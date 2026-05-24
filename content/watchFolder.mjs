/**
 * Main orchestration service for the Watch Folder plugin
 * Manages polling, scanning, importing, and tracking of files
 * @module watchFolder
 */

import { getPref, setPref, delay, getFileHash, relativePath } from './utils.mjs';
import { scanFolder, scanFolderRecursive } from './fileScanner.mjs';
import { importFile, handlePostImportAction } from './fileImporter.mjs';
import { TrackingStore, createFileRecord, createCollectionRecord, STATE } from './trackingStore.mjs';
import { renameAttachment } from './fileRenamer.mjs';
import { processItemWithRules } from './smartRules.mjs';
import { checkForDuplicate, getDuplicateDetector } from './duplicateDetector.mjs';
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

      // Initialize tracking store
      this._trackingStore = new TrackingStore();
      await this._trackingStore.init();

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

        // Skip if already tracked
        if (this._trackingStore && this._trackingStore.hasPath(filePath)) {
          continue;
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

      if (hash && this._trackingStore) {
        const existingByHash = this._trackingStore.findByHash(hash);
        if (existingByHash) {
          Zotero.debug(`[WatchFolder] File already tracked by hash: ${filePath}`);
          // The new physical copy of an existing tracked item points at the
          // SAME attachment but with a different localPath. canonicalLocalPath
          // stays on the original location (canonical-path rule).
          this._trackingStore.add(createFileRecord({
            localPath: filePath,
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
                this._trackingStore.add(createFileRecord({
                  localPath: filePath,
                  canonicalLocalPath: filePath,
                  lastSyncedHash: hash,
                  lastSyncedSize,
                  lastSyncedMtime,
                  zoteroItemKey: existing.parentItem?.key ?? existing.key,
                  zoteroAttachmentKey: existing.key,
                  canonicalCollectionKey,
                  collectionMembershipKeys: [canonicalCollectionKey],
                  state: STATE.CLEAN,
                }));
                await this._trackingStore.save();
              }
              return;
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
      // disk location (post-move/leave). For 'delete' we keep the original
      // localPath but flip state so external-deletion detection ignores it.
      const finalPath = postImportResult.finalPath ?? filePath;
      const wasDeleted = postImportResult.action === 'delete';
      if (this._trackingStore) {
        this._trackingStore.add(createFileRecord({
          localPath: finalPath,
          canonicalLocalPath: finalPath,
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
        this._metadataRetriever.queueItem(itemID, async (success, completedItemID) => {
          if (this._trackingStore) {
            this._trackingStore.update(finalPath, { metadataRetrieved: success });
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
    // localPath is stored as an ABSOLUTE disk path (matching the convention
    // file records use) so per-prefix comparisons in folder-rename
    // detection and the recursive sweep work without watch-path
    // conversion gymnastics.
    const chain = [];
    let cursor = leafCollection;
    let depth = segments.length;
    while (cursor && depth > 0) {
      const relSegments = segments.slice(0, depth);
      const absPath = watchPath + '/' + relSegments.join('/');
      chain.unshift({ collection: cursor, absPath });
      depth--;
      if (!cursor.parentID) break;
      cursor = Zotero.Collections.get(cursor.parentID);
    }

    for (const { collection, absPath } of chain) {
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
        localPath: absPath,
        zoteroCollectionKey: collection.key,
        parentCollectionKey: parentKey,
        state: STATE.CLEAN,
      }));
      Zotero.debug(`[WatchFolder] Tracked new collection record: ${absPath} (key=${collection.key})`);
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
    const collectionRecords = this._trackingStore.getAllOfType('collection');
    if (collectionRecords.length === 0) return;

    // ── 1. Build on-disk dir state (ABSOLUTE paths to match record schema) ──
    const onDiskDirs = new Set([watchPath]);
    for (const fileInfo of scannedFiles) {
      const rel = relativePath(fileInfo.path, watchPath);
      if (rel == null || rel === '') continue;
      const parts = rel.split('/');
      parts.pop(); // drop filename
      // Add this dir + all ancestor dirs as absolute paths.
      for (let i = 1; i <= parts.length; i++) {
        onDiskDirs.add(watchPath + '/' + parts.slice(0, i).join('/'));
      }
    }

    // ── 2. Find missing collection records ──────────────────────────────
    const missing = collectionRecords.filter(r =>
      r.localPath && !onDiskDirs.has(r.localPath));
    if (missing.length === 0) return;

    // Sort shallowest first so a parent rename is processed before its
    // children — child records get rewritten by the parent's recursive
    // descendant update and won't need a per-child rename.
    missing.sort((a, b) => a.localPath.split('/').length - b.localPath.split('/').length);

    const hashCache = new Map();
    const hashOf = async (p) => {
      if (!hashCache.has(p)) hashCache.set(p, await getFileHash(p));
      return hashCache.get(p);
    };

    // Index scanned files by their absolute ancestor dirs so candidate
    // matching can do O(1) tail lookups against the absolute-path schema.
    const scannedByAbsDir = new Map(); // absDir → [{absPath}, …]
    for (const fileInfo of scannedFiles) {
      const rel = relativePath(fileInfo.path, watchPath);
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
      const oldPath = collRecord.localPath;
      const oldPrefix = oldPath + '/';

      // Re-fetch tracked files each iteration — earlier rename sweeps may
      // have rewritten paths.
      const trackedFilesNow = this._trackingStore.getAllOfType('file');
      const trackedShape = new Map(); // hash → tail under oldPath
      for (const f of trackedFilesNow) {
        if (!f.lastSyncedHash) continue;
        let tail;
        if (f.localPath === oldPath) tail = '';
        else if (f.localPath.startsWith(oldPrefix)) tail = f.localPath.slice(oldPrefix.length);
        else continue;
        trackedShape.set(f.lastSyncedHash, tail);
      }
      if (trackedShape.size === 0) {
        Zotero.debug(`[WatchFolder] Folder ${oldPath} missing but no tracked file hashes under it — skip`);
        continue;
      }

      const trackedDirs = new Set(
        this._trackingStore.getAllOfType('collection').map(r => r.localPath),
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
    const oldPath = oldRecord.localPath;
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
      localPath: newPath,
    }));

    // Recursively update descendants. Iterate snapshots because we mutate
    // the store while looping.
    const oldPrefix = oldPath + '/';
    const newPrefix = newPath + '/';

    const files = this._trackingStore.getAllOfType('file').slice();
    for (const f of files) {
      if (f.localPath === oldPath) {
        const updated = { ...f, localPath: newPath, canonicalLocalPath: newPath };
        this._trackingStore.remove(f.localPath);
        this._trackingStore.add(updated);
      } else if (f.localPath.startsWith(oldPrefix)) {
        const tail = f.localPath.slice(oldPrefix.length);
        const newLocal = newPrefix + tail;
        const updated = { ...f, localPath: newLocal, canonicalLocalPath: newLocal };
        this._trackingStore.remove(f.localPath);
        this._trackingStore.add(updated);
      }
    }

    const cols = this._trackingStore.getAllOfType('collection').slice();
    for (const c of cols) {
      if (c.zoteroCollectionKey === oldRecord.zoteroCollectionKey) continue; // already handled
      if (c.localPath.startsWith(oldPrefix)) {
        const tail = c.localPath.slice(oldPrefix.length);
        const newLocal = newPrefix + tail;
        this._trackingStore.removeCollectionRecord(c.zoteroCollectionKey);
        this._trackingStore.add(createCollectionRecord({
          ...c,
          localPath: newLocal,
        }));
      }
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

        default:
          // Other events (add, modify) don't need special handling
          break;
      }
    } catch (e) {
      Zotero.logError(e);
      Zotero.debug(`[WatchFolder] Notification handler error: ${e.message}`);
    }
  }

  /**
   * Handle items being moved to Zotero's trash. Based on the
   * `diskDeleteOnTrash` preference, optionally remove the corresponding
   * source files from the watch folder.
   *
   * Modes:
   * - 'never'      : leave the source files alone, drop the tracking entry
   * - 'os_trash'   : move source files to the OS trash silently
   * - 'permanent'  : permanently delete source files silently
   * - 'ask'        : show a 3-button dialog (OS trash / Permanent / Keep)
   *
   * Linked mode adds an extra warning before permanent-delete since the
   * watch-folder file is the only copy.
   *
   * @param {number[]} ids - Trashed Zotero item IDs
   */
  async _handleZoteroTrash(ids) {
    if (!this._trackingStore || !ids || ids.length === 0) {
      return;
    }
    // Defense in depth: v2.0 (Mode 1) callers gate before calling, but if a
    // future caller invokes this directly we still want the v2.1/v2.2-only
    // semantics. The body below still references the v1 tracking schema
    // (record.path / record.itemID / record.expectedOnDisk) — v2.1 will
    // rewrite it. Until then this is unreachable in Mode 1.
    const syncMode = getPref('mode') || 'mode1';
    if (syncMode === 'mode1') return;

    // Collect tracked files for the trashed items
    const targets = [];
    for (const id of ids) {
      const record = this._trackingStore.findByItemID(id);
      if (!record || !record.path || record.expectedOnDisk === false) {
        if (record) this._trackingStore.removeByItemID(id);
        continue;
      }
      const exists = await IOUtils.exists(record.path).catch(() => false);
      if (!exists) {
        // File already gone — just clear the tracking entry
        this._trackingStore.removeByItemID(id);
        continue;
      }
      targets.push({ itemID: id, path: record.path });
    }

    if (targets.length === 0) return;

    const mode = getPref('diskDeleteOnTrash') || 'ask';
    let action = mode; // 'never' | 'os_trash' | 'permanent' | 'ask'

    if (mode === 'ask') {
      action = this._promptDiskDelete(targets);
      // action is now one of 'os_trash' | 'permanent' | 'never'
    }

    for (const { itemID, path } of targets) {
      if (action === 'os_trash') {
        await this._moveToOSTrash(path);
      } else if (action === 'permanent') {
        try {
          await IOUtils.remove(path);
          Zotero.debug(`[WatchFolder] Trash sync: permanently deleted ${path}`);
        } catch (e) {
          Zotero.debug(`[WatchFolder] Trash sync: failed to delete ${path}: ${e.message}`);
        }
      }
      // 'never' → leave file alone
      this._trackingStore.removeByItemID(itemID);
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
      message,
      flags,
      'Move to OS trash',     // Button 0 → recoverable
      'Keep on disk',         // Button 1 → leave alone
      'Delete permanently',   // Button 2 → irreversible
      "Don't ask again",
      checkState
    );

    const action = result === 0 ? 'os_trash'
                 : result === 1 ? 'never'
                 : result === 2 ? 'permanent'
                 : 'never';

    if (checkState.value) {
      setPref('diskDeleteOnTrash', action);
    }
    return action;
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
      if (!record.localPath || !record.zoteroAttachmentKey) continue;
      if (diskPaths.has(record.localPath)) continue;

      // Race-safe double-check.
      const exists = await IOUtils.exists(record.localPath).catch(() => false);
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
      const hashCache = new Map();
      const hashOf = async (p) => {
        if (!hashCache.has(p)) hashCache.set(p, await getFileHash(p));
        return hashCache.get(p);
      };

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
    // v2.0 / Mode 1: never propagate disk deletions to Zotero. Just mark
    // the tracking record as `missing` so subsequent scans don't re-detect
    // and the user can decide what to do.
    const mode = getPref('mode') || 'mode1';
    if (mode === 'mode1') {
      for (const record of stillMissing) {
        this._trackingStore.update(record.localPath, { state: STATE.MISSING });
        Zotero.debug(`[WatchFolder] Mode 1: ${record.localPath} missing from disk — marked, not trashed`);
      }
      try { await this._trackingStore.save(); } catch (_) {}
      return;
    }

    // v2.1 / v2.2 take over here. The body below still needs updating to
    // use the v2 schema + safe-delete predicate; v2.1's B4 work will do
    // that. For now it's unreachable in Mode 1.
    Zotero.debug(`[WatchFolder] Detected ${stillMissing.length} externally-deleted file(s) (mode=${mode})`);
    const trashed = [];
    for (const record of stillMissing) {
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
      try {
        const newCanonicalCollectionKey = (newRel != null)
          ? (await relativePathToCollection(newRel, { createIfMissing: false }).catch(() => null))?.key
            ?? record.canonicalCollectionKey
          : record.canonicalCollectionKey;
        this._trackingStore.remove(record.localPath);
        this._trackingStore.add(createFileRecord({
          ...record,
          localPath: newPath,
          canonicalLocalPath: newPath,
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
        // For attachments, stamp the parent item (where the duplicate detector looks)
        let target = item;
        if (item.isAttachment && item.isAttachment() && item.parentID) {
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
