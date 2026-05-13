/**
 * Unit tests for content/collectionSync.mjs
 *
 * Covers UT-054..UT-064 — the Phase-2 CollectionSyncService orchestrator.
 *
 * The service has heavy external dependencies (SyncState, CollectionWatcher,
 * FolderWatcher, PathMapper, ConflictResolver, plus the Zotero/IOUtils
 * globals). Every collaborator is mocked via vi.mock so each test can drive a
 * specific code path without booting the real Zotero environment.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ───────────────────────────────────────────────────────────────────────────
// Module mocks
// ───────────────────────────────────────────────────────────────────────────

vi.mock('../../content/utils.mjs', () => ({
  getPref: vi.fn(),
  setPref: vi.fn(),
}));

vi.mock('../../content/syncState.mjs', () => {
  const mockState = {
    init: vi.fn(async () => {}),
    save: vi.fn(async () => {}),
    clear: vi.fn(),
    markFullSync: vi.fn(),
    setCollection: vi.fn(),
    getCollection: vi.fn(),
    removeCollection: vi.fn(),
    getCollectionByPath: vi.fn(),
    setItem: vi.fn(),
    getItem: vi.fn(),
    removeItem: vi.fn(),
    getItemByPath: vi.fn(),
    getItemsByCollection: vi.fn(() => []),
    addItemToCollection: vi.fn(),
    removeItemFromCollection: vi.fn(),
    getStats: vi.fn(() => ({})),
  };
  return {
    SyncState: vi.fn(),
    getSyncState: vi.fn(() => mockState),
    __mockState: mockState,
  };
});

vi.mock('../../content/collectionWatcher.mjs', () => {
  const watcher = {
    register: vi.fn(),
    unregister: vi.fn(),
    isEnabled: vi.fn(() => true),
    pause: vi.fn(),
    resume: vi.fn(),
  };
  return {
    CollectionWatcher: vi.fn(),
    getCollectionWatcher: vi.fn(() => watcher),
    __mockWatcher: watcher,
  };
});

vi.mock('../../content/folderWatcher.mjs', () => {
  const watcher = {
    start: vi.fn(),
    stop: vi.fn(),
    forceScan: vi.fn(),
    isWatching: vi.fn(() => true),
  };
  return {
    FolderWatcher: vi.fn(),
    getFolderWatcher: vi.fn(() => watcher),
    __mockFolderWatcher: watcher,
  };
});

vi.mock('../../content/pathMapper.mjs', () => {
  const mapper = {
    getPathForCollection: vi.fn((c) => `/mirror/${c.name}`),
    getCollectionForPath: vi.fn(() => null),
    getUniqueFilePath: vi.fn(async (folder, name) => `${folder}/unique-${name}`),
    clearCache: vi.fn(),
    invalidateCollection: vi.fn(),
    setMirrorPath: vi.fn(),
    setRootCollection: vi.fn(),
    sanitizeFolderName: vi.fn((n) => n),
  };
  return {
    PathMapper: vi.fn(),
    getPathMapper: vi.fn(() => mapper),
    __mockMapper: mapper,
  };
});

vi.mock('../../content/conflictResolver.mjs', () => {
  return {
    ConflictResolver: vi.fn(function () {
      this.init = vi.fn();
      this.resolve = vi.fn(async () => ({ action: 'rename' }));
    }),
    ResolutionStrategy: {
      ZOTERO_WINS: 'zotero',
      DISK_WINS: 'disk',
      LAST_WRITE_WINS: 'last',
      KEEP_BOTH: 'both',
      MANUAL: 'manual',
    },
    ConflictType: {},
  };
});

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

/**
 * Build a fresh CollectionSyncService with all collaborators stubbed and the
 * `_initialized`/`_enabled` flags pre-set so we can focus on the method under
 * test without re-running init() each time.
 */
async function buildService({ enabled = true, initialized = true } = {}) {
  const { CollectionSyncService } = await import('../../content/collectionSync.mjs');
  const syncStateMod = await import('../../content/syncState.mjs');
  const colWatcherMod = await import('../../content/collectionWatcher.mjs');
  const folderWatcherMod = await import('../../content/folderWatcher.mjs');
  const pathMapperMod = await import('../../content/pathMapper.mjs');

  const svc = new CollectionSyncService();
  svc._mirrorPath = '/mirror';
  svc._rootCollectionID = 1;
  svc._enabled = enabled;
  svc._initialized = initialized;
  svc._syncState = syncStateMod.__mockState;
  svc._collectionWatcher = colWatcherMod.__mockWatcher;
  svc._folderWatcher = folderWatcherMod.__mockFolderWatcher;
  svc._pathMapper = pathMapperMod.__mockMapper;
  svc._conflictResolver = { resolve: vi.fn(async () => ({ action: 'rename' })) };
  return svc;
}

function makeCollection({ id = 10, name = 'Stuff', parentID = 1, libraryID = 1, children = [] } = {}) {
  return {
    id, name, parentID, libraryID,
    getChildItems: vi.fn(() => children),
    saveTx: vi.fn(async () => {}),
    eraseTx: vi.fn(async () => {}),
    removeItem: vi.fn(),
  };
}

function makeLinkedAttachment({ id = 100, path = '/mirror/Stuff/file.pdf' } = {}) {
  return {
    id,
    isAttachment: vi.fn(() => true),
    attachmentLinkMode: 2, // LINK_MODE_LINKED_FILE constant value
    getFilePath: vi.fn(() => path),
    relinkAttachmentFile: vi.fn(async () => {}),
    saveTx: vi.fn(async () => {}),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// UT-054: init()
// ───────────────────────────────────────────────────────────────────────────

describe('UT-054: CollectionSyncService.init', () => {
  let getPrefMock;

  beforeEach(async () => {
    vi.resetAllMocks();
    const utils = await import('../../content/utils.mjs');
    getPrefMock = utils.getPref;

    // Default: required prefs present and root collection exists
    getPrefMock.mockImplementation((k) => {
      if (k === 'mirrorPath') return '/mirror';
      if (k === 'mirrorRootCollection') return '1';
      if (k === 'collectionSyncEnabled') return true;
      return undefined;
    });
    globalThis.Zotero.Collections.get = vi.fn(() => makeCollection({ id: 1, name: 'Root' }));
  });

  it('initialises components when prefs are configured and root exists', async () => {
    const { CollectionSyncService } = await import('../../content/collectionSync.mjs');
    const svc = new CollectionSyncService();

    await svc.init();

    expect(svc._initialized).toBe(true);
    expect(svc._mirrorPath).toBe('/mirror');
    expect(svc._rootCollectionID).toBe(1);
    expect(svc._syncState).toBeTruthy();
    expect(svc._pathMapper).toBeTruthy();
    expect(svc._collectionWatcher).toBeTruthy();
    expect(svc._folderWatcher).toBeTruthy();
  });

  it('bails out (not initialised) when mirrorPath pref is missing', async () => {
    getPrefMock.mockImplementation((k) => k === 'mirrorRootCollection' ? '1' : null);
    const { CollectionSyncService } = await import('../../content/collectionSync.mjs');
    const svc = new CollectionSyncService();

    await svc.init();

    expect(svc._initialized).toBe(false);
    expect(svc._syncState).toBeNull();
  });

  it('bails out when root collection does not exist', async () => {
    globalThis.Zotero.Collections.get = vi.fn(() => null);
    const { CollectionSyncService } = await import('../../content/collectionSync.mjs');
    const svc = new CollectionSyncService();

    await svc.init();

    expect(svc._initialized).toBe(false);
  });

  it('is idempotent — calling init twice does not re-register watchers', async () => {
    const { CollectionSyncService } = await import('../../content/collectionSync.mjs');
    const colWatcherMod = await import('../../content/collectionWatcher.mjs');
    const svc = new CollectionSyncService();

    await svc.init();
    await svc.init();

    // getCollectionWatcher should have been called exactly once
    expect(colWatcherMod.getCollectionWatcher).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// UT-055: start() / stop()
// ───────────────────────────────────────────────────────────────────────────

describe('UT-055: CollectionSyncService.start / stop', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it('start() runs a full sync and registers both watchers', async () => {
    const svc = await buildService();
    const fullSyncSpy = vi.spyOn(svc, 'performFullSync').mockResolvedValue();
    globalThis.Zotero.Collections.getByParent = vi.fn(() => []);

    await svc.start();

    expect(fullSyncSpy).toHaveBeenCalledTimes(1);
    expect(svc._collectionWatcher.register).toHaveBeenCalledTimes(1);
    expect(svc._folderWatcher.start).toHaveBeenCalledTimes(1);
  });

  it('start() short-circuits when service is not enabled', async () => {
    const svc = await buildService({ enabled: false });
    const fullSyncSpy = vi.spyOn(svc, 'performFullSync').mockResolvedValue();

    await svc.start();

    expect(fullSyncSpy).not.toHaveBeenCalled();
    expect(svc._collectionWatcher.register).not.toHaveBeenCalled();
  });

  it('stop() unregisters watchers cleanly and tolerates null collaborators', async () => {
    const svc = await buildService();
    const colW = svc._collectionWatcher;
    const fldW = svc._folderWatcher;

    svc.stop();

    expect(colW.unregister).toHaveBeenCalledTimes(1);
    expect(fldW.stop).toHaveBeenCalledTimes(1);

    // Now null them out and re-call: should not throw thanks to optional chaining
    svc._collectionWatcher = null;
    svc._folderWatcher = null;
    expect(() => svc.stop()).not.toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// UT-056: performFullSync()
// ───────────────────────────────────────────────────────────────────────────

describe('UT-056: CollectionSyncService.performFullSync', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it('ensures mirror dir, syncs each collection, syncs items, marks done', async () => {
    const svc = await buildService();
    const c1 = makeCollection({ id: 10, name: 'A', parentID: 1 });
    const c2 = makeCollection({ id: 11, name: 'B', parentID: 1 });

    globalThis.Zotero.Collections.get = vi.fn((id) =>
      id === 1 ? makeCollection({ id: 1, name: 'Root' }) :
      id === 10 ? c1 : id === 11 ? c2 : null);
    globalThis.Zotero.Collections.getByParent = vi.fn((parent) =>
      parent === 1 ? [c1, c2] : []);

    await svc.performFullSync();

    expect(globalThis.IOUtils.makeDirectory).toHaveBeenCalledWith('/mirror', expect.objectContaining({ ignoreExisting: true }));
    expect(svc._syncState.setCollection).toHaveBeenCalledTimes(2);
    expect(svc._syncState.markFullSync).toHaveBeenCalledTimes(1);
    expect(svc._syncState.save).toHaveBeenCalled();
    expect(svc._isSyncing).toBe(false); // finally block restored it
  });

  it('returns immediately when another full sync is in progress (_isSyncing guard)', async () => {
    const svc = await buildService();
    svc._isSyncing = true;

    await svc.performFullSync();

    expect(globalThis.IOUtils.makeDirectory).not.toHaveBeenCalled();
    expect(svc._syncState.markFullSync).not.toHaveBeenCalled();
  });

  it('swallows errors from makeDirectory but always clears _isSyncing', async () => {
    const svc = await buildService();
    const original = globalThis.IOUtils.makeDirectory;
    globalThis.IOUtils.makeDirectory = vi.fn(async () => { throw new Error('disk full'); });
    globalThis.Zotero.Collections.get = vi.fn(() => makeCollection({ id: 1, name: 'Root' }));
    globalThis.Zotero.Collections.getByParent = vi.fn(() => []);

    try {
      await svc.performFullSync();

      expect(svc._isSyncing).toBe(false);
      expect(globalThis.Zotero.logError).toHaveBeenCalled();
    } finally {
      // Restore so it doesn't leak into following tests in the same file
      globalThis.IOUtils.makeDirectory = original;
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// UT-057: handleCollectionCreated
// ───────────────────────────────────────────────────────────────────────────

describe('UT-057: handleCollectionCreated', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it('creates folder + updates state for a new collection under mirror root', async () => {
    const svc = await buildService();
    const newCol = makeCollection({ id: 50, name: 'NewKid', parentID: 1 });
    globalThis.Zotero.Collections.get = vi.fn((id) =>
      id === 1 ? makeCollection({ id: 1, name: 'Root' }) :
      id === 50 ? newCol : null);

    await svc.handleCollectionCreated(50);

    expect(globalThis.IOUtils.makeDirectory).toHaveBeenCalled();
    expect(svc._syncState.setCollection).toHaveBeenCalledWith(50, expect.objectContaining({
      name: 'NewKid',
      parentID: 1,
    }));
    expect(svc._syncState.save).toHaveBeenCalled();
  });

  it('skips when _isSyncing is true (loop prevention)', async () => {
    const svc = await buildService();
    svc._isSyncing = true;

    await svc.handleCollectionCreated(50);

    expect(svc._syncState.setCollection).not.toHaveBeenCalled();
  });

  it('skips when collection is outside the mirror root', async () => {
    const svc = await buildService();
    const outside = makeCollection({ id: 50, name: 'Outsider', parentID: 999 });
    globalThis.Zotero.Collections.get = vi.fn((id) =>
      id === 1 ? makeCollection({ id: 1, name: 'Root' }) :
      id === 50 ? outside :
      id === 999 ? makeCollection({ id: 999, name: 'Other', parentID: null }) : null);

    await svc.handleCollectionCreated(50);

    expect(svc._syncState.setCollection).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// UT-058: handleCollectionRenamed
// ───────────────────────────────────────────────────────────────────────────

describe('UT-058: handleCollectionRenamed', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it('moves the old folder to the new path when both exist', async () => {
    const svc = await buildService();
    const col = makeCollection({ id: 50, name: 'NewName', parentID: 1 });
    globalThis.Zotero.Collections.get = vi.fn((id) =>
      id === 1 ? makeCollection({ id: 1, name: 'Root' }) :
      id === 50 ? col : null);
    globalThis.Zotero.Collections.getByParent = vi.fn(() => []);
    svc._syncState.getCollection.mockReturnValue({
      name: 'OldName', parentID: 1, folderPath: '/mirror/OldName',
    });
    svc._pathMapper.getPathForCollection.mockReturnValue('/mirror/NewName');
    globalThis.IOUtils.exists = vi.fn(async () => true);

    await svc.handleCollectionRenamed(50, 'OldName');

    expect(globalThis.IOUtils.move).toHaveBeenCalledWith('/mirror/OldName', '/mirror/NewName');
    expect(svc._syncState.setCollection).toHaveBeenCalledWith(50, expect.objectContaining({
      folderPath: '/mirror/NewName',
    }));
  });

  it('does NOT move the folder if old path is missing on disk', async () => {
    const svc = await buildService();
    const col = makeCollection({ id: 50, name: 'NewName', parentID: 1 });
    globalThis.Zotero.Collections.get = vi.fn((id) =>
      id === 1 ? makeCollection({ id: 1, name: 'Root' }) :
      id === 50 ? col : null);
    svc._syncState.getCollection.mockReturnValue({
      name: 'OldName', parentID: 1, folderPath: '/mirror/OldName',
    });
    svc._pathMapper.getPathForCollection.mockReturnValue('/mirror/NewName');
    globalThis.IOUtils.exists = vi.fn(async () => false);

    await svc.handleCollectionRenamed(50, 'OldName');

    expect(globalThis.IOUtils.move).not.toHaveBeenCalled();
  });

  it('treats untracked collection as a fresh create', async () => {
    const svc = await buildService();
    const col = makeCollection({ id: 50, name: 'Renamed', parentID: 1 });
    globalThis.Zotero.Collections.get = vi.fn((id) =>
      id === 1 ? makeCollection({ id: 1, name: 'Root' }) :
      id === 50 ? col : null);
    svc._syncState.getCollection.mockReturnValue(null);

    await svc.handleCollectionRenamed(50, 'OldName');

    expect(globalThis.IOUtils.makeDirectory).toHaveBeenCalled();
    expect(svc._syncState.setCollection).toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// UT-059: handleCollectionDeleted
// ───────────────────────────────────────────────────────────────────────────

describe('UT-059: handleCollectionDeleted', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it('removes the folder when it is empty', async () => {
    const svc = await buildService();
    svc._syncState.getCollection.mockReturnValue({ folderPath: '/mirror/Gone' });
    globalThis.IOUtils.exists = vi.fn(async () => true);
    globalThis.IOUtils.getChildren = vi.fn(async () => []);

    await svc.handleCollectionDeleted(50);

    expect(globalThis.IOUtils.remove).toHaveBeenCalledWith('/mirror/Gone');
    expect(svc._syncState.removeCollection).toHaveBeenCalledWith(50);
  });

  it('keeps a non-empty folder, but still drops the state entry', async () => {
    const svc = await buildService();
    svc._syncState.getCollection.mockReturnValue({ folderPath: '/mirror/HasStuff' });
    globalThis.IOUtils.exists = vi.fn(async () => true);
    globalThis.IOUtils.getChildren = vi.fn(async () => ['/mirror/HasStuff/x.pdf']);

    await svc.handleCollectionDeleted(50);

    expect(globalThis.IOUtils.remove).not.toHaveBeenCalled();
    expect(svc._syncState.removeCollection).toHaveBeenCalledWith(50);
  });

  it('is a no-op when collection was never tracked', async () => {
    const svc = await buildService();
    svc._syncState.getCollection.mockReturnValue(null);

    await svc.handleCollectionDeleted(50);

    expect(svc._syncState.removeCollection).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// UT-060: handleItemAddedToCollection
// ───────────────────────────────────────────────────────────────────────────

describe('UT-060: handleItemAddedToCollection', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    globalThis.Zotero.Attachments = {
      LINK_MODE_LINKED_FILE: 2,
      linkFromFile: vi.fn(),
    };
  });

  it('moves the file, relinks attachment, updates state', async () => {
    const svc = await buildService();
    const item = makeLinkedAttachment({ id: 100, path: '/inbox/file.pdf' });
    globalThis.Zotero.Items.getAsync = vi.fn(async () => item);

    const col = makeCollection({ id: 10, name: 'Target', parentID: 1 });
    globalThis.Zotero.Collections.get = vi.fn((id) =>
      id === 1 ? makeCollection({ id: 1, name: 'Root' }) :
      id === 10 ? col : null);
    svc._pathMapper.getPathForCollection.mockReturnValue('/mirror/Target');
    // Source must exist (line 543 check); target must NOT exist (no conflict)
    globalThis.IOUtils.exists = vi.fn(async (p) => p === '/inbox/file.pdf');

    await svc.handleItemAddedToCollection(100, 10);

    expect(globalThis.IOUtils.move).toHaveBeenCalledWith('/inbox/file.pdf', '/mirror/Target/file.pdf');
    expect(item.relinkAttachmentFile).toHaveBeenCalledWith('/mirror/Target/file.pdf');
    expect(svc._syncState.setItem).toHaveBeenCalledWith(100, expect.objectContaining({
      filePath: '/mirror/Target/file.pdf',
      primaryCollectionID: 10,
    }));
  });

  it('invokes conflictResolver when a file already exists at the target', async () => {
    const svc = await buildService();
    const item = makeLinkedAttachment({ id: 100, path: '/inbox/file.pdf' });
    globalThis.Zotero.Items.getAsync = vi.fn(async () => item);

    const col = makeCollection({ id: 10, name: 'Target', parentID: 1 });
    globalThis.Zotero.Collections.get = vi.fn((id) =>
      id === 1 ? makeCollection({ id: 1, name: 'Root' }) :
      id === 10 ? col : null);
    svc._pathMapper.getPathForCollection.mockReturnValue('/mirror/Target');
    svc._pathMapper.getUniqueFilePath.mockResolvedValue('/mirror/Target/file (1).pdf');
    globalThis.IOUtils.exists = vi.fn(async () => true);  // CONFLICT
    svc._conflictResolver.resolve.mockResolvedValue({ action: 'rename' });

    await svc.handleItemAddedToCollection(100, 10);

    expect(svc._conflictResolver.resolve).toHaveBeenCalledWith(expect.objectContaining({
      type: 'file_exists',
      sourcePath: '/inbox/file.pdf',
    }));
    expect(globalThis.IOUtils.move).toHaveBeenCalledWith('/inbox/file.pdf', '/mirror/Target/file (1).pdf');
  });

  it('skips the move when the conflict resolver returns action=skip', async () => {
    const svc = await buildService();
    const item = makeLinkedAttachment({ id: 100, path: '/inbox/file.pdf' });
    globalThis.Zotero.Items.getAsync = vi.fn(async () => item);

    const col = makeCollection({ id: 10, name: 'Target', parentID: 1 });
    globalThis.Zotero.Collections.get = vi.fn((id) =>
      id === 1 ? makeCollection({ id: 1, name: 'Root' }) :
      id === 10 ? col : null);
    svc._pathMapper.getPathForCollection.mockReturnValue('/mirror/Target');
    globalThis.IOUtils.exists = vi.fn(async () => true);
    svc._conflictResolver.resolve.mockResolvedValue({ action: 'skip' });

    await svc.handleItemAddedToCollection(100, 10);

    expect(globalThis.IOUtils.move).not.toHaveBeenCalled();
    expect(item.relinkAttachmentFile).not.toHaveBeenCalled();
  });

  it('ignores non-linked attachments', async () => {
    const svc = await buildService();
    const item = {
      isAttachment: vi.fn(() => true),
      attachmentLinkMode: 1, // stored, not linked
      getFilePath: vi.fn(),
    };
    globalThis.Zotero.Items.getAsync = vi.fn(async () => item);

    await svc.handleItemAddedToCollection(100, 10);

    expect(item.getFilePath).not.toHaveBeenCalled();
    expect(globalThis.IOUtils.move).not.toHaveBeenCalled();
  });

  it('returns early when the same item is already in the pending set', async () => {
    const svc = await buildService();
    svc._pendingItems.add(100);

    await svc.handleItemAddedToCollection(100, 10);

    expect(globalThis.Zotero.Items.getAsync ?? vi.fn()).not.toHaveBeenCalled?.();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// UT-061: handleItemRemovedFromCollection / handleItemDeleted
// ───────────────────────────────────────────────────────────────────────────

describe('UT-061: handleItemRemovedFromCollection / handleItemDeleted', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it('removes the collection from the item but keeps the item if other collections remain', async () => {
    const svc = await buildService();
    svc._syncState.getItem
      .mockReturnValueOnce({ collectionIDs: [10, 20] })  // before removal — pre-check
      .mockReturnValueOnce({ collectionIDs: [20] });     // after removal

    await svc.handleItemRemovedFromCollection(100, 10);

    expect(svc._syncState.removeItemFromCollection).toHaveBeenCalledWith(100, 10);
    expect(svc._syncState.removeItem).not.toHaveBeenCalled();
  });

  it('removes the item from state entirely when the last collection link is gone', async () => {
    const svc = await buildService();
    svc._syncState.getItem
      .mockReturnValueOnce({ collectionIDs: [10] })
      .mockReturnValueOnce({ collectionIDs: [] });

    await svc.handleItemRemovedFromCollection(100, 10);

    expect(svc._syncState.removeItem).toHaveBeenCalledWith(100);
  });

  it('handleItemDeleted just clears state', async () => {
    const svc = await buildService();

    await svc.handleItemDeleted(100);

    expect(svc._syncState.removeItem).toHaveBeenCalledWith(100);
    expect(svc._syncState.save).toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// UT-062: handleFileAdded / handleFolderCreated / handleFileDeletedFromMirror
// ───────────────────────────────────────────────────────────────────────────

describe('UT-062: disk-side handlers', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    globalThis.Zotero.Attachments = {
      LINK_MODE_LINKED_FILE: 2,
      linkFromFile: vi.fn(async () => ({ id: 555 })),
    };
  });

  it('handleFileAdded creates a linked attachment when not already tracked', async () => {
    const svc = await buildService();
    const col = makeCollection({ id: 10, name: 'Target', parentID: 1 });
    svc._syncState.getItemByPath.mockReturnValue(null);
    svc._syncState.getCollectionByPath.mockReturnValue({ id: 10 });
    globalThis.Zotero.Collections.get = vi.fn((id) =>
      id === 1 ? makeCollection({ id: 1, name: 'Root' }) :
      id === 10 ? col : null);

    await svc.handleFileAdded('/mirror/Target/new.pdf');

    expect(globalThis.Zotero.Attachments.linkFromFile).toHaveBeenCalledWith(expect.objectContaining({
      file: '/mirror/Target/new.pdf',
      collections: [10],
    }));
    expect(svc._syncState.setItem).toHaveBeenCalledWith(555, expect.objectContaining({
      filePath: '/mirror/Target/new.pdf',
      primaryCollectionID: 10,
    }));
  });

  it('handleFileAdded skips a file whose parent folder is not a tracked collection', async () => {
    const svc = await buildService();
    svc._syncState.getItemByPath.mockReturnValue(null);
    svc._syncState.getCollectionByPath.mockReturnValue(null);

    await svc.handleFileAdded('/mirror/Untracked/new.pdf');

    expect(globalThis.Zotero.Attachments.linkFromFile).not.toHaveBeenCalled();
  });

  it('handleFileAdded skips files already tracked', async () => {
    const svc = await buildService();
    svc._syncState.getItemByPath.mockReturnValue({ id: 999 });

    await svc.handleFileAdded('/mirror/Target/dup.pdf');

    expect(globalThis.Zotero.Attachments.linkFromFile).not.toHaveBeenCalled();
  });

  it('handleFileAdded ignores paths outside the mirror', async () => {
    const svc = await buildService();

    await svc.handleFileAdded('/elsewhere/new.pdf');

    expect(svc._syncState.getCollectionByPath).not.toHaveBeenCalled();
  });

  it('handleFolderCreated creates a matching Zotero collection', async () => {
    const svc = await buildService();

    // Capture instances of new Zotero.Collection()
    const savedInstances = [];
    globalThis.Zotero.Collection = vi.fn(function () {
      const inst = {
        libraryID: null,
        name: null,
        parentID: null,
        id: 777,
        saveTx: vi.fn(async () => {}),
      };
      savedInstances.push(inst);
      return inst;
    });
    globalThis.Zotero.Libraries = { userLibraryID: 1 };
    globalThis.Zotero.Collections.get = vi.fn(() => makeCollection({ id: 1, name: 'Root', libraryID: 1 }));
    svc._syncState.getCollectionByPath.mockReturnValue(null);

    await svc.handleFolderCreated('/mirror/NewFolder');

    expect(savedInstances).toHaveLength(1);
    expect(savedInstances[0].name).toBe('NewFolder');
    expect(savedInstances[0].parentID).toBe(1); // mirror root
    expect(savedInstances[0].saveTx).toHaveBeenCalled();
    expect(svc._syncState.setCollection).toHaveBeenCalledWith(777, expect.objectContaining({
      folderPath: '/mirror/NewFolder',
    }));
  });

  it('handleFolderCreated bails when a state entry already exists for that path', async () => {
    const svc = await buildService();
    svc._syncState.getCollectionByPath.mockReturnValue({ id: 99 });
    globalThis.Zotero.Collection = vi.fn();

    await svc.handleFolderCreated('/mirror/Existing');

    expect(globalThis.Zotero.Collection).not.toHaveBeenCalled();
  });

  it('handleFileDeletedFromMirror removes item from collections but does NOT delete the Zotero item', async () => {
    const svc = await buildService();
    const col = makeCollection({ id: 10, name: 'Target' });
    const item = { id: 100, deleted: false };
    svc._syncState.getItemByPath.mockReturnValue({ id: 100, collectionIDs: [10] });
    globalThis.Zotero.Items.getAsync = vi.fn(async () => item);
    globalThis.Zotero.Collections.get = vi.fn(() => col);

    await svc.handleFileDeletedFromMirror('/mirror/Target/gone.pdf');

    expect(col.removeItem).toHaveBeenCalledWith(100);
    expect(col.saveTx).toHaveBeenCalled();
    expect(item.deleted).toBe(false); // item not deleted, only unlinked
    expect(svc._syncState.removeItem).toHaveBeenCalledWith(100);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// UT-063: setEnabled / configure
// ───────────────────────────────────────────────────────────────────────────

describe('UT-063: setEnabled / configure', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it('setEnabled(false) calls stop() and writes the pref', async () => {
    const svc = await buildService();
    const utils = await import('../../content/utils.mjs');
    const stopSpy = vi.spyOn(svc, 'stop');

    await svc.setEnabled(false);

    expect(stopSpy).toHaveBeenCalled();
    expect(utils.setPref).toHaveBeenCalledWith('collectionSyncEnabled', false);
    expect(svc._enabled).toBe(false);
  });

  it('configure() stops, updates prefs, clears state, and restarts when previously running', async () => {
    const svc = await buildService();
    const utils = await import('../../content/utils.mjs');
    const stopSpy = vi.spyOn(svc, 'stop');
    const startSpy = vi.spyOn(svc, 'start').mockResolvedValue();

    await svc.configure('/new/mirror', 99);

    expect(stopSpy).toHaveBeenCalled();
    expect(utils.setPref).toHaveBeenCalledWith('mirrorPath', '/new/mirror');
    expect(utils.setPref).toHaveBeenCalledWith('mirrorRootCollection', '99');
    expect(svc._syncState.clear).toHaveBeenCalled();
    expect(svc._initialized).toBe(false);
    expect(startSpy).toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// UT-064: getStats / _isUnderMirrorRoot
// ───────────────────────────────────────────────────────────────────────────

describe('UT-064: getStats and root-check helpers', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it('getStats returns service status snapshot', async () => {
    const svc = await buildService();
    svc._syncState.getStats.mockReturnValue({ collectionCount: 3 });
    const stats = svc.getStats();
    expect(stats).toMatchObject({
      initialized: true,
      enabled: true,
      isSyncing: false,
      mirrorPath: '/mirror',
      rootCollectionID: 1,
    });
    expect(stats.syncState).toEqual({ collectionCount: 3 });
  });

  it('_isUnderMirrorRoot returns false for the root itself, true for descendants', async () => {
    const svc = await buildService();
    const root = makeCollection({ id: 1, name: 'Root', parentID: null });
    const child = makeCollection({ id: 2, name: 'Kid', parentID: 1 });
    const grand = makeCollection({ id: 3, name: 'Grand', parentID: 2 });
    globalThis.Zotero.Collections.get = vi.fn((id) =>
      id === 1 ? root : id === 2 ? child : id === 3 ? grand : null);

    expect(svc._isUnderMirrorRoot(root)).toBe(false);
    expect(svc._isUnderMirrorRoot(child)).toBe(true);
    expect(svc._isUnderMirrorRoot(grand)).toBe(true);
  });

  it('_isUnderMirrorRoot returns false when collection is outside root chain', async () => {
    const svc = await buildService();
    const other = makeCollection({ id: 99, name: 'Other', parentID: null });
    globalThis.Zotero.Collections.get = vi.fn((id) =>
      id === 1 ? makeCollection({ id: 1, name: 'Root' }) :
      id === 99 ? other : null);

    expect(svc._isUnderMirrorRoot(other)).toBe(false);
  });
});
