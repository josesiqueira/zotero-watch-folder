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

import { getPref, setPref, getFileHash, relativePath } from './utils.mjs';
import {
  resolveSyncRoot,
  collectionKeyToRelativePath,
  chooseCanonicalCollection,
  isSpecialCollection,
} from './canonicalPath.mjs';
import { createFileRecord, createCollectionRecord, STATE } from './trackingStore.mjs';
import { report as reportWarning, WARNING_CATEGORY } from './warningSink.mjs';
import { scanFolderRecursive } from './fileScanner.mjs';

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
  let copies = 0, mkdirs = 0, errors = 0, reconciles = 0;

  try {
    const { collections, attachments } = await _enumerateUnderSyncRoot(syncRoot);

    // B.7 — build a disk-file hash index ONCE so the per-attachment
    // copy step can detect content that already exists on disk at a
    // non-canonical path. Adopts it as the tracked record instead of
    // copying from Zotero storage (which would duplicate the bytes).
    // The index is the dominant cost of baseline on large trees — we
    // skip it in dryRun to keep planning cheap.
    const diskHashIndex = dryRun ? null : await _buildDiskHashIndex(watchRoot);

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
          attachment, item, syncRoot, watchRoot, store, dryRun, diskHashIndex,
        });
        if (result === 'copied') copies++;
        else if (result === 'adopted-different-path') reconciles++;
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

    Zotero.debug(`[WatchFolder] baseline: complete (copies=${copies} mkdirs=${mkdirs} reconciles=${reconciles} errors=${errors})`);
    return { ok: true, baselineRan: true, copies, mkdirs, reconciles, errors };
  } catch (e) {
    Zotero.logError(`[WatchFolder] baseline: ${e?.message ?? e}`);
    return { ok: false, baselineRan: false, error: String(e?.message ?? e) };
  }
}

// ─── Per-attachment copy (also exported for adopt-into-scope + late-attach) ─

/**
 * Copy a single Zotero attachment to its canonical local path under
 * the sync root, inserting a tracked FileRecord. Used by:
 *   - runBaseline (full initial reconcile)
 *   - collectionWatcher adopt-into-scope (A4 fix)
 *   - itemAddHandler late-attached PDF flow (A8 fix)
 *
 * Returns 'copied' / 'skipped' / 'adopted'. Errors propagate; callers
 * should report via warningSink.
 *
 * @param {Object} args
 * @param {Object} args.attachment - Zotero attachment Item.
 * @param {Object} args.item       - Owning Item (parent if attached, else attachment itself).
 * @param {Object} args.syncRoot   - { collection, libraryID } from resolveSyncRoot.
 * @param {string} args.watchRoot
 * @param {Object} args.store      - TrackingStore.
 * @param {boolean} [args.dryRun=false]
 */
export async function copyAttachmentToCanonical(args) {
  return _copyAttachmentToCanonical(args);
}

/**
 * Same shape as runBaseline but scoped to a single subtree. Used by
 * collectionWatcher's adopt-into-scope path so a Zotero collection
 * moved INTO the sync root gets its existing attachments copied to
 * local (instead of just an empty mkdir).
 *
 * Does NOT touch the baselineCompletedForRoot pref — this is a partial
 * reconcile that runs on demand, not the full one-shot install baseline.
 *
 * @param {Object} args
 * @param {Object} args.rootCollection - The collection to walk from.
 * @param {Object} args.syncRoot
 * @param {string} args.watchRoot
 * @param {Object} args.store
 * @param {boolean} [args.dryRun=false]
 * @returns {Promise<{ok: boolean, copies: number, mkdirs: number, errors: number}>}
 */
export async function adoptCollectionSubtree({ rootCollection, syncRoot, watchRoot, store, dryRun = false, diskHashIndex }) {
  if (!rootCollection || !syncRoot || !watchRoot || !store) {
    return { ok: false, copies: 0, mkdirs: 0, errors: 0, reason: 'invalid-args' };
  }
  let copies = 0, mkdirs = 0, errors = 0, reconciles = 0;
  try {
    const { collections, attachments } = _enumerateFrom(rootCollection, syncRoot);
    // Adopt uses the same B.7 reconcile as the install-time baseline:
    // if disk already has the bytes elsewhere, link instead of duplicate.
    // Caller may pre-supply an index (e.g. shared across many adopt calls
    // in a session); otherwise we build a scoped one for this subtree.
    const index = (typeof diskHashIndex !== 'undefined')
      ? diskHashIndex
      : (dryRun ? null : await _buildDiskHashIndex(watchRoot));
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
        } else if (!store.getCollectionRecord(col.key) && !dryRun) {
          store.add(createCollectionRecord({
            localPath: relPath,
            zoteroCollectionKey: col.key,
            parentCollectionKey: _parentKeyOf(col),
            state: STATE.CLEAN,
          }));
        }
      } catch (e) {
        errors++;
        reportWarning({
          category: WARNING_CATEGORY.IO_ERROR,
          actionType: 'adopt-mkdir',
          collectionKey: col.key,
          path: relPath,
          reason: 'mkdir-failed',
          message: `Adopt-into-scope mkdir failed for "${relPath}": ${e?.message ?? e}`,
        });
      }
    }
    for (const { attachment, item } of attachments) {
      try {
        const result = await _copyAttachmentToCanonical({
          attachment, item, syncRoot, watchRoot, store, dryRun, diskHashIndex: index,
        });
        if (result === 'copied') copies++;
        else if (result === 'adopted-different-path') reconciles++;
      } catch (e) {
        errors++;
        reportWarning({
          category: WARNING_CATEGORY.IO_ERROR,
          actionType: 'adopt-copy',
          attachmentKey: attachment?.key ?? null,
          reason: 'copy-failed',
          message: `Adopt-into-scope copy failed: ${e?.message ?? e}`,
        });
      }
    }
    if (!dryRun) {
      try { await store.save(); } catch (_e) { /* logged */ }
    }
    return { ok: true, copies, mkdirs, reconciles, errors };
  } catch (e) {
    Zotero.logError(`[WatchFolder] adoptCollectionSubtree: ${e?.message ?? e}`);
    return { ok: false, copies, mkdirs, errors, error: String(e?.message ?? e) };
  }
}

/**
 * Returns one of:
 *   'copied'                  — copied from Zotero storage to canonical
 *   'adopted-different-path'  — disk had a hash-matching file elsewhere; linked
 *   'skipped'                 — destination existed (adopted) or nothing to do
 * Throws on hard IO failures.
 */
async function _copyAttachmentToCanonical({ attachment, item, syncRoot, watchRoot, store, dryRun, diskHashIndex }) {
  const filename = attachment.attachmentFilename;
  if (!filename) return 'skipped';

  const canonical = await chooseCanonicalCollection(item, syncRoot.collection);
  if (!canonical) return 'skipped';
  const relDir = await collectionKeyToRelativePath(canonical.key);
  if (relDir == null) return 'skipped';
  const relPath = relDir === '' ? filename : `${relDir}/${filename}`;
  const absDest = _toAbs(watchRoot, relPath);

  // Don't trample existing files. If the destination already has a file,
  // adopt it (hash-link to the Zotero attachment) so the dedup paths
  // recognise the pair.
  const destExists = await IOUtils.exists(absDest);
  if (destExists) {
    if (!store.getByAttachmentKey(attachment.key) && !dryRun) {
      await _adoptExistingDestFile({ attachment, item, canonical, relPath, absDest, store });
    }
    return 'skipped';
  }

  // Already tracked elsewhere — skip (shouldn't happen on a true first run).
  if (store.getByAttachmentKey(attachment.key)) return 'skipped';

  // ── B.7 cross-path reconcile ────────────────────────────────────
  // Before copying from Zotero storage, see if disk already has the
  // same content at a non-canonical path. If yes, adopt that file
  // instead of duplicating bytes.
  if (diskHashIndex && !dryRun) {
    const attHash = await _attachmentContentHash(attachment);
    if (attHash) {
      const matchAbs = diskHashIndex.get(attHash);
      if (matchAbs && matchAbs !== absDest) {
        const matchRel = relativePath(matchAbs, watchRoot);
        if (matchRel != null && matchRel !== '') {
          // Don't double-claim: a future iteration with the same hash
          // (e.g. two Zotero attachments sharing bytes) must fall
          // through to its own copy.
          diskHashIndex.delete(attHash);
          let stat = null;
          try { stat = await IOUtils.stat(matchAbs); } catch (_e) { /* best effort */ }
          // Accept the disk layout — localPath = disk path,
          // canonicalLocalPath also = disk path so canonical recompute
          // doesn't immediately relocate the user's chosen layout.
          store.add(createFileRecord({
            localPath: matchRel,
            canonicalLocalPath: matchRel,
            lastSyncedHash: attHash,
            lastSyncedSize: stat?.size ?? 0,
            lastSyncedMtime: stat?.lastModified ?? 0,
            zoteroItemKey: _parentItemKey(attachment),
            zoteroAttachmentKey: attachment.key,
            canonicalCollectionKey: canonical.key,
            collectionMembershipKeys: _itemMembershipKeys(item),
            state: STATE.CLEAN,
          }));
          Zotero.debug(`[WatchFolder] baseline B.7: linked ${attachment.key} → existing disk file ${matchRel} (canonical would have been ${relPath})`);
          return 'adopted-different-path';
        }
      }
    }
  }

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
 * Walk just the subtree rooted at `rootCollection` (which may be any
 * collection under the sync root, including `syncRoot.collection`
 * itself). Sync-version of _enumerateUnderSyncRoot, scoped narrower.
 *
 * @returns {{collections: Array, attachments: Array<{attachment, item}>}}
 */
function _enumerateFrom(rootCollection, syncRoot) {
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
  walk(rootCollection);
  return { collections, attachments: Array.from(attachmentMap.values()) };
}

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

/**
 * Walk the watch folder and hash every file. Returns a Map<hash, absPath>
 * keyed by full-file SHA-256 (see utils.getFileHash). On hash collision
 * (multiple disk files sharing content), the FIRST encountered path
 * wins; subsequent paths are silently dropped.
 *
 * Used by B.7 hash reconcile in the initial baseline. Skipped in dryRun.
 */
async function _buildDiskHashIndex(watchRoot) {
  const index = new Map();
  let files = [];
  try { files = await scanFolderRecursive(watchRoot); }
  catch (e) {
    Zotero.debug(`[WatchFolder] baseline B.7: hash-index scan failed: ${e?.message ?? e}`);
    return index;
  }
  for (const fileInfo of files) {
    if (!fileInfo?.path) continue;
    const hash = await getFileHash(fileInfo.path);
    if (!hash) continue;
    if (!index.has(hash)) index.set(hash, fileInfo.path);
  }
  Zotero.debug(`[WatchFolder] baseline B.7: hashed ${files.length} disk files, ${index.size} unique hashes`);
  return index;
}

/**
 * Best-effort content hash for a Zotero attachment. Reads the file at
 * the attachment's storage path via IOUtils — there's no shortcut from
 * Zotero's existing metadata to a SHA-256-of-first-1MB. Returns null
 * when the file is unavailable (not yet synced, missing, etc).
 */
async function _attachmentContentHash(attachment) {
  if (!attachment || typeof attachment.getFilePathAsync !== 'function') return null;
  let srcPath = null;
  try { srcPath = await attachment.getFilePathAsync(); }
  catch (_e) { return null; }
  if (!srcPath) return null;
  let exists = false;
  try { exists = await IOUtils.exists(srcPath); }
  catch (_e) { return null; }
  if (!exists) return null;
  return getFileHash(srcPath);
}

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
