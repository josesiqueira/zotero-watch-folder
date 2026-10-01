/**
 * Zotero Watch Folder — Owning-mapping router (Mode 2/3 foundation).
 *
 * In the folder-list model there are N watch roots on disk and N target
 * collections in Zotero. The sync MODE is global ("same for all folders"), but
 * every mirror event — a collection renamed, a folder deleted on disk, an item
 * moved between collections — must be attributed to EXACTLY ONE owning mapping
 * so it uses that mapping's watch root and sync-root. This module answers
 * "which mapping owns this collection / item?".
 *
 * Ownership rule: NEAREST SYNC-ROOT ANCESTOR WINS (see docs/mode2-mode3-design.md §5).
 * Deterministic by construction — every collection has at most one closest
 * sync-root above it, and validateMapping rejects the only genuine tie (two
 * mappings on the exact same sync-root / two library-scope mappings on one
 * library), so there is never a runtime coin-flip.
 *
 * Leaf module: depends on mappings (registry) + canonicalPath (isSpecialCollection)
 * only, so it introduces no import cycle.
 */

import { getActiveMappings } from './mappings.mjs';
import { isSpecialCollection } from './canonicalPath.mjs';

/** userLibraryID fallback used to normalize a mapping's (possibly absent) library. */
function _userLibraryID() {
  try {
    return (Zotero.Libraries && Zotero.Libraries.userLibraryID) || 1;
  } catch (_e) {
    return 1;
  }
}

/**
 * Resolve the ONE watch-folder mapping that owns a given Zotero collection.
 *
 * Walks the collection's ancestor chain (itself, then parents via `parentID`).
 * The first collection-scope mapping whose sync-root collection key sits on
 * that chain owns it (deepest / closest ancestor, since we walk upward). If no
 * collection-scope mapping claims it, a library-scope mapping covering the same
 * library owns it as the fallback. Returns `null` when no watch folder covers
 * this collection (or the collection is a virtual view).
 *
 * @param {object} collection - A real Zotero.Collection (not a virtual view).
 * @returns {import('./mappings.mjs').MappingContext|null}
 */
export function mappingForCollection(collection) {
  if (!collection) return null;

  const mappings = getActiveMappings();
  if (!mappings || mappings.length === 0) return null;

  const libraryID = collection.libraryID;
  const userLib = _userLibraryID();

  // Partition the mappings that live in THIS collection's library by scope.
  const collScope = [];
  let libScope = null;
  for (const m of mappings) {
    if (!m) continue;
    const mLib = m.syncRootLibraryID || userLib;
    if (mLib !== libraryID) continue;
    if (m.scopeMode === 'library') {
      // First library-scope mapping for this library is the fallback owner.
      // (validateMapping forbids a second one.)
      if (!libScope) libScope = m;
    } else if (m.syncRootCollectionKey) {
      collScope.push(m);
    }
  }
  if (collScope.length === 0 && !libScope) return null;

  // Nearest-ancestor walk: the first collection-scope sync-root we hit going
  // UP from the collection is the closest ancestor → the owner.
  let cursor = collection;
  const seen = new Set();
  while (cursor) {
    // A collection can never live under a virtual view, but guard the leaf
    // anyway — isSpecialCollection is the sole scope boundary.
    if (isSpecialCollection(cursor)) return null;

    const key = cursor.key;
    if (key) {
      if (seen.has(key)) break; // defensive: broken parent chain / cycle
      seen.add(key);
      const owner = collScope.find((m) => m.syncRootCollectionKey === key);
      if (owner) return owner;
    }

    if (!cursor.parentID) break;
    try {
      cursor = Zotero.Collections.get(cursor.parentID);
    } catch (_e) {
      break;
    }
  }

  // No collection-scope ancestor claimed it → the library-scope mapping (if any)
  // owns everything else in the library; otherwise nothing watches it.
  return libScope;
}

/**
 * Resolve the ONE watch-folder mapping that owns a given Zotero item.
 *
 * An item is attributed via its collection memberships: the first membership
 * with an owning mapping wins (nearest-ancestor per collection — see
 * {@link mappingForCollection}), matching the plugin's existing "first folder
 * wins" philosophy for items that happen to sit in more than one watched tree.
 * An item with no owning collection membership (e.g. Unfiled) falls back to the
 * library-scope mapping covering the item's library, if any. Returns `null`
 * when no watch folder covers the item.
 *
 * @param {object} item - A Zotero.Item (its parent, for a child attachment,
 *   should be passed by the caller when membership lives on the parent).
 * @returns {import('./mappings.mjs').MappingContext|null}
 */
export function mappingForItem(item) {
  if (!item) return null;
  const mappings = getActiveMappings();
  if (!mappings || mappings.length === 0) return null;

  let collectionIDs = [];
  try {
    collectionIDs = (typeof item.getCollections === 'function' ? item.getCollections() : []) || [];
  } catch (_e) {
    collectionIDs = [];
  }

  for (const id of collectionIDs) {
    let coll = null;
    try {
      coll = Zotero.Collections.get(id);
    } catch (_e) {
      coll = null;
    }
    if (!coll) continue;
    const owner = mappingForCollection(coll);
    if (owner) return owner;
  }

  // Unfiled / no owning collection → the library-scope mapping for this
  // item's library is the fallback owner.
  const libraryID = item.libraryID;
  const userLib = _userLibraryID();
  return (
    mappings.find(
      (m) => m && m.scopeMode === 'library' && (m.syncRootLibraryID || userLib) === libraryID,
    ) || null
  );
}
