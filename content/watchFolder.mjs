/**
 * Main orchestration service for the Watch Folder plugin
 * Manages polling, scanning, importing, and tracking of files
 * @module watchFolder
 */

import { getPref, setPref, delay, getFileHash, relativePath } from './utils.mjs';
import { hashFile as _hashFileCached } from './_hashCache.mjs';
import { scanFolder, scanFolderRecursive, SKIP_DIRNAMES } from './fileScanner.mjs';
import { importFile, handlePostImportAction } from './fileImporter.mjs';
import { TrackingStore, initTrackingStore, createFileRecord, createCollectionRecord, createTombstoneRecord, STATE } from './trackingStore.mjs';
import { renameAttachment } from './fileRenamer.mjs';
import { processItemWithRules } from './smartRules.mjs';
import { checkForDuplicate, getDuplicateDetector } from './duplicateDetector.mjs';
import { report as reportWarning, WARNING_CATEGORY } from './warningSink.mjs';
import { isBulkDelete, confirmBulkDelete } from './bulkGuard.mjs';
import {
  resolveSyncRoot,
  relativePathToCollection,
  collectionKeyToRelativePath,
  SyncRootMissingError,
} from './canonicalPath.mjs';
import {
  classifyMissingFile,
  isWatchRootAvailable,
  MISSING_CLASSIFICATION,
  STATE_FOR_CLASSIFICATION,
} from './fileMissing.mjs';

/**
 * Main service class for watch folder functionality
 * Coordinates all plugin operations including scanning, importing, and tracking
 */
export class WatchFolderService {
  constructor() {
    /** @type {TrackingStore|null} */
    this._trackingStore = null;

    /** @type {number|null} Timer ID for polling */
    this._pollTimer = null;

    /** @type {boolean} Whether the service is actively watching */
    this._isWatching = false;

    /** @type {boolean} Whether a scan is currently in progress */
    this._scanInProgress = false;

    /** @type {number} Count of consecutive empty scans (for adaptive polling) */
    this._emptyScans = 0;

    /** @type {number} Current polling interval in ms */
    this._currentInterval = 5000;

    /** @type {Set<Window>} Tracked main windows */
    this._windows = new Set();

    /** @type {string|null} Zotero notifier ID */
    this._notifierID = null;

    /** @type {Set<string>} Files currently being processed (prevent duplicates) */
    this._processingFiles = new Set();

    /** @type {Array<{itemID: number, filePath: string}>} Queue for metadata retrieval */
    this._metadataQueue = [];

    /** @type {boolean} Whether service has been initialized */
    this._initialized = false;

    /** @type {Object|null} Reference to MetadataRetriever for post-import processing */
    this._metadataRetriever = null;

    /** @type {Object|null} Reference to SyncCoordinator for v2.1 scan-cycle bridge */
    this._syncCoordinator = null;
  }

  /**
   * Set the metadata retriever instance for post-import processing
   * @param {Object} retriever - MetadataRetriever instance
   */
  setMetadataRetriever(retriever) {
    this._metadataRetriever = retriever;
    Zotero.debug('[WatchFolder] MetadataRetriever connected');
  }

  /**
   * Set the v2.1 SyncCoordinator so the scan loop can notify it once per
   * cycle (Phase A2's folderEventDetector hook). The coordinator stays
   * idle in Mode 1; the hook is a no-op until Mode 2/3.
   * @param {Object} coordinator - SyncCoordinator instance
   */
  setSyncCoordinator(coordinator) {
    this._syncCoordinator = coordinator;
    Zotero.debug('[WatchFolder] SyncCoordinator connected');
  }

  /**
   * Convert an absolute disk path to the sync-root-relative form used
   * by v2 records (`FileRecord.localPath` / `canonicalLocalPath` /
   * `CollectionRecord.localPath`). Returns the input unchanged when
   * the path is already relative or sits outside the watch root.
   *
   * @private
   */
  _toRelativeForStore(absPath, watchPath) {
    if (!absPath || !watchPath) return absPath;
    // Already relative? (no leading '/' and not a Windows drive letter)
    if (!absPath.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(absPath)) return absPath;
    const rel = relativePath(absPath, watchPath);
    return rel != null ? rel : absPath;
  }

  /**
   * Resolve a tracked FileRecord/CollectionRecord `localPath` (which the
   * v2 spec says is sync-root-relative, but legacy writers in this
   * module sometimes emit as absolute) into an absolute path. Idempotent:
   * absolute input is returned as-is. Empty/null → watchPath itself.
   *
   * @private
   */
  _resolveTrackedAbs(storedPath, watchPath) {
    if (!storedPath) return watchPath || '';
    if (storedPath.startsWith('/')) return storedPath;
    if (/^[A-Za-z]:[\\/]/.test(storedPath)) return storedPath;
    const segs = storedPath.split('/').filter((s) => s.trim() !== '');
    if (!watchPath) return storedPath;
    if (segs.length === 0) return watchPath;
    return PathUtils.join(watchPath, ...segs);
  }

  /**
   * Initialize the service
   * Loads tracking data and registers Zotero notifier
   * @returns {Promise<void>}
   */
  async init() {
    if (this._initialized) {
      Zotero.debug('[WatchFolder] Service already initialized');
      return;
    }

    try {
      Zotero.debug('[WatchFolder] Initializing service...');

      // Initialize tracking store. Use the singleton so suppressionResolver
      // (which reads via getTrackingStore()) sees the same records this
      // service writes. Pre-Track-A both paths instantiated their own store
      // and the prefs UI silently reported zero suppressed items.
      this._trackingStore = await initTrackingStore();

      // Register Zotero notifier for item events
      this._notifierID = Zotero.Notifier.registerObserver(
        {
          notify: async (event, type, ids, extraData) => {
            await this.handleNotification(event, type, ids, extraData);
          }
        },
        ['item'],
        'watchFolder'
      );

      // Load base interval from preferences
      this._currentInterval = (getPref('pollInterval') || 5) * 1000;

      this._initialized = true;
      Zotero.debug('[WatchFolder] Service initialized successfully');

      // One-pass backfill: any tracked item that doesn't yet have its content
      // hash stamped into Zotero's Extra field gets stamped now. This makes
      // hash-based dedup survive a future tracking-store wipe. Awaited but
      // failures are swallowed — backfill is best-effort.
      this._backfillHashesForExistingItems().catch(e => {
        Zotero.debug(`[WatchFolder] Backfill error: ${e.message}`);
      });

    } catch (e) {
      Zotero.logError(e);
      Zotero.debug(`[WatchFolder] Initialization error: ${e.message}`);
      throw e;
    }
  }

  /**
   * Start watching the configured folder
   * Begins the polling loop with setTimeout
   * @returns {Promise<void>}
   */
  async startWatching() {
    if (this._isWatching) {
      Zotero.debug('[WatchFolder] Already watching');
      return;
    }

    if (!this._initialized) {
      await this.init();
    }

    const watchPath = getPref('sourcePath');
    if (!watchPath) {
      Zotero.debug('[WatchFolder] No watch path configured');
      return;
    }

    // Verify path exists
    try {
      const exists = await IOUtils.exists(watchPath);
      if (!exists) {
        Zotero.debug(`[WatchFolder] Watch path does not exist: ${watchPath}`);
        return;
      }
    } catch (e) {
      Zotero.logError(e);
      Zotero.debug(`[WatchFolder] Error checking watch path: ${e.message}`);
      return;
    }

    this._isWatching = true;
    this._emptyScans = 0;
    this._currentInterval = (getPref('pollInterval') || 5) * 1000;

    Zotero.debug(`[WatchFolder] Started watching: ${watchPath}`);

    // Run initial scan immediately
    await this._scan();

    // Schedule next scan
    this._scheduleNextScan();
  }

  /**
   * Stop watching the folder
   * Clears the polling timer
   */
  stopWatching() {
    if (!this._isWatching) {
      return;
    }

    this._isWatching = false;

    if (this._pollTimer !== null) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }

    Zotero.debug('[WatchFolder] Stopped watching');
  }

  /**
   * Full cleanup and destruction of the service
   * Call this on plugin shutdown
   * @returns {Promise<void>}
   */
  async destroy() {
    Zotero.debug('[WatchFolder] Destroying service...');

    // Stop watching
    this.stopWatching();

    // Unregister notifier
    if (this._notifierID) {
      Zotero.Notifier.unregisterObserver(this._notifierID);
      this._notifierID = null;
    }

    // Save and close tracking store
    if (this._trackingStore) {
      await this._trackingStore.save();
      this._trackingStore = null;
    }

    // Clear windows
    this._windows.clear();

    // Clear processing set
    this._processingFiles.clear();

    // Clear metadata queue
    this._metadataQueue = [];

    this._initialized = false;
    Zotero.debug('[WatchFolder] Service destroyed');
  }

  /**
   * Schedule the next scan using setTimeout
   * Implements adaptive polling based on activity
   * @private
   */
  _scheduleNextScan() {
    if (!this._isWatching) {
      return;
    }

    this._pollTimer = setTimeout(async () => {
      await this._scan();
      this._scheduleNextScan();
    }, this._currentInterval);
  }

  /**
   * Perform a scan of the watch folder
   * @private
   * @returns {Promise<void>}
   */
  async _scan() {
    // Prevent concurrent scans
    if (this._scanInProgress) {
      Zotero.debug('[WatchFolder] Scan already in progress, skipping');
      return;
    }

    this._scanInProgress = true;

    try {
      const watchPath = getPref('sourcePath');
      if (!watchPath) {
        return;
      }

      // Scan for files recursively
      const files = await scanFolderRecursive(watchPath);

      // ── Detect folder renames BEFORE per-file logic ──────────────────
      // If the user renamed a subfolder on disk, rename the corresponding
      // Zotero subcollection (same key, new name) and update descendant
      // tracking records so per-file move detection sees a consistent
      // state on the very same scan.
      try {
        await this._detectFolderRenames(files, watchPath);
      } catch (e) {
        Zotero.debug(`[WatchFolder] Folder-rename detection failed: ${e.message}`);
      }

      // ── B.4 / EF.1 — empty-folder pickup ─────────────────────────────
      // Files imported into a subfolder trigger subcollection creation
      // as a side effect of canonicalPath.relativePathToCollection. But
      // a user who creates an empty subfolder (or a subfolder with only
      // skipped/ignored files) expects an empty Zotero subcollection
      // too. Walk the disk dirs and create collections for any not yet
      // tracked.
      try {
        await this._ensureCollectionsForExistingFolders(watchPath);
      } catch (e) {
        Zotero.debug(`[WatchFolder] Empty-folder pickup failed: ${e.message}`);
      }

      // ── A2 — folderEventDetector hook ────────────────────────────────
      // Bridge the scan cycle into the v2.1 sync pipeline. Gated on
      // coordinator.isRunning() so Mode 1 doesn't pay the recursive
      // _listSubdirectories cost every poll interval (review fix B7).
      // Runs AFTER folder-rename and empty-folder pickup so the
      // disk-side view is settled.
      if (this._syncCoordinator
          && typeof this._syncCoordinator.isRunning === 'function'
          && this._syncCoordinator.isRunning()) {
        try {
          const onDiskAbsDirs = new Set([watchPath, ...(await this._listSubdirectories(watchPath))]);
          await this._syncCoordinator.notifyScanCycle({
            scannedFiles: files,
            onDiskAbsDirs,
            watchRoot: watchPath,
          });
        } catch (e) {
          Zotero.debug(`[WatchFolder] SyncCoordinator scan-cycle notify failed: ${e.message}`);
        }
      }

      // Detect externally-deleted files vs file-moves. A "move" is when a
      // tracked file's path disappears AND an untracked file with the same
      // content hash appears elsewhere — common case is the user
      // reorganising the watch folder by dragging a file into a subfolder.
      // Moves update the tracking record + move the Zotero item to the new
      // subfolder's collection without ever sending it to the bin.
      try {
        const diskPaths = new Set(files.map(f => f.path));
        await this._handleExternalDeletions(diskPaths, files);
      } catch (e) {
        Zotero.debug(`[WatchFolder] External-deletion scan failed: ${e.message}`);
      }

      // Filter out already tracked and currently processing files
      const newFiles = [];
      for (const fileInfo of files) {
        const filePath = fileInfo.path;

        // Skip if currently being processed
        if (this._processingFiles.has(filePath)) {
          continue;
        }

        // Skip if already tracked. Check BOTH the absolute and the
        // sync-root-relative form — v2 spec records use relative paths,
        // but legacy writers in this module sometimes wrote absolute.
        // Without the relative check, baseline-written records (which
        // are properly relative) would be missed and the dedup-skip
        // path would insert a duplicate at the absolute key (#25).
        if (this._trackingStore) {
          if (this._trackingStore.hasPath(filePath)) continue;
          const relForLookup = relativePath(filePath, watchPath);
          if (relForLookup != null && this._trackingStore.hasPath(relForLookup)) {
            continue;
          }
        }

        // Compute the sync-root-relative directory for this file. The sync
        // root collection itself maps to "" (the watch-folder root). A file
        // in a subfolder yields its relative directory, e.g. "Methods/AI".
        const rel = relativePath(filePath, watchPath); // null if not under watch
        let relativeDir = '';
        if (rel != null && rel !== '') {
          const parts = rel.split('/');
          parts.pop(); // drop filename
          relativeDir = parts.join('/');
        }
        Zotero.debug(`[WatchFolder] ${filePath} → sync-root dir "${relativeDir}"`);
        newFiles.push({ path: filePath, relativeDir });
      }

      if (newFiles.length > 0) {
        Zotero.debug(`[WatchFolder] Found ${newFiles.length} new file(s)`);

        // Reset adaptive polling when files found
        this._emptyScans = 0;
        this._currentInterval = (getPref('pollInterval') || 5) * 1000;

        // Process new files
        for (const fileObj of newFiles) {
          await this._processNewFile(fileObj.path, fileObj.relativeDir);
        }
      } else {
        // Increment empty scan counter for adaptive polling
        this._emptyScans++;

        // After 10 consecutive empty scans, increase interval (up to 2x)
        if (this._emptyScans >= 10) {
          const baseInterval = (getPref('pollInterval') || 5) * 1000;
          const maxInterval = baseInterval * 2;

          if (this._currentInterval < maxInterval) {
            this._currentInterval = Math.min(this._currentInterval * 1.2, maxInterval);
            Zotero.debug(`[WatchFolder] Increased poll interval to ${this._currentInterval}ms`);
          }
        }
      }

    } catch (e) {
      Zotero.logError(e);
      Zotero.debug(`[WatchFolder] Scan error: ${e.message}`);
    } finally {
      // Backstop save (bug #15). Some inner paths
      // (`_ensureCollectionRecordsForPath`, dedup-skip in
      // `_processNewFile`) flip `_dirty=true` and rely on a later
      // mutation's `save()` to flush. If every file in a scan
      // dedup-skips, that mutation never happens and a crash before
      // the next scan loses the added records. TrackingStore.save()
      // no-ops when not dirty, so this is cheap on the common path.
      if (this._trackingStore && this._trackingStore.isDirty) {
        try { await this._trackingStore.save(); }
        catch (e) { Zotero.debug(`[WatchFolder] backstop save failed: ${e.message}`); }
      }
      this._scanInProgress = false;
    }
  }

  /**
   * Process a newly detected file. v2: resolves the target collection via
   * canonicalPath (sync-root-relative), builds a v2 file record, and uses
   * `zoteroAttachmentKey` as the stable identity.
   *
   * @private
   * @param {string} filePath - Absolute path to the file.
   * @param {string} relativeDir - Forward-slash-joined dir under sync root
   *   ("" for files at the root), used to resolve the target collection.
   * @returns {Promise<void>}
   */
  async _processNewFile(filePath, relativeDir = '') {
    this._processingFiles.add(filePath);

    try {
      Zotero.debug(`[WatchFolder] Processing new file: ${filePath} (dir="${relativeDir}")`);

      // Step 1: Wait for the file to stop growing.
      const isStable = await this._waitForFileStable(filePath);
      if (!isStable) {
        Zotero.debug(`[WatchFolder] File not stable, skipping: ${filePath}`);
        return;
      }

      // Step 2: Resolve / create target collection under the sync root.
      // Bails early if the sync root isn't configured or doesn't resolve.
      let targetCollection;
      try {
        targetCollection = await relativePathToCollection(relativeDir, { createIfMissing: true });
      } catch (e) {
        if (e instanceof SyncRootMissingError) {
          Zotero.logError(`[WatchFolder] Sync root not found — pausing import: ${e.message}`);
          return;
        }
        throw e;
      }
      if (!targetCollection) {
        Zotero.debug(`[WatchFolder] Sync root not configured — skipping import of ${filePath}`);
        return;
      }
      const canonicalCollectionKey = targetCollection.key;

      // Ensure a `collection` tracking record exists for every Zotero
      // subcollection between sync root and the target. Without these
      // records, B2 folder-rename detection has nothing to compare
      // against on subsequent scans.
      if (this._trackingStore && relativeDir !== '') {
        const watchPath = getPref('sourcePath') || '';
        await this._ensureCollectionRecordsForPath(relativeDir, targetCollection, watchPath);
      }

      // Step 3: Hash + dedup pre-check via tracking store.
      const hash = await getFileHash(filePath);
      const fileStat = await IOUtils.stat(filePath).catch(() => null);
      const lastSyncedSize = fileStat ? fileStat.size : 0;
      const lastSyncedMtime = fileStat ? (fileStat.lastModified ?? 0) : 0;

      // Step 3a: Tombstone-aware re-link (v2.2 RST.3, Track C #4). Before
      // any live-record dedup, check whether this file's content matches
      // a recoverable tombstone — that is, an attachment we previously
      // trashed (Zotero-side) whose local file is now reappearing.
      // Un-trash the attachment if still in Zotero's trash, re-create the
      // FileRecord, and drop the tombstone. Falls through to the normal
      // import path if the Zotero side has been permanently purged.
      if (hash && this._trackingStore) {
        const tombstone = this._trackingStore.findTombstoneByHash(hash);
        if (tombstone && tombstone.zoteroAttachmentKey && tombstone.deletedFrom === 'zotero') {
          try {
            const syncRoot = await resolveSyncRoot().catch(() => null);
            const libraryID = syncRoot?.libraryID ?? Zotero.Libraries.userLibraryID;
            const attachment = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, tombstone.zoteroAttachmentKey);
            if (attachment) {
              if (attachment.deleted) {
                try {
                  attachment.deleted = false;
                  await attachment.saveTx();
                  Zotero.debug(`[WatchFolder] Tombstone re-link: un-trashed Zotero attachment ${tombstone.zoteroAttachmentKey}`);
                } catch (e) {
                  Zotero.debug(`[WatchFolder] Tombstone re-link: failed to un-trash ${tombstone.zoteroAttachmentKey}: ${e?.message ?? e}`);
                }
              }
              const watchPath = getPref('sourcePath') || '';
              const relFile = this._toRelativeForStore(filePath, watchPath);
              this._trackingStore.add(createFileRecord({
                localPath: relFile,
                canonicalLocalPath: relFile,
                lastSyncedHash: hash,
                lastSyncedSize,
                lastSyncedMtime,
                zoteroItemKey: tombstone.zoteroItemKey,
                zoteroAttachmentKey: tombstone.zoteroAttachmentKey,
                state: STATE.CLEAN,
              }));
              this._trackingStore.removeTombstoneByAttachmentKey(tombstone.zoteroAttachmentKey);
              await this._trackingStore.save();
              Zotero.debug(`[WatchFolder] Tombstone re-link: ${filePath} → ${tombstone.zoteroAttachmentKey}`);
              return;
            }
            // RST.5: attachment is gone but the original parent item may
            // still exist. If so, attach the file as a child of that
            // parent instead of importing it as a brand-new standalone
            // top-level item. tombstone.zoteroItemKey holds the parent
            // key when the original attachment had a parent; pre-v2
            // standalone attachments stored their own key there as a
            // fallback, so guard with an "is not itself an attachment"
            // check to avoid attaching to a deleted attachment shell.
            if (tombstone.zoteroItemKey && tombstone.zoteroItemKey !== tombstone.zoteroAttachmentKey) {
              try {
                const parent = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, tombstone.zoteroItemKey);
                if (parent && !parent.deleted && (!parent.isAttachment || !parent.isAttachment())) {
                  const newAttachment = await Zotero.Attachments.importFromFile({
                    file: filePath,
                    libraryID,
                    parentItemID: parent.id,
                  });
                  if (newAttachment && newAttachment.key) {
                    const watchPath = getPref('sourcePath') || '';
                    const relFile = this._toRelativeForStore(filePath, watchPath);
                    this._trackingStore.add(createFileRecord({
                      localPath: relFile,
                      canonicalLocalPath: relFile,
                      lastSyncedHash: hash,
                      lastSyncedSize,
                      lastSyncedMtime,
                      zoteroItemKey: parent.key,
                      zoteroAttachmentKey: newAttachment.key,
                      state: STATE.CLEAN,
                    }));
                    this._trackingStore.removeTombstoneByAttachmentKey(tombstone.zoteroAttachmentKey);
                    await this._trackingStore.save();
                    Zotero.debug(`[WatchFolder] RST.5: re-attached ${filePath} to parent ${parent.key} as new attachment ${newAttachment.key}`);
                    return;
                  }
                }
              } catch (rstErr) {
                Zotero.debug(`[WatchFolder] RST.5: parent re-attach failed (${rstErr?.message ?? rstErr}); falling through to normal import`);
              }
            }

            // Attachment permanently purged from Zotero AND no usable
            // parent to re-attach under; drop the now-unreachable
            // tombstone and let import-as-new run below.
            Zotero.debug(`[WatchFolder] Tombstone re-link: attachment ${tombstone.zoteroAttachmentKey} no longer in Zotero; dropping tombstone, importing as new`);
            this._trackingStore.removeTombstoneByAttachmentKey(tombstone.zoteroAttachmentKey);
            await this._trackingStore.save();
          } catch (e) {
            Zotero.debug(`[WatchFolder] Tombstone re-link error: ${e?.message ?? e} — falling through to normal import`);
          }
        }
      }

      if (hash && this._trackingStore) {
        const existingByHash = this._trackingStore.findByHash(hash);
        if (existingByHash) {
          Zotero.debug(`[WatchFolder] File already tracked by hash: ${filePath}`);
          const watchPath = getPref('sourcePath') || '';
          const relFile = this._toRelativeForStore(filePath, watchPath);
          // If the existing record already represents THIS file (same
          // resolved path), skip the duplicate insert (#25 dedup).
          const existingAbs = this._resolveTrackedAbs(existingByHash.localPath, watchPath);
          if (existingAbs === filePath) {
            Zotero.debug(`[WatchFolder] Dedup-skip: existing record already represents ${filePath}, no duplicate insert`);
            return;
          }
          // The new physical copy of an existing tracked item points at the
          // SAME attachment but with a different localPath. canonicalLocalPath
          // stays on the original location (canonical-path rule).
          this._trackingStore.add(createFileRecord({
            localPath: relFile,
            canonicalLocalPath: existingByHash.canonicalLocalPath,
            lastSyncedHash: hash,
            lastSyncedSize,
            lastSyncedMtime,
            zoteroItemKey: existingByHash.zoteroItemKey,
            zoteroAttachmentKey: existingByHash.zoteroAttachmentKey,
            canonicalCollectionKey: existingByHash.canonicalCollectionKey,
            collectionMembershipKeys: existingByHash.collectionMembershipKeys,
            state: STATE.CLEAN,
          }));
          await this._trackingStore.save();
          return;
        }
      }

      // Step 3b: Full duplicate detection (hash → Extra-field lookup) if
      // enabled. This catches files whose tracking record was lost but whose
      // hash was previously stamped into a Zotero item.
      const duplicateCheckEnabled = getPref('duplicateCheck') !== false;
      if (duplicateCheckEnabled) {
        try {
          const duplicateResult = await checkForDuplicate({}, filePath);
          if (duplicateResult.isDuplicate) {
            const action = getPref('duplicateAction') || 'skip';
            if (action === 'skip') {
              Zotero.debug(`[WatchFolder] Duplicate detected (${duplicateResult.reason}), skipping: ${filePath}`);
              const existing = duplicateResult.existingItem;
              if (this._trackingStore && existing) {
                // BUG #29 fix: `existing` is typically the PARENT item
                // (Extra-field hash stamps live on the parent), so
                // `existing.key` is the parent's key — NOT the attachment's.
                // Walk the parent's attachments and find the one whose
                // file actually has the matching hash. If `existing` is
                // already an attachment, use it directly.
                let attachment = null;
                let parentKey = null;
                if (existing.isAttachment && existing.isAttachment()) {
                  attachment = existing;
                  parentKey = existing.parentItem?.key ?? null;
                } else {
                  // Parent item — walk children to find the matching attachment.
                  // WP-A4 (perf): batch the attachment fetch (array form of
                  // Zotero.Items.getAsync), then iterate with cached hashes.
                  // Path + hash still need per-item awaits because we break
                  // on first match, but the cache (WP-A1) makes the hash
                  // step itself near-free when re-scanning the same files.
                  parentKey = existing.key;
                  const attIDs = (typeof existing.getAttachments === 'function')
                    ? (existing.getAttachments() || []) : [];
                  let atts = [];
                  if (attIDs.length > 0) {
                    try {
                      const fetched = await Zotero.Items.getAsync(attIDs);
                      atts = Array.isArray(fetched) ? fetched : [];
                    } catch (_e) { atts = []; }
                    if (atts.length === 0) {
                      // Fallback: per-id sync (legacy Zotero.Items.get).
                      atts = attIDs.map(aid => Zotero.Items.get(aid));
                    }
                  }
                  for (const att of atts) {
                    if (!att || !att.isAttachment || !att.isAttachment()) continue;
                    let attPath = null;
                    try { attPath = await att.getFilePathAsync(); }
                    catch (_e) { continue; }
                    if (!attPath) continue;
                    const attHash = await getFileHash(attPath);
                    if (attHash === hash) { attachment = att; break; }
                  }
                  // Fallback: if no child attachment hash matched (e.g. file
                  // sync pending), use the first attachment if there's
                  // exactly one. Otherwise we can't safely pick.
                  if (!attachment && attIDs.length === 1) {
                    const sole = atts[0] ?? Zotero.Items.get(attIDs[0]);
                    if (sole?.isAttachment?.()) attachment = sole;
                  }
                }
                if (attachment) {
                  const watchPath = getPref('sourcePath') || '';
                  const relFile = this._toRelativeForStore(filePath, watchPath);
                  // Don't double-track: if a record for this attachment
                  // at this exact path already exists, skip the insert.
                  const existing = this._trackingStore.getByAttachmentKey(attachment.key);
                  if (existing && this._resolveTrackedAbs(existing.localPath, watchPath) === filePath) {
                    Zotero.debug(`[WatchFolder] Dedup-skip (Extra): existing record for ${attachment.key} already at ${filePath}`);
                    return;
                  }
                  this._trackingStore.add(createFileRecord({
                    localPath: relFile,
                    canonicalLocalPath: relFile,
                    lastSyncedHash: hash,
                    lastSyncedSize,
                    lastSyncedMtime,
                    zoteroItemKey: parentKey,
                    zoteroAttachmentKey: attachment.key,
                    canonicalCollectionKey,
                    collectionMembershipKeys: [canonicalCollectionKey],
                    state: STATE.CLEAN,
                  }));
                  await this._trackingStore.save();
                  return; // skip the import — duplicate handled
                }
                // Couldn't resolve the matching attachment — better to
                // log + fall through to normal import than to store a
                // record with the WRONG attachment key.
                Zotero.debug(`[WatchFolder] Dedup-skip: couldn't resolve attachment for parent ${existing.key} (children=${(existing.getAttachments?.() || []).length}); falling through to import.`);
              } else {
                // No tracking-store or no existing item — preserve legacy
                // skip behavior (no record, no import).
                return;
              }
            }
            Zotero.debug(`[WatchFolder] Duplicate detected but importing anyway (action: ${action}): ${filePath}`);
          }
        } catch (dupError) {
          Zotero.debug(`[WatchFolder] Duplicate check error: ${dupError.message}`);
        }
      }

      // Step 4: Import via fileImporter (Collection object, not name).
      const item = await importFile(filePath, { collection: targetCollection });
      if (!item || !item.key) {
        Zotero.debug(`[WatchFolder] Import failed for: ${filePath}`);
        return;
      }
      const attachmentKey = item.key;
      const itemID = item.id;
      Zotero.debug(`[WatchFolder] Imported successfully, key=${attachmentKey} itemID=${itemID}`);

      // Step 4b: Post-import action (only meaningful for stored mode).
      let postImportResult = { action: 'leave', finalPath: filePath };
      const importMode = getPref('importMode') || 'stored';
      if (importMode === 'stored') {
        try {
          postImportResult = await handlePostImportAction(filePath);
        } catch (e) {
          Zotero.debug(`[WatchFolder] Post-import action failed: ${e.message}`);
        }
      }

      // Step 5: Build the v2 tracking record. localPath is the file's final
      // disk location (post-move/leave) in sync-root-relative form. For
      // 'delete' we keep the original localPath but flip state so
      // external-deletion detection ignores it.
      const finalPath = postImportResult.finalPath ?? filePath;
      const wasDeleted = postImportResult.action === 'delete';
      if (this._trackingStore) {
        const watchPath = getPref('sourcePath') || '';
        const relFinal = this._toRelativeForStore(finalPath, watchPath);
        this._trackingStore.add(createFileRecord({
          localPath: relFinal,
          canonicalLocalPath: relFinal,
          lastSyncedHash: hash,
          lastSyncedSize,
          lastSyncedMtime,
          zoteroItemKey: item.parentItem?.key ?? attachmentKey,
          zoteroAttachmentKey: attachmentKey,
          canonicalCollectionKey,
          collectionMembershipKeys: [canonicalCollectionKey],
          state: wasDeleted ? STATE.MISSING : STATE.CLEAN,
        }));
        await this._trackingStore.save();
      }

      // Step 5a: Stamp the hash into the Zotero item's Extra field — the
      // cross-install dedup anchor that survives a tracking-store wipe.
      //
      // BUT: at this point the import has produced a standalone Zotero
      // attachment with no parent. Attachments don't carry an `extra`
      // field — only regular bibliographic items do — so storeContentHash
      // would log "'extra' is not a valid field for type 'attachment'".
      // Defer to the metadata-retrieval callback (Step 6) where a parent
      // bibliographic item will exist after recognition succeeds. If
      // metadata retrieval is disabled, the startup backfill picks this
      // up on the next launch.
      const stampHashWhenPossible = async (resolvedItem) => {
        if (!hash) return;
        try {
          const detector = getDuplicateDetector();
          await detector.storeContentHash(resolvedItem, finalPath);
        } catch (stampErr) {
          Zotero.debug(`[WatchFolder] storeContentHash failed for ${itemID}: ${stampErr.message}`);
        }
      };
      // If the import already produced a parent-bearing or regular item
      // (e.g. linked-file import paths in future modes), stamp now.
      if (hash && (!item.isAttachment() || item.parentID)) {
        await stampHashWhenPossible(item);
      }

      // Step 5b: Smart rules.
      try {
        const filename = PathUtils.filename(filePath);
        const rulesResult = await processItemWithRules(item, { filename, filePath });
        if (rulesResult.matchedRules.length > 0) {
          Zotero.debug(`[WatchFolder] Smart rules applied: ${rulesResult.matchedRules.map(r => r.name).join(', ')}`);
        }
      } catch (rulesError) {
        Zotero.debug(`[WatchFolder] Smart rules processing error: ${rulesError.message}`);
      }

      // Step 6: Queue for metadata retrieval if enabled.
      const autoRetrieveMetadata = getPref('autoRetrieveMetadata');
      if (autoRetrieveMetadata !== false && this._metadataRetriever) {
        const watchPathForCallback = getPref('sourcePath') || '';
        const finalRelKey = this._toRelativeForStore(finalPath, watchPathForCallback);
        this._metadataRetriever.queueItem(itemID, async (success, completedItemID) => {
          if (this._trackingStore) {
            // Use the sync-root-relative key matching what _processNewFile
            // just wrote (#25 migration).
            this._trackingStore.update(finalRelKey, { metadataRetrieved: success });
          }
          Zotero.debug(`[WatchFolder] Metadata retrieval ${success ? 'completed' : 'failed'} for item ${completedItemID}`);

          // Once recognition succeeds, the attachment has gained a parent
          // bibliographic item — now we can stamp the content hash into
          // the parent's Extra field. This is the deferred Step 5a from
          // the import path.
          if (success && hash) {
            try {
              const attachmentItem = await Zotero.Items.getAsync(completedItemID);
              if (attachmentItem) {
                // Update the tracking record's zoteroItemKey to reflect
                // the newly-created parent (was the attachment key as a
                // placeholder before recognition).
                if (this._trackingStore && attachmentItem.parentItem) {
                  this._trackingStore.update(finalPath, {
                    zoteroItemKey: attachmentItem.parentItem.key,
                  });
                }
                await stampHashWhenPossible(attachmentItem);
              }
            } catch (deferredStampErr) {
              Zotero.debug(`[WatchFolder] Deferred storeContentHash failed: ${deferredStampErr.message}`);
            }
          }

          if (success && getPref('autoRename') !== false) {
            try {
              const attachmentItem = await Zotero.Items.getAsync(completedItemID);
              if (attachmentItem && attachmentItem.isAttachment()) {
                const renameResult = await renameAttachment(attachmentItem);
                if (renameResult.success && renameResult.oldName !== renameResult.newName) {
                  Zotero.debug(`[WatchFolder] Renamed: "${renameResult.oldName}" → "${renameResult.newName}"`);
                  if (this._trackingStore) {
                    this._trackingStore.update(finalPath, { renamed: true });
                  }
                }
              }
            } catch (renameError) {
              Zotero.debug(`[WatchFolder] Auto-rename failed: ${renameError.message}`);
            }
          }
          if (this._trackingStore) await this._trackingStore.save();
        });
      } else {
        this._metadataQueue.push({ itemID, filePath: finalPath });
      }

    } catch (e) {
      Zotero.logError(e);
      Zotero.debug(`[WatchFolder] Error processing file ${filePath}: ${e.message}`);
    } finally {
      this._processingFiles.delete(filePath);
    }
  }

  /**
   * Walk from sync root down to `targetCollection` along `relativeDir`,
   * creating a `collection` tracking record for any segment that doesn't
   * yet have one. Called from _processNewFile so B2 (folder-rename
   * detection) has data to work with.
   *
   * @private
   * @param {string} relativeDir - Forward-slash relative path, e.g. "Methods/AI".
   * @param {object} leafCollection - The Zotero.Collection at the leaf of relativeDir.
   */
  async _ensureCollectionRecordsForPath(relativeDir, leafCollection, watchPath) {
    const segments = relativeDir.split('/').filter(s => s !== '');
    if (segments.length === 0) return;

    // Walk from the leaf upward, collecting (collection, segmentPath) pairs.
    // We then iterate top-down to insert records with parent linkage.
    // localPath is sync-root-relative per v2 spec (migrated from absolute
    // in the #25 schema-drift fix). _detectFolderRenames + the recursive
    // sweep that consume these records have been updated to translate via
    // _resolveTrackedAbs / _toRelativeForStore where they need absolute.
    const chain = [];
    let cursor = leafCollection;
    let depth = segments.length;
    while (cursor && depth > 0) {
      const relSegments = segments.slice(0, depth);
      const relPath = relSegments.join('/');
      chain.unshift({ collection: cursor, relPath });
      depth--;
      if (!cursor.parentID) break;
      cursor = Zotero.Collections.get(cursor.parentID);
    }

    for (const { collection, relPath } of chain) {
      const existing = this._trackingStore.getCollectionRecord(collection.key);
      if (existing) continue;
      let parentKey = null;
      if (collection.parentID) {
        const parent = Zotero.Collections.get(collection.parentID);
        if (parent && parent.key !== collection.key) {
          parentKey = parent.key;
        }
      }
      this._trackingStore.add(createCollectionRecord({
        localPath: relPath,
        zoteroCollectionKey: collection.key,
        parentCollectionKey: parentKey,
        state: STATE.CLEAN,
      }));
      Zotero.debug(`[WatchFolder] Tracked new collection record: ${relPath} (key=${collection.key})`);
    }
  }

  /**
   * Recursively enumerate subdirectories under `watchPath`, skipping
   * reserved names (`imported`, `.zotero-watch-trash`) and depth-capping
   * the walk to mirror `scanFolderRecursive`. Returns absolute paths.
   *
   * @private
   * @param {string} watchPath
   * @param {number} [maxDepth=10]
   * @returns {Promise<string[]>}
   */
  async _listSubdirectories(watchPath, maxDepth = 10) {
    const out = [];
    const visit = async (dir, depth) => {
      if (depth > maxDepth) return;
      let entries;
      try { entries = await IOUtils.getChildren(dir); } catch (_e) { return; }
      for (const entry of entries) {
        let info;
        try { info = await IOUtils.stat(entry); } catch (_e) { continue; }
        if (info?.type !== 'directory') continue;
        const name = PathUtils.filename(entry);
        if (SKIP_DIRNAMES.has(name)) continue;
        out.push(entry);
        await visit(entry, depth + 1);
      }
    };
    await visit(watchPath, 0);
    return out;
  }

  /**
   * B.4 / EF.1 — make sure every disk subfolder under the sync root has
   * a matching Zotero subcollection. The file-import path creates
   * collections as a side effect when a file lands in a subfolder, but
   * folders that contain only ignored files (or no files at all) need
   * an explicit pass so the user's expected `inbox/Methods/` ↔ Zotero
   * `Methods` mapping holds.
   *
   * @private
   * @param {string} watchPath
   */
  async _ensureCollectionsForExistingFolders(watchPath) {
    if (!this._trackingStore || !watchPath) return;
    const dirs = await this._listSubdirectories(watchPath);
    if (dirs.length === 0) return;

    // Build the tracked-set in ABSOLUTE form for comparison with the
    // disk `absDir`. CollectionRecord.localPath is now relative
    // (post-#25 migration), so resolve each through _resolveTrackedAbs;
    // legacy absolute records still match because the resolver is
    // idempotent.
    const tracked = new Set(
      this._trackingStore.getAllOfType('collection')
        .map(r => this._resolveTrackedAbs(r.localPath, watchPath)),
    );

    for (const absDir of dirs) {
      if (tracked.has(absDir)) continue;
      const relDir = relativePath(absDir, watchPath);
      if (relDir == null || relDir === '') continue;
      try {
        const col = await relativePathToCollection(relDir, { createIfMissing: true });
        if (col) {
          await this._ensureCollectionRecordsForPath(relDir, col, watchPath);
          // tracked.add(absDir) — refresh local set so subsequent siblings
          // don't double-create. _ensureCollectionRecordsForPath also
          // inserts the record into the store, so getAllOfType would
          // return it on the next call, but doing it here keeps the
          // inner loop pure.
          tracked.add(absDir);
        }
      } catch (e) {
        if (e instanceof SyncRootMissingError) {
          Zotero.debug('[WatchFolder] Sync root missing — skipping empty-folder pickup');
          return;
        }
        Zotero.debug(`[WatchFolder] Empty-folder pickup failed for ${absDir}: ${e.message}`);
      }
    }
  }

  /**
   * Detect folder renames on disk (e.g. user renamed Methods/ → Procedures/)
   * and rename the corresponding Zotero collection instead of letting
   * per-file move-detection leave an empty Zotero subcollection behind.
   *
   * Approach:
   *   1. Build an on-disk dir set from the scanned files (plus intermediate
   *      dirs and a dir→file-paths map).
   *   2. For each tracked `collection` record whose `localPath` directory
   *      is no longer in that set, hunt for a candidate replacement: an
   *      on-disk dir that's NOT yet tracked as a collection AND contains
   *      ≥1 file whose hash matches a tracked file previously under the
   *      missing collection's path.
   *   3. On match: rename the Zotero collection, recursively update
   *      every descendant file + collection tracking record so their
   *      localPath reflects the new directory tree.
   *
   * Must run BEFORE `_handleExternalDeletions` in the scan cycle so the
   * per-file move detection sees a consistent collection name and skips
   * the per-file collection-swap work.
   *
   * @private
   * @param {Array<{path: string}>} scannedFiles
   * @param {string} watchPath
   */
  async _detectFolderRenames(scannedFiles, watchPath) {
    if (!this._trackingStore || !watchPath) return;
    const rawRecords = this._trackingStore.getAllOfType('collection');
    if (rawRecords.length === 0) return;

    // Normalize collection records to ABSOLUTE-path form for this
    // method's scope. v2 spec stores relative paths in localPath, but
    // we compare against on-disk absolute paths everywhere here. The
    // resolver is idempotent so both representations work; we tag each
    // record with an `_absLocalPath` field used throughout this fn.
    const collectionRecords = rawRecords.map(r => ({
      ...r,
      _absLocalPath: this._resolveTrackedAbs(r.localPath, watchPath),
    }));

    // ── 1. Build on-disk dir state (ABSOLUTE paths) ────────────────────
    // Include ALL existing subdirs (even empty ones) — otherwise a tracked
    // collection record for an empty folder would be flagged as missing
    // every scan and trigger spurious "no tracked file hashes — skip" log.
    const onDiskDirs = new Set([watchPath, ...(await this._listSubdirectories(watchPath))]);
    for (const fileInfo of scannedFiles) {
      // WP-A2 (perf): prefer the scanner-provided relativePath when present
      // (avoids recomputing from absPath + watchPath each iteration). Falls
      // back to the legacy compute for callers that didn't pass new-shape
      // entries.
      const rel = fileInfo.relativePath ?? relativePath(fileInfo.path, watchPath);
      if (rel == null || rel === '') continue;
      const parts = rel.split('/');
      parts.pop(); // drop filename
      for (let i = 1; i <= parts.length; i++) {
        onDiskDirs.add(watchPath + '/' + parts.slice(0, i).join('/'));
      }
    }

    // ── 2. Find missing collection records ──────────────────────────────
    const missing = collectionRecords.filter(r =>
      r._absLocalPath && !onDiskDirs.has(r._absLocalPath));
    if (missing.length === 0) return;

    // Sort shallowest first so a parent rename is processed before its
    // children — child records get rewritten by the parent's recursive
    // descendant update and won't need a per-child rename.
    missing.sort((a, b) => a._absLocalPath.split('/').length - b._absLocalPath.split('/').length);

    // WP-A1 (perf): module-level (path, size, mtime) LRU cache — survives
    // across scan cycles, so a re-scan with unchanged disk contents hits
    // the cache instead of re-hashing every candidate. See _hashCache.mjs.
    const hashOf = async (p) => _hashFileCached(p);

    // Index scanned files by their absolute ancestor dirs so candidate
    // matching can do O(1) tail lookups against the absolute-path schema.
    const scannedByAbsDir = new Map(); // absDir → [{absPath}, …]
    for (const fileInfo of scannedFiles) {
      // WP-A2 (perf): use scanner-provided relativePath when available.
      const rel = fileInfo.relativePath ?? relativePath(fileInfo.path, watchPath);
      if (rel == null || rel === '') continue;
      const parts = rel.split('/');
      parts.pop();
      for (let i = 1; i <= parts.length; i++) {
        const absDir = watchPath + '/' + parts.slice(0, i).join('/');
        if (!scannedByAbsDir.has(absDir)) scannedByAbsDir.set(absDir, []);
        scannedByAbsDir.get(absDir).push({ absPath: fileInfo.path });
      }
    }

    // ── 3. For each missing record, find a candidate ─────────────────────
    //
    // Matching is *tail-aware*: a candidate dir is only a valid rename
    // target if files in the old subtree map to files in the candidate's
    // subtree at the SAME relative tail (i.e. the inner structure matches).
    // This is what stops a nested-child candidate (Procedures/AI) from
    // beating a true parent candidate (Procedures) when the renamed
    // folder contains subfolders.
    for (const collRecord of missing) {
      // Skip if a prior iteration's recursive descendant sweep already
      // updated this record.
      if (!this._trackingStore.getCollectionRecord(collRecord.zoteroCollectionKey)) continue;
      const oldPath = collRecord._absLocalPath; // normalized above
      const oldPrefix = oldPath + '/';

      // Re-fetch tracked files each iteration — earlier rename sweeps may
      // have rewritten paths. Resolve each file's localPath to absolute
      // for comparison (post-#25 records are sync-root-relative).
      const trackedFilesNow = this._trackingStore.getAllOfType('file');
      const trackedShape = new Map(); // hash → tail under oldPath
      for (const f of trackedFilesNow) {
        if (!f.lastSyncedHash) continue;
        const fAbs = this._resolveTrackedAbs(f.localPath, watchPath);
        let tail;
        if (fAbs === oldPath) tail = '';
        else if (fAbs.startsWith(oldPrefix)) tail = fAbs.slice(oldPrefix.length);
        else continue;
        trackedShape.set(f.lastSyncedHash, tail);
      }
      if (trackedShape.size === 0) {
        Zotero.debug(`[WatchFolder] Folder ${oldPath} missing but no tracked file hashes under it — skip`);
        continue;
      }

      const trackedDirs = new Set(
        this._trackingStore.getAllOfType('collection')
          .map(r => this._resolveTrackedAbs(r.localPath, watchPath)),
      );
      const candidateDirs = [...onDiskDirs].filter(d =>
        d !== watchPath && !trackedDirs.has(d));

      let best = null;
      let bestScore = 0;
      for (const candDir of candidateDirs) {
        const candPrefix = candDir + '/';
        const candEntries = scannedByAbsDir.get(candDir) || [];
        let score = 0;
        for (const { absPath } of candEntries) {
          let candTail;
          if (absPath === candDir) candTail = '';
          else if (absPath.startsWith(candPrefix)) candTail = absPath.slice(candPrefix.length);
          else continue;
          const h = await hashOf(absPath);
          if (h && trackedShape.get(h) === candTail) score++;
        }
        if (score > bestScore) {
          best = candDir;
          bestScore = score;
        }
      }

      if (best && bestScore >= 1) {
        Zotero.debug(`[WatchFolder] Folder rename detected: ${oldPath} → ${best} (matched files=${bestScore})`);
        await this._renameTrackedCollection(collRecord, best);
      }
    }

    try { await this._trackingStore.save(); } catch (_) {}
  }

  /**
   * Apply a detected folder rename: rename the Zotero collection (same
   * key, new name), then sweep descendant file + collection tracking
   * records to update their localPath to the new prefix.
   *
   * @private
   */
  async _renameTrackedCollection(oldRecord, newPath) {
    // oldRecord may carry _absLocalPath (set by _detectFolderRenames'
    // normalization pass) or raw localPath that's relative or absolute.
    // newPath is the new absolute disk path of the renamed dir.
    const watchPath = getPref('sourcePath') || '';
    const oldAbs = oldRecord._absLocalPath
      ?? this._resolveTrackedAbs(oldRecord.localPath, watchPath);
    const newAbs = newPath;
    const newRel = this._toRelativeForStore(newAbs, watchPath);
    const newName = newPath.split('/').pop();
    try {
      const syncRoot = await resolveSyncRoot().catch(() => null);
      const libraryID = syncRoot?.libraryID ?? Zotero.Libraries.userLibraryID;
      const collection = await Zotero.Collections.getByLibraryAndKeyAsync(
        libraryID, oldRecord.zoteroCollectionKey);
      if (!collection) {
        Zotero.debug(`[WatchFolder] Rename: Zotero collection ${oldRecord.zoteroCollectionKey} not found`);
        return;
      }
      if (collection.name !== newName) {
        collection.name = newName;
        await collection.saveTx();
      }
    } catch (e) {
      Zotero.debug(`[WatchFolder] Rename: Zotero collection rename failed: ${e.message}`);
      return;
    }

    // Update the collection tracking record itself.
    this._trackingStore.removeCollectionRecord(oldRecord.zoteroCollectionKey);
    this._trackingStore.add(createCollectionRecord({
      ...oldRecord,
      localPath: newRel,
    }));

    // Recursively update descendants. Iterate snapshots because we mutate
    // the store while looping. Comparisons are done in ABSOLUTE form
    // (idempotent _resolveTrackedAbs handles both abs and rel records).
    const oldPrefix = oldAbs + '/';
    const newPrefix = newAbs + '/';

    const files = this._trackingStore.getAllOfType('file').slice();
    for (const f of files) {
      const fAbs = this._resolveTrackedAbs(f.localPath, watchPath);
      let newLocalAbs = null;
      if (fAbs === oldAbs) newLocalAbs = newAbs;
      else if (fAbs.startsWith(oldPrefix)) newLocalAbs = newPrefix + fAbs.slice(oldPrefix.length);
      else continue;
      const newLocalRel = this._toRelativeForStore(newLocalAbs, watchPath);
      const updated = { ...f, localPath: newLocalRel, canonicalLocalPath: newLocalRel };
      this._trackingStore.remove(f.localPath);
      this._trackingStore.add(updated);
    }

    const cols = this._trackingStore.getAllOfType('collection').slice();
    for (const c of cols) {
      if (c.zoteroCollectionKey === oldRecord.zoteroCollectionKey) continue; // already handled
      const cAbs = this._resolveTrackedAbs(c.localPath, watchPath);
      if (!cAbs.startsWith(oldPrefix)) continue;
      const tail = cAbs.slice(oldPrefix.length);
      const newLocalAbs = newPrefix + tail;
      const newLocalRel = this._toRelativeForStore(newLocalAbs, watchPath);
      this._trackingStore.removeCollectionRecord(c.zoteroCollectionKey);
      this._trackingStore.add(createCollectionRecord({
        ...c,
        localPath: newLocalRel,
      }));
    }
  }

  /**
   * Wait for a file to become stable (not being written to)
   * Checks file size twice with a delay
   * @private
   * @param {string} filePath - Path to the file
   * @param {number} [maxAttempts=3] - Maximum check attempts
   * @returns {Promise<boolean>} True if file is stable
   */
  async _waitForFileStable(filePath, maxAttempts = 3) {
    const STABILITY_DELAY = 1000; // 1 second between checks

    try {
      let previousSize = -1;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // Check if file still exists
        const exists = await IOUtils.exists(filePath);
        if (!exists) {
          return false;
        }

        // Get file info
        const info = await IOUtils.stat(filePath);
        const currentSize = info.size;

        // If size matches previous, file is stable
        if (currentSize === previousSize) {
          return true;
        }

        previousSize = currentSize;

        // Wait before next check (unless last attempt)
        if (attempt < maxAttempts - 1) {
          await delay(STABILITY_DELAY);
        }
      }

      // Assume stable after max attempts if size is non-zero
      const finalInfo = await IOUtils.stat(filePath);
      return finalInfo.size > 0;

    } catch (e) {
      Zotero.debug(`[WatchFolder] Stability check error: ${e.message}`);
      return false;
    }
  }

  /**
   * Handle Zotero notifier events
   * Used to track item deletions and updates
   * @param {string} event - Event type (add, modify, delete, etc.)
   * @param {string} type - Object type (item, collection, etc.)
   * @param {number[]} ids - Affected object IDs
   * @param {object} extraData - Additional event data
   */
  async handleNotification(event, type, ids, extraData) {
    if (type !== 'item') {
      return;
    }

    try {
      switch (event) {
        case 'delete':
          // Drop tracking entries for permanently-deleted Zotero items.
          // Notifier passes itemIDs (numeric); we translate to attachment
          // keys before looking up in the v2 tracking store. extraData
          // carries the key on `delete` events for items already removed
          // from the DB.
          if (this._trackingStore) {
            for (const id of ids) {
              const key = extraData?.[id]?.key
                ?? (Zotero.Items.get(id)?.key);
              if (!key) continue;
              const removed = this._trackingStore.removeByAttachmentKey(key);
              if (removed) {
                Zotero.debug(`[WatchFolder] Removed tracking for deleted item: ${id} (key=${key})`);
              }
            }
          }
          break;

        case 'trash': {
          // Mode 1 never propagates Zotero deletions back to disk.
          // v2.1 / v2.2 reactivate this path with explicit safety nets.
          const mode = getPref('mode') || 'mode1';
          if (mode === 'mode1') {
            Zotero.debug(`[WatchFolder] Mode 1: ignoring trash event for items ${ids.join(', ')}`);
            break;
          }
          Zotero.debug(`[WatchFolder] Items trashed: ${ids.join(', ')}`);
          await this._handleZoteroTrash(ids);
          break;
        }

        case 'modify': {
          // v2.2 restore matrix (RST.1): a trashed attachment that
          // becomes untrashed should restore the corresponding local
          // file from plugin trash if available. Zotero's notifier
          // fires 'modify' for trash + untrash both — distinguish via
          // the current `deleted` state and the tombstone presence.
          const mode = getPref('mode') || 'mode1';
          if (mode === 'mode1') break;
          if (!this._trackingStore) break;
          // Cheap pre-filter: only do restore work when we actually
          // have tombstones to consult — otherwise modify events on
          // every metadata edit would walk the entire tracking store.
          if (this._trackingStore.getAllOfType('tombstone').length === 0) break;
          await this._handleZoteroRestore(ids);
          break;
        }

        default:
          // Other events (add) don't need special handling
          break;
      }
    } catch (e) {
      Zotero.logError(e);
      Zotero.debug(`[WatchFolder] Notification handler error: ${e.message}`);
    }
  }

  /**
   * Handle items being moved to Zotero's trash. v2 schema; supports
   * Mode 2 (warn-only) and Mode 3 (safe-delete).
   *
   * Cascading-trash protection: dedup-skip can produce multiple tracking
   * records pointing at the SAME zoteroAttachmentKey (canonical + shadow
   * records, distinguished by `record.localPath === record.canonicalLocalPath`).
   * A naive "delete every tracked path for this attachment" would
   * disk-delete the canonical even when the user only touched a shadow
   * — and vice versa. This rewrite collapses per-attachment: at most
   * ONE disk path is offered for deletion (the canonical), and shadow
   * tracking records are dropped without any disk action.
   *
   * Mode 3 disk-action policy (pref `diskDeleteOnTrash`):
   *   - 'never'     : leave source files alone, drop tracking
   *   - 'os_trash'  : move canonical files to OS trash silently
   *   - 'permanent' : permanently delete canonical files silently
   *   - 'ask'       : show 3-button dialog (OS trash / Permanent / Keep)
   *
   * Mode 2: never touches disk; surfaces a warningSink entry per
   * attachment and drops all related tracking records.
   *
   * @param {number[]} ids - Trashed Zotero item IDs (numeric).
   */
  async _handleZoteroTrash(ids) {
    if (!this._trackingStore || !ids || ids.length === 0) return;
    const syncMode = getPref('mode') || 'mode1';
    if (syncMode === 'mode1') return; // defense in depth

    const watchPath = getPref('sourcePath') || '';

    // 1. Translate numeric Zotero item IDs → attachment keys (the v2
    //    identity). For attachment items, include directly. For PARENT
    //    items, walk their child attachments and include each — Zotero's
    //    trash notifier fires once for the parent and silently inherits
    //    the deleted state to children, so we have to expand here or
    //    every parent-level trash slips through (RST.2 / RST.4 bug
    //    discovered on the 2026-05-25 Mode 3 live pass).
    const attachmentKeys = new Set();
    for (const id of ids) {
      try {
        const item = Zotero.Items.get(id);
        if (!item || !item.key) continue;
        if (item.isAttachment && item.isAttachment()) {
          attachmentKeys.add(item.key);
          continue;
        }
        // Parent / regular item — expand to live child attachments.
        if (typeof item.getAttachments === 'function') {
          const childIDs = item.getAttachments(true) || []; // include trashed
          for (const cid of childIDs) {
            const child = Zotero.Items.get(cid);
            if (child && child.key && child.isAttachment && child.isAttachment()) {
              attachmentKeys.add(child.key);
            }
          }
        }
      } catch (_e) { /* item already removed from DB — fall through */ }
    }
    if (attachmentKeys.size === 0) return;

    // 2. Per attachment, gather all records and split canonical vs shadows.
    //    Decide whether the canonical file is actually on disk and
    //    eligible for deletion.
    const plans = [];
    const allFiles = this._trackingStore.getAllOfType('file');
    for (const key of attachmentKeys) {
      const records = allFiles.filter(r => r.zoteroAttachmentKey === key);
      if (records.length === 0) continue;
      const canonical = records.find(r => r.localPath === r.canonicalLocalPath) || records[0];
      const shadows = records.filter(r => r !== canonical);
      let canonicalDiskPath = null;
      if (canonical.state !== STATE.MISSING && canonical.localPath) {
        const abs = this._resolveTrackedAbs(canonical.localPath, watchPath);
        const exists = await IOUtils.exists(abs).catch(() => false);
        if (exists) canonicalDiskPath = abs;
      }
      plans.push({ attachmentKey: key, canonical, shadows, canonicalDiskPath });
    }
    if (plans.length === 0) return;

    // 3. Mode 2: warn-only. Drop tracking for canonical + shadows, surface
    //    one warningSink entry per attachment. Never touch disk.
    if (syncMode === 'mode2') {
      for (const p of plans) {
        for (const r of [p.canonical, ...p.shadows]) {
          this._trackingStore.remove(r.localPath);
        }
        try {
          reportWarning({
            category: WARNING_CATEGORY.SUPPRESSED,
            actionType: 'zotero-trash',
            attachmentKey: p.attachmentKey,
            path: p.canonical.localPath,
            reason: 'mode2-warn-only',
            message: `Zotero item trashed — local file kept (Mode 2): "${p.canonical.localPath}"${p.shadows.length > 0 ? ` (+${p.shadows.length} shadow record${p.shadows.length === 1 ? '' : 's'} dropped)` : ''}`,
          });
        } catch (_e) { /* sink unavailable */ }
      }
      try { await this._trackingStore.save(); } catch (_) {}
      return;
    }

    // 4. Mode 3: ask once for all deletable targets, then act per attachment.
    // Default action is 'plugin_trash' — the watch-root-local
    // `.zotero-watch-trash/` dir keeps files recoverable AND addressable
    // from the same mount as the original, which matters for network
    // shares / external drives where the OS trash isn't reachable.
    const deletable = plans.filter(p => p.canonicalDiskPath);

    // Bulk-delete guard: when a single Zotero-trash event covers >10
    // files (or >20% of the tracked tree), prompt before any disk
    // mutation. Counts canonical files only — shadows are dropped
    // from tracking but not disk-touched, so they don't count toward
    // the threshold. Refusal aborts the whole batch.
    if (deletable.length > 0) {
      const totalTracked = this._trackingStore.getAllOfType('file').length;
      if (isBulkDelete(deletable.length, totalTracked)) {
        const approved = await confirmBulkDelete({
          action: 'disk-trash on Zotero trash',
          path: `${deletable.length} attachment(s)`,
          affectedCount: deletable.length,
          totalTracked,
        });
        if (!approved) {
          for (const p of plans) {
            try {
              reportWarning({
                category: WARNING_CATEGORY.SUPPRESSED,
                actionType: 'zotero-trash',
                attachmentKey: p.attachmentKey,
                path: p.canonical.localPath,
                reason: 'bulk-confirm-denied',
                message: `Bulk Zotero-trash refused (${deletable.length}/${totalTracked} disk files would be touched). Tracking + disk left untouched for "${p.canonical.localPath}".`,
              });
            } catch (_e) { /* sink unavailable */ }
          }
          return;
        }
      }
    }

    let action = getPref('diskDeleteOnTrash') || 'plugin_trash';
    if (action === 'ask' && deletable.length > 0) {
      action = this._promptDiskDelete(
        deletable.map(p => ({ attachmentKey: p.attachmentKey, path: p.canonicalDiskPath }))
      );
    }
    for (const p of plans) {
      let trashPath = null;   // sync-root-relative path inside plugin trash
      let movedToRecoverable = false; // covers plugin_trash + os_trash success
      if (p.canonicalDiskPath) {
        if (action === 'plugin_trash') {
          trashPath = await this._moveToPluginTrash(p.canonicalDiskPath);
          if (trashPath) {
            movedToRecoverable = true;
          } else {
            // Fall back to OS trash so the user doesn't end up with an
            // un-actioned file plus a missing tracking record. Logged
            // inside _moveToPluginTrash; mirror the OS-trash debug here
            // so the chain is visible.
            Zotero.debug(`[WatchFolder] _handleZoteroTrash: plugin-trash failed, falling back to OS trash for ${p.canonicalDiskPath}`);
            try {
              await this._moveToOSTrash(p.canonicalDiskPath);
              movedToRecoverable = true;
            } catch (e) {
              Zotero.debug(`[WatchFolder] OS-trash fallback failed for ${p.canonicalDiskPath}: ${e?.message ?? e}`);
            }
          }
        } else if (action === 'os_trash') {
          try {
            await this._moveToOSTrash(p.canonicalDiskPath);
            movedToRecoverable = true;
          } catch (e) {
            Zotero.debug(`[WatchFolder] _handleZoteroTrash os_trash failed for ${p.canonicalDiskPath}: ${e?.message ?? e}`);
          }
        } else if (action === 'permanent') {
          try {
            await IOUtils.remove(p.canonicalDiskPath);
            Zotero.debug(`[WatchFolder] _handleZoteroTrash: permanently deleted ${p.canonicalDiskPath}`);
          } catch (e) {
            Zotero.debug(`[WatchFolder] _handleZoteroTrash: failed to delete ${p.canonicalDiskPath}: ${e?.message ?? e}`);
          }
        }
        // 'never' → leave canonical file alone
      }

      // Emit a tombstone when the canonical file landed in plugin or OS
      // trash so RST.1 / RST.3 can re-link on restore. Skipped for
      // 'permanent' (unrecoverable) and 'never' (file untouched) so the
      // tracking store doesn't grow tombstones that can never resolve.
      if (movedToRecoverable) {
        try {
          this._trackingStore.add(createTombstoneRecord({
            objectType: 'file',
            localPath: p.canonical.localPath,
            canonicalLocalPath: p.canonical.canonicalLocalPath,
            zoteroAttachmentKey: p.attachmentKey,
            zoteroItemKey: p.canonical.zoteroItemKey,
            deletedFrom: 'zotero',
            trashPath: trashPath, // null for OS-trash (unreachable for restore)
            originalHash: p.canonical.lastSyncedHash,
          }));
        } catch (e) {
          Zotero.debug(`[WatchFolder] _handleZoteroTrash: tombstone creation failed for ${p.canonical.localPath}: ${e?.message ?? e}`);
        }
      }

      // Drop tracking for canonical + every shadow. Shadow paths are
      // NEVER disk-deleted here — that's the cascading-trash guard.
      this._trackingStore.remove(p.canonical.localPath);
      for (const s of p.shadows) {
        this._trackingStore.remove(s.localPath);
      }
    }

    try { await this._trackingStore.save(); } catch (_) {}
  }

  /**
   * Handle Zotero attachments being restored from the trash (RST.1).
   * Fired from the 'modify' notifier branch — that event covers many
   * mutations, so the heavy lifting is gated on (a) a tombstone existing
   * for the attachment key (b) the attachment's `deleted` flag being
   * back to false. For each restore that matches a recoverable
   * tombstone, the canonical local file is moved out of
   * `.zotero-watch-trash/` back to its original sync-root-relative
   * path. RST.6 collision policy applies — never overwrite an
   * existing file at the target.
   *
   * @param {number[]} ids - Modified Zotero item IDs.
   */
  async _handleZoteroRestore(ids) {
    if (!this._trackingStore || !ids || ids.length === 0) return;
    const watchPath = getPref('sourcePath');
    if (!watchPath) return;

    // RST.2: when a parent item is restored, the 'modify' notifier may
    // fire for the parent ID only (Zotero batches child attachments
    // implicitly). Expand the ID list so each restored child attachment
    // gets a chance to re-link.
    //
    // RST.4 is the natural inverse: if a parent is restored but a child
    // attachment remains in trash (`deleted === true`), the per-item
    // loop below skips it via the `attachment.deleted` check — local
    // file stays trashed, exactly per spec.
    const expandedItems = [];
    const seenKeys = new Set();
    for (const id of ids) {
      let item;
      try { item = Zotero.Items.get(id); }
      catch (_e) { continue; }
      if (!item || !item.key) continue;
      const isAttachment = !item.isAttachment || item.isAttachment();
      if (isAttachment) {
        if (!seenKeys.has(item.key)) { seenKeys.add(item.key); expandedItems.push(item); }
      } else {
        // Parent item — enumerate its current attachments. Each one is
        // re-checked for `deleted === false` below before any restore
        // action runs.
        let attIDs = [];
        try { attIDs = item.getAttachments ? (item.getAttachments() || []) : []; }
        catch (_e) { /* item didn't expose getAttachments — skip */ }
        for (const aid of attIDs) {
          let att;
          try { att = Zotero.Items.get(aid); }
          catch (_e) { continue; }
          if (!att || !att.key) continue;
          if (att.isAttachment && !att.isAttachment()) continue;
          if (!seenKeys.has(att.key)) { seenKeys.add(att.key); expandedItems.push(att); }
        }
      }
    }
    if (expandedItems.length === 0) return;

    for (const attachment of expandedItems) {
      const attachmentKey = attachment.key;
      // Only act on un-deleted attachments. Trash events on the same
      // attachment fire 'modify' too; we want the restore direction.
      // For RST.4 (parent restored, attachment still trashed), this
      // skip leaves the local file in plugin trash.
      if (attachment.deleted !== false) continue;

      const tombstone = this._trackingStore.findTombstoneByAttachmentKey(attachmentKey);
      if (!tombstone) continue; // not a tombstoned attachment — nothing to restore

      // Resolve the source (plugin trash) and destination (canonical path).
      const srcRel = tombstone.trashPath;
      const dstRel = tombstone.canonicalLocalPath || tombstone.localPath;
      if (!srcRel || !dstRel) {
        // OS-trash tombstones have no addressable trashPath; we can't
        // restore the bytes ourselves. Drop the tombstone so the next
        // import of this file is handled fresh (it'll dedup via the
        // Zotero attachment's content if Zotero still has the file).
        Zotero.debug(`[WatchFolder] _handleZoteroRestore: no trashPath for ${attachmentKey}; dropping tombstone`);
        this._trackingStore.removeTombstoneByAttachmentKey(attachmentKey);
        continue;
      }

      const srcAbs = PathUtils.join(watchPath, ...srcRel.split('/'));
      let dstRel2 = dstRel;
      let dstAbs = PathUtils.join(watchPath, ...dstRel.split('/'));

      // Source must still exist; if the user emptied the plugin trash
      // manually we can't restore — drop the tombstone and let the
      // normal import path pick the Zotero file up again on next scan.
      const srcExists = await IOUtils.exists(srcAbs).catch(() => false);
      if (!srcExists) {
        Zotero.debug(`[WatchFolder] _handleZoteroRestore: trash source ${srcAbs} missing; dropping tombstone`);
        this._trackingStore.removeTombstoneByAttachmentKey(attachmentKey);
        continue;
      }

      // RST.6: destination collision → restore as copy with suffix;
      // never overwrite. Existing file at the target gets to keep its
      // path; the restored copy lands at `<name>.restored.<ts>.<ext>`.
      if (await IOUtils.exists(dstAbs).catch(() => false)) {
        const dotIdx = dstRel.lastIndexOf('.');
        const slashIdx = dstRel.lastIndexOf('/');
        const hasExt = dotIdx > slashIdx;
        const stamp = Date.now();
        const suffixed = hasExt
          ? `${dstRel.slice(0, dotIdx)}.restored.${stamp}${dstRel.slice(dotIdx)}`
          : `${dstRel}.restored.${stamp}`;
        dstRel2 = suffixed;
        dstAbs = PathUtils.join(watchPath, ...dstRel2.split('/'));
      }

      // Pre-create destination parent.
      const parent = PathUtils.parent(dstAbs);
      if (parent) {
        try {
          await IOUtils.makeDirectory(parent, { ignoreExisting: true, createAncestors: true });
        } catch (e) {
          Zotero.debug(`[WatchFolder] _handleZoteroRestore: mkdir ${parent} failed: ${e?.message ?? e}`);
          continue;
        }
      }

      try {
        await IOUtils.move(srcAbs, dstAbs);
      } catch (moveErr) {
        // Cross-FS fallback.
        try {
          await IOUtils.copy(srcAbs, dstAbs);
          await IOUtils.remove(srcAbs);
        } catch (copyErr) {
          try { await IOUtils.remove(dstAbs, { ignoreAbsent: true }); }
          catch (_e) { /* best effort */ }
          Zotero.debug(`[WatchFolder] _handleZoteroRestore: move ${srcAbs} → ${dstAbs} failed: ${copyErr?.message ?? copyErr}`);
          continue;
        }
      }

      // Re-create the FileRecord and drop the tombstone.
      this._trackingStore.add(createFileRecord({
        localPath: dstRel2,
        canonicalLocalPath: dstRel2,
        lastSyncedHash: tombstone.originalHash,
        zoteroItemKey: tombstone.zoteroItemKey,
        zoteroAttachmentKey: attachmentKey,
        state: STATE.CLEAN,
      }));
      this._trackingStore.removeTombstoneByAttachmentKey(attachmentKey);
      Zotero.debug(`[WatchFolder] _handleZoteroRestore: restored ${attachmentKey} → ${dstRel2}`);
    }

    try { await this._trackingStore.save(); } catch (_) {}
  }

  /**
   * Show a 3-button confirm dialog asking what to do with the watch-folder
   * source files. The default action is to move them to the OS trash (Mac
   * Trash / Windows Recycle Bin / XDG Trash) — recoverable from the OS.
   *
   * "Don't ask again" persists the chosen action to the `diskDeleteOnTrash`
   * preference.
   *
   * @param {{itemID: number, path: string}[]} targets
   * @returns {'os_trash' | 'permanent' | 'never'} The chosen action
   */
  _promptDiskDelete(targets) {
    const window = this._pickWindow();
    if (!window || !Services || !Services.prompt) {
      // No UI available; default to NOT touching disk (safer)
      return 'never';
    }

    const count = targets.length;
    const importMode = getPref('importMode') || 'stored';
    const linkedWarning = importMode === 'linked'
      ? '\n\nNote: you are in linked mode — the watch-folder file is the ONLY copy. '
      + 'Permanent delete cannot be undone.'
      : '';

    const message = count === 1
      ? `An item was moved to Zotero's bin.\n\nWhat should happen to the source file?\n\n${targets[0].path}${linkedWarning}`
      : `${count} items were moved to Zotero's bin.\n\nWhat should happen to the source files?${linkedWarning}`;

    const flags = Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING
                + Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_IS_STRING
                + Services.prompt.BUTTON_POS_2 * Services.prompt.BUTTON_TITLE_IS_STRING
                + Services.prompt.BUTTON_POS_0_DEFAULT;

    const checkState = { value: false };
    const result = Services.prompt.confirmEx(
      window,
      'Zotero Watch Folder',
      // v2.2 default: plugin trash (".zotero-watch-trash/" under the watch
      // root) keeps the file recoverable AND addressable from the same
      // mount as the original — a difference that matters when the watch
      // root is on a network share, an external drive, or anywhere the
      // OS trash can't reach. OS trash + permanent stay accessible via
      // about:config (diskDeleteOnTrash=os_trash / permanent).
      message,
      flags,
      'Move to plugin trash',  // Button 0 → recoverable, default
      'Keep on disk',          // Button 1 → leave alone
      'Delete permanently',    // Button 2 → irreversible
      "Don't ask again",
      checkState
    );

    const action = result === 0 ? 'plugin_trash'
                 : result === 1 ? 'never'
                 : result === 2 ? 'permanent'
                 : 'never';

    if (checkState.value) {
      setPref('diskDeleteOnTrash', action);
    }
    return action;
  }

  /**
   * Move a file into the plugin's local trash directory
   * (`.zotero-watch-trash/` under the watch root). Preserves the
   * sync-root-relative subpath so restore (RST.1, RST.3) can re-link
   * cleanly. On collision (file already in trash at same subpath),
   * appends a millisecond timestamp before the extension — per spec
   * RST.6 the plugin must never overwrite existing trash contents.
   *
   * The plugin-trash dirname is reserved in `fileScanner.SKIP_DIRNAMES`
   * so trashed files don't get re-imported on the next scan cycle.
   *
   * @param {string} absPath - Absolute source path inside the watch root.
   * @returns {Promise<string|null>} Sync-root-relative `trashPath`
   *   (e.g. `.zotero-watch-trash/Methods/paper.pdf`) on success, or
   *   `null` if the move failed and the caller should fall back.
   */
  async _moveToPluginTrash(absPath) {
    const watchRoot = getPref('sourcePath');
    if (!watchRoot) {
      Zotero.debug(`[WatchFolder] _moveToPluginTrash: no watch root set; aborting for ${absPath}`);
      return null;
    }
    // Compute the sync-root-relative source path. If the file lives
    // outside the watch root (shouldn't happen for tracked files, but
    // defensive), bail rather than dump it at the trash root with a
    // misleading name.
    const rel = relativePath(absPath, watchRoot);
    if (rel == null) {
      Zotero.debug(`[WatchFolder] _moveToPluginTrash: ${absPath} not under watch root; aborting`);
      return null;
    }
    const TRASH_DIRNAME = '.zotero-watch-trash';
    let trashRel = `${TRASH_DIRNAME}/${rel}`;
    let trashAbs = PathUtils.join(watchRoot, ...trashRel.split('/'));

    // Ensure intermediate dirs exist.
    const parent = PathUtils.parent(trashAbs);
    if (parent) {
      try {
        await IOUtils.makeDirectory(parent, { ignoreExisting: true, createAncestors: true });
      } catch (e) {
        Zotero.debug(`[WatchFolder] _moveToPluginTrash: mkdir ${parent} failed: ${e?.message ?? e}`);
        return null;
      }
    }

    // Collision handling (RST.6): never overwrite. Suffix with a
    // millisecond timestamp before the extension so the original
    // basename is preserved and listings stay sorted.
    if (await IOUtils.exists(trashAbs).catch(() => false)) {
      const dotIdx = rel.lastIndexOf('.');
      const slashIdx = rel.lastIndexOf('/');
      const hasExt = dotIdx > slashIdx;
      const stamp = Date.now();
      const suffixed = hasExt
        ? `${rel.slice(0, dotIdx)}.${stamp}${rel.slice(dotIdx)}`
        : `${rel}.${stamp}`;
      trashRel = `${TRASH_DIRNAME}/${suffixed}`;
      trashAbs = PathUtils.join(watchRoot, ...trashRel.split('/'));
    }

    try {
      await IOUtils.move(absPath, trashAbs);
      Zotero.debug(`[WatchFolder] _moveToPluginTrash: ${absPath} → ${trashAbs}`);
      return trashRel;
    } catch (moveErr) {
      // Cross-FS fallback (rare for same-watch-root moves, but defensive).
      try {
        await IOUtils.copy(absPath, trashAbs);
        await IOUtils.remove(absPath);
        Zotero.debug(`[WatchFolder] _moveToPluginTrash: copy+remove fallback for ${absPath} → ${trashAbs}`);
        return trashRel;
      } catch (copyErr) {
        try { await IOUtils.remove(trashAbs, { ignoreAbsent: true }); }
        catch (_e) { /* best effort */ }
        Zotero.debug(`[WatchFolder] _moveToPluginTrash: ${absPath} → plugin trash failed: ${copyErr?.message ?? copyErr}`);
        return null;
      }
    }
  }

  /**
   * Move a file to the OS trash via nsIFile.moveToTrash().
   * If the platform doesn't support it (older Gecko, sandboxing), fall back
   * to a permanent IOUtils.remove with a debug warning.
   *
   * @param {string} path - Absolute file path
   */
  async _moveToOSTrash(path) {
    try {
      if (typeof Components !== 'undefined' && Components.classes && Components.interfaces) {
        const file = Components.classes['@mozilla.org/file/local;1']
          .createInstance(Components.interfaces.nsIFile);
        file.initWithPath(path);
        if (typeof file.moveToTrash === 'function') {
          file.moveToTrash();
          Zotero.debug(`[WatchFolder] Trash sync: moved ${path} to OS trash`);
          return;
        }
      }
    } catch (e) {
      Zotero.debug(`[WatchFolder] OS trash failed for ${path}: ${e.message} — falling back to permanent delete`);
    }
    // Fallback
    try {
      await IOUtils.remove(path);
      Zotero.debug(`[WatchFolder] Trash sync: fallback permanent delete for ${path}`);
    } catch (e) {
      Zotero.debug(`[WatchFolder] Trash sync: fallback delete failed for ${path}: ${e.message}`);
    }
  }

  /**
   * Detect files that used to be tracked but are no longer on disk and
   * auto-move the corresponding Zotero items to the bin. Shows one batched
   * popup summarizing what happened.
   *
   * @param {Set<string>} diskPaths - Paths currently present in the watch folder
   */
  async _handleExternalDeletions(diskPaths, allFiles = null) {
    if (!this._trackingStore) return;
    if ((getPref('diskDeleteSync') || 'auto') === 'never') return;

    // Whole-mount sanity check: if the watch root itself is unreachable
    // (USB unplugged, network share gone, cloud client logged out), every
    // tracked file would naively look "missing". Pause sync globally
    // instead of mass-tagging.
    const watchPath = getPref('sourcePath') || '';
    if (watchPath) {
      const rootAvailable = await isWatchRootAvailable(watchPath);
      if (!rootAvailable) {
        Zotero.debug('[WatchFolder] Watch root unavailable — pausing external-deletion scan');
        for (const r of this._trackingStore.getAllOfType('file')) {
          if (r.state !== STATE.PAUSED) {
            this._trackingStore.update(r.localPath, { state: STATE.PAUSED });
          }
        }
        try { await this._trackingStore.save(); } catch (_) {}
        return;
      }
    }

    // v2 schema: enumerate FILE records only (collection + tombstone
    // records have their own paths and are handled elsewhere).
    const records = this._trackingStore.getAllOfType('file');
    const missing = [];

    for (const record of records) {
      // The 'missing' state is the v2 equivalent of v1's
      // expectedOnDisk===false — set when postImportAction was 'delete'.
      // External-deletion sync ignores those records.
      if (record.state === STATE.MISSING) continue;
      // Suppressed/detached records are intentionally kept out of sync
      // by the user — don't treat them as "missing on disk" candidates.
      if (record.state === STATE.OUT_OF_SCOPE_SUPPRESSED) continue;
      if (record.state === STATE.USER_DETACHED) continue;
      if (record.state === STATE.CONFLICT_BLOCKED) continue;
      if (!record.localPath || !record.zoteroAttachmentKey) continue;

      // Resolve the stored path to an absolute one for the disk checks.
      // FileRecord.localPath is sync-root-relative per v2 spec, but legacy
      // sites (and the scan-loop dedup-skip path before #25 fully lands)
      // sometimes store absolute paths. _resolveTrackedAbs accepts both —
      // absolute input is returned as-is, relative is joined under
      // watchPath. Without this, baseline's relative-path records were
      // mis-flagged as "missing" + then "moved" by _handleFileMoves,
      // which silently rewrote them to absolute paths (live test cascade).
      const absPath = this._resolveTrackedAbs(record.localPath, watchPath);
      if (diskPaths.has(absPath)) continue;
      if (record.localPath !== absPath && diskPaths.has(record.localPath)) continue;

      // Race-safe double-check.
      const exists = await IOUtils.exists(absPath).catch(() => false);
      if (exists) continue;

      // NOTE: classification (B6) runs LATER, after move-detection has
      // had a chance to claim records as moves. Pre-classifying here
      // would prevent records whose parent dir disappeared (folder
      // rename) from being recognized as moves.
      missing.push(record);
    }

    if (missing.length === 0) {
      try { await this._trackingStore.save(); } catch (_) {}
      return;
    }

    // ── Move detection ────────────────────────────────────────────────────
    // For each missing tracked record, see whether some untracked file on
    // disk has the same content hash. That signals a rename / drag-into-
    // subfolder, not a deletion. Update tracking + relocate the Zotero
    // item to the new path's collection instead of trashing. Active in
    // every mode — local-side moves are always informative.
    const moves = [];
    const trulyMissing = [];
    if (allFiles && allFiles.length > 0) {
      const trackedPaths = new Set(records.map(r => r.localPath));
      const candidates = allFiles
        .map(f => f.path)
        .filter(p => !trackedPaths.has(p) && !this._processingFiles.has(p));
      // WP-A1 (perf): module-level (path, size, mtime) LRU cache — replaces
      // the per-invocation Map. Files with unchanged size + mtime hit the
      // cache instead of re-reading the full file every scan cycle.
      const hashOf = async (p) => _hashFileCached(p);

      for (const record of missing) {
        if (!record.lastSyncedHash) { trulyMissing.push(record); continue; }
        let movedTo = null;
        for (const candidate of candidates) {
          const h = await hashOf(candidate);
          if (h && h === record.lastSyncedHash) {
            movedTo = candidate;
            break;
          }
        }
        if (movedTo) {
          moves.push({ record, newPath: movedTo });
          const idx = candidates.indexOf(movedTo);
          if (idx !== -1) candidates.splice(idx, 1);
        } else {
          trulyMissing.push(record);
        }
      }
    } else {
      trulyMissing.push(...missing);
    }

    if (moves.length > 0) {
      Zotero.debug(`[WatchFolder] Detected ${moves.length} file move(s)`);
      await this._handleFileMoves(moves);
    }

    if (trulyMissing.length === 0) return;

    // ── B6 classification on records that no candidate claimed ─────────
    // A record is truly missing — but WHY? Distinguish drive-disconnected
    // / permission-denied / cloud-placeholder from user-deleted. Non-
    // user-deleted classifications skip the trash branch entirely (no
    // destructive action when the mount is gone) and just update state.
    const stillMissing = [];
    for (const record of trulyMissing) {
      const classification = await classifyMissingFile(record.localPath, watchPath);
      if (classification === MISSING_CLASSIFICATION.STILL_EXISTS) continue;
      if (classification === MISSING_CLASSIFICATION.DRIVE_DISCONNECTED
          || classification === MISSING_CLASSIFICATION.PERMISSION_DENIED
          || classification === MISSING_CLASSIFICATION.CLOUD_PLACEHOLDER) {
        const newState = STATE_FOR_CLASSIFICATION[classification];
        if (record.state !== newState) {
          this._trackingStore.update(record.localPath, { state: newState });
        }
        continue;
      }
      stillMissing.push(record);
    }

    if (stillMissing.length === 0) {
      try { await this._trackingStore.save(); } catch (_) {}
      return;
    }

    // ── Trash branch ──────────────────────────────────────────────────────
    // Mode 1 + Mode 2: never propagate disk deletions to Zotero. Mark
    // the tracking record as `missing` so subsequent scans don't re-detect
    // and the user can resolve via the suppression UX. Mode 2 also emits
    // a warningSink entry so the user sees the event (bug #33 fix —
    // previously the Mode-3 modal alert fired in Mode 2 too, blocking
    // the bridge and creating modal popups for every deleted file).
    const mode = getPref('mode') || 'mode1';
    if (mode !== 'mode3') {
      for (const record of stillMissing) {
        this._trackingStore.update(record.localPath, { state: STATE.MISSING });
        if (mode === 'mode2') {
          try {
            reportWarning({
              category: WARNING_CATEGORY.MISSING_FILE,
              actionType: 'external-deletion',
              attachmentKey: record.zoteroAttachmentKey,
              path: record.localPath,
              reason: 'disk-deleted',
              message: `File "${record.localPath}" disappeared from disk — Mode 2 keeps Zotero item; mark as missing.`,
            });
          } catch (_e) { /* sink unavailable — debug log only */ }
        }
        Zotero.debug(`[WatchFolder] ${mode}: ${record.localPath} missing from disk — marked, not trashed`);
      }
      try { await this._trackingStore.save(); } catch (_) {}
      return;
    }

    // Mode 3 — safe-delete propagation (v2.2).
    Zotero.debug(`[WatchFolder] Detected ${stillMissing.length} externally-deleted file(s) (mode=${mode})`);

    // Bulk-delete guard: if a single scan cycle detected many missing
    // files, prompt before propagating any of them to Zotero. Common
    // trigger: the user moved a big folder OUT of the watch root in
    // the file manager — without this guard, the next scan would
    // trash every contained attachment in Zotero silently. Counts use
    // the full stillMissing list (shadow protection further down only
    // SKIPS the propagation per-record; the user should still be
    // warned about the scale).
    if (stillMissing.length > 0) {
      const totalTracked = this._trackingStore.getAllOfType('file').length;
      if (isBulkDelete(stillMissing.length, totalTracked)) {
        const approved = await confirmBulkDelete({
          action: 'trash in Zotero (external-deletion sync)',
          path: `${stillMissing.length} missing file(s)`,
          affectedCount: stillMissing.length,
          totalTracked,
        });
        if (!approved) {
          // Demote propagation to "mark missing" (the Mode 1/2 path):
          // tracking flips to MISSING so we don't re-detect, but the
          // Zotero side stays intact and the user can resolve manually.
          for (const record of stillMissing) {
            this._trackingStore.update(record.localPath, { state: STATE.MISSING });
            try {
              reportWarning({
                category: WARNING_CATEGORY.MISSING_FILE,
                actionType: 'external-deletion',
                attachmentKey: record.zoteroAttachmentKey,
                path: record.localPath,
                reason: 'bulk-confirm-denied',
                message: `Bulk external-deletion refused (${stillMissing.length}/${totalTracked} missing). Marked "${record.localPath}" missing; Zotero attachment untouched.`,
              });
            } catch (_e) { /* sink unavailable */ }
          }
          try { await this._trackingStore.save(); } catch (_) {}
          return;
        }
      }
    }

    const trashed = [];
    for (const record of stillMissing) {
      // Cascading-trash protection: a record is a SHADOW when its
      // localPath differs from its canonicalLocalPath (the dedup-skip
      // path at _processNewFile creates these when the user puts two
      // copies of the same file under the watch root). If only the
      // shadow is missing while its canonical sibling is still on disk,
      // trashing the Zotero attachment would later cascade through
      // _handleZoteroTrash and disk-delete the canonical too. Drop just
      // the shadow tracking; leave Zotero alone.
      const isShadow = record.localPath !== record.canonicalLocalPath;
      if (isShadow) {
        const canonical = this._trackingStore.getAllOfType('file').find(
          r => r.zoteroAttachmentKey === record.zoteroAttachmentKey
               && r.localPath === r.canonicalLocalPath
        );
        if (canonical) {
          const canonAbs = this._resolveTrackedAbs(canonical.localPath, watchPath);
          const canonExists = await IOUtils.exists(canonAbs).catch(() => false);
          if (canonExists) {
            Zotero.debug(`[WatchFolder] Cascading-trash guard: shadow ${record.localPath} missing but canonical ${canonical.localPath} still on disk — dropping shadow only`);
            this._trackingStore.remove(record.localPath);
            continue;
          }
        }
      }
      try {
        const syncRoot = await resolveSyncRoot().catch(() => null);
        const libraryID = syncRoot?.libraryID ?? Zotero.Libraries.userLibraryID;
        const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, record.zoteroAttachmentKey);
        if (!item) {
          this._trackingStore.removeByAttachmentKey(record.zoteroAttachmentKey);
          continue;
        }
        if (!item.deleted) {
          item.deleted = true;
          await item.saveTx();
        }
        let title = '(untitled)';
        try {
          title = (item.getDisplayTitle && item.getDisplayTitle()) || item.getField('title') || title;
        } catch (_) {}
        trashed.push({ path: record.localPath, attachmentKey: record.zoteroAttachmentKey, title });
      } catch (e) {
        Zotero.debug(`[WatchFolder] Failed to auto-bin item ${record.zoteroAttachmentKey}: ${e.message}`);
      }
      this._trackingStore.removeByAttachmentKey(record.zoteroAttachmentKey);
    }

    try { await this._trackingStore.save(); } catch (_) {}
    if (trashed.length > 0) this._showExternalDeletionPopup(trashed);
  }

  /**
   * Handle one or more files that moved within the watch folder. Updates
   * the tracking record's path AND moves the Zotero item from its current
   * watch-folder-mapped collection to the new path's mapped collection.
   * No bin, no popup, no reimport.
   *
   * @param {{record: TrackingRecord, newPath: string}[]} moves
   */
  async _handleFileMoves(moves) {
    if (!moves || moves.length === 0) return;
    const watchPath = getPref('sourcePath') || '';

    // Helper: compute the sync-root-relative directory for a file path.
    // Returns "" if the file is at the watch-folder root.
    const relativeDirFor = (filePath) => {
      const rel = relativePath(filePath, watchPath);
      if (rel == null) return null;
      const parts = rel.split('/');
      parts.pop(); // drop filename
      return parts.join('/');
    };

    for (const { record, newPath } of moves) {
      const oldRel = relativeDirFor(record.localPath);
      const newRel = relativeDirFor(newPath);
      Zotero.debug(`[WatchFolder] Move: ${record.localPath} → ${newPath}`);
      Zotero.debug(`[WatchFolder] Move: relativeDir "${oldRel}" → "${newRel}"`);

      try {
        const syncRoot = await resolveSyncRoot().catch(() => null);
        const libraryID = syncRoot?.libraryID ?? Zotero.Libraries.userLibraryID;
        const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, record.zoteroAttachmentKey);

        if (item && !item.deleted) {
          if (oldRel !== newRel && newRel != null) {
            // Resolve / create the new auto-mapped collection under the sync root.
            const newCollection = await relativePathToCollection(newRel, { createIfMissing: true });
            if (newCollection) {
              // Remove from the OLD auto-mapped collection if currently a
              // member; preserve manually-added collection memberships.
              const oldCollection = (oldRel != null)
                ? await relativePathToCollection(oldRel, { createIfMissing: false }).catch(() => null)
                : null;
              const currentColIDs = item.getCollections ? item.getCollections() : [];
              if (oldCollection && currentColIDs.includes(oldCollection.id)) {
                item.removeFromCollection(oldCollection.id);
              }
              if (!currentColIDs.includes(newCollection.id)) {
                item.addToCollection(newCollection.id);
              }
              await item.saveTx();
            }
          }
        }
      } catch (e) {
        Zotero.debug(`[WatchFolder] Move: failed to reassign collection for ${record.zoteroAttachmentKey}: ${e.message}`);
      }

      // Update tracking: remove the old record (keyed by localPath) and
      // re-add at the new path with the updated canonical bits.
      // localPath persisted in sync-root-relative form (#25 migration).
      try {
        const newCanonicalCollectionKey = (newRel != null)
          ? (await relativePathToCollection(newRel, { createIfMissing: false }).catch(() => null))?.key
            ?? record.canonicalCollectionKey
          : record.canonicalCollectionKey;
        const newRelLocal = this._toRelativeForStore(newPath, watchPath);
        this._trackingStore.remove(record.localPath);
        this._trackingStore.add(createFileRecord({
          ...record,
          localPath: newRelLocal,
          canonicalLocalPath: newRelLocal,
          canonicalCollectionKey: newCanonicalCollectionKey,
        }));
      } catch (e) {
        Zotero.debug(`[WatchFolder] Move: tracking update failed: ${e.message}`);
      }
    }

    try { await this._trackingStore.save(); } catch (_) {}
  }

  /**
   * Look up a Zotero collection by its slash-separated path, e.g.
   * "Inbox/Research/AI". Returns the leaf collection if every segment
   * resolves; null if any segment is missing.
   */
  async _findCollectionByPath(path) {
    if (!path) return null;
    const parts = path.split('/').filter(p => p.trim() !== '');
    if (parts.length === 0) return null;
    try {
      const libraryID = Zotero.Libraries.userLibraryID;
      let parentID = null;
      let current = null;
      for (const name of parts) {
        let candidates;
        if (parentID === null) {
          candidates = Zotero.Collections.getByLibrary(libraryID).filter(c => !c.parentID);
        } else {
          candidates = Zotero.Collections.getByParent(parentID, libraryID);
        }
        const found = candidates.find(c => c.name === name);
        if (!found) return null;
        current = found;
        parentID = found.id;
      }
      return current;
    } catch (e) {
      Zotero.debug(`[WatchFolder] _findCollectionByPath error: ${e.message}`);
      return null;
    }
  }

  /**
   * Informational popup listing items that were just auto-moved to Zotero's
   * bin because their watch-folder source files disappeared. Shows
   * mode-specific wording (stored vs linked).
   *
   * @param {{path: string, itemID: number, title: string}[]} trashed
   */
  _showExternalDeletionPopup(trashed) {
    const window = this._pickWindow();
    if (!window || !Services || !Services.prompt) return;

    const importMode = getPref('importMode') || 'stored';
    const count = trashed.length;
    const lines = trashed.slice(0, 20).map(t => `- ${t.path}  → "${t.title}"`).join('\n');
    const more = trashed.length > 20 ? `\n…and ${trashed.length - 20} more.` : '';

    let footer;
    if (importMode === 'linked') {
      footer = 'These were linked attachments — the items are now in the bin '
             + 'with broken file links. Restore them from the bin to keep the records, '
             + 'or empty the bin to discard.';
    } else {
      footer = 'Zotero still has its own copies in storage. Restore the items '
             + 'from Zotero\'s bin to keep them, or empty the bin to discard.';
    }

    const message = `${count} file(s) were deleted from your watch folder.\n`
                  + 'The matching Zotero items have been moved to the bin.\n\n'
                  + `${lines}${more}\n\n`
                  + footer;

    try {
      Services.prompt.alert(window, 'Zotero Watch Folder', message);
    } catch (e) {
      Zotero.debug(`[WatchFolder] External-deletion popup failed: ${e.message}`);
    }
  }

  /**
   * One-pass backfill: ensure every tracked item has its file hash stamped
   * into the Zotero item's Extra field. Items that already carry the stamp
   * are skipped. This makes dedup survive a tracking-store wipe — even
   * without local tracking, future imports of the same content will find
   * the existing Zotero item via library hash lookup.
   *
   * Safe to call repeatedly (idempotent on already-stamped items).
   */
  async _backfillHashesForExistingItems() {
    if (!this._trackingStore) return;
    const records = this._trackingStore.getAllOfType('file');
    if (records.length === 0) return;

    const syncRoot = await resolveSyncRoot().catch(() => null);
    const libraryID = syncRoot?.libraryID ?? Zotero.Libraries.userLibraryID;

    let stamped = 0;
    let skipped = 0;
    for (const record of records) {
      if (!record.zoteroAttachmentKey || !record.lastSyncedHash) {
        skipped++;
        continue;
      }
      try {
        const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, record.zoteroAttachmentKey);
        if (!item || item.deleted) {
          skipped++;
          continue;
        }
        // The Extra field only exists on regular bibliographic items. For
        // attachments we walk to the parent. If the attachment is still
        // standalone (recognition hasn't created a parent yet), there's
        // nothing to stamp — skip and let a future backfill run after
        // recognition succeeds catch it.
        let target = item;
        if (item.isAttachment && item.isAttachment()) {
          if (!item.parentID) { skipped++; continue; }
          target = await Zotero.Items.getAsync(item.parentID);
          if (!target) { skipped++; continue; }
        }
        const existingExtra = target.getField('extra') || '';
        if (existingExtra.includes(`watchfolder-hash:${record.lastSyncedHash}`)) {
          skipped++;
          continue;
        }
        const newExtra = existingExtra
          ? `${existingExtra}\nwatchfolder-hash:${record.lastSyncedHash}`
          : `watchfolder-hash:${record.lastSyncedHash}`;
        target.setField('extra', newExtra);
        await target.saveTx();
        stamped++;
      } catch (e) {
        Zotero.debug(`[WatchFolder] Backfill error for attachmentKey ${record.zoteroAttachmentKey}: ${e.message}`);
        skipped++;
      }
    }

    if (stamped > 0) {
      Zotero.debug(`[WatchFolder] Backfill: stamped ${stamped} item(s), skipped ${skipped}`);
    } else {
      Zotero.debug(`[WatchFolder] Backfill: no items needed stamping (skipped ${skipped})`);
    }
  }

  /**
   * Pick a Zotero window to use as a parent for prompt dialogs.
   * Prefers a tracked main window; falls back to Zotero.getMainWindow().
   */
  _pickWindow() {
    if (this._windows && this._windows.size > 0) {
      for (const w of this._windows) return w;
    }
    try {
      return Zotero.getMainWindow();
    } catch (_) {
      return null;
    }
  }

  /**
   * Add a window to track
   * @param {Window} window - The window object to track
   */
  addWindow(window) {
    this._windows.add(window);
    Zotero.debug(`[WatchFolder] Added window, total: ${this._windows.size}`);
  }

  /**
   * Remove a window from tracking
   * @param {Window} window - The window object to remove
   */
  removeWindow(window) {
    this._windows.delete(window);
    Zotero.debug(`[WatchFolder] Removed window, total: ${this._windows.size}`);
  }

  /**
   * Get the current watching status
   * @returns {boolean} True if actively watching
   */
  get isWatching() {
    return this._isWatching;
  }

  /**
   * Get the tracking store instance
   * @returns {TrackingStore|null}
   */
  get trackingStore() {
    return this._trackingStore;
  }

  /**
   * Get count of tracked windows
   * @returns {number}
   */
  get windowCount() {
    return this._windows.size;
  }

  /**
   * Get pending metadata queue length
   * @returns {number}
   */
  get metadataQueueLength() {
    return this._metadataQueue.length;
  }

  /**
   * Get the next item from the metadata queue
   * @returns {{itemID: number, filePath: string}|null}
   */
  dequeueMetadataItem() {
    return this._metadataQueue.shift() || null;
  }

  /**
   * Force an immediate scan (for manual trigger)
   * @returns {Promise<void>}
   */
  async forceScan() {
    if (!this._initialized) {
      Zotero.debug('[WatchFolder] Cannot force scan - not initialized');
      return;
    }

    Zotero.debug('[WatchFolder] Force scan requested');
    await this._scan();
  }

  /**
   * Get service statistics
   * @returns {object} Statistics object
   */
  getStats() {
    return {
      isWatching: this._isWatching,
      isInitialized: this._initialized,
      currentInterval: this._currentInterval,
      emptyScans: this._emptyScans,
      processingCount: this._processingFiles.size,
      metadataQueueLength: this._metadataQueue.length,
      windowCount: this._windows.size,
      trackedFiles: this._trackingStore ? this._trackingStore.count : 0
    };
  }
}

// Singleton instance
let _instance = null;

/**
 * Get the singleton WatchFolderService instance
 * @returns {WatchFolderService}
 */
export function getWatchFolderService() {
  if (!_instance) {
    _instance = new WatchFolderService();
  }
  return _instance;
}

/**
 * Reset the singleton (for testing)
 * @returns {Promise<void>}
 */
export async function resetWatchFolderService() {
  if (_instance) {
    await _instance.destroy();
    _instance = null;
  }
}
