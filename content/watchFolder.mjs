/**
 * Main orchestration service for the Watch Folder plugin
 * Manages polling, scanning, importing, and tracking of files
 * @module watchFolder
 */

import { getPref, setPref, delay, getFileHash, getOrCreateCollectionPath } from './utils.mjs';
import { scanFolder, scanFolderRecursive } from './fileScanner.mjs';
import { importFile, handlePostImportAction } from './fileImporter.mjs';
import { TrackingStore } from './trackingStore.mjs';
import { renameAttachment } from './fileRenamer.mjs';
import { processItemWithRules } from './smartRules.mjs';
import { checkForDuplicate, getDuplicateDetector } from './duplicateDetector.mjs';

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

        // Calculate target collection based on relative path
        let targetCollection = getPref('targetCollection') || 'Inbox';
        
        // Get relative path from watchPath to filePath
        if (filePath.startsWith(watchPath)) {
          let relativePath = filePath.substring(watchPath.length);
          Zotero.debug(`[WatchFolder] File path: ${filePath}`);
          Zotero.debug(`[WatchFolder] Watch path: ${watchPath}`);
          Zotero.debug(`[WatchFolder] Initial relative path: ${relativePath}`);

          // Remove leading separator
          if (relativePath.startsWith('/') || relativePath.startsWith('\\')) {
            relativePath = relativePath.substring(1);
          }
          
          // Get directory part of relative path
          const pathParts = relativePath.split(/[/\\]/);
          pathParts.pop(); // Remove filename
          
          if (pathParts.length > 0) {
            Zotero.debug(`[WatchFolder] Folder parts found: ${JSON.stringify(pathParts)}`);
            targetCollection = targetCollection + '/' + pathParts.join('/');
          } else {
            Zotero.debug(`[WatchFolder] No subfolders found in relative path.`);
          }
        }
        
        Zotero.debug(`[WatchFolder] Final target collection path: ${targetCollection}`);
        newFiles.push({ path: filePath, collection: targetCollection });
      }

      if (newFiles.length > 0) {
        Zotero.debug(`[WatchFolder] Found ${newFiles.length} new file(s)`);

        // Reset adaptive polling when files found
        this._emptyScans = 0;
        this._currentInterval = (getPref('pollInterval') || 5) * 1000;

        // Process new files
        for (const fileObj of newFiles) {
          await this._processNewFile(fileObj.path, fileObj.collection);
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
   * Process a newly detected file
   * @private
   * @param {string} filePath - Absolute path to the file
   * @param {string} [targetCollection] - Target collection path
   * @returns {Promise<void>}
   */
  async _processNewFile(filePath, targetCollection) {
    // Mark as processing to prevent duplicate handling
    this._processingFiles.add(filePath);

    try {
      Zotero.debug(`[WatchFolder] Processing new file: ${filePath} into ${targetCollection}`);

      // Step 1: Check if file is stable (size not changing)
      const isStable = await this._waitForFileStable(filePath);
      if (!isStable) {
        Zotero.debug(`[WatchFolder] File not stable, skipping: ${filePath}`);
        return;
      }

      // Step 2: Check if already tracked by hash (internal tracking store)
      const hash = await getFileHash(filePath);
      if (hash && this._trackingStore) {
        const existingByHash = this._trackingStore.findByHash(hash);
        if (existingByHash) {
          Zotero.debug(`[WatchFolder] File already tracked by hash: ${filePath}`);
          // Track this path too to prevent future scans
          this._trackingStore.add({
            path: filePath,
            hash: hash,
            itemID: existingByHash.itemID,
            importedAt: Date.now(),
            isDuplicate: true
          });
          return;
        }
      }

      // Step 2b: Full duplicate detection (DOI, ISBN, title similarity) if enabled
      const duplicateCheckEnabled = getPref('duplicateCheck') !== false;
      if (duplicateCheckEnabled) {
        try {
          // Note: checkForDuplicate needs metadata, but we don't have it yet before import.
          // For now, we can only do file-based duplicate check (hash).
          // Full metadata-based duplicate detection happens after metadata retrieval.
          // Here we pass filePath for hash-based detection if enabled.
          const duplicateResult = await checkForDuplicate({}, filePath);
          if (duplicateResult.isDuplicate) {
            const action = getPref('duplicateAction') || 'skip';
            if (action === 'skip') {
              Zotero.debug(`[WatchFolder] Duplicate detected (${duplicateResult.reason}), skipping: ${filePath}`);
              // Track the path to prevent re-checking
              if (this._trackingStore) {
                this._trackingStore.add({
                  path: filePath,
                  hash: hash,
                  itemID: duplicateResult.existingItem?.id || 0,
                  importedAt: Date.now(),
                  isDuplicate: true
                });
              }
              return;
            }
            // For 'import' action, continue with import (will be tagged later)
            Zotero.debug(`[WatchFolder] Duplicate detected but importing anyway (action: ${action}): ${filePath}`);
          }
        } catch (dupError) {
          Zotero.debug(`[WatchFolder] Duplicate check error: ${dupError.message}`);
          // Continue with import on error
        }
      }

      // Step 3: Import file via fileImporter
      const item = await importFile(filePath, { collectionName: targetCollection });

      if (!item || !item.id) {
        Zotero.debug(`[WatchFolder] Import failed for: ${filePath}`);
        return;
      }

      const itemID = item.id;
      Zotero.debug(`[WatchFolder] Imported successfully, itemID: ${itemID}`);

      // Step 3b: Handle post-import action (delete, move, or leave)
      // Default to a "leave" result so linked-mode imports record the original path.
      let postImportResult = { action: 'leave', finalPath: filePath };
      const importMode = getPref('importMode') || 'stored';
      if (importMode === 'stored') {
        try {
          postImportResult = await handlePostImportAction(filePath);
        } catch (e) {
          Zotero.debug(`[WatchFolder] Post-import action failed: ${e.message}`);
        }
      }

      // Step 4: Add to tracking store. The recorded `path` is the final disk
      // location after any post-import move; for 'delete' it stays as the
      // original (the entry is marked expectedOnDisk=false so external-delete
      // detection skips it).
      if (this._trackingStore) {
        this._trackingStore.add({
          path: postImportResult.finalPath || filePath,
          hash: hash,
          itemID: itemID,
          importedAt: Date.now(),
          postImportAction: postImportResult.action,
          expectedOnDisk: postImportResult.finalPath !== null
        });

        // Persist tracking data
        await this._trackingStore.save();
      }

      // Step 4a: Stamp the hash into the Zotero item's Extra field so future
      // imports of the same content can find this item via library lookup,
      // even if the local tracking store gets wiped. Failures here are
      // non-fatal — the import has already succeeded and is tracked locally.
      if (hash) {
        try {
          const detector = getDuplicateDetector();
          await detector.storeContentHash(item, postImportResult.finalPath || filePath);
        } catch (stampErr) {
          Zotero.debug(`[WatchFolder] Failed to stamp content hash on item ${itemID}: ${stampErr.message}`);
        }
      }

      // Step 4b: Process with smart rules (if enabled)
      try {
        const filename = PathUtils.filename(filePath);
        const rulesResult = await processItemWithRules(item, { filename, filePath });
        if (rulesResult.matchedRules.length > 0) {
          Zotero.debug(`[WatchFolder] Smart rules applied: ${rulesResult.matchedRules.map(r => r.name).join(', ')}`);
        }
      } catch (rulesError) {
        Zotero.debug(`[WatchFolder] Smart rules processing error: ${rulesError.message}`);
      }

      // Step 5: Queue for metadata retrieval if enabled
      const autoRetrieveMetadata = getPref('autoRetrieveMetadata');
      if (autoRetrieveMetadata !== false && this._metadataRetriever) {
        // Queue item for metadata retrieval with callback for tracking and renaming
        this._metadataRetriever.queueItem(itemID, async (success, completedItemID) => {
          // Update tracking store with metadata retrieval status
          if (this._trackingStore) {
            this._trackingStore.update(filePath, { metadataRetrieved: success });
          }

          Zotero.debug(`[WatchFolder] Metadata retrieval ${success ? 'completed' : 'failed'} for item ${completedItemID}`);

          // Step 6: Auto-rename file if metadata retrieval succeeded and auto-rename is enabled
          if (success && getPref('autoRename') !== false) {
            try {
              const attachmentItem = await Zotero.Items.getAsync(completedItemID);
              if (attachmentItem && attachmentItem.isAttachment()) {
                const renameResult = await renameAttachment(attachmentItem);
                if (renameResult.success && renameResult.oldName !== renameResult.newName) {
                  Zotero.debug(`[WatchFolder] Renamed: "${renameResult.oldName}" → "${renameResult.newName}"`);
                  // Update tracking store with rename status
                  if (this._trackingStore) {
                    this._trackingStore.update(filePath, { renamed: true });
                  }
                }
              }
            } catch (renameError) {
              Zotero.debug(`[WatchFolder] Auto-rename failed: ${renameError.message}`);
            }
          }

          // Save tracking store after all updates
          if (this._trackingStore) {
            await this._trackingStore.save();
          }
        });
      } else {
        // Fallback: add to internal queue for potential later processing
        this._metadataQueue.push({
          itemID: itemID,
          filePath: filePath
        });
      }

    } catch (e) {
      Zotero.logError(e);
      Zotero.debug(`[WatchFolder] Error processing file ${filePath}: ${e.message}`);
    } finally {
      // Remove from processing set
      this._processingFiles.delete(filePath);
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
          // Remove tracking entries for deleted items
          if (this._trackingStore) {
            for (const id of ids) {
              const removed = this._trackingStore.removeByItemID(id);
              if (removed) {
                Zotero.debug(`[WatchFolder] Removed tracking for deleted item: ${id}`);
              }
            }
          }
          break;

        case 'trash':
          Zotero.debug(`[WatchFolder] Items trashed: ${ids.join(', ')}`);
          await this._handleZoteroTrash(ids);
          break;

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

    const records = this._trackingStore.getAll();
    const missing = [];

    for (const record of records) {
      if (record.expectedOnDisk === false) continue;   // postImportAction='delete' — not external
      if (!record.path || !record.itemID) continue;
      if (diskPaths.has(record.path)) continue;

      // Double-check on disk (race-safe — the scan list may be stale by ms)
      const exists = await IOUtils.exists(record.path).catch(() => false);
      if (exists) continue;

      missing.push(record);
    }

    if (missing.length === 0) return;

    // ── Move detection ────────────────────────────────────────────────────
    // For each missing tracked record, see whether some untracked file on
    // disk has the same content hash. That signals a rename / drag-into-
    // subfolder, not a deletion. Update tracking + relocate the Zotero
    // item to the new path's collection instead of trashing.
    const moves = [];
    const trulyMissing = [];
    if (allFiles && allFiles.length > 0) {
      const trackedPaths = new Set(records.map(r => r.path));
      // Candidate "new" files on disk: untracked, not currently being processed.
      const candidates = allFiles
        .map(f => f.path)
        .filter(p => !trackedPaths.has(p) && !this._processingFiles.has(p));
      // Cache hashes so we don't recompute for each missing record.
      const hashCache = new Map();
      const hashOf = async (p) => {
        if (!hashCache.has(p)) hashCache.set(p, await getFileHash(p));
        return hashCache.get(p);
      };

      for (const record of missing) {
        if (!record.hash) { trulyMissing.push(record); continue; }
        let movedTo = null;
        for (const candidate of candidates) {
          const h = await hashOf(candidate);
          if (h && h === record.hash) {
            movedTo = candidate;
            break;
          }
        }
        if (movedTo) {
          moves.push({ record, newPath: movedTo });
          // Claim this candidate so multiple missing records can't all grab it.
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
    Zotero.debug(`[WatchFolder] Detected ${trulyMissing.length} externally-deleted file(s)`);

    const trashed = [];
    for (const record of trulyMissing) {
      try {
        const item = await Zotero.Items.getAsync(record.itemID);
        if (!item) {
          // Item already gone from Zotero; just clear the tracking entry
          this._trackingStore.removeByItemID(record.itemID);
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
        trashed.push({ path: record.path, itemID: record.itemID, title });
      } catch (e) {
        Zotero.debug(`[WatchFolder] Failed to auto-bin item ${record.itemID}: ${e.message}`);
      }
      this._trackingStore.removeByItemID(record.itemID);
    }

    try {
      await this._trackingStore.save();
    } catch (_) {}

    if (trashed.length > 0) {
      this._showExternalDeletionPopup(trashed);
    }
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
    const baseTarget = getPref('targetCollection') || 'Inbox';

    // Helper: compute the collection path that would be auto-assigned for a file path
    const collectionPathFor = (filePath) => {
      let collection = baseTarget;
      if (watchPath && filePath.startsWith(watchPath)) {
        let relative = filePath.substring(watchPath.length).replace(/^[/\\]/, '');
        const parts = relative.split(/[/\\]/);
        parts.pop(); // drop filename
        if (parts.length > 0) {
          collection = baseTarget + '/' + parts.join('/');
        }
      }
      return collection;
    };

    for (const { record, newPath } of moves) {
      const oldCollectionPath = collectionPathFor(record.path);
      const newCollectionPath = collectionPathFor(newPath);
      Zotero.debug(`[WatchFolder] Move: ${record.path} → ${newPath}`);
      Zotero.debug(`[WatchFolder] Move: collection ${oldCollectionPath} → ${newCollectionPath}`);

      try {
        const item = await Zotero.Items.getAsync(record.itemID);
        if (item && !item.deleted) {
          // Only touch collections if the auto-mapping actually changed.
          if (oldCollectionPath !== newCollectionPath) {
            const newCollection = await getOrCreateCollectionPath(newCollectionPath);
            if (newCollection) {
              // Remove from the old auto-mapped collection if currently a member.
              // Other manually-added collection memberships are left untouched.
              const oldCollection = await this._findCollectionByPath(oldCollectionPath);
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
        Zotero.debug(`[WatchFolder] Move: failed to reassign collection for item ${record.itemID}: ${e.message}`);
      }

      // Update tracking: remove the old record, add a new one at the new path
      // pointing at the same item. We can't update path in place without a
      // method on TrackingStore, so we remove by item and re-add.
      try {
        if (typeof this._trackingStore.remove === 'function') {
          this._trackingStore.remove(record.path);
        } else {
          this._trackingStore.removeByItemID(record.itemID);
        }
        this._trackingStore.add({
          ...record,
          path: newPath,
          importedAt: record.importedAt || Date.now(),
        });
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
    const records = this._trackingStore.getAll();
    if (records.length === 0) return;

    let stamped = 0;
    let skipped = 0;
    for (const record of records) {
      if (!record.itemID || !record.hash) {
        skipped++;
        continue;
      }
      try {
        const item = await Zotero.Items.getAsync(record.itemID);
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
        if (existingExtra.includes(`watchfolder-hash:${record.hash}`)) {
          skipped++;
          continue;
        }
        const newExtra = existingExtra
          ? `${existingExtra}\nwatchfolder-hash:${record.hash}`
          : `watchfolder-hash:${record.hash}`;
        target.setField('extra', newExtra);
        await target.saveTx();
        stamped++;
      } catch (e) {
        Zotero.debug(`[WatchFolder] Backfill error for itemID ${record.itemID}: ${e.message}`);
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
