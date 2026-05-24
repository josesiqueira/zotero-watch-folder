/**
 * Unit tests for content/watchFolder.mjs
 * Covers:
 *   UT-050: WatchFolderService._handleZoteroTrash — Zotero → disk deletion sync
 *   UT-051: WatchFolderService._handleExternalDeletions — disk → Zotero deletion sync
 *   UT-052: WatchFolderService._backfillHashesForExistingItems — library-side hash backfill
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../content/utils.mjs', () => ({
  getPref: vi.fn(),
  setPref: vi.fn(),
  delay: vi.fn(),
  getFileHash: vi.fn(),
  // v2 utils — used by watchFolder for sync-root-relative path computation.
  relativePath: vi.fn((abs, root) => {
    if (typeof abs !== 'string' || typeof root !== 'string') return null;
    const a = abs.replace(/\\/g, '/');
    let r = root.replace(/\\/g, '/');
    if (r.endsWith('/')) r = r.slice(0, -1);
    if (a === r) return '';
    const prefix = r + '/';
    if (!a.startsWith(prefix)) return null;
    return a.slice(prefix.length);
  }),
  HASH_CHUNK_SIZE: 1024 * 1024,
}));

vi.mock('../../content/canonicalPath.mjs', () => ({
  resolveSyncRoot: vi.fn(async () => null),
  relativePathToCollection: vi.fn(async () => null),
  collectionKeyToRelativePath: vi.fn(async () => null),
  SyncRootMissingError: class SyncRootMissingError extends Error {
    constructor(m) { super(m); this.name = 'SyncRootMissingError'; }
  },
}));

vi.mock('../../content/fileMissing.mjs', () => {
  const STATE = {
    MISSING: 'missing', PAUSED: 'paused', PENDING_HYDRATION: 'pending-hydration',
  };
  const MISSING_CLASSIFICATION = Object.freeze({
    STILL_EXISTS: 'still-exists',
    USER_DELETED: 'user-deleted',
    DRIVE_DISCONNECTED: 'drive-disconnected',
    PERMISSION_DENIED: 'permission-denied',
    CLOUD_PLACEHOLDER: 'cloud-placeholder',
  });
  return {
    isWatchRootAvailable: vi.fn(async () => true),
    classifyMissingFile: vi.fn(async () => MISSING_CLASSIFICATION.USER_DELETED),
    MISSING_CLASSIFICATION,
    STATE_FOR_CLASSIFICATION: Object.freeze({
      [MISSING_CLASSIFICATION.STILL_EXISTS]: null,
      [MISSING_CLASSIFICATION.USER_DELETED]: STATE.MISSING,
      [MISSING_CLASSIFICATION.DRIVE_DISCONNECTED]: STATE.PAUSED,
      [MISSING_CLASSIFICATION.PERMISSION_DENIED]: STATE.PAUSED,
      [MISSING_CLASSIFICATION.CLOUD_PLACEHOLDER]: STATE.PENDING_HYDRATION,
    }),
  };
});

vi.mock('../../content/fileScanner.mjs', () => ({
  scanFolder: vi.fn(),
  scanFolderRecursive: vi.fn(),
  SKIP_DIRNAMES: Object.freeze(new Set(['imported', '.zotero-watch-trash'])),
}));

vi.mock('../../content/fileImporter.mjs', () => ({
  importFile: vi.fn(),
  handlePostImportAction: vi.fn(),
}));

vi.mock('../../content/trackingStore.mjs', () => {
  const STATE = Object.freeze({
    CLEAN: 'clean', DIRTY: 'dirty', PENDING: 'pending', MISSING: 'missing',
    PAUSED: 'paused', RECOVERABLE: 'recoverable',
    OUT_OF_SCOPE_SUPPRESSED: 'out-of-scope-suppressed',
    CONFLICT_BLOCKED: 'conflict-blocked', CONFLICT_REFUSED: 'conflict-refused',
    PENDING_ZOTERO_FILE: 'pending-zotero-file', EXTERNAL_EDIT: 'external-edit',
    PENDING_HYDRATION: 'pending-hydration', MISSING_FILE: 'missing-file',
  });
  return {
    TrackingStore: vi.fn(function () {
      return {
        init: vi.fn(),
        getAllOfType: vi.fn(() => []),
        getByLocalPath: vi.fn(),
        getByAttachmentKey: vi.fn(),
        getCollectionRecord: vi.fn(),
        findByHash: vi.fn(),
        add: vi.fn(),
        update: vi.fn(),
        remove: vi.fn(() => true),
        removeByAttachmentKey: vi.fn(() => true),
        addTombstone: vi.fn(),
        clear: vi.fn(),
        getAll: vi.fn(() => []),
        save: vi.fn(),
      };
    }),
    createFileRecord: (data) => ({ type: 'file', ...data }),
    createCollectionRecord: (data) => ({ type: 'collection', ...data }),
    createTombstoneRecord: (data) => ({ type: 'tombstone', ...data }),
    STATE,
  };
});

vi.mock('../../content/fileRenamer.mjs', () => ({
  renameAttachment: vi.fn(),
}));

vi.mock('../../content/smartRules.mjs', () => ({
  processItemWithRules: vi.fn(),
}));

vi.mock('../../content/duplicateDetector.mjs', () => ({
  checkForDuplicate: vi.fn(),
  getDuplicateDetector: vi.fn(),
}));

// ─────────────────────────────────────────────────────────────────────────────
// UT-050: _handleZoteroTrash — Zotero item trashed → optionally delete disk file
// ─────────────────────────────────────────────────────────────────────────────

// UT-050 + UT-051 below cover the v1 trash-propagation paths. In v2 Mode 1
// those paths are gated to be no-ops (`watchFolder.mjs` returns early when
// `getPref('mode') === 'mode1'`), so the v1 test bodies — which exercise the
// 3-button dialog, OS-trash invocation, and Zotero-side bin moves — no longer
// apply. v2.1's Phase B4 work will rewrite the gated bodies to use the v2
// tracking-store schema + the safe-delete predicate; we'll rewrite these
// tests against that target then. For now the gate itself is verified by
// `WatchFolderService — Mode 1 deletion gates` below.

describe('WatchFolderService — Mode 1 deletion gates', () => {
  let service;
  let getPrefMock;

  beforeEach(async () => {
    vi.resetAllMocks();
    const utils = await import('../../content/utils.mjs');
    getPrefMock = utils.getPref;
    getPrefMock.mockImplementation((k) => k === 'mode' ? 'mode1' : undefined);

    const mod = await import('../../content/watchFolder.mjs');
    service = new mod.WatchFolderService();
    service._trackingStore = {
      getAllOfType: vi.fn(() => []),
      getByAttachmentKey: vi.fn(),
      removeByAttachmentKey: vi.fn(() => true),
      update: vi.fn(),
      save: vi.fn(),
    };
  });

  it('_handleZoteroTrash early-returns in Mode 1 (no IO, no tracking touches)', async () => {
    globalThis.IOUtils.exists = vi.fn(async () => true);
    globalThis.IOUtils.remove = vi.fn(async () => {});

    await service._handleZoteroTrash([42, 43]);

    expect(globalThis.IOUtils.remove).not.toHaveBeenCalled();
    expect(service._trackingStore.removeByAttachmentKey).not.toHaveBeenCalled();
    expect(service._trackingStore.save).not.toHaveBeenCalled();
  });

  it('handleNotification swallows trash events in Mode 1', async () => {
    const spy = vi.spyOn(service, '_handleZoteroTrash');
    await service.handleNotification('trash', 'item', [42], {});
    expect(spy).not.toHaveBeenCalled();
  });

  it('_handleExternalDeletions marks tracked files state=missing in Mode 1 (no Zotero side effect)', async () => {
    service._trackingStore.getAllOfType = vi.fn((t) => t === 'file' ? [
      { type: 'file', localPath: '/watch/gone.pdf', zoteroAttachmentKey: 'AK1', lastSyncedHash: 'H1', state: 'clean' },
    ] : []);
    globalThis.IOUtils.exists = vi.fn(async () => false);
    globalThis.Zotero.Items.getByLibraryAndKeyAsync = vi.fn();

    await service._handleExternalDeletions(new Set(), []);

    expect(service._trackingStore.update).toHaveBeenCalledWith('/watch/gone.pdf', { state: 'missing' });
    // Mode 1 must NOT trash the Zotero attachment.
    expect(globalThis.Zotero.Items.getByLibraryAndKeyAsync).not.toHaveBeenCalled();
    expect(service._trackingStore.removeByAttachmentKey).not.toHaveBeenCalled();
  });
});

describe.skip('UT-050: WatchFolderService._handleZoteroTrash (3-button dialog) — v1 schema, deferred to v2.1', () => {
  let service;
  let getPrefMock;
  let setPrefMock;
  let nsIFileMock;

  beforeEach(async () => {
    vi.resetAllMocks();

    const utils = await import('../../content/utils.mjs');
    getPrefMock = utils.getPref;
    setPrefMock = utils.setPref;

    const mod = await import('../../content/watchFolder.mjs');
    service = new mod.WatchFolderService();

    service._trackingStore = {
      findByItemID: vi.fn((id) => ({ itemID: id, path: `/watch/${id}.pdf`, expectedOnDisk: true })),
      removeByItemID: vi.fn(() => true),
      save: vi.fn(),
      getAll: vi.fn(() => []),
    };

    service._windows.add({ document: {} });

    globalThis.IOUtils.exists = vi.fn(async () => true);
    globalThis.IOUtils.remove = vi.fn(async () => {});
    globalThis.Services.prompt.confirmEx = vi.fn(() => 0);

    // Reset Components mock with a controllable nsIFile per test
    nsIFileMock = {
      initWithPath: vi.fn(),
      moveToTrash: vi.fn(),
    };
    globalThis.Components.classes['@mozilla.org/file/local;1'].createInstance = vi.fn(() => nsIFileMock);
  });

  it('mode=never: skips disk action and prompt; drops tracking entry', async () => {
    getPrefMock.mockImplementation((k) => k === 'diskDeleteOnTrash' ? 'never' : undefined);

    await service._handleZoteroTrash([42]);

    expect(globalThis.IOUtils.remove).not.toHaveBeenCalled();
    expect(nsIFileMock.moveToTrash).not.toHaveBeenCalled();
    expect(globalThis.Services.prompt.confirmEx).not.toHaveBeenCalled();
    expect(service._trackingStore.removeByItemID).toHaveBeenCalledWith(42);
  });

  it('mode=os_trash: moves file to OS trash silently, no prompt', async () => {
    getPrefMock.mockImplementation((k) => k === 'diskDeleteOnTrash' ? 'os_trash' : undefined);

    await service._handleZoteroTrash([42]);

    expect(nsIFileMock.initWithPath).toHaveBeenCalledWith('/watch/42.pdf');
    expect(nsIFileMock.moveToTrash).toHaveBeenCalled();
    expect(globalThis.IOUtils.remove).not.toHaveBeenCalled();
    expect(globalThis.Services.prompt.confirmEx).not.toHaveBeenCalled();
    expect(service._trackingStore.removeByItemID).toHaveBeenCalledWith(42);
  });

  it('mode=permanent: hard-deletes silently, no prompt', async () => {
    getPrefMock.mockImplementation((k) => k === 'diskDeleteOnTrash' ? 'permanent' : undefined);

    await service._handleZoteroTrash([42]);

    expect(globalThis.IOUtils.remove).toHaveBeenCalledWith('/watch/42.pdf');
    expect(nsIFileMock.moveToTrash).not.toHaveBeenCalled();
    expect(globalThis.Services.prompt.confirmEx).not.toHaveBeenCalled();
  });

  it('mode=ask, user picks "Move to OS trash" (button 0): moves to OS trash', async () => {
    getPrefMock.mockImplementation((k) => k === 'diskDeleteOnTrash' ? 'ask' : undefined);
    globalThis.Services.prompt.confirmEx = vi.fn(() => 0);

    await service._handleZoteroTrash([42]);

    expect(globalThis.Services.prompt.confirmEx).toHaveBeenCalled();
    expect(nsIFileMock.moveToTrash).toHaveBeenCalled();
    expect(globalThis.IOUtils.remove).not.toHaveBeenCalled();
  });

  it('mode=ask, user picks "Keep on disk" (button 1): leaves file', async () => {
    getPrefMock.mockImplementation((k) => k === 'diskDeleteOnTrash' ? 'ask' : undefined);
    globalThis.Services.prompt.confirmEx = vi.fn(() => 1);

    await service._handleZoteroTrash([42]);

    expect(nsIFileMock.moveToTrash).not.toHaveBeenCalled();
    expect(globalThis.IOUtils.remove).not.toHaveBeenCalled();
    expect(service._trackingStore.removeByItemID).toHaveBeenCalledWith(42);
  });

  it('mode=ask, user picks "Delete permanently" (button 2): hard-deletes', async () => {
    getPrefMock.mockImplementation((k) => k === 'diskDeleteOnTrash' ? 'ask' : undefined);
    globalThis.Services.prompt.confirmEx = vi.fn(() => 2);

    await service._handleZoteroTrash([42]);

    expect(globalThis.IOUtils.remove).toHaveBeenCalledWith('/watch/42.pdf');
    expect(nsIFileMock.moveToTrash).not.toHaveBeenCalled();
  });

  it('mode=ask + "Don\'t ask again" + OS trash: persists pref="os_trash"', async () => {
    getPrefMock.mockImplementation((k) => k === 'diskDeleteOnTrash' ? 'ask' : undefined);
    globalThis.Services.prompt.confirmEx = vi.fn((_w, _t, _m, _f, _b0, _b1, _b2, _cl, checkState) => {
      checkState.value = true;
      return 0;
    });

    await service._handleZoteroTrash([42]);

    expect(setPrefMock).toHaveBeenCalledWith('diskDeleteOnTrash', 'os_trash');
  });

  it('mode=ask + "Don\'t ask again" + Permanent: persists pref="permanent"', async () => {
    getPrefMock.mockImplementation((k) => k === 'diskDeleteOnTrash' ? 'ask' : undefined);
    globalThis.Services.prompt.confirmEx = vi.fn((_w, _t, _m, _f, _b0, _b1, _b2, _cl, checkState) => {
      checkState.value = true;
      return 2;
    });

    await service._handleZoteroTrash([42]);

    expect(setPrefMock).toHaveBeenCalledWith('diskDeleteOnTrash', 'permanent');
  });

  it('mode=ask + "Don\'t ask again" + Keep: persists pref="never"', async () => {
    getPrefMock.mockImplementation((k) => k === 'diskDeleteOnTrash' ? 'ask' : undefined);
    globalThis.Services.prompt.confirmEx = vi.fn((_w, _t, _m, _f, _b0, _b1, _b2, _cl, checkState) => {
      checkState.value = true;
      return 1;
    });

    await service._handleZoteroTrash([42]);

    expect(setPrefMock).toHaveBeenCalledWith('diskDeleteOnTrash', 'never');
  });

  it('file already missing on disk: no prompt, no action, drops tracking', async () => {
    getPrefMock.mockImplementation((k) => k === 'diskDeleteOnTrash' ? 'ask' : undefined);
    globalThis.IOUtils.exists = vi.fn(async () => false);

    await service._handleZoteroTrash([42]);

    expect(globalThis.Services.prompt.confirmEx).not.toHaveBeenCalled();
    expect(nsIFileMock.moveToTrash).not.toHaveBeenCalled();
    expect(globalThis.IOUtils.remove).not.toHaveBeenCalled();
    expect(service._trackingStore.removeByItemID).toHaveBeenCalledWith(42);
  });

  it('record with expectedOnDisk=false: skipped (the plugin already removed it)', async () => {
    getPrefMock.mockImplementation((k) => k === 'diskDeleteOnTrash' ? 'os_trash' : undefined);
    service._trackingStore.findByItemID = vi.fn(() => ({ itemID: 42, path: '/watch/42.pdf', expectedOnDisk: false }));

    await service._handleZoteroTrash([42]);

    expect(nsIFileMock.moveToTrash).not.toHaveBeenCalled();
    expect(service._trackingStore.removeByItemID).toHaveBeenCalledWith(42);
  });

  it('multiple items: single batched prompt, each processed', async () => {
    getPrefMock.mockImplementation((k) => k === 'diskDeleteOnTrash' ? 'ask' : undefined);
    globalThis.Services.prompt.confirmEx = vi.fn(() => 0);
    // moveToTrash is on the SAME mock instance because createInstance is mocked once
    // -> the test only verifies call count

    await service._handleZoteroTrash([1, 2, 3]);

    expect(globalThis.Services.prompt.confirmEx).toHaveBeenCalledTimes(1);
    // Three files → three nsIFile.moveToTrash calls (one per file)
    expect(nsIFileMock.moveToTrash).toHaveBeenCalledTimes(3);
    expect(service._trackingStore.removeByItemID).toHaveBeenCalledTimes(3);
  });

  it('OS trash falls back to permanent delete when moveToTrash unavailable', async () => {
    getPrefMock.mockImplementation((k) => k === 'diskDeleteOnTrash' ? 'os_trash' : undefined);
    nsIFileMock.moveToTrash = undefined; // simulate older platform

    await service._handleZoteroTrash([42]);

    expect(globalThis.IOUtils.remove).toHaveBeenCalledWith('/watch/42.pdf');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UT-051: _handleExternalDeletions — disk file gone → Zotero item → bin + popup
// ─────────────────────────────────────────────────────────────────────────────

describe.skip('UT-051: WatchFolderService._handleExternalDeletions trash branch — v1 schema, deferred to v2.1', () => {
  let service;
  let getPrefMock;
  let fakeItem;

  beforeEach(async () => {
    vi.resetAllMocks();

    const utils = await import('../../content/utils.mjs');
    getPrefMock = utils.getPref;

    const mod = await import('../../content/watchFolder.mjs');
    service = new mod.WatchFolderService();
    service._windows.add({ document: {} });

    fakeItem = {
      deleted: false,
      saveTx: vi.fn(async () => {}),
      getDisplayTitle: vi.fn(() => 'Smith 2024 - Test paper'),
      getField: vi.fn(() => ''),
    };
    globalThis.Zotero.Items.getAsync = vi.fn(async () => fakeItem);

    service._trackingStore = {
      findByItemID: vi.fn(),
      removeByItemID: vi.fn(() => true),
      getAll: vi.fn(() => []),
      save: vi.fn(async () => {}),
    };

    globalThis.IOUtils.exists = vi.fn(async () => false);
    globalThis.Services.prompt.alert = vi.fn();
  });

  it('mode=never: no detection, no item changes, no popup', async () => {
    getPrefMock.mockImplementation((k) => k === 'diskDeleteSync' ? 'never' : undefined);
    service._trackingStore.getAll = vi.fn(() => [
      { itemID: 42, path: '/watch/gone.pdf', expectedOnDisk: true },
    ]);

    await service._handleExternalDeletions(new Set());

    expect(globalThis.Zotero.Items.getAsync).not.toHaveBeenCalled();
    expect(globalThis.Services.prompt.alert).not.toHaveBeenCalled();
    expect(service._trackingStore.removeByItemID).not.toHaveBeenCalled();
  });

  it('mode=auto, tracked file missing on disk: item moved to bin, popup shown', async () => {
    getPrefMock.mockImplementation((k) => {
      if (k === 'diskDeleteSync') return 'auto';
      if (k === 'importMode') return 'stored';
      return undefined;
    });
    service._trackingStore.getAll = vi.fn(() => [
      { itemID: 42, path: '/watch/gone.pdf', expectedOnDisk: true },
    ]);

    await service._handleExternalDeletions(new Set());

    expect(fakeItem.deleted).toBe(true);
    expect(fakeItem.saveTx).toHaveBeenCalledTimes(1);
    expect(globalThis.Services.prompt.alert).toHaveBeenCalledTimes(1);
    expect(service._trackingStore.removeByItemID).toHaveBeenCalledWith(42);
  });

  it('tracked file still on disk (in diskPaths): skipped, no action', async () => {
    getPrefMock.mockImplementation((k) => k === 'diskDeleteSync' ? 'auto' : undefined);
    service._trackingStore.getAll = vi.fn(() => [
      { itemID: 42, path: '/watch/here.pdf', expectedOnDisk: true },
    ]);

    await service._handleExternalDeletions(new Set(['/watch/here.pdf']));

    expect(globalThis.Zotero.Items.getAsync).not.toHaveBeenCalled();
    expect(globalThis.Services.prompt.alert).not.toHaveBeenCalled();
  });

  it('record with expectedOnDisk=false: skipped (plugin deleted the file post-import)', async () => {
    getPrefMock.mockImplementation((k) => k === 'diskDeleteSync' ? 'auto' : undefined);
    service._trackingStore.getAll = vi.fn(() => [
      { itemID: 42, path: '/watch/gone.pdf', expectedOnDisk: false },
    ]);

    await service._handleExternalDeletions(new Set());

    expect(globalThis.Zotero.Items.getAsync).not.toHaveBeenCalled();
  });

  it('item missing from Zotero.Items.getAsync: just clears tracking, no popup', async () => {
    getPrefMock.mockImplementation((k) => k === 'diskDeleteSync' ? 'auto' : undefined);
    globalThis.Zotero.Items.getAsync = vi.fn(async () => null);
    service._trackingStore.getAll = vi.fn(() => [
      { itemID: 42, path: '/watch/gone.pdf', expectedOnDisk: true },
    ]);

    await service._handleExternalDeletions(new Set());

    expect(service._trackingStore.removeByItemID).toHaveBeenCalledWith(42);
    expect(globalThis.Services.prompt.alert).not.toHaveBeenCalled();
  });

  it('already-deleted Zotero item: skips saveTx but still appears in popup', async () => {
    getPrefMock.mockImplementation((k) => k === 'diskDeleteSync' ? 'auto' : undefined);
    fakeItem.deleted = true;
    service._trackingStore.getAll = vi.fn(() => [
      { itemID: 42, path: '/watch/gone.pdf', expectedOnDisk: true },
    ]);

    await service._handleExternalDeletions(new Set());

    expect(fakeItem.saveTx).not.toHaveBeenCalled();
    expect(globalThis.Services.prompt.alert).toHaveBeenCalledTimes(1);
  });

  it('multiple deletions: single batched popup with all entries', async () => {
    getPrefMock.mockImplementation((k) => k === 'diskDeleteSync' ? 'auto' : undefined);
    service._trackingStore.getAll = vi.fn(() => [
      { itemID: 1, path: '/watch/a.pdf', expectedOnDisk: true },
      { itemID: 2, path: '/watch/b.pdf', expectedOnDisk: true },
      { itemID: 3, path: '/watch/c.pdf', expectedOnDisk: true },
    ]);

    await service._handleExternalDeletions(new Set());

    expect(globalThis.Services.prompt.alert).toHaveBeenCalledTimes(1);
    expect(service._trackingStore.removeByItemID).toHaveBeenCalledTimes(3);
  });

  it('linked-mode popup uses "broken file links" wording', async () => {
    getPrefMock.mockImplementation((k) => {
      if (k === 'diskDeleteSync') return 'auto';
      if (k === 'importMode') return 'linked';
      return undefined;
    });
    service._trackingStore.getAll = vi.fn(() => [
      { itemID: 42, path: '/watch/gone.pdf', expectedOnDisk: true },
    ]);

    await service._handleExternalDeletions(new Set());

    const message = globalThis.Services.prompt.alert.mock.calls[0][2];
    expect(message).toMatch(/linked attachments/);
    expect(message).toMatch(/broken file links/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UT-052: _backfillHashesForExistingItems — stamp hash into Zotero item Extra
//         so library-wide dedup survives a tracking-store wipe
// ─────────────────────────────────────────────────────────────────────────────

describe('UT-052: WatchFolderService._backfillHashesForExistingItems (v2 schema)', () => {
  let service;

  function makeItem({ extra = '', deleted = false, isAttachment = false, parentID = null } = {}) {
    const item = {
      _extra: extra,
      deleted,
      getField: vi.fn((f) => f === 'extra' ? item._extra : ''),
      setField: vi.fn((f, v) => { if (f === 'extra') item._extra = v; }),
      saveTx: vi.fn(async () => {}),
      isAttachment: vi.fn(() => isAttachment),
      parentID,
    };
    return item;
  }

  beforeEach(async () => {
    vi.resetAllMocks();
    const cp = await import('../../content/canonicalPath.mjs');
    cp.resolveSyncRoot.mockResolvedValue({ collection: { id: 1, key: 'ROOT1' }, libraryID: 1 });

    const mod = await import('../../content/watchFolder.mjs');
    service = new mod.WatchFolderService();
    service._trackingStore = {
      getAllOfType: vi.fn(() => []),
    };
    globalThis.Zotero.Items.getByLibraryAndKeyAsync = vi.fn();
    globalThis.Zotero.Items.getAsync = vi.fn();
  });

  it('stamps the hash when Extra is empty', async () => {
    const item = makeItem({ extra: '' });
    globalThis.Zotero.Items.getByLibraryAndKeyAsync.mockResolvedValue(item);
    service._trackingStore.getAllOfType = vi.fn(() => [
      { type: 'file', zoteroAttachmentKey: 'AK42', lastSyncedHash: 'abc123', localPath: '/x.pdf' },
    ]);

    await service._backfillHashesForExistingItems();

    expect(item.setField).toHaveBeenCalledWith('extra', 'watchfolder-hash:abc123');
    expect(item.saveTx).toHaveBeenCalledTimes(1);
  });

  it('appends the hash on a new line when Extra already has content', async () => {
    const item = makeItem({ extra: 'tex.bibkey: smith2024\nDOI: 10.x/y' });
    globalThis.Zotero.Items.getByLibraryAndKeyAsync.mockResolvedValue(item);
    service._trackingStore.getAllOfType = vi.fn(() => [
      { type: 'file', zoteroAttachmentKey: 'AK42', lastSyncedHash: 'def456', localPath: '/x.pdf' },
    ]);

    await service._backfillHashesForExistingItems();

    expect(item.setField).toHaveBeenCalledWith(
      'extra',
      'tex.bibkey: smith2024\nDOI: 10.x/y\nwatchfolder-hash:def456'
    );
    expect(item.saveTx).toHaveBeenCalledTimes(1);
  });

  it('skips items whose Extra already contains the same hash', async () => {
    const item = makeItem({ extra: 'watchfolder-hash:abc123' });
    globalThis.Zotero.Items.getByLibraryAndKeyAsync.mockResolvedValue(item);
    service._trackingStore.getAllOfType = vi.fn(() => [
      { type: 'file', zoteroAttachmentKey: 'AK42', lastSyncedHash: 'abc123', localPath: '/x.pdf' },
    ]);

    await service._backfillHashesForExistingItems();

    expect(item.setField).not.toHaveBeenCalled();
    expect(item.saveTx).not.toHaveBeenCalled();
  });

  it('skips records with missing attachmentKey or missing hash', async () => {
    service._trackingStore.getAllOfType = vi.fn(() => [
      { type: 'file', zoteroAttachmentKey: '', lastSyncedHash: 'abc' },
      { type: 'file', zoteroAttachmentKey: 'AK42', lastSyncedHash: '' },
      { type: 'file', zoteroAttachmentKey: null, lastSyncedHash: null },
    ]);

    await service._backfillHashesForExistingItems();

    expect(globalThis.Zotero.Items.getByLibraryAndKeyAsync).not.toHaveBeenCalled();
  });

  it('skips deleted items and items not found in Zotero', async () => {
    const deletedItem = makeItem({ deleted: true });
    globalThis.Zotero.Items.getByLibraryAndKeyAsync
      .mockResolvedValueOnce(deletedItem)   // first call: deleted
      .mockResolvedValueOnce(null);          // second call: gone
    service._trackingStore.getAllOfType = vi.fn(() => [
      { type: 'file', zoteroAttachmentKey: 'AK42', lastSyncedHash: 'abc', localPath: '/x.pdf' },
      { type: 'file', zoteroAttachmentKey: 'AK43', lastSyncedHash: 'def', localPath: '/y.pdf' },
    ]);

    await service._backfillHashesForExistingItems();

    expect(deletedItem.setField).not.toHaveBeenCalled();
    expect(deletedItem.saveTx).not.toHaveBeenCalled();
  });

  it('for an attachment record, stamps the parent item not the attachment', async () => {
    const parent = makeItem({ extra: '' });
    const attachment = makeItem({ isAttachment: true, parentID: 99 });
    globalThis.Zotero.Items.getByLibraryAndKeyAsync.mockResolvedValueOnce(attachment);
    globalThis.Zotero.Items.getAsync.mockResolvedValueOnce(parent);
    service._trackingStore.getAllOfType = vi.fn(() => [
      { type: 'file', zoteroAttachmentKey: 'AK42', lastSyncedHash: 'xyz', localPath: '/p.pdf' },
    ]);

    await service._backfillHashesForExistingItems();

    expect(parent.setField).toHaveBeenCalledWith('extra', 'watchfolder-hash:xyz');
    expect(attachment.setField).not.toHaveBeenCalled();
  });

  it('is a no-op when tracking store has no file records', async () => {
    service._trackingStore.getAllOfType = vi.fn(() => []);

    await service._backfillHashesForExistingItems();

    expect(globalThis.Zotero.Items.getAsync).not.toHaveBeenCalled();
  });

  it('continues processing other records when one record errors', async () => {
    const ok = makeItem({ extra: '' });
    globalThis.Zotero.Items.getByLibraryAndKeyAsync
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(ok);
    service._trackingStore.getAllOfType = vi.fn(() => [
      { type: 'file', zoteroAttachmentKey: 'AK1', lastSyncedHash: 'a', localPath: '/a.pdf' },
      { type: 'file', zoteroAttachmentKey: 'AK2', lastSyncedHash: 'b', localPath: '/b.pdf' },
    ]);

    await service._backfillHashesForExistingItems();

    expect(ok.setField).toHaveBeenCalledWith('extra', 'watchfolder-hash:b');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UT-053: _handleExternalDeletions + _handleFileMoves — distinguishes a
// file move within the watch folder from a real deletion, and relocates the
// Zotero item to the new subfolder's collection instead of trashing it.
// ─────────────────────────────────────────────────────────────────────────────

describe('UT-053: WatchFolderService move detection (drag-into-subfolder) — v2 schema, Mode 1', () => {
  let service;
  let getPrefMock;
  let getFileHashMock;
  let relativePathToCollectionMock;
  let movedItem;
  const INBOX = { id: 5, key: 'INBOX', name: 'Inbox', libraryID: 1 };

  beforeEach(async () => {
    vi.resetAllMocks();

    const utils = await import('../../content/utils.mjs');
    getPrefMock = utils.getPref;
    getFileHashMock = utils.getFileHash;

    const cp = await import('../../content/canonicalPath.mjs');
    relativePathToCollectionMock = cp.relativePathToCollection;
    cp.resolveSyncRoot.mockResolvedValue({ collection: INBOX, libraryID: 1 });

    const mod = await import('../../content/watchFolder.mjs');
    service = new mod.WatchFolderService();
    service._windows.add({ document: {} });

    getPrefMock.mockImplementation((k) => {
      if (k === 'diskDeleteSync') return 'auto';
      if (k === 'mode') return 'mode1';  // important: tests live in Mode 1
      if (k === 'sourcePath') return '/watch';
      return undefined;
    });

    // The Zotero item that gets reassigned when its file moves between
    // sync-root subfolders.
    movedItem = {
      deleted: false,
      getCollections: vi.fn(() => [5]),
      removeFromCollection: vi.fn(),
      addToCollection: vi.fn(),
      saveTx: vi.fn(async () => {}),
      getDisplayTitle: vi.fn(() => 'Paper title'),
      getField: vi.fn(() => ''),
    };
    globalThis.Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async () => movedItem);

    // Default: every relativePathToCollection call returns a fresh collection.
    let nextColID = 100;
    relativePathToCollectionMock.mockImplementation(async (relPath, opts) => {
      if (relPath === '') return INBOX;
      return { id: nextColID++, key: `COL${relPath}`, name: relPath.split('/').pop(), libraryID: 1 };
    });

    service._trackingStore = {
      getAllOfType: vi.fn(() => []),
      remove: vi.fn(() => true),
      removeByAttachmentKey: vi.fn(() => true),
      add: vi.fn(),
      update: vi.fn(),
      save: vi.fn(async () => {}),
      hasPath: vi.fn(() => false),
    };

    globalThis.IOUtils.exists = vi.fn(async () => false);
  });

  it('matching hash on a candidate path triggers a move, NOT a deletion', async () => {
    service._trackingStore.getAllOfType = vi.fn((t) => t === 'file' ? [
      { type: 'file', zoteroAttachmentKey: 'AK42', localPath: '/watch/paper.pdf', lastSyncedHash: 'abc123', state: 'clean', canonicalCollectionKey: 'INBOX' },
    ] : []);
    getFileHashMock.mockImplementation(async (p) => p === '/watch/sub/paper.pdf' ? 'abc123' : null);

    await service._handleExternalDeletions(
      new Set(['/watch/sub/paper.pdf']),
      [{ path: '/watch/sub/paper.pdf' }]
    );

    expect(movedItem.deleted).toBe(false);
    expect(globalThis.Services.prompt.alert).not.toHaveBeenCalled();
    expect(service._trackingStore.remove).toHaveBeenCalledWith('/watch/paper.pdf');
    expect(service._trackingStore.add).toHaveBeenCalledWith(
      // Post-#25 migration: localPath is now sync-root-relative.
      expect.objectContaining({ localPath: 'sub/paper.pdf', zoteroAttachmentKey: 'AK42' })
    );
  });

  it('moves Zotero item from old auto-collection to new auto-collection', async () => {
    service._trackingStore.getAllOfType = vi.fn((t) => t === 'file' ? [
      { type: 'file', zoteroAttachmentKey: 'AK42', localPath: '/watch/paper.pdf', lastSyncedHash: 'abc', state: 'clean' },
    ] : []);
    getFileHashMock.mockImplementation(async (p) => p === '/watch/sub/paper.pdf' ? 'abc' : null);

    await service._handleExternalDeletions(
      new Set(['/watch/sub/paper.pdf']),
      [{ path: '/watch/sub/paper.pdf' }]
    );

    // Should have asked canonicalPath to resolve "sub" under the sync root.
    expect(relativePathToCollectionMock).toHaveBeenCalledWith('sub', { createIfMissing: true });
    expect(movedItem.removeFromCollection).toHaveBeenCalledWith(5);
    expect(movedItem.addToCollection).toHaveBeenCalled();
    expect(movedItem.saveTx).toHaveBeenCalled();
  });

  it('move within the same sync-root level (just rename) skips the collection swap', async () => {
    service._trackingStore.getAllOfType = vi.fn((t) => t === 'file' ? [
      { type: 'file', zoteroAttachmentKey: 'AK42', localPath: '/watch/old.pdf', lastSyncedHash: 'abc', state: 'clean' },
    ] : []);
    getFileHashMock.mockImplementation(async (p) => p === '/watch/new-name.pdf' ? 'abc' : null);

    await service._handleExternalDeletions(
      new Set(['/watch/new-name.pdf']),
      [{ path: '/watch/new-name.pdf' }]
    );

    // Both paths sit at the sync-root level — no collection re-assignment.
    expect(movedItem.removeFromCollection).not.toHaveBeenCalled();
    expect(movedItem.addToCollection).not.toHaveBeenCalled();
    expect(service._trackingStore.add).toHaveBeenCalledWith(
      expect.objectContaining({ localPath: 'new-name.pdf' })
    );
  });

  it('no hash-matching file in Mode 1 → record marked state=missing, NOT trashed', async () => {
    service._trackingStore.getAllOfType = vi.fn((t) => t === 'file' ? [
      { type: 'file', zoteroAttachmentKey: 'AK42', localPath: '/watch/paper.pdf', lastSyncedHash: 'abc', state: 'clean' },
    ] : []);
    getFileHashMock.mockImplementation(async () => 'differentHash');

    await service._handleExternalDeletions(
      new Set(['/watch/unrelated.pdf']),
      [{ path: '/watch/unrelated.pdf' }]
    );

    // Mode 1: no Zotero side effect; tracking record state flipped to "missing".
    expect(movedItem.deleted).toBe(false);
    expect(globalThis.Zotero.Items.getByLibraryAndKeyAsync).not.toHaveBeenCalled();
    expect(globalThis.Services.prompt.alert).not.toHaveBeenCalled();
    expect(service._trackingStore.update).toHaveBeenCalledWith('/watch/paper.pdf', { state: 'missing' });
    expect(service._trackingStore.add).not.toHaveBeenCalled();
  });

  it('two missing records + two matching candidates: each claims one', async () => {
    service._trackingStore.getAllOfType = vi.fn((t) => t === 'file' ? [
      { type: 'file', zoteroAttachmentKey: 'AK1', localPath: '/watch/a.pdf', lastSyncedHash: 'AAA', state: 'clean' },
      { type: 'file', zoteroAttachmentKey: 'AK2', localPath: '/watch/b.pdf', lastSyncedHash: 'BBB', state: 'clean' },
    ] : []);
    getFileHashMock.mockImplementation(async (p) => {
      if (p === '/watch/x/a.pdf') return 'AAA';
      if (p === '/watch/y/b.pdf') return 'BBB';
      return null;
    });

    await service._handleExternalDeletions(
      new Set(['/watch/x/a.pdf', '/watch/y/b.pdf']),
      [{ path: '/watch/x/a.pdf' }, { path: '/watch/y/b.pdf' }]
    );

    expect(service._trackingStore.add).toHaveBeenCalledTimes(2);
    expect(service._trackingStore.add).toHaveBeenCalledWith(
      expect.objectContaining({ localPath: 'x/a.pdf', zoteroAttachmentKey: 'AK1' })
    );
    expect(service._trackingStore.add).toHaveBeenCalledWith(
      expect.objectContaining({ localPath: 'y/b.pdf', zoteroAttachmentKey: 'AK2' })
    );
    expect(globalThis.Services.prompt.alert).not.toHaveBeenCalled();
  });

  it('missing record without a hash falls through to deletion path (Mode 1: just marked missing)', async () => {
    service._trackingStore.getAllOfType = vi.fn((t) => t === 'file' ? [
      { type: 'file', zoteroAttachmentKey: 'AK42', localPath: '/watch/paper.pdf', lastSyncedHash: null, state: 'clean' },
    ] : []);

    await service._handleExternalDeletions(
      new Set(['/watch/sub/paper.pdf']),
      [{ path: '/watch/sub/paper.pdf' }]
    );

    // Can't detect a move without a hash → fall through to the deletion
    // branch, which in Mode 1 just flips state=missing.
    expect(movedItem.deleted).toBe(false);
    expect(service._trackingStore.update).toHaveBeenCalledWith('/watch/paper.pdf', { state: 'missing' });
  });

  it('called without allFiles parameter: deletion-only path (Mode 1 marks missing)', async () => {
    service._trackingStore.getAllOfType = vi.fn((t) => t === 'file' ? [
      { type: 'file', zoteroAttachmentKey: 'AK42', localPath: '/watch/paper.pdf', lastSyncedHash: 'abc', state: 'clean' },
    ] : []);

    await service._handleExternalDeletions(new Set());

    expect(movedItem.deleted).toBe(false);
    expect(service._trackingStore.update).toHaveBeenCalledWith('/watch/paper.pdf', { state: 'missing' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UT-054: folder-rename detection (B2). Detects when a user renamed a
// subfolder on disk and renames the matching Zotero subcollection in place
// (same key, new name) rather than leaving an empty Zotero collection behind.
// ─────────────────────────────────────────────────────────────────────────────

describe('UT-054: WatchFolderService folder-rename detection (B2)', () => {
  let service;
  let getPrefMock;
  let getFileHashMock;

  /**
   * In-memory tracking-store stub keyed by localPath (files) and
   * zoteroCollectionKey (collections). Mirrors enough of the real API for
   * the B2 code to operate end-to-end.
   */
  function makeStore(initialFiles = [], initialCollections = []) {
    const files = new Map(initialFiles.map(f => [f.localPath, f]));
    const collections = new Map(initialCollections.map(c => [c.zoteroCollectionKey, c]));
    return {
      _files: files,
      _collections: collections,
      getAllOfType: vi.fn((t) => {
        if (t === 'file') return [...files.values()];
        if (t === 'collection') return [...collections.values()];
        return [];
      }),
      getCollectionRecord: vi.fn((key) => collections.get(key) || null),
      removeCollectionRecord: vi.fn((key) => collections.delete(key)),
      remove: vi.fn((path) => files.delete(path)),
      removeByAttachmentKey: vi.fn(),
      update: vi.fn(),
      add: vi.fn((rec) => {
        if (rec.type === 'file') files.set(rec.localPath, rec);
        else if (rec.type === 'collection') collections.set(rec.zoteroCollectionKey, rec);
      }),
      hasPath: vi.fn((p) => files.has(p)),
      save: vi.fn(async () => {}),
    };
  }

  beforeEach(async () => {
    vi.resetAllMocks();

    const utils = await import('../../content/utils.mjs');
    getPrefMock = utils.getPref;
    getFileHashMock = utils.getFileHash;

    const cp = await import('../../content/canonicalPath.mjs');
    cp.resolveSyncRoot.mockResolvedValue({
      collection: { id: 1, key: 'ROOT1' },
      libraryID: 1,
    });

    getPrefMock.mockImplementation((k) => {
      if (k === 'sourcePath') return '/watch';
      if (k === 'mode') return 'mode1';
      return undefined;
    });

    const mod = await import('../../content/watchFolder.mjs');
    service = new mod.WatchFolderService();
  });

  it('renames a Zotero collection when its on-disk folder name changes and ≥1 child file hash matches', async () => {
    // Tracked: Methods/ collection containing one file paper.pdf
    service._trackingStore = makeStore(
      [{
        type: 'file',
        localPath: '/watch/Methods/paper.pdf',
        canonicalLocalPath: '/watch/Methods/paper.pdf',
        lastSyncedHash: 'H1',
        zoteroAttachmentKey: 'AK1',
        canonicalCollectionKey: 'COL_METHODS',
        collectionMembershipKeys: ['COL_METHODS'],
        state: 'clean',
      }],
      [{
        type: 'collection',
        localPath: '/watch/Methods',
        zoteroCollectionKey: 'COL_METHODS',
        parentCollectionKey: null,
        state: 'clean',
      }],
    );

    // Stub Zotero.Collections.getByLibraryAndKeyAsync to return a collection
    // we can rename.
    const fakeCollection = { id: 100, key: 'COL_METHODS', name: 'Methods', saveTx: vi.fn(async () => {}) };
    globalThis.Zotero.Collections.getByLibraryAndKeyAsync = vi.fn(async () => fakeCollection);

    // Files on disk: Methods/ is gone; Procedures/paper.pdf exists.
    const scannedFiles = [{ path: '/watch/Procedures/paper.pdf' }];
    getFileHashMock.mockImplementation(async (p) =>
      p === '/watch/Procedures/paper.pdf' ? 'H1' : null);

    await service._detectFolderRenames(scannedFiles, '/watch');

    expect(fakeCollection.name).toBe('Procedures');
    expect(fakeCollection.saveTx).toHaveBeenCalledTimes(1);

    // Tracking record was rewritten to the new sync-root-relative path.
    const renamed = service._trackingStore.getCollectionRecord('COL_METHODS');
    expect(renamed).not.toBe(null);
    expect(renamed.localPath).toBe('Procedures');

    // Descendant file record was rewritten too (relative form post-#25).
    expect(service._trackingStore._files.has('/watch/Methods/paper.pdf')).toBe(false);
    const renamedFile = service._trackingStore._files.get('Procedures/paper.pdf');
    expect(renamedFile).toBeTruthy();
    expect(renamedFile.canonicalLocalPath).toBe('Procedures/paper.pdf');
  });

  it('does NOT rename when there are no tracked files under the missing folder (no hash anchor)', async () => {
    service._trackingStore = makeStore(
      [], // no files
      [{
        type: 'collection',
        localPath: '/watch/Methods',
        zoteroCollectionKey: 'COL_METHODS',
        parentCollectionKey: null,
        state: 'clean',
      }],
    );
    const fakeCollection = { id: 100, key: 'COL_METHODS', name: 'Methods', saveTx: vi.fn(async () => {}) };
    globalThis.Zotero.Collections.getByLibraryAndKeyAsync = vi.fn(async () => fakeCollection);

    const scannedFiles = [{ path: '/watch/Procedures/orphan.pdf' }];

    await service._detectFolderRenames(scannedFiles, '/watch');

    expect(fakeCollection.saveTx).not.toHaveBeenCalled();
    const stillThere = service._trackingStore.getCollectionRecord('COL_METHODS');
    expect(stillThere.localPath).toBe('/watch/Methods');
  });

  it('does NOT rename when no on-disk dir has matching file hashes', async () => {
    service._trackingStore = makeStore(
      [{
        type: 'file',
        localPath: '/watch/Methods/paper.pdf',
        lastSyncedHash: 'H1',
        zoteroAttachmentKey: 'AK1',
        state: 'clean',
      }],
      [{
        type: 'collection',
        localPath: '/watch/Methods',
        zoteroCollectionKey: 'COL_METHODS',
        parentCollectionKey: null,
        state: 'clean',
      }],
    );
    const fakeCollection = { id: 100, key: 'COL_METHODS', name: 'Methods', saveTx: vi.fn(async () => {}) };
    globalThis.Zotero.Collections.getByLibraryAndKeyAsync = vi.fn(async () => fakeCollection);

    // On-disk file with a completely different hash.
    const scannedFiles = [{ path: '/watch/Procedures/different.pdf' }];
    getFileHashMock.mockImplementation(async () => 'H_DIFFERENT');

    await service._detectFolderRenames(scannedFiles, '/watch');

    expect(fakeCollection.saveTx).not.toHaveBeenCalled();
  });

  it('no-op when the folder still exists on disk', async () => {
    service._trackingStore = makeStore(
      [{
        type: 'file',
        localPath: '/watch/Methods/paper.pdf',
        lastSyncedHash: 'H1',
        zoteroAttachmentKey: 'AK1',
        state: 'clean',
      }],
      [{
        type: 'collection',
        localPath: '/watch/Methods',
        zoteroCollectionKey: 'COL_METHODS',
        parentCollectionKey: null,
        state: 'clean',
      }],
    );
    const fakeCollection = { id: 100, key: 'COL_METHODS', name: 'Methods', saveTx: vi.fn(async () => {}) };
    globalThis.Zotero.Collections.getByLibraryAndKeyAsync = vi.fn(async () => fakeCollection);

    // Folder still there on disk.
    const scannedFiles = [{ path: '/watch/Methods/paper.pdf' }];

    await service._detectFolderRenames(scannedFiles, '/watch');

    expect(fakeCollection.saveTx).not.toHaveBeenCalled();
  });

  it('renaming a parent folder recursively updates all descendant records', async () => {
    service._trackingStore = makeStore(
      [
        {
          type: 'file',
          localPath: '/watch/Methods/AI/paper.pdf',
          canonicalLocalPath: '/watch/Methods/AI/paper.pdf',
          lastSyncedHash: 'H_AI',
          zoteroAttachmentKey: 'AK_AI',
          state: 'clean',
        },
      ],
      [
        {
          type: 'collection',
          localPath: '/watch/Methods',
          zoteroCollectionKey: 'COL_METHODS',
          parentCollectionKey: null,
          state: 'clean',
        },
        {
          type: 'collection',
          localPath: '/watch/Methods/AI',
          zoteroCollectionKey: 'COL_AI',
          parentCollectionKey: 'COL_METHODS',
          state: 'clean',
        },
      ],
    );
    const methodsCollection = { id: 100, key: 'COL_METHODS', name: 'Methods', saveTx: vi.fn(async () => {}) };
    const aiCollection = { id: 101, key: 'COL_AI', name: 'AI', saveTx: vi.fn(async () => {}) };
    globalThis.Zotero.Collections.getByLibraryAndKeyAsync = vi.fn(async (libID, key) =>
      key === 'COL_METHODS' ? methodsCollection : (key === 'COL_AI' ? aiCollection : null));

    // User renamed Methods/ → Procedures/. AI/ child is automatically at
    // Procedures/AI on disk.
    const scannedFiles = [{ path: '/watch/Procedures/AI/paper.pdf' }];
    getFileHashMock.mockImplementation(async (p) =>
      p === '/watch/Procedures/AI/paper.pdf' ? 'H_AI' : null);

    await service._detectFolderRenames(scannedFiles, '/watch');

    // Methods collection renamed to Procedures, AI collection NOT renamed
    // (its name didn't change — only its containing path did).
    expect(methodsCollection.name).toBe('Procedures');
    expect(aiCollection.name).toBe('AI');

    // Tracking records (sync-root-relative post-#25): shallowest (Methods)
    // processed first, sweeps descendants. AI's localPath rewritten by
    // the parent's recursive sweep.
    const methodsRec = service._trackingStore.getCollectionRecord('COL_METHODS');
    expect(methodsRec.localPath).toBe('Procedures');
    const aiRec = service._trackingStore.getCollectionRecord('COL_AI');
    expect(aiRec.localPath).toBe('Procedures/AI');

    const aiFile = service._trackingStore._files.get('Procedures/AI/paper.pdf');
    expect(aiFile).toBeTruthy();
    expect(aiFile.canonicalLocalPath).toBe('Procedures/AI/paper.pdf');
    expect(service._trackingStore._files.has('/watch/Methods/AI/paper.pdf')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UT-055: empty-folder pickup (B.4 / EF.1) — disk subfolders without files
// still get a corresponding Zotero subcollection so the local-↔-Zotero
// folder mapping holds for users who pre-create empty folders.
// ─────────────────────────────────────────────────────────────────────────────

describe('UT-055: WatchFolderService empty-folder pickup (B.4)', () => {
  let service;
  let relativePathToCollectionMock;

  function makeStore(initialFiles = [], initialCollections = []) {
    const files = new Map(initialFiles.map(f => [f.localPath, f]));
    const collections = new Map(initialCollections.map(c => [c.zoteroCollectionKey, c]));
    return {
      _files: files,
      _collections: collections,
      getAllOfType: vi.fn((t) => {
        if (t === 'file') return [...files.values()];
        if (t === 'collection') return [...collections.values()];
        return [];
      }),
      getCollectionRecord: vi.fn((key) => collections.get(key) || null),
      removeCollectionRecord: vi.fn((key) => collections.delete(key)),
      remove: vi.fn((path) => files.delete(path)),
      removeByAttachmentKey: vi.fn(),
      update: vi.fn(),
      add: vi.fn((rec) => {
        if (rec.type === 'file') files.set(rec.localPath, rec);
        else if (rec.type === 'collection') collections.set(rec.zoteroCollectionKey, rec);
      }),
      hasPath: vi.fn((p) => files.has(p)),
      save: vi.fn(async () => {}),
    };
  }

  beforeEach(async () => {
    vi.resetAllMocks();
    const cp = await import('../../content/canonicalPath.mjs');
    relativePathToCollectionMock = cp.relativePathToCollection;
    const mod = await import('../../content/watchFolder.mjs');
    service = new mod.WatchFolderService();
    service._trackingStore = makeStore();

    // Default IOUtils stubs — overridden per test where needed.
    globalThis.IOUtils.getChildren = vi.fn(async () => []);
    globalThis.IOUtils.stat = vi.fn(async () => ({ type: 'regular' }));
  });

  it('creates a Zotero subcollection for an existing empty disk folder', async () => {
    // Disk: /watch contains an empty `Methods/` dir.
    globalThis.IOUtils.getChildren = vi.fn(async (p) => {
      if (p === '/watch') return ['/watch/Methods'];
      return [];
    });
    globalThis.IOUtils.stat = vi.fn(async (p) =>
      p === '/watch/Methods' ? { type: 'directory' } : { type: 'regular' });

    const methodsCollection = { id: 100, key: 'COL_METHODS', name: 'Methods', parentID: 1 };
    relativePathToCollectionMock.mockResolvedValue(methodsCollection);
    globalThis.Zotero.Collections.get = vi.fn(() => null); // no parent walk needed past leaf

    await service._ensureCollectionsForExistingFolders('/watch');

    expect(relativePathToCollectionMock).toHaveBeenCalledWith('Methods', { createIfMissing: true });
    const record = service._trackingStore.getCollectionRecord('COL_METHODS');
    expect(record).not.toBe(null);
    // Post-#25: localPath is sync-root-relative.
    expect(record.localPath).toBe('Methods');
  });

  it('does NOT re-create a Zotero subcollection that already has a tracking record', async () => {
    service._trackingStore = makeStore([], [{
      type: 'collection',
      localPath: '/watch/Methods',
      zoteroCollectionKey: 'COL_METHODS',
      parentCollectionKey: null,
      state: 'clean',
    }]);
    globalThis.IOUtils.getChildren = vi.fn(async (p) => {
      if (p === '/watch') return ['/watch/Methods'];
      return [];
    });
    globalThis.IOUtils.stat = vi.fn(async () => ({ type: 'directory' }));

    await service._ensureCollectionsForExistingFolders('/watch');

    expect(relativePathToCollectionMock).not.toHaveBeenCalled();
  });

  it('skips SKIP_DIRNAMES (imported/, .zotero-watch-trash/)', async () => {
    globalThis.IOUtils.getChildren = vi.fn(async (p) => {
      if (p === '/watch') return ['/watch/imported', '/watch/.zotero-watch-trash'];
      return [];
    });
    globalThis.IOUtils.stat = vi.fn(async () => ({ type: 'directory' }));

    await service._ensureCollectionsForExistingFolders('/watch');

    expect(relativePathToCollectionMock).not.toHaveBeenCalled();
  });

  it('walks recursively and creates collections at depth', async () => {
    globalThis.IOUtils.getChildren = vi.fn(async (p) => {
      if (p === '/watch') return ['/watch/Methods'];
      if (p === '/watch/Methods') return ['/watch/Methods/AI'];
      return [];
    });
    globalThis.IOUtils.stat = vi.fn(async () => ({ type: 'directory' }));

    relativePathToCollectionMock.mockImplementation(async (relPath) => ({
      id: 100 + relPath.length,
      key: `COL_${relPath.replace(/\//g, '_')}`,
      name: relPath.split('/').pop(),
      parentID: 1,
    }));
    globalThis.Zotero.Collections.get = vi.fn(() => null);

    await service._ensureCollectionsForExistingFolders('/watch');

    expect(relativePathToCollectionMock).toHaveBeenCalledWith('Methods', { createIfMissing: true });
    expect(relativePathToCollectionMock).toHaveBeenCalledWith('Methods/AI', { createIfMissing: true });
  });

  it('bails silently when sync root is missing', async () => {
    globalThis.IOUtils.getChildren = vi.fn(async (p) => {
      if (p === '/watch') return ['/watch/Methods'];
      return [];
    });
    globalThis.IOUtils.stat = vi.fn(async () => ({ type: 'directory' }));

    const cp = await import('../../content/canonicalPath.mjs');
    relativePathToCollectionMock.mockRejectedValue(new cp.SyncRootMissingError('gone'));

    await expect(service._ensureCollectionsForExistingFolders('/watch')).resolves.toBeUndefined();
  });
});
