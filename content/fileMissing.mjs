/**
 * File-missing classifier.
 *
 * When a tracked file is no longer on disk, we need to know WHY before
 * deciding what to do. The cases that look identical to "missing" are
 * actually very different in intent:
 *
 *   - drive-disconnected : the user unplugged a USB / unmounted a share /
 *                          the cloud client logged out. Every tracked file
 *                          looks missing, but none are deleted. The right
 *                          response is to pause sync entirely until the
 *                          drive comes back.
 *   - permission-denied  : the file exists but we can't see it because of
 *                          ACL changes. Pause that record.
 *   - cloud-placeholder  : iCloud / OneDrive / Dropbox evicted the bytes
 *                          to save disk space but left a placeholder. The
 *                          file is there, just not hydrated.
 *   - user-deleted       : the only "real" deletion case.
 *
 * In v2.0 / Mode 1 we never propagate disk deletions to Zotero anyway,
 * but we still want to record the correct STATE on the tracking record
 * so v2.1 / v2.2 can make safe decisions later.
 *
 * @module fileMissing
 */

import { STATE } from './trackingStore.mjs';

/**
 * @typedef {'still-exists'|'user-deleted'|'drive-disconnected'|'permission-denied'|'cloud-placeholder'} MissingClassification
 */

/**
 * String values for each classification. Frozen so consumers can compare
 * by identity without worrying about typos drifting.
 */
export const MISSING_CLASSIFICATION = Object.freeze({
  STILL_EXISTS: 'still-exists',
  USER_DELETED: 'user-deleted',
  DRIVE_DISCONNECTED: 'drive-disconnected',
  PERMISSION_DENIED: 'permission-denied',
  CLOUD_PLACEHOLDER: 'cloud-placeholder',
});

/**
 * The tracking-record STATE that corresponds to each missing classification.
 * Mode 1 reads this to update record.state without touching Zotero.
 */
export const STATE_FOR_CLASSIFICATION = Object.freeze({
  [MISSING_CLASSIFICATION.STILL_EXISTS]: null,                     // no state change
  [MISSING_CLASSIFICATION.USER_DELETED]: STATE.MISSING,
  [MISSING_CLASSIFICATION.DRIVE_DISCONNECTED]: STATE.PAUSED,
  [MISSING_CLASSIFICATION.PERMISSION_DENIED]: STATE.PAUSED,
  [MISSING_CLASSIFICATION.CLOUD_PLACEHOLDER]: STATE.PENDING_HYDRATION,
});

/**
 * Cheap pre-check used at the top of an external-deletion scan: if the
 * watch root itself can't be stat()'d, the whole mount is gone and the
 * scan should pause instead of marking everything as missing.
 *
 * @param {string} watchPath - Absolute path to the configured watch folder.
 * @returns {Promise<boolean>} true if the watch root is reachable.
 */
export async function isWatchRootAvailable(watchPath) {
  if (!watchPath) return false;
  try {
    const info = await IOUtils.stat(watchPath);
    return info?.type === 'directory';
  } catch (_e) {
    return false;
  }
}

/**
 * Classify why a tracked file is no longer on disk. Caller has already
 * confirmed that `IOUtils.exists(filePath)` returned false. We re-check
 * to absorb scan-snapshot races, then probe the parent directory to tell
 * the four real cases apart.
 *
 * @param {string} filePath - Absolute path of the formerly-tracked file.
 * @returns {Promise<MissingClassification>}
 */
export async function classifyMissingFile(filePath) {
  // 1) Race-safe re-check. The scan list can lag by milliseconds; if the
  //    file is back, we're done.
  try {
    if (await IOUtils.exists(filePath)) {
      return MISSING_CLASSIFICATION.STILL_EXISTS;
    }
  } catch (_e) { /* fall through */ }

  // 2) Probe the parent directory. If parent stat throws, the mount /
  //    network share / cloud client has gone away. Tag as drive-disconnected.
  const parentPath = (() => {
    try { return PathUtils.parent(filePath); } catch (_e) { return null; }
  })();
  if (!parentPath) {
    return MISSING_CLASSIFICATION.USER_DELETED;
  }
  let parentInfo;
  try {
    parentInfo = await IOUtils.stat(parentPath);
  } catch (e) {
    // Parent gone = whole subtree unreachable, treat as drive-disconnected.
    return _isPermissionError(e)
      ? MISSING_CLASSIFICATION.PERMISSION_DENIED
      : MISSING_CLASSIFICATION.DRIVE_DISCONNECTED;
  }
  if (parentInfo?.type !== 'directory') {
    // Parent path exists but isn't a directory? Treat as deleted.
    return MISSING_CLASSIFICATION.USER_DELETED;
  }

  // 3) Try listing the parent directory. If listing throws with a
  //    permission error, classify that specifically.
  let entries;
  try {
    entries = await IOUtils.getChildren(parentPath);
  } catch (e) {
    return _isPermissionError(e)
      ? MISSING_CLASSIFICATION.PERMISSION_DENIED
      : MISSING_CLASSIFICATION.DRIVE_DISCONNECTED;
  }

  // 4) If the parent listing shows a cloud-placeholder variant of our
  //    filename (e.g. macOS iCloud appends `.icloud`, Windows OneDrive may
  //    leave the same name), classify as cloud-placeholder.
  let filename;
  try { filename = PathUtils.filename(filePath); } catch (_e) { filename = ''; }
  if (filename && entries) {
    for (const entry of entries) {
      let entryName;
      try { entryName = PathUtils.filename(entry); } catch (_e) { continue; }
      if (!entryName) continue;
      // macOS iCloud places `.<name>.icloud` next to the original.
      if (entryName === `.${filename}.icloud`) {
        return MISSING_CLASSIFICATION.CLOUD_PLACEHOLDER;
      }
      // Windows / OneDrive: a reparse-point stub keeps the original name,
      // so IOUtils.exists returning false on a stub is unusual — but if
      // it does happen, the parent listing will still show the name.
      if (entryName === filename) {
        return MISSING_CLASSIFICATION.CLOUD_PLACEHOLDER;
      }
    }
  }

  // 5) Default: the user (or some external process) deleted the file.
  return MISSING_CLASSIFICATION.USER_DELETED;
}

/**
 * Detect whether an exception object describes a permission error.
 * Cross-platform — different Gecko builds expose this differently.
 *
 * @param {*} e
 * @returns {boolean}
 * @private
 */
function _isPermissionError(e) {
  if (!e) return false;
  const name = String(e.name ?? '');
  const msg = String(e.message ?? '');
  if (name === 'NotAllowedError' || name === 'OperationError') return true;
  if (/permission denied|EACCES|EPERM/i.test(msg)) return true;
  return false;
}
