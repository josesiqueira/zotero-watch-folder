/**
 * Unit tests for content/collectionWatcher.mjs
 *
 * Covers UT-065 — CollectionWatcher observer wiring.
 *
 * The watcher itself is just a thin adapter that registers a Zotero notifier
 * and forwards parsed events to the sync service. We verify:
 *   - constructor stores the service
 *   - register() registers a real notifier with the right types
 *   - unregister() unregisters the notifier
 *   - collection events: add/modify/delete/move are routed correctly
 *   - collection-item events: composite IDs are parsed and dispatched
 *   - loop prevention: callbacks are skipped while syncService.isSyncing
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// CollectionWatcher itself imports nothing from the project — only Zotero
// globals. So no module mocks are needed here.

describe('UT-065: CollectionWatcher', () => {
  let syncService;
  let CollectionWatcher;
  let resetCollectionWatcher;
  let getCollectionWatcher;

  beforeEach(async () => {
    vi.resetAllMocks();

    const mod = await import('../../content/collectionWatcher.mjs');
    CollectionWatcher = mod.CollectionWatcher;
    resetCollectionWatcher = mod.resetCollectionWatcher;
    getCollectionWatcher = mod.getCollectionWatcher;
    // Reset module-level singleton between tests
    resetCollectionWatcher();

    syncService = {
      isSyncing: false,
      handleCollectionCreated: vi.fn(async () => {}),
      handleCollectionRenamed: vi.fn(async () => {}),
      handleCollectionDeleted: vi.fn(async () => {}),
      handleCollectionMoved: vi.fn(async () => {}),
      handleItemAddedToCollection: vi.fn(async () => {}),
      handleItemRemovedFromCollection: vi.fn(async () => {}),
    };

    // Replace the Notifier register/unregister with fresh spies
    globalThis.Zotero.Notifier.registerObserver = vi.fn(() => 'NOTIFIER-ID');
    globalThis.Zotero.Notifier.unregisterObserver = vi.fn();
  });

  // ─────────────────────────────────────────────────────────────────────
  // UT-065a: constructor and register
  // ─────────────────────────────────────────────────────────────────────

  it('UT-065a: constructor stores the syncService reference', () => {
    const w = new CollectionWatcher(syncService);
    expect(w._syncService).toBe(syncService);
    expect(w._notifierID).toBeNull();
    expect(w._enabled).toBe(false);
  });

  it('UT-065b: register() registers the notifier with the right event types', () => {
    const w = new CollectionWatcher(syncService);
    w.register();

    expect(globalThis.Zotero.Notifier.registerObserver).toHaveBeenCalledTimes(1);
    const [observer, types, name] = globalThis.Zotero.Notifier.registerObserver.mock.calls[0];
    expect(typeof observer.notify).toBe('function');
    expect(types).toEqual(['collection', 'collection-item']);
    expect(name).toBe('watchFolderCollectionSync');
    expect(w._notifierID).toBe('NOTIFIER-ID');
    expect(w._enabled).toBe(true);
  });

  it('UT-065c: register() is idempotent', () => {
    const w = new CollectionWatcher(syncService);
    w.register();
    w.register();
    expect(globalThis.Zotero.Notifier.registerObserver).toHaveBeenCalledTimes(1);
  });

  // ─────────────────────────────────────────────────────────────────────
  // UT-065d: unregister
  // ─────────────────────────────────────────────────────────────────────

  it('UT-065d: unregister() releases the observer and resets state', () => {
    const w = new CollectionWatcher(syncService);
    w.register();
    w.unregister();
    expect(globalThis.Zotero.Notifier.unregisterObserver).toHaveBeenCalledWith('NOTIFIER-ID');
    expect(w._notifierID).toBeNull();
    expect(w._enabled).toBe(false);
  });

  it('UT-065e: unregister() with no active registration is a no-op', () => {
    const w = new CollectionWatcher(syncService);
    w.unregister();
    expect(globalThis.Zotero.Notifier.unregisterObserver).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────────
  // Helpers for event-routing tests
  // ─────────────────────────────────────────────────────────────────────

  async function dispatch({ event, type, ids, extraData = {} }) {
    const w = new CollectionWatcher(syncService);
    w.register();
    const observer = globalThis.Zotero.Notifier.registerObserver.mock.calls[0][0];
    await observer.notify(event, type, ids, extraData);
    return w;
  }

  // ─────────────────────────────────────────────────────────────────────
  // UT-065f-i: collection event routing
  // ─────────────────────────────────────────────────────────────────────

  it('UT-065f: collection+add routes to handleCollectionCreated for each id', async () => {
    await dispatch({ event: 'add', type: 'collection', ids: [10, 11] });
    expect(syncService.handleCollectionCreated).toHaveBeenCalledTimes(2);
    expect(syncService.handleCollectionCreated).toHaveBeenCalledWith(10);
    expect(syncService.handleCollectionCreated).toHaveBeenCalledWith(11);
  });

  it('UT-065g: collection+modify routes to handleCollectionRenamed (with extraData name)', async () => {
    await dispatch({
      event: 'modify',
      type: 'collection',
      ids: [10],
      extraData: { 10: { name: 'OldName' } },
    });
    expect(syncService.handleCollectionRenamed).toHaveBeenCalledWith(10, 'OldName');
  });

  it('UT-065h: collection+modify with no old name in extraData does nothing', async () => {
    await dispatch({
      event: 'modify',
      type: 'collection',
      ids: [10],
      extraData: { 10: {} },
    });
    expect(syncService.handleCollectionRenamed).not.toHaveBeenCalled();
  });

  it('UT-065i: collection+delete routes to handleCollectionDeleted', async () => {
    await dispatch({ event: 'delete', type: 'collection', ids: [10] });
    expect(syncService.handleCollectionDeleted).toHaveBeenCalledWith(10);
  });

  it('UT-065j: collection+move routes to handleCollectionMoved with old parent id', async () => {
    await dispatch({
      event: 'move',
      type: 'collection',
      ids: [10],
      extraData: { 10: 5 },  // old parent ID
    });
    expect(syncService.handleCollectionMoved).toHaveBeenCalledWith(10, 5);
  });

  // ─────────────────────────────────────────────────────────────────────
  // UT-065k-m: collection-item event routing
  // ─────────────────────────────────────────────────────────────────────

  it('UT-065k: collection-item+add parses "collectionID-itemID" and dispatches', async () => {
    await dispatch({
      event: 'add',
      type: 'collection-item',
      ids: ['10-100', '10-101'],
    });
    expect(syncService.handleItemAddedToCollection).toHaveBeenCalledTimes(2);
    expect(syncService.handleItemAddedToCollection).toHaveBeenCalledWith(100, 10);
    expect(syncService.handleItemAddedToCollection).toHaveBeenCalledWith(101, 10);
  });

  it('UT-065l: collection-item+remove routes to handleItemRemovedFromCollection', async () => {
    await dispatch({
      event: 'remove',
      type: 'collection-item',
      ids: ['10-100'],
    });
    expect(syncService.handleItemRemovedFromCollection).toHaveBeenCalledWith(100, 10);
  });

  it('UT-065m: collection-item with malformed id is skipped (no crash)', async () => {
    await dispatch({
      event: 'add',
      type: 'collection-item',
      ids: ['garbage'],
    });
    expect(syncService.handleItemAddedToCollection).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────────
  // UT-065n: loop prevention via isSyncing
  // ─────────────────────────────────────────────────────────────────────

  it('UT-065n: when sync service is currently syncing, the observer is a no-op', async () => {
    syncService.isSyncing = true;
    await dispatch({ event: 'add', type: 'collection', ids: [10] });
    expect(syncService.handleCollectionCreated).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────────
  // UT-065o: error inside handler is swallowed
  // ─────────────────────────────────────────────────────────────────────

  it('UT-065o: errors thrown by a handler are caught and logged, not rethrown', async () => {
    syncService.handleCollectionCreated.mockRejectedValue(new Error('boom'));
    await expect(dispatch({ event: 'add', type: 'collection', ids: [10] })).resolves.toBeDefined();
    expect(globalThis.Zotero.logError).toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────────
  // UT-065p: factory + singleton
  // ─────────────────────────────────────────────────────────────────────

  it('UT-065p: getCollectionWatcher returns a singleton', () => {
    const w1 = getCollectionWatcher(syncService);
    const w2 = getCollectionWatcher(syncService);
    expect(w1).toBe(w2);
  });
});
