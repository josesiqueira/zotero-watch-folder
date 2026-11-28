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
  scanTree,
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

// ─── UT-A2: WP-A2 result shape — relativePath + isSymlink fields ─────────

describe('UT-A2: scanner result shape (relativePath + isSymlink)', () => {
  beforeEach(() => {
    globalThis.IOUtils.exists = vi.fn(async () => true);
    globalThis.IOUtils.stat = vi.fn(async (p) => {
      if (p === '/watch' || /^\/watch\/[^./]+$/.test(p)) {
        return { type: 'directory', size: 0, lastModified: 0 };
      }
      return { type: 'regular', size: 1234, lastModified: 5678 };
    });
    globalThis.Zotero.Prefs.get = vi.fn(() => undefined);
    __test_setSymlinkDetector(null);
  });

  it('scanFolder result includes relativePath relative to folderPath and isSymlink=false', async () => {
    globalThis.IOUtils.getChildren = vi.fn(async () => ['/watch/a.pdf', '/watch/b.pdf']);

    const files = await scanFolder('/watch');

    expect(files).toHaveLength(2);
    expect(files[0]).toEqual(expect.objectContaining({
      path: '/watch/a.pdf',
      size: 1234,
      mtime: 5678,
      isSymlink: false,
      relativePath: 'a.pdf',
    }));
    expect(files[1].relativePath).toBe('b.pdf');
  });

  it('scanFolderRecursive result anchors relativePath at the TOP-LEVEL folder, not the recursive sub-folder', async () => {
    globalThis.IOUtils.getChildren = vi.fn(async (p) => {
      if (p === '/watch') return ['/watch/sub'];
      if (p === '/watch/sub') return ['/watch/sub/paper.pdf'];
      return [];
    });
    globalThis.IOUtils.stat = vi.fn(async (p) => {
      if (p.endsWith('.pdf')) return { type: 'regular', size: 100, lastModified: 7 };
      return { type: 'directory', size: 0, lastModified: 0 };
    });

    const files = await scanFolderRecursive('/watch');

    expect(files).toHaveLength(1);
    expect(files[0].relativePath).toBe('sub/paper.pdf'); // anchored at /watch
    expect(files[0].isSymlink).toBe(false);
  });

  it('scanFolder skips symlinks before stat — symlinks never appear in result', async () => {
    globalThis.IOUtils.getChildren = vi.fn(async () => ['/watch/real.pdf', '/watch/link.pdf']);
    __test_setSymlinkDetector((p) => p === '/watch/link.pdf');

    const files = await scanFolder('/watch');

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('/watch/real.pdf');
    // No entry for the symlink — its isSymlink is implicitly true but never observed.
    expect(files.find(f => f.path === '/watch/link.pdf')).toBeUndefined();
    __test_setSymlinkDetector(null);
  });
});

// ─── UT-A3 — scanTree incremental cached walk (Option 1 scan optimization) ───
//
// scanTree returns the SAME complete file view as scanFolderRecursive PLUS the
// subdir set, but skips getChildren()+per-file stat() for directories whose
// mtime is unchanged. These tests pin: completeness, that unchanged dirs are
// NOT re-enumerated, that structural changes (add/remove/nested) ARE picked up,
// and that clearing the cache forces a full sweep.

describe('UT-A3: scanTree incremental cached walk', () => {
  /**
   * Install an in-memory filesystem wired to IOUtils.
   * @param {Map<string,{type:'dir'|'file', mtime:number, size?:number, children?:string[]}>} nodes
   * @returns {import('vitest').Mock} the getChildren spy (to count enumerations)
   */
  function installFs(nodes) {
    globalThis.IOUtils.exists = vi.fn(async (p) => nodes.has(p));
    globalThis.IOUtils.stat = vi.fn(async (p) => {
      const n = nodes.get(p);
      if (!n) throw Object.assign(new Error('NotFound'), { name: 'NotFoundError' });
      return n.type === 'dir'
        ? { type: 'directory', size: 0, lastModified: n.mtime }
        : { type: 'regular', size: n.size ?? 100, lastModified: n.mtime };
    });
    const gc = vi.fn(async (p) => {
      const n = nodes.get(p);
      return (n && n.children) ? [...n.children] : [];
    });
    globalThis.IOUtils.getChildren = gc;
    return gc;
  }

  /** A small nested tree: /watch → a.pdf, sub/ → sub/b.pdf */
  function baseTree() {
    return new Map([
      ['/watch', { type: 'dir', mtime: 1, children: ['/watch/a.pdf', '/watch/sub'] }],
      ['/watch/a.pdf', { type: 'file', mtime: 1 }],
      ['/watch/sub', { type: 'dir', mtime: 1, children: ['/watch/sub/b.pdf'] }],
      ['/watch/sub/b.pdf', { type: 'file', mtime: 1 }],
    ]);
  }

  beforeEach(() => {
    __test_setSymlinkDetector(null);
    globalThis.Zotero.Prefs.get = vi.fn(() => undefined); // isAllowedFileType → 'pdf'
    globalThis.Zotero.debug = vi.fn();
  });

  it('returns the complete file list + subdir set (null cache = full walk)', async () => {
    installFs(baseTree());
    const { files, dirs } = await scanTree('/watch', null);

    expect(files.map(f => f.path).sort()).toEqual(['/watch/a.pdf', '/watch/sub/b.pdf']);
    expect(dirs).toEqual(['/watch/sub']);
    // relativePath is anchored at the root.
    expect(files.find(f => f.path === '/watch/sub/b.pdf').relativePath).toBe('sub/b.pdf');
  });

  it('skips getChildren() for unchanged dirs on the second walk, but returns the same files', async () => {
    const nodes = baseTree();
    const gc = installFs(nodes);
    const cache = new Map();

    const first = await scanTree('/watch', cache);
    expect(first.files).toHaveLength(2);
    expect(gc).toHaveBeenCalled(); // full enumeration first time

    gc.mockClear();
    const second = await scanTree('/watch', cache);
    // Nothing changed → NO directory re-enumerated…
    expect(gc).not.toHaveBeenCalled();
    // …yet the complete file view is still returned from cache.
    expect(second.files.map(f => f.path).sort()).toEqual(['/watch/a.pdf', '/watch/sub/b.pdf']);
    expect(second.dirs).toEqual(['/watch/sub']);
  });

  it('re-enumerates a dir whose mtime bumped and picks up the new file', async () => {
    const nodes = baseTree();
    const gc = installFs(nodes);
    const cache = new Map();
    await scanTree('/watch', cache);

    // Add a file at the root and bump /watch mtime (a real FS bumps dir mtime
    // on child add).
    nodes.set('/watch/c.pdf', { type: 'file', mtime: 2 });
    nodes.get('/watch').children.push('/watch/c.pdf');
    nodes.get('/watch').mtime = 2;

    gc.mockClear();
    const r = await scanTree('/watch', cache);
    expect(gc).toHaveBeenCalledWith('/watch');      // changed dir re-enumerated
    expect(gc).not.toHaveBeenCalledWith('/watch/sub'); // unchanged dir reused
    expect(r.files.map(f => f.path)).toContain('/watch/c.pdf');
  });

  it('drops a deleted file when its parent dir mtime bumps (deletion detection stays correct)', async () => {
    const nodes = baseTree();
    installFs(nodes);
    const cache = new Map();
    await scanTree('/watch', cache);

    // Delete /watch/a.pdf and bump the parent mtime.
    nodes.delete('/watch/a.pdf');
    nodes.get('/watch').children = ['/watch/sub'];
    nodes.get('/watch').mtime = 2;

    const r = await scanTree('/watch', cache);
    expect(r.files.map(f => f.path)).toEqual(['/watch/sub/b.pdf']);
  });

  it('detects a change nested under an UNCHANGED parent (recursion always descends)', async () => {
    const nodes = baseTree();
    const gc = installFs(nodes);
    const cache = new Map();
    await scanTree('/watch', cache);

    // Parent /watch unchanged; only the child /watch/sub changes.
    nodes.set('/watch/sub/d.pdf', { type: 'file', mtime: 2 });
    nodes.get('/watch/sub').children.push('/watch/sub/d.pdf');
    nodes.get('/watch/sub').mtime = 2;

    gc.mockClear();
    const r = await scanTree('/watch', cache);
    expect(gc).not.toHaveBeenCalledWith('/watch');     // parent was a cache hit
    expect(gc).toHaveBeenCalledWith('/watch/sub');      // nested change re-enumerated
    expect(r.files.map(f => f.path)).toContain('/watch/sub/d.pdf');
  });

  it('clearing the cache forces a full sweep (every dir re-enumerated)', async () => {
    const nodes = baseTree();
    const gc = installFs(nodes);
    const cache = new Map();
    await scanTree('/watch', cache);

    gc.mockClear();
    cache.clear(); // simulate the periodic full sweep
    await scanTree('/watch', cache);
    expect(gc).toHaveBeenCalledWith('/watch');
    expect(gc).toHaveBeenCalledWith('/watch/sub');
  });

  it('null cache never short-circuits (full walk every call)', async () => {
    const nodes = baseTree();
    const gc = installFs(nodes);
    await scanTree('/watch', null);
    gc.mockClear();
    await scanTree('/watch', null);
    expect(gc).toHaveBeenCalledWith('/watch');
    expect(gc).toHaveBeenCalledWith('/watch/sub');
  });

  it('skips symlinked dirs and reserved dirs (parity with scanFolderRecursive)', async () => {
    const nodes = new Map([
      ['/watch', { type: 'dir', mtime: 1, children: ['/watch/keep.pdf', '/watch/link', '/watch/imported'] }],
      ['/watch/keep.pdf', { type: 'file', mtime: 1 }],
      ['/watch/link', { type: 'dir', mtime: 1, children: ['/watch/link/escaped.pdf'] }],
      ['/watch/link/escaped.pdf', { type: 'file', mtime: 1 }],
      ['/watch/imported', { type: 'dir', mtime: 1, children: ['/watch/imported/old.pdf'] }],
      ['/watch/imported/old.pdf', { type: 'file', mtime: 1 }],
    ]);
    installFs(nodes);
    __test_setSymlinkDetector((p) => p === '/watch/link');

    const { files, dirs } = await scanTree('/watch', new Map());
    const paths = files.map(f => f.path);
    expect(paths).toEqual(['/watch/keep.pdf']);
    expect(paths).not.toContain('/watch/link/escaped.pdf');   // symlinked dir skipped
    expect(paths).not.toContain('/watch/imported/old.pdf');   // reserved dir skipped
    expect(dirs).toEqual([]);
    __test_setSymlinkDetector(null);
  });

  it('returns empty and forgets the cache entry when the root is gone (fail-safe)', async () => {
    const nodes = baseTree();
    installFs(nodes);
    const cache = new Map();
    await scanTree('/watch', cache);
    expect(cache.has('/watch')).toBe(true);

    // Root vanishes (e.g. transient unmount).
    const empty = new Map();
    installFs(empty);
    const r = await scanTree('/watch', cache);
    expect(r.files).toEqual([]);
    expect(r.dirs).toEqual([]);
    expect(cache.has('/watch')).toBe(false); // stale snapshot dropped
  });
});
