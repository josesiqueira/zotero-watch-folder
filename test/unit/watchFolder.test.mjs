/**
 * Unit tests for content/watchFolder.mjs (v2.2).
 *
 * Mode-1 gates + v2 schema coverage. The v1-schema UT-050 / UT-051
 * placeholder describe.skip blocks were deleted in the v2.2 cleanup;
 * UT-090..UT-095 cover the trash + restore matrix end-to-end.
 *
 * Covers:
 *   UT-052: _backfillHashesForExistingItems — library-side hash backfill
 *   UT-053: move detection (drag-into-subfolder)
 *   UT-054: folder-rename detection (B2)
 *   UT-055: empty-folder pickup (B.4)
 *   UT-090: cascading-trash protection (shadow guard + canonical-only delete)
 *   UT-092: restore matrix RST.1 / RST.6
 *   UT-093: restore matrix RST.2 / RST.4 (parent-restore expansion)
 *   UT-094: bulk-delete guard for _handleZoteroTrash + _handleExternalDeletions
 *   UT-095: RST.5 re-attach under living parent
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
// Mode-1 deletion gates (the trash-propagation paths' no-op behavior)
// ─────────────────────────────────────────────────────────────────────────────
//
// The v2 trash-propagation paths (`_handleZoteroTrash`, `_handleExternalDeletions`)
// are exercised in detail by UT-090..UT-092 (cascading-trash guard,
// `_handleZoteroTrash` v2 rewrite, restore matrix) below. This describe block
// just verifies the Mode-1 gate: those paths return early when
// `getPref('mode') === 'mode1'`, so neither IO nor tracking mutations happen.
//
// The v1-schema UT-050 / UT-051 placeholder describe.skip blocks were
// deleted in the v2.2 cleanup once UT-090..UT-092 + UT-419..UT-420 took
// over coverage. Git history has the old bodies if anyone needs them.

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
      flush: vi.fn(async () => {}),
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
      flush: vi.fn(async () => {}),
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
// UT-FRE: FOLDER-RENAME-EMPTY — renaming an EMPTY folder on disk should rename
// the existing Zotero collection (conservative 1:1 structural match), NOT
// create a new collection. The hash matcher can't help (no files → no anchor),
// so an empty orphan is treated as renamed ONLY on an unambiguous 1:1 match
// (exactly one empty orphan + exactly one new untracked empty dir under the
// SAME parent). Any ambiguity falls through to the existing create-new path.
// ─────────────────────────────────────────────────────────────────────────────

describe('UT-FRE: WatchFolderService empty-folder rename detection', () => {
  let service;
  let getPrefMock;
  let getFileHashMock;

  // Same in-memory tracking-store stub as UT-054.
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
      flush: vi.fn(async () => {}),
    };
  }

  function emptyCollection(localPath, key, parentKey = null) {
    return { type: 'collection', localPath, zoteroCollectionKey: key, parentCollectionKey: parentKey, state: 'clean' };
  }

  beforeEach(async () => {
    vi.resetAllMocks();

    // Clear the real module-level hash cache — we mock getFileHash below.
    const hc = await import('../../content/_hashCache.mjs');
    hc.clear();

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

  it('(a) renames in place on an unambiguous 1:1 match (one empty orphan + one new empty dir)', async () => {
    service._trackingStore = makeStore([], [emptyCollection('/watch/Methods', 'COL_METHODS')]);
    const fakeCollection = { id: 100, key: 'COL_METHODS', name: 'Methods', saveTx: vi.fn(async () => {}) };
    globalThis.Zotero.Collections.getByLibraryAndKeyAsync = vi.fn(async () => fakeCollection);

    // On disk: Methods/ is gone; one new empty dir Procedures/ exists. No
    // files anywhere, so _listSubdirectories supplies the dir set.
    vi.spyOn(service, '_listSubdirectories').mockResolvedValue(['/watch/Procedures']);

    await service._detectFolderRenames([], '/watch');

    // The existing collection was renamed (NOT a new collection created).
    expect(fakeCollection.name).toBe('Procedures');
    expect(fakeCollection.saveTx).toHaveBeenCalledTimes(1);
    const renamed = service._trackingStore.getCollectionRecord('COL_METHODS');
    expect(renamed).toBeTruthy();
    expect(renamed.localPath).toBe('Procedures');
  });

  it('(b) falls through (no rename) when there are TWO new empty dirs (ambiguous target)', async () => {
    service._trackingStore = makeStore([], [emptyCollection('/watch/Methods', 'COL_METHODS')]);
    const fakeCollection = { id: 100, key: 'COL_METHODS', name: 'Methods', saveTx: vi.fn(async () => {}) };
    globalThis.Zotero.Collections.getByLibraryAndKeyAsync = vi.fn(async () => fakeCollection);

    vi.spyOn(service, '_listSubdirectories').mockResolvedValue(['/watch/Procedures', '/watch/Protocols']);

    await service._detectFolderRenames([], '/watch');

    expect(fakeCollection.saveTx).not.toHaveBeenCalled();
    const stillThere = service._trackingStore.getCollectionRecord('COL_METHODS');
    expect(stillThere.localPath).toBe('/watch/Methods'); // unchanged
  });

  it('(c) falls through (no rename) when TWO orphaned empty collections vanish (ambiguous source)', async () => {
    service._trackingStore = makeStore([], [
      emptyCollection('/watch/Methods', 'COL_METHODS'),
      emptyCollection('/watch/Results', 'COL_RESULTS'),
    ]);
    const colByKey = {
      COL_METHODS: { id: 100, key: 'COL_METHODS', name: 'Methods', saveTx: vi.fn(async () => {}) },
      COL_RESULTS: { id: 101, key: 'COL_RESULTS', name: 'Results', saveTx: vi.fn(async () => {}) },
    };
    globalThis.Zotero.Collections.getByLibraryAndKeyAsync = vi.fn(async (lib, key) => colByKey[key] || null);

    // Both gone; only one new empty dir on disk — ambiguous (which orphan?).
    vi.spyOn(service, '_listSubdirectories').mockResolvedValue(['/watch/Procedures']);

    await service._detectFolderRenames([], '/watch');

    expect(colByKey.COL_METHODS.saveTx).not.toHaveBeenCalled();
    expect(colByKey.COL_RESULTS.saveTx).not.toHaveBeenCalled();
    expect(service._trackingStore.getCollectionRecord('COL_METHODS').localPath).toBe('/watch/Methods');
    expect(service._trackingStore.getCollectionRecord('COL_RESULTS').localPath).toBe('/watch/Results');
  });

  it('(d) candidate new dir that HOLDS files is not an empty-match target (uses hash path instead)', async () => {
    // The tracked Methods/ has a file; the new Procedures/ also has a file.
    // This is the NON-empty path: the hash matcher should drive the rename,
    // not the empty matcher. (Regression-flavored: confirms a dir with files
    // is excluded from newEmptyDirsByParent.)
    service._trackingStore = makeStore(
      [{
        type: 'file',
        localPath: '/watch/Methods/paper.pdf',
        canonicalLocalPath: '/watch/Methods/paper.pdf',
        lastSyncedHash: 'H1',
        zoteroAttachmentKey: 'AK1',
        state: 'clean',
      }],
      [emptyCollection('/watch/Methods', 'COL_METHODS')],
    );
    const fakeCollection = { id: 100, key: 'COL_METHODS', name: 'Methods', saveTx: vi.fn(async () => {}) };
    globalThis.Zotero.Collections.getByLibraryAndKeyAsync = vi.fn(async () => fakeCollection);

    const scannedFiles = [{ path: '/watch/Procedures/paper.pdf' }];
    getFileHashMock.mockImplementation(async (p) =>
      p === '/watch/Procedures/paper.pdf' ? 'H1' : null);

    await service._detectFolderRenames(scannedFiles, '/watch');

    // Renamed via the hash matcher (not the empty matcher), exactly once.
    expect(fakeCollection.name).toBe('Procedures');
    expect(fakeCollection.saveTx).toHaveBeenCalledTimes(1);
    expect(service._trackingStore.getCollectionRecord('COL_METHODS').localPath).toBe('Procedures');
  });

  it('(e) regression: non-empty hash-based rename still works unchanged', async () => {
    service._trackingStore = makeStore(
      [{
        type: 'file',
        localPath: '/watch/Methods/paper.pdf',
        canonicalLocalPath: '/watch/Methods/paper.pdf',
        lastSyncedHash: 'H1',
        zoteroAttachmentKey: 'AK1',
        state: 'clean',
      }],
      [emptyCollection('/watch/Methods', 'COL_METHODS')],
    );
    const fakeCollection = { id: 100, key: 'COL_METHODS', name: 'Methods', saveTx: vi.fn(async () => {}) };
    globalThis.Zotero.Collections.getByLibraryAndKeyAsync = vi.fn(async () => fakeCollection);

    const scannedFiles = [{ path: '/watch/Procedures/paper.pdf' }];
    getFileHashMock.mockImplementation(async (p) =>
      p === '/watch/Procedures/paper.pdf' ? 'H1' : null);

    await service._detectFolderRenames(scannedFiles, '/watch');

    expect(fakeCollection.name).toBe('Procedures');
    const renamedFile = service._trackingStore._files.get('Procedures/paper.pdf');
    expect(renamedFile).toBeTruthy();
    expect(renamedFile.canonicalLocalPath).toBe('Procedures/paper.pdf');
    expect(service._trackingStore._files.has('/watch/Methods/paper.pdf')).toBe(false);
  });

  it('(f) a DEAD suppressed orphan must NOT poison the 1:1 count (ultracode FOLDER-RENAME root cause)', async () => {
    // One ACTIVE empty orphan (Methods, clean) + one DEAD empty orphan
    // (DeadOld, out-of-scope-suppressed — lingers in the store forever) both
    // missing from disk; one new empty dir (Procedures). Before the fix, the
    // dead orphan made emptyMissingByParent['/watch'].length === 2 → the 1:1
    // guard silently no-op'd → Methods fell through to the deletion pass and
    // got trashed-and-recreated. The dead orphan must be excluded so the
    // legitimate rename still fires.
    service._trackingStore = makeStore([], [
      emptyCollection('/watch/Methods', 'COL_METHODS'),
      { type: 'collection', localPath: '/watch/DeadOld', zoteroCollectionKey: 'COL_DEAD',
        parentCollectionKey: null, state: 'out-of-scope-suppressed' },
    ]);
    const colByKey = {
      COL_METHODS: { id: 100, key: 'COL_METHODS', name: 'Methods', saveTx: vi.fn(async () => {}) },
      COL_DEAD: { id: 102, key: 'COL_DEAD', name: 'DeadOld', saveTx: vi.fn(async () => {}) },
    };
    globalThis.Zotero.Collections.getByLibraryAndKeyAsync = vi.fn(async (lib, key) => colByKey[key] || null);
    vi.spyOn(service, '_listSubdirectories').mockResolvedValue(['/watch/Procedures']);

    await service._detectFolderRenames([], '/watch');

    // The ACTIVE orphan was renamed in place (key preserved); the dead one was untouched.
    expect(colByKey.COL_METHODS.name).toBe('Procedures');
    expect(colByKey.COL_METHODS.saveTx).toHaveBeenCalledTimes(1);
    expect(service._trackingStore.getCollectionRecord('COL_METHODS').localPath).toBe('Procedures');
    expect(colByKey.COL_DEAD.saveTx).not.toHaveBeenCalled();
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
      flush: vi.fn(async () => {}),
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

// ─────────────────────────────────────────────────────────────────────────────
// UT-090: cascading-trash protection (v2 schema).
// Dedup-skip can produce SHADOW records (localPath !== canonicalLocalPath)
// pointing at the same zoteroAttachmentKey as the canonical record. Both
// the disk-side trash path (_handleExternalDeletions Mode 3 branch) and
// the Zotero-side trash path (_handleZoteroTrash v2 rewrite) must avoid
// cascading a single user-deletion into deleting the canonical sibling.
// ─────────────────────────────────────────────────────────────────────────────

describe('UT-090: cascading-trash protection — _handleExternalDeletions', () => {
  let service;
  let store;
  let watchFolderMod;

  beforeEach(async () => {
    vi.resetAllMocks();
    // The module-level hash cache is a real singleton; clear it so a hash
    // computed in one case can't leak into the freshness gate of the next.
    const hashCache = await import('../../content/_hashCache.mjs');
    hashCache.clear();
    const utils = await import('../../content/utils.mjs');
    utils.getPref.mockImplementation((k) => {
      if (k === 'mode') return 'mode3';
      if (k === 'sourcePath') return '/watch';
      if (k === 'diskDeleteSync') return 'auto';
      return undefined;
    });
    utils.getFileHash.mockResolvedValue(null);

    watchFolderMod = await import('../../content/watchFolder.mjs');
    service = new watchFolderMod.WatchFolderService();

    // Build a hand-rolled store so we can assert .remove vs
    // .removeByAttachmentKey precisely.
    const records = [];
    store = {
      _records: records,
      getAllOfType: vi.fn((t) => t === 'file' ? records.slice() : []),
      getAllByAttachmentKey: vi.fn((k) => records.filter(r => r.zoteroAttachmentKey === k)),
      getByAttachmentKey: vi.fn((k) => records.find(r => r.zoteroAttachmentKey === k) ?? null),
      remove: vi.fn((path) => {
        const idx = records.findIndex(r => r.localPath === path);
        if (idx === -1) return false;
        records.splice(idx, 1);
        return true;
      }),
      removeByAttachmentKey: vi.fn((key) => {
        for (let i = records.length - 1; i >= 0; i--) {
          if (records[i].zoteroAttachmentKey === key) records.splice(i, 1);
        }
        return true;
      }),
      update: vi.fn(),
      save: vi.fn(async () => {}),
      flush: vi.fn(async () => {}),
    };
    service._trackingStore = store;

    globalThis.IOUtils.exists = vi.fn(async () => true);
    globalThis.Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async () => ({
      key: 'ATT001', deleted: false, saveTx: vi.fn(async () => {}),
      getDisplayTitle: () => 'doc', getField: () => 'doc',
      // Zotero-stored attachment path used by the freshness gate
      // (canSafelyTrashZoteroAttachment). Default: present + hash-matching.
      getFilePathAsync: async () => '/zotero/storage/ATT001.pdf',
    }));
    globalThis.Zotero.Libraries = { userLibraryID: 1 };
    service._showExternalDeletionPopup = vi.fn();
  });

  it('drops shadow tracking ONLY when its canonical sibling still exists on disk (Mode 3)', async () => {
    // Canonical: A.pdf (present on disk). Shadow: A2.pdf (missing).
    store._records.push(
      { type: 'file', localPath: 'A.pdf', canonicalLocalPath: 'A.pdf', zoteroAttachmentKey: 'ATT001', state: 'clean', lastSyncedHash: 'H1' },
      { type: 'file', localPath: 'A2.pdf', canonicalLocalPath: 'A.pdf', zoteroAttachmentKey: 'ATT001', state: 'clean', lastSyncedHash: 'H1' },
    );
    // Disk shows A.pdf only. A2.pdf is missing.
    globalThis.IOUtils.exists = vi.fn(async (p) => p === '/watch/A.pdf');
    // Pretend the scanner saw A.pdf only.
    const diskPaths = new Set(['/watch/A.pdf']);

    await service._handleExternalDeletions(diskPaths, []);

    // Shadow tracking was dropped via .remove(localPath), NOT via
    // .removeByAttachmentKey (which would have collapsed both).
    expect(store.remove).toHaveBeenCalledWith('A2.pdf');
    expect(store.removeByAttachmentKey).not.toHaveBeenCalled();
    // Zotero attachment must NOT have been trashed.
    expect(globalThis.Zotero.Items.getByLibraryAndKeyAsync).not.toHaveBeenCalled();
  });

  it('falls through to normal trash propagation when BOTH canonical and shadow are missing (Mode 3)', async () => {
    store._records.push(
      { type: 'file', localPath: 'A.pdf', canonicalLocalPath: 'A.pdf', zoteroAttachmentKey: 'ATT001', state: 'clean', lastSyncedHash: 'H1' },
      { type: 'file', localPath: 'A2.pdf', canonicalLocalPath: 'A.pdf', zoteroAttachmentKey: 'ATT001', state: 'clean', lastSyncedHash: 'H1' },
    );
    // Both local copies are gone, but the Zotero-stored file is present and
    // UNCHANGED (hash matches lastSyncedHash), so the freshness gate passes
    // and propagation proceeds.
    const utils = await import('../../content/utils.mjs');
    utils.getFileHash.mockResolvedValue('H1');
    globalThis.IOUtils.exists = vi.fn(async (p) => p === '/zotero/storage/ATT001.pdf');
    const diskPaths = new Set();

    await service._handleExternalDeletions(diskPaths, []);

    // At least one trash propagation. removeByAttachmentKey was used to
    // collapse all records for the attachment, which is correct when
    // every copy is gone.
    expect(globalThis.Zotero.Items.getByLibraryAndKeyAsync).toHaveBeenCalled();
    expect(store.removeByAttachmentKey).toHaveBeenCalledWith('ATT001');
  });

  it('does NOT drop the canonical record when only it is missing (shadow on disk)', async () => {
    // Canonical missing, shadow still on disk. The cascading guard only
    // protects shadows whose canonical still exists — it does not protect
    // a canonical whose shadow exists. Trash the attachment normally.
    store._records.push(
      { type: 'file', localPath: 'A.pdf', canonicalLocalPath: 'A.pdf', zoteroAttachmentKey: 'ATT001', state: 'clean', lastSyncedHash: 'H1' },
      { type: 'file', localPath: 'A2.pdf', canonicalLocalPath: 'A.pdf', zoteroAttachmentKey: 'ATT001', state: 'clean', lastSyncedHash: 'H1' },
    );
    globalThis.IOUtils.exists = vi.fn(async (p) => p === '/watch/A2.pdf');
    const diskPaths = new Set(['/watch/A2.pdf']);

    await service._handleExternalDeletions(diskPaths, []);

    expect(globalThis.Zotero.Items.getByLibraryAndKeyAsync).toHaveBeenCalled();
  });

  it('Mode 3 BLOCKS trashing the Zotero attachment when its stored copy changed (freshness gate, spec risk #2)', async () => {
    store._records.push(
      { type: 'file', localPath: 'A.pdf', canonicalLocalPath: 'A.pdf', zoteroAttachmentKey: 'ATT001', state: 'clean', lastSyncedHash: 'H1' },
    );
    // Local file gone; the Zotero-stored copy is present but CHANGED (≠ H1).
    const utils = await import('../../content/utils.mjs');
    utils.getFileHash.mockResolvedValue('DRIFTED');
    globalThis.IOUtils.exists = vi.fn(async (p) => p === '/zotero/storage/ATT001.pdf');

    await service._handleExternalDeletions(new Set(), []);

    // Attachment NOT trashed; record kept and flipped to conflict-blocked.
    expect(store.removeByAttachmentKey).not.toHaveBeenCalled();
    expect(store.update).toHaveBeenCalledWith('A.pdf', { state: 'conflict-blocked' });
  });
});

describe('UT-090: cascading-trash protection — _handleZoteroTrash v2 rewrite', () => {
  let service;
  let store;
  let watchFolderMod;
  let utils;
  let warningSinkMod;

  beforeEach(async () => {
    vi.resetAllMocks();
    utils = await import('../../content/utils.mjs');
    utils.getPref.mockImplementation((k) => {
      if (k === 'mode') return 'mode3';
      if (k === 'sourcePath') return '/watch';
      if (k === 'diskDeleteOnTrash') return 'permanent';
      return undefined;
    });
    // The conflict gate (canSafelyMove) reads the module-level hash cache;
    // clear it so a hash from another case can't leak in.
    const hc090 = await import('../../content/_hashCache.mjs');
    hc090.clear();

    watchFolderMod = await import('../../content/watchFolder.mjs');
    warningSinkMod = await import('../../content/warningSink.mjs');
    service = new watchFolderMod.WatchFolderService();

    const records = [];
    store = {
      _records: records,
      getAllOfType: vi.fn((t) => t === 'file' ? records.slice() : []),
      getAllByAttachmentKey: vi.fn((k) => records.filter(r => r.zoteroAttachmentKey === k)),
      remove: vi.fn((path) => {
        const idx = records.findIndex(r => r.localPath === path);
        if (idx === -1) return false;
        records.splice(idx, 1);
        return true;
      }),
      removeByAttachmentKey: vi.fn(),
      update: vi.fn((path, updates) => {
        const r = records.find(x => x.localPath === path);
        if (r) Object.assign(r, updates);
        return !!r;
      }),
      save: vi.fn(async () => {}),
      flush: vi.fn(async () => {}),
    };
    service._trackingStore = store;
    service._moveToOSTrash = vi.fn(async () => {});
    service._pickWindow = vi.fn(() => null); // no UI → 'never' fallback inside _promptDiskDelete

    globalThis.IOUtils.exists = vi.fn(async () => true);
    globalThis.IOUtils.remove = vi.fn(async () => {});
    globalThis.Zotero.Items.get = vi.fn((id) => ({
      id, key: id === 42 ? 'ATT001' : `K${id}`, isAttachment: () => true,
    }));
  });

  it('Mode 3 disk-deletes ONLY the canonical path; drops shadows from tracking without disk action', async () => {
    // DATA-1 fail-closed: the canonical-delete path now requires the conflict
    // gate to PROVE the file is unchanged, so the record carries a
    // lastSyncedHash and getFileHash returns the matching value.
    utils.getFileHash.mockResolvedValue('H1');
    store._records.push(
      { type: 'file', localPath: 'A.pdf', canonicalLocalPath: 'A.pdf', zoteroAttachmentKey: 'ATT001', state: 'clean', lastSyncedHash: 'H1' },
      { type: 'file', localPath: 'A2.pdf', canonicalLocalPath: 'A.pdf', zoteroAttachmentKey: 'ATT001', state: 'clean', lastSyncedHash: 'H1' },
    );

    await service._handleZoteroTrash([42]);

    // IOUtils.remove called exactly once, for canonical only.
    expect(globalThis.IOUtils.remove).toHaveBeenCalledTimes(1);
    expect(globalThis.IOUtils.remove).toHaveBeenCalledWith('/watch/A.pdf');
    // Canonical bytes were permanently deleted → its record is dropped.
    expect(store.remove).toHaveBeenCalledWith('A.pdf');
    // The shadow file is NEVER disk-deleted (cascading guard). It still
    // exists on disk, so its record is SUPPRESSED (not dropped) to prevent a
    // re-import loop (spec risk #3).
    expect(store.update).toHaveBeenCalledWith('A2.pdf', { state: 'out-of-scope-suppressed' });
    expect(store.remove).not.toHaveBeenCalledWith('A2.pdf');
  });

  it('Mode 3 with diskDeleteOnTrash=never drops tracking but never touches disk', async () => {
    utils.getPref.mockImplementation((k) => {
      if (k === 'mode') return 'mode3';
      if (k === 'sourcePath') return '/watch';
      if (k === 'diskDeleteOnTrash') return 'never';
      return undefined;
    });
    // DATA-1 fail-closed: the canonical file passes the conflict gate (clean),
    // so action='never' keeps it on disk and SUPPRESSES (not CONFLICT_BLOCKS).
    utils.getFileHash.mockResolvedValue('H1');
    store._records.push(
      { type: 'file', localPath: 'A.pdf', canonicalLocalPath: 'A.pdf', zoteroAttachmentKey: 'ATT001', state: 'clean', lastSyncedHash: 'H1' },
      { type: 'file', localPath: 'A2.pdf', canonicalLocalPath: 'A.pdf', zoteroAttachmentKey: 'ATT001', state: 'clean', lastSyncedHash: 'H1' },
    );

    await service._handleZoteroTrash([42]);

    expect(globalThis.IOUtils.remove).not.toHaveBeenCalled();
    expect(service._moveToOSTrash).not.toHaveBeenCalled();
    // diskDeleteOnTrash='never' leaves both files on disk → both records are
    // SUPPRESSED, not dropped, so the next scan can't re-import them.
    expect(store.update).toHaveBeenCalledWith('A.pdf', { state: 'out-of-scope-suppressed' });
    expect(store.update).toHaveBeenCalledWith('A2.pdf', { state: 'out-of-scope-suppressed' });
    expect(store.remove).not.toHaveBeenCalled();
  });

  it('Mode 2 (warn-only) suppresses tracking + reports warning, never touches disk', async () => {
    utils.getPref.mockImplementation((k) => {
      if (k === 'mode') return 'mode2';
      if (k === 'sourcePath') return '/watch';
      return undefined;
    });
    const reportSpy = vi.spyOn(warningSinkMod, 'report');
    store._records.push(
      { type: 'file', localPath: 'A.pdf', canonicalLocalPath: 'A.pdf', zoteroAttachmentKey: 'ATT001', state: 'clean' },
      { type: 'file', localPath: 'A2.pdf', canonicalLocalPath: 'A.pdf', zoteroAttachmentKey: 'ATT001', state: 'clean' },
    );

    await service._handleZoteroTrash([42]);

    expect(globalThis.IOUtils.remove).not.toHaveBeenCalled();
    expect(service._moveToOSTrash).not.toHaveBeenCalled();
    // Mode 2 keeps the local files; both records are SUPPRESSED (not dropped)
    // so the next scan can't re-create the Zotero item the user just trashed.
    expect(store.update).toHaveBeenCalledWith('A.pdf', { state: 'out-of-scope-suppressed' });
    expect(store.update).toHaveBeenCalledWith('A2.pdf', { state: 'out-of-scope-suppressed' });
    expect(store.remove).not.toHaveBeenCalled();
    expect(reportSpy).toHaveBeenCalledTimes(1);
    expect(reportSpy.mock.calls[0][0]).toMatchObject({
      actionType: 'zotero-trash',
      attachmentKey: 'ATT001',
      reason: 'mode2-warn-only',
    });
  });

  it('Mode 3 does NOT trash a locally-edited canonical file (conflict gate, spec risk #1a)', async () => {
    const hc = await import('../../content/_hashCache.mjs');
    hc.clear();
    const utils = await import('../../content/utils.mjs');
    utils.getFileHash.mockResolvedValue('DRIFTED'); // current on-disk hash ≠ baseline
    store._records.push(
      { type: 'file', localPath: 'A.pdf', canonicalLocalPath: 'A.pdf', zoteroAttachmentKey: 'ATT001', state: 'clean', lastSyncedHash: 'H1' },
    );

    await service._handleZoteroTrash([42]);

    // The edited local file is NOT trashed; its record is kept and flipped to
    // conflict-blocked for the user to resolve.
    expect(globalThis.IOUtils.remove).not.toHaveBeenCalled();
    expect(store.update).toHaveBeenCalledWith('A.pdf', { state: 'conflict-blocked' });
    expect(store.remove).not.toHaveBeenCalledWith('A.pdf');
  });

  // ── DATA-1: the conflict gate is FAIL-CLOSED (delete only on gate.ok). ──
  // A record we cannot PROVE is unchanged is never disk-deleted; it is kept
  // and flipped to CONFLICT_BLOCKED with the real gate reason surfaced.

  it('DATA-1: BLOCKS a canonical with NO baseline hash (fail-closed, was fail-open)', async () => {
    // No lastSyncedHash → canSafelyMove returns invalid-record. Pre-DATA-1
    // this fell through to a disk delete; now it must be blocked.
    const hc = await import('../../content/_hashCache.mjs');
    hc.clear();
    utils.getFileHash.mockResolvedValue('whatever'); // irrelevant — no baseline
    const reportSpy = vi.spyOn(warningSinkMod, 'report');
    store._records.push(
      { type: 'file', localPath: 'A.pdf', canonicalLocalPath: 'A.pdf', zoteroAttachmentKey: 'ATT001', state: 'clean' },
    );

    await service._handleZoteroTrash([42]);

    expect(globalThis.IOUtils.remove).not.toHaveBeenCalled();
    expect(store.update).toHaveBeenCalledWith('A.pdf', { state: 'conflict-blocked' });
    expect(store.remove).not.toHaveBeenCalledWith('A.pdf');
    expect(reportSpy).toHaveBeenCalledWith(expect.objectContaining({
      actionType: 'zotero-trash',
      attachmentKey: 'ATT001',
      reason: 'invalid-record',
    }));
  });

  it('DATA-1: BLOCKS when the hash cannot be computed (hash-failed, fail-closed)', async () => {
    const hc = await import('../../content/_hashCache.mjs');
    hc.clear();
    utils.getFileHash.mockResolvedValue(null); // hash unavailable
    const reportSpy = vi.spyOn(warningSinkMod, 'report');
    store._records.push(
      { type: 'file', localPath: 'A.pdf', canonicalLocalPath: 'A.pdf', zoteroAttachmentKey: 'ATT001', state: 'clean', lastSyncedHash: 'H1' },
    );

    await service._handleZoteroTrash([42]);

    expect(globalThis.IOUtils.remove).not.toHaveBeenCalled();
    expect(store.update).toHaveBeenCalledWith('A.pdf', { state: 'conflict-blocked' });
    expect(reportSpy).toHaveBeenCalledWith(expect.objectContaining({
      actionType: 'zotero-trash',
      reason: 'hash-failed',
    }));
  });

  it('DATA-1: green path — proven-unchanged canonical is permanently deleted', async () => {
    const hc = await import('../../content/_hashCache.mjs');
    hc.clear();
    utils.getFileHash.mockResolvedValue('H1'); // matches baseline
    store._records.push(
      { type: 'file', localPath: 'A.pdf', canonicalLocalPath: 'A.pdf', zoteroAttachmentKey: 'ATT001', state: 'clean', lastSyncedHash: 'H1' },
    );

    await service._handleZoteroTrash([42]);

    expect(globalThis.IOUtils.remove).toHaveBeenCalledTimes(1);
    expect(globalThis.IOUtils.remove).toHaveBeenCalledWith('/watch/A.pdf');
    expect(store.remove).toHaveBeenCalledWith('A.pdf');
    expect(store.update).not.toHaveBeenCalledWith('A.pdf', { state: 'conflict-blocked' });
  });

  it('skips non-attachment items WITHOUT child attachments', async () => {
    // A plain non-attachment item with no children is silently dropped.
    globalThis.Zotero.Items.get = vi.fn((id) => ({
      id, key: `K${id}`, isAttachment: () => false,
      getAttachments: () => [],
    }));
    store._records.push(
      { type: 'file', localPath: 'A.pdf', canonicalLocalPath: 'A.pdf', zoteroAttachmentKey: 'ATT001', state: 'clean' },
    );

    await service._handleZoteroTrash([42]);

    expect(globalThis.IOUtils.remove).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
  });

  it('expands PARENT items to their child attachments (RST.2 / parent-trash bug)', async () => {
    // When Zotero trashes a parent item, the notifier fires only once
    // (for the parent ID); the child attachments inherit the deleted
    // state but never get their own trash event. The handler must
    // walk parent.getAttachments(true) and include each attachment
    // key, otherwise parent-level trashes silently leak past Mode 3.
    // DATA-1 fail-closed: both canonical files must pass the conflict gate.
    utils.getFileHash.mockResolvedValue('H1');
    store._records.push(
      { type: 'file', localPath: 'A.pdf', canonicalLocalPath: 'A.pdf', zoteroAttachmentKey: 'ATTA', state: 'clean', lastSyncedHash: 'H1' },
      { type: 'file', localPath: 'B.pdf', canonicalLocalPath: 'B.pdf', zoteroAttachmentKey: 'ATTB', state: 'clean', lastSyncedHash: 'H1' },
    );

    const attA = { id: 501, key: 'ATTA', isAttachment: () => true };
    const attB = { id: 502, key: 'ATTB', isAttachment: () => true };
    const parent = {
      id: 500, key: 'PARENT1', isAttachment: () => false,
      getAttachments: () => [501, 502],
    };
    globalThis.Zotero.Items.get = vi.fn((id) => {
      if (id === 500) return parent;
      if (id === 501) return attA;
      if (id === 502) return attB;
      return null;
    });

    await service._handleZoteroTrash([500]); // parent ID only

    expect(globalThis.IOUtils.remove).toHaveBeenCalledTimes(2);
    expect(globalThis.IOUtils.remove).toHaveBeenCalledWith('/watch/A.pdf');
    expect(globalThis.IOUtils.remove).toHaveBeenCalledWith('/watch/B.pdf');
    expect(store.remove).toHaveBeenCalledWith('A.pdf');
    expect(store.remove).toHaveBeenCalledWith('B.pdf');
  });

  it('parent expansion includes already-trashed child attachments (getAttachments(true))', async () => {
    // Selective restore (RST.4) and partial trashes mean some children
    // may already be `deleted=true` before the parent trash. They must
    // still be picked up so disk + tracking are kept consistent.
    // DATA-1 fail-closed: the canonical file must pass the conflict gate.
    utils.getFileHash.mockResolvedValue('H1');
    store._records.push(
      { type: 'file', localPath: 'A.pdf', canonicalLocalPath: 'A.pdf', zoteroAttachmentKey: 'ATTA', state: 'clean', lastSyncedHash: 'H1' },
    );

    const attA = { id: 501, key: 'ATTA', isAttachment: () => true };
    const parent = {
      id: 500, key: 'PARENT1', isAttachment: () => false,
      // Spy: ensure called with `true` (include trashed)
      getAttachments: vi.fn(() => [501]),
    };
    globalThis.Zotero.Items.get = vi.fn((id) => id === 500 ? parent : attA);

    await service._handleZoteroTrash([500]);

    expect(parent.getAttachments).toHaveBeenCalledWith(true);
    expect(store.remove).toHaveBeenCalledWith('A.pdf');
  });

  it('handles missing canonical file gracefully (drops tracking, no remove call)', async () => {
    store._records.push(
      { type: 'file', localPath: 'A.pdf', canonicalLocalPath: 'A.pdf', zoteroAttachmentKey: 'ATT001', state: 'clean' },
      { type: 'file', localPath: 'A2.pdf', canonicalLocalPath: 'A.pdf', zoteroAttachmentKey: 'ATT001', state: 'clean' },
    );
    globalThis.IOUtils.exists = vi.fn(async () => false); // canonical missing too

    await service._handleZoteroTrash([42]);

    expect(globalThis.IOUtils.remove).not.toHaveBeenCalled();
    expect(store.remove).toHaveBeenCalledWith('A.pdf');
    expect(store.remove).toHaveBeenCalledWith('A2.pdf');
  });

  it('Mode 1 still early-returns (no-op)', async () => {
    utils.getPref.mockImplementation((k) => k === 'mode' ? 'mode1' : undefined);
    store._records.push(
      { type: 'file', localPath: 'A.pdf', canonicalLocalPath: 'A.pdf', zoteroAttachmentKey: 'ATT001', state: 'clean' },
    );

    await service._handleZoteroTrash([42]);

    expect(globalThis.IOUtils.remove).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UT-091: plugin trash (.zotero-watch-trash/) — v2.2 safe-delete recoverability
// ─────────────────────────────────────────────────────────────────────────────

describe('UT-091: _moveToPluginTrash', () => {
  let service;
  let utils;

  beforeEach(async () => {
    vi.resetAllMocks();
    utils = await import('../../content/utils.mjs');
    utils.getPref.mockImplementation((k) => k === 'sourcePath' ? '/watch' : undefined);
    const watchFolderMod = await import('../../content/watchFolder.mjs');
    service = new watchFolderMod.WatchFolderService();
    globalThis.IOUtils.exists = vi.fn(async () => false);
    globalThis.IOUtils.makeDirectory = vi.fn(async () => {});
    globalThis.IOUtils.move = vi.fn(async () => {});
    globalThis.IOUtils.copy = vi.fn(async () => {});
    globalThis.IOUtils.remove = vi.fn(async () => {});
  });

  it('moves file into .zotero-watch-trash/ preserving the sync-root-relative path', async () => {
    const trashPath = await service._moveToPluginTrash('/watch/Methods/paper.pdf');

    expect(trashPath).toBe('.zotero-watch-trash/Methods/paper.pdf');
    expect(globalThis.IOUtils.makeDirectory).toHaveBeenCalledWith(
      '/watch/.zotero-watch-trash/Methods',
      { ignoreExisting: true, createAncestors: true }
    );
    expect(globalThis.IOUtils.move).toHaveBeenCalledWith(
      '/watch/Methods/paper.pdf',
      '/watch/.zotero-watch-trash/Methods/paper.pdf'
    );
  });

  it('suffixes filename with millisecond timestamp on collision (RST.6 — never overwrite)', async () => {
    // Pretend the target already exists.
    globalThis.IOUtils.exists = vi.fn(async (p) => p === '/watch/.zotero-watch-trash/paper.pdf');
    const before = Date.now();

    const trashPath = await service._moveToPluginTrash('/watch/paper.pdf');

    expect(trashPath).toMatch(/^\.zotero-watch-trash\/paper\.\d+\.pdf$/);
    const stamp = parseInt(trashPath.match(/paper\.(\d+)\.pdf$/)[1], 10);
    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(globalThis.IOUtils.move).toHaveBeenCalledTimes(1);
  });

  it('returns null and bails when watch root is not set', async () => {
    utils.getPref.mockImplementation(() => undefined);
    const trashPath = await service._moveToPluginTrash('/anywhere/paper.pdf');
    expect(trashPath).toBeNull();
    expect(globalThis.IOUtils.move).not.toHaveBeenCalled();
  });

  it('returns null when the source path is outside the watch root', async () => {
    const trashPath = await service._moveToPluginTrash('/some-other-dir/paper.pdf');
    expect(trashPath).toBeNull();
    expect(globalThis.IOUtils.move).not.toHaveBeenCalled();
  });

  it('falls back to copy+remove when IOUtils.move throws (cross-FS)', async () => {
    globalThis.IOUtils.move = vi.fn(async () => { throw new Error('EXDEV'); });

    const trashPath = await service._moveToPluginTrash('/watch/paper.pdf');

    expect(trashPath).toBe('.zotero-watch-trash/paper.pdf');
    expect(globalThis.IOUtils.copy).toHaveBeenCalledWith(
      '/watch/paper.pdf',
      '/watch/.zotero-watch-trash/paper.pdf'
    );
    expect(globalThis.IOUtils.remove).toHaveBeenCalledWith('/watch/paper.pdf');
  });

  it('returns null and cleans partial destination when both move and copy fail', async () => {
    globalThis.IOUtils.move = vi.fn(async () => { throw new Error('EXDEV'); });
    globalThis.IOUtils.copy = vi.fn(async () => { throw new Error('ENOSPC'); });

    const trashPath = await service._moveToPluginTrash('/watch/paper.pdf');

    expect(trashPath).toBeNull();
    expect(globalThis.IOUtils.remove).toHaveBeenCalledWith(
      '/watch/.zotero-watch-trash/paper.pdf',
      { ignoreAbsent: true }
    );
  });
});

describe('UT-091: _handleZoteroTrash plugin_trash action + tombstone', () => {
  let service;
  let store;
  let tombstones;
  let utils;

  beforeEach(async () => {
    vi.resetAllMocks();
    utils = await import('../../content/utils.mjs');
    utils.getPref.mockImplementation((k) => {
      if (k === 'mode') return 'mode3';
      if (k === 'sourcePath') return '/watch';
      if (k === 'diskDeleteOnTrash') return 'plugin_trash';
      return undefined;
    });
    // Clear the module-level hash cache so the conflict gate doesn't read a
    // stale hash computed by another describe.
    const hc091 = await import('../../content/_hashCache.mjs');
    hc091.clear();
    // DATA-1 fail-closed: every canonical-delete in this block must pass the
    // conflict gate, so the on-disk hash matches the record's lastSyncedHash.
    utils.getFileHash.mockResolvedValue('H1');

    const watchFolderMod = await import('../../content/watchFolder.mjs');
    service = new watchFolderMod.WatchFolderService();

    const records = [];
    tombstones = [];
    store = {
      _records: records,
      getAllOfType: vi.fn((t) => t === 'file' ? records.slice() : []),
      getAllByAttachmentKey: vi.fn((k) => records.filter(r => r.zoteroAttachmentKey === k)),
      add: vi.fn((r) => { if (r.type === 'tombstone') tombstones.push(r); }),
      remove: vi.fn((path) => {
        const idx = records.findIndex(r => r.localPath === path);
        if (idx === -1) return false;
        records.splice(idx, 1);
        return true;
      }),
      removeByAttachmentKey: vi.fn(),
      update: vi.fn((path, updates) => {
        const r = records.find(x => x.localPath === path);
        if (r) Object.assign(r, updates);
        return !!r;
      }),
      save: vi.fn(async () => {}),
      flush: vi.fn(async () => {}),
    };
    service._trackingStore = store;
    service._moveToOSTrash = vi.fn(async () => {});
    service._moveToPluginTrash = vi.fn(async () => '.zotero-watch-trash/A.pdf');

    globalThis.IOUtils.exists = vi.fn(async () => true);
    globalThis.IOUtils.remove = vi.fn(async () => {});
    globalThis.Zotero.Items.get = vi.fn((id) => ({
      id, key: 'ATT001', isAttachment: () => true,
    }));
  });

  it('routes plugin_trash → _moveToPluginTrash and emits a tombstone with trashPath', async () => {
    store._records.push(
      { type: 'file', localPath: 'A.pdf', canonicalLocalPath: 'A.pdf', zoteroAttachmentKey: 'ATT001', zoteroItemKey: 'PARENT1', state: 'clean', lastSyncedHash: 'H1' },
    );

    await service._handleZoteroTrash([42]);

    expect(service._moveToPluginTrash).toHaveBeenCalledWith('/watch/A.pdf');
    expect(globalThis.IOUtils.remove).not.toHaveBeenCalled();
    expect(service._moveToOSTrash).not.toHaveBeenCalled();
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]).toMatchObject({
      type: 'tombstone',
      objectType: 'file',
      localPath: 'A.pdf',
      zoteroAttachmentKey: 'ATT001',
      zoteroItemKey: 'PARENT1',
      deletedFrom: 'zotero',
      trashPath: '.zotero-watch-trash/A.pdf',
      originalHash: 'H1',
    });
    expect(store.remove).toHaveBeenCalledWith('A.pdf');
  });

  it('falls back to OS trash when plugin_trash returns null', async () => {
    service._moveToPluginTrash = vi.fn(async () => null);
    store._records.push(
      { type: 'file', localPath: 'A.pdf', canonicalLocalPath: 'A.pdf', zoteroAttachmentKey: 'ATT001', state: 'clean', lastSyncedHash: 'H1' },
    );

    await service._handleZoteroTrash([42]);

    expect(service._moveToOSTrash).toHaveBeenCalledWith('/watch/A.pdf');
    // OS trash path emits a tombstone with trashPath=null (unreachable for restore).
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0].trashPath).toBeNull();
  });

  it('does NOT emit a tombstone for action=never (file kept on disk)', async () => {
    utils.getPref.mockImplementation((k) => {
      if (k === 'mode') return 'mode3';
      if (k === 'sourcePath') return '/watch';
      if (k === 'diskDeleteOnTrash') return 'never';
      return undefined;
    });
    store._records.push(
      { type: 'file', localPath: 'A.pdf', canonicalLocalPath: 'A.pdf', zoteroAttachmentKey: 'ATT001', state: 'clean', lastSyncedHash: 'H1' },
    );

    await service._handleZoteroTrash([42]);

    expect(tombstones).toHaveLength(0);
    // 'never' keeps the file on disk → record is suppressed, not dropped.
    expect(store.update).toHaveBeenCalledWith('A.pdf', { state: 'out-of-scope-suppressed' });
    expect(store.remove).not.toHaveBeenCalledWith('A.pdf');
  });

  it('does NOT emit a tombstone for action=permanent (file unrecoverable)', async () => {
    utils.getPref.mockImplementation((k) => {
      if (k === 'mode') return 'mode3';
      if (k === 'sourcePath') return '/watch';
      if (k === 'diskDeleteOnTrash') return 'permanent';
      return undefined;
    });
    store._records.push(
      { type: 'file', localPath: 'A.pdf', canonicalLocalPath: 'A.pdf', zoteroAttachmentKey: 'ATT001', state: 'clean', lastSyncedHash: 'H1' },
    );

    await service._handleZoteroTrash([42]);

    expect(tombstones).toHaveLength(0);
    expect(globalThis.IOUtils.remove).toHaveBeenCalledWith('/watch/A.pdf');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UT-092: restore matrix (v2.2)
//   RST.1 — Zotero attachment restored → move file out of plugin trash
//   RST.3 — Local file reappears → re-link to tombstoned attachment
//   RST.6 — Destination collision → restore as `<name>.restored.<ts>.<ext>`
// ─────────────────────────────────────────────────────────────────────────────

describe('UT-092: _handleZoteroRestore — RST.1 + RST.6', () => {
  let service;
  let store;
  let utils;

  beforeEach(async () => {
    vi.resetAllMocks();
    utils = await import('../../content/utils.mjs');
    utils.getPref.mockImplementation((k) => k === 'sourcePath' ? '/watch' : undefined);

    const watchFolderMod = await import('../../content/watchFolder.mjs');
    service = new watchFolderMod.WatchFolderService();

    const tombstones = [];
    const files = [];
    store = {
      _tombstones: tombstones,
      _files: files,
      getAllOfType: vi.fn((t) => t === 'tombstone' ? tombstones.slice() : (t === 'file' ? files.slice() : [])),
      findTombstoneByAttachmentKey: vi.fn((k) => tombstones.find(t => t.zoteroAttachmentKey === k) ?? null),
      removeTombstoneByAttachmentKey: vi.fn((k) => {
        let removed = 0;
        for (let i = tombstones.length - 1; i >= 0; i--) {
          if (tombstones[i].zoteroAttachmentKey === k) { tombstones.splice(i, 1); removed++; }
        }
        return removed;
      }),
      add: vi.fn((r) => { if (r.type === 'file') files.push(r); }),
      save: vi.fn(async () => {}),
      flush: vi.fn(async () => {}),
    };
    service._trackingStore = store;

    globalThis.IOUtils.exists = vi.fn(async () => true);
    globalThis.IOUtils.makeDirectory = vi.fn(async () => {});
    globalThis.IOUtils.move = vi.fn(async () => {});
    globalThis.IOUtils.copy = vi.fn(async () => {});
    globalThis.IOUtils.remove = vi.fn(async () => {});
    globalThis.Zotero.Items.get = vi.fn((id) => ({
      id, key: 'ATT001', deleted: false, isAttachment: () => true,
    }));
  });

  it('RST.1: restored attachment → moves file out of plugin trash, re-creates FileRecord, drops tombstone', async () => {
    store._tombstones.push({
      type: 'tombstone', objectType: 'file',
      localPath: 'Methods/paper.pdf', canonicalLocalPath: 'Methods/paper.pdf',
      zoteroAttachmentKey: 'ATT001', zoteroItemKey: 'PARENT1',
      deletedFrom: 'zotero',
      trashPath: '.zotero-watch-trash/Methods/paper.pdf',
      originalHash: 'H1', state: 'recoverable',
    });
    globalThis.IOUtils.exists = vi.fn(async (p) => p === '/watch/.zotero-watch-trash/Methods/paper.pdf');

    await service._handleZoteroRestore([42]);

    expect(globalThis.IOUtils.move).toHaveBeenCalledWith(
      '/watch/.zotero-watch-trash/Methods/paper.pdf',
      '/watch/Methods/paper.pdf'
    );
    expect(store.add).toHaveBeenCalledWith(expect.objectContaining({
      type: 'file', localPath: 'Methods/paper.pdf',
      zoteroAttachmentKey: 'ATT001', lastSyncedHash: 'H1', state: 'clean',
    }));
    expect(store.removeTombstoneByAttachmentKey).toHaveBeenCalledWith('ATT001');
  });

  it('RST.6: destination collision → suffix as `.restored.<ts>.<ext>`, never overwrite', async () => {
    store._tombstones.push({
      type: 'tombstone', objectType: 'file',
      localPath: 'paper.pdf', canonicalLocalPath: 'paper.pdf',
      zoteroAttachmentKey: 'ATT001',
      deletedFrom: 'zotero',
      trashPath: '.zotero-watch-trash/paper.pdf',
      state: 'recoverable',
    });
    // BOTH source AND destination exist → collision.
    globalThis.IOUtils.exists = vi.fn(async (p) =>
      p === '/watch/.zotero-watch-trash/paper.pdf' || p === '/watch/paper.pdf'
    );
    const before = Date.now();

    await service._handleZoteroRestore([42]);

    const moveCall = globalThis.IOUtils.move.mock.calls[0];
    expect(moveCall[0]).toBe('/watch/.zotero-watch-trash/paper.pdf');
    expect(moveCall[1]).toMatch(/^\/watch\/paper\.restored\.\d+\.pdf$/);
    const stamp = parseInt(moveCall[1].match(/paper\.restored\.(\d+)\.pdf$/)[1], 10);
    expect(stamp).toBeGreaterThanOrEqual(before);
    // FileRecord uses the suffixed path.
    expect(store.add).toHaveBeenCalledWith(expect.objectContaining({
      localPath: expect.stringMatching(/^paper\.restored\.\d+\.pdf$/),
    }));
  });

  it('drops tombstone when the trash source is missing (user emptied plugin trash)', async () => {
    store._tombstones.push({
      type: 'tombstone', objectType: 'file',
      localPath: 'paper.pdf', canonicalLocalPath: 'paper.pdf',
      zoteroAttachmentKey: 'ATT001',
      deletedFrom: 'zotero',
      trashPath: '.zotero-watch-trash/paper.pdf',
      state: 'recoverable',
    });
    globalThis.IOUtils.exists = vi.fn(async () => false); // trash source gone

    await service._handleZoteroRestore([42]);

    expect(globalThis.IOUtils.move).not.toHaveBeenCalled();
    expect(store.add).not.toHaveBeenCalled();
    expect(store.removeTombstoneByAttachmentKey).toHaveBeenCalledWith('ATT001');
  });

  it('skips items whose attachment is still in trash (deleted: true)', async () => {
    globalThis.Zotero.Items.get = vi.fn((id) => ({
      id, key: 'ATT001', deleted: true, isAttachment: () => true,
    }));
    store._tombstones.push({
      type: 'tombstone', zoteroAttachmentKey: 'ATT001', deletedFrom: 'zotero',
      trashPath: '.zotero-watch-trash/x.pdf', canonicalLocalPath: 'x.pdf', state: 'recoverable',
    });

    await service._handleZoteroRestore([42]);

    expect(globalThis.IOUtils.move).not.toHaveBeenCalled();
    expect(store.removeTombstoneByAttachmentKey).not.toHaveBeenCalled();
  });

  it('drops tombstones with no trashPath (OS-trash variant — unreachable for restore)', async () => {
    store._tombstones.push({
      type: 'tombstone', zoteroAttachmentKey: 'ATT001', deletedFrom: 'zotero',
      trashPath: null, canonicalLocalPath: 'paper.pdf', state: 'recoverable',
    });

    await service._handleZoteroRestore([42]);

    expect(globalThis.IOUtils.move).not.toHaveBeenCalled();
    expect(store.removeTombstoneByAttachmentKey).toHaveBeenCalledWith('ATT001');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UT-093: restore matrix RST.2 / RST.4 — parent-driven restore semantics
//
// RST.2: Restoring a parent item with attachments restores all matched
//        local files if available (parent expansion).
// RST.4: Restoring a parent item without restoring its attachment leaves
//        the local file trashed.
// ─────────────────────────────────────────────────────────────────────────────

describe('UT-093: _handleZoteroRestore — RST.2 (parent expansion) + RST.4 (selective restore)', () => {
  let service;
  let store;

  beforeEach(async () => {
    vi.resetAllMocks();
    const utils = await import('../../content/utils.mjs');
    utils.getPref.mockImplementation((k) => k === 'sourcePath' ? '/watch' : undefined);
    const watchFolderMod = await import('../../content/watchFolder.mjs');
    service = new watchFolderMod.WatchFolderService();

    const tombstones = [];
    const files = [];
    store = {
      _tombstones: tombstones,
      _files: files,
      getAllOfType: vi.fn((t) => t === 'tombstone' ? tombstones.slice() : (t === 'file' ? files.slice() : [])),
      findTombstoneByAttachmentKey: vi.fn((k) => tombstones.find(t => t.zoteroAttachmentKey === k) ?? null),
      removeTombstoneByAttachmentKey: vi.fn((k) => {
        let removed = 0;
        for (let i = tombstones.length - 1; i >= 0; i--) {
          if (tombstones[i].zoteroAttachmentKey === k) { tombstones.splice(i, 1); removed++; }
        }
        return removed;
      }),
      add: vi.fn((r) => { if (r.type === 'file') files.push(r); }),
      save: vi.fn(async () => {}),
      flush: vi.fn(async () => {}),
    };
    service._trackingStore = store;

    globalThis.IOUtils.exists = vi.fn(async () => true);
    globalThis.IOUtils.makeDirectory = vi.fn(async () => {});
    globalThis.IOUtils.move = vi.fn(async () => {});
  });

  it('RST.2: parent restore expands to all live (deleted=false) attachments', async () => {
    // Parent item (id=100, key=PARENT1) restored along with 2 attachments.
    // Both attachments have tombstones in the store.
    const att1 = { id: 201, key: 'ATT001', deleted: false, isAttachment: () => true };
    const att2 = { id: 202, key: 'ATT002', deleted: false, isAttachment: () => true };
    const parent = {
      id: 100, key: 'PARENT1', deleted: false, isAttachment: () => false,
      getAttachments: () => [201, 202],
    };
    const items = new Map([[100, parent], [201, att1], [202, att2]]);
    globalThis.Zotero.Items.get = vi.fn((id) => items.get(id));

    store._tombstones.push(
      { type: 'tombstone', zoteroAttachmentKey: 'ATT001', deletedFrom: 'zotero',
        trashPath: '.zotero-watch-trash/a.pdf', canonicalLocalPath: 'a.pdf', state: 'recoverable' },
      { type: 'tombstone', zoteroAttachmentKey: 'ATT002', deletedFrom: 'zotero',
        trashPath: '.zotero-watch-trash/b.pdf', canonicalLocalPath: 'b.pdf', state: 'recoverable' },
    );
    // exists returns true for both trash sources, false for destinations (no collision).
    globalThis.IOUtils.exists = vi.fn(async (p) => p.includes('/.zotero-watch-trash/'));

    // Notifier fires for the parent ID only.
    await service._handleZoteroRestore([100]);

    expect(globalThis.IOUtils.move).toHaveBeenCalledTimes(2);
    expect(store.removeTombstoneByAttachmentKey).toHaveBeenCalledWith('ATT001');
    expect(store.removeTombstoneByAttachmentKey).toHaveBeenCalledWith('ATT002');
  });

  it('RST.4: parent restored but child attachment still deleted → child skipped', async () => {
    // Parent restored (deleted=false), child still in trash (deleted=true).
    const att = { id: 201, key: 'ATT001', deleted: true, isAttachment: () => true };
    const parent = {
      id: 100, key: 'PARENT1', deleted: false, isAttachment: () => false,
      getAttachments: () => [201],
    };
    const items = new Map([[100, parent], [201, att]]);
    globalThis.Zotero.Items.get = vi.fn((id) => items.get(id));

    store._tombstones.push({
      type: 'tombstone', zoteroAttachmentKey: 'ATT001', deletedFrom: 'zotero',
      trashPath: '.zotero-watch-trash/a.pdf', canonicalLocalPath: 'a.pdf', state: 'recoverable',
    });

    await service._handleZoteroRestore([100]);

    expect(globalThis.IOUtils.move).not.toHaveBeenCalled();
    // Tombstone preserved — restore is conditional on attachment also being restored.
    expect(store.removeTombstoneByAttachmentKey).not.toHaveBeenCalled();
    expect(store._tombstones).toHaveLength(1);
  });

  it('RST.2: parent restore with mixed live + still-trashed children restores only the live ones', async () => {
    const liveAtt = { id: 201, key: 'ATT001', deleted: false, isAttachment: () => true };
    const trashedAtt = { id: 202, key: 'ATT002', deleted: true, isAttachment: () => true };
    const parent = {
      id: 100, key: 'PARENT1', deleted: false, isAttachment: () => false,
      getAttachments: () => [201, 202],
    };
    const items = new Map([[100, parent], [201, liveAtt], [202, trashedAtt]]);
    globalThis.Zotero.Items.get = vi.fn((id) => items.get(id));

    store._tombstones.push(
      { type: 'tombstone', zoteroAttachmentKey: 'ATT001', deletedFrom: 'zotero',
        trashPath: '.zotero-watch-trash/a.pdf', canonicalLocalPath: 'a.pdf', state: 'recoverable' },
      { type: 'tombstone', zoteroAttachmentKey: 'ATT002', deletedFrom: 'zotero',
        trashPath: '.zotero-watch-trash/b.pdf', canonicalLocalPath: 'b.pdf', state: 'recoverable' },
    );
    globalThis.IOUtils.exists = vi.fn(async (p) => p.includes('/.zotero-watch-trash/'));

    await service._handleZoteroRestore([100]);

    expect(globalThis.IOUtils.move).toHaveBeenCalledTimes(1);
    expect(store.removeTombstoneByAttachmentKey).toHaveBeenCalledWith('ATT001');
    expect(store.removeTombstoneByAttachmentKey).not.toHaveBeenCalledWith('ATT002');
  });

  it('parent + attachment ID both in payload → no duplicate restore (dedupe by key)', async () => {
    // Notifier sometimes fires for both the parent and each child. Make
    // sure my dedupe doesn't trigger the restore twice.
    const att = { id: 201, key: 'ATT001', deleted: false, isAttachment: () => true };
    const parent = {
      id: 100, key: 'PARENT1', deleted: false, isAttachment: () => false,
      getAttachments: () => [201],
    };
    const items = new Map([[100, parent], [201, att]]);
    globalThis.Zotero.Items.get = vi.fn((id) => items.get(id));

    store._tombstones.push({
      type: 'tombstone', zoteroAttachmentKey: 'ATT001', deletedFrom: 'zotero',
      trashPath: '.zotero-watch-trash/a.pdf', canonicalLocalPath: 'a.pdf', state: 'recoverable',
    });
    globalThis.IOUtils.exists = vi.fn(async (p) => p.includes('/.zotero-watch-trash/'));

    await service._handleZoteroRestore([100, 201]);

    expect(globalThis.IOUtils.move).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UT-094: bulk-delete protection for the watchFolder.mjs side
//   _handleZoteroTrash (>10 attachments at once → prompt; decline → no IO)
//   _handleExternalDeletions Mode 3 (>10 missing files at once → prompt;
//   decline → demote to "mark missing", Zotero untouched)
// ─────────────────────────────────────────────────────────────────────────────

describe('UT-094: _handleZoteroTrash bulk guard', () => {
  let service;
  let store;

  beforeEach(async () => {
    vi.resetAllMocks();
    const utils = await import('../../content/utils.mjs');
    utils.getPref.mockImplementation((k) => {
      if (k === 'mode') return 'mode3';
      if (k === 'sourcePath') return '/watch';
      if (k === 'diskDeleteOnTrash') return 'plugin_trash';
      return undefined;
    });
    // DATA-1 fail-closed: bulk-guard fixtures carry a baseline hash and the
    // on-disk hash matches, so the conflict gate passes and the batch flows.
    const hc094 = await import('../../content/_hashCache.mjs');
    hc094.clear();
    utils.getFileHash.mockResolvedValue('H');

    const watchFolderMod = await import('../../content/watchFolder.mjs');
    service = new watchFolderMod.WatchFolderService();

    const records = [];
    store = {
      _records: records,
      getAllOfType: vi.fn((t) => t === 'file' ? records.slice() : []),
      getAllByAttachmentKey: vi.fn((k) => records.filter(r => r.zoteroAttachmentKey === k)),
      remove: vi.fn((path) => {
        const i = records.findIndex(r => r.localPath === path);
        if (i === -1) return false;
        records.splice(i, 1);
        return true;
      }),
      removeByAttachmentKey: vi.fn(),
      update: vi.fn((path, updates) => {
        const r = records.find(x => x.localPath === path);
        if (r) Object.assign(r, updates);
        return !!r;
      }),
      add: vi.fn(),
      save: vi.fn(async () => {}),
      flush: vi.fn(async () => {}),
    };
    service._trackingStore = store;
    service._moveToPluginTrash = vi.fn(async () => '.zotero-watch-trash/x.pdf');
    service._moveToOSTrash = vi.fn(async () => {});
    service._pickWindow = vi.fn(() => null);
    Services.prompt.confirmEx.mockReturnValue(0); // approve by default

    globalThis.IOUtils.exists = vi.fn(async () => true);
    globalThis.IOUtils.remove = vi.fn(async () => {});
  });

  it('prompts when >10 attachments would be disk-deleted', async () => {
    // 15 attachments, each with a tracked canonical file on disk.
    const ids = [];
    for (let i = 0; i < 15; i++) {
      store._records.push({
        type: 'file', localPath: `f${i}.pdf`, canonicalLocalPath: `f${i}.pdf`,
        zoteroAttachmentKey: `K${i}`, state: 'clean', lastSyncedHash: 'H',
      });
      ids.push(100 + i);
    }
    const items = new Map();
    for (let i = 0; i < 15; i++) {
      items.set(100 + i, { id: 100 + i, key: `K${i}`, isAttachment: () => true });
    }
    globalThis.Zotero.Items.get = vi.fn((id) => items.get(id));

    await service._handleZoteroTrash(ids);

    expect(Services.prompt.confirmEx).toHaveBeenCalledTimes(1);
    // Approved → all 15 plugin_trash moves ran.
    expect(service._moveToPluginTrash).toHaveBeenCalledTimes(15);
  });

  it('user decline aborts the batch — no disk move, no tracking change', async () => {
    Services.prompt.confirmEx.mockReturnValue(1); // Cancel
    const ids = [];
    for (let i = 0; i < 15; i++) {
      store._records.push({
        type: 'file', localPath: `f${i}.pdf`, canonicalLocalPath: `f${i}.pdf`,
        zoteroAttachmentKey: `K${i}`, state: 'clean', lastSyncedHash: 'H',
      });
      ids.push(100 + i);
    }
    const items = new Map();
    for (let i = 0; i < 15; i++) {
      items.set(100 + i, { id: 100 + i, key: `K${i}`, isAttachment: () => true });
    }
    globalThis.Zotero.Items.get = vi.fn((id) => items.get(id));

    await service._handleZoteroTrash(ids);

    expect(Services.prompt.confirmEx).toHaveBeenCalledTimes(1);
    expect(service._moveToPluginTrash).not.toHaveBeenCalled();
    expect(service._moveToOSTrash).not.toHaveBeenCalled();
    expect(globalThis.IOUtils.remove).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
    // Records untouched.
    expect(store._records).toHaveLength(15);
  });

  it('skips the prompt when batch is small (≤10 AND ≤20%)', async () => {
    // 2 attachments out of 20 tracked → 10% < 20%, count ≤ 10 → no prompt.
    for (let i = 0; i < 20; i++) {
      store._records.push({
        type: 'file', localPath: `f${i}.pdf`, canonicalLocalPath: `f${i}.pdf`,
        zoteroAttachmentKey: i < 2 ? `K${i}` : `O${i}`, state: 'clean', lastSyncedHash: 'H',
      });
    }
    const items = new Map();
    items.set(100, { id: 100, key: 'K0', isAttachment: () => true });
    items.set(101, { id: 101, key: 'K1', isAttachment: () => true });
    globalThis.Zotero.Items.get = vi.fn((id) => items.get(id));

    await service._handleZoteroTrash([100, 101]);

    expect(Services.prompt.confirmEx).not.toHaveBeenCalled();
    expect(service._moveToPluginTrash).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UT-095: RST.5 — _processNewFile re-attaches under living parent when
// the original attachment was permanently purged from Zotero.
// ─────────────────────────────────────────────────────────────────────────────

describe('UT-095: RST.5 re-attach under living parent', () => {
  let service;
  let store;
  let utils;
  let canonicalPath;

  beforeEach(async () => {
    vi.resetAllMocks();
    utils = await import('../../content/utils.mjs');
    utils.getPref.mockImplementation((k) => k === 'sourcePath' ? '/watch' : undefined);
    utils.getFileHash.mockResolvedValue('TOMBHASH');

    canonicalPath = await import('../../content/canonicalPath.mjs');
    canonicalPath.resolveSyncRoot.mockResolvedValue({
      collection: { id: 1, key: 'ROOT1', name: 'Inbox' },
      libraryID: 1,
    });
    canonicalPath.relativePathToCollection.mockResolvedValue({
      id: 2, key: 'SUB1', libraryID: 1,
    });

    const watchFolderMod = await import('../../content/watchFolder.mjs');
    service = new watchFolderMod.WatchFolderService();
    // Bypass the file-stability wait.
    service._waitForFileStable = vi.fn(async () => true);
    // Stub the relative-path helper used by the record builder.
    service._toRelativeForStore = (path) => path.replace(/^\/watch\//, '');

    const tombstones = [];
    const files = [];
    store = {
      _tombstones: tombstones,
      _files: files,
      findByHash: vi.fn(() => null), // nothing in the live hash index
      findTombstoneByHash: vi.fn((h) => tombstones.find(t => t.originalHash === h) ?? null),
      removeTombstoneByAttachmentKey: vi.fn((k) => {
        const i = tombstones.findIndex(t => t.zoteroAttachmentKey === k);
        if (i !== -1) { tombstones.splice(i, 1); return 1; }
        return 0;
      }),
      add: vi.fn((r) => { if (r.type === 'file') files.push(r); }),
      hasPath: vi.fn(() => false),
      save: vi.fn(async () => {}),
      flush: vi.fn(async () => {}),
      // _processNewFile pre-tombstone code paths use these — return
      // benign defaults so we reach the tombstone block.
      getAllOfType: vi.fn((t) => t === 'tombstone' ? tombstones.slice() : (t === 'file' ? files.slice() : [])),
      getCollectionRecord: vi.fn(() => null),
      getByLocalPath: vi.fn(() => null),
      getByAttachmentKey: vi.fn(() => null),
      update: vi.fn(),
      remove: vi.fn(() => true),
    };
    service._trackingStore = store;

    globalThis.IOUtils.stat = vi.fn(async () => ({ size: 100, lastModified: 1 }));
    globalThis.IOUtils.exists = vi.fn(async () => true);
    globalThis.Zotero.Libraries = { userLibraryID: 1 };
  });

  it('parent intact + attachment purged → importFromFile({parentItemID}) + FileRecord + tombstone dropped', async () => {
    store._tombstones.push({
      type: 'tombstone', objectType: 'file',
      localPath: 'old/paper.pdf', canonicalLocalPath: 'old/paper.pdf',
      zoteroAttachmentKey: 'ATT_GONE', zoteroItemKey: 'PARENT_ALIVE',
      deletedFrom: 'zotero', trashPath: null,
      originalHash: 'TOMBHASH', state: 'recoverable',
    });

    // Original attachment is permanently purged.
    globalThis.Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async (lib, key) => {
      if (key === 'ATT_GONE') return null;
      if (key === 'PARENT_ALIVE') return {
        id: 999, key: 'PARENT_ALIVE', deleted: false,
        isAttachment: () => false,
      };
      return null;
    });
    // The re-attach call returns a fresh attachment item.
    globalThis.Zotero.Attachments.importFromFile.mockResolvedValue({
      id: 1234, key: 'NEW_ATT',
    });

    await service._processNewFile('/watch/Other/paper.pdf', 'Other');

    // The re-attach happened with the live parent.
    expect(globalThis.Zotero.Attachments.importFromFile).toHaveBeenCalledWith(expect.objectContaining({
      file: '/watch/Other/paper.pdf',
      parentItemID: 999,
    }));
    // FileRecord was added with the new attachment key + parent key.
    const added = store.add.mock.calls.find(c => c[0]?.type === 'file');
    expect(added).toBeDefined();
    expect(added[0]).toMatchObject({
      type: 'file',
      localPath: 'Other/paper.pdf',
      zoteroAttachmentKey: 'NEW_ATT',
      zoteroItemKey: 'PARENT_ALIVE',
      state: 'clean',
    });
    // Tombstone dropped.
    expect(store.removeTombstoneByAttachmentKey).toHaveBeenCalledWith('ATT_GONE');
    expect(store._tombstones).toHaveLength(0);
  });

  it('parent also gone → falls through to normal import, tombstone dropped', async () => {
    store._tombstones.push({
      type: 'tombstone', objectType: 'file',
      localPath: 'old/paper.pdf', canonicalLocalPath: 'old/paper.pdf',
      zoteroAttachmentKey: 'ATT_GONE', zoteroItemKey: 'PARENT_GONE',
      deletedFrom: 'zotero', trashPath: null,
      originalHash: 'TOMBHASH', state: 'recoverable',
    });
    globalThis.Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async () => null);

    // The fileImporter mock chain ends with our import returning a basic item.
    const fileImporterMod = await import('../../content/fileImporter.mjs');
    fileImporterMod.importFile.mockResolvedValue({
      id: 5, key: 'NEW_TOP', parentItem: undefined,
    });
    fileImporterMod.handlePostImportAction.mockResolvedValue({
      action: 'leave', finalPath: '/watch/Other/paper.pdf',
    });

    await service._processNewFile('/watch/Other/paper.pdf', 'Other');

    // RST.5 didn't fire — no parent re-attach.
    expect(globalThis.Zotero.Attachments.importFromFile).not.toHaveBeenCalled();
    // Tombstone dropped before fall-through.
    expect(store.removeTombstoneByAttachmentKey).toHaveBeenCalledWith('ATT_GONE');
    // Normal import path ran (fileImporter.importFile).
    expect(fileImporterMod.importFile).toHaveBeenCalled();
  });

  it('parent exists but is itself an attachment → falls through (no re-attach)', async () => {
    store._tombstones.push({
      type: 'tombstone', objectType: 'file',
      localPath: 'old/paper.pdf', canonicalLocalPath: 'old/paper.pdf',
      zoteroAttachmentKey: 'ATT_GONE', zoteroItemKey: 'ATT_AS_PARENT',
      deletedFrom: 'zotero', trashPath: null,
      originalHash: 'TOMBHASH', state: 'recoverable',
    });
    globalThis.Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async (lib, key) => {
      if (key === 'ATT_GONE') return null;
      if (key === 'ATT_AS_PARENT') return {
        id: 999, key: 'ATT_AS_PARENT', deleted: false,
        isAttachment: () => true, // looks like an attachment, not a real parent
      };
      return null;
    });
    const fileImporterMod = await import('../../content/fileImporter.mjs');
    fileImporterMod.importFile.mockResolvedValue({ id: 5, key: 'NEW_TOP' });
    fileImporterMod.handlePostImportAction.mockResolvedValue({
      action: 'leave', finalPath: '/watch/Other/paper.pdf',
    });

    await service._processNewFile('/watch/Other/paper.pdf', 'Other');

    expect(globalThis.Zotero.Attachments.importFromFile).not.toHaveBeenCalled();
    expect(store.removeTombstoneByAttachmentKey).toHaveBeenCalledWith('ATT_GONE');
  });
});

describe('UT-094: _handleExternalDeletions bulk guard (Mode 3)', () => {
  let service;
  let store;

  beforeEach(async () => {
    vi.resetAllMocks();
    const utils = await import('../../content/utils.mjs');
    utils.getPref.mockImplementation((k) => {
      if (k === 'mode') return 'mode3';
      if (k === 'sourcePath') return '/watch';
      if (k === 'diskDeleteSync') return 'auto';
      return undefined;
    });
    utils.getFileHash.mockResolvedValue(null);
    const watchFolderMod = await import('../../content/watchFolder.mjs');
    service = new watchFolderMod.WatchFolderService();

    const records = [];
    store = {
      _records: records,
      getAllOfType: vi.fn((t) => t === 'file' ? records.slice() : []),
      getAllByAttachmentKey: vi.fn((k) => records.filter(r => r.zoteroAttachmentKey === k)),
      getByAttachmentKey: vi.fn((k) => records.find(r => r.zoteroAttachmentKey === k) ?? null),
      update: vi.fn((path, updates) => {
        const r = records.find(x => x.localPath === path);
        if (r) Object.assign(r, updates);
      }),
      remove: vi.fn(),
      removeByAttachmentKey: vi.fn(),
      save: vi.fn(async () => {}),
      flush: vi.fn(async () => {}),
    };
    service._trackingStore = store;
    service._showExternalDeletionPopup = vi.fn();

    globalThis.IOUtils.exists = vi.fn(async () => false);
    globalThis.Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async () => ({
      key: 'X', deleted: false, saveTx: vi.fn(async () => {}),
      getDisplayTitle: () => 't', getField: () => 't',
    }));
    globalThis.Zotero.Libraries = { userLibraryID: 1 };
    Services.prompt.confirmEx.mockReturnValue(0); // approve by default
  });

  it('decline → demotes propagation to "mark missing", Zotero untouched', async () => {
    Services.prompt.confirmEx.mockReturnValue(1); // Cancel
    // 15 tracked files, all missing on disk.
    for (let i = 0; i < 15; i++) {
      store._records.push({
        type: 'file', localPath: `f${i}.pdf`, canonicalLocalPath: `f${i}.pdf`,
        zoteroAttachmentKey: `K${i}`, lastSyncedHash: 'h', state: 'clean',
      });
    }

    await service._handleExternalDeletions(new Set(), []);

    expect(Services.prompt.confirmEx).toHaveBeenCalledTimes(1);
    // All 15 flipped to MISSING — no Zotero.Items lookup happened.
    expect(globalThis.Zotero.Items.getByLibraryAndKeyAsync).not.toHaveBeenCalled();
    expect(store.update).toHaveBeenCalledTimes(15);
    for (const call of store.update.mock.calls) {
      expect(call[1]).toEqual({ state: 'missing' });
    }
  });

  it('approve → falls through to normal per-record propagation', async () => {
    Services.prompt.confirmEx.mockReturnValue(0); // approve
    for (let i = 0; i < 15; i++) {
      store._records.push({
        type: 'file', localPath: `f${i}.pdf`, canonicalLocalPath: `f${i}.pdf`,
        zoteroAttachmentKey: `K${i}`, lastSyncedHash: 'h', state: 'clean',
      });
    }

    await service._handleExternalDeletions(new Set(), []);

    expect(Services.prompt.confirmEx).toHaveBeenCalledTimes(1);
    // 15 attachment lookups (one per record going through the Mode-3 path).
    expect(globalThis.Zotero.Items.getByLibraryAndKeyAsync).toHaveBeenCalledTimes(15);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UT-A1: WP-A1 hash-cache integration into _handleExternalDeletions
// move detection. Two scan cycles with unchanged disk contents should
// hash each candidate at most once (cache hit on the second cycle).
// ─────────────────────────────────────────────────────────────────────────────

describe('UT-A1: _handleExternalDeletions consults the module-level hash cache', () => {
  let service;
  let getPrefMock;
  let getFileHashMock;
  let hashCache;
  const INBOX = { id: 5, key: 'INBOX', name: 'Inbox', libraryID: 1 };

  beforeEach(async () => {
    vi.resetAllMocks();

    const utils = await import('../../content/utils.mjs');
    getPrefMock = utils.getPref;
    getFileHashMock = utils.getFileHash;

    const cp = await import('../../content/canonicalPath.mjs');
    cp.resolveSyncRoot.mockResolvedValue({ collection: INBOX, libraryID: 1 });
    cp.relativePathToCollection.mockResolvedValue(INBOX);

    const mod = await import('../../content/watchFolder.mjs');
    service = new mod.WatchFolderService();
    service._windows.add({ document: {} });

    getPrefMock.mockImplementation((k) => {
      if (k === 'diskDeleteSync') return 'auto';
      if (k === 'mode') return 'mode1';
      if (k === 'sourcePath') return '/watch';
      return undefined;
    });

    globalThis.Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async () => ({
      deleted: false,
      getCollections: vi.fn(() => [5]),
      removeFromCollection: vi.fn(),
      addToCollection: vi.fn(),
      saveTx: vi.fn(),
      getDisplayTitle: vi.fn(() => 't'),
      getField: vi.fn(() => ''),
    }));

    service._trackingStore = {
      getAllOfType: vi.fn(() => []),
      remove: vi.fn(() => true),
      removeByAttachmentKey: vi.fn(() => true),
      add: vi.fn(),
      update: vi.fn(),
      save: vi.fn(async () => {}),
      flush: vi.fn(async () => {}),
      hasPath: vi.fn(() => false),
    };

    // Default stat: stable (size, mtime). hashFile() will cache by this key.
    globalThis.IOUtils.exists = vi.fn(async () => false);
    globalThis.IOUtils.stat = vi.fn(async (p) => ({ size: 4242, lastModified: 7777, type: 'regular', path: p }));

    // Clear the module-level cache so test order doesn't matter.
    hashCache = await import('../../content/_hashCache.mjs');
    hashCache.clear();
  });

  it('second cycle on unchanged disk contents skips re-hashing (cache hit)', async () => {
    service._trackingStore.getAllOfType = vi.fn((t) => t === 'file' ? [
      { type: 'file', zoteroAttachmentKey: 'AK42', localPath: '/watch/orig.pdf', lastSyncedHash: 'abc', state: 'clean' },
    ] : []);
    // Stable hash mock — same content across both cycles.
    getFileHashMock.mockResolvedValue('abc');

    // Cycle 1 — candidate is at /watch/sub/orig.pdf.
    await service._handleExternalDeletions(
      new Set(['/watch/sub/orig.pdf']),
      [{ path: '/watch/sub/orig.pdf' }]
    );
    const callsAfterCycle1 = getFileHashMock.mock.calls.length;
    expect(callsAfterCycle1).toBeGreaterThan(0); // at least one hash on first cycle

    // Cycle 2 — exact same candidate. The first cycle already moved the
    // record; reset the tracked record to make the second call still
    // exercise the candidate-hash codepath.
    service._trackingStore.getAllOfType = vi.fn((t) => t === 'file' ? [
      { type: 'file', zoteroAttachmentKey: 'AK99', localPath: '/watch/different.pdf', lastSyncedHash: 'abc', state: 'clean' },
    ] : []);

    await service._handleExternalDeletions(
      new Set(['/watch/sub/orig.pdf']),
      [{ path: '/watch/sub/orig.pdf' }]
    );

    // Cache hit on /watch/sub/orig.pdf — getFileHash should NOT have been
    // called for it a second time.
    const callsAfterCycle2 = getFileHashMock.mock.calls.length;
    expect(callsAfterCycle2).toBe(callsAfterCycle1);
    expect(hashCache.stats().hits).toBeGreaterThan(0);
  });

  it('stat-change (mtime advance) bypasses cache + re-hashes', async () => {
    service._trackingStore.getAllOfType = vi.fn((t) => t === 'file' ? [
      { type: 'file', zoteroAttachmentKey: 'AK42', localPath: '/watch/orig.pdf', lastSyncedHash: 'abc', state: 'clean' },
    ] : []);
    getFileHashMock.mockResolvedValue('abc');

    // Cycle 1
    await service._handleExternalDeletions(
      new Set(['/watch/sub/orig.pdf']),
      [{ path: '/watch/sub/orig.pdf' }]
    );
    const callsAfterCycle1 = getFileHashMock.mock.calls.length;

    // Bump mtime — file was edited between cycles.
    globalThis.IOUtils.stat = vi.fn(async (p) => ({ size: 4242, lastModified: 9999, type: 'regular', path: p }));

    service._trackingStore.getAllOfType = vi.fn((t) => t === 'file' ? [
      { type: 'file', zoteroAttachmentKey: 'AK99', localPath: '/watch/different.pdf', lastSyncedHash: 'abc', state: 'clean' },
    ] : []);

    await service._handleExternalDeletions(
      new Set(['/watch/sub/orig.pdf']),
      [{ path: '/watch/sub/orig.pdf' }]
    );

    const callsAfterCycle2 = getFileHashMock.mock.calls.length;
    expect(callsAfterCycle2).toBeGreaterThan(callsAfterCycle1);
  });
});

// ─── UT-056: destroy() commits the tracking store synchronously ──────────

describe('UT-056: WatchFolderService.destroy uses flush() for shutdown writes', () => {
  let service;
  beforeEach(async () => {
    vi.resetAllMocks();
    const utils = await import('../../content/utils.mjs');
    utils.getPref.mockImplementation((k) => {
      if (k === 'sourcePath') return '/watch';
      return undefined;
    });
    const mod = await import('../../content/watchFolder.mjs');
    service = new mod.WatchFolderService();
  });

  it('calls flush() on shutdown to skip the 50ms save() debounce window', async () => {
    const store = {
      save: vi.fn(async () => {}),
      flush: vi.fn(async () => {}),
    };
    service._trackingStore = store;
    service._initialized = true;
    await service.destroy();
    expect(store.flush).toHaveBeenCalledTimes(1);
    expect(store.save).not.toHaveBeenCalled();
    expect(service._trackingStore).toBeNull();
  });

  it('falls back to save() when flush() is unavailable (pre-B3 store / older mock)', async () => {
    const store = {
      save: vi.fn(async () => {}),
      // No flush — simulates an older mock or pre-B3 store.
    };
    service._trackingStore = store;
    service._initialized = true;
    await service.destroy();
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(service._trackingStore).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UT-608 (SYNC-1): _scan gates the folder-deletion notify behind
// isWatchRootAvailable. A transient unmount (root unreachable) must NOT run
// the folderEventDetector pass, which would otherwise see a collapsed disk
// dir set and mass-trash every tracked folder. Defense-in-depth: the call
// site (here) AND the emitter (folderEventDetector) both check.
// ─────────────────────────────────────────────────────────────────────────────

describe('UT-608: _scan skips the folder-deletion notify when watch root is unavailable', () => {
  let service;
  let watchFolderMod;
  let fileMissing;
  let fileScanner;

  beforeEach(async () => {
    vi.resetAllMocks();
    const utils = await import('../../content/utils.mjs');
    utils.getPref.mockImplementation((k) => {
      if (k === 'sourcePath') return '/watch';
      if (k === 'mode') return 'mode2';
      return undefined;
    });
    fileMissing = await import('../../content/fileMissing.mjs');
    fileMissing.isWatchRootAvailable.mockResolvedValue(true);
    fileScanner = await import('../../content/fileScanner.mjs');
    fileScanner.scanFolderRecursive.mockResolvedValue([]); // empty scan → no per-file work

    watchFolderMod = await import('../../content/watchFolder.mjs');
    service = new watchFolderMod.WatchFolderService();

    // Coordinator wired + running so the A2 hook is reached.
    service._syncCoordinator = {
      isRunning: vi.fn(() => true),
      notifyScanCycle: vi.fn(async () => {}),
    };

    // Isolate the notify block: stub the surrounding _scan collaborators.
    vi.spyOn(service, '_detectFolderRenames').mockResolvedValue(undefined);
    vi.spyOn(service, '_ensureCollectionsForExistingFolders').mockResolvedValue(undefined);
    vi.spyOn(service, '_handleExternalDeletions').mockResolvedValue(undefined);
    vi.spyOn(service, '_listSubdirectories').mockResolvedValue(['/watch/Methods']);
    service._trackingStore = { hasPath: vi.fn(() => false) };
    globalThis.Zotero.debug = vi.fn();
  });

  it('root unavailable → notifyScanCycle and _listSubdirectories are NOT called + debug log', async () => {
    fileMissing.isWatchRootAvailable.mockResolvedValue(false);

    await service._scan();

    expect(fileMissing.isWatchRootAvailable).toHaveBeenCalledWith('/watch');
    expect(service._syncCoordinator.notifyScanCycle).not.toHaveBeenCalled();
    expect(service._listSubdirectories).not.toHaveBeenCalled();
    expect(globalThis.Zotero.debug).toHaveBeenCalledWith(
      expect.stringContaining('Watch root unavailable'),
    );
  });

  it('root available → notifyScanCycle called once with watchRoot === watchPath', async () => {
    fileMissing.isWatchRootAvailable.mockResolvedValue(true);

    await service._scan();

    expect(service._listSubdirectories).toHaveBeenCalledWith('/watch');
    expect(service._syncCoordinator.notifyScanCycle).toHaveBeenCalledTimes(1);
    const arg = service._syncCoordinator.notifyScanCycle.mock.calls[0][0];
    expect(arg.watchRoot).toBe('/watch');
    expect(arg.onDiskAbsDirs instanceof Set).toBe(true);
    expect(arg.onDiskAbsDirs.has('/watch')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UT-IMPORT-1: _waitForFileStable + _looksLikeCompletePdf
// ─────────────────────────────────────────────────────────────────────────────
//
// IMPORT-1 hardens the import-gate against partial cloud-sync (pCloud /
// WebDAV) downloads. The gate now requires BOTH size AND lastModified to
// match across two consecutive reads, then sanity-checks the bytes for a
// `%PDF-` header and a `%%EOF` marker within the last 1024 bytes. The old
// `size > 0` fallback is gone — non-convergence returns false (defer to the
// next poll). The sanity check uses raw byte reads, NOT SHA-256, so it does
// not touch HASH_VERSION or _hashCache.
describe('UT-IMPORT-1: _waitForFileStable hardened against partial cloud downloads', () => {
  let service;

  // Build a Uint8Array that starts with "%PDF-" and ends with "%%EOF".
  function buildPdf({ withEof = true, header = '%PDF-', pad = 32 } = {}) {
    const enc = new TextEncoder();
    const head = enc.encode(header);
    const body = new Uint8Array(pad); // zero-filled filler
    const tail = enc.encode(withEof ? '\n%%EOF\n' : '\nstartxref\n0\n');
    const out = new Uint8Array(head.length + body.length + tail.length);
    out.set(head, 0);
    out.set(body, head.length);
    out.set(tail, head.length + body.length);
    return out;
  }

  // Wire IOUtils.read to slice the given backing buffer per { offset, maxBytes }.
  function backReadWith(buf) {
    globalThis.IOUtils.read = vi.fn(async (_path, opts = {}) => {
      const offset = Number.isInteger(opts.offset) ? opts.offset : 0;
      const end = Number.isInteger(opts.maxBytes)
        ? Math.min(buf.length, offset + opts.maxBytes)
        : buf.length;
      return buf.slice(Math.min(offset, buf.length), end);
    });
  }

  beforeEach(async () => {
    vi.resetAllMocks();
    // Tests below do not mock getFileHash (they call the gate directly), but
    // clear the module-level hash cache anyway to keep the singleton clean.
    const hc = await import('../../content/_hashCache.mjs');
    hc.clear();

    const utils = await import('../../content/utils.mjs');
    utils.getPref.mockImplementation((k) =>
      k === 'sourcePath' ? '/watch' : (k === 'mode' ? 'mode1' : undefined));
    // delay is a no-op vi.fn() per the top-level mock, so the loop runs fast.

    const mod = await import('../../content/watchFolder.mjs');
    service = new mod.WatchFolderService();

    globalThis.IOUtils.exists = vi.fn(async () => true);
    globalThis.Zotero.debug = vi.fn();
  });

  it('UT-IMPORT-1a: steady size but changing mtime never converges → false', async () => {
    const pdf = buildPdf();
    backReadWith(pdf);
    let n = 0;
    globalThis.IOUtils.stat = vi.fn(async () => ({
      type: 'regular',
      size: pdf.length,        // size is steady
      lastModified: 1000 + (n++), // but mtime ticks every read
    }));

    const ok = await service._waitForFileStable('/watch/a.pdf', 3);
    expect(ok).toBe(false);
  });

  it('UT-IMPORT-1b: stable size+mtime + complete PDF bytes → true', async () => {
    const pdf = buildPdf({ withEof: true });
    backReadWith(pdf);
    globalThis.IOUtils.stat = vi.fn(async () => ({
      type: 'regular',
      size: pdf.length,
      lastModified: 4242, // constant across reads
    }));

    const ok = await service._waitForFileStable('/watch/a.pdf', 3);
    expect(ok).toBe(true);
  });

  it('UT-IMPORT-1j: non-PDF allowed type (.epub) passes on size+mtime, PDF check skipped', async () => {
    // Regression guard: the %PDF-/%%EOF sanity check must NOT be applied to
    // non-pdf allowed types (epub/djvu/…), or they would defer forever and
    // never import — silently breaking the advertised multi-type support.
    const epubBytes = new TextEncoder().encode('PK\x03\x04 not-a-pdf at all');
    backReadWith(epubBytes);
    const looksSpy = vi.spyOn(service, '_looksLikeCompletePdf');
    globalThis.IOUtils.stat = vi.fn(async () => ({
      type: 'regular', size: epubBytes.length, lastModified: 4242, // constant
    }));

    const ok = await service._waitForFileStable('/watch/book.epub', 3);
    expect(ok).toBe(true);
    expect(looksSpy).not.toHaveBeenCalled(); // PDF check skipped for non-pdf
  });

  it('UT-IMPORT-1k: a .pdf with the same non-PDF bytes still gets the PDF check (→ false)', async () => {
    // The extension gate must not weaken the check for actual PDFs.
    const notPdf = new TextEncoder().encode('PK\x03\x04 not-a-pdf at all');
    backReadWith(notPdf);
    globalThis.IOUtils.stat = vi.fn(async () => ({
      type: 'regular', size: notPdf.length, lastModified: 4242,
    }));
    const ok = await service._waitForFileStable('/watch/mislabeled.pdf', 3);
    expect(ok).toBe(false);
  });

  it('UT-IMPORT-1c: stable file but truncated (no %%EOF in tail) → false', async () => {
    const pdf = buildPdf({ withEof: false }); // header present, no %%EOF
    backReadWith(pdf);
    globalThis.IOUtils.stat = vi.fn(async () => ({
      type: 'regular',
      size: pdf.length,
      lastModified: 4242,
    }));

    const ok = await service._waitForFileStable('/watch/a.pdf', 3);
    expect(ok).toBe(false);
  });

  it('UT-IMPORT-1d: stable file but header not %PDF- → false', async () => {
    const notPdf = buildPdf({ header: '%XYZ-', withEof: true });
    backReadWith(notPdf);
    globalThis.IOUtils.stat = vi.fn(async () => ({
      type: 'regular',
      size: notPdf.length,
      lastModified: 4242,
    }));

    const ok = await service._waitForFileStable('/watch/a.pdf', 3);
    expect(ok).toBe(false);
  });

  it('UT-IMPORT-1e: still growing after maxAttempts → false (old size>0 fallback gone)', async () => {
    const pdf = buildPdf();
    backReadWith(pdf);
    let size = 100;
    globalThis.IOUtils.stat = vi.fn(async () => ({
      type: 'regular',
      size: (size += 50), // grows on every read — never stable
      lastModified: 4242,
    }));

    const ok = await service._waitForFileStable('/watch/a.pdf', 3);
    expect(ok).toBe(false);
  });

  it('UT-IMPORT-1f: file vanishes mid-check → false', async () => {
    const pdf = buildPdf();
    backReadWith(pdf);
    globalThis.IOUtils.stat = vi.fn(async () => ({
      type: 'regular', size: pdf.length, lastModified: 4242,
    }));
    // Exists on the first poll, gone on the second.
    let calls = 0;
    globalThis.IOUtils.exists = vi.fn(async () => (++calls) < 2);

    const ok = await service._waitForFileStable('/watch/a.pdf', 3);
    expect(ok).toBe(false);
  });

  it('UT-IMPORT-1g: stat/read throws → false, no throw', async () => {
    globalThis.IOUtils.stat = vi.fn(async () => { throw new Error('EIO transient'); });

    await expect(service._waitForFileStable('/watch/a.pdf', 3)).resolves.toBe(false);
  });

  it('UT-IMPORT-1g2: _looksLikeCompletePdf swallows read errors → false', async () => {
    globalThis.IOUtils.read = vi.fn(async () => { throw new Error('read failed'); });
    await expect(service._looksLikeCompletePdf('/watch/a.pdf', 4096)).resolves.toBe(false);
  });

  it('UT-IMPORT-1h: _looksLikeCompletePdf rejects a size smaller than the header', async () => {
    backReadWith(buildPdf());
    await expect(service._looksLikeCompletePdf('/watch/a.pdf', 3)).resolves.toBe(false);
  });

  it('UT-IMPORT-1i: tail window caps at 1024 bytes (%%EOF beyond the window → false)', async () => {
    // %%EOF sits at the very start; the rest is >1024 bytes of filler, so the
    // last-1024-byte tail window does not contain %%EOF.
    const enc = new TextEncoder();
    const head = enc.encode('%PDF-');
    const eof = enc.encode('%%EOF');
    const filler = new Uint8Array(2048);
    const buf = new Uint8Array(head.length + eof.length + filler.length);
    buf.set(head, 0);
    buf.set(eof, head.length);
    buf.set(filler, head.length + eof.length);
    backReadWith(buf);

    await expect(service._looksLikeCompletePdf('/watch/a.pdf', buf.length)).resolves.toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UX-1 — _promptDiskDelete must never PERSIST 'permanent'
// ─────────────────────────────────────────────────────────────────────────────
//
// The "Delete permanently" choice is honored for the single batch (the return
// value), but the "Don't ask again" persist branch must downgrade it to
// 'plugin_trash' before writing the pref, and surface a one-time advisory
// alert. Safe dispositions persist verbatim with no alert. This guards the
// data-safety invariant: one click can never arm an unattended every-batch
// permanent delete.
describe('UT-096: _promptDiskDelete never persists permanent', () => {
  let service;
  let utils;
  let setPrefMock;

  // confirmEx button result → action mapping (see _promptDiskDelete):
  //   0 → 'plugin_trash', 1 → 'never', 2 → 'permanent'
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    utils = await import('../../content/utils.mjs');
    setPrefMock = utils.setPref;
    // pdfStorageStrategy unset → defaults to 'stored' (no linked-warning path).
    utils.getPref.mockImplementation(() => undefined);

    const mod = await import('../../content/watchFolder.mjs');
    service = new mod.WatchFolderService();
    // Provide a window so the prompt path runs (not the no-UI 'never' fallback).
    service._pickWindow = vi.fn(() => ({}));

    globalThis.Services.prompt.confirmEx = vi.fn();
    globalThis.Services.prompt.alert = vi.fn();
  });

  const targets = [{ itemID: 1, path: '/watch/a.pdf' }];

  it('UT-096a: permanent + "don\'t ask again" → returns permanent, persists plugin_trash, alerts once', () => {
    // Button 2 (permanent) with the "don't ask again" checkbox ticked.
    globalThis.Services.prompt.confirmEx.mockImplementation(
      (win, title, msg, flags, b0, b1, b2, check, checkState) => {
        checkState.value = true;
        return 2;
      }
    );

    const action = service._promptDiskDelete(targets);

    expect(action).toBe('permanent'); // this batch still honors permanent
    expect(setPrefMock).toHaveBeenCalledTimes(1);
    expect(setPrefMock).toHaveBeenCalledWith('diskDeleteOnTrash', 'plugin_trash');
    expect(globalThis.Services.prompt.alert).toHaveBeenCalledTimes(1);
  });

  it('UT-096b: safe value (plugin_trash) + checkbox → persists verbatim, no alert', () => {
    globalThis.Services.prompt.confirmEx.mockImplementation(
      (win, title, msg, flags, b0, b1, b2, check, checkState) => {
        checkState.value = true;
        return 0; // plugin_trash
      }
    );

    const action = service._promptDiskDelete(targets);

    expect(action).toBe('plugin_trash');
    expect(setPrefMock).toHaveBeenCalledTimes(1);
    expect(setPrefMock).toHaveBeenCalledWith('diskDeleteOnTrash', 'plugin_trash');
    expect(globalThis.Services.prompt.alert).not.toHaveBeenCalled();
  });

  it('UT-096c: permanent WITHOUT checkbox → returns permanent, no setPref, no alert', () => {
    globalThis.Services.prompt.confirmEx.mockImplementation(
      (win, title, msg, flags, b0, b1, b2, check, checkState) => {
        checkState.value = false; // "don't ask again" NOT ticked
        return 2; // permanent
      }
    );

    const action = service._promptDiskDelete(targets);

    expect(action).toBe('permanent');
    expect(setPrefMock).not.toHaveBeenCalled();
    expect(globalThis.Services.prompt.alert).not.toHaveBeenCalled();
  });

  it('UT-096d: no UI available → returns never, no setPref, no alert', () => {
    service._pickWindow = vi.fn(() => null);

    const action = service._promptDiskDelete(targets);

    expect(action).toBe('never');
    expect(setPrefMock).not.toHaveBeenCalled();
    expect(globalThis.Services.prompt.alert).not.toHaveBeenCalled();
  });
});
