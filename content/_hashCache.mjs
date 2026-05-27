/**
 * Module-level LRU cache for full-file SHA-256 hashes, keyed by
 * `(absPath, size, mtime)`. The semantics:
 *
 *   - A file whose `(size, mtime)` is unchanged is the SAME content. Any
 *     edit (even one preserving size) advances `mtime`. Pathological tools
 *     like `rsync -t` can preserve mtime on overwrite — see the risk note
 *     in `docs/optimization_plan.md`. Tracked-record correctness is owned
 *     by `lastSyncedHash` on the FileRecord, not by this cache; the cache
 *     only speeds up the *candidate-discovery* path.
 *
 *   - The cache is in-memory only. Cleared on plugin reload.
 *
 *   - LRU eviction by re-insertion order. A `Map` preserves insertion
 *     order; on a cache hit we delete + re-insert to move the entry to
 *     the most-recent end. Capacity defaults to 5,000 entries.
 *
 *   - `hashFile(absPath)` is the high-level entry point: stats the file,
 *     looks up the cache, computes via `getFileHash` on miss, stores and
 *     returns. Callers that already have a stat handy should use
 *     `get(absPath, size, mtime)` + `set(...)` directly to skip the
 *     redundant stat. `hashFile` swallows stat errors and falls back to
 *     a stat-less direct hash call (legacy behavior parity).
 *
 *   - Hash itself is unchanged — full-file SHA-256 via `utils.getFileHash`,
 *     `HASH_VERSION = 2`. The cache speeds I/O, never replaces hash
 *     verification.
 *
 * @module _hashCache
 */

import { getFileHash } from './utils.mjs';

const DEFAULT_CAPACITY = 5000;

// Module-level Map. Insertion order = LRU order (oldest first).
const _cache = new Map();
let _capacity = DEFAULT_CAPACITY;
let _hits = 0;
let _misses = 0;

function _key(absPath, size, mtime) {
  return `${absPath}|${size}|${mtime}`;
}

/**
 * Look up a cached hash by (path, size, mtime). Returns the hex hash on
 * hit (and marks the entry MRU), or `null` on miss.
 *
 * @param {string} absPath
 * @param {number} size
 * @param {number} mtime
 * @returns {string|null}
 */
export function get(absPath, size, mtime) {
  const k = _key(absPath, size, mtime);
  if (!_cache.has(k)) {
    _misses++;
    return null;
  }
  const hash = _cache.get(k);
  // LRU-promote: delete + re-insert moves to most-recent end.
  _cache.delete(k);
  _cache.set(k, hash);
  _hits++;
  return hash;
}

/**
 * Store a hash for (path, size, mtime). If insertion would exceed
 * capacity, evict oldest entries until back at capacity. Overwrites
 * an existing entry for the same key (LRU-promoting it).
 *
 * @param {string} absPath
 * @param {number} size
 * @param {number} mtime
 * @param {string} hash
 */
export function set(absPath, size, mtime, hash) {
  if (!hash || typeof hash !== 'string') return;
  const k = _key(absPath, size, mtime);
  if (_cache.has(k)) _cache.delete(k);
  _cache.set(k, hash);
  // Evict oldest while over capacity.
  while (_cache.size > _capacity) {
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
  }
}

/**
 * Stat + cache-lookup + compute-on-miss in one call. Returns the hex
 * hash, or `null` if the file is unreadable.
 *
 * If `IOUtils.stat` fails (file vanished between scan + hash, permission
 * denied, etc.) falls back to a direct `getFileHash` call without
 * caching — preserves legacy behavior at the cost of one extra read.
 *
 * Callers that already have a stat handy (e.g. baseline's reconcile
 * loop) can pass `statHint = {size, lastModified}` to skip the
 * redundant stat call.
 *
 * @param {string} absPath
 * @param {{size?: number, lastModified?: number}|null} [statHint]
 * @returns {Promise<string|null>}
 */
export async function hashFile(absPath, statHint) {
  if (!absPath) return null;
  let stat = statHint;
  if (!stat) {
    try {
      stat = await IOUtils.stat(absPath);
    } catch (_e) {
      // stat failed — fall through to a stat-less hash call. No cache
      // because we have no key.
      return await getFileHash(absPath);
    }
  }
  if (!stat) return await getFileHash(absPath);
  const size = stat.size ?? 0;
  const mtime = stat.lastModified ?? 0;
  const cached = get(absPath, size, mtime);
  if (cached) return cached;
  const hash = await getFileHash(absPath);
  if (hash) set(absPath, size, mtime, hash);
  return hash;
}

/**
 * Clear the cache. Resets stats counters too. Mainly for tests and
 * plugin shutdown.
 */
export function clear() {
  _cache.clear();
  _hits = 0;
  _misses = 0;
}

/**
 * Snapshot of cache stats. `size` is the current entry count;
 * `capacity` is the eviction threshold. `hits` and `misses` are
 * cumulative since plugin load or last `clear()`.
 *
 * @returns {{size: number, capacity: number, hits: number, misses: number}}
 */
export function stats() {
  return {
    size: _cache.size,
    capacity: _capacity,
    hits: _hits,
    misses: _misses,
  };
}

/**
 * Set the LRU capacity. Truncates immediately if the new cap is
 * smaller than the current size. Used by tests; production code should
 * leave the default in place.
 *
 * @param {number} n
 */
export function __test_setCapacity(n) {
  if (typeof n !== 'number' || n < 1) throw new TypeError('capacity must be a positive number');
  _capacity = n;
  while (_cache.size > _capacity) {
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
  }
}

/** Reset capacity to default. */
export function __test_resetCapacity() {
  _capacity = DEFAULT_CAPACITY;
}
