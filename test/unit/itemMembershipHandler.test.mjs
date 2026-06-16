/**
 * Unit tests for content/itemMembershipHandler.mjs (v2.1 Phase A3).
 *
 * Covers:
 *   UT-501 add event on tracked item → addItemMembership executor call
 *   UT-502 add event on untracked item → logged, no executor call (B.2 deferred)
 *   UT-503 add event scope gate (collection not under sync root → ignored)
 *   UT-504 add event triggers moveItem when canonical changes
 *   UT-505 remove event on tracked item → removeItemMembership executor call
 *   UT-506 remove of canonical with remaining memberships → recompute + moveItem
 *   UT-507 remove of last membership → no recompute (executor handles suppress)
 *   UT-508 parent item events resolve to attachment children
 *   UT-509 standalone-attachment shortcut
 *   UT-510 modify events are ignored
 *   UT-511 malformed composite IDs and missing items are tolerated
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock collaborators BEFORE importing the SUT so vi.mock hoists.
vi.mock('../../content/mirrorExecutor.mjs', () => ({
  execute: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../../content/canonicalPath.mjs', async () => {
  const actual = await vi.importActual('../../content/canonicalPath.mjs');
  return {
    ...actual,
    resolveSyncRoot: vi.fn(),
    collectionKeyToRelativePath: vi.fn(),
    collectionKeyToDiskRelativePath: vi.fn(),
    chooseCanonicalCollection: vi.fn(),
  };
});
// getPref defaults to undefined → untracked adds DEFER (baseline not complete).
// The adopt-after-baseline tests override it.
vi.mock('../../content/utils.mjs', async () => {
  const actual = await vi.importActual('../../content/utils.mjs');
  return { ...actual, getPref: vi.fn(() => undefined) };
});
vi.mock('../../content/baseline.mjs', () => ({
  copyAttachmentToCanonical: vi.fn(async () => 'copied'),
  adoptCollectionSubtree: vi.fn(async () => ({ ok: true })),
}));

import * as mirrorExecutor from '../../content/mirrorExecutor.mjs';
import {
  resolveSyncRoot,
  collectionKeyToRelativePath,
  collectionKeyToDiskRelativePath,
  chooseCanonicalCollection,
} from '../../content/canonicalPath.mjs';
import { getPref } from '../../content/utils.mjs';
import * as baseline from '../../content/baseline.mjs';
import { handleCollectionItemEvent } from '../../content/itemMembershipHandler.mjs';

const SYNC_ROOT = { id: 100, key: 'ROOT1', name: 'Inbox', libraryID: 1, parentID: null };

function makeStore(records = []) {
  const byKey = new Map(records.map((r) => [r.zoteroAttachmentKey, r]));
  return {
    getByAttachmentKey: vi.fn((key) => byKey.get(key) ?? null),
    _byKey: byKey,
    _replace: (key, updates) => {
      const cur = byKey.get(key);
      if (cur) byKey.set(key, { ...cur, ...updates });
    },
  };
}

function makeCoordinator(store) {
  return { _trackingStore: store };
}

function makeItem(opts) {
  const { key, isAttachment = false, attachmentChildren = [] } = opts;
  return {
    key,
    isAttachment: () => isAttachment,
    getAttachments: () => attachmentChildren.map((a) => a.id),
    getCollections: () => opts.collectionIDs || [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  Zotero.debug = vi.fn();
  Zotero.logError = vi.fn();
  Zotero.Libraries = { userLibraryID: 1, publicationsLibraryID: 4 };
  Zotero.Collections.get = vi.fn();
  Zotero.Items.get = vi.fn();
  resolveSyncRoot.mockResolvedValue({ collection: SYNC_ROOT, libraryID: 1 });
  collectionKeyToRelativePath.mockResolvedValue('Methods');
  // FS-1: the canonical recompute path now uses the disk-sanitized variant.
  // Delegate it to the raw mock so every collectionKeyToRelativePath.mock*
  // setup in the tests drives both (sanitize is a no-op on the clean test
  // names: '', 'Methods', 'OldFolder', 'NewFolder').
  collectionKeyToDiskRelativePath.mockImplementation((k) => collectionKeyToRelativePath(k));
  chooseCanonicalCollection.mockResolvedValue(null);
});

// ─── UT-501 ────────────────────────────────────────────────────────────────

describe('UT-501: add on tracked item → addItemMembership executor call', () => {
  it('forwards addItemMembership and leaves canonical alone when unchanged', async () => {
    const collection = { id: 200, key: 'SUB1', name: 'Methods' };
    const att = { key: 'ATT1', isAttachment: () => true };
    Zotero.Collections.get.mockReturnValue(collection);
    Zotero.Items.get.mockReturnValue(att);
    collectionKeyToRelativePath.mockResolvedValue('Methods');
    chooseCanonicalCollection.mockResolvedValue({ key: 'EXISTING', libraryID: 1 });

    const store = makeStore([
      { zoteroAttachmentKey: 'ATT1', canonicalCollectionKey: 'EXISTING', collectionMembershipKeys: ['EXISTING'], canonicalLocalPath: 'X/paper.pdf' },
    ]);
    await handleCollectionItemEvent('add', ['200-300'], {}, makeCoordinator(store));

    expect(mirrorExecutor.execute).toHaveBeenCalledTimes(1);
    expect(mirrorExecutor.execute.mock.calls[0][0]).toEqual({
      type: 'addItemMembership',
      payload: { attachmentKey: 'ATT1', collectionKey: 'SUB1' },
    });
  });
});

// ─── UT-502 ────────────────────────────────────────────────────────────────

describe('UT-502: add on untracked item → defer (B.2 case)', () => {
  it('does not call executor and logs deferral', async () => {
    const collection = { id: 200, key: 'SUB1' };
    const att = { key: 'NEW', isAttachment: () => true };
    Zotero.Collections.get.mockReturnValue(collection);
    Zotero.Items.get.mockReturnValue(att);
    collectionKeyToRelativePath.mockResolvedValue('Methods');

    await handleCollectionItemEvent('add', ['200-300'], {}, makeCoordinator(makeStore()));
    expect(mirrorExecutor.execute).not.toHaveBeenCalled();
    expect(baseline.copyAttachmentToCanonical).not.toHaveBeenCalled();
    expect(Zotero.debug).toHaveBeenCalledWith(
      expect.stringMatching(/untracked.*NEW.*deferring to baseline/),
    );
  });
});

// ─── UT-513 (spec risk #4 — adopt item moved into sync root after baseline) ─

describe('UT-513: add on untracked attachment AFTER baseline → adopt', () => {
  it('copies the attachment to its canonical path + creates a record when baseline is complete', async () => {
    getPref.mockImplementation((k) => ({ baselineCompletedForRoot: 'ROOT1', sourcePath: '/watch' }[k]));
    const collection = { id: 200, key: 'SUB1' };
    const att = { key: 'NEWATT', isAttachment: () => true };
    Zotero.Collections.get.mockReturnValue(collection);
    Zotero.Items.get.mockReturnValue(att);
    Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async () => att);

    await handleCollectionItemEvent('add', ['200-300'], {}, makeCoordinator(makeStore()));

    expect(baseline.copyAttachmentToCanonical).toHaveBeenCalledTimes(1);
    const arg = baseline.copyAttachmentToCanonical.mock.calls[0][0];
    expect(arg.attachment).toBe(att);
    expect(arg.watchRoot).toBe('/watch');
    // It's an adopt, not a membership mutation.
    expect(mirrorExecutor.execute).not.toHaveBeenCalled();
  });

  it('still defers when baseline completed for a DIFFERENT root', async () => {
    getPref.mockImplementation((k) => ({ baselineCompletedForRoot: 'OTHERROOT', sourcePath: '/watch' }[k]));
    const collection = { id: 200, key: 'SUB1' };
    const att = { key: 'NEWATT', isAttachment: () => true };
    Zotero.Collections.get.mockReturnValue(collection);
    Zotero.Items.get.mockReturnValue(att);

    await handleCollectionItemEvent('add', ['200-300'], {}, makeCoordinator(makeStore()));

    expect(baseline.copyAttachmentToCanonical).not.toHaveBeenCalled();
  });
});

// ─── UT-503 ────────────────────────────────────────────────────────────────

describe('UT-503: scope gate', () => {
  it('drops events on collections outside the sync root', async () => {
    Zotero.Collections.get.mockReturnValue({ id: 999, key: 'OTHER' });
    collectionKeyToRelativePath.mockResolvedValue(null); // outside sync root

    await handleCollectionItemEvent('add', ['999-300'], {}, makeCoordinator(makeStore()));
    expect(Zotero.Items.get).not.toHaveBeenCalled();
    expect(mirrorExecutor.execute).not.toHaveBeenCalled();
  });

  it('drops events when sync root unset', async () => {
    resolveSyncRoot.mockResolvedValueOnce(null);
    await handleCollectionItemEvent('add', ['200-300'], {}, makeCoordinator(makeStore()));
    expect(mirrorExecutor.execute).not.toHaveBeenCalled();
  });
});

// ─── UT-504 ────────────────────────────────────────────────────────────────

describe('UT-504: add triggers moveItem when canonical changes', () => {
  it('emits moveItem with new canonical path + key when canonical changed', async () => {
    const collection = { id: 200, key: 'NEWC', name: 'NewC' };
    const att = { key: 'ATT1', isAttachment: () => true };
    Zotero.Collections.get.mockReturnValue(collection);
    Zotero.Items.get.mockReturnValue(att);
    collectionKeyToRelativePath.mockImplementation(async (k) => {
      if (k === 'NEWC') return 'NewFolder';
      return 'OldFolder';
    });
    chooseCanonicalCollection.mockResolvedValue({ key: 'NEWC', libraryID: 1 });

    const store = makeStore([
      {
        zoteroAttachmentKey: 'ATT1',
        canonicalCollectionKey: 'OLDC',
        collectionMembershipKeys: ['OLDC'],
        canonicalLocalPath: 'OldFolder/paper.pdf',
      },
    ]);
    await handleCollectionItemEvent('add', ['200-300'], {}, makeCoordinator(store));

    const calls = mirrorExecutor.execute.mock.calls.map((c) => c[0]);
    expect(calls[0].type).toBe('addItemMembership');
    expect(calls[1]).toEqual({
      type: 'moveItem',
      payload: {
        attachmentKey: 'ATT1',
        oldCanonicalPath: 'OldFolder/paper.pdf',
        newCanonicalPath: 'NewFolder/paper.pdf',
        newCanonicalCollectionKey: 'NEWC',
      },
    });
    // FS-1 revert guard: the canonical recompute MUST resolve the new path via
    // the disk-sanitized variant (so a reparent into a Windows-reserved name
    // mirrors safely). If this line is reverted to the raw
    // collectionKeyToRelativePath, the disk fn is never called here and this
    // assertion fails — keeping the live-path fix from silently rotting.
    expect(collectionKeyToDiskRelativePath).toHaveBeenCalledWith('NEWC');
  });

  it('does NOT emit moveItem when newCanonical equals current', async () => {
    const collection = { id: 200, key: 'SAME', name: 'Same' };
    const att = { key: 'ATT1', isAttachment: () => true };
    Zotero.Collections.get.mockReturnValue(collection);
    Zotero.Items.get.mockReturnValue(att);
    collectionKeyToRelativePath.mockResolvedValue('OldFolder');
    chooseCanonicalCollection.mockResolvedValue({ key: 'SAME', libraryID: 1 });

    const store = makeStore([
      {
        zoteroAttachmentKey: 'ATT1',
        canonicalCollectionKey: 'SAME',
        collectionMembershipKeys: ['SAME'],
        canonicalLocalPath: 'OldFolder/paper.pdf',
      },
    ]);
    await handleCollectionItemEvent('add', ['200-300'], {}, makeCoordinator(store));

    const types = mirrorExecutor.execute.mock.calls.map((c) => c[0].type);
    expect(types).toEqual(['addItemMembership']);
  });
});

// ─── UT-505 ────────────────────────────────────────────────────────────────

describe('UT-505: remove on tracked item → removeItemMembership', () => {
  it('emits removeItemMembership when collection is in the membership list', async () => {
    const collection = { id: 200, key: 'SUB1' };
    const att = { key: 'ATT1', isAttachment: () => true };
    Zotero.Collections.get.mockReturnValue(collection);
    Zotero.Items.get.mockReturnValue(att);

    const store = makeStore([
      {
        zoteroAttachmentKey: 'ATT1',
        canonicalCollectionKey: 'OTHER',
        collectionMembershipKeys: ['SUB1', 'OTHER'],
        canonicalLocalPath: 'X/paper.pdf',
      },
    ]);
    await handleCollectionItemEvent('remove', ['200-300'], {}, makeCoordinator(store));

    expect(mirrorExecutor.execute).toHaveBeenCalledTimes(1);
    expect(mirrorExecutor.execute.mock.calls[0][0]).toEqual({
      type: 'removeItemMembership',
      payload: { attachmentKey: 'ATT1', collectionKey: 'SUB1' },
    });
  });

  it('no-ops when collection was not in the membership list', async () => {
    const collection = { id: 200, key: 'SUB1' };
    const att = { key: 'ATT1', isAttachment: () => true };
    Zotero.Collections.get.mockReturnValue(collection);
    Zotero.Items.get.mockReturnValue(att);

    const store = makeStore([
      { zoteroAttachmentKey: 'ATT1', canonicalCollectionKey: 'OTHER', collectionMembershipKeys: ['OTHER'] },
    ]);
    await handleCollectionItemEvent('remove', ['200-300'], {}, makeCoordinator(store));
    expect(mirrorExecutor.execute).not.toHaveBeenCalled();
  });
});

// ─── UT-506 ────────────────────────────────────────────────────────────────

describe('UT-506: remove of canonical with remaining memberships → recompute', () => {
  it('emits removeItemMembership AND moveItem to new canonical', async () => {
    const collection = { id: 200, key: 'CAN' };
    const att = { key: 'ATT1', isAttachment: () => true };
    Zotero.Collections.get.mockReturnValue(collection);
    Zotero.Items.get.mockReturnValue(att);
    collectionKeyToRelativePath.mockImplementation(async (k) => {
      if (k === 'CAN') return 'OldFolder';
      if (k === 'NEW') return 'NewFolder';
      return null;
    });
    chooseCanonicalCollection.mockResolvedValue({ key: 'NEW', libraryID: 1 });

    const store = makeStore([
      {
        zoteroAttachmentKey: 'ATT1',
        canonicalCollectionKey: 'CAN',
        collectionMembershipKeys: ['CAN', 'NEW'],
        canonicalLocalPath: 'OldFolder/paper.pdf',
      },
    ]);
    // Simulate the executor having stripped CAN and cleared canonicalCollectionKey.
    mirrorExecutor.execute.mockImplementation(async (action) => {
      if (action.type === 'removeItemMembership') {
        store._replace('ATT1', {
          collectionMembershipKeys: ['NEW'],
          canonicalCollectionKey: null,
        });
      }
      return { ok: true };
    });

    await handleCollectionItemEvent('remove', ['200-300'], {}, makeCoordinator(store));

    const calls = mirrorExecutor.execute.mock.calls.map((c) => c[0]);
    expect(calls[0].type).toBe('removeItemMembership');
    expect(calls[1]).toEqual({
      type: 'moveItem',
      payload: {
        attachmentKey: 'ATT1',
        oldCanonicalPath: 'OldFolder/paper.pdf',
        newCanonicalPath: 'NewFolder/paper.pdf',
        newCanonicalCollectionKey: 'NEW',
      },
    });
  });
});

// ─── UT-507 ────────────────────────────────────────────────────────────────

describe('UT-507: remove of last membership', () => {
  it('does NOT recompute when no memberships remain', async () => {
    const collection = { id: 200, key: 'CAN' };
    const att = { key: 'ATT1', isAttachment: () => true };
    Zotero.Collections.get.mockReturnValue(collection);
    Zotero.Items.get.mockReturnValue(att);

    const store = makeStore([
      {
        zoteroAttachmentKey: 'ATT1',
        canonicalCollectionKey: 'CAN',
        collectionMembershipKeys: ['CAN'],
        canonicalLocalPath: 'OldFolder/paper.pdf',
      },
    ]);
    mirrorExecutor.execute.mockImplementation(async (action) => {
      if (action.type === 'removeItemMembership') {
        store._replace('ATT1', {
          collectionMembershipKeys: [],
          canonicalCollectionKey: null,
        });
      }
      return { ok: true };
    });

    await handleCollectionItemEvent('remove', ['200-300'], {}, makeCoordinator(store));

    const types = mirrorExecutor.execute.mock.calls.map((c) => c[0].type);
    expect(types).toEqual(['removeItemMembership']);
    expect(chooseCanonicalCollection).not.toHaveBeenCalled();
  });
});

// ─── UT-508 ────────────────────────────────────────────────────────────────

describe('UT-508: parent item events resolve to attachment children', () => {
  it('walks all attachment children of a parent item', async () => {
    const collection = { id: 200, key: 'SUB1' };
    const attA = { key: 'ATTA', isAttachment: () => true };
    const attB = { key: 'ATTB', isAttachment: () => true };
    const parent = {
      key: 'PARENT',
      isAttachment: () => false,
      getAttachments: () => [501, 502],
    };
    Zotero.Collections.get.mockReturnValue(collection);
    Zotero.Items.get.mockImplementation((id) => {
      if (id === 300) return parent;
      if (id === 501) return attA;
      if (id === 502) return attB;
      return null;
    });

    const store = makeStore([
      { zoteroAttachmentKey: 'ATTA', canonicalCollectionKey: 'SUB1', collectionMembershipKeys: ['SUB1'], canonicalLocalPath: 'X/a.pdf' },
      { zoteroAttachmentKey: 'ATTB', canonicalCollectionKey: 'SUB1', collectionMembershipKeys: ['SUB1'], canonicalLocalPath: 'X/b.pdf' },
    ]);
    await handleCollectionItemEvent('add', ['200-300'], {}, makeCoordinator(store));

    const calls = mirrorExecutor.execute.mock.calls.map((c) => c[0]);
    expect(calls.length).toBe(2);
    expect(calls.map((c) => c.payload.attachmentKey)).toEqual(['ATTA', 'ATTB']);
  });
});

// ─── UT-509 ────────────────────────────────────────────────────────────────

describe('UT-509: standalone attachment shortcut', () => {
  it('uses the item key directly when isAttachment() returns true', async () => {
    const collection = { id: 200, key: 'SUB1' };
    const att = { key: 'STAND', isAttachment: () => true, getAttachments: () => [] };
    Zotero.Collections.get.mockReturnValue(collection);
    Zotero.Items.get.mockReturnValue(att);

    const store = makeStore([
      { zoteroAttachmentKey: 'STAND', canonicalCollectionKey: 'SUB1', collectionMembershipKeys: ['SUB1'], canonicalLocalPath: 'X/p.pdf' },
    ]);
    await handleCollectionItemEvent('add', ['200-300'], {}, makeCoordinator(store));
    expect(mirrorExecutor.execute.mock.calls[0][0].payload.attachmentKey).toBe('STAND');
  });
});

// ─── UT-510 ────────────────────────────────────────────────────────────────

describe('UT-510: modify events ignored', () => {
  it('does nothing on modify', async () => {
    await handleCollectionItemEvent('modify', ['200-300'], {}, makeCoordinator(makeStore()));
    expect(resolveSyncRoot).not.toHaveBeenCalled();
    expect(mirrorExecutor.execute).not.toHaveBeenCalled();
  });
});

// ─── UT-511 ────────────────────────────────────────────────────────────────

describe('UT-511: malformed input tolerance', () => {
  it('skips composite IDs that fail to parse', async () => {
    await handleCollectionItemEvent('add', ['not-a-pair', '200', ''], {}, makeCoordinator(makeStore()));
    expect(Zotero.Collections.get).not.toHaveBeenCalled();
  });

  it('skips when collection or item lookup returns null', async () => {
    Zotero.Collections.get.mockReturnValue(null);
    await handleCollectionItemEvent('add', ['200-300'], {}, makeCoordinator(makeStore()));
    expect(mirrorExecutor.execute).not.toHaveBeenCalled();
  });

  it('handles empty compositeIDs array', async () => {
    await handleCollectionItemEvent('add', [], {}, makeCoordinator(makeStore()));
    expect(resolveSyncRoot).not.toHaveBeenCalled();
  });

  it('ignores non-add/remove events', async () => {
    await handleCollectionItemEvent('delete', ['200-300'], {}, makeCoordinator(makeStore()));
    expect(mirrorExecutor.execute).not.toHaveBeenCalled();
  });
});

// ─── UT-512 ────────────────────────────────────────────────────────────────

describe('UT-512: Zotero reparenting guard on remove', () => {
  it('skips removeItemMembership when the attachment\'s parent is still in the collection (RecognizePDF case)', async () => {
    // RecognizePDF flow: attachment is removed from sync-root collection
    // because Zotero just reparented it under a newly-created parent
    // item, which now lives in that sync-root collection. The FileRecord
    // is still effectively "in" the collection via the parent — don't
    // propagate as a user removal (which would suppress the record).
    const collection = { id: 200, key: 'SYNCROOT' };
    const parent = {
      key: 'PARENT1',
      isAttachment: () => false,
      getCollections: () => [200],
    };
    const att = {
      key: 'ATT1',
      isAttachment: () => true,
      parentItem: parent,
    };
    Zotero.Collections.get.mockReturnValue(collection);
    Zotero.Items.get.mockReturnValue(att);

    const store = makeStore([
      {
        zoteroAttachmentKey: 'ATT1',
        canonicalCollectionKey: 'SYNCROOT',
        collectionMembershipKeys: ['SYNCROOT'],
        canonicalLocalPath: 'paper.pdf',
      },
    ]);
    await handleCollectionItemEvent('remove', ['200-300'], {}, makeCoordinator(store));

    // The guard short-circuits BEFORE dispatching to the executor.
    expect(mirrorExecutor.execute).not.toHaveBeenCalled();
  });

  it('falls through to removeItemMembership when the parent is NOT in the collection (real user removal)', async () => {
    const collection = { id: 200, key: 'SYNCROOT' };
    const parent = {
      key: 'PARENT1',
      isAttachment: () => false,
      getCollections: () => [], // parent NOT in the collection anymore either
    };
    const att = {
      key: 'ATT1',
      isAttachment: () => true,
      parentItem: parent,
    };
    Zotero.Collections.get.mockReturnValue(collection);
    Zotero.Items.get.mockReturnValue(att);

    const store = makeStore([
      {
        zoteroAttachmentKey: 'ATT1',
        canonicalCollectionKey: 'SYNCROOT',
        collectionMembershipKeys: ['SYNCROOT'],
        canonicalLocalPath: 'paper.pdf',
      },
    ]);
    await handleCollectionItemEvent('remove', ['200-300'], {}, makeCoordinator(store));

    expect(mirrorExecutor.execute).toHaveBeenCalledTimes(1);
    expect(mirrorExecutor.execute.mock.calls[0][0].type).toBe('removeItemMembership');
  });

  it('falls through to removeItemMembership for standalone attachments without a parent', async () => {
    const collection = { id: 200, key: 'SYNCROOT' };
    const att = {
      key: 'ATT1',
      isAttachment: () => true,
      parentItem: null,
    };
    Zotero.Collections.get.mockReturnValue(collection);
    Zotero.Items.get.mockReturnValue(att);

    const store = makeStore([
      {
        zoteroAttachmentKey: 'ATT1',
        canonicalCollectionKey: 'SYNCROOT',
        collectionMembershipKeys: ['SYNCROOT'],
        canonicalLocalPath: 'paper.pdf',
      },
    ]);
    await handleCollectionItemEvent('remove', ['200-300'], {}, makeCoordinator(store));

    expect(mirrorExecutor.execute).toHaveBeenCalledTimes(1);
    expect(mirrorExecutor.execute.mock.calls[0][0].type).toBe('removeItemMembership');
  });

  it('falls through for parent-item events (item is the parent itself, not an attachment)', async () => {
    // When the user removes a parent from a sync-root collection, the
    // notifier event item IS the parent (not the attachment). The
    // attachment children are resolved via getAttachments(). The guard
    // should NOT trigger here because item.isAttachment() is false.
    const collection = { id: 200, key: 'SYNCROOT' };
    const childAtt = { key: 'CHILDATT', isAttachment: () => true };
    const parent = {
      key: 'PARENT1',
      isAttachment: () => false,
      getAttachments: () => [501],
      getCollections: () => [], // already removed
    };
    Zotero.Collections.get.mockReturnValue(collection);
    Zotero.Items.get.mockImplementation((id) => {
      if (id === 300) return parent;
      if (id === 501) return childAtt;
      return null;
    });

    const store = makeStore([
      {
        zoteroAttachmentKey: 'CHILDATT',
        canonicalCollectionKey: 'SYNCROOT',
        collectionMembershipKeys: ['SYNCROOT'],
        canonicalLocalPath: 'paper.pdf',
      },
    ]);
    await handleCollectionItemEvent('remove', ['200-300'], {}, makeCoordinator(store));

    expect(mirrorExecutor.execute).toHaveBeenCalledTimes(1);
    expect(mirrorExecutor.execute.mock.calls[0][0]).toEqual({
      type: 'removeItemMembership',
      payload: { attachmentKey: 'CHILDATT', collectionKey: 'SYNCROOT' },
    });
  });
});

// ─── UT-513 (WP-C #4 — per-collection batching) ───────────────────────────

describe('UT-513: handleCollectionItemEvent groups composite IDs by collection (WP-C #4)', () => {
  it('resolves collectionKeyToRelativePath ONCE per collection across many items', async () => {
    // 5 items added to the same collection in one batch → the
    // per-collection scope-gate resolver runs ONCE, not 5 times.
    const collection = { id: 200, key: 'SUB1' };
    Zotero.Collections.get.mockReturnValue(collection);
    Zotero.Items.get.mockImplementation((id) => makeItem({
      key: `ITEM${id}`,
      isAttachment: true,
      collectionIDs: [200],
    }));

    const records = [];
    for (let i = 0; i < 5; i++) {
      records.push({
        zoteroAttachmentKey: `ITEM${300 + i}`,
        canonicalCollectionKey: null,
        collectionMembershipKeys: [],
        canonicalLocalPath: `p${i}.pdf`,
      });
    }
    const store = makeStore(records);

    const compositeIDs = [];
    for (let i = 0; i < 5; i++) compositeIDs.push(`200-${300 + i}`);
    await handleCollectionItemEvent('add', compositeIDs, {}, makeCoordinator(store));

    // 5 items dispatched but only 1 call to collectionKeyToRelativePath
    // for the collection-scope gate (chooseCanonicalCollection may call
    // it from the recompute path; that's a different code path).
    const scopeCalls = collectionKeyToRelativePath.mock.calls.filter(
      ([key]) => key === 'SUB1',
    );
    // At least 1 (we ran the scope gate). The legacy implementation ran
    // it 5 times (one per item) — batching collapses to a single check.
    expect(scopeCalls.length).toBe(1);
    expect(mirrorExecutor.execute).toHaveBeenCalledTimes(5);
  });

  it('resolves each DIFFERENT collection in the batch separately', async () => {
    const collA = { id: 200, key: 'A' };
    const collB = { id: 300, key: 'B' };
    Zotero.Collections.get.mockImplementation((id) => (id === 200 ? collA : (id === 300 ? collB : null)));
    Zotero.Items.get.mockImplementation((id) => makeItem({
      key: `ITEM${id}`,
      isAttachment: true,
      collectionIDs: [id === 400 ? 200 : 300],
    }));
    const store = makeStore([
      { zoteroAttachmentKey: 'ITEM400', collectionMembershipKeys: [], canonicalLocalPath: 'a.pdf' },
      { zoteroAttachmentKey: 'ITEM500', collectionMembershipKeys: [], canonicalLocalPath: 'b.pdf' },
    ]);

    await handleCollectionItemEvent(
      'add',
      ['200-400', '300-500'],
      {},
      makeCoordinator(store),
    );

    // One scope-gate call per UNIQUE collection.
    const scopeCalls = collectionKeyToRelativePath.mock.calls.filter(
      ([key]) => key === 'A' || key === 'B',
    );
    expect(scopeCalls.length).toBe(2);
    expect(mirrorExecutor.execute).toHaveBeenCalledTimes(2);
  });

  it('preserves the RecognizePDF reparenting guard across batched events', async () => {
    // Same scenario as UT-512 but routed through the new batching
    // path. Each per-item handler call still runs the guard.
    const collection = { id: 200, key: 'SUB1' };
    Zotero.Collections.get.mockReturnValue(collection);
    const parent = {
      key: 'PARENT1',
      isAttachment: () => false,
      getCollections: () => [200], // parent still in the collection
    };
    const attachment = {
      key: 'ATT1',
      isAttachment: () => true,
      parentItem: parent,
      getCollections: () => [],
    };
    Zotero.Items.get.mockReturnValue(attachment);
    const store = makeStore([
      {
        zoteroAttachmentKey: 'ATT1',
        canonicalCollectionKey: 'SUB1',
        collectionMembershipKeys: ['SUB1'],
        canonicalLocalPath: 'paper.pdf',
      },
    ]);

    await handleCollectionItemEvent('remove', ['200-300'], {}, makeCoordinator(store));

    // Guard fired → no executor call at all.
    expect(mirrorExecutor.execute).not.toHaveBeenCalled();
  });
});
