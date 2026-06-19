/**
 * Check & Repair — disk ↔ Zotero ↔ tracking reconciliation (v2.8).
 *
 * The sync pipeline normally keeps the three views consistent, but edge cases
 * leave drift the regular scan won't self-heal:
 *   - a file's CANONICAL copy is deleted while a duplicate (shadow) survives in
 *     another folder → the Zotero item is stranded (Unfiled/missing) instead of
 *     re-homing to the surviving folder;
 *   - a stale dead-state collection record shadows a live disk folder, so the
 *     empty-folder pickup skips creating its collection;
 *   - a tracked file is gone from BOTH disk and Zotero → a dangling record.
 *
 * `detect()` is READ-ONLY: it walks the three views and returns structured
 * findings, each with a count of the attachment's annotations/notes (so the UI
 * can surface and protect high-value items) and a RECOMMENDED, safe action.
 * `applyRepairs()` executes only the actions the caller selected, reusing the
 * existing safe primitives (tracking-store mutations + additive Zotero
 * membership changes) — it never bypasses a deletion-safety gate and never
 * disk-deletes. High-value items are never defaulted to a destructive action.
 *
 * @module reconcile
 */

import { getPref } from './utils.mjs';
import {
  resolveSyncRoot,
  relativePathToCollection,
  collectionKeyToDiskRelativePath,
} from './canonicalPath.mjs';
import { getTrackingStore, createCollectionRecord, STATE } from './trackingStore.mjs';
import { isWatchRootAvailable, classifyMissingFile, MISSING_CLASSIFICATION } from './fileMissing.mjs';

/**
 * Collection-record states that are "dead" — not actively syncing. A dead
 * record must not shadow a live disk folder (mirrors the FOLDER-RENAME-EMPTY
 * dead-state exclusion).
 */
const DEAD_COLL_STATES = new Set([
  STATE.OUT_OF_SCOPE_SUPPRESSED,
  STATE.USER_DETACHED,
  STATE.CONFLICT_BLOCKED,
  STATE.PAUSED,
  STATE.RECOVERABLE,
  STATE.MISSING,
]);

/**
 * File-record states excluded from shadow-survivor consideration (M1): a
 * USER_DETACHED / suppressed / conflict-blocked on-disk copy must NOT be
 * promoted to canonical — that would reverse an explicit user choice. Mirrors
 * the `_byHash` detached-state exclusion.
 */
const NON_SYNCING_FILE_STATES = new Set([
  STATE.USER_DETACHED,
  STATE.OUT_OF_SCOPE_SUPPRESSED,
  STATE.CONFLICT_BLOCKED,
]);

const FINDING = Object.freeze({
  SHADOW_ORPHANED: 'shadow-orphaned',
  STALE_COLLECTION: 'stale-collection-record',
  ORPHAN_TRACKING: 'orphan-tracking',
  UNTRACKED_FOLDER: 'untracked-folder',
});

// ─── Annotation / note counting (fail-OPEN to "has value" so high-value items
//     are never under-counted and thus never auto-deleted) ───────────────────

/**
 * Count an attachment's annotations + notes. On ANY uncertainty (missing API,
 * throw, odd shape) returns a sentinel `unknown:true` so callers treat the item
 * as high-value (protect it) rather than presume zero — the conservative
 * direction for a repair tool.
 * @param {object} attachment
 * @returns {{annotations:number, notes:number, unknown:boolean}}
 */
export function countAnnotationsNotes(attachment) {
  if (!attachment) return { annotations: 0, notes: 0, unknown: false };
  let annotations = 0;
  let notes = 0;
  let unknown = false;
  // M4: fail OPEN to unknown on ANY uncertainty — a missing method or a
  // non-array return (not just a throw) means we can't prove zero, so treat the
  // item as high-value. Mirrors storageStrategy's fail-closed child classifier.
  try {
    if (typeof attachment.getAnnotations !== 'function') { unknown = true; }
    else {
      const a = attachment.getAnnotations();
      if (Array.isArray(a)) annotations = a.length; else unknown = true;
    }
  } catch (_e) { unknown = true; }
  // M3: count the attachment's OWN child notes (att.getNotes), not the parent's
  // — reading the parent counts sibling notes that don't belong to this file.
  try {
    if (typeof attachment.getNotes !== 'function') { unknown = true; }
    else {
      const n = attachment.getNotes();
      if (Array.isArray(n)) notes = n.length; else unknown = true;
    }
  } catch (_e) { unknown = true; }
  return { annotations, notes, unknown };
}

function _absPath(watchRoot, rel) {
  if (!rel) return watchRoot;
  if (rel.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rel)) return rel;
  const segs = rel.split('/').filter((s) => s.trim() !== '');
  return segs.length ? PathUtils.join(watchRoot, ...segs) : watchRoot;
}

function _relForm(localPath, watchRoot) {
  let rel = String(localPath || '');
  if (watchRoot && rel.startsWith(watchRoot)) rel = rel.slice(watchRoot.length);
  return rel.replace(/^[/\\]+/, '').replace(/\\/g, '/');
}

function _parentRel(rel) {
  const parts = String(rel || '').split('/').filter((s) => s.trim() !== '');
  parts.pop();
  return parts.join('/');
}

async function _exists(p) {
  try { return await IOUtils.exists(p); } catch (_e) { return false; }
}

/**
 * Is a tracked FILE genuinely gone (C5)? Uses classifyMissingFile so a
 * cloud-evicted placeholder (iCloud/OneDrive/Dropbox dehydration),
 * permission-denied, or a disconnected drive is treated as STILL PRESENT — only
 * a real USER_DELETED counts as absent. A bare IOUtils.exists would misread a
 * dehydrated cloud file as deleted on the owner's pCloud setup.
 * @returns {Promise<boolean>} true only when the file is genuinely deleted.
 */
async function _fileGone(abs, watchRoot) {
  try {
    const cls = await classifyMissingFile(abs, watchRoot);
    return cls === MISSING_CLASSIFICATION.USER_DELETED;
  } catch (_e) {
    return false; // uncertain → treat as present (never act on uncertainty)
  }
}

/**
 * Walk the three views and classify drift. READ-ONLY.
 * @returns {Promise<{ok:boolean, reason?:string, findings:Array}>}
 */
export async function detect() {
  const store = getTrackingStore();
  if (!store) return { ok: false, reason: 'no-store', findings: [] };

  const syncRoot = await resolveSyncRoot().catch(() => null);
  if (!syncRoot) return { ok: false, reason: 'no-sync-root', findings: [] };

  const watchRoot = getPref('sourcePath');
  if (!watchRoot) return { ok: false, reason: 'no-watch-root', findings: [] };

  // C1 (SYNC-1): never reconcile against an unreachable watch root — a transient
  // unmount/cloud-drop would make every file read "missing" and mass-flag
  // deletions. Bail exactly as the scan + folderEventDetector do.
  if (!(await isWatchRootAvailable(watchRoot))) {
    return { ok: false, reason: 'watch-root-unavailable', findings: [] };
  }

  const libraryID = syncRoot.libraryID ?? Zotero?.Libraries?.userLibraryID;
  const findings = [];
  let seq = 0;

  const fileRecords = store.getAllOfType('file') || [];
  const collRecords = store.getAllOfType('collection') || [];

  // Group file records by attachment key (canonical + shadows).
  const byKey = new Map();
  for (const r of fileRecords) {
    const k = r.zoteroAttachmentKey;
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }

  for (const [attKey, recs] of byKey) {
    // Disk presence per record (C5: cloud-placeholder-aware — only a genuine
    // USER_DELETED counts as gone).
    const withDisk = [];
    for (const r of recs) {
      const abs = _absPath(watchRoot, r.localPath);
      const on = !(await _fileGone(abs, watchRoot));
      withDisk.push({ rec: r, abs, onDisk: on });
    }
    const canonical = withDisk.find((x) => x.rec.localPath === (x.rec.canonicalLocalPath || x.rec.localPath))
      || withDisk[0];
    const canonicalOnDisk = canonical ? canonical.onDisk : false;
    // M1: a surviving shadow eligible for promotion must be on disk AND in a
    // syncing state — never promote a USER_DETACHED / suppressed copy (that
    // would reverse an explicit user choice).
    const survivingShadows = withDisk.filter((x) =>
      x !== canonical && x.onDisk && !NON_SYNCING_FILE_STATES.has(x.rec.state));
    const anyOnDisk = withDisk.some((x) => x.onDisk);

    // Resolve the Zotero attachment once (for annotation/note counting + state).
    let attachment = null;
    try { attachment = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, attKey); }
    catch (_e) { attachment = null; }
    const zoteroAlive = !!attachment && attachment.deleted !== true;
    const counts = countAnnotationsNotes(attachment);
    const highValue = counts.unknown || (counts.annotations + counts.notes) > 0;

    if (zoteroAlive && !canonicalOnDisk && survivingShadows.length > 0) {
      // CANONICAL gone, a duplicate survives elsewhere → re-home.
      const surv = survivingShadows[0];
      const survRel = _relForm(surv.rec.localPath, watchRoot);
      const folderRel = _parentRel(survRel);
      findings.push(_finding({
        id: `f${seq++}`,
        type: FINDING.SHADOW_ORPHANED,
        severity: 'high',
        title: 'File moved out of its original location',
        detail: `The copy this item pointed to is gone, but a duplicate is still on disk`
          + `${folderRel ? ` in "${folderRel}"` : ' at the watch-folder root'}. `
          + `Re-home the item to the surviving copy so it shows up where the file actually is.`,
        path: survRel,
        attachmentKey: attKey,
        counts, highValue,
        actions: [
          { id: 'rehome', label: folderRel ? `Re-home to "${folderRel}"` : 'Re-home to watch-folder root (Unfiled)', recommended: true, destructive: false },
          { id: 'skip', label: 'Leave as-is', recommended: false, destructive: false },
        ],
        defaultActionId: 'rehome',
        _payload: {
          attKey,
          survivingLocalPath: surv.rec.localPath,
          allSurvivingLocalPaths: survivingShadows.map((x) => x.rec.localPath),
          folderRel,
          canonicalLocalPath: canonical?.rec.localPath,
        },
      }));
      continue;
    }

    if (!anyOnDisk && !zoteroAlive) {
      // Gone from disk AND Zotero → dangling tracking record(s).
      findings.push(_finding({
        id: `f${seq++}`,
        type: FINDING.ORPHAN_TRACKING,
        severity: 'low',
        title: 'Tracking entry for a file that no longer exists',
        detail: 'This file is gone from both your watch folder and Zotero. The leftover '
          + 'tracking entry does nothing useful — clean it up.',
        path: _relForm(canonical?.rec.localPath, watchRoot),
        attachmentKey: attKey,
        counts, highValue,
        actions: [
          { id: 'drop', label: 'Remove the stale tracking entry', recommended: true, destructive: false },
          { id: 'skip', label: 'Keep it', recommended: false, destructive: false },
        ],
        defaultActionId: 'drop',
        _payload: { attKey, localPaths: recs.map((r) => r.localPath) },
      }));
    }
  }

  // ── Collection-record drift ──────────────────────────────────────────────
  const liveCollPathsByRel = new Set();
  for (const c of collRecords) {
    if (DEAD_COLL_STATES.has(c.state)) continue;
    liveCollPathsByRel.add(_relForm(c.localPath, watchRoot));
  }

  for (const c of collRecords) {
    if (!DEAD_COLL_STATES.has(c.state)) continue;
    const rel = _relForm(c.localPath, watchRoot);
    if (!rel) continue;
    const onDisk = await _exists(_absPath(watchRoot, c.localPath));
    // A dead record whose folder is back on disk (and no live record owns the
    // path) is actively blocking the folder from becoming a collection.
    if (onDisk && !liveCollPathsByRel.has(rel)) {
      findings.push(_finding({
        id: `f${seq++}`,
        type: FINDING.STALE_COLLECTION,
        severity: 'medium',
        title: 'Folder not syncing because of a stale entry',
        detail: `The folder "${rel}" exists on disk but an old, inactive tracking entry is `
          + `blocking it from becoming a Zotero collection. Clearing the entry lets it sync.`,
        path: rel,
        attachmentKey: null,
        counts: { annotations: 0, notes: 0, unknown: false },
        highValue: false,
        actions: [
          { id: 'cleanup', label: 'Clear the stale entry (folder will sync next scan)', recommended: true, destructive: false },
          { id: 'skip', label: 'Leave as-is', recommended: false, destructive: false },
        ],
        defaultActionId: 'cleanup',
        _payload: { zoteroCollectionKey: c.zoteroCollectionKey, rel },
      }));
    }
  }

  // Sort: high-value first, then by severity, then stable by id.
  const sevRank = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => {
    if (a.highValue !== b.highValue) return a.highValue ? -1 : 1;
    const s = (sevRank[a.severity] ?? 9) - (sevRank[b.severity] ?? 9);
    if (s !== 0) return s;
    return a.id.localeCompare(b.id);
  });

  return { ok: true, findings, highValueCount: findings.filter((f) => f.highValue).length };
}

function _finding(f) { return f; }

/**
 * Apply the selected repair actions. `decisions` maps finding.id → actionId.
 * Only non-skip actions run. Returns a per-action summary.
 *
 * @param {Array} findings - the findings from detect() (carry _payload).
 * @param {Object<string,string>} decisions - { findingId: actionId }
 * @returns {Promise<{ok:boolean, applied:number, skipped:number, failed:number, results:Array}>}
 */
export async function applyRepairs(findings, decisions) {
  const store = getTrackingStore();
  if (!store) return { ok: false, reason: 'no-store', applied: 0, skipped: 0, failed: 0, results: [] };
  const syncRoot = await resolveSyncRoot().catch(() => null);
  const libraryID = syncRoot?.libraryID ?? Zotero?.Libraries?.userLibraryID;
  const watchRoot = getPref('sourcePath');
  // C2: re-validation re-probes disk; refuse to mutate against an unavailable
  // watch root (would mis-read every file as gone).
  if (!watchRoot || !(await isWatchRootAvailable(watchRoot))) {
    return { ok: false, reason: 'watch-root-unavailable', applied: 0, skipped: 0, failed: 0, results: [] };
  }

  let applied = 0, skipped = 0, failed = 0;
  const results = [];

  for (const f of (findings || [])) {
    const action = (decisions && decisions[f.id]) || f.defaultActionId;
    if (!action || action === 'skip') { skipped++; results.push({ id: f.id, action: 'skip', ok: true }); continue; }
    try {
      const r = await _applyOne(f, action, { store, libraryID, watchRoot });
      if (r && r.ok) { applied++; results.push({ id: f.id, action, ok: true }); }
      else { failed++; results.push({ id: f.id, action, ok: false, reason: r?.reason }); }
    } catch (e) {
      failed++;
      results.push({ id: f.id, action, ok: false, reason: String(e?.message ?? e) });
      try { Zotero.logError(`[WatchFolder] reconcile apply ${f.id}/${action}: ${e?.message ?? e}`); } catch (_e) { /* */ }
    }
  }
  try { await store.save(); } catch (_e) { /* logged */ }
  return { ok: true, applied, skipped, failed, results };
}

async function _applyOne(f, action, { store, libraryID, watchRoot }) {
  switch (f.type) {
    case FINDING.SHADOW_ORPHANED: {
      if (action !== 'rehome') return { ok: false, reason: 'unknown-action' };
      const { attKey, survivingLocalPath, allSurvivingLocalPaths, folderRel, canonicalLocalPath } = f._payload;

      // C2/C3 re-validate at apply time (the detect→Apply window is interactive):
      //  - the dead canonical must STILL be gone on disk, and
      //  - the survivor record must STILL exist and STILL be on disk.
      // Abort (don't mutate) if the world changed under us.
      if (canonicalLocalPath && canonicalLocalPath !== survivingLocalPath) {
        const canonGone = await _fileGone(_absPath(watchRoot, canonicalLocalPath), watchRoot);
        if (!canonGone) return { ok: false, reason: 'state-changed: canonical reappeared' };
      }
      const survRec = store.getByLocalPath ? store.getByLocalPath(survivingLocalPath) : null;
      if (!survRec) return { ok: false, reason: 'state-changed: survivor record gone' };
      if (await _fileGone(_absPath(watchRoot, survivingLocalPath), watchRoot)) {
        return { ok: false, reason: 'state-changed: survivor file gone' };
      }

      // Resolve / create the destination collection FIRST (so a failure here
      // aborts before any tracking mutation).
      let newCanonicalCollectionKey = null;
      let collId = null;
      if (folderRel) {
        const coll = await relativePathToCollection(folderRel, { createIfMissing: true }).catch(() => null);
        if (coll && coll.id) { newCanonicalCollectionKey = coll.key; collId = coll.id; }
      }

      // C3 atomic ordering: PROMOTE the survivor first, then drop the dead
      // canonical. If promotion can't happen the dead record stays (re-detectable).
      // M5: root re-home (folderRel '') → canonicalCollectionKey null is correct
      // (Unfiled); a non-empty folder sets the resolved key.
      store.update(survivingLocalPath, {
        canonicalLocalPath: survivingLocalPath,
        canonicalCollectionKey: newCanonicalCollectionKey,
        state: STATE.CLEAN,
      });
      // C4: re-point EVERY other surviving shadow's canonical to the new
      // canonical so none dangle at the removed path.
      for (const lp of (allSurvivingLocalPaths || [])) {
        if (lp === survivingLocalPath) continue;
        if (store.getByLocalPath && store.getByLocalPath(lp)) {
          store.update(lp, { canonicalLocalPath: survivingLocalPath });
        }
      }
      // Now drop the dead canonical record (its file is genuinely gone).
      if (canonicalLocalPath && canonicalLocalPath !== survivingLocalPath) {
        store.remove(canonicalLocalPath);
      }

      // Additive Zotero membership (consistent with suppressionResolver._reinstate,
      // which also adds directly). Never removes memberships.
      if (collId != null) {
        try {
          const att = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, attKey);
          const owner = att && (att.parentItem || att);
          if (owner && typeof owner.addToCollection === 'function') {
            const cur = (owner.getCollections && owner.getCollections()) || [];
            if (!cur.includes(collId)) { owner.addToCollection(collId); await owner.saveTx(); }
          }
        } catch (e) {
          // Tracking is already consistent; surface the membership failure but
          // don't unwind (the file is correctly re-homed on disk + in tracking).
          return { ok: false, reason: 'rehomed-tracking-ok-but-membership-add-failed: ' + (e?.message ?? e) };
        }
      }
      return { ok: true };
    }
    case FINDING.ORPHAN_TRACKING: {
      if (action !== 'drop') return { ok: false, reason: 'unknown-action' };
      const { attKey, localPaths } = f._payload;
      // C2 re-validate: only drop if the file is STILL gone from disk for every
      // path AND the Zotero item is STILL absent. If anything reappeared, abort
      // (dropping a live record causes a re-import loop — suppress-not-drop).
      for (const lp of (localPaths || [])) {
        if (!(await _fileGone(_absPath(watchRoot, lp), watchRoot))) {
          return { ok: false, reason: 'state-changed: file reappeared' };
        }
      }
      let att = null;
      try { att = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, attKey); } catch (_e) { att = null; }
      if (att && att.deleted !== true) return { ok: false, reason: 'state-changed: zotero item alive' };
      for (const lp of (localPaths || [])) store.remove(lp);
      return { ok: true };
    }
    case FINDING.STALE_COLLECTION: {
      if (action !== 'cleanup') return { ok: false, reason: 'unknown-action' };
      // C2 re-validate: only clean up if the record is STILL dead-state.
      const rec = store.getCollectionRecord(f._payload.zoteroCollectionKey);
      if (!rec) return { ok: true }; // already gone — nothing to do
      if (!DEAD_COLL_STATES.has(rec.state)) return { ok: false, reason: 'state-changed: record is live again' };
      store.removeCollectionRecord(f._payload.zoteroCollectionKey);
      return { ok: true };
    }
    default:
      return { ok: false, reason: 'unknown-finding-type' };
  }
}

export { FINDING, DEAD_COLL_STATES };
