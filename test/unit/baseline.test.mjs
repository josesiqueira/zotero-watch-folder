/**
 * Unit tests for content/baseline.mjs (v2.1 Phase C — first-run baseline).
 *
 * Covers:
 *   UT-901 idempotency: skips when baselineCompletedForRoot matches sync root
 *   UT-902 returns no-sync-root when sync root isn't configured
 *   UT-903 returns no-watch-root when pref unset
 *   UT-904 B.6: mkdirs empty subcollections + inserts CollectionRecords
 *   UT-905 B.6 adopt: doesn't mkdir when folder exists, but adds tracking record
 *   UT-906 B.2: copies Zotero attachment file to canonical local path + tracks
 *   UT-907 B.2: skips when destination already exists (B.7 deferred), but adopts tracking
 *   UT-908 B.2: warns + skips when source file path is unavailable
 *   UT-909 dryRun makes no IO changes and does NOT mark complete
 *   UT-910 force=true re-runs even when pref matches
 *   UT-911 special / virtual collections are skipped
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../content/utils.mjs', async () => {
  const actual = await vi.importActual('../../content/utils.mjs');
  return {
    ...actual,
    getPref: vi.fn(),
    setPref: vi.fn(),
    getFileHash: vi.fn(async () => 'hash1'),
  };
});
vi.mock('../../content/canonicalPath.mjs', async () => {
  const actual = await vi.importActual('../../content/canonicalPath.mjs');
  return {
    ...actual,
    resolveSyncRoot: vi.fn(),
    collectionKeyToRelativePath: vi.fn(),
    chooseCanonicalCollection: vi.fn(),
    isSpecialCollection: vi.fn(() => false),
  };
});
vi.mock('../../content/fileScanner.mjs', () => ({
  scanFolderRecursive: vi.fn(async () => []),
  SKIP_DIRNAMES: new Set(),
}));

import { runBaseline, isBaselineNeeded, markBaselineComplete } from '../../content/baseline.mjs';
import { TrackingStore, STATE } from '../../content/trackingStore.mjs';
import { getPref, setPref, getFileHash } from '../../content/utils.mjs';
import {
  resolveSyncRoot,
  collectionKeyToRelativePath,
  chooseCanonicalCollection,
  isSpecialCollection,
} from '../../content/canonicalPath.mjs';
import { scanFolderRecursive } from '../../content/fileScanner.mjs';

const SYNC_ROOT = {
  collection: { id: 100, key: 'ROOT1', name: 'Inbox', libraryID: 1, parentID: null },
  libraryID: 1,
};

async function makeStore() {
  const store = new TrackingStore();
  store.dataFile = '/tmp/x.json';
  store._initialized = true;
  return store;
}

function prefStubs(values) {
  getPref.mockImplementation((key) => values[key]);
}

beforeEach(() => {
  vi.clearAllMocks();
  Zotero.debug = vi.fn();
  Zotero.logError = vi.fn();
  Zotero.Collections.get = vi.fn();
  Zotero.Collections.getByParent = vi.fn(() => []);
  Zotero.Items.get = vi.fn();
  IOUtils.exists = vi.fn(async () => false);
  IOUtils.makeDirectory = vi.fn(async () => {});
  IOUtils.copy = vi.fn(async () => {});
  IOUtils.stat = vi.fn(async () => ({ type: 'regular', size: 4096, lastModified: 1700000000000 }));
  prefStubs({ sourcePath: '/watch', baselineCompletedForRoot: '' });
  resolveSyncRoot.mockResolvedValue(SYNC_ROOT);
  collectionKeyToRelativePath.mockResolvedValue('');
  chooseCanonicalCollection.mockResolvedValue(null);
  isSpecialCollection.mockReturnValue(false);
  getFileHash.mockResolvedValue('hash1');
  scanFolderRecursive.mockResolvedValue([]);
});

// ─── UT-901 ────────────────────────────────────────────────────────────────

describe('UT-901: idempotency on baselineCompletedForRoot pref', () => {
  it('skips when pref matches current sync root key', async () => {
    prefStubs({ sourcePath: '/watch', baselineCompletedForRoot: 'ROOT1' });
    const result = await runBaseline({ trackingStore: await makeStore() });
    expect(result).toMatchObject({ baselineRan: false, skipped: 'already-completed' });
    expect(IOUtils.copy).not.toHaveBeenCalled();
    expect(IOUtils.makeDirectory).not.toHaveBeenCalled();
  });

  it('runs when pref points at a different sync root key', async () => {
    prefStubs({ sourcePath: '/watch', baselineCompletedForRoot: 'OTHER_ROOT' });
    const result = await runBaseline({ trackingStore: await makeStore() });
    expect(result.baselineRan).toBe(true);
  });

  it('isBaselineNeeded returns true when pref differs from current root', async () => {
    prefStubs({ baselineCompletedForRoot: 'OTHER' });
    expect(await isBaselineNeeded()).toBe(true);
  });

  it('markBaselineComplete writes the pref', () => {
    markBaselineComplete('ROOT1');
    expect(setPref).toHaveBeenCalledWith('baselineCompletedForRoot', 'ROOT1');
  });
});

// ─── UT-902 ────────────────────────────────────────────────────────────────

describe('UT-902: no-sync-root short-circuit', () => {
  it('returns no-sync-root when resolveSyncRoot returns null', async () => {
    resolveSyncRoot.mockResolvedValue(null);
    const result = await runBaseline({ trackingStore: await makeStore() });
    expect(result).toMatchObject({ baselineRan: false, skipped: 'no-sync-root' });
  });

  it('returns sync-root-error when resolveSyncRoot throws', async () => {
    resolveSyncRoot.mockRejectedValueOnce(new Error('SyncRootMissingError'));
    const result = await runBaseline({ trackingStore: await makeStore() });
    expect(result.skipped).toBe('sync-root-error');
  });
});

// ─── UT-903 ────────────────────────────────────────────────────────────────

describe('UT-903: no watch root', () => {
  it('returns no-watch-root when sourcePath pref is empty', async () => {
    prefStubs({ sourcePath: '', baselineCompletedForRoot: '' });
    const result = await runBaseline({ trackingStore: await makeStore() });
    expect(result).toMatchObject({ baselineRan: false, skipped: 'no-watch-root' });
  });
});

// ─── UT-904 ────────────────────────────────────────────────────────────────

describe('UT-904: B.6 mkdir empty subcollections', () => {
  it('makes directories and inserts CollectionRecords for each non-existing subcollection', async () => {
    const sub1 = { id: 200, key: 'SUB1', name: 'Methods', libraryID: 1, parentID: 100, getChildItems: () => [] };
    const sub2 = { id: 300, key: 'SUB2', name: 'Refs', libraryID: 1, parentID: 100, getChildItems: () => [] };
    SYNC_ROOT.collection.getChildItems = () => [];
    Zotero.Collections.getByParent.mockImplementation((parentID) => {
      if (parentID === 100) return [sub1, sub2];
      return [];
    });
    collectionKeyToRelativePath.mockImplementation(async (k) => {
      if (k === 'SUB1') return 'Methods';
      if (k === 'SUB2') return 'Refs';
      return '';
    });
    Zotero.Collections.get.mockImplementation((id) => (id === 100 ? SYNC_ROOT.collection : null));

    const store = await makeStore();
    const result = await runBaseline({ trackingStore: store });

    expect(result.ok).toBe(true);
    expect(result.mkdirs).toBe(2);
    expect(IOUtils.makeDirectory).toHaveBeenCalledWith('/watch/Methods', expect.any(Object));
    expect(IOUtils.makeDirectory).toHaveBeenCalledWith('/watch/Refs', expect.any(Object));
    expect(store.getCollectionRecord('SUB1')).toBeTruthy();
    expect(store.getCollectionRecord('SUB1').localPath).toBe('Methods');
    expect(store.getCollectionRecord('SUB1').parentCollectionKey).toBe('ROOT1');
    expect(store.getCollectionRecord('SUB2')).toBeTruthy();
  });
});

// ─── UT-905 ────────────────────────────────────────────────────────────────

describe('UT-905: B.6 adopt — existing folder gets tracking but no mkdir', () => {
  it('does not mkdir but adopts the tracking record when the dir already exists', async () => {
    const sub = { id: 200, key: 'SUB1', name: 'Methods', libraryID: 1, parentID: 100, getChildItems: () => [] };
    SYNC_ROOT.collection.getChildItems = () => [];
    Zotero.Collections.getByParent.mockImplementation((parentID) => (parentID === 100 ? [sub] : []));
    collectionKeyToRelativePath.mockImplementation(async (k) => (k === 'SUB1' ? 'Methods' : ''));
    Zotero.Collections.get.mockImplementation((id) => (id === 100 ? SYNC_ROOT.collection : null));
    IOUtils.exists.mockResolvedValue(true); // folder already on disk

    const store = await makeStore();
    const result = await runBaseline({ trackingStore: store });

    expect(result.mkdirs).toBe(0);
    expect(IOUtils.makeDirectory).not.toHaveBeenCalled();
    expect(store.getCollectionRecord('SUB1')).toBeTruthy();
  });
});

// ─── UT-906 ────────────────────────────────────────────────────────────────

describe('UT-906: B.2 copy Zotero attachment to canonical path', () => {
  it('copies the file + inserts a FileRecord with the right canonical', async () => {
    const att = {
      id: 700, key: 'ATT1',
      attachmentFilename: 'paper.pdf',
      isAttachment: () => true,
      parentItemID: null,
      getCollections: () => [200],
      getFilePathAsync: vi.fn(async () => '/zotero-storage/ABCD/paper.pdf'),
    };
    SYNC_ROOT.collection.getChildItems = () => [att];
    chooseCanonicalCollection.mockResolvedValue({ key: 'SUB1', libraryID: 1 });
    collectionKeyToRelativePath.mockImplementation(async (k) => (k === 'SUB1' ? 'Methods' : ''));
    IOUtils.exists.mockImplementation(async (p) => p === '/zotero-storage/ABCD/paper.pdf');
    Zotero.Collections.get.mockReturnValue({ key: 'SUB1' });

    const store = await makeStore();
    const result = await runBaseline({ trackingStore: store });

    expect(result.copies).toBe(1);
    expect(IOUtils.copy).toHaveBeenCalledWith('/zotero-storage/ABCD/paper.pdf', '/watch/Methods/paper.pdf');
    const rec = store.getByAttachmentKey('ATT1');
    expect(rec).toBeTruthy();
    expect(rec.localPath).toBe('Methods/paper.pdf');
    expect(rec.canonicalCollectionKey).toBe('SUB1');
    expect(rec.lastSyncedHash).toBe('hash1');
    expect(rec.state).toBe(STATE.CLEAN);
  });

  it('marks complete by writing the pref after a successful run', async () => {
    SYNC_ROOT.collection.getChildItems = () => [];
    const store = await makeStore();
    await runBaseline({ trackingStore: store });
    expect(setPref).toHaveBeenCalledWith('baselineCompletedForRoot', 'ROOT1');
  });
});

// ─── UT-907 ────────────────────────────────────────────────────────────────

describe('UT-907: B.2 adopt when destination file exists', () => {
  it('skips the copy but inserts a FileRecord with the existing file\'s hash', async () => {
    const att = {
      id: 700, key: 'ATT1',
      attachmentFilename: 'paper.pdf',
      isAttachment: () => true,
      parentItemID: null,
      getCollections: () => [],
      getFilePathAsync: async () => '/zotero-storage/ABCD/paper.pdf',
    };
    SYNC_ROOT.collection.getChildItems = () => [att];
    chooseCanonicalCollection.mockResolvedValue({ key: 'SUB1', libraryID: 1 });
    collectionKeyToRelativePath.mockImplementation(async (k) => (k === 'SUB1' ? 'Methods' : ''));
    // Destination already exists.
    IOUtils.exists.mockResolvedValue(true);
    getFileHash.mockResolvedValueOnce('disk-hash');

    const store = await makeStore();
    const result = await runBaseline({ trackingStore: store });

    expect(result.copies).toBe(0);
    expect(IOUtils.copy).not.toHaveBeenCalled();
    const rec = store.getByAttachmentKey('ATT1');
    expect(rec).toBeTruthy();
    expect(rec.lastSyncedHash).toBe('disk-hash');
  });
});

// ─── UT-908 ────────────────────────────────────────────────────────────────

describe('UT-908: B.2 source unavailable warning', () => {
  it('warns and skips when getFilePathAsync returns null', async () => {
    const att = {
      id: 700, key: 'ATT1',
      attachmentFilename: 'p.pdf',
      isAttachment: () => true,
      parentItemID: null,
      getCollections: () => [],
      getFilePathAsync: async () => null,
    };
    SYNC_ROOT.collection.getChildItems = () => [att];
    chooseCanonicalCollection.mockResolvedValue({ key: 'SUB1', libraryID: 1 });
    collectionKeyToRelativePath.mockImplementation(async (k) => (k === 'SUB1' ? 'Methods' : ''));

    const store = await makeStore();
    const result = await runBaseline({ trackingStore: store });

    expect(result.copies).toBe(0);
    expect(IOUtils.copy).not.toHaveBeenCalled();
    expect(store.getByAttachmentKey('ATT1')).toBe(null);
  });
});

// ─── UT-909 ────────────────────────────────────────────────────────────────

describe('UT-909: dryRun', () => {
  it('counts but does not perform IO; does not mark complete', async () => {
    const sub = { id: 200, key: 'SUB1', name: 'X', libraryID: 1, parentID: 100, getChildItems: () => [] };
    SYNC_ROOT.collection.getChildItems = () => [];
    Zotero.Collections.getByParent.mockImplementation((parentID) => (parentID === 100 ? [sub] : []));
    collectionKeyToRelativePath.mockImplementation(async (k) => (k === 'SUB1' ? 'X' : ''));

    const store = await makeStore();
    const result = await runBaseline({ trackingStore: store, dryRun: true });

    expect(result.mkdirs).toBe(1);
    expect(IOUtils.makeDirectory).not.toHaveBeenCalled();
    expect(store.getCollectionRecord('SUB1')).toBe(null);
    expect(setPref).not.toHaveBeenCalled();
  });
});

// ─── UT-910 ────────────────────────────────────────────────────────────────

describe('UT-910: force=true bypasses idempotency', () => {
  it('runs even when pref matches', async () => {
    prefStubs({ sourcePath: '/watch', baselineCompletedForRoot: 'ROOT1' });
    SYNC_ROOT.collection.getChildItems = () => [];
    const result = await runBaseline({ trackingStore: await makeStore(), force: true });
    expect(result.baselineRan).toBe(true);
  });
});

// ─── UT-912 (B.7) ─────────────────────────────────────────────────────────

describe('UT-912: B.7 hash-based reconcile', () => {
  it('adopts an existing disk file at a non-canonical path when content matches', async () => {
    const att = {
      id: 700, key: 'ATT1',
      attachmentFilename: 'paper.pdf',
      isAttachment: () => true,
      parentItemID: null,
      getCollections: () => [],
      // The attachment's Zotero-storage source path.
      getFilePathAsync: vi.fn(async () => '/zotero-storage/ABC/paper.pdf'),
    };
    SYNC_ROOT.collection.getChildItems = () => [att];
    chooseCanonicalCollection.mockResolvedValue({ key: 'SUB1', libraryID: 1 });
    collectionKeyToRelativePath.mockImplementation(async (k) => (k === 'SUB1' ? 'Methods' : ''));

    // The CANONICAL destination /watch/Methods/paper.pdf does NOT exist.
    // But disk has /watch/elsewhere/paper.pdf with matching content hash.
    IOUtils.exists.mockImplementation(async (p) => {
      if (p === '/watch/elsewhere/paper.pdf') return true;
      if (p === '/zotero-storage/ABC/paper.pdf') return true;
      return false;
    });
    scanFolderRecursive.mockResolvedValue([
      { path: '/watch/elsewhere/paper.pdf', name: 'paper.pdf' },
    ]);
    // Both the disk file and the Zotero storage file hash to the same value.
    getFileHash.mockResolvedValue('SAMEHASH');

    const store = await makeStore();
    const result = await runBaseline({ trackingStore: store });

    expect(result.ok).toBe(true);
    expect(result.reconciles).toBe(1);
    expect(result.copies).toBe(0);
    // Did NOT copy from Zotero storage.
    expect(IOUtils.copy).not.toHaveBeenCalled();
    // Tracked record points at the EXISTING disk path, not the canonical.
    const rec = store.getByAttachmentKey('ATT1');
    expect(rec).toBeTruthy();
    expect(rec.localPath).toBe('elsewhere/paper.pdf');
    expect(rec.canonicalLocalPath).toBe('elsewhere/paper.pdf');
    expect(rec.lastSyncedHash).toBe('SAMEHASH');
  });

  it('still copies from Zotero storage when no disk file has the matching hash', async () => {
    const att = {
      id: 700, key: 'ATT1',
      attachmentFilename: 'paper.pdf',
      isAttachment: () => true,
      parentItemID: null,
      getCollections: () => [],
      getFilePathAsync: vi.fn(async () => '/zotero-storage/ABC/paper.pdf'),
    };
    SYNC_ROOT.collection.getChildItems = () => [att];
    chooseCanonicalCollection.mockResolvedValue({ key: 'SUB1', libraryID: 1 });
    collectionKeyToRelativePath.mockImplementation(async (k) => (k === 'SUB1' ? 'Methods' : ''));

    IOUtils.exists.mockImplementation(async (p) => p === '/zotero-storage/ABC/paper.pdf');
    scanFolderRecursive.mockResolvedValue([
      { path: '/watch/other.pdf', name: 'other.pdf' },
    ]);
    // Disk file has a DIFFERENT hash from the Zotero attachment.
    getFileHash.mockImplementation(async (p) => (p === '/watch/other.pdf' ? 'DISK-HASH' : 'ZOTERO-HASH'));

    const store = await makeStore();
    const result = await runBaseline({ trackingStore: store });

    expect(result.copies).toBe(1);
    expect(result.reconciles).toBe(0);
    expect(IOUtils.copy).toHaveBeenCalledWith('/zotero-storage/ABC/paper.pdf', '/watch/Methods/paper.pdf');
  });

  it('does not double-claim: second attachment with the same hash falls through to copy', async () => {
    const att1 = {
      id: 700, key: 'ATT1', attachmentFilename: 'paper.pdf',
      isAttachment: () => true, parentItemID: null, getCollections: () => [],
      getFilePathAsync: async () => '/zotero-storage/ABC/paper.pdf',
    };
    const att2 = {
      id: 701, key: 'ATT2', attachmentFilename: 'paper-copy.pdf',
      isAttachment: () => true, parentItemID: null, getCollections: () => [],
      getFilePathAsync: async () => '/zotero-storage/DEF/paper-copy.pdf',
    };
    SYNC_ROOT.collection.getChildItems = () => [att1, att2];
    chooseCanonicalCollection.mockResolvedValue({ key: 'SUB1', libraryID: 1 });
    collectionKeyToRelativePath.mockImplementation(async (k) => (k === 'SUB1' ? 'Methods' : ''));

    IOUtils.exists.mockImplementation(async (p) => p.startsWith('/zotero-storage') || p === '/watch/disk-copy.pdf');
    scanFolderRecursive.mockResolvedValue([{ path: '/watch/disk-copy.pdf', name: 'disk-copy.pdf' }]);
    getFileHash.mockResolvedValue('SHARED-HASH'); // every file has same hash

    const store = await makeStore();
    const result = await runBaseline({ trackingStore: store });

    expect(result.reconciles).toBe(1); // only the FIRST attachment adopted the disk file
    expect(result.copies).toBe(1);     // the SECOND attachment falls through to copy
  });

  it('skips B.7 entirely in dryRun mode', async () => {
    const att = {
      id: 700, key: 'ATT1', attachmentFilename: 'paper.pdf',
      isAttachment: () => true, parentItemID: null, getCollections: () => [],
      getFilePathAsync: async () => '/zotero-storage/ABC/paper.pdf',
    };
    SYNC_ROOT.collection.getChildItems = () => [att];
    chooseCanonicalCollection.mockResolvedValue({ key: 'SUB1', libraryID: 1 });
    collectionKeyToRelativePath.mockImplementation(async (k) => (k === 'SUB1' ? 'Methods' : ''));

    scanFolderRecursive.mockResolvedValue([{ path: '/watch/other.pdf', name: 'other.pdf' }]);
    await runBaseline({ trackingStore: await makeStore(), dryRun: true });
    // dryRun shouldn't even call scanFolderRecursive — the hash index is skipped.
    expect(scanFolderRecursive).not.toHaveBeenCalled();
  });
});

// ─── UT-913 (WP-C #3 — B.7 size pre-filter) ───────────────────────────────

describe('UT-913: B.7 size pre-filter (WP-C #3)', () => {
  it('skips hashing disk candidates whose size differs from attachmentFileSize', async () => {
    // The attachment knows its size (Zotero exposes attachmentFileSize
    // as a sync property on imported-file attachments). Disk has a
    // file of a DIFFERENT size — the size pre-filter must reject it
    // BEFORE paying for a hash read.
    const att = {
      id: 700, key: 'ATT1',
      attachmentFilename: 'paper.pdf',
      attachmentFileSize: 12345,
      isAttachment: () => true,
      parentItemID: null,
      getCollections: () => [],
      getFilePathAsync: vi.fn(async () => '/zotero-storage/ABC/paper.pdf'),
    };
    SYNC_ROOT.collection.getChildItems = () => [att];
    chooseCanonicalCollection.mockResolvedValue({ key: 'SUB1', libraryID: 1 });
    collectionKeyToRelativePath.mockImplementation(async (k) => (k === 'SUB1' ? 'Methods' : ''));

    IOUtils.exists.mockImplementation(async (p) => p === '/zotero-storage/ABC/paper.pdf');
    scanFolderRecursive.mockResolvedValue([
      { path: '/watch/big-different.pdf', name: 'big-different.pdf' },
    ]);
    // IOUtils.stat returns size=99999 for the disk file (not 12345).
    IOUtils.stat = vi.fn(async () => ({ type: 'regular', size: 99999, lastModified: 1700000000000 }));
    // Hash function shouldn't be called on the disk file at all due to
    // the size pre-filter. We track every getFileHash call to confirm
    // — only the Zotero-storage hash should run (for the actual copy).
    getFileHash.mockClear();
    getFileHash.mockImplementation(async (p) => p);

    const store = await makeStore();
    const result = await runBaseline({ trackingStore: store });

    expect(result.reconciles).toBe(0);
    // The disk file (different size) was NEVER hashed.
    expect(getFileHash).not.toHaveBeenCalledWith('/watch/big-different.pdf');
    // Falls through to copy from Zotero storage.
    expect(IOUtils.copy).toHaveBeenCalledWith('/zotero-storage/ABC/paper.pdf', '/watch/Methods/paper.pdf');
  });

  it('adopts when disk size matches attachmentFileSize AND hash matches', async () => {
    const att = {
      id: 700, key: 'ATT1',
      attachmentFilename: 'paper.pdf',
      attachmentFileSize: 4096,
      isAttachment: () => true,
      parentItemID: null,
      getCollections: () => [],
      getFilePathAsync: vi.fn(async () => '/zotero-storage/ABC/paper.pdf'),
    };
    SYNC_ROOT.collection.getChildItems = () => [att];
    chooseCanonicalCollection.mockResolvedValue({ key: 'SUB1', libraryID: 1 });
    collectionKeyToRelativePath.mockImplementation(async (k) => (k === 'SUB1' ? 'Methods' : ''));

    IOUtils.exists.mockImplementation(async (p) => {
      if (p === '/watch/elsewhere/paper.pdf') return true;
      if (p === '/zotero-storage/ABC/paper.pdf') return true;
      return false;
    });
    scanFolderRecursive.mockResolvedValue([
      { path: '/watch/elsewhere/paper.pdf', name: 'paper.pdf' },
    ]);
    // Default IOUtils.stat returns size=4096 (matches attachmentFileSize).
    // Both Zotero and disk hash to SAMEHASH.
    getFileHash.mockResolvedValue('SAMEHASH');

    const store = await makeStore();
    const result = await runBaseline({ trackingStore: store });

    expect(result.reconciles).toBe(1);
    expect(IOUtils.copy).not.toHaveBeenCalled();
    const rec = store.getByAttachmentKey('ATT1');
    expect(rec.localPath).toBe('elsewhere/paper.pdf');
  });

  it('falls back to hashing all candidates when attachmentFileSize is null/undefined', async () => {
    // Legacy behavior: an attachment without a populated
    // attachmentFileSize still goes through the original hash-every-
    // candidate path. Documents the no-regression contract.
    const att = {
      id: 700, key: 'ATT1',
      attachmentFilename: 'paper.pdf',
      // attachmentFileSize intentionally omitted
      isAttachment: () => true,
      parentItemID: null,
      getCollections: () => [],
      getFilePathAsync: vi.fn(async () => '/zotero-storage/ABC/paper.pdf'),
    };
    SYNC_ROOT.collection.getChildItems = () => [att];
    chooseCanonicalCollection.mockResolvedValue({ key: 'SUB1', libraryID: 1 });
    collectionKeyToRelativePath.mockImplementation(async (k) => (k === 'SUB1' ? 'Methods' : ''));

    IOUtils.exists.mockImplementation(async (p) => {
      if (p === '/watch/x.pdf') return true;
      if (p === '/zotero-storage/ABC/paper.pdf') return true;
      return false;
    });
    scanFolderRecursive.mockResolvedValue([{ path: '/watch/x.pdf', name: 'x.pdf' }]);
    getFileHash.mockResolvedValue('SAMEHASH');

    const store = await makeStore();
    const result = await runBaseline({ trackingStore: store });

    // Still reconciles because the legacy hash-all-candidates path runs.
    expect(result.reconciles).toBe(1);
  });
});

// ─── UT-911 ────────────────────────────────────────────────────────────────

describe('UT-911: special collections are skipped during enumeration', () => {
  it('does not enumerate or copy from a virtual subcollection', async () => {
    const trash = { id: 555, key: 'TRSH', name: 'Trash', libraryID: 1, parentID: 100, getChildItems: () => [] };
    const sub = { id: 200, key: 'SUB1', name: 'Methods', libraryID: 1, parentID: 100, getChildItems: () => [] };
    SYNC_ROOT.collection.getChildItems = () => [];
    Zotero.Collections.getByParent.mockImplementation((parentID) => (parentID === 100 ? [trash, sub] : []));
    isSpecialCollection.mockImplementation((c) => c.key === 'TRSH');
    collectionKeyToRelativePath.mockImplementation(async (k) => (k === 'SUB1' ? 'Methods' : ''));

    const store = await makeStore();
    const result = await runBaseline({ trackingStore: store });

    expect(result.mkdirs).toBe(1); // only SUB1, not TRSH
    expect(store.getCollectionRecord('TRSH')).toBe(null);
  });
});
