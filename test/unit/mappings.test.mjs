/**
 * Unit tests for content/mappings.mjs — the multi-mapping registry.
 *
 * Covers:
 *   UT-M1 isMultiMappingActive (gate)
 *   UT-M2 synthesizeLegacyMapping (single-root fallback shape)
 *   UT-M3 getActiveMappings (gate off → synth; gate on → parsed; malformed → fallback; dedup ids)
 *   UT-M4 getMappingById (match / legacy fallback / unknown)
 *   UT-M5 watchRootsOverlap (equal / nested / sibling)
 *   UT-M6 validateMapping (empty / overlap / data-dir unsafe / ok)
 *   UT-M7 readMappings / writeMappings round-trip
 *   UT-M8 mintMappingId (returns a non-empty string)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  LEGACY_MAPPING_ID,
  isMultiMappingActive,
  effectiveGlobalMode,
  synthesizeLegacyMapping,
  getActiveMappings,
  getMappingById,
  watchRootsOverlap,
  validateMapping,
  readMappings,
  writeMappings,
  mintMappingId,
  __test_setActiveMappings,
} from '../../content/mappings.mjs';

const PREFIX = 'extensions.zotero.watchFolder.';

/** In-memory pref store wired to Zotero.Prefs.get/set (what utils.getPref/setPref call). */
function installPrefs(values = {}) {
  const store = { ...values };
  Zotero.Prefs.get = vi.fn((fullKey) => {
    if (fullKey.startsWith(PREFIX)) return store[fullKey.slice(PREFIX.length)];
    return undefined;
  });
  Zotero.Prefs.set = vi.fn((fullKey, val) => {
    if (fullKey.startsWith(PREFIX)) store[fullKey.slice(PREFIX.length)] = val;
  });
  return store;
}

beforeEach(() => {
  vi.resetAllMocks();
  Zotero.debug = vi.fn();
  Zotero.logError = vi.fn();
  __test_setActiveMappings(null); // clear the test seam between cases
});

// ─── UT-M1 ───────────────────────────────────────────────────────────────
describe('UT-M1: isMultiMappingActive', () => {
  it('is false when the gate pref is unset', () => {
    installPrefs({});
    expect(isMultiMappingActive()).toBe(false);
  });
  it('is false when the gate pref is false, true only when strictly true', () => {
    installPrefs({ watchMappingsMulti: false });
    expect(isMultiMappingActive()).toBe(false);
    installPrefs({ watchMappingsMulti: true });
    expect(isMultiMappingActive()).toBe(true);
  });
});

// ─── UT-M2 ───────────────────────────────────────────────────────────────
describe('UT-M2: synthesizeLegacyMapping', () => {
  it('builds a legacy-id context from the scalar prefs', () => {
    installPrefs({
      sourcePath: '/watch', scopeMode: 'collection', syncRootCollectionKey: 'ROOT1',
      syncRootLibraryID: 1, mode: 'mode3', pdfStorageStrategy: 'linked_watch_folder',
    });
    const m = synthesizeLegacyMapping();
    expect(m).toEqual({
      id: LEGACY_MAPPING_ID, sourcePath: '/watch', scopeMode: 'collection',
      syncRootCollectionKey: 'ROOT1', syncRootLibraryID: 1, mode: 'mode3',
      pdfStorageStrategy: 'linked_watch_folder',
    });
  });
  it("scopeMode is 'library' only when the pref is exactly 'library'", () => {
    installPrefs({ sourcePath: '/w', scopeMode: 'library' });
    expect(synthesizeLegacyMapping().scopeMode).toBe('library');
    installPrefs({ sourcePath: '/w' }); // unset → collection (matches getScopeMode)
    expect(synthesizeLegacyMapping().scopeMode).toBe('collection');
  });
});

// ─── UT-M3 ───────────────────────────────────────────────────────────────
describe('UT-M3: getActiveMappings', () => {
  it('returns a single synthesized legacy mapping when the gate is off', () => {
    installPrefs({ sourcePath: '/watch', mode: 'mode1', watchMappings: '[]' });
    const ms = getActiveMappings();
    expect(ms).toHaveLength(1);
    expect(ms[0].id).toBe(LEGACY_MAPPING_ID);
    expect(ms[0].sourcePath).toBe('/watch');
  });

  it('parses N mappings when the gate is on', () => {
    const mappings = [
      { id: 'aaaa1111', sourcePath: '/A', scopeMode: 'collection', syncRootCollectionKey: 'CA', syncRootLibraryID: 1, mode: 'mode1', pdfStorageStrategy: 'stored' },
      { id: 'bbbb2222', sourcePath: '/B', scopeMode: 'library', syncRootCollectionKey: '', syncRootLibraryID: 3, mode: 'mode3', pdfStorageStrategy: 'linked_watch_folder' },
    ];
    installPrefs({ watchMappingsMulti: true, watchMappings: JSON.stringify(mappings) });
    const ms = getActiveMappings();
    expect(ms.map(m => m.id)).toEqual(['aaaa1111', 'bbbb2222']);
    expect(ms[0].sourcePath).toBe('/A');
    expect(ms[1].scopeMode).toBe('library');
    expect(ms[1].syncRootLibraryID).toBe(3);
  });

  it('falls back to the synthesized legacy mapping when the gate is on but the JSON is malformed', () => {
    installPrefs({ watchMappingsMulti: true, watchMappings: 'not json', sourcePath: '/watch' });
    const ms = getActiveMappings();
    expect(ms).toHaveLength(1);
    expect(ms[0].id).toBe(LEGACY_MAPPING_ID);
  });

  it('returns [] (watch nothing) for a valid EMPTY array — does NOT resurrect legacy scalars', () => {
    // All folders removed: an empty list must mean "no folders", not a phantom
    // watch of the stale single-root sourcePath/collection.
    installPrefs({ watchMappingsMulti: true, watchMappings: '[]', sourcePath: '/watch', syncRootCollectionKey: 'DEADKEY0' });
    expect(getActiveMappings()).toEqual([]);
  });

  it('drops entries with no sourcePath and duplicate ids', () => {
    const mappings = [
      { id: 'x', sourcePath: '/A' },
      { id: 'y' },                    // no sourcePath → dropped
      { id: 'x', sourcePath: '/C' },  // duplicate id → dropped
      { id: 'z', sourcePath: '/D' },
    ];
    installPrefs({ watchMappingsMulti: true, watchMappings: JSON.stringify(mappings) });
    expect(getActiveMappings().map(m => m.id)).toEqual(['x', 'z']);
  });

  it('honors the __test_setActiveMappings seam', () => {
    installPrefs({});
    __test_setActiveMappings([{ id: 'seam', sourcePath: '/S', scopeMode: 'collection', mode: 'mode1' }]);
    const ms = getActiveMappings();
    expect(ms).toHaveLength(1);
    expect(ms[0].id).toBe('seam');
  });
});

// ─── UT-M4 ───────────────────────────────────────────────────────────────
describe('UT-M4: getMappingById', () => {
  it('returns the matching active mapping', () => {
    installPrefs({ watchMappingsMulti: true, watchMappings: JSON.stringify([{ id: 'q1', sourcePath: '/Q' }]) });
    expect(getMappingById('q1').sourcePath).toBe('/Q');
  });
  it('falls back to the synthesized legacy mapping for the legacy id', () => {
    installPrefs({ sourcePath: '/watch' });
    expect(getMappingById(LEGACY_MAPPING_ID).sourcePath).toBe('/watch');
  });
  it('returns null for an unknown id', () => {
    installPrefs({ watchMappingsMulti: true, watchMappings: JSON.stringify([{ id: 'q1', sourcePath: '/Q' }]) });
    expect(getMappingById('nope')).toBe(null);
  });
});

// ─── UT-M5 ───────────────────────────────────────────────────────────────
describe('UT-M5: watchRootsOverlap', () => {
  it('flags identical roots', () => {
    expect(watchRootsOverlap('/a/b', '/a/b')).toBe(true);
  });
  it('flags a nested root (either direction)', () => {
    expect(watchRootsOverlap('/a', '/a/b')).toBe(true);
    expect(watchRootsOverlap('/a/b', '/a')).toBe(true);
  });
  it('allows siblings / unrelated roots', () => {
    expect(watchRootsOverlap('/a/b', '/a/c')).toBe(false);
    expect(watchRootsOverlap('/a-backup', '/a')).toBe(false); // not a real prefix
  });
});

// ─── UT-M6 ───────────────────────────────────────────────────────────────
describe('UT-M6: validateMapping', () => {
  const dataDir = '/Users/me/Zotero';
  it('rejects an empty path', () => {
    expect(validateMapping({ sourcePath: '' }, [], dataDir)).toMatch(/watch folder is required/i);
  });
  it('rejects a path overlapping an existing mapping', () => {
    const existing = [{ id: 'a', sourcePath: '/watch/A' }];
    expect(validateMapping({ id: 'b', sourcePath: '/watch/A/sub' }, existing, dataDir)).toMatch(/overlaps/i);
  });
  it('rejects a path inside the Zotero data dir (isWatchRootUnsafe)', () => {
    expect(validateMapping({ sourcePath: '/Users/me/Zotero/storage/x' }, [], dataDir)).toBeTruthy();
  });
  it('allows a disjoint, safe path', () => {
    const existing = [{ id: 'a', sourcePath: '/watch/A' }];
    expect(validateMapping({ id: 'b', sourcePath: '/watch/B' }, existing, dataDir)).toBe(null);
  });
  it('does not treat editing the same row as an overlap with itself', () => {
    const existing = [{ id: 'a', sourcePath: '/watch/A' }];
    expect(validateMapping({ id: 'a', sourcePath: '/watch/A' }, existing, dataDir)).toBe(null);
  });

  // Target (Zotero-side) collisions — Mode 2/3 routing.
  it('rejects a second whole-library mapping on the same library', () => {
    const existing = [{ id: 'a', sourcePath: '/watch/A', scopeMode: 'library', syncRootLibraryID: 1 }];
    const reason = validateMapping(
      { id: 'b', sourcePath: '/watch/B', scopeMode: 'library', syncRootLibraryID: 1 }, existing, dataDir);
    expect(reason).toMatch(/whole library/i);
  });
  it('rejects two mappings targeting the EXACT same collection', () => {
    const existing = [{ id: 'a', sourcePath: '/watch/A', scopeMode: 'collection', syncRootCollectionKey: 'COLL1234', syncRootLibraryID: 1 }];
    const reason = validateMapping(
      { id: 'b', sourcePath: '/watch/B', scopeMode: 'collection', syncRootCollectionKey: 'COLL1234', syncRootLibraryID: 1 }, existing, dataDir);
    expect(reason).toMatch(/exact same collection|already syncs this collection/i);
  });
  it('ALLOWS nested collection targets (nearest-ancestor auto-pick)', () => {
    const existing = [{ id: 'a', sourcePath: '/watch/A', scopeMode: 'collection', syncRootCollectionKey: 'PARENT00', syncRootLibraryID: 1 }];
    expect(validateMapping(
      { id: 'b', sourcePath: '/watch/B', scopeMode: 'collection', syncRootCollectionKey: 'CHILD000', syncRootLibraryID: 1 }, existing, dataDir)).toBe(null);
  });
  it('ALLOWS a collection-scope mapping alongside a whole-library mapping', () => {
    const existing = [{ id: 'a', sourcePath: '/watch/A', scopeMode: 'library', syncRootLibraryID: 1 }];
    expect(validateMapping(
      { id: 'b', sourcePath: '/watch/B', scopeMode: 'collection', syncRootCollectionKey: 'COLL1234', syncRootLibraryID: 1 }, existing, dataDir)).toBe(null);
  });
  it('ALLOWS the same collection key in DIFFERENT libraries', () => {
    const existing = [{ id: 'a', sourcePath: '/watch/A', scopeMode: 'collection', syncRootCollectionKey: 'COLL1234', syncRootLibraryID: 1 }];
    expect(validateMapping(
      { id: 'b', sourcePath: '/watch/B', scopeMode: 'collection', syncRootCollectionKey: 'COLL1234', syncRootLibraryID: 5 }, existing, dataDir)).toBe(null);
  });
});

// ─── UT-M7 ───────────────────────────────────────────────────────────────
describe('UT-M7: readMappings / writeMappings', () => {
  it('round-trips the mappings array through the pref', () => {
    installPrefs({});
    const mappings = [{ id: 'a', sourcePath: '/A' }, { id: 'b', sourcePath: '/B' }];
    writeMappings(mappings);
    expect(readMappings()).toEqual(mappings);
  });
  it('returns [] on a malformed pref', () => {
    installPrefs({ watchMappings: '{not an array}' });
    expect(readMappings()).toEqual([]);
  });
});

// ─── UT-M8 ───────────────────────────────────────────────────────────────
describe('UT-M8: mintMappingId', () => {
  it('returns a non-empty string', () => {
    installPrefs({});
    const id = mintMappingId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });
});

// ─── UT-M9 ───────────────────────────────────────────────────────────────
describe('UT-M9: effectiveGlobalMode (folder-list clamp)', () => {
  it('single-root (multi off) returns the configured mode verbatim', () => {
    installPrefs({ mode: 'mode3' });
    expect(effectiveGlobalMode()).toBe('mode3');
    installPrefs({ mode: 'mode2' });
    expect(effectiveGlobalMode()).toBe('mode2');
  });
  it('defaults to mode1 when unset', () => {
    installPrefs({});
    expect(effectiveGlobalMode()).toBe('mode1');
  });
  it('multi active keeps mode1 and mode2 as-is', () => {
    installPrefs({ watchMappingsMulti: true, mode: 'mode1' });
    expect(effectiveGlobalMode()).toBe('mode1');
    installPrefs({ watchMappingsMulti: true, mode: 'mode2' });
    expect(effectiveGlobalMode()).toBe('mode2');
  });
  it('multi active CLAMPS mode3 → mode2 (deletes deferred to Stage B)', () => {
    installPrefs({ watchMappingsMulti: true, mode: 'mode3' });
    expect(effectiveGlobalMode()).toBe('mode2');
  });
});
