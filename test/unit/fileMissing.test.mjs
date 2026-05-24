/**
 * Unit tests for content/fileMissing.mjs (new in v2).
 *
 * Covers:
 *   UT-301 isWatchRootAvailable
 *   UT-302 classifyMissingFile — race-safe re-check
 *   UT-303 classifyMissingFile — drive disconnected (parent stat throws)
 *   UT-304 classifyMissingFile — permission denied
 *   UT-305 classifyMissingFile — cloud placeholder (.icloud / OneDrive stub)
 *   UT-306 classifyMissingFile — user-deleted (default)
 *   UT-307 STATE_FOR_CLASSIFICATION mapping
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  classifyMissingFile,
  isWatchRootAvailable,
  MISSING_CLASSIFICATION,
  STATE_FOR_CLASSIFICATION,
} from '../../content/fileMissing.mjs';
import { STATE } from '../../content/trackingStore.mjs';

beforeEach(() => {
  vi.resetAllMocks();
  // Restore stable PathUtils mock — geckoMocks supplies these but we may
  // need to override per-test.
  globalThis.PathUtils.parent = vi.fn((p) => {
    const sep = p.includes('\\') ? '\\' : '/';
    const parts = p.split(sep);
    parts.pop();
    return parts.join(sep);
  });
  globalThis.PathUtils.filename = vi.fn((p) => {
    const sep = p.includes('\\') ? '\\' : '/';
    return p.split(sep).pop();
  });
});

// ─── UT-301 ────────────────────────────────────────────────────────────────

describe('UT-301: isWatchRootAvailable', () => {
  it('returns true when stat + getChildren both succeed', async () => {
    globalThis.IOUtils.stat = vi.fn(async () => ({ type: 'directory' }));
    globalThis.IOUtils.getChildren = vi.fn(async () => []);
    expect(await isWatchRootAvailable('/watch')).toBe(true);
  });

  it('returns false when stat throws (drive disconnected)', async () => {
    globalThis.IOUtils.stat = vi.fn(async () => { throw new Error('NotFoundError'); });
    expect(await isWatchRootAvailable('/watch')).toBe(false);
  });

  it('returns false when stat resolves but type !== directory', async () => {
    globalThis.IOUtils.stat = vi.fn(async () => ({ type: 'regular' }));
    expect(await isWatchRootAvailable('/watch')).toBe(false);
  });

  it('returns false when stat succeeds but getChildren throws (chmod 000 case)', async () => {
    globalThis.IOUtils.stat = vi.fn(async () => ({ type: 'directory' }));
    globalThis.IOUtils.getChildren = vi.fn(async () => {
      throw new Error('NS_ERROR_FILE_ACCESS_DENIED');
    });
    expect(await isWatchRootAvailable('/watch')).toBe(false);
  });

  it('returns false for empty / null path', async () => {
    expect(await isWatchRootAvailable('')).toBe(false);
    expect(await isWatchRootAvailable(null)).toBe(false);
  });
});

// ─── UT-302 ────────────────────────────────────────────────────────────────

describe('UT-302: classifyMissingFile — race-safe re-check', () => {
  it('returns STILL_EXISTS when the file reappears between scans', async () => {
    globalThis.IOUtils.exists = vi.fn(async () => true);
    const result = await classifyMissingFile('/watch/paper.pdf');
    expect(result).toBe(MISSING_CLASSIFICATION.STILL_EXISTS);
  });
});

// ─── UT-303 ────────────────────────────────────────────────────────────────

describe('UT-303: classifyMissingFile — drive disconnected', () => {
  it('returns DRIVE_DISCONNECTED when parent stat throws a non-permission error', async () => {
    globalThis.IOUtils.exists = vi.fn(async () => false);
    globalThis.IOUtils.stat = vi.fn(async () => { throw new Error('NotFoundError'); });
    const result = await classifyMissingFile('/watch/sub/paper.pdf');
    expect(result).toBe(MISSING_CLASSIFICATION.DRIVE_DISCONNECTED);
  });

  it('returns DRIVE_DISCONNECTED when getChildren throws a non-permission error', async () => {
    globalThis.IOUtils.exists = vi.fn(async () => false);
    globalThis.IOUtils.stat = vi.fn(async () => ({ type: 'directory' }));
    globalThis.IOUtils.getChildren = vi.fn(async () => { throw new Error('I/O fail'); });
    const result = await classifyMissingFile('/watch/sub/paper.pdf');
    expect(result).toBe(MISSING_CLASSIFICATION.DRIVE_DISCONNECTED);
  });
});

// ─── UT-304 ────────────────────────────────────────────────────────────────

describe('UT-304: classifyMissingFile — permission denied', () => {
  it('detects EACCES message and tags PERMISSION_DENIED', async () => {
    globalThis.IOUtils.exists = vi.fn(async () => false);
    globalThis.IOUtils.stat = vi.fn(async () => ({ type: 'directory' }));
    const err = new Error('open() failed: EACCES (Permission denied)');
    globalThis.IOUtils.getChildren = vi.fn(async () => { throw err; });
    const result = await classifyMissingFile('/watch/sub/paper.pdf');
    expect(result).toBe(MISSING_CLASSIFICATION.PERMISSION_DENIED);
  });

  it('detects NotAllowedError by name', async () => {
    globalThis.IOUtils.exists = vi.fn(async () => false);
    const err = new Error('forbidden');
    err.name = 'NotAllowedError';
    globalThis.IOUtils.stat = vi.fn(async () => { throw err; });
    const result = await classifyMissingFile('/watch/sub/paper.pdf');
    expect(result).toBe(MISSING_CLASSIFICATION.PERMISSION_DENIED);
  });
});

// ─── UT-305 ────────────────────────────────────────────────────────────────

describe('UT-305: classifyMissingFile — cloud placeholder', () => {
  it('detects iCloud-style .<name>.icloud sibling', async () => {
    globalThis.IOUtils.exists = vi.fn(async () => false);
    globalThis.IOUtils.stat = vi.fn(async () => ({ type: 'directory' }));
    globalThis.IOUtils.getChildren = vi.fn(async () => [
      '/watch/sub/other.pdf',
      '/watch/sub/.paper.pdf.icloud',
    ]);
    const result = await classifyMissingFile('/watch/sub/paper.pdf');
    expect(result).toBe(MISSING_CLASSIFICATION.CLOUD_PLACEHOLDER);
  });

  it('detects OneDrive-style same-name stub', async () => {
    globalThis.IOUtils.exists = vi.fn(async () => false);
    globalThis.IOUtils.stat = vi.fn(async () => ({ type: 'directory' }));
    globalThis.IOUtils.getChildren = vi.fn(async () => [
      '/watch/sub/paper.pdf', // listed by name even though exists() returned false
    ]);
    const result = await classifyMissingFile('/watch/sub/paper.pdf');
    expect(result).toBe(MISSING_CLASSIFICATION.CLOUD_PLACEHOLDER);
  });
});

// ─── UT-306 ────────────────────────────────────────────────────────────────

describe('UT-306: classifyMissingFile — user-deleted (default)', () => {
  it('returns USER_DELETED when parent dir is healthy and file is not in the listing', async () => {
    globalThis.IOUtils.exists = vi.fn(async () => false);
    globalThis.IOUtils.stat = vi.fn(async () => ({ type: 'directory' }));
    globalThis.IOUtils.getChildren = vi.fn(async () => [
      '/watch/sub/other.pdf',
      '/watch/sub/another.pdf',
    ]);
    const result = await classifyMissingFile('/watch/sub/paper.pdf');
    expect(result).toBe(MISSING_CLASSIFICATION.USER_DELETED);
  });

  it('returns USER_DELETED when parent is not a directory', async () => {
    globalThis.IOUtils.exists = vi.fn(async () => false);
    globalThis.IOUtils.stat = vi.fn(async () => ({ type: 'regular' }));
    const result = await classifyMissingFile('/watch/sub/paper.pdf');
    expect(result).toBe(MISSING_CLASSIFICATION.USER_DELETED);
  });
});

// ─── UT-307 ────────────────────────────────────────────────────────────────

describe('UT-307: STATE_FOR_CLASSIFICATION mapping', () => {
  it('maps each classification to the documented state (or null for still-exists)', () => {
    expect(STATE_FOR_CLASSIFICATION[MISSING_CLASSIFICATION.STILL_EXISTS]).toBe(null);
    expect(STATE_FOR_CLASSIFICATION[MISSING_CLASSIFICATION.USER_DELETED]).toBe(STATE.MISSING);
    expect(STATE_FOR_CLASSIFICATION[MISSING_CLASSIFICATION.DRIVE_DISCONNECTED]).toBe(STATE.PAUSED);
    expect(STATE_FOR_CLASSIFICATION[MISSING_CLASSIFICATION.PERMISSION_DENIED]).toBe(STATE.PAUSED);
    expect(STATE_FOR_CLASSIFICATION[MISSING_CLASSIFICATION.CLOUD_PLACEHOLDER]).toBe(STATE.PENDING_HYDRATION);
  });

  it('MISSING_CLASSIFICATION is frozen', () => {
    expect(Object.isFrozen(MISSING_CLASSIFICATION)).toBe(true);
  });
});
