/**
 * Unit tests for content/syncCoordinator.mjs — runtime mode-observer teardown.
 *
 * TEST-3 (launch v2.6.3): coverage for the "stop-deleting transition". When a
 * user switches Mode 3 → Mode 1 via the runtime mode-pref observer
 * (`SyncCoordinator._modeObserverID`), the destructive Mode-3 wiring
 * (collectionWatcher / itemAddHandler / folderEventDetector) MUST tear down
 * with no restart, so no further `localFolderDeleted` / Zotero-trash
 * propagation can occur.
 *
 * Covers:
 *   UT-610 init() registers the runtime mode-pref observer (global path).
 *   UT-611 start() in mode3 wires collectionWatcher + itemAddHandler + baseline.
 *   UT-612 mode3→mode1 at runtime tears down the Mode-3 wiring (stop()).
 *   UT-613 after teardown, notifyScanCycle no longer drives folderEventDetector
 *          (no further local-folder-deletion propagation).
 *   UT-614 mode3→mode1 when not running is a safe no-op.
 *   UT-615 mode3→mode1 with mode unchanged (mode3→mode3) leaves wiring intact.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock collaborators BEFORE importing the SUT so vi.mock hoists correctly.
vi.mock('../../content/collectionWatcher.mjs', () => ({
  start: vi.fn(),
  stop: vi.fn(),
}));
vi.mock('../../content/itemAddHandler.mjs', () => ({
  start: vi.fn(),
  stop: vi.fn(),
}));
vi.mock('../../content/folderEventDetector.mjs', () => ({
  detectFolderEvents: vi.fn(async () => {}),
}));
vi.mock('../../content/mirrorExecutor.mjs', () => ({
  init: vi.fn(),
  reset: vi.fn(),
  execute: vi.fn(async () => ({ ok: false, reason: 'mocked' })),
}));
vi.mock('../../content/baseline.mjs', () => ({
  runBaseline: vi.fn(async () => ({ ok: true })),
}));

import * as collectionWatcher from '../../content/collectionWatcher.mjs';
import * as itemAddHandler from '../../content/itemAddHandler.mjs';
import * as folderEventDetector from '../../content/folderEventDetector.mjs';
import * as mirrorExecutor from '../../content/mirrorExecutor.mjs';
import * as baseline from '../../content/baseline.mjs';
import { getSyncCoordinator, resetSyncCoordinator } from '../../content/syncCoordinator.mjs';

// ─── Test fixtures ───────────────────────────────────────────────────────────

const PREFIX = 'extensions.zotero.watchFolder.';

/**
 * Install a mutable pref-backing map + a registerObserver stub that captures
 * the registered callback so a test can fire it directly (mirrors how Zotero
 * fans a pref change out to the observer).
 *
 * @param {Object} initial pref keys (un-prefixed)
 * @returns {{ values, fireModeObserver }}
 */
function installPrefs(initial = {}) {
  const values = { ...initial };
  let modeObserverCb = null;

  Zotero.Prefs.get = vi.fn((fullKey) => {
    if (fullKey.startsWith(PREFIX)) return values[fullKey.slice(PREFIX.length)];
    return undefined;
  });
  Zotero.Prefs.set = vi.fn((fullKey, val) => {
    if (fullKey.startsWith(PREFIX)) values[fullKey.slice(PREFIX.length)] = val;
  });
  Zotero.Prefs.registerObserver = vi.fn((path, cb, _global) => {
    if (path === `${PREFIX}mode`) modeObserverCb = cb;
    return 'mode-observer-1';
  });
  Zotero.Prefs.unregisterObserver = vi.fn();

  return {
    values,
    /** Simulate a runtime mode-pref change firing the registered observer. */
    async fireModeObserver(newMode) {
      values.mode = newMode;
      expect(typeof modeObserverCb).toBe('function');
      // The observer callback is sync-and-fire-and-forget in the SUT; it
      // kicks off _onModeChanged() and swallows its promise. Invoke the async
      // transition directly so the test can await full teardown.
      await modeObserverCb();
      // Give the swallowed promise chain a turn to settle.
      await Promise.resolve();
    },
    getRegisteredCallback: () => modeObserverCb,
  };
}

function makeStore() {
  return {
    getCollectionRecord: vi.fn(() => null),
    save: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  // Reset the SUT singleton FIRST — resetSyncCoordinator() calls destroy() on
  // any prior instance, which fires collectionWatcher.stop()/itemAddHandler.stop()
  // on the mocks. Clear the mocks AFTER so those teardown calls don't leak into
  // the next test's call counts.
  resetSyncCoordinator();
  vi.clearAllMocks();
});

// ─── UT-610 ──────────────────────────────────────────────────────────────────

describe('SyncCoordinator runtime mode observer', () => {
  it('UT-610 init() registers the mode-pref observer on the global path', async () => {
    installPrefs({ mode: 'mode3', enabled: true });
    const coord = getSyncCoordinator();
    await coord.init(makeStore());

    expect(Zotero.Prefs.registerObserver).toHaveBeenCalledWith(
      `${PREFIX}mode`,
      expect.any(Function),
      true, // MUST be the global flag — fully-qualified pref path.
    );
  });

  // ─── UT-611 ────────────────────────────────────────────────────────────────

  it('UT-611 start() in mode3 wires collectionWatcher + itemAddHandler + baseline', async () => {
    installPrefs({ mode: 'mode3', enabled: true });
    const coord = getSyncCoordinator();
    await coord.init(makeStore());
    await coord.start();

    expect(baseline.runBaseline).toHaveBeenCalledTimes(1);
    expect(collectionWatcher.start).toHaveBeenCalledTimes(1);
    expect(itemAddHandler.start).toHaveBeenCalledTimes(1);
    expect(coord.isRunning()).toBe(true);
  });

  // ─── UT-612 ────────────────────────────────────────────────────────────────

  it('UT-612 mode3→mode1 at runtime tears down the Mode-3 wiring', async () => {
    const prefs = installPrefs({ mode: 'mode3', enabled: true });
    const coord = getSyncCoordinator();
    await coord.init(makeStore());
    await coord.start();
    expect(coord.isRunning()).toBe(true);

    // User flips mode3 → mode1 at runtime. The observer fires.
    await prefs.fireModeObserver('mode1');

    // The destructive Mode-3 observers must be torn down.
    expect(collectionWatcher.stop).toHaveBeenCalledTimes(1);
    expect(itemAddHandler.stop).toHaveBeenCalledTimes(1);
    expect(coord.isRunning()).toBe(false);
  });

  // ─── UT-613 ────────────────────────────────────────────────────────────────

  it('UT-613 after mode3→mode1 teardown, notifyScanCycle no longer drives folderEventDetector', async () => {
    const prefs = installPrefs({ mode: 'mode3', enabled: true });
    const coord = getSyncCoordinator();
    await coord.init(makeStore());
    await coord.start();

    // While running, a scan cycle drives the disk-side detector (the path that
    // would emit localFolderDeleted / propagate deletions to Zotero).
    await coord.notifyScanCycle({ onDiskAbsDirs: new Set(), watchRoot: '/w' });
    expect(folderEventDetector.detectFolderEvents).toHaveBeenCalledTimes(1);

    // Flip to mode1 — deletion propagation must stop.
    await prefs.fireModeObserver('mode1');
    folderEventDetector.detectFolderEvents.mockClear();

    // A subsequent scan cycle must NOT reach the detector — no further
    // local-folder-deletion → Zotero-trash propagation.
    await coord.notifyScanCycle({ onDiskAbsDirs: new Set(), watchRoot: '/w' });
    expect(folderEventDetector.detectFolderEvents).not.toHaveBeenCalled();
  });

  // ─── UT-614 ────────────────────────────────────────────────────────────────

  it('UT-614 mode3→mode1 when not running is a safe no-op', async () => {
    const prefs = installPrefs({ mode: 'mode3', enabled: true });
    const coord = getSyncCoordinator();
    await coord.init(makeStore());
    // Note: start() never called — coordinator is initialized but idle.
    expect(coord.isRunning()).toBe(false);

    await prefs.fireModeObserver('mode1');

    expect(collectionWatcher.stop).not.toHaveBeenCalled();
    expect(itemAddHandler.stop).not.toHaveBeenCalled();
    expect(coord.isRunning()).toBe(false);
  });

  // ─── UT-615 ────────────────────────────────────────────────────────────────

  it('UT-615 mode3→mode3 (no real change) leaves the Mode-3 wiring intact', async () => {
    const prefs = installPrefs({ mode: 'mode3', enabled: true });
    const coord = getSyncCoordinator();
    await coord.init(makeStore());
    await coord.start();
    collectionWatcher.start.mockClear();
    itemAddHandler.start.mockClear();

    // Observer fires but mode is still mode3 — already running, stays running.
    await prefs.fireModeObserver('mode3');

    expect(collectionWatcher.stop).not.toHaveBeenCalled();
    expect(itemAddHandler.stop).not.toHaveBeenCalled();
    expect(collectionWatcher.start).not.toHaveBeenCalled(); // no re-start
    expect(coord.isRunning()).toBe(true);
  });
});
