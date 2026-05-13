/**
 * Main orchestration service for the Watch Folder plugin
 * Manages polling, scanning, importing, and tracking of files
 * @module watchFolder
 */

import { getPref, delay, getFileHash } from './utils.mjs';
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
          notify: (event, type, ids, extraData) => {
            this.handleNotification(event, type, ids, extraData);
          }
        },
        ['item'],
        'watchFolder'
      );

      // Load base interval from preferences
      this._currentInterval = (getPref('pollInterval') || 5) * 1000;

      this._initialized = true;
      Zotero.debug('[WatchFolder] Service initialized successfully');

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
      const importMode = getPref('importMode') || 'stored';
      if (importMode === 'stored') {
        // Only handle post-import action for stored copies (linked files must stay in place)
        try {
          await handlePostImportAction(filePath);
        } catch (e) {
          Zotero.debug(`[WatchFolder] Post-import action failed: ${e.message}`);
        }
      }

      // Step 4: Add to tracking store
      if (this._trackingStore) {
        this._trackingStore.add({
          path: filePath,
          hash: hash,
          itemID: itemID,
          importedAt: Date.now()
        });

        // Persist tracking data
        await this._trackingStore.save();
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
  handleNotification(event, type, ids, extraData) {
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
          // Optionally handle trashed items (could re-enable import)
          Zotero.debug(`[WatchFolder] Items trashed: ${ids.join(', ')}`);
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
