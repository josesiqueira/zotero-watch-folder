/**
 * Unit tests for content/folderEventDetector.mjs (v2.1 Phase A2).
 *
 * Covers:
 *   UT-601 emits deleteFolder for tracked collections missing on disk
 *   UT-602 leaves on-disk tracked collections alone
 *   UT-603 falls back to IOUtils.exists when dir set is incomplete
 *   UT-604 skips v1-era absolute-path records
 *   UT-605 no-op when there are no collection records
 *   UT-606 tolerates falsy / malformed records
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../content/mirrorExecutor.mjs', () => ({
  execute: vi.fn(async () => ({ ok: true })),
}));

import * as mirrorExecutor from '../../content/mirrorExecutor.mjs';
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
    expect(calls.every((c) => c.type === 'deleteFolder')).toBe(true);
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

describe('UT-604: skips v1-era absolute-path records', () => {
  it('does not act on records where localPath starts with /', async () => {
    const records = [
      { type: 'collection', zoteroCollectionKey: 'V1', localPath: '/watch/V1Path', state: 'clean' },
    ];
    await detectFolderEvents({
      trackingStore: makeStore(records),
      onDiskAbsDirs: new Set(['/watch']),
      watchRoot: '/watch',
    });
    expect(mirrorExecutor.execute).not.toHaveBeenCalled();
    expect(IOUtils.exists).not.toHaveBeenCalled();
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
