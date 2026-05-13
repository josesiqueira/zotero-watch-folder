/**
 * Unit tests covering UT-037 through UT-041:
 *   UT-037: hasFileChanged (fileScanner.mjs)
 *   UT-038: FolderWatcher._detectChanges (folderWatcher.mjs)
 *   UT-039: isSupportedFileType / filterSupportedFiles (fileImporter.mjs)
 *   UT-040: BulkOperations._hasGoodMetadata (bulkOperations.mjs)
 *   UT-041: CollectionWatcher._handleCollectionItemEvent (collectionWatcher.mjs)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { hasFileChanged } from '../../content/fileScanner.mjs';
import { FolderWatcher } from '../../content/folderWatcher.mjs';
import { isSupportedFileType, filterSupportedFiles } from '../../content/fileImporter.mjs';
import { BulkOperations } from '../../content/bulkOperations.mjs';
import { CollectionWatcher } from '../../content/collectionWatcher.mjs';

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

// ─── UT-038: FolderWatcher._detectChanges ────────────────────────────────────

describe('FolderWatcher._detectChanges', () => {
  let watcher;
  let syncService;

  beforeEach(() => {
    // Minimal stub for syncService — _detectChanges does not call it
    syncService = {
      isSyncing: false,
      mirrorPath: '/mirror'
    };
    watcher = new FolderWatcher(syncService);
    vi.clearAllMocks();
  });

  // UT-038a: new file → file_created
  it('UT-038a: detects file_created when a file appears that was not in lastScan', () => {
    watcher._lastScan = new Map();
    const currentState = new Map([
      ['/a/f.pdf', { type: 'regular', mtime: 1, size: 10 }]
    ]);
    const changes = watcher._detectChanges(currentState);
    expect(changes.length).toBe(1);
    expect(changes[0].type).toBe('file_created');
    expect(changes[0].path).toBe('/a/f.pdf');
  });

  // UT-038b: file in lastScan but not current → file_deleted
  it('UT-038b: detects file_deleted when a file disappears from lastScan', () => {
    watcher._lastScan = new Map([
      ['/a/f.pdf', { type: 'regular', mtime: 1, size: 10 }]
    ]);
    const changes = watcher._detectChanges(new Map());
    expect(changes.length).toBe(1);
    expect(changes[0].type).toBe('file_deleted');
    expect(changes[0].path).toBe('/a/f.pdf');
  });

  // UT-038c: mtime changed → file_modified
  it('UT-038c: detects file_modified when mtime changes', () => {
    watcher._lastScan = new Map([
      ['/a/f.pdf', { type: 'regular', mtime: 1, size: 10 }]
    ]);
    const currentState = new Map([
      ['/a/f.pdf', { type: 'regular', mtime: 2, size: 10 }]
    ]);
    const changes = watcher._detectChanges(currentState);
    expect(changes.length).toBe(1);
    expect(changes[0].type).toBe('file_modified');
  });

  // UT-038d: new directory → folder_created
  it('UT-038d: detects folder_created when a directory appears', () => {
    watcher._lastScan = new Map();
    const currentState = new Map([
      ['/a/dir', { type: 'directory', mtime: 1, size: 0 }]
    ]);
    const changes = watcher._detectChanges(currentState);
    expect(changes.length).toBe(1);
    expect(changes[0].type).toBe('folder_created');
  });

  // UT-038e: directory removed → folder_deleted
  it('UT-038e: detects folder_deleted when a directory disappears', () => {
    watcher._lastScan = new Map([
      ['/a/dir', { type: 'directory', mtime: 1, size: 0 }]
    ]);
    const changes = watcher._detectChanges(new Map());
    expect(changes.length).toBe(1);
    expect(changes[0].type).toBe('folder_deleted');
  });

  // UT-038f: folder changes sorted before file changes
  it('UT-038f: sorts folder changes before file changes', () => {
    watcher._lastScan = new Map();
    const currentState = new Map([
      ['/a/file.pdf', { type: 'regular', mtime: 1, size: 5 }],
      ['/a/newdir',   { type: 'directory', mtime: 1, size: 0 }]
    ]);
    const changes = watcher._detectChanges(currentState);
    // Folder change should come first
    expect(changes[0].type).toBe('folder_created');
    expect(changes[1].type).toBe('file_created');
  });
});

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

// ─── UT-041: CollectionWatcher._handleCollectionItemEvent ────────────────────

describe('CollectionWatcher._handleCollectionItemEvent', () => {
  let syncService;
  let watcher;

  beforeEach(() => {
    syncService = {
      isSyncing: false,
      handleItemAddedToCollection: vi.fn(async () => {}),
      handleItemRemovedFromCollection: vi.fn(async () => {})
    };
    watcher = new CollectionWatcher(syncService);
    vi.clearAllMocks();
  });

  // UT-041a: ['5-10'] + 'add' → handleItemAddedToCollection(10, 5)
  it('UT-041a: calls handleItemAddedToCollection(itemID, collectionID) on add event', async () => {
    await watcher._handleCollectionItemEvent('add', ['5-10'], {});
    expect(syncService.handleItemAddedToCollection).toHaveBeenCalledTimes(1);
    expect(syncService.handleItemAddedToCollection).toHaveBeenCalledWith(10, 5);
  });

  // UT-041b: ['5-10'] + 'remove' → handleItemRemovedFromCollection(10, 5)
  it('UT-041b: calls handleItemRemovedFromCollection(itemID, collectionID) on remove event', async () => {
    await watcher._handleCollectionItemEvent('remove', ['5-10'], {});
    expect(syncService.handleItemRemovedFromCollection).toHaveBeenCalledTimes(1);
    expect(syncService.handleItemRemovedFromCollection).toHaveBeenCalledWith(10, 5);
  });

  // UT-041c: invalid ID format → no call, debug emitted
  it('UT-041c: does not call sync service for invalid composite ID, emits debug', async () => {
    await watcher._handleCollectionItemEvent('add', ['invalid'], {});
    expect(syncService.handleItemAddedToCollection).not.toHaveBeenCalled();
    expect(Zotero.debug).toHaveBeenCalledWith(expect.stringContaining('Invalid collection-item ID'));
  });

  // UT-041d: multiple valid IDs → multiple separate calls
  it('UT-041d: makes separate calls for each valid composite ID', async () => {
    await watcher._handleCollectionItemEvent('add', ['5-10', '6-20'], {});
    expect(syncService.handleItemAddedToCollection).toHaveBeenCalledTimes(2);
    expect(syncService.handleItemAddedToCollection).toHaveBeenCalledWith(10, 5);
    expect(syncService.handleItemAddedToCollection).toHaveBeenCalledWith(20, 6);
  });
});
