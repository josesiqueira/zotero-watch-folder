/**
 * Unit tests for syncState.mjs
 * Covers: UT-033 through UT-036
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SyncState, getSyncState, resetSyncState } from '../../content/syncState.mjs';

// SyncState uses IOUtils, PathUtils, and Zotero globals only in init()/save()/load().
// We test in-memory operations by instantiating directly without calling init().

describe('SyncState', () => {
  let state;

  beforeEach(() => {
    state = new SyncState();
    // Reset singleton between tests
    resetSyncState();
  });

  // ─── UT-033: in-memory collection operations ────────────────────────────────

  describe('UT-033: collection operations', () => {
    // UT-033a: setCollection and getCollection
    it('UT-033a: setCollection stores and getCollection retrieves collection state', () => {
      state.setCollection(1, { name: 'A', parentID: null, folderPath: '/m/A' });
      const col = state.getCollection(1);
      expect(col).not.toBeNull();
      expect(col.name).toBe('A');
      expect(col.folderPath).toBe('/m/A');
      expect(col.parentID).toBeNull();
      expect(typeof col.lastSynced).toBe('number');
    });

    // UT-033b: hasCollection returns true after set
    it('UT-033b: hasCollection returns true after setCollection', () => {
      state.setCollection(1, { name: 'A', parentID: null, folderPath: '/m/A' });
      expect(state.hasCollection(1)).toBe(true);
    });

    // UT-033c: removeCollection then hasCollection returns false
    it('UT-033c: removeCollection removes the collection', () => {
      state.setCollection(1, { name: 'A', parentID: null, folderPath: '/m/A' });
      state.removeCollection(1);
      expect(state.hasCollection(1)).toBe(false);
    });

    // UT-033d: getCollectionByPath returns matching collection
    it('UT-033d: getCollectionByPath returns collection with matching folderPath', () => {
      state.setCollection(1, { name: 'A', parentID: null, folderPath: '/m/A' });
      const result = state.getCollectionByPath('/m/A');
      expect(result).not.toBeNull();
      expect(result.id).toBe(1);
      expect(result.name).toBe('A');
    });

    it('UT-033d-miss: getCollectionByPath returns null when path not found', () => {
      const result = state.getCollectionByPath('/not/exist');
      expect(result).toBeNull();
    });

    // UT-033e: getCollectionsByParent returns collections with matching parentID
    it('UT-033e: getCollectionsByParent returns collections with matching parentID=null', () => {
      state.setCollection(1, { name: 'Root1', parentID: null, folderPath: '/m/R1' });
      state.setCollection(2, { name: 'Root2', parentID: null, folderPath: '/m/R2' });
      state.setCollection(3, { name: 'Child', parentID: 1, folderPath: '/m/R1/C' });
      const roots = state.getCollectionsByParent(null);
      expect(roots.length).toBe(2);
      const ids = roots.map(r => r.id);
      expect(ids).toContain(1);
      expect(ids).toContain(2);
    });

    it('UT-033e-child: getCollectionsByParent filters by specific parentID', () => {
      state.setCollection(1, { name: 'Root', parentID: null, folderPath: '/m/R' });
      state.setCollection(2, { name: 'Child', parentID: 1, folderPath: '/m/R/C' });
      const children = state.getCollectionsByParent(1);
      expect(children.length).toBe(1);
      expect(children[0].id).toBe(2);
    });
  });

  // ─── UT-034: in-memory item operations ─────────────────────────────────────

  describe('UT-034: item operations', () => {
    // UT-034a: setItem and getItem
    it('UT-034a: setItem stores and getItem retrieves item state', () => {
      state.setItem(10, { collectionIDs: [1, 2], filePath: '/p/f.pdf', primaryCollectionID: 1 });
      const item = state.getItem(10);
      expect(item).not.toBeNull();
      expect(item.collectionIDs).toEqual([1, 2]);
      expect(item.filePath).toBe('/p/f.pdf');
      expect(item.primaryCollectionID).toBe(1);
    });

    // UT-034b: hasItem returns true after setItem
    it('UT-034b: hasItem returns true after setItem', () => {
      state.setItem(10, { collectionIDs: [1], filePath: '/p/f.pdf', primaryCollectionID: 1 });
      expect(state.hasItem(10)).toBe(true);
    });

    // UT-034c: removeItem then hasItem returns false
    it('UT-034c: removeItem removes the item', () => {
      state.setItem(10, { collectionIDs: [1], filePath: '/p/f.pdf', primaryCollectionID: 1 });
      state.removeItem(10);
      expect(state.hasItem(10)).toBe(false);
    });

    // UT-034d: getItemByPath returns matching item
    it('UT-034d: getItemByPath returns item with matching filePath', () => {
      state.setItem(10, { collectionIDs: [1], filePath: '/p/f.pdf', primaryCollectionID: 1 });
      const result = state.getItemByPath('/p/f.pdf');
      expect(result).not.toBeNull();
      expect(result.id).toBe(10);
    });

    it('UT-034d-miss: getItemByPath returns null when path not found', () => {
      expect(state.getItemByPath('/not/exist')).toBeNull();
    });

    // UT-034e: getItemsByCollection
    it('UT-034e: getItemsByCollection returns items in the specified collection', () => {
      state.setItem(10, { collectionIDs: [1, 2], filePath: '/a.pdf', primaryCollectionID: 1 });
      state.setItem(11, { collectionIDs: [2], filePath: '/b.pdf', primaryCollectionID: 2 });
      state.setItem(12, { collectionIDs: [3], filePath: '/c.pdf', primaryCollectionID: 3 });
      const inCol1 = state.getItemsByCollection(1);
      expect(inCol1.length).toBe(1);
      expect(inCol1[0].id).toBe(10);
      const inCol2 = state.getItemsByCollection(2);
      expect(inCol2.length).toBe(2);
    });

    // UT-034f: addItemToCollection adds collection ID
    it('UT-034f: addItemToCollection adds a collection ID to item', () => {
      state.setItem(10, { collectionIDs: [1, 2], filePath: '/a.pdf', primaryCollectionID: 1 });
      state.addItemToCollection(10, 3);
      const item = state.getItem(10);
      expect(item.collectionIDs).toContain(3);
    });

    it('UT-034f-noop: addItemToCollection does not duplicate existing collection ID', () => {
      state.setItem(10, { collectionIDs: [1, 2], filePath: '/a.pdf', primaryCollectionID: 1 });
      state.addItemToCollection(10, 1);
      const item = state.getItem(10);
      expect(item.collectionIDs.filter(id => id === 1).length).toBe(1);
    });

    // UT-034g: removeItemFromCollection removes the collection, keeps others
    it('UT-034g: removeItemFromCollection removes specified collection but keeps others', () => {
      state.setItem(10, { collectionIDs: [1, 2], filePath: '/a.pdf', primaryCollectionID: 1 });
      state.removeItemFromCollection(10, 1);
      const item = state.getItem(10);
      expect(item.collectionIDs).not.toContain(1);
      expect(item.collectionIDs).toContain(2);
    });
  });

  // ─── UT-035: getStats and markFullSync ──────────────────────────────────────

  describe('UT-035: getStats and markFullSync', () => {
    it('UT-035a: getStats returns correct counts', () => {
      state.setCollection(1, { name: 'A', parentID: null, folderPath: '/a' });
      state.setItem(10, { collectionIDs: [1], filePath: '/a.pdf', primaryCollectionID: 1 });
      state.setItem(11, { collectionIDs: [1], filePath: '/b.pdf', primaryCollectionID: 1 });

      const stats = state.getStats();
      expect(stats.collectionCount).toBe(1);
      expect(stats.itemCount).toBe(2);
      expect(stats.lastFullSync).toBeNull();
    });

    it('UT-035b: markFullSync sets lastFullSync to a non-null number and isDirty becomes true', () => {
      // Clear any dirty state from setup
      state._dirty = false;
      state.markFullSync();
      const stats = state.getStats();
      expect(stats.lastFullSync).not.toBeNull();
      expect(typeof stats.lastFullSync).toBe('number');
      expect(stats.isDirty).toBe(true);
    });

    it('UT-035c: isDirty() reflects _dirty flag', () => {
      state._dirty = false;
      expect(state.isDirty()).toBe(false);
      state.setCollection(99, { name: 'X', parentID: null, folderPath: '/x' });
      expect(state.isDirty()).toBe(true);
    });
  });

  // ─── UT-036: clear ───────────────────────────────────────────────────────────

  describe('UT-036: clear', () => {
    it('UT-036a: clear empties both maps and resets lastFullSync to null', () => {
      state.setCollection(1, { name: 'A', parentID: null, folderPath: '/a' });
      state.setItem(10, { collectionIDs: [1], filePath: '/a.pdf', primaryCollectionID: 1 });
      state.markFullSync();

      state.clear();

      expect(state.collections.size).toBe(0);
      expect(state.items.size).toBe(0);
      expect(state.lastFullSync).toBeNull();
    });

    it('UT-036b: clear sets dirty flag', () => {
      state._dirty = false;
      state.clear();
      expect(state._dirty).toBe(true);
    });
  });

  // ─── Singleton helpers ───────────────────────────────────────────────────────

  describe('getSyncState / resetSyncState', () => {
    it('getSyncState returns same instance on repeated calls', () => {
      const a = getSyncState();
      const b = getSyncState();
      expect(a).toBe(b);
    });

    it('resetSyncState creates a fresh instance on next call', () => {
      const a = getSyncState();
      resetSyncState();
      const b = getSyncState();
      expect(a).not.toBe(b);
    });
  });
});
