/**
 * syncState.mjs - Sync State Persistence Module
 *
 * Manages persistence of collection-folder sync state.
 * Stores mappings between Zotero collections and disk folders.
 *
 * Part of Phase 2: Collection ↔ Folder Synchronization
 */

/**
 * Manages persistence of collection-folder sync state
 * Stores mappings between Zotero collections and disk folders
 */
export class SyncState {
  constructor() {
    /** @type {number} State file format version */
    this.version = 1;

    /** @type {number|null} Timestamp of last full sync */
    this.lastFullSync = null;

    /** @type {Map<number, CollectionState>} collectionID -> state data */
    this.collections = new Map();

    /** @type {Map<number, ItemState>} itemID -> state data */
    this.items = new Map();

    /** @type {string|null} Path to the state JSON file */
    this.dataFile = null;

    /** @type {boolean} Whether state has unsaved changes */
    this._dirty = false;
  }

  /**
   * Initialize the sync state manager
   * Sets up data file path and loads existing state
   */
  async init() {
    // Set data file path in Zotero data directory
    this.dataFile = PathUtils.join(
      Zotero.DataDirectory.dir,
      'zotero-watch-folder-sync-state.json'
    );
    await this.load();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Collection State Methods
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Store or update collection sync state
   * @param {number} collectionID - Zotero collection ID
   * @param {Object} data - Collection state data
   * @param {string} data.name - Collection name
   * @param {number|null} data.parentID - Parent collection ID
   * @param {string} data.folderPath - Mapped folder path on disk
   */
  setCollection(collectionID, data) {
    this.collections.set(collectionID, {
      name: data.name,
      parentID: data.parentID || null,
      folderPath: data.folderPath,
      lastSynced: Date.now()
    });
    this._dirty = true;
  }

  /**
   * Get collection sync state
   * @param {number} collectionID - Zotero collection ID
   * @returns {CollectionState|null} Collection state or null if not found
   */
  getCollection(collectionID) {
    return this.collections.get(collectionID) || null;
  }

  /**
   * Remove collection from sync state
   * @param {number} collectionID - Zotero collection ID
   */
  removeCollection(collectionID) {
    this.collections.delete(collectionID);
    this._dirty = true;
  }

  /**
   * Find collection by its folder path
   * @param {string} folderPath - Folder path to search for
   * @returns {Object|null} Collection state with id, or null if not found
   */
  getCollectionByPath(folderPath) {
    for (const [id, data] of this.collections) {
      if (data.folderPath === folderPath) {
        return { id, ...data };
      }
    }
    return null;
  }

  /**
   * Get all collections under a specific parent
   * @param {number|null} parentID - Parent collection ID (null for root)
   * @returns {Array<Object>} Array of collection states with ids
   */
  getCollectionsByParent(parentID) {
    const result = [];
    for (const [id, data] of this.collections) {
      if (data.parentID === parentID) {
        result.push({ id, ...data });
      }
    }
    return result;
  }

  /**
   * Check if a collection is tracked
   * @param {number} collectionID - Zotero collection ID
   * @returns {boolean} True if collection is in sync state
   */
  hasCollection(collectionID) {
    return this.collections.has(collectionID);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Item State Methods
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Store or update item sync state
   * @param {number} itemID - Zotero item ID
   * @param {Object} data - Item state data
   * @param {number[]} data.collectionIDs - Collection IDs containing this item
   * @param {string} data.filePath - Current file path on disk
   * @param {number|null} data.primaryCollectionID - Primary collection for file location
   */
  setItem(itemID, data) {
    this.items.set(itemID, {
      collectionIDs: data.collectionIDs || [],
      filePath: data.filePath,
      primaryCollectionID: data.primaryCollectionID || null,
      lastSynced: Date.now()
    });
    this._dirty = true;
  }

  /**
   * Get item sync state
   * @param {number} itemID - Zotero item ID
   * @returns {ItemState|null} Item state or null if not found
   */
  getItem(itemID) {
    return this.items.get(itemID) || null;
  }

  /**
   * Remove item from sync state
   * @param {number} itemID - Zotero item ID
   */
  removeItem(itemID) {
    this.items.delete(itemID);
    this._dirty = true;
  }

  /**
   * Find item by its file path
   * @param {string} filePath - File path to search for
   * @returns {Object|null} Item state with id, or null if not found
   */
  getItemByPath(filePath) {
    for (const [id, data] of this.items) {
      if (data.filePath === filePath) {
        return { id, ...data };
      }
    }
    return null;
  }

  /**
   * Get all items in a specific collection
   * @param {number} collectionID - Collection ID to search
   * @returns {Array<Object>} Array of item states with ids
   */
  getItemsByCollection(collectionID) {
    const result = [];
    for (const [id, data] of this.items) {
      if (data.collectionIDs.includes(collectionID)) {
        result.push({ id, ...data });
      }
    }
    return result;
  }

  /**
   * Check if an item is tracked
   * @param {number} itemID - Zotero item ID
   * @returns {boolean} True if item is in sync state
   */
  hasItem(itemID) {
    return this.items.has(itemID);
  }

  /**
   * Update item's collection membership
   * @param {number} itemID - Zotero item ID
   * @param {number} collectionID - Collection ID to add
   */
  addItemToCollection(itemID, collectionID) {
    const item = this.items.get(itemID);
    if (item && !item.collectionIDs.includes(collectionID)) {
      item.collectionIDs.push(collectionID);
      item.lastSynced = Date.now();
      this._dirty = true;
    }
  }

  /**
   * Remove item from a collection (keeps item if in other collections)
   * @param {number} itemID - Zotero item ID
   * @param {number} collectionID - Collection ID to remove from
   */
  removeItemFromCollection(itemID, collectionID) {
    const item = this.items.get(itemID);
    if (item) {
      const index = item.collectionIDs.indexOf(collectionID);
      if (index > -1) {
        item.collectionIDs.splice(index, 1);
        item.lastSynced = Date.now();
        this._dirty = true;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Persistence Methods
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Save state to disk if dirty
   */
  async save() {
    if (!this._dirty) return;

    if (!this.dataFile) {
      Zotero.debug('[WatchFolder] Cannot save sync state: no data file path set');
      return;
    }

    const data = {
      version: this.version,
      lastFullSync: this.lastFullSync,
      collections: Object.fromEntries(this.collections),
      items: Object.fromEntries(this.items)
    };

    try {
      await IOUtils.writeJSON(this.dataFile, data);
      this._dirty = false;
      Zotero.debug('[WatchFolder] Sync state saved');
    } catch (e) {
      Zotero.logError(`[WatchFolder] Failed to save sync state: ${e.message}`);
      // Don't clear dirty flag so we retry on next save
      throw e;
    }
  }

  /**
   * Force save even if not dirty
   */
  async forceSave() {
    this._dirty = true;
    await this.save();
  }

  /**
   * Load state from disk
   */
  async load() {
    try {
      if (await IOUtils.exists(this.dataFile)) {
        const data = await IOUtils.readJSON(this.dataFile);

        // Handle version migrations if needed
        if (data.version !== this.version) {
          await this._migrateState(data);
        } else {
          this.version = data.version || 1;
          this.lastFullSync = data.lastFullSync || null;

          // Convert plain objects back to Maps with numeric keys
          this.collections = new Map(
            Object.entries(data.collections || {}).map(([k, v]) => [parseInt(k) || k, v])
          );
          this.items = new Map(
            Object.entries(data.items || {}).map(([k, v]) => [parseInt(k) || k, v])
          );
        }

        Zotero.debug(
          `[WatchFolder] Sync state loaded: ${this.collections.size} collections, ${this.items.size} items`
        );
      }
    } catch (e) {
      Zotero.debug(`[WatchFolder] Failed to load sync state: ${e.message}`);
    }
  }

  /**
   * Migrate state from older versions
   * @param {Object} oldData - Data from older version
   * @private
   */
  async _migrateState(oldData) {
    Zotero.debug(`[WatchFolder] Migrating sync state from version ${oldData.version} to ${this.version}`);

    // Currently only version 1, add migration logic here as needed
    this.lastFullSync = oldData.lastFullSync || null;
    this.collections = new Map(
      Object.entries(oldData.collections || {}).map(([k, v]) => [parseInt(k) || k, v])
    );
    this.items = new Map(
      Object.entries(oldData.items || {}).map(([k, v]) => [parseInt(k) || k, v])
    );

    this._dirty = true;
    await this.save();
  }

  /**
   * Clear all state
   */
  clear() {
    this.collections.clear();
    this.items.clear();
    this.lastFullSync = null;
    this._dirty = true;
  }

  /**
   * Mark that a full sync was completed
   */
  markFullSync() {
    this.lastFullSync = Date.now();
    this._dirty = true;
  }

  /**
   * Check if state has unsaved changes
   * @returns {boolean} True if dirty
   */
  isDirty() {
    return this._dirty;
  }

  /**
   * Get statistics about current state
   * @returns {Object} State statistics
   */
  getStats() {
    return {
      collectionCount: this.collections.size,
      itemCount: this.items.size,
      lastFullSync: this.lastFullSync,
      isDirty: this._dirty
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Singleton Pattern
// ═══════════════════════════════════════════════════════════════════════════════

/** @type {SyncState|null} Singleton instance */
let _instance = null;

/**
 * Get the singleton SyncState instance
 * @returns {SyncState} The sync state manager
 */
export function getSyncState() {
  if (!_instance) {
    _instance = new SyncState();
  }
  return _instance;
}

/**
 * Reset the singleton (useful for testing)
 */
export function resetSyncState() {
  _instance = null;
}

/**
 * @typedef {Object} CollectionState
 * @property {string} name - Collection name
 * @property {number|null} parentID - Parent collection ID
 * @property {string} folderPath - Mapped folder path on disk
 * @property {number} lastSynced - Timestamp of last sync
 */

/**
 * @typedef {Object} ItemState
 * @property {number[]} collectionIDs - Collection IDs containing this item
 * @property {string} filePath - Current file path on disk
 * @property {number|null} primaryCollectionID - Primary collection for file location
 * @property {number} lastSynced - Timestamp of last sync
 */
