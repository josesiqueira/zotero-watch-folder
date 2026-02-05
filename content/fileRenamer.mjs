/**
 * File Renamer Module for Watch Folder Plugin
 * Renames attachment files based on parent item metadata using configurable patterns
 * @module fileRenamer
 */

import { getPref, sanitizeFilename } from './utils.mjs';

/**
 * Template variables supported in rename patterns:
 * - {firstCreator} - First author's last name
 * - {creators} - All authors (comma-separated last names)
 * - {year} - Publication year
 * - {title} - Full title
 * - {shortTitle} - First 50 characters of title
 * - {DOI} - DOI value
 * - {itemType} - Item type (journalArticle, etc.)
 * - {publicationTitle} - Journal/conference name
 */

/**
 * Get first creator's last name
 * @param {Zotero.Item} item - The Zotero item
 * @returns {string} First creator's last name or empty string
 */
function getFirstCreator(item) {
  const creators = item.getCreators();
  if (!creators || creators.length === 0) return '';

  const first = creators[0];
  return first.lastName || first.name || '';
}

/**
 * Get all creators as comma-separated last names
 * @param {Zotero.Item} item - The Zotero item
 * @returns {string} Comma-separated last names or empty string
 */
function getAllCreators(item) {
  const creators = item.getCreators();
  if (!creators || creators.length === 0) return '';

  return creators
    .map(c => c.lastName || c.name || '')
    .filter(n => n)
    .join(', ');
}

/**
 * Check if an item has useful metadata for renaming
 * @param {Zotero.Item} item - The Zotero item to check
 * @returns {boolean} True if item has sufficient metadata
 */
function hasUsefulMetadata(item) {
  const title = item.getField('title');
  if (!title) return false;

  // Check if title looks like a filename (probably no real metadata)
  if (title.match(/\.(pdf|epub|djvu|doc|docx|txt|rtf|odt|mobi|azw)$/i)) return false;

  // Check if we have at least title or author
  const creators = item.getCreators();
  return title.length > 0 || (creators && creators.length > 0);
}

/**
 * Build a filename from a pattern and item metadata
 * @param {Zotero.Item} item - The Zotero item (parent of attachment)
 * @param {string} [pattern=null] - Pattern like "{firstCreator} - {year} - {title}"
 * @returns {string} Generated filename (without extension)
 */
export function buildFilename(item, pattern = null) {
  const template = pattern || getPref('renamePattern') || '{firstCreator} - {year} - {title}';
  const maxLength = getPref('maxFilenameLength') || 150;

  // Get metadata values
  const values = {
    firstCreator: getFirstCreator(item),
    creators: getAllCreators(item),
    year: item.getField('year') || item.getField('date')?.substring(0, 4) || '',
    title: item.getField('title') || '',
    shortTitle: (item.getField('title') || '').substring(0, 50),
    DOI: item.getField('DOI') || '',
    itemType: item.itemType || '',
    publicationTitle: item.getField('publicationTitle') || ''
  };

  // Replace template variables
  let filename = template;
  for (const [key, value] of Object.entries(values)) {
    filename = filename.replace(new RegExp(`\\{${key}\\}`, 'g'), value || '');
  }

  // Clean up empty separators (e.g., " - - " becomes " - ")
  filename = filename.replace(/\s*-\s*-\s*/g, ' - ');
  filename = filename.replace(/^\s*-\s*/, '');
  filename = filename.replace(/\s*-\s*$/, '');

  // Remove multiple spaces
  filename = filename.replace(/\s+/g, ' ');

  // Sanitize and truncate
  return sanitizeFilename(filename.trim(), maxLength);
}

/**
 * Rename an attachment file based on parent item metadata
 * @param {Zotero.Item} attachment - The attachment item
 * @param {Object} [options={}] - Options
 * @param {string} [options.pattern] - Custom pattern (uses preference if not provided)
 * @returns {Promise<{success: boolean, oldName: string, newName: string, error?: string}>}
 */
export async function renameAttachment(attachment, options = {}) {
  const { pattern = null } = options;

  // Must be an attachment
  if (!attachment.isAttachment()) {
    Zotero.debug('[WatchFolder] renameAttachment: Item is not an attachment');
    return { success: false, oldName: '', newName: '', error: 'Not an attachment' };
  }

  // Get current filename
  const oldName = attachment.attachmentFilename;
  if (!oldName) {
    Zotero.debug('[WatchFolder] renameAttachment: Attachment has no filename');
    return { success: false, oldName: '', newName: '', error: 'No filename' };
  }

  // Get parent item for metadata
  const parentID = attachment.parentID;
  if (!parentID) {
    Zotero.debug('[WatchFolder] Attachment has no parent, skipping rename');
    return { success: false, oldName, newName: '', error: 'No parent item' };
  }

  const parentItem = await Zotero.Items.getAsync(parentID);
  if (!parentItem) {
    Zotero.debug(`[WatchFolder] Parent item ${parentID} not found`);
    return { success: false, oldName, newName: '', error: 'Parent item not found' };
  }

  // Check if parent has meaningful metadata
  if (!hasUsefulMetadata(parentItem)) {
    Zotero.debug(`[WatchFolder] Parent item ${parentID} lacks metadata, skipping rename`);
    return { success: false, oldName, newName: '', error: 'No metadata available' };
  }

  // Build new filename
  const extension = oldName.includes('.') ? oldName.split('.').pop() : 'pdf';
  const baseName = buildFilename(parentItem, pattern);
  const newName = `${baseName}.${extension}`;

  // Skip if name unchanged
  if (oldName === newName) {
    Zotero.debug(`[WatchFolder] Filename unchanged: "${oldName}"`);
    return { success: true, oldName, newName, error: 'Name unchanged' };
  }

  try {
    // Use Zotero's built-in rename method
    await attachment.renameAttachmentFile(newName);

    Zotero.debug(`[WatchFolder] Renamed: "${oldName}" → "${newName}"`);
    return { success: true, oldName, newName };
  } catch (error) {
    Zotero.logError(`[WatchFolder] Rename failed: ${error.message}`);
    return { success: false, oldName, newName, error: error.message };
  }
}

/**
 * Rename multiple attachments
 * @param {Zotero.Item[]} attachments - Array of attachment items
 * @param {Object} [options={}] - Options
 * @param {Function} [options.onProgress] - Progress callback (current, total)
 * @param {string} [options.pattern] - Custom rename pattern
 * @returns {Promise<{success: number, failed: number, results: Array}>}
 */
export async function renameAttachments(attachments, options = {}) {
  const { onProgress = () => {}, pattern = null } = options;

  Zotero.debug(`[WatchFolder] Starting batch rename of ${attachments.length} attachments`);

  const results = [];
  let successCount = 0;
  let failedCount = 0;

  for (let i = 0; i < attachments.length; i++) {
    const attachment = attachments[i];
    const result = await renameAttachment(attachment, { pattern });

    results.push(result);
    if (result.success) {
      successCount++;
    } else {
      failedCount++;
    }

    onProgress(i + 1, attachments.length);
  }

  Zotero.debug(`[WatchFolder] Batch rename complete: ${successCount} success, ${failedCount} failed`);
  return { success: successCount, failed: failedCount, results };
}

/**
 * Preview what a filename would be (without actually renaming)
 * @param {Zotero.Item} item - The Zotero item to preview filename for
 * @param {string} [pattern=null] - Custom pattern to use
 * @returns {string} The generated filename (without extension)
 */
export function previewFilename(item, pattern = null) {
  return buildFilename(item, pattern);
}

/**
 * Get available template variables and their descriptions
 * @returns {Object} Object mapping variable names to descriptions
 */
export function getTemplateVariables() {
  return {
    firstCreator: 'First author\'s last name',
    creators: 'All authors (comma-separated last names)',
    year: 'Publication year',
    title: 'Full title',
    shortTitle: 'First 50 characters of title',
    DOI: 'DOI value',
    itemType: 'Item type (journalArticle, etc.)',
    publicationTitle: 'Journal/conference name'
  };
}

/**
 * Validate a rename pattern
 * @param {string} pattern - The pattern to validate
 * @returns {{valid: boolean, errors: string[]}} Validation result
 */
export function validatePattern(pattern) {
  const errors = [];
  const validVariables = Object.keys(getTemplateVariables());

  // Find all template variables in the pattern
  const matches = pattern.match(/\{(\w+)\}/g) || [];

  for (const match of matches) {
    const varName = match.slice(1, -1); // Remove { and }
    if (!validVariables.includes(varName)) {
      errors.push(`Unknown variable: {${varName}}`);
    }
  }

  // Check for empty pattern
  if (!pattern.trim()) {
    errors.push('Pattern cannot be empty');
  }

  // Check if pattern has at least one variable
  if (matches.length === 0) {
    errors.push('Pattern must contain at least one template variable');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}
