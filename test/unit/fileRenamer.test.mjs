/**
 * Unit tests for content/fileRenamer.mjs
 * Covers: UT-005 (buildFilename template substitution), UT-006 (separator cleanup),
 *         UT-007 (validatePattern), UT-008 (getTemplateVariables)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildFilename, validatePattern, getTemplateVariables } from '../../content/fileRenamer.mjs';

/**
 * Create a minimal mock Zotero Item
 */
function makeMockItem({ creators = [], year = '', date = '', title = '', DOI = '', itemType = '', publicationTitle = '' } = {}) {
  return {
    getCreators: vi.fn(() => creators),
    getField: vi.fn((field) => {
      const map = { year, date, title, DOI, publicationTitle };
      return map[field] ?? '';
    }),
    itemType,
  };
}

// ─── UT-005 ──────────────────────────────────────────────────────────────────

describe('UT-005: buildFilename — template substitution', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Make getPref return null so the pattern argument is used directly
    Zotero.Prefs.get.mockReturnValue(null);
  });

  // UT-005a
  it('substitutes firstCreator, year, title', () => {
    const item = makeMockItem({
      creators: [{ lastName: 'Smith' }],
      year: '2023',
      title: 'Deep Learning',
    });
    const result = buildFilename(item, '{firstCreator} - {year} - {title}');
    expect(result).toBe('Smith - 2023 - Deep Learning');
  });

  // UT-005b
  it('cleans dangling separator when firstCreator is empty', () => {
    const item = makeMockItem({ year: '2023', title: 'Deep Learning' });
    const result = buildFilename(item, '{firstCreator} - {year} - {title}');
    // Leading " - " should be stripped
    expect(result).toBe('2023 - Deep Learning');
  });

  // UT-005c
  it('cleans empty year separator: Smith - AI', () => {
    const item = makeMockItem({
      creators: [{ lastName: 'Smith' }],
      title: 'AI',
    });
    const result = buildFilename(item, '{firstCreator} - {year} - {title}');
    expect(result).toBe('Smith - AI');
  });

  // UT-005d
  it('handles all-empty metadata gracefully', () => {
    const item = makeMockItem();
    const result = buildFilename(item, '{firstCreator} - {year} - {title}');
    // Result should be empty or a safe minimal string (not throw)
    expect(typeof result).toBe('string');
  });

  // UT-005e
  it('shortTitle is unchanged when title is ≤50 chars', () => {
    const item = makeMockItem({ title: 'Short' });
    const result = buildFilename(item, '{shortTitle}');
    expect(result).toBe('Short');
  });

  // UT-005f
  it('shortTitle truncates to 50 chars when title is longer', () => {
    const longTitle = 'a'.repeat(60);
    const item = makeMockItem({ title: longTitle });
    const result = buildFilename(item, '{shortTitle}');
    expect(result).toBe('a'.repeat(50));
  });

  // UT-005g
  it('falls back to creator.name when lastName is absent', () => {
    const item = makeMockItem({ creators: [{ name: 'Anonymous' }] });
    const result = buildFilename(item, '{firstCreator}');
    expect(result).toBe('Anonymous');
  });

  // UT-005h
  it('creators lists all last names comma-separated', () => {
    const item = makeMockItem({
      creators: [{ lastName: 'Smith' }, { lastName: 'Jones' }],
    });
    const result = buildFilename(item, '{creators}');
    expect(result).toBe('Smith, Jones');
  });
});

// ─── UT-006 ──────────────────────────────────────────────────────────────────

describe('UT-006: buildFilename — separator cleanup', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    Zotero.Prefs.get.mockReturnValue(null);
  });

  // UT-006a — double separator in middle collapses
  it('collapses " - - " in the middle to " - "', () => {
    // empty year produces " - - "
    const item = makeMockItem({
      creators: [{ lastName: 'Smith' }],
      title: 'AI',
    });
    const result = buildFilename(item, '{firstCreator} - {year} - {title}');
    expect(result).not.toContain(' - - ');
    expect(result).toBe('Smith - AI');
  });

  // UT-006b — leading " - " stripped
  it('strips leading " - " when first variable is empty', () => {
    const item = makeMockItem({ year: '2023', title: 'Foo' });
    const result = buildFilename(item, '{firstCreator} - {year} - {title}');
    expect(result.startsWith(' - ')).toBe(false);
    expect(result.startsWith('-')).toBe(false);
  });

  // UT-006c — trailing " - " stripped
  it('strips trailing " - " when last variable is empty', () => {
    const item = makeMockItem({ creators: [{ lastName: 'Smith' }], year: '2023' });
    const result = buildFilename(item, '{firstCreator} - {year} - {title}');
    expect(result.endsWith(' - ')).toBe(false);
    expect(result.endsWith('-')).toBe(false);
  });

  // UT-006d — multiple consecutive spaces collapse
  it('collapses multiple spaces to one', () => {
    // title with extra spaces after sanitizeFilename
    const item = makeMockItem({ title: 'foo  bar' });
    const result = buildFilename(item, '{title}');
    expect(result).not.toMatch(/\s{2,}/);
  });
});

// ─── UT-007 ──────────────────────────────────────────────────────────────────

describe('UT-007: validatePattern — valid and invalid patterns', () => {
  // UT-007a
  it('returns valid=true with 0 errors for a good pattern', () => {
    const r = validatePattern('{firstCreator} - {year}');
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  // UT-007b
  it('returns valid=false with 2 errors for empty string', () => {
    const r = validatePattern('');
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBe(2);
  });

  // UT-007c
  it('returns valid=false with 1 error for static string (no variable)', () => {
    const r = validatePattern('static string');
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBe(1);
  });

  // UT-007d
  it('returns valid=false with 1 error for unknown variable', () => {
    const r = validatePattern('{unknownVar}');
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBe(1);
  });

  // UT-007e
  it('returns valid=false with 1 error when mixing known and unknown vars', () => {
    const r = validatePattern('{title}{unknownVar}');
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBe(1);
  });

  // UT-007f
  it('returns valid=true with 0 errors for all-valid multi-variable pattern', () => {
    const r = validatePattern('{firstCreator}{year}{title}');
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });
});

// ─── UT-008 ──────────────────────────────────────────────────────────────────

describe('UT-008: getTemplateVariables — completeness', () => {
  it('returns an object with exactly the 8 documented keys', () => {
    const vars = getTemplateVariables();
    const expectedKeys = [
      'firstCreator',
      'creators',
      'year',
      'title',
      'shortTitle',
      'DOI',
      'itemType',
      'publicationTitle',
    ];
    expect(Object.keys(vars).sort()).toEqual(expectedKeys.sort());
  });
});
