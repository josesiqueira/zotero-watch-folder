/**
 * Unit tests for content/firstRunHandler.mjs
 * Covers:
 *   UT-049 checkFirstRun no_path guard
 *   UT-054 checkFirstRun path_changed
 *   UT-055 checkFirstRun fresh_install
 *   UT-056 checkFirstRun normal
 *   UT-057 getExistingFilesCount happy path + empty source
 *   UT-058 getExistingFilesCount scanFolder error
 *   UT-059 showFirstRunPrompt return mapping
 *   UT-060 importExistingFiles empty files
 *   UT-061 importExistingFiles delegates to importBatch
 *   UT-062 handleFirstRun orchestrator branches
 *   UT-063 resetFirstRunState clears pref
 *
 * Earlier UT-042..UT-048 cases tested private helpers from a previous
 * bidirectional-reconciliation design (_relativePath, _parentRel,
 * buildMergePlan). That design is no longer in this codebase, so those
 * cases were removed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../content/utils.mjs', () => ({
  getPref: vi.fn(),
  setPref: vi.fn(),
  getFileHash: vi.fn(),
}));

vi.mock('../../content/trackingStore.mjs', () => ({
  getTrackingStore: vi.fn(),
}));

vi.mock('../../content/fileScanner.mjs', () => ({
  scanFolder: vi.fn(),
  scanFolderRecursive: vi.fn(),
}));

vi.mock('../../content/fileImporter.mjs', () => ({
  importFile: vi.fn(),
  importBatch: vi.fn(),
}));

vi.mock('../../content/fileRenamer.mjs', () => ({
  renameAttachment: vi.fn(),
}));

describe('UT-049: checkFirstRun — no sourcePath configured', () => {
  let getPrefMock;
  let getTrackingStoreMock;
  let checkFirstRun;

  beforeEach(async () => {
    vi.resetAllMocks();

    const utilsMod = await import('../../content/utils.mjs');
    getPrefMock = utilsMod.getPref;

    const trackingMod = await import('../../content/trackingStore.mjs');
    getTrackingStoreMock = trackingMod.getTrackingStore;

    const mod = await import('../../content/firstRunHandler.mjs');
    checkFirstRun = mod.checkFirstRun;
  });

  // UT-049a
  it('returns { isFirstRun: false, reason: "no_path" } when sourcePath is empty string', async () => {
    getPrefMock.mockImplementation((key) => {
      if (key === 'sourcePath') return '';
      if (key === 'lastWatchedPath') return '/some/previous/path';
      return '';
    });

    const result = await checkFirstRun();

    expect(result).toEqual({ isFirstRun: false, reason: 'no_path' });
    expect(getTrackingStoreMock).not.toHaveBeenCalled();
  });

  // UT-049b
  it('returns { isFirstRun: false, reason: "no_path" } when sourcePath is null/falsy', async () => {
    getPrefMock.mockImplementation((key) => {
      if (key === 'sourcePath') return null;
      return '';
    });

    const result = await checkFirstRun();

    expect(result).toEqual({ isFirstRun: false, reason: 'no_path' });
    expect(getTrackingStoreMock).not.toHaveBeenCalled();
  });
});

describe('UT-054: checkFirstRun — path_changed when lastWatchedPath differs', () => {
  let getPrefMock;
  let getTrackingStoreMock;
  let checkFirstRun;

  beforeEach(async () => {
    vi.resetAllMocks();
    const utilsMod = await import('../../content/utils.mjs');
    getPrefMock = utilsMod.getPref;
    const trackingMod = await import('../../content/trackingStore.mjs');
    getTrackingStoreMock = trackingMod.getTrackingStore;
    const mod = await import('../../content/firstRunHandler.mjs');
    checkFirstRun = mod.checkFirstRun;
  });

  it('returns isFirstRun=true with reason "path_changed" when lastWatchedPath !== sourcePath', async () => {
    getPrefMock.mockImplementation((key) => {
      if (key === 'sourcePath') return '/new/path';
      if (key === 'lastWatchedPath') return '/old/path';
      return '';
    });

    const result = await checkFirstRun();

    expect(result).toEqual({ isFirstRun: true, reason: 'path_changed' });
    // We should short-circuit before consulting the tracking store.
    expect(getTrackingStoreMock).not.toHaveBeenCalled();
  });
});

describe('UT-055: checkFirstRun — fresh_install when no lastWatchedPath and tracking empty', () => {
  let getPrefMock;
  let getTrackingStoreMock;
  let checkFirstRun;

  beforeEach(async () => {
    vi.resetAllMocks();
    const utilsMod = await import('../../content/utils.mjs');
    getPrefMock = utilsMod.getPref;
    const trackingMod = await import('../../content/trackingStore.mjs');
    getTrackingStoreMock = trackingMod.getTrackingStore;
    const mod = await import('../../content/firstRunHandler.mjs');
    checkFirstRun = mod.checkFirstRun;
  });

  it('returns isFirstRun=true with reason "fresh_install" when no lastPath and stats.total === 0', async () => {
    getPrefMock.mockImplementation((key) => {
      if (key === 'sourcePath') return '/configured/path';
      if (key === 'lastWatchedPath') return '';
      return '';
    });
    const getStatsMock = vi.fn(() => ({ total: 0 }));
    getTrackingStoreMock.mockReturnValue({ getStats: getStatsMock });

    const result = await checkFirstRun();

    expect(result).toEqual({ isFirstRun: true, reason: 'fresh_install' });
    expect(getTrackingStoreMock).toHaveBeenCalledTimes(1);
    expect(getStatsMock).toHaveBeenCalledTimes(1);
  });
});

describe('UT-056: checkFirstRun — normal when paths match and tracking has records', () => {
  let getPrefMock;
  let getTrackingStoreMock;
  let checkFirstRun;

  beforeEach(async () => {
    vi.resetAllMocks();
    const utilsMod = await import('../../content/utils.mjs');
    getPrefMock = utilsMod.getPref;
    const trackingMod = await import('../../content/trackingStore.mjs');
    getTrackingStoreMock = trackingMod.getTrackingStore;
    const mod = await import('../../content/firstRunHandler.mjs');
    checkFirstRun = mod.checkFirstRun;
  });

  it('returns isFirstRun=false with reason "normal" when lastPath === sourcePath and tracking is non-empty', async () => {
    getPrefMock.mockImplementation((key) => {
      if (key === 'sourcePath') return '/configured/path';
      if (key === 'lastWatchedPath') return '/configured/path';
      return '';
    });
    getTrackingStoreMock.mockReturnValue({
      getStats: vi.fn(() => ({ total: 42 })),
    });

    const result = await checkFirstRun();

    expect(result).toEqual({ isFirstRun: false, reason: 'normal' });
  });

  it('also returns "normal" when lastPath === sourcePath even if tracking is empty (paths matched branch)', async () => {
    // When lastPath is truthy and equals sourcePath, the "fresh_install"
    // branch is gated by `!lastPath`, so we must fall through to "normal".
    getPrefMock.mockImplementation((key) => {
      if (key === 'sourcePath') return '/configured/path';
      if (key === 'lastWatchedPath') return '/configured/path';
      return '';
    });
    getTrackingStoreMock.mockReturnValue({
      getStats: vi.fn(() => ({ total: 0 })),
    });

    const result = await checkFirstRun();
    expect(result).toEqual({ isFirstRun: false, reason: 'normal' });
  });
});

describe('UT-057: getExistingFilesCount — happy path and empty sourcePath', () => {
  let getPrefMock;
  let scanFolderMock;
  let getExistingFilesCount;

  beforeEach(async () => {
    vi.resetAllMocks();
    const utilsMod = await import('../../content/utils.mjs');
    getPrefMock = utilsMod.getPref;
    const scannerMod = await import('../../content/fileScanner.mjs');
    scanFolderMock = scannerMod.scanFolder;
    const mod = await import('../../content/firstRunHandler.mjs');
    getExistingFilesCount = mod.getExistingFilesCount;
  });

  it('returns { count, files } from scanFolder when sourcePath is set', async () => {
    getPrefMock.mockImplementation((key) => (key === 'sourcePath' ? '/watch' : ''));
    const fakeFiles = [
      { path: '/watch/a.pdf' },
      { path: '/watch/b.pdf' },
      { path: '/watch/c.pdf' },
    ];
    scanFolderMock.mockResolvedValue(fakeFiles);

    const result = await getExistingFilesCount();

    expect(scanFolderMock).toHaveBeenCalledWith('/watch');
    expect(result).toEqual({ count: 3, files: fakeFiles });
  });

  it('returns { count: 0, files: [] } when sourcePath is empty', async () => {
    getPrefMock.mockImplementation(() => '');

    const result = await getExistingFilesCount();

    expect(result).toEqual({ count: 0, files: [] });
    expect(scanFolderMock).not.toHaveBeenCalled();
  });
});

describe('UT-058: getExistingFilesCount — scanFolder throws', () => {
  let getPrefMock;
  let scanFolderMock;
  let getExistingFilesCount;

  beforeEach(async () => {
    vi.resetAllMocks();
    const utilsMod = await import('../../content/utils.mjs');
    getPrefMock = utilsMod.getPref;
    const scannerMod = await import('../../content/fileScanner.mjs');
    scanFolderMock = scannerMod.scanFolder;
    const mod = await import('../../content/firstRunHandler.mjs');
    getExistingFilesCount = mod.getExistingFilesCount;
  });

  it('swallows the error and returns { count: 0, files: [] }', async () => {
    getPrefMock.mockImplementation((key) => (key === 'sourcePath' ? '/watch' : ''));
    scanFolderMock.mockRejectedValue(new Error('permission denied'));

    const result = await getExistingFilesCount();

    expect(result).toEqual({ count: 0, files: [] });
    expect(Zotero.debug).toHaveBeenCalled();
    const debugMsg = Zotero.debug.mock.calls.map((c) => c[0]).join('\n');
    expect(debugMsg).toContain('permission denied');
  });
});

describe('UT-059: showFirstRunPrompt — confirmEx return mapping', () => {
  let showFirstRunPrompt;

  beforeEach(async () => {
    vi.resetAllMocks();
    const mod = await import('../../content/firstRunHandler.mjs');
    showFirstRunPrompt = mod.showFirstRunPrompt;
  });

  function makeWindowWithFailingL10n() {
    return {
      document: {
        l10n: {
          formatValue: vi.fn(async () => {
            throw new Error('no l10n');
          }),
        },
      },
    };
  }

  it('returns "import" when confirmEx returns 0', async () => {
    Services.prompt.confirmEx = vi.fn(() => 0);
    const result = await showFirstRunPrompt(makeWindowWithFailingL10n(), 5);
    expect(result).toBe('import');
    expect(Services.prompt.confirmEx).toHaveBeenCalledTimes(1);
  });

  it('returns "skip" when confirmEx returns 1', async () => {
    Services.prompt.confirmEx = vi.fn(() => 1);
    const result = await showFirstRunPrompt(makeWindowWithFailingL10n(), 5);
    expect(result).toBe('skip');
  });

  it('returns "cancel" for any other result (e.g. 2)', async () => {
    Services.prompt.confirmEx = vi.fn(() => 2);
    const result = await showFirstRunPrompt(makeWindowWithFailingL10n(), 5);
    expect(result).toBe('cancel');
  });

  it('returns "cancel" for unexpected values too (e.g. -1)', async () => {
    Services.prompt.confirmEx = vi.fn(() => -1);
    const result = await showFirstRunPrompt(makeWindowWithFailingL10n(), 5);
    expect(result).toBe('cancel');
  });

  it('uses localized strings when l10n succeeds', async () => {
    Services.prompt.confirmEx = vi.fn(() => 0);
    const win = {
      document: {
        l10n: {
          formatValue: vi.fn(async (key) => `LOC:${key}`),
        },
      },
    };
    const result = await showFirstRunPrompt(win, 7);
    expect(result).toBe('import');
    expect(win.document.l10n.formatValue).toHaveBeenCalled();
  });
});

describe('UT-060: importExistingFiles — empty files array', () => {
  let importExistingFiles;
  let importBatchMock;

  beforeEach(async () => {
    vi.resetAllMocks();
    const importerMod = await import('../../content/fileImporter.mjs');
    importBatchMock = importerMod.importBatch;
    const mod = await import('../../content/firstRunHandler.mjs');
    importExistingFiles = mod.importExistingFiles;
  });

  it('returns { imported: 0, failed: 0, cancelled: false } for empty array without calling importBatch', async () => {
    const result = await importExistingFiles({}, []);
    expect(result).toEqual({ imported: 0, failed: 0, cancelled: false });
    expect(importBatchMock).not.toHaveBeenCalled();
  });

  it('returns the same for null files', async () => {
    const result = await importExistingFiles({}, null);
    expect(result).toEqual({ imported: 0, failed: 0, cancelled: false });
    expect(importBatchMock).not.toHaveBeenCalled();
  });
});

describe('UT-061: importExistingFiles — delegates to importBatch and maps results', () => {
  let importExistingFiles;
  let importBatchMock;

  beforeEach(async () => {
    vi.resetAllMocks();
    const importerMod = await import('../../content/fileImporter.mjs');
    importBatchMock = importerMod.importBatch;
    const mod = await import('../../content/firstRunHandler.mjs');
    importExistingFiles = mod.importExistingFiles;
  });

  it('passes the file paths to importBatch and returns mapped counts (all success)', async () => {
    importBatchMock.mockImplementation(async (paths, opts) => {
      // exercise the onProgress callback to cover those lines
      if (opts && typeof opts.onProgress === 'function') {
        opts.onProgress(1, paths.length);
        opts.onProgress(paths.length, paths.length);
      }
      return {
        success: paths.map((p) => ({ path: p })),
        failed: [],
      };
    });

    const files = [{ path: '/a.pdf' }, { path: '/b.pdf' }];
    const result = await importExistingFiles({}, files);

    expect(importBatchMock).toHaveBeenCalledTimes(1);
    const [pathsArg, optsArg] = importBatchMock.mock.calls[0];
    expect(pathsArg).toEqual(['/a.pdf', '/b.pdf']);
    expect(optsArg).toMatchObject({ delayBetween: 300 });
    expect(typeof optsArg.onProgress).toBe('function');

    expect(result).toEqual({ imported: 2, failed: 0, cancelled: false });
  });

  it('reports failures when importBatch returns failed entries', async () => {
    importBatchMock.mockResolvedValue({
      success: [{ path: '/a.pdf' }],
      failed: [{ path: '/b.pdf', error: 'boom' }],
    });

    const result = await importExistingFiles({}, [{ path: '/a.pdf' }, { path: '/b.pdf' }]);
    expect(result).toEqual({ imported: 1, failed: 1, cancelled: false });
  });
});

describe('UT-062: handleFirstRun — orchestrator branches', () => {
  let getPrefMock;
  let setPrefMock;
  let getTrackingStoreMock;
  let scanFolderMock;
  let importBatchMock;
  let handleFirstRun;

  beforeEach(async () => {
    vi.resetAllMocks();

    const utilsMod = await import('../../content/utils.mjs');
    getPrefMock = utilsMod.getPref;
    setPrefMock = utilsMod.setPref;

    const trackingMod = await import('../../content/trackingStore.mjs');
    getTrackingStoreMock = trackingMod.getTrackingStore;

    const scannerMod = await import('../../content/fileScanner.mjs');
    scanFolderMock = scannerMod.scanFolder;

    const importerMod = await import('../../content/fileImporter.mjs');
    importBatchMock = importerMod.importBatch;

    const mod = await import('../../content/firstRunHandler.mjs');
    handleFirstRun = mod.handleFirstRun;
  });

  function freshInstallPrefs() {
    getPrefMock.mockImplementation((key) => {
      if (key === 'sourcePath') return '/watch';
      if (key === 'lastWatchedPath') return '';
      return '';
    });
    getTrackingStoreMock.mockReturnValue({
      getStats: vi.fn(() => ({ total: 0 })),
    });
  }

  function makeWindow() {
    return {
      document: {
        l10n: {
          formatValue: vi.fn(async () => {
            throw new Error('no l10n');
          }),
        },
      },
    };
  }

  it('returns { handled: false, imported: 0 } immediately when not a first run', async () => {
    // Configured + matching lastPath + non-empty tracking => "normal"
    getPrefMock.mockImplementation((key) => {
      if (key === 'sourcePath') return '/watch';
      if (key === 'lastWatchedPath') return '/watch';
      return '';
    });
    getTrackingStoreMock.mockReturnValue({
      getStats: vi.fn(() => ({ total: 5 })),
    });

    const result = await handleFirstRun(makeWindow());

    expect(result).toEqual({ handled: false, imported: 0 });
    expect(scanFolderMock).not.toHaveBeenCalled();
    expect(setPrefMock).not.toHaveBeenCalled();
  });

  it('marks first run complete and imports nothing when no files are found', async () => {
    freshInstallPrefs();
    scanFolderMock.mockResolvedValue([]);

    const result = await handleFirstRun(makeWindow());

    expect(result).toEqual({ handled: true, imported: 0 });
    // markFirstRunComplete sets lastWatchedPath to current sourcePath
    expect(setPrefMock).toHaveBeenCalledWith('lastWatchedPath', '/watch');
    // No import attempt
    expect(importBatchMock).not.toHaveBeenCalled();
    // No prompt either
    expect(Services.prompt.confirmEx).not.toHaveBeenCalled();
  });

  it('marks complete with imported=0 when user picks "skip"', async () => {
    freshInstallPrefs();
    scanFolderMock.mockResolvedValue([{ path: '/watch/a.pdf' }]);
    Services.prompt.confirmEx = vi.fn(() => 1); // skip

    const result = await handleFirstRun(makeWindow());

    expect(result).toEqual({ handled: true, imported: 0 });
    expect(importBatchMock).not.toHaveBeenCalled();
    expect(setPrefMock).toHaveBeenCalledWith('lastWatchedPath', '/watch');
  });

  it('does NOT mark complete when user picks "cancel"', async () => {
    freshInstallPrefs();
    scanFolderMock.mockResolvedValue([{ path: '/watch/a.pdf' }]);
    Services.prompt.confirmEx = vi.fn(() => 2); // cancel

    const result = await handleFirstRun(makeWindow());

    expect(result).toEqual({ handled: false, imported: 0 });
    expect(importBatchMock).not.toHaveBeenCalled();
    // lastWatchedPath must not be persisted on cancel
    expect(setPrefMock).not.toHaveBeenCalledWith('lastWatchedPath', expect.anything());
  });

  it('imports files and marks complete when user picks "import"', async () => {
    freshInstallPrefs();
    const files = [{ path: '/watch/a.pdf' }, { path: '/watch/b.pdf' }];
    scanFolderMock.mockResolvedValue(files);
    Services.prompt.confirmEx = vi.fn(() => 0); // import
    importBatchMock.mockResolvedValue({
      success: [{ path: '/watch/a.pdf' }, { path: '/watch/b.pdf' }],
      failed: [],
    });

    const result = await handleFirstRun(makeWindow());

    expect(result).toEqual({ handled: true, imported: 2 });
    expect(importBatchMock).toHaveBeenCalledTimes(1);
    expect(importBatchMock.mock.calls[0][0]).toEqual(['/watch/a.pdf', '/watch/b.pdf']);
    expect(setPrefMock).toHaveBeenCalledWith('lastWatchedPath', '/watch');
  });
});

describe('UT-063: resetFirstRunState — clears lastWatchedPath pref', () => {
  let setPrefMock;
  let resetFirstRunState;
  let rescanExistingFiles;

  beforeEach(async () => {
    vi.resetAllMocks();
    const utilsMod = await import('../../content/utils.mjs');
    setPrefMock = utilsMod.setPref;
    const mod = await import('../../content/firstRunHandler.mjs');
    resetFirstRunState = mod.resetFirstRunState;
    rescanExistingFiles = mod.rescanExistingFiles;
  });

  it('calls setPref("lastWatchedPath", "")', () => {
    resetFirstRunState();
    expect(setPrefMock).toHaveBeenCalledTimes(1);
    expect(setPrefMock).toHaveBeenCalledWith('lastWatchedPath', '');
  });

  it('rescanExistingFiles resets state and then runs handleFirstRun', async () => {
    // Arrange prefs so handleFirstRun short-circuits at the no_path guard
    // (sourcePath empty => not-first-run => returns immediately).
    const utilsMod = await import('../../content/utils.mjs');
    utilsMod.getPref.mockImplementation(() => '');

    const result = await rescanExistingFiles({});

    expect(setPrefMock).toHaveBeenCalledWith('lastWatchedPath', '');
    expect(result).toEqual({ handled: false, imported: 0 });
  });
});
