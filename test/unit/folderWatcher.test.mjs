/**
 * Unit tests for content/folderWatcher.mjs
 *
 * Covers UT-066 — FolderWatcher disk-side polling.
 *
 * FolderWatcher is the reverse-direction watcher that polls the mirror
 * directory for filesystem changes and forwards them to the sync service.
 *
 * We use vi.useFakeTimers() to drive the polling loop deterministically.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../content/utils.mjs', () => ({
  getPref: vi.fn(),
}));

describe('UT-066: FolderWatcher', () => {
  let FolderWatcher;
  let resetFolderWatcher;
  let getFolderWatcher;
  let getPrefMock;
  let syncService;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetAllMocks();

    const mod = await import('../../content/folderWatcher.mjs');
    FolderWatcher = mod.FolderWatcher;
    resetFolderWatcher = mod.resetFolderWatcher;
    getFolderWatcher = mod.getFolderWatcher;
    resetFolderWatcher();

    const utils = await import('../../content/utils.mjs');
    getPrefMock = utils.getPref;
    getPrefMock.mockReturnValue(10); // default 10 seconds

    syncService = {
      isSyncing: false,
      mirrorPath: '/mirror',
      handleFolderCreated: vi.fn(async () => {}),
      handleFolderDeleted: vi.fn(async () => {}),
      handleFileCreatedInMirror: vi.fn(async () => {}),
      handleFileDeletedFromMirror: vi.fn(async () => {}),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─────────────────────────────────────────────────────────────────────
  // UT-066a: start/stop lifecycle
  // ─────────────────────────────────────────────────────────────────────

  it('UT-066a: start() flips watching, reads pref, and schedules a timer', () => {
    const w = new FolderWatcher(syncService);
    w.start();
    expect(w.isWatching()).toBe(true);
    expect(getPrefMock).toHaveBeenCalledWith('mirrorPollInterval');
    // Poll interval converted to ms
    expect(w._pollInterval).toBe(10000);
    expect(w._pollTimer).not.toBeNull();
  });

  it('UT-066b: start() is idempotent', () => {
    const w = new FolderWatcher(syncService);
    w.start();
    const firstTimer = w._pollTimer;
    w.start();
    expect(w._pollTimer).toBe(firstTimer);
  });

  it('UT-066c: stop() clears the timer and flips watching off', () => {
    const w = new FolderWatcher(syncService);
    w.start();
    w.stop();
    expect(w.isWatching()).toBe(false);
    expect(w._pollTimer).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────
  // UT-066d: scan when mirror path does not exist (silent pause)
  // ─────────────────────────────────────────────────────────────────────

  it('UT-066d: skips scan when mirror path does not exist', async () => {
    globalThis.IOUtils.exists = vi.fn(async () => false);
    globalThis.IOUtils.getChildren = vi.fn(async () => []);

    const w = new FolderWatcher(syncService);
    await w.forceScan();

    expect(globalThis.IOUtils.getChildren).not.toHaveBeenCalled();
    expect(syncService.handleFolderCreated).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────────
  // UT-066e: skip scan when sync service is busy (no overlap)
  // ─────────────────────────────────────────────────────────────────────

  it('UT-066e: skips scan when syncService.isSyncing is true', async () => {
    syncService.isSyncing = true;
    globalThis.IOUtils.exists = vi.fn(async () => true);
    globalThis.IOUtils.getChildren = vi.fn(async () => ['/mirror/a.pdf']);

    const w = new FolderWatcher(syncService);
    await w.forceScan();

    expect(globalThis.IOUtils.getChildren).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────────
  // UT-066f: detect new files and folders on first scan
  // ─────────────────────────────────────────────────────────────────────

  it('UT-066f: first scan detects new folders and new files and dispatches them', async () => {
    globalThis.IOUtils.exists = vi.fn(async () => true);

    // /mirror contains one subfolder and one file
    globalThis.IOUtils.getChildren = vi.fn(async (path) => {
      if (path === '/mirror') return ['/mirror/sub', '/mirror/top.pdf'];
      if (path === '/mirror/sub') return ['/mirror/sub/nested.pdf'];
      return [];
    });
    globalThis.IOUtils.stat = vi.fn(async (path) => {
      if (path === '/mirror/sub') return { type: 'directory', lastModified: 1, size: 0 };
      return { type: 'regular', lastModified: 1, size: 100 };
    });

    const w = new FolderWatcher(syncService);
    await w.forceScan();

    // Folder change should fire BEFORE file changes (sort order)
    const folderCalls = syncService.handleFolderCreated.mock.invocationCallOrder;
    const fileCalls = syncService.handleFileCreatedInMirror.mock.invocationCallOrder;

    expect(syncService.handleFolderCreated).toHaveBeenCalledWith('/mirror/sub');
    expect(syncService.handleFileCreatedInMirror).toHaveBeenCalledWith('/mirror/top.pdf');
    expect(syncService.handleFileCreatedInMirror).toHaveBeenCalledWith('/mirror/sub/nested.pdf');

    // All folder calls happen before any file call
    if (folderCalls.length && fileCalls.length) {
      expect(Math.max(...folderCalls)).toBeLessThan(Math.min(...fileCalls));
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // UT-066g: detect deletions on second scan
  // ─────────────────────────────────────────────────────────────────────

  it('UT-066g: detects deletions when a previously seen entry vanishes', async () => {
    globalThis.IOUtils.exists = vi.fn(async () => true);
    const w = new FolderWatcher(syncService);

    // Seed _lastScan with one folder and one file
    w._lastScan = new Map([
      ['/mirror/sub', { type: 'directory', mtime: 1, size: 0 }],
      ['/mirror/old.pdf', { type: 'regular', mtime: 1, size: 100 }],
    ]);

    // Now the mirror is empty
    globalThis.IOUtils.getChildren = vi.fn(async () => []);
    globalThis.IOUtils.stat = vi.fn(async () => ({ type: 'regular', lastModified: 1, size: 0 }));

    await w.forceScan();

    expect(syncService.handleFolderDeleted).toHaveBeenCalledWith('/mirror/sub');
    expect(syncService.handleFileDeletedFromMirror).toHaveBeenCalledWith('/mirror/old.pdf');
  });

  // ─────────────────────────────────────────────────────────────────────
  // UT-066h: unchanged files produce no calls
  // ─────────────────────────────────────────────────────────────────────

  it('UT-066h: a stable file (same mtime, same size) produces no handler calls', async () => {
    globalThis.IOUtils.exists = vi.fn(async () => true);
    globalThis.IOUtils.getChildren = vi.fn(async (path) =>
      path === '/mirror' ? ['/mirror/stable.pdf'] : []);
    globalThis.IOUtils.stat = vi.fn(async () => ({
      type: 'regular', lastModified: 42, size: 100,
    }));

    const w = new FolderWatcher(syncService);
    w._lastScan = new Map([
      ['/mirror/stable.pdf', { type: 'regular', mtime: 42, size: 100 }],
    ]);

    await w.forceScan();

    expect(syncService.handleFileCreatedInMirror).not.toHaveBeenCalled();
    expect(syncService.handleFileDeletedFromMirror).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────────
  // UT-066i: poll timer wiring via fake timers
  // ─────────────────────────────────────────────────────────────────────

  it('UT-066i: the polling timer reschedules itself after each scan', async () => {
    globalThis.IOUtils.exists = vi.fn(async () => true);
    globalThis.IOUtils.getChildren = vi.fn(async () => []);

    const w = new FolderWatcher(syncService);
    w.start();
    expect(w._pollTimer).not.toBeNull();

    // Advance timers + drain microtasks; new timer should be scheduled afterwards
    await vi.advanceTimersByTimeAsync(10000);
    expect(w._pollTimer).not.toBeNull();

    w.stop();
  });

  // ─────────────────────────────────────────────────────────────────────
  // UT-066j: scan continues when an individual directory traversal fails
  // ─────────────────────────────────────────────────────────────────────

  it('UT-066j: a thrown stat() in subfolder traversal does not abort the whole scan', async () => {
    globalThis.IOUtils.exists = vi.fn(async () => true);
    globalThis.IOUtils.getChildren = vi.fn(async (path) =>
      path === '/mirror' ? ['/mirror/ok.pdf'] : []);
    globalThis.IOUtils.stat = vi.fn(async () => {
      throw new Error('stat failed');
    });

    const w = new FolderWatcher(syncService);
    await expect(w.forceScan()).resolves.toBeUndefined();
    // No handler dispatched because stat failed
    expect(syncService.handleFileCreatedInMirror).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────────
  // UT-066k: getFolderWatcher singleton
  // ─────────────────────────────────────────────────────────────────────

  it('UT-066k: getFolderWatcher returns a singleton instance', () => {
    const w1 = getFolderWatcher(syncService);
    const w2 = getFolderWatcher(syncService);
    expect(w1).toBe(w2);
  });

  // ─────────────────────────────────────────────────────────────────────
  // UT-066l: updateInterval reads pref again
  // ─────────────────────────────────────────────────────────────────────

  it('UT-066l: updateInterval() refreshes pollInterval from prefs', () => {
    const w = new FolderWatcher(syncService);
    w._pollInterval = 5000;
    getPrefMock.mockReturnValue(30);
    w.updateInterval();
    expect(w._pollInterval).toBe(30000);
  });
});
