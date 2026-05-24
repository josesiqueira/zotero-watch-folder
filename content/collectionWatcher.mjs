/**
 * Collection Watcher — v2.1 Phase A1.
 *
 * Subscribes to `Zotero.Notifier` for `['collection', 'collection-item']`
 * topics and dispatches by event type into MirrorAction value-objects,
 * which are handed to `mirrorExecutor.execute()`. The executor is the
 * single bottleneck for every disk + Zotero mutation in Mode 2 / 3
 * (Phase A4).
 *
 * Collection events:
 *   add (collection)            → createFolder MirrorAction
 *   modify (collection)         → moveFolder MirrorAction iff the
 *                                 relative-path-under-sync-root changed
 *                                 (handles both rename and reparent in one
 *                                 unified diff — see `_handleModify`)
 *   delete | trash (collection) → deleteFolder MirrorAction iff we had
 *                                 a tracked CollectionRecord for it
 *
 * Collection-item events (item added to / removed from a collection)
 * are forwarded to `itemMembershipHandler` (Phase A3), which owns the
 * canonical-path-rule logic for multi-collection items.
 *
 * Sync-root scope gating — all collection-event branches drop events whose
 * collections are not under the configured sync root (or are Zotero
 * virtual collections per `isSpecialCollection`). The watcher never acts
 * on out-of-scope state. The coordinator is responsible for the mode gate
 * (Mode 1 does not start this watcher); the watcher itself does not read
 * the mode pref so it stays trivially testable.
 *
 * @module collectionWatcher
 */

import { collectionKeyToRelativePath, isSpecialCollection } from './canonicalPath.mjs';
import * as mirrorExecutor from './mirrorExecutor.mjs';
import { handleCollectionItemEvent } from './itemMembershipHandler.mjs';

/**
 * @typedef {Object} MirrorAction
 * @property {'createFolder'|'moveFolder'|'deleteFolder'|'moveItem'|'addItemMembership'|'removeItemMembership'} type
 * @property {Object} payload
 */

let _observerID = null;
let _registered = false;
let _coordinator = null;
let _store = null;

/**
 * Promise chain that serializes notifier callbacks. Zotero's notifier
 * fires events as fire-and-forget (it ignores our returned promise), so
 * back-to-back emissions (e.g. a modify on a collection followed by an
 * add burst on its items) would otherwise interleave through the async
 * `collectionKeyToRelativePath` / `getCollectionRecord` chain and read
 * an inconsistent store snapshot. The chain forces each notify to wait
 * for the previous one to settle. Errors do NOT poison the chain.
 */
let _notifyChain = Promise.resolve();

/**
 * Register the Zotero notifier observer. Idempotent — calling twice is
 * harmless.
 * @param {SyncCoordinator} coordinator
 */
export function start(coordinator) {
  if (_registered) return;
  _coordinator = coordinator;
  _store = coordinator?._trackingStore ?? null;

  const observer = {
    // Zotero's notifier ignores our return value, but returning the
    // promise lets tests `await observer.notify(...)` deterministically.
    // Wraps in a chain so concurrent batches serialize through the
    // decision layer (collectionKeyToRelativePath + store lookups).
    // Errors are caught so the chain isn't poisoned.
    notify: (event, type, ids, extraData) => {
      const next = _notifyChain
        .catch(() => {})
        .then(() => _onNotify(event, type, ids, extraData))
        .catch((e) => {
          Zotero.logError(`[WatchFolder] collectionWatcher notify: ${e?.message ?? e}`);
        });
      _notifyChain = next;
      return next;
    },
  };
  _observerID = Zotero.Notifier.registerObserver(
    observer,
    ['collection', 'collection-item'],
    'watchFolder-mode2',
  );
  _registered = true;
  Zotero.debug(`[WatchFolder] collectionWatcher: registered (observerID=${_observerID})`);
}

/**
 * Unregister the observer. Safe to call when not registered.
 */
export function stop() {
  if (!_registered) return;
  if (_observerID) {
    try {
      Zotero.Notifier.unregisterObserver(_observerID);
    } catch (e) {
      Zotero.logError(`[WatchFolder] collectionWatcher.stop: ${e?.message ?? e}`);
    }
  }
  _observerID = null;
  _coordinator = null;
  _store = null;
  _registered = false;
  _notifyChain = Promise.resolve();
  Zotero.debug('[WatchFolder] collectionWatcher: unregistered');
}

/** Test seam — observe whether the singleton state thinks it's wired up. */
export function _isRegistered() {
  return _registered;
}

async function _onNotify(event, type, ids, extraData) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  if (type === 'collection') {
    await _dispatchCollection(event, ids, extraData ?? {});
  } else if (type === 'collection-item') {
    await handleCollectionItemEvent(event, ids, extraData ?? {}, _coordinator);
  }
}

async function _dispatchCollection(event, ids, extraData) {
  for (const id of ids) {
    try {
      if (event === 'delete' || event === 'trash') {
        await _handleDelete(id, extraData);
        continue;
      }
      const collection = Zotero.Collections.get(id);
      if (!collection) continue;
      if (isSpecialCollection(collection)) continue;

      const relPath = await collectionKeyToRelativePath(collection.key);
      if (relPath === null) continue; // not under sync root

      if (event === 'add') {
        await _handleAdd(collection, relPath);
      } else if (event === 'modify') {
        await _handleModify(collection, relPath);
      }
    } catch (e) {
      Zotero.logError(`[WatchFolder] collectionWatcher dispatch ${event}/${id}: ${e?.message ?? e}`);
    }
  }
}

async function _handleAdd(collection, relPath) {
  // Empty relPath means the sync root itself was "added" — that would only
  // fire if the user just created the sync-root collection during this
  // session (i.e., the prefs picker just made it). Nothing to mkdir for the
  // sync root because the watch-folder root already exists on disk.
  if (relPath === '') return;
  await _emit({
    type: 'createFolder',
    payload: {
      collectionKey: collection.key,
      parentCollectionKey: _parentKeyOf(collection),
      relativePath: relPath,
      name: collection.name,
    },
  });
}

async function _handleModify(collection, currentRelPath) {
  // A modify event covers any of: rename, reparent, description change,
  // sort-key change, etc. We only care if the rendered relative path
  // changed. If it did, emit a single moveFolder action; the executor
  // handles "rename in place" and "move to new parent" as the same op.
  if (!_store) return;
  const record = _store.getCollectionRecord(collection.key);
  if (!record) {
    // Untracked: looks like Zotero just took ownership of a collection
    // that's now under our sync root (e.g., user moved an existing
    // collection INTO the sync root). Treat as create.
    if (currentRelPath === '') return;
    await _emit({
      type: 'createFolder',
      payload: {
        collectionKey: collection.key,
        parentCollectionKey: _parentKeyOf(collection),
        relativePath: currentRelPath,
        name: collection.name,
      },
    });
    return;
  }
  if (record.localPath === currentRelPath) return; // no-op modify

  await _emit({
    type: 'moveFolder',
    payload: {
      collectionKey: collection.key,
      oldRelativePath: record.localPath,
      newRelativePath: currentRelPath,
      newName: collection.name,
      newParentCollectionKey: _parentKeyOf(collection),
    },
  });
}

async function _handleDelete(id, extraData) {
  // Collection is already gone from Zotero.Collections.get(). Use the key
  // from extraData (Notifier convention) to look up our tracking record.
  const key = extraData?.[id]?.key;
  if (!key || !_store) return;
  const record = _store.getCollectionRecord(key);
  if (!record) return; // never tracked → not under sync root → ignore
  await _emit({
    type: 'deleteFolder',
    payload: {
      collectionKey: key,
      oldRelativePath: record.localPath,
    },
  });
}

function _parentKeyOf(collection) {
  if (!collection?.parentID) return null;
  const parent = Zotero.Collections.get(collection.parentID);
  return parent?.key ?? null;
}

async function _emit(action) {
  Zotero.debug(`[WatchFolder] collectionWatcher emit ${action.type} ${JSON.stringify(action.payload)}`);
  try {
    await mirrorExecutor.execute(action);
  } catch (e) {
    Zotero.logError(`[WatchFolder] collectionWatcher emit ${action.type}: ${e?.message ?? e}`);
  }
}
