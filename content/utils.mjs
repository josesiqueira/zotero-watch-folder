/**
 * Shared utilities for the Watch Folder plugin
 * @module utils
 */

// Preference helper constants
export const PREF_PREFIX = 'extensions.zotero.watchFolder.';

/**
 * Chunk size used by getFileHash. Exposed as a named export so the duplicate
 * detector (and any future caller) can import the same constant rather than
 * duplicating the literal. Divergence would silently break dedup for files
 * larger than the chunk.
 */
/**
 * Hash strategy version. v1 hashed only the first 1 MB (cheap but bit
 * by PDFs differing only past the 1 MB boundary). v2 hashes the entire
 * file — definitive correctness at the cost of one full read per
 * computed hash. Bump this if the strategy ever changes again so old
 * stamps can be recognised by version.
 */
export const HASH_VERSION = 2;

/**
 * @deprecated v1 chunk cap. Kept exported only so existing imports
 * don't fail at module load. v2 reads the whole file — see HASH_VERSION.
 */
export const HASH_CHUNK_SIZE = 1024 * 1024;

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
    const dotIndex = sanitized.lastIndexOf('.');
    if (dotIndex > 0) {
      const ext = sanitized.substring(dotIndex); // includes the dot
      const nameLength = maxLength - ext.length;
      if (nameLength > 0) {
        sanitized = sanitized.substring(0, nameLength) + ext;
      } else {
        // Extension alone exceeds maxLength — truncate the whole thing
        sanitized = sanitized.substring(0, maxLength);
      }
    } else {
      // No extension — just truncate
      sanitized = sanitized.substring(0, maxLength);
    }
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
  try {
    // Full-file SHA-256 (v2 strategy — was first-1MB-only in v1; the
    // truncated hash collided on PDFs that differed only past the 1 MB
    // boundary). For very large files this can read tens of MB per
    // call; callers that hash in tight loops (e.g. baseline.B.7 disk
    // index) should rate-limit accordingly.
    const data = await IOUtils.read(filePath);
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
 * Compute the path of an absolute path relative to a root.
 * Returns a forward-slash joined string with no leading slash.
 * Returns "" when the two paths are equal (root itself).
 * Returns null when absolutePath is not under root.
 *
 * @param {string} absolutePath
 * @param {string} root
 * @returns {string|null}
 */
export function relativePath(absolutePath, root) {
  if (typeof absolutePath !== 'string' || typeof root !== 'string') return null;
  // Normalize backslashes (Windows) to forward slashes; strip trailing slash on root.
  const norm = (s) => s.replace(/\\/g, '/');
  const a = norm(absolutePath);
  let r = norm(root);
  if (r.endsWith('/')) r = r.slice(0, -1);
  if (a === r) return '';
  const prefix = r + '/';
  if (!a.startsWith(prefix)) return null;
  return a.slice(prefix.length);
}
