/**
 * Folder Event Detector — v2.1 Phase A2.
 *
 * Disk-side counterpart to `collectionWatcher` (A1). Runs once per scan
 * cycle (driven by `watchFolder._scan` via `syncCoordinator.notifyScanCycle`)
 * and detects folder DELETIONS — tracked `CollectionRecord`s whose
 * `localPath` is no longer on disk.
 *
 * Why only deletions in v2.1:
 *   - folder RENAMES are already handled by `_detectFolderRenames` in
 *     watchFolder.mjs (Phase B2). That path runs earlier in the scan
 *     and updates collection records so this detector sees a consistent
 *     state.
 *   - folder CREATES are already handled by
 *     `_ensureCollectionsForExistingFolders` (Phase B5), which calls
 *     `relativePathToCollection({ createIfMissing: true })` and persists
 *     a `CollectionRecord`. By the time A2 runs, any new disk dir has
 *     been turned into a tracked collection.
 *
 * The detector emits `deleteFolder` MirrorActions to `mirrorExecutor`,
 * which applies the mode-appropriate policy: Mode 2 flips the record's
 * state to `out-of-scope-suppressed` (warn-only); Mode 3 (v2.2) will
 * trash via `.zotero-watch-trash/`.
 *
 * @module folderEventDetector
 */

import * as mirrorExecutor from './mirrorExecutor.mjs';
import { STATE } from './trackingStore.mjs';
import { isWatchRootAvailable } from './fileMissing.mjs';
import { resolveSyncRoot } from './canonicalPath.mjs';
import { report as reportWarning, WARNING_CATEGORY } from './warningSink.mjs';
import {
  topLevelDirNames,
  checkTopLevelCollapse,
  recordHealthyFingerprint,
  checkCycleAggregate,
} from './watchRootGuard.mjs';

/**
 * Run the disk diff against the tracked collection records.
 *
 * @param {Object} ctx
 * @param {import('./trackingStore.mjs').TrackingStore} ctx.trackingStore
 * @param {Set<string>} ctx.onDiskAbsDirs - Absolute paths of all dirs under
 *   the watch root (already enumerated by the caller — see
 *   `watchFolder._listSubdirectories`).
 * @param {string} ctx.watchRoot - Absolute watch-folder root.
 */
export async function detectFolderEvents({ trackingStore, onDiskAbsDirs, watchRoot }) {
  if (!trackingStore || !watchRoot) return;

  // SYNC-1: defense-in-depth — if the watch root is unreachable (transient
  // unmount / disconnected drive), the on-disk dir set is meaningless and
  // every tracked folder would appear deleted, mass-emitting
  // localFolderDeleted. Bail before the record loop; emit nothing and do NOT
  // flip any CollectionRecord here (file-record pausing remains the job of
  // _handleExternalDeletions). The caller (watchFolder._scan) already gates
  // on this too; this is the emitter-side backstop.
  if (!(await isWatchRootAvailable(watchRoot))) {
    Zotero.debug('[WatchFolder] folderEventDetector: watch root unavailable — skipping folder-deletion detection');
    return;
  }

  const dirSet = onDiskAbsDirs instanceof Set ? onDiskAbsDirs : new Set(onDiskAbsDirs || []);

  // ── SYNC-1: top-level collapse gate (cloud-eviction guard) ──────────────
  // The root is reachable, but if most/all of its top-level folders vanished
  // at once that's the signature of a placeholdered/evicted cloud mount, not
  // real deletions — under library scope it would be a whole-library wipe.
  // Pause the deletion pass and DON'T refresh the fingerprint (so a real
  // collapse can't quietly become the new "healthy" baseline).
  const topNames = topLevelDirNames(dirSet, watchRoot);
  const collapse = checkTopLevelCollapse(topNames);
  if (collapse.collapsed) {
    Zotero.debug(`[WatchFolder] folderEventDetector: ${collapse.reason} — skipping folder-deletion detection`);
    reportWarning({
      category: WARNING_CATEGORY.IO_ERROR,
      actionType: 'folderDeletionPass',
      path: watchRoot,
      reason: 'top-level-collapse',
      message: `Folder-deletion sync paused: ${collapse.reason}. No folders were deleted. If you really removed these folders, they will sync once the count stabilises.`,
    });
    return;
  }

  const records = trackingStore.getAllOfType('collection');

  // ── Phase 1: collect every tracked collection that's gone from disk ─────
  const missing = [];
  for (const rec of records) {
    if (!rec || typeof rec.localPath !== 'string' || rec.localPath === '') continue;
    // Idempotency guard — a CollectionRecord that's already
    // OUT_OF_SCOPE_SUPPRESSED has already been emitted to the executor
    // (and reported once). Re-emitting every scan cycle would flood the
    // warning ring buffer and rewrite tracking-v2.json on every poll.
    if (rec.state === STATE.OUT_OF_SCOPE_SUPPRESSED) continue;

    // _toAbs is idempotent: absolute paths from legacy v1 writers AND
    // sync-root-relative paths from v2 baseline both resolve correctly.
    const absPath = _toAbs(watchRoot, rec.localPath);
    if (dirSet.has(absPath)) continue;

    // Fallback existence check — the caller's dir set may be capped at
    // a max depth that misses very-deep records.
    let exists = false;
    try { exists = await IOUtils.exists(absPath); }
    catch (_e) { exists = false; }
    if (exists) continue;

    missing.push(rec);
  }
  // CLEAN cycle (nothing missing) — only NOW is it safe to refresh the healthy
  // fingerprint. Recording it earlier (before deletions are reconciled) let a
  // drip-eviction ratchet the collapse baseline downward each cycle so the
  // >50%-collapse gate never fired against the true pre-incident count (F7/F6).
  // A cycle WITH missing folders deliberately leaves the fingerprint stale; the
  // next fully-reconciled clean cycle updates it.
  //
  // SUPPRESSED-DRIP HOLE: Phase 1 above skips OUT_OF_SCOPE_SUPPRESSED records
  // (emit-idempotency), so a top-level folder that was evicted and has since
  // flipped to suppressed no longer appears in `missing` — making the cycle
  // look "clean" while a folder is in fact gone from disk. Left unchecked, a
  // gradual eviction (one folder suppressed per cycle) would ratchet the
  // fingerprint downward one notch at a time and never trip the >50% collapse
  // gate. So before refreshing, also confirm no SUPPRESSED top-level folder is
  // missing from disk. (Suppression normally keeps the local folder in place;
  // a suppressed record whose folder also vanished is exactly the drip-eviction
  // signature, so we fail safe and leave the baseline stale.)
  if (missing.length === 0) {
    // Genuine cloud-eviction = a disk folder vanishes while its Zotero
    // collection STILL EXISTS. A suppressed record whose Zotero collection is
    // ALSO gone is an orphan (the collection was deleted), not eviction —
    // counting it here would freeze the fingerprint forever on installs that
    // accumulate such orphans. So only treat a suppressed-missing top-level
    // folder as a drip-eviction signal when its collection is still present.
    let libraryID = null;
    try { const sr = await resolveSyncRoot(); libraryID = sr?.libraryID ?? null; } catch (_e) { libraryID = null; }
    if (libraryID == null) { try { libraryID = Zotero.Libraries.userLibraryID; } catch (_e) { libraryID = null; } }
    let suppressedTopLevelMissing = 0;
    for (const rec of records) {
      if (!rec || typeof rec.localPath !== 'string' || rec.localPath === '') continue;
      if (rec.state !== STATE.OUT_OF_SCOPE_SUPPRESSED) continue;
      if (_relForm(rec.localPath, watchRoot).includes('/')) continue; // top-level only
      const absPath = _toAbs(watchRoot, rec.localPath);
      if (dirSet.has(absPath)) continue;
      let exists = false;
      try { exists = await IOUtils.exists(absPath); }
      catch (_e) { exists = false; }
      if (exists) continue;
      // Orphan check: if the Zotero collection is gone, this is stale cruft, not
      // eviction — don't let it freeze the fingerprint. (On lookup failure we
      // keep the conservative behavior and count it.)
      if (libraryID != null && rec.zoteroCollectionKey) {
        let coll = null;
        try { coll = Zotero.Collections.getByLibraryAndKey(libraryID, rec.zoteroCollectionKey); }
        catch (_e) { coll = null; }
        if (!coll) continue;
      }
      suppressedTopLevelMissing++;
    }
    if (suppressedTopLevelMissing === 0) {
      recordHealthyFingerprint(topNames);
    } else {
      Zotero.debug(`[WatchFolder] folderEventDetector: ${suppressedTopLevelMissing} suppressed top-level folder(s) missing from disk (collection still present) — leaving healthy fingerprint stale (drip-eviction guard)`);
    }
    return;
  }

  // ── Phase 2: cycle aggregate cap (above the per-action bulkGuard) ───────
  // N individually-small deletes still add up to a mass deletion. A top-level
  // folder is one whose SYNC-ROOT-RELATIVE path has no separator. Compute the
  // relative form first: legacy absolute localPaths contain '/' and would
  // otherwise be miscounted as nested, undercounting missingTopLevel and
  // weakening the top-level cap (F7b).
  const missingTopLevel = missing.filter((r) => !_relForm(r.localPath, watchRoot).includes('/')).length;
  const aggregate = checkCycleAggregate({
    missingTopLevel,
    missingTotal: missing.length,
    totalTracked: records.length,
  });
  if (aggregate.trip) {
    Zotero.debug(`[WatchFolder] folderEventDetector: ${aggregate.reason} — refusing batch`);
    reportWarning({
      category: WARNING_CATEGORY.SUPPRESSED,
      actionType: 'folderDeletionPass',
      path: watchRoot,
      reason: 'cycle-aggregate-cap',
      message: `Folder-deletion sync paused: ${aggregate.reason}. No folders were deleted — this guards against accidental or transient mass deletion. Remove the folders in smaller batches, or restore them, to proceed.`,
    });
    return;
  }

  // ── Phase 3: emit one localFolderDeleted per genuinely-missing folder ───
  for (const rec of missing) {
    // Disk-side deletion → propagate to Zotero (localFolderDeleted). The
    // local folder is GONE; the corresponding Zotero collection (and, in
    // Mode 3, its clean attachments) is what gets trashed. Distinct from
    // `zoteroCollectionDeleted`, which trashes the local folder.
    Zotero.debug(`[WatchFolder] folderEventDetector: tracked collection missing on disk → localFolderDeleted (${rec.localPath})`);
    try {
      await mirrorExecutor.execute({
        type: 'localFolderDeleted',
        payload: {
          collectionKey: rec.zoteroCollectionKey,
          oldRelativePath: rec.localPath,
        },
      });
    } catch (e) {
      Zotero.logError(`[WatchFolder] folderEventDetector emit localFolderDeleted ${rec.localPath}: ${e?.message ?? e}`);
    }
  }
}

function _toAbs(root, rel) {
  if (!rel) return root;
  if (rel.startsWith('/')) return rel;
  if (/^[A-Za-z]:[\\/]/.test(rel)) return rel;
  const segs = rel.split('/').filter((s) => s.trim() !== '');
  if (segs.length === 0) return root;
  return PathUtils.join(root, ...segs);
}

/**
 * Sync-root-relative form of a (possibly legacy-absolute) tracked localPath, so
 * "top-level" can be judged by "no separator" regardless of how the path was
 * stored. Strips a leading watchRoot + separators; normalizes '\\' to '/'.
 */
function _relForm(localPath, watchRoot) {
  let rel = String(localPath || '');
  if (watchRoot && rel.startsWith(watchRoot)) rel = rel.slice(watchRoot.length);
  return rel.replace(/^[/\\]+/, '').replace(/\\/g, '/');
}
