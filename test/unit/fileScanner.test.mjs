/**
 * Unit tests for fileScanner + adjacent helpers.
 *
 * v2 cleanup: removed UT-038 (FolderWatcher) and UT-041 (CollectionWatcher)
 * because folderWatcher.mjs and collectionWatcher.mjs were Phase 2 modules
 * deleted in Phase E. v2.1 will rebuild equivalent collection / folder
 * watchers under the new sync-root architecture; tests against those
 * land then.
 *
 * Surviving sections:
 *   UT-037: hasFileChanged (fileScanner.mjs)
 *   UT-039: isSupportedFileType / filterSupportedFiles (fileImporter.mjs)
 *   UT-040: BulkOperations._hasGoodMetadata (bulkOperations.mjs)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { hasFileChanged } from '../../content/fileScanner.mjs';
import { isSupportedFileType, filterSupportedFiles } from '../../content/fileImporter.mjs';
import { BulkOperations } from '../../content/bulkOperations.mjs';

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

// ─── UT-040: BulkOperations._hasGoodMetadata ─────────────────────────────────

describe('BulkOperations._hasGoodMetadata', () => {
  let bulkOps;

  beforeEach(() => {
    bulkOps = new BulkOperations();
  });

  function makeItem(title, creators = []) {
    return {
      getField: (field) => (field === 'title' ? title : ''),
      getCreators: () => creators
    };
  }

  // UT-040a: real title + creator → true
  it('UT-040a: returns true for meaningful title (no extension) with 1 creator', () => {
    const item = makeItem('Deep Learning', [{ lastName: 'Smith' }]);
    expect(bulkOps._hasGoodMetadata(item)).toBe(true);
  });

  // UT-040b: title looks like filename (has .pdf extension) → false
  it('UT-040b: returns false when title looks like a filename (ends with .pdf)', () => {
    const item = makeItem('paper.pdf', [{ lastName: 'Smith' }]);
    expect(bulkOps._hasGoodMetadata(item)).toBe(false);
  });

  // UT-040c: empty title → false
  it('UT-040c: returns false for empty title', () => {
    const item = makeItem('', [{ lastName: 'Smith' }]);
    expect(bulkOps._hasGoodMetadata(item)).toBe(false);
  });

  // UT-040d: null title + no creators → false
  it('UT-040d: returns false for null title with no creators', () => {
    const item = makeItem(null, []);
    expect(bulkOps._hasGoodMetadata(item)).toBe(false);
  });

  // UT-040e: short title (<=5 chars) + no creators → false
  it('UT-040e: returns false for short title (<=5 chars) with no creators', () => {
    const item = makeItem('AI', []);
    expect(bulkOps._hasGoodMetadata(item)).toBe(false);
  });

  // UT-040f: short title (<=5 chars) + has creator → true
  it('UT-040f: returns true for short title (<=5 chars) when has at least 1 creator', () => {
    const item = makeItem('AI', [{ lastName: 'Smith' }]);
    expect(bulkOps._hasGoodMetadata(item)).toBe(true);
  });

  it('UT-040-epub: returns false when title ends with .epub', () => {
    const item = makeItem('mybook.epub', [{ lastName: 'Doe' }]);
    expect(bulkOps._hasGoodMetadata(item)).toBe(false);
  });
});

// UT-041 (CollectionWatcher) removed — collectionWatcher.mjs deleted in
// Phase E. v2.1 will rebuild a sync-root-aware replacement.
