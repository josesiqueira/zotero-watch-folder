/**
 * Collection Watcher Module for Zotero Watch Folder Plugin
 *
 * Watches Zotero for collection and item changes using Zotero.Notifier
 * to observe events and trigger synchronization with the filesystem.
 */

/**
 * Watches Zotero for collection and item changes
 * Uses Zotero.Notifier to observe events and trigger sync
 */
export class CollectionWatcher {
  constructor(syncService) {
    this._syncService = syncService;
    this._notifierID = null;
    this._enabled = false;
  }

  /**
   * Register the Zotero notifier observer
   */
  register() {
    if (this._notifierID) return;

    this._notifierID = Zotero.Notifier.registerObserver(
      {
        notify: async (event, type, ids, extraData) => {
          // Prevent recursive sync loops
          if (this._syncService.isSyncing) return;

          try {
            switch (type) {
              case 'collection':
                await this._handleCollectionEvent(event, ids, extraData);
                break;
              case 'collection-item':
                await this._handleCollectionItemEvent(event, ids, extraData);
                break;
            }
          } catch (e) {
            Zotero.logError(e);
            Zotero.debug(`[WatchFolder] CollectionWatcher error: ${e.message}`);
          }
        }
      },
      ['collection', 'collection-item'],
      'watchFolderCollectionSync'
    );

    this._enabled = true;
    Zotero.debug('[WatchFolder] CollectionWatcher registered');
  }

  /**
   * Unregister the notifier observer
   */
  unregister() {
    if (this._notifierID) {
      Zotero.Notifier.unregisterObserver(this._notifierID);
      this._notifierID = null;
      this._enabled = false;
      Zotero.debug('[WatchFolder] CollectionWatcher unregistered');
    }
  }

  /**
   * Handle collection events (add, modify, delete)
   * @param {string} event - Event type (add, modify, delete, move)
   * @param {number[]} ids - Array of collection IDs
   * @param {Object} extraData - Additional event data
   */
  async _handleCollectionEvent(event, ids, extraData) {
    for (const id of ids) {
      switch (event) {
        case 'add':
          await this._syncService.handleCollectionCreated(id);
          break;

        case 'modify':
          // Check if name changed
          const oldData = extraData[id];
          if (oldData && oldData.name) {
            await this._syncService.handleCollectionRenamed(id, oldData.name);
          }
          break;

        case 'delete':
          await this._syncService.handleCollectionDeleted(id);
          break;

        case 'move':
          // Collection moved to different parent
          await this._syncService.handleCollectionMoved(id, extraData[id]);
          break;
      }
    }
  }

  /**
   * Handle collection-item events (items added/removed from collections)
   *
   * For collection-item events, ids are in format "collectionID-itemID"
   * @param {string} event - Event type (add, remove)
   * @param {string[]} ids - Array of composite IDs in "collectionID-itemID" format
   * @param {Object} extraData - Additional event data
   */
  async _handleCollectionItemEvent(event, ids, extraData) {
    for (const compositeID of ids) {
      // Parse "collectionID-itemID" format
      const [collectionID, itemID] = compositeID.split('-').map(Number);

      if (isNaN(collectionID) || isNaN(itemID)) {
        Zotero.debug(`[WatchFolder] Invalid collection-item ID: ${compositeID}`);
        continue;
      }

      switch (event) {
        case 'add':
          // Item added to collection
          await this._syncService.handleItemAddedToCollection(itemID, collectionID);
          break;

        case 'remove':
          // Item removed from collection
          await this._syncService.handleItemRemovedFromCollection(itemID, collectionID);
          break;
      }
    }
  }

  /**
   * Check if the watcher is currently enabled
   * @returns {boolean}
   */
  isEnabled() {
    return this._enabled;
  }

  /**
   * Temporarily pause watching (for batch operations)
   */
  pause() {
    this._enabled = false;
  }

  /**
   * Resume watching
   */
  resume() {
    this._enabled = true;
  }
}

// Factory function with singleton pattern
let _instance = null;

/**
 * Get the CollectionWatcher instance
 * @param {Object} syncService - The sync service to use
 * @returns {CollectionWatcher}
 */
export function getCollectionWatcher(syncService) {
  if (!_instance && syncService) {
    _instance = new CollectionWatcher(syncService);
  }
  return _instance;
}

/**
 * Reset the CollectionWatcher instance (for cleanup/testing)
 */
export function resetCollectionWatcher() {
  if (_instance) {
    _instance.unregister();
    _instance = null;
  }
}
