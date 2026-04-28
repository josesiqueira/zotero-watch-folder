/**
 * Shared utilities for the Watch Folder plugin
 * @module utils
 */

// Preference helper constants
export const PREF_PREFIX = 'extensions.zotero.watchFolder.';

/**
 * Get a preference value
 * @param {string} key - Preference key (without prefix)
 * @returns {*} The preference value
 */
export function getPref(key) {
  return Zotero.Prefs.get(PREF_PREFIX + key, true);
}

/**
 * Set a preference value
 * @param {string} key - Preference key (without prefix)
 * @param {*} value - Value to set
 */
export function setPref(key, value) {
  Zotero.Prefs.set(PREF_PREFIX + key, value, true);
}

/**
 * Check if file extension matches configured types
 * @param {string} filename - Name of the file to check
 * @returns {boolean} True if file type is allowed
 */
export function isAllowedFileType(filename) {
  const fileTypesPref = getPref('fileTypes');
  // Default to 'pdf' if preference is not set or empty
  const allowedTypes = (fileTypesPref || 'pdf').split(',').map(t => t.trim().toLowerCase()).filter(t => t);
  if (allowedTypes.length === 0) {
    allowedTypes.push('pdf');
  }
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return allowedTypes.includes(ext);
}

/**
 * Sanitize filename for the file system
 * Removes illegal characters and truncates if necessary
 * @param {string} filename - Original filename
 * @param {number} [maxLength=150] - Maximum allowed length
 * @returns {string} Sanitized filename
 */
export function sanitizeFilename(filename, maxLength = 150) {
  // Remove illegal characters for Windows/Mac/Linux
  let sanitized = filename.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  // Replace multiple underscores/spaces with single
  sanitized = sanitized.replace(/[_\s]+/g, ' ').trim();
  // Truncate if too long (preserve extension)
  if (sanitized.length > maxLength) {
    const ext = sanitized.split('.').pop();
    const nameLength = maxLength - ext.length - 1;
    sanitized = sanitized.substring(0, nameLength) + '.' + ext;
  }
  return sanitized;
}

/**
 * Generate a simple hash of first 1MB of file for tracking
 * Uses SHA-256 for reliable duplicate detection
 * @param {string} filePath - Absolute path to the file
 * @returns {Promise<string|null>} Hex hash string or null on error
 */
export async function getFileHash(filePath) {
  // Read first 1MB for hashing (performance)
  const CHUNK_SIZE = 1024 * 1024;
  try {
    const data = await IOUtils.read(filePath, { maxBytes: CHUNK_SIZE });
    // Simple hash using crypto
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (e) {
    Zotero.debug(`[WatchFolder] Hash error: ${e.message}`);
    return null;
  }
}

/**
 * Delay helper (native Promise, NOT Bluebird)
 * @param {number} ms - Milliseconds to delay
 * @returns {Promise<void>} Resolves after delay
 */
export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get or create the target collection
 * @param {string} collectionName - Name of the collection
 * @param {number} [libraryID] - Library ID (defaults to user library)
 * @returns {Promise<Zotero.Collection|null>} The collection object or null if creation fails
 */
export async function getOrCreateTargetCollection(collectionName, libraryID = Zotero.Libraries.userLibraryID) {
  // If no collection name provided, return null (no target collection)
  if (!collectionName || collectionName.trim() === '') {
    return null;
  }

  try {
    // Search for existing collection
    const collections = Zotero.Collections.getByLibrary(libraryID);
    if (collections && collections.length > 0) {
      for (const collection of collections) {
        if (collection.name === collectionName) {
          return collection;
        }
      }
    }

    // Create new collection
    const collection = new Zotero.Collection();
    collection.libraryID = libraryID;
    collection.name = collectionName;
    await collection.saveTx();

    Zotero.debug(`[WatchFolder] Created collection: ${collectionName}`);
    return collection;
  } catch (e) {
    Zotero.logError(`[WatchFolder] Failed to get/create collection "${collectionName}": ${e.message}`);
    return null;
  }
}

/**
 * Get or create a path of nested collections
 * @param {string} path - Slash-separated collection path (e.g. "Inbox/Subfolder")
 * @param {number} [libraryID] - Library ID
 * @returns {Promise<Zotero.Collection|null>} The leaf collection
 */
export async function getOrCreateCollectionPath(path, libraryID = Zotero.Libraries.userLibraryID) {
  Zotero.debug(`[WatchFolder] Attempting to get/create collection path: ${path}`);
  if (!path || path.trim() === '') return null;

  const parts = path.split('/').filter(p => p.trim() !== '');
  let parentID = null;
  let currentCollection = null;

  for (const name of parts) {
    try {
      Zotero.debug(`[WatchFolder] Looking for collection: "${name}" under parent: ${parentID || 'root'}`);
      // Look for existing child collection
      const children = Zotero.Collections.getByParent(parentID, libraryID);
      let found = false;
      for (const col of children) {
        if (col.name === name) {
          Zotero.debug(`[WatchFolder] Found existing collection: "${name}" (ID: ${col.id})`);
          currentCollection = col;
          parentID = col.id;
          found = true;
          break;
        }
      }

      if (!found) {
        Zotero.debug(`[WatchFolder] Collection "${name}" not found, creating it...`);
        // Create new child collection
        const col = new Zotero.Collection();
        col.libraryID = libraryID;
        col.name = name;
        col.parentID = parentID;
        await col.saveTx();
        currentCollection = col;
        parentID = col.id;
        Zotero.debug(`[WatchFolder] Successfully created collection: "${name}" (ID: ${parentID})`);
      }
    } catch (e) {
      Zotero.logError(`[WatchFolder] CRITICAL ERROR in getOrCreateCollectionPath for "${name}": ${e.message}`);
      return null;
    }
  }

  return currentCollection;
}
