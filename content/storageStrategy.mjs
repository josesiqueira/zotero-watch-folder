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
import { resolveSyncRoot, chooseCanonicalCollection, collectionKeyToRelativePath } from './canonicalPath.mjs';
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
 * True when the attachment has ANY child item (PDF-reader annotation or a
 * child note). Such attachments are KEPT stored by Reclaim — converting them
 * would risk orphaning highlights, which live as children of the attachment.
 */
function _hasChildItems(att) {
  try {
    const anns = (typeof att.getAnnotations === 'function') ? (att.getAnnotations() || []) : [];
    if (anns.length > 0) return true;
    const notes = (typeof att.getNotes === 'function') ? (att.getNotes() || []) : [];
    if (notes.length > 0) return true;
  } catch (_e) { /* treat as no children only if both calls are safe */ }
  return false;
}

// ─── Reclaim Zotero Storage (stored → linked_watch_folder) ──────────────────

/**
 * Enumerate stored attachments under the sync root and classify each as
 * convertible (no annotations) or kept-stored (has annotations / file
 * unavailable). Pure read — never mutates Zotero or disk.
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
    if (_hasChildItems(attachment)) {
      keptStored.push({ key: attachment.key, filename, reason: 'has-annotations' });
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

  // 1. Resolve canonical watch-folder destination.
  const canonical = await chooseCanonicalCollection(item, syncRoot.collection);
  const relDir = canonical ? await collectionKeyToRelativePath(canonical.key) : '';
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
  const result = await baseline.adoptCollectionSubtree({
    rootCollection: syncRoot.collection, syncRoot, watchRoot, store, dryRun: true,
  });
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
  const result = await baseline.adoptCollectionSubtree({
    rootCollection: syncRoot.collection, syncRoot, watchRoot, store, dryRun: false,
  });
  return { ok: result.ok, copies: result.copies, mkdirs: result.mkdirs, errors: result.errors };
}
