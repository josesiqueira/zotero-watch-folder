/**
 * Unit tests for content/mirrorExecutor.mjs (v2.1 Phase A4 + A5).
 *
 * Covers:
 *   UT-401 execute() dispatch + invalid action handling
 *   UT-402 canSafelyMove (clean / drifted / missing / no baseline)
 *   UT-403 createFolder (mkdir + tracking insert)
 *   UT-404 moveFolder (rename + child file path rewrite)
 *   UT-405 moveFolder (cross-FS fallback via copy + remove)
 *   UT-406 deleteFolder (Mode 2 warn-only: state flip to suppressed)
 *   UT-407 moveItem (conflict-gate refusal + state=conflict-blocked)
 *   UT-408 moveItem (clean → file moved + record re-keyed)
 *   UT-409 addItemMembership / removeItemMembership (no IO, set ops)
 *   UT-410 per-key lock serializes concurrent calls
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock utils.getFileHash so we can control conflict-gate outcomes.
vi.mock('../../content/utils.mjs', async () => {
  const actual = await vi.importActual('../../content/utils.mjs');
  return {
    ...actual,
    getFileHash: vi.fn(async () => 'fakehash'),
    getPref: vi.fn((key) => {
      const v = { sourcePath: '/watch' };
      return v[key];
    }),
  };
});

import { execute, canSafelyMove, init, reset, _getStore } from '../../content/mirrorExecutor.mjs';
import { TrackingStore, createFileRecord, createCollectionRecord, STATE } from '../../content/trackingStore.mjs';
import { getFileHash, getPref } from '../../content/utils.mjs';

// ─── Fixtures ──────────────────────────────────────────────────────────────

async function makeStore() {
  // Real TrackingStore but with init() short-circuited.
  const store = new TrackingStore();
  store.dataFile = '/tmp/mock-tracking-v2.json';
  store._initialized = true;
  return store;
}

function resetIOMocks() {
  IOUtils.exists = vi.fn(async () => true);
  IOUtils.makeDirectory = vi.fn(async () => {});
  IOUtils.move = vi.fn(async () => {});
  IOUtils.copy = vi.fn(async () => {});
  IOUtils.remove = vi.fn(async () => {});
  IOUtils.writeJSON = vi.fn(async () => {});
  IOUtils.readJSON = vi.fn(async () => ({}));
}

beforeEach(() => {
  vi.clearAllMocks();
  Zotero.debug = vi.fn();
  Zotero.logError = vi.fn();
  resetIOMocks();
  reset();
  getPref.mockImplementation((key) => ({ sourcePath: '/watch' }[key]));
  getFileHash.mockImplementation(async () => 'fakehash');
});

// ─── UT-401 ────────────────────────────────────────────────────────────────

describe('UT-401: execute() dispatch + invalid action handling', () => {
  it('rejects null/undefined action', async () => {
    expect(await execute(null)).toEqual({ ok: false, reason: 'invalid-action' });
    expect(await execute(undefined)).toEqual({ ok: false, reason: 'invalid-action' });
  });

  it('rejects unknown action types', async () => {
    expect(await execute({ type: 'wat', payload: {} })).toEqual({ ok: false, reason: 'unknown-action' });
  });

  it('rejects action with no type field', async () => {
    expect(await execute({ payload: {} })).toEqual({ ok: false, reason: 'invalid-action' });
  });
});

// ─── UT-402 ────────────────────────────────────────────────────────────────

describe('UT-402: canSafelyMove conflict gate', () => {
  it('returns ok=true when current hash matches recorded', async () => {
    const record = createFileRecord({
      localPath: 'a.pdf', zoteroAttachmentKey: 'K1', lastSyncedHash: 'fakehash',
    });
    getFileHash.mockResolvedValueOnce('fakehash');
    const result = await canSafelyMove(record, '/watch/a.pdf');
    expect(result.ok).toBe(true);
  });

  it('returns hash-drifted when current bytes differ', async () => {
    const record = createFileRecord({
      localPath: 'a.pdf', zoteroAttachmentKey: 'K1', lastSyncedHash: 'oldhash',
    });
    getFileHash.mockResolvedValueOnce('newhash');
    const result = await canSafelyMove(record, '/watch/a.pdf');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('hash-drifted');
    expect(result.currentHash).toBe('newhash');
    expect(result.recordedHash).toBe('oldhash');
  });

  it('returns missing-file when file does not exist', async () => {
    const record = createFileRecord({
      localPath: 'a.pdf', zoteroAttachmentKey: 'K1', lastSyncedHash: 'fakehash',
    });
    IOUtils.exists.mockResolvedValueOnce(false);
    const result = await canSafelyMove(record, '/watch/a.pdf');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('missing-file');
  });

  it('returns invalid-record when no lastSyncedHash baseline', async () => {
    const record = createFileRecord({
      localPath: 'a.pdf', zoteroAttachmentKey: 'K1', lastSyncedHash: null,
    });
    const result = await canSafelyMove(record, '/watch/a.pdf');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid-record');
  });

  it('returns invalid-record when called with falsy args', async () => {
    expect(await canSafelyMove(null, '/watch/a.pdf')).toMatchObject({ ok: false, reason: 'invalid-record' });
    expect(await canSafelyMove({ lastSyncedHash: 'x' }, '')).toMatchObject({ ok: false, reason: 'invalid-record' });
  });
});

// ─── UT-403 ────────────────────────────────────────────────────────────────

describe('UT-403: createFolder', () => {
  it('makes the directory and inserts a CollectionRecord', async () => {
    const store = await makeStore();
    init({ trackingStore: store });

    const result = await execute({
      type: 'createFolder',
      payload: {
        collectionKey: 'SUB1',
        parentCollectionKey: 'ROOT1',
        relativePath: 'Methods',
        name: 'Methods',
      },
    });
    expect(result.ok).toBe(true);
    expect(IOUtils.makeDirectory).toHaveBeenCalledWith('/watch/Methods', expect.objectContaining({ ignoreExisting: true }));
    const rec = store.getCollectionRecord('SUB1');
    expect(rec).toBeTruthy();
    expect(rec.localPath).toBe('Methods');
    expect(rec.parentCollectionKey).toBe('ROOT1');
  });

  it('rejects empty relative path (sync-root itself)', async () => {
    init({ trackingStore: await makeStore() });
    const result = await execute({
      type: 'createFolder',
      payload: { collectionKey: 'SUB1', relativePath: '' },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid-payload');
  });

  it('returns io-error when makeDirectory throws', async () => {
    init({ trackingStore: await makeStore() });
    IOUtils.makeDirectory.mockRejectedValueOnce(new Error('EACCES'));
    const result = await execute({
      type: 'createFolder',
      payload: { collectionKey: 'SUB1', relativePath: 'X' },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('io-error');
  });
});

// ─── UT-404 ────────────────────────────────────────────────────────────────

describe('UT-404: moveFolder (rename) + child path rewrite', () => {
  it('moves the dir and rewrites child file localPath/canonicalLocalPath', async () => {
    const store = await makeStore();
    store.add(createCollectionRecord({
      localPath: 'OldName', zoteroCollectionKey: 'SUB1', parentCollectionKey: 'ROOT1', state: STATE.CLEAN,
    }));
    store.add(createFileRecord({
      localPath: 'OldName/paper.pdf',
      canonicalLocalPath: 'OldName/paper.pdf',
      zoteroAttachmentKey: 'K1',
      lastSyncedHash: 'h1',
      state: STATE.CLEAN,
    }));
    store.add(createFileRecord({
      localPath: 'OldName/nested/inner.pdf',
      canonicalLocalPath: 'OldName/nested/inner.pdf',
      zoteroAttachmentKey: 'K2',
      lastSyncedHash: 'h2',
      state: STATE.CLEAN,
    }));
    init({ trackingStore: store });

    const result = await execute({
      type: 'moveFolder',
      payload: {
        collectionKey: 'SUB1',
        oldRelativePath: 'OldName',
        newRelativePath: 'NewName',
      },
    });
    expect(result.ok).toBe(true);
    expect(IOUtils.move).toHaveBeenCalledWith('/watch/OldName', '/watch/NewName', expect.any(Object));

    expect(store.getCollectionRecord('SUB1').localPath).toBe('NewName');
    expect(store.getByLocalPath('OldName/paper.pdf')).toBe(null);
    expect(store.getByLocalPath('OldName/nested/inner.pdf')).toBe(null);

    const renamed1 = store.getByLocalPath('NewName/paper.pdf');
    expect(renamed1).toBeTruthy();
    expect(renamed1.canonicalLocalPath).toBe('NewName/paper.pdf');
    const renamed2 = store.getByLocalPath('NewName/nested/inner.pdf');
    expect(renamed2).toBeTruthy();
    expect(renamed2.canonicalLocalPath).toBe('NewName/nested/inner.pdf');
  });

  it('returns no-op when paths match', async () => {
    init({ trackingStore: await makeStore() });
    const result = await execute({
      type: 'moveFolder',
      payload: {
        collectionKey: 'SUB1',
        oldRelativePath: 'X',
        newRelativePath: 'X',
      },
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('no-op');
    expect(IOUtils.move).not.toHaveBeenCalled();
  });

  it('pre-creates the destination parent for cross-parent moves', async () => {
    init({ trackingStore: await makeStore() });
    await execute({
      type: 'moveFolder',
      payload: {
        collectionKey: 'SUB1',
        oldRelativePath: 'A/Methods',
        newRelativePath: 'B/Methods',
      },
    });
    // makeDirectory called for the parent of the destination
    expect(IOUtils.makeDirectory).toHaveBeenCalledWith('/watch/B', expect.any(Object));
  });
});

// ─── UT-405 ────────────────────────────────────────────────────────────────

describe('UT-405: moveFolder cross-FS fallback', () => {
  it('falls back to copy + remove when IOUtils.move throws', async () => {
    init({ trackingStore: await makeStore() });
    IOUtils.move.mockRejectedValueOnce(new Error('EXDEV: cross-device link'));
    const result = await execute({
      type: 'moveFolder',
      payload: {
        collectionKey: 'SUB1',
        oldRelativePath: 'A',
        newRelativePath: 'B',
      },
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('copy-fallback');
    expect(IOUtils.copy).toHaveBeenCalledWith('/watch/A', '/watch/B', { recursive: true });
    expect(IOUtils.remove).toHaveBeenCalledWith('/watch/A', { recursive: true });
  });

  it('returns io-error and rolls back partial copy when copy ALSO fails', async () => {
    init({ trackingStore: await makeStore() });
    IOUtils.move.mockRejectedValueOnce(new Error('EXDEV'));
    IOUtils.copy.mockRejectedValueOnce(new Error('ENOSPC'));
    const result = await execute({
      type: 'moveFolder',
      payload: {
        collectionKey: 'SUB1',
        oldRelativePath: 'A',
        newRelativePath: 'B',
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('io-error');
    // Rollback: should try to remove the partial destination
    expect(IOUtils.remove).toHaveBeenCalledWith('/watch/B', expect.objectContaining({ recursive: true, ignoreAbsent: true }));
  });
});

// ─── UT-406 ────────────────────────────────────────────────────────────────

describe('UT-406: deleteFolder (Mode 2 warn-only)', () => {
  it('flips state to OUT_OF_SCOPE_SUPPRESSED without deleting the dir', async () => {
    const store = await makeStore();
    store.add(createCollectionRecord({
      localPath: 'Methods', zoteroCollectionKey: 'SUB1', parentCollectionKey: 'ROOT1', state: STATE.CLEAN,
    }));
    init({ trackingStore: store });

    const result = await execute({
      type: 'deleteFolder',
      payload: { collectionKey: 'SUB1', oldRelativePath: 'Methods' },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('warn-only-mode2');
    expect(IOUtils.remove).not.toHaveBeenCalled();
    expect(store.getCollectionRecord('SUB1').state).toBe(STATE.OUT_OF_SCOPE_SUPPRESSED);
  });
});

// ─── UT-407 ────────────────────────────────────────────────────────────────

describe('UT-407: moveItem refusal on hash drift', () => {
  it('refuses to move when current bytes differ from lastSyncedHash and marks state', async () => {
    const store = await makeStore();
    store.add(createFileRecord({
      localPath: 'Old/paper.pdf', canonicalLocalPath: 'Old/paper.pdf',
      zoteroAttachmentKey: 'K1', lastSyncedHash: 'oldhash',
      state: STATE.CLEAN,
    }));
    init({ trackingStore: store });
    getFileHash.mockResolvedValueOnce('newhash');

    const result = await execute({
      type: 'moveItem',
      payload: {
        attachmentKey: 'K1',
        oldCanonicalPath: 'Old/paper.pdf',
        newCanonicalPath: 'New/paper.pdf',
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('hash-drifted');
    expect(IOUtils.move).not.toHaveBeenCalled();
    expect(store.getByLocalPath('Old/paper.pdf').state).toBe(STATE.CONFLICT_BLOCKED);
  });
});

// ─── UT-408 ────────────────────────────────────────────────────────────────

describe('UT-408: moveItem happy path', () => {
  it('moves the file and re-keys the tracking record', async () => {
    const store = await makeStore();
    store.add(createFileRecord({
      localPath: 'Old/paper.pdf', canonicalLocalPath: 'Old/paper.pdf',
      zoteroAttachmentKey: 'K1', lastSyncedHash: 'fakehash',
      state: STATE.CLEAN,
    }));
    init({ trackingStore: store });

    const result = await execute({
      type: 'moveItem',
      payload: {
        attachmentKey: 'K1',
        oldCanonicalPath: 'Old/paper.pdf',
        newCanonicalPath: 'New/paper.pdf',
      },
    });
    expect(result.ok).toBe(true);
    expect(IOUtils.move).toHaveBeenCalledWith('/watch/Old/paper.pdf', '/watch/New/paper.pdf', expect.any(Object));
    expect(store.getByLocalPath('Old/paper.pdf')).toBe(null);
    expect(store.getByLocalPath('New/paper.pdf')).toBeTruthy();
    expect(store.getByLocalPath('New/paper.pdf').canonicalLocalPath).toBe('New/paper.pdf');
  });
});

// ─── UT-409 ────────────────────────────────────────────────────────────────

describe('UT-409: membership updates (no IO)', () => {
  it('addItemMembership unions the key', async () => {
    const store = await makeStore();
    store.add(createFileRecord({
      localPath: 'p.pdf', zoteroAttachmentKey: 'K1',
      collectionMembershipKeys: ['C1'], state: STATE.CLEAN,
    }));
    init({ trackingStore: store });
    const result = await execute({
      type: 'addItemMembership',
      payload: { attachmentKey: 'K1', collectionKey: 'C2' },
    });
    expect(result.ok).toBe(true);
    expect(store.getByLocalPath('p.pdf').collectionMembershipKeys).toEqual(['C1', 'C2']);
    expect(IOUtils.move).not.toHaveBeenCalled();
  });

  it('addItemMembership no-ops when key already present', async () => {
    const store = await makeStore();
    store.add(createFileRecord({
      localPath: 'p.pdf', zoteroAttachmentKey: 'K1',
      collectionMembershipKeys: ['C1'], state: STATE.CLEAN,
    }));
    init({ trackingStore: store });
    const result = await execute({
      type: 'addItemMembership',
      payload: { attachmentKey: 'K1', collectionKey: 'C1' },
    });
    expect(result.reason).toBe('no-op');
  });

  it('removeItemMembership drops the key and clears canonical when canonical', async () => {
    const store = await makeStore();
    store.add(createFileRecord({
      localPath: 'p.pdf', zoteroAttachmentKey: 'K1',
      canonicalCollectionKey: 'C1',
      collectionMembershipKeys: ['C1', 'C2'], state: STATE.CLEAN,
    }));
    init({ trackingStore: store });
    const result = await execute({
      type: 'removeItemMembership',
      payload: { attachmentKey: 'K1', collectionKey: 'C1' },
    });
    expect(result.ok).toBe(true);
    expect(store.getByLocalPath('p.pdf').collectionMembershipKeys).toEqual(['C2']);
    expect(store.getByLocalPath('p.pdf').canonicalCollectionKey).toBe(null);
  });

  it('removeItemMembership marks suppressed when last membership is dropped', async () => {
    const store = await makeStore();
    store.add(createFileRecord({
      localPath: 'p.pdf', zoteroAttachmentKey: 'K1',
      canonicalCollectionKey: 'C1',
      collectionMembershipKeys: ['C1'], state: STATE.CLEAN,
    }));
    init({ trackingStore: store });
    await execute({
      type: 'removeItemMembership',
      payload: { attachmentKey: 'K1', collectionKey: 'C1' },
    });
    expect(store.getByLocalPath('p.pdf').state).toBe(STATE.OUT_OF_SCOPE_SUPPRESSED);
  });
});

// ─── UT-414 (review fix D2) ────────────────────────────────────────────────

describe('UT-414: moveFolder rewrites canonicalLocalPath for multi-collection items', () => {
  it('updates canonicalLocalPath for a file whose localPath is OUTSIDE the moved subtree', async () => {
    const store = await makeStore();
    // Two records for the same attachment in different collections.
    // Canonical is "Methods/paper.pdf" (in collection A=Methods),
    // localPath of the OTHER record is "Refs/paper.pdf" (collection B).
    // Canonical is OUTSIDE the localPath's subtree.
    store.add(createFileRecord({
      localPath: 'Refs/paper.pdf',
      canonicalLocalPath: 'Methods/paper.pdf',
      zoteroAttachmentKey: 'ATT-OTHER',
      lastSyncedHash: 'h1',
      state: STATE.CLEAN,
    }));
    init({ trackingStore: store });

    // Rename Methods → Methodology. The Refs-side record's localPath
    // doesn't change, but its canonicalLocalPath must be rewritten.
    const result = await execute({
      type: 'moveFolder',
      payload: {
        collectionKey: 'METHC',
        oldRelativePath: 'Methods',
        newRelativePath: 'Methodology',
      },
    });
    expect(result.ok).toBe(true);

    const rec = store.getByLocalPath('Refs/paper.pdf');
    expect(rec).toBeTruthy();
    expect(rec.canonicalLocalPath).toBe('Methodology/paper.pdf');
  });
});

// ─── UT-411 (review fix) ───────────────────────────────────────────────────

describe('UT-411: _createFolder preserves existing CollectionRecord state', () => {
  it('does not clobber OUT_OF_SCOPE_SUPPRESSED with CLEAN on re-emit', async () => {
    const store = await makeStore();
    store.add(createCollectionRecord({
      localPath: 'X', zoteroCollectionKey: 'SUB1', state: STATE.OUT_OF_SCOPE_SUPPRESSED,
    }));
    init({ trackingStore: store });
    const result = await execute({
      type: 'createFolder',
      payload: { collectionKey: 'SUB1', relativePath: 'X' },
    });
    expect(result.ok).toBe(true);
    expect(store.getCollectionRecord('SUB1').state).toBe(STATE.OUT_OF_SCOPE_SUPPRESSED);
  });

  it('uses CLEAN when no existing record', async () => {
    init({ trackingStore: await makeStore() });
    await execute({
      type: 'createFolder',
      payload: { collectionKey: 'SUB1', relativePath: 'X' },
    });
    expect(_getStore().getCollectionRecord('SUB1').state).toBe(STATE.CLEAN);
  });
});

// ─── UT-412 (review fix) ───────────────────────────────────────────────────

describe('UT-412: _moveFolder rejects empty oldRelativePath', () => {
  it('returns invalid-payload when oldRelativePath is empty string', async () => {
    init({ trackingStore: await makeStore() });
    const result = await execute({
      type: 'moveFolder',
      payload: { collectionKey: 'SUB1', oldRelativePath: '', newRelativePath: 'X' },
    });
    expect(result).toEqual({ ok: false, reason: 'invalid-payload' });
    expect(IOUtils.move).not.toHaveBeenCalled();
  });

  it('returns invalid-payload when oldRelativePath is undefined', async () => {
    init({ trackingStore: await makeStore() });
    const result = await execute({
      type: 'moveFolder',
      payload: { collectionKey: 'SUB1', newRelativePath: 'X' },
    });
    expect(result.reason).toBe('invalid-payload');
    expect(IOUtils.move).not.toHaveBeenCalled();
  });
});

// ─── UT-413 (review fix) ───────────────────────────────────────────────────

describe('UT-413: _removeItemMembership clears canonical on last-membership-removed', () => {
  it('clears canonicalCollectionKey when next.length === 0', async () => {
    const store = await makeStore();
    store.add(createFileRecord({
      localPath: 'p.pdf', zoteroAttachmentKey: 'K1',
      canonicalCollectionKey: 'CAN',
      collectionMembershipKeys: ['CAN'],
      state: STATE.CLEAN,
    }));
    init({ trackingStore: store });
    await execute({
      type: 'removeItemMembership',
      payload: { attachmentKey: 'K1', collectionKey: 'CAN' },
    });
    const rec = store.getByLocalPath('p.pdf');
    expect(rec.canonicalCollectionKey).toBe(null);
    expect(rec.state).toBe(STATE.OUT_OF_SCOPE_SUPPRESSED);
  });

  it('also clears canonical when the removed-canonical was the LAST membership but a DIFFERENT collection was the canonical', async () => {
    const store = await makeStore();
    store.add(createFileRecord({
      localPath: 'p.pdf', zoteroAttachmentKey: 'K1',
      canonicalCollectionKey: 'X',
      collectionMembershipKeys: ['Y'],
      state: STATE.CLEAN,
    }));
    init({ trackingStore: store });
    await execute({
      type: 'removeItemMembership',
      payload: { attachmentKey: 'K1', collectionKey: 'Y' },
    });
    const rec = store.getByLocalPath('p.pdf');
    expect(rec.collectionMembershipKeys).toEqual([]);
    expect(rec.canonicalCollectionKey).toBe(null);
    expect(rec.state).toBe(STATE.OUT_OF_SCOPE_SUPPRESSED);
  });
});

// ─── UT-410 ────────────────────────────────────────────────────────────────

describe('UT-410: per-key lock serializes concurrent calls', () => {
  it('runs two ops on the same collection key sequentially', async () => {
    const store = await makeStore();
    init({ trackingStore: store });

    // Make the first makeDirectory slow so we can prove the second waits.
    const order = [];
    let firstResolve;
    const firstDone = new Promise((r) => { firstResolve = r; });
    IOUtils.makeDirectory
      .mockImplementationOnce(async () => {
        order.push('start1');
        await firstDone;
        order.push('end1');
      })
      .mockImplementationOnce(async () => {
        order.push('start2');
        order.push('end2');
      });

    const p1 = execute({
      type: 'createFolder',
      payload: { collectionKey: 'SUB1', relativePath: 'A' },
    });
    const p2 = execute({
      type: 'createFolder',
      payload: { collectionKey: 'SUB1', relativePath: 'B' },
    });

    // Yield to macrotasks so p1's async prelude runs (mock pushes 'start1').
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['start1']);
    firstResolve();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['start1', 'end1', 'start2', 'end2']);
  });

  it('allows ops on DIFFERENT collection keys to interleave', async () => {
    init({ trackingStore: await makeStore() });
    const order = [];
    let resolve1;
    const block = new Promise((r) => { resolve1 = r; });
    IOUtils.makeDirectory.mockImplementation(async (path) => {
      order.push(`start:${path}`);
      if (path === '/watch/A') await block;
      order.push(`end:${path}`);
    });
    const p1 = execute({
      type: 'createFolder',
      payload: { collectionKey: 'SUB1', relativePath: 'A' },
    });
    const p2 = execute({
      type: 'createFolder',
      payload: { collectionKey: 'SUB2', relativePath: 'B' },
    });
    // Both should be able to enter before A is unblocked.
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toContain('start:/watch/A');
    expect(order).toContain('start:/watch/B');
    expect(order).toContain('end:/watch/B');
    expect(order).not.toContain('end:/watch/A');
    resolve1();
    await Promise.all([p1, p2]);
  });
});
