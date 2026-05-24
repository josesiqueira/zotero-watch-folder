/**
 * Folder Event Detector — v2.1 Phase A2.
 *
 * Disk-side counterpart to `collectionWatcher` (A1). Runs once per scan
 * cycle (driven by `watchFolder._scan` via `syncCoordinator.notifyScanCycle`)
 * and detects folder DELETIONS — tracked `CollectionRecord`s whose
 * `localPath` is no longer on disk.
 *
 * Why only deletions in v2.1:
 *   - folder RENAMES are already handled by `_detectFolderRenames` in
 *     watchFolder.mjs (Phase B2). That path runs earlier in the scan
 *     and updates collection records so this detector sees a consistent
 *     state.
 *   - folder CREATES are already handled by
 *     `_ensureCollectionsForExistingFolders` (Phase B5), which calls
 *     `relativePathToCollection({ createIfMissing: true })` and persists
 *     a `CollectionRecord`. By the time A2 runs, any new disk dir has
 *     been turned into a tracked collection.
 *
 * The detector emits `deleteFolder` MirrorActions to `mirrorExecutor`,
 * which applies the mode-appropriate policy: Mode 2 flips the record's
 * state to `out-of-scope-suppressed` (warn-only); Mode 3 (v2.2) will
 * trash via `.zotero-watch-trash/`.
 *
 * @module folderEventDetector
 */

import * as mirrorExecutor from './mirrorExecutor.mjs';

/**
 * Run the disk diff against the tracked collection records.
 *
 * @param {Object} ctx
 * @param {import('./trackingStore.mjs').TrackingStore} ctx.trackingStore
 * @param {Set<string>} ctx.onDiskAbsDirs - Absolute paths of all dirs under
 *   the watch root (already enumerated by the caller — see
 *   `watchFolder._listSubdirectories`).
 * @param {string} ctx.watchRoot - Absolute watch-folder root.
 */
export async function detectFolderEvents({ trackingStore, onDiskAbsDirs, watchRoot }) {
  if (!trackingStore || !watchRoot) return;
  const dirSet = onDiskAbsDirs instanceof Set ? onDiskAbsDirs : new Set(onDiskAbsDirs || []);

  const records = trackingStore.getAllOfType('collection');
  if (records.length === 0) return;

  for (const rec of records) {
    if (!rec || typeof rec.localPath !== 'string' || rec.localPath === '') continue;
    // Skip v1-era absolute-path records. The v1 `_ensureCollectionsFor
    // ExistingFolders` wrote `localPath: absDir`; v2 records use
    // sync-root-relative paths. Migrating v1 stragglers is out of A2
    // scope — they're effectively invisible to this detector.
    if (rec.localPath.startsWith('/')) continue;

    const absPath = _toAbs(watchRoot, rec.localPath);
    if (dirSet.has(absPath)) continue;

    // Fallback existence check — the caller's dir set may be capped at
    // a max depth that misses very-deep records.
    let exists = false;
    try { exists = await IOUtils.exists(absPath); }
    catch (_e) { exists = false; }
    if (exists) continue;

    Zotero.debug(`[WatchFolder] folderEventDetector: tracked collection missing on disk → deleteFolder (${rec.localPath})`);
    try {
      await mirrorExecutor.execute({
        type: 'deleteFolder',
        payload: {
          collectionKey: rec.zoteroCollectionKey,
          oldRelativePath: rec.localPath,
        },
      });
    } catch (e) {
      Zotero.logError(`[WatchFolder] folderEventDetector emit deleteFolder ${rec.localPath}: ${e?.message ?? e}`);
    }
  }
}

function _toAbs(root, rel) {
  if (!rel) return root;
  const segs = rel.split('/').filter((s) => s.trim() !== '');
  if (segs.length === 0) return root;
  return PathUtils.join(root, ...segs);
}
