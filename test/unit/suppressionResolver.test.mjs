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
 *   UT-812 (scanner re-import-loop guard via hasPath — file-level)
 *   UT-813 listSuppressedCollections + uninitialized-store tolerance
 *   UT-820 resolveCollection REINSTATE creates Zotero collection, updates record
 *   UT-821 resolveCollection KEEP_LOCAL flips collection to USER_DETACHED
 *   UT-822 resolveCollection TRASH moves folder to OS trash + drops record/children
 *   UT-823 resolveCollection MOVE_OUTSIDE recursive move + cross-FS fallback
 *   UT-824 resolveConflict RESTAMP_BASELINE re-hashes + state=CLEAN
 *   UT-825 resolveConflict DISCARD_LOCAL copies attachment file, re-hashes
 *   UT-826 resolveConflict PAUSE_SYNC flips to USER_DETACHED
 *   UT-827 rollback on save() failure restores state + reports warning
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
    relativePathToCollection: vi.fn(async () => ({ id: 1, key: 'COL1' })),
  };
});

import {
  resolve,
  resolveCollection,
  resolveConflict,
  listSuppressed,
  listMissing,
  stopTrackingMissing,
  RESOLUTION_ACTION,
  COLLECTION_RESOLUTION_ACTION,
  CONFLICT_RESOLUTION_ACTION,
} from '../../content/suppressionResolver.mjs';
import {
  TrackingStore,
  createFileRecord,
  createCollectionRecord,
  STATE,
} from '../../content/trackingStore.mjs';
import * as warningSink from '../../content/warningSink.mjs';

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

// ─── UT-820: resolveCollection REINSTATE ───────────────────────────────────

describe('UT-820: resolveCollection REINSTATE', () => {
  it('creates a new Zotero collection, updates record with new key + state=CLEAN', async () => {
    const store = await makeStore();
    store.add(createCollectionRecord({
      localPath: 'Methods/Sub', zoteroCollectionKey: 'OLD1',
      state: STATE.OUT_OF_SCOPE_SUPPRESSED,
    }));

    // Old key no longer resolves to a live collection.
    Zotero.Collections.getByLibraryAndKeyAsync = vi.fn(async () => null);
    const created = { id: 999, key: 'NEW1', name: '', libraryID: 1, save: vi.fn(async () => {}) };
    globalThis.Zotero.Collection = vi.fn(function () {
      Object.assign(this, created);
      created.save = this.save = vi.fn(async () => { this.key = 'NEW1'; });
      return this;
    });

    const rec = store.getCollectionRecord('OLD1');
    const result = await resolveCollection(rec, COLLECTION_RESOLUTION_ACTION.REINSTATE, {
      store, syncRoot: SYNC_ROOT_INFO,
    });
    expect(result.ok).toBe(true);
    expect(store.getCollectionRecord('OLD1')).toBe(null);
    const fresh = store.getCollectionRecord('NEW1');
    expect(fresh).toBeTruthy();
    expect(fresh.state).toBe(STATE.CLEAN);
    expect(fresh.parentCollectionKey).toBe('ROOT1');
  });

  it('re-links when the old key still resolves (user re-created in Zotero)', async () => {
    const store = await makeStore();
    store.add(createCollectionRecord({
      localPath: 'Methods/Sub', zoteroCollectionKey: 'OLD1',
      state: STATE.OUT_OF_SCOPE_SUPPRESSED,
    }));
    const live = { id: 42, key: 'OLD1', name: 'Sub' };
    Zotero.Collections.getByLibraryAndKeyAsync = vi.fn(async () => live);
    const ctorSpy = vi.fn();
    globalThis.Zotero.Collection = vi.fn(function () { ctorSpy(); });

    const rec = store.getCollectionRecord('OLD1');
    const result = await resolveCollection(rec, COLLECTION_RESOLUTION_ACTION.REINSTATE, {
      store, syncRoot: SYNC_ROOT_INFO,
    });
    expect(result.ok).toBe(true);
    expect(ctorSpy).not.toHaveBeenCalled();
    expect(store.getCollectionRecord('OLD1').state).toBe(STATE.CLEAN);
  });
});

// ─── UT-821: resolveCollection KEEP_LOCAL ──────────────────────────────────

describe('UT-821: resolveCollection KEEP_LOCAL', () => {
  it('flips collection state to USER_DETACHED, folder untouched', async () => {
    const store = await makeStore();
    store.add(createCollectionRecord({
      localPath: 'Topic', zoteroCollectionKey: 'CK',
      state: STATE.OUT_OF_SCOPE_SUPPRESSED,
    }));
    const rec = store.getCollectionRecord('CK');
    const result = await resolveCollection(rec, COLLECTION_RESOLUTION_ACTION.KEEP_LOCAL, { store });
    expect(result.ok).toBe(true);
    expect(store.getCollectionRecord('CK').state).toBe(STATE.USER_DETACHED);
    expect(IOUtils.move).not.toHaveBeenCalled();
    expect(IOUtils.remove).not.toHaveBeenCalled();
  });
});

// ─── UT-822: resolveCollection TRASH ───────────────────────────────────────

describe('UT-822: resolveCollection TRASH', () => {
  it('moves folder to OS trash, removes collection + child file records', async () => {
    const store = await makeStore();
    store.add(createCollectionRecord({
      localPath: 'Topic', zoteroCollectionKey: 'CK',
      state: STATE.OUT_OF_SCOPE_SUPPRESSED,
    }));
    // Two files under that folder + one outside.
    store.add(createFileRecord({
      localPath: 'Topic/a.pdf', zoteroAttachmentKey: 'A1',
      state: STATE.OUT_OF_SCOPE_SUPPRESSED,
    }));
    store.add(createFileRecord({
      localPath: 'Topic/sub/b.pdf', zoteroAttachmentKey: 'A2',
      state: STATE.OUT_OF_SCOPE_SUPPRESSED,
    }));
    store.add(createFileRecord({
      localPath: 'Other/c.pdf', zoteroAttachmentKey: 'A3', state: STATE.CLEAN,
    }));

    const fakeFile = { initWithPath: vi.fn(), moveToTrash: vi.fn() };
    Components.classes['@mozilla.org/file/local;1'].createInstance.mockReturnValue(fakeFile);

    const rec = store.getCollectionRecord('CK');
    const result = await resolveCollection(rec, COLLECTION_RESOLUTION_ACTION.TRASH, { store });
    expect(result.ok).toBe(true);
    expect(fakeFile.initWithPath).toHaveBeenCalledWith('/watch/Topic');
    expect(fakeFile.moveToTrash).toHaveBeenCalled();
    expect(store.getCollectionRecord('CK')).toBe(null);
    expect(store.getByLocalPath('Topic/a.pdf')).toBe(null);
    expect(store.getByLocalPath('Topic/sub/b.pdf')).toBe(null);
    expect(store.getByLocalPath('Other/c.pdf')).toBeTruthy();
  });

  it('returns io-error when nsIFile.moveToTrash throws', async () => {
    const store = await makeStore();
    store.add(createCollectionRecord({
      localPath: 'Topic', zoteroCollectionKey: 'CK',
      state: STATE.OUT_OF_SCOPE_SUPPRESSED,
    }));
    const fakeFile = {
      initWithPath: vi.fn(),
      moveToTrash: vi.fn(() => { throw new Error('EPERM'); }),
    };
    Components.classes['@mozilla.org/file/local;1'].createInstance.mockReturnValue(fakeFile);
    const rec = store.getCollectionRecord('CK');
    const result = await resolveCollection(rec, COLLECTION_RESOLUTION_ACTION.TRASH, { store });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('io-error');
    expect(store.getCollectionRecord('CK')).toBeTruthy();
  });
});

// ─── UT-823: resolveCollection MOVE_OUTSIDE ────────────────────────────────

describe('UT-823: resolveCollection MOVE_OUTSIDE', () => {
  it('rejects when no targetDir', async () => {
    const store = await makeStore();
    store.add(createCollectionRecord({
      localPath: 'Topic', zoteroCollectionKey: 'CK',
      state: STATE.OUT_OF_SCOPE_SUPPRESSED,
    }));
    const rec = store.getCollectionRecord('CK');
    const result = await resolveCollection(rec, COLLECTION_RESOLUTION_ACTION.MOVE_OUTSIDE, { store });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no-target-dir');
  });

  it('recursive move + drops collection + child records', async () => {
    const store = await makeStore();
    store.add(createCollectionRecord({
      localPath: 'Topic', zoteroCollectionKey: 'CK',
      state: STATE.OUT_OF_SCOPE_SUPPRESSED,
    }));
    store.add(createFileRecord({
      localPath: 'Topic/a.pdf', zoteroAttachmentKey: 'A1',
      state: STATE.OUT_OF_SCOPE_SUPPRESSED,
    }));
    const rec = store.getCollectionRecord('CK');
    const result = await resolveCollection(rec, COLLECTION_RESOLUTION_ACTION.MOVE_OUTSIDE, {
      store, targetDir: '/elsewhere',
    });
    expect(result.ok).toBe(true);
    expect(IOUtils.move).toHaveBeenCalledWith('/watch/Topic', '/elsewhere/Topic', expect.any(Object));
    expect(store.getCollectionRecord('CK')).toBe(null);
    expect(store.getByLocalPath('Topic/a.pdf')).toBe(null);
  });

  it('cross-FS fallback uses recursive copy + recursive remove', async () => {
    const store = await makeStore();
    store.add(createCollectionRecord({
      localPath: 'Topic', zoteroCollectionKey: 'CK',
      state: STATE.OUT_OF_SCOPE_SUPPRESSED,
    }));
    IOUtils.move.mockRejectedValueOnce(new Error('EXDEV'));
    const rec = store.getCollectionRecord('CK');
    const result = await resolveCollection(rec, COLLECTION_RESOLUTION_ACTION.MOVE_OUTSIDE, {
      store, targetDir: '/elsewhere',
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('copy-fallback');
    expect(IOUtils.copy).toHaveBeenCalledWith('/watch/Topic', '/elsewhere/Topic', expect.objectContaining({ recursive: true }));
    expect(IOUtils.remove).toHaveBeenCalledWith('/watch/Topic', expect.objectContaining({ recursive: true }));
  });
});

// ─── UT-824: resolveConflict RESTAMP_BASELINE ──────────────────────────────

describe('UT-824: resolveConflict RESTAMP_BASELINE', () => {
  it('re-hashes file, sets lastSyncedHash + state=CLEAN', async () => {
    const store = await makeStore();
    const rec = createFileRecord({
      localPath: 'p.pdf', zoteroAttachmentKey: 'A',
      lastSyncedHash: 'OLDHASH', state: STATE.CONFLICT_BLOCKED,
    });
    store.add(rec);
    IOUtils.exists.mockResolvedValue(true);
    // getFileHash uses IOUtils.read + crypto.subtle.digest (16-byte fake) →
    // deterministic hash from geckoMocks; sufficient for assertion.
    const result = await resolveConflict(rec, CONFLICT_RESOLUTION_ACTION.RESTAMP_BASELINE, { store });
    expect(result.ok).toBe(true);
    const updated = store.getByLocalPath('p.pdf');
    expect(updated.state).toBe(STATE.CLEAN);
    expect(updated.lastSyncedHash).not.toBe('OLDHASH');
    expect(updated.lastSyncedHash).toBeTruthy();
  });

  it('returns missing-file when the file is gone on disk', async () => {
    const store = await makeStore();
    const rec = createFileRecord({
      localPath: 'gone.pdf', zoteroAttachmentKey: 'A',
      lastSyncedHash: 'H', state: STATE.CONFLICT_BLOCKED,
    });
    store.add(rec);
    IOUtils.exists.mockResolvedValue(false);
    const result = await resolveConflict(rec, CONFLICT_RESOLUTION_ACTION.RESTAMP_BASELINE, { store });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('missing-file');
    expect(store.getByLocalPath('gone.pdf').state).toBe(STATE.CONFLICT_BLOCKED);
  });
});

// ─── UT-825: resolveConflict DISCARD_LOCAL ─────────────────────────────────

describe('UT-825: resolveConflict DISCARD_LOCAL', () => {
  it('copies attachment file over local, re-hashes, flips to CLEAN', async () => {
    const store = await makeStore();
    const rec = createFileRecord({
      localPath: 'p.pdf', zoteroAttachmentKey: 'ATT1',
      lastSyncedHash: 'OLDHASH', state: STATE.CONFLICT_BLOCKED,
    });
    store.add(rec);
    const attachment = {
      id: 5, key: 'ATT1',
      getFilePathAsync: vi.fn(async () => '/zotero/store/ATT1/p.pdf'),
    };
    Zotero.Items.getByLibraryAndKeyAsync.mockResolvedValue(attachment);
    const result = await resolveConflict(rec, CONFLICT_RESOLUTION_ACTION.DISCARD_LOCAL, {
      store, syncRoot: SYNC_ROOT_INFO,
    });
    expect(result.ok).toBe(true);
    expect(IOUtils.copy).toHaveBeenCalledWith('/zotero/store/ATT1/p.pdf', '/watch/p.pdf');
    const updated = store.getByLocalPath('p.pdf');
    expect(updated.state).toBe(STATE.CLEAN);
    expect(updated.lastSyncedHash).toBeTruthy();
    expect(updated.lastSyncedHash).not.toBe('OLDHASH');
  });

  it('returns attachment-missing when the attachment lookup yields nothing', async () => {
    const store = await makeStore();
    const rec = createFileRecord({
      localPath: 'p.pdf', zoteroAttachmentKey: 'GONE',
      state: STATE.CONFLICT_BLOCKED,
    });
    store.add(rec);
    Zotero.Items.getByLibraryAndKeyAsync.mockResolvedValue(null);
    const result = await resolveConflict(rec, CONFLICT_RESOLUTION_ACTION.DISCARD_LOCAL, {
      store, syncRoot: SYNC_ROOT_INFO,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('attachment-missing');
  });

  it('returns attachment-missing when getFilePathAsync returns nothing', async () => {
    const store = await makeStore();
    const rec = createFileRecord({
      localPath: 'p.pdf', zoteroAttachmentKey: 'A',
      state: STATE.CONFLICT_BLOCKED,
    });
    store.add(rec);
    Zotero.Items.getByLibraryAndKeyAsync.mockResolvedValue({
      key: 'A', getFilePathAsync: vi.fn(async () => null),
    });
    const result = await resolveConflict(rec, CONFLICT_RESOLUTION_ACTION.DISCARD_LOCAL, {
      store, syncRoot: SYNC_ROOT_INFO,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('attachment-missing');
  });
});

// ─── UT-826: resolveConflict PAUSE_SYNC ────────────────────────────────────

describe('UT-826: resolveConflict PAUSE_SYNC', () => {
  it('flips state to USER_DETACHED', async () => {
    const store = await makeStore();
    const rec = createFileRecord({
      localPath: 'p.pdf', zoteroAttachmentKey: 'A',
      state: STATE.CONFLICT_BLOCKED,
    });
    store.add(rec);
    const result = await resolveConflict(rec, CONFLICT_RESOLUTION_ACTION.PAUSE_SYNC, { store });
    expect(result.ok).toBe(true);
    expect(store.getByLocalPath('p.pdf').state).toBe(STATE.USER_DETACHED);
  });
});

// ─── UT-827: rollback on save() failure ────────────────────────────────────

describe('UT-827: rollback on save() failure', () => {
  it('_keepLocal: restores state + reports warning when save throws', async () => {
    const store = await makeStore();
    const rec = createFileRecord({
      localPath: 'a.pdf', zoteroAttachmentKey: 'A',
      state: STATE.OUT_OF_SCOPE_SUPPRESSED,
    });
    store.add(rec);

    const reportSpy = vi.spyOn(warningSink, 'report');
    const originalState = rec.state;
    store.save = vi.fn(async () => { throw new Error('EROFS'); });

    const result = await resolve(rec, RESOLUTION_ACTION.KEEP_LOCAL, { store });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('save-failed');
    expect(result.error).toMatch(/EROFS/);
    // Tracking-store state must have been restored.
    expect(store.getByLocalPath('a.pdf').state).toBe(originalState);
    expect(reportSpy).toHaveBeenCalledWith(expect.objectContaining({
      category: 'io-error',
      actionType: 'suppression-save',
    }));
    reportSpy.mockRestore();
  });

  it('_trash: restores tombstone+record when save throws after FS move', async () => {
    const store = await makeStore();
    const rec = createFileRecord({
      localPath: 'a.pdf', zoteroAttachmentKey: 'A',
      lastSyncedHash: 'h', state: STATE.OUT_OF_SCOPE_SUPPRESSED,
    });
    store.add(rec);
    store.save = vi.fn(async () => { throw new Error('EROFS'); });
    const result = await resolve(rec, RESOLUTION_ACTION.TRASH, { store });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('save-failed');
    // The tracking-store mutations must be rolled back even though the
    // file is already gone from disk.
    expect(store.getByLocalPath('a.pdf')).toBeTruthy();
    expect(store.getAllOfType('tombstone').length).toBe(0);
  });

  it('resolveCollection _keepLocalCollection: restores state on save failure', async () => {
    const store = await makeStore();
    store.add(createCollectionRecord({
      localPath: 'Topic', zoteroCollectionKey: 'CK',
      state: STATE.OUT_OF_SCOPE_SUPPRESSED,
    }));
    store.save = vi.fn(async () => { throw new Error('EROFS'); });
    const rec = store.getCollectionRecord('CK');
    const result = await resolveCollection(rec, COLLECTION_RESOLUTION_ACTION.KEEP_LOCAL, { store });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('save-failed');
    expect(store.getCollectionRecord('CK').state).toBe(STATE.OUT_OF_SCOPE_SUPPRESSED);
  });
});

// ─── UT-830/831: listTrashedFolders + restoreTrashedFolder (v2.2 Track D) ───

describe('UT-830: listTrashedFolders', () => {
  let listTrashedFolders;
  beforeEach(async () => {
    const mod = await import('../../content/suppressionResolver.mjs');
    listTrashedFolders = mod.listTrashedFolders;
    globalThis.IOUtils.exists = vi.fn(async () => true);
    globalThis.IOUtils.getChildren = vi.fn(async () => []);
    globalThis.IOUtils.stat = vi.fn(async () => ({ type: 'directory' }));
  });

  it('returns [] when watchRoot is unset', async () => {
    const res = await listTrashedFolders({ watchRoot: '' });
    expect(res).toEqual([]);
  });

  it('returns [] when plugin trash dir does not exist', async () => {
    globalThis.IOUtils.exists = vi.fn(async () => false);
    const res = await listTrashedFolders({ watchRoot: '/watch' });
    expect(res).toEqual([]);
  });

  it('lists directories (skipping files), stripping timestamp collision suffix into originalName', async () => {
    globalThis.IOUtils.getChildren = vi.fn(async () => [
      '/watch/.zotero-watch-trash/Methods',
      '/watch/.zotero-watch-trash/Methods.1779671312304',
      '/watch/.zotero-watch-trash/loose-file.pdf',
    ]);
    globalThis.IOUtils.stat = vi.fn(async (p) => ({
      type: p.endsWith('.pdf') ? 'regular' : 'directory',
    }));

    const res = await listTrashedFolders({ watchRoot: '/watch' });
    const names = res.map(e => e.name).sort();
    expect(names).toEqual(['Methods', 'Methods.1779671312304']);
    const suffixed = res.find(e => e.name === 'Methods.1779671312304');
    expect(suffixed.originalName).toBe('Methods');
    const plain = res.find(e => e.name === 'Methods');
    expect(plain.originalName).toBe('Methods');
  });
});

describe('UT-831: restoreTrashedFolder', () => {
  let restoreTrashedFolder;
  let canonicalPath;
  beforeEach(async () => {
    const mod = await import('../../content/suppressionResolver.mjs');
    restoreTrashedFolder = mod.restoreTrashedFolder;
    canonicalPath = await import('../../content/canonicalPath.mjs');
    canonicalPath.relativePathToCollection.mockResolvedValue({ id: 2, key: 'NEW' });
    globalThis.IOUtils.exists = vi.fn(async () => true);
    globalThis.IOUtils.move = vi.fn(async () => {});
    globalThis.IOUtils.copy = vi.fn(async () => {});
    globalThis.IOUtils.remove = vi.fn(async () => {});
  });

  it('rejects invalid entry', async () => {
    const r = await restoreTrashedFolder(null, { watchRoot: '/watch' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid-entry');
  });

  it('rejects when watchRoot is unset', async () => {
    const r = await restoreTrashedFolder({ name: 'Methods' }, { watchRoot: '' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no-watch-root');
  });

  it('returns trash-source-missing when the src does not exist', async () => {
    globalThis.IOUtils.exists = vi.fn(async () => false);
    const r = await restoreTrashedFolder({ name: 'Methods' }, { watchRoot: '/watch' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('trash-source-missing');
  });

  it('happy path: moves src → watchRoot/originalName + recreates collection', async () => {
    // Source exists; destination doesn't (no collision).
    globalThis.IOUtils.exists = vi.fn(async (p) =>
      p === '/watch/.zotero-watch-trash/Methods'
    );
    const r = await restoreTrashedFolder({ name: 'Methods', originalName: 'Methods' }, { watchRoot: '/watch' });
    expect(r.ok).toBe(true);
    expect(r.restoredTo).toBe('Methods');
    expect(globalThis.IOUtils.move).toHaveBeenCalledWith(
      '/watch/.zotero-watch-trash/Methods',
      '/watch/Methods'
    );
    expect(canonicalPath.relativePathToCollection).toHaveBeenCalledWith(
      'Methods', { createIfMissing: true }
    );
  });

  it('RST.6 collision: target exists → suffix .restored.<ts>', async () => {
    globalThis.IOUtils.exists = vi.fn(async () => true); // src + dst both exist
    const before = Date.now();
    const r = await restoreTrashedFolder({ name: 'Methods' }, { watchRoot: '/watch' });
    expect(r.ok).toBe(true);
    expect(r.restoredTo).toMatch(/^Methods\.restored\.\d+$/);
    const stamp = parseInt(r.restoredTo.match(/Methods\.restored\.(\d+)$/)[1], 10);
    expect(stamp).toBeGreaterThanOrEqual(before);
  });

  it('strips timestamp suffix from `name` when originalName is not provided', async () => {
    globalThis.IOUtils.exists = vi.fn(async (p) =>
      p === '/watch/.zotero-watch-trash/Methods.1779671312304'
    );
    const r = await restoreTrashedFolder({ name: 'Methods.1779671312304' }, { watchRoot: '/watch' });
    expect(r.ok).toBe(true);
    expect(r.restoredTo).toBe('Methods');
  });

  it('returns ok with `warning` when collection recreation fails', async () => {
    globalThis.IOUtils.exists = vi.fn(async (p) =>
      p === '/watch/.zotero-watch-trash/Methods'
    );
    canonicalPath.relativePathToCollection.mockRejectedValueOnce(new Error('boom'));
    const r = await restoreTrashedFolder({ name: 'Methods' }, { watchRoot: '/watch' });
    expect(r.ok).toBe(true);
    expect(r.warning).toMatch(/collection-recreate-failed/);
  });

  it('cross-FS fallback: IOUtils.move throws → copy + remove path runs', async () => {
    globalThis.IOUtils.exists = vi.fn(async (p) =>
      p === '/watch/.zotero-watch-trash/Methods'
    );
    globalThis.IOUtils.move = vi.fn(async () => { throw new Error('EXDEV'); });
    const r = await restoreTrashedFolder({ name: 'Methods' }, { watchRoot: '/watch' });
    expect(r.ok).toBe(true);
    expect(globalThis.IOUtils.copy).toHaveBeenCalled();
    expect(globalThis.IOUtils.remove).toHaveBeenCalled();
  });

  it('io-error: both move and copy fail → returns io-error + cleans dst', async () => {
    globalThis.IOUtils.exists = vi.fn(async (p) =>
      p === '/watch/.zotero-watch-trash/Methods'
    );
    globalThis.IOUtils.move = vi.fn(async () => { throw new Error('EXDEV'); });
    globalThis.IOUtils.copy = vi.fn(async () => { throw new Error('ENOSPC'); });
    const r = await restoreTrashedFolder({ name: 'Methods' }, { watchRoot: '/watch' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('io-error');
    expect(globalThis.IOUtils.remove).toHaveBeenCalledWith(
      '/watch/Methods',
      { recursive: true, ignoreAbsent: true }
    );
  });
});

// ─── UT-MISSING-1 (UX-MISSING-1 backend) ─────────────────────────────────────

describe('UT-MISSING-1: listMissing', () => {
  it('returns only MISSING file records', async () => {
    const store = await makeStore();
    store.add(createFileRecord({ localPath: 'clean.pdf', zoteroAttachmentKey: 'A', state: STATE.CLEAN }));
    store.add(createFileRecord({ localPath: 'm1.pdf', zoteroAttachmentKey: 'M1', state: STATE.MISSING }));
    store.add(createFileRecord({ localPath: 'm2.pdf', zoteroAttachmentKey: 'M2', state: STATE.MISSING }));
    store.add(createFileRecord({ localPath: 'sup.pdf', zoteroAttachmentKey: 'S', state: STATE.OUT_OF_SCOPE_SUPPRESSED }));
    const list = listMissing(store);
    expect(list.map((r) => r.zoteroAttachmentKey).sort()).toEqual(['M1', 'M2']);
  });

  it('tolerates an uninitialized / shapeless store (returns [])', async () => {
    expect(listMissing({})).toEqual([]);
    const store = new TrackingStore(); // not initialized → getMissingFiles throws
    expect(listMissing(store)).toEqual([]);
  });
});

describe('UT-MISSING-1: stopTrackingMissing is tracking-only', () => {
  it('removes the tracking record and persists it', async () => {
    const store = await makeStore();
    const rec = createFileRecord({
      localPath: 'm1.pdf', zoteroAttachmentKey: 'M1', zoteroItemKey: 'PA1',
      lastSyncedHash: 'h1', state: STATE.MISSING,
    });
    store.add(rec);
    const saveSpy = vi.spyOn(store, 'save');

    const result = await stopTrackingMissing('m1.pdf', { store });
    expect(result.ok).toBe(true);
    expect(store.getByLocalPath('m1.pdf')).toBe(null);
    expect(saveSpy).toHaveBeenCalled();
  });

  it('NEVER calls any Zotero item delete/trash/erase API', async () => {
    const store = await makeStore();
    const rec = createFileRecord({
      localPath: 'm1.pdf', zoteroAttachmentKey: 'M1', state: STATE.MISSING,
    });
    store.add(rec);

    // Instrument every plausible Zotero deletion entry-point so we can
    // prove the action is tracking-only.
    const deleted = vi.fn();
    const eraseTx = vi.fn(async () => {});
    const itemErase = vi.fn(async () => {});
    Zotero.Items.get = vi.fn(() => ({
      get deleted() { deleted(); return false; },
      set deleted(_v) { deleted(); },
      eraseTx,
      erase: itemErase,
      isInTrash: vi.fn(() => false),
    }));
    Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async () => ({
      eraseTx, erase: itemErase,
      set deleted(_v) { deleted(); },
    }));
    Zotero.Items.trashTx = vi.fn(async () => {});
    Zotero.Items.erase = vi.fn(async () => {});

    const result = await stopTrackingMissing('m1.pdf', { store });
    expect(result.ok).toBe(true);
    // The Zotero item must never be touched.
    expect(deleted).not.toHaveBeenCalled();
    expect(eraseTx).not.toHaveBeenCalled();
    expect(itemErase).not.toHaveBeenCalled();
    expect(Zotero.Items.trashTx).not.toHaveBeenCalled();
    expect(Zotero.Items.erase).not.toHaveBeenCalled();
    expect(Zotero.Items.getByLibraryAndKeyAsync).not.toHaveBeenCalled();
    expect(Zotero.Items.get).not.toHaveBeenCalled();
    // No tombstone either — this is a forget, not a soft-delete.
    expect(store.getAllOfType('tombstone').length).toBe(0);
  });

  it('rolls back (record restored) when save() fails', async () => {
    const store = await makeStore();
    const rec = createFileRecord({
      localPath: 'm1.pdf', zoteroAttachmentKey: 'M1', state: STATE.MISSING,
    });
    store.add(rec);
    vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('disk full'));

    const result = await stopTrackingMissing('m1.pdf', { store });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('save-failed');
    // Record restored by rollback.
    const restored = store.getByLocalPath('m1.pdf');
    expect(restored).toBeTruthy();
    expect(restored.state).toBe(STATE.MISSING);
    expect(restored.zoteroAttachmentKey).toBe('M1');
  });

  it('rejects a non-MISSING record (not-missing) and a missing path (invalid-record)', async () => {
    const store = await makeStore();
    store.add(createFileRecord({ localPath: 'clean.pdf', state: STATE.CLEAN }));
    expect((await stopTrackingMissing('clean.pdf', { store })).reason).toBe('not-missing');
    expect((await stopTrackingMissing('nope.pdf', { store })).reason).toBe('invalid-record');
    expect((await stopTrackingMissing('', { store })).reason).toBe('invalid-path');
  });
});
