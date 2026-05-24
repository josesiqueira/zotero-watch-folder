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
 * Pre-check used at the top of an external-deletion scan: returns false
 * if the watch root is missing, not a directory, or unreadable (e.g. the
 * user revoked permissions, or the OS reported the mount as unhealthy).
 *
 * A bare `stat` is insufficient — on POSIX, `chmod 000 dir` still lets
 * `stat` succeed and report `type=directory`, but `getChildren` returns
 * `NS_ERROR_FILE_ACCESS_DENIED`. We treat any failure to ENUMERATE the
 * directory as "unavailable" so the scan pauses sync instead of
 * concluding every tracked file is missing.
 *
 * @param {string} watchPath - Absolute path to the configured watch folder.
 * @returns {Promise<boolean>} true if the watch root can be enumerated.
 */
export async function isWatchRootAvailable(watchPath) {
  if (!watchPath) return false;
  try {
    const info = await IOUtils.stat(watchPath);
    if (info?.type !== 'directory') return false;
  } catch (_e) {
    return false;
  }
  // Stat succeeded — now confirm the directory is actually readable.
  // IOUtils.getChildren throws NS_ERROR_FILE_ACCESS_DENIED on a 000-perm
  // dir, NS_ERROR_FILE_NOT_FOUND on a transient unmount, etc.
  try {
    await IOUtils.getChildren(watchPath);
    return true;
  } catch (_e) {
    return false;
  }
}

/**
 * Classify why a tracked file is no longer on disk. Caller has already
 * confirmed that `IOUtils.exists(filePath)` returned false. We re-check
 * to absorb scan-snapshot races, then probe parent + watch root to tell
 * the four real cases apart.
 *
 * @param {string} filePath - Absolute path of the formerly-tracked file.
 * @param {string} [watchPath] - Configured watch root, used to distinguish
 *   "user renamed/deleted the parent directory" (USER_DELETED — parent
 *   gone but watch root present) from "whole mount went away"
 *   (DRIVE_DISCONNECTED — watch root itself unreachable). If omitted,
 *   we fall back to the older heuristic that treats any parent-stat
 *   failure as drive-disconnected.
 * @returns {Promise<MissingClassification>}
 */
export async function classifyMissingFile(filePath, watchPath = null) {
  // 1) Race-safe re-check. The scan list can lag by milliseconds; if the
  //    file is back, we're done.
  try {
    if (await IOUtils.exists(filePath)) {
      return MISSING_CLASSIFICATION.STILL_EXISTS;
    }
  } catch (_e) { /* fall through */ }

  // 2) Probe the parent directory. If parent stat throws AND the watch
  //    root also can't be stat'd, the mount / network share / cloud
  //    client is gone (drive_disconnected). If watch root is fine but
  //    the file's parent is gone, the user deleted/renamed the parent
  //    directory — classify as user_deleted so move-detection can run.
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
    if (_isPermissionError(e)) return MISSING_CLASSIFICATION.PERMISSION_DENIED;
    // Watch root reachable but this parent isn't → user removed the parent
    // (often a folder rename in flight). Otherwise the drive is gone.
    if (watchPath) {
      const rootOk = await isWatchRootAvailable(watchPath);
      if (rootOk) return MISSING_CLASSIFICATION.USER_DELETED;
    }
    return MISSING_CLASSIFICATION.DRIVE_DISCONNECTED;
  }
  if (parentInfo?.type !== 'directory') {
    // Parent path exists but isn't a directory? Treat as deleted.
    return MISSING_CLASSIFICATION.USER_DELETED;
  }

  // 3) Try listing the parent directory. If listing throws with a
  //    permission error, classify that specifically. Otherwise, if the
  //    watch root is still reachable, treat as user_deleted (transient
  //    listing failures on a healthy mount usually mean the directory
  //    is being mutated, not unreachable).
  let entries;
  try {
    entries = await IOUtils.getChildren(parentPath);
  } catch (e) {
    if (_isPermissionError(e)) return MISSING_CLASSIFICATION.PERMISSION_DENIED;
    if (watchPath) {
      const rootOk = await isWatchRootAvailable(watchPath);
      if (rootOk) return MISSING_CLASSIFICATION.USER_DELETED;
    }
    return MISSING_CLASSIFICATION.DRIVE_DISCONNECTED;
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
