/**
 * Unit tests for content/_hashCache.mjs — WP-A1 module-level LRU hash cache.
 *
 * UT-HC-001..UT-HC-005 cover:
 *   - get / set hit + miss
 *   - LRU eviction when capacity exceeded
 *   - LRU promotion on hit (re-insertion order)
 *   - hashFile end-to-end (stat + cache + compute on miss)
 *   - clear resets state + counters
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// We re-import the module per-test to get a fresh module-level cache state.
// Easier than juggling exports for the internal Map.
async function freshCache() {
  vi.resetModules();
  const mod = await import('../../content/_hashCache.mjs');
  return mod;
}

describe('UT-HC-001: _hashCache.get / set basic semantics', () => {
  let cache;
  beforeEach(async () => { cache = await freshCache(); cache.clear(); });

  it('a: get returns null on miss + increments misses counter', () => {
    expect(cache.get('/a.pdf', 100, 1000)).toBeNull();
    expect(cache.stats().misses).toBe(1);
    expect(cache.stats().hits).toBe(0);
  });

  it('b: set + get round-trip returns the stored hash + increments hits', () => {
    cache.set('/a.pdf', 100, 1000, 'deadbeef');
    expect(cache.get('/a.pdf', 100, 1000)).toBe('deadbeef');
    expect(cache.stats().hits).toBe(1);
  });

  it('c: same path, different size → miss', () => {
    cache.set('/a.pdf', 100, 1000, 'deadbeef');
    expect(cache.get('/a.pdf', 200, 1000)).toBeNull();
  });

  it('d: same path, different mtime → miss', () => {
    cache.set('/a.pdf', 100, 1000, 'deadbeef');
    expect(cache.get('/a.pdf', 100, 2000)).toBeNull();
  });

  it('e: set with falsy hash is a no-op', () => {
    cache.set('/a.pdf', 100, 1000, '');
    cache.set('/a.pdf', 100, 1000, null);
    expect(cache.stats().size).toBe(0);
  });

  it('f: set overwrites existing entry (same key)', () => {
    cache.set('/a.pdf', 100, 1000, 'old');
    cache.set('/a.pdf', 100, 1000, 'new');
    expect(cache.get('/a.pdf', 100, 1000)).toBe('new');
    expect(cache.stats().size).toBe(1);
  });
});

describe('UT-HC-002: LRU eviction at capacity', () => {
  let cache;
  beforeEach(async () => { cache = await freshCache(); cache.clear(); cache.__test_setCapacity(3); });
  afterEach(() => { cache.__test_resetCapacity(); });

  it('a: filling to capacity does not evict', () => {
    cache.set('/a', 1, 1, 'A');
    cache.set('/b', 1, 1, 'B');
    cache.set('/c', 1, 1, 'C');
    expect(cache.stats().size).toBe(3);
    expect(cache.get('/a', 1, 1)).toBe('A');
  });

  it('b: inserting beyond capacity evicts oldest', () => {
    cache.set('/a', 1, 1, 'A');
    cache.set('/b', 1, 1, 'B');
    cache.set('/c', 1, 1, 'C');
    cache.set('/d', 1, 1, 'D'); // forces eviction of /a
    expect(cache.stats().size).toBe(3);
    expect(cache.get('/a', 1, 1)).toBeNull(); // evicted
    expect(cache.get('/d', 1, 1)).toBe('D');
  });

  it('c: shrinking capacity truncates immediately', () => {
    cache.set('/a', 1, 1, 'A');
    cache.set('/b', 1, 1, 'B');
    cache.set('/c', 1, 1, 'C');
    cache.__test_setCapacity(2);
    expect(cache.stats().size).toBe(2);
    expect(cache.get('/a', 1, 1)).toBeNull(); // oldest dropped
    expect(cache.get('/c', 1, 1)).toBe('C');
  });
});

describe('UT-HC-003: LRU promotion on hit', () => {
  let cache;
  beforeEach(async () => { cache = await freshCache(); cache.clear(); cache.__test_setCapacity(3); });
  afterEach(() => { cache.__test_resetCapacity(); });

  it('a: a hit on the oldest entry promotes it so a subsequent insert evicts a different one', () => {
    cache.set('/a', 1, 1, 'A');
    cache.set('/b', 1, 1, 'B');
    cache.set('/c', 1, 1, 'C');
    // Hit on /a should promote it to MRU.
    expect(cache.get('/a', 1, 1)).toBe('A');
    // Inserting /d should evict /b (now oldest), NOT /a.
    cache.set('/d', 1, 1, 'D');
    expect(cache.get('/a', 1, 1)).toBe('A'); // survived
    expect(cache.get('/b', 1, 1)).toBeNull(); // evicted
    expect(cache.get('/c', 1, 1)).toBe('C');
    expect(cache.get('/d', 1, 1)).toBe('D');
  });
});

describe('UT-HC-004: hashFile end-to-end', () => {
  let cache;
  let getFileHashSpy;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../../content/utils.mjs', () => ({
      getFileHash: vi.fn(async (path) => `hash-of-${path}`),
    }));
    cache = await import('../../content/_hashCache.mjs');
    cache.clear();
    const utils = await import('../../content/utils.mjs');
    getFileHashSpy = utils.getFileHash;
  });

  afterEach(() => {
    vi.doUnmock('../../content/utils.mjs');
  });

  it('a: first call computes via getFileHash + caches the result', async () => {
    globalThis.IOUtils.stat = vi.fn(async () => ({ size: 100, lastModified: 1000, type: 'regular' }));

    const h = await cache.hashFile('/x.pdf');

    expect(h).toBe('hash-of-/x.pdf');
    expect(getFileHashSpy).toHaveBeenCalledTimes(1);
    expect(cache.stats().size).toBe(1);
  });

  it('b: second call with unchanged stat hits the cache, NOT getFileHash', async () => {
    globalThis.IOUtils.stat = vi.fn(async () => ({ size: 100, lastModified: 1000, type: 'regular' }));

    await cache.hashFile('/x.pdf');
    await cache.hashFile('/x.pdf');

    expect(getFileHashSpy).toHaveBeenCalledTimes(1); // only the first
    expect(cache.stats().hits).toBe(1);
  });

  it('c: stat change (size or mtime) bypasses cache + recomputes', async () => {
    let mtime = 1000;
    globalThis.IOUtils.stat = vi.fn(async () => ({ size: 100, lastModified: mtime, type: 'regular' }));

    await cache.hashFile('/x.pdf');
    mtime = 2000; // file edited
    await cache.hashFile('/x.pdf');

    expect(getFileHashSpy).toHaveBeenCalledTimes(2);
    expect(cache.stats().size).toBe(2); // both keys present (old + new mtime)
  });

  it('d: stat failure falls through to direct getFileHash (no caching)', async () => {
    globalThis.IOUtils.stat = vi.fn(async () => { throw new Error('ENOENT'); });

    const h = await cache.hashFile('/missing.pdf');

    expect(h).toBe('hash-of-/missing.pdf');
    expect(getFileHashSpy).toHaveBeenCalledTimes(1);
    expect(cache.stats().size).toBe(0); // nothing cached
  });

  it('e: empty path returns null without calling stat or hash', async () => {
    globalThis.IOUtils.stat = vi.fn();

    const h = await cache.hashFile('');

    expect(h).toBeNull();
    expect(globalThis.IOUtils.stat).not.toHaveBeenCalled();
    expect(getFileHashSpy).not.toHaveBeenCalled();
  });

  it('f: getFileHash returning null does not pollute the cache', async () => {
    globalThis.IOUtils.stat = vi.fn(async () => ({ size: 100, lastModified: 1000, type: 'regular' }));
    getFileHashSpy.mockResolvedValueOnce(null);

    const h = await cache.hashFile('/x.pdf');

    expect(h).toBeNull();
    expect(cache.stats().size).toBe(0);
  });
});

describe('UT-HC-005: clear resets state + counters', () => {
  let cache;
  beforeEach(async () => { cache = await freshCache(); });

  it('a: clear wipes entries and resets hits/misses', () => {
    cache.set('/a', 1, 1, 'A');
    cache.get('/a', 1, 1); // hit
    cache.get('/b', 1, 1); // miss
    expect(cache.stats().size).toBe(1);
    expect(cache.stats().hits).toBe(1);
    expect(cache.stats().misses).toBe(1);

    cache.clear();

    expect(cache.stats().size).toBe(0);
    expect(cache.stats().hits).toBe(0);
    expect(cache.stats().misses).toBe(0);
  });
});
