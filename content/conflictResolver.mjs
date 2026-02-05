import { getPref } from './utils.mjs';

// Tag for items with sync conflicts
const SYNC_CONFLICT_TAG = '_sync-conflict';

/**
 * Resolution strategies
 */
export const ResolutionStrategy = {
  ZOTERO_WINS: 'zotero',      // Zotero state takes precedence
  DISK_WINS: 'disk',          // Disk state takes precedence
  LAST_WRITE_WINS: 'last',    // Most recent change wins
  KEEP_BOTH: 'both',          // Keep both versions
  MANUAL: 'manual'            // Log for user review
};

/**
 * Conflict types
 */
export const ConflictType = {
  COLLECTION_RENAMED_BOTH_SIDES: 'collection_renamed',
  ITEM_MOVED_BOTH_SIDES: 'item_moved',
  FILE_MODIFIED_BOTH_SIDES: 'file_modified',
  DELETED_BUT_MODIFIED: 'deleted_modified'
};

/**
 * Handles synchronization conflicts between Zotero and disk
 */
export class ConflictResolver {
  constructor() {
    this._strategy = ResolutionStrategy.LAST_WRITE_WINS;
    this._conflictLog = [];  // Recent conflicts for review
    this._maxLogSize = 100;
  }

  /**
   * Initialize with preference
   */
  init() {
    const strategyPref = getPref('conflictResolution') || 'last';
    this._strategy = strategyPref;
  }

  /**
   * Detect if there's a conflict
   * @param {Object} zoteroState - State from Zotero (timestamp, value)
   * @param {Object} diskState - State from disk (timestamp, value)
   * @param {Object} lastSyncState - State at last sync (timestamp, value)
   * @returns {Object|null} Conflict info or null if no conflict
   */
  detectConflict(zoteroState, diskState, lastSyncState) {
    // No conflict if either side unchanged since last sync
    if (zoteroState.timestamp <= lastSyncState.timestamp) {
      return null; // Zotero unchanged, disk can overwrite
    }
    if (diskState.timestamp <= lastSyncState.timestamp) {
      return null; // Disk unchanged, Zotero can overwrite
    }

    // Both changed since last sync - conflict!
    return {
      zoteroState,
      diskState,
      lastSyncState,
      detectedAt: Date.now()
    };
  }

  /**
   * Resolve a simple file-exists conflict (when moving/copying a file)
   * @param {Object} params - Conflict parameters
   * @param {string} params.type - Conflict type (e.g., 'file_exists')
   * @param {string} params.sourcePath - Source file path
   * @param {string} params.targetPath - Target file path (where conflict exists)
   * @param {Zotero.Item} params.item - The Zotero item
   * @param {Zotero.Collection} params.collection - Target collection
   * @returns {Object} Resolution with action ('skip', 'rename', 'overwrite')
   */
  async resolve(params) {
    // Handle simple single-argument call (file existence check)
    if (params && typeof params === 'object' && params.type === 'file_exists') {
      return this._resolveFileExists(params);
    }

    // Handle three-argument call for full conflict resolution
    const conflictType = params;
    const conflict = arguments[1];
    const context = arguments[2];
    return this._resolveConflict(conflictType, conflict, context);
  }

  /**
   * Resolve a file-exists conflict
   * @param {Object} params - Conflict parameters
   * @returns {Object} Resolution result
   * @private
   */
  async _resolveFileExists(params) {
    Zotero.debug(`[WatchFolder] File exists conflict: ${params.targetPath}`);

    // For file-exists, we typically rename or skip
    switch (this._strategy) {
      case ResolutionStrategy.DISK_WINS:
        // Keep existing file, skip the move
        return { action: 'skip' };

      case ResolutionStrategy.ZOTERO_WINS:
        // Overwrite existing file
        return { action: 'overwrite' };

      case ResolutionStrategy.KEEP_BOTH:
        // Rename the incoming file
        return { action: 'rename' };

      case ResolutionStrategy.LAST_WRITE_WINS:
      default:
        // Default: rename to avoid data loss
        return { action: 'rename' };
    }
  }

  /**
   * Resolve a full sync conflict using configured strategy
   * @param {string} conflictType - Type of conflict
   * @param {Object} conflict - Conflict details
   * @param {Object} context - Additional context (item, collection, paths)
   * @returns {Object} Resolution result
   * @private
   */
  async _resolveConflict(conflictType, conflict, context) {
    this._logConflict(conflictType, conflict, context);

    const strategy = this._strategy;
    Zotero.debug(`[WatchFolder] Resolving conflict (${conflictType}) with strategy: ${strategy}`);

    switch (strategy) {
      case ResolutionStrategy.ZOTERO_WINS:
        return this._resolveZoteroWins(conflictType, conflict, context);

      case ResolutionStrategy.DISK_WINS:
        return this._resolveDiskWins(conflictType, conflict, context);

      case ResolutionStrategy.LAST_WRITE_WINS:
        return this._resolveLastWriteWins(conflictType, conflict, context);

      case ResolutionStrategy.KEEP_BOTH:
        return this._resolveKeepBoth(conflictType, conflict, context);

      case ResolutionStrategy.MANUAL:
      default:
        return this._resolveManual(conflictType, conflict, context);
    }
  }

  /**
   * Zotero state wins - apply Zotero state to disk
   */
  async _resolveZoteroWins(conflictType, conflict, context) {
    return {
      action: 'apply_zotero_to_disk',
      winner: 'zotero',
      value: conflict.zoteroState.value
    };
  }

  /**
   * Disk state wins - apply disk state to Zotero
   */
  async _resolveDiskWins(conflictType, conflict, context) {
    return {
      action: 'apply_disk_to_zotero',
      winner: 'disk',
      value: conflict.diskState.value
    };
  }

  /**
   * Most recent change wins
   */
  async _resolveLastWriteWins(conflictType, conflict, context) {
    if (conflict.zoteroState.timestamp > conflict.diskState.timestamp) {
      return this._resolveZoteroWins(conflictType, conflict, context);
    } else {
      return this._resolveDiskWins(conflictType, conflict, context);
    }
  }

  /**
   * Keep both versions - rename one to avoid collision
   */
  async _resolveKeepBoth(conflictType, conflict, context) {
    // Tag the item for user review
    if (context.item) {
      await this._addConflictTag(context.item);
    }

    return {
      action: 'keep_both',
      winner: 'both',
      needsRename: true,
      suffix: `_conflict_${Date.now()}`
    };
  }

  /**
   * Manual resolution - just log and tag for user
   */
  async _resolveManual(conflictType, conflict, context) {
    if (context.item) {
      await this._addConflictTag(context.item);
    }

    return {
      action: 'manual',
      winner: 'none',
      requiresUserAction: true
    };
  }

  /**
   * Add conflict tag to item
   */
  async _addConflictTag(item) {
    try {
      let targetItem = item;
      if (item.isAttachment() && item.parentID) {
        targetItem = await Zotero.Items.getAsync(item.parentID);
      }

      if (targetItem) {
        const tags = targetItem.getTags();
        if (!tags.some(t => t.tag === SYNC_CONFLICT_TAG)) {
          targetItem.addTag(SYNC_CONFLICT_TAG);
          await targetItem.saveTx();
          Zotero.debug(`[WatchFolder] Added ${SYNC_CONFLICT_TAG} to item ${targetItem.id}`);
        }
      }
    } catch (e) {
      Zotero.debug(`[WatchFolder] Failed to add conflict tag: ${e.message}`);
    }
  }

  /**
   * Remove conflict tag from item
   */
  async removeConflictTag(item) {
    try {
      let targetItem = item;
      if (item.isAttachment() && item.parentID) {
        targetItem = await Zotero.Items.getAsync(item.parentID);
      }

      if (targetItem) {
        targetItem.removeTag(SYNC_CONFLICT_TAG);
        await targetItem.saveTx();
      }
    } catch (e) {
      Zotero.debug(`[WatchFolder] Failed to remove conflict tag: ${e.message}`);
    }
  }

  /**
   * Log a conflict for later review
   */
  _logConflict(conflictType, conflict, context) {
    const entry = {
      type: conflictType,
      timestamp: Date.now(),
      zoteroTimestamp: conflict.zoteroState?.timestamp,
      diskTimestamp: conflict.diskState?.timestamp,
      path: context.path || null,
      collectionID: context.collection?.id || null,
      itemID: context.item?.id || null
    };

    this._conflictLog.unshift(entry);

    // Trim log to max size
    if (this._conflictLog.length > this._maxLogSize) {
      this._conflictLog = this._conflictLog.slice(0, this._maxLogSize);
    }

    Zotero.debug(`[WatchFolder] Conflict logged: ${conflictType}`);
  }

  /**
   * Get recent conflicts for review
   */
  getConflictLog() {
    return [...this._conflictLog];
  }

  /**
   * Clear the conflict log
   */
  clearLog() {
    this._conflictLog = [];
  }

  /**
   * Update resolution strategy
   */
  setStrategy(strategy) {
    if (Object.values(ResolutionStrategy).includes(strategy)) {
      this._strategy = strategy;
    }
  }

  /**
   * Get current strategy
   */
  getStrategy() {
    return this._strategy;
  }
}

// Export the tag for other modules
export { SYNC_CONFLICT_TAG };
