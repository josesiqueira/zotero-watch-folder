/**
 * Collection Watcher — v2.1 Phase A1 skeleton.
 *
 * Subscribes to `Zotero.Notifier` for `['collection', 'collection-item']`
 * topics and routes events through a dispatch table:
 *
 *   add (collection)            → handleCollectionCreated
 *   modify (collection: name)   → handleCollectionRenamed
 *   modify (collection: parent) → handleCollectionMoved
 *   delete | trash (collection) → handleCollectionDeleted
 *   add | modify | remove (collection-item) → itemMembershipHandler
 *
 * All handlers gated by `canonicalPath.isUnderSyncRoot(collection)` —
 * we never act on collections outside the configured sync root.
 *
 * Emits `MirrorAction` value-objects to `mirrorExecutor` rather than
 * doing IO directly. This separates decision from execution so we can:
 *   1. Batch operations within a scan cycle
 *   2. Apply conflict-gate / cross-FS checks centrally
 *   3. Avoid the `_isSyncing` global-deadlock bug from v1's Phase-2 code
 *      (see CODEBASE_OVERVIEW §9.4 sharp edge #6)
 *
 * Not implemented in this v2.1 starter — file exists so the v2.1
 * implementation has a stable target to grow into.
 *
 * @module collectionWatcher
 */

/**
 * @typedef {Object} MirrorAction
 * @property {'createFolder'|'renameFolder'|'deleteFolder'|'moveItem'|'addItemMembership'|'removeItemMembership'} type
 * @property {Object} payload
 */

let _registered = false;
let _observerID = null;

/**
 * Register the Zotero notifier observer. Idempotent — calling twice is
 * harmless.
 * @param {SyncCoordinator} coordinator
 */
export function start(coordinator) {
  if (_registered) return;
  // TODO(v2.1): Zotero.Notifier.registerObserver({notify: dispatch}, ['collection','collection-item'])
  _registered = true;
  void coordinator; // suppress unused-arg lint until implementation lands
  Zotero.debug('[WatchFolder] collectionWatcher: skeleton registered (no-op)');
}

/**
 * Unregister the observer. Safe to call when not registered.
 */
export function stop() {
  if (!_registered) return;
  // TODO(v2.1): Zotero.Notifier.unregisterObserver(_observerID)
  _registered = false;
  _observerID = null;
  Zotero.debug('[WatchFolder] collectionWatcher: skeleton unregistered');
}
