/**
 * Metadata Retriever Module for Zotero Watch Folder Plugin
 *
 * Triggers Zotero's built-in PDF metadata retrieval for imported files
 * and tracks results. Handles queuing, throttling, and failure tagging.
 */

import { getPref, delay } from './utils.mjs';

// Tag to add when metadata retrieval fails
const NEEDS_REVIEW_TAG = '_needs-review';

/**
 * MetadataRetriever class
 * Manages a queue of items pending metadata retrieval with throttling
 * and automatic failure tagging.
 */
export class MetadataRetriever {
  constructor() {
    /** @type {Array<{itemID: number, onComplete: Function|null}>} */
    this._queue = [];
    /** @type {number} Current number of concurrent operations */
    this._processing = 0;
    /** @type {number} Maximum concurrent metadata requests */
    this._maxConcurrent = 2;
    /** @type {number} Delay between requests in milliseconds */
    this._delayBetween = 1500;
    /** @type {boolean} Whether the retriever is running */
    this._isRunning = false;
    /** @type {string|null} Zotero notifier ID for tracking changes */
    this._notifierID = null;
    /** @type {Map<number, {resolve: Function, timeout: number}>} Pending recognition tracking */
    this._pendingRecognition = new Map();
  }

  /**
   * Initialize the retriever
   * Sets up preferences and registers Zotero notifier to detect recognition completion
   */
  async init() {
    // Load max concurrent from preferences
    this._maxConcurrent = getPref('maxConcurrentMetadata') || 2;

    // Register a notifier to detect when recognition completes
    // Zotero fires 'modify' events when metadata is added to items
    this._notifierID = Zotero.Notifier.registerObserver(
      {
        notify: async (event, type, ids, extraData) => {
          await this._handleNotify(event, type, ids, extraData);
        }
      },
      ['item'],
      'watchFolder-metadataRetriever'
    );

    Zotero.debug('[WatchFolder] MetadataRetriever initialized');
  }

  /**
   * Handle Zotero notifier events
   * Detects when metadata recognition has completed for tracked items
   * @param {string} event - Event type (add, modify, delete, etc.)
   * @param {string} type - Object type (item, collection, etc.)
   * @param {number[]} ids - Array of affected item IDs
   * @param {Object} extraData - Additional event data
   */
  async _handleNotify(event, type, ids, extraData) {
    // We're interested in 'add' events for new parent items created by recognition
    // and 'modify' events when attachments get linked to parents
    if (type !== 'item') return;
    if (event !== 'add' && event !== 'modify') return;

    for (const id of ids) {
      // Check if this item is related to any pending recognition
      const item = await Zotero.Items.getAsync(id);
      if (!item) continue;

      // If this is a newly created parent item from recognition,
      // check if any of our pending attachments are now linked to it
      if (event === 'add' && item.isRegularItem()) {
        // Check child attachments
        const attachmentIDs = item.getAttachments();
        for (const attachmentID of attachmentIDs) {
          if (this._pendingRecognition.has(attachmentID)) {
            const pending = this._pendingRecognition.get(attachmentID);
            this._pendingRecognition.delete(attachmentID);
            clearTimeout(pending.timeout);
            pending.resolve(true);
            Zotero.debug(`[WatchFolder] Recognition completed for attachment ${attachmentID} -> parent ${id}`);
          }
        }
      }

      // If an attachment was modified (e.g., got a parent), check if we're tracking it
      if (event === 'modify' && item.isAttachment()) {
        if (this._pendingRecognition.has(id) && item.parentID) {
          const pending = this._pendingRecognition.get(id);
          this._pendingRecognition.delete(id);
          clearTimeout(pending.timeout);
          pending.resolve(true);
          Zotero.debug(`[WatchFolder] Recognition completed for item ${id}`);
        }
      }
    }
  }

  /**
   * Queue an item for metadata retrieval
   * @param {number} itemID - Zotero item ID
   * @param {Function} [onComplete] - Callback(success, itemID) called when done
   */
  queueItem(itemID, onComplete = null) {
    // Avoid duplicates in queue
    const exists = this._queue.some(q => q.itemID === itemID);
    if (exists) {
      Zotero.debug(`[WatchFolder] Item ${itemID} already in queue, skipping`);
      return;
    }

    this._queue.push({ itemID, onComplete });
    Zotero.debug(`[WatchFolder] Queued item ${itemID} for metadata retrieval (queue length: ${this._queue.length})`);
    this._processQueue();
  }

  /**
   * Queue multiple items for metadata retrieval
   * @param {number[]} itemIDs - Array of Zotero item IDs
   * @param {Function} [onComplete] - Callback(success, itemID) called for each item
   */
  queueItems(itemIDs, onComplete = null) {
    for (const itemID of itemIDs) {
      this.queueItem(itemID, onComplete);
    }
  }

  /**
   * Process the queue respecting concurrency limits
   * Called automatically when items are queued or processing completes
   */
  async _processQueue() {
    if (!this._isRunning) return;
    if (this._processing >= this._maxConcurrent) return;
    if (this._queue.length === 0) return;

    const { itemID, onComplete } = this._queue.shift();
    this._processing++;

    Zotero.debug(`[WatchFolder] Processing metadata for item ${itemID} (${this._processing}/${this._maxConcurrent} active)`);

    try {
      const success = await this._retrieveMetadata(itemID);
      if (onComplete) {
        try {
          onComplete(success, itemID);
        } catch (callbackError) {
          Zotero.debug(`[WatchFolder] Callback error for item ${itemID}: ${callbackError.message}`);
        }
      }
    } catch (error) {
      Zotero.logError(`[WatchFolder] Metadata retrieval error for item ${itemID}: ${error.message}`);
      if (onComplete) {
        try {
          onComplete(false, itemID);
        } catch (callbackError) {
          Zotero.debug(`[WatchFolder] Callback error for item ${itemID}: ${callbackError.message}`);
        }
      }
    } finally {
      this._processing--;

      // Delay before processing next item to avoid overwhelming services
      if (this._queue.length > 0) {
        await delay(this._delayBetween);
      }

      // Process next item
      this._processQueue();
    }
  }

  /**
   * Actually retrieve metadata for an item using Zotero's built-in recognition
   * @param {number} itemID - Zotero item ID
   * @returns {Promise<boolean>} True if recognition was successful or item already has metadata
   */
  async _retrieveMetadata(itemID) {
    const item = await Zotero.Items.getAsync(itemID);
    if (!item) {
      Zotero.debug(`[WatchFolder] Item ${itemID} not found`);
      return false;
    }

    // Skip if item already has metadata (title is not just filename)
    if (this._hasMetadata(item)) {
      Zotero.debug(`[WatchFolder] Item ${itemID} already has metadata, skipping`);
      return true;
    }

    // Only process attachments (PDFs)
    if (!item.isAttachment()) {
      Zotero.debug(`[WatchFolder] Item ${itemID} is not an attachment, skipping`);
      return true;
    }

    // Check if it's a PDF
    const contentType = item.attachmentContentType;
    if (contentType !== 'application/pdf') {
      Zotero.debug(`[WatchFolder] Item ${itemID} is not a PDF (${contentType}), skipping recognition`);
      return true;
    }

    try {
      // Use Zotero's built-in recognition
      // Zotero.RecognizeDocument.recognizeItems expects an array of items
      Zotero.debug(`[WatchFolder] Starting metadata recognition for item ${itemID}`);

      // Create a promise that will resolve when recognition completes
      const recognitionPromise = new Promise((resolve) => {
        // Set a timeout for recognition (60 seconds)
        const timeout = setTimeout(() => {
          if (this._pendingRecognition.has(itemID)) {
            this._pendingRecognition.delete(itemID);
            Zotero.debug(`[WatchFolder] Recognition timed out for item ${itemID}`);
            resolve(false);
          }
        }, 60000);

        this._pendingRecognition.set(itemID, { resolve, timeout });
      });

      // Start recognition
      await Zotero.RecognizeDocument.recognizeItems([item]);

      // Wait for recognition to complete (via notifier) or timeout
      const success = await recognitionPromise;

      if (!success) {
        // Recognition failed or timed out - add needs-review tag
        await this._addNeedsReviewTag(item);
        return false;
      }

      Zotero.debug(`[WatchFolder] Metadata retrieval succeeded for item ${itemID}`);
      return true;
    } catch (error) {
      // Add _needs-review tag on failure
      await this._addNeedsReviewTag(item);
      Zotero.debug(`[WatchFolder] Metadata retrieval failed for item ${itemID}: ${error.message}`);
      return false;
    }
  }

  /**
   * Check if item already has meaningful metadata
   * @param {Zotero.Item} item - Zotero item to check
   * @returns {boolean} True if item appears to have metadata
   */
  _hasMetadata(item) {
    try {
      // If it's an attachment, check if it has a parent with metadata
      if (item.isAttachment()) {
        const parentID = item.parentID;
        if (parentID) {
          // Use sync Zotero.Items.get() - valid in Zotero 7/8 for single item lookup
          // Note: can return null/undefined if item was deleted
          const parent = Zotero.Items.get(parentID);
          if (parent && !parent.deleted) {
            try {
              const title = parent.getField('title');
              if (title) {
                // Parent exists and has a title - likely has metadata
                return true;
              }
            } catch (e) {
              // getField can throw if item was deleted mid-check
              Zotero.debug(`[WatchFolder] Error checking parent metadata: ${e.message}`);
            }
          }
        }
        // No parent means standalone attachment, needs recognition
        return false;
      }

      // For regular items, check if title looks like a filename
      const title = item.getField('title');
      if (!title) return false;

      // If title ends with .pdf or similar file extensions, probably no real metadata
      if (title.match(/\.(pdf|epub|djvu|doc|docx)$/i)) {
        return false;
      }

      // Has a real title
      return true;
    } catch (e) {
      Zotero.debug(`[WatchFolder] Error in _hasMetadata: ${e.message}`);
      return false;
    }
  }

  /**
   * Add the _needs-review tag to an item to help users find failed items later
   * @param {Zotero.Item} item - Zotero item to tag
   */
  async _addNeedsReviewTag(item) {
    try {
      // If it's an attachment with a parent, tag the parent
      // Otherwise tag the attachment itself
      let targetItem = item;
      if (item.isAttachment() && item.parentID) {
        // Use sync Zotero.Items.get() - valid in Zotero 7/8 for single item lookup
        // Note: can return null/undefined if item was deleted
        const parent = Zotero.Items.get(item.parentID);
        if (parent && !parent.deleted) {
          targetItem = parent;
        }
        // If parent doesn't exist, fall back to tagging the attachment itself
      }

      if (targetItem && !targetItem.deleted) {
        // Check if tag already exists
        const existingTags = targetItem.getTags();
        const hasTag = existingTags.some(t => t.tag === NEEDS_REVIEW_TAG);

        if (!hasTag) {
          targetItem.addTag(NEEDS_REVIEW_TAG);
          await targetItem.saveTx();
          Zotero.debug(`[WatchFolder] Added ${NEEDS_REVIEW_TAG} tag to item ${targetItem.id}`);
        }
      }
    } catch (error) {
      Zotero.debug(`[WatchFolder] Failed to add ${NEEDS_REVIEW_TAG} tag: ${error.message}`);
    }
  }

  /**
   * Remove the _needs-review tag from an item
   * Useful when user manually fixes metadata
   * @param {Zotero.Item} item - Zotero item to untag
   */
  async removeNeedsReviewTag(item) {
    try {
      let targetItem = item;
      if (item.isAttachment() && item.parentID) {
        // Use sync Zotero.Items.get() - valid in Zotero 7/8 for single item lookup
        // Note: can return null/undefined if item was deleted
        const parent = Zotero.Items.get(item.parentID);
        if (parent && !parent.deleted) {
          targetItem = parent;
        }
        // If parent doesn't exist, fall back to the attachment itself
      }

      if (targetItem && !targetItem.deleted) {
        targetItem.removeTag(NEEDS_REVIEW_TAG);
        await targetItem.saveTx();
        Zotero.debug(`[WatchFolder] Removed ${NEEDS_REVIEW_TAG} tag from item ${targetItem.id}`);
      }
    } catch (error) {
      Zotero.debug(`[WatchFolder] Failed to remove ${NEEDS_REVIEW_TAG} tag: ${error.message}`);
    }
  }

  /**
   * Start processing the queue
   */
  start() {
    this._isRunning = true;
    Zotero.debug('[WatchFolder] MetadataRetriever started');
    this._processQueue();
  }

  /**
   * Stop processing (items remain in queue for later)
   */
  stop() {
    this._isRunning = false;
    Zotero.debug('[WatchFolder] MetadataRetriever stopped');
  }

  /**
   * Clear all items from the queue
   */
  clearQueue() {
    const cleared = this._queue.length;
    this._queue = [];
    Zotero.debug(`[WatchFolder] Cleared ${cleared} items from metadata queue`);
  }

  /**
   * Get the current queue length
   * @returns {number} Number of items waiting in queue
   */
  getQueueLength() {
    return this._queue.length;
  }

  /**
   * Get the number of items currently being processed
   * @returns {number} Number of active concurrent operations
   */
  getActiveCount() {
    return this._processing;
  }

  /**
   * Check if the retriever is currently running
   * @returns {boolean} True if running
   */
  isRunning() {
    return this._isRunning;
  }

  /**
   * Update configuration from preferences
   * Call this when preferences change
   */
  updateConfig() {
    this._maxConcurrent = getPref('maxConcurrentMetadata') || 2;
    Zotero.debug(`[WatchFolder] MetadataRetriever config updated: maxConcurrent=${this._maxConcurrent}`);
  }

  /**
   * Cleanup resources
   * Call this when shutting down the plugin
   */
  destroy() {
    this.stop();
    this.clearQueue();

    // Clear any pending recognition timeouts
    for (const [itemID, pending] of this._pendingRecognition) {
      clearTimeout(pending.timeout);
      pending.resolve(false);
    }
    this._pendingRecognition.clear();

    // Unregister notifier
    if (this._notifierID) {
      Zotero.Notifier.unregisterObserver(this._notifierID);
      this._notifierID = null;
      Zotero.debug('[WatchFolder] MetadataRetriever notifier unregistered');
    }

    Zotero.debug('[WatchFolder] MetadataRetriever destroyed');
  }
}

// Singleton instance
let _instance = null;

/**
 * Get the singleton MetadataRetriever instance
 * @returns {MetadataRetriever} The retriever instance
 */
export function getMetadataRetriever() {
  if (!_instance) {
    _instance = new MetadataRetriever();
  }
  return _instance;
}

/**
 * Initialize and start the metadata retriever
 * Convenience function for plugin startup
 * @returns {Promise<MetadataRetriever>} The initialized retriever
 */
export async function initMetadataRetriever() {
  const retriever = getMetadataRetriever();
  await retriever.init();
  retriever.start();
  return retriever;
}

/**
 * Shutdown the metadata retriever
 * Convenience function for plugin shutdown
 */
export function shutdownMetadataRetriever() {
  if (_instance) {
    _instance.destroy();
    _instance = null;
  }
}

// Export the tag name for use by other modules
export { NEEDS_REVIEW_TAG };
