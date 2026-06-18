/**
 * Unit tests for content/trackingStore.mjs (v2 schema).
 *
 * Covers:
 *   UT-101 record factories (file / collection / tombstone defaults + overrides)
 *   UT-102 legacy createTrackingRecord alias
 *   UT-103 file-record CRUD (add / get / update / remove / hasPath)
 *   UT-104 key-based lookup (getByAttachmentKey, findByHash)
 *   UT-105 collection records (add / get / remove)
 *   UT-106 tombstone records (append-only)
 *   UT-107 getAllOfType / getAll
 *   UT-108 LRU eviction applies only to file records
 *   UT-109 persistence: save dirty / load v2 / refuse v1 / flush unconditional
 *   UT-110 state enum exported
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  TrackingStore,
  createFileRecord,
  createCollectionRecord,
  createTombstoneRecord,
  createTrackingRecord,
  resetTrackingStore,
  STATE,
} from '../../content/trackingStore.mjs';

/**
 * Make an initialised store without touching disk. `init()` would try to
 * resolve `Zotero.DataDirectory.dir` and load from disk; tests that need
 * persistence behaviour exercise `load()` / `save()` directly with a stub
 * dataFile path.
 */
function makeStore(maxFiles = 5000) {
  const store = new TrackingStore(maxFiles);
  store._initialized = true;
  return store;
}

// ─── UT-101 ────────────────────────────────────────────────────────────────

describe('UT-101: record factories', () => {
  it('createFileRecord supplies all required defaults', () => {
    const rec = createFileRecord({});
    expect(rec.type).toBe('file');
    expect(rec.localPath).toBe('');
    expect(rec.canonicalLocalPath).toBe('');
    expect(rec.lastSyncedHash).toBe(null);
    expect(rec.lastSyncedSize).toBe(0);
    expect(rec.lastSyncedMtime).toBe(0);
    expect(rec.zoteroItemKey).toBe(null);
    expect(rec.zoteroAttachmentKey).toBe('');
    expect(rec.canonicalCollectionKey).toBe(null);
    expect(rec.collectionMembershipKeys).toEqual([]);
    expect(rec.state).toBe(STATE.CLEAN);
    expect(new Date(rec.importDate).toISOString()).toBe(rec.importDate);
  });

  it('createFileRecord defaults canonicalLocalPath to localPath when omitted', () => {
    const rec = createFileRecord({ localPath: 'Methods/paper.pdf' });
    expect(rec.canonicalLocalPath).toBe('Methods/paper.pdf');
  });

  it('createFileRecord seeds collectionMembershipKeys from canonicalCollectionKey', () => {
    const rec = createFileRecord({ canonicalCollectionKey: 'ABC123' });
    expect(rec.collectionMembershipKeys).toEqual(['ABC123']);
  });

  it('createFileRecord copies collectionMembershipKeys (no shared reference)', () => {
    const keys = ['A', 'B'];
    const rec = createFileRecord({ collectionMembershipKeys: keys });
    keys.push('C');
    expect(rec.collectionMembershipKeys).toEqual(['A', 'B']);
  });

  it('createCollectionRecord defaults', () => {
    const rec = createCollectionRecord({ localPath: 'Methods', zoteroCollectionKey: 'COL1' });
    expect(rec.type).toBe('collection');
    expect(rec.localPath).toBe('Methods');
    expect(rec.zoteroCollectionKey).toBe('COL1');
    expect(rec.parentCollectionKey).toBe(null);
    expect(rec.state).toBe(STATE.CLEAN);
  });

  it('createTombstoneRecord defaults', () => {
    const rec = createTombstoneRecord({ localPath: 'paper.pdf' });
    expect(rec.type).toBe('tombstone');
    expect(rec.objectType).toBe('file');
    expect(rec.deletedFrom).toBe('zotero');
    expect(rec.state).toBe(STATE.RECOVERABLE);
    expect(new Date(rec.deletedAt).toISOString()).toBe(rec.deletedAt);
  });
});

// ─── UT-102 ────────────────────────────────────────────────────────────────

describe('UT-102: legacy createTrackingRecord alias', () => {
  it('produces a file record', () => {
    const rec = createTrackingRecord({ localPath: 'a.pdf' });
    expect(rec.type).toBe('file');
    expect(rec.localPath).toBe('a.pdf');
  });
});

// ─── UT-103 ────────────────────────────────────────────────────────────────

describe('UT-103: TrackingStore — file-record CRUD', () => {
  let store;
  beforeEach(() => {
    resetTrackingStore();
    store = makeStore();
  });

  it('add() + hasPath() + getByLocalPath()', () => {
    store.add(createFileRecord({ localPath: 'a.pdf', zoteroAttachmentKey: 'AK1' }));
    expect(store.hasPath('a.pdf')).toBe(true);
    const rec = store.getByLocalPath('a.pdf');
    expect(rec).not.toBeNull();
    expect(rec.zoteroAttachmentKey).toBe('AK1');
  });

  it('adding the same localPath twice keeps size at 1 (LRU move-to-end)', () => {
    store.add(createFileRecord({ localPath: 'a.pdf', lastSyncedHash: 'h1' }));
    store.add(createFileRecord({ localPath: 'a.pdf', lastSyncedHash: 'h2' }));
    expect(store.size).toBe(1);
    expect(store.getByLocalPath('a.pdf').lastSyncedHash).toBe('h2');
  });

  it('getByLocalPath returns null for unknown path', () => {
    expect(store.getByLocalPath('nope')).toBe(null);
  });

  it('update() applies partial changes', () => {
    store.add(createFileRecord({ localPath: 'a.pdf', state: STATE.PENDING }));
    store.update('a.pdf', { state: STATE.CLEAN });
    expect(store.getByLocalPath('a.pdf').state).toBe(STATE.CLEAN);
  });

  it('update() no-ops for unknown path', () => {
    expect(() => store.update('nope', { state: STATE.CLEAN })).not.toThrow();
  });

  it('remove() returns true and clears the record', () => {
    store.add(createFileRecord({ localPath: 'a.pdf' }));
    expect(store.remove('a.pdf')).toBe(true);
    expect(store.hasPath('a.pdf')).toBe(false);
  });

  it('remove() returns false for unknown path', () => {
    expect(store.remove('nope')).toBe(false);
  });

  it('clear() empties all collections', () => {
    store.add(createFileRecord({ localPath: 'a.pdf' }));
    store.add(createCollectionRecord({ localPath: 'Methods', zoteroCollectionKey: 'C1' }));
    store.addTombstone(createTombstoneRecord({ localPath: 'b.pdf' }));
    store.clear();
    expect(store.size).toBe(0);
    expect(store.getAllOfType('collection')).toHaveLength(0);
    expect(store.getAllOfType('tombstone')).toHaveLength(0);
  });
});

// ─── UT-104 ────────────────────────────────────────────────────────────────

describe('UT-104: TrackingStore — key-based lookup', () => {
  let store;
  beforeEach(() => { resetTrackingStore(); store = makeStore(); });

  it('getByAttachmentKey returns the matching file record', () => {
    store.add(createFileRecord({ localPath: 'a.pdf', zoteroAttachmentKey: 'AK1' }));
    store.add(createFileRecord({ localPath: 'b.pdf', zoteroAttachmentKey: 'AK2' }));
    const rec = store.getByAttachmentKey('AK2');
    expect(rec).not.toBeNull();
    expect(rec.localPath).toBe('b.pdf');
  });

  it('getByAttachmentKey returns null when no key supplied or no match', () => {
    expect(store.getByAttachmentKey('')).toBe(null);
    expect(store.getByAttachmentKey('AK-unknown')).toBe(null);
  });

  it('findByHash returns file records only — tombstones are excluded', () => {
    store.add(createFileRecord({ localPath: 'a.pdf', lastSyncedHash: 'H1' }));
    store.addTombstone(createTombstoneRecord({ localPath: 'b.pdf', originalHash: 'H1' }));
    const rec = store.findByHash('H1');
    expect(rec).not.toBeNull();
    expect(rec.type).toBe('file');
    expect(rec.localPath).toBe('a.pdf');
  });

  it('findByHash returns null for unknown hash', () => {
    expect(store.findByHash('NOPE')).toBe(null);
  });

  it('removeByAttachmentKey removes by key and updates indexes', () => {
    store.add(createFileRecord({ localPath: 'a.pdf', zoteroAttachmentKey: 'AK1', lastSyncedHash: 'H1' }));
    expect(store.removeByAttachmentKey('AK1')).toBe(true);
    expect(store.getByLocalPath('a.pdf')).toBe(null);
    expect(store.getByAttachmentKey('AK1')).toBe(null);
    expect(store.findByHash('H1')).toBe(null);
  });

  it('indexes are maintained after update()', () => {
    store.add(createFileRecord({ localPath: 'a.pdf', zoteroAttachmentKey: 'AK1', lastSyncedHash: 'H1' }));
    store.update('a.pdf', { lastSyncedHash: 'H2' });
    expect(store.findByHash('H1')).toBe(null);
    expect(store.findByHash('H2')?.localPath).toBe('a.pdf');
  });

  // ─── UT-107: tombstone queries (v2.2 restore matrix support) ──────────────

  it('findTombstoneByHash returns the most-recent recoverable tombstone', () => {
    store.addTombstone(createTombstoneRecord({
      localPath: 'old.pdf', zoteroAttachmentKey: 'AK1', originalHash: 'H1',
      deletedAt: '2026-05-01T00:00:00Z',
    }));
    store.addTombstone(createTombstoneRecord({
      localPath: 'new.pdf', zoteroAttachmentKey: 'AK2', originalHash: 'H1',
      deletedAt: '2026-05-25T00:00:00Z',
    }));
    const t = store.findTombstoneByHash('H1');
    expect(t).not.toBeNull();
    expect(t.zoteroAttachmentKey).toBe('AK2');
  });

  it('findTombstoneByHash returns null for unknown hash or empty/null input', () => {
    store.addTombstone(createTombstoneRecord({ localPath: 'x.pdf', originalHash: 'H1' }));
    expect(store.findTombstoneByHash('')).toBe(null);
    expect(store.findTombstoneByHash(null)).toBe(null);
    expect(store.findTombstoneByHash('UNKNOWN')).toBe(null);
  });

  it('findTombstoneByHash excludes non-recoverable tombstones', () => {
    store.addTombstone(createTombstoneRecord({
      localPath: 'x.pdf', originalHash: 'H1', state: 'recoverable',
    }));
    store.addTombstone(createTombstoneRecord({
      localPath: 'y.pdf', originalHash: 'H1', state: 'expired',
    }));
    const t = store.findTombstoneByHash('H1');
    expect(t.localPath).toBe('x.pdf');
  });

  it('findTombstoneByAttachmentKey returns the matching tombstone', () => {
    store.addTombstone(createTombstoneRecord({ localPath: 'a.pdf', zoteroAttachmentKey: 'AK1' }));
    store.addTombstone(createTombstoneRecord({ localPath: 'b.pdf', zoteroAttachmentKey: 'AK2' }));
    expect(store.findTombstoneByAttachmentKey('AK1').localPath).toBe('a.pdf');
    expect(store.findTombstoneByAttachmentKey('AK2').localPath).toBe('b.pdf');
    expect(store.findTombstoneByAttachmentKey('UNKNOWN')).toBe(null);
    expect(store.findTombstoneByAttachmentKey('')).toBe(null);
  });

  it('removeTombstoneByAttachmentKey removes ALL matching tombstones and dirties the store', () => {
    store.addTombstone(createTombstoneRecord({ localPath: 'a.pdf', zoteroAttachmentKey: 'AK1' }));
    store.addTombstone(createTombstoneRecord({ localPath: 'a-copy.pdf', zoteroAttachmentKey: 'AK1' }));
    store.addTombstone(createTombstoneRecord({ localPath: 'b.pdf', zoteroAttachmentKey: 'AK2' }));
    store._dirty = false;
    const removed = store.removeTombstoneByAttachmentKey('AK1');
    expect(removed).toBe(2);
    expect(store.getAllOfType('tombstone')).toHaveLength(1);
    expect(store.isDirty).toBe(true);
  });

  it('removeTombstoneByAttachmentKey returns 0 (and does NOT dirty) when nothing matches', () => {
    store.addTombstone(createTombstoneRecord({ localPath: 'a.pdf', zoteroAttachmentKey: 'AK1' }));
    store._dirty = false;
    expect(store.removeTombstoneByAttachmentKey('UNKNOWN')).toBe(0);
    expect(store.isDirty).toBe(false);
  });
});

// ─── UT-105 ────────────────────────────────────────────────────────────────

describe('UT-105: TrackingStore — collection records', () => {
  let store;
  beforeEach(() => { resetTrackingStore(); store = makeStore(); });

  it('addCollection then getCollectionRecord', () => {
    store.add(createCollectionRecord({ localPath: 'Methods', zoteroCollectionKey: 'COL1' }));
    const rec = store.getCollectionRecord('COL1');
    expect(rec).not.toBeNull();
    expect(rec.type).toBe('collection');
    expect(rec.localPath).toBe('Methods');
  });

  it('getCollectionRecord returns null for unknown key', () => {
    expect(store.getCollectionRecord('NOPE')).toBe(null);
  });

  it('removeCollectionRecord clears the record', () => {
    store.add(createCollectionRecord({ localPath: 'M', zoteroCollectionKey: 'COL1' }));
    expect(store.removeCollectionRecord('COL1')).toBe(true);
    expect(store.getCollectionRecord('COL1')).toBe(null);
  });

  it('collection records do NOT affect file-record size counter', () => {
    store.add(createCollectionRecord({ localPath: 'M', zoteroCollectionKey: 'COL1' }));
    expect(store.size).toBe(0); // size counts files only
  });
});

// ─── UT-106 ────────────────────────────────────────────────────────────────

describe('UT-106: TrackingStore — tombstone records', () => {
  let store;
  beforeEach(() => { resetTrackingStore(); store = makeStore(); });

  it('addTombstone appends and does not deduplicate', () => {
    store.addTombstone(createTombstoneRecord({ localPath: 'a.pdf', deletedFrom: 'zotero' }));
    store.addTombstone(createTombstoneRecord({ localPath: 'a.pdf', deletedFrom: 'local' }));
    expect(store.getAllOfType('tombstone')).toHaveLength(2);
  });

  it('non-tombstone object handed to addTombstone is rejected (logged + skipped)', () => {
    store.addTombstone({ type: 'file', localPath: 'oops' });
    expect(store.getAllOfType('tombstone')).toHaveLength(0);
  });

  it('add() dispatches a tombstone-typed record to addTombstone', () => {
    store.add(createTombstoneRecord({ localPath: 'a.pdf' }));
    expect(store.getAllOfType('tombstone')).toHaveLength(1);
  });
});

// ─── UT-107 ────────────────────────────────────────────────────────────────

describe('UT-107: TrackingStore — getAllOfType and getAll', () => {
  let store;
  beforeEach(() => { resetTrackingStore(); store = makeStore(); });

  it('getAllOfType returns only records of the requested type', () => {
    store.add(createFileRecord({ localPath: 'a.pdf' }));
    store.add(createCollectionRecord({ localPath: 'M', zoteroCollectionKey: 'COL1' }));
    store.addTombstone(createTombstoneRecord({ localPath: 'b.pdf' }));
    expect(store.getAllOfType('file')).toHaveLength(1);
    expect(store.getAllOfType('collection')).toHaveLength(1);
    expect(store.getAllOfType('tombstone')).toHaveLength(1);
    expect(store.getAllOfType('unknown')).toEqual([]);
  });

  it('getAll concatenates all three primary collections', () => {
    store.add(createFileRecord({ localPath: 'a.pdf' }));
    store.add(createCollectionRecord({ localPath: 'M', zoteroCollectionKey: 'COL1' }));
    store.addTombstone(createTombstoneRecord({ localPath: 'b.pdf' }));
    expect(store.getAll()).toHaveLength(3);
  });

  it('add() with unknown type is rejected', () => {
    store.add({ type: 'weirdo', localPath: 'x' });
    expect(store.getAll()).toHaveLength(0);
  });
});

// ─── UT-108 ────────────────────────────────────────────────────────────────

describe('UT-108: TrackingStore — LRU eviction (file records only)', () => {
  it('evicts the oldest file when maxFiles is exceeded', () => {
    const store = makeStore(3);
    store.add(createFileRecord({ localPath: 'a' }));
    store.add(createFileRecord({ localPath: 'b' }));
    store.add(createFileRecord({ localPath: 'c' }));
    expect(store.size).toBe(3);
    store.add(createFileRecord({ localPath: 'd' }));
    expect(store.size).toBe(3);
    expect(store.hasPath('a')).toBe(false);
    expect(store.hasPath('b')).toBe(true);
    expect(store.hasPath('c')).toBe(true);
    expect(store.hasPath('d')).toBe(true);
  });

  it('LRU eviction does NOT touch collection or tombstone records', () => {
    const store = makeStore(1);
    store.add(createCollectionRecord({ localPath: 'M', zoteroCollectionKey: 'COL1' }));
    store.addTombstone(createTombstoneRecord({ localPath: 'gone.pdf' }));
    store.add(createFileRecord({ localPath: 'a' }));
    store.add(createFileRecord({ localPath: 'b' }));
    expect(store.size).toBe(1); // files: only 'b' (a evicted)
    expect(store.getAllOfType('collection')).toHaveLength(1);
    expect(store.getAllOfType('tombstone')).toHaveLength(1);
  });
});

// ─── UT-109 ────────────────────────────────────────────────────────────────

describe('UT-109: TrackingStore — persistence', () => {
  beforeEach(() => {
    resetTrackingStore();
    // Reset IO mocks for predictable behaviour.
    globalThis.IOUtils.writeJSON.mockClear();
    globalThis.IOUtils.readJSON.mockClear();
    globalThis.IOUtils.exists.mockClear();
  });

  it('save() writes a v2 envelope and clears the dirty flag', async () => {
    const store = makeStore();
    store.dataFile = '/fake/tracking.json';
    store.add(createFileRecord({ localPath: 'a.pdf' }));
    expect(store.isDirty).toBe(true);
    await store.save();
    expect(globalThis.IOUtils.writeJSON).toHaveBeenCalledTimes(1);
    const [path, data] = globalThis.IOUtils.writeJSON.mock.calls[0];
    expect(path).toBe('/fake/tracking.json');
    expect(data.version).toBe(2);
    expect(data.files).toHaveLength(1);
    expect(data.files[0].localPath).toBe('a.pdf');
    expect(store.isDirty).toBe(false);
  });

  it('save() is a no-op when not dirty', async () => {
    const store = makeStore();
    store.dataFile = '/fake/tracking.json';
    await store.save();
    expect(globalThis.IOUtils.writeJSON).not.toHaveBeenCalled();
  });

  it('flush() saves unconditionally even if not dirty', async () => {
    const store = makeStore();
    store.dataFile = '/fake/tracking.json';
    store.add(createFileRecord({ localPath: 'a.pdf' }));
    await store.save();
    globalThis.IOUtils.writeJSON.mockClear();
    await store.flush();
    expect(globalThis.IOUtils.writeJSON).toHaveBeenCalledTimes(1);
  });

  it('load() refuses to load a v1 file (returns empty)', async () => {
    const store = makeStore();
    store.dataFile = '/fake/tracking.json';
    globalThis.IOUtils.exists.mockResolvedValueOnce(true);
    globalThis.IOUtils.readJSON.mockResolvedValueOnce({
      version: 1,
      records: [{ path: '/x', hash: 'abc' }],
    });
    await store.load();
    expect(store.size).toBe(0);
    expect(store.getAll()).toHaveLength(0);
  });

  it('load() reads a v2 envelope back into typed records', async () => {
    const store = makeStore();
    store.dataFile = '/fake/tracking.json';
    globalThis.IOUtils.exists.mockResolvedValueOnce(true);
    globalThis.IOUtils.readJSON.mockResolvedValueOnce({
      version: 2,
      lastSaved: '2026-01-01T00:00:00.000Z',
      files: [createFileRecord({ localPath: 'a.pdf', lastSyncedHash: 'H1', zoteroAttachmentKey: 'AK1' })],
      collections: [createCollectionRecord({ localPath: 'M', zoteroCollectionKey: 'COL1' })],
      tombstones: [createTombstoneRecord({ localPath: 'b.pdf' })],
    });
    await store.load();
    expect(store.getByLocalPath('a.pdf')?.lastSyncedHash).toBe('H1');
    expect(store.getCollectionRecord('COL1')?.localPath).toBe('M');
    expect(store.getAllOfType('tombstone')).toHaveLength(1);
    // Indexes rebuilt:
    expect(store.findByHash('H1')?.localPath).toBe('a.pdf');
    expect(store.getByAttachmentKey('AK1')?.localPath).toBe('a.pdf');
  });

  it('load() with no file on disk leaves the store empty', async () => {
    const store = makeStore();
    store.dataFile = '/fake/tracking.json';
    globalThis.IOUtils.exists.mockResolvedValueOnce(false);
    await store.load();
    expect(store.size).toBe(0);
    expect(globalThis.IOUtils.readJSON).not.toHaveBeenCalled();
  });

  // ── Proto-pollution hygiene (security audit 2026-05-27) ──────────────
  it('load() strips __proto__ from persisted records before insertion', async () => {
    const store = makeStore();
    store.dataFile = '/fake/tracking.json';
    globalThis.IOUtils.exists.mockResolvedValueOnce(true);
    // Build a record with a own-property `__proto__` (mimics what JSON.parse
    // of a malicious tracking file would produce per ES2018+ spec).
    const polluted = createFileRecord({ localPath: 'a.pdf', lastSyncedHash: 'H1', zoteroAttachmentKey: 'AK1' });
    Object.defineProperty(polluted, '__proto__', {
      value: { polluted: 'YES' },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    globalThis.IOUtils.readJSON.mockResolvedValueOnce({
      version: 2,
      lastSaved: '2026-01-01T00:00:00.000Z',
      files: [polluted],
      collections: [],
      tombstones: [],
    });
    await store.load();
    const rec = store.getByLocalPath('a.pdf');
    expect(rec).toBeTruthy();
    expect(Object.prototype.hasOwnProperty.call(rec, '__proto__')).toBe(false);
    // And the real record fields are preserved
    expect(rec.lastSyncedHash).toBe('H1');
    expect(rec.zoteroAttachmentKey).toBe('AK1');
    // Object.prototype not polluted
    const fresh = {};
    expect(fresh.polluted).toBeUndefined();
  });
});

// ─── UT-110 ────────────────────────────────────────────────────────────────

describe('UT-110: STATE enum', () => {
  it('exposes all documented values', () => {
    expect(STATE.CLEAN).toBe('clean');
    expect(STATE.PENDING).toBe('pending');
    expect(STATE.MISSING).toBe('missing');
    expect(STATE.PAUSED).toBe('paused');
    expect(STATE.RECOVERABLE).toBe('recoverable');
    expect(STATE.OUT_OF_SCOPE_SUPPRESSED).toBe('out-of-scope-suppressed');
    expect(STATE.CONFLICT_BLOCKED).toBe('conflict-blocked');
    expect(STATE.CONFLICT_REFUSED).toBe('conflict-refused');
    expect(STATE.PENDING_ZOTERO_FILE).toBe('pending-zotero-file');
    expect(STATE.EXTERNAL_EDIT).toBe('external-edit');
    expect(STATE.PENDING_HYDRATION).toBe('pending-hydration');
    expect(STATE.MISSING_FILE).toBe('missing-file');
  });

  it('is frozen (immutable)', () => {
    expect(Object.isFrozen(STATE)).toBe(true);
  });

  it('includes USER_DETACHED for Phase B KEEP_LOCAL', () => {
    expect(STATE.USER_DETACHED).toBe('user-detached');
  });
});

// ─── UT-111 ────────────────────────────────────────────────────────────────

describe('UT-111: findByHash filters out non-syncing states (review fix)', () => {
  it('returns null when the matching record is USER_DETACHED', async () => {
    const { TrackingStore, createFileRecord } = await import('../../content/trackingStore.mjs');
    const store = new TrackingStore();
    store.dataFile = '/tmp/x.json';
    store._initialized = true;
    store.add(createFileRecord({
      localPath: 'a.pdf', zoteroAttachmentKey: 'A',
      lastSyncedHash: 'HASHZ', state: STATE.USER_DETACHED,
    }));
    expect(store.findByHash('HASHZ')).toBe(null);
  });

  it('returns null when the matching record is OUT_OF_SCOPE_SUPPRESSED', async () => {
    const { TrackingStore, createFileRecord } = await import('../../content/trackingStore.mjs');
    const store = new TrackingStore();
    store.dataFile = '/tmp/x.json';
    store._initialized = true;
    store.add(createFileRecord({
      localPath: 'a.pdf', zoteroAttachmentKey: 'A',
      lastSyncedHash: 'HASHZ', state: STATE.OUT_OF_SCOPE_SUPPRESSED,
    }));
    expect(store.findByHash('HASHZ')).toBe(null);
  });

  it('still returns the record for CLEAN state', async () => {
    const { TrackingStore, createFileRecord } = await import('../../content/trackingStore.mjs');
    const store = new TrackingStore();
    store.dataFile = '/tmp/x.json';
    store._initialized = true;
    store.add(createFileRecord({
      localPath: 'a.pdf', zoteroAttachmentKey: 'A',
      lastSyncedHash: 'HASHZ', state: STATE.CLEAN,
    }));
    expect(store.findByHash('HASHZ')).toBeTruthy();
  });

  it('still surfaces detached records via attachment-key lookup', async () => {
    const { TrackingStore, createFileRecord } = await import('../../content/trackingStore.mjs');
    const store = new TrackingStore();
    store.dataFile = '/tmp/x.json';
    store._initialized = true;
    store.add(createFileRecord({
      localPath: 'a.pdf', zoteroAttachmentKey: 'A',
      lastSyncedHash: 'HASHZ', state: STATE.USER_DETACHED,
    }));
    expect(store.getByAttachmentKey('A')).toBeTruthy();
  });
});

// ─── UT-113 (review fix B8) ────────────────────────────────────────────────

describe('UT-113: getConflictedFiles', () => {
  it('returns only file records in CONFLICT_BLOCKED state', async () => {
    const { TrackingStore, createFileRecord } = await import('../../content/trackingStore.mjs');
    const store = new TrackingStore();
    store.dataFile = '/tmp/x.json';
    store._initialized = true;
    store.add(createFileRecord({
      localPath: 'a.pdf', zoteroAttachmentKey: 'A', state: STATE.CLEAN,
    }));
    store.add(createFileRecord({
      localPath: 'b.pdf', zoteroAttachmentKey: 'B', state: STATE.CONFLICT_BLOCKED,
    }));
    store.add(createFileRecord({
      localPath: 'c.pdf', zoteroAttachmentKey: 'C', state: STATE.CONFLICT_BLOCKED,
    }));
    expect(store.getConflictedFiles().map((r) => r.zoteroAttachmentKey).sort()).toEqual(['B', 'C']);
  });
});

// ─── UT-MISSING-1 (UX-MISSING-1 backend) ─────────────────────────────────────

describe('UT-MISSING-1: getMissingFiles', () => {
  it('returns only file records in MISSING state; excludes clean/suppressed/conflicted', async () => {
    const { TrackingStore, createFileRecord } = await import('../../content/trackingStore.mjs');
    const store = new TrackingStore();
    store.dataFile = '/tmp/x.json';
    store._initialized = true;
    store.add(createFileRecord({
      localPath: 'clean.pdf', zoteroAttachmentKey: 'A', state: STATE.CLEAN,
    }));
    store.add(createFileRecord({
      localPath: 'missing1.pdf', zoteroAttachmentKey: 'M1', state: STATE.MISSING,
    }));
    store.add(createFileRecord({
      localPath: 'missing2.pdf', zoteroAttachmentKey: 'M2', state: STATE.MISSING,
    }));
    store.add(createFileRecord({
      localPath: 'suppressed.pdf', zoteroAttachmentKey: 'S', state: STATE.OUT_OF_SCOPE_SUPPRESSED,
    }));
    store.add(createFileRecord({
      localPath: 'conflicted.pdf', zoteroAttachmentKey: 'C', state: STATE.CONFLICT_BLOCKED,
    }));
    expect(store.getMissingFiles().map((r) => r.zoteroAttachmentKey).sort()).toEqual(['M1', 'M2']);
  });

  it('returns an empty array when no records are MISSING', async () => {
    const { TrackingStore, createFileRecord } = await import('../../content/trackingStore.mjs');
    const store = new TrackingStore();
    store.dataFile = '/tmp/x.json';
    store._initialized = true;
    store.add(createFileRecord({ localPath: 'clean.pdf', state: STATE.CLEAN }));
    expect(store.getMissingFiles()).toEqual([]);
  });
});

// ─── UT-112 ────────────────────────────────────────────────────────────────

describe('UT-112: getSuppressedCollections', () => {
  it('returns only collection records in OUT_OF_SCOPE_SUPPRESSED state', async () => {
    const { TrackingStore, createCollectionRecord } = await import('../../content/trackingStore.mjs');
    const store = new TrackingStore();
    store.dataFile = '/tmp/x.json';
    store._initialized = true;
    store.add(createCollectionRecord({ localPath: 'A', zoteroCollectionKey: 'A', state: STATE.CLEAN }));
    store.add(createCollectionRecord({ localPath: 'B', zoteroCollectionKey: 'B', state: STATE.OUT_OF_SCOPE_SUPPRESSED }));
    store.add(createCollectionRecord({ localPath: 'C', zoteroCollectionKey: 'C', state: STATE.OUT_OF_SCOPE_SUPPRESSED }));
    const got = store.getSuppressedCollections();
    expect(got.map((r) => r.zoteroCollectionKey).sort()).toEqual(['B', 'C']);
  });
});

// ─── UT-114 (WP-B / B1) ─────────────────────────────────────────────────────

describe('UT-114: tombstone indexes (WP-B / B1)', () => {
  let store;
  beforeEach(() => {
    resetTrackingStore();
    store = makeStore();
  });

  it('findTombstoneByHash uses the bucket index and returns the most recent recoverable', () => {
    store.addTombstone(createTombstoneRecord({
      localPath: 'old.pdf', zoteroAttachmentKey: 'AK1', originalHash: 'HX',
      deletedAt: '2026-05-01T00:00:00Z',
    }));
    store.addTombstone(createTombstoneRecord({
      localPath: 'new.pdf', zoteroAttachmentKey: 'AK2', originalHash: 'HX',
      deletedAt: '2026-05-20T00:00:00Z',
    }));
    // Confirm the index map is populated (white-box: the optimization
    // exists). Bucket-list length is 2 because both tombstones share HX.
    expect(store._tombstonesByHash.get('HX')).toHaveLength(2);
    const t = store.findTombstoneByHash('HX');
    expect(t.zoteroAttachmentKey).toBe('AK2');
  });

  it('findTombstoneByAttachmentKey returns the first recoverable from the bucket', () => {
    store.addTombstone(createTombstoneRecord({
      localPath: 'a.pdf', zoteroAttachmentKey: 'AK1',
    }));
    expect(store._tombstonesByAttachmentKey.get('AK1')).toHaveLength(1);
    const t = store.findTombstoneByAttachmentKey('AK1');
    expect(t.localPath).toBe('a.pdf');
  });

  it('removeTombstoneByAttachmentKey deletes the attachment-key bucket and updates hash buckets', () => {
    store.addTombstone(createTombstoneRecord({
      localPath: 'a.pdf', zoteroAttachmentKey: 'AK1', originalHash: 'H1',
    }));
    store.addTombstone(createTombstoneRecord({
      localPath: 'a-copy.pdf', zoteroAttachmentKey: 'AK1', originalHash: 'H1',
    }));
    store.addTombstone(createTombstoneRecord({
      localPath: 'b.pdf', zoteroAttachmentKey: 'AK2', originalHash: 'H2',
    }));
    store.removeTombstoneByAttachmentKey('AK1');
    expect(store._tombstonesByAttachmentKey.has('AK1')).toBe(false);
    // AK2 survives
    expect(store._tombstonesByAttachmentKey.get('AK2')).toHaveLength(1);
    // H1 bucket now empty → deleted from index map entirely.
    expect(store._tombstonesByHash.has('H1')).toBe(false);
    // H2 survives.
    expect(store._tombstonesByHash.get('H2')).toHaveLength(1);
  });

  it('removeTombstoneByAttachmentKey preserves hash bucket when other AKs share the hash', () => {
    store.addTombstone(createTombstoneRecord({
      localPath: 'a.pdf', zoteroAttachmentKey: 'AK1', originalHash: 'SHARED',
    }));
    store.addTombstone(createTombstoneRecord({
      localPath: 'b.pdf', zoteroAttachmentKey: 'AK2', originalHash: 'SHARED',
    }));
    store.removeTombstoneByAttachmentKey('AK1');
    const remaining = store._tombstonesByHash.get('SHARED');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].zoteroAttachmentKey).toBe('AK2');
  });

  it('load() rebuilds tombstone indexes', async () => {
    const store2 = makeStore();
    store2.dataFile = '/fake/tracking.json';
    globalThis.IOUtils.exists.mockResolvedValueOnce(true);
    globalThis.IOUtils.readJSON.mockResolvedValueOnce({
      version: 2,
      lastSaved: '2026-01-01T00:00:00.000Z',
      files: [],
      collections: [],
      tombstones: [
        createTombstoneRecord({ localPath: 'a.pdf', zoteroAttachmentKey: 'AK1', originalHash: 'H1' }),
        createTombstoneRecord({ localPath: 'b.pdf', zoteroAttachmentKey: 'AK2', originalHash: 'H2' }),
      ],
    });
    await store2.load();
    expect(store2.findTombstoneByHash('H1')?.zoteroAttachmentKey).toBe('AK1');
    expect(store2.findTombstoneByAttachmentKey('AK2')?.originalHash).toBe('H2');
  });

  it('tombstones stay OUT of _byHash (live-record dedup invariant preserved)', () => {
    store.addTombstone(createTombstoneRecord({
      localPath: 'a.pdf', zoteroAttachmentKey: 'AK1', originalHash: 'H1',
    }));
    // _byHash is the live-record-only index; tombstones must be absent.
    expect(store._byHash.has('H1')).toBe(false);
    // But the tombstone index DOES carry the hash.
    expect(store._tombstonesByHash.has('H1')).toBe(true);
  });
});

// ─── UT-115 (WP-B / B2) ─────────────────────────────────────────────────────

describe('UT-115: getAllByAttachmentKey (canonical + shadows)', () => {
  let store;
  beforeEach(() => {
    resetTrackingStore();
    store = makeStore();
  });

  it('returns canonical + every shadow for an attachment key', () => {
    // Canonical record (localPath === canonicalLocalPath).
    store.add(createFileRecord({
      localPath: 'Methods/paper.pdf',
      canonicalLocalPath: 'Methods/paper.pdf',
      zoteroAttachmentKey: 'AK1',
    }));
    // Shadow: the user dropped a copy under a different folder.
    store.add(createFileRecord({
      localPath: 'Inbox/paper.pdf',
      canonicalLocalPath: 'Methods/paper.pdf',
      zoteroAttachmentKey: 'AK1',
    }));
    // Unrelated record.
    store.add(createFileRecord({
      localPath: 'other.pdf',
      zoteroAttachmentKey: 'AK2',
    }));
    const got = store.getAllByAttachmentKey('AK1');
    expect(got).toHaveLength(2);
    expect(got.map(r => r.localPath).sort()).toEqual([
      'Inbox/paper.pdf',
      'Methods/paper.pdf',
    ]);
  });

  it('returns empty array for unknown / empty / falsy key', () => {
    store.add(createFileRecord({ localPath: 'a.pdf', zoteroAttachmentKey: 'AK1' }));
    expect(store.getAllByAttachmentKey('UNKNOWN')).toEqual([]);
    expect(store.getAllByAttachmentKey('')).toEqual([]);
    expect(store.getAllByAttachmentKey(null)).toEqual([]);
    expect(store.getAllByAttachmentKey(undefined)).toEqual([]);
  });

  it('returns a defensive copy (mutating the result does not affect the store)', () => {
    store.add(createFileRecord({ localPath: 'a.pdf', zoteroAttachmentKey: 'AK1' }));
    const got = store.getAllByAttachmentKey('AK1');
    got.length = 0;
    // Subsequent call still returns the canonical-length list.
    expect(store.getAllByAttachmentKey('AK1')).toHaveLength(1);
  });

  it('legacy getByAttachmentKey is unchanged (still returns a single record)', () => {
    // Adding two records with the same attachment key — getByAttachmentKey
    // returns the most-recently-added record (the legacy single-record index).
    store.add(createFileRecord({
      localPath: 'a.pdf', zoteroAttachmentKey: 'AK1',
    }));
    store.add(createFileRecord({
      localPath: 'b.pdf', zoteroAttachmentKey: 'AK1',
    }));
    const single = store.getByAttachmentKey('AK1');
    expect(single).not.toBeNull();
    // Most-recent wins for the legacy index (Map insertion order semantics).
    expect(single.localPath).toBe('b.pdf');
    // But getAllByAttachmentKey returns both.
    expect(store.getAllByAttachmentKey('AK1')).toHaveLength(2);
  });

  it('update() keeps the multi-record index in sync', () => {
    store.add(createFileRecord({ localPath: 'a.pdf', zoteroAttachmentKey: 'AK1' }));
    store.add(createFileRecord({ localPath: 'b.pdf', zoteroAttachmentKey: 'AK1' }));
    // Re-key one of them.
    store.update('a.pdf', { zoteroAttachmentKey: 'AK_NEW' });
    expect(store.getAllByAttachmentKey('AK1')).toHaveLength(1);
    expect(store.getAllByAttachmentKey('AK1')[0].localPath).toBe('b.pdf');
    expect(store.getAllByAttachmentKey('AK_NEW')).toHaveLength(1);
    expect(store.getAllByAttachmentKey('AK_NEW')[0].localPath).toBe('a.pdf');
  });

  it('remove() drops the record from the multi-record index too', () => {
    store.add(createFileRecord({ localPath: 'a.pdf', zoteroAttachmentKey: 'AK1' }));
    store.add(createFileRecord({ localPath: 'b.pdf', zoteroAttachmentKey: 'AK1' }));
    store.remove('a.pdf');
    const got = store.getAllByAttachmentKey('AK1');
    expect(got).toHaveLength(1);
    expect(got[0].localPath).toBe('b.pdf');
  });

  it('load() rebuilds the multi-record index from disk', async () => {
    const store2 = makeStore();
    store2.dataFile = '/fake/tracking.json';
    globalThis.IOUtils.exists.mockResolvedValueOnce(true);
    globalThis.IOUtils.readJSON.mockResolvedValueOnce({
      version: 2,
      lastSaved: '2026-01-01T00:00:00.000Z',
      files: [
        createFileRecord({ localPath: 'canonical.pdf', zoteroAttachmentKey: 'AK1' }),
        createFileRecord({ localPath: 'shadow.pdf', zoteroAttachmentKey: 'AK1' }),
      ],
      collections: [],
      tombstones: [],
    });
    await store2.load();
    expect(store2.getAllByAttachmentKey('AK1')).toHaveLength(2);
  });
});

// ─── UT-116 (WP-B / B3) ─────────────────────────────────────────────────────

describe('UT-116: debounced save (WP-B / B3)', () => {
  beforeEach(() => {
    resetTrackingStore();
    globalThis.IOUtils.writeJSON.mockClear();
  });

  it('save() coalesces rapid calls into ONE write', async () => {
    const store = makeStore();
    store.dataFile = '/fake/tracking.json';
    store.add(createFileRecord({ localPath: 'a.pdf' }));
    store.add(createFileRecord({ localPath: 'b.pdf' }));
    store.add(createFileRecord({ localPath: 'c.pdf' }));
    // Three save() calls in rapid succession — all return the same
    // pending promise. Only ONE writeJSON should fire.
    const p1 = store.save();
    const p2 = store.save();
    const p3 = store.save();
    await Promise.all([p1, p2, p3]);
    expect(globalThis.IOUtils.writeJSON).toHaveBeenCalledTimes(1);
    expect(store.isDirty).toBe(false);
  });

  it('save() returns a promise that resolves AFTER the actual write', async () => {
    const store = makeStore();
    store.dataFile = '/fake/tracking.json';
    let writeResolve;
    const writePromise = new Promise(r => { writeResolve = r; });
    globalThis.IOUtils.writeJSON.mockImplementationOnce(async () => {
      await writePromise; // hold the write until we say so
    });
    store.add(createFileRecord({ localPath: 'a.pdf' }));
    const savePromise = store.save();
    // Give the debounce timer time to fire and start the write.
    await new Promise(r => setTimeout(r, 80));
    // The write started but hasn't finished yet, so savePromise hasn't resolved.
    let resolved = false;
    savePromise.then(() => { resolved = true; });
    await new Promise(r => setTimeout(r, 10));
    expect(resolved).toBe(false);
    writeResolve();
    await savePromise;
    expect(resolved).toBe(true);
  });

  it('save() returns a promise that REJECTS when the write fails', async () => {
    const store = makeStore();
    store.dataFile = '/fake/tracking.json';
    globalThis.IOUtils.writeJSON.mockRejectedValueOnce(new Error('disk full'));
    store.add(createFileRecord({ localPath: 'a.pdf' }));
    await expect(store.save()).rejects.toThrow('disk full');
  });

  it('flush() bypasses the debounce timer — writes immediately', async () => {
    const store = makeStore();
    store.dataFile = '/fake/tracking.json';
    store.add(createFileRecord({ localPath: 'a.pdf' }));
    // Schedule a debounced save, then flush() to bypass.
    const savePromise = store.save();
    // flush() should pre-empt the timer.
    await store.flush();
    expect(globalThis.IOUtils.writeJSON).toHaveBeenCalledTimes(1);
    // The earlier save() promise resolves to the same write outcome.
    await expect(savePromise).resolves.toBeUndefined();
  });

  it('saveNow() is an alias for flush()', async () => {
    const store = makeStore();
    store.dataFile = '/fake/tracking.json';
    store.add(createFileRecord({ localPath: 'a.pdf' }));
    await store.saveNow();
    expect(globalThis.IOUtils.writeJSON).toHaveBeenCalledTimes(1);
  });

  it('save() is a no-op when the store is not dirty', async () => {
    const store = makeStore();
    store.dataFile = '/fake/tracking.json';
    await store.save();
    expect(globalThis.IOUtils.writeJSON).not.toHaveBeenCalled();
  });

  it('destroy() rejects awaiters with a clear error', async () => {
    const store = makeStore();
    store.dataFile = '/fake/tracking.json';
    store.add(createFileRecord({ localPath: 'a.pdf' }));
    const savePromise = store.save();
    store.destroy();
    await expect(savePromise).rejects.toThrow(/destroyed/i);
  });
});

// ─── UT-117 ────────────────────────────────────────────────────────────────

describe('UT-117: atomic tracking-store write (DATA-3)', () => {
  beforeEach(() => {
    resetTrackingStore();
    globalThis.IOUtils.writeJSON.mockClear();
    globalThis.IOUtils.move.mockClear();
  });

  it('save() passes { tmpPath } so Gecko writes-then-renames atomically', async () => {
    const store = makeStore();
    store.dataFile = '/fake/tracking.json';
    store.add(createFileRecord({ localPath: 'a.pdf' }));
    await store.save();
    expect(globalThis.IOUtils.writeJSON).toHaveBeenCalledTimes(1);
    const [path, , opts] = globalThis.IOUtils.writeJSON.mock.calls[0];
    expect(path).toBe('/fake/tracking.json');
    expect(opts).toEqual({ tmpPath: '/fake/tracking.json.tmp' });
  });

  it('flush() is also atomic — passes the same { tmpPath }', async () => {
    const store = makeStore();
    store.dataFile = '/fake/tracking.json';
    store.add(createFileRecord({ localPath: 'a.pdf' }));
    await store.flush();
    expect(globalThis.IOUtils.writeJSON).toHaveBeenCalledTimes(1);
    const [, , opts] = globalThis.IOUtils.writeJSON.mock.calls[0];
    expect(opts).toEqual({ tmpPath: '/fake/tracking.json.tmp' });
  });

  it('tmp path is a same-directory sibling of dataFile (rename stays intra-FS)', async () => {
    const store = makeStore();
    store.dataFile = '/fake/dir/tracking.json';
    store.add(createFileRecord({ localPath: 'a.pdf' }));
    await store.save();
    const [, , opts] = globalThis.IOUtils.writeJSON.mock.calls[0];
    // Same directory ⇒ rename is atomic (no cross-filesystem copy).
    expect(opts.tmpPath.startsWith('/fake/dir/')).toBe(true);
    expect(opts.tmpPath).toBe('/fake/dir/tracking.json.tmp');
  });

  it('the geckoMocks atomic write emulates write-tmp-then-move onto the final path', async () => {
    const store = makeStore();
    store.dataFile = '/fake/tracking.json';
    store.add(createFileRecord({ localPath: 'a.pdf' }));
    await store.save();
    // The mock honors tmpPath by renaming the tmp sibling onto the target.
    expect(globalThis.IOUtils.move).toHaveBeenCalledTimes(1);
    expect(globalThis.IOUtils.move).toHaveBeenCalledWith(
      '/fake/tracking.json.tmp',
      '/fake/tracking.json',
    );
  });

  it('a failed write still REJECTS and leaves the store dirty (contract guard)', async () => {
    const store = makeStore();
    store.dataFile = '/fake/tracking.json';
    globalThis.IOUtils.writeJSON.mockRejectedValueOnce(new Error('disk full'));
    store.add(createFileRecord({ localPath: 'a.pdf' }));
    expect(store.isDirty).toBe(true);
    await expect(store.save()).rejects.toThrow('disk full');
    // Dirty flag is only cleared on a successful write.
    expect(store.isDirty).toBe(true);
  });
});
