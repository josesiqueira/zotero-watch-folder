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
  getOrCreateCollectionPath: vi.fn(),
}));

vi.mock('../../content/fileScanner.mjs', () => ({
  scanFolder: vi.fn(),
  scanFolderRecursive: vi.fn(),
}));

vi.mock('../../content/fileImporter.mjs', () => ({
  importFile: vi.fn(),
  handlePostImportAction: vi.fn(),
}));

vi.mock('../../content/trackingStore.mjs', () => ({
  TrackingStore: vi.fn(function () {
    return {
      init: vi.fn(),
      findByItemID: vi.fn(),
      removeByItemID: vi.fn(),
      getAll: vi.fn(() => []),
      save: vi.fn(),
    };
  }),
}));

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

describe('UT-050: WatchFolderService._handleZoteroTrash (3-button dialog)', () => {
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

describe('UT-051: WatchFolderService._handleExternalDeletions (Scenario 1)', () => {
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

describe('UT-052: WatchFolderService._backfillHashesForExistingItems', () => {
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
    const mod = await import('../../content/watchFolder.mjs');
    service = new mod.WatchFolderService();
    service._trackingStore = {
      getAll: vi.fn(() => []),
    };
    globalThis.Zotero.Items.getAsync = vi.fn();
  });

  it('stamps the hash when Extra is empty', async () => {
    const item = makeItem({ extra: '' });
    globalThis.Zotero.Items.getAsync.mockResolvedValue(item);
    service._trackingStore.getAll = vi.fn(() => [
      { itemID: 42, hash: 'abc123', path: '/x.pdf' },
    ]);

    await service._backfillHashesForExistingItems();

    expect(item.setField).toHaveBeenCalledWith('extra', 'watchfolder-hash:abc123');
    expect(item.saveTx).toHaveBeenCalledTimes(1);
  });

  it('appends the hash on a new line when Extra already has content', async () => {
    const item = makeItem({ extra: 'tex.bibkey: smith2024\nDOI: 10.x/y' });
    globalThis.Zotero.Items.getAsync.mockResolvedValue(item);
    service._trackingStore.getAll = vi.fn(() => [
      { itemID: 42, hash: 'def456', path: '/x.pdf' },
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
    globalThis.Zotero.Items.getAsync.mockResolvedValue(item);
    service._trackingStore.getAll = vi.fn(() => [
      { itemID: 42, hash: 'abc123', path: '/x.pdf' },
    ]);

    await service._backfillHashesForExistingItems();

    expect(item.setField).not.toHaveBeenCalled();
    expect(item.saveTx).not.toHaveBeenCalled();
  });

  it('skips records with missing itemID or missing hash', async () => {
    service._trackingStore.getAll = vi.fn(() => [
      { itemID: 0, hash: 'abc' },
      { itemID: 42, hash: '' },
      { itemID: null, hash: null },
    ]);

    await service._backfillHashesForExistingItems();

    expect(globalThis.Zotero.Items.getAsync).not.toHaveBeenCalled();
  });

  it('skips deleted items and items not found in Zotero', async () => {
    const deletedItem = makeItem({ deleted: true });
    globalThis.Zotero.Items.getAsync
      .mockResolvedValueOnce(deletedItem)   // first call: deleted
      .mockResolvedValueOnce(null);          // second call: gone
    service._trackingStore.getAll = vi.fn(() => [
      { itemID: 42, hash: 'abc', path: '/x.pdf' },
      { itemID: 43, hash: 'def', path: '/y.pdf' },
    ]);

    await service._backfillHashesForExistingItems();

    expect(deletedItem.setField).not.toHaveBeenCalled();
    expect(deletedItem.saveTx).not.toHaveBeenCalled();
  });

  it('for an attachment record, stamps the parent item not the attachment', async () => {
    const parent = makeItem({ extra: '' });
    const attachment = makeItem({ isAttachment: true, parentID: 99 });
    globalThis.Zotero.Items.getAsync
      .mockImplementationOnce(async (id) => attachment)   // first call: the attachment
      .mockImplementationOnce(async (id) => parent);       // second call: the parent
    service._trackingStore.getAll = vi.fn(() => [
      { itemID: 42, hash: 'xyz', path: '/p.pdf' },
    ]);

    await service._backfillHashesForExistingItems();

    expect(parent.setField).toHaveBeenCalledWith('extra', 'watchfolder-hash:xyz');
    expect(attachment.setField).not.toHaveBeenCalled();
  });

  it('is a no-op when tracking store is empty', async () => {
    service._trackingStore.getAll = vi.fn(() => []);

    await service._backfillHashesForExistingItems();

    expect(globalThis.Zotero.Items.getAsync).not.toHaveBeenCalled();
  });

  it('continues processing other records when one record errors', async () => {
    const ok = makeItem({ extra: '' });
    globalThis.Zotero.Items.getAsync
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(ok);
    service._trackingStore.getAll = vi.fn(() => [
      { itemID: 1, hash: 'a', path: '/a.pdf' },
      { itemID: 2, hash: 'b', path: '/b.pdf' },
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

describe('UT-053: WatchFolderService move detection (drag-into-subfolder)', () => {
  let service;
  let getPrefMock;
  let getFileHashMock;
  let getOrCreateCollectionPathMock;
  let movedItem;

  beforeEach(async () => {
    vi.resetAllMocks();

    const utils = await import('../../content/utils.mjs');
    getPrefMock = utils.getPref;
    getFileHashMock = utils.getFileHash;
    getOrCreateCollectionPathMock = utils.getOrCreateCollectionPath;

    const mod = await import('../../content/watchFolder.mjs');
    service = new mod.WatchFolderService();
    service._windows.add({ document: {} });

    // Default prefs for these tests
    getPrefMock.mockImplementation((k) => {
      if (k === 'diskDeleteSync') return 'auto';
      if (k === 'importMode') return 'stored';
      if (k === 'sourcePath') return '/watch';
      if (k === 'targetCollection') return 'Inbox';
      return undefined;
    });

    // The Zotero item that's about to be moved between collections
    movedItem = {
      deleted: false,
      getCollections: vi.fn(() => [5]),  // currently in collection 5
      removeFromCollection: vi.fn(),
      addToCollection: vi.fn(),
      saveTx: vi.fn(async () => {}),
      getDisplayTitle: vi.fn(() => 'Paper title'),
      getField: vi.fn(() => ''),
    };
    globalThis.Zotero.Items.getAsync = vi.fn(async () => movedItem);

    // Default: every collection lookup returns a fresh "collection" object
    let nextColID = 100;
    getOrCreateCollectionPathMock.mockImplementation(async () => ({ id: nextColID++ }));

    // Zotero.Collections — used by _findCollectionByPath
    globalThis.Zotero.Collections = {
      ...globalThis.Zotero.Collections,
      getByLibrary: vi.fn(() => [
        { id: 5, name: 'Inbox', parentID: null },
      ]),
      getByParent: vi.fn(() => []),
    };

    service._trackingStore = {
      getAll: vi.fn(() => []),
      remove: vi.fn(),
      removeByItemID: vi.fn(),
      add: vi.fn(),
      save: vi.fn(async () => {}),
      hasPath: vi.fn(() => false),
    };

    globalThis.IOUtils.exists = vi.fn(async () => false);
  });

  it('matching hash on a candidate path triggers a move, NOT a deletion', async () => {
    service._trackingStore.getAll = vi.fn(() => [
      { itemID: 42, path: '/watch/paper.pdf', hash: 'abc123', expectedOnDisk: true },
    ]);
    getFileHashMock.mockImplementation(async (p) => p === '/watch/sub/paper.pdf' ? 'abc123' : null);

    await service._handleExternalDeletions(
      new Set(['/watch/sub/paper.pdf']),
      [{ path: '/watch/sub/paper.pdf' }]
    );

    // The item was NOT moved to the bin
    expect(movedItem.deleted).toBe(false);
    // The popup was NOT shown
    expect(globalThis.Services.prompt.alert).not.toHaveBeenCalled();
    // Tracking was updated (remove + add)
    expect(service._trackingStore.remove).toHaveBeenCalled();
    expect(service._trackingStore.add).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/watch/sub/paper.pdf', itemID: 42 })
    );
  });

  it('moves Zotero item from old auto-collection to new auto-collection', async () => {
    service._trackingStore.getAll = vi.fn(() => [
      { itemID: 42, path: '/watch/paper.pdf', hash: 'abc', expectedOnDisk: true },
    ]);
    getFileHashMock.mockImplementation(async (p) => p === '/watch/sub/paper.pdf' ? 'abc' : null);

    await service._handleExternalDeletions(
      new Set(['/watch/sub/paper.pdf']),
      [{ path: '/watch/sub/paper.pdf' }]
    );

    // Should have looked up the new collection path "Inbox/sub"
    expect(getOrCreateCollectionPathMock).toHaveBeenCalledWith('Inbox/sub');
    // Item should have left the old auto-collection (Inbox = id 5)
    expect(movedItem.removeFromCollection).toHaveBeenCalledWith(5);
    // and joined the new one (whatever getOrCreate returned)
    expect(movedItem.addToCollection).toHaveBeenCalled();
    expect(movedItem.saveTx).toHaveBeenCalled();
  });

  it('move within the same collection (just rename) skips the collection swap', async () => {
    service._trackingStore.getAll = vi.fn(() => [
      { itemID: 42, path: '/watch/old.pdf', hash: 'abc', expectedOnDisk: true },
    ]);
    getFileHashMock.mockImplementation(async (p) => p === '/watch/new-name.pdf' ? 'abc' : null);

    await service._handleExternalDeletions(
      new Set(['/watch/new-name.pdf']),
      [{ path: '/watch/new-name.pdf' }]
    );

    // Both paths map to "Inbox" — no collection re-assignment needed
    expect(getOrCreateCollectionPathMock).not.toHaveBeenCalled();
    expect(movedItem.removeFromCollection).not.toHaveBeenCalled();
    expect(movedItem.addToCollection).not.toHaveBeenCalled();
    // Tracking still updated
    expect(service._trackingStore.add).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/watch/new-name.pdf' })
    );
  });

  it('no hash-matching file means a real deletion (falls through to bin)', async () => {
    service._trackingStore.getAll = vi.fn(() => [
      { itemID: 42, path: '/watch/paper.pdf', hash: 'abc', expectedOnDisk: true },
    ]);
    // The other file on disk has a different hash
    getFileHashMock.mockImplementation(async () => 'differentHash');

    await service._handleExternalDeletions(
      new Set(['/watch/unrelated.pdf']),
      [{ path: '/watch/unrelated.pdf' }]
    );

    // Should have gone to bin
    expect(movedItem.deleted).toBe(true);
    expect(movedItem.saveTx).toHaveBeenCalled();
    // Popup shown
    expect(globalThis.Services.prompt.alert).toHaveBeenCalled();
    // _trackingStore.add should NOT have been called for a move
    expect(service._trackingStore.add).not.toHaveBeenCalled();
  });

  it('two missing records + two matching candidates: each claims one', async () => {
    service._trackingStore.getAll = vi.fn(() => [
      { itemID: 1, path: '/watch/a.pdf', hash: 'AAA', expectedOnDisk: true },
      { itemID: 2, path: '/watch/b.pdf', hash: 'BBB', expectedOnDisk: true },
    ]);
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
      expect.objectContaining({ path: '/watch/x/a.pdf', itemID: 1 })
    );
    expect(service._trackingStore.add).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/watch/y/b.pdf', itemID: 2 })
    );
    // Neither item went to the bin
    expect(globalThis.Services.prompt.alert).not.toHaveBeenCalled();
  });

  it('missing record without a hash falls through to deletion (cannot detect move)', async () => {
    service._trackingStore.getAll = vi.fn(() => [
      { itemID: 42, path: '/watch/paper.pdf', hash: '', expectedOnDisk: true },
    ]);

    await service._handleExternalDeletions(
      new Set(['/watch/sub/paper.pdf']),
      [{ path: '/watch/sub/paper.pdf' }]
    );

    expect(movedItem.deleted).toBe(true);
  });

  it('called without allFiles parameter behaves like the old deletion-only path', async () => {
    service._trackingStore.getAll = vi.fn(() => [
      { itemID: 42, path: '/watch/paper.pdf', hash: 'abc', expectedOnDisk: true },
    ]);

    await service._handleExternalDeletions(new Set());

    expect(movedItem.deleted).toBe(true);
    expect(globalThis.Services.prompt.alert).toHaveBeenCalled();
  });
});
