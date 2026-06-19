/**
 * Unit tests for content/reconcile.mjs (Check & Repair engine, v2.8).
 *
 * Covers:
 *   UT-RC-1 countAnnotationsNotes (counts + fail-open unknown)
 *   UT-RC-2 detect: shadow-orphaned (canonical gone, shadow survives) → rehome
 *   UT-RC-3 detect: stale dead-state collection record blocking a live folder
 *   UT-RC-4 detect: orphan tracking (gone from disk AND Zotero) → drop
 *   UT-RC-5 detect: high-value (annotated) findings sort to the top
 *   UT-RC-6 applyRepairs: rehome / drop / cleanup / skip
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../content/utils.mjs', async () => {
  const actual = await vi.importActual('../../content/utils.mjs');
  return { ...actual, getPref: vi.fn(() => '/watch') };
});
vi.mock('../../content/canonicalPath.mjs', async () => {
  const actual = await vi.importActual('../../content/canonicalPath.mjs');
  return {
    ...actual,
    resolveSyncRoot: vi.fn(async () => ({ collection: null, libraryID: 1, isLibraryRoot: true })),
    relativePathToCollection: vi.fn(),
    collectionKeyToDiskRelativePath: vi.fn(),
  };
});
vi.mock('../../content/trackingStore.mjs', async () => {
  const actual = await vi.importActual('../../content/trackingStore.mjs');
  return { ...actual, getTrackingStore: vi.fn() };
});

import * as reconcile from '../../content/reconcile.mjs';
import { resolveSyncRoot, relativePathToCollection } from '../../content/canonicalPath.mjs';
import { getTrackingStore } from '../../content/trackingStore.mjs';

function makeStore(files = [], collections = []) {
  return {
    _files: files, _collections: collections,
    getAllOfType: vi.fn((t) => t === 'file' ? files.slice() : t === 'collection' ? collections.slice() : []),
    remove: vi.fn(),
    removeCollectionRecord: vi.fn(),
    update: vi.fn(),
    save: vi.fn(async () => {}),
  };
}

function fileRec(opts) {
  return {
    type: 'file',
    localPath: opts.localPath,
    canonicalLocalPath: opts.canonicalLocalPath ?? opts.localPath,
    zoteroAttachmentKey: opts.key,
    canonicalCollectionKey: opts.canonicalCollectionKey ?? null,
    state: opts.state ?? 'clean',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.Zotero = globalThis.Zotero || {};
  globalThis.Zotero.debug = vi.fn();
  globalThis.Zotero.logError = vi.fn();
  globalThis.Zotero.Libraries = { userLibraryID: 1 };
  globalThis.Zotero.Items = { getByLibraryAndKeyAsync: vi.fn(async () => null) };
  globalThis.PathUtils = {
    join: (...p) => p.join('/'),
  };
  globalThis.IOUtils = { exists: vi.fn(async () => false) };
  resolveSyncRoot.mockResolvedValue({ collection: null, libraryID: 1, isLibraryRoot: true });
});

// ─── UT-RC-1 ─────────────────────────────────────────────────────────────────
describe('UT-RC-1: countAnnotationsNotes', () => {
  it('counts annotations and parent notes', () => {
    const att = {
      getAnnotations: () => [{}, {}, {}],
      parentItem: { getNotes: () => [{}] },
    };
    expect(reconcile.countAnnotationsNotes(att)).toEqual({ annotations: 3, notes: 1, unknown: false });
  });
  it('fails OPEN to unknown when getAnnotations throws', () => {
    const att = { getAnnotations: () => { throw new Error('x'); } };
    const r = reconcile.countAnnotationsNotes(att);
    expect(r.unknown).toBe(true);
  });
  it('zero for a plain attachment with no children', () => {
    expect(reconcile.countAnnotationsNotes({ getAnnotations: () => [] })).toEqual({ annotations: 0, notes: 0, unknown: false });
  });
});

// ─── UT-RC-2 ─────────────────────────────────────────────────────────────────
describe('UT-RC-2: shadow-orphaned detection', () => {
  it('flags a re-home when the canonical file is gone but a shadow survives', async () => {
    const store = makeStore([
      fileRec({ localPath: 'a.pdf', canonicalLocalPath: 'a.pdf', key: 'K1' }),          // canonical (root)
      fileRec({ localPath: 'Topics/a.pdf', canonicalLocalPath: 'a.pdf', key: 'K1' }),    // shadow (Topics)
    ]);
    getTrackingStore.mockReturnValue(store);
    // canonical (root a.pdf) missing; shadow (Topics/a.pdf) present
    globalThis.IOUtils.exists = vi.fn(async (p) => p === '/watch/Topics/a.pdf');
    globalThis.Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async () => ({
      key: 'K1', deleted: false, getAnnotations: () => [], parentItem: null,
    }));

    const r = await reconcile.detect();
    expect(r.ok).toBe(true);
    const f = r.findings.find((x) => x.type === reconcile.FINDING.SHADOW_ORPHANED);
    expect(f).toBeDefined();
    expect(f.defaultActionId).toBe('rehome');
    expect(f._payload.survivingLocalPath).toBe('Topics/a.pdf');
    expect(f._payload.folderRel).toBe('Topics');
  });
});

// ─── UT-RC-3 ─────────────────────────────────────────────────────────────────
describe('UT-RC-3: stale collection record blocking a live folder', () => {
  it('flags a dead-state collection record whose folder is back on disk', async () => {
    const store = makeStore([], [
      { type: 'collection', localPath: 'Untitled Folder', zoteroCollectionKey: 'DEADK', state: 'out-of-scope-suppressed' },
    ]);
    getTrackingStore.mockReturnValue(store);
    globalThis.IOUtils.exists = vi.fn(async (p) => p === '/watch/Untitled Folder');

    const r = await reconcile.detect();
    const f = r.findings.find((x) => x.type === reconcile.FINDING.STALE_COLLECTION);
    expect(f).toBeDefined();
    expect(f.defaultActionId).toBe('cleanup');
    expect(f._payload.zoteroCollectionKey).toBe('DEADK');
  });

  it('does NOT flag a dead record whose folder is gone from disk', async () => {
    const store = makeStore([], [
      { type: 'collection', localPath: 'Gone', zoteroCollectionKey: 'G', state: 'out-of-scope-suppressed' },
    ]);
    getTrackingStore.mockReturnValue(store);
    globalThis.IOUtils.exists = vi.fn(async () => false);
    const r = await reconcile.detect();
    expect(r.findings.find((x) => x.type === reconcile.FINDING.STALE_COLLECTION)).toBeUndefined();
  });
});

// ─── UT-RC-4 ─────────────────────────────────────────────────────────────────
describe('UT-RC-4: orphan tracking (gone from disk AND Zotero)', () => {
  it('flags a drop when nothing exists on disk and the item is gone', async () => {
    const store = makeStore([fileRec({ localPath: 'ghost.pdf', key: 'GH' })]);
    getTrackingStore.mockReturnValue(store);
    globalThis.IOUtils.exists = vi.fn(async () => false);
    globalThis.Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async () => null);
    const r = await reconcile.detect();
    const f = r.findings.find((x) => x.type === reconcile.FINDING.ORPHAN_TRACKING);
    expect(f).toBeDefined();
    expect(f.defaultActionId).toBe('drop');
  });
});

// ─── UT-RC-5 ─────────────────────────────────────────────────────────────────
describe('UT-RC-5: high-value items sort first', () => {
  it('an annotated shadow-orphan sorts above a non-annotated stale record', async () => {
    const store = makeStore(
      [
        fileRec({ localPath: 'p.pdf', canonicalLocalPath: 'p.pdf', key: 'K1' }),
        fileRec({ localPath: 'Topics/p.pdf', canonicalLocalPath: 'p.pdf', key: 'K1' }),
      ],
      [{ type: 'collection', localPath: 'Untitled Folder', zoteroCollectionKey: 'D', state: 'missing' }],
    );
    getTrackingStore.mockReturnValue(store);
    globalThis.IOUtils.exists = vi.fn(async (p) => p === '/watch/Topics/p.pdf' || p === '/watch/Untitled Folder');
    globalThis.Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async () => ({
      key: 'K1', deleted: false, getAnnotations: () => [{}, {}], parentItem: { getNotes: () => [] },
    }));
    const r = await reconcile.detect();
    expect(r.findings.length).toBeGreaterThanOrEqual(2);
    expect(r.findings[0].highValue).toBe(true);
    expect(r.findings[0].type).toBe(reconcile.FINDING.SHADOW_ORPHANED);
    expect(r.highValueCount).toBe(1);
  });
});

// ─── UT-RC-6 ─────────────────────────────────────────────────────────────────
describe('UT-RC-6: applyRepairs', () => {
  it('rehome: drops the dead canonical, adds the folder collection, promotes the shadow', async () => {
    const store = makeStore();
    getTrackingStore.mockReturnValue(store);
    const owner = { getCollections: () => [], addToCollection: vi.fn(), saveTx: vi.fn(async () => {}) };
    globalThis.Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async () => ({ key: 'K1', parentItem: owner }));
    relativePathToCollection.mockResolvedValue({ id: 99, key: 'COLT' });

    const findings = [{
      id: 'f0', type: reconcile.FINDING.SHADOW_ORPHANED, defaultActionId: 'rehome',
      _payload: { attKey: 'K1', survivingLocalPath: 'Topics/a.pdf', folderRel: 'Topics', canonicalLocalPath: 'a.pdf' },
    }];
    const res = await reconcile.applyRepairs(findings, { f0: 'rehome' });
    expect(res.applied).toBe(1);
    expect(store.remove).toHaveBeenCalledWith('a.pdf');           // dead canonical dropped
    expect(owner.addToCollection).toHaveBeenCalledWith(99);        // membership added
    expect(store.update).toHaveBeenCalledWith('Topics/a.pdf', expect.objectContaining({
      canonicalLocalPath: 'Topics/a.pdf', canonicalCollectionKey: 'COLT', state: 'clean',
    }));
  });

  it('drop: removes the stale tracking entries', async () => {
    const store = makeStore();
    getTrackingStore.mockReturnValue(store);
    const findings = [{ id: 'f0', type: reconcile.FINDING.ORPHAN_TRACKING, defaultActionId: 'drop', _payload: { attKey: 'GH', localPaths: ['ghost.pdf'] } }];
    const res = await reconcile.applyRepairs(findings, { f0: 'drop' });
    expect(res.applied).toBe(1);
    expect(store.remove).toHaveBeenCalledWith('ghost.pdf');
  });

  it('cleanup: removes the stale collection record', async () => {
    const store = makeStore();
    getTrackingStore.mockReturnValue(store);
    const findings = [{ id: 'f0', type: reconcile.FINDING.STALE_COLLECTION, defaultActionId: 'cleanup', _payload: { zoteroCollectionKey: 'DEADK' } }];
    const res = await reconcile.applyRepairs(findings, { f0: 'cleanup' });
    expect(res.applied).toBe(1);
    expect(store.removeCollectionRecord).toHaveBeenCalledWith('DEADK');
  });

  it('skip: does nothing and counts as skipped', async () => {
    const store = makeStore();
    getTrackingStore.mockReturnValue(store);
    const findings = [{ id: 'f0', type: reconcile.FINDING.STALE_COLLECTION, defaultActionId: 'cleanup', _payload: { zoteroCollectionKey: 'X' } }];
    const res = await reconcile.applyRepairs(findings, { f0: 'skip' });
    expect(res.skipped).toBe(1);
    expect(res.applied).toBe(0);
    expect(store.removeCollectionRecord).not.toHaveBeenCalled();
  });
});
