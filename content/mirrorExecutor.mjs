/**
 * Mirror Executor — v2.1 Phase A4 + A5 skeleton.
 *
 * Single bottleneck for every FS + Zotero mutation in Mode 2 / Mode 3.
 * The v1 Phase-2 code spread IO calls across collectionSync.mjs,
 * collectionWatcher.mjs, folderWatcher.mjs, etc., each protected by a
 * global `_isSyncing` flag that could deadlock if any exception escaped
 * before the matching release. v2.1 funnels through this single module
 * so:
 *
 *   1. Cross-FS detection happens in one place
 *   2. Conflict-gate (A5) is consistently applied
 *   3. Per-operation locks replace v1's coarse global flag
 *
 * Conflict gate (A5): before any move/rename/delete that touches a
 * tracked file, verify `getFileHash(record.canonicalLocalPath) ===
 * record.lastSyncedHash`. If the hash drifted (user edited the file
 * locally), refuse the operation, mark state=conflict-blocked, surface
 * a warning via warningSink (Phase D).
 *
 * Not implemented in this v2.1 starter.
 *
 * @module mirrorExecutor
 */

/**
 * Execute a MirrorAction (emitted by collectionWatcher / folderEventDetector
 * / itemMembershipHandler). Skeleton dispatches by `action.type`; bodies
 * are TODO for v2.1.
 *
 * @param {{type: string, payload: any}} action
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function execute(action) {
  // TODO(v2.1): dispatch by action.type, route through:
  //   - canSafelyMove(record)  — hash freshness + lastSyncedHash check
  //   - _validateMoveTarget()  — IOUtils.stat on dest parent + device-id
  //   - cross-FS fallback: copy → verify → remove + rollback on error
  switch (action?.type) {
    case 'createFolder':
    case 'renameFolder':
    case 'deleteFolder':
    case 'moveItem':
    case 'addItemMembership':
    case 'removeItemMembership':
      Zotero.debug(`[WatchFolder] mirrorExecutor: ${action.type} (skeleton — no-op)`);
      return { ok: false, reason: 'not-implemented' };
    default:
      return { ok: false, reason: 'unknown-action' };
  }
}

/**
 * Conflict gate (A5). Checks if a tracked file is safe to move/rename/
 * delete by comparing its current hash with the lastSyncedHash on the
 * tracking record. Returns `{ok: false}` if the file has been modified
 * locally since the last sync.
 *
 * @param {object} record - File tracking record.
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function canSafelyMove(record) {
  // TODO(v2.1):
  //   - IOUtils.exists(record.canonicalLocalPath) → if no, defer to fileMissing classifier
  //   - getFileHash(record.canonicalLocalPath) === record.lastSyncedHash
  //   - On mismatch: return { ok: false, reason: 'hash-drifted' }
  void record;
  return { ok: false, reason: 'not-implemented' };
}
