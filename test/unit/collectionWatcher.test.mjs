/**
 * Unit tests for content/collectionWatcher.mjs (v2.1 Phase A1).
 *
 * Covers:
 *   UT-301 register/unregister lifecycle (idempotent, hooks into Zotero.Notifier)
 *   UT-302 collection 'add' → createFolder MirrorAction when under sync root
 *   UT-303 collection 'add' → ignored when not under sync root / virtual / sync-root itself
 *   UT-304 collection 'modify' (rename) → moveFolder MirrorAction
 *   UT-305 collection 'modify' (reparent) → moveFolder MirrorAction
 *   UT-306 collection 'modify' (no path change) → no emit
 *   UT-307 collection 'modify' on untracked under-root collection → createFolder
 *   UT-308 collection 'delete' → deleteFolder iff record exists
 *   UT-309 collection-item event → forwarded to itemMembershipHandler
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock collaborators BEFORE importing the SUT so vi.mock hoists correctly.
vi.mock('../../content/mirrorExecutor.mjs', () => ({
  execute: vi.fn(async () => ({ ok: false, reason: 'mocked' })),
}));
vi.mock('../../content/itemMembershipHandler.mjs', () => ({
  handleCollectionItemEvent: vi.fn(async () => {}),
}));
vi.mock('../../content/baseline.mjs', () => ({
  adoptCollectionSubtree: vi.fn(async () => ({ ok: true, copies: 0, mkdirs: 0, errors: 0 })),
}));

import * as mirrorExecutor from '../../content/mirrorExecutor.mjs';
import { handleCollectionItemEvent } from '../../content/itemMembershipHandler.mjs';
import * as baseline from '../../content/baseline.mjs';
import { start, stop, _isRegistered } from '../../content/collectionWatcher.mjs';

// ─── Test fixtures ─────────────────────────────────────────────────────────

const SYNC_ROOT = { id: 100, key: 'ROOT1', name: 'Inbox', libraryID: 1, parentID: null };

function makeCollectionRegistry(collections) {
  const byID = new Map(collections.map((c) => [c.id, c]));
  const byKey = new Map(collections.map((c) => [c.key, c]));
  Zotero.Collections.getByLibraryAndKeyAsync = vi.fn(async (libraryID, key) => {
    const c = byKey.get(key);
    if (!c || c.libraryID !== libraryID) return null;
    return c;
  });
  Zotero.Collections.get = vi.fn((id) => byID.get(id) ?? null);
  Zotero.Collections.getByParent = vi.fn((parentID, libraryID) =>
    collections.filter((c) => c.parentID === parentID && c.libraryID === libraryID),
  );
  return { byID, byKey };
}

function prefStubs(values) {
  Zotero.Prefs.get = vi.fn((fullKey) => {
    const prefix = 'extensions.zotero.watchFolder.';
    if (fullKey.startsWith(prefix)) return values[fullKey.slice(prefix.length)];
    return undefined;
  });
}

function makeStore(collectionRecords = []) {
  const byKey = new Map(collectionRecords.map((r) => [r.zoteroCollectionKey, r]));
  return {
    getCollectionRecord: vi.fn((key) => byKey.get(key) ?? null),
  };
}

function makeCoordinator(store) {
  return { _trackingStore: store };
}

/**
 * Capture the observer object passed to Zotero.Notifier.registerObserver so
 * we can invoke `.notify(...)` directly — mirrors how a real Zotero would
 * fan events out.
 */
function captureObserverID() {
  let captured = null;
  Zotero.Notifier.registerObserver = vi.fn((observer, _topics, _name) => {
    captured = observer;
    return 'observer-1';
  });
  Zotero.Notifier.unregisterObserver = vi.fn();
  return () => captured;
}

beforeEach(() => {
  vi.clearAllMocks();
  Zotero.debug = vi.fn();
  Zotero.logError = vi.fn();
  Zotero.Libraries = { userLibraryID: 1, publicationsLibraryID: 4 };
  // Always make sure the watcher is unregistered between tests.
  stop();
});

// ─── UT-301 ────────────────────────────────────────────────────────────────

describe('UT-301: register/unregister lifecycle', () => {
  it('registers exactly once even when start() is called twice', () => {
    captureObserverID();
    start(makeCoordinator(makeStore()));
    start(makeCoordinator(makeStore()));
    expect(Zotero.Notifier.registerObserver).toHaveBeenCalledTimes(1);
    expect(_isRegistered()).toBe(true);
  });

  it('subscribes to collection + collection-item topics', () => {
    captureObserverID();
    start(makeCoordinator(makeStore()));
    const call = Zotero.Notifier.registerObserver.mock.calls[0];
    expect(call[1]).toEqual(['collection', 'collection-item']);
  });

  it('stop() unregisters and clears state', () => {
    captureObserverID();
    start(makeCoordinator(makeStore()));
    stop();
    expect(Zotero.Notifier.unregisterObserver).toHaveBeenCalledWith('observer-1');
    expect(_isRegistered()).toBe(false);
  });

  it('stop() is a no-op when not registered', () => {
    stop();
    expect(Zotero.Notifier.unregisterObserver).not.toHaveBeenCalled();
  });
});

// ─── UT-302 ────────────────────────────────────────────────────────────────

describe('UT-302: collection add → createFolder under sync root', () => {
  it('emits createFolder for a new subcollection under the sync root', async () => {
    const sub = { id: 200, key: 'SUB1', name: 'Methods', libraryID: 1, parentID: 100 };
    makeCollectionRegistry([SYNC_ROOT, sub]);
    prefStubs({ syncRootCollectionKey: 'ROOT1', syncRootLibraryID: 1 });

    const getObs = captureObserverID();
    start(makeCoordinator(makeStore()));
    const observer = getObs();

    await observer.notify('add', 'collection', [200], {});

    expect(mirrorExecutor.execute).toHaveBeenCalledTimes(1);
    const action = mirrorExecutor.execute.mock.calls[0][0];
    expect(action.type).toBe('createFolder');
    expect(action.payload.collectionKey).toBe('SUB1');
    expect(action.payload.relativePath).toBe('Methods');
    expect(action.payload.parentCollectionKey).toBe('ROOT1');
    expect(action.payload.name).toBe('Methods');
  });

  it('emits createFolder for a deeper nested subcollection', async () => {
    const mid = { id: 200, key: 'SUB1', name: 'Methods', libraryID: 1, parentID: 100 };
    const leaf = { id: 300, key: 'SUB2', name: 'Sub', libraryID: 1, parentID: 200 };
    makeCollectionRegistry([SYNC_ROOT, mid, leaf]);
    prefStubs({ syncRootCollectionKey: 'ROOT1', syncRootLibraryID: 1 });

    const getObs = captureObserverID();
    start(makeCoordinator(makeStore()));
    await getObs().notify('add', 'collection', [300], {});

    const action = mirrorExecutor.execute.mock.calls[0][0];
    expect(action.payload.relativePath).toBe('Methods/Sub');
    expect(action.payload.parentCollectionKey).toBe('SUB1');
  });
});

// ─── UT-310 (A4 fix) ───────────────────────────────────────────────────────

describe('UT-310: add on a populated collection → adopt-into-scope', () => {
  it('routes through baseline when the new collection already has child items', async () => {
    const sub = {
      id: 200, key: 'SUB1', name: 'Methods', libraryID: 1, parentID: 100,
      // Pretend the collection has one item — triggers the content-has check.
      getChildItems: () => [{ key: 'I1' }],
    };
    makeCollectionRegistry([SYNC_ROOT, sub]);
    prefStubs({ syncRootCollectionKey: 'ROOT1', syncRootLibraryID: 1, sourcePath: '/watch' });

    const getObs = captureObserverID();
    start(makeCoordinator(makeStore()));
    await getObs().notify('add', 'collection', [200], {});

    expect(baseline.adoptCollectionSubtree).toHaveBeenCalledTimes(1);
    expect(baseline.adoptCollectionSubtree.mock.calls[0][0].rootCollection.key).toBe('SUB1');
    // Plain createFolder NOT emitted — baseline owns mkdir + copies.
    expect(mirrorExecutor.execute).not.toHaveBeenCalled();
  });
});

// ─── UT-303 ────────────────────────────────────────────────────────────────

describe('UT-303: collection add → ignored when out-of-scope', () => {
  it('ignores collections that are not under the sync root', async () => {
    const other = { id: 999, key: 'OTHER', name: 'Project A', libraryID: 1, parentID: null };
    makeCollectionRegistry([SYNC_ROOT, other]);
    prefStubs({ syncRootCollectionKey: 'ROOT1', syncRootLibraryID: 1 });

    const getObs = captureObserverID();
    start(makeCoordinator(makeStore()));
    await getObs().notify('add', 'collection', [999], {});

    expect(mirrorExecutor.execute).not.toHaveBeenCalled();
  });

  it('ignores virtual / special collections', async () => {
    const trash = { id: 555, key: 'TRSH', name: 'Trash', libraryID: 1, parentID: 100, treeViewID: 'T' };
    makeCollectionRegistry([SYNC_ROOT, trash]);
    prefStubs({ syncRootCollectionKey: 'ROOT1', syncRootLibraryID: 1 });

    const getObs = captureObserverID();
    start(makeCoordinator(makeStore()));
    await getObs().notify('add', 'collection', [555], {});

    expect(mirrorExecutor.execute).not.toHaveBeenCalled();
  });

  it('does NOT emit createFolder for the sync root itself', async () => {
    makeCollectionRegistry([SYNC_ROOT]);
    prefStubs({ syncRootCollectionKey: 'ROOT1', syncRootLibraryID: 1 });

    const getObs = captureObserverID();
    start(makeCoordinator(makeStore()));
    await getObs().notify('add', 'collection', [100], {});

    expect(mirrorExecutor.execute).not.toHaveBeenCalled();
  });
});

// ─── UT-304 ────────────────────────────────────────────────────────────────

describe('UT-304: collection modify (rename) → moveFolder', () => {
  it('emits moveFolder when the leaf name changed', async () => {
    const sub = { id: 200, key: 'SUB1', name: 'NewName', libraryID: 1, parentID: 100 };
    makeCollectionRegistry([SYNC_ROOT, sub]);
    prefStubs({ syncRootCollectionKey: 'ROOT1', syncRootLibraryID: 1 });

    const store = makeStore([
      { type: 'collection', zoteroCollectionKey: 'SUB1', localPath: 'OldName', parentCollectionKey: 'ROOT1', state: 'clean' },
    ]);
    const getObs = captureObserverID();
    start(makeCoordinator(store));
    await getObs().notify('modify', 'collection', [200], {});

    expect(mirrorExecutor.execute).toHaveBeenCalledTimes(1);
    const action = mirrorExecutor.execute.mock.calls[0][0];
    expect(action.type).toBe('moveFolder');
    expect(action.payload.oldRelativePath).toBe('OldName');
    expect(action.payload.newRelativePath).toBe('NewName');
    expect(action.payload.newName).toBe('NewName');
  });
});

// ─── UT-305 ────────────────────────────────────────────────────────────────

describe('UT-305: collection modify (reparent) → moveFolder', () => {
  it('emits moveFolder when parent changed', async () => {
    const newParent = { id: 250, key: 'NEWP', name: 'NewParent', libraryID: 1, parentID: 100 };
    const moved = { id: 200, key: 'SUB1', name: 'Methods', libraryID: 1, parentID: 250 };
    makeCollectionRegistry([SYNC_ROOT, newParent, moved]);
    prefStubs({ syncRootCollectionKey: 'ROOT1', syncRootLibraryID: 1 });

    const store = makeStore([
      { type: 'collection', zoteroCollectionKey: 'SUB1', localPath: 'Methods', parentCollectionKey: 'ROOT1', state: 'clean' },
    ]);
    const getObs = captureObserverID();
    start(makeCoordinator(store));
    await getObs().notify('modify', 'collection', [200], {});

    const action = mirrorExecutor.execute.mock.calls[0][0];
    expect(action.type).toBe('moveFolder');
    expect(action.payload.oldRelativePath).toBe('Methods');
    expect(action.payload.newRelativePath).toBe('NewParent/Methods');
    expect(action.payload.newParentCollectionKey).toBe('NEWP');
  });
});

// ─── UT-306 ────────────────────────────────────────────────────────────────

describe('UT-306: collection modify with no path change → no emit', () => {
  it('does nothing when localPath matches current relpath', async () => {
    const sub = { id: 200, key: 'SUB1', name: 'Methods', libraryID: 1, parentID: 100 };
    makeCollectionRegistry([SYNC_ROOT, sub]);
    prefStubs({ syncRootCollectionKey: 'ROOT1', syncRootLibraryID: 1 });

    const store = makeStore([
      { type: 'collection', zoteroCollectionKey: 'SUB1', localPath: 'Methods', parentCollectionKey: 'ROOT1', state: 'clean' },
    ]);
    const getObs = captureObserverID();
    start(makeCoordinator(store));
    await getObs().notify('modify', 'collection', [200], {});

    expect(mirrorExecutor.execute).not.toHaveBeenCalled();
  });
});

// ─── UT-307 ────────────────────────────────────────────────────────────────

describe('UT-307: modify on untracked under-root collection → adopt-into-scope', () => {
  it('routes through baseline.adoptCollectionSubtree (does NOT emit createFolder)', async () => {
    const sub = { id: 200, key: 'SUB1', name: 'Methods', libraryID: 1, parentID: 100 };
    makeCollectionRegistry([SYNC_ROOT, sub]);
    prefStubs({ syncRootCollectionKey: 'ROOT1', syncRootLibraryID: 1, sourcePath: '/watch' });

    const getObs = captureObserverID();
    start(makeCoordinator(makeStore())); // empty store
    await getObs().notify('modify', 'collection', [200], {});

    expect(baseline.adoptCollectionSubtree).toHaveBeenCalledTimes(1);
    const args = baseline.adoptCollectionSubtree.mock.calls[0][0];
    expect(args.rootCollection.key).toBe('SUB1');
    expect(args.watchRoot).toBe('/watch');
    // createFolder is NOT emitted — adoptCollectionSubtree owns the mkdir.
    expect(mirrorExecutor.execute).not.toHaveBeenCalled();
  });
});

// ─── UT-308 ────────────────────────────────────────────────────────────────

describe('UT-308: collection delete → deleteFolder iff record exists', () => {
  it('emits deleteFolder when we had a tracked collection record', async () => {
    makeCollectionRegistry([SYNC_ROOT]); // SUB1 already gone
    prefStubs({ syncRootCollectionKey: 'ROOT1', syncRootLibraryID: 1 });

    const store = makeStore([
      { type: 'collection', zoteroCollectionKey: 'SUB1', localPath: 'Methods', parentCollectionKey: 'ROOT1', state: 'clean' },
    ]);
    const getObs = captureObserverID();
    start(makeCoordinator(store));
    await getObs().notify('delete', 'collection', [200], { 200: { key: 'SUB1' } });

    const action = mirrorExecutor.execute.mock.calls[0][0];
    expect(action.type).toBe('deleteFolder');
    expect(action.payload.collectionKey).toBe('SUB1');
    expect(action.payload.oldRelativePath).toBe('Methods');
  });

  it('ignores delete of an untracked collection', async () => {
    makeCollectionRegistry([SYNC_ROOT]);
    prefStubs({ syncRootCollectionKey: 'ROOT1', syncRootLibraryID: 1 });

    const getObs = captureObserverID();
    start(makeCoordinator(makeStore())); // empty store
    await getObs().notify('delete', 'collection', [200], { 200: { key: 'GONE' } });

    expect(mirrorExecutor.execute).not.toHaveBeenCalled();
  });

  it('handles trash event the same as delete', async () => {
    makeCollectionRegistry([SYNC_ROOT]);
    prefStubs({ syncRootCollectionKey: 'ROOT1', syncRootLibraryID: 1 });

    const store = makeStore([
      { type: 'collection', zoteroCollectionKey: 'SUB1', localPath: 'Methods', parentCollectionKey: 'ROOT1', state: 'clean' },
    ]);
    const getObs = captureObserverID();
    start(makeCoordinator(store));
    await getObs().notify('trash', 'collection', [200], { 200: { key: 'SUB1' } });

    expect(mirrorExecutor.execute).toHaveBeenCalledTimes(1);
    expect(mirrorExecutor.execute.mock.calls[0][0].type).toBe('deleteFolder');
  });
});

// ─── UT-309 ────────────────────────────────────────────────────────────────

describe('UT-309: collection-item events → forwarded to membership handler', () => {
  it('forwards add events with the coordinator reference', async () => {
    makeCollectionRegistry([SYNC_ROOT]);
    prefStubs({ syncRootCollectionKey: 'ROOT1', syncRootLibraryID: 1 });

    const coordinator = makeCoordinator(makeStore());
    const getObs = captureObserverID();
    start(coordinator);
    await getObs().notify('add', 'collection-item', ['100-500'], { '100-500': {} });

    expect(handleCollectionItemEvent).toHaveBeenCalledTimes(1);
    const [event, ids, extraData, coord] = handleCollectionItemEvent.mock.calls[0];
    expect(event).toBe('add');
    expect(ids).toEqual(['100-500']);
    expect(extraData).toEqual({ '100-500': {} });
    expect(coord).toBe(coordinator);
  });

  it('does not touch mirrorExecutor for collection-item events', async () => {
    makeCollectionRegistry([SYNC_ROOT]);
    prefStubs({ syncRootCollectionKey: 'ROOT1', syncRootLibraryID: 1 });

    const getObs = captureObserverID();
    start(makeCoordinator(makeStore()));
    await getObs().notify('remove', 'collection-item', ['100-500'], {});

    expect(mirrorExecutor.execute).not.toHaveBeenCalled();
  });
});
