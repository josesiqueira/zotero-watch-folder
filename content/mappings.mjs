/**
 * Multi-mapping registry for the Watch Folder plugin.
 *
 * The v2.9 feature lets the user watch MULTIPLE folders, each mapped to its own
 * Zotero target (a collection or a whole/group library) with its own mode and
 * storage strategy. This module is the SINGLE source of truth for the active
 * set of (folder → target) mappings; every scan/import/mirror/safety path reads
 * its watch root + scope from a `MappingContext` produced here instead of the
 * global `sourcePath`/`scopeMode`/`syncRoot*` prefs.
 *
 * GREEN-PRESERVING GATE: while `watchMappingsMulti` is false (the default), or
 * whenever `watchMappings` is empty/malformed, {@link getActiveMappings} returns
 * EXACTLY ONE context synthesized from the legacy scalar prefs — so the plugin
 * behaves byte-identically to the single-root version. Enabling the feature just
 * swaps that one synthesized context for the N configured ones.
 *
 * This is a LEAF module: it imports only from `utils.mjs`, so any other module
 * may import it without an esbuild import cycle.
 *
 * @module mappings
 */

import { getPref, setPref, relativePath, isWatchRootUnsafe } from './utils.mjs';

/**
 * The mapping id assigned to a migrated single-folder install (see
 * bootstrap.js::_migrateToWatchMappings) AND the default `mappingId` on tracking
 * records written before the feature existed. Keeping them equal means existing
 * `…-tracking-v2.json` records resolve to the migrated mapping with no rewrite.
 * @type {string}
 */
export const LEGACY_MAPPING_ID = 'legacy';

const VALID_SCOPES = new Set(['library', 'collection']);
const VALID_MODES = new Set(['mode1', 'mode2', 'mode3']);
const VALID_STORAGE = new Set(['stored', 'linked_watch_folder', 'stored_plus_mirror']);

/**
 * @typedef {Object} MappingContext
 * @property {string} id                    - stable, minted once, never recycled
 * @property {string} sourcePath            - absolute watch-folder path
 * @property {'library'|'collection'} scopeMode
 * @property {string} syncRootCollectionKey - 8-char key; "" in library scope
 * @property {number} syncRootLibraryID
 * @property {'mode1'|'mode2'|'mode3'} mode
 * @property {'stored'|'linked_watch_folder'|'stored_plus_mirror'} pdfStorageStrategy
 */

/** Test seam: when set, {@link getActiveMappings} returns this verbatim. */
let _testMappings = null;
let _idCounter = 0;

/**
 * Normalize a raw persisted mapping object into a {@link MappingContext},
 * coercing/validating each field. Returns `null` when the entry is unusable
 * (no watch folder) so callers can drop it.
 * @param {any} raw
 * @returns {MappingContext|null}
 */
function _normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const sourcePath = typeof raw.sourcePath === 'string' ? raw.sourcePath : '';
  if (!sourcePath) return null;
  return {
    id: (typeof raw.id === 'string' && raw.id) ? raw.id : LEGACY_MAPPING_ID,
    sourcePath,
    // Mirror canonicalPath.getScopeMode: anything not exactly 'library' is 'collection'.
    scopeMode: raw.scopeMode === 'library' ? 'library' : 'collection',
    syncRootCollectionKey: typeof raw.syncRootCollectionKey === 'string' ? raw.syncRootCollectionKey : '',
    syncRootLibraryID: Number.isInteger(raw.syncRootLibraryID) ? raw.syncRootLibraryID : 1,
    mode: VALID_MODES.has(raw.mode) ? raw.mode : 'mode1',
    pdfStorageStrategy: VALID_STORAGE.has(raw.pdfStorageStrategy) ? raw.pdfStorageStrategy : 'stored',
  };
}

/**
 * Build the single {@link MappingContext} that reproduces today's single-root
 * behavior from the legacy scalar prefs. `scopeMode` mirrors
 * canonicalPath.getScopeMode exactly ('library' iff the pref is 'library').
 * @returns {MappingContext}
 */
export function synthesizeLegacyMapping() {
  return {
    id: LEGACY_MAPPING_ID,
    sourcePath: getPref('sourcePath') || '',
    scopeMode: getPref('scopeMode') === 'library' ? 'library' : 'collection',
    syncRootCollectionKey: getPref('syncRootCollectionKey') || '',
    syncRootLibraryID: getPref('syncRootLibraryID') || 1,
    mode: getPref('mode') || 'mode1',
    pdfStorageStrategy: getPref('pdfStorageStrategy') || 'stored',
  };
}

/**
 * Whether the multi-mapping feature is switched on. While this is true the
 * runtime treats every mapping as import-only (Mode 1) — the mirror/delete
 * (Mode 2/3) paths per mapping are deferred to a later hardening pass, so a
 * multi-folder setup can never propagate a deletion. Single-root installs
 * (gate off) keep full Mode 2/3 behavior.
 * @returns {boolean}
 */
export function isMultiMappingActive() {
  return getPref('watchMappingsMulti') === true;
}

/**
 * The effective GLOBAL sync mode, with the folder-list clamp applied.
 *
 * Sync mode is a single global pref ("same for all folders"). Mode 2 (mirror,
 * no delete) is live; Mode 3 (delete) is deferred to Stage B, so while multi is
 * active a Mode-3 pref is CLAMPED to Mode 2 — the SINGLE SOURCE OF TRUTH that
 * keeps every delete path (mirrorExecutor delete arms, watchFolder trash paths,
 * the coordinator lifecycle) from ever firing a deletion in the folder-list
 * model. Single-root (multi off) returns the configured mode verbatim, so
 * legacy Mode 3 is preserved.
 *
 * @returns {'mode1'|'mode2'|'mode3'}
 */
export function effectiveGlobalMode() {
  const global = getPref('mode') || 'mode1';
  if (isMultiMappingActive()) {
    return global === 'mode1' ? 'mode1' : 'mode2';
  }
  return global;
}

/**
 * The active set of mappings. The ordering is the persisted order.
 *
 * Returns a single synthesized-legacy context when the feature is off OR when
 * `watchMappings` is empty/malformed (fail-safe: never leaves the plugin with
 * zero mappings when a watch folder is configured the old way). Malformed and
 * duplicate-id entries are dropped with a log line.
 *
 * @returns {MappingContext[]}
 */
export function getActiveMappings() {
  if (_testMappings) return _testMappings.map((m) => ({ ...m }));

  if (getPref('watchMappingsMulti') !== true) {
    return [synthesizeLegacyMapping()];
  }

  let arr = null;
  try { arr = JSON.parse(getPref('watchMappings') || '[]'); } catch (_e) { arr = null; }
  if (!Array.isArray(arr)) {
    // Malformed (parse error / not an array) while the gate is on → fail-safe to
    // the legacy scalar rather than watch nothing on corruption.
    return [synthesizeLegacyMapping()];
  }
  if (arr.length === 0) {
    // Intentionally EMPTY (e.g. the user removed every folder) → watch nothing.
    // Must NOT resurrect the legacy single-root scalars: in the unified
    // folder-list model an empty list is a valid "no folders" state, and the
    // stale scalars may point at a since-deleted collection.
    return [];
  }

  const out = [];
  const seenIds = new Set();
  for (const entry of arr) {
    const ctx = _normalize(entry);
    if (!ctx) {
      try { Zotero.logError(`[WatchFolder] mappings: dropping malformed entry ${JSON.stringify(entry)}`); } catch (_e) { /* */ }
      continue;
    }
    if (seenIds.has(ctx.id)) {
      try { Zotero.logError(`[WatchFolder] mappings: dropping duplicate mapping id "${ctx.id}"`); } catch (_e) { /* */ }
      continue;
    }
    seenIds.add(ctx.id);
    out.push(ctx);
  }
  return out.length > 0 ? out : [synthesizeLegacyMapping()];
}

/**
 * Reverse lookup: the active {@link MappingContext} for an id (record → root),
 * or `null`. Falls back to the synthesized legacy mapping for the legacy id so
 * pre-feature tracking records always resolve to a root.
 * @param {string} id
 * @returns {MappingContext|null}
 */
export function getMappingById(id) {
  if (!id) return null;
  const found = getActiveMappings().find((m) => m.id === id);
  if (found) return found;
  if (id === LEGACY_MAPPING_ID) return synthesizeLegacyMapping();
  return null;
}

/**
 * True when two absolute watch-root paths are equal, or one contains the other.
 * Uses the lexical {@link relativePath} containment test (returns '' for equal,
 * a relative string when nested, `null` when unrelated).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function watchRootsOverlap(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  return relativePath(a, b) !== null || relativePath(b, a) !== null;
}

/**
 * Config-time validation for a candidate mapping. Returns a human-readable
 * reason string when the candidate must be REJECTED (the UI shows it and writes
 * nothing), else `null`. Fail-closed: an unresolvable data dir still lets the
 * user configure (isWatchRootUnsafe fails open by design), but any overlap with
 * an existing mapping is a hard reject so every path has exactly one owner.
 *
 * Target (Zotero-side) collisions matter for Mode 2/3 mirroring: two folders
 * that sync the SAME collection, or two whole-library folders on one library,
 * have no deterministic owner. Nested/overlapping targets are ALLOWED — the
 * runtime router picks the nearest-ancestor owner (see mappingRouter.mjs) — so
 * only those two genuine ties are rejected here.
 *
 * @param {{id?: string, sourcePath: string, scopeMode?: string, syncRootCollectionKey?: string, syncRootLibraryID?: number}} candidate
 * @param {Array<{id?: string, sourcePath: string, scopeMode?: string, syncRootCollectionKey?: string, syncRootLibraryID?: number}>} existingMappings
 * @param {string} dataDir - Zotero.DataDirectory.dir
 * @returns {string|null}
 */
export function validateMapping(candidate, existingMappings, dataDir) {
  const path = candidate && candidate.sourcePath;
  if (!path || typeof path !== 'string') return 'A watch folder is required.';
  const unsafe = isWatchRootUnsafe(path, dataDir);
  if (unsafe) return unsafe;

  let userLib;
  try { userLib = (Zotero.Libraries && Zotero.Libraries.userLibraryID) || undefined; }
  catch (_e) { userLib = undefined; }
  const candLib = candidate.syncRootLibraryID || userLib;
  const candScope = candidate.scopeMode === 'library' ? 'library' : 'collection';
  const candKey = candidate.syncRootCollectionKey || '';

  for (const m of (existingMappings || [])) {
    if (!m || typeof m.sourcePath !== 'string') continue;
    if (candidate.id && m.id === candidate.id) continue; // editing the same row

    // Disk-path overlap: watch roots may never be nested/duplicated.
    if (watchRootsOverlap(path, m.sourcePath)) {
      return `This folder overlaps another watch folder ("${m.sourcePath}"). `
        + `Watch folders may not be nested inside one another or duplicated. Choose a separate folder.`;
    }

    // Target-collision (same library only). Nesting is fine; exact ties aren't.
    const mLib = m.syncRootLibraryID || userLib;
    if (mLib !== candLib) continue;
    const mScope = m.scopeMode === 'library' ? 'library' : 'collection';
    if (candScope === 'library' && mScope === 'library') {
      return `Another watch folder already syncs the whole library. `
        + `A library can have only one whole-library watch folder — pick a specific collection instead.`;
    }
    if (candScope === 'collection' && mScope === 'collection'
        && candKey && candKey === (m.syncRootCollectionKey || '')) {
      return `Another watch folder ("${m.sourcePath}") already syncs this collection. `
        + `Two folders can't target the exact same collection — choose a different collection.`;
    }
  }
  return null;
}

/**
 * Mint an 8-hex-char mapping id. Prefers crypto randomness; falls back to a
 * time+counter token when `crypto.getRandomValues` is unavailable (e.g. tests).
 * @returns {string}
 */
export function mintMappingId() {
  try {
    const buf = new Uint8Array(4);
    crypto.getRandomValues(buf);
    return Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch (_e) {
    _idCounter += 1;
    return ('m' + Date.now().toString(36) + _idCounter.toString(36)).slice(0, 8);
  }
}

/**
 * Raw read of the persisted mappings array (for the prefs-pane editor). Returns
 * `[]` on parse failure. Does NOT apply the synthesized-legacy fallback — the UI
 * edits the literal pref.
 * @returns {Array<object>}
 */
export function readMappings() {
  try {
    const a = JSON.parse(getPref('watchMappings') || '[]');
    return Array.isArray(a) ? a : [];
  } catch (_e) {
    return [];
  }
}

/**
 * Persist the mappings array back to the `watchMappings` pref.
 * @param {Array<object>} mappings
 */
export function writeMappings(mappings) {
  setPref('watchMappings', JSON.stringify(Array.isArray(mappings) ? mappings : []));
}

/**
 * Test seam: force {@link getActiveMappings} to return the given contexts
 * (shallow-copied). Pass `null` to restore pref-driven behavior.
 * @param {MappingContext[]|null} arr
 */
export function __test_setActiveMappings(arr) {
  _testMappings = Array.isArray(arr) ? arr.slice() : null;
}
