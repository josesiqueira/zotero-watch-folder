/**
 * Bulk Operations Module for Zotero Watch Folder Plugin
 *
 * Provides mass operations for library reorganization, metadata retry,
 * and smart rules application. Includes progress reporting and dry-run mode.
 *
 * @module bulkOperations
 */

import { delay } from './utils.mjs';
import { renameAttachment, buildFilename } from './fileRenamer.mjs';
import { getMetadataRetriever, NEEDS_REVIEW_TAG } from './metadataRetriever.mjs';

// Default batch size for processing
const DEFAULT_BATCH_SIZE = 10;

// Delay between batches in milliseconds
const BATCH_DELAY_MS = 100;

/**
 * Progress status enum
 * @typedef {'processing' | 'success' | 'error' | 'skipped'} ProgressStatus
 */

/**
 * Progress callback information
 * @typedef {Object} ProgressInfo
 * @property {number} current - Current item number being processed
 * @property {number} total - Total number of items to process
 * @property {string} currentItem - Title or name of current item
 * @property {ProgressStatus} status - Current status of the operation
 * @property {string} [message] - Optional status message
 */

/**
 * Bulk operation options
 * @typedef {Object} BulkOperationOptions
 * @property {boolean} [dryRun=false] - If true, simulate without making changes
 * @property {Function} [onProgress] - Progress callback function
 * @property {number} [batchSize=10] - Number of items to process per batch
 * @property {string} [pattern] - Custom rename pattern (for reorganize operations)
 */

/**
 * Bulk operation result
 * @typedef {Object} BulkOperationResult
 * @property {number} processed - Number of items processed
 * @property {number} success - Number of successful operations
 * @property {number} failed - Number of failed operations
 * @property {number} skipped - Number of skipped items
 * @property {Array<Object>} results - Detailed results for each item
 */

/**
 * BulkOperations class
 * Manages mass operations on Zotero library items with progress tracking
 * and batch processing to prevent UI freezing.
 */
export class BulkOperations {
  constructor() {
    /** @type {boolean} Whether an operation is currently running */
    this._isRunning = false;

    /** @type {boolean} Whether cancellation has been requested */
    this._cancelRequested = false;
  }

  /**
   * Initialize the bulk operations manager
   */
  async init() {
    Zotero.debug('[WatchFolder] BulkOperations initialized');
  }

  /**
   * Check if an operation is currently running
   * @returns {boolean} True if an operation is in progress
   */
  isRunning() {
    return this._isRunning;
  }

  /**
   * Request cancellation of the current operation
   * The operation will stop at the next batch boundary
   */
  requestCancel() {
    if (this._isRunning) {
      this._cancelRequested = true;
      Zotero.debug('[WatchFolder] Bulk operation cancellation requested');
    }
  }

  // ============================================================
  // Helper Methods
  // ============================================================

  /**
   * Get all regular items in the library that have file attachments
   * @param {number} [libraryID] - Library ID (defaults to user library)
   * @returns {Promise<Zotero.Item[]>} Array of regular items with attachments
   */
  async getItemsWithAttachments(libraryID = Zotero.Libraries.userLibraryID) {
    const allItems = await Zotero.Items.getAll(libraryID);
    const itemsWithAttachments = [];

    for (const item of allItems) {
      if (!item.isRegularItem()) continue;

      const attachmentIDs = item.getAttachments();
      if (attachmentIDs && attachmentIDs.length > 0) {
        // Check if any attachment is a linked file
        for (const attachID of attachmentIDs) {
          const attachment = await Zotero.Items.getAsync(attachID);
          if (attachment && attachment.isAttachment()) {
            const linkMode = attachment.attachmentLinkMode;
            // linkMode: 0 = imported file, 1 = imported URL, 2 = linked file, 3 = linked URL
            if (linkMode === 0 || linkMode === 2) {
              itemsWithAttachments.push(item);
              break;
            }
          }
        }
      }
    }

    return itemsWithAttachments;
  }

  /**
   * Get all linked file attachments in the library
   * @param {number} [libraryID] - Library ID (defaults to user library)
   * @returns {Promise<Zotero.Item[]>} Array of attachment items
   */
  async getAllLinkedAttachments(libraryID = Zotero.Libraries.userLibraryID) {
    const allItems = await Zotero.Items.getAll(libraryID);
    const attachments = [];

    for (const item of allItems) {
      if (!item.isAttachment()) continue;

      const linkMode = item.attachmentLinkMode;
      // Include both imported files (0) and linked files (2)
      if (linkMode === 0 || linkMode === 2) {
        attachments.push(item);
      }
    }

    return attachments;
  }

  /**
   * Get all items with a specific tag
   * @param {string} tag - The tag to search for
   * @param {number} [libraryID] - Library ID (defaults to user library)
   * @returns {Promise<Zotero.Item[]>} Array of items with the tag
   */
  async getItemsWithTag(tag, libraryID = Zotero.Libraries.userLibraryID) {
    const allItems = await Zotero.Items.getAll(libraryID);
    const taggedItems = [];

    for (const item of allItems) {
      const tags = item.getTags();
      const hasTag = tags.some(t => t.tag === tag);
      if (hasTag) {
        taggedItems.push(item);
      }
    }

    return taggedItems;
  }

  /**
   * Process items in batches with progress reporting
   * @param {Array} items - Items to process
   * @param {Function} processor - Async function to process each item
   * @param {BulkOperationOptions} options - Processing options
   * @returns {Promise<BulkOperationResult>} Operation results
   */
  async _processBatch(items, processor, options = {}) {
    const {
      dryRun = false,
      onProgress = () => {},
      batchSize = DEFAULT_BATCH_SIZE
    } = options;

    const results = [];
    let successCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    this._isRunning = true;
    this._cancelRequested = false;

    try {
      for (let i = 0; i < items.length; i++) {
        // Check for cancellation
        if (this._cancelRequested) {
          Zotero.debug(`[WatchFolder] Bulk operation cancelled at item ${i + 1}/${items.length}`);
          break;
        }

        const item = items[i];
        const itemTitle = item.getField ? (item.getField('title') || `Item ${item.id}`) : `Item ${item.id}`;

        // Report progress - processing
        onProgress({
          current: i + 1,
          total: items.length,
          currentItem: itemTitle,
          status: 'processing',
          message: `Processing ${itemTitle}...`
        });

        try {
          const result = await processor(item, dryRun);
          results.push(result);

          if (result.skipped) {
            skippedCount++;
            onProgress({
              current: i + 1,
              total: items.length,
              currentItem: itemTitle,
              status: 'skipped',
              message: result.message || 'Skipped'
            });
          } else if (result.success) {
            successCount++;
            onProgress({
              current: i + 1,
              total: items.length,
              currentItem: itemTitle,
              status: 'success',
              message: result.message || 'Completed'
            });
          } else {
            failedCount++;
            onProgress({
              current: i + 1,
              total: items.length,
              currentItem: itemTitle,
              status: 'error',
              message: result.error || 'Failed'
            });
          }
        } catch (error) {
          failedCount++;
          results.push({
            itemID: item.id,
            success: false,
            error: error.message
          });
          onProgress({
            current: i + 1,
            total: items.length,
            currentItem: itemTitle,
            status: 'error',
            message: error.message
          });
        }

        // Delay between batches to prevent UI freezing
        if ((i + 1) % batchSize === 0 && i + 1 < items.length) {
          await delay(BATCH_DELAY_MS);
        }
      }
    } finally {
      this._isRunning = false;
      this._cancelRequested = false;
    }

    return {
      processed: results.length,
      success: successCount,
      failed: failedCount,
      skipped: skippedCount,
      results
    };
  }

  // ============================================================
  // Reorganize Operations
  // ============================================================

  /**
   * Reorganize a single item's attachments using the current naming pattern
   * @param {Zotero.Item} item - The parent item whose attachments to rename
   * @param {Object} [options={}] - Options
   * @param {boolean} [options.dryRun=false] - If true, preview without renaming
   * @param {string} [options.pattern] - Custom rename pattern
   * @returns {Promise<Object>} Result object with success status and details
   */
  async reorganizeItem(item, options = {}) {
    const { dryRun = false, pattern = null } = options;

    if (!item.isRegularItem()) {
      return {
        itemID: item.id,
        success: false,
        skipped: true,
        message: 'Not a regular item'
      };
    }

    const attachmentIDs = item.getAttachments();
    if (!attachmentIDs || attachmentIDs.length === 0) {
      return {
        itemID: item.id,
        success: false,
        skipped: true,
        message: 'No attachments'
      };
    }

    const attachmentResults = [];
    let anySuccess = false;

    for (const attachID of attachmentIDs) {
      const attachment = await Zotero.Items.getAsync(attachID);
      if (!attachment || !attachment.isAttachment()) continue;

      const linkMode = attachment.attachmentLinkMode;
      // Only process file attachments (imported or linked files)
      if (linkMode !== 0 && linkMode !== 2) continue;

      if (dryRun) {
        // Preview mode - show what would happen
        const oldName = attachment.attachmentFilename;
        const extension = oldName && oldName.includes('.') ? oldName.split('.').pop() : 'pdf';
        const newBaseName = buildFilename(item, pattern);
        const newName = `${newBaseName}.${extension}`;

        attachmentResults.push({
          attachmentID: attachID,
          oldName: oldName || 'Unknown',
          newName,
          wouldChange: oldName !== newName
        });

        if (oldName !== newName) anySuccess = true;
      } else {
        // Actually rename
        const result = await renameAttachment(attachment, { pattern });
        attachmentResults.push({
          attachmentID: attachID,
          ...result
        });
        if (result.success) anySuccess = true;
      }
    }

    return {
      itemID: item.id,
      itemTitle: item.getField('title'),
      success: anySuccess,
      skipped: attachmentResults.length === 0,
      dryRun,
      attachments: attachmentResults,
      message: dryRun
        ? `Would rename ${attachmentResults.filter(r => r.wouldChange).length} attachment(s)`
        : `Renamed ${attachmentResults.filter(r => r.success).length} attachment(s)`
    };
  }

  /**
   * Reorganize all items in the library using the current naming pattern
   * @param {BulkOperationOptions} [options={}] - Operation options
   * @returns {Promise<BulkOperationResult>} Operation results
   */
  async reorganizeAllItems(options = {}) {
    const { dryRun = false, pattern = null, ...restOptions } = options;

    Zotero.debug(`[WatchFolder] Starting reorganize all items (dryRun: ${dryRun})`);

    // Get all items with attachments
    const items = await this.getItemsWithAttachments();
    Zotero.debug(`[WatchFolder] Found ${items.length} items with attachments`);

    if (items.length === 0) {
      return {
        processed: 0,
        success: 0,
        failed: 0,
        skipped: 0,
        results: []
      };
    }

    // Process each item
    const result = await this._processBatch(
      items,
      (item) => this.reorganizeItem(item, { dryRun, pattern }),
      restOptions
    );

    Zotero.debug(`[WatchFolder] Reorganize complete: ${result.success} success, ${result.failed} failed, ${result.skipped} skipped`);
    return result;
  }

  // ============================================================
  // Metadata Operations
  // ============================================================

  /**
   * Retry metadata retrieval for a single item
   * @param {Zotero.Item} item - The item to retry metadata for
   * @param {boolean} [dryRun=false] - If true, preview without triggering
   * @returns {Promise<Object>} Result object
   */
  async retryMetadataForItem(item, dryRun = false) {
    // Find PDF attachments that need metadata
    let attachmentToRetry = null;

    if (item.isAttachment()) {
      // Item is itself an attachment
      const contentType = item.attachmentContentType;
      if (contentType === 'application/pdf') {
        attachmentToRetry = item;
      }
    } else if (item.isRegularItem()) {
      // Find PDF attachments
      const attachmentIDs = item.getAttachments();
      for (const attachID of attachmentIDs) {
        const attachment = await Zotero.Items.getAsync(attachID);
        if (attachment && attachment.attachmentContentType === 'application/pdf') {
          // Check if this is a standalone attachment without parent metadata
          if (!attachment.parentID || !this._hasGoodMetadata(item)) {
            attachmentToRetry = attachment;
            break;
          }
        }
      }
    }

    if (!attachmentToRetry) {
      return {
        itemID: item.id,
        success: false,
        skipped: true,
        message: 'No PDF attachment found'
      };
    }

    if (dryRun) {
      return {
        itemID: item.id,
        attachmentID: attachmentToRetry.id,
        success: true,
        dryRun: true,
        message: 'Would retry metadata retrieval'
      };
    }

    // Remove the needs-review tag before retrying
    try {
      const retriever = getMetadataRetriever();

      // Remove existing tag
      await retriever.removeNeedsReviewTag(item);

      // Queue for metadata retrieval
      return new Promise((resolve) => {
        retriever.queueItem(attachmentToRetry.id, (success, itemID) => {
          resolve({
            itemID: item.id,
            attachmentID: itemID,
            success,
            message: success ? 'Metadata retrieval succeeded' : 'Metadata retrieval failed'
          });
        });
      });
    } catch (error) {
      return {
        itemID: item.id,
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Check if an item has good metadata (not just filename)
   * @param {Zotero.Item} item - Item to check
   * @returns {boolean} True if item has meaningful metadata
   */
  _hasGoodMetadata(item) {
    const title = item.getField('title');
    if (!title) return false;

    // If title looks like a filename, it's not good metadata
    if (title.match(/\.(pdf|epub|djvu|doc|docx|txt|rtf)$/i)) {
      return false;
    }

    // Check for at least one creator
    const creators = item.getCreators();
    return title.length > 5 || (creators && creators.length > 0);
  }

  /**
   * Retry metadata retrieval for all items with the _needs-review tag
   * @param {BulkOperationOptions} [options={}] - Operation options
   * @returns {Promise<BulkOperationResult>} Operation results
   */
  async retryFailedMetadata(options = {}) {
    const { dryRun = false, ...restOptions } = options;

    Zotero.debug(`[WatchFolder] Starting retry failed metadata (dryRun: ${dryRun})`);

    // Get all items with _needs-review tag
    const items = await this.getItemsWithTag(NEEDS_REVIEW_TAG);
    Zotero.debug(`[WatchFolder] Found ${items.length} items with ${NEEDS_REVIEW_TAG} tag`);

    if (items.length === 0) {
      return {
        processed: 0,
        success: 0,
        failed: 0,
        skipped: 0,
        results: []
      };
    }

    // Make sure metadata retriever is initialized and running
    if (!dryRun) {
      const retriever = getMetadataRetriever();
      // Initialize if not already done (sets up notifier for recognition detection)
      if (!retriever._notifierID) {
        await retriever.init();
      }
      if (!retriever.isRunning()) {
        retriever.start();
      }
    }

    // Process each item
    const result = await this._processBatch(
      items,
      (item) => this.retryMetadataForItem(item, dryRun),
      restOptions
    );

    Zotero.debug(`[WatchFolder] Retry metadata complete: ${result.success} queued, ${result.failed} failed, ${result.skipped} skipped`);
    return result;
  }

  // ============================================================
  // Smart Rules Operations
  // ============================================================

  /**
   * Apply smart rules to a single item
   * @param {Zotero.Item} item - The item to apply rules to
   * @param {boolean} [dryRun=false] - If true, preview without applying
   * @returns {Promise<Object>} Result object with applied rules
   */
  async applyRulesToItem(item, dryRun = false) {
    if (!item.isRegularItem()) {
      return {
        itemID: item.id,
        success: false,
        skipped: true,
        message: 'Not a regular item'
      };
    }

    try {
      // Dynamically import smartRules to avoid circular dependency
      // and to handle the case where it might not exist yet
      let getSmartRulesEngine;
      try {
        const smartRulesModule = await import('./smartRules.mjs');
        getSmartRulesEngine = smartRulesModule.getSmartRulesEngine;
      } catch (importError) {
        return {
          itemID: item.id,
          success: false,
          skipped: true,
          message: 'Smart rules module not available'
        };
      }

      const rulesEngine = getSmartRulesEngine();

      // Initialize engine if needed
      if (!rulesEngine._initialized) {
        await rulesEngine.init();
      }

      // Evaluate rules against the item
      const evaluation = rulesEngine.evaluate(item, {});

      if (dryRun) {
        // Preview mode - show which rules would match
        return {
          itemID: item.id,
          itemTitle: item.getField('title'),
          success: evaluation.matchedRules.length > 0,
          skipped: evaluation.matchedRules.length === 0,
          dryRun: true,
          matchingRules: evaluation.matchedRules.map(r => ({
            name: r.name,
            actions: evaluation.actions.filter(a => a.ruleId === r.id)
          })),
          message: evaluation.matchedRules.length > 0
            ? `Would apply ${evaluation.matchedRules.length} rule(s)`
            : 'No matching rules'
        };
      }

      // Execute matched actions
      if (evaluation.actions.length > 0) {
        const executionResult = await rulesEngine.executeActions(evaluation.actions, item);
        return {
          itemID: item.id,
          itemTitle: item.getField('title'),
          success: executionResult.succeeded > 0,
          skipped: false,
          appliedRules: evaluation.matchedRules.map(r => ({
            name: r.name,
            actions: evaluation.actions.filter(a => a.ruleId === r.id)
          })),
          message: `Applied ${evaluation.matchedRules.length} rule(s), ${executionResult.succeeded} action(s) succeeded`
        };
      }

      // No matching rules
      return {
        itemID: item.id,
        itemTitle: item.getField('title'),
        success: false,
        skipped: true,
        appliedRules: [],
        message: 'No matching rules'
      };
    } catch (error) {
      return {
        itemID: item.id,
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Apply smart rules to all existing library items
   * @param {BulkOperationOptions} [options={}] - Operation options
   * @returns {Promise<BulkOperationResult>} Operation results
   */
  async applyRulesToExisting(options = {}) {
    const { dryRun = false, ...restOptions } = options;

    Zotero.debug(`[WatchFolder] Starting apply rules to existing items (dryRun: ${dryRun})`);

    // Get all regular items
    const libraryID = Zotero.Libraries.userLibraryID;
    const allItems = await Zotero.Items.getAll(libraryID);
    const regularItems = allItems.filter(item => item.isRegularItem());

    Zotero.debug(`[WatchFolder] Found ${regularItems.length} regular items`);

    if (regularItems.length === 0) {
      return {
        processed: 0,
        success: 0,
        failed: 0,
        skipped: 0,
        results: []
      };
    }

    // Process each item
    const result = await this._processBatch(
      regularItems,
      (item) => this.applyRulesToItem(item, dryRun),
      restOptions
    );

    Zotero.debug(`[WatchFolder] Apply rules complete: ${result.success} success, ${result.failed} failed, ${result.skipped} skipped`);
    return result;
  }

  // ============================================================
  // Cleanup
  // ============================================================

  /**
   * Cleanup resources
   */
  destroy() {
    this._cancelRequested = true;
    Zotero.debug('[WatchFolder] BulkOperations destroyed');
  }
}

// ============================================================
// Singleton Pattern
// ============================================================

/** @type {BulkOperations|null} */
let _instance = null;

/**
 * Get the singleton BulkOperations instance
 * @returns {BulkOperations} The bulk operations instance
 */
export function getBulkOperations() {
  if (!_instance) {
    _instance = new BulkOperations();
  }
  return _instance;
}

/**
 * Reset the singleton instance (useful for testing)
 */
export function resetBulkOperations() {
  if (_instance) {
    _instance.destroy();
    _instance = null;
  }
}

// ============================================================
// Convenience Functions
// ============================================================

/**
 * Reorganize all items in the library using the current naming pattern
 * @param {BulkOperationOptions} [options={}] - Operation options
 * @returns {Promise<BulkOperationResult>} Operation results
 */
export async function reorganizeAll(options = {}) {
  const bulkOps = getBulkOperations();
  return bulkOps.reorganizeAllItems(options);
}

/**
 * Retry metadata retrieval for all failed items
 * @param {BulkOperationOptions} [options={}] - Operation options
 * @returns {Promise<BulkOperationResult>} Operation results
 */
export async function retryAllMetadata(options = {}) {
  const bulkOps = getBulkOperations();
  return bulkOps.retryFailedMetadata(options);
}

/**
 * Apply smart rules to all existing library items
 * @param {BulkOperationOptions} [options={}] - Operation options
 * @returns {Promise<BulkOperationResult>} Operation results
 */
export async function applyRulesToAll(options = {}) {
  const bulkOps = getBulkOperations();
  return bulkOps.applyRulesToExisting(options);
}

/**
 * Check if a bulk operation is currently running
 * @returns {boolean} True if an operation is in progress
 */
export function isBulkOperationRunning() {
  return _instance ? _instance.isRunning() : false;
}

/**
 * Cancel the current bulk operation
 */
export function cancelBulkOperation() {
  if (_instance) {
    _instance.requestCancel();
  }
}
