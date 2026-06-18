/**
 * File Importer Module for Zotero Watch Folder Plugin
 *
 * Imports files into Zotero as attachments under a pre-resolved Zotero
 * collection. v2: the caller (usually WatchFolderService._processNewFile)
 * resolves the target collection via `canonicalPath.relativePathToCollection`
 * before invoking the importer; the importer no longer takes a string
 * collection path.
 *
 * @module fileImporter
 */

import { getPref } from './utils.mjs';
import { resolveSyncRoot, relativePathToCollection, UNFILED } from './canonicalPath.mjs';
import { getStorageStrategy, STRATEGY } from './storageStrategy.mjs';

/**
 * Import a file into Zotero.
 *
 * @param {string} filePath - Absolute path to the file on disk.
 * @param {Object} [options]
 * @param {object} [options.collection] - A resolved Zotero.Collection where
 *   the attachment should land. Required for v2 normal operation. If omitted,
 *   falls back to the configured sync root.
 * @param {number} [options.libraryID] - Override the library. Defaults to
 *   the sync root's libraryID, or user library if no sync root configured.
 * @param {string} [options.storageStrategy] - Override the PDF storage
 *   strategy ('stored' | 'linked_watch_folder' | 'stored_plus_mirror').
 *   Defaults to the configured `pdfStorageStrategy` pref.
 * @param {boolean} [options.unfiled] - Library scope only: import the file as
 *   an Unfiled item (no collection membership). Also triggered when
 *   `options.collection` is the UNFILED sentinel (a root drop under the watch
 *   folder in scopeMode 'library').
 * @returns {Promise<Zotero.Item>} The created attachment item.
 */
export async function importFile(filePath, options = {}) {
  const strategy = options.storageStrategy || getStorageStrategy();
  // `linked_watch_folder` links to the file in place; `stored` and
  // `stored_plus_mirror` both copy into Zotero storage (the mirror copy for
  // stored_plus_mirror is the watch-folder file, which we leave on disk).
  const useLinked = strategy === STRATEGY.LINKED_WATCH_FOLDER;

  // 1. Verify file exists
  const fileExists = await IOUtils.exists(filePath);
  if (!fileExists) {
    throw new Error(`File does not exist: ${filePath}`);
  }

  const filename = getFilename(filePath);
  Zotero.debug(`[WatchFolder] Importing file: ${filename} (strategy: ${strategy})`);

  // 2. Resolve target collection. Caller normally passes one; if not, fall
  //    back to the configured sync root so we never silently drop files
  //    into library root (which is dangerous per spec Rule 4).
  //
  //    Library scope (scopeMode 'library'): a root drop has no collection —
  //    `options.unfiled` (or the UNFILED sentinel as `collection`) means import
  //    with NO collection membership, landing the item in Zotero's Unfiled
  //    view. This is intentional here (unlike collection scope, where an empty
  //    collection list would mean library-root) — the whole library is in
  //    scope, so Unfiled is a valid in-scope destination.
  let collection = options.collection;
  let libraryID = options.libraryID;
  const unfiled = options.unfiled === true || collection === UNFILED;
  if (unfiled) {
    collection = null;
    if (libraryID == null) {
      const syncRoot = await resolveSyncRoot().catch(() => null);
      libraryID = syncRoot?.libraryID;
    }
  } else if (!collection) {
    const syncRoot = await resolveSyncRoot();
    if (syncRoot) {
      collection = syncRoot.collection;
      libraryID = libraryID ?? syncRoot.libraryID;
    }
  } else {
    libraryID = libraryID ?? collection.libraryID;
  }
  libraryID = libraryID ?? Zotero.Libraries.userLibraryID;
  const collections = collection ? [collection.id] : [];

  // 3. Import based on strategy
  let item;
  try {
    if (useLinked) {
      item = await Zotero.Attachments.linkFromFile({
        file: filePath,
        collections,
      });
      Zotero.debug(`[WatchFolder] Created linked attachment for: ${filename}`);
    } else {
      item = await Zotero.Attachments.importFromFile({
        file: filePath,
        libraryID,
        collections,
      });
      Zotero.debug(`[WatchFolder] Created stored attachment for: ${filename}`);
    }
  } catch (importError) {
    Zotero.logError(`[WatchFolder] Import error for ${filename}: ${importError.message}`);
    throw new Error(`Failed to import file: ${importError.message}`);
  }

  if (!item) {
    throw new Error(`Import returned no item for: ${filename}`);
  }
  return item;
}

/**
 * Handle the post-import disposition of the source file. Identical to v1
 * semantics — the action ('leave', 'delete', 'move') doesn't change in v2;
 * only the bookkeeping around it (tracking record shape) does.
 *
 * @param {string} filePath - Original source path on disk.
 * @param {string} [action] - 'leave' | 'delete' | 'move'. Reads pref if omitted.
 * @returns {Promise<{action: string, finalPath: string|null}>}
 *   finalPath: where the file lives after the action, or null if deleted.
 */
export async function handlePostImportAction(filePath, action = null) {
  const actionToTake = action || getPref('postImportAction') || 'leave';
  const filename = getFilename(filePath);

  switch (actionToTake) {
    case 'leave':
      Zotero.debug(`[WatchFolder] Leaving file in place: ${filename}`);
      return { action: 'leave', finalPath: filePath };

    case 'delete':
      try {
        await IOUtils.remove(filePath);
        Zotero.debug(`[WatchFolder] Deleted source file: ${filename}`);
        return { action: 'delete', finalPath: null };
      } catch (error) {
        Zotero.logError(`[WatchFolder] Failed to delete file ${filename}: ${error.message}`);
        throw error;
      }

    case 'move': {
      try {
        const watchRoot = getPref('sourcePath');
        let destPath;
        if (watchRoot && filePath.startsWith(watchRoot)) {
          const importedBaseDir = PathUtils.join(watchRoot, 'imported');
          const rel = filePath.substring(watchRoot.length).replace(/^[/\\]/, '');
          destPath = PathUtils.join(importedBaseDir, rel);
        } else {
          // Fallback: 'imported/' folder next to the file.
          destPath = PathUtils.join(PathUtils.parent(filePath), 'imported', filename);
        }
        const destDir = PathUtils.parent(destPath);
        const dirExists = await IOUtils.exists(destDir);
        if (!dirExists) {
          await IOUtils.makeDirectory(destDir, { createAncestors: true });
          Zotero.debug(`[WatchFolder] Created directory: ${destDir}`);
        }
        await IOUtils.move(filePath, destPath);
        Zotero.debug(`[WatchFolder] Moved file to: ${destPath}`);
        return { action: 'move', finalPath: destPath };
      } catch (error) {
        Zotero.logError(`[WatchFolder] Failed to move file ${filename}: ${error.message}`);
        throw error;
      }
    }

    default:
      Zotero.debug(`[WatchFolder] Unknown post-import action: ${actionToTake}, leaving file in place`);
      return { action: 'leave', finalPath: filePath };
  }
}

/**
 * Import multiple files in batch. v2 API: per-file `collection` is either a
 * resolved Zotero.Collection object OR a forward-slash-joined relative path
 * under the sync root (which we resolve on demand). The mixed API exists so
 * the v2 first-run baseline (Phase B5) can pass relative-path strings while
 * Phase B1 callers can pass Collection objects directly.
 *
 * @param {Array<string|{path: string, collection?: object|string}>} files
 * @param {Object} [options]
 * @param {Function} [options.onProgress] - (current, total) callback.
 * @param {number} [options.delayBetween] - Inter-import delay in ms.
 * @param {boolean} [options.handlePostImport] - Whether to invoke
 *   handlePostImportAction on each import.
 * @param {object} [options.collection] - Default Zotero.Collection for files
 *   passed as bare path strings.
 * @returns {Promise<{success: object[], failed: Array<{path:string,error:string}>}>}
 */
export async function importBatch(files, options = {}) {
  const {
    onProgress = () => {},
    delayBetween = 500,
    handlePostImport = true,
    ...importOptions
  } = options;

  const results = { success: [], failed: [] };
  Zotero.debug(`[WatchFolder] Starting batch import of ${files.length} files`);

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const filePath = typeof file === 'string' ? file : file.path;
    const filename = getFilename(filePath);

    // Resolve per-file collection. Accepted forms:
    //   - Zotero.Collection object → use as-is
    //   - string → treat as relative path under sync root, resolve+create
    //   - undefined → fall back to importOptions.collection
    let perFileCollection = (typeof file === 'object' ? file.collection : undefined);
    if (typeof perFileCollection === 'string') {
      perFileCollection = await relativePathToCollection(perFileCollection, { createIfMissing: true });
    }
    const collection = perFileCollection ?? importOptions.collection;

    try {
      const item = await importFile(filePath, { ...importOptions, collection });
      results.success.push(item);

      if (handlePostImport) {
        // Post-import disposition (delete/move the source) is only safe for
        // the pure `stored` strategy. `stored_plus_mirror` must keep the
        // watch-folder copy; `linked_watch_folder` IS the watch-folder file.
        const strategy = importOptions.storageStrategy || getStorageStrategy();
        if (strategy === STRATEGY.STORED) {
          try {
            await handlePostImportAction(filePath);
          } catch (postImportError) {
            Zotero.logError(`[WatchFolder] Post-import action failed for ${filename}: ${postImportError.message}`);
          }
        }
      }
      Zotero.debug(`[WatchFolder] Successfully imported: ${filename} (${i + 1}/${files.length})`);
    } catch (error) {
      results.failed.push({ path: filePath, error: error.message });
      Zotero.logError(`[WatchFolder] Import failed for ${filePath}: ${error.message}`);
    }

    onProgress(i + 1, files.length);
    if (i < files.length - 1 && delayBetween > 0) {
      await new Promise(r => setTimeout(r, delayBetween));
    }
  }

  Zotero.debug(`[WatchFolder] Batch import complete: ${results.success.length} succeeded, ${results.failed.length} failed`);
  return results;
}

function getFilename(filePath) {
  return PathUtils.filename(filePath);
}

/**
 * Check whether a file extension is in Zotero's importable set.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isSupportedFileType(filePath) {
  const filename = getFilename(filePath);
  const extension = filename.split('.').pop()?.toLowerCase();
  const supportedExtensions = [
    'pdf',
    'epub',
    'html', 'htm',
    'txt',
    'rtf',
    'doc', 'docx',
    'odt',
    'ppt', 'pptx',
    'xls', 'xlsx',
    'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp',
    'mp3', 'wav', 'ogg',
    'mp4', 'webm', 'avi', 'mov',
    'zip', 'tar', 'gz',
    'json', 'xml', 'csv',
  ];
  return supportedExtensions.includes(extension);
}

/**
 * Filter to only files Zotero can import.
 * @param {string[]} filePaths
 * @returns {string[]}
 */
export function filterSupportedFiles(filePaths) {
  return filePaths.filter(isSupportedFileType);
}
