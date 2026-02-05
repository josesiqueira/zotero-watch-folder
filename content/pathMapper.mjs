/**
 * Path Mapper Module for Zotero Watch Folder Plugin
 *
 * Maps Zotero collections to filesystem folder paths and vice versa.
 * Handles path sanitization for cross-platform compatibility (Windows/Mac/Linux).
 */

/**
 * Maps Zotero collections to filesystem folder paths and vice versa
 * Handles path sanitization for cross-platform compatibility
 */
export class PathMapper {
  constructor(mirrorPath, rootCollectionID) {
    this._mirrorPath = mirrorPath;
    this._rootCollectionID = rootCollectionID;

    // Caches for performance
    this._collectionToPath = new Map();  // collectionID -> folderPath
    this._pathToCollection = new Map();  // folderPath -> collectionID
  }

  /**
   * Get the filesystem path for a Zotero collection
   * @param {Zotero.Collection} collection - The collection
   * @param {boolean} forceRecalculate - Bypass cache
   * @returns {string} Full filesystem path
   */
  getPathForCollection(collection, forceRecalculate = false) {
    if (!forceRecalculate && this._collectionToPath.has(collection.id)) {
      return this._collectionToPath.get(collection.id);
    }

    // Build path by traversing up to root
    const pathParts = [];
    let current = collection;

    while (current && current.id !== this._rootCollectionID) {
      pathParts.unshift(this.sanitizeFolderName(current.name));
      current = current.parentID ? Zotero.Collections.get(current.parentID) : null;
    }

    const fullPath = PathUtils.join(this._mirrorPath, ...pathParts);

    // Update caches
    this._collectionToPath.set(collection.id, fullPath);
    this._pathToCollection.set(fullPath, collection.id);

    return fullPath;
  }

  /**
   * Get the collection ID for a filesystem path
   * @param {string} folderPath - The folder path
   * @returns {number|null} Collection ID or null if not found
   */
  getCollectionForPath(folderPath) {
    // Check cache first
    if (this._pathToCollection.has(folderPath)) {
      return this._pathToCollection.get(folderPath);
    }

    // Parse path relative to mirror root
    const relativePath = this._getRelativePath(folderPath);
    if (!relativePath) return null;

    // Walk down the collection tree
    const parts = relativePath.split(/[/\\]/).filter(p => p);
    let currentParentID = this._rootCollectionID;

    for (const part of parts) {
      const children = Zotero.Collections.getByParent(currentParentID);
      const match = children.find(c => this.sanitizeFolderName(c.name) === part);

      if (!match) return null;
      currentParentID = match.id;
    }

    // Cache the result
    this._pathToCollection.set(folderPath, currentParentID);
    return currentParentID;
  }

  /**
   * Sanitize a collection name for use as a folder name
   * @param {string} name - Collection name
   * @returns {string} Sanitized folder name
   */
  sanitizeFolderName(name) {
    if (!name) return '_unnamed';

    return name
      // Remove characters illegal on Windows/Mac/Linux
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      // Remove leading/trailing dots (problematic on Windows)
      .replace(/^\.+/, '_')
      .replace(/\.+$/, '_')
      // Replace multiple spaces/underscores with single
      .replace(/[\s_]+/g, ' ')
      // Trim whitespace
      .trim()
      // Truncate to safe length (255 is max on most filesystems, leave room for path)
      .substring(0, 200)
      // Ensure not empty
      || '_unnamed';
  }

  /**
   * Get path relative to mirror root
   * @param {string} fullPath - Full filesystem path
   * @returns {string|null} Relative path or null if not under mirror root
   */
  _getRelativePath(fullPath) {
    // Normalize paths for comparison
    const normalizedFull = fullPath.replace(/\\/g, '/');
    const normalizedMirror = this._mirrorPath.replace(/\\/g, '/');

    if (!normalizedFull.startsWith(normalizedMirror)) {
      return null;
    }

    return normalizedFull.substring(normalizedMirror.length).replace(/^\/+/, '');
  }

  /**
   * Clear the path caches (call when collections change significantly)
   */
  clearCache() {
    this._collectionToPath.clear();
    this._pathToCollection.clear();
    Zotero.debug('[WatchFolder] PathMapper cache cleared');
  }

  /**
   * Invalidate cache for a specific collection
   * @param {number} collectionID - The collection ID to invalidate
   */
  invalidateCollection(collectionID) {
    const path = this._collectionToPath.get(collectionID);
    if (path) {
      this._collectionToPath.delete(collectionID);
      this._pathToCollection.delete(path);
    }
  }

  /**
   * Update mirror path (if preference changes)
   * @param {string} newPath - New mirror path
   */
  setMirrorPath(newPath) {
    if (this._mirrorPath !== newPath) {
      this._mirrorPath = newPath;
      this.clearCache();
    }
  }

  /**
   * Update root collection (if preference changes)
   * @param {number} newRootID - New root collection ID
   */
  setRootCollection(newRootID) {
    if (this._rootCollectionID !== newRootID) {
      this._rootCollectionID = newRootID;
      this.clearCache();
    }
  }

  /**
   * Build a new filename for an item in a collection folder
   * Ensures uniqueness within the folder
   * @param {string} folderPath - Target folder path
   * @param {string} desiredFilename - Desired filename
   * @returns {Promise<string>} Unique file path
   */
  async getUniqueFilePath(folderPath, desiredFilename) {
    const ext = desiredFilename.split('.').pop();
    const baseName = desiredFilename.slice(0, -(ext.length + 1));

    let targetPath = PathUtils.join(folderPath, desiredFilename);
    let counter = 1;

    while (await IOUtils.exists(targetPath)) {
      const newName = `${baseName} (${counter}).${ext}`;
      targetPath = PathUtils.join(folderPath, newName);
      counter++;

      if (counter > 100) {
        throw new Error('Could not find unique filename');
      }
    }

    return targetPath;
  }

  /**
   * Get stats about the mapper
   * @returns {{mirrorPath: string, rootCollectionID: number, cachedCollections: number, cachedPaths: number}}
   */
  getStats() {
    return {
      mirrorPath: this._mirrorPath,
      rootCollectionID: this._rootCollectionID,
      cachedCollections: this._collectionToPath.size,
      cachedPaths: this._pathToCollection.size
    };
  }
}

// Factory with singleton pattern
let _instance = null;

/**
 * Get the PathMapper instance
 * @param {string} mirrorPath - The mirror folder path
 * @param {number} rootCollectionID - The root collection ID
 * @returns {PathMapper}
 */
export function getPathMapper(mirrorPath, rootCollectionID) {
  if (!_instance && mirrorPath && rootCollectionID) {
    _instance = new PathMapper(mirrorPath, rootCollectionID);
  } else if (_instance && mirrorPath && rootCollectionID) {
    // Update if config changed
    _instance.setMirrorPath(mirrorPath);
    _instance.setRootCollection(rootCollectionID);
  }
  return _instance;
}

/**
 * Reset the PathMapper instance (for cleanup/testing)
 */
export function resetPathMapper() {
  _instance = null;
}
