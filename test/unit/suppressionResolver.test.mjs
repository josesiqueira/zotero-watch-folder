/**
 * Unit tests for content/suppressionResolver.mjs (v2.1 Phase B).
 *
 * Covers:
 *   UT-801 listSuppressed returns only OUT_OF_SCOPE_SUPPRESSED file records
 *   UT-802 resolve rejects invalid record / unknown action
 *   UT-803 REINSTATE adds parent to sync root, flips state, restores membership
 *   UT-804 REINSTATE falls back to attachment item when no parent
 *   UT-805 REINSTATE returns attachment-missing when lookup fails
 *   UT-806 KEEP_LOCAL flips state to USER_DETACHED (file stays on disk)
 *   UT-807 TRASH moves to OS trash + tombstones + removes record
 *   UT-808 TRASH IO failure returns io-error and does not tombstone
 *   UT-809 MOVE_OUTSIDE requires targetDir
 *   UT-810 MOVE_OUTSIDE happy path moves file + tombstones
 *   UT-811 MOVE_OUTSIDE cross-FS fallback uses copy+remove
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../content/utils.mjs', async () => {
  const actual = await vi.importActual('../../content/utils.mjs');
  return {
    ...actual,
    getPref: vi.fn((key) => ({ sourcePath: '/watch' }[key])),
  };
});
vi.mock('../../content/canonicalPath.mjs', async () => {
  const actual = await vi.importActual('../../content/canonicalPath.mjs');
  return {
    ...actual,
    resolveSyncRoot: vi.fn(),
  };
});

import {
  resolve,
  listSuppressed,
  RESOLUTION_ACTION,
} from '../../content/suppressionResolver.mjs';
import { TrackingStore, createFileRecord, STATE } from '../../content/trackingStore.mjs';

async function makeStore() {
  const store = new TrackingStore();
  store.dataFile = '/tmp/x.json';
  store._initialized = true;
  return store;
}

const SYNC_ROOT_INFO = {
  collection: { id: 100, key: 'ROOT1', name: 'Inbox', libraryID: 1 },
  libraryID: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  Zotero.debug = vi.fn();
  Zotero.logError = vi.fn();
  Zotero.DB = { executeTransaction: vi.fn(async (fn) => fn()) };
  Zotero.Items = { get: vi.fn(), getByLibraryAndKeyAsync: vi.fn() };
  IOUtils.exists = vi.fn(async () => true);
  IOUtils.move = vi.fn(async () => {});
  IOUtils.copy = vi.fn(async () => {});
  IOUtils.remove = vi.fn(async () => {});
  IOUtils.writeJSON = vi.fn(async () => {});
  // _moveToOSTrash uses Components.classes; fake nsIFile.moveToTrash
  globalThis.Components = {
    classes: {
      '@mozilla.org/file/local;1': {
        createInstance: vi.fn(() => ({
          initWithPath: vi.fn(),
          moveToTrash: vi.fn(),
        })),
      },
    },
    interfaces: { nsIFile: {} },
  };
});

// ─── UT-801 ────────────────────────────────────────────────────────────────

describe('UT-801: listSuppressed filters by state', () => {
  it('returns only file records with state OUT_OF_SCOPE_SUPPRESSED', async () => {
    const store = await makeStore();
    store.add(createFileRecord({ localPath: 'a.pdf', zoteroAttachmentKey: 'A', state: STATE.CLEAN }));
    store.add(createFileRecord({ localPath: 'b.pdf', zoteroAttachmentKey: 'B', state: STATE.OUT_OF_SCOPE_SUPPRESSED }));
    store.add(createFileRecord({ localPath: 'c.pdf', zoteroAttachmentKey: 'C', state: STATE.USER_DETACHED }));
    store.add(createFileRecord({ localPath: 'd.pdf', zoteroAttachmentKey: 'D', state: STATE.OUT_OF_SCOPE_SUPPRESSED }));
    const list = listSuppressed(store);
    expect(list.map((r) => r.zoteroAttachmentKey).sort()).toEqual(['B', 'D']);
  });
});

// ─── UT-802 ────────────────────────────────────────────────────────────────

describe('UT-802: resolve rejects invalid input', () => {
  it('rejects null record / wrong type', async () => {
    expect((await resolve(null, RESOLUTION_ACTION.TRASH, { store: await makeStore() })).reason).toBe('invalid-record');
    expect((await resolve({ type: 'collection' }, RESOLUTION_ACTION.TRASH, { store: await makeStore() })).reason).toBe('invalid-record');
  });

  it('rejects unknown action', async () => {
    const store = await makeStore();
    const rec = createFileRecord({ localPath: 'a.pdf', zoteroAttachmentKey: 'A', state: STATE.OUT_OF_SCOPE_SUPPRESSED });
    store.add(rec);
    const r = await resolve(rec, 'eat-it', { store });
    expect(r.reason).toBe('unknown-action');
  });
});

// ─── UT-803 ────────────────────────────────────────────────────────────────

describe('UT-803: REINSTATE happy path', () => {
  it('adds parent to sync root, flips state to CLEAN, restores membership', async () => {
    const store = await makeStore();
    const rec = createFileRecord({
      localPath: 'a.pdf', zoteroAttachmentKey: 'ATT1',
      canonicalCollectionKey: null,
      collectionMembershipKeys: [],
      state: STATE.OUT_OF_SCOPE_SUPPRESSED,
    });
    store.add(rec);

    const parent = {
      id: 700, key: 'PARENT',
      addToCollection: vi.fn(),
      save: vi.fn(async () => {}),
    };
    const attachment = { id: 701, key: 'ATT1', parentItemID: 700 };
    Zotero.Items.getByLibraryAndKeyAsync.mockResolvedValue(attachment);
    Zotero.Items.get.mockReturnValue(parent);

    const result = await resolve(rec, RESOLUTION_ACTION.REINSTATE, { store, syncRoot: SYNC_ROOT_INFO });
    expect(result.ok).toBe(true);
    expect(parent.addToCollection).toHaveBeenCalledWith(100);
    const updated = store.getByLocalPath('a.pdf');
    expect(updated.state).toBe(STATE.CLEAN);
    expect(updated.canonicalCollectionKey).toBe('ROOT1');
    expect(updated.collectionMembershipKeys).toEqual(['ROOT1']);
  });
});

// ─── UT-804 ────────────────────────────────────────────────────────────────

describe('UT-804: REINSTATE on standalone attachment', () => {
  it('uses the attachment itself when no parent', async () => {
    const store = await makeStore();
    const rec = createFileRecord({
      localPath: 'a.pdf', zoteroAttachmentKey: 'ATT1', state: STATE.OUT_OF_SCOPE_SUPPRESSED,
    });
    store.add(rec);
    const attachment = {
      id: 800, key: 'ATT1', parentItemID: null,
      addToCollection: vi.fn(),
      save: vi.fn(async () => {}),
    };
    Zotero.Items.getByLibraryAndKeyAsync.mockResolvedValue(attachment);

    const result = await resolve(rec, RESOLUTION_ACTION.REINSTATE, { store, syncRoot: SYNC_ROOT_INFO });
    expect(result.ok).toBe(true);
    expect(attachment.addToCollection).toHaveBeenCalledWith(100);
  });
});

// ─── UT-805 ────────────────────────────────────────────────────────────────

describe('UT-805: REINSTATE when attachment cannot be looked up', () => {
  it('returns attachment-missing', async () => {
    const store = await makeStore();
    const rec = createFileRecord({
      localPath: 'a.pdf', zoteroAttachmentKey: 'GONE', state: STATE.OUT_OF_SCOPE_SUPPRESSED,
    });
    store.add(rec);
    Zotero.Items.getByLibraryAndKeyAsync.mockResolvedValue(null);
    const result = await resolve(rec, RESOLUTION_ACTION.REINSTATE, { store, syncRoot: SYNC_ROOT_INFO });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('attachment-missing');
  });
});

// ─── UT-806 ────────────────────────────────────────────────────────────────

describe('UT-806: KEEP_LOCAL', () => {
  it('flips state to USER_DETACHED without touching disk', async () => {
    const store = await makeStore();
    const rec = createFileRecord({
      localPath: 'a.pdf', zoteroAttachmentKey: 'A', state: STATE.OUT_OF_SCOPE_SUPPRESSED,
    });
    store.add(rec);
    const result = await resolve(rec, RESOLUTION_ACTION.KEEP_LOCAL, { store });
    expect(result.ok).toBe(true);
    expect(store.getByLocalPath('a.pdf').state).toBe(STATE.USER_DETACHED);
    expect(IOUtils.move).not.toHaveBeenCalled();
    expect(IOUtils.remove).not.toHaveBeenCalled();
  });
});

// ─── UT-807 ────────────────────────────────────────────────────────────────

describe('UT-807: TRASH', () => {
  it('moves to OS trash, drops record, adds tombstone', async () => {
    const store = await makeStore();
    const rec = createFileRecord({
      localPath: 'a.pdf', canonicalLocalPath: 'a.pdf',
      zoteroAttachmentKey: 'A', zoteroItemKey: 'PA',
      lastSyncedHash: 'h1',
      state: STATE.OUT_OF_SCOPE_SUPPRESSED,
    });
    store.add(rec);

    const fakeFile = { initWithPath: vi.fn(), moveToTrash: vi.fn() };
    Components.classes['@mozilla.org/file/local;1'].createInstance.mockReturnValue(fakeFile);

    const result = await resolve(rec, RESOLUTION_ACTION.TRASH, { store });
    expect(result.ok).toBe(true);
    expect(fakeFile.initWithPath).toHaveBeenCalledWith('/watch/a.pdf');
    expect(fakeFile.moveToTrash).toHaveBeenCalled();
    expect(store.getByLocalPath('a.pdf')).toBe(null);
    const tombstones = store.getAllOfType('tombstone');
    expect(tombstones.length).toBe(1);
    expect(tombstones[0].zoteroAttachmentKey).toBe('A');
    expect(tombstones[0].originalHash).toBe('h1');
    expect(tombstones[0].deletedFrom).toBe('local');
  });
});

// ─── UT-808 ────────────────────────────────────────────────────────────────

describe('UT-808: TRASH on failed OS trash', () => {
  it('returns io-error and leaves the record intact', async () => {
    const store = await makeStore();
    const rec = createFileRecord({
      localPath: 'a.pdf', zoteroAttachmentKey: 'A',
      state: STATE.OUT_OF_SCOPE_SUPPRESSED,
    });
    store.add(rec);
    const fakeFile = {
      initWithPath: vi.fn(),
      moveToTrash: vi.fn(() => { throw new Error('EPERM'); }),
    };
    Components.classes['@mozilla.org/file/local;1'].createInstance.mockReturnValue(fakeFile);

    const result = await resolve(rec, RESOLUTION_ACTION.TRASH, { store });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('io-error');
    expect(store.getByLocalPath('a.pdf')).toBeTruthy();
    expect(store.getAllOfType('tombstone').length).toBe(0);
  });
});

// ─── UT-809 ────────────────────────────────────────────────────────────────

describe('UT-809: MOVE_OUTSIDE requires targetDir', () => {
  it('rejects when no targetDir provided', async () => {
    const store = await makeStore();
    const rec = createFileRecord({
      localPath: 'a.pdf', zoteroAttachmentKey: 'A',
      state: STATE.OUT_OF_SCOPE_SUPPRESSED,
    });
    store.add(rec);
    const result = await resolve(rec, RESOLUTION_ACTION.MOVE_OUTSIDE, { store });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no-target-dir');
  });
});

// ─── UT-810 ────────────────────────────────────────────────────────────────

describe('UT-810: MOVE_OUTSIDE happy path', () => {
  it('moves the file, removes the record, adds a tombstone', async () => {
    const store = await makeStore();
    const rec = createFileRecord({
      localPath: 'Methods/p.pdf', canonicalLocalPath: 'Methods/p.pdf',
      zoteroAttachmentKey: 'A', lastSyncedHash: 'h1',
      state: STATE.OUT_OF_SCOPE_SUPPRESSED,
    });
    store.add(rec);
    const result = await resolve(rec, RESOLUTION_ACTION.MOVE_OUTSIDE, { store, targetDir: '/home/user/Archive' });
    expect(result.ok).toBe(true);
    expect(IOUtils.move).toHaveBeenCalledWith('/watch/Methods/p.pdf', '/home/user/Archive/p.pdf', expect.any(Object));
    expect(store.getByLocalPath('Methods/p.pdf')).toBe(null);
    expect(store.getAllOfType('tombstone').length).toBe(1);
  });
});

// ─── UT-812 (re-import-loop guard) ─────────────────────────────────────────

describe('UT-812: scanner re-import-loop guard', () => {
  it('hasPath returns true for OUT_OF_SCOPE_SUPPRESSED records so the scanner skips them', async () => {
    const store = await makeStore();
    store.add(createFileRecord({
      localPath: 'Methods/p.pdf', zoteroAttachmentKey: 'A',
      state: STATE.OUT_OF_SCOPE_SUPPRESSED,
    }));
    expect(store.hasPath('Methods/p.pdf')).toBe(true);
    expect(store.getByLocalPath('Methods/p.pdf').state).toBe(STATE.OUT_OF_SCOPE_SUPPRESSED);
  });

  it('hasPath also returns true for USER_DETACHED records (post-keep-local)', async () => {
    const store = await makeStore();
    store.add(createFileRecord({
      localPath: 'a.pdf', zoteroAttachmentKey: 'A',
      state: STATE.USER_DETACHED,
    }));
    expect(store.hasPath('a.pdf')).toBe(true);
  });
});

// ─── UT-813 (review fix) ───────────────────────────────────────────────────

describe('UT-813: listSuppressedCollections + uninitialized-store tolerance', () => {
  it('returns suppressed CollectionRecords via listSuppressedCollections', async () => {
    const { listSuppressedCollections } = await import('../../content/suppressionResolver.mjs');
    const { createCollectionRecord } = await import('../../content/trackingStore.mjs');
    const store = await makeStore();
    store.add(createCollectionRecord({
      localPath: 'A', zoteroCollectionKey: 'A', state: STATE.OUT_OF_SCOPE_SUPPRESSED,
    }));
    store.add(createCollectionRecord({
      localPath: 'B', zoteroCollectionKey: 'B', state: STATE.CLEAN,
    }));
    const got = listSuppressedCollections(store);
    expect(got.map((r) => r.zoteroCollectionKey)).toEqual(['A']);
  });

  it('listSuppressed tolerates an uninitialized store (returns [])', async () => {
    const { listSuppressed } = await import('../../content/suppressionResolver.mjs');
    const { TrackingStore } = await import('../../content/trackingStore.mjs');
    const store = new TrackingStore();
    // Deliberately NOT initialized — getSuppressedFiles would throw.
    expect(listSuppressed(store)).toEqual([]);
  });
});

// ─── UT-811 ────────────────────────────────────────────────────────────────

describe('UT-811: MOVE_OUTSIDE cross-FS fallback', () => {
  it('falls back to copy + remove when move fails', async () => {
    const store = await makeStore();
    const rec = createFileRecord({
      localPath: 'p.pdf', zoteroAttachmentKey: 'A',
      state: STATE.OUT_OF_SCOPE_SUPPRESSED,
    });
    store.add(rec);
    IOUtils.move.mockRejectedValueOnce(new Error('EXDEV'));
    const result = await resolve(rec, RESOLUTION_ACTION.MOVE_OUTSIDE, { store, targetDir: '/elsewhere' });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('copy-fallback');
    expect(IOUtils.copy).toHaveBeenCalledWith('/watch/p.pdf', '/elsewhere/p.pdf');
    expect(IOUtils.remove).toHaveBeenCalledWith('/watch/p.pdf');
  });

  it('returns io-error and rolls back partial dest when copy also fails', async () => {
    const store = await makeStore();
    const rec = createFileRecord({
      localPath: 'p.pdf', zoteroAttachmentKey: 'A',
      state: STATE.OUT_OF_SCOPE_SUPPRESSED,
    });
    store.add(rec);
    IOUtils.move.mockRejectedValueOnce(new Error('EXDEV'));
    IOUtils.copy.mockRejectedValueOnce(new Error('ENOSPC'));
    const result = await resolve(rec, RESOLUTION_ACTION.MOVE_OUTSIDE, { store, targetDir: '/elsewhere' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('io-error');
    expect(IOUtils.remove).toHaveBeenCalledWith('/elsewhere/p.pdf', expect.objectContaining({ ignoreAbsent: true }));
    expect(store.getByLocalPath('p.pdf')).toBeTruthy(); // record kept
  });
});
