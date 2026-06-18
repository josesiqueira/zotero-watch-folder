/**
 * PDF storage strategy — a product layer orthogonal to the three sync modes.
 *
 * Where should the PDF bytes live?
 *   - `stored`               — Zotero manages the PDF inside its storage
 *                              (synced via Zotero Storage / WebDAV).
 *   - `linked_watch_folder`  — Zotero LINKS to the PDF in the watch folder;
 *                              your folder-sync tool backs it up. Saves
 *                              Zotero Storage space.
 *   - `stored_plus_mirror`   — stored in Zotero AND a copy kept in the watch
 *                              folder (redundant; for backup/export).
 *
 * This is independent of the sync MODE (mode1/2/3), which governs how the
 * folder tree and the Zotero collection tree mirror each other.
 *
 * Zotero facts this module respects:
 *   - Data sync (metadata, collections, tags, notes, PDF-reader annotations)
 *     is separate from FILE sync (the PDF bytes).
 *   - Annotations are stored as CHILD items of the attachment, not embedded
 *     in the PDF — so converting an attachment's storage mode risks them.
 *     The Reclaim conversion is therefore conservative: it only converts
 *     attachments with NO child items (annotations/notes), and never
 *     hard-deletes — the old stored attachment goes to Zotero's trash.
 *   - The plugin never syncs the Zotero data directory itself.
 *
 * @module storageStrategy
 */

import { getPref, getFileHash } from './utils.mjs';
import { resolveSyncRoot, chooseCanonicalCollection, collectionKeyToDiskRelativePath, UNFILED } from './canonicalPath.mjs';
import { getTrackingStore, createFileRecord, STATE } from './trackingStore.mjs';
import { report as reportWarning, WARNING_CATEGORY } from './warningSink.mjs';
import * as baseline from './baseline.mjs';

/** The three storage strategies. */
export const STRATEGY = Object.freeze({
  STORED: 'stored',
  LINKED_WATCH_FOLDER: 'linked_watch_folder',
  STORED_PLUS_MIRROR: 'stored_plus_mirror',
});

/**
 * Resolve the effective storage strategy. `pdfStorageStrategy` is
 * authoritative; if it's unset/`stored` but the user previously set the
 * legacy `importMode` pref to `linked`, honor that as `linked_watch_folder`
 * (soft migration — the only way importMode is `linked` is an explicit
 * choice, since its default is `stored`).
 */
export function getStorageStrategy() {
  const s = getPref('pdfStorageStrategy');
  if (s === STRATEGY.LINKED_WATCH_FOLDER || s === STRATEGY.STORED_PLUS_MIRROR) return s;
  if ((!s || s === STRATEGY.STORED) && getPref('importMode') === 'linked') {
    return STRATEGY.LINKED_WATCH_FOLDER;
  }
  return STRATEGY.STORED;
}

/**
 * Which conversion button a strategy exposes in the prefs pane.
 * @returns {'reclaim'|'mirror'|null}
 */
export function buttonForStrategy(strategy) {
  if (strategy === STRATEGY.LINKED_WATCH_FOLDER) return 'reclaim';
  if (strategy === STRATEGY.STORED_PLUS_MIRROR) return 'mirror';
  return null;
}

// ─── Explanatory text (single source of truth — used by UI + asserted in tests) ─

export const STORAGE_EXPLAINER =
  'Zotero data sync protects your library metadata, notes, collections, and Zotero highlights/annotations. '
  + 'PDF files are separate. If you choose linked watch-folder files, Zotero will remember the papers and '
  + 'annotations, while your folder-sync provider protects the PDF files.';

export const RESTORE_EXPLAINER_LINKED =
  'If this computer is lost, install Zotero and sign in to restore metadata, notes, and annotations. '
  + 'Then install your folder-sync app, let it download the watch folder, and set Zotero’s linked '
  + 'attachment base directory so Zotero can find the PDFs again.';

/** Per-strategy label / description / info / warning text. */
export const STRATEGY_INFO = Object.freeze({
  [STRATEGY.STORED]: Object.freeze({
    label: 'Store PDFs in Zotero',
    desc: 'Best Zotero experience. Zotero manages PDFs and can sync them using Zotero Storage or WebDAV. '
      + 'Uses Zotero file storage if file sync is enabled.',
    info: 'Zotero will sync your metadata, notes, and highlights. PDFs require Zotero Storage or WebDAV.',
    warning: null,
  }),
  [STRATEGY.LINKED_WATCH_FOLDER]: Object.freeze({
    label: 'Link PDFs from watch folder',
    desc: 'Saves Zotero Storage space. PDFs live in your watch folder, so use pCloud Sync, Dropbox, OneDrive, '
      + 'Syncthing, or another folder-sync tool to back them up.',
    info: 'Zotero syncs metadata, notes, and Zotero annotations. Your folder-sync provider backs up the PDFs. '
      + 'To restore on a new computer, install Zotero and your folder-sync app, then set the linked attachment '
      + 'base directory.',
    warning: 'Linked PDFs may not be available inside Zotero mobile apps.',
  }),
  [STRATEGY.STORED_PLUS_MIRROR]: Object.freeze({
    label: 'Store in Zotero and mirror to watch folder',
    desc: 'Keeps Zotero’s normal stored attachment plus a copy in the watch folder. This is redundant and '
      + 'useful for backup/export workflows, but it does not save Zotero Storage space.',
    info: 'Zotero syncs metadata, notes, highlights, and stored PDFs if Zotero file sync is enabled. '
      + 'The watch folder also keeps a copy.',
    warning: null,
  }),
});

/** Shown before the destructive Reclaim step. */
export const RECLAIM_CONFIRM_NOTE =
  'This moves PDF file storage out of Zotero. Zotero will still sync metadata, notes, and annotations.';

// ─── Attachment classification helpers ──────────────────────────────────────

function _isStoredFileAttachment(att) {
  try {
    if (typeof att.isStoredFileAttachment === 'function') return att.isStoredFileAttachment();
    const LM = Zotero.Attachments?.LINK_MODE_IMPORTED_FILE;
    return LM != null && att.attachmentLinkMode === LM;
  } catch (_e) {
    return false;
  }
}

/**
 * Fail-closed classifier for an attachment's child items. Reclaim may only
 * convert a stored attachment to a linked one if we can CONFIDENTLY prove it
 * has zero PDF-reader annotations and zero child notes — those live as child
 * items in the Zotero DB, not in the PDF bytes, so a conversion that replaces
 * the attachment would orphan them. Anything we can't confidently evaluate
 * (missing API, thrown error, unexpected shape) must be treated as unsafe and
 * kept stored — never presumed empty.
 *
 * @returns {{safe: boolean, reason: string|null}}
 *   { safe: true,  reason: null }
 *   { safe: false, reason: 'has-annotations' }
 *   { safe: false, reason: 'has-notes' }
 *   { safe: false, reason: 'annotation-status-unknown' }
 *   { safe: false, reason: 'note-status-unknown' }
 *   { safe: false, reason: 'child-status-unknown' }
 */
function _classifyAttachmentChildren(att) {
  try {
    // ── PDF-reader annotations / highlights (child items) ──
    if (typeof att.getAnnotations !== 'function') {
      return { safe: false, reason: 'annotation-status-unknown' };
    }
    let anns;
    try { anns = att.getAnnotations(); }
    catch (_e) { return { safe: false, reason: 'annotation-status-unknown' }; }
    if (!Array.isArray(anns)) {
      return { safe: false, reason: 'annotation-status-unknown' };
    }
    if (anns.length > 0) return { safe: false, reason: 'has-annotations' };

    // ── Child notes (or any other child item) ──
    if (typeof att.getNotes !== 'function') {
      return { safe: false, reason: 'note-status-unknown' };
    }
    let notes;
    try { notes = att.getNotes(); }
    catch (_e) { return { safe: false, reason: 'note-status-unknown' }; }
    if (!Array.isArray(notes)) {
      return { safe: false, reason: 'note-status-unknown' };
    }
    if (notes.length > 0) return { safe: false, reason: 'has-notes' };

    // Confidently zero annotations AND zero notes.
    return { safe: true, reason: null };
  } catch (_e) {
    // Anything unexpected (e.g. a null/odd attachment object) → unsafe.
    return { safe: false, reason: 'child-status-unknown' };
  }
}

// ─── Reclaim Zotero Storage (stored → linked_watch_folder) ──────────────────

/**
 * Enumerate stored attachments under the sync root and classify each as
 * convertible (confidently zero annotations/notes + file available) or
 * kept-stored. Pure read — never mutates Zotero or disk. Classification is
 * fail-closed: anything uncertain stays stored.
 *
 * keptStored reasons: 'has-annotations' | 'has-notes' |
 * 'annotation-status-unknown' | 'note-status-unknown' | 'child-status-unknown'
 * | 'file-unavailable'.
 *
 * @returns {Promise<{ok:boolean, reason?:string, convertible:Array, keptStored:Array, totalBytes:number}>}
 */
export async function previewReclaim() {
  const syncRoot = await resolveSyncRoot().catch(() => null);
  if (!syncRoot) return { ok: false, reason: 'no-sync-root', convertible: [], keptStored: [], totalBytes: 0 };

  const { attachments } = await baseline.enumerateSyncRootAttachments(syncRoot);
  const convertible = [];
  const keptStored = [];
  let totalBytes = 0;

  for (const { attachment, item } of attachments) {
    if (!_isStoredFileAttachment(attachment)) continue; // already linked / not a stored file
    const filename = attachment.attachmentFilename || attachment.key;
    // Child-item gate (fail-closed): only convert when we can confidently
    // prove zero annotations AND zero notes. Annotated/uncertain → keep stored.
    const childStatus = _classifyAttachmentChildren(attachment);
    if (!childStatus.safe) {
      keptStored.push({ key: attachment.key, filename, reason: childStatus.reason });
      continue;
    }
    let path = null;
    try { path = await attachment.getFilePathAsync(); } catch (_e) { path = null; }
    if (!path) {
      keptStored.push({ key: attachment.key, filename, reason: 'file-unavailable' });
      continue;
    }
    let size = 0;
    try { const st = await IOUtils.stat(path); size = st?.size ?? 0; } catch (_e) { size = 0; }
    totalBytes += size;
    convertible.push({ key: attachment.key, filename, path, size, attachment, item });
  }
  return { ok: true, convertible, keptStored, totalBytes };
}

/**
 * Convert convertible stored attachments to linked watch-folder files.
 * Conservative + recoverable: copy → hash-verify → create linked attachment
 * (preserving parent / tags / collections) → trash the old STORED attachment
 * (Zotero trash, never erased). Attachments with annotations are skipped.
 *
 * @param {{apply?: boolean}} [opts] - apply=false performs the preview only.
 * @returns {Promise<{ok:boolean, reason?:string, converted:number, keptStored:number, failed:number}>}
 */
export async function runReclaim({ apply = true } = {}) {
  const preview = await previewReclaim();
  if (!preview.ok) return { ok: false, reason: preview.reason, converted: 0, keptStored: 0, failed: 0 };
  if (!apply) {
    return { ok: true, converted: 0, keptStored: preview.keptStored.length, failed: 0, preview };
  }

  const syncRoot = await resolveSyncRoot().catch(() => null);
  const watchRoot = getPref('sourcePath');
  const store = getTrackingStore();
  if (!syncRoot || !watchRoot) {
    return { ok: false, reason: 'not-configured', converted: 0, keptStored: preview.keptStored.length, failed: 0 };
  }

  let converted = 0;
  let failed = 0;
  for (const entry of preview.convertible) {
    try {
      const ok = await _convertOneToLinked(entry, { syncRoot, watchRoot, store });
      if (ok) converted++; else failed++;
    } catch (e) {
      failed++;
      Zotero.logError(`[WatchFolder] reclaim convert ${entry.key}: ${e?.message ?? e}`);
    }
  }
  if (store) { try { await store.save(); } catch (_e) { /* logged inside save */ } }
  return { ok: true, converted, keptStored: preview.keptStored.length, failed };
}

async function _convertOneToLinked(entry, { syncRoot, watchRoot, store }) {
  const { attachment, item, path: srcPath } = entry;

  // 1. Resolve canonical watch-folder destination. Library scope: an Unfiled
  // item (UNFILED sentinel) reclaims to the watch-folder root (relDir '').
  const canonical = await chooseCanonicalCollection(item, syncRoot.collection);
  const isUnfiled = canonical === UNFILED;
  const relDir = isUnfiled ? '' : (canonical ? await collectionKeyToDiskRelativePath(canonical.key) : '');
  if (relDir == null) return false;
  const filename = attachment.attachmentFilename || PathUtils.filename(srcPath);
  const relPath = relDir === '' ? filename : `${relDir}/${filename}`;
  const absDest = PathUtils.join(watchRoot, ...relPath.split('/').filter(Boolean));

  // 2. Copy bytes to the watch folder (unless already there) + hash-verify.
  const destExists = await IOUtils.exists(absDest).catch(() => false);
  if (!destExists) {
    const parent = PathUtils.parent(absDest);
    if (parent && parent !== absDest) {
      await IOUtils.makeDirectory(parent, { ignoreExisting: true, createAncestors: true });
    }
    await IOUtils.copy(srcPath, absDest);
  }
  const srcHash = await getFileHash(srcPath);
  const destHash = await getFileHash(absDest);
  if (!srcHash || !destHash || srcHash !== destHash) {
    reportWarning({
      category: WARNING_CATEGORY.IO_ERROR,
      actionType: 'reclaim',
      attachmentKey: attachment.key,
      path: relPath,
      reason: 'hash-verify-failed',
      message: `Reclaim aborted for "${filename}": copy could not be hash-verified — left stored, untouched.`,
    });
    return false;
  }

  // 3. Create a linked attachment that preserves parent / collections / tags.
  const parentItemID = (typeof attachment.parentItemID === 'number') ? attachment.parentItemID : null;
  const linkArgs = { file: absDest };
  if (parentItemID) {
    linkArgs.parentItemID = parentItemID;
  } else if (typeof attachment.getCollections === 'function') {
    linkArgs.collections = attachment.getCollections() || [];
  }
  const linked = await Zotero.Attachments.linkFromFile(linkArgs);
  if (!linked) return false;
  try {
    if (typeof attachment.getTags === 'function' && typeof linked.setTags === 'function') {
      const tags = attachment.getTags() || [];
      if (tags.length > 0) { linked.setTags(tags); await linked.saveTx(); }
    }
  } catch (e) { Zotero.debug(`[WatchFolder] reclaim tag copy: ${e?.message ?? e}`); }

  // 4. Track the new linked file.
  if (store) {
    let stat = null;
    try { stat = await IOUtils.stat(absDest); } catch (_e) { /* best effort */ }
    store.add(createFileRecord({
      localPath: relPath,
      canonicalLocalPath: relPath,
      lastSyncedHash: destHash,
      lastSyncedSize: stat?.size ?? entry.size ?? 0,
      lastSyncedMtime: stat?.lastModified ?? 0,
      zoteroItemKey: parentItemID ? (Zotero.Items.get(parentItemID)?.key ?? null) : linked.key,
      zoteroAttachmentKey: linked.key,
      canonicalCollectionKey: canonical?.key ?? null,
      collectionMembershipKeys: canonical ? [canonical.key] : [],
      state: STATE.CLEAN,
    }));
  }

  // 5. Trash the OLD stored attachment (recoverable — never erase). The
  //    parent item and its metadata/notes are untouched.
  try {
    if (!attachment.deleted) {
      attachment.deleted = true;
      await attachment.saveTx();
    }
  } catch (e) {
    Zotero.logError(`[WatchFolder] reclaim trash old stored ${attachment.key}: ${e?.message ?? e}`);
  }

  // Drop any stale tracking record for the old stored attachment key.
  if (store && typeof store.removeByAttachmentKey === 'function' && attachment.key !== linked.key) {
    store.removeByAttachmentKey(attachment.key);
  }
  return true;
}

// ─── Accounting / storage dashboard (FEAT-DASHBOARD) ────────────────────────

/**
 * Sum the on-disk byte size of an attachment's file, if available. Pure read.
 * Returns 0 when the file is missing/unreadable so the dashboard degrades
 * gracefully rather than throwing.
 */
async function _attachmentFileBytes(att) {
  let path = null;
  try { path = await att.getFilePathAsync(); } catch (_e) { path = null; }
  if (!path) return 0;
  try { const st = await IOUtils.stat(path); return st?.size ?? 0; } catch (_e) { return 0; }
}

/**
 * Enumerate the watch folder once and total its file count + bytes. Pure read.
 * Skips unreadable files. Returns { count, bytes }.
 */
async function _watchFolderUsage(watchRoot) {
  if (!watchRoot) return { count: 0, bytes: 0 };
  // Minimal recursive disk walk used only by the dashboard. Skips the plugin
  // trash dir and hidden dot-dirs. Best-effort — never throws.
  let count = 0;
  let bytes = 0;
  // Depth-capped stack of [dir, depth]. IOUtils.stat dereferences symlinks,
  // so a symlinked directory would otherwise let a symlink LOOP (or a link to
  // /) recurse forever and wedge the prefs window. The depth cap bounds the
  // walk so a loop terminates instead of hanging. Skip the plugin trash, the
  // 'imported' dir (excluded from scanning per fileScanner.SKIP_DIRNAMES), and
  // hidden dot-dirs.
  const MAX_DEPTH = 20;
  const stack = [[watchRoot, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    let entries = [];
    try { entries = await IOUtils.getChildren(dir); } catch (_e) { entries = []; }
    for (const child of entries) {
      const name = PathUtils.filename(child);
      if (name === '.zotero-watch-trash' || name === 'imported'
          || (typeof name === 'string' && name.startsWith('.'))) continue;
      let st = null;
      try { st = await IOUtils.stat(child); } catch (_e) { st = null; }
      if (!st) continue;
      if (st.type === 'directory') {
        if (depth < MAX_DEPTH) stack.push([child, depth + 1]);
        continue;
      }
      count++;
      bytes += st.size ?? 0;
    }
  }
  return { count, bytes };
}

/**
 * Read-only storage accounting for the prefs dashboard. Enumerates the sync
 * root (the SAME walk previewReclaim uses) plus Zotero's trashed attachments
 * and the watch folder on disk. Computed ONLY on explicit call — never on
 * prefs open. Never mutates Zotero or disk.
 *
 * @returns {Promise<{
 *   ok:boolean, reason?:string,
 *   zoteroItemCount:number, storedCount:number, linkedCount:number, storedBytes:number,
 *   watchFolderFileCount:number, watchFolderBytes:number,
 *   trashedAttachmentCount:number, trashedBytes:number
 * }>}
 */
export async function accountingReport() {
  const empty = {
    zoteroItemCount: 0, storedCount: 0, linkedCount: 0, storedBytes: 0,
    watchFolderFileCount: 0, watchFolderBytes: 0,
    trashedAttachmentCount: 0, trashedBytes: 0,
  };

  const syncRoot = await resolveSyncRoot().catch(() => null);
  if (!syncRoot) return Object.freeze({ ok: false, reason: 'no-sync-root', ...empty });

  const { attachments } = await baseline.enumerateSyncRootAttachments(syncRoot);
  let zoteroItemCount = 0;
  let storedCount = 0;
  let linkedCount = 0;
  let storedBytes = 0;

  for (const { attachment } of attachments) {
    zoteroItemCount++;
    if (_isStoredFileAttachment(attachment)) {
      storedCount++;
      storedBytes += await _attachmentFileBytes(attachment);
    } else {
      linkedCount++;
    }
  }

  // Trashed (item.deleted === true) attachments under the library that still
  // have files. The sync-root walk excludes trashed items, so enumerate the
  // library trash directly.
  let trashedAttachmentCount = 0;
  let trashedBytes = 0;
  const libraryID = syncRoot.libraryID ?? (Zotero?.Libraries?.userLibraryID);
  try {
    let deletedIDs = [];
    if (Zotero?.Items && typeof Zotero.Items.getDeleted === 'function') {
      deletedIDs = (await Zotero.Items.getDeleted(libraryID, true)) || [];
    }
    for (const id of deletedIDs) {
      let item = null;
      try { item = Zotero.Items.get(id); } catch (_e) { item = null; }
      if (!item) continue;
      if (!(typeof item.isAttachment === 'function' && item.isAttachment())) continue;
      if (item.deleted !== true) continue;
      if (!_isStoredFileAttachment(item)) continue; // only stored files occupy reclaimable bytes
      const bytes = await _attachmentFileBytes(item);
      if (bytes <= 0) continue; // "that still have files"
      trashedAttachmentCount++;
      trashedBytes += bytes;
    }
  } catch (e) {
    Zotero.debug(`[WatchFolder] accountingReport trash enumeration: ${e?.message ?? e}`);
  }

  const watchRoot = getPref('sourcePath');
  const usage = await _watchFolderUsage(watchRoot);

  return Object.freeze({
    ok: true,
    zoteroItemCount, storedCount, linkedCount, storedBytes,
    watchFolderFileCount: usage.count, watchFolderBytes: usage.bytes,
    trashedAttachmentCount, trashedBytes,
  });
}

// ─── Empty Zotero trash (FEAT-EMPTY-TRASH) ──────────────────────────────────

/**
 * Permanently empty Zotero's trash for a library to reclaim space. This is a
 * library-wide, irreversible operation handled entirely by Zotero — the plugin
 * NEVER deletes inside the Zotero storage directory itself.
 *
 * Coded defensively behind a typeof guard because the exact API name must be
 * verified on a live Zotero build (Zotero.Items.emptyTrash is the expected
 * name on Zotero 7/8/9, but this is not assumed — absence yields a clear,
 * non-destructive error rather than a thrown ReferenceError).
 *
 * @param {number} [libraryID] - defaults to the user library.
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function emptyZoteroTrash(libraryID) {
  const lib = (typeof libraryID === 'number')
    ? libraryID
    : (Zotero?.Libraries?.userLibraryID);
  if (!Zotero?.Items || typeof Zotero.Items.emptyTrash !== 'function') {
    return { ok: false, reason: 'empty-trash-api-unavailable' };
  }
  try {
    await Zotero.Items.emptyTrash(lib);
    return { ok: true };
  } catch (e) {
    Zotero.logError(`[WatchFolder] emptyZoteroTrash: ${e?.message ?? e}`);
    return { ok: false, reason: 'empty-trash-failed', error: String(e?.message ?? e) };
  }
}

// ─── Build / Repair Watch Folder Mirror (stored_plus_mirror) ────────────────

/**
 * Preview the watch-folder mirror: how many stored attachments would get a
 * local copy. Read-only (dry run). Keeps stored attachments stored.
 */
export async function previewMirror() {
  const syncRoot = await resolveSyncRoot().catch(() => null);
  if (!syncRoot) return { ok: false, reason: 'no-sync-root' };
  const watchRoot = getPref('sourcePath');
  const store = getTrackingStore();
  if (!watchRoot) return { ok: false, reason: 'not-configured' };
  // Library scope has no single root collection — the whole-library walk
  // (runBaseline, forced + dry) is the equivalent "copy stored → disk" pass.
  const result = syncRoot.isLibraryRoot
    ? await baseline.runBaseline({ trackingStore: store, watchRoot, syncRoot, force: true, dryRun: true })
    : await baseline.adoptCollectionSubtree({ rootCollection: syncRoot.collection, syncRoot, watchRoot, store, dryRun: true });
  return { ok: result.ok, copies: result.copies, mkdirs: result.mkdirs, reconciles: result.reconciles ?? 0 };
}

/**
 * Build/repair the watch-folder mirror by copying stored attachment files to
 * their canonical watch-folder paths. KEEPS the stored attachments — this is
 * a redundant backup copy, not a conversion. Reuses baseline's copy logic.
 */
export async function runMirror() {
  const syncRoot = await resolveSyncRoot().catch(() => null);
  if (!syncRoot) return { ok: false, reason: 'no-sync-root' };
  const watchRoot = getPref('sourcePath');
  const store = getTrackingStore();
  if (!watchRoot) return { ok: false, reason: 'not-configured' };
  const result = syncRoot.isLibraryRoot
    ? await baseline.runBaseline({ trackingStore: store, watchRoot, syncRoot, force: true, dryRun: false })
    : await baseline.adoptCollectionSubtree({ rootCollection: syncRoot.collection, syncRoot, watchRoot, store, dryRun: false });
  return { ok: result.ok, copies: result.copies, mkdirs: result.mkdirs, errors: result.errors };
}
