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
 *   UT-411..UT-415 review/SUPP/MCP fixes
 *   UT-416 moveItem reads live canonicalLocalPath after stale payload (Track A #3)
 *   UT-417 moveItem uses live source when destination differs from live (Track A #3)
 *   UT-418 moveFolder acquires per-attachment lock for each child (Track A #4)
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
// Mock canonicalPath so the sync-root scope filter in
// _removeItemMembership can be controlled per test.
vi.mock('../../content/canonicalPath.mjs', async () => {
  const actual = await vi.importActual('../../content/canonicalPath.mjs');
  return {
    ...actual,
    collectionKeyToRelativePath: vi.fn(async () => null), // default: nothing is under sync root
  };
});

import { execute, canSafelyMove, init, reset, _getStore } from '../../content/mirrorExecutor.mjs';
import { TrackingStore, createFileRecord, createCollectionRecord, STATE } from '../../content/trackingStore.mjs';
import { getFileHash, getPref } from '../../content/utils.mjs';
import { collectionKeyToRelativePath } from '../../content/canonicalPath.mjs';

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

  it('addItemMembership clears OUT_OF_SCOPE_SUPPRESSED when a sync-root collection is re-added', async () => {
    // Safety net for the RecognizePDF reparenting flow: even when the
    // remove fires before the parent add (so the record gets suppressed
    // transiently), re-adding membership to a sync-root collection
    // should restore the record to CLEAN automatically. USER_DETACHED
    // is NOT auto-cleared (those are explicit user decisions).
    const store = await makeStore();
    store.add(createFileRecord({
      localPath: 'p.pdf', zoteroAttachmentKey: 'K1',
      collectionMembershipKeys: [],
      canonicalCollectionKey: null,
      state: STATE.OUT_OF_SCOPE_SUPPRESSED,
    }));
    init({ trackingStore: store });
    // C1 IS under the sync root
    collectionKeyToRelativePath.mockResolvedValue('Methods');
    const result = await execute({
      type: 'addItemMembership',
      payload: { attachmentKey: 'K1', collectionKey: 'C1' },
    });
    expect(result.ok).toBe(true);
    const rec = store.getByLocalPath('p.pdf');
    expect(rec.collectionMembershipKeys).toEqual(['C1']);
    expect(rec.state).toBe(STATE.CLEAN);
    expect(rec.canonicalCollectionKey).toBe('C1');
  });

  it('addItemMembership does NOT clear suppression when the re-added collection is OUTSIDE the sync root', async () => {
    const store = await makeStore();
    store.add(createFileRecord({
      localPath: 'p.pdf', zoteroAttachmentKey: 'K1',
      collectionMembershipKeys: [],
      canonicalCollectionKey: null,
      state: STATE.OUT_OF_SCOPE_SUPPRESSED,
    }));
    init({ trackingStore: store });
    // Outside sync root
    collectionKeyToRelativePath.mockResolvedValue(null);
    await execute({
      type: 'addItemMembership',
      payload: { attachmentKey: 'K1', collectionKey: 'OUTSIDE' },
    });
    const rec = store.getByLocalPath('p.pdf');
    expect(rec.collectionMembershipKeys).toEqual(['OUTSIDE']);
    expect(rec.state).toBe(STATE.OUT_OF_SCOPE_SUPPRESSED); // unchanged
  });

  it('addItemMembership leaves USER_DETACHED records alone (explicit user choice)', async () => {
    const store = await makeStore();
    store.add(createFileRecord({
      localPath: 'p.pdf', zoteroAttachmentKey: 'K1',
      collectionMembershipKeys: [],
      canonicalCollectionKey: null,
      state: STATE.USER_DETACHED,
    }));
    init({ trackingStore: store });
    collectionKeyToRelativePath.mockResolvedValue('Methods');
    await execute({
      type: 'addItemMembership',
      payload: { attachmentKey: 'K1', collectionKey: 'C1' },
    });
    const rec = store.getByLocalPath('p.pdf');
    expect(rec.state).toBe(STATE.USER_DETACHED);
  });

  it('removeItemMembership drops the key and clears canonical when canonical (C2 IS under sync root)', async () => {
    const store = await makeStore();
    store.add(createFileRecord({
      localPath: 'p.pdf', zoteroAttachmentKey: 'K1',
      canonicalCollectionKey: 'C1',
      collectionMembershipKeys: ['C1', 'C2'], state: STATE.CLEAN,
    }));
    init({ trackingStore: store });
    // C2 IS under the sync root → at least one sync-root membership
    // remains → NO suppression flip; canonical cleared (it pointed at
    // the just-removed C1).
    collectionKeyToRelativePath.mockImplementation(async (k) => (k === 'C2' ? 'somewhere' : null));
    const result = await execute({
      type: 'removeItemMembership',
      payload: { attachmentKey: 'K1', collectionKey: 'C1' },
    });
    expect(result.ok).toBe(true);
    const rec = store.getByLocalPath('p.pdf');
    expect(rec.collectionMembershipKeys).toEqual(['C2']);
    expect(rec.canonicalCollectionKey).toBe(null);
    expect(rec.state).toBe(STATE.CLEAN); // not suppressed
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

// ─── UT-415 (live MCP SUPP.1 fix) ──────────────────────────────────────────

describe('UT-415: _removeItemMembership counts SYNC-ROOT memberships only', () => {
  it('flips to suppressed when remaining membership is OUTSIDE the sync root', async () => {
    const store = await makeStore();
    store.add(createFileRecord({
      localPath: 'p.pdf', zoteroAttachmentKey: 'K1',
      canonicalCollectionKey: 'SUB1',
      collectionMembershipKeys: ['SUB1', 'INBOX'], state: STATE.CLEAN,
    }));
    init({ trackingStore: store });
    // SUB1 is the sync root (or under it), INBOX is outside. After
    // removing SUB1, only INBOX remains — but that's not counted as
    // sync-root → suppression should fire.
    collectionKeyToRelativePath.mockImplementation(async (k) => (k === 'SUB1' ? '' : null));

    const result = await execute({
      type: 'removeItemMembership',
      payload: { attachmentKey: 'K1', collectionKey: 'SUB1' },
    });
    expect(result.ok).toBe(true);
    const rec = store.getByLocalPath('p.pdf');
    expect(rec.collectionMembershipKeys).toEqual(['INBOX']); // INBOX kept in the list
    expect(rec.canonicalCollectionKey).toBe(null);
    expect(rec.state).toBe(STATE.OUT_OF_SCOPE_SUPPRESSED);
  });

  it('keeps state clean when at least one remaining membership IS under sync root', async () => {
    const store = await makeStore();
    store.add(createFileRecord({
      localPath: 'p.pdf', zoteroAttachmentKey: 'K1',
      canonicalCollectionKey: 'SUB1',
      collectionMembershipKeys: ['SUB1', 'SUB2'], state: STATE.CLEAN,
    }));
    init({ trackingStore: store });
    // Both SUB1 and SUB2 are under the sync root.
    collectionKeyToRelativePath.mockImplementation(async () => 'somewhere');

    await execute({
      type: 'removeItemMembership',
      payload: { attachmentKey: 'K1', collectionKey: 'SUB1' },
    });
    expect(store.getByLocalPath('p.pdf').state).toBe(STATE.CLEAN);
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

// ─── UT-416 (Track A #3 — moveItem stale oldCanonicalPath race) ───────────

describe('UT-416: _moveItem reads live canonicalLocalPath after stale payload', () => {
  it('no-ops when a prior same-cycle action already moved the file to the destination', async () => {
    const store = await makeStore();
    // Seed at A/paper.pdf.
    store.add(createFileRecord({
      localPath: 'A/paper.pdf', canonicalLocalPath: 'A/paper.pdf',
      zoteroAttachmentKey: 'K1', lastSyncedHash: 'fakehash',
      state: STATE.CLEAN,
    }));
    init({ trackingStore: store });

    // Simulate same-cycle rewrite: a moveFolder already relocated it to B.
    store.update('A/paper.pdf', { canonicalLocalPath: 'B/paper.pdf' });
    // Note: localPath stays as the Map key in this test; the live canonical
    // is what _moveItem consults for the source path.

    const result = await execute({
      type: 'moveItem',
      payload: {
        attachmentKey: 'K1',
        oldCanonicalPath: 'A/paper.pdf', // stale
        newCanonicalPath: 'B/paper.pdf',
      },
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('no-op');
    expect(IOUtils.move).not.toHaveBeenCalled();
  });
});

// ─── UT-417 (Track A #3 — stale payload still resolves correct source) ────

describe('UT-417: _moveItem uses live source when destination differs from live', () => {
  it('moves from B (live) to C, not A (stale payload)', async () => {
    const store = await makeStore();
    store.add(createFileRecord({
      localPath: 'A/paper.pdf', canonicalLocalPath: 'A/paper.pdf',
      zoteroAttachmentKey: 'K1', lastSyncedHash: 'fakehash',
      state: STATE.CLEAN,
    }));
    init({ trackingStore: store });

    // Same-cycle rewrite to B.
    store.update('A/paper.pdf', { canonicalLocalPath: 'B/paper.pdf' });

    const result = await execute({
      type: 'moveItem',
      payload: {
        attachmentKey: 'K1',
        oldCanonicalPath: 'A/paper.pdf', // stale
        newCanonicalPath: 'C/paper.pdf',
      },
    });
    expect(result.ok).toBe(true);
    // Source must be the LIVE path (B), not the stale payload (A).
    expect(IOUtils.move).toHaveBeenCalledWith('/watch/B/paper.pdf', '/watch/C/paper.pdf', expect.any(Object));
    expect(IOUtils.move).not.toHaveBeenCalledWith('/watch/A/paper.pdf', expect.anything(), expect.anything());
  });
});

// ─── UT-418 (Track A #4 — per-attachment lock during moveFolder rewrite) ──

describe('UT-418: _moveFolder acquires per-attachment lock for each child', () => {
  it('serializes a concurrent moveItem against a child attachment', async () => {
    const store = await makeStore();
    store.add(createCollectionRecord({
      localPath: 'Old', zoteroCollectionKey: 'SUB1', state: STATE.CLEAN,
    }));
    store.add(createFileRecord({
      localPath: 'Old/paper.pdf', canonicalLocalPath: 'Old/paper.pdf',
      zoteroAttachmentKey: 'K1', lastSyncedHash: 'fakehash',
      state: STATE.CLEAN,
    }));
    init({ trackingStore: store });

    const order = [];
    let releaseMove;
    const moveBlock = new Promise((r) => { releaseMove = r; });

    // Block IOUtils.move (the moveFolder rename) so we can prove the
    // concurrent moveItem cannot enter the per-attachment lock while
    // moveFolder's rewrite loop is still in flight.
    IOUtils.move.mockImplementation(async (src, dst) => {
      if (src === '/watch/Old') {
        order.push('moveFolder:io-start');
        await moveBlock;
        order.push('moveFolder:io-end');
      } else {
        order.push(`moveItem:io ${src} → ${dst}`);
      }
    });

    const pFolder = execute({
      type: 'moveFolder',
      payload: {
        collectionKey: 'SUB1',
        oldRelativePath: 'Old',
        newRelativePath: 'New',
      },
    });

    // Give moveFolder time to enter IOUtils.move (and therefore reach the
    // per-attachment rewrite loop only AFTER we release).
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['moveFolder:io-start']);

    // Queue a concurrent moveItem on the same attachment. It must wait
    // until moveFolder has released the per-attachment lock around the
    // rewrite. The payload references the post-rewrite path so this is a
    // benign no-op once it does run.
    const pItem = execute({
      type: 'moveItem',
      payload: {
        attachmentKey: 'K1',
        oldCanonicalPath: 'New/paper.pdf',
        newCanonicalPath: 'New/paper.pdf',
      },
    });

    // Yield: moveItem must NOT have observed any state yet (still queued
    // behind moveFolder's IO + rewrite).
    await new Promise((r) => setTimeout(r, 0));
    // moveItem on a same-key payload short-circuits to no-op before any IO,
    // so the only way to detect interleaving is to check that the FS-level
    // move-folder did not yet end.
    expect(order).toEqual(['moveFolder:io-start']);

    releaseMove();
    await Promise.all([pFolder, pItem]);
    expect(order[0]).toBe('moveFolder:io-start');
    expect(order).toContain('moveFolder:io-end');

    // Final state: record is re-keyed under New/, and the moveItem ran AFTER
    // the rewrite (so it saw the new path).
    expect(store.getByLocalPath('Old/paper.pdf')).toBe(null);
    expect(store.getByLocalPath('New/paper.pdf')).toBeTruthy();
  });

  it('skips records with no zoteroAttachmentKey instead of locking on attachment:undefined', async () => {
    const store = await makeStore();
    store.add(createCollectionRecord({
      localPath: 'Old', zoteroCollectionKey: 'SUB1', state: STATE.CLEAN,
    }));
    // A bogus record with no attachment key. Skipped by the rewrite loop.
    store.add(createFileRecord({
      localPath: 'Old/orphan.pdf', canonicalLocalPath: 'Old/orphan.pdf',
      zoteroAttachmentKey: '', lastSyncedHash: 'h',
      state: STATE.CLEAN,
    }));
    init({ trackingStore: store });

    const result = await execute({
      type: 'moveFolder',
      payload: {
        collectionKey: 'SUB1',
        oldRelativePath: 'Old',
        newRelativePath: 'New',
      },
    });
    expect(result.ok).toBe(true);
    // The orphan record is NOT rewritten (would have collided on the
    // attachment:undefined lock key).
    expect(store.getByLocalPath('Old/orphan.pdf')).toBeTruthy();
    expect(store.getByLocalPath('New/orphan.pdf')).toBe(null);
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

// ─── UT-419 (Track C — _deleteFolder Mode 3 plugin trash) ───────────────────

describe('UT-419: _deleteFolder Mode 3 routes through plugin trash', () => {
  beforeEach(() => {
    getPref.mockImplementation((key) => {
      if (key === 'sourcePath') return '/watch';
      if (key === 'mode') return 'mode3';
      return undefined;
    });
  });

  it('recursive-moves the folder into .zotero-watch-trash/<rel> and drops collection + child file records', async () => {
    const store = await makeStore();
    store.add(createCollectionRecord({
      localPath: 'Methods', zoteroCollectionKey: 'SUB1', state: STATE.CLEAN,
    }));
    store.add(createFileRecord({
      localPath: 'Methods/a.pdf', canonicalLocalPath: 'Methods/a.pdf',
      zoteroAttachmentKey: 'K1', lastSyncedHash: 'h', state: STATE.CLEAN,
    }));
    store.add(createFileRecord({
      localPath: 'Methods/sub/b.pdf', canonicalLocalPath: 'Methods/sub/b.pdf',
      zoteroAttachmentKey: 'K2', lastSyncedHash: 'h', state: STATE.CLEAN,
    }));
    // A file OUTSIDE the deleted folder — must stay tracked.
    store.add(createFileRecord({
      localPath: 'Other/c.pdf', canonicalLocalPath: 'Other/c.pdf',
      zoteroAttachmentKey: 'K3', lastSyncedHash: 'h', state: STATE.CLEAN,
    }));
    init({ trackingStore: store });

    // Source dir exists; destination doesn't (no collision).
    IOUtils.exists.mockImplementation(async (p) => p === '/watch/Methods');

    const result = await execute({
      type: 'deleteFolder',
      payload: { collectionKey: 'SUB1', oldRelativePath: 'Methods' },
    });

    expect(result.ok).toBe(true);
    expect(result.trashPath).toBe('.zotero-watch-trash/Methods');
    expect(IOUtils.move).toHaveBeenCalledWith(
      '/watch/Methods',
      '/watch/.zotero-watch-trash/Methods',
      expect.anything()
    );
    expect(store.getCollectionRecord('SUB1')).toBe(null);
    expect(store.getByLocalPath('Methods/a.pdf')).toBe(null);
    expect(store.getByLocalPath('Methods/sub/b.pdf')).toBe(null);
    // Outside the subtree — untouched.
    expect(store.getByLocalPath('Other/c.pdf')).not.toBe(null);
  });

  it('collision: suffixes dst dir with millisecond timestamp', async () => {
    const store = await makeStore();
    store.add(createCollectionRecord({
      localPath: 'Methods', zoteroCollectionKey: 'SUB1', state: STATE.CLEAN,
    }));
    init({ trackingStore: store });

    // Both source AND existing plugin-trash destination exist.
    IOUtils.exists.mockImplementation(async (p) =>
      p === '/watch/Methods' || p === '/watch/.zotero-watch-trash/Methods'
    );
    const before = Date.now();

    const result = await execute({
      type: 'deleteFolder',
      payload: { collectionKey: 'SUB1', oldRelativePath: 'Methods' },
    });

    expect(result.ok).toBe(true);
    expect(result.trashPath).toMatch(/^\.zotero-watch-trash\/Methods\.\d+$/);
    const stamp = parseInt(result.trashPath.match(/Methods\.(\d+)$/)[1], 10);
    expect(stamp).toBeGreaterThanOrEqual(before);
  });

  it('source already missing → drops tracking + returns ok with already-missing reason', async () => {
    const store = await makeStore();
    store.add(createCollectionRecord({
      localPath: 'Methods', zoteroCollectionKey: 'SUB1', state: STATE.CLEAN,
    }));
    init({ trackingStore: store });

    IOUtils.exists.mockResolvedValue(false);

    const result = await execute({
      type: 'deleteFolder',
      payload: { collectionKey: 'SUB1', oldRelativePath: 'Methods' },
    });

    expect(result.ok).toBe(true);
    expect(result.reason).toBe('already-missing');
    expect(IOUtils.move).not.toHaveBeenCalled();
    expect(store.getCollectionRecord('SUB1')).toBe(null);
  });

  it('Mode 2 still warn-only (collection state flipped, no IO)', async () => {
    getPref.mockImplementation((key) => {
      if (key === 'sourcePath') return '/watch';
      if (key === 'mode') return 'mode2';
      return undefined;
    });
    const store = await makeStore();
    store.add(createCollectionRecord({
      localPath: 'Methods', zoteroCollectionKey: 'SUB1', state: STATE.CLEAN,
    }));
    init({ trackingStore: store });

    const result = await execute({
      type: 'deleteFolder',
      payload: { collectionKey: 'SUB1', oldRelativePath: 'Methods' },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('warn-only-mode2');
    expect(IOUtils.move).not.toHaveBeenCalled();
    expect(store.getCollectionRecord('SUB1').state).toBe(STATE.OUT_OF_SCOPE_SUPPRESSED);
  });
});

// ─── UT-420 (Track C — bulk-delete protection) ──────────────────────────────

describe('UT-420: _deleteFolder bulk-delete protection (Mode 3)', () => {
  beforeEach(() => {
    getPref.mockImplementation((key) => {
      if (key === 'sourcePath') return '/watch';
      if (key === 'mode') return 'mode3';
      return undefined;
    });
    // Reset confirmEx to the default (approve) at the start of each test.
    Services.prompt.confirmEx.mockReturnValue(0);
    IOUtils.exists.mockImplementation(async (p) => p === '/watch/Big');
  });

  function seedBigFolder(store, fileCount) {
    store.add(createCollectionRecord({
      localPath: 'Big', zoteroCollectionKey: 'SUB1', state: STATE.CLEAN,
    }));
    for (let i = 0; i < fileCount; i++) {
      store.add(createFileRecord({
        localPath: `Big/file${i}.pdf`, canonicalLocalPath: `Big/file${i}.pdf`,
        zoteroAttachmentKey: `K${i}`, lastSyncedHash: `h${i}`, state: STATE.CLEAN,
      }));
    }
  }

  it('over-threshold by count (>10) prompts before moving', async () => {
    const store = await makeStore();
    seedBigFolder(store, 11);
    init({ trackingStore: store });

    const result = await execute({
      type: 'deleteFolder',
      payload: { collectionKey: 'SUB1', oldRelativePath: 'Big' },
    });

    expect(Services.prompt.confirmEx).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(IOUtils.move).toHaveBeenCalled();
  });

  it('over-threshold by percent (>20%) prompts before moving', async () => {
    const store = await makeStore();
    // 3 files in Big + 2 files outside → 3/5 = 60% over threshold.
    seedBigFolder(store, 3);
    store.add(createFileRecord({ localPath: 'Other/x.pdf', canonicalLocalPath: 'Other/x.pdf', zoteroAttachmentKey: 'OK1', lastSyncedHash: 'h', state: STATE.CLEAN }));
    store.add(createFileRecord({ localPath: 'Other/y.pdf', canonicalLocalPath: 'Other/y.pdf', zoteroAttachmentKey: 'OK2', lastSyncedHash: 'h', state: STATE.CLEAN }));
    init({ trackingStore: store });

    const result = await execute({
      type: 'deleteFolder',
      payload: { collectionKey: 'SUB1', oldRelativePath: 'Big' },
    });

    expect(Services.prompt.confirmEx).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  it('under both thresholds (≤10 AND ≤20%) skips the prompt entirely', async () => {
    const store = await makeStore();
    // 2 files in Big + 20 files outside → 2 ≤10 AND 2/22 = ~9% ≤20%.
    seedBigFolder(store, 2);
    for (let i = 0; i < 20; i++) {
      store.add(createFileRecord({
        localPath: `Other/o${i}.pdf`, canonicalLocalPath: `Other/o${i}.pdf`,
        zoteroAttachmentKey: `OK${i}`, lastSyncedHash: 'h', state: STATE.CLEAN,
      }));
    }
    init({ trackingStore: store });

    const result = await execute({
      type: 'deleteFolder',
      payload: { collectionKey: 'SUB1', oldRelativePath: 'Big' },
    });

    expect(Services.prompt.confirmEx).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(IOUtils.move).toHaveBeenCalled();
  });

  it('user declines → no move, no tracking change, returns bulk-confirm-denied', async () => {
    Services.prompt.confirmEx.mockReturnValue(1); // user chose Cancel
    const store = await makeStore();
    seedBigFolder(store, 15);
    init({ trackingStore: store });

    const result = await execute({
      type: 'deleteFolder',
      payload: { collectionKey: 'SUB1', oldRelativePath: 'Big' },
    });

    expect(Services.prompt.confirmEx).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bulk-confirm-denied');
    expect(result.affectedCount).toBe(15);
    expect(IOUtils.move).not.toHaveBeenCalled();
    // Tracking record untouched.
    expect(store.getCollectionRecord('SUB1')).not.toBe(null);
    expect(store.getByLocalPath('Big/file0.pdf')).not.toBe(null);
  });

  it('no Services.prompt available → refuses (safer than silent execution)', async () => {
    const originalPrompt = Services.prompt;
    Services.prompt = undefined;
    try {
      const store = await makeStore();
      seedBigFolder(store, 15);
      init({ trackingStore: store });

      const result = await execute({
        type: 'deleteFolder',
        payload: { collectionKey: 'SUB1', oldRelativePath: 'Big' },
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe('bulk-confirm-denied');
      expect(IOUtils.move).not.toHaveBeenCalled();
    } finally {
      Services.prompt = originalPrompt;
    }
  });
});
