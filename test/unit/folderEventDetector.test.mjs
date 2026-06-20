/**
 * Unit tests for content/folderEventDetector.mjs (v2.1 Phase A2).
 *
 * Covers:
 *   UT-601 emits deleteFolder for tracked collections missing on disk
 *   UT-602 leaves on-disk tracked collections alone
 *   UT-603 falls back to IOUtils.exists when dir set is incomplete
 *   UT-604 absolute-path records work the same as relative (idempotent _toAbs)
 *   UT-605 no-op when there are no collection records
 *   UT-606 tolerates falsy / malformed records
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../content/mirrorExecutor.mjs', () => ({
  execute: vi.fn(async () => ({ ok: true })),
}));

// SYNC-1: the detector now imports isWatchRootAvailable from fileMissing.mjs
// to bail early on an unreachable root. Default to true so the existing
// UT-601..606 deletion scenarios still run; UT-607a overrides per-test.
vi.mock('../../content/fileMissing.mjs', () => ({
  isWatchRootAvailable: vi.fn(async () => true),
}));

// Keep the real collapse/aggregate logic, but spy recordHealthyFingerprint so
// tests can assert WHEN the healthy baseline is (not) refreshed — the
// drip-eviction guard hinges on suppressing that refresh on a dirty cycle.
vi.mock('../../content/watchRootGuard.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, recordHealthyFingerprint: vi.fn(actual.recordHealthyFingerprint) };
});

import * as mirrorExecutor from '../../content/mirrorExecutor.mjs';
import { isWatchRootAvailable } from '../../content/fileMissing.mjs';
import { recordHealthyFingerprint } from '../../content/watchRootGuard.mjs';
import { detectFolderEvents } from '../../content/folderEventDetector.mjs';

function makeStore(records = []) {
  return {
    getAllOfType: vi.fn((type) => (type === 'collection' ? records.slice() : [])),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  Zotero.debug = vi.fn();
  Zotero.logError = vi.fn();
  IOUtils.exists = vi.fn(async () => false);
  // Restore the default available-root behavior after clearAllMocks wiped
  // any per-test mockResolvedValueOnce/mockImplementation.
  isWatchRootAvailable.mockResolvedValue(true);
});

// ─── UT-601 ────────────────────────────────────────────────────────────────

describe('UT-601: emits deleteFolder for missing-on-disk records', () => {
  it('emits one deleteFolder per missing record', async () => {
    const records = [
      { type: 'collection', zoteroCollectionKey: 'A', localPath: 'Methods', state: 'clean' },
      { type: 'collection', zoteroCollectionKey: 'B', localPath: 'Inbox', state: 'clean' },
    ];
    const onDiskAbsDirs = new Set(['/watch']);
    await detectFolderEvents({ trackingStore: makeStore(records), onDiskAbsDirs, watchRoot: '/watch' });

    const calls = mirrorExecutor.execute.mock.calls.map((c) => c[0]);
    expect(calls.length).toBe(2);
    expect(calls.map((c) => c.payload.collectionKey).sort()).toEqual(['A', 'B']);
    expect(calls.every((c) => c.type === 'localFolderDeleted')).toBe(true);
  });
});

// ─── UT-602 ────────────────────────────────────────────────────────────────

describe('UT-602: on-disk records are left alone', () => {
  it('does not emit when the record path is in the disk set', async () => {
    const records = [
      { type: 'collection', zoteroCollectionKey: 'A', localPath: 'Methods', state: 'clean' },
    ];
    const onDiskAbsDirs = new Set(['/watch', '/watch/Methods']);
    await detectFolderEvents({ trackingStore: makeStore(records), onDiskAbsDirs, watchRoot: '/watch' });
    expect(mirrorExecutor.execute).not.toHaveBeenCalled();
  });

  it('handles nested paths under the watch root', async () => {
    const records = [
      { type: 'collection', zoteroCollectionKey: 'A', localPath: 'Methods/Sub', state: 'clean' },
    ];
    const onDiskAbsDirs = new Set(['/watch', '/watch/Methods', '/watch/Methods/Sub']);
    await detectFolderEvents({ trackingStore: makeStore(records), onDiskAbsDirs, watchRoot: '/watch' });
    expect(mirrorExecutor.execute).not.toHaveBeenCalled();
  });
});

// ─── UT-603 ────────────────────────────────────────────────────────────────

describe('UT-603: IOUtils.exists fallback when dir set is incomplete', () => {
  it('checks IOUtils.exists when the path is missing from the supplied set', async () => {
    const records = [
      { type: 'collection', zoteroCollectionKey: 'A', localPath: 'Deep/Nested/Path', state: 'clean' },
    ];
    IOUtils.exists.mockResolvedValueOnce(true);
    await detectFolderEvents({
      trackingStore: makeStore(records),
      onDiskAbsDirs: new Set(['/watch']),
      watchRoot: '/watch',
    });
    expect(IOUtils.exists).toHaveBeenCalledWith('/watch/Deep/Nested/Path');
    expect(mirrorExecutor.execute).not.toHaveBeenCalled();
  });

  it('emits deleteFolder when both set and IOUtils.exists agree the dir is gone', async () => {
    const records = [
      { type: 'collection', zoteroCollectionKey: 'A', localPath: 'X', state: 'clean' },
    ];
    IOUtils.exists.mockResolvedValueOnce(false);
    await detectFolderEvents({
      trackingStore: makeStore(records),
      onDiskAbsDirs: new Set(['/watch']),
      watchRoot: '/watch',
    });
    expect(mirrorExecutor.execute).toHaveBeenCalledTimes(1);
  });
});

// ─── UT-604 ────────────────────────────────────────────────────────────────

describe('UT-604: absolute-path records work via idempotent _toAbs', () => {
  it('emits deleteFolder when the legacy absolute path is missing on disk', async () => {
    const records = [
      { type: 'collection', zoteroCollectionKey: 'V1', localPath: '/watch/V1Path', state: 'clean' },
    ];
    await detectFolderEvents({
      trackingStore: makeStore(records),
      onDiskAbsDirs: new Set(['/watch']),
      watchRoot: '/watch',
    });
    // Now that the schema-drift skip is gone, the detector resolves
    // /watch/V1Path → /watch/V1Path (idempotent), sees it's NOT in the
    // dirSet + fallback exists returns false → emits localFolderDeleted.
    expect(mirrorExecutor.execute).toHaveBeenCalledTimes(1);
    expect(mirrorExecutor.execute.mock.calls[0][0]).toMatchObject({
      type: 'localFolderDeleted',
      payload: { collectionKey: 'V1' },
    });
  });

  it('does NOT emit when the absolute path is in the dirSet', async () => {
    const records = [
      { type: 'collection', zoteroCollectionKey: 'V1', localPath: '/watch/V1Path', state: 'clean' },
    ];
    await detectFolderEvents({
      trackingStore: makeStore(records),
      onDiskAbsDirs: new Set(['/watch', '/watch/V1Path']),
      watchRoot: '/watch',
    });
    expect(mirrorExecutor.execute).not.toHaveBeenCalled();
  });
});

// ─── UT-605 ────────────────────────────────────────────────────────────────

describe('UT-605: no-op for empty record set', () => {
  it('does nothing when there are no collection records', async () => {
    await detectFolderEvents({
      trackingStore: makeStore([]),
      onDiskAbsDirs: new Set(['/watch']),
      watchRoot: '/watch',
    });
    expect(mirrorExecutor.execute).not.toHaveBeenCalled();
  });

  it('returns early when watchRoot is falsy', async () => {
    await detectFolderEvents({
      trackingStore: makeStore([{ type: 'collection', zoteroCollectionKey: 'A', localPath: 'X' }]),
      onDiskAbsDirs: new Set(),
      watchRoot: '',
    });
    expect(mirrorExecutor.execute).not.toHaveBeenCalled();
  });
});

// ─── UT-607 (review fix) ───────────────────────────────────────────────────

describe('UT-607: skips records already in OUT_OF_SCOPE_SUPPRESSED', () => {
  it('does not re-emit deleteFolder for an already-suppressed collection record', async () => {
    const records = [
      { type: 'collection', zoteroCollectionKey: 'A', localPath: 'X', state: 'out-of-scope-suppressed' },
    ];
    await detectFolderEvents({
      trackingStore: makeStore(records),
      onDiskAbsDirs: new Set(['/watch']),
      watchRoot: '/watch',
    });
    // Core guarantee: a suppressed record is never RE-EMITTED to the executor.
    // (Its disk presence may be consulted by the drip-eviction fingerprint
    // guard below — that's covered by UT-607c, not asserted here.)
    expect(mirrorExecutor.execute).not.toHaveBeenCalled();
  });

  it('still emits for non-suppressed records', async () => {
    const records = [
      { type: 'collection', zoteroCollectionKey: 'A', localPath: 'X', state: 'clean' },
      { type: 'collection', zoteroCollectionKey: 'B', localPath: 'Y', state: 'out-of-scope-suppressed' },
    ];
    await detectFolderEvents({
      trackingStore: makeStore(records),
      onDiskAbsDirs: new Set(['/watch']),
      watchRoot: '/watch',
    });
    expect(mirrorExecutor.execute).toHaveBeenCalledTimes(1);
    expect(mirrorExecutor.execute.mock.calls[0][0].payload.collectionKey).toBe('A');
  });
});

// ─── UT-607c (drip-eviction fingerprint guard) ─────────────────────────────
// Phase 1 skips OUT_OF_SCOPE_SUPPRESSED records for emit-idempotency, so a
// top-level folder evicted-then-suppressed drops out of `missing` and the
// cycle LOOKS clean. Refreshing the healthy fingerprint on such a cycle would
// ratchet the collapse baseline down one folder at a time, letting a gradual
// cloud-eviction slip past the >50% collapse gate. The fix: don't refresh the
// fingerprint while a suppressed top-level folder is missing from disk.
describe('UT-607c: drip-eviction fingerprint guard', () => {
  it('does NOT refresh the healthy fingerprint when a suppressed top-level folder is gone from disk', async () => {
    const records = [
      { type: 'collection', zoteroCollectionKey: 'A', localPath: 'X', state: 'out-of-scope-suppressed' },
    ];
    // Disk shows the root only; the suppressed folder X is gone (IOUtils.exists
    // defaults to false). missing.length===0 (suppressed skipped), but the
    // drip-guard must keep the baseline stale.
    await detectFolderEvents({
      trackingStore: makeStore(records),
      onDiskAbsDirs: new Set(['/watch']),
      watchRoot: '/watch',
    });
    expect(mirrorExecutor.execute).not.toHaveBeenCalled();
    expect(recordHealthyFingerprint).not.toHaveBeenCalled();
  });

  it('DOES refresh the fingerprint when the suppressed folder is still present on disk', async () => {
    const records = [
      { type: 'collection', zoteroCollectionKey: 'A', localPath: 'X', state: 'out-of-scope-suppressed' },
    ];
    // Suppression normally keeps the local folder in place — a clean cycle.
    await detectFolderEvents({
      trackingStore: makeStore(records),
      onDiskAbsDirs: new Set(['/watch', '/watch/X']),
      watchRoot: '/watch',
    });
    expect(mirrorExecutor.execute).not.toHaveBeenCalled();
    expect(recordHealthyFingerprint).toHaveBeenCalledTimes(1);
  });

  it('does NOT refresh while a non-suppressed (still-missing) folder is being reconciled', async () => {
    const records = [
      { type: 'collection', zoteroCollectionKey: 'A', localPath: 'X', state: 'clean' },
    ];
    // X is gone from disk and still CLEAN → it's in `missing`, an unclean cycle.
    await detectFolderEvents({
      trackingStore: makeStore(records),
      onDiskAbsDirs: new Set(['/watch']),
      watchRoot: '/watch',
    });
    expect(recordHealthyFingerprint).not.toHaveBeenCalled();
  });
});

// ─── UT-607a / UT-607b (SYNC-1) ────────────────────────────────────────────

describe('UT-607a: bails when the watch root is unavailable', () => {
  it('emits zero deleteFolder actions despite missing-on-disk records', async () => {
    isWatchRootAvailable.mockResolvedValue(false);
    const records = [
      { type: 'collection', zoteroCollectionKey: 'A', localPath: 'Methods', state: 'clean' },
      { type: 'collection', zoteroCollectionKey: 'B', localPath: 'Inbox', state: 'clean' },
    ];
    // Disk set collapsed to just the root — exactly the unmount symptom.
    await detectFolderEvents({
      trackingStore: makeStore(records),
      onDiskAbsDirs: new Set(['/watch']),
      watchRoot: '/watch',
    });
    expect(isWatchRootAvailable).toHaveBeenCalledWith('/watch');
    expect(mirrorExecutor.execute).not.toHaveBeenCalled();
    // It returns before the record loop — no existence probing either.
    expect(IOUtils.exists).not.toHaveBeenCalled();
    expect(Zotero.debug).toHaveBeenCalledWith(
      expect.stringContaining('watch root unavailable'),
    );
  });

  it('does NOT flip any CollectionRecord state when the root is unavailable', async () => {
    isWatchRootAvailable.mockResolvedValue(false);
    const update = vi.fn();
    const records = [
      { type: 'collection', zoteroCollectionKey: 'A', localPath: 'Methods', state: 'clean' },
    ];
    const store = { ...makeStore(records), update };
    await detectFolderEvents({
      trackingStore: store,
      onDiskAbsDirs: new Set(['/watch']),
      watchRoot: '/watch',
    });
    expect(update).not.toHaveBeenCalled();
    expect(records[0].state).toBe('clean');
  });
});

describe('UT-607b: regression — available root still detects deletions', () => {
  it('fires two localFolderDeleted for two missing folders (UT-601 still holds)', async () => {
    isWatchRootAvailable.mockResolvedValue(true);
    const records = [
      { type: 'collection', zoteroCollectionKey: 'A', localPath: 'Methods', state: 'clean' },
      { type: 'collection', zoteroCollectionKey: 'B', localPath: 'Inbox', state: 'clean' },
    ];
    await detectFolderEvents({
      trackingStore: makeStore(records),
      onDiskAbsDirs: new Set(['/watch']),
      watchRoot: '/watch',
    });
    const calls = mirrorExecutor.execute.mock.calls.map((c) => c[0]);
    expect(calls.length).toBe(2);
    expect(calls.map((c) => c.payload.collectionKey).sort()).toEqual(['A', 'B']);
    expect(calls.every((c) => c.type === 'localFolderDeleted')).toBe(true);
  });
});

// ─── UT-606 ────────────────────────────────────────────────────────────────

describe('UT-606: tolerates malformed records', () => {
  it('skips records with missing or non-string localPath', async () => {
    const records = [
      { type: 'collection', zoteroCollectionKey: 'A', localPath: null },
      { type: 'collection', zoteroCollectionKey: 'B', localPath: '' },
      { type: 'collection', zoteroCollectionKey: 'C', localPath: 123 },
      null,
    ];
    await detectFolderEvents({
      trackingStore: makeStore(records),
      onDiskAbsDirs: new Set(['/watch']),
      watchRoot: '/watch',
    });
    expect(mirrorExecutor.execute).not.toHaveBeenCalled();
  });

  it('accepts Array (not Set) for onDiskAbsDirs', async () => {
    const records = [
      { type: 'collection', zoteroCollectionKey: 'A', localPath: 'X', state: 'clean' },
    ];
    await detectFolderEvents({
      trackingStore: makeStore(records),
      onDiskAbsDirs: ['/watch', '/watch/X'],
      watchRoot: '/watch',
    });
    expect(mirrorExecutor.execute).not.toHaveBeenCalled();
  });
});

// ─── UT-608: SYNC-1 top-level collapse + cycle aggregate cap (v2.7) ──────────

describe('UT-608: delete-safety gates (library-scale)', () => {
  it('SYNC-1: pauses the deletion pass when top-level folders collapse >50%', async () => {
    // Last healthy fingerprint had 8 top-level folders; now the root has none
    // (cloud eviction). Even one missing tracked collection must NOT propagate.
    Zotero.Prefs.get = vi.fn(() => JSON.stringify({ count: 8, namesHash: 'x' }));
    Zotero.Prefs.set = vi.fn();
    const records = [
      { type: 'collection', zoteroCollectionKey: 'A', localPath: 'Methods', state: 'clean' },
    ];
    await detectFolderEvents({
      trackingStore: makeStore(records),
      onDiskAbsDirs: new Set(['/watch']),
      watchRoot: '/watch',
    });
    expect(mirrorExecutor.execute).not.toHaveBeenCalled();
  });

  it('cycle aggregate cap: refuses the whole batch when >3 top-level folders go missing', async () => {
    Zotero.Prefs.get = vi.fn(() => ''); // no fingerprint → bootstrap, not a collapse
    Zotero.Prefs.set = vi.fn();
    const records = ['A', 'B', 'C', 'D'].map((k) => (
      { type: 'collection', zoteroCollectionKey: k, localPath: k, state: 'clean' }));
    await detectFolderEvents({
      trackingStore: makeStore(records),
      onDiskAbsDirs: new Set(['/watch']),
      watchRoot: '/watch',
    });
    expect(mirrorExecutor.execute).not.toHaveBeenCalled();
  });

  it('still emits when exactly 3 top-level folders are missing (under the cap)', async () => {
    Zotero.Prefs.get = vi.fn(() => '');
    Zotero.Prefs.set = vi.fn();
    const records = ['A', 'B', 'C'].map((k) => (
      { type: 'collection', zoteroCollectionKey: k, localPath: k, state: 'clean' }));
    await detectFolderEvents({
      trackingStore: makeStore(records),
      onDiskAbsDirs: new Set(['/watch']),
      watchRoot: '/watch',
    });
    expect(mirrorExecutor.execute).toHaveBeenCalledTimes(3);
  });
});

// ─── UT-609: F7 — fingerprint refreshes ONLY on a fully-clean cycle ─────────

describe('UT-609: healthy fingerprint only on a clean cycle (anti-drip-poison)', () => {
  it('does NOT refresh the fingerprint on a cycle that has missing folders', async () => {
    Zotero.Prefs.get = vi.fn(() => JSON.stringify({ count: 10, namesHash: 'x' }));
    const setSpy = vi.fn();
    Zotero.Prefs.set = setSpy;
    // 2 of 10 top-level folders missing (under collapse + aggregate caps) → emits,
    // but must leave the count=10 baseline intact so a drip can't ratchet it down.
    const records = ['A', 'B'].map((k) => (
      { type: 'collection', zoteroCollectionKey: k, localPath: k, state: 'clean' }));
    await detectFolderEvents({
      trackingStore: makeStore(records),
      onDiskAbsDirs: new Set(['/watch', '/watch/C', '/watch/D', '/watch/E', '/watch/F', '/watch/G', '/watch/H', '/watch/I']),
      watchRoot: '/watch',
    });
    // Deletions emitted...
    expect(mirrorExecutor.execute).toHaveBeenCalledTimes(2);
    // ...but the fingerprint pref was NOT rewritten this cycle.
    const wroteFingerprint = setSpy.mock.calls.some(
      (c) => String(c[0]).includes('watchRootTopLevelFingerprint'));
    expect(wroteFingerprint).toBe(false);
  });

  it('DOES refresh the fingerprint on a clean cycle (no missing folders)', async () => {
    Zotero.Prefs.get = vi.fn(() => '');
    const setSpy = vi.fn();
    Zotero.Prefs.set = setSpy;
    const records = [
      { type: 'collection', zoteroCollectionKey: 'A', localPath: 'A', state: 'clean' },
    ];
    await detectFolderEvents({
      trackingStore: makeStore(records),
      onDiskAbsDirs: new Set(['/watch', '/watch/A']), // A present → nothing missing
      watchRoot: '/watch',
    });
    expect(mirrorExecutor.execute).not.toHaveBeenCalled();
    const wroteFingerprint = setSpy.mock.calls.some(
      (c) => String(c[0]).includes('watchRootTopLevelFingerprint'));
    expect(wroteFingerprint).toBe(true);
  });
});
