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
