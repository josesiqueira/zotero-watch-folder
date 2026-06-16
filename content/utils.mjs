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
 * Prototype-pollution hygiene (security audit 2026-05-27, LOW).
 *
 * Strip `__proto__`, `constructor`, `prototype` own properties from `obj`
 * (and recursively from nested objects/arrays). Applied at JSON-load
 * boundaries — `trackingStore.load` and `smartRules` rule parsing — so
 * a maliciously-crafted persisted file can't pollute Object.prototype via
 * downstream `Object.assign(rec, source)` operations.
 *
 * Returns the same object reference (mutates in place + returns it) so
 * callers can chain.
 *
 * @template T
 * @param {T} obj
 * @returns {T}
 */
export function sanitizeUntrustedKeys(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    for (const v of obj) sanitizeUntrustedKeys(v);
    return obj;
  }
  // Use Object.prototype.hasOwnProperty via .call to dodge any shadowed
  // `.hasOwnProperty` on the parsed object itself.
  const has = Object.prototype.hasOwnProperty;
  for (const danger of ['__proto__', 'constructor', 'prototype']) {
    if (has.call(obj, danger)) {
      try { delete obj[danger]; } catch (_e) { /* sealed/frozen — fine */ }
    }
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v !== null && typeof v === 'object') sanitizeUntrustedKeys(v);
  }
  return obj;
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

/**
 * Pure config-time guard: decide whether `watchRoot` dangerously overlaps the
 * Zotero data directory (or its `storage/` subdir). A watch root that equals,
 * sits inside, or is a parent of the data dir (or storage subdir) would have
 * the plugin import/move/delete Zotero's own managed files — catastrophic.
 *
 * Containment is decided via `relativePath` (NOT a naive `startsWith`), so a
 * sibling like `.../Zotero-backup` is NOT flagged against `.../Zotero`.
 *
 * Fails OPEN: returns `null` (no block) when `dataDir` is unresolvable or
 * either argument is not a non-empty string, so an unknown data dir never
 * locks a user out of configuring a watch folder.
 *
 * IMPORTANT: a byte-identical copy of this function lives inline in
 * `content/preferences.js` (`browseForFolder`), which cannot import modules.
 * If you change this, change that copy too and keep them byte-identical.
 *
 * @param {string} watchRoot - absolute path the user wants to watch
 * @param {string} dataDir - Zotero data directory (Zotero.DataDirectory.dir)
 * @returns {string|null} a human-readable reason when unsafe, else null
 */
export function isWatchRootUnsafe(watchRoot, dataDir) {
  if (typeof watchRoot !== 'string' || watchRoot.length === 0) return null;
  if (typeof dataDir !== 'string' || dataDir.length === 0) return null;
  const norm = (s) => s.replace(/\\/g, '/').replace(/\/+$/, '');
  const storageDir = norm(dataDir) + '/storage';
  // Watch root equals or sits inside the data dir / storage subdir.
  if (relativePath(watchRoot, dataDir) !== null) {
    return 'The watch folder is inside (or equal to) the Zotero data directory. The plugin would treat Zotero\'s own managed files as imports. Choose a separate folder.';
  }
  if (relativePath(watchRoot, storageDir) !== null) {
    return 'The watch folder is inside (or equal to) the Zotero "storage" directory. The plugin would treat Zotero\'s own attachment files as imports. Choose a separate folder.';
  }
  // Watch root is a PARENT of the data dir / storage subdir.
  if (relativePath(dataDir, watchRoot) !== null) {
    return 'The watch folder contains the Zotero data directory. The plugin could move or delete Zotero\'s own files. Choose a folder that does not contain your Zotero data.';
  }
  if (relativePath(storageDir, watchRoot) !== null) {
    return 'The watch folder contains the Zotero "storage" directory. The plugin could move or delete Zotero\'s own attachment files. Choose a folder that does not contain your Zotero data.';
  }
  return null;
}
