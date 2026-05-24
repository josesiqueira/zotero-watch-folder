/**
 * First-run baseline — v2.1 Phase C.
 *
 * Spec §"Install-time baseline behavior" (table B.1–B.7). On first
 * activation of Mode 2/3 for a given sync root, this module
 * reconciles initial state across both sides:
 *
 *   B.2 — Copy Zotero attachment files from storage to the watch
 *         folder at their canonical path under the sync root.
 *   B.6 — mkdir empty Zotero subcollections as empty disk folders.
 *
 * Cases handled by other code paths:
 *   B.1 (both empty)        — no-op
 *   B.3/B.4/B.5 (disk has)  — covered by the regular scan loop +
 *                             _ensureCollectionsForExistingFolders
 *   B.7 (both have content) — current code skips disk files that
 *                             already exist at the destination; full
 *                             hash-based reconcile + reverse copy is
 *                             a follow-up.
 *
 * Idempotent. Marks completion via the `baselineCompletedForRoot`
 * pref keyed on the sync-root collection key, so changing the sync
 * root re-triggers the baseline against the new root.
 *
 * @module baseline
 */

import { getPref, setPref, getFileHash } from './utils.mjs';
import {
  resolveSyncRoot,
  collectionKeyToRelativePath,
  chooseCanonicalCollection,
  isSpecialCollection,
} from './canonicalPath.mjs';
import { createFileRecord, createCollectionRecord, STATE } from './trackingStore.mjs';
import { report as reportWarning, WARNING_CATEGORY } from './warningSink.mjs';

const BASELINE_PREF = 'baselineCompletedForRoot';

/**
 * Has the baseline been run for the current sync root?
 * @returns {Promise<boolean>}
 */
export async function isBaselineNeeded() {
  let syncRoot;
  try { syncRoot = await resolveSyncRoot(); }
  catch (_e) { return false; }
  if (!syncRoot) return false;
  const completed = getPref(BASELINE_PREF);
  return completed !== syncRoot.collection.key;
}

/** Mark the baseline complete for `syncRootKey`. */
export function markBaselineComplete(syncRootKey) {
  setPref(BASELINE_PREF, syncRootKey || '');
}

/**
 * Run the install-time baseline. Idempotent — bails when the current
 * sync root key matches the persisted `baselineCompletedForRoot` pref
 * unless `opts.force` is true.
 *
 * @param {Object} opts
 * @param {Object} opts.trackingStore - Required. Live store from SyncCoordinator.
 * @param {string} [opts.watchRoot]    - Defaults to `sourcePath` pref.
 * @param {Object} [opts.syncRoot]     - Test seam; otherwise resolved.
 * @param {boolean} [opts.force=false] - Re-run even if already completed.
 * @param {boolean} [opts.dryRun=false]
 * @returns {Promise<Object>} summary { ok, baselineRan, copies, mkdirs, errors, skipped? }
 */
export async function runBaseline(opts = {}) {
  const watchRoot = opts.watchRoot ?? getPref('sourcePath');
  if (!watchRoot) return { ok: false, baselineRan: false, skipped: 'no-watch-root' };

  let syncRoot = opts.syncRoot;
  if (typeof syncRoot === 'undefined') {
    try { syncRoot = await resolveSyncRoot(); }
    catch (e) { return { ok: false, baselineRan: false, skipped: 'sync-root-error', error: String(e?.message ?? e) }; }
  }
  if (!syncRoot) return { ok: false, baselineRan: false, skipped: 'no-sync-root' };

  const completed = getPref(BASELINE_PREF);
  if (!opts.force && completed === syncRoot.collection.key) {
    return { ok: true, baselineRan: false, skipped: 'already-completed' };
  }

  const store = opts.trackingStore;
  if (!store) return { ok: false, baselineRan: false, skipped: 'no-store' };

  Zotero.debug(`[WatchFolder] baseline: starting for sync root ${syncRoot.collection.key} → ${watchRoot}`);
  const dryRun = !!opts.dryRun;
  let copies = 0, mkdirs = 0, errors = 0;

  try {
    const { collections, attachments } = await _enumerateUnderSyncRoot(syncRoot);

    // ─── B.6 — empty subcollections → empty disk folders ────────────
    for (const col of collections) {
      const relPath = await collectionKeyToRelativePath(col.key);
      if (relPath == null || relPath === '') continue;
      const absPath = _toAbs(watchRoot, relPath);
      try {
        const exists = await IOUtils.exists(absPath);
        if (!exists) {
          if (!dryRun) {
            await IOUtils.makeDirectory(absPath, { ignoreExisting: true, createAncestors: true });
            store.add(createCollectionRecord({
              localPath: relPath,
              zoteroCollectionKey: col.key,
              parentCollectionKey: _parentKeyOf(col),
              state: STATE.CLEAN,
            }));
          }
          mkdirs++;
        } else if (!store.getCollectionRecord(col.key)) {
          // Folder already exists on disk but we never tracked it —
          // adopt the tracking record so later events route correctly.
          if (!dryRun) {
            store.add(createCollectionRecord({
              localPath: relPath,
              zoteroCollectionKey: col.key,
              parentCollectionKey: _parentKeyOf(col),
              state: STATE.CLEAN,
            }));
          }
        }
      } catch (e) {
        errors++;
        reportWarning({
          category: WARNING_CATEGORY.IO_ERROR,
          actionType: 'baseline-mkdir',
          collectionKey: col.key,
          path: relPath,
          reason: 'mkdir-failed',
          message: `Baseline mkdir failed for "${relPath}": ${e?.message ?? e}`,
        });
      }
    }

    // ─── B.2 — copy Zotero attachment files to local ────────────────
    for (const entry of attachments) {
      const { attachment, item } = entry;
      try {
        const result = await _copyAttachmentToCanonical({
          attachment, item, syncRoot, watchRoot, store, dryRun,
        });
        if (result === 'copied') copies++;
      } catch (e) {
        errors++;
        reportWarning({
          category: WARNING_CATEGORY.IO_ERROR,
          actionType: 'baseline-copy',
          attachmentKey: attachment?.key ?? null,
          reason: 'copy-failed',
          message: `Baseline copy failed for ${attachment?.key}: ${e?.message ?? e}`,
        });
      }
    }

    if (!dryRun) {
      try { await store.save(); } catch (_e) { /* logged inside save */ }
      markBaselineComplete(syncRoot.collection.key);
    }

    Zotero.debug(`[WatchFolder] baseline: complete (copies=${copies} mkdirs=${mkdirs} errors=${errors})`);
    return { ok: true, baselineRan: true, copies, mkdirs, errors };
  } catch (e) {
    Zotero.logError(`[WatchFolder] baseline: ${e?.message ?? e}`);
    return { ok: false, baselineRan: false, error: String(e?.message ?? e) };
  }
}

// ─── Internal: copy one attachment to its canonical local path ────────────

/**
 * Returns 'copied' on successful copy, 'skipped' when destination
 * exists or attachment isn't trackable. Throws on hard IO failures.
 */
async function _copyAttachmentToCanonical({ attachment, item, syncRoot, watchRoot, store, dryRun }) {
  const filename = attachment.attachmentFilename;
  if (!filename) return 'skipped';

  const canonical = await chooseCanonicalCollection(item, syncRoot.collection);
  if (!canonical) return 'skipped';
  const relDir = await collectionKeyToRelativePath(canonical.key);
  if (relDir == null) return 'skipped';
  const relPath = relDir === '' ? filename : `${relDir}/${filename}`;
  const absDest = _toAbs(watchRoot, relPath);

  // Don't trample existing files (B.7 full reconcile is a follow-up).
  const destExists = await IOUtils.exists(absDest);
  if (destExists) {
    // Adopt the file if we don't already track it — hash-link to the
    // Zotero attachment so the regular dedup paths recognise the pair.
    if (!store.getByAttachmentKey(attachment.key) && !dryRun) {
      await _adoptExistingDestFile({ attachment, item, canonical, relPath, absDest, store });
    }
    return 'skipped';
  }

  // Already tracked elsewhere — skip (shouldn't happen on a true first run).
  if (store.getByAttachmentKey(attachment.key)) return 'skipped';

  let srcPath = null;
  try { srcPath = await attachment.getFilePathAsync(); }
  catch (_e) { /* fall through to warning */ }
  if (!srcPath) {
    reportWarning({
      category: WARNING_CATEGORY.MISSING_FILE,
      actionType: 'baseline-copy',
      attachmentKey: attachment.key,
      path: relPath,
      reason: 'src-unavailable',
      message: `Baseline: attachment ${attachment.key} has no file on disk (Zotero file sync pending?)`,
    });
    return 'skipped';
  }
  const srcExists = await IOUtils.exists(srcPath);
  if (!srcExists) {
    reportWarning({
      category: WARNING_CATEGORY.MISSING_FILE,
      actionType: 'baseline-copy',
      attachmentKey: attachment.key,
      path: relPath,
      reason: 'src-missing',
      message: `Baseline: Zotero storage path missing for ${attachment.key}: ${srcPath}`,
    });
    return 'skipped';
  }

  if (!dryRun) {
    const parent = PathUtils.parent(absDest);
    if (parent && parent !== absDest) {
      await IOUtils.makeDirectory(parent, { ignoreExisting: true, createAncestors: true });
    }
    await IOUtils.copy(srcPath, absDest);

    const hash = await getFileHash(absDest);
    let stat = null;
    try { stat = await IOUtils.stat(absDest); } catch (_e) { /* best effort */ }

    store.add(createFileRecord({
      localPath: relPath,
      canonicalLocalPath: relPath,
      lastSyncedHash: hash,
      lastSyncedSize: stat?.size ?? 0,
      lastSyncedMtime: stat?.lastModified ?? 0,
      zoteroItemKey: _parentItemKey(attachment),
      zoteroAttachmentKey: attachment.key,
      canonicalCollectionKey: canonical.key,
      collectionMembershipKeys: _itemMembershipKeys(item),
      state: STATE.CLEAN,
    }));
  }
  return 'copied';
}

async function _adoptExistingDestFile({ attachment, item, canonical, relPath, absDest, store }) {
  const hash = await getFileHash(absDest);
  let stat = null;
  try { stat = await IOUtils.stat(absDest); } catch (_e) { /* best effort */ }
  store.add(createFileRecord({
    localPath: relPath,
    canonicalLocalPath: relPath,
    lastSyncedHash: hash,
    lastSyncedSize: stat?.size ?? 0,
    lastSyncedMtime: stat?.lastModified ?? 0,
    zoteroItemKey: _parentItemKey(attachment),
    zoteroAttachmentKey: attachment.key,
    canonicalCollectionKey: canonical.key,
    collectionMembershipKeys: _itemMembershipKeys(item),
    state: STATE.CLEAN,
  }));
}

// ─── Enumeration ─────────────────────────────────────────────────────────

/**
 * Recursively walk the sync-root collection tree. Returns:
 *   collections — every non-special subcollection (excluding the sync root)
 *   attachments — Map<attachmentKey, {attachment, item}> seen via getChildItems
 */
async function _enumerateUnderSyncRoot(syncRoot) {
  const collections = [];
  const attachmentMap = new Map();
  const libraryID = syncRoot.libraryID;
  const visited = new Set();

  const walk = (collection) => {
    if (visited.has(collection.id)) return;
    visited.add(collection.id);
    if (collection.key !== syncRoot.collection.key) collections.push(collection);

    const items = (typeof collection.getChildItems === 'function')
      ? (collection.getChildItems(false, false) || [])
      : [];
    for (const item of items) {
      if (!item) continue;
      if (item.isAttachment && item.isAttachment()) {
        attachmentMap.set(item.key, { attachment: item, item });
      } else {
        const attIDs = (typeof item.getAttachments === 'function')
          ? (item.getAttachments() || []) : [];
        for (const attID of attIDs) {
          const att = Zotero.Items.get(attID);
          if (att?.isAttachment && att.isAttachment()) {
            attachmentMap.set(att.key, { attachment: att, item });
          }
        }
      }
    }

    const children = Zotero.Collections.getByParent(collection.id, libraryID) || [];
    for (const child of children) {
      if (isSpecialCollection(child)) continue;
      walk(child);
    }
  };

  walk(syncRoot.collection);
  return { collections, attachments: Array.from(attachmentMap.values()) };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function _toAbs(root, rel) {
  if (!rel) return root;
  const segs = rel.split('/').filter((s) => s.trim() !== '');
  if (segs.length === 0) return root;
  return PathUtils.join(root, ...segs);
}

function _parentKeyOf(collection) {
  if (!collection?.parentID) return null;
  const parent = Zotero.Collections.get(collection.parentID);
  return parent?.key ?? null;
}

function _parentItemKey(attachment) {
  if (!attachment) return null;
  if (typeof attachment.parentItemID === 'number' && attachment.parentItemID > 0) {
    const parent = Zotero.Items.get(attachment.parentItemID);
    return parent?.key ?? null;
  }
  return null;
}

function _itemMembershipKeys(item) {
  if (!item || typeof item.getCollections !== 'function') return [];
  const ids = item.getCollections() || [];
  const keys = [];
  for (const id of ids) {
    const c = Zotero.Collections.get(id);
    if (c?.key) keys.push(c.key);
  }
  return keys;
}
