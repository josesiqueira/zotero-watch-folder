/**
 * Zotero Watch Folder - Tracking Store Module
 *
 * Manages persistence of imported file tracking data.
 * Uses JSON file in Zotero profile directory.
 * Implements LRU eviction to bound memory usage.
 */

/**
 * Represents a tracking record for an imported file
 * @typedef {Object} TrackingRecord
 * @property {string} path - Original file path
 * @property {string} hash - SHA-256 hash of first 1MB
 * @property {number} mtime - Last modified time
 * @property {number} size - File size in bytes
 * @property {number} itemID - Zotero item ID after import
 * @property {string} importDate - ISO date string
 * @property {boolean} metadataRetrieved - Has metadata been fetched?
 * @property {boolean} renamed - Has file been renamed?
 */

/**
 * Creates a new tracking record with default values
 * @param {Partial<TrackingRecord>} data - Partial record data
 * @returns {TrackingRecord}
 */
export function createTrackingRecord(data) {
    return {
        path: data.path || '',
        hash: data.hash || '',
        mtime: data.mtime || 0,
        size: data.size || 0,
        itemID: data.itemID || 0,
        importDate: data.importDate || new Date().toISOString(),
        metadataRetrieved: data.metadataRetrieved || false,
        renamed: data.renamed || false
    };
}

/**
 * Manages persistence of imported file tracking data
 * Uses JSON file in Zotero profile directory
 * Implements LRU eviction to bound memory usage
 */
export class TrackingStore {
    /**
     * @param {number} maxEntries - Maximum number of entries to store
     */
    constructor(maxEntries = 5000) {
        this.maxEntries = maxEntries;
        this.records = new Map(); // path -> TrackingRecord
        this.dataFile = null;
        this._dirty = false;
        this._initialized = false;
    }

    /**
     * Initialize the store - load from disk
     * @returns {Promise<void>}
     */
    async init() {
        if (this._initialized) {
            Zotero.debug('[Watch Folder] TrackingStore: Already initialized');
            return;
        }

        try {
            // Get Zotero data directory (profile directory for data)
            // Use Zotero.DataDirectory.dir for the Zotero data location
            // or Zotero.Profile.dir for the Firefox profile
            const dataDir = Zotero.DataDirectory.dir;

            // Construct the path to our tracking file
            this.dataFile = PathUtils.join(dataDir, 'zotero-watch-folder-tracking.json');

            Zotero.debug(`[Watch Folder] TrackingStore: Data file path: ${this.dataFile}`);

            // Load existing data if file exists
            await this.load();

            this._initialized = true;
            Zotero.debug(`[Watch Folder] TrackingStore: Initialized with ${this.records.size} records`);

        } catch (error) {
            Zotero.debug(`[Watch Folder] TrackingStore: Initialization error: ${error.message}`);
            // Initialize with empty state even if load fails
            this.records = new Map();
            this._initialized = true;
        }
    }

    /**
     * Ensure the store is initialized before operations
     * @private
     */
    _ensureInitialized() {
        if (!this._initialized) {
            throw new Error('TrackingStore not initialized. Call init() first.');
        }
    }

    /**
     * Add a tracking record
     * @param {TrackingRecord} record
     */
    add(record) {
        this._ensureInitialized();

        if (!record || !record.path) {
            Zotero.debug('[Watch Folder] TrackingStore: Cannot add record without path');
            return;
        }

        // If the path already exists, delete it first so it moves to end (LRU)
        if (this.records.has(record.path)) {
            this.records.delete(record.path);
        }

        // Add the new record
        this.records.set(record.path, record);
        this._dirty = true;

        // Evict oldest entries if over maxEntries (LRU eviction)
        this._evictIfNeeded();

        Zotero.debug(`[Watch Folder] TrackingStore: Added record for ${record.path}`);
    }

    /**
     * Evict oldest entries if over maxEntries
     * Map maintains insertion order, so first entries are oldest
     * @private
     */
    _evictIfNeeded() {
        while (this.records.size > this.maxEntries) {
            // Get the first (oldest) key
            const oldestKey = this.records.keys().next().value;
            this.records.delete(oldestKey);
            Zotero.debug(`[Watch Folder] TrackingStore: Evicted oldest record: ${oldestKey}`);
        }
    }

    /**
     * Check if a file path is already tracked
     * @param {string} path - File path to check
     * @returns {boolean}
     */
    hasPath(path) {
        this._ensureInitialized();
        return this.records.has(path);
    }

    /**
     * Check if a file hash is already tracked
     * @param {string} hash - SHA-256 hash to check
     * @returns {boolean}
     */
    hasHash(hash) {
        this._ensureInitialized();

        if (!hash) {
            return false;
        }

        for (const record of this.records.values()) {
            if (record.hash === hash) {
                return true;
            }
        }
        return false;
    }

    /**
     * Find a record by hash
     * @param {string} hash - SHA-256 hash to find
     * @returns {TrackingRecord|null}
     */
    findByHash(hash) {
        this._ensureInitialized();

        if (!hash) {
            return null;
        }

        for (const record of this.records.values()) {
            if (record.hash === hash) {
                return record;
            }
        }
        return null;
    }

    /**
     * Find records by Zotero item ID
     * @param {number} itemID - Zotero item ID
     * @returns {TrackingRecord|null}
     */
    findByItemID(itemID) {
        this._ensureInitialized();

        if (!itemID) {
            return null;
        }

        for (const record of this.records.values()) {
            if (record.itemID === itemID) {
                return record;
            }
        }
        return null;
    }

    /**
     * Get a record by path
     * @param {string} path - File path
     * @returns {TrackingRecord|null}
     */
    get(path) {
        this._ensureInitialized();
        return this.records.get(path) || null;
    }

    /**
     * Update a record (e.g., after metadata retrieval)
     * @param {string} path - File path
     * @param {Partial<TrackingRecord>} updates - Fields to update
     */
    update(path, updates) {
        this._ensureInitialized();

        const record = this.records.get(path);
        if (record) {
            Object.assign(record, updates);
            this._dirty = true;
            Zotero.debug(`[Watch Folder] TrackingStore: Updated record for ${path}`);
        } else {
            Zotero.debug(`[Watch Folder] TrackingStore: Cannot update - record not found for ${path}`);
        }
    }

    /**
     * Remove a record by path
     * @param {string} path - File path
     * @returns {boolean} - True if record was removed
     */
    remove(path) {
        this._ensureInitialized();

        const removed = this.records.delete(path);
        if (removed) {
            this._dirty = true;
            Zotero.debug(`[Watch Folder] TrackingStore: Removed record for ${path}`);
        }
        return removed;
    }

    /**
     * Remove a record by Zotero item ID
     * @param {number} itemID - Zotero item ID
     * @returns {boolean} - True if record was removed
     */
    removeByItemID(itemID) {
        this._ensureInitialized();

        if (!itemID) {
            return false;
        }

        for (const [path, record] of this.records.entries()) {
            if (record.itemID === itemID) {
                this.records.delete(path);
                this._dirty = true;
                Zotero.debug(`[Watch Folder] TrackingStore: Removed record for itemID ${itemID}`);
                return true;
            }
        }
        return false;
    }

    /**
     * Get all records
     * @returns {TrackingRecord[]}
     */
    getAll() {
        this._ensureInitialized();
        return Array.from(this.records.values());
    }

    /**
     * Get the number of tracked records
     * @returns {number}
     */
    get size() {
        return this.records.size;
    }

    /**
     * Get the number of tracked records (alias for size)
     * @returns {number}
     */
    get count() {
        return this.records.size;
    }

    /**
     * Check if the store has unsaved changes
     * @returns {boolean}
     */
    get isDirty() {
        return this._dirty;
    }

    /**
     * Save to disk if dirty
     * @returns {Promise<void>}
     */
    async save() {
        this._ensureInitialized();

        if (!this._dirty) {
            Zotero.debug('[Watch Folder] TrackingStore: No changes to save');
            return;
        }

        if (!this.dataFile) {
            Zotero.debug('[Watch Folder] TrackingStore: No data file path set');
            return;
        }

        try {
            // Convert Map to array for JSON serialization
            const data = {
                version: 1,
                lastSaved: new Date().toISOString(),
                records: Array.from(this.records.entries()).map(([path, record]) => ({
                    path,
                    ...record
                }))
            };

            // Write to file using IOUtils
            await IOUtils.writeJSON(this.dataFile, data);

            this._dirty = false;
            Zotero.debug(`[Watch Folder] TrackingStore: Saved ${this.records.size} records to ${this.dataFile}`);

        } catch (error) {
            Zotero.debug(`[Watch Folder] TrackingStore: Error saving to disk: ${error.message}`);
            throw error;
        }
    }

    /**
     * Load from disk
     * @returns {Promise<void>}
     */
    async load() {
        if (!this.dataFile) {
            Zotero.debug('[Watch Folder] TrackingStore: No data file path set');
            return;
        }

        try {
            // Check if file exists
            const exists = await IOUtils.exists(this.dataFile);
            if (!exists) {
                Zotero.debug('[Watch Folder] TrackingStore: No existing data file found');
                this.records = new Map();
                return;
            }

            // Read from file using IOUtils
            const data = await IOUtils.readJSON(this.dataFile);

            // Validate data structure
            if (!data || !Array.isArray(data.records)) {
                Zotero.debug('[Watch Folder] TrackingStore: Invalid data format in file');
                this.records = new Map();
                return;
            }

            // Populate Map from array
            this.records = new Map();
            for (const record of data.records) {
                if (record && record.path) {
                    this.records.set(record.path, record);
                }
            }

            this._dirty = false;
            Zotero.debug(`[Watch Folder] TrackingStore: Loaded ${this.records.size} records from ${this.dataFile}`);

        } catch (error) {
            if (error.name === 'NotFoundError') {
                Zotero.debug('[Watch Folder] TrackingStore: Data file not found, starting fresh');
            } else if (error instanceof SyntaxError) {
                Zotero.debug('[Watch Folder] TrackingStore: Invalid JSON in data file, starting fresh');
            } else {
                Zotero.debug(`[Watch Folder] TrackingStore: Error loading from disk: ${error.message}`);
            }
            this.records = new Map();
        }
    }

    /**
     * Force reload from disk (discards unsaved changes)
     * @returns {Promise<void>}
     */
    async reload() {
        this._ensureInitialized();
        await this.load();
    }

    /**
     * Clear all tracking data
     */
    clear() {
        this._ensureInitialized();
        this.records.clear();
        this._dirty = true;
        Zotero.debug('[Watch Folder] TrackingStore: Cleared all records');
    }

    /**
     * Get records that need metadata retrieval
     * @returns {TrackingRecord[]}
     */
    getPendingMetadata() {
        this._ensureInitialized();
        return Array.from(this.records.values()).filter(
            record => !record.metadataRetrieved && record.itemID
        );
    }

    /**
     * Get records that need file renaming
     * @returns {TrackingRecord[]}
     */
    getPendingRename() {
        this._ensureInitialized();
        return Array.from(this.records.values()).filter(
            record => !record.renamed && record.itemID && record.metadataRetrieved
        );
    }

    /**
     * Get statistics about the tracking store
     * @returns {{total: number, withMetadata: number, renamed: number, pending: number}}
     */
    getStats() {
        this._ensureInitialized();

        let withMetadata = 0;
        let renamed = 0;
        let pending = 0;

        for (const record of this.records.values()) {
            if (record.metadataRetrieved) {
                withMetadata++;
            }
            if (record.renamed) {
                renamed++;
            }
            if (!record.metadataRetrieved && record.itemID) {
                pending++;
            }
        }

        return {
            total: this.records.size,
            withMetadata,
            renamed,
            pending
        };
    }

    /**
     * Export tracking data for debugging
     * @returns {Object}
     */
    exportData() {
        this._ensureInitialized();
        return {
            version: 1,
            exportDate: new Date().toISOString(),
            maxEntries: this.maxEntries,
            currentSize: this.records.size,
            records: Array.from(this.records.values())
        };
    }

    /**
     * Destroy the store (call before plugin unload)
     */
    destroy() {
        this.records.clear();
        this._initialized = false;
        this._dirty = false;
        Zotero.debug('[Watch Folder] TrackingStore: Destroyed');
    }
}

// Export a singleton instance for convenience
let _defaultStore = null;

/**
 * Get the default tracking store instance
 * @returns {TrackingStore}
 */
export function getTrackingStore() {
    if (!_defaultStore) {
        _defaultStore = new TrackingStore();
    }
    return _defaultStore;
}

/**
 * Initialize the default tracking store
 * @returns {Promise<TrackingStore>}
 */
export async function initTrackingStore() {
    const store = getTrackingStore();
    await store.init();
    return store;
}

/**
 * Reset the default tracking store (for testing)
 */
export function resetTrackingStore() {
    _defaultStore = null;
}
