/**
 * Zotero Watch Folder - File Scanner Module
 *
 * Handles folder scanning and file detection for the watch folder plugin.
 * Uses IOUtils for all file system operations (Zotero 8 / Firefox 115+).
 */

import { isAllowedFileType, delay } from './utils.mjs';

/**
 * Scan a folder and return list of files matching allowed types
 * @param {string} folderPath - Path to scan
 * @returns {Promise<Array<{path: string, mtime: number, size: number}>>}
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
                // Get file info
                const info = await IOUtils.stat(childPath);

                // Skip directories - only process files
                if (info.type === 'directory') {
                    continue;
                }

                // Check if file type is allowed
                if (!isAllowedFileType(childPath)) {
                    continue;
                }

                // Add file info to results
                files.push({
                    path: childPath,
                    mtime: info.lastModified,
                    size: info.size
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
 * Recursively scan a folder and return list of files matching allowed types
 * @param {string} folderPath - Path to scan
 * @param {number} [maxDepth=10] - Maximum recursion depth to prevent infinite loops
 * @returns {Promise<Array<{path: string, mtime: number, size: number}>>}
 */
export async function scanFolderRecursive(folderPath, maxDepth = 10) {
    const files = [];

    if (!folderPath || maxDepth < 0) {
        return files;
    }

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
                const info = await IOUtils.stat(childPath);

                if (info.type === 'directory') {
                    // Recursively scan subdirectories
                    const subFiles = await scanFolderRecursive(childPath, maxDepth - 1);
                    files.push(...subFiles);
                } else {
                    // Process file
                    if (isAllowedFileType(childPath)) {
                        files.push({
                            path: childPath,
                            mtime: info.lastModified,
                            size: info.size
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
