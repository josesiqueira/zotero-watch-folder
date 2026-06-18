/**
 * Suppression Resolver — v2.1 Phase B.
 *
 * When a Zotero item loses its last sync-root membership, the executor
 * flips its FileRecord state to OUT_OF_SCOPE_SUPPRESSED and the local
 * file is left in place. This module implements the four user-facing
 * resolutions per spec §"Suppression rule to prevent re-import loops":
 *
 *   REINSTATE     — Re-add to Zotero sync root
 *   KEEP_LOCAL    — Keep local file but stop syncing it
 *   TRASH         — Move local file to OS trash
 *   MOVE_OUTSIDE  — Move local file outside the watch folder
 *
 * `resolve(record, action, opts)` is the single entry point for files.
 * `resolveCollection(record, action, opts)` is the entry point for
 * suppressed CollectionRecords (folder-side analogue of the file flow).
 * `resolveConflict(record, action, opts)` resolves CONFLICT_BLOCKED
 * FileRecords flagged by the move/delete conflict gate.
 *
 * Internal handlers receive a `ctx` object so the resolver can be
 * unit-tested with stubs in place of the live tracking store / Zotero /
 * IOUtils.
 *
 * Every handler that mutates the tracking store wraps the mutation in
 * a rollback guard: the pre-mutation snapshot is captured first, the
 * store is mutated, and `store.save()` is awaited. If the save throws,
 * the in-memory snapshot is restored so a restart re-reads a state
 * consistent with what was last persisted (see `_saveWithRollback`).
 *
 * @module suppressionResolver
 */

import {
  getTrackingStore,
  createTombstoneRecord,
  STATE,
} from './trackingStore.mjs';
import { resolveSyncRoot, relativePathToCollection } from './canonicalPath.mjs';
import { getPref, getFileHash } from './utils.mjs';
import { report as reportWarning, WARNING_CATEGORY } from './warningSink.mjs';

const TRASH_DIRNAME = '.zotero-watch-trash';

export const RESOLUTION_ACTION = Object.freeze({
  REINSTATE: 'reinstate',
  KEEP_LOCAL: 'keep-local',
  TRASH: 'trash',
  MOVE_OUTSIDE: 'move-outside',
});

export const COLLECTION_RESOLUTION_ACTION = Object.freeze({
  REINSTATE: 'reinstate-collection',
  KEEP_LOCAL: 'keep-local-collection',
  TRASH: 'trash-collection',
  MOVE_OUTSIDE: 'move-outside-collection',
});

export const CONFLICT_RESOLUTION_ACTION = Object.freeze({
  RESTAMP_BASELINE: 'restamp-baseline',
  DISCARD_LOCAL: 'discard-local',
  PAUSE_SYNC: 'pause-sync',
});

/**
 * List all currently suppressed FileRecords (state ===
 * OUT_OF_SCOPE_SUPPRESSED). Defaults to the singleton tracking store.
 * @param {object} [store]
 * @returns {Array}
 */
export function listSuppressed(store) {
  const s = store || getTrackingStore();
  if (!s || typeof s.getSuppressedFiles !== 'function') return [];
  // The store throws if init() hasn't been called yet; tolerate that
  // gracefully so prefs-pane UI doesn't blow up on early load.
  try { return s.getSuppressedFiles(); }
  catch (_e) { return []; }
}

/**
 * List all currently suppressed CollectionRecords. Mode 2 flips folder
 * records to OUT_OF_SCOPE_SUPPRESSED on Zotero-side delete; the prefs
 * UI uses this together with `resolveCollection` to surface them for
 * the user to act on.
 * @param {object} [store]
 * @returns {Array}
 */
export function listSuppressedCollections(store) {
  const s = store || getTrackingStore();
  if (!s || typeof s.getSuppressedCollections !== 'function') return [];
  try { return s.getSuppressedCollections(); }
  catch (_e) { return []; }
}

/**
 * List all FileRecords currently flagged CONFLICT_BLOCKED — files
 * whose conflict gate refused a move/delete because of local hash
 * drift. The prefs UI uses this together with `resolveConflict` to
 * surface them for the user to act on.
 * @param {object} [store]
 * @returns {Array}
 */
/**
 * Enumerate top-level directories inside the plugin trash
 * (`<watchRoot>/.zotero-watch-trash/`). These come from
 * `mirrorExecutor._deleteFolder` Mode 3 moves: when Zotero deletes a
 * tracked collection, the local folder lands here so the user can
 * restore it via the prefs pane.
 *
 * The original folder name may have been suffixed with a millisecond
 * timestamp on collision (e.g. `Methods.1779671312304`). The returned
 * `originalName` strips that suffix back to the user-meaningful name;
 * `name` is the on-disk name in plugin trash (the source-of-truth for
 * the restore move).
 *
 * @param {Object} [opts]
 * @param {string} [opts.watchRoot] - Override the `sourcePath` pref.
 * @returns {Promise<Array<{name: string, originalName: string, fullPath: string}>>}
 */
export async function listTrashedFolders(opts = {}) {
  const watchRoot = opts.watchRoot ?? getPref('sourcePath');
  if (!watchRoot) return [];
  const trashAbs = PathUtils.join(watchRoot, TRASH_DIRNAME);
  let exists = false;
  try { exists = await IOUtils.exists(trashAbs); }
  catch (_e) { return []; }
  if (!exists) return [];
  let children = [];
  try { children = (await IOUtils.getChildren(trashAbs)) || []; }
  catch (_e) { return []; }
  const out = [];
  for (const child of children) {
    let info;
    try { info = await IOUtils.stat(child); }
    catch (_e) { continue; }
    if (info?.type !== 'directory') continue;
    const name = PathUtils.filename(child);
    if (!name) continue;
    // Strip a trailing `.<ms-timestamp>` collision suffix when present.
    // mirrorExecutor uses Date.now() (10+ digits, no extension) for dir
    // collisions, so the stripped name is the original collection name.
    const m = name.match(/^(.+)\.(\d{10,})$/);
    const originalName = m ? m[1] : name;
    out.push({ name, originalName, fullPath: child });
  }
  // Newest-first ordering is friendliest in the UI.
  out.sort((a, b) => b.name.localeCompare(a.name));
  return out;
}

/**
 * Restore a folder out of plugin trash. Moves the directory back to
 * `<watchRoot>/<originalName>` (RST.6 collision: appends
 * `.restored.<timestamp>` to the dir name when the target is occupied)
 * and re-creates the Zotero collection chain via
 * `relativePathToCollection({createIfMissing: true})`. The next scan
 * cycle picks up the contained files and imports them into the
 * recreated collection.
 *
 * Returns `{ok: true, restoredTo}` on success or `{ok: false, reason, error?}`
 * otherwise. Does NOT re-link previously-deleted Zotero attachments —
 * folder deletes drop tracking + don't tombstone (per spec, collection
 * removal is a scope change). Re-import happens via the normal scanner.
 *
 * @param {{name: string, originalName?: string}} entry
 *   `name` is the on-disk name inside plugin trash; `originalName`
 *   (optional) is the user-meaningful name to restore to. When omitted,
 *   the timestamp-suffix-stripped form of `name` is used.
 * @param {Object} [opts]
 * @param {string} [opts.watchRoot]
 */
export async function restoreTrashedFolder(entry, opts = {}) {
  if (!entry || typeof entry.name !== 'string' || !entry.name) {
    return { ok: false, reason: 'invalid-entry' };
  }
  const watchRoot = opts.watchRoot ?? getPref('sourcePath');
  if (!watchRoot) return { ok: false, reason: 'no-watch-root' };

  const srcAbs = PathUtils.join(watchRoot, TRASH_DIRNAME, entry.name);
  if (!(await IOUtils.exists(srcAbs).catch(() => false))) {
    return { ok: false, reason: 'trash-source-missing' };
  }
  const stripped = entry.originalName
    || (entry.name.match(/^(.+)\.(\d{10,})$/)?.[1])
    || entry.name;
  let dstRel = stripped;
  let dstAbs = PathUtils.join(watchRoot, dstRel);

  // RST.6 collision: existing local file/dir at the target → suffix.
  if (await IOUtils.exists(dstAbs).catch(() => false)) {
    const stamp = Date.now();
    dstRel = `${stripped}.restored.${stamp}`;
    dstAbs = PathUtils.join(watchRoot, dstRel);
  }

  try {
    await IOUtils.move(srcAbs, dstAbs);
  } catch (moveErr) {
    // Cross-FS fallback (rare for same-watch-root moves).
    try {
      await IOUtils.copy(srcAbs, dstAbs, { recursive: true });
      await IOUtils.remove(srcAbs, { recursive: true });
    } catch (copyErr) {
      try { await IOUtils.remove(dstAbs, { recursive: true, ignoreAbsent: true }); }
      catch (_e) { /* best effort */ }
      return { ok: false, reason: 'io-error', error: String(copyErr?.message ?? copyErr) };
    }
  }

  // Re-create the Zotero collection chain under the sync root. The next
  // scan cycle picks up the files inside and imports them. Best-effort:
  // a failure here doesn't roll back the disk move (the user can still
  // see the folder + work with it manually).
  try {
    await relativePathToCollection(dstRel, { createIfMissing: true });
  } catch (e) {
    return { ok: true, restoredTo: dstRel, warning: `collection-recreate-failed: ${e?.message ?? e}` };
  }
  return { ok: true, restoredTo: dstRel };
}

export function listConflicted(store) {
  const s = store || getTrackingStore();
  if (!s || typeof s.getConflictedFiles !== 'function') return [];
  try { return s.getConflictedFiles(); }
  catch (_e) { return []; }
}

/**
 * List all FileRecords currently flagged MISSING — local files that
 * disappeared from disk under Mode 1 / Mode 2, where the deletion is
 * deliberately NOT propagated to Zotero. The prefs UI uses this
 * together with `stopTrackingMissing` to surface them and let the user
 * stop tracking the gone-from-disk file. Defaults to the singleton
 * tracking store.
 * @param {object} [store]
 * @returns {Array}
 */
export function listMissing(store) {
  const s = store || getTrackingStore();
  if (!s || typeof s.getMissingFiles !== 'function') return [];
  // The store throws if init() hasn't been called yet; tolerate that
  // gracefully so the prefs-pane UI doesn't blow up on early load.
  try { return s.getMissingFiles(); }
  catch (_e) { return []; }
}

/**
 * Stop tracking a MISSING file — TRACKING-ONLY.
 *
 * Removes ONLY the plugin's tracking record for the given localPath and
 * persists the store (with snapshot + rollback on a save() failure, per
 * the resolver contract). It NEVER touches the Zotero item: no trash, no
 * erase, no detach, no tombstone. This upholds the Mode 1 / Mode 2
 * no-delete contract — the file is already gone from disk, so the only
 * thing to clean up is the now-dangling tracking entry; the Zotero
 * attachment is intentionally preserved for the user to keep or remove
 * themselves.
 *
 * Because no tombstone is written, the Zotero attachment is NOT made
 * re-linkable by hash — this is a forget, not a soft-delete.
 *
 * @param {string} localPath - localPath of the MISSING FileRecord.
 * @param {object} [opts]
 * @param {object} [opts.store] - Test seam: override the singleton store.
 * @returns {Promise<{ok: boolean, reason?: string, error?: string}>}
 */
export async function stopTrackingMissing(localPath, opts = {}) {
  if (typeof localPath !== 'string' || !localPath) {
    return { ok: false, reason: 'invalid-path' };
  }
  const store = opts.store || getTrackingStore();
  if (!store) return { ok: false, reason: 'no-store' };

  let record;
  try { record = store.getByLocalPath(localPath); }
  catch (_e) { record = null; }
  if (!record || record.type !== 'file') {
    return { ok: false, reason: 'invalid-record' };
  }
  if (record.state !== STATE.MISSING) {
    return { ok: false, reason: 'not-missing' };
  }

  // Snapshot first so a failed save() can be rolled back, leaving the
  // record exactly as it was. TRACKING-ONLY: store.remove() drops the
  // tracking entry; there is no Zotero item delete/trash/erase here.
  const snapshot = _snapshotFileRecord(record);
  store.remove(localPath);
  try {
    await store.save();
  } catch (saveErr) {
    store.add({ ...snapshot });
    _reportSaveFailure(saveErr, record);
    return { ok: false, reason: 'save-failed', error: String(saveErr?.message ?? saveErr) };
  }
  return { ok: true };
}

/**
 * Apply a resolution action to a suppressed FileRecord.
 *
 * @param {object} record - FileRecord with state===OUT_OF_SCOPE_SUPPRESSED.
 * @param {string} action - One of RESOLUTION_ACTION.*
 * @param {object} [opts]
 * @param {string} [opts.targetDir] - Required for MOVE_OUTSIDE.
 * @param {object} [opts.store] - Test seam: override the singleton store.
 * @returns {Promise<{ok: boolean, reason?: string, error?: string}>}
 */
export async function resolve(record, action, opts = {}) {
  if (!record || typeof record !== 'object' || record.type !== 'file') {
    return { ok: false, reason: 'invalid-record' };
  }
  const store = opts.store || getTrackingStore();
  if (!store) return { ok: false, reason: 'no-store' };

  const watchRoot = opts.watchRoot ?? getPref('sourcePath');
  if (!watchRoot && action !== RESOLUTION_ACTION.REINSTATE) {
    // REINSTATE doesn't need the watch root because no IO happens on disk.
    return { ok: false, reason: 'no-watch-root' };
  }

  let syncRoot = opts.syncRoot;
  if (typeof syncRoot === 'undefined' && action === RESOLUTION_ACTION.REINSTATE) {
    try { syncRoot = await resolveSyncRoot(); }
    catch (e) { return { ok: false, reason: 'sync-root-error', error: String(e?.message ?? e) }; }
    if (!syncRoot) return { ok: false, reason: 'no-sync-root' };
  }

  const ctx = { store, watchRoot, syncRoot, opts };
  switch (action) {
    case RESOLUTION_ACTION.REINSTATE:    return _reinstate(record, ctx);
    case RESOLUTION_ACTION.KEEP_LOCAL:   return _keepLocal(record, ctx);
    case RESOLUTION_ACTION.TRASH:        return _trash(record, ctx);
    case RESOLUTION_ACTION.MOVE_OUTSIDE: return _moveOutside(record, ctx);
    default: return { ok: false, reason: 'unknown-action' };
  }
}

/**
 * Apply a resolution action to a suppressed CollectionRecord
 * (state===OUT_OF_SCOPE_SUPPRESSED).
 *
 * @param {object} record - CollectionRecord with state===OUT_OF_SCOPE_SUPPRESSED.
 * @param {string} action - One of COLLECTION_RESOLUTION_ACTION.*
 * @param {object} [opts]
 * @param {string} [opts.targetDir] - Required for MOVE_OUTSIDE.
 * @param {object} [opts.store] - Test seam: override the singleton store.
 * @param {object} [opts.syncRoot] - Test seam: override sync-root info.
 * @param {string} [opts.watchRoot] - Test seam: override the watch root path.
 * @returns {Promise<{ok: boolean, reason?: string, error?: string}>}
 */
export async function resolveCollection(record, action, opts = {}) {
  if (!record || typeof record !== 'object' || record.type !== 'collection') {
    return { ok: false, reason: 'invalid-record' };
  }
  const store = opts.store || getTrackingStore();
  if (!store) return { ok: false, reason: 'no-store' };

  const watchRoot = opts.watchRoot ?? getPref('sourcePath');
  if (!watchRoot && action !== COLLECTION_RESOLUTION_ACTION.REINSTATE
                 && action !== COLLECTION_RESOLUTION_ACTION.KEEP_LOCAL) {
    return { ok: false, reason: 'no-watch-root' };
  }

  let syncRoot = opts.syncRoot;
  if (typeof syncRoot === 'undefined' && action === COLLECTION_RESOLUTION_ACTION.REINSTATE) {
    try { syncRoot = await resolveSyncRoot(); }
    catch (e) { return { ok: false, reason: 'sync-root-error', error: String(e?.message ?? e) }; }
    if (!syncRoot) return { ok: false, reason: 'no-sync-root' };
  }

  const ctx = { store, watchRoot, syncRoot, opts };
  switch (action) {
    case COLLECTION_RESOLUTION_ACTION.REINSTATE:    return _reinstateCollection(record, ctx);
    case COLLECTION_RESOLUTION_ACTION.KEEP_LOCAL:   return _keepLocalCollection(record, ctx);
    case COLLECTION_RESOLUTION_ACTION.TRASH:        return _trashCollection(record, ctx);
    case COLLECTION_RESOLUTION_ACTION.MOVE_OUTSIDE: return _moveOutsideCollection(record, ctx);
    default: return { ok: false, reason: 'unknown-action' };
  }
}

/**
 * Apply a resolution action to a CONFLICT_BLOCKED FileRecord. The
 * conflict gate (mirrorExecutor.canSafelyMove) flips records to this
 * state when a move/delete would touch a file whose disk content has
 * drifted from `lastSyncedHash`.
 *
 * @param {object} record - FileRecord with state===CONFLICT_BLOCKED.
 * @param {string} action - One of CONFLICT_RESOLUTION_ACTION.*
 * @param {object} [opts]
 * @param {object} [opts.store] - Test seam.
 * @param {object} [opts.syncRoot] - Test seam.
 * @param {string} [opts.watchRoot] - Test seam.
 * @returns {Promise<{ok: boolean, reason?: string, error?: string}>}
 */
export async function resolveConflict(record, action, opts = {}) {
  if (!record || typeof record !== 'object' || record.type !== 'file') {
    return { ok: false, reason: 'invalid-record' };
  }
  const store = opts.store || getTrackingStore();
  if (!store) return { ok: false, reason: 'no-store' };

  const watchRoot = opts.watchRoot ?? getPref('sourcePath');
  if (!watchRoot && action !== CONFLICT_RESOLUTION_ACTION.PAUSE_SYNC) {
    return { ok: false, reason: 'no-watch-root' };
  }

  let syncRoot = opts.syncRoot;
  if (typeof syncRoot === 'undefined' && action === CONFLICT_RESOLUTION_ACTION.DISCARD_LOCAL) {
    try { syncRoot = await resolveSyncRoot(); }
    catch (e) { return { ok: false, reason: 'sync-root-error', error: String(e?.message ?? e) }; }
    if (!syncRoot) return { ok: false, reason: 'no-sync-root' };
  }

  const ctx = { store, watchRoot, syncRoot, opts };
  switch (action) {
    case CONFLICT_RESOLUTION_ACTION.RESTAMP_BASELINE: return _restampBaseline(record, ctx);
    case CONFLICT_RESOLUTION_ACTION.DISCARD_LOCAL:    return _discardLocal(record, ctx);
    case CONFLICT_RESOLUTION_ACTION.PAUSE_SYNC:       return _pauseSyncFile(record, ctx);
    default: return { ok: false, reason: 'unknown-action' };
  }
}

// ─── File-record resolution handlers ───────────────────────────────────────

async function _reinstate(record, ctx) {
  const { store, syncRoot } = ctx;
  if (!record.zoteroAttachmentKey) return { ok: false, reason: 'no-attachment-key' };
  const libraryID = syncRoot.libraryID;

  let attachment;
  try {
    attachment = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, record.zoteroAttachmentKey);
  } catch (e) {
    return { ok: false, reason: 'lookup-failed', error: String(e?.message ?? e) };
  }
  if (!attachment) return { ok: false, reason: 'attachment-missing' };

  // Add the parent (or the attachment itself if standalone) to the sync-root collection.
  let target = attachment;
  try {
    if (typeof attachment.parentItemID === 'number' && attachment.parentItemID > 0) {
      const parent = Zotero.Items.get(attachment.parentItemID);
      if (parent) target = parent;
    }
  } catch (_e) { /* fall back to attachment */ }

  // Library scope: there is no single sync-root collection to re-add the item
  // to. "Reinstate" simply lifts the suppression — the item resumes syncing as
  // an Unfiled item at the watch-folder root (no Zotero collection mutation).
  if (syncRoot.isLibraryRoot) {
    const snapshot = _snapshotFileRecord(record);
    store.update(record.localPath, {
      state: STATE.CLEAN,
      canonicalCollectionKey: record.canonicalCollectionKey ?? null,
    });
    const saveResult = await _saveWithFileRollback(store, record.localPath, snapshot, record);
    if (!saveResult.ok) return saveResult;
    return { ok: true };
  }

  try {
    await Zotero.DB.executeTransaction(async () => {
      target.addToCollection(syncRoot.collection.id);
      await target.save();
    });
  } catch (e) {
    return { ok: false, reason: 'save-failed', error: String(e?.message ?? e) };
  }

  const snapshot = _snapshotFileRecord(record);
  const memberships = new Set(record.collectionMembershipKeys || []);
  memberships.add(syncRoot.collection.key);
  store.update(record.localPath, {
    state: STATE.CLEAN,
    canonicalCollectionKey: record.canonicalCollectionKey ?? syncRoot.collection.key,
    collectionMembershipKeys: Array.from(memberships),
  });
  const saveResult = await _saveWithFileRollback(store, record.localPath, snapshot, record);
  if (!saveResult.ok) return saveResult;
  return { ok: true };
}

async function _keepLocal(record, ctx) {
  const { store } = ctx;
  const snapshot = _snapshotFileRecord(record);
  store.update(record.localPath, { state: STATE.USER_DETACHED });
  const saveResult = await _saveWithFileRollback(store, record.localPath, snapshot, record);
  if (!saveResult.ok) return saveResult;
  return { ok: true };
}

async function _trash(record, ctx) {
  const { store, watchRoot } = ctx;
  const absPath = _toAbs(watchRoot, record.localPath);
  try {
    await _moveToOSTrash(absPath);
  } catch (e) {
    reportWarning({
      category: WARNING_CATEGORY.IO_ERROR,
      actionType: 'suppression-trash',
      attachmentKey: record.zoteroAttachmentKey,
      path: record.localPath,
      reason: 'trash-failed',
      message: `Failed to move "${record.localPath}" to OS trash: ${e?.message ?? e}`,
    });
    return { ok: false, reason: 'io-error', error: String(e?.message ?? e) };
  }
  // FS mutation already happened; on save() failure we can only roll back
  // the tracking-store changes (the file is already in the OS trash).
  return _applyTombstoneRemove(store, record);
}

async function _moveOutside(record, ctx) {
  const { store, watchRoot, opts } = ctx;
  const targetDir = opts?.targetDir;
  if (!targetDir || typeof targetDir !== 'string') {
    return { ok: false, reason: 'no-target-dir' };
  }
  const srcAbs = _toAbs(watchRoot, record.localPath);
  const filename = _filenameOf(record.localPath);
  if (!filename) return { ok: false, reason: 'invalid-record' };
  const dstAbs = PathUtils.join(targetDir, filename);

  let movedReason = null;
  try {
    await IOUtils.move(srcAbs, dstAbs, { noOverwrite: true });
  } catch (moveErr) {
    // Cross-FS fallback: copy + remove.
    try {
      await IOUtils.copy(srcAbs, dstAbs);
      await IOUtils.remove(srcAbs);
      movedReason = 'copy-fallback';
    } catch (copyErr) {
      try { await IOUtils.remove(dstAbs, { ignoreAbsent: true }); }
      catch (_e) { /* best effort */ }
      reportWarning({
        category: WARNING_CATEGORY.IO_ERROR,
        actionType: 'suppression-move-outside',
        attachmentKey: record.zoteroAttachmentKey,
        path: record.localPath,
        reason: 'move-failed',
        message: `Failed to move "${record.localPath}" outside watch folder: ${copyErr?.message ?? copyErr}`,
      });
      return { ok: false, reason: 'io-error', error: String(copyErr?.message ?? copyErr) };
    }
  }
  // FS mutation already happened; on save() failure we can only roll back
  // the tracking-store changes (the file is at the new location regardless).
  const tombstoneResult = await _applyTombstoneRemove(store, record);
  if (!tombstoneResult.ok) return tombstoneResult;
  return movedReason ? { ok: true, reason: movedReason } : { ok: true };
}

// ─── Collection-record resolution handlers ─────────────────────────────────

async function _reinstateCollection(record, ctx) {
  const { store, syncRoot } = ctx;
  if (!record.zoteroCollectionKey) return { ok: false, reason: 'no-collection-key' };

  // If the old key still resolves to a live collection (e.g. the user
  // re-created it in Zotero by hand), prefer to re-link rather than
  // create a duplicate.
  let live = null;
  try {
    live = await Zotero.Collections.getByLibraryAndKeyAsync(syncRoot.libraryID, record.zoteroCollectionKey);
  } catch (_e) { /* fall through to create */ }

  // Resolve the parent the recreated collection should hang under. Collection
  // scope: always the sync-root collection. Library scope: derived from the
  // folder's path — a top-level folder gets NO parent (top-level collection);
  // a nested folder resolves/creates its parent-folder collection.
  let parentID; // undefined = top-level
  let parentKey = null;
  if (!syncRoot.isLibraryRoot) {
    parentID = syncRoot.collection.id;
    parentKey = syncRoot.collection.key;
  } else {
    const parentPath = _parentPath(record.localPath);
    if (parentPath) {
      const parentColl = await relativePathToCollection(parentPath, { createIfMissing: true }).catch(() => null);
      if (parentColl && parentColl.id) { parentID = parentColl.id; parentKey = parentColl.key; }
    }
  }

  let newKey = record.zoteroCollectionKey;
  if (!live) {
    const name = _lastSegment(record.localPath) || record.localPath || 'Untitled';
    try {
      const created = await Zotero.DB.executeTransaction(async () => {
        const c = new Zotero.Collection();
        c.libraryID = syncRoot.libraryID;
        c.name = name;
        if (typeof parentID === 'number') c.parentID = parentID; // top-level: leave unset
        await c.save();
        return c;
      });
      newKey = created?.key ?? newKey;
    } catch (e) {
      return { ok: false, reason: 'save-failed', error: String(e?.message ?? e) };
    }
  }

  const snapshot = _snapshotCollectionRecord(record);
  const oldKey = record.zoteroCollectionKey;
  // If the collection key changed we need to drop the old record and
  // re-add a fresh one keyed on the new collection key.
  if (newKey !== oldKey) {
    store.removeCollectionRecord(oldKey);
    store.add({
      ...snapshot,
      zoteroCollectionKey: newKey,
      parentCollectionKey: parentKey,
      state: STATE.CLEAN,
    });
  } else {
    // Same key (re-linked). Mutate the existing record in place via a
    // remove+add so the indexes stay coherent and the state flips.
    store.removeCollectionRecord(oldKey);
    store.add({
      ...snapshot,
      parentCollectionKey: parentKey,
      state: STATE.CLEAN,
    });
  }

  try {
    await store.save();
  } catch (saveErr) {
    _rollbackCollectionRecord(store, snapshot, newKey !== oldKey ? newKey : null);
    _reportSaveFailure(saveErr, { localPath: record.localPath, zoteroCollectionKey: oldKey });
    return { ok: false, reason: 'save-failed', error: String(saveErr?.message ?? saveErr) };
  }
  return { ok: true };
}

async function _keepLocalCollection(record, ctx) {
  const { store } = ctx;
  const snapshot = _snapshotCollectionRecord(record);
  store.removeCollectionRecord(record.zoteroCollectionKey);
  store.add({ ...snapshot, state: STATE.USER_DETACHED });
  try {
    await store.save();
  } catch (saveErr) {
    _rollbackCollectionRecord(store, snapshot, null);
    _reportSaveFailure(saveErr, { localPath: record.localPath, zoteroCollectionKey: record.zoteroCollectionKey });
    return { ok: false, reason: 'save-failed', error: String(saveErr?.message ?? saveErr) };
  }
  return { ok: true };
}

async function _trashCollection(record, ctx) {
  const { store, watchRoot } = ctx;
  const absPath = _toAbs(watchRoot, record.localPath);
  try {
    await _moveToOSTrash(absPath);
  } catch (e) {
    reportWarning({
      category: WARNING_CATEGORY.IO_ERROR,
      actionType: 'suppression-trash-collection',
      collectionKey: record.zoteroCollectionKey,
      path: record.localPath,
      reason: 'trash-failed',
      message: `Failed to move folder "${record.localPath}" to OS trash: ${e?.message ?? e}`,
    });
    return { ok: false, reason: 'io-error', error: String(e?.message ?? e) };
  }
  // FS mutation already happened; on save() failure we can only roll
  // back the tracking-store changes — the folder is already in OS trash.
  return _applyCollectionRemove(store, record);
}

async function _moveOutsideCollection(record, ctx) {
  const { store, watchRoot, opts } = ctx;
  const targetDir = opts?.targetDir;
  if (!targetDir || typeof targetDir !== 'string') {
    return { ok: false, reason: 'no-target-dir' };
  }
  const srcAbs = _toAbs(watchRoot, record.localPath);
  const folderName = _lastSegment(record.localPath);
  if (!folderName) return { ok: false, reason: 'invalid-record' };
  const dstAbs = PathUtils.join(targetDir, folderName);

  let movedReason = null;
  try {
    await IOUtils.move(srcAbs, dstAbs, { noOverwrite: true });
  } catch (moveErr) {
    // Cross-FS fallback: recursive copy + recursive remove.
    try {
      await IOUtils.copy(srcAbs, dstAbs, { recursive: true });
      await IOUtils.remove(srcAbs, { recursive: true });
      movedReason = 'copy-fallback';
    } catch (copyErr) {
      try { await IOUtils.remove(dstAbs, { recursive: true, ignoreAbsent: true }); }
      catch (_e) { /* best effort */ }
      reportWarning({
        category: WARNING_CATEGORY.IO_ERROR,
        actionType: 'suppression-move-outside-collection',
        collectionKey: record.zoteroCollectionKey,
        path: record.localPath,
        reason: 'move-failed',
        message: `Failed to move folder "${record.localPath}" outside watch folder: ${copyErr?.message ?? copyErr}`,
      });
      return { ok: false, reason: 'io-error', error: String(copyErr?.message ?? copyErr) };
    }
  }
  // FS mutation already happened; on save() failure we can only roll
  // back the tracking-store changes — the folder is at the new location.
  const removeResult = await _applyCollectionRemove(store, record);
  if (!removeResult.ok) return removeResult;
  return movedReason ? { ok: true, reason: movedReason } : { ok: true };
}

// ─── Conflict resolution handlers ──────────────────────────────────────────

async function _restampBaseline(record, ctx) {
  const { store, watchRoot } = ctx;
  const absPath = _toAbs(watchRoot, record.localPath);
  const exists = await IOUtils.exists(absPath).catch(() => false);
  if (!exists) {
    reportWarning({
      category: WARNING_CATEGORY.MISSING_FILE,
      actionType: 'conflict-restamp',
      attachmentKey: record.zoteroAttachmentKey,
      path: record.localPath,
      reason: 'missing-file',
      message: `Cannot re-stamp baseline: "${record.localPath}" is missing on disk`,
    });
    return { ok: false, reason: 'missing-file' };
  }
  const newHash = await getFileHash(absPath);
  if (!newHash) {
    reportWarning({
      category: WARNING_CATEGORY.IO_ERROR,
      actionType: 'conflict-restamp',
      attachmentKey: record.zoteroAttachmentKey,
      path: record.localPath,
      reason: 'hash-failed',
      message: `Cannot re-stamp baseline: failed to hash "${record.localPath}"`,
    });
    return { ok: false, reason: 'hash-failed' };
  }
  const snapshot = _snapshotFileRecord(record);
  store.update(record.localPath, { lastSyncedHash: newHash, state: STATE.CLEAN });
  const saveResult = await _saveWithFileRollback(store, record.localPath, snapshot, record);
  if (!saveResult.ok) return saveResult;
  return { ok: true };
}

async function _discardLocal(record, ctx) {
  const { store, watchRoot, syncRoot } = ctx;
  if (!record.zoteroAttachmentKey) return { ok: false, reason: 'no-attachment-key' };

  let attachment;
  try {
    attachment = await Zotero.Items.getByLibraryAndKeyAsync(syncRoot.libraryID, record.zoteroAttachmentKey);
  } catch (e) {
    return { ok: false, reason: 'lookup-failed', error: String(e?.message ?? e) };
  }
  if (!attachment) return { ok: false, reason: 'attachment-missing' };

  let sourcePath = null;
  try {
    sourcePath = await attachment.getFilePathAsync();
  } catch (_e) { /* falls through */ }
  if (!sourcePath) return { ok: false, reason: 'attachment-missing' };

  const dstAbs = _toAbs(watchRoot, record.localPath);
  try {
    await IOUtils.copy(sourcePath, dstAbs);
  } catch (e) {
    reportWarning({
      category: WARNING_CATEGORY.IO_ERROR,
      actionType: 'conflict-discard-local',
      attachmentKey: record.zoteroAttachmentKey,
      path: record.localPath,
      reason: 'copy-failed',
      message: `Failed to copy attachment file over "${record.localPath}": ${e?.message ?? e}`,
    });
    return { ok: false, reason: 'io-error', error: String(e?.message ?? e) };
  }
  const newHash = await getFileHash(dstAbs);
  if (!newHash) {
    reportWarning({
      category: WARNING_CATEGORY.IO_ERROR,
      actionType: 'conflict-discard-local',
      attachmentKey: record.zoteroAttachmentKey,
      path: record.localPath,
      reason: 'hash-failed',
      message: `Failed to re-hash "${record.localPath}" after discard-local`,
    });
    return { ok: false, reason: 'hash-failed' };
  }
  const snapshot = _snapshotFileRecord(record);
  store.update(record.localPath, { lastSyncedHash: newHash, state: STATE.CLEAN });
  const saveResult = await _saveWithFileRollback(store, record.localPath, snapshot, record);
  if (!saveResult.ok) return saveResult;
  return { ok: true };
}

async function _pauseSyncFile(record, ctx) {
  const { store } = ctx;
  const snapshot = _snapshotFileRecord(record);
  store.update(record.localPath, { state: STATE.USER_DETACHED });
  const saveResult = await _saveWithFileRollback(store, record.localPath, snapshot, record);
  if (!saveResult.ok) return saveResult;
  return { ok: true };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function _toAbs(root, rel) {
  if (!rel) return root;
  if (rel.startsWith('/')) return rel;
  if (/^[A-Za-z]:[\\/]/.test(rel)) return rel;
  const segs = rel.split('/').filter((s) => s.trim() !== '');
  if (segs.length === 0) return root;
  return PathUtils.join(root, ...segs);
}

function _filenameOf(p) {
  if (typeof p !== 'string') return '';
  const parts = p.split('/');
  return parts[parts.length - 1] || '';
}

function _lastSegment(p) {
  if (typeof p !== 'string') return '';
  const parts = p.split('/').filter((s) => s.trim() !== '');
  return parts[parts.length - 1] || '';
}

/**
 * The parent relative path of a sync-root-relative folder path, or '' if the
 * folder is top-level. e.g. 'Projects/Alpha/Beta' → 'Projects/Alpha';
 * 'Projects' → ''. Used in library scope to resolve a recreated collection's
 * parent.
 */
function _parentPath(p) {
  if (typeof p !== 'string') return '';
  const parts = p.split('/').filter((s) => s.trim() !== '');
  parts.pop();
  return parts.join('/');
}

/**
 * Shallow snapshot of a FileRecord deep enough to restore it: scalar
 * fields are copied by value and the membership array is cloned.
 */
function _snapshotFileRecord(record) {
  return {
    ...record,
    collectionMembershipKeys: Array.isArray(record.collectionMembershipKeys)
      ? [...record.collectionMembershipKeys]
      : [],
  };
}

/**
 * Shallow snapshot of a CollectionRecord.
 */
function _snapshotCollectionRecord(record) {
  return { ...record };
}

/**
 * Restore a FileRecord to a previously-captured snapshot. Used by
 * rollback paths when `store.save()` fails after an in-memory mutation
 * has already been applied.
 */
function _rollbackFileRecord(store, localPath, snapshot) {
  const current = store.getByLocalPath(localPath);
  if (!current) return;
  // Reset every field that was on the snapshot, including the membership array.
  Object.assign(current, snapshot, {
    collectionMembershipKeys: Array.isArray(snapshot.collectionMembershipKeys)
      ? [...snapshot.collectionMembershipKeys]
      : [],
  });
  // Re-run the store's internal index rebuild without forcing a save —
  // calling update() does the rebuild for us.
  store.update(localPath, {});
}

/**
 * Restore a CollectionRecord to a previously-captured snapshot. If the
 * resolution created a NEW collection record under a different key,
 * pass `newKey` so the freshly-added record is removed too.
 */
function _rollbackCollectionRecord(store, snapshot, newKey) {
  if (newKey) {
    store.removeCollectionRecord(newKey);
  } else {
    store.removeCollectionRecord(snapshot.zoteroCollectionKey);
  }
  store.add({ ...snapshot });
}

/**
 * Common path for TRASH / MOVE_OUTSIDE on a FileRecord: tombstone +
 * remove + save with rollback. The FS mutation has already happened by
 * the time this runs, so on save() failure we can only roll back the
 * tracking-store changes — the file is already gone from disk.
 */
async function _applyTombstoneRemove(store, record) {
  const tombstone = createTombstoneRecord({
    objectType: 'file',
    localPath: record.localPath,
    canonicalLocalPath: record.canonicalLocalPath,
    zoteroAttachmentKey: record.zoteroAttachmentKey,
    zoteroItemKey: record.zoteroItemKey,
    deletedFrom: 'local',
    originalHash: record.lastSyncedHash,
  });
  const snapshot = _snapshotFileRecord(record);
  store.add(tombstone);
  store.remove(record.localPath);
  try {
    await store.save();
  } catch (saveErr) {
    _rollbackTombstoneRemove(store, snapshot, tombstone);
    _reportSaveFailure(saveErr, record);
    return { ok: false, reason: 'save-failed', error: String(saveErr?.message ?? saveErr) };
  }
  return { ok: true };
}

/**
 * Common path for TRASH / MOVE_OUTSIDE on a CollectionRecord: remove
 * the collection record, drop any FileRecords that lived under it, and
 * save. Same rollback semantics as `_applyTombstoneRemove` — the FS
 * mutation isn't reversible from here.
 */
async function _applyCollectionRemove(store, record) {
  const collectionSnapshot = _snapshotCollectionRecord(record);
  const childPrefix = record.localPath ? record.localPath + '/' : '';
  const removedChildren = [];
  const allFiles = store.getAllOfType('file');
  for (const f of allFiles) {
    if (f.localPath === record.localPath
      || (childPrefix && f.localPath.startsWith(childPrefix))) {
      removedChildren.push(_snapshotFileRecord(f));
    }
  }
  store.removeCollectionRecord(record.zoteroCollectionKey);
  for (const child of removedChildren) {
    store.remove(child.localPath);
  }
  try {
    await store.save();
  } catch (saveErr) {
    // Restore: re-add the collection and every child file we removed.
    store.add({ ...collectionSnapshot });
    for (const child of removedChildren) {
      store.add({ ...child });
    }
    _reportSaveFailure(saveErr, { localPath: record.localPath, zoteroAttachmentKey: null });
    return { ok: false, reason: 'save-failed', error: String(saveErr?.message ?? saveErr) };
  }
  return { ok: true };
}

/**
 * Restore a FileRecord that was tombstoned + removed (used when save()
 * fails after the in-memory mutation). The fresh tombstone is dropped
 * from the tombstone array and the original record is re-added.
 */
function _rollbackTombstoneRemove(store, recordSnapshot, tombstone) {
  // Drop the freshly-added tombstone. _tombstones is an internal
  // array; we touch it by identity to avoid removing pre-existing
  // tombstones for the same path.
  const arr = store._tombstones;
  if (Array.isArray(arr)) {
    const idx = arr.lastIndexOf(tombstone);
    if (idx >= 0) arr.splice(idx, 1);
  }
  // Re-insert the original file record.
  store.add({ ...recordSnapshot });
}

/**
 * Mutate a FileRecord via store.update + store.save with rollback on
 * save failure. Returns `{ok:true}` on success or `{ok:false, reason:
 * 'save-failed', error}` if the save throws. Also surfaces the failure
 * via warningSink.
 */
async function _saveWithFileRollback(store, localPath, snapshot, record) {
  try {
    await store.save();
    return { ok: true };
  } catch (saveErr) {
    _rollbackFileRecord(store, localPath, snapshot);
    _reportSaveFailure(saveErr, record);
    return { ok: false, reason: 'save-failed', error: String(saveErr?.message ?? saveErr) };
  }
}

/**
 * Surface a tracking-store save() failure through the warning sink so
 * the user knows their resolution didn't persist. Called AFTER the
 * in-memory state has been rolled back, so the message accurately
 * reflects that the resolution was rolled back rather than left in a
 * silent-half-applied state.
 */
function _reportSaveFailure(err, record) {
  reportWarning({
    category: WARNING_CATEGORY.IO_ERROR,
    actionType: 'suppression-save',
    attachmentKey: record?.zoteroAttachmentKey ?? null,
    path: record?.localPath ?? null,
    reason: 'tracking-save-failed',
    message: `Suppression resolution rolled back: tracking-v2.json write failed (${err?.message ?? err}).`,
  });
}

/**
 * Move `absPath` to the OS trash via XPCOM nsIFile. Mirrors the pattern
 * used in watchFolderService._moveToOSTrash. Works for both files and
 * directories. Synchronous on the XPCOM side but wrapped in async to
 * keep the resolver's API uniform.
 */
async function _moveToOSTrash(absPath) {
  const file = Components.classes['@mozilla.org/file/local;1']
    .createInstance(Components.interfaces.nsIFile);
  file.initWithPath(absPath);
  file.moveToTrash();
}
