/**
 * Sync Coordinator — v2.1 Mode 2 entry point.
 *
 * Replaces the deleted Phase-2 `CollectionSyncService`. Wires together the
 * Zotero-side observer (`collectionWatcher`), the disk-side detector
 * (`folderEventDetector`), the item-membership handler, and the single
 * mutation bottleneck (`mirrorExecutor`).
 *
 * Lifecycle:
 *   - Constructed lazily via `getSyncCoordinator()`.
 *   - `init()` runs AFTER `WatchFolderService.init()` (notifier
 *     registration order matters — v1's CollectionSync got bitten by
 *     observer-double-register issues, see CODEBASE_OVERVIEW §9.4).
 *   - `start()` / `stop()` mirror WatchFolderService's poll lifecycle.
 *
 * v2.0 / Mode 1: this module exists but its `start()` is a no-op when
 * `mode === 'mode1'`. It's wired into `index.mjs` so the upgrade path to
 * v2.1 doesn't require lifecycle changes — only the Mode 2 / 3 internals
 * fill in.
 *
 * Out of scope for the initial skeleton:
 *   - Actual handler implementations (A1–A5)
 *   - First-run baseline (C)
 *   - Warning surface (D)
 *
 * @module syncCoordinator
 */

import { getPref } from './utils.mjs';
import * as collectionWatcher from './collectionWatcher.mjs';
import * as itemAddHandler from './itemAddHandler.mjs';
import * as mirrorExecutor from './mirrorExecutor.mjs';
import * as folderEventDetector from './folderEventDetector.mjs';
import * as baseline from './baseline.mjs';

let _instance = null;

/**
 * @returns {SyncCoordinator} singleton instance
 */
export function getSyncCoordinator() {
  if (!_instance) _instance = new SyncCoordinator();
  return _instance;
}

export function resetSyncCoordinator() {
  if (_instance) {
    try { _instance.destroy(); } catch (_e) { /* ignore */ }
  }
  _instance = null;
}

/**
 * Coordinator for Mode 2 / Mode 3 bidirectional sync.
 *
 * Mode 1 (v2.0) does NOT use this. The coordinator is wired into the
 * plugin lifecycle so it exists, but `start()` checks `mode` and bails
 * unless we're in mode2 or mode3.
 */
export class SyncCoordinator {
  constructor() {
    this._initialized = false;
    this._running = false;
    /** @type {TrackingStore|null} */
    this._trackingStore = null;
  }

  /**
   * Wire dependencies. Caller passes the live tracking store so we don't
   * duplicate persistence state with WatchFolderService.
   * @param {TrackingStore} trackingStore
   */
  async init(trackingStore) {
    if (this._initialized) return;
    this._trackingStore = trackingStore;
    // Wire the executor's tracking-store dependency at init time so it's
    // ready before any collection event can land — Zotero may emit
    // notifier events on the very first `add()` after registration.
    mirrorExecutor.init({ trackingStore });
    this._initialized = true;
    Zotero.debug('[WatchFolder] SyncCoordinator: initialized (idle until mode2/mode3)');
  }

  /**
   * Activate the Zotero-side notifier observer + the disk-side detector.
   * No-op for Mode 1. v2.1 / v2.2 fills in the handler wiring.
   */
  async start() {
    if (!this._initialized) {
      Zotero.debug('[WatchFolder] SyncCoordinator.start: not initialized — skipping');
      return;
    }
    const mode = getPref('mode') || 'mode1';
    if (mode === 'mode1') {
      Zotero.debug('[WatchFolder] SyncCoordinator: Mode 1 — staying idle');
      return;
    }
    if (this._running) return;
    // Phase C — first-run baseline. Idempotent (skips when the sync-root
    // key matches the persisted `baselineCompletedForRoot` pref).
    // MUST run before collectionWatcher registers; otherwise the
    // mkdirs/copies issued here would race with notifier events the
    // baseline itself indirectly triggers.
    try {
      await baseline.runBaseline({ trackingStore: this._trackingStore });
    } catch (e) {
      Zotero.logError(`[WatchFolder] SyncCoordinator: baseline failed - ${e?.message ?? e}`);
    }
    // A1: register the Zotero-side notifier observer. The watcher emits
    // MirrorActions to mirrorExecutor.execute() per A4. itemMembershipHandler
    // is invoked from inside collectionWatcher for collection-item events.
    collectionWatcher.start(this);
    // A8 fix: subscribe to item-add events so late-attached PDFs (added
    // to a parent already in the sync root) get copied locally.
    itemAddHandler.start(this);
    this._running = true;
    Zotero.debug(`[WatchFolder] SyncCoordinator: started in ${mode}`);
  }

  async stop() {
    if (!this._running) return;
    try { collectionWatcher.stop(); }
    catch (e) { Zotero.logError(`[WatchFolder] SyncCoordinator.stop collectionWatcher: ${e?.message ?? e}`); }
    try { itemAddHandler.stop(); }
    catch (e) { Zotero.logError(`[WatchFolder] SyncCoordinator.stop itemAddHandler: ${e?.message ?? e}`); }
    this._running = false;
    Zotero.debug('[WatchFolder] SyncCoordinator: stopped');
  }

  /**
   * Called by `WatchFolderService._scan` once per scan cycle. Bridges the
   * disk-side scan into the Mode 2/3 sync pipeline (A2). No-op when the
   * coordinator hasn't been started (Mode 1, or pre-start).
   *
   * @param {Object} ctx
   * @param {Array<{path: string}>} ctx.scannedFiles
   * @param {Set<string>} ctx.onDiskAbsDirs - Absolute dir paths under watchRoot.
   * @param {string} ctx.watchRoot
   */
  async notifyScanCycle(ctx) {
    if (!this._running) return;
    try {
      await folderEventDetector.detectFolderEvents({
        trackingStore: this._trackingStore,
        onDiskAbsDirs: ctx?.onDiskAbsDirs,
        watchRoot: ctx?.watchRoot,
      });
    } catch (e) {
      Zotero.logError(`[WatchFolder] SyncCoordinator.notifyScanCycle: ${e?.message ?? e}`);
    }
  }

  destroy() {
    try {
      try { collectionWatcher.stop(); } catch (_e) { /* best effort */ }
      try { itemAddHandler.stop(); } catch (_e) { /* best effort */ }
      try { mirrorExecutor.reset(); } catch (_e) { /* best effort */ }
      this._running = false;
      this._initialized = false;
      this._trackingStore = null;
    } catch (_e) { /* swallow */ }
  }
}
