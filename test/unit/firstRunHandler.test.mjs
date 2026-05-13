/**
 * Unit tests for content/firstRunHandler.mjs
 * Covers: UT-049 (checkFirstRun no-sourcePath guard).
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
