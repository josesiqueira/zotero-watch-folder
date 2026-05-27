/**
 * Unit tests for content/utils.mjs
 * Covers: UT-001 (sanitizeFilename basic), UT-002 (sanitizeFilename truncation),
 *         UT-003 (isAllowedFileType), UT-004 (delay),
 *         UT-005 (relativePath — v2 helper),
 *         UT-006 (HASH_CHUNK_SIZE — v2 export)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  sanitizeFilename,
  isAllowedFileType,
  delay,
  relativePath,
  HASH_CHUNK_SIZE,
  sanitizeUntrustedKeys,
} from '../../content/utils.mjs';

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

// ─── UT-005 ──────────────────────────────────────────────────────────────────
// New in v2: relativePath helper — used to compute the part of a local path
// under a configured sync-root watch folder.

describe('UT-005: relativePath — sync-root relative path helper', () => {
  it('returns the path after the root for a nested file', () => {
    expect(relativePath('/watch/Methods/paper.pdf', '/watch')).toBe('Methods/paper.pdf');
  });

  it('returns "" when the absolute path equals the root', () => {
    expect(relativePath('/watch', '/watch')).toBe('');
  });

  it('returns "" when both paths end with a slash and are equal-modulo-trailing-slash', () => {
    expect(relativePath('/watch', '/watch/')).toBe('');
  });

  it('returns null when the absolute path is NOT under the root', () => {
    expect(relativePath('/elsewhere/paper.pdf', '/watch')).toBe(null);
  });

  it('returns null for a path that shares a prefix but isn\'t a child (sibling)', () => {
    // '/watcher' starts with '/watch' but is not a child of '/watch'.
    expect(relativePath('/watcher/paper.pdf', '/watch')).toBe(null);
  });

  it('normalises Windows-style backslashes to forward slashes', () => {
    expect(relativePath('C:\\watch\\Methods\\paper.pdf', 'C:\\watch'))
      .toBe('Methods/paper.pdf');
  });

  it('returns null on non-string inputs', () => {
    expect(relativePath(null, '/watch')).toBe(null);
    expect(relativePath('/watch/x', undefined)).toBe(null);
    expect(relativePath(42, '/watch')).toBe(null);
  });

  it('returns top-level filename when file is directly under root', () => {
    expect(relativePath('/watch/paper.pdf', '/watch')).toBe('paper.pdf');
  });
});

// ─── UT-006 ──────────────────────────────────────────────────────────────────
// HASH_CHUNK_SIZE was lifted out of getFileHash so the duplicate detector
// can import it instead of duplicating the literal.

describe('UT-006: HASH_CHUNK_SIZE export', () => {
  it('equals 1 MB (1024 * 1024)', () => {
    expect(HASH_CHUNK_SIZE).toBe(1024 * 1024);
  });

  it('is a named export', () => {
    expect(typeof HASH_CHUNK_SIZE).toBe('number');
  });
});

// ─── UT-007 — sanitizeUntrustedKeys (security audit 2026-05-27) ──────────

describe('UT-007: sanitizeUntrustedKeys', () => {
  it('strips __proto__ own property from a top-level object', () => {
    const malicious = JSON.parse('{"safe":"yes","__proto__":{"polluted":true}}');
    expect(Object.prototype.hasOwnProperty.call(malicious, '__proto__')).toBe(true);
    sanitizeUntrustedKeys(malicious);
    expect(Object.prototype.hasOwnProperty.call(malicious, '__proto__')).toBe(false);
    expect(malicious.safe).toBe('yes');
  });

  it('strips constructor and prototype own properties', () => {
    const obj = {};
    Object.defineProperty(obj, 'constructor', { value: 'evil', enumerable: true, configurable: true, writable: true });
    Object.defineProperty(obj, 'prototype', { value: 'evil', enumerable: true, configurable: true, writable: true });
    sanitizeUntrustedKeys(obj);
    expect(Object.prototype.hasOwnProperty.call(obj, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(obj, 'prototype')).toBe(false);
  });

  it('recurses into nested object values', () => {
    const obj = JSON.parse('{"a":{"b":{"__proto__":{"polluted":true},"c":1}}}');
    sanitizeUntrustedKeys(obj);
    expect(Object.prototype.hasOwnProperty.call(obj.a.b, '__proto__')).toBe(false);
    expect(obj.a.b.c).toBe(1);
  });

  it('recurses into array elements', () => {
    const arr = JSON.parse('[{"__proto__":{"x":1}},{"ok":true}]');
    sanitizeUntrustedKeys(arr);
    expect(Object.prototype.hasOwnProperty.call(arr[0], '__proto__')).toBe(false);
    expect(arr[1].ok).toBe(true);
  });

  it('leaves clean objects untouched (deep equality preserved)', () => {
    const obj = { a: 1, b: { c: [1, 2, 3], d: 'hello' } };
    const before = JSON.stringify(obj);
    sanitizeUntrustedKeys(obj);
    expect(JSON.stringify(obj)).toBe(before);
  });

  it('is a no-op on primitives and null', () => {
    expect(sanitizeUntrustedKeys(null)).toBe(null);
    expect(sanitizeUntrustedKeys(undefined)).toBe(undefined);
    expect(sanitizeUntrustedKeys(42)).toBe(42);
    expect(sanitizeUntrustedKeys('hello')).toBe('hello');
    expect(sanitizeUntrustedKeys(true)).toBe(true);
  });

  it('mutates in place AND returns the same reference (for chaining)', () => {
    const obj = JSON.parse('{"__proto__":{"polluted":true},"safe":1}');
    const result = sanitizeUntrustedKeys(obj);
    expect(result).toBe(obj);
  });

  it('does not affect Object.prototype after sanitizing a polluting source', () => {
    const obj = JSON.parse('{"__proto__":{"polluted":"yes"}}');
    sanitizeUntrustedKeys(obj);
    // After sanitize, instantiate a clean object and confirm no pollution.
    const fresh = {};
    expect(fresh.polluted).toBeUndefined();
  });
});
