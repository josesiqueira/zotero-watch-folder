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
 * `resolve(record, action, opts)` is the single entry point. It takes a
 * suppressed FileRecord and an action and applies the appropriate side
 * effects. Internal handlers receive a `ctx` object so the resolver can
 * be unit-tested with stubs in place of the live tracking store /
 * Zotero / IOUtils.
 *
 * @module suppressionResolver
 */

import { getTrackingStore, createTombstoneRecord, STATE } from './trackingStore.mjs';
import { resolveSyncRoot } from './canonicalPath.mjs';
import { getPref } from './utils.mjs';
import { report as reportWarning, WARNING_CATEGORY } from './warningSink.mjs';

export const RESOLUTION_ACTION = Object.freeze({
  REINSTATE: 'reinstate',
  KEEP_LOCAL: 'keep-local',
  TRASH: 'trash',
  MOVE_OUTSIDE: 'move-outside',
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
 * records to OUT_OF_SCOPE_SUPPRESSED on Zotero-side delete; this helper
 * exposes them to the prefs UI. Full folder-resolution actions are
 * pending — for now the UI surfaces the count.
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

// ─── Resolution handlers ───────────────────────────────────────────────────

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

  try {
    await Zotero.DB.executeTransaction(async () => {
      target.addToCollection(syncRoot.collection.id);
      await target.save();
    });
  } catch (e) {
    return { ok: false, reason: 'save-failed', error: String(e?.message ?? e) };
  }

  const memberships = new Set(record.collectionMembershipKeys || []);
  memberships.add(syncRoot.collection.key);
  store.update(record.localPath, {
    state: STATE.CLEAN,
    canonicalCollectionKey: record.canonicalCollectionKey ?? syncRoot.collection.key,
    collectionMembershipKeys: Array.from(memberships),
  });
  try { await store.save(); } catch (saveErr) { _reportSaveFailure(saveErr, record); }
  return { ok: true };
}

async function _keepLocal(record, ctx) {
  const { store } = ctx;
  store.update(record.localPath, { state: STATE.USER_DETACHED });
  try { await store.save(); } catch (saveErr) { _reportSaveFailure(saveErr, record); }
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
  store.add(createTombstoneRecord({
    objectType: 'file',
    localPath: record.localPath,
    canonicalLocalPath: record.canonicalLocalPath,
    zoteroAttachmentKey: record.zoteroAttachmentKey,
    zoteroItemKey: record.zoteroItemKey,
    deletedFrom: 'local',
    originalHash: record.lastSyncedHash,
  }));
  store.remove(record.localPath);
  try { await store.save(); } catch (saveErr) { _reportSaveFailure(saveErr, record); }
  return { ok: true };
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
  store.add(createTombstoneRecord({
    objectType: 'file',
    localPath: record.localPath,
    canonicalLocalPath: record.canonicalLocalPath,
    zoteroAttachmentKey: record.zoteroAttachmentKey,
    zoteroItemKey: record.zoteroItemKey,
    deletedFrom: 'local',
    originalHash: record.lastSyncedHash,
  }));
  store.remove(record.localPath);
  try { await store.save(); } catch (saveErr) { _reportSaveFailure(saveErr, record); }
  return movedReason ? { ok: true, reason: movedReason } : { ok: true };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function _toAbs(root, rel) {
  if (!rel) return root;
  const segs = rel.split('/').filter((s) => s.trim() !== '');
  if (segs.length === 0) return root;
  return PathUtils.join(root, ...segs);
}

function _filenameOf(p) {
  if (typeof p !== 'string') return '';
  const parts = p.split('/');
  return parts[parts.length - 1] || '';
}

/**
 * Surface a tracking-store save() failure through the warning sink so
 * the user knows their resolution didn't make it to disk. In-memory
 * mutation has already been applied; a Zotero restart at this point
 * would silently revert the user's choice. Rollback is a separate
 * follow-up — for now we just make the failure visible.
 */
function _reportSaveFailure(err, record) {
  reportWarning({
    category: WARNING_CATEGORY.IO_ERROR,
    actionType: 'suppression-save',
    attachmentKey: record?.zoteroAttachmentKey ?? null,
    path: record?.localPath ?? null,
    reason: 'tracking-save-failed',
    message: `Suppression resolution persisted in memory but tracking-v2.json write failed (${err?.message ?? err}). The resolution may not survive a restart.`,
  });
}

/**
 * Move `absPath` to the OS trash via XPCOM nsIFile. Mirrors the pattern
 * used in watchFolderService._moveToOSTrash. Synchronous on the XPCOM
 * side but wrapped in async to keep the resolver's API uniform.
 */
async function _moveToOSTrash(absPath) {
  const file = Components.classes['@mozilla.org/file/local;1']
    .createInstance(Components.interfaces.nsIFile);
  file.initWithPath(absPath);
  file.moveToTrash();
}
