/**
 * Bulk-Delete Guard — shared safety predicate + confirmation prompt
 * for any destructive op that may touch many tracked files at once.
 *
 * Used by:
 *   - `mirrorExecutor._deleteFolder` (Mode 3) — recursive folder trash
 *   - `watchFolder._handleZoteroTrash` (Mode 3) — batched disk delete
 *   - `watchFolder._handleExternalDeletions` (Mode 3) — batched Zotero trash
 *
 * The spec (TODO Track C): block + prompt when an op would remove
 * >10 tracked files OR more than 20% of the tracked tree in one
 * batch. Either threshold trips the prompt. Single-file ops never
 * prompt.
 *
 * The confirmer refuses the op when no Zotero window is reachable —
 * silent execution at scale is the failure mode this whole feature
 * exists to prevent.
 *
 * @module bulkGuard
 */

const BULK_FILE_THRESHOLD = 10;
const BULK_PERCENT_THRESHOLD = 0.20;

/**
 * Re-entrancy guard. `Services.prompt.confirmEx` is synchronous in
 * Mozilla but spins a *nested* event loop while displayed — meaning
 * `setTimeout` callbacks and Zotero notifier events can fire while a
 * prompt is up, each potentially triggering another bulk-delete
 * branch from a DIFFERENT call path. Realistic case: `_handleZoteroTrash`
 * receives a notifier 'trash' event while `_handleExternalDeletions`
 * has its modal open, or `mirrorExecutor._deleteFolder` fires for a
 * collection delete in the same window. Without this flag those
 * secondary calls stack additional modal dialogs on top of the first.
 *
 * Scope: protects against multi-path reentry within ONE bundle
 * instance. A plugin reload creates a fresh module + fresh flag, so
 * reload-mid-modal can still stack — but reload is an operator
 * action and out of scope for this guard.
 *
 * Behavior while the flag is set: subsequent `confirmBulkDelete`
 * calls return `false` immediately (treated as user-declined). Each
 * caller already has a safe path for `false` — mark-missing for
 * external deletions, warn-only for Zotero trash, abort for folder
 * delete. The user's eventual answer to the outstanding prompt still
 * drives the original op.
 *
 * Discovered during the 2026-05-27 DEL.3 MCP run (two stacked
 * commonDialog.xhtml windows — though that specific repro was via
 * plugin reload; the in-bundle multi-path case is the primary one
 * this fix prevents).
 */
let _promptInFlight = false;

/**
 * @param {number} affectedCount - files about to be deleted/trashed
 * @param {number} totalTracked - all tracked files in the store
 * @returns {boolean} true if this counts as a "bulk" operation
 */
export function isBulkDelete(affectedCount, totalTracked) {
  if (affectedCount <= 1) return false;
  if (affectedCount > BULK_FILE_THRESHOLD) return true;
  if (totalTracked > 0 && (affectedCount / totalTracked) > BULK_PERCENT_THRESHOLD) return true;
  return false;
}

/**
 * Show a confirmation dialog before running a bulk destructive op.
 * Returns `true` if the user approves, `false` otherwise. Tries
 * `Services.wm` for a parent window; falls back to null (Zotero
 * attaches a default). When `Services.prompt` is unavailable,
 * REFUSES the op — never silently executes.
 *
 * @param {Object} opts
 * @param {string} opts.action - human-readable verb ("move to plugin trash", "trash Zotero attachment", etc.)
 * @param {string} opts.path - context path / collection key shown in the prompt
 * @param {number} opts.affectedCount
 * @param {number} opts.totalTracked
 * @returns {Promise<boolean>}
 */
export async function confirmBulkDelete({ action, path, affectedCount, totalTracked }) {
  if (_promptInFlight) {
    try { Zotero.debug(`[WatchFolder] bulkGuard: declined — another bulk prompt already pending (${action}, ${affectedCount}/${totalTracked}, ${path})`); }
    catch (_e) { /* Zotero may not exist in unit tests; that's fine */ }
    return false;
  }
  let win = null;
  try {
    if (typeof Services !== 'undefined' && Services.wm && typeof Services.wm.getMostRecentWindow === 'function') {
      win = Services.wm.getMostRecentWindow('navigator:browser');
    }
  } catch (_e) { /* fall through with null window */ }
  if (typeof Services === 'undefined' || !Services.prompt || typeof Services.prompt.confirmEx !== 'function') {
    try { Zotero.debug(`[WatchFolder] bulkGuard: refused (no Services.prompt) — ${action} ${affectedCount}/${totalTracked} ${path}`); }
    catch (_e) { /* Zotero may not exist in unit tests; that's fine */ }
    return false;
  }
  const pct = totalTracked > 0 ? Math.round((affectedCount / totalTracked) * 100) : 0;
  const msg =
    `About to ${action} ${affectedCount} tracked file(s)` +
    (totalTracked > 0 ? ` — roughly ${pct}% of ${totalTracked} tracked` : '') +
    (path ? `\nunder "${path}".` : '.') +
    `\n\nThis is a bulk destructive action. Proceed?`;
  const flags = Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING
              + Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_CANCEL
              + Services.prompt.BUTTON_POS_1_DEFAULT; // Cancel is the default
  _promptInFlight = true;
  try {
    const result = Services.prompt.confirmEx(
      win, 'Watch Folder — bulk delete', msg, flags,
      'Proceed', null, null, null, { value: false },
    );
    return result === 0;
  } finally {
    _promptInFlight = false;
  }
}

/**
 * Test seam — reset the re-entrancy flag between cases. Internal.
 */
export function __test_resetPromptInFlight() {
  _promptInFlight = false;
}
