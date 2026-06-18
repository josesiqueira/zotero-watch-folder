/**
 * Watch-root delete-safety guards — v2.7 (whole-library scope).
 *
 * Library scope removes the sync-root collection boundary that used to bound
 * the blast radius of a Mode-3 delete. Two new nets live here, both purely
 * about REFUSING destructive folder-deletion work when the disk state looks
 * untrustworthy or the deletion is suspiciously large:
 *
 *   1. SYNC-1 persisted top-level fingerprint. `isWatchRootAvailable`
 *      (fileMissing.mjs) only stats the root — a mounted-but-placeholdered
 *      cloud root (pCloud/WebDAV) can pass while every top-level folder is
 *      evicted, which under library scope is a whole-library wipe. We persist
 *      the count + an order-independent name hash of top-level dirs on each
 *      healthy scan; before the folder-deletion pass, a >50% collapse vs the
 *      last healthy fingerprint is treated as transient -> pause, don't delete.
 *
 *   2. Cycle-level aggregate cap. `folderEventDetector` emits one
 *      `localFolderDeleted` per missing collection with no aggregate view, so
 *      N small under-threshold deletes evade the per-action bulkGuard. The
 *      aggregate predicate here trips on too many missing collections in a
 *      single cycle (absolute top-level cap, absolute total cap, OR relative
 *      share of all tracked collections), so the whole batch can be gated
 *      above the per-action net.
 *
 * Pure + side-effect-light: fingerprint read/write goes through prefs; the
 * predicates are plain functions so they unit-test without a live Zotero.
 *
 * @module watchRootGuard
 */

import { getPref, setPref } from './utils.mjs';

const FINGERPRINT_PREF = 'watchRootTopLevelFingerprint';

/** Default collapse ratio: pause if current <= 50% of last-healthy top-level count. */
export const COLLAPSE_RATIO = 0.5;
/** Don't arm collapse detection until there were at least this many top-level dirs. */
export const COLLAPSE_FLOOR = 2;
/** Cycle aggregate caps: refuse a cycle deleting more than this many TOP-LEVEL folders... */
export const AGGREGATE_TOPLEVEL_CAP = 3;
/** ...or more than this absolute number of folders total (catches mass nested deletion)... */
export const AGGREGATE_ABSOLUTE_CAP = 25;
/** ...or more than this share of ALL tracked collections (only once past the absolute floor). */
export const AGGREGATE_RELATIVE_CAP = 0.25;

/**
 * Order-independent hash of top-level dir basenames. Sorted names joined by '/'
 * — collision-free because a path separator can never appear inside a single
 * basename — so this distinguishes "same set of folders" from "different set"
 * without storing the names verbatim. '/' is also pref-safe (unlike NUL).
 * @param {string[]} names
 * @returns {string}
 */
function _hashNames(names) {
  return (names || []).slice().sort().join('/');
}

/**
 * Derive the top-level dir basenames from a set/array of absolute dir paths
 * (a dir is top-level iff its parent IS the watch root). The caller already
 * enumerated these for the scan, so we reuse them rather than re-stat.
 * @param {Set<string>|string[]} onDiskAbsDirs
 * @param {string} watchRoot
 * @returns {string[]}
 */
export function topLevelDirNames(onDiskAbsDirs, watchRoot) {
  const set = onDiskAbsDirs instanceof Set ? onDiskAbsDirs : new Set(onDiskAbsDirs || []);
  const names = [];
  for (const d of set) {
    if (typeof d !== 'string') continue;
    let parent = null;
    try { parent = PathUtils.parent(d); } catch (_e) { continue; }
    if (parent !== watchRoot) continue;
    try { names.push(PathUtils.filename(d)); } catch (_e) { /* skip */ }
  }
  return names;
}

/**
 * Read the persisted healthy fingerprint, or null if not bootstrapped / corrupt.
 * @returns {{count: number, namesHash: string}|null}
 */
export function readFingerprint() {
  const raw = getPref(FINGERPRINT_PREF);
  if (!raw || typeof raw !== 'string') return null;
  try {
    const fp = JSON.parse(raw);
    if (fp && typeof fp.count === 'number') return fp;
  } catch (_e) { /* corrupt -> treat as unbootstrapped */ }
  return null;
}

/**
 * Persist the current top-level dir set as the new healthy fingerprint. Called
 * after a scan whose root is available AND not collapsed.
 * @param {string[]} names
 * @returns {{count: number, namesHash: string}}
 */
export function recordHealthyFingerprint(names) {
  const fp = { count: (names || []).length, namesHash: _hashNames(names) };
  try { setPref(FINGERPRINT_PREF, JSON.stringify(fp)); } catch (_e) { /* best effort */ }
  return fp;
}

/**
 * Has the top-level dir set collapsed vs the last healthy fingerprint? A
 * collapse is the cloud-eviction signature: the root is still present (so
 * isWatchRootAvailable passes) but most/all of its top-level folders vanished
 * at once. Bootstraps silently when no fingerprint exists yet.
 *
 * @param {string[]} currentNames - current top-level dir basenames.
 * @param {{ratio?: number, floor?: number}} [opts]
 * @returns {{collapsed: boolean, bootstrap?: boolean, prevCount: number|null, curCount: number, reason?: string}}
 */
export function checkTopLevelCollapse(currentNames, { ratio = COLLAPSE_RATIO, floor = COLLAPSE_FLOOR } = {}) {
  const curCount = (currentNames || []).length;
  const prev = readFingerprint();
  if (!prev) return { collapsed: false, bootstrap: true, prevCount: null, curCount };
  // Not enough history for a collapse to be meaningful (e.g. 1 -> 0 is normal
  // churn). Only arm once a non-trivial number of top-level folders existed.
  if (prev.count < floor) return { collapsed: false, prevCount: prev.count, curCount };
  if (curCount <= prev.count * ratio) {
    return {
      collapsed: true,
      prevCount: prev.count,
      curCount,
      reason: `top-level folder count collapsed ${prev.count} -> ${curCount} (<=${Math.round(ratio * 100)}% of last healthy) - treating as a transient unmount/cloud-eviction, not real deletions`,
    };
  }
  return { collapsed: false, prevCount: prev.count, curCount };
}

/**
 * Aggregate cap for a single scan cycle's folder deletions. Trips when too many
 * tracked collections went missing at once. Sits ABOVE the per-action bulkGuard
 * so N small deletes can't slip through individually.
 *
 * @param {{missingTopLevel: number, missingTotal: number, totalTracked: number}} counts
 * @param {{topLevelCap?: number, absoluteCap?: number, relativeCap?: number}} [opts]
 * @returns {{trip: boolean, reason?: string}}
 */
export function checkCycleAggregate(
  { missingTopLevel, missingTotal, totalTracked },
  { topLevelCap = AGGREGATE_TOPLEVEL_CAP, absoluteCap = AGGREGATE_ABSOLUTE_CAP, relativeCap = AGGREGATE_RELATIVE_CAP } = {},
) {
  if (missingTopLevel > topLevelCap) {
    return { trip: true, reason: `${missingTopLevel} top-level folders missing in one cycle (> ${topLevelCap}) - refusing the whole batch` };
  }
  if (missingTotal > absoluteCap) {
    return { trip: true, reason: `${missingTotal} folders missing in one cycle (> ${absoluteCap}) - refusing the whole batch` };
  }
  // Relative cap only arms past the absolute top-level floor, so deleting a
  // handful of folders in a small library never trips it (e.g. 2 of 2 is not a
  // mass deletion); it's there to catch a large RELATIVE share in a big library.
  if (missingTotal > topLevelCap && totalTracked > 0 && missingTotal > totalTracked * relativeCap) {
    return { trip: true, reason: `${missingTotal} of ${totalTracked} tracked collections missing in one cycle (> ${Math.round(relativeCap * 100)}%) - refusing the whole batch` };
  }
  return { trip: false };
}
