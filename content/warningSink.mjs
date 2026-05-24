/**
 * Warning Sink — v2.1 Phase D.
 *
 * Centralized in-memory ring buffer for surfacing mirror-execution warnings
 * (conflict-blocked moves, missing files, IO errors, suppression flips) to
 * the user. Replaces silent `Zotero.debug` calls that get lost in the
 * general log.
 *
 * Contract:
 *   - `report({ category, message, ... })` — record one warning. Notifies
 *     subscribers synchronously.
 *   - `getRecent(n)` — newest `n` warnings, oldest first. Defaults to 20.
 *   - `getTotalCount()` — running total since last `clear()`.
 *   - `getCountsByCategory()` — Map<category, count>.
 *   - `subscribe(fn)` — register listener; returns an unsubscribe fn.
 *   - `clear()` — drop all warnings + counts (e.g. user clicked "dismiss
 *     all" in the prefs UI).
 *
 * The buffer caps at `RING_CAPACITY` (100) — older entries are dropped
 * but counts are preserved.
 *
 * @module warningSink
 */

export const WARNING_CATEGORY = Object.freeze({
  CONFLICT_BLOCKED: 'conflict-blocked',
  MISSING_FILE: 'missing-file',
  IO_ERROR: 'io-error',
  SUPPRESSED: 'suppressed',
  UNKNOWN_TARGET: 'unknown-target',
});

const RING_CAPACITY = 100;

const _ring = [];
const _counts = new Map();
const _listeners = new Set();

/**
 * Record a warning. Synchronously notifies all subscribers. Returns the
 * stored entry so callers can attach an ID for cross-referencing.
 *
 * @param {Object} entry
 * @param {string} entry.category - One of WARNING_CATEGORY.*
 * @param {string} [entry.message] - Short human-readable summary.
 * @param {string} [entry.actionType] - The MirrorAction.type if applicable.
 * @param {string} [entry.attachmentKey]
 * @param {string} [entry.collectionKey]
 * @param {string} [entry.path] - Local relative path if relevant.
 * @param {string} [entry.reason] - Machine-readable reason code from the executor.
 * @returns {Object} The stored entry (with `timestamp` filled in).
 */
export function report(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.category !== 'string') {
    return null;
  }
  const stored = {
    category: entry.category,
    message: typeof entry.message === 'string' ? entry.message : '',
    actionType: entry.actionType ?? null,
    attachmentKey: entry.attachmentKey ?? null,
    collectionKey: entry.collectionKey ?? null,
    path: entry.path ?? null,
    reason: entry.reason ?? null,
    timestamp: Date.now(),
  };
  _ring.push(stored);
  if (_ring.length > RING_CAPACITY) _ring.shift();
  _counts.set(stored.category, (_counts.get(stored.category) || 0) + 1);

  Zotero.debug(`[WatchFolder] WARNING [${stored.category}] ${stored.message || stored.reason || ''}`);

  for (const fn of _listeners) {
    try { fn(stored); }
    catch (e) { Zotero.logError(`[WatchFolder] warningSink listener: ${e?.message ?? e}`); }
  }
  return stored;
}

/**
 * Get the newest `n` warnings (oldest first). Returns at most
 * RING_CAPACITY entries.
 * @param {number} [n=20]
 * @returns {Array}
 */
export function getRecent(n = 20) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return [];
  const slice = _ring.slice(-Math.min(n, RING_CAPACITY));
  return slice;
}

/** Running total across all categories since last `clear()`. */
export function getTotalCount() {
  let sum = 0;
  for (const v of _counts.values()) sum += v;
  return sum;
}

/** @returns {Map<string, number>} */
export function getCountsByCategory() {
  return new Map(_counts);
}

/**
 * Subscribe to new warnings. Returns an unsubscribe function. Listeners
 * are called synchronously from `report()`.
 * @param {(entry: Object) => void} fn
 * @returns {() => void}
 */
export function subscribe(fn) {
  if (typeof fn !== 'function') return () => {};
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/** Drop all stored warnings + counts. Listeners get a synthetic `cleared` entry. */
export function clear() {
  _ring.length = 0;
  _counts.clear();
  for (const fn of _listeners) {
    try { fn({ cleared: true, timestamp: Date.now() }); }
    catch (_e) { /* swallow */ }
  }
}

/** Test seam — also called from clear(). */
export function _resetForTesting() {
  _ring.length = 0;
  _counts.clear();
  _listeners.clear();
}
