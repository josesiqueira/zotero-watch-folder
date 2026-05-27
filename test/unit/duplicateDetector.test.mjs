/**
 * Unit tests for duplicateDetector.mjs — UT-015 through UT-020
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DuplicateDetector } from '../../content/duplicateDetector.mjs';

// Helper: create a fresh DuplicateDetector instance for each test
function makeDetector() {
  return new DuplicateDetector();
}

// ---------------------------------------------------------------------------
// UT-015 — DuplicateDetector.normalizeTitle
// ---------------------------------------------------------------------------
describe('UT-015 — DuplicateDetector.normalizeTitle', () => {
  let detector;
  beforeEach(() => { detector = makeDetector(); });

  // UT-015a
  it('a: removes punctuation and lowercases', () => {
    expect(detector.normalizeTitle('Deep Learning: A Survey')).toBe('deep learning a survey');
  });

  // UT-015b
  it('b: collapses extra whitespace', () => {
    expect(detector.normalizeTitle('  Extra   Spaces  ')).toBe('extra spaces');
  });

  // UT-015c
  it('c: empty string returns empty string', () => {
    expect(detector.normalizeTitle('')).toBe('');
  });

  // UT-015d
  it('d: null returns empty string', () => {
    expect(detector.normalizeTitle(null)).toBe('');
  });

  // UT-015e
  it('e: keeps Unicode letters, replaces hyphen with space', () => {
    const result = detector.normalizeTitle('Unicode: über-cool');
    expect(result).toBe('unicode über cool');
  });

  // UT-015f
  it('f: removes parentheses', () => {
    expect(detector.normalizeTitle('(2021) Title')).toBe('2021 title');
  });
});

// ---------------------------------------------------------------------------
// UT-016 — DuplicateDetector.levenshteinDistance
// ---------------------------------------------------------------------------
describe('UT-016 — DuplicateDetector.levenshteinDistance', () => {
  let detector;
  beforeEach(() => { detector = makeDetector(); });

  // UT-016a
  it('a: empty vs empty = 0', () => {
    expect(detector.levenshteinDistance('', '')).toBe(0);
  });

  // UT-016b
  it('b: empty vs abc = 3', () => {
    expect(detector.levenshteinDistance('', 'abc')).toBe(3);
  });

  // UT-016c
  it('c: abc vs empty = 3', () => {
    expect(detector.levenshteinDistance('abc', '')).toBe(3);
  });

  // UT-016d
  it('d: identical strings = 0', () => {
    expect(detector.levenshteinDistance('abc', 'abc')).toBe(0);
  });

  // UT-016e
  it('e: kitten vs sitting = 3', () => {
    expect(detector.levenshteinDistance('kitten', 'sitting')).toBe(3);
  });

  // UT-016f
  it('f: abc vs abd = 1 (one substitution)', () => {
    expect(detector.levenshteinDistance('abc', 'abd')).toBe(1);
  });

  // UT-016g
  it('g: a vs b = 1', () => {
    expect(detector.levenshteinDistance('a', 'b')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// UT-017 — DuplicateDetector.calculateSimilarity
// ---------------------------------------------------------------------------
describe('UT-017 — DuplicateDetector.calculateSimilarity', () => {
  let detector;
  beforeEach(() => { detector = makeDetector(); });

  // UT-017a
  it('a: identical strings = 1.0', () => {
    expect(detector.calculateSimilarity('hello', 'hello')).toBe(1.0);
  });

  // UT-017b
  it('b: empty first string = 0', () => {
    expect(detector.calculateSimilarity('', 'hello')).toBe(0);
  });

  // UT-017c
  it('c: completely different strings = 0', () => {
    expect(detector.calculateSimilarity('abc', 'xyz')).toBe(0);
  });

  // UT-017d
  it('d: partial overlap > 0.6', () => {
    const sim = detector.calculateSimilarity('deep learning', 'deep learning survey');
    expect(sim).toBeGreaterThan(0.6);
  });
});

// ---------------------------------------------------------------------------
// UT-018 — DuplicateDetector._isbn10to13
// ---------------------------------------------------------------------------
describe('UT-018 — DuplicateDetector._isbn10to13', () => {
  let detector;
  beforeEach(() => { detector = makeDetector(); });

  // UT-018a
  it('a: 0306406152 -> 9780306406157', () => {
    expect(detector._isbn10to13('0306406152')).toBe('9780306406157');
  });

  // UT-018b
  it('b: ISBN-10 with X check digit returns valid ISBN-13 string', () => {
    // 030640615X — the X is the ISBN-10 check digit.
    // _isbn10to13 only uses the first 9 digits: isbn10.slice(0, 9) = '030640615'
    // The X is never parsed as a number, so conversion succeeds.
    const result = detector._isbn10to13('030640615X');
    // Should return a 13-digit string starting with 978
    expect(result).not.toBeNull();
    expect(typeof result).toBe('string');
    expect(result).toHaveLength(13);
    expect(result.startsWith('978')).toBe(true);
  });

  // UT-018c
  it('c: null returns null', () => {
    expect(detector._isbn10to13(null)).toBeNull();
  });

  // UT-018d
  it('d: wrong length returns null', () => {
    expect(detector._isbn10to13('12345')).toBeNull();
  });

  // UT-018e
  it('e: non-numeric digits return null', () => {
    expect(detector._isbn10to13('abcdefghij')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// UT-019 — DuplicateDetector._isbn13to10
// ---------------------------------------------------------------------------
describe('UT-019 — DuplicateDetector._isbn13to10', () => {
  let detector;
  beforeEach(() => { detector = makeDetector(); });

  // UT-019a
  it('a: 9780306406157 -> 0306406152', () => {
    expect(detector._isbn13to10('9780306406157')).toBe('0306406152');
  });

  // UT-019b
  it('b: 979 prefix returns null (not convertible)', () => {
    expect(detector._isbn13to10('9791000000000')).toBeNull();
  });

  // UT-019c
  it('c: null returns null', () => {
    expect(detector._isbn13to10(null)).toBeNull();
  });

  // UT-019d
  it('d: wrong length returns null', () => {
    expect(detector._isbn13to10('12345')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// UT-020 — ISBN round-trip: ISBN-10 -> ISBN-13 -> ISBN-10
// ---------------------------------------------------------------------------
describe('UT-020 — ISBN round-trip conversion', () => {
  let detector;
  beforeEach(() => { detector = makeDetector(); });

  const knownISBN10s = [
    '0306406152',
    '0471958697',
    '0201633612',
    '0596517742',
  ];

  knownISBN10s.forEach((isbn10) => {
    it(`round-trip for ${isbn10}`, () => {
      const isbn13 = detector._isbn10to13(isbn10);
      expect(isbn13).not.toBeNull();
      expect(isbn13).toHaveLength(13);
      expect(isbn13.startsWith('978')).toBe(true);

      const recovered = detector._isbn13to10(isbn13);
      expect(recovered).toBe(isbn10);
    });
  });
});

// ---------------------------------------------------------------------------
// UT-A1-dd: findByHash routes through the WP-A1 module-level LRU hash cache.
// Two calls on the same (path, size, mtime) tuple should compute the
// hash only once — the second call is served from cache.
// ---------------------------------------------------------------------------
describe('UT-A1-dd: findByHash routes through the module-level hash cache', () => {
  let detector;
  let hashCache;
  let utils;

  beforeEach(async () => {
    detector = makeDetector();
    hashCache = await import('../../content/_hashCache.mjs');
    hashCache.clear();
    utils = await import('../../content/utils.mjs');

    // Stable stat — first call caches, second call hits.
    globalThis.IOUtils.stat = vi.fn(async (p) => ({
      size: 12345, lastModified: 6789, type: 'regular', path: p,
    }));
    // Mocked Zotero.Search → returns no results so findByHash returns null,
    // but the hash WILL have been computed first.
    const search = {
      libraryID: 1,
      addCondition: vi.fn(),
      search: vi.fn(async () => []),
    };
    globalThis.Zotero.Search = vi.fn(() => search);
  });

  it('a: two findByHash calls for the same file → one underlying read.read', async () => {
    // Spy on IOUtils.read which getFileHash uses under the hood.
    const readSpy = vi.fn(async () => new Uint8Array([1, 2, 3]));
    globalThis.IOUtils.read = readSpy;

    await detector.findByHash('/sample.pdf');
    await detector.findByHash('/sample.pdf');

    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(hashCache.stats().hits).toBeGreaterThanOrEqual(1);
  });

  it('b: stat change between calls forces a fresh hash computation', async () => {
    const readSpy = vi.fn(async () => new Uint8Array([1, 2, 3]));
    globalThis.IOUtils.read = readSpy;

    await detector.findByHash('/sample.pdf');
    // Advance mtime — cache key changes.
    globalThis.IOUtils.stat = vi.fn(async (p) => ({
      size: 12345, lastModified: 99999, type: 'regular', path: p,
    }));
    await detector.findByHash('/sample.pdf');

    expect(readSpy).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// UT-A3: WP-A3 — title cache prewarm + first-call short-circuit + parallel batches.
// ---------------------------------------------------------------------------
describe('UT-A3: title cache prewarm + first-call short-circuit', () => {
  let detector;

  beforeEach(() => {
    detector = makeDetector();
    // Bypass init's notifier registration paths.
    detector._initialized = true;
    detector._enabled = true;
    detector._matchTitle = true;
    // Provide a Zotero.Search stub (constructor — called via `new`).
    let pendingResolvers = [];
    globalThis.Zotero.Search = vi.fn(function() {
      this.libraryID = 1;
      this.addCondition = vi.fn();
      this.search = vi.fn(() => new Promise((resolve) => pendingResolvers.push(resolve)));
    });
    globalThis._pendingSearchResolvers = pendingResolvers;
    globalThis.Zotero.Items.getAsync = vi.fn(async (ids) => {
      // ids is an array — return one item per id, each with a unique title.
      return ids.map((id) => ({
        id,
        deleted: false,
        getField: (k) => k === 'title' ? `Title ${id}` : '',
      }));
    });
  });

  it('a: first findByTitle returns null AND kicks off background prewarm', async () => {
    // Search never resolves during this test — verifying the
    // short-circuit happens before the build completes.
    const result = await detector.findByTitle('Some long title');
    expect(result).toBeNull();
    expect(detector._titleCachePrewarm).not.toBeNull();
    // We didn't await the prewarm; cache still not ready.
    expect(detector._titleCacheReady).toBe(false);
  });

  it('b: prewarmTitleCache is idempotent (second call returns same promise)', () => {
    const p1 = detector.prewarmTitleCache();
    const p2 = detector.prewarmTitleCache();
    expect(p1).toBe(p2);
  });

  it('c: after prewarm finishes, findByTitle uses the populated cache', async () => {
    // Set search to resolve immediately with a single item id.
    globalThis.Zotero.Search = vi.fn(function() {
      this.libraryID = 1;
      this.addCondition = vi.fn();
      this.search = vi.fn(async () => [42]);
    });
    const makeItem = (id) => ({
      id, deleted: false,
      getField: (k) => k === 'title' ? 'A Distinctive Paper Title' : '',
    });
    globalThis.Zotero.Items.getAsync = vi.fn(async (idOrIds) => {
      // findByTitle calls getAsync with a single ID; _buildTitleCache calls with an array.
      if (Array.isArray(idOrIds)) return idOrIds.map(makeItem);
      return makeItem(idOrIds);
    });

    await detector.prewarmTitleCache();
    expect(detector._titleCacheReady).toBe(true);

    const result = await detector.findByTitle('A Distinctive Paper Title');
    expect(result).not.toBeNull();
    expect(result.isDuplicate).toBe(true);
    expect(result.existingItem.id).toBe(42);
  });

  it('d: _buildTitleCache issues batches in waves of CONCURRENCY=3', async () => {
    // 1500 ids → 3 batches of 500 → exactly one wave.
    // 2000 ids → 4 batches → two waves (3 + 1).
    const ids = Array.from({ length: 2000 }, (_, i) => i + 1);
    globalThis.Zotero.Search = vi.fn(function() {
      this.libraryID = 1;
      this.addCondition = vi.fn();
      this.search = vi.fn(async () => ids);
    });

    let inFlight = 0;
    let maxInFlight = 0;
    globalThis.Zotero.Items.getAsync = vi.fn(async (batchIDs) => {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      // Microtask-yield to allow concurrent dispatch.
      await new Promise((r) => setTimeout(r, 0));
      inFlight--;
      return batchIDs.map((id) => ({
        id, deleted: false,
        getField: (k) => k === 'title' ? `t${id}` : '',
      }));
    });

    await detector._buildTitleCache();

    // 4 batches dispatched, max 3 in flight at any time.
    expect(globalThis.Zotero.Items.getAsync).toHaveBeenCalledTimes(4);
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThanOrEqual(2); // at least some parallelism
  });

  it('e: prewarm failure resets _titleCachePrewarm so a later retry can run', async () => {
    globalThis.Zotero.Search = vi.fn(function() {
      this.libraryID = 1;
      this.addCondition = vi.fn();
      this.search = vi.fn(async () => { throw new Error('DB unavailable'); });
    });

    await detector.prewarmTitleCache();
    expect(detector._titleCachePrewarm).toBeNull();
    expect(detector._titleCacheReady).toBe(false);
  });

  it('f: invalidateTitleCache resets prewarm promise', () => {
    detector._titleCachePrewarm = Promise.resolve();
    detector._titleCacheReady = true;
    detector.invalidateTitleCache();
    expect(detector._titleCachePrewarm).toBeNull();
    expect(detector._titleCacheReady).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// UT-A4: WP-A4 — batch getAsync in notifier handler (add/modify).
// One Zotero.Items.getAsync(ids) array call instead of N per-id awaits.
// ---------------------------------------------------------------------------
describe('UT-A4: _handleNotify batches Zotero.Items.getAsync', () => {
  let detector;
  beforeEach(() => {
    detector = makeDetector();
    detector._initialized = true;
    detector._titleCacheReady = true; // skip the build path
    detector._titleCache = new Map();
  });

  it('a: add event uses array form when supported (1 call, not N)', async () => {
    const ids = [10, 11, 12, 13];
    const items = ids.map((id) => ({
      id, deleted: false,
      isRegularItem: () => true,
      getField: (k) => k === 'title' ? `Paper ${id}` : '',
    }));
    globalThis.Zotero.Items.getAsync = vi.fn(async (arg) => Array.isArray(arg) ? items : items[0]);

    await detector._handleNotify('add', 'item', ids, {});

    expect(globalThis.Zotero.Items.getAsync).toHaveBeenCalledTimes(1);
    expect(globalThis.Zotero.Items.getAsync).toHaveBeenCalledWith(ids);
    expect(detector._titleCache.size).toBe(4);
  });

  it('b: modify event uses array form (1 call, not N)', async () => {
    const ids = [20, 21];
    const items = ids.map((id) => ({
      id, deleted: false,
      isRegularItem: () => true,
      getField: (k) => k === 'title' ? `t${id}` : '',
    }));
    globalThis.Zotero.Items.getAsync = vi.fn(async (arg) => Array.isArray(arg) ? items : items[0]);

    await detector._handleNotify('modify', 'item', ids, {});

    expect(globalThis.Zotero.Items.getAsync).toHaveBeenCalledTimes(1);
    expect(detector._titleCache.size).toBe(2);
  });

  it('c: per-id fallback (cap 8) kicks in when array form throws', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => 100 + i);
    let arrayCalls = 0, perIdCalls = 0, inFlight = 0, maxInFlight = 0;
    globalThis.Zotero.Items.getAsync = vi.fn(async (arg) => {
      if (Array.isArray(arg)) { arrayCalls++; throw new Error('array form unsupported here'); }
      perIdCalls++;
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      await new Promise((r) => setTimeout(r, 0));
      inFlight--;
      return {
        id: arg, deleted: false,
        isRegularItem: () => true,
        getField: (k) => k === 'title' ? `t${arg}` : '',
      };
    });

    await detector._handleNotify('add', 'item', ids, {});

    expect(arrayCalls).toBe(1);
    expect(perIdCalls).toBe(12);
    // 12 ids, cap 8 → first wave 8, second wave 4; max in flight ≤ 8.
    expect(maxInFlight).toBeLessThanOrEqual(8);
  });

  it('d: per-id error resolves to null without breaking the wave', async () => {
    const ids = [1, 2, 3];
    globalThis.Zotero.Items.getAsync = vi.fn(async (arg) => {
      if (Array.isArray(arg)) throw new Error('no array form');
      if (arg === 2) throw new Error('deleted mid-flight');
      return {
        id: arg, deleted: false,
        isRegularItem: () => true,
        getField: (k) => k === 'title' ? `t${arg}` : '',
      };
    });

    await detector._handleNotify('add', 'item', ids, {});

    // 1 and 3 cached; 2 missing.
    expect(detector._titleCache.size).toBe(2);
  });
});
