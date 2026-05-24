/**
 * Unit tests for content/itemAddHandler.mjs (v2.1 review fix A8).
 *
 * Covers:
 *   UT-1001 register/unregister lifecycle (idempotent, item topic subscription)
 *   UT-1002 ignores non-attachment items
 *   UT-1003 ignores attachments already tracked
 *   UT-1004 ignores attachments whose parent has no sync-root membership
 *   UT-1005 copies a late-attached attachment to canonical path
 *   UT-1006 standalone attachment with sync-root membership is copied
 *   UT-1007 non-add events are ignored
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../content/baseline.mjs', () => ({
  copyAttachmentToCanonical: vi.fn(async () => 'copied'),
}));
vi.mock('../../content/canonicalPath.mjs', async () => {
  const actual = await vi.importActual('../../content/canonicalPath.mjs');
  return {
    ...actual,
    resolveSyncRoot: vi.fn(),
    collectionKeyToRelativePath: vi.fn(),
  };
});
vi.mock('../../content/utils.mjs', async () => {
  const actual = await vi.importActual('../../content/utils.mjs');
  return {
    ...actual,
    getPref: vi.fn(),
  };
});

import { start, stop, _isRegistered } from '../../content/itemAddHandler.mjs';
import * as baseline from '../../content/baseline.mjs';
import { resolveSyncRoot } from '../../content/canonicalPath.mjs';
import { getPref } from '../../content/utils.mjs';

const SYNC_ROOT = {
  collection: { id: 100, key: 'ROOT1', libraryID: 1 },
  libraryID: 1,
};

function makeStore(byKey = new Map()) {
  return {
    getByAttachmentKey: vi.fn((k) => byKey.get(k) ?? null),
    save: vi.fn(async () => {}),
  };
}

function makeCoordinator(store) {
  return { _trackingStore: store };
}

function captureObserver() {
  let captured = null;
  Zotero.Notifier.registerObserver = vi.fn((observer, topics, _name) => {
    captured = { observer, topics };
    return 'obs-itemadd';
  });
  Zotero.Notifier.unregisterObserver = vi.fn();
  return () => captured;
}

beforeEach(() => {
  vi.clearAllMocks();
  Zotero.debug = vi.fn();
  Zotero.logError = vi.fn();
  Zotero.Collections = { get: vi.fn() };
  Zotero.Items = { get: vi.fn() };
  Zotero.Libraries = { userLibraryID: 1 };
  resolveSyncRoot.mockResolvedValue(SYNC_ROOT);
  getPref.mockImplementation((key) => {
    if (key === 'sourcePath') return '/watch';
    if (key === 'syncRootCollectionKey') return 'ROOT1';
    return undefined;
  });
  stop();
});

// ─── UT-1001 ───────────────────────────────────────────────────────────────

describe('UT-1001: lifecycle', () => {
  it('subscribes to ["item"] and is idempotent', () => {
    const get = captureObserver();
    start(makeCoordinator(makeStore()));
    start(makeCoordinator(makeStore()));
    expect(Zotero.Notifier.registerObserver).toHaveBeenCalledTimes(1);
    expect(get().topics).toEqual(['item']);
    expect(_isRegistered()).toBe(true);
  });

  it('stop() unregisters and resets state', () => {
    captureObserver();
    start(makeCoordinator(makeStore()));
    stop();
    expect(Zotero.Notifier.unregisterObserver).toHaveBeenCalledWith('obs-itemadd');
    expect(_isRegistered()).toBe(false);
  });
});

// ─── UT-1002 ───────────────────────────────────────────────────────────────

describe('UT-1002: ignores non-attachment items', () => {
  it('does not call baseline for a parent (non-attachment) item add', async () => {
    Zotero.Items.get.mockReturnValue({
      key: 'P1',
      isAttachment: () => false,
    });
    const get = captureObserver();
    start(makeCoordinator(makeStore()));
    await get().observer.notify('add', 'item', [10], {});
    expect(baseline.copyAttachmentToCanonical).not.toHaveBeenCalled();
  });
});

// ─── UT-1003 ───────────────────────────────────────────────────────────────

describe('UT-1003: ignores already-tracked attachments', () => {
  it('skips when store.getByAttachmentKey returns a record', async () => {
    const att = {
      key: 'ATT1', isAttachment: () => true,
      parentItemID: null, getCollections: () => [],
    };
    Zotero.Items.get.mockReturnValue(att);
    const tracked = new Map([['ATT1', { zoteroAttachmentKey: 'ATT1' }]]);
    const get = captureObserver();
    start(makeCoordinator(makeStore(tracked)));
    await get().observer.notify('add', 'item', [10], {});
    expect(baseline.copyAttachmentToCanonical).not.toHaveBeenCalled();
  });
});

// ─── UT-1004 ───────────────────────────────────────────────────────────────

describe('UT-1004: ignores attachments whose parent is not in sync root', () => {
  it('skips when parent has no sync-root membership', async () => {
    const parent = {
      id: 999, key: 'PARENT', getCollections: () => [777], // 777 = out-of-scope
    };
    const att = {
      id: 10, key: 'ATT1', isAttachment: () => true, parentItemID: 999,
    };
    Zotero.Items.get.mockImplementation((id) => (id === 10 ? att : parent));
    Zotero.Collections.get.mockReturnValue({ key: 'OTHER', parentID: null });

    const get = captureObserver();
    start(makeCoordinator(makeStore()));
    await get().observer.notify('add', 'item', [10], {});
    expect(baseline.copyAttachmentToCanonical).not.toHaveBeenCalled();
  });
});

// ─── UT-1005 ───────────────────────────────────────────────────────────────

describe('UT-1005: copies a late-attached attachment whose parent IS in sync root', () => {
  it('calls baseline.copyAttachmentToCanonical with the right args', async () => {
    const parent = {
      id: 999, key: 'PARENT', getCollections: () => [200],
    };
    const att = {
      id: 10, key: 'ATT1', isAttachment: () => true, parentItemID: 999,
    };
    Zotero.Items.get.mockImplementation((id) => (id === 10 ? att : parent));
    // Collection 200 is under sync root: parent walk hits ROOT1.
    Zotero.Collections.get.mockImplementation((id) => {
      if (id === 200) return { key: 'SUB1', parentID: 100 };
      if (id === 100) return { key: 'ROOT1', parentID: null };
      return null;
    });

    const store = makeStore();
    const get = captureObserver();
    start(makeCoordinator(store));
    await get().observer.notify('add', 'item', [10], {});

    expect(baseline.copyAttachmentToCanonical).toHaveBeenCalledTimes(1);
    const args = baseline.copyAttachmentToCanonical.mock.calls[0][0];
    expect(args.attachment).toBe(att);
    expect(args.item).toBe(parent);
    expect(args.syncRoot).toEqual(SYNC_ROOT);
    expect(args.watchRoot).toBe('/watch');
    expect(args.store).toBe(store);
    expect(store.save).toHaveBeenCalled();
  });
});

// ─── UT-1006 ───────────────────────────────────────────────────────────────

describe('UT-1006: standalone attachment with sync-root membership', () => {
  it('treats the attachment itself as owning item when no parent', async () => {
    const standalone = {
      id: 10, key: 'STAND', isAttachment: () => true,
      parentItemID: null,
      getCollections: () => [100], // directly in sync-root collection
    };
    Zotero.Items.get.mockReturnValue(standalone);
    Zotero.Collections.get.mockImplementation((id) => (id === 100 ? { key: 'ROOT1', parentID: null } : null));

    const get = captureObserver();
    start(makeCoordinator(makeStore()));
    await get().observer.notify('add', 'item', [10], {});

    expect(baseline.copyAttachmentToCanonical).toHaveBeenCalledTimes(1);
    const args = baseline.copyAttachmentToCanonical.mock.calls[0][0];
    expect(args.item).toBe(standalone);
  });
});

// ─── UT-1007 ───────────────────────────────────────────────────────────────

describe('UT-1007: non-add events ignored', () => {
  it('drops modify events', async () => {
    const get = captureObserver();
    start(makeCoordinator(makeStore()));
    await get().observer.notify('modify', 'item', [10], {});
    expect(resolveSyncRoot).not.toHaveBeenCalled();
    expect(baseline.copyAttachmentToCanonical).not.toHaveBeenCalled();
  });

  it('drops events on non-item topics', async () => {
    const get = captureObserver();
    start(makeCoordinator(makeStore()));
    await get().observer.notify('add', 'collection', [10], {});
    expect(baseline.copyAttachmentToCanonical).not.toHaveBeenCalled();
  });
});
