/**
 * Unit tests for content/storageStrategy.mjs — the PDF storage strategy layer.
 *
 * Covers:
 *   UT-900 getStorageStrategy (incl. legacy importMode=linked migration)
 *   UT-901 buttonForStrategy (drives prefs-pane button visibility)
 *   UT-902 explainer constants mention metadata/notes/annotations vs PDF files
 *   UT-903 previewReclaim classifies annotated vs un-annotated
 *   UT-904 runReclaim converts only un-annotated, preserves parent, recoverable
 *   UT-905 runReclaim aborts on hash-verify mismatch (leaves stored, untouched)
 *   UT-906 runMirror copies stored→watch and keeps stored attachments
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../content/utils.mjs', async () => {
  const actual = await vi.importActual('../../content/utils.mjs');
  return { ...actual, getPref: vi.fn(), getFileHash: vi.fn() };
});
vi.mock('../../content/canonicalPath.mjs', async () => {
  const actual = await vi.importActual('../../content/canonicalPath.mjs');
  return {
    ...actual,
    resolveSyncRoot: vi.fn(),
    chooseCanonicalCollection: vi.fn(),
    collectionKeyToDiskRelativePath: vi.fn(),
  };
});
vi.mock('../../content/baseline.mjs', () => ({
  enumerateSyncRootAttachments: vi.fn(),
  adoptCollectionSubtree: vi.fn(),
  copyAttachmentToCanonical: vi.fn(),
}));
vi.mock('../../content/trackingStore.mjs', async () => {
  const actual = await vi.importActual('../../content/trackingStore.mjs');
  return { ...actual, getTrackingStore: vi.fn() };
});
vi.mock('../../content/warningSink.mjs', () => ({
  report: vi.fn(),
  WARNING_CATEGORY: { IO_ERROR: 'io-error' },
}));

import * as storageStrategy from '../../content/storageStrategy.mjs';
import { getPref, getFileHash } from '../../content/utils.mjs';
import { resolveSyncRoot, chooseCanonicalCollection, collectionKeyToDiskRelativePath } from '../../content/canonicalPath.mjs';
import * as baseline from '../../content/baseline.mjs';
import { getTrackingStore } from '../../content/trackingStore.mjs';
import { report as reportWarning } from '../../content/warningSink.mjs';

const { STRATEGY } = storageStrategy;

function prefMap(map) {
  getPref.mockImplementation((k) => map[k]);
}

function mockStore() {
  return {
    add: vi.fn(),
    removeByAttachmentKey: vi.fn(),
    save: vi.fn(async () => {}),
  };
}

function mockAttachment(opts = {}) {
  const {
    key = 'ATT1', filename = 'paper.pdf', stored = true,
    annotations = [], notes = [], path = '/zotero/storage/ATT1/paper.pdf',
    parentItemID = null, tags = [], collections = [],
  } = opts;
  return {
    key,
    attachmentFilename: filename,
    parentItemID,
    deleted: false,
    isStoredFileAttachment: () => stored,
    getAnnotations: () => annotations,
    getNotes: () => notes,
    getFilePathAsync: async () => path,
    getTags: () => tags,
    getCollections: () => collections,
    setTags: vi.fn(),
    saveTx: vi.fn(async function () { /* persists this.deleted */ }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.Zotero = globalThis.Zotero || {};
  globalThis.Zotero.debug = vi.fn();
  globalThis.Zotero.logError = vi.fn();
  globalThis.Zotero.Attachments = { linkFromFile: vi.fn(), LINK_MODE_IMPORTED_FILE: 1 };
  globalThis.Zotero.Items = { get: vi.fn() };
  globalThis.IOUtils = {
    exists: vi.fn(async () => false),
    copy: vi.fn(async () => {}),
    makeDirectory: vi.fn(async () => {}),
    stat: vi.fn(async () => ({ size: 1024, lastModified: 1 })),
  };
  globalThis.PathUtils = {
    join: (...parts) => parts.join('/'),
    parent: (p) => p.split('/').slice(0, -1).join('/'),
    filename: (p) => p.split('/').pop(),
  };
});

// ─── UT-900 ──────────────────────────────────────────────────────────────────

describe('UT-900: getStorageStrategy', () => {
  it('returns the explicit pdfStorageStrategy value', () => {
    prefMap({ pdfStorageStrategy: 'linked_watch_folder' });
    expect(storageStrategy.getStorageStrategy()).toBe(STRATEGY.LINKED_WATCH_FOLDER);
    prefMap({ pdfStorageStrategy: 'stored_plus_mirror' });
    expect(storageStrategy.getStorageStrategy()).toBe(STRATEGY.STORED_PLUS_MIRROR);
  });

  it('defaults to stored', () => {
    prefMap({ pdfStorageStrategy: 'stored' });
    expect(storageStrategy.getStorageStrategy()).toBe(STRATEGY.STORED);
    prefMap({});
    expect(storageStrategy.getStorageStrategy()).toBe(STRATEGY.STORED);
  });

  it('migrates a legacy importMode=linked to linked_watch_folder', () => {
    prefMap({ pdfStorageStrategy: 'stored', importMode: 'linked' });
    expect(storageStrategy.getStorageStrategy()).toBe(STRATEGY.LINKED_WATCH_FOLDER);
    prefMap({ importMode: 'linked' }); // pdfStorageStrategy unset
    expect(storageStrategy.getStorageStrategy()).toBe(STRATEGY.LINKED_WATCH_FOLDER);
  });
});

// ─── UT-901 ──────────────────────────────────────────────────────────────────

describe('UT-901: buttonForStrategy', () => {
  it('linked_watch_folder → reclaim', () => {
    expect(storageStrategy.buttonForStrategy(STRATEGY.LINKED_WATCH_FOLDER)).toBe('reclaim');
  });
  it('stored_plus_mirror → mirror', () => {
    expect(storageStrategy.buttonForStrategy(STRATEGY.STORED_PLUS_MIRROR)).toBe('mirror');
  });
  it('stored → null (no conversion button)', () => {
    expect(storageStrategy.buttonForStrategy(STRATEGY.STORED)).toBe(null);
    expect(storageStrategy.buttonForStrategy('anything-else')).toBe(null);
  });
});

// ─── UT-902 ──────────────────────────────────────────────────────────────────

describe('UT-902: explanatory text distinguishes data sync from file sync', () => {
  it('STORAGE_EXPLAINER mentions metadata, notes, annotations/highlights, and PDF', () => {
    const t = storageStrategy.STORAGE_EXPLAINER.toLowerCase();
    expect(t).toMatch(/metadata/);
    expect(t).toMatch(/notes/);
    expect(t).toMatch(/annotation|highlight/);
    expect(t).toMatch(/pdf/);
  });
  it('RESTORE_EXPLAINER_LINKED mentions restoring metadata/notes/annotations + base directory', () => {
    const t = storageStrategy.RESTORE_EXPLAINER_LINKED.toLowerCase();
    expect(t).toMatch(/metadata/);
    expect(t).toMatch(/notes/);
    expect(t).toMatch(/annotation/);
    expect(t).toMatch(/base directory/);
  });
  it('RECLAIM_CONFIRM_NOTE states metadata/notes/annotations still sync', () => {
    const t = storageStrategy.RECLAIM_CONFIRM_NOTE.toLowerCase();
    expect(t).toMatch(/metadata/);
    expect(t).toMatch(/notes/);
    expect(t).toMatch(/annotation/);
  });
});

// ─── UT-903 ──────────────────────────────────────────────────────────────────

describe('UT-903: previewReclaim classifies annotated vs un-annotated', () => {
  beforeEach(() => {
    resolveSyncRoot.mockResolvedValue({ collection: { key: 'ROOT1' }, libraryID: 1 });
  });

  it('annotated PDFs are kept stored; un-annotated are convertible', async () => {
    const clean = mockAttachment({ key: 'CLEAN', filename: 'clean.pdf' });
    const annotated = mockAttachment({ key: 'ANNO', filename: 'anno.pdf', annotations: [{ id: 1 }, { id: 2 }] });
    baseline.enumerateSyncRootAttachments.mockResolvedValue({
      attachments: [
        { attachment: clean, item: clean },
        { attachment: annotated, item: annotated },
      ],
    });

    const preview = await storageStrategy.previewReclaim();

    expect(preview.ok).toBe(true);
    expect(preview.convertible.map(c => c.key)).toEqual(['CLEAN']);
    expect(preview.keptStored).toEqual([
      { key: 'ANNO', filename: 'anno.pdf', reason: 'has-annotations' },
    ]);
    expect(preview.totalBytes).toBe(1024);
  });

  it('returns no-sync-root when none is configured', async () => {
    resolveSyncRoot.mockResolvedValue(null);
    const preview = await storageStrategy.previewReclaim();
    expect(preview.ok).toBe(false);
    expect(preview.reason).toBe('no-sync-root');
  });
});

// ─── UT-907 ──────────────────────────────────────────────────────────────────

describe('UT-907: child-item classification is fail-closed', () => {
  beforeEach(() => {
    resolveSyncRoot.mockResolvedValue({ collection: { key: 'ROOT1' }, libraryID: 1 });
  });

  async function previewOne(att) {
    baseline.enumerateSyncRootAttachments.mockResolvedValue({ attachments: [{ attachment: att, item: att }] });
    return storageStrategy.previewReclaim();
  }

  function expectKept(p, reason) {
    expect(p.convertible).toEqual([]);
    expect(p.keptStored).toHaveLength(1);
    expect(p.keptStored[0].reason).toBe(reason);
  }

  it('confidently zero annotations AND notes → convertible', async () => {
    const p = await previewOne(mockAttachment({ key: 'CLEAN', annotations: [], notes: [] }));
    expect(p.convertible.map(c => c.key)).toEqual(['CLEAN']);
    expect(p.keptStored).toEqual([]);
  });

  it('annotations present → kept stored (has-annotations)', async () => {
    const p = await previewOne(mockAttachment({ key: 'A', annotations: [{ id: 1 }] }));
    expectKept(p, 'has-annotations');
  });

  it('child notes present → kept stored (has-notes)', async () => {
    const p = await previewOne(mockAttachment({ key: 'N', notes: [{ id: 9 }] }));
    expectKept(p, 'has-notes');
  });

  it('getAnnotations() throws → kept stored (annotation-status-unknown), NOT convertible', async () => {
    const att = mockAttachment({ key: 'THROW_A' });
    att.getAnnotations = () => { throw new Error('boom'); };
    expectKept(await previewOne(att), 'annotation-status-unknown');
  });

  it('getNotes() throws → kept stored (note-status-unknown), NOT convertible', async () => {
    const att = mockAttachment({ key: 'THROW_N' }); // annotations default [] (safe), notes throw
    att.getNotes = () => { throw new Error('boom'); };
    expectKept(await previewOne(att), 'note-status-unknown');
  });

  it('annotation API missing → kept stored (annotation-status-unknown)', async () => {
    const att = mockAttachment({ key: 'NOAPI' });
    att.getAnnotations = undefined;
    expectKept(await previewOne(att), 'annotation-status-unknown');
  });

  it('notes API missing → kept stored (note-status-unknown)', async () => {
    const att = mockAttachment({ key: 'NONOTESAPI' });
    att.getNotes = undefined;
    expectKept(await previewOne(att), 'note-status-unknown');
  });

  it('unexpected (non-array) annotation result → kept stored (annotation-status-unknown)', async () => {
    const att = mockAttachment({ key: 'WEIRD' });
    att.getAnnotations = () => 'not-an-array';
    expectKept(await previewOne(att), 'annotation-status-unknown');
  });

  it('safe children but file unavailable → kept stored (file-unavailable)', async () => {
    const att = mockAttachment({ key: 'NOFILE', annotations: [], notes: [] });
    att.getFilePathAsync = async () => false;
    expectKept(await previewOne(att), 'file-unavailable');
  });
});

// ─── UT-904 ──────────────────────────────────────────────────────────────────

describe('UT-904: runReclaim converts only un-annotated, recoverable, parent preserved', () => {
  let store;
  let parentItem;

  beforeEach(() => {
    store = mockStore();
    getTrackingStore.mockReturnValue(store);
    resolveSyncRoot.mockResolvedValue({ collection: { key: 'ROOT1' }, libraryID: 1 });
    prefMap({ sourcePath: '/watch', pdfStorageStrategy: 'linked_watch_folder' });
    chooseCanonicalCollection.mockResolvedValue({ key: 'COL1' });
    collectionKeyToDiskRelativePath.mockResolvedValue('Methods');
    getFileHash.mockResolvedValue('HASH');
    parentItem = { key: 'PARENT', deleted: false };
    globalThis.Zotero.Items.get = vi.fn(() => parentItem);
    globalThis.Zotero.Attachments.linkFromFile = vi.fn(async () => ({
      key: 'LINK1', setTags: vi.fn(), saveTx: vi.fn(async () => {}),
    }));
  });

  it('converts the clean attachment, trashes the OLD stored one, leaves the parent + annotated one alone', async () => {
    const clean = mockAttachment({ key: 'CLEAN', filename: 'clean.pdf', parentItemID: 5 });
    const annotated = mockAttachment({ key: 'ANNO', filename: 'anno.pdf', annotations: [{ id: 1 }] });
    baseline.enumerateSyncRootAttachments.mockResolvedValue({
      attachments: [
        { attachment: clean, item: clean },
        { attachment: annotated, item: annotated },
      ],
    });

    const result = await storageStrategy.runReclaim({ apply: true });

    expect(result.ok).toBe(true);
    expect(result.converted).toBe(1);
    expect(result.keptStored).toBe(1);
    expect(result.failed).toBe(0);

    // A linked attachment was created under the same parent.
    expect(globalThis.Zotero.Attachments.linkFromFile).toHaveBeenCalledTimes(1);
    expect(globalThis.Zotero.Attachments.linkFromFile.mock.calls[0][0]).toMatchObject({ parentItemID: 5 });

    // Old stored attachment trashed (recoverable), NOT erased.
    expect(clean.deleted).toBe(true);
    expect(clean.saveTx).toHaveBeenCalled();

    // Parent item is never touched.
    expect(parentItem.deleted).toBe(false);

    // Annotated attachment is left completely alone.
    expect(annotated.deleted).toBe(false);
    expect(globalThis.Zotero.Attachments.linkFromFile).not.toHaveBeenCalledWith(
      expect.objectContaining({ file: expect.stringContaining('anno.pdf') }),
    );

    // New linked file tracked.
    expect(store.add).toHaveBeenCalledTimes(1);
  });

  it('apply:false performs no conversion (preview only)', async () => {
    const clean = mockAttachment({ key: 'CLEAN' });
    baseline.enumerateSyncRootAttachments.mockResolvedValue({ attachments: [{ attachment: clean, item: clean }] });
    const result = await storageStrategy.runReclaim({ apply: false });
    expect(result.converted).toBe(0);
    expect(clean.deleted).toBe(false);
    expect(globalThis.Zotero.Attachments.linkFromFile).not.toHaveBeenCalled();
  });
});

// ─── UT-905 ──────────────────────────────────────────────────────────────────

describe('UT-905: runReclaim aborts on hash-verify mismatch', () => {
  let store;

  beforeEach(() => {
    store = mockStore();
    getTrackingStore.mockReturnValue(store);
    resolveSyncRoot.mockResolvedValue({ collection: { key: 'ROOT1' }, libraryID: 1 });
    prefMap({ sourcePath: '/watch', pdfStorageStrategy: 'linked_watch_folder' });
    chooseCanonicalCollection.mockResolvedValue({ key: 'COL1' });
    collectionKeyToDiskRelativePath.mockResolvedValue('Methods');
    globalThis.Zotero.Attachments.linkFromFile = vi.fn(async () => ({ key: 'LINK1', setTags: vi.fn(), saveTx: vi.fn(async () => {}) }));
  });

  it('does not trash the stored attachment when the copy fails verification', async () => {
    // Source hashes 'A', destination hashes 'B' → mismatch.
    getFileHash.mockImplementation(async (p) => (p.includes('/watch/') ? 'B' : 'A'));
    const clean = mockAttachment({ key: 'CLEAN', filename: 'clean.pdf', parentItemID: 5 });
    baseline.enumerateSyncRootAttachments.mockResolvedValue({ attachments: [{ attachment: clean, item: clean }] });

    const result = await storageStrategy.runReclaim({ apply: true });

    expect(result.converted).toBe(0);
    expect(result.failed).toBe(1);
    expect(clean.deleted).toBe(false);                  // stored copy preserved
    expect(globalThis.Zotero.Attachments.linkFromFile).not.toHaveBeenCalled();
    expect(reportWarning).toHaveBeenCalled();
  });
});

// ─── UT-906 ──────────────────────────────────────────────────────────────────

describe('UT-906: runMirror copies stored→watch and keeps stored attachments', () => {
  beforeEach(() => {
    resolveSyncRoot.mockResolvedValue({ collection: { key: 'ROOT1' }, libraryID: 1 });
    prefMap({ sourcePath: '/watch', pdfStorageStrategy: 'stored_plus_mirror' });
    getTrackingStore.mockReturnValue(mockStore());
  });

  it('delegates to baseline.adoptCollectionSubtree (keeps stored) and reports counts', async () => {
    baseline.adoptCollectionSubtree.mockResolvedValue({ ok: true, copies: 3, mkdirs: 1, errors: 0 });
    const result = await storageStrategy.runMirror();
    expect(result.ok).toBe(true);
    expect(result.copies).toBe(3);
    expect(baseline.adoptCollectionSubtree).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: false }),
    );
    // Mirror never links or trashes — it only copies bytes via baseline.
    expect(globalThis.Zotero.Attachments.linkFromFile).not.toHaveBeenCalled();
  });

  it('previewMirror runs a dry run', async () => {
    baseline.adoptCollectionSubtree.mockResolvedValue({ ok: true, copies: 2, mkdirs: 0, reconciles: 0 });
    const result = await storageStrategy.previewMirror();
    expect(result.ok).toBe(true);
    expect(result.copies).toBe(2);
    expect(baseline.adoptCollectionSubtree).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true }),
    );
  });
});

// ─── UT-908: accountingReport (FEAT-DASHBOARD) ───────────────────────────────

describe('UT-908: accountingReport storage dashboard', () => {
  beforeEach(() => {
    resolveSyncRoot.mockResolvedValue({ collection: { key: 'ROOT1' }, libraryID: 1 });
    prefMap({ sourcePath: '/watch' });
    globalThis.Zotero.Libraries = { userLibraryID: 1 };
    globalThis.Zotero.Items.getDeleted = vi.fn(async () => []);
    // Empty watch folder by default.
    globalThis.IOUtils.getChildren = vi.fn(async () => []);
  });

  it('returns the expected shape and counts on mocked attachments', async () => {
    const stored = mockAttachment({ key: 'S1', filename: 's1.pdf', stored: true, path: '/zotero/storage/S1/s1.pdf' });
    const linked = mockAttachment({ key: 'L1', filename: 'l1.pdf', stored: false, path: '/watch/l1.pdf' });
    baseline.enumerateSyncRootAttachments.mockResolvedValue({
      attachments: [{ attachment: stored, item: stored }, { attachment: linked, item: linked }],
    });
    // stored attachment file is 2048 bytes; linked isn't counted in storedBytes.
    globalThis.IOUtils.stat = vi.fn(async (p) => ({ size: 2048, type: 'regular' }));

    const r = await storageStrategy.accountingReport();

    expect(r.ok).toBe(true);
    expect(r).toMatchObject({
      zoteroItemCount: 2,
      storedCount: 1,
      linkedCount: 1,
      storedBytes: 2048,
      trashedAttachmentCount: 0,
      trashedBytes: 0,
    });
    // The returned object is read-only (frozen).
    expect(Object.isFrozen(r)).toBe(true);
    expect(() => { r.storedCount = 99; }).toThrow();
  });

  it('counts trashed stored attachments that still have files', async () => {
    baseline.enumerateSyncRootAttachments.mockResolvedValue({ attachments: [] });
    const trashed = mockAttachment({ key: 'T1', filename: 't1.pdf', stored: true, path: '/zotero/storage/T1/t1.pdf' });
    trashed.deleted = true;
    trashed.isAttachment = () => true;
    globalThis.Zotero.Items.getDeleted = vi.fn(async () => [42]);
    globalThis.Zotero.Items.get = vi.fn(() => trashed);
    globalThis.IOUtils.stat = vi.fn(async () => ({ size: 4096, type: 'regular' }));

    const r = await storageStrategy.accountingReport();
    expect(r.trashedAttachmentCount).toBe(1);
    expect(r.trashedBytes).toBe(4096);
  });

  it('totals watch folder files via a recursive disk walk', async () => {
    baseline.enumerateSyncRootAttachments.mockResolvedValue({ attachments: [] });
    globalThis.IOUtils.getChildren = vi.fn(async (dir) => {
      if (dir === '/watch') return ['/watch/a.pdf', '/watch/sub', '/watch/.zotero-watch-trash'];
      if (dir === '/watch/sub') return ['/watch/sub/b.pdf'];
      return [];
    });
    globalThis.IOUtils.stat = vi.fn(async (p) => {
      if (p === '/watch/sub') return { type: 'directory', size: 0 };
      return { type: 'regular', size: 1000 };
    });

    const r = await storageStrategy.accountingReport();
    // a.pdf + sub/b.pdf = 2 files, 2000 bytes; trash dir skipped.
    expect(r.watchFolderFileCount).toBe(2);
    expect(r.watchFolderBytes).toBe(2000);
  });

  it('returns ok:false with no-sync-root when none configured', async () => {
    resolveSyncRoot.mockResolvedValue(null);
    const r = await storageStrategy.accountingReport();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no-sync-root');
  });
});

// ─── UT-909: emptyZoteroTrash (FEAT-EMPTY-TRASH) ─────────────────────────────

describe('UT-909: emptyZoteroTrash', () => {
  beforeEach(() => {
    globalThis.Zotero.Libraries = { userLibraryID: 7 };
  });

  it('calls Zotero.Items.emptyTrash with the library ID when present', async () => {
    globalThis.Zotero.Items.emptyTrash = vi.fn(async () => {});
    const r = await storageStrategy.emptyZoteroTrash();
    expect(r.ok).toBe(true);
    expect(globalThis.Zotero.Items.emptyTrash).toHaveBeenCalledWith(7);
  });

  it('passes an explicit libraryID through', async () => {
    globalThis.Zotero.Items.emptyTrash = vi.fn(async () => {});
    await storageStrategy.emptyZoteroTrash(99);
    expect(globalThis.Zotero.Items.emptyTrash).toHaveBeenCalledWith(99);
  });

  it('no-ops with a clear reason when the API is absent', async () => {
    globalThis.Zotero.Items.emptyTrash = undefined;
    const r = await storageStrategy.emptyZoteroTrash();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('empty-trash-api-unavailable');
  });

  it('reports empty-trash-failed when the API throws', async () => {
    globalThis.Zotero.Items.emptyTrash = vi.fn(async () => { throw new Error('boom'); });
    const r = await storageStrategy.emptyZoteroTrash();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('empty-trash-failed');
  });
});
