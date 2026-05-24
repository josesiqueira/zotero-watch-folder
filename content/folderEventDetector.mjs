/**
 * Folder Event Detector — v2.1 Phase A2 skeleton.
 *
 * Disk-side counterpart to `collectionWatcher`. Detects:
 *   - folderCreated (new directory under sync root not yet tracked)
 *   - folderRenamed (B2's logic now in `_detectFolderRenames` — Mode 2
 *     can subscribe to it via this module's pub/sub or call it directly)
 *   - folderDeleted (tracked collection's localPath disappeared)
 *
 * Implementation note: piggybacks on the existing poll loop in
 * `watchFolder.mjs:_scan` rather than spawning a second timer. The v1
 * Phase-2 code had a separate `mirrorPollInterval` timer that doubled
 * disk-IO budget; v2.1 doesn't repeat that mistake.
 *
 * The plan calls for emitting events to mirrorExecutor like
 * collectionWatcher does for symmetry. For Mode 1 these events fire but
 * the executor stays disabled (mode gate).
 *
 * Not implemented in this v2.1 starter.
 *
 * @module folderEventDetector
 */

/**
 * Run the disk diff against the tracked collection records. Called from
 * `watchFolder._scan` once per cycle. The skeleton no-ops; v2.1 fills in
 * the diff + event emission.
 *
 * @param {Array<{path: string}>} scannedFiles
 * @param {string} watchPath
 * @param {object} coordinator
 */
export async function detectFolderEvents(scannedFiles, watchPath, coordinator) {
  // TODO(v2.1):
  // 1. List all on-disk dirs under watchPath (use watchFolder._listSubdirectories)
  // 2. Compare against trackingStore.getAllOfType('collection'):
  //    - on disk + no record → folderCreated
  //    - record + no disk    → folderDeleted (or folderRenamed — but
  //                            B2 already handles the rename case)
  // 3. Emit MirrorAction to mirrorExecutor via coordinator
  void scannedFiles; void watchPath; void coordinator;
}
