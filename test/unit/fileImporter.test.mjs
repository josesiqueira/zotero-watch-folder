/**
 * Unit tests for content/fileImporter.mjs
 * Covers:
 *   UT-053: handlePostImportAction — 'leave' branch
 *   UT-054: handlePostImportAction — 'delete' branch
 *   UT-055: handlePostImportAction — 'move' branch
 *   UT-056: handlePostImportAction — pref fallback and unknown action
 *   UT-057: isSupportedFileType — extension matching
 *   UT-058: filterSupportedFiles — array filtering
 *   UT-059: importFile — happy path (stored / linked modes)
 *   UT-064: importBatch — empty input
 *   UT-065: importBatch — mixed string / object entries
 *   UT-066: importBatch — onProgress callback
 *   UT-067: importBatch — delayBetween honoured
 *   UT-068: importBatch — continues after a failing import
 *   UT-069: importBatch — handlePostImport=false skips post action
 *   UT-070: importFile — Zotero.Attachments.importFromFile throws
 *   UT-071: importFile — non-existent file
 *   UT-072: importFile — nested collection path uses getOrCreateCollectionPath
 *   UT-073: importFile — collection helper returns null (no collection)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../content/utils.mjs', () => ({
  getPref: vi.fn(),
  getOrCreateTargetCollection: vi.fn(),
  getOrCreateCollectionPath: vi.fn(),
}));

// ─── UT-053 ──────────────────────────────────────────────────────────────────

describe("UT-053: handlePostImportAction — action='leave'", () => {
  let getPrefMock;
  let handlePostImportAction;

  beforeEach(async () => {
    vi.resetAllMocks();
    const utils = await import('../../content/utils.mjs');
    getPrefMock = utils.getPref;
    const mod = await import('../../content/fileImporter.mjs');
    handlePostImportAction = mod.handlePostImportAction;

    globalThis.IOUtils.remove = vi.fn(async () => {});
    globalThis.IOUtils.move = vi.fn(async () => {});
    globalThis.IOUtils.exists = vi.fn(async () => true);
    globalThis.IOUtils.makeDirectory = vi.fn(async () => {});
  });

  // UT-053a
  it("returns {action:'leave', finalPath:filePath} and performs no IO", async () => {
    const filePath = '/watch/sub/paper.pdf';
    const result = await handlePostImportAction(filePath, 'leave');

    expect(result).toEqual({ action: 'leave', finalPath: filePath });
    expect(globalThis.IOUtils.remove).not.toHaveBeenCalled();
    expect(globalThis.IOUtils.move).not.toHaveBeenCalled();
    expect(globalThis.IOUtils.makeDirectory).not.toHaveBeenCalled();
  });
});

// ─── UT-054 ──────────────────────────────────────────────────────────────────

describe("UT-054: handlePostImportAction — action='delete'", () => {
  let getPrefMock;
  let handlePostImportAction;

  beforeEach(async () => {
    vi.resetAllMocks();
    const utils = await import('../../content/utils.mjs');
    getPrefMock = utils.getPref;
    const mod = await import('../../content/fileImporter.mjs');
    handlePostImportAction = mod.handlePostImportAction;

    globalThis.IOUtils.remove = vi.fn(async () => {});
    globalThis.IOUtils.move = vi.fn(async () => {});
    globalThis.IOUtils.exists = vi.fn(async () => true);
    globalThis.IOUtils.makeDirectory = vi.fn(async () => {});
  });

  // UT-054a
  it("returns {action:'delete', finalPath:null} and calls IOUtils.remove(filePath)", async () => {
    const filePath = '/watch/paper.pdf';
    const result = await handlePostImportAction(filePath, 'delete');

    expect(result).toEqual({ action: 'delete', finalPath: null });
    expect(globalThis.IOUtils.remove).toHaveBeenCalledTimes(1);
    expect(globalThis.IOUtils.remove).toHaveBeenCalledWith(filePath);
  });

  // UT-054b
  it('propagates errors when IOUtils.remove rejects', async () => {
    globalThis.IOUtils.remove = vi.fn(async () => {
      throw new Error('permission denied');
    });

    await expect(
      handlePostImportAction('/watch/paper.pdf', 'delete')
    ).rejects.toThrow('permission denied');
  });
});

// ─── UT-055 ──────────────────────────────────────────────────────────────────

describe("UT-055: handlePostImportAction — action='move'", () => {
  let getPrefMock;
  let handlePostImportAction;

  beforeEach(async () => {
    vi.resetAllMocks();
    const utils = await import('../../content/utils.mjs');
    getPrefMock = utils.getPref;
    const mod = await import('../../content/fileImporter.mjs');
    handlePostImportAction = mod.handlePostImportAction;

    globalThis.IOUtils.remove = vi.fn(async () => {});
    globalThis.IOUtils.move = vi.fn(async () => {});
    globalThis.IOUtils.exists = vi.fn(async () => true);
    globalThis.IOUtils.makeDirectory = vi.fn(async () => {});
  });

  // UT-055a
  it("returns {action:'move', finalPath:<newPath>} and calls IOUtils.move", async () => {
    getPrefMock.mockImplementation((k) => k === 'sourcePath' ? '/watch' : undefined);

    const filePath = '/watch/paper.pdf';
    const result = await handlePostImportAction(filePath, 'move');

    expect(result.action).toBe('move');
    expect(result.finalPath).toBe('/watch/imported/paper.pdf');
    expect(globalThis.IOUtils.move).toHaveBeenCalledTimes(1);
    expect(globalThis.IOUtils.move).toHaveBeenCalledWith(filePath, '/watch/imported/paper.pdf');
  });

  // UT-055b
  it('computes destination mirroring relative subfolder structure under watchRoot/imported', async () => {
    getPrefMock.mockImplementation((k) => k === 'sourcePath' ? '/watch' : undefined);

    const filePath = '/watch/sub/nested/paper.pdf';
    const result = await handlePostImportAction(filePath, 'move');

    expect(result.finalPath).toBe('/watch/imported/sub/nested/paper.pdf');
    expect(globalThis.IOUtils.move).toHaveBeenCalledWith(
      filePath,
      '/watch/imported/sub/nested/paper.pdf'
    );
  });

  // UT-055c
  it("creates parent dir via IOUtils.makeDirectory when destDir doesn't exist", async () => {
    getPrefMock.mockImplementation((k) => k === 'sourcePath' ? '/watch' : undefined);
    globalThis.IOUtils.exists = vi.fn(async () => false);

    const filePath = '/watch/sub/paper.pdf';
    await handlePostImportAction(filePath, 'move');

    expect(globalThis.IOUtils.makeDirectory).toHaveBeenCalledTimes(1);
    expect(globalThis.IOUtils.makeDirectory).toHaveBeenCalledWith(
      '/watch/imported/sub',
      { createAncestors: true }
    );
    expect(globalThis.IOUtils.move).toHaveBeenCalled();
  });

  // UT-055d
  it('does NOT call makeDirectory when destDir already exists', async () => {
    getPrefMock.mockImplementation((k) => k === 'sourcePath' ? '/watch' : undefined);
    globalThis.IOUtils.exists = vi.fn(async () => true);

    await handlePostImportAction('/watch/sub/paper.pdf', 'move');

    expect(globalThis.IOUtils.makeDirectory).not.toHaveBeenCalled();
    expect(globalThis.IOUtils.move).toHaveBeenCalled();
  });
});

// ─── UT-056 ──────────────────────────────────────────────────────────────────

describe('UT-056: handlePostImportAction — pref fallback and unknown action', () => {
  let getPrefMock;
  let handlePostImportAction;

  beforeEach(async () => {
    vi.resetAllMocks();
    const utils = await import('../../content/utils.mjs');
    getPrefMock = utils.getPref;
    const mod = await import('../../content/fileImporter.mjs');
    handlePostImportAction = mod.handlePostImportAction;

    globalThis.IOUtils.remove = vi.fn(async () => {});
    globalThis.IOUtils.move = vi.fn(async () => {});
    globalThis.IOUtils.exists = vi.fn(async () => true);
    globalThis.IOUtils.makeDirectory = vi.fn(async () => {});
  });

  // UT-056a
  it("action=null falls back to 'postImportAction' pref ('delete')", async () => {
    getPrefMock.mockImplementation((k) => k === 'postImportAction' ? 'delete' : undefined);

    const result = await handlePostImportAction('/watch/paper.pdf', null);

    expect(result).toEqual({ action: 'delete', finalPath: null });
    expect(globalThis.IOUtils.remove).toHaveBeenCalledWith('/watch/paper.pdf');
  });

  // UT-056b
  it("unknown action ('foo') hits the default branch and returns {action:'leave', finalPath:filePath}", async () => {
    const filePath = '/watch/paper.pdf';
    const result = await handlePostImportAction(filePath, 'foo');

    expect(result).toEqual({ action: 'leave', finalPath: filePath });
    expect(globalThis.IOUtils.remove).not.toHaveBeenCalled();
    expect(globalThis.IOUtils.move).not.toHaveBeenCalled();
  });
});

// ─── UT-057 ──────────────────────────────────────────────────────────────────

describe('UT-057: isSupportedFileType — extension matching', () => {
  let isSupportedFileType;

  beforeEach(async () => {
    vi.resetAllMocks();
    const mod = await import('../../content/fileImporter.mjs');
    isSupportedFileType = mod.isSupportedFileType;
  });

  // UT-057a
  it('returns true for .pdf', () => {
    expect(isSupportedFileType('/x/paper.pdf')).toBe(true);
  });

  // UT-057b
  it('is case-insensitive: .PDF returns true', () => {
    expect(isSupportedFileType('/x/paper.PDF')).toBe(true);
  });

  // UT-057c
  it('returns true for .txt (txt is in the supportedExtensions list)', () => {
    expect(isSupportedFileType('/x/notes.txt')).toBe(true);
  });

  // UT-057d
  it('returns false for an unknown extension like .xyz', () => {
    expect(isSupportedFileType('/x/blob.xyz')).toBe(false);
  });
});

// ─── UT-058 ──────────────────────────────────────────────────────────────────

describe('UT-058: filterSupportedFiles — array filtering', () => {
  let filterSupportedFiles;

  beforeEach(async () => {
    vi.resetAllMocks();
    const mod = await import('../../content/fileImporter.mjs');
    filterSupportedFiles = mod.filterSupportedFiles;
  });

  // UT-058a
  it('returns only paths whose extensions are supported', () => {
    const input = [
      '/x/paper.pdf',
      '/x/book.epub',
      '/x/blob.xyz',
      '/x/binary.exe',
      '/x/song.mp3',
    ];
    const result = filterSupportedFiles(input);
    expect(result).toEqual([
      '/x/paper.pdf',
      '/x/book.epub',
      '/x/song.mp3',
    ]);
  });

  // UT-058b
  it('returns empty array when no inputs are supported', () => {
    expect(filterSupportedFiles(['/x/a.xyz', '/x/b.exe'])).toEqual([]);
  });

  // UT-058c
  it('returns empty array for empty input', () => {
    expect(filterSupportedFiles([])).toEqual([]);
  });
});

// ─── UT-059 ──────────────────────────────────────────────────────────────────

describe('UT-059: importFile — stored vs linked import modes', () => {
  let getPrefMock;
  let getOrCreateTargetCollectionMock;
  let importFile;

  beforeEach(async () => {
    vi.resetAllMocks();
    const utils = await import('../../content/utils.mjs');
    getPrefMock = utils.getPref;
    getOrCreateTargetCollectionMock = utils.getOrCreateTargetCollection;
    const mod = await import('../../content/fileImporter.mjs');
    importFile = mod.importFile;

    globalThis.IOUtils.exists = vi.fn(async () => true);

    getOrCreateTargetCollectionMock.mockResolvedValue({ id: 99 });

    globalThis.Zotero.Attachments.importFromFile = vi.fn(async () => ({ id: 1001 }));
    globalThis.Zotero.Attachments.linkFromFile = vi.fn(async () => ({ id: 1002 }));
  });

  // UT-059a
  it("stored mode calls Zotero.Attachments.importFromFile with expected args", async () => {
    getPrefMock.mockImplementation((k) => {
      if (k === 'targetCollection') return 'Inbox';
      if (k === 'importMode') return 'stored';
      return undefined;
    });

    const item = await importFile('/watch/paper.pdf');

    expect(item).toEqual({ id: 1001 });
    expect(globalThis.Zotero.Attachments.importFromFile).toHaveBeenCalledTimes(1);
    expect(globalThis.Zotero.Attachments.importFromFile).toHaveBeenCalledWith({
      file: '/watch/paper.pdf',
      libraryID: 1,
      collections: [99],
    });
    expect(globalThis.Zotero.Attachments.linkFromFile).not.toHaveBeenCalled();
  });

  // UT-059b
  it('linked mode calls Zotero.Attachments.linkFromFile with expected args', async () => {
    getPrefMock.mockImplementation((k) => {
      if (k === 'targetCollection') return 'Inbox';
      if (k === 'importMode') return 'linked';
      return undefined;
    });

    const item = await importFile('/watch/paper.pdf');

    expect(item).toEqual({ id: 1002 });
    expect(globalThis.Zotero.Attachments.linkFromFile).toHaveBeenCalledTimes(1);
    expect(globalThis.Zotero.Attachments.linkFromFile).toHaveBeenCalledWith({
      file: '/watch/paper.pdf',
      collections: [99],
    });
    expect(globalThis.Zotero.Attachments.importFromFile).not.toHaveBeenCalled();
  });
});

// ─── UT-064 ──────────────────────────────────────────────────────────────────

describe('UT-064: importBatch — empty files array', () => {
  let importBatch;

  beforeEach(async () => {
    vi.resetAllMocks();
    const mod = await import('../../content/fileImporter.mjs');
    importBatch = mod.importBatch;

    globalThis.IOUtils.exists = vi.fn(async () => true);
    globalThis.Zotero.Attachments.importFromFile = vi.fn(async () => ({ id: 1 }));
    globalThis.Zotero.Attachments.linkFromFile = vi.fn(async () => ({ id: 2 }));
  });

  // UT-064a
  it('returns {success:[], failed:[]} and does not call any Zotero attachment APIs', async () => {
    const result = await importBatch([]);

    expect(result).toEqual({ success: [], failed: [] });
    expect(globalThis.Zotero.Attachments.importFromFile).not.toHaveBeenCalled();
    expect(globalThis.Zotero.Attachments.linkFromFile).not.toHaveBeenCalled();
    expect(globalThis.IOUtils.exists).not.toHaveBeenCalled();
  });
});

// ─── UT-065 ──────────────────────────────────────────────────────────────────

describe('UT-065: importBatch — mixed string / {path, collection} entries', () => {
  let getPrefMock;
  let getOrCreateTargetCollectionMock;
  let importBatch;

  beforeEach(async () => {
    vi.resetAllMocks();
    const utils = await import('../../content/utils.mjs');
    getPrefMock = utils.getPref;
    getOrCreateTargetCollectionMock = utils.getOrCreateTargetCollection;
    const mod = await import('../../content/fileImporter.mjs');
    importBatch = mod.importBatch;

    getPrefMock.mockImplementation((k) => {
      if (k === 'targetCollection') return 'Inbox';
      if (k === 'importMode') return 'linked'; // linked => skips post-import IO
      if (k === 'postImportAction') return 'leave';
      return undefined;
    });

    getOrCreateTargetCollectionMock.mockImplementation(async (name) => ({
      id: name === 'Inbox' ? 10 : 20,
      name,
    }));

    globalThis.IOUtils.exists = vi.fn(async () => true);
    globalThis.Zotero.Attachments.linkFromFile = vi.fn(async ({ file }) => ({
      id: 100,
      path: file,
    }));
    globalThis.Zotero.Attachments.importFromFile = vi.fn();
  });

  // UT-065a
  it('handles strings (using default collection) and objects (using per-entry collection)', async () => {
    const files = [
      '/watch/a.pdf',
      { path: '/watch/b.pdf', collection: 'Research' },
    ];
    const result = await importBatch(files, { delayBetween: 0, importMode: 'linked' });

    expect(result.success).toHaveLength(2);
    expect(result.failed).toEqual([]);

    // String entry => default collection (Inbox => id 10)
    expect(globalThis.Zotero.Attachments.linkFromFile).toHaveBeenNthCalledWith(1, {
      file: '/watch/a.pdf',
      collections: [10],
    });
    // Object entry => per-entry collection (Research => id 20)
    expect(globalThis.Zotero.Attachments.linkFromFile).toHaveBeenNthCalledWith(2, {
      file: '/watch/b.pdf',
      collections: [20],
    });
    expect(getOrCreateTargetCollectionMock).toHaveBeenCalledWith('Inbox', 1);
    expect(getOrCreateTargetCollectionMock).toHaveBeenCalledWith('Research', 1);
  });
});

// ─── UT-066 ──────────────────────────────────────────────────────────────────

describe('UT-066: importBatch — onProgress callback', () => {
  let getPrefMock;
  let getOrCreateTargetCollectionMock;
  let importBatch;

  beforeEach(async () => {
    vi.resetAllMocks();
    const utils = await import('../../content/utils.mjs');
    getPrefMock = utils.getPref;
    getOrCreateTargetCollectionMock = utils.getOrCreateTargetCollection;
    const mod = await import('../../content/fileImporter.mjs');
    importBatch = mod.importBatch;

    getPrefMock.mockImplementation((k) => {
      if (k === 'targetCollection') return 'Inbox';
      if (k === 'importMode') return 'linked';
      return undefined;
    });
    getOrCreateTargetCollectionMock.mockResolvedValue({ id: 10 });

    globalThis.IOUtils.exists = vi.fn(async () => true);
    globalThis.Zotero.Attachments.linkFromFile = vi.fn(async () => ({ id: 1 }));
  });

  // UT-066a
  it('calls onProgress(i+1, total) once per file in order', async () => {
    const onProgress = vi.fn();
    const files = ['/watch/a.pdf', '/watch/b.pdf', '/watch/c.pdf'];

    await importBatch(files, { onProgress, delayBetween: 0, importMode: 'linked' });

    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenNthCalledWith(1, 1, 3);
    expect(onProgress).toHaveBeenNthCalledWith(2, 2, 3);
    expect(onProgress).toHaveBeenNthCalledWith(3, 3, 3);
  });
});

// ─── UT-067 ──────────────────────────────────────────────────────────────────

describe('UT-067: importBatch — delayBetween honoured', () => {
  let getPrefMock;
  let getOrCreateTargetCollectionMock;
  let importBatch;

  beforeEach(async () => {
    vi.resetAllMocks();
    const utils = await import('../../content/utils.mjs');
    getPrefMock = utils.getPref;
    getOrCreateTargetCollectionMock = utils.getOrCreateTargetCollection;
    const mod = await import('../../content/fileImporter.mjs');
    importBatch = mod.importBatch;

    getPrefMock.mockImplementation((k) => {
      if (k === 'targetCollection') return 'Inbox';
      if (k === 'importMode') return 'linked';
      return undefined;
    });
    getOrCreateTargetCollectionMock.mockResolvedValue({ id: 10 });

    globalThis.IOUtils.exists = vi.fn(async () => true);
    globalThis.Zotero.Attachments.linkFromFile = vi.fn(async () => ({ id: 1 }));

    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // UT-067a
  it('waits delayBetween ms between successive imports (no delay after the last file)', async () => {
    const files = ['/watch/a.pdf', '/watch/b.pdf'];
    const batchPromise = importBatch(files, { delayBetween: 1000, importMode: 'linked' });

    // Drain microtasks so the loop reaches the first setTimeout.
    await vi.advanceTimersByTimeAsync(0);
    // The first import has resolved but the inter-file delay hasn't elapsed yet,
    // so only one linkFromFile call so far.
    expect(globalThis.Zotero.Attachments.linkFromFile).toHaveBeenCalledTimes(1);

    // Advance just shy of 1000ms — second import still not started.
    await vi.advanceTimersByTimeAsync(999);
    expect(globalThis.Zotero.Attachments.linkFromFile).toHaveBeenCalledTimes(1);

    // Cross the threshold — second import proceeds.
    await vi.advanceTimersByTimeAsync(1);
    const result = await batchPromise;

    expect(globalThis.Zotero.Attachments.linkFromFile).toHaveBeenCalledTimes(2);
    expect(result.success).toHaveLength(2);
  });
});

// ─── UT-068 ──────────────────────────────────────────────────────────────────

describe('UT-068: importBatch — continues after a failing import', () => {
  let getPrefMock;
  let getOrCreateTargetCollectionMock;
  let importBatch;

  beforeEach(async () => {
    vi.resetAllMocks();
    const utils = await import('../../content/utils.mjs');
    getPrefMock = utils.getPref;
    getOrCreateTargetCollectionMock = utils.getOrCreateTargetCollection;
    const mod = await import('../../content/fileImporter.mjs');
    importBatch = mod.importBatch;

    getPrefMock.mockImplementation((k) => {
      if (k === 'targetCollection') return 'Inbox';
      if (k === 'importMode') return 'linked';
      return undefined;
    });
    getOrCreateTargetCollectionMock.mockResolvedValue({ id: 10 });

    globalThis.IOUtils.exists = vi.fn(async () => true);

    // First call succeeds, second call throws, third call succeeds.
    let call = 0;
    globalThis.Zotero.Attachments.linkFromFile = vi.fn(async () => {
      call += 1;
      if (call === 2) throw new Error('disk full');
      return { id: 1000 + call };
    });
  });

  // UT-068a
  it('records the failing file in `failed` and continues with the remaining files', async () => {
    const files = ['/watch/a.pdf', '/watch/b.pdf', '/watch/c.pdf'];
    const result = await importBatch(files, { delayBetween: 0, importMode: 'linked' });

    expect(result.success).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].path).toBe('/watch/b.pdf');
    expect(result.failed[0].error).toMatch(/disk full/);
    expect(globalThis.Zotero.Attachments.linkFromFile).toHaveBeenCalledTimes(3);
    expect(globalThis.Zotero.logError).toHaveBeenCalled();
  });
});

// ─── UT-069 ──────────────────────────────────────────────────────────────────

describe('UT-069: importBatch — handlePostImport flag', () => {
  let getPrefMock;
  let getOrCreateTargetCollectionMock;
  let importBatch;

  beforeEach(async () => {
    vi.resetAllMocks();
    const utils = await import('../../content/utils.mjs');
    getPrefMock = utils.getPref;
    getOrCreateTargetCollectionMock = utils.getOrCreateTargetCollection;
    const mod = await import('../../content/fileImporter.mjs');
    importBatch = mod.importBatch;

    getPrefMock.mockImplementation((k) => {
      if (k === 'targetCollection') return 'Inbox';
      if (k === 'importMode') return 'stored';
      if (k === 'postImportAction') return 'delete';
      return undefined;
    });
    getOrCreateTargetCollectionMock.mockResolvedValue({ id: 10 });

    globalThis.IOUtils.exists = vi.fn(async () => true);
    globalThis.IOUtils.remove = vi.fn(async () => {});
    globalThis.Zotero.Attachments.importFromFile = vi.fn(async () => ({ id: 1 }));
  });

  // UT-069a
  it('handlePostImport=false skips the post-import action (no IOUtils.remove call)', async () => {
    const result = await importBatch(['/watch/a.pdf'], {
      delayBetween: 0,
      handlePostImport: false,
      importMode: 'stored',
    });

    expect(result.success).toHaveLength(1);
    expect(globalThis.Zotero.Attachments.importFromFile).toHaveBeenCalledTimes(1);
    expect(globalThis.IOUtils.remove).not.toHaveBeenCalled();
  });

  // UT-069b
  it('handlePostImport=true (default) triggers the post-import action for stored mode', async () => {
    const result = await importBatch(['/watch/a.pdf'], {
      delayBetween: 0,
      importMode: 'stored',
    });

    expect(result.success).toHaveLength(1);
    expect(globalThis.IOUtils.remove).toHaveBeenCalledTimes(1);
    expect(globalThis.IOUtils.remove).toHaveBeenCalledWith('/watch/a.pdf');
  });
});

// ─── UT-070 ──────────────────────────────────────────────────────────────────

describe('UT-070: importFile — Zotero.Attachments.importFromFile throws', () => {
  let getPrefMock;
  let getOrCreateTargetCollectionMock;
  let importFile;

  beforeEach(async () => {
    vi.resetAllMocks();
    const utils = await import('../../content/utils.mjs');
    getPrefMock = utils.getPref;
    getOrCreateTargetCollectionMock = utils.getOrCreateTargetCollection;
    const mod = await import('../../content/fileImporter.mjs');
    importFile = mod.importFile;

    getPrefMock.mockImplementation((k) => {
      if (k === 'targetCollection') return 'Inbox';
      if (k === 'importMode') return 'stored';
      return undefined;
    });
    getOrCreateTargetCollectionMock.mockResolvedValue({ id: 99 });

    globalThis.IOUtils.exists = vi.fn(async () => true);
    globalThis.Zotero.Attachments.importFromFile = vi.fn(async () => {
      throw new Error('disk corruption');
    });
    globalThis.Zotero.logError = vi.fn();
  });

  // UT-070a
  it('rethrows a wrapped error and calls Zotero.logError', async () => {
    await expect(importFile('/watch/paper.pdf')).rejects.toThrow(
      /Failed to import file: disk corruption/
    );
    expect(globalThis.Zotero.logError).toHaveBeenCalledTimes(1);
    expect(globalThis.Zotero.logError.mock.calls[0][0]).toMatch(/disk corruption/);
  });
});

// ─── UT-071 ──────────────────────────────────────────────────────────────────

describe('UT-071: importFile — file does not exist', () => {
  let getPrefMock;
  let getOrCreateTargetCollectionMock;
  let importFile;

  beforeEach(async () => {
    vi.resetAllMocks();
    const utils = await import('../../content/utils.mjs');
    getPrefMock = utils.getPref;
    getOrCreateTargetCollectionMock = utils.getOrCreateTargetCollection;
    const mod = await import('../../content/fileImporter.mjs');
    importFile = mod.importFile;

    getPrefMock.mockImplementation((k) => {
      if (k === 'targetCollection') return 'Inbox';
      if (k === 'importMode') return 'stored';
      return undefined;
    });

    globalThis.IOUtils.exists = vi.fn(async () => false);
    globalThis.Zotero.Attachments.importFromFile = vi.fn();
    globalThis.Zotero.Attachments.linkFromFile = vi.fn();
  });

  // UT-071a
  it('throws "File does not exist" and never touches Zotero.Attachments', async () => {
    await expect(importFile('/watch/missing.pdf')).rejects.toThrow(
      /File does not exist: \/watch\/missing\.pdf/
    );
    expect(globalThis.Zotero.Attachments.importFromFile).not.toHaveBeenCalled();
    expect(globalThis.Zotero.Attachments.linkFromFile).not.toHaveBeenCalled();
    expect(getOrCreateTargetCollectionMock).not.toHaveBeenCalled();
  });
});

// ─── UT-072 ──────────────────────────────────────────────────────────────────

describe('UT-072: importFile — nested collection path', () => {
  let getPrefMock;
  let getOrCreateTargetCollectionMock;
  let getOrCreateCollectionPathMock;
  let importFile;

  beforeEach(async () => {
    vi.resetAllMocks();
    const utils = await import('../../content/utils.mjs');
    getPrefMock = utils.getPref;
    getOrCreateTargetCollectionMock = utils.getOrCreateTargetCollection;
    getOrCreateCollectionPathMock = utils.getOrCreateCollectionPath;
    const mod = await import('../../content/fileImporter.mjs');
    importFile = mod.importFile;

    getPrefMock.mockImplementation((k) => {
      if (k === 'importMode') return 'stored';
      return undefined;
    });

    getOrCreateCollectionPathMock.mockResolvedValue({ id: 555 });

    globalThis.IOUtils.exists = vi.fn(async () => true);
    globalThis.Zotero.Attachments.importFromFile = vi.fn(async () => ({ id: 2001 }));
  });

  // UT-072a
  it('uses getOrCreateCollectionPath when collectionName contains "/" and forwards the resulting collection id', async () => {
    const item = await importFile('/watch/paper.pdf', {
      collectionName: 'Inbox/Research/AI',
    });

    expect(item).toEqual({ id: 2001 });
    expect(getOrCreateCollectionPathMock).toHaveBeenCalledTimes(1);
    expect(getOrCreateCollectionPathMock).toHaveBeenCalledWith('Inbox/Research/AI', 1);
    expect(getOrCreateTargetCollectionMock).not.toHaveBeenCalled();
    expect(globalThis.Zotero.Attachments.importFromFile).toHaveBeenCalledWith({
      file: '/watch/paper.pdf',
      libraryID: 1,
      collections: [555],
    });
  });
});

// ─── UT-073 ──────────────────────────────────────────────────────────────────

describe('UT-073: importFile — collection helper returns null', () => {
  let getPrefMock;
  let getOrCreateTargetCollectionMock;
  let importFile;

  beforeEach(async () => {
    vi.resetAllMocks();
    const utils = await import('../../content/utils.mjs');
    getPrefMock = utils.getPref;
    getOrCreateTargetCollectionMock = utils.getOrCreateTargetCollection;
    const mod = await import('../../content/fileImporter.mjs');
    importFile = mod.importFile;

    getPrefMock.mockImplementation((k) => {
      if (k === 'targetCollection') return 'Inbox';
      if (k === 'importMode') return 'stored';
      return undefined;
    });

    // Collection creation failed — return null.
    getOrCreateTargetCollectionMock.mockResolvedValue(null);

    globalThis.IOUtils.exists = vi.fn(async () => true);
    globalThis.Zotero.Attachments.importFromFile = vi.fn(async () => ({ id: 3001 }));
  });

  // UT-073a
  it('still imports the item but passes an empty collections array', async () => {
    const item = await importFile('/watch/paper.pdf');

    expect(item).toEqual({ id: 3001 });
    expect(globalThis.Zotero.Attachments.importFromFile).toHaveBeenCalledTimes(1);
    expect(globalThis.Zotero.Attachments.importFromFile).toHaveBeenCalledWith({
      file: '/watch/paper.pdf',
      libraryID: 1,
      collections: [],
    });
  });
});
