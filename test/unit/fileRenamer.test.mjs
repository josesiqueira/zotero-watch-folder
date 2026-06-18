/**
 * Unit tests for content/fileRenamer.mjs
 * Covers: UT-005 (buildFilename template substitution), UT-006 (separator cleanup),
 *         UT-007 (validatePattern), UT-008 (getTemplateVariables)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildFilename, validatePattern, getTemplateVariables, formatPartialDate } from '../../content/fileRenamer.mjs';

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
  it('returns an object with exactly the 9 documented keys', () => {
    const vars = getTemplateVariables();
    const expectedKeys = [
      'firstCreator',
      'creators',
      'year',
      'date',
      'title',
      'shortTitle',
      'DOI',
      'itemType',
      'publicationTitle',
    ];
    expect(Object.keys(vars).sort()).toEqual(expectedKeys.sort());
  });
});

// ─── UT-DATEFMT-1 ─────────────────────────────────────────────────────────────

describe('UT-DATEFMT-1: formatPartialDate — partial-date formatting', () => {
  let originalDate;

  beforeEach(() => {
    originalDate = globalThis.Zotero.Date;
    // Local stub: parse a few canonical raw strings into Zotero's
    // 0-indexed-month {year, month, day} shape.
    globalThis.Zotero.Date = {
      strToDate: vi.fn((raw) => {
        if (!raw) return {};
        switch (raw) {
          case '2021-03-09':
            // March (0-indexed 2), day 9
            return { year: 2021, month: 2, day: 9 };
          case '2021-03':
            return { year: 2021, month: 2 };
          case '2021':
            return { year: 2021 };
          default:
            // Garbage: no recognizable parts
            return {};
        }
      }),
    };
  });

  afterEach(() => {
    globalThis.Zotero.Date = originalDate;
  });

  // UT-DATEFMT-1a — full date dd.mm.yyyy
  it('formats a full date "2021-03-09" -> "09.03.2021"', () => {
    expect(formatPartialDate('2021-03-09')).toBe('09.03.2021');
  });

  // UT-DATEFMT-1b — year + month -> mm.yyyy
  it('formats year+month "2021-03" -> "03.2021"', () => {
    expect(formatPartialDate('2021-03')).toBe('03.2021');
  });

  // UT-DATEFMT-1c — year only -> yyyy
  it('formats year-only "2021" -> "2021"', () => {
    expect(formatPartialDate('2021')).toBe('2021');
  });

  // UT-DATEFMT-1d — empty / garbage -> ''
  it('returns "" for empty input', () => {
    expect(formatPartialDate('')).toBe('');
  });

  it('returns "" for unparseable garbage', () => {
    expect(formatPartialDate('not a date')).toBe('');
  });

  // UT-DATEFMT-1e — zero-padding single-digit month/day
  it('zero-pads single-digit day and month', () => {
    globalThis.Zotero.Date.strToDate = vi.fn(() => ({ year: 2021, month: 0, day: 5 }));
    expect(formatPartialDate('whatever')).toBe('05.01.2021');
  });
});

// ─── UT-DATEFMT-2 ─────────────────────────────────────────────────────────────

describe('UT-DATEFMT-2: {date} token wiring + validation', () => {
  let originalDate;

  beforeEach(() => {
    vi.resetAllMocks();
    Zotero.Prefs.get.mockReturnValue(null);
    originalDate = globalThis.Zotero.Date;
    globalThis.Zotero.Date = {
      strToDate: vi.fn((raw) =>
        raw === '2021-03-09' ? { year: 2021, month: 2, day: 9 } : {}
      ),
    };
  });

  afterEach(() => {
    globalThis.Zotero.Date = originalDate;
  });

  // UT-DATEFMT-2a — pattern containing {date} validates
  it('validatePattern accepts a pattern containing {date}', () => {
    const r = validatePattern('{firstCreator} - {date} - {title}');
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  // UT-DATEFMT-2b — buildFilename renders {date} from item.getField('date')
  it('renders {date} sourced from the item publication date', () => {
    const item = makeMockItem({
      creators: [{ lastName: 'Smith' }],
      date: '2021-03-09',
      title: 'Deep Learning',
    });
    const result = buildFilename(item, '{firstCreator} - {date} - {title}');
    expect(result).toBe('Smith - 09.03.2021 - Deep Learning');
  });
});
