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
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
