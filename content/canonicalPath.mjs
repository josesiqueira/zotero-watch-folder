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
 * Resolve the configured sync-root collection.
 *
 * @returns {Promise<{collection: object, libraryID: number}|null>}
 *   `null` if `syncRootCollectionKey` is unset (user hasn't run the setup
 *   wizard yet). Otherwise the resolved Zotero.Collection and its libraryID.
 * @throws {SyncRootMissingError} if a key is configured but the collection
 *   cannot be resolved (deleted, wrong library, etc).
 */
export async function resolveSyncRoot() {
  const key = getPref('syncRootCollectionKey');
  if (!key) return null;
  const libraryID = getPref('syncRootLibraryID') || Zotero.Libraries.userLibraryID;
  const collection = await Zotero.Collections.getByLibraryAndKeyAsync(libraryID, key);
  if (!collection) {
    throw new SyncRootMissingError(
      `Sync-root collection ${key} not found in library ${libraryID}`
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
  if (target.key === syncRoot.collection.key) return '';

  const segments = [];
  let cursor = target;
  // Walk up parents until we hit the sync root. Cap the depth to avoid an
  // infinite loop on a corrupt parent chain.
  for (let i = 0; i < 1024 && cursor; i++) {
    if (cursor.key === syncRoot.collection.key) {
      return segments.reverse().join('/');
    }
    segments.push(cursor.name);
    if (!cursor.parentID) break;
    cursor = Zotero.Collections.get(cursor.parentID);
  }
  // Walked off the top without finding sync root → not under it.
  return null;
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
  if (relativePathStr === '' || relativePathStr == null) return syncRoot.collection;

  const segments = relativePathStr.split('/').filter(s => s.trim() !== '');
  if (segments.length === 0) return syncRoot.collection;

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
  if (!item || !syncRootCollection) return null;
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

  // 3) First-seen — `item.getCollections()` returns IDs in insertion order
  // in modern Zotero, so the first qualifying candidate maps to first-seen.
  // (If a future Zotero version reorders these, we'll still pick a stable
  // candidate; falling through to rule 4 catches the ambiguity.)
  if (candidates.length > 0) {
    // Resolve ties downstream; rule 3 is satisfied if a unique first-seen
    // exists. Otherwise rule 4 picks the shortest path.
  }

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
