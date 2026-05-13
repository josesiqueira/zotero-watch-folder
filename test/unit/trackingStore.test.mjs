/**
 * Unit tests for content/trackingStore.mjs
 * Covers: UT-011 (in-memory CRUD), UT-012 (LRU eviction),
 *         UT-013 (getStats), UT-014 (createTrackingRecord defaults)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TrackingStore, createTrackingRecord, resetTrackingStore } from '../../content/trackingStore.mjs';

/**
 * Helper: create an already-initialised TrackingStore without touching disk.
 * We set internal state directly to bypass init() which requires Zotero.DataDirectory.
 */
function makeStore(maxEntries = 5000) {
  const store = new TrackingStore(maxEntries);
  store._initialized = true;
  store.records = new Map();
  return store;
}

// ─── UT-014 ──────────────────────────────────────────────────────────────────
// Tested first because other tests use createTrackingRecord

describe('UT-014: createTrackingRecord — defaults', () => {
  // UT-014a
  it('provides defaults for all fields when called with {}', () => {
    const rec = createTrackingRecord({});
    expect(rec.path).toBe('');
    expect(rec.hash).toBe('');
    expect(rec.mtime).toBe(0);
    expect(rec.size).toBe(0);
    expect(rec.itemID).toBe(0);
    expect(rec.metadataRetrieved).toBe(false);
    expect(rec.renamed).toBe(false);
    // importDate is a valid ISO string
    expect(() => new Date(rec.importDate).toISOString()).not.toThrow();
    expect(new Date(rec.importDate).toISOString()).toBe(rec.importDate);
  });

  // UT-014b
  it('merges supplied values over defaults', () => {
    const rec = createTrackingRecord({ path: '/x', itemID: 42 });
    expect(rec.path).toBe('/x');
    expect(rec.itemID).toBe(42);
    // Remaining fields retain defaults
    expect(rec.hash).toBe('');
    expect(rec.mtime).toBe(0);
    expect(rec.metadataRetrieved).toBe(false);
    expect(rec.renamed).toBe(false);
  });
});

// ─── UT-011 ──────────────────────────────────────────────────────────────────

describe('UT-011: TrackingStore — in-memory CRUD operations', () => {
  let store;

  beforeEach(() => {
    resetTrackingStore();
    store = makeStore();
  });

  // UT-011a — createTrackingRecord returns valid record (covered in UT-014, referenced here)
  it('createTrackingRecord({path,hash}) has valid importDate ISO string', () => {
    const rec = createTrackingRecord({ path: '/a', hash: 'abc' });
    expect(rec.path).toBe('/a');
    expect(rec.hash).toBe('abc');
    expect(typeof rec.importDate).toBe('string');
    expect(new Date(rec.importDate).toISOString()).toBe(rec.importDate);
  });

  // UT-011b
  it('add() then hasPath() returns true', () => {
    store.add({ path: '/a', hash: 'x', itemID: 1 });
    expect(store.hasPath('/a')).toBe(true);
  });

  // UT-011c
  it('adding the same path twice keeps size at 1', () => {
    store.add({ path: '/a', hash: 'x' });
    store.add({ path: '/a', hash: 'y' });
    expect(store.size).toBe(1);
  });

  // UT-011d
  it('get() returns the record after add()', () => {
    const rec = { path: '/a', hash: 'abc', itemID: 5 };
    store.add(rec);
    const fetched = store.get('/a');
    expect(fetched).not.toBeNull();
    expect(fetched.path).toBe('/a');
    expect(fetched.hash).toBe('abc');
  });

  // UT-011e
  it('get() returns null for a path that was never added', () => {
    expect(store.get('/notexists')).toBeNull();
  });

  // UT-011f
  it('remove() returns true and record is gone', () => {
    store.add({ path: '/a' });
    const result = store.remove('/a');
    expect(result).toBe(true);
    expect(store.hasPath('/a')).toBe(false);
  });

  // UT-011g
  it('remove() returns false for non-existent path', () => {
    expect(store.remove('/notexists')).toBe(false);
  });

  // UT-011h
  it('update() modifies an existing record', () => {
    store.add({ path: '/a', hash: 'x', metadataRetrieved: false });
    store.update('/a', { metadataRetrieved: true });
    expect(store.get('/a').metadataRetrieved).toBe(true);
  });

  // UT-011i
  it('update() silently no-ops for non-existent path', () => {
    expect(() => store.update('/notexists', { metadataRetrieved: true })).not.toThrow();
  });

  // UT-011j
  it('hasHash() returns true after adding record with that hash', () => {
    store.add({ path: '/a', hash: 'abc' });
    expect(store.hasHash('abc')).toBe(true);
  });

  // UT-011k
  it('findByHash() returns the matching record', () => {
    store.add({ path: '/a', hash: 'abc' });
    const found = store.findByHash('abc');
    expect(found).not.toBeNull();
    expect(found.path).toBe('/a');
  });

  // UT-011l
  it('findByItemID() returns the matching record', () => {
    store.add({ path: '/a', hash: 'abc', itemID: 1 });
    const found = store.findByItemID(1);
    expect(found).not.toBeNull();
    expect(found.path).toBe('/a');
  });

  // UT-011m
  it('removeByItemID() returns true and record is gone', () => {
    store.add({ path: '/a', hash: 'abc', itemID: 1 });
    const result = store.removeByItemID(1);
    expect(result).toBe(true);
    expect(store.hasPath('/a')).toBe(false);
  });

  // UT-011n
  it('getPendingMetadata() returns records with metadataRetrieved=false and itemID set', () => {
    store.add({ path: '/a', hash: 'x', itemID: 1, metadataRetrieved: false });
    store.add({ path: '/b', hash: 'y', itemID: 2, metadataRetrieved: true });
    const pending = store.getPendingMetadata();
    expect(pending).toHaveLength(1);
    expect(pending[0].path).toBe('/a');
  });

  // UT-011o
  it('getPendingRename() returns records with metadataRetrieved=true, renamed=false, itemID set', () => {
    store.add({ path: '/a', hash: 'x', itemID: 1, metadataRetrieved: true, renamed: false });
    store.add({ path: '/b', hash: 'y', itemID: 2, metadataRetrieved: true, renamed: true });
    store.add({ path: '/c', hash: 'z', itemID: 3, metadataRetrieved: false, renamed: false });
    const pending = store.getPendingRename();
    expect(pending).toHaveLength(1);
    expect(pending[0].path).toBe('/a');
  });
});

// ─── UT-012 ──────────────────────────────────────────────────────────────────

describe('UT-012: TrackingStore — LRU eviction', () => {
  it('evicts the oldest entry when maxEntries is exceeded', () => {
    const store = makeStore(3);

    store.add({ path: '/first', hash: 'h1' });
    store.add({ path: '/second', hash: 'h2' });
    store.add({ path: '/third', hash: 'h3' });
    expect(store.size).toBe(3);

    // Adding a 4th entry should evict '/first' (oldest)
    store.add({ path: '/fourth', hash: 'h4' });
    expect(store.size).toBe(3);
    expect(store.hasPath('/first')).toBe(false);
    expect(store.hasPath('/second')).toBe(true);
    expect(store.hasPath('/third')).toBe(true);
    expect(store.hasPath('/fourth')).toBe(true);
  });
});

// ─── UT-013 ──────────────────────────────────────────────────────────────────

describe('UT-013: TrackingStore.getStats — statistics calculation', () => {
  it('returns correct counts for a mixed set of records', () => {
    const store = makeStore();

    // Record 1: has metadata + renamed
    store.add({ path: '/a', hash: 'h1', itemID: 1, metadataRetrieved: true, renamed: true });
    // Record 2: has metadata, not renamed
    store.add({ path: '/b', hash: 'h2', itemID: 2, metadataRetrieved: true, renamed: false });
    // Record 3: no metadata (pending), has itemID
    store.add({ path: '/c', hash: 'h3', itemID: 3, metadataRetrieved: false, renamed: false });

    const stats = store.getStats();
    expect(stats.total).toBe(3);
    expect(stats.withMetadata).toBe(2);
    expect(stats.renamed).toBe(1);
    expect(stats.pending).toBe(1);
  });

  it('returns all zeros when store is empty', () => {
    const store = makeStore();
    const stats = store.getStats();
    expect(stats.total).toBe(0);
    expect(stats.withMetadata).toBe(0);
    expect(stats.renamed).toBe(0);
    expect(stats.pending).toBe(0);
  });
});
