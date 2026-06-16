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

import {
  collectionKeyToDiskRelativePath,
  isSpecialCollection,
  resolveSyncRoot,
  invalidateCanonicalPathCache,
} from './canonicalPath.mjs';
import * as mirrorExecutor from './mirrorExecutor.mjs';
import { handleCollectionItemEvent } from './itemMembershipHandler.mjs';
import * as baseline from './baseline.mjs';
import { getPref } from './utils.mjs';

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

// ─── WP-C #4: debounce + batching ─────────────────────────────────────────
//
// Zotero fires fine-grained notifier events: a single user action (drag
// 30 items into a collection) can fan out as 30 separate `add`
// collection-item events. Each previously bought its own pass through
// the async decision layer + per-event call into the membership
// handler. Debouncing for `DEBOUNCE_MS` collapses bursts into a single
// batched pass: same-collection adds become one grouped payload for
// the handler, and collection-event types still go through their
// per-id dispatch but on the same scheduled drain.
//
// The existing `_notifyChain` invariant is preserved: drains feed into
// the chain so two drains never run concurrently.

let _debounceMs = 100;
let _pendingBuffer = [];      // {event, type, ids, extraData}[]
let _pendingPromise = null;   // resolves when the current batch has drained
let _pendingTimer = null;

/**
 * Test seam — override the debounce window. Pass 0 in tests so a
 * single `await observer.notify(...)` settles immediately.
 */
export function __test_setDebounceMs(ms) {
  _debounceMs = Math.max(0, Number(ms) || 0);
}

/** Test seam — flush any pending debounce buffer right now. */
export function __test_flush() {
  if (_pendingTimer) {
    clearTimeout(_pendingTimer);
    _pendingTimer = null;
    _drainPending();
  }
  return _pendingPromise || Promise.resolve();
}

function _scheduleDrain() {
  if (_pendingTimer) return;
  _pendingTimer = setTimeout(() => {
    _pendingTimer = null;
    _drainPending();
  }, _debounceMs);
}

function _drainPending() {
  const batch = _pendingBuffer;
  _pendingBuffer = [];
  const resolveCurrent = _pendingResolve;
  _pendingResolve = null;
  _pendingPromise = null;
  // Feed the batch through the existing chain to preserve serialization.
  const next = _notifyChain
    .catch(() => {})
    .then(() => _processBatch(batch))
    .catch((e) => {
      Zotero.logError(`[WatchFolder] collectionWatcher batch: ${e?.message ?? e}`);
    });
  _notifyChain = next;
  if (resolveCurrent) next.then(() => resolveCurrent());
}

let _pendingResolve = null;

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
    // WP-C #4: debounce-buffer the event then schedule a drain. Multiple
    // notify() calls within DEBOUNCE_MS join the same batch and share
    // its return promise. The drain feeds into _notifyChain so the
    // existing serialization invariant is preserved.
    notify: (event, type, ids, extraData) => {
      _pendingBuffer.push({ event, type, ids, extraData });
      if (!_pendingPromise) {
        _pendingPromise = new Promise((resolve) => { _pendingResolve = resolve; });
      }
      _scheduleDrain();
      return _pendingPromise;
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
  // Clear any pending debounce buffer so a stale event from a previous
  // session doesn't fire after stop().
  if (_pendingTimer) {
    clearTimeout(_pendingTimer);
    _pendingTimer = null;
  }
  _pendingBuffer = [];
  if (_pendingResolve) { _pendingResolve(); _pendingResolve = null; }
  _pendingPromise = null;
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

/**
 * Process a coalesced batch of (event, type, ids, extraData) tuples.
 * Same-(event,type) groups are merged so the existing single-pass
 * dispatch sees the union of ids. `collection` events still get
 * per-id resolution inside `_dispatchCollection` (each id may have a
 * different state); `collection-item` events go to the handler as a
 * combined compositeIDs array — the handler iterates internally.
 */
async function _processBatch(batch) {
  if (!Array.isArray(batch) || batch.length === 0) return;

  // Group by (event,type). Coalesce ids + merge extraData.
  // Key shape: "event||type"
  const grouped = new Map();
  for (const entry of batch) {
    const { event, type, ids, extraData } = entry || {};
    if (!event || !type || !Array.isArray(ids) || ids.length === 0) continue;
    const key = `${event}||${type}`;
    let g = grouped.get(key);
    if (!g) {
      g = { event, type, ids: [], idSeen: new Set(), extraData: {} };
      grouped.set(key, g);
    }
    for (const id of ids) {
      if (g.idSeen.has(id)) continue;
      g.idSeen.add(id);
      g.ids.push(id);
    }
    if (extraData && typeof extraData === 'object') {
      Object.assign(g.extraData, extraData);
    }
  }

  // Invalidate canonical-path cache entries for modify/delete on
  // collection events BEFORE dispatch — downstream
  // collectionKeyToRelativePath lookups must see fresh data.
  for (const g of grouped.values()) {
    if (g.type !== 'collection') continue;
    if (g.event !== 'modify' && g.event !== 'delete' && g.event !== 'trash') continue;
    for (const id of g.ids) {
      let key = null;
      if (g.event === 'delete' || g.event === 'trash') {
        // The collection is already gone; use extraData per Notifier convention.
        key = g.extraData?.[id]?.key ?? null;
      } else {
        const collection = Zotero.Collections.get(id);
        key = collection?.key ?? null;
      }
      // The cache invalidates wholesale (descendant paths can change too)
      // — `key` is informational. See canonicalPath.mjs B4.
      if (key) invalidateCanonicalPathCache();
    }
  }

  for (const g of grouped.values()) {
    try {
      if (g.type === 'collection') {
        await _dispatchCollection(g.event, g.ids, g.extraData);
      } else if (g.type === 'collection-item') {
        await handleCollectionItemEvent(g.event, g.ids, g.extraData, _coordinator);
      }
    } catch (e) {
      Zotero.logError(`[WatchFolder] collectionWatcher process ${g.event}/${g.type}: ${e?.message ?? e}`);
    }
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

      // Disk-domain variant: sanitizes each segment (FS-1) so the emitted
      // createFolder/moveFolder paths — and the localPath stored from them —
      // match the sanitized folders baseline creates and round-trip on
      // Windows-reserved/illegal collection names. Passes '' / null through.
      const relPath = await collectionKeyToDiskRelativePath(collection.key);
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
  // If the freshly-added collection already has child items / subcollections
  // (e.g. a populated tree was moved into sync root), route through the
  // adopt-into-scope baseline so existing attachments get copied to disk
  // — not just an empty mkdir (review finding A4).
  if (_collectionHasContent(collection)) {
    await _adoptIntoScope(collection);
    return;
  }
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

function _collectionHasContent(collection) {
  try {
    const items = (typeof collection.getChildItems === 'function')
      ? (collection.getChildItems(false, false) || [])
      : [];
    if (items.length > 0) return true;
    const children = (typeof Zotero.Collections.getByParent === 'function')
      ? (Zotero.Collections.getByParent(collection.id, collection.libraryID) || [])
      : [];
    return children.length > 0;
  } catch (_e) { return false; }
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
    // collection INTO the sync root). Adopt the whole subtree —
    // mkdir the folders + copy any existing attachment files so the
    // local view matches Zotero (review finding A4).
    if (currentRelPath === '') return;
    await _adoptIntoScope(collection);
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
  // Zotero-side deletion → trash the LOCAL folder (zoteroCollectionDeleted).
  // Distinct from localFolderDeleted (disk-side), which propagates to Zotero.
  await _emit({
    type: 'zoteroCollectionDeleted',
    payload: {
      collectionKey: key,
      oldRelativePath: record.localPath,
    },
  });
}

/**
 * A collection just appeared (or moved) into the sync root with
 * existing content. mkdir the directory tree on disk AND copy any
 * existing Zotero attachments to their canonical local paths. Uses
 * `baseline.adoptCollectionSubtree` so behavior matches the install-
 * time B.2 + B.6 path.
 */
async function _adoptIntoScope(collection) {
  if (!_store) return;
  let syncRoot;
  try { syncRoot = await resolveSyncRoot(); }
  catch (e) {
    Zotero.logError(`[WatchFolder] collectionWatcher adopt: ${e?.message ?? e}`);
    return;
  }
  if (!syncRoot) return;
  const watchRoot = getPref('sourcePath');
  if (!watchRoot) return;
  try {
    const result = await baseline.adoptCollectionSubtree({
      rootCollection: collection,
      syncRoot,
      watchRoot,
      store: _store,
    });
    Zotero.debug(`[WatchFolder] collectionWatcher: adopted ${collection.key} into scope (copies=${result.copies} mkdirs=${result.mkdirs} errors=${result.errors})`);
  } catch (e) {
    Zotero.logError(`[WatchFolder] collectionWatcher adopt failed: ${e?.message ?? e}`);
  }
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
