/**
 * Item-add Handler — v2.1 (review fix A8).
 *
 * Subscribes to Zotero.Notifier `['item']` topic and filters for `add`
 * events on ATTACHMENT items whose parent is in a sync-root collection.
 * These don't fire collection-item events (parent's collection set
 * didn't change when a new attachment is dropped onto it), so the
 * Phase A pipeline would otherwise miss them entirely.
 *
 * For each such attachment, copies the file from Zotero storage to its
 * canonical local path via baseline.copyAttachmentToCanonical and
 * inserts a tracked FileRecord.
 *
 * Lifecycle parallel to collectionWatcher: start(coordinator) registers,
 * stop() unregisters. Idempotent. Serializes its own notify chain so
 * concurrent attachment-add bursts don't interleave through the async
 * decision layer.
 *
 * @module itemAddHandler
 */

import { resolveSyncRoot, collectionKeyToRelativePath } from './canonicalPath.mjs';
import { getPref } from './utils.mjs';
import * as baseline from './baseline.mjs';

let _observerID = null;
let _registered = false;
let _coordinator = null;
let _store = null;
let _notifyChain = Promise.resolve();

export function start(coordinator) {
  if (_registered) return;
  _coordinator = coordinator;
  _store = coordinator?._trackingStore ?? null;

  const observer = {
    notify: (event, type, ids, extraData) => {
      const next = _notifyChain
        .catch(() => {})
        .then(() => _onNotify(event, type, ids, extraData))
        .catch((e) => {
          Zotero.logError(`[WatchFolder] itemAddHandler notify: ${e?.message ?? e}`);
        });
      _notifyChain = next;
      return next;
    },
  };
  _observerID = Zotero.Notifier.registerObserver(observer, ['item'], 'watchFolder-itemAdd');
  _registered = true;
  Zotero.debug(`[WatchFolder] itemAddHandler: registered (observerID=${_observerID})`);
}

export function stop() {
  if (!_registered) return;
  if (_observerID) {
    try { Zotero.Notifier.unregisterObserver(_observerID); }
    catch (e) { Zotero.logError(`[WatchFolder] itemAddHandler.stop: ${e?.message ?? e}`); }
  }
  _observerID = null;
  _coordinator = null;
  _store = null;
  _registered = false;
  _notifyChain = Promise.resolve();
  Zotero.debug('[WatchFolder] itemAddHandler: unregistered');
}

export function _isRegistered() { return _registered; }

async function _onNotify(event, type, ids, extraData) {
  if (event !== 'add' || type !== 'item') return;
  if (!Array.isArray(ids) || ids.length === 0) return;
  if (!_store) return;

  let syncRoot;
  try { syncRoot = await resolveSyncRoot(); }
  catch (e) {
    Zotero.logError(`[WatchFolder] itemAddHandler: ${e?.message ?? e}`);
    return;
  }
  if (!syncRoot) return;

  const watchRoot = getPref('sourcePath');
  if (!watchRoot) return;

  for (const id of ids) {
    try {
      const item = Zotero.Items.get(id);
      if (!item) continue;
      // Only attachments. Standalone attachments + parent-attachments
      // both need a parent in the sync root; standalones get their own
      // collections directly.
      if (typeof item.isAttachment !== 'function' || !item.isAttachment()) continue;

      // Skip if we already track this attachment (a regular import path
      // or the install-time baseline may have done so already).
      if (_store.getByAttachmentKey(item.key)) continue;

      // Determine the "owning item" whose collection memberships we
      // consult: for child attachments, the parent; for standalone, self.
      let owningItem = item;
      if (typeof item.parentItemID === 'number' && item.parentItemID > 0) {
        const parent = Zotero.Items.get(item.parentItemID);
        if (parent) owningItem = parent;
      }
      // Gate on the owning item having at least one sync-root membership.
      if (!_itemInSyncRoot(owningItem)) continue;

      await baseline.copyAttachmentToCanonical({
        attachment: item,
        item: owningItem,
        syncRoot,
        watchRoot,
        store: _store,
      });
      try { await _store.save(); } catch (_e) { /* logged */ }
      Zotero.debug(`[WatchFolder] itemAddHandler: copied late-attached ${item.key}`);
    } catch (e) {
      Zotero.logError(`[WatchFolder] itemAddHandler item ${id}: ${e?.message ?? e}`);
    }
  }
}

/**
 * Does this item have at least one collection membership under the
 * sync root? Uses collectionKeyToRelativePath (returns null for
 * out-of-scope collections, '' for the sync root itself).
 */
function _itemInSyncRoot(item) {
  if (typeof item?.getCollections !== 'function') return false;
  const ids = item.getCollections() || [];
  for (const id of ids) {
    const c = Zotero.Collections.get(id);
    if (!c) continue;
    // We can't await inside a sync helper; use the synchronous parent walk.
    // collectionKeyToRelativePath does an async lookup; here we walk by ID
    // for speed (sync root id known at start time).
    if (_isUnderSyncRoot(c)) return true;
  }
  return false;
}

function _isUnderSyncRoot(collection) {
  // Walk up from `collection` to library root; if we encounter the
  // sync-root collection id along the way (or are it), we're inside.
  const syncRootKey = getPref('syncRootCollectionKey');
  if (!syncRootKey) return false;
  let cursor = collection;
  for (let i = 0; i < 1024 && cursor; i++) {
    if (cursor.key === syncRootKey) return true;
    if (!cursor.parentID) break;
    cursor = Zotero.Collections.get(cursor.parentID);
  }
  return false;
}

// collectionKeyToRelativePath is imported for callers that want the
// async version. Kept in the import list to make the dependency
// explicit even though we use the sync walk above.
void collectionKeyToRelativePath;
