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
    // TODO(v2.1 A1): collectionWatcher.start(this)
    // TODO(v2.1 A2): folderEventDetector hook into WatchFolderService scan
    // TODO(v2.1 A3): itemMembershipHandler attached as a notifier subscriber
    // TODO(v2.1 A4/A5): mirrorExecutor + conflict gate ready to receive actions
    // TODO(v2.1 C): first-run baseline (B.2/B.6/B.7)
    this._running = true;
    Zotero.debug(`[WatchFolder] SyncCoordinator: started in ${mode} (skeleton — no handlers yet)`);
  }

  async stop() {
    if (!this._running) return;
    // TODO(v2.1): unregister observers, tear down detector hooks
    this._running = false;
    Zotero.debug('[WatchFolder] SyncCoordinator: stopped');
  }

  destroy() {
    try { /* sync destroy */ this._running = false; this._initialized = false; this._trackingStore = null; }
    catch (_e) { /* swallow */ }
  }
}
