/**
 * Canonical path + sync-root scoping helpers.
 *
 * The v2 architecture mounts the local watch folder under a *selected Zotero
 * collection* (the "sync root"), not the library root. This module owns:
 *
 *   - resolving the configured sync-root collection,
 *   - mapping between collection keys and local relative paths under that root,
 *   - resolving or creating a chain of subcollections under that root,
 *   - filtering out Zotero virtual collections (Duplicates, Unfiled, Trash,
 *     My Publications, Saved Searches) per spec Rule 4,
 *   - picking the canonical collection for an item that belongs to multiple
 *     collections under the sync root, per spec §"Canonical path selection
 *     order".
 *
 * Replaces the library-root-scoped helpers `getOrCreateTargetCollection` and
 * `getOrCreateCollectionPath` that used to live in `utils.mjs`.
 *
 * @module canonicalPath
 */

import { getPref } from './utils.mjs';

/**
 * Thrown when the sync root preference points at a collection that no longer
 * exists. Per the X3 cross-phase decision, callers must surface this rather
 * than silently no-op (the old `collectionSync.mjs` did the latter and that's
 * how it silently broke in production).
 */
export class SyncRootMissingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SyncRootMissingError';
  }
}

/**
 * Thrown in `scopeMode === 'library'` when the configured library can't be
 * resolved (e.g. a stale group-library id). The library-mode analogue of
 * {@link SyncRootMissingError} — callers already catch SyncRootMissingError
 * and pause cleanly; this extends it so the existing catch sites cover both
 * without rewiring every consumer.
 */
export class LibraryUnavailableError extends SyncRootMissingError {
  constructor(message) {
    super(message);
    this.name = 'LibraryUnavailableError';
  }
}

/**
 * Sentinel returned by `relativePathToCollection('')` / `chooseCanonicalCollection`
 * in `scopeMode === 'library'` to mean "the library root / Unfiled Items" — an
 * item in NO collection, mirrored to the watch-folder root. Distinct from
 * `null` (which means "skip / resolution failed"): a UNFILED result is a VALID,
 * actionable target (import with no collection), whereas `null` is a non-result.
 * A frozen unique object so callers compare by identity (`=== UNFILED`).
 *
 * @type {{readonly isUnfiled: true}}
 */
export const UNFILED = Object.freeze({ isUnfiled: true });

/**
 * The scope model. `'collection'` = the legacy single-sync-root model (one
 * chosen collection anchors everything). `'library'` = the whole-library
 * mirror (root → Unfiled, every top-level collection → a top-level folder).
 *
 * During the 2.7.0 build the default stays `'collection'` so the existing
 * suite + installs are unchanged while library mode is built alongside; the
 * default flips to `'library'` (and the collection path is removed) once the
 * whole-library feature is complete and verified (task #53).
 *
 * @returns {'library'|'collection'}
 */
export function getScopeMode() {
  return getPref('scopeMode') === 'library' ? 'library' : 'collection';
}

/**
 * Path-traversal defense (security finding 2026-05-27 audit, MEDIUM).
 *
 * Collection names come from Zotero, which lets the user rename a collection
 * to literally anything — including `..`, `.`, `/etc`, `..\windows`, or names
 * containing NUL. When the plugin composes a relative path by walking parent
 * pointers and joining segments with `/`, an unsanitized name can escape the
 * watch root once the relative path is resolved against `sourcePath` via
 * `PathUtils.join` (which doesn't itself reject `..`).
 *
 * A segment is considered unsafe when ANY of:
 *   - it isn't a string,
 *   - it is empty (after trim),
 *   - it equals `.` or `..` (after trim),
 *   - it contains `/` or `\` (would split into multiple segments downstream),
 *   - it contains a NUL byte.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isUnsafeCollectionNameSegment(name) {
  if (typeof name !== 'string') return true;
  const trimmed = name.trim();
  if (trimmed === '' || trimmed === '.' || trimmed === '..') return true;
  if (name.indexOf('/') !== -1 || name.indexOf('\\') !== -1) return true;
  if (name.indexOf('\0') !== -1) return true;
  return false;
}

/**
 * Windows reserved device names (case-insensitive, matched against the
 * pre-extension base of a segment). A file/folder named any of these is
 * rejected by the Windows filesystem regardless of extension, so we prefix
 * an underscore to disarm them.
 */
const _WINDOWS_RESERVED_DEVICE_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * Map a single collection-name segment to a filesystem-safe disk segment.
 *
 * This is a SEPARATE LAYER from {@link isUnsafeCollectionNameSegment}: that
 * function is the path-traversal GATE (refuses `..`, `/`, `\`, NUL, empty)
 * and must run FIRST. `sanitizeCollectionNameSegment` only ever runs on a
 * segment already cleared by that gate, and addresses the WIDER set of names
 * that are traversal-safe but still problematic on disk (notably Windows):
 *
 *   - characters illegal on Windows: `< > : " | ? *` and control chars
 *     `\x00-\x1f` → replaced with `_`;
 *   - trailing dots/spaces (silently stripped by Windows) → removed;
 *   - Windows reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9),
 *     matched on the pre-dot base, case-insensitive → prefixed with `_`;
 *   - an empty result (e.g. the name was all dots/spaces) → `_`.
 *
 * The Zotero collection NAME remains canonical; the disk name is a
 * deterministic pure function of it, so {@link relativePathToCollection}
 * (which works in the Zotero-name domain) stays reversible.
 *
 * ACCEPTED LIMITATION (out of scope for this fix): two sibling collections
 * whose names sanitize to the same disk segment (e.g. `Topic?` and `Topic*`
 * both → `Topic_`) will share one folder. This is rare and non-destructive;
 * a collision-suffix scheme is deliberately deferred to keep this surgical.
 *
 * @param {string} name - A segment already cleared by isUnsafeCollectionNameSegment.
 * @returns {string} A non-empty, filesystem-safe segment.
 */
export function sanitizeCollectionNameSegment(name) {
  if (typeof name !== 'string') return '_';
  // Replace Windows-illegal characters and control chars.
  let out = name.replace(/[<>:"|?*\x00-\x1f]/g, '_');
  // Strip trailing dots and spaces (Windows silently drops these).
  out = out.replace(/[. ]+$/, '');
  if (out === '') return '_';
  // Disarm Windows reserved device names, matched on the pre-dot base.
  const dot = out.indexOf('.');
  const base = (dot === -1 ? out : out.slice(0, dot)).toUpperCase();
  if (_WINDOWS_RESERVED_DEVICE_NAMES.has(base)) {
    out = '_' + out;
  }
  return out;
}

/**
 * WP-B / B4: module-level cache for `collectionKeyToRelativePathCached`.
 *
 * Keyed by `${libraryID}:${collectionKey}` → string. Stores positive
 * lookups only — i.e. paths that resolved successfully under the sync
 * root. A miss falls through to the uncached function, which handles
 * `null` returns (collection not under sync root, unsafe segment, etc.)
 * without polluting the cache.
 *
 * Invalidated wholesale via `invalidateCanonicalPathCache()`. The
 * collection-watcher in WP-C will call this on every `collection`-type
 * `modify`/`delete` notifier event, because:
 *   - rename: a collection's name changes → its segment changes →
 *     every descendant's relative path changes.
 *   - move:   a collection's parentID changes → its descendants' paths
 *     change too.
 *   - delete: removed collection's path is no longer valid.
 *
 * Wholesale invalidation is simpler than tracking per-key descendants
 * and the cache is cheap to rebuild on demand.
 */
const _relativePathCache = new Map();

/**
 * Clear the canonical-path memoization cache. Call on any
 * collection-tree mutation (rename / move / delete). WP-B / B4.
 */
export function invalidateCanonicalPathCache() {
  _relativePathCache.clear();
}

/**
 * Resolve the configured sync-root collection.
 *
 * @returns {Promise<{collection: object, libraryID: number}|null>}
 *   `null` if `syncRootCollectionKey` is unset (user hasn't run the setup
 *   wizard yet). Otherwise the resolved Zotero.Collection and its libraryID.
 * @throws {SyncRootMissingError} if a key is configured but the collection
 *   cannot be resolved (deleted, wrong library, etc).
 */
export async function resolveSyncRoot() {
  // ── scopeMode === 'library' — the whole-library anchor (2.7.0) ──
  // Return a library-root descriptor instead of a chosen collection.
  // `collection: null` + `isLibraryRoot: true`; callers branch on the flag
  // rather than dereferencing `syncRoot.collection.key`. No collection lookup;
  // the only input is the library id. A missing library (stale group id)
  // throws LibraryUnavailableError (a SyncRootMissingError subclass) so the
  // existing catch→pause contract still applies.
  if (getScopeMode() === 'library') {
    const libraryID = getPref('syncRootLibraryID') || Zotero.Libraries.userLibraryID;
    try {
      const lib = Zotero.Libraries.get ? Zotero.Libraries.get(libraryID) : true;
      if (!lib) {
        throw new LibraryUnavailableError(`Library ${libraryID} not found — pausing sync.`);
      }
    } catch (e) {
      if (e instanceof LibraryUnavailableError) throw e;
      throw new LibraryUnavailableError(`Library ${libraryID} could not be resolved: ${e?.message ?? e}`);
    }
    return { collection: null, libraryID, isLibraryRoot: true };
  }

  // ── scopeMode === 'collection' — legacy single-sync-root (unchanged) ──
  const key = getPref('syncRootCollectionKey');
  if (!key) return null;
  const libraryID = getPref('syncRootLibraryID') || Zotero.Libraries.userLibraryID;
  const collection = await Zotero.Collections.getByLibraryAndKeyAsync(libraryID, key);
  if (!collection) {
    throw new SyncRootMissingError(
      `Sync-root collection ${key} not found in library ${libraryID}`
    );
  }
  // Trashed-sync-root hardening (2026-05-27 live finding on Zotero 9):
  // a trashed sync-root collection is found by getByLibraryAndKeyAsync but
  // its children's `getCollections()` calls filter it out — so the plugin
  // would silently classify every import as out-of-scope-suppressed.
  // Treat trashed sync-roots as missing: callers (watchFolder._processNewFile,
  // syncCoordinator) already catch SyncRootMissingError and pause cleanly,
  // surfacing a clear log message instead of a silent misclassification.
  // To restore: un-trash the collection in Zotero (Bin → right-click → Restore).
  if (collection.deleted) {
    throw new SyncRootMissingError(
      `Sync-root collection ${key} is in Zotero's trash — pausing sync. `
      + `Restore the collection from Zotero's Bin to resume.`
    );
  }
  return { collection, libraryID };
}

/**
 * Compute the path of a collection relative to the sync root, joined by
 * forward slashes (so it can be reused as a local relative path without
 * platform-specific separators).
 *
 * @param {string} collectionKey
 * @returns {Promise<string|null>}
 *   - `""` if the collection IS the sync root itself.
 *   - `"Methods/Subtopic"` for nested collections under the sync root.
 *   - `null` if the collection isn't under the sync root, or sync root unset.
 */
export async function collectionKeyToRelativePath(collectionKey) {
  const syncRoot = await resolveSyncRoot();
  if (!syncRoot) return null;
  const libraryID = syncRoot.libraryID;
  const target = await Zotero.Collections.getByLibraryAndKeyAsync(libraryID, collectionKey);
  if (!target) return null;

  // ── Library mode: walk up to a TOP-LEVEL collection (no parent = success) ──
  if (syncRoot.isLibraryRoot) {
    if (isSpecialCollection(target)) return null; // special views never become folders
    const segs = [];
    let c = target;
    for (let i = 0; i < 1024 && c; i++) {
      if (isSpecialCollection(c)) return null;
      if (isUnsafeCollectionNameSegment(c.name)) {
        try { Zotero.logError(`[WatchFolder] canonicalPath(library): unsafe segment ${JSON.stringify(c.name)} in chain for ${target.key}`); } catch (_e) { /* */ }
        return null;
      }
      segs.push(c.name);
      if (!c.parentID) return segs.reverse().join('/'); // reached top level → success
      c = Zotero.Collections.get(c.parentID);
    }
    return null; // depth cap / broken chain
  }

  // ── Collection mode (legacy, unchanged) ──
  if (target.key === syncRoot.collection.key) return '';

  const segments = [];
  let cursor = target;
  // Walk up parents until we hit the sync root. Cap the depth to avoid an
  // infinite loop on a corrupt parent chain.
  for (let i = 0; i < 1024 && cursor; i++) {
    if (cursor.key === syncRoot.collection.key) {
      return segments.reverse().join('/');
    }
    // Path-traversal defense: refuse to compose a relative path if any
    // segment in the chain is unsafe. The caller treats `null` as
    // "not under sync root" — same effect as if the collection were
    // outside the sync root entirely. The user must rename the
    // offending collection in Zotero before the plugin will sync it.
    if (isUnsafeCollectionNameSegment(cursor.name)) {
      try {
        Zotero.logError(
          `[WatchFolder] canonicalPath: refusing unsafe collection name segment ${JSON.stringify(cursor.name)} `
          + `in chain for ${target.key}; treating as out-of-scope`
        );
      } catch (_e) { /* logError unavailable in some test contexts */ }
      return null;
    }
    segments.push(cursor.name);
    if (!cursor.parentID) break;
    cursor = Zotero.Collections.get(cursor.parentID);
  }
  // Walked off the top without finding sync root → not under it.
  return null;
}

/**
 * Disk-domain variant of {@link collectionKeyToRelativePath}.
 *
 * Returns the same relative path with every segment run through
 * {@link sanitizeCollectionNameSegment}, so the result is safe to use as an
 * on-disk relative path (and as the stored `localPath`/`relPath` value that
 * `relativePath(abs, root)` must round-trip against the folders actually
 * created on disk). Use this — NOT the raw variant — at every callsite that
 * creates a directory or stores a path derived from a collection name.
 *
 * Passes through the special return values unchanged: `''` (sync root itself)
 * and `null` (not under sync root / sync root unset).
 *
 * @param {string} collectionKey
 * @returns {Promise<string|null>}
 */
export async function collectionKeyToDiskRelativePath(collectionKey) {
  const rel = await collectionKeyToRelativePath(collectionKey);
  if (rel === '' || rel == null) return rel;
  return rel.split('/').map(sanitizeCollectionNameSegment).join('/');
}

/**
 * Memoized variant of {@link collectionKeyToRelativePath} (WP-B / B4).
 *
 * Same contract as the uncached function — returns `""` for the sync
 * root itself, the joined name segments for nested collections, and
 * `null` when the collection isn't under the sync root.
 *
 * Behaviour vs uncached:
 *   - Cache stores POSITIVE results only (`""` or `"Methods/Subtopic"`).
 *     `null` lookups are NOT cached so a re-parented collection picks
 *     up its new (in-scope) path on the next call.
 *   - Cache key is `${libraryID}:${collectionKey}` so two libraries
 *     can hold the same key without collision.
 *   - `SyncRootMissingError` propagates exactly as in the uncached
 *     function — the cache never swallows it.
 *
 * Callers that need to opt out (e.g. tests verifying live walk
 * behaviour) can keep using `collectionKeyToRelativePath` directly.
 *
 * @param {string} collectionKey
 * @param {number} [libraryID] - Optional explicit library; otherwise
 *   resolved via `resolveSyncRoot`.
 * @returns {Promise<string|null>}
 */
export async function collectionKeyToRelativePathCached(collectionKey, libraryID) {
  // If the caller didn't pre-resolve libraryID, fall back to the sync
  // root's library. Doing this lookup once up front means cached hits
  // (the common case) skip an extra resolveSyncRoot call on subsequent
  // requests for the same key.
  let lib = libraryID;
  if (lib == null) {
    const syncRoot = await resolveSyncRoot();
    if (!syncRoot) return null;
    lib = syncRoot.libraryID;
  }
  const cacheKey = `${lib}:${collectionKey}`;
  if (_relativePathCache.has(cacheKey)) {
    return _relativePathCache.get(cacheKey);
  }
  const result = await collectionKeyToRelativePath(collectionKey);
  if (result !== null) {
    _relativePathCache.set(cacheKey, result);
  }
  return result;
}

/**
 * Resolve (and optionally create) a chain of subcollections under the sync
 * root, addressed by a forward-slash-joined relative path.
 *
 * Replaces `utils.mjs:getOrCreateCollectionPath` but is **scoped to the sync
 * root** — segments are walked from sync root downward rather than from
 * library root downward.
 *
 * @param {string} relativePathStr - e.g. "Methods/Subtopic", or "" for the
 *   sync root itself.
 * @param {{createIfMissing?: boolean}} [opts]
 * @returns {Promise<object|null>} The Zotero.Collection, or `null` when the
 *   path doesn't exist and `createIfMissing` is false. The sync root itself
 *   is returned for an empty path.
 * @throws {SyncRootMissingError} via `resolveSyncRoot`.
 */
export async function relativePathToCollection(relativePathStr, { createIfMissing = false } = {}) {
  const syncRoot = await resolveSyncRoot();
  if (!syncRoot) return null;

  // ── Library mode: '' → UNFILED; first segment → a TOP-LEVEL collection ──
  if (syncRoot.isLibraryRoot) {
    if (relativePathStr === '' || relativePathStr == null) return UNFILED;
    const segs = relativePathStr.split('/').filter(s => s.trim() !== '');
    if (segs.length === 0) return UNFILED;
    for (const seg of segs) {
      if (isUnsafeCollectionNameSegment(seg)) {
        try { Zotero.logError(`[WatchFolder] canonicalPath(library): refusing unsafe segment ${JSON.stringify(seg)} in ${JSON.stringify(relativePathStr)}`); } catch (_e) { /* */ }
        return null;
      }
    }
    const libraryID = syncRoot.libraryID;
    let parent = null; // null parent = the library root (top level)
    for (const name of segs) {
      const siblings = (parent === null)
        ? (Zotero.Collections.getByLibrary(libraryID) || []).filter(c => !c.parentID && !isSpecialCollection(c))
        : (Zotero.Collections.getByParent(parent.id, libraryID) || []);
      const found = siblings.find(c => c.name === name);
      if (found) { parent = found; continue; }
      if (!createIfMissing) return null;
      const created = new Zotero.Collection();
      created.libraryID = libraryID;
      created.name = name;
      if (parent) created.parentID = parent.id; // top-level collections get NO parentID
      await created.saveTx();
      Zotero.debug(`[WatchFolder] canonicalPath(library): created ${parent ? 'subcollection' : 'top-level collection'} "${name}"`);
      parent = created;
    }
    return parent;
  }

  // ── Collection mode (legacy, unchanged) ──
  if (relativePathStr === '' || relativePathStr == null) return syncRoot.collection;

  const segments = relativePathStr.split('/').filter(s => s.trim() !== '');
  if (segments.length === 0) return syncRoot.collection;

  // Path-traversal defense: refuse any segment that would escape the
  // sync root on disk. A `..` or `/`-bearing segment here would never
  // round-trip safely through PathUtils.join under the watch root.
  for (const seg of segments) {
    if (isUnsafeCollectionNameSegment(seg)) {
      try {
        Zotero.logError(
          `[WatchFolder] canonicalPath: refusing unsafe relative-path segment `
          + `${JSON.stringify(seg)} in ${JSON.stringify(relativePathStr)}`
        );
      } catch (_e) { /* logError unavailable */ }
      return null;
    }
  }

  const libraryID = syncRoot.libraryID;
  let parent = syncRoot.collection;

  for (const name of segments) {
    const children = Zotero.Collections.getByParent(parent.id, libraryID) || [];
    const found = children.find(c => c.name === name);
    if (found) {
      parent = found;
      continue;
    }
    if (!createIfMissing) return null;
    const created = new Zotero.Collection();
    created.libraryID = libraryID;
    created.name = name;
    created.parentID = parent.id;
    await created.saveTx();
    Zotero.debug(`[WatchFolder] canonicalPath: created subcollection "${name}" under ${parent.name}`);
    parent = created;
  }
  return parent;
}

/**
 * Detect Zotero's virtual collections (Duplicates, Unfiled Items, Trash,
 * My Publications, Saved Searches). These must never be treated as ordinary
 * subcollections per spec Rule 4 lines 187-196.
 *
 * Zotero 7+ exposes `treeViewID` on the collection-tree row but **not** on a
 * `Zotero.Collection` instance — real collections have IDs like `"C123"` and
 * virtual ones like `"D"` (duplicates), `"U"` (unfiled), `"T"` (trash),
 * `"P"` (publications), `"S<id>"` (saved searches). When called with a
 * real Zotero.Collection instance, this should always return false because
 * the virtual collections never appear in `Zotero.Collections.getByLibrary`
 * / `getByParent` results — they're a UI-only concept on the tree.
 *
 * This helper exists as a defensive filter for code paths that build the
 * setup wizard's collection picker (which DOES enumerate tree rows including
 * virtual ones) and for any future code that walks collection-like objects
 * without knowing their origin.
 *
 * @param {object} collection
 * @returns {boolean}
 */
export function isSpecialCollection(collection) {
  if (!collection) return false;
  // treeViewID is the only reliable virtual marker exposed by Zotero 7+;
  // ordinary Zotero.Collection objects don't carry it.
  const tvid = collection.treeViewID;
  if (typeof tvid === 'string') {
    // Library-virtual roots
    if (tvid === 'D' || tvid === 'U' || tvid === 'T' || tvid === 'P') return true;
    // Saved searches: "S<id>"
    if (tvid.startsWith('S')) return true;
  }
  // Some Zotero builds expose explicit boolean markers
  if (collection.isVirtual === true) return true;
  // My Publications library is exposed via `Zotero.Libraries.publicationsLibraryID`;
  // if a collection lives there, treat it as special.
  try {
    const pubLib = Zotero.Libraries?.publicationsLibraryID;
    if (pubLib && collection.libraryID === pubLib) return true;
  } catch (_e) { /* older builds */ }
  return false;
}

/**
 * Choose the canonical collection for an item that belongs to multiple
 * collections under the sync root. Implements the 5-step priority in spec
 * §"Canonical path selection order" lines 256-263:
 *
 *   1. Existing tracked canonical (if still valid + under sync root).
 *   2. User-preferred collection (if configured + item belongs to it).
 *   3. First collection under sync root where the item appeared (best-effort:
 *      Zotero exposes collections in `item.getCollections()` returning IDs;
 *      we treat the first one that qualifies as the first-seen).
 *   4. Shortest path under sync root.
 *   5. Stable alphabetic fallback.
 *
 * Special collections (Rule 4) and collections outside the sync root are
 * skipped at every step.
 *
 * @param {object} item - Zotero.Item.
 * @param {object} syncRootCollection - Zotero.Collection of the sync root.
 * @param {{existingTrackingRecord?: object, userPreferredKey?: string}} [opts]
 * @returns {Promise<object|null>} The chosen Zotero.Collection, or null.
 */
export async function chooseCanonicalCollection(item, syncRootCollection, opts = {}) {
  if (!item) return null;

  // ── Library mode: syncRootCollection is null (the whole library is the root).
  // An item in no qualifying real collection is Unfiled → return the UNFILED
  // sentinel (distinct from null = "skip"). Otherwise the priority rules below
  // run identically, scoped library-wide via collectionKeyToRelativePath. ──
  const libraryMode = getScopeMode() === 'library';
  if (libraryMode) {
    const ids = (typeof item.getCollections === 'function') ? item.getCollections() : [];
    if (!ids || ids.length === 0) return UNFILED;
    const cand = [];
    for (const id of ids) {
      const c = Zotero.Collections.get(id);
      if (!c) continue;
      if (isSpecialCollection(c)) continue;
      const relPath = await collectionKeyToRelativePath(c.key);
      if (relPath === null) continue; // special/unsafe segment in chain
      cand.push({ collection: c, relPath });
    }
    if (cand.length === 0) return UNFILED; // only special/unsafe memberships → loose at root
    return _pickCanonicalAmong(cand, opts);
  }

  if (!syncRootCollection) return null;
  const libraryID = syncRootCollection.libraryID;
  const ids = (typeof item.getCollections === 'function') ? item.getCollections() : [];
  if (!ids || ids.length === 0) return null;

  // Materialize candidate collections and filter to: (a) exists, (b) not
  // special, (c) under sync root.
  const candidates = [];
  for (const id of ids) {
    const c = Zotero.Collections.get(id);
    if (!c) continue;
    if (isSpecialCollection(c)) continue;
    const relPath = await collectionKeyToRelativePath(c.key);
    if (relPath === null) continue; // not under sync root
    candidates.push({ collection: c, relPath });
  }
  if (candidates.length === 0) return null;
  return _pickCanonicalAmong(candidates, opts);
}

/**
 * Apply the canonical-selection priority (steps 1-5) to an already-filtered,
 * non-empty candidate list of `{ collection, relPath }`. Shared by both the
 * library-mode and collection-mode branches of chooseCanonicalCollection.
 *
 * @param {Array<{collection: object, relPath: string}>} candidates
 * @param {{existingTrackingRecord?: object, userPreferredKey?: string}} opts
 * @returns {object} The chosen Zotero.Collection.
 */
function _pickCanonicalAmong(candidates, opts = {}) {
  if (candidates.length === 1) return candidates[0].collection;

  // 1) Existing tracked canonical.
  const existingKey = opts.existingTrackingRecord?.canonicalCollectionKey;
  if (existingKey) {
    const match = candidates.find(x => x.collection.key === existingKey);
    if (match) return match.collection;
  }

  // 2) User-preferred.
  if (opts.userPreferredKey) {
    const match = candidates.find(x => x.collection.key === opts.userPreferredKey);
    if (match) return match.collection;
  }

  // 3) First-seen — `item.getCollections()` returns IDs in insertion order in
  // modern Zotero, so the first qualifying candidate maps to first-seen. Ties
  // fall through to rule 4 (shortest path) below.

  // 4) Shortest path.
  let best = candidates[0];
  let bestLen = best.relPath.split('/').filter(Boolean).length;
  for (let i = 1; i < candidates.length; i++) {
    const len = candidates[i].relPath.split('/').filter(Boolean).length;
    if (len < bestLen) {
      best = candidates[i];
      bestLen = len;
    }
  }
  // Check if shortest is unique.
  const tied = candidates.filter(x =>
    x.relPath.split('/').filter(Boolean).length === bestLen);
  if (tied.length === 1) return best.collection;

  // 5) Alphabetic fallback among ties.
  tied.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return tied[0].collection;
}
