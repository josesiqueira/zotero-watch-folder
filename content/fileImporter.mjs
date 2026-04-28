/**
 * File Importer Module for Zotero Watch Folder Plugin
 *
 * Handles importing files into Zotero as attachments with support for
 * stored (copied) and linked import modes.
 */

import { getPref, getOrCreateTargetCollection, getOrCreateCollectionPath } from './utils.mjs';

/**
 * Import a file into Zotero
 * @param {string} filePath - Full path to the file
 * @param {Object} options - Import options
 * @param {number} [options.libraryID] - Target library (default: user library)
 * @param {string} [options.collectionName] - Target collection name (can be a path)
 * @param {string} [options.importMode] - 'stored' or 'linked'
 * @returns {Promise<Zotero.Item>} - The created attachment item
 */
export async function importFile(filePath, options = {}) {
  const {
    libraryID = Zotero.Libraries.userLibraryID,
    collectionName = getPref('targetCollection') || 'Inbox',
    importMode = getPref('importMode') || 'stored'
  } = options;

  // 1. Verify file exists
  const fileExists = await IOUtils.exists(filePath);
  if (!fileExists) {
    throw new Error(`File does not exist: ${filePath}`);
  }

  const filename = getFilename(filePath);
  Zotero.debug(`[WatchFolder] Importing file: ${filename} (mode: ${importMode})`);

  // 2. Get or create target collection (supporting paths)
  let collection;
  if (collectionName.includes('/')) {
    collection = await getOrCreateCollectionPath(collectionName, libraryID);
  } else {
    collection = await getOrCreateTargetCollection(collectionName, libraryID);
  }
  const collectionID = collection ? collection.id : null;
  const collections = collectionID ? [collectionID] : [];

  // 3. Import based on mode
  let item;

  try {
    if (importMode === 'linked') {
      // Import as linked file (file stays in original location)
      item = await Zotero.Attachments.linkFromFile({
        file: filePath,
        collections: collections
      });
      Zotero.debug(`[WatchFolder] Created linked attachment for: ${filename}`);
    } else {
      // Default: Import as stored copy (file copied to Zotero storage)
      item = await Zotero.Attachments.importFromFile({
        file: filePath,
        libraryID: libraryID,
        collections: collections
      });
      Zotero.debug(`[WatchFolder] Created stored attachment for: ${filename}`);
    }
  } catch (importError) {
    Zotero.logError(`[WatchFolder] Import error for ${filename}: ${importError.message}`);
    throw new Error(`Failed to import file: ${importError.message}`);
  }

  // 4. Verify item was created
  if (!item) {
    throw new Error(`Import returned no item for: ${filename}`);
  }

  // 5. Return the created item
  return item;
}

/**
 * Handle post-import action (leave, delete, or move file)
 * @param {string} filePath - Original file path
 * @param {string} action - 'leave', 'delete', or 'move'
 */
export async function handlePostImportAction(filePath, action = null) {
  const actionToTake = action || getPref('postImportAction') || 'leave';
  const filename = getFilename(filePath);

  switch (actionToTake) {
    case 'leave':
      // Do nothing - file stays in place
      Zotero.debug(`[WatchFolder] Leaving file in place: ${filename}`);
      break;

    case 'delete':
      // Delete the source file
      try {
        await IOUtils.remove(filePath);
        Zotero.debug(`[WatchFolder] Deleted source file: ${filename}`);
      } catch (error) {
        Zotero.logError(`[WatchFolder] Failed to delete file ${filename}: ${error.message}`);
        throw error;
      }
      break;

    case 'move':
      // Move to 'imported' subfolder
      try {
        const parentDir = PathUtils.parent(filePath);
        const importedDir = PathUtils.join(parentDir, 'imported');

        // Create subfolder if not exists
        const dirExists = await IOUtils.exists(importedDir);
        if (!dirExists) {
          await IOUtils.makeDirectory(importedDir, { createAncestors: true });
          Zotero.debug(`[WatchFolder] Created 'imported' subfolder: ${importedDir}`);
        }

        // Move the file
        const destPath = PathUtils.join(importedDir, filename);
        await IOUtils.move(filePath, destPath);
        Zotero.debug(`[WatchFolder] Moved file to: ${destPath}`);
      } catch (error) {
        Zotero.logError(`[WatchFolder] Failed to move file ${filename}: ${error.message}`);
        throw error;
      }
      break;

    default:
      Zotero.debug(`[WatchFolder] Unknown post-import action: ${actionToTake}, leaving file in place`);
  }
}

/**
 * Import multiple files in batch
 * @param {string[]|Array<{path: string, collection: string}>} files - Array of file paths or objects
 * @param {Object} options - Import options
 * @param {Function} [options.onProgress] - Progress callback (current, total)
 * @param {number} [options.delayBetween] - Delay between imports in ms
 * @param {boolean} [options.handlePostImport] - Whether to handle post-import action
 * @returns {Promise<{success: Zotero.Item[], failed: {path: string, error: string}[]}>}
 */
export async function importBatch(files, options = {}) {
  const {
    onProgress = () => {},
    delayBetween = 500,
    handlePostImport = true,
    ...importOptions
  } = options;

  const results = {
    success: [],
    failed: []
  };

  Zotero.debug(`[WatchFolder] Starting batch import of ${files.length} files`);

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const filePath = typeof file === 'string' ? file : file.path;
    const collectionName = typeof file === 'object' ? file.collection : (importOptions.collectionName || getPref('targetCollection') || 'Inbox');
    const filename = getFilename(filePath);

    try {
      // Import the file
      const item = await importFile(filePath, { ...importOptions, collectionName });
      results.success.push(item);

      // Handle post-import action (only for stored imports, not linked)
      if (handlePostImport) {
        const importMode = importOptions.importMode || getPref('importMode') || 'stored';
        // Only handle post-import for stored copies (linked files should stay in place)
        if (importMode === 'stored') {
          try {
            await handlePostImportAction(filePath);
          } catch (postImportError) {
            // Log but don't fail the import if post-import action fails
            Zotero.logError(`[WatchFolder] Post-import action failed for ${filename}: ${postImportError.message}`);
          }
        }
      }

      Zotero.debug(`[WatchFolder] Successfully imported: ${filename} (${i + 1}/${filePaths.length})`);
    } catch (error) {
      results.failed.push({
        path: filePath,
        error: error.message
      });
      Zotero.logError(`[WatchFolder] Import failed for ${filePath}: ${error.message}`);
    }

    // Report progress
    onProgress(i + 1, filePaths.length);

    // Delay between imports to avoid overwhelming Zotero
    if (i < filePaths.length - 1 && delayBetween > 0) {
      await new Promise(r => setTimeout(r, delayBetween));
    }
  }

  Zotero.debug(`[WatchFolder] Batch import complete: ${results.success.length} succeeded, ${results.failed.length} failed`);

  return results;
}

/**
 * Get the filename from a path
 * @param {string} filePath
 * @returns {string}
 */
function getFilename(filePath) {
  return PathUtils.filename(filePath);
}

/**
 * Check if a file type is supported for import
 * @param {string} filePath - Path to the file
 * @returns {boolean} - Whether the file type is supported
 */
export function isSupportedFileType(filePath) {
  const filename = getFilename(filePath);
  const extension = filename.split('.').pop()?.toLowerCase();

  // Common document types supported by Zotero
  const supportedExtensions = [
    'pdf',          // PDF documents
    'epub',         // E-books
    'html', 'htm',  // Web pages
    'txt',          // Plain text
    'rtf',          // Rich text
    'doc', 'docx',  // Word documents
    'odt',          // OpenDocument text
    'ppt', 'pptx',  // PowerPoint
    'xls', 'xlsx',  // Excel
    'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp',  // Images
    'mp3', 'wav', 'ogg',  // Audio
    'mp4', 'webm', 'avi', 'mov',  // Video
    'zip', 'tar', 'gz',  // Archives
    'json', 'xml', 'csv'  // Data files
  ];

  return supportedExtensions.includes(extension);
}

/**
 * Filter an array of file paths to only include supported types
 * @param {string[]} filePaths - Array of file paths
 * @returns {string[]} - Filtered array of supported file paths
 */
export function filterSupportedFiles(filePaths) {
  return filePaths.filter(isSupportedFileType);
}
