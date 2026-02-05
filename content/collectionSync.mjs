/**
 * collectionSync.mjs - Collection Sync Coordinator
 *
 * Main coordinator for collection-folder synchronization.
 * Orchestrates sync state, watchers, path mapping, and conflict resolution.
 *
 * Part of Phase 2: Collection ↔ Folder Synchronization
 *
 * Features:
 * - F2.1: Collection → Folder sync (create/rename/delete folders)
 * - F2.2: Item → Folder sync (move files when items move between collections)
 * - F2.3: Folder → Collection sync (reverse direction)
 * - F2.4: Conflict resolution for bidirectional sync
 */

import { getPref, setPref } from './utils.mjs';
import { SyncState, getSyncState } from './syncState.mjs';
import { CollectionWatcher, getCollectionWatcher } from './collectionWatcher.mjs';
import { FolderWatcher, getFolderWatcher } from './folderWatcher.mjs';
import { PathMapper, getPathMapper } from './pathMapper.mjs';
import { ConflictResolver } from './conflictResolver.mjs';

/**
 * Main coordinator for collection-folder synchronization
 * Manages bidirectional sync between Zotero collections and disk folders
 */
export class CollectionSyncService {
  constructor() {
    // ═══════════════════════════════════════════════════════════════════════
    // Dependencies
    // ═══════════════════════════════════════════════════════════════════════

    /** @type {SyncState|null} State persistence manager */
    this._syncState = null;

    /** @type {CollectionWatcher|null} Zotero collection change watcher */
    this._collectionWatcher = null;

    /** @type {FolderWatcher|null} Filesystem folder watcher */
    this._folderWatcher = null;

    /** @type {PathMapper|null} Collection-folder path mapper */
    this._pathMapper = null;

    /** @type {ConflictResolver|null} Sync conflict resolver */
    this._conflictResolver = null;

    // ═══════════════════════════════════════════════════════════════════════
    // State
    // ═══════════════════════════════════════════════════════════════════════

    /** @type {boolean} Prevents recursive sync operations */
    this._isSyncing = false;

    /** @type {boolean} Whether service has been initialized */
    this._initialized = false;

    /** @type {boolean} Whether sync is enabled */
    this._enabled = false;

    // ═══════════════════════════════════════════════════════════════════════
    // Configuration
    // ═══════════════════════════════════════════════════════════════════════

    /** @type {number|null} Root collection ID for mirror */
    this._rootCollectionID = null;

    /** @type {string|null} Mirror directory path on disk */
    this._mirrorPath = null;

    /** @type {Set<number>} Collection IDs currently being processed (debounce) */
    this._pendingCollections = new Set();

    /** @type {Set<number>} Item IDs currently being processed (debounce) */
    this._pendingItems = new Set();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Getters
  // ═══════════════════════════════════════════════════════════════════════════

  /** @returns {boolean} Whether a sync operation is in progress */
  get isSyncing() { return this._isSyncing; }

  /** @returns {number|null} Root collection ID */
  get rootCollectionID() { return this._rootCollectionID; }

  /** @returns {string|null} Mirror directory path */
  get mirrorPath() { return this._mirrorPath; }

  /** @returns {boolean} Whether service is initialized */
  get isInitialized() { return this._initialized; }

  /** @returns {boolean} Whether sync is enabled */
  get isEnabled() { return this._enabled; }

  /** @returns {SyncState|null} The sync state manager */
  get syncState() { return this._syncState; }

  /** @returns {PathMapper|null} The path mapper */
  get pathMapper() { return this._pathMapper; }

  // ═══════════════════════════════════════════════════════════════════════════
  // Lifecycle Methods
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Initialize the sync service
   * Loads configuration and sets up components
   */
  async init() {
    if (this._initialized) return;

    // Load configuration from preferences
    this._mirrorPath = getPref('mirrorPath');
    this._rootCollectionID = parseInt(getPref('mirrorRootCollection')) || null;
    this._enabled = getPref('collectionSyncEnabled') || false;

    if (!this._mirrorPath || !this._rootCollectionID) {
      Zotero.debug('[WatchFolder] Collection sync not configured (missing mirrorPath or rootCollection)');
      return;
    }

    // Validate root collection exists
    const rootCollection = Zotero.Collections.get(this._rootCollectionID);
    if (!rootCollection) {
      Zotero.debug(`[WatchFolder] Root collection ${this._rootCollectionID} not found`);
      return;
    }

    // Initialize components
    this._syncState = getSyncState();
    await this._syncState.init();

    this._pathMapper = getPathMapper(this._mirrorPath, this._rootCollectionID);
    this._conflictResolver = new ConflictResolver();
    this._conflictResolver.init();

    this._collectionWatcher = getCollectionWatcher(this);
    this._folderWatcher = getFolderWatcher(this);

    this._initialized = true;
    Zotero.debug(`[WatchFolder] CollectionSyncService initialized`);
    Zotero.debug(`[WatchFolder]   Mirror path: ${this._mirrorPath}`);
    Zotero.debug(`[WatchFolder]   Root collection: ${rootCollection.name} (ID: ${this._rootCollectionID})`);
  }

  /**
   * Start the sync service
   * Performs initial sync and starts watchers
   */
  async start() {
    if (!this._initialized) {
      await this.init();
    }

    if (!this._initialized || !this._enabled) {
      Zotero.debug('[WatchFolder] Cannot start: not initialized or not enabled');
      return;
    }

    // Perform initial full sync
    await this.performFullSync();

    // Start watchers for ongoing sync
    this._collectionWatcher.register();
    this._folderWatcher.start();

    Zotero.debug('[WatchFolder] Collection sync started');
  }

  /**
   * Stop the sync service
   * Stops watchers but preserves state
   */
  stop() {
    this._collectionWatcher?.unregister();
    this._folderWatcher?.stop();
    Zotero.debug('[WatchFolder] Collection sync stopped');
  }

  /**
   * Destroy the sync service
   * Stops watchers and saves final state
   */
  async destroy() {
    this.stop();
    await this._syncState?.save();
    this._initialized = false;
    Zotero.debug('[WatchFolder] CollectionSyncService destroyed');
  }

  /**
   * Enable or disable sync
   * @param {boolean} enabled - Whether to enable sync
   */
  async setEnabled(enabled) {
    this._enabled = enabled;
    setPref('collectionSyncEnabled', enabled);

    if (enabled) {
      await this.start();
    } else {
      this.stop();
    }
  }

  /**
   * Update mirror configuration
   * @param {string} mirrorPath - New mirror directory path
   * @param {number} rootCollectionID - New root collection ID
   */
  async configure(mirrorPath, rootCollectionID) {
    const wasRunning = this._enabled && this._initialized;

    if (wasRunning) {
      this.stop();
    }

    this._mirrorPath = mirrorPath;
    this._rootCollectionID = rootCollectionID;

    setPref('mirrorPath', mirrorPath);
    setPref('mirrorRootCollection', rootCollectionID.toString());

    // Clear old state and reinitialize
    this._syncState?.clear();
    this._initialized = false;

    if (wasRunning) {
      await this.start();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Full Sync Methods
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Perform full reconciliation sync
   * Syncs all collections and items under the mirror root
   */
  async performFullSync() {
    if (this._isSyncing) {
      Zotero.debug('[WatchFolder] Full sync already in progress, skipping');
      return;
    }

    this._isSyncing = true;

    try {
      Zotero.debug('[WatchFolder] Starting full sync...');
      const startTime = Date.now();

      // Ensure mirror directory exists
      await IOUtils.makeDirectory(this._mirrorPath, { ignoreExisting: true });

      // Get all collections under root
      const collections = await this._getCollectionsUnderRoot();
      Zotero.debug(`[WatchFolder] Found ${collections.length} collections to sync`);

      // Create folders for each collection (in order to handle parent folders first)
      for (const collection of collections) {
        await this.syncCollectionToFolder(collection);
      }

      // Sync items in each collection
      for (const collection of collections) {
        await this._syncCollectionItems(collection);
      }

      // Mark full sync complete
      this._syncState.markFullSync();
      await this._syncState.save();

      const elapsed = Date.now() - startTime;
      Zotero.debug(`[WatchFolder] Full sync complete: ${collections.length} collections in ${elapsed}ms`);

    } catch (e) {
      Zotero.logError(e);
      Zotero.debug(`[WatchFolder] Full sync failed: ${e.message}`);
    } finally {
      this._isSyncing = false;
    }
  }

  /**
   * Sync items within a collection
   * @param {Zotero.Collection} collection - Collection to sync items from
   * @private
   */
  async _syncCollectionItems(collection) {
    const items = collection.getChildItems();

    for (const item of items) {
      // Only process linked file attachments
      if (!item.isAttachment() ||
          item.attachmentLinkMode !== Zotero.Attachments.LINK_MODE_LINKED_FILE) {
        continue;
      }

      const currentPath = item.getFilePath();
      if (!currentPath || !await IOUtils.exists(currentPath)) continue;

      const targetFolder = this._pathMapper.getPathForCollection(collection);
      const filename = PathUtils.filename(currentPath);
      const targetPath = PathUtils.join(targetFolder, filename);

      // Track item state
      this._syncState.setItem(item.id, {
        collectionIDs: [collection.id],
        filePath: currentPath,
        primaryCollectionID: collection.id
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Collection → Folder Sync (F2.1)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Sync a collection to its corresponding folder
   * Creates the folder if it doesn't exist
   * @param {Zotero.Collection} collection - Collection to sync
   */
  async syncCollectionToFolder(collection) {
    const folderPath = this._pathMapper.getPathForCollection(collection);

    try {
      // Create folder with all ancestors
      await IOUtils.makeDirectory(folderPath, {
        ignoreExisting: true,
        createAncestors: true
      });

      // Update state
      this._syncState.setCollection(collection.id, {
        name: collection.name,
        parentID: collection.parentID,
        folderPath: folderPath
      });

      Zotero.debug(`[WatchFolder] Synced collection "${collection.name}" → ${folderPath}`);
    } catch (e) {
      Zotero.debug(`[WatchFolder] Failed to sync collection "${collection.name}": ${e.message}`);
      throw e;
    }
  }

  /**
   * Handle collection creation event
   * @param {number} collectionID - ID of created collection
   */
  async handleCollectionCreated(collectionID) {
    if (this._isSyncing) return;
    if (this._pendingCollections.has(collectionID)) return;

    this._pendingCollections.add(collectionID);

    try {
      const collection = Zotero.Collections.get(collectionID);
      if (!collection || !this._isUnderMirrorRoot(collection)) return;

      await this.syncCollectionToFolder(collection);
      await this._syncState.save();
    } finally {
      this._pendingCollections.delete(collectionID);
    }
  }

  /**
   * Handle collection rename event
   * @param {number} collectionID - ID of renamed collection
   * @param {string} oldName - Previous collection name
   */
  async handleCollectionRenamed(collectionID, oldName) {
    if (this._isSyncing) return;
    if (this._pendingCollections.has(collectionID)) return;

    this._pendingCollections.add(collectionID);

    try {
      const collection = Zotero.Collections.get(collectionID);
      if (!collection || !this._isUnderMirrorRoot(collection)) return;

      const state = this._syncState.getCollection(collectionID);
      if (!state) {
        // Collection not tracked, add it
        await this.syncCollectionToFolder(collection);
        await this._syncState.save();
        return;
      }

      const oldPath = state.folderPath;
      const newPath = this._pathMapper.getPathForCollection(collection, true); // force recalculate

      if (oldPath !== newPath && await IOUtils.exists(oldPath)) {
        // Rename folder
        await IOUtils.move(oldPath, newPath);

        // Update state
        this._syncState.setCollection(collectionID, {
          name: collection.name,
          parentID: collection.parentID,
          folderPath: newPath
        });

        // Update paths for all child collections
        await this._updateChildCollectionPaths(collectionID);

        // Update paths for items in this collection
        await this._updateItemPathsForCollection(collectionID, oldPath, newPath);

        Zotero.debug(`[WatchFolder] Renamed folder: ${oldPath} → ${newPath}`);
      }

      await this._syncState.save();
    } finally {
      this._pendingCollections.delete(collectionID);
    }
  }

  /**
   * Handle collection deletion event
   * @param {number} collectionID - ID of deleted collection
   */
  async handleCollectionDeleted(collectionID) {
    if (this._isSyncing) return;

    const state = this._syncState.getCollection(collectionID);
    if (!state) return;

    const folderPath = state.folderPath;

    if (await IOUtils.exists(folderPath)) {
      // Check if folder is empty
      const children = await IOUtils.getChildren(folderPath);

      if (children.length === 0) {
        await IOUtils.remove(folderPath);
        Zotero.debug(`[WatchFolder] Deleted empty folder: ${folderPath}`);
      } else {
        Zotero.debug(`[WatchFolder] Folder not empty (${children.length} items), keeping: ${folderPath}`);
      }
    }

    this._syncState.removeCollection(collectionID);
    await this._syncState.save();
  }

  /**
   * Handle collection move event (parent changed)
   * @param {number} collectionID - ID of moved collection
   * @param {number|null} oldParentID - Previous parent ID
   */
  async handleCollectionMoved(collectionID, oldParentID) {
    if (this._isSyncing) return;
    if (this._pendingCollections.has(collectionID)) return;

    this._pendingCollections.add(collectionID);

    try {
      const collection = Zotero.Collections.get(collectionID);
      if (!collection) return;

      const wasUnderRoot = oldParentID !== null &&
        (oldParentID === this._rootCollectionID || this._isUnderMirrorRootByID(oldParentID));
      const isUnderRoot = this._isUnderMirrorRoot(collection);

      if (!wasUnderRoot && !isUnderRoot) return; // Neither in mirror scope

      const state = this._syncState.getCollection(collectionID);

      if (wasUnderRoot && !isUnderRoot) {
        // Moved out of mirror scope - remove folder
        if (state && await IOUtils.exists(state.folderPath)) {
          const children = await IOUtils.getChildren(state.folderPath);
          if (children.length === 0) {
            await IOUtils.remove(state.folderPath);
          }
        }
        this._syncState.removeCollection(collectionID);

      } else if (!wasUnderRoot && isUnderRoot) {
        // Moved into mirror scope - create folder
        await this.syncCollectionToFolder(collection);

      } else {
        // Moved within mirror scope - rename folder
        if (state) {
          const oldPath = state.folderPath;
          const newPath = this._pathMapper.getPathForCollection(collection, true);

          if (oldPath !== newPath && await IOUtils.exists(oldPath)) {
            await IOUtils.move(oldPath, newPath);

            this._syncState.setCollection(collectionID, {
              name: collection.name,
              parentID: collection.parentID,
              folderPath: newPath
            });

            await this._updateChildCollectionPaths(collectionID);
            await this._updateItemPathsForCollection(collectionID, oldPath, newPath);
          }
        }
      }

      await this._syncState.save();
    } finally {
      this._pendingCollections.delete(collectionID);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Item → Folder Sync (F2.2)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Handle item added to collection event
   * @param {number} itemID - ID of the item
   * @param {number} collectionID - ID of the collection
   */
  async handleItemAddedToCollection(itemID, collectionID) {
    if (this._isSyncing) return;
    if (this._pendingItems.has(itemID)) return;

    this._pendingItems.add(itemID);

    try {
      // Only process linked file attachments
      const item = await Zotero.Items.getAsync(itemID);
      if (!item || !item.isAttachment() ||
          item.attachmentLinkMode !== Zotero.Attachments.LINK_MODE_LINKED_FILE) {
        return;
      }

      const collection = Zotero.Collections.get(collectionID);
      if (!collection || !this._isUnderMirrorRoot(collection)) return;

      const currentPath = item.getFilePath();
      if (!currentPath || !await IOUtils.exists(currentPath)) return;

      const targetFolder = this._pathMapper.getPathForCollection(collection);
      const filename = PathUtils.filename(currentPath);
      let targetPath = PathUtils.join(targetFolder, filename);

      // Check if file is already in the target location
      if (currentPath === targetPath) {
        // Just update state
        this._syncState.setItem(itemID, {
          collectionIDs: [collectionID],
          filePath: currentPath,
          primaryCollectionID: collectionID
        });
        await this._syncState.save();
        return;
      }

      // Check for conflicts
      if (await IOUtils.exists(targetPath)) {
        const resolution = await this._conflictResolver.resolve({
          type: 'file_exists',
          sourcePath: currentPath,
          targetPath: targetPath,
          item: item,
          collection: collection
        });

        if (resolution.action === 'skip') {
          Zotero.debug(`[WatchFolder] Skipping file move due to conflict: ${currentPath}`);
          return;
        } else if (resolution.action === 'rename') {
          // Generate a unique target path
          targetPath = await this._pathMapper.getUniqueFilePath(targetFolder, filename);
          Zotero.debug(`[WatchFolder] Renamed to unique path: ${targetPath}`);
        }
        // 'overwrite' action: continue with original targetPath (will overwrite)
      }

      // Move the file
      this._isSyncing = true;
      try {
        // First move the file
        await IOUtils.move(currentPath, targetPath);

        // Then relink the attachment - if this fails, try to restore
        try {
          await item.relinkAttachmentFile(targetPath);
        } catch (relinkError) {
          // Attempt to restore the file to original location
          Zotero.logError(`[WatchFolder] Failed to relink attachment, attempting to restore: ${relinkError.message}`);
          try {
            await IOUtils.move(targetPath, currentPath);
            Zotero.debug(`[WatchFolder] Restored file to original location: ${currentPath}`);
          } catch (restoreError) {
            Zotero.logError(`[WatchFolder] Failed to restore file: ${restoreError.message}`);
          }
          throw relinkError;
        }

        this._syncState.setItem(itemID, {
          collectionIDs: [collectionID],
          filePath: targetPath,
          primaryCollectionID: collectionID
        });

        Zotero.debug(`[WatchFolder] Moved item file: ${currentPath} → ${targetPath}`);
      } catch (moveError) {
        Zotero.logError(`[WatchFolder] Failed to move item file: ${moveError.message}`);
        throw moveError;
      } finally {
        this._isSyncing = false;
      }

      await this._syncState.save();
    } finally {
      this._pendingItems.delete(itemID);
    }
  }

  /**
   * Handle item removed from collection event
   * @param {number} itemID - ID of the item
   * @param {number} collectionID - ID of the collection
   */
  async handleItemRemovedFromCollection(itemID, collectionID) {
    if (this._isSyncing) return;

    const state = this._syncState.getItem(itemID);
    if (!state) return;

    // Remove collection from item's collection list
    this._syncState.removeItemFromCollection(itemID, collectionID);

    // If item is no longer in any tracked collections, remove from state
    const updatedState = this._syncState.getItem(itemID);
    if (updatedState && updatedState.collectionIDs.length === 0) {
      this._syncState.removeItem(itemID);
    }

    await this._syncState.save();
  }

  /**
   * Handle item deletion event
   * @param {number} itemID - ID of deleted item
   */
  async handleItemDeleted(itemID) {
    if (this._isSyncing) return;

    this._syncState.removeItem(itemID);
    await this._syncState.save();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Folder → Collection Sync (F2.3) - Handlers for FolderWatcher
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Handle folder creation event from filesystem
   * @param {string} folderPath - Path of created folder
   */
  async handleFolderCreated(folderPath) {
    if (this._isSyncing) return;

    // Check if folder is within mirror path
    if (!folderPath.startsWith(this._mirrorPath)) return;

    // Check if collection already exists for this path
    const existingState = this._syncState.getCollectionByPath(folderPath);
    if (existingState) return;

    // Determine parent collection
    const parentPath = PathUtils.parent(folderPath);
    const parentState = this._syncState.getCollectionByPath(parentPath);
    const parentCollectionID = parentState ? parentState.id : this._rootCollectionID;

    // Create new collection
    const folderName = PathUtils.filename(folderPath);

    this._isSyncing = true;
    try {
      // Get libraryID from the root collection
      const rootCollection = Zotero.Collections.get(this._rootCollectionID);
      const libraryID = rootCollection ? rootCollection.libraryID : Zotero.Libraries.userLibraryID;

      const collection = new Zotero.Collection();
      collection.libraryID = libraryID;
      collection.name = folderName;
      collection.parentID = parentCollectionID;
      await collection.saveTx();

      this._syncState.setCollection(collection.id, {
        name: collection.name,
        parentID: collection.parentID,
        folderPath: folderPath
      });

      Zotero.debug(`[WatchFolder] Created collection "${folderName}" from folder: ${folderPath}`);
    } finally {
      this._isSyncing = false;
    }

    await this._syncState.save();
  }

  /**
   * Handle folder rename event from filesystem
   * @param {string} oldPath - Previous folder path
   * @param {string} newPath - New folder path
   */
  async handleFolderRenamed(oldPath, newPath) {
    if (this._isSyncing) return;

    const state = this._syncState.getCollectionByPath(oldPath);
    if (!state) return;

    const collection = Zotero.Collections.get(state.id);
    if (!collection) return;

    const newName = PathUtils.filename(newPath);

    this._isSyncing = true;
    try {
      collection.name = newName;
      await collection.saveTx();

      this._syncState.setCollection(state.id, {
        name: newName,
        parentID: state.parentID,
        folderPath: newPath
      });

      Zotero.debug(`[WatchFolder] Renamed collection from folder: ${oldPath} → ${newPath}`);
    } finally {
      this._isSyncing = false;
    }

    await this._syncState.save();
  }

  /**
   * Handle folder deletion event from filesystem
   * @param {string} folderPath - Path of deleted folder
   */
  async handleFolderDeleted(folderPath) {
    if (this._isSyncing) return;

    const state = this._syncState.getCollectionByPath(folderPath);
    if (!state) return;

    const collection = Zotero.Collections.get(state.id);
    if (!collection) return;

    this._isSyncing = true;
    try {
      await collection.eraseTx();
      this._syncState.removeCollection(state.id);
      Zotero.debug(`[WatchFolder] Deleted collection from folder removal: ${folderPath}`);
    } finally {
      this._isSyncing = false;
    }

    await this._syncState.save();
  }

  /**
   * Handle file created in mirror directory (alias for handleFileAdded)
   * @param {string} filePath - Path of created file
   */
  async handleFileCreatedInMirror(filePath) {
    return this.handleFileAdded(filePath);
  }

  /**
   * Handle file added event from filesystem
   * @param {string} filePath - Path of added file
   */
  async handleFileAdded(filePath) {
    if (this._isSyncing) return;

    // Check if file is within mirror path
    if (!filePath.startsWith(this._mirrorPath)) return;

    // Check if item already exists for this path
    const existingState = this._syncState.getItemByPath(filePath);
    if (existingState) return;

    // Determine collection from parent folder
    const parentPath = PathUtils.parent(filePath);
    const collectionState = this._syncState.getCollectionByPath(parentPath);
    if (!collectionState) return;

    const collection = Zotero.Collections.get(collectionState.id);
    if (!collection) return;

    // Create linked file attachment
    this._isSyncing = true;
    try {
      const item = await Zotero.Attachments.linkFromFile({
        file: filePath,
        collections: [collection.id]
      });

      if (item) {
        this._syncState.setItem(item.id, {
          collectionIDs: [collection.id],
          filePath: filePath,
          primaryCollectionID: collection.id
        });

        Zotero.debug(`[WatchFolder] Created linked attachment from file: ${filePath}`);
      }
    } finally {
      this._isSyncing = false;
    }

    await this._syncState.save();
  }

  /**
   * Handle file deleted from mirror directory
   * @param {string} filePath - Path of deleted file
   */
  async handleFileDeletedFromMirror(filePath) {
    if (this._isSyncing) return;

    // Check if file was within mirror path
    if (!filePath.startsWith(this._mirrorPath)) return;

    // Find the item by path
    const itemState = this._syncState.getItemByPath(filePath);
    if (!itemState) return;

    const item = await Zotero.Items.getAsync(itemState.id);
    if (!item) {
      // Item no longer exists in Zotero, just clean up state
      this._syncState.removeItem(itemState.id);
      await this._syncState.save();
      return;
    }

    // Option: Delete the Zotero item or just unlink it
    // For safety, we just remove from collections (not delete the item)
    this._isSyncing = true;
    try {
      // Remove item from all tracked collections
      for (const collectionID of itemState.collectionIDs) {
        const collection = Zotero.Collections.get(collectionID);
        if (collection) {
          collection.removeItem(item.id);
          await collection.saveTx();
        }
      }

      // Remove from state
      this._syncState.removeItem(itemState.id);
      Zotero.debug(`[WatchFolder] Removed item ${itemState.id} from collections due to file deletion: ${filePath}`);
    } finally {
      this._isSyncing = false;
    }

    await this._syncState.save();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Helper Methods
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get all collections under the mirror root
   * @returns {Promise<Zotero.Collection[]>} Array of collections
   * @private
   */
  async _getCollectionsUnderRoot() {
    const result = [];
    const rootCollection = Zotero.Collections.get(this._rootCollectionID);
    if (!rootCollection) return result;

    const traverse = (collection) => {
      result.push(collection);
      const children = Zotero.Collections.getByParent(collection.id);
      for (const child of children) {
        traverse(child);
      }
    };

    // Start with children of root (not root itself)
    const children = Zotero.Collections.getByParent(this._rootCollectionID);
    for (const child of children) {
      traverse(child);
    }

    return result;
  }

  /**
   * Check if a collection is under the mirror root
   * @param {Zotero.Collection} collection - Collection to check
   * @returns {boolean} True if under mirror root
   * @private
   */
  _isUnderMirrorRoot(collection) {
    if (!collection || !this._rootCollectionID) return false;
    if (collection.id === this._rootCollectionID) return false; // Root itself not synced

    let current = collection;
    while (current) {
      if (current.parentID === this._rootCollectionID) return true;
      current = current.parentID ? Zotero.Collections.get(current.parentID) : null;
    }
    return false;
  }

  /**
   * Check if a collection ID is under the mirror root
   * @param {number} collectionID - Collection ID to check
   * @returns {boolean} True if under mirror root
   * @private
   */
  _isUnderMirrorRootByID(collectionID) {
    const collection = Zotero.Collections.get(collectionID);
    return collection ? this._isUnderMirrorRoot(collection) : false;
  }

  /**
   * Update folder paths for all child collections after a parent rename/move
   * @param {number} parentCollectionID - Parent collection ID
   * @private
   */
  async _updateChildCollectionPaths(parentCollectionID) {
    const children = Zotero.Collections.getByParent(parentCollectionID);

    for (const child of children) {
      const state = this._syncState.getCollection(child.id);
      if (state) {
        const newPath = this._pathMapper.getPathForCollection(child, true);

        this._syncState.setCollection(child.id, {
          name: child.name,
          parentID: child.parentID,
          folderPath: newPath
        });

        // Recursively update grandchildren
        await this._updateChildCollectionPaths(child.id);
      }
    }
  }

  /**
   * Update file paths for items when a collection folder is renamed
   * @param {number} collectionID - Collection ID
   * @param {string} oldFolderPath - Old folder path
   * @param {string} newFolderPath - New folder path
   * @private
   */
  async _updateItemPathsForCollection(collectionID, oldFolderPath, newFolderPath) {
    const items = this._syncState.getItemsByCollection(collectionID);

    for (const itemState of items) {
      if (itemState.filePath.startsWith(oldFolderPath)) {
        const relativePath = itemState.filePath.substring(oldFolderPath.length);
        const newPath = newFolderPath + relativePath;

        this._syncState.setItem(itemState.id, {
          collectionIDs: itemState.collectionIDs,
          filePath: newPath,
          primaryCollectionID: itemState.primaryCollectionID
        });
      }
    }
  }

  /**
   * Get service statistics
   * @returns {Object} Service statistics
   */
  getStats() {
    return {
      initialized: this._initialized,
      enabled: this._enabled,
      isSyncing: this._isSyncing,
      mirrorPath: this._mirrorPath,
      rootCollectionID: this._rootCollectionID,
      syncState: this._syncState?.getStats() || null
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Singleton Pattern and Module Exports
// ═══════════════════════════════════════════════════════════════════════════════

/** @type {CollectionSyncService|null} Singleton instance */
let _instance = null;

/**
 * Get the singleton CollectionSyncService instance
 * @returns {CollectionSyncService} The sync service
 */
export function getCollectionSyncService() {
  if (!_instance) {
    _instance = new CollectionSyncService();
  }
  return _instance;
}

/**
 * Initialize and optionally start the collection sync service
 * @returns {Promise<CollectionSyncService>} The initialized service
 */
export async function initCollectionSync() {
  const service = getCollectionSyncService();
  await service.init();

  if (getPref('collectionSyncEnabled')) {
    await service.start();
  }

  return service;
}

/**
 * Shutdown the collection sync service
 * @returns {Promise<void>}
 */
export async function shutdownCollectionSync() {
  if (_instance) {
    await _instance.destroy();
    _instance = null;
  }
}

/**
 * Reset the singleton (useful for testing)
 */
export function resetCollectionSyncService() {
  if (_instance) {
    _instance.stop();
  }
  _instance = null;
}
