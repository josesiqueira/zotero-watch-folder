import { getPref } from './utils.mjs';

/**
 * Watches the mirror directory for filesystem changes
 * Uses polling (no native fs.watch in Gecko)
 */
export class FolderWatcher {
  constructor(syncService) {
    this._syncService = syncService;
    this._pollTimer = null;
    this._isWatching = false;
    this._lastScan = new Map();  // path -> {mtime, size, type}
    this._pollInterval = 10000;   // 10 seconds default
  }

  /**
   * Start watching the mirror directory
   */
  start() {
    if (this._isWatching) return;

    this._pollInterval = (getPref('mirrorPollInterval') || 10) * 1000;
    this._isWatching = true;
    this._scheduleNextScan();

    Zotero.debug('[WatchFolder] FolderWatcher started');
  }

  /**
   * Stop watching
   */
  stop() {
    this._isWatching = false;
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    Zotero.debug('[WatchFolder] FolderWatcher stopped');
  }

  /**
   * Schedule the next scan
   */
  _scheduleNextScan() {
    if (!this._isWatching) return;

    this._pollTimer = setTimeout(async () => {
      await this._scan();
      this._scheduleNextScan();
    }, this._pollInterval);
  }

  /**
   * Scan the mirror directory for changes
   */
  async _scan() {
    if (this._syncService.isSyncing) return;

    const mirrorPath = this._syncService.mirrorPath;
    if (!mirrorPath || !await IOUtils.exists(mirrorPath)) return;

    try {
      const currentState = new Map();
      await this._scanDirectory(mirrorPath, currentState);

      // Detect changes
      const changes = this._detectChanges(currentState);

      // Process changes
      for (const change of changes) {
        await this._processChange(change);
      }

      // Update state
      this._lastScan = currentState;

    } catch (e) {
      Zotero.debug(`[WatchFolder] Folder scan error: ${e.message}`);
    }
  }

  /**
   * Recursively scan a directory
   */
  async _scanDirectory(dirPath, stateMap) {
    try {
      const entries = await IOUtils.getChildren(dirPath);

      for (const entryPath of entries) {
        const info = await IOUtils.stat(entryPath);

        stateMap.set(entryPath, {
          type: info.type,
          mtime: info.lastModified,
          size: info.size
        });

        // Recurse into directories
        if (info.type === 'directory') {
          await this._scanDirectory(entryPath, stateMap);
        }
      }
    } catch (e) {
      // Directory might have been deleted during scan
      Zotero.debug(`[WatchFolder] Error scanning ${dirPath}: ${e.message}`);
    }
  }

  /**
   * Detect changes between last scan and current state
   */
  _detectChanges(currentState) {
    const changes = [];

    // Check for new and modified entries
    for (const [path, info] of currentState) {
      const oldInfo = this._lastScan.get(path);

      if (!oldInfo) {
        // New entry
        changes.push({
          type: info.type === 'directory' ? 'folder_created' : 'file_created',
          path: path,
          info: info
        });
      } else if (info.type === 'regular' && info.mtime !== oldInfo.mtime) {
        // File modified
        changes.push({
          type: 'file_modified',
          path: path,
          info: info,
          oldInfo: oldInfo
        });
      }
    }

    // Check for deleted entries
    for (const [path, info] of this._lastScan) {
      if (!currentState.has(path)) {
        changes.push({
          type: info.type === 'directory' ? 'folder_deleted' : 'file_deleted',
          path: path,
          info: info
        });
      }
    }

    // Sort: process folder changes before file changes
    changes.sort((a, b) => {
      if (a.type.startsWith('folder') && !b.type.startsWith('folder')) return -1;
      if (!a.type.startsWith('folder') && b.type.startsWith('folder')) return 1;
      return 0;
    });

    return changes;
  }

  /**
   * Process a detected change
   */
  async _processChange(change) {
    // Skip if sync service is busy
    if (this._syncService.isSyncing) return;

    Zotero.debug(`[WatchFolder] Detected change: ${change.type} - ${change.path}`);

    switch (change.type) {
      case 'folder_created':
        await this._syncService.handleFolderCreated(change.path);
        break;

      case 'folder_deleted':
        await this._syncService.handleFolderDeleted(change.path);
        break;

      case 'file_created':
        await this._syncService.handleFileCreatedInMirror(change.path);
        break;

      case 'file_deleted':
        await this._syncService.handleFileDeletedFromMirror(change.path);
        break;

      case 'file_modified':
        // File content changed - typically no action needed
        break;
    }
  }

  /**
   * Force an immediate scan
   */
  async forceScan() {
    await this._scan();
  }

  /**
   * Get watching status
   */
  isWatching() {
    return this._isWatching;
  }

  /**
   * Update poll interval from preferences
   */
  updateInterval() {
    this._pollInterval = (getPref('mirrorPollInterval') || 10) * 1000;
  }
}

// Factory
let _instance = null;

export function getFolderWatcher(syncService) {
  if (!_instance && syncService) {
    _instance = new FolderWatcher(syncService);
  }
  return _instance;
}

export function resetFolderWatcher() {
  if (_instance) {
    _instance.stop();
    _instance = null;
  }
}
