/**
 * Unit tests for content/mappingRouter.mjs — the owning-mapping resolver.
 *
 * Covers the "nearest sync-root ancestor wins" rule (docs/mode2-mode3-design.md §5):
 *   UT-MR1 no mappings / uncovered collection → null
 *   UT-MR2 collection-scope: the sync root itself + nested descendants
 *   UT-MR3 nearest-ancestor: deepest sync-root wins over a shallower one
 *   UT-MR4 library-scope fallback owns everything not under a collection root
 *   UT-MR5 collection-scope beats library-scope for its own subtree
 *   UT-MR6 different library → not owned
 *   UT-MR7 virtual/special view → never owned
 *   UT-MR8 broken parent chain / cycle terminates safely
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../content/mappings.mjs', () => ({
  getActiveMappings: vi.fn(() => []),
}));
vi.mock('../../content/canonicalPath.mjs', () => ({
  // Real-equivalent: virtual tree rows carry a non-'C' treeViewID marker.
  isSpecialCollection: (c) =>
    typeof c?.treeViewID === 'string' && c.treeViewID.length > 0 && 'DUTPSFL'.includes(c.treeViewID[0]),
}));

import { mappingForCollection, mappingForItem } from '../../content/mappingRouter.mjs';
import { getActiveMappings } from '../../content/mappings.mjs';

// ── A small collection graph, wired to Zotero.Collections.get(id) ──────────
//   PAPERS (10) ─ DRAFT (11) ─ SUB (12)      [library 1]
//   OTHER  (20)                              [library 1, unrelated top-level]
//   L2COLL (30)                              [library 2]
const COLS = {
  PAPERS: { id: 10, key: 'PAPERS00', libraryID: 1, parentID: null, treeViewID: 'C10' },
  DRAFT: { id: 11, key: 'DRAFT000', libraryID: 1, parentID: 10, treeViewID: 'C11' },
  SUB: { id: 12, key: 'SUB00000', libraryID: 1, parentID: 11, treeViewID: 'C12' },
  OTHER: { id: 20, key: 'OTHER000', libraryID: 1, parentID: null, treeViewID: 'C20' },
  L2COLL: { id: 30, key: 'L2COLL00', libraryID: 2, parentID: null, treeViewID: 'C30' },
};

function collMapping(id, key, libraryID = 1) {
  return { id, scopeMode: 'collection', syncRootCollectionKey: key, syncRootLibraryID: libraryID };
}
function libMapping(id, libraryID = 1) {
  return { id, scopeMode: 'library', syncRootCollectionKey: '', syncRootLibraryID: libraryID };
}

beforeEach(() => {
  vi.resetAllMocks();
  const byId = new Map(Object.values(COLS).map((c) => [c.id, c]));
  globalThis.Zotero = globalThis.Zotero || {};
  globalThis.Zotero.Collections = { get: vi.fn((id) => byId.get(id) || null) };
  globalThis.Zotero.Libraries = { userLibraryID: 1 };
});

// ── UT-MR1 ──────────────────────────────────────────────────────────────
describe('UT-MR1: no owner', () => {
  it('returns null when there are no active mappings', () => {
    getActiveMappings.mockReturnValue([]);
    expect(mappingForCollection(COLS.PAPERS)).toBe(null);
  });
  it('returns null for a null collection', () => {
    getActiveMappings.mockReturnValue([collMapping('A', 'PAPERS00')]);
    expect(mappingForCollection(null)).toBe(null);
  });
  it('returns null for a collection outside every collection-scope subtree (no library mapping)', () => {
    getActiveMappings.mockReturnValue([collMapping('A', 'PAPERS00')]);
    expect(mappingForCollection(COLS.OTHER)).toBe(null);
  });
});

// ── UT-MR2 ──────────────────────────────────────────────────────────────
describe('UT-MR2: collection scope — root and descendants', () => {
  it('the sync-root collection itself is owned', () => {
    const A = collMapping('A', 'PAPERS00');
    getActiveMappings.mockReturnValue([A]);
    expect(mappingForCollection(COLS.PAPERS)).toBe(A);
  });
  it('a nested descendant is owned by the ancestor mapping', () => {
    const A = collMapping('A', 'PAPERS00');
    getActiveMappings.mockReturnValue([A]);
    expect(mappingForCollection(COLS.SUB)).toBe(A); // SUB → DRAFT → PAPERS
  });
});

// ── UT-MR3 ──────────────────────────────────────────────────────────────
describe('UT-MR3: nearest ancestor wins', () => {
  it('deepest sync-root owns a collection nested under both', () => {
    const A = collMapping('A', 'PAPERS00'); // shallow
    const B = collMapping('B', 'DRAFT000'); // deep (under PAPERS)
    getActiveMappings.mockReturnValue([A, B]);
    expect(mappingForCollection(COLS.SUB)).toBe(B);   // nearest is DRAFT
    expect(mappingForCollection(COLS.DRAFT)).toBe(B);
    expect(mappingForCollection(COLS.PAPERS)).toBe(A); // above DRAFT → PAPERS
  });
  it('order in the mappings array does not change the result', () => {
    const A = collMapping('A', 'PAPERS00');
    const B = collMapping('B', 'DRAFT000');
    getActiveMappings.mockReturnValue([B, A]); // reversed
    expect(mappingForCollection(COLS.SUB)).toBe(B);
  });
});

// ── UT-MR4 ──────────────────────────────────────────────────────────────
describe('UT-MR4: library-scope fallback', () => {
  it('owns any collection in its library not under a collection root', () => {
    const L = libMapping('L');
    getActiveMappings.mockReturnValue([L]);
    expect(mappingForCollection(COLS.OTHER)).toBe(L);
    expect(mappingForCollection(COLS.SUB)).toBe(L);
  });
});

// ── UT-MR5 ──────────────────────────────────────────────────────────────
describe('UT-MR5: collection scope beats library fallback within its subtree', () => {
  it('collection mapping owns its subtree; library mapping owns the rest', () => {
    const A = collMapping('A', 'PAPERS00');
    const L = libMapping('L');
    getActiveMappings.mockReturnValue([A, L]);
    expect(mappingForCollection(COLS.SUB)).toBe(A);    // under PAPERS
    expect(mappingForCollection(COLS.OTHER)).toBe(L);  // elsewhere in the library
  });
});

// ── UT-MR6 ──────────────────────────────────────────────────────────────
describe('UT-MR6: library isolation', () => {
  it('a mapping in library 1 does not own a library-2 collection', () => {
    getActiveMappings.mockReturnValue([collMapping('A', 'PAPERS00', 1), libMapping('L', 1)]);
    expect(mappingForCollection(COLS.L2COLL)).toBe(null);
  });
  it('a library-2 mapping owns the library-2 collection', () => {
    const L2 = libMapping('L2', 2);
    getActiveMappings.mockReturnValue([libMapping('L', 1), L2]);
    expect(mappingForCollection(COLS.L2COLL)).toBe(L2);
  });
});

// ── UT-MR7 ──────────────────────────────────────────────────────────────
describe('UT-MR7: virtual views are never owned', () => {
  it('returns null for a Trash/virtual collection even with a library mapping', () => {
    getActiveMappings.mockReturnValue([libMapping('L')]);
    const trash = { key: 'x', libraryID: 1, parentID: null, treeViewID: 'T1' };
    expect(mappingForCollection(trash)).toBe(null);
  });
});

// ── UT-MR8 ──────────────────────────────────────────────────────────────
describe('UT-MR8: broken parent chain terminates safely', () => {
  it('a self-referential parentID does not loop forever', () => {
    const cyc = { id: 40, key: 'CYCLE000', libraryID: 1, parentID: 40, treeViewID: 'C40' };
    globalThis.Zotero.Collections.get = vi.fn((id) => (id === 40 ? cyc : null));
    getActiveMappings.mockReturnValue([collMapping('A', 'PAPERS00')]);
    expect(mappingForCollection(cyc)).toBe(null); // not owned, and returns (no hang)
  });
});

// ── UT-MR9: mappingForItem ────────────────────────────────────────────────
describe('UT-MR9: mappingForItem', () => {
  /** Build a Zotero-item-like object with collection memberships (by id). */
  function item(collectionIDs, libraryID = 1) {
    return { libraryID, getCollections: () => collectionIDs };
  }

  it('attributes an item to the mapping owning one of its collections', () => {
    const A = collMapping('A', 'PAPERS00');
    getActiveMappings.mockReturnValue([A]);
    expect(mappingForItem(item([COLS.SUB.id]))).toBe(A); // SUB is under PAPERS
  });

  it('an Unfiled item (no collections) falls back to the library-scope mapping', () => {
    const L = libMapping('L');
    getActiveMappings.mockReturnValue([L]);
    expect(mappingForItem(item([]))).toBe(L);
  });

  it('an Unfiled item with no library-scope mapping is unowned', () => {
    getActiveMappings.mockReturnValue([collMapping('A', 'PAPERS00')]);
    expect(mappingForItem(item([]))).toBe(null);
  });

  it('an item only in unwatched collections is unowned', () => {
    getActiveMappings.mockReturnValue([collMapping('A', 'PAPERS00')]);
    expect(mappingForItem(item([COLS.OTHER.id]))).toBe(null); // OTHER not under PAPERS, no lib mapping
  });

  it('a library-scope item in a different library is unowned', () => {
    getActiveMappings.mockReturnValue([libMapping('L', 1)]);
    expect(mappingForItem(item([], 2))).toBe(null);
  });

  it('returns null for a null item', () => {
    getActiveMappings.mockReturnValue([libMapping('L')]);
    expect(mappingForItem(null)).toBe(null);
  });
});
