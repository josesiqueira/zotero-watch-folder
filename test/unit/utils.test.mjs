/**
 * Unit tests for content/utils.mjs
 * Covers: UT-001 (sanitizeFilename basic), UT-002 (sanitizeFilename truncation),
 *         UT-003 (isAllowedFileType), UT-004 (delay)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sanitizeFilename, isAllowedFileType, delay } from '../../content/utils.mjs';

// ─── UT-001 ──────────────────────────────────────────────────────────────────

describe('UT-001: sanitizeFilename — basic illegal character replacement', () => {
  // UT-001a
  it('replaces < and > with underscores, then normalises to spaces', () => {
    const result = sanitizeFilename('Hello<World>.pdf');
    // < and > become _, multi-underscore/space collapses to space, then trim
    expect(result).toBe('Hello World .pdf');
  });

  // UT-001b
  it('replaces : / \\ with underscores then normalises', () => {
    const result = sanitizeFilename('File:Name/slash\\back.txt');
    expect(result).toBe('File Name slash back.txt');
  });

  // UT-001c
  it('trims leading/trailing spaces', () => {
    const result = sanitizeFilename('   spaces   .pdf');
    expect(result).toBe('spaces .pdf');
  });

  // UT-001d
  it('leaves a normal filename unchanged', () => {
    expect(sanitizeFilename('normal.pdf')).toBe('normal.pdf');
  });

  // UT-001e
  it('truncates a 200-char base to 150 chars total, preserving extension', () => {
    const longName = 'a'.repeat(200) + '.pdf';
    const result = sanitizeFilename(longName);
    expect(result.length).toBe(150);
    expect(result.endsWith('.pdf')).toBe(true);
  });

  // UT-001f
  it('returns empty string for empty input', () => {
    expect(sanitizeFilename('')).toBe('');
  });

  // UT-001g — no extension, length > maxLength
  it('truncates filename with no extension to maxLength', () => {
    const longName = 'f'.repeat(200);
    const result = sanitizeFilename(longName, 150);
    expect(result.length).toBe(150);
  });
});

// ─── UT-002 ──────────────────────────────────────────────────────────────────

describe('UT-002: sanitizeFilename — extension preservation during truncation', () => {
  // UT-002a
  it('truncates to maxLength=20 while preserving .pdf extension', () => {
    // 'averylongfilename.pdf' is 21 chars
    const result = sanitizeFilename('averylongfilename.pdf', 20);
    expect(result.length).toBe(20);
    expect(result.endsWith('.pdf')).toBe(true);
  });

  // UT-002b
  it('truncates to maxLength when extension alone exceeds it', () => {
    const result = sanitizeFilename('file.verylongextension', 10);
    expect(result.length).toBe(10);
  });
});

// ─── UT-003 ──────────────────────────────────────────────────────────────────

describe('UT-003: isAllowedFileType — extension matching', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // UT-003a
  it('returns true for .pdf when fileTypes pref is "pdf"', () => {
    Zotero.Prefs.get.mockReturnValue('pdf');
    expect(isAllowedFileType('paper.pdf')).toBe(true);
  });

  // UT-003b
  it('is case-insensitive: .PDF matches "pdf"', () => {
    Zotero.Prefs.get.mockReturnValue('pdf');
    expect(isAllowedFileType('paper.PDF')).toBe(true);
  });

  // UT-003c
  it('returns false for .epub when fileTypes pref is "pdf"', () => {
    Zotero.Prefs.get.mockReturnValue('pdf');
    expect(isAllowedFileType('paper.epub')).toBe(false);
  });

  // UT-003d
  it('returns true for .epub when fileTypes pref is "pdf,epub"', () => {
    Zotero.Prefs.get.mockReturnValue('pdf,epub');
    expect(isAllowedFileType('paper.epub')).toBe(true);
  });

  // UT-003e
  it('falls back to "pdf" when fileTypes pref is empty string', () => {
    Zotero.Prefs.get.mockReturnValue('');
    expect(isAllowedFileType('paper.pdf')).toBe(true);
  });

  // UT-003f
  it('falls back to "pdf" when fileTypes pref returns null', () => {
    Zotero.Prefs.get.mockReturnValue(null);
    expect(isAllowedFileType('paper.pdf')).toBe(true);
  });

  // UT-003g
  it('returns false for a filename with no extension', () => {
    Zotero.Prefs.get.mockReturnValue('pdf');
    expect(isAllowedFileType('paper')).toBe(false);
  });

  // UT-003h
  it('returns false for an empty filename', () => {
    Zotero.Prefs.get.mockReturnValue('pdf');
    expect(isAllowedFileType('')).toBe(false);
  });
});

// ─── UT-004 ──────────────────────────────────────────────────────────────────

describe('UT-004: delay — timing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // UT-004a
  it('returns a Promise that resolves with delay(0)', async () => {
    const p = delay(0);
    expect(p).toBeInstanceOf(Promise);
    vi.runAllTimers();
    await expect(p).resolves.toBeUndefined();
  });

  // UT-004b
  it('resolves after timer advances 1000ms', async () => {
    let resolved = false;
    const p = delay(1000).then(() => { resolved = true; });
    expect(resolved).toBe(false);
    vi.advanceTimersByTime(999);
    // Not yet resolved — flush microtasks
    await Promise.resolve();
    expect(resolved).toBe(false);
    vi.advanceTimersByTime(1);
    await p;
    expect(resolved).toBe(true);
  });
});
