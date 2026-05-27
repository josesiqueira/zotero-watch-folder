/**
 * Unit tests for content/canonicalPath.mjs (new in v2).
 *
 * Covers:
 *   UT-201 resolveSyncRoot (not configured / resolved / missing → throw)
 *   UT-202 collectionKeyToRelativePath (root / nested / not-under)
 *   UT-203 relativePathToCollection (resolve / create / sync root itself)
 *   UT-204 isSpecialCollection (treeViewID virtual markers)
 *   UT-205 chooseCanonicalCollection (5 priority rules)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolveSyncRoot,
  collectionKeyToRelativePath,
  relativePathToCollection,
  isSpecialCollection,
  isUnsafeCollectionNameSegment,
  chooseCanonicalCollection,
  SyncRootMissingError,
} from '../../content/canonicalPath.mjs';

/**
 * Build a fake Zotero collection registry that satisfies the API surface
 * canonicalPath.mjs depends on:
 *   - Zotero.Collections.getByLibraryAndKeyAsync(libraryID, key)
 *   - Zotero.Collections.get(id)
 *   - Zotero.Collections.getByParent(parentID, libraryID)
 *
 * Each fake collection has: { id, key, name, libraryID, parentID }.
 * The registry exposes mock implementations + a `set` helper that wires them.
 */
function makeCollectionRegistry(collections) {
  const byID = new Map(collections.map(c => [c.id, c]));
  const byKey = new Map(collections.map(c => [c.key, c]));
  Zotero.Collections.getByLibraryAndKeyAsync = vi.fn(async (libraryID, key) => {
    const c = byKey.get(key);
    if (!c) return null;
    if (c.libraryID !== libraryID) return null;
    return c;
  });
  Zotero.Collections.get = vi.fn((id) => byID.get(id) ?? null);
  Zotero.Collections.getByParent = vi.fn((parentID, libraryID) =>
    collections.filter(c => c.parentID === parentID && c.libraryID === libraryID),
  );
  return { byID, byKey };
}

function resetPrefs(values) {
  // utils.mjs.getPref calls Zotero.Prefs.get(PREF_PREFIX + key, true)
  Zotero.Prefs.get = vi.fn((fullKey) => {
    const prefix = 'extensions.zotero.watchFolder.';
    if (fullKey.startsWith(prefix)) return values[fullKey.slice(prefix.length)];
    return undefined;
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  // Restore safe Zotero defaults the mocks blow away.
  Zotero.debug = vi.fn();
  Zotero.logError = vi.fn();
  Zotero.Libraries = { userLibraryID: 1, publicationsLibraryID: 4 };
});

// ─── UT-201 ────────────────────────────────────────────────────────────────

describe('UT-201: resolveSyncRoot', () => {
  it('returns null when syncRootCollectionKey is unset (empty string)', async () => {
    resetPrefs({ syncRootCollectionKey: '', syncRootLibraryID: 1 });
    const result = await resolveSyncRoot();
    expect(result).toBe(null);
  });

  it('returns the resolved collection when configured', async () => {
    resetPrefs({ syncRootCollectionKey: 'ROOT1', syncRootLibraryID: 1 });
    makeCollectionRegistry([
      { id: 100, key: 'ROOT1', name: 'Inbox', libraryID: 1, parentID: null },
    ]);
    const result = await resolveSyncRoot();
    expect(result).not.toBe(null);
    expect(result.collection.key).toBe('ROOT1');
    expect(result.libraryID).toBe(1);
  });

  it('throws SyncRootMissingError when the key is configured but no longer resolves', async () => {
    resetPrefs({ syncRootCollectionKey: 'GONE', syncRootLibraryID: 1 });
    makeCollectionRegistry([]); // nothing in the registry
    await expect(resolveSyncRoot()).rejects.toBeInstanceOf(SyncRootMissingError);
  });

  it('falls back to userLibraryID when syncRootLibraryID is unset', async () => {
    resetPrefs({ syncRootCollectionKey: 'ROOT1', syncRootLibraryID: undefined });
    makeCollectionRegistry([
      { id: 100, key: 'ROOT1', name: 'Inbox', libraryID: 1, parentID: null },
    ]);
    const result = await resolveSyncRoot();
    expect(result.libraryID).toBe(1);
  });

  // Trashed-sync-root hardening (2026-05-27 live finding on Zotero 9 verification).
  it('throws SyncRootMissingError when the resolved sync-root collection is in Zotero trash', async () => {
    resetPrefs({ syncRootCollectionKey: 'ROOT1', syncRootLibraryID: 1 });
    makeCollectionRegistry([
      { id: 100, key: 'ROOT1', name: 'Inbox', libraryID: 1, parentID: null, deleted: true },
    ]);
    await expect(resolveSyncRoot()).rejects.toBeInstanceOf(SyncRootMissingError);
  });

  it('error message for trashed sync-root mentions the Bin (so users know how to restore)', async () => {
    resetPrefs({ syncRootCollectionKey: 'ROOT1', syncRootLibraryID: 1 });
    makeCollectionRegistry([
      { id: 100, key: 'ROOT1', name: 'Inbox', libraryID: 1, parentID: null, deleted: true },
    ]);
    await expect(resolveSyncRoot()).rejects.toThrow(/trash|bin/i);
  });

  it('still resolves cleanly when the sync-root collection is NOT trashed', async () => {
    resetPrefs({ syncRootCollectionKey: 'ROOT1', syncRootLibraryID: 1 });
    makeCollectionRegistry([
      { id: 100, key: 'ROOT1', name: 'Inbox', libraryID: 1, parentID: null, deleted: false },
    ]);
    const result = await resolveSyncRoot();
    expect(result.collection.key).toBe('ROOT1');
  });
});

// ─── UT-202 ────────────────────────────────────────────────────────────────

describe('UT-202: collectionKeyToRelativePath', () => {
  beforeEach(() => {
    resetPrefs({ syncRootCollectionKey: 'ROOT1', syncRootLibraryID: 1 });
    makeCollectionRegistry([
      { id: 1, key: 'ROOT1', name: 'Inbox', libraryID: 1, parentID: null },
      { id: 2, key: 'METHODS', name: 'Methods', libraryID: 1, parentID: 1 },
      { id: 3, key: 'SUB', name: 'Subtopic', libraryID: 1, parentID: 2 },
      { id: 4, key: 'OTHER', name: 'Other', libraryID: 1, parentID: null },
    ]);
  });

  it('returns "" when the collection IS the sync root itself', async () => {
    expect(await collectionKeyToRelativePath('ROOT1')).toBe('');
  });

  it('returns the joined names for a nested collection', async () => {
    expect(await collectionKeyToRelativePath('METHODS')).toBe('Methods');
    expect(await collectionKeyToRelativePath('SUB')).toBe('Methods/Subtopic');
  });

  it('returns null when the collection isn\'t under the sync root', async () => {
    expect(await collectionKeyToRelativePath('OTHER')).toBe(null);
  });

  it('returns null for unknown collection key', async () => {
    expect(await collectionKeyToRelativePath('UNKNOWN')).toBe(null);
  });

  it('returns null when sync root is not configured', async () => {
    resetPrefs({ syncRootCollectionKey: '' });
    expect(await collectionKeyToRelativePath('METHODS')).toBe(null);
  });
});

// ─── UT-203 ────────────────────────────────────────────────────────────────

describe('UT-203: relativePathToCollection', () => {
  let collections;
  beforeEach(() => {
    resetPrefs({ syncRootCollectionKey: 'ROOT1', syncRootLibraryID: 1 });
    collections = [
      { id: 1, key: 'ROOT1', name: 'Inbox', libraryID: 1, parentID: null },
      { id: 2, key: 'METHODS', name: 'Methods', libraryID: 1, parentID: 1 },
    ];
    makeCollectionRegistry(collections);
  });

  it('returns the sync root itself for "" or null path', async () => {
    expect(await relativePathToCollection('')).toMatchObject({ key: 'ROOT1' });
    expect(await relativePathToCollection(null)).toMatchObject({ key: 'ROOT1' });
  });

  it('resolves an existing nested path without creating', async () => {
    const c = await relativePathToCollection('Methods');
    expect(c.key).toBe('METHODS');
  });

  it('returns null when path doesn\'t exist and createIfMissing is false', async () => {
    const c = await relativePathToCollection('Methods/Subtopic');
    expect(c).toBe(null);
  });

  it('creates missing intermediate collections when createIfMissing=true', async () => {
    // Stub Zotero.Collection constructor + saveTx
    let nextId = 100;
    globalThis.Zotero.Collection = vi.fn(function () {
      const self = {
        name: '',
        libraryID: 0,
        parentID: null,
        saveTx: vi.fn(async () => {
          self.id = nextId++;
          self.key = 'NEW' + self.id;
          collections.push(self);
          // Re-prime registry mocks so getByParent sees the new collection.
          makeCollectionRegistry(collections);
        }),
      };
      return self;
    });

    const leaf = await relativePathToCollection('Methods/Subtopic/Deep', { createIfMissing: true });
    expect(leaf).not.toBe(null);
    expect(leaf.name).toBe('Deep');
    expect(leaf.parentID).toBeDefined();
    // 2 new collections created: Subtopic + Deep.
    expect(globalThis.Zotero.Collection).toHaveBeenCalledTimes(2);
  });

  it('returns null when sync root is unset', async () => {
    resetPrefs({ syncRootCollectionKey: '' });
    expect(await relativePathToCollection('Methods')).toBe(null);
  });
});

// ─── UT-204 ────────────────────────────────────────────────────────────────

describe('UT-204: isSpecialCollection', () => {
  it('returns false for null / undefined', () => {
    expect(isSpecialCollection(null)).toBe(false);
    expect(isSpecialCollection(undefined)).toBe(false);
  });

  it('returns false for an ordinary collection (no treeViewID, no isVirtual)', () => {
    expect(isSpecialCollection({ id: 1, key: 'ABC', name: 'Methods' })).toBe(false);
  });

  it('returns true for the Duplicates virtual root (treeViewID="D")', () => {
    expect(isSpecialCollection({ treeViewID: 'D' })).toBe(true);
  });

  it('returns true for the Unfiled virtual root (treeViewID="U")', () => {
    expect(isSpecialCollection({ treeViewID: 'U' })).toBe(true);
  });

  it('returns true for the Trash virtual root (treeViewID="T")', () => {
    expect(isSpecialCollection({ treeViewID: 'T' })).toBe(true);
  });

  it('returns true for My Publications virtual root (treeViewID="P")', () => {
    expect(isSpecialCollection({ treeViewID: 'P' })).toBe(true);
  });

  it('returns true for a saved search (treeViewID starting with "S")', () => {
    expect(isSpecialCollection({ treeViewID: 'S42' })).toBe(true);
  });

  it('returns true when isVirtual flag is set', () => {
    expect(isSpecialCollection({ isVirtual: true })).toBe(true);
  });

  it('returns true when collection lives in publicationsLibraryID', () => {
    expect(isSpecialCollection({ libraryID: 4, name: 'PubChild' })).toBe(true);
  });
});

// ─── UT-205 ────────────────────────────────────────────────────────────────

describe('UT-205: chooseCanonicalCollection', () => {
  let collections;
  beforeEach(() => {
    resetPrefs({ syncRootCollectionKey: 'ROOT1', syncRootLibraryID: 1 });
    collections = [
      { id: 1, key: 'ROOT1', name: 'Inbox', libraryID: 1, parentID: null },
      { id: 2, key: 'METHODS', name: 'Methods', libraryID: 1, parentID: 1 },
      { id: 3, key: 'IMPORTANT', name: 'Important', libraryID: 1, parentID: 1 },
      { id: 4, key: 'DEEP', name: 'Deep', libraryID: 1, parentID: 2 }, // under Methods
      { id: 5, key: 'OUTSIDE', name: 'Outside', libraryID: 1, parentID: null },
    ];
    makeCollectionRegistry(collections);
  });

  function makeItem(collectionIDs) {
    return { getCollections: () => collectionIDs };
  }

  const root = { id: 1, key: 'ROOT1', name: 'Inbox', libraryID: 1, parentID: null };

  it('returns null when item has no collections under sync root', async () => {
    const item = makeItem([5]); // only OUTSIDE
    const c = await chooseCanonicalCollection(item, root);
    expect(c).toBe(null);
  });

  it('returns the single qualifying collection when only one is under sync root', async () => {
    const item = makeItem([2, 5]); // METHODS + OUTSIDE
    const c = await chooseCanonicalCollection(item, root);
    expect(c.key).toBe('METHODS');
  });

  it('rule 1: existing tracked canonical wins when still valid', async () => {
    const item = makeItem([2, 3]); // METHODS + IMPORTANT
    const c = await chooseCanonicalCollection(item, root, {
      existingTrackingRecord: { canonicalCollectionKey: 'IMPORTANT' },
    });
    expect(c.key).toBe('IMPORTANT');
  });

  it('rule 2: user-preferred wins when rule 1 doesn\'t match', async () => {
    const item = makeItem([2, 3]);
    const c = await chooseCanonicalCollection(item, root, {
      existingTrackingRecord: { canonicalCollectionKey: 'NOT_IN_ITEM' },
      userPreferredKey: 'IMPORTANT',
    });
    expect(c.key).toBe('IMPORTANT');
  });

  it('rule 4: shortest path wins when no tracked/preferred match', async () => {
    // METHODS depth=1, DEEP depth=2 → METHODS wins.
    const item = makeItem([2, 4]);
    const c = await chooseCanonicalCollection(item, root);
    expect(c.key).toBe('METHODS');
  });

  it('rule 5: alphabetic fallback when paths tie on length', async () => {
    // METHODS and IMPORTANT both at depth 1. Alphabetic: Important < Methods.
    const item = makeItem([2, 3]);
    const c = await chooseCanonicalCollection(item, root);
    expect(c.key).toBe('IMPORTANT');
  });

  it('skips special collections in candidate set', async () => {
    // Add a virtual collection that the item also "belongs" to.
    collections.push({ id: 99, key: 'VIRT', name: 'Trash', libraryID: 1, parentID: null, treeViewID: 'T' });
    makeCollectionRegistry(collections);
    const item = makeItem([2, 99]);
    const c = await chooseCanonicalCollection(item, root);
    expect(c.key).toBe('METHODS'); // virt is filtered out
  });
});

// ─── UT-206 — path-traversal defense (security audit 2026-05-27) ──────────

describe('UT-206: isUnsafeCollectionNameSegment', () => {
  it('rejects empty / whitespace-only segments', () => {
    expect(isUnsafeCollectionNameSegment('')).toBe(true);
    expect(isUnsafeCollectionNameSegment('   ')).toBe(true);
  });

  it('rejects `.` and `..`', () => {
    expect(isUnsafeCollectionNameSegment('.')).toBe(true);
    expect(isUnsafeCollectionNameSegment('..')).toBe(true);
    expect(isUnsafeCollectionNameSegment('  .  ')).toBe(true);
    expect(isUnsafeCollectionNameSegment('  ..  ')).toBe(true);
  });

  it('rejects path-separator-bearing segments', () => {
    expect(isUnsafeCollectionNameSegment('foo/bar')).toBe(true);
    expect(isUnsafeCollectionNameSegment('foo\\bar')).toBe(true);
    expect(isUnsafeCollectionNameSegment('/etc')).toBe(true);
    expect(isUnsafeCollectionNameSegment('..\\windows')).toBe(true);
  });

  it('rejects NUL bytes', () => {
    expect(isUnsafeCollectionNameSegment('foo bar')).toBe(true);
  });

  it('rejects non-string values', () => {
    expect(isUnsafeCollectionNameSegment(null)).toBe(true);
    expect(isUnsafeCollectionNameSegment(undefined)).toBe(true);
    expect(isUnsafeCollectionNameSegment(42)).toBe(true);
    expect(isUnsafeCollectionNameSegment({})).toBe(true);
  });

  it('accepts ordinary names — spaces, dots, unicode, dashes', () => {
    expect(isUnsafeCollectionNameSegment('Methods')).toBe(false);
    expect(isUnsafeCollectionNameSegment('A.B')).toBe(false);
    expect(isUnsafeCollectionNameSegment('A B C')).toBe(false);
    expect(isUnsafeCollectionNameSegment('étude — papers')).toBe(false);
    expect(isUnsafeCollectionNameSegment('2024-research')).toBe(false);
    // Trailing dot/space — annoying on Windows but not a traversal vector
    // per se; accepted here. (Filesystem layer normalizes these.)
    expect(isUnsafeCollectionNameSegment('foo.')).toBe(false);
  });
});

describe('UT-206: collectionKeyToRelativePath refuses unsafe segments in the chain', () => {
  beforeEach(() => {
    resetPrefs({ syncRootCollectionKey: 'ROOT1', syncRootLibraryID: 1 });
  });

  it('returns null when an ancestor name is `..`', async () => {
    makeCollectionRegistry([
      { id: 1, key: 'ROOT1', name: 'Inbox', libraryID: 1, parentID: null },
      { id: 2, key: 'EVIL',  name: '..',    libraryID: 1, parentID: 1 },
      { id: 3, key: 'CHILD', name: 'paper', libraryID: 1, parentID: 2 },
    ]);
    expect(await collectionKeyToRelativePath('CHILD')).toBe(null);
    expect(Zotero.logError).toHaveBeenCalled();
  });

  it('returns null when a name contains a path separator', async () => {
    makeCollectionRegistry([
      { id: 1, key: 'ROOT1', name: 'Inbox', libraryID: 1, parentID: null },
      { id: 2, key: 'EVIL',  name: 'foo/bar', libraryID: 1, parentID: 1 },
    ]);
    expect(await collectionKeyToRelativePath('EVIL')).toBe(null);
  });

  it('returns null when a name contains a backslash', async () => {
    makeCollectionRegistry([
      { id: 1, key: 'ROOT1', name: 'Inbox', libraryID: 1, parentID: null },
      { id: 2, key: 'EVIL',  name: '..\\windows', libraryID: 1, parentID: 1 },
    ]);
    expect(await collectionKeyToRelativePath('EVIL')).toBe(null);
  });

  it('accepts legitimate nested names without complaint', async () => {
    makeCollectionRegistry([
      { id: 1, key: 'ROOT1', name: 'Inbox', libraryID: 1, parentID: null },
      { id: 2, key: 'A',     name: 'Methods', libraryID: 1, parentID: 1 },
      { id: 3, key: 'B',     name: 'Subtopic', libraryID: 1, parentID: 2 },
    ]);
    expect(await collectionKeyToRelativePath('B')).toBe('Methods/Subtopic');
    expect(Zotero.logError).not.toHaveBeenCalled();
  });
});

describe('UT-206: relativePathToCollection refuses unsafe path segments', () => {
  beforeEach(() => {
    resetPrefs({ syncRootCollectionKey: 'ROOT1', syncRootLibraryID: 1 });
    makeCollectionRegistry([
      { id: 1, key: 'ROOT1', name: 'Inbox', libraryID: 1, parentID: null },
    ]);
  });

  it('returns null when the requested path contains `..`', async () => {
    expect(await relativePathToCollection('Methods/../escape', { createIfMissing: true })).toBe(null);
    expect(Zotero.logError).toHaveBeenCalled();
  });

  it('returns null when the requested path contains `.`', async () => {
    expect(await relativePathToCollection('./escape', { createIfMissing: true })).toBe(null);
  });

  it('returns null when a segment contains backslash (Windows path injection)', async () => {
    expect(await relativePathToCollection('Methods/..\\..\\etc', { createIfMissing: true })).toBe(null);
  });

  it('accepts ordinary nested paths', async () => {
    const c = await relativePathToCollection('Methods/Subtopic', { createIfMissing: true });
    expect(c).not.toBe(null);
    expect(Zotero.logError).not.toHaveBeenCalled();
  });
});
