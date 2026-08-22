/**
 * Zotero Watch Folder - File Scanner Module
 *
 * Handles folder scanning and file detection for the watch folder plugin.
 * Uses IOUtils for all file system operations (Zotero 8 / Firefox 115+).
 */

import { isAllowedFileType, delay, relativePath as _relPath } from './utils.mjs';

/**
 * Directory names the recursive scanner skips entirely. These are reserved
 * for the plugin's own bookkeeping and must never be imported as content:
 *
 *   - 'imported'           : `postImportAction: 'move'` parks copies here
 *                            after import; descending into it would create
 *                            an infinite re-import loop.
 *   - '.zotero-watch-trash': v2.2 (Mode 3) plugin-trash directory. Defined
 *                            now as a forward-compat reservation so v2.0
 *                            installs don't accidentally walk into a
 *                            user-created folder of that name.
 */
export const SKIP_DIRNAMES = Object.freeze(new Set(['imported', '.zotero-watch-trash']));

/**
 * Symlink detection (security finding 2026-05-27 audit, MEDIUM).
 *
 * `IOUtils.stat()` dereferences symlinks — its `type` field reflects the
 * TARGET, so an `inbox/escape -> /etc` symlink looks like a regular dir
 * to the scanner and recursion would walk into `/etc`. nsIFile.isSymlink()
 * is the canonical Mozilla way to detect a symlink without following it.
 *
 * Exposed as `__test_setSymlinkDetector` so unit tests can swap the
 * detection without juggling Components.classes mocks.
 *
 * @param {string} absPath
 * @returns {boolean}
 */
let _isSymlink = function _defaultIsSymlink(absPath) {
  try {
    const file = Components.classes['@mozilla.org/file/local;1']
      .createInstance(Components.interfaces.nsIFile);
    file.initWithPath(absPath);
    return !!file.isSymlink && file.isSymlink();
  } catch (_e) {
    // If we can't tell, err on the side of NOT skipping — false negatives
    // here just mean Zotero continues with the file as if it were normal,
    // which is the pre-fix behavior. False positives (skipping a real
    // file) would be worse for usability.
    return false;
  }
};

/** Test seam: replace the symlink detector. Pass null to restore default. */
export function __test_setSymlinkDetector(fn) {
  if (fn === null || typeof fn === 'undefined') {
    _isSymlink = function _defaultIsSymlink(absPath) {
      try {
        const file = Components.classes['@mozilla.org/file/local;1']
          .createInstance(Components.interfaces.nsIFile);
        file.initWithPath(absPath);
        return !!file.isSymlink && file.isSymlink();
      } catch (_e) { return false; }
    };
    return;
  }
  if (typeof fn !== 'function') throw new TypeError('expected function');
  _isSymlink = fn;
}

/**
 * Scan a folder and return list of files matching allowed types.
 *
 * Return shape (WP-A2): each entry carries `{ path, size, mtime,
 * isSymlink, relativePath }`. `isSymlink` is always `false` because
 * symlinked entries are skipped before they reach the result (kept on
 * the shape so consumers can branch on it without re-querying). The
 * `relativePath` is relative to `folderPath` (forward-slash joined, no
 * leading slash), populated so consumers can avoid recomputing it from
 * `path` and the root.
 *
 * @param {string} folderPath - Path to scan
 * @returns {Promise<Array<{path: string, mtime: number, size: number, isSymlink: boolean, relativePath: string}>>}
 */
export async function scanFolder(folderPath) {
    const files = [];

    if (!folderPath) {
        Zotero.debug('[Watch Folder] scanFolder: No folder path provided');
        return files;
    }

    try {
        // Check if the folder exists first
        const exists = await IOUtils.exists(folderPath);
        if (!exists) {
            Zotero.debug(`[Watch Folder] scanFolder: Folder does not exist: ${folderPath}`);
            return files;
        }

        // Get directory info to verify it's a directory
        const folderInfo = await IOUtils.stat(folderPath);
        if (folderInfo.type !== 'directory') {
            Zotero.debug(`[Watch Folder] scanFolder: Path is not a directory: ${folderPath}`);
            return files;
        }

        // Get all children in the directory
        // IOUtils.getChildren returns an array of full paths
        const children = await IOUtils.getChildren(folderPath);

        for (const childPath of children) {
            try {
                // Security: refuse to follow symlinks. IOUtils.stat dereferences
                // them so the result would look like an ordinary file/dir, and
                // a symlink pointing OUTSIDE the watch root would route the
                // scanner into arbitrary filesystem locations. Done BEFORE
                // stat so we never observe the target's metadata.
                if (_isSymlink(childPath)) {
                    Zotero.debug(`[Watch Folder] scanFolder: skipping symlink ${childPath}`);
                    continue;
                }

                // Single stat per surviving entry — WP-A2 fold.
                const info = await IOUtils.stat(childPath);

                // Skip directories - only process files
                if (info.type === 'directory') {
                    continue;
                }

                // Check if file type is allowed
                if (!isAllowedFileType(childPath)) {
                    continue;
                }

                // Add file info to results (WP-A2 shape: + isSymlink + relativePath).
                files.push({
                    path: childPath,
                    mtime: info.lastModified,
                    size: info.size,
                    isSymlink: false,
                    relativePath: _relPath(childPath, folderPath) ?? '',
                });
            } catch (fileError) {
                // Log but continue scanning other files
                Zotero.debug(`[Watch Folder] scanFolder: Error reading file ${childPath}: ${fileError.message}`);
            }
        }

        Zotero.debug(`[Watch Folder] scanFolder: Found ${files.length} matching files in ${folderPath}`);

    } catch (error) {
        // Handle various error conditions
        if (error.name === 'NotFoundError') {
            Zotero.debug(`[Watch Folder] scanFolder: Folder not found: ${folderPath}`);
        } else if (error.name === 'NotAllowedError') {
            Zotero.debug(`[Watch Folder] scanFolder: Permission denied for folder: ${folderPath}`);
        } else {
            Zotero.debug(`[Watch Folder] scanFolder: Error scanning folder ${folderPath}: ${error.message}`);
        }
    }

    return files;
}

/**
 * Recursively scan a folder and return list of files matching allowed types.
 *
 * Return shape (WP-A2): each entry carries `{ path, size, mtime,
 * isSymlink, relativePath }`. `relativePath` is forward-slash joined,
 * with no leading slash, relative to the *original* top-level
 * `folderPath`. The recursion threads `_rootPath` so deeper levels
 * stay anchored to the watch root, not the current sub-folder.
 *
 * @param {string} folderPath - Path to scan
 * @param {number} [maxDepth=10] - Maximum recursion depth to prevent infinite loops
 * @param {string} [_rootPath=folderPath] - INTERNAL: root anchor for relativePath
 * @returns {Promise<Array<{path: string, mtime: number, size: number, isSymlink: boolean, relativePath: string}>>}
 */
export async function scanFolderRecursive(folderPath, maxDepth = 10, _rootPath = null) {
    const files = [];

    if (!folderPath || maxDepth < 0) {
        return files;
    }

    // First-call default: anchor relativePath at the top-level folder.
    const rootPath = _rootPath ?? folderPath;

    try {
        const exists = await IOUtils.exists(folderPath);
        if (!exists) {
            Zotero.debug(`[Watch Folder] scanFolderRecursive: Folder does not exist: ${folderPath}`);
            return files;
        }

        const folderInfo = await IOUtils.stat(folderPath);
        if (folderInfo.type !== 'directory') {
            Zotero.debug(`[Watch Folder] scanFolderRecursive: Path is not a directory: ${folderPath}`);
            return files;
        }

        const children = await IOUtils.getChildren(folderPath);

        for (const childPath of children) {
            try {
                // Security: refuse to follow symlinks at any depth. Without
                // this check, a symlink anywhere under the watch root could
                // redirect the recursion into arbitrary filesystem locations
                // (e.g. /etc, $HOME, another user's directory) — every file
                // found there would then be imported into the user's Zotero
                // library. See audit 2026-05-27.
                if (_isSymlink(childPath)) {
                    Zotero.debug(`[Watch Folder] scanFolderRecursive: skipping symlink ${childPath}`);
                    continue;
                }

                // Single stat per surviving entry — WP-A2 fold.
                const info = await IOUtils.stat(childPath);

                if (info.type === 'directory') {
                    const dirName = PathUtils.filename(childPath);
                    if (SKIP_DIRNAMES.has(dirName)) {
                        Zotero.debug(`[Watch Folder] scanFolderRecursive: Skipping reserved folder '${dirName}': ${childPath}`);
                        continue;
                    }
                    // Recursively scan subdirectories — thread rootPath so
                    // deeper levels still produce relativePaths anchored at
                    // the original top-level folder.
                    const subFiles = await scanFolderRecursive(childPath, maxDepth - 1, rootPath);
                    files.push(...subFiles);
                } else {
                    // Process file
                    if (isAllowedFileType(childPath)) {
                        files.push({
                            path: childPath,
                            mtime: info.lastModified,
                            size: info.size,
                            isSymlink: false,
                            relativePath: _relPath(childPath, rootPath) ?? '',
                        });
                    }
                }
            } catch (fileError) {
                Zotero.debug(`[Watch Folder] scanFolderRecursive: Error reading ${childPath}: ${fileError.message}`);
            }
        }

    } catch (error) {
        Zotero.debug(`[Watch Folder] scanFolderRecursive: Error scanning ${folderPath}: ${error.message}`);
    }

    return files;
}

/**
 * Cached, incremental tree walk (the "Option 1" scan optimization).
 *
 * Produces the SAME complete view as {@link scanFolderRecursive} — every
 * allowed file under `rootPath`, with symlinks and reserved dirs skipped —
 * PLUS the set of every subdirectory (absolute paths, matching
 * `watchFolder._listSubdirectories` semantics), in ONE walk. The win: it
 * skips the expensive `getChildren()` + per-file `stat()` for any directory
 * whose mtime is unchanged since the previous walk.
 *
 * Why mtime is the right signal: a directory's mtime bumps on any DIRECT
 * child add / remove / rename, so every STRUCTURAL change (a new file, a
 * deleted file, a rename) forces that directory to be re-enumerated — which
 * is exactly what import detection AND external-deletion detection rely on.
 * The returned `files` are therefore always the COMPLETE current on-disk set
 * (fresh entries for changed dirs + cached entries for unchanged ones), so
 * deletion detection stays correct. Pure in-place CONTENT edits do NOT bump a
 * dir's mtime and are intentionally not re-observed here: path-based tracking
 * skips already-imported files, and the delete-safety gates re-hash the file
 * DIRECTLY (they never trust scan metadata), so a stale cached size/mtime for
 * an edited-in-place file is harmless.
 *
 * The walk still descends into EVERY directory (one `stat()` per dir to read
 * its mtime), so a change nested below an unchanged parent is still detected —
 * only the per-file work of unchanged dirs is elided.
 *
 * Fail-safe under unreliable filesystems: if a cloud client ever fails to bump
 * a dir mtime on a change, a stale cache entry can only cause an UNDER-report
 * (a new file seen late / a deletion not seen) — never a spurious deletion.
 * Callers MUST still run a periodic FULL SWEEP (clear the cache map, then call
 * again) as the backstop that bounds that latency.
 *
 * The classification of each child (symlink skip, reserved-dir skip, allowed
 * file type, result shape) MUST stay in lock-step with {@link scanFolderRecursive}.
 *
 * @param {string} rootPath - Top-level watch root to walk.
 * @param {Map<string, {mtime: number, files: Array, subdirs: string[]}>|null} [cache]
 *   Per-watch-root cache keyed by absolute directory path. Pass `null` to force
 *   a full, uncached walk (identical output to `scanFolderRecursive` + dirs).
 *   Clearing the map before a call forces a full sweep.
 * @param {number} [maxDepth=10] - Max recursion depth (matches scanFolderRecursive).
 * @returns {Promise<{files: Array<{path: string, mtime: number, size: number, isSymlink: boolean, relativePath: string}>, dirs: string[]}>}
 */
export async function scanTree(rootPath, cache = null, maxDepth = 10) {
    const files = [];
    const dirs = [];
    await _walkTreeCached(rootPath, rootPath, maxDepth, cache, files, dirs);
    return { files, dirs };
}

/**
 * Recursive worker for {@link scanTree}. Accumulates into `filesOut`/`dirsOut`.
 * @private
 */
async function _walkTreeCached(dirPath, rootPath, maxDepth, cache, filesOut, dirsOut) {
    if (!dirPath || maxDepth < 0) return;

    let dirInfo;
    try {
        const exists = await IOUtils.exists(dirPath);
        if (!exists) {
            // Vanished dir: forget any stale snapshot so recovery is a clean walk.
            if (cache) cache.delete(dirPath);
            return;
        }
        dirInfo = await IOUtils.stat(dirPath);
        if (dirInfo.type !== 'directory') {
            if (cache) cache.delete(dirPath);
            return;
        }
    } catch (e) {
        Zotero.debug(`[Watch Folder] scanTree: stat failed for ${dirPath}: ${e && e.message ? e.message : e}`);
        return;
    }

    const cached = cache ? cache.get(dirPath) : null;
    let entryFiles;
    let entrySubdirs;

    if (cached && cached.mtime === dirInfo.lastModified) {
        // Unchanged directory — reuse the last enumeration verbatim. Its direct
        // children (names) cannot have changed since the mtime is identical, so
        // there is nothing new to stat here.
        entryFiles = cached.files;
        entrySubdirs = cached.subdirs;
    } else {
        // New or structurally-changed directory — re-enumerate its children.
        // NOTE: keep this classification in sync with scanFolderRecursive.
        entryFiles = [];
        entrySubdirs = [];
        let children;
        try {
            children = await IOUtils.getChildren(dirPath);
        } catch (e) {
            Zotero.debug(`[Watch Folder] scanTree: getChildren failed for ${dirPath}: ${e && e.message ? e.message : e}`);
            children = [];
        }
        for (const childPath of children) {
            try {
                // Never follow symlinks (see scanFolderRecursive: a symlink could
                // redirect the walk outside the watch root).
                if (_isSymlink(childPath)) {
                    continue;
                }
                const info = await IOUtils.stat(childPath);
                if (info.type === 'directory') {
                    const dirName = PathUtils.filename(childPath);
                    if (SKIP_DIRNAMES.has(dirName)) {
                        continue;
                    }
                    entrySubdirs.push(childPath);
                } else if (isAllowedFileType(childPath)) {
                    entryFiles.push({
                        path: childPath,
                        mtime: info.lastModified,
                        size: info.size,
                        isSymlink: false,
                        relativePath: _relPath(childPath, rootPath) ?? '',
                    });
                }
            } catch (fileError) {
                Zotero.debug(`[Watch Folder] scanTree: Error reading ${childPath}: ${fileError && fileError.message ? fileError.message : fileError}`);
            }
        }
        if (cache) {
            cache.set(dirPath, { mtime: dirInfo.lastModified, files: entryFiles, subdirs: entrySubdirs });
        }
    }

    for (const f of entryFiles) filesOut.push(f);
    for (const sub of entrySubdirs) {
        dirsOut.push(sub);
        await _walkTreeCached(sub, rootPath, maxDepth - 1, cache, filesOut, dirsOut);
    }
}

/**
 * Check if a file is stable (not being written to)
 * Checks size twice with 1 second delay
 * @param {string} filePath - File to check
 * @returns {Promise<boolean>} - True if file is stable
 */
export async function isFileStable(filePath) {
    if (!filePath) {
        return false;
    }

    try {
        // Get initial file stats
        const firstStat = await IOUtils.stat(filePath);

        // File must have size > 0 to be considered
        if (firstStat.size === 0) {
            Zotero.debug(`[Watch Folder] isFileStable: File is empty: ${filePath}`);
            return false;
        }

        // Wait 1 second
        await delay(1000);

        // Get stats again
        const secondStat = await IOUtils.stat(filePath);

        // Compare sizes - if equal and > 0, file is stable
        const isStable = firstStat.size === secondStat.size && secondStat.size > 0;

        if (!isStable) {
            Zotero.debug(`[Watch Folder] isFileStable: File still changing: ${filePath} (${firstStat.size} -> ${secondStat.size})`);
        }

        return isStable;

    } catch (error) {
        // File might have been deleted or moved during check
        Zotero.debug(`[Watch Folder] isFileStable: Error checking file stability for ${filePath}: ${error.message}`);
        return false;
    }
}

/**
 * Check if a file is stable with custom delay and retries
 * @param {string} filePath - File to check
 * @param {number} [delayMs=1000] - Delay between checks in milliseconds
 * @param {number} [maxRetries=3] - Maximum number of retry attempts
 * @returns {Promise<boolean>} - True if file is stable
 */
export async function isFileStableWithRetry(filePath, delayMs = 1000, maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const stable = await isFileStable(filePath);
        if (stable) {
            return true;
        }

        // Wait before retry if not the last attempt
        if (attempt < maxRetries - 1) {
            await delay(delayMs);
        }
    }

    Zotero.debug(`[Watch Folder] isFileStableWithRetry: File not stable after ${maxRetries} attempts: ${filePath}`);
    return false;
}

/**
 * Check if a file exists and is readable
 * @param {string} filePath - File to check
 * @returns {Promise<boolean>}
 */
export async function fileExists(filePath) {
    if (!filePath) {
        return false;
    }

    try {
        const exists = await IOUtils.exists(filePath);
        return exists;
    } catch (error) {
        Zotero.debug(`[Watch Folder] fileExists: Error checking existence for ${filePath}: ${error.message}`);
        return false;
    }
}

/**
 * Get file info (size, mtime)
 * @param {string} filePath - File to check
 * @returns {Promise<{size: number, mtime: number}|null>}
 */
export async function getFileInfo(filePath) {
    if (!filePath) {
        return null;
    }

    try {
        const info = await IOUtils.stat(filePath);

        return {
            size: info.size,
            mtime: info.lastModified
        };
    } catch (error) {
        // File might not exist or be inaccessible
        if (error.name !== 'NotFoundError') {
            Zotero.debug(`[Watch Folder] getFileInfo: Error getting info for ${filePath}: ${error.message}`);
        }
        return null;
    }
}

/**
 * Get detailed file info including type
 * @param {string} filePath - File to check
 * @returns {Promise<{size: number, mtime: number, type: string, path: string}|null>}
 */
export async function getDetailedFileInfo(filePath) {
    if (!filePath) {
        return null;
    }

    try {
        const info = await IOUtils.stat(filePath);

        return {
            path: filePath,
            size: info.size,
            mtime: info.lastModified,
            type: info.type // 'regular' or 'directory'
        };
    } catch (error) {
        if (error.name !== 'NotFoundError') {
            Zotero.debug(`[Watch Folder] getDetailedFileInfo: Error getting info for ${filePath}: ${error.message}`);
        }
        return null;
    }
}

/**
 * Compare two file infos to detect changes
 * @param {{size: number, mtime: number}} oldInfo - Previous file info
 * @param {{size: number, mtime: number}} newInfo - Current file info
 * @returns {boolean} - True if file has changed
 */
export function hasFileChanged(oldInfo, newInfo) {
    if (!oldInfo || !newInfo) {
        return true;
    }

    return oldInfo.size !== newInfo.size || oldInfo.mtime !== newInfo.mtime;
}
