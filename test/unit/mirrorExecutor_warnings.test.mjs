/**
 * Integration tests: mirrorExecutor → warningSink wiring (v2.1 Phase D).
 *
 * Verifies that the right warning categories fire on the right action
 * outcomes. The executor and the sink are both real here; tests inspect
 * sink state after exercising the executor.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../content/utils.mjs', async () => {
  const actual = await vi.importActual('../../content/utils.mjs');
  return {
    ...actual,
    getFileHash: vi.fn(async () => 'fakehash'),
    getPref: vi.fn((key) => ({ sourcePath: '/watch' }[key])),
  };
});

import {
  execute,
  init,
  reset,
} from '../../content/mirrorExecutor.mjs';
import {
  getRecent,
  getCountsByCategory,
  WARNING_CATEGORY,
  _resetForTesting,
} from '../../content/warningSink.mjs';
import { TrackingStore, createFileRecord, createCollectionRecord, STATE } from '../../content/trackingStore.mjs';
import { getFileHash } from '../../content/utils.mjs';

async function makeStore() {
  const store = new TrackingStore();
  store.dataFile = '/tmp/x.json';
  store._initialized = true;
  return store;
}

beforeEach(() => {
  vi.clearAllMocks();
  Zotero.debug = vi.fn();
  Zotero.logError = vi.fn();
  IOUtils.exists = vi.fn(async () => true);
  IOUtils.makeDirectory = vi.fn(async () => {});
  IOUtils.move = vi.fn(async () => {});
  IOUtils.copy = vi.fn(async () => {});
  IOUtils.remove = vi.fn(async () => {});
  IOUtils.writeJSON = vi.fn(async () => {});
  reset();
  _resetForTesting();
  getFileHash.mockImplementation(async () => 'fakehash');
});

describe('mirrorExecutor → warningSink integration', () => {
  it('reports CONFLICT_BLOCKED when moveItem refuses on hash drift', async () => {
    const store = await makeStore();
    store.add(createFileRecord({
      localPath: 'old/p.pdf',
      canonicalLocalPath: 'old/p.pdf',
      zoteroAttachmentKey: 'K1',
      lastSyncedHash: 'OLD',
      state: STATE.CLEAN,
    }));
    init({ trackingStore: store });
    getFileHash.mockResolvedValueOnce('NEW');

    await execute({
      type: 'moveItem',
      payload: {
        attachmentKey: 'K1',
        oldCanonicalPath: 'old/p.pdf',
        newCanonicalPath: 'new/p.pdf',
      },
    });

    const counts = getCountsByCategory();
    expect(counts.get(WARNING_CATEGORY.CONFLICT_BLOCKED)).toBe(1);
    expect(getRecent(1)[0].attachmentKey).toBe('K1');
  });

  it('reports MISSING_FILE when moveItem target vanished', async () => {
    const store = await makeStore();
    store.add(createFileRecord({
      localPath: 'old/p.pdf',
      canonicalLocalPath: 'old/p.pdf',
      zoteroAttachmentKey: 'K1',
      lastSyncedHash: 'OLD',
      state: STATE.CLEAN,
    }));
    init({ trackingStore: store });
    IOUtils.exists.mockResolvedValueOnce(false);

    await execute({
      type: 'moveItem',
      payload: {
        attachmentKey: 'K1',
        oldCanonicalPath: 'old/p.pdf',
        newCanonicalPath: 'new/p.pdf',
      },
    });

    const counts = getCountsByCategory();
    expect(counts.get(WARNING_CATEGORY.MISSING_FILE)).toBe(1);
  });

  it('reports IO_ERROR when createFolder mkdir fails', async () => {
    init({ trackingStore: await makeStore() });
    IOUtils.makeDirectory.mockRejectedValueOnce(new Error('EACCES'));
    await execute({
      type: 'createFolder',
      payload: { collectionKey: 'SUB1', relativePath: 'X' },
    });
    expect(getCountsByCategory().get(WARNING_CATEGORY.IO_ERROR)).toBe(1);
  });

  it('reports SUPPRESSED when deleteFolder fires in Mode 2', async () => {
    const store = await makeStore();
    store.add(createCollectionRecord({
      localPath: 'X', zoteroCollectionKey: 'SUB1', state: STATE.CLEAN,
    }));
    init({ trackingStore: store });
    await execute({
      type: 'deleteFolder',
      payload: { collectionKey: 'SUB1', oldRelativePath: 'X' },
    });
    expect(getCountsByCategory().get(WARNING_CATEGORY.SUPPRESSED)).toBe(1);
  });

  it('reports SUPPRESSED when removeItemMembership drops the last membership', async () => {
    const store = await makeStore();
    store.add(createFileRecord({
      localPath: 'p.pdf', zoteroAttachmentKey: 'K1',
      collectionMembershipKeys: ['CAN'], canonicalCollectionKey: 'CAN',
      state: STATE.CLEAN,
    }));
    init({ trackingStore: store });
    await execute({
      type: 'removeItemMembership',
      payload: { attachmentKey: 'K1', collectionKey: 'CAN' },
    });
    expect(getCountsByCategory().get(WARNING_CATEGORY.SUPPRESSED)).toBe(1);
  });

  it('reports UNKNOWN_TARGET when addItemMembership lands on an untracked attachment', async () => {
    init({ trackingStore: await makeStore() });
    await execute({
      type: 'addItemMembership',
      payload: { attachmentKey: 'NOPE', collectionKey: 'C1' },
    });
    expect(getCountsByCategory().get(WARNING_CATEGORY.UNKNOWN_TARGET)).toBe(1);
  });
});
