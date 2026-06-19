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
// Mock the missing-file classifier so tests deterministically control disk
// presence (the engine now uses classifyMissingFile, not bare IOUtils.exists).
// NB: the factory is hoisted, so it can't reference outer consts — inline the
// classification strings here; the MC alias below is for the test bodies.
vi.mock('../../content/fileMissing.mjs', () => ({
  isWatchRootAvailable: vi.fn(async () => true),
  classifyMissingFile: vi.fn(async () => 'still-exists'),
  MISSING_CLASSIFICATION: { STILL_EXISTS: 'still-exists', USER_DELETED: 'user-deleted', CLOUD_PLACEHOLDER: 'cloud-placeholder', PERMISSION_DENIED: 'permission-denied', DRIVE_DISCONNECTED: 'drive-disconnected' },
}));
const MC = { STILL_EXISTS: 'still-exists', USER_DELETED: 'user-deleted', CLOUD_PLACEHOLDER: 'cloud-placeholder', PERMISSION_DENIED: 'permission-denied', DRIVE_DISCONNECTED: 'drive-disconnected' };

import * as reconcile from '../../content/reconcile.mjs';
import { resolveSyncRoot, relativePathToCollection } from '../../content/canonicalPath.mjs';
import { getTrackingStore } from '../../content/trackingStore.mjs';
import { isWatchRootAvailable, classifyMissingFile } from '../../content/fileMissing.mjs';

// Drive classifyMissingFile: paths in `gonePaths` (absolute) → USER_DELETED.
function setGone(gonePaths) {
  const gone = new Set(gonePaths);
  classifyMissingFile.mockImplementation(async (abs) => gone.has(abs) ? MC.USER_DELETED : MC.STILL_EXISTS);
}

function makeStore(files = [], collections = []) {
  const byPath = new Map(files.map((f) => [f.localPath, f]));
  return {
    _files: files, _collections: collections,
    getAllOfType: vi.fn((t) => t === 'file' ? files.slice() : t === 'collection' ? collections.slice() : []),
    getByLocalPath: vi.fn((lp) => byPath.get(lp) || null),
    getCollectionRecord: vi.fn((k) => collections.find((c) => c.zoteroCollectionKey === k) || null),
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
  isWatchRootAvailable.mockResolvedValue(true);
  classifyMissingFile.mockImplementation(async () => MC.STILL_EXISTS); // present unless a test marks gone
});

// ─── UT-RC-1 ─────────────────────────────────────────────────────────────────
describe('UT-RC-1: countAnnotationsNotes', () => {
  it('counts the attachment OWN annotations + notes (M3: not the parent\'s)', () => {
    const att = { getAnnotations: () => [{}, {}, {}], getNotes: () => [{}] };
    expect(reconcile.countAnnotationsNotes(att)).toEqual({ annotations: 3, notes: 1, unknown: false });
  });
  it('fails OPEN to unknown when getAnnotations throws', () => {
    expect(reconcile.countAnnotationsNotes({ getAnnotations: () => { throw new Error('x'); }, getNotes: () => [] }).unknown).toBe(true);
  });
  it('M4: fails OPEN to unknown when getAnnotations/getNotes is MISSING (not just on throw)', () => {
    expect(reconcile.countAnnotationsNotes({}).unknown).toBe(true); // no methods
  });
  it('M4: fails OPEN when a getter returns a non-array', () => {
    expect(reconcile.countAnnotationsNotes({ getAnnotations: () => null, getNotes: () => [] }).unknown).toBe(true);
  });
  it('zero (known) for an attachment whose methods return empty arrays', () => {
    expect(reconcile.countAnnotationsNotes({ getAnnotations: () => [], getNotes: () => [] })).toEqual({ annotations: 0, notes: 0, unknown: false });
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
    setGone(['/watch/a.pdf']); // canonical (root) gone; shadow (Topics) present
    globalThis.Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async () => ({
      key: 'K1', deleted: false, getAnnotations: () => [], getNotes: () => [],
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
    setGone(['/watch/ghost.pdf']);
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
    setGone(['/watch/p.pdf']); // canonical gone; Topics/p.pdf present
    globalThis.IOUtils.exists = vi.fn(async (p) => p === '/watch/Untitled Folder'); // folder check (collection loop)
    globalThis.Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async () => ({
      key: 'K1', deleted: false, getAnnotations: () => [{}, {}], getNotes: () => [],
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
  it('rehome: promotes the survivor, re-points other shadows, drops the dead canonical, adds membership', async () => {
    const store = makeStore([
      fileRec({ localPath: 'a.pdf', canonicalLocalPath: 'a.pdf', key: 'K1' }),
      fileRec({ localPath: 'Topics/a.pdf', canonicalLocalPath: 'a.pdf', key: 'K1' }),
      fileRec({ localPath: 'More/a.pdf', canonicalLocalPath: 'a.pdf', key: 'K1' }), // 2nd survivor (C4)
    ]);
    getTrackingStore.mockReturnValue(store);
    setGone(['/watch/a.pdf']); // canonical gone; survivors present
    const owner = { getCollections: () => [], addToCollection: vi.fn(), saveTx: vi.fn(async () => {}) };
    globalThis.Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async () => ({ key: 'K1', parentItem: owner }));
    relativePathToCollection.mockResolvedValue({ id: 99, key: 'COLT' });

    const findings = [{
      id: 'f0', type: reconcile.FINDING.SHADOW_ORPHANED, defaultActionId: 'rehome',
      _payload: { attKey: 'K1', survivingLocalPath: 'Topics/a.pdf', allSurvivingLocalPaths: ['Topics/a.pdf', 'More/a.pdf'], folderRel: 'Topics', canonicalLocalPath: 'a.pdf' },
    }];
    const res = await reconcile.applyRepairs(findings, { f0: 'rehome' });
    expect(res.applied).toBe(1);
    expect(store.update).toHaveBeenCalledWith('Topics/a.pdf', expect.objectContaining({
      canonicalLocalPath: 'Topics/a.pdf', canonicalCollectionKey: 'COLT', state: 'clean',
    }));
    expect(store.update).toHaveBeenCalledWith('More/a.pdf', { canonicalLocalPath: 'Topics/a.pdf' }); // C4
    expect(store.remove).toHaveBeenCalledWith('a.pdf');     // dead canonical dropped AFTER promote
    expect(owner.addToCollection).toHaveBeenCalledWith(99);
  });

  it('C2: rehome ABORTS (no mutation) if the canonical file reappeared before apply', async () => {
    const store = makeStore([
      fileRec({ localPath: 'a.pdf', canonicalLocalPath: 'a.pdf', key: 'K1' }),
      fileRec({ localPath: 'Topics/a.pdf', canonicalLocalPath: 'a.pdf', key: 'K1' }),
    ]);
    getTrackingStore.mockReturnValue(store);
    setGone([]); // NOTHING gone now (canonical came back)
    const findings = [{
      id: 'f0', type: reconcile.FINDING.SHADOW_ORPHANED, defaultActionId: 'rehome',
      _payload: { attKey: 'K1', survivingLocalPath: 'Topics/a.pdf', allSurvivingLocalPaths: ['Topics/a.pdf'], folderRel: 'Topics', canonicalLocalPath: 'a.pdf' },
    }];
    const res = await reconcile.applyRepairs(findings, { f0: 'rehome' });
    expect(res.applied).toBe(0);
    expect(res.failed).toBe(1);
    expect(store.remove).not.toHaveBeenCalled();
    expect(store.update).not.toHaveBeenCalled();
  });

  it('drop: removes the stale entries when STILL gone from disk + Zotero', async () => {
    const store = makeStore([fileRec({ localPath: 'ghost.pdf', key: 'GH' })]);
    getTrackingStore.mockReturnValue(store);
    setGone(['/watch/ghost.pdf']);
    globalThis.Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async () => null);
    const findings = [{ id: 'f0', type: reconcile.FINDING.ORPHAN_TRACKING, defaultActionId: 'drop', _payload: { attKey: 'GH', localPaths: ['ghost.pdf'] } }];
    const res = await reconcile.applyRepairs(findings, { f0: 'drop' });
    expect(res.applied).toBe(1);
    expect(store.remove).toHaveBeenCalledWith('ghost.pdf');
  });

  it('C2: drop ABORTS if the file reappeared (avoids the re-import loop)', async () => {
    const store = makeStore([fileRec({ localPath: 'ghost.pdf', key: 'GH' })]);
    getTrackingStore.mockReturnValue(store);
    setGone([]); // file is back
    globalThis.Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async () => null);
    const findings = [{ id: 'f0', type: reconcile.FINDING.ORPHAN_TRACKING, defaultActionId: 'drop', _payload: { attKey: 'GH', localPaths: ['ghost.pdf'] } }];
    const res = await reconcile.applyRepairs(findings, { f0: 'drop' });
    expect(res.failed).toBe(1);
    expect(store.remove).not.toHaveBeenCalled();
  });

  it('cleanup: removes the stale collection record when STILL dead-state', async () => {
    const store = makeStore([], [{ type: 'collection', localPath: 'X', zoteroCollectionKey: 'DEADK', state: 'out-of-scope-suppressed' }]);
    getTrackingStore.mockReturnValue(store);
    const findings = [{ id: 'f0', type: reconcile.FINDING.STALE_COLLECTION, defaultActionId: 'cleanup', _payload: { zoteroCollectionKey: 'DEADK' } }];
    const res = await reconcile.applyRepairs(findings, { f0: 'cleanup' });
    expect(res.applied).toBe(1);
    expect(store.removeCollectionRecord).toHaveBeenCalledWith('DEADK');
  });

  it('C2: cleanup ABORTS if the record went live again', async () => {
    const store = makeStore([], [{ type: 'collection', localPath: 'X', zoteroCollectionKey: 'DEADK', state: 'clean' }]);
    getTrackingStore.mockReturnValue(store);
    const findings = [{ id: 'f0', type: reconcile.FINDING.STALE_COLLECTION, defaultActionId: 'cleanup', _payload: { zoteroCollectionKey: 'DEADK' } }];
    const res = await reconcile.applyRepairs(findings, { f0: 'cleanup' });
    expect(res.failed).toBe(1);
    expect(store.removeCollectionRecord).not.toHaveBeenCalled();
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

  it('refuses to apply against an unavailable watch root (C1/C2)', async () => {
    getTrackingStore.mockReturnValue(makeStore());
    isWatchRootAvailable.mockResolvedValue(false);
    const res = await reconcile.applyRepairs([{ id: 'f0', type: reconcile.FINDING.ORPHAN_TRACKING, defaultActionId: 'drop', _payload: { localPaths: ['x'] } }], {});
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('watch-root-unavailable');
  });
});

// ─── UT-RC-7: watch-root guard + M1 (detached not promoted) ─────────────────
describe('UT-RC-7: detect guards', () => {
  it('C1: returns watch-root-unavailable and no findings when the root is down', async () => {
    getTrackingStore.mockReturnValue(makeStore([fileRec({ localPath: 'a.pdf', key: 'K1' })]));
    isWatchRootAvailable.mockResolvedValue(false);
    const r = await reconcile.detect();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('watch-root-unavailable');
    expect(r.findings).toEqual([]);
  });

  it('M1: a USER_DETACHED on-disk copy is NOT offered as a rehome survivor', async () => {
    const store = makeStore([
      fileRec({ localPath: 'a.pdf', canonicalLocalPath: 'a.pdf', key: 'K1' }),
      fileRec({ localPath: 'Topics/a.pdf', canonicalLocalPath: 'a.pdf', key: 'K1', state: 'user-detached' }),
    ]);
    getTrackingStore.mockReturnValue(store);
    setGone(['/watch/a.pdf']); // canonical gone; the only other copy is USER_DETACHED
    globalThis.Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async () => ({ key: 'K1', deleted: false, getAnnotations: () => [], getNotes: () => [] }));
    const r = await reconcile.detect();
    expect(r.findings.find((x) => x.type === reconcile.FINDING.SHADOW_ORPHANED)).toBeUndefined();
  });
});
