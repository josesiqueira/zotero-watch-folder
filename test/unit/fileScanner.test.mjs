/**
 * Unit tests for fileScanner + adjacent helpers.
 *
 * v2 cleanup: removed UT-038 (FolderWatcher) and UT-041 (CollectionWatcher)
 * because folderWatcher.mjs and collectionWatcher.mjs were Phase 2 modules
 * deleted in Phase E. v2.1 will rebuild equivalent collection / folder
 * watchers under the new sync-root architecture; tests against those
 * land then.
 *
 * v2.2 cleanup: removed UT-040 (BulkOperations._hasGoodMetadata) because
 * bulkOperations.mjs was deleted — the v1-era bulk ops were unreachable
 * via Zotero.WatchFolder.hooks under the v2 sync model.
 *
 * Surviving sections:
 *   UT-037: hasFileChanged (fileScanner.mjs)
 *   UT-039: isSupportedFileType / filterSupportedFiles (fileImporter.mjs)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  hasFileChanged,
  scanFolder,
  scanFolderRecursive,
  __test_setSymlinkDetector,
} from '../../content/fileScanner.mjs';
import { isSupportedFileType, filterSupportedFiles } from '../../content/fileImporter.mjs';

// ─── UT-037: hasFileChanged ──────────────────────────────────────────────────

describe('hasFileChanged', () => {
  // UT-037a: same size and mtime → not changed
  it('UT-037a: returns false when size and mtime are identical', () => {
    expect(hasFileChanged({ size: 100, mtime: 1000 }, { size: 100, mtime: 1000 })).toBe(false);
  });

  // UT-037b: different size → changed
  it('UT-037b: returns true when size differs', () => {
    expect(hasFileChanged({ size: 100, mtime: 1000 }, { size: 200, mtime: 1000 })).toBe(true);
  });

  // UT-037c: different mtime → changed
  it('UT-037c: returns true when mtime differs', () => {
    expect(hasFileChanged({ size: 100, mtime: 1000 }, { size: 100, mtime: 2000 })).toBe(true);
  });

  // UT-037d: oldInfo null → changed
  it('UT-037d: returns true when oldInfo is null', () => {
    expect(hasFileChanged(null, { size: 100, mtime: 1000 })).toBe(true);
  });

  // UT-037e: newInfo null → changed
  it('UT-037e: returns true when newInfo is null', () => {
    expect(hasFileChanged({ size: 100, mtime: 1000 }, null)).toBe(true);
  });
});

// UT-038 (FolderWatcher) removed — folderWatcher.mjs deleted in Phase E.

// ─── UT-039: isSupportedFileType / filterSupportedFiles ──────────────────────

describe('isSupportedFileType', () => {
  // PathUtils.filename is mocked in geckoMocks.js to return last path segment.

  // UT-039a: pdf → true
  it('UT-039a: returns true for .pdf files', () => {
    expect(isSupportedFileType('/x/paper.pdf')).toBe(true);
  });

  // UT-039b: epub → true
  it('UT-039b: returns true for .epub files', () => {
    expect(isSupportedFileType('/x/paper.epub')).toBe(true);
  });

  // UT-039c: jpg → true
  it('UT-039c: returns true for .jpg files', () => {
    expect(isSupportedFileType('/x/photo.jpg')).toBe(true);
  });

  // UT-039d: unsupported extension → false
  it('UT-039d: returns false for unsupported extension .xyz', () => {
    expect(isSupportedFileType('/x/data.xyz')).toBe(false);
  });
});

describe('filterSupportedFiles', () => {
  // UT-039e: filters to only supported types
  it('UT-039e: filters array to only supported file types', () => {
    const input = ['/x/a.pdf', '/x/b.xyz', '/x/c.epub'];
    const result = filterSupportedFiles(input);
    expect(result).toEqual(['/x/a.pdf', '/x/c.epub']);
  });

  it('returns empty array when no supported files', () => {
    expect(filterSupportedFiles(['/x/a.foo', '/x/b.bar'])).toEqual([]);
  });

  it('returns all when all supported', () => {
    expect(filterSupportedFiles(['/x/a.pdf', '/x/b.txt'])).toEqual(['/x/a.pdf', '/x/b.txt']);
  });
});

// UT-040 (BulkOperations._hasGoodMetadata) removed — bulkOperations.mjs
// deleted in v2.2 cleanup. The v1-era reorganize/retry/applyRules surface
// was unreachable via Zotero.WatchFolder.hooks under the v2 sync model.
//
// UT-041 (CollectionWatcher) removed — collectionWatcher.mjs deleted in
// Phase E. v2.1 will rebuild a sync-root-aware replacement.

// ─── UT-042 — symlink defense (security audit 2026-05-27) ─────────────────

describe('UT-042: scanner refuses to follow symlinks', () => {
  // NB: do NOT call vi.clearAllMocks here — it resets implementations of the
  // geckoMocks.js IOUtils stubs to () => undefined, which makes scanFolder
  // think nothing exists. Each test sets the specific IOUtils stubs it needs.
  beforeEach(() => {
    globalThis.IOUtils.exists = vi.fn(async () => true);
    globalThis.IOUtils.stat = vi.fn(async (p) => {
      // Top-level path is a dir, child .pdf paths are regular files.
      if (p === '/watch' || /^\/watch\/[^./]+$/.test(p)) {
        return { type: 'directory', size: 0, lastModified: 0 };
      }
      return { type: 'regular', size: 100, lastModified: 0 };
    });
    // utils.isAllowedFileType reads fileTypes via getPref → Zotero.Prefs.get.
    // The default geckoMocks Prefs.get returns its fallback arg, which
    // utils.getPref doesn't pass — net effect is `undefined`. Re-pin
    // explicitly so the fallback to 'pdf' kicks in inside isAllowedFileType.
    globalThis.Zotero.Prefs.get = vi.fn(() => undefined);
  });

  it('scanFolder skips symlinked children', async () => {
    globalThis.IOUtils.getChildren = vi.fn(async () => [
      '/watch/real.pdf',
      '/watch/evil.pdf', // we'll claim this is a symlink
    ]);
    __test_setSymlinkDetector((p) => p === '/watch/evil.pdf');

    const files = await scanFolder('/watch');

    expect(files.map(f => f.path)).toEqual(['/watch/real.pdf']);
    __test_setSymlinkDetector(null); // restore default for other tests
  });

  it('scanFolderRecursive skips symlinked directories (no recursion into them)', async () => {
    globalThis.IOUtils.getChildren = vi.fn(async (p) => {
      if (p === '/watch') return ['/watch/safe', '/watch/evil-link'];
      if (p === '/watch/safe') return ['/watch/safe/paper.pdf'];
      // If the scanner DID recurse into /watch/evil-link, the test would
      // observe a getChildren call for it. We assert that doesn't happen
      // by leaving this path with a sentinel that would surface as junk.
      if (p === '/watch/evil-link') return ['/watch/evil-link/escaped.pdf'];
      return [];
    });
    globalThis.IOUtils.stat = vi.fn(async (p) => {
      if (p.endsWith('.pdf')) return { type: 'regular', size: 100, lastModified: 0 };
      return { type: 'directory', size: 0, lastModified: 0 };
    });

    __test_setSymlinkDetector((p) => p === '/watch/evil-link');

    const files = await scanFolderRecursive('/watch');
    const paths = files.map(f => f.path);

    expect(paths).toContain('/watch/safe/paper.pdf');
    expect(paths).not.toContain('/watch/evil-link/escaped.pdf');
    __test_setSymlinkDetector(null);
  });

  it('scanFolderRecursive skips symlinked FILES too', async () => {
    globalThis.IOUtils.getChildren = vi.fn(async () => [
      '/watch/real.pdf',
      '/watch/symlinked.pdf',
    ]);
    __test_setSymlinkDetector((p) => p === '/watch/symlinked.pdf');

    const files = await scanFolderRecursive('/watch');
    const paths = files.map(f => f.path);

    expect(paths).toEqual(['/watch/real.pdf']);
    __test_setSymlinkDetector(null);
  });

  it('default detector handles missing nsIFile gracefully (returns false → no skip)', async () => {
    // The default detector relies on Components.classes; if the call
    // throws (e.g. on a stripped-down environment), it must not crash.
    // It should return false so the file is processed as normal.
    globalThis.IOUtils.getChildren = vi.fn(async () => ['/watch/a.pdf']);
    // Force Components access to throw
    const savedClasses = globalThis.Components.classes;
    globalThis.Components.classes = new Proxy({}, {
      get() { throw new Error('Components.classes unavailable'); }
    });
    __test_setSymlinkDetector(null); // use default

    const files = await scanFolder('/watch');
    expect(files.map(f => f.path)).toEqual(['/watch/a.pdf']);

    globalThis.Components.classes = savedClasses;
  });

  it('test-seam restoration: passing null restores default', () => {
    __test_setSymlinkDetector(() => true); // override
    __test_setSymlinkDetector(null);       // restore
    // No throw, no crash — the next scan uses the default detector again.
  });

  it('test-seam validation: passing non-function throws', () => {
    expect(() => __test_setSymlinkDetector(42)).toThrow();
  });
});
