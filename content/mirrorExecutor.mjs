/**
 * Mirror Executor — v2.1 Phase A4 + A5.
 *
 * Single bottleneck for every FS + Zotero mutation in Mode 2 / Mode 3.
 * The v1 Phase-2 code spread IO calls across collectionSync.mjs,
 * collectionWatcher.mjs, folderWatcher.mjs, etc., each protected by a
 * global `_isSyncing` flag that could deadlock if any exception escaped
 * before the matching release. v2.1 funnels through this module so:
 *
 *   1. Cross-FS detection happens in one place (`_moveWithFallback`)
 *   2. Conflict-gate (A5) is consistently applied (`canSafelyMove`)
 *   3. Per-operation locks replace v1's coarse global flag (`_withLock`)
 *
 * Action types and what each does:
 *
 *   createFolder            — mkdir under watch root; insert CollectionRecord
 *   moveFolder              — rename/move local dir; rewrite child file paths
 *   zoteroCollectionDeleted — Zotero collection gone → Mode 3 trashes the LOCAL
 *                             folder (per-child local-hash gate); Mode 2 warns.
 *                             `deleteFolder` is a back-compat alias for this.
 *   localFolderDeleted      — local folder gone → Mode 3 propagates to Zotero:
 *                             bulk-safe-delete the contained attachments (each
 *                             cleared by the Zotero-side freshness gate) then
 *                             trashes the Zotero collection; Mode 2 warns.
 *   moveItem                — gated by conflict-gate; move single file
 *   addItemMembership       — tracking-only (collectionMembershipKeys union)
 *   removeItemMembership    — tracking-only (collectionMembershipKeys minus)
 *
 * The executor does NOT read the `mode` preference itself. The coordinator
 * decides which actions to emit per-mode; the executor is a pure handler.
 *
 * @module mirrorExecutor
 */

import { getPref, getFileHash } from './utils.mjs';
import { createFileRecord, createCollectionRecord, STATE } from './trackingStore.mjs';
import { report as reportWarning, WARNING_CATEGORY } from './warningSink.mjs';
import { collectionKeyToRelativePath, resolveSyncRoot, getScopeMode } from './canonicalPath.mjs';
import { isBulkDelete, confirmBulkDelete, confirmFirstLibraryDelete } from './bulkGuard.mjs';

/** @type {import('./trackingStore.mjs').TrackingStore | null} */
let _store = null;

/**
 * Per-key promise chain. Each lock key serializes operations so two
 * concurrent moveFolders on the same collection don't race. Keyed by either
 * `collection:<key>` or `attachment:<key>` or `path:<absPath>`.
 * @type {Map<string, Promise>}
 */
const _locks = new Map();

/**
 * Concurrency cap for the per-child rewrite passes in `_moveFolder`
 * (WP-C #1). Each child still acquires its own `attachment:<key>` lock,
 * which guarantees per-attachment serialization; this cap merely limits
 * the OUTER parallelism so a folder with thousands of tracked children
 * doesn't queue thousands of microtasks at once. 8 strikes a reasonable
 * balance: enough to overlap async tracking-store mutations without
 * flooding the event loop. Different children acquire DIFFERENT locks
 * so they can run truly in parallel; same-key children would serialize
 * naturally on their shared lock chain.
 */
const CHILD_REWRITE_CONCURRENCY = 8;

/**
 * Wire the executor's dependency on the tracking store. Called by the
 * SyncCoordinator (Phase A6) after the store is initialized.
 * @param {{trackingStore: import('./trackingStore.mjs').TrackingStore}} ctx
 */
export function init(ctx) {
  _store = ctx?.trackingStore ?? null;
}

/** Test seam — drop injected state. */
export function reset() {
  _store = null;
  _locks.clear();
}

/** Test seam — expose current store (read-only). */
export function _getStore() {
  return _store;
}

/**
 * Acquire a serial lock on `key` and run `fn` once any prior operation on
 * the same key has settled (resolved or rejected). Returns whatever `fn`
 * returns. Errors from `fn` propagate to the caller of `_withLock`; they
 * don't poison the lock chain for the next caller.
 */
function _withLock(key, fn) {
  const prev = _locks.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  _locks.set(key, next);
  // Clean up the map entry when this op is no longer the tail.
  next.finally(() => {
    if (_locks.get(key) === next) _locks.delete(key);
  }).catch(() => { /* swallow — caller already handled */ });
  return next;
}

/**
 * Inline semaphore — run `worker(item)` against every item in `items`
 * with at most `cap` invocations in flight at once. Resolves after every
 * worker has settled (resolved or rejected). Errors are NOT propagated:
 * each worker is responsible for its own error handling (the existing
 * `_withLock`-wrapped rewrite blocks already swallow per-record errors
 * by re-reading the live record under the lock and bailing if anything
 * is amiss).
 *
 * Used by `_moveFolder` (WP-C #1) to overlap per-child rewrites without
 * violating the per-attachment lock contract: each worker still acquires
 * its own `attachment:<key>` lock and re-reads under it.
 */
async function _runWithConcurrency(items, cap, worker) {
  if (!Array.isArray(items) || items.length === 0) return;
  const effectiveCap = Math.max(1, Math.min(cap, items.length));
  let cursor = 0;
  const runners = [];
  for (let i = 0; i < effectiveCap; i++) {
    runners.push((async () => {
      // Each runner pulls the next index until the queue is drained.
      // Reading `cursor` synchronously between awaits is safe in single-
      // threaded JS — the increment happens before any await inside the
      // worker, so two runners can't claim the same index.
      while (true) {
        const idx = cursor++;
        if (idx >= items.length) return;
        try {
          await worker(items[idx]);
        } catch (e) {
          // Per-record errors are swallowed at this layer — the worker
          // is responsible for surfacing via warningSink or store state.
          Zotero.logError(`[WatchFolder] mirrorExecutor _runWithConcurrency: ${e?.message ?? e}`);
        }
      }
    })());
  }
  await Promise.all(runners);
}

/**
 * Execute a MirrorAction. Dispatches by `action.type`; per-action
 * implementations apply their own locks and tracking-store updates.
 *
 * @param {{type: string, payload: any}} action
 * @returns {Promise<{ok: boolean, reason?: string, error?: string}>}
 */
export async function execute(action) {
  if (!action || typeof action !== 'object' || typeof action.type !== 'string') {
    return { ok: false, reason: 'invalid-action' };
  }
  const payload = action.payload ?? {};
  switch (action.type) {
    case 'createFolder':         return _createFolder(payload);
    case 'moveFolder':           return _moveFolder(payload);
    case 'renameFolder':         return _moveFolder(payload); // alias
    // Direction-specific folder deletion (spec risk #5). The Zotero side
    // and the disk side mean very different things, so they get distinct
    // handlers + conflict gates. `deleteFolder` is kept as a back-compat
    // alias for the Zotero-collection-deleted direction (its historical
    // behavior: trash the LOCAL folder).
    case 'zoteroCollectionDeleted': return _zoteroCollectionDeleted(payload);
    case 'deleteFolder':            return _zoteroCollectionDeleted(payload); // alias
    case 'localFolderDeleted':      return _localFolderDeleted(payload);
    case 'moveItem':             return _moveItem(payload);
    case 'addItemMembership':    return _addItemMembership(payload);
    case 'removeItemMembership': return _removeItemMembership(payload);
    default:                     return { ok: false, reason: 'unknown-action' };
  }
}

// ─── Conflict gate (A5) ───────────────────────────────────────────────────

/**
 * Conflict gate. Returns `{ok: true}` only when the file's current bytes
 * still match the `lastSyncedHash` recorded at last sync. If the user has
 * edited the file locally since then, the operation must be refused — the
 * canonical example is "user touched the file, then Zotero moved the item
 * between collections, and Mode 2 wants to move the local file." We don't
 * want to silently relocate user-edited content.
 *
 * Returns:
 *   { ok: true }                                — safe
 *   { ok: false, reason: 'missing-file' }       — file vanished
 *   { ok: false, reason: 'hash-drifted', currentHash, recordedHash }
 *   { ok: false, reason: 'invalid-record' }     — no path or no recorded hash
 *
 * @param {object} record - FileRecord.
 * @param {string} absPath - Absolute path to the file on disk.
 */
export async function canSafelyMove(record, absPath) {
  if (!record || !absPath) return { ok: false, reason: 'invalid-record' };
  if (!record.lastSyncedHash) {
    // No baseline → we have nothing to compare against. Treat as unsafe so
    // we don't move a file whose state we never validated.
    return { ok: false, reason: 'invalid-record' };
  }
  let exists = false;
  try {
    exists = await IOUtils.exists(absPath);
  } catch (e) {
    return { ok: false, reason: 'io-error', error: String(e?.message ?? e) };
  }
  if (!exists) return { ok: false, reason: 'missing-file' };
  // Delete-safety gate: hash the file DIRECTLY, never via the
  // (path, size, mtime) hash cache. A mtime-preserving same-size overwrite
  // (`rsync -t`, `touch`-then-edit, some cloud clients) yields a stale cache
  // HIT — which would let this gate approve MOVING locally-edited bytes, a
  // fail-OPEN that violates the delete-safety contract. The cache is a
  // read-avoidance optimization for the scan path only; this gate must be
  // authoritative, so it always recomputes.
  let currentHash = null;
  try {
    currentHash = await getFileHash(absPath);
  } catch (_e) {
    currentHash = null;
  }
  if (!currentHash) return { ok: false, reason: 'hash-failed' };
  if (currentHash !== record.lastSyncedHash) {
    return {
      ok: false,
      reason: 'hash-drifted',
      currentHash,
      recordedHash: record.lastSyncedHash,
    };
  }
  return { ok: true };
}

/**
 * Freshness gate for propagating a LOCAL deletion to Zotero. Before we trash
 * a Zotero attachment because its local file disappeared, verify the
 * Zotero-stored attachment file still matches `record.lastSyncedHash` — i.e.
 * the Zotero side has NOT changed since the last successful sync. If we
 * cannot prove it's unchanged (no baseline hash, or the stored file is
 * unavailable / not yet downloaded by file-sync), we BLOCK the deletion
 * (spec §"Zotero-side freshness protection for local-file deletion").
 *
 * This is the Zotero-side mirror of `canSafelyMove` (which gates the LOCAL
 * side). Both deletion directions must clear the appropriate gate before any
 * destructive action.
 *
 * Returns:
 *   { ok: true }                                — Zotero side unchanged, safe
 *   { ok: false, reason: 'invalid-record' }     — missing args
 *   { ok: false, reason: 'no-baseline' }        — record has no lastSyncedHash
 *   { ok: false, reason: 'file-unavailable' }   — stored file missing / not downloaded
 *   { ok: false, reason: 'hash-drifted', currentHash, recordedHash }
 *
 * @param {object} record - FileRecord.
 * @param {object} attachmentItem - Zotero attachment Item.
 */
export async function canSafelyTrashZoteroAttachment(record, attachmentItem) {
  if (!record || !attachmentItem) return { ok: false, reason: 'invalid-record' };
  if (!record.lastSyncedHash) return { ok: false, reason: 'no-baseline' };
  let storedPath = null;
  try {
    if (typeof attachmentItem.getFilePathAsync === 'function') {
      storedPath = await attachmentItem.getFilePathAsync();
    } else if (typeof attachmentItem.getFilePath === 'function') {
      storedPath = attachmentItem.getFilePath();
    }
  } catch (_e) {
    storedPath = null;
  }
  // getFilePathAsync() resolves to `false` when the file isn't available
  // (linked-missing, or file-sync hasn't downloaded it yet).
  if (!storedPath) return { ok: false, reason: 'file-unavailable' };
  let exists = false;
  try { exists = await IOUtils.exists(storedPath); } catch (_e) { exists = false; }
  if (!exists) return { ok: false, reason: 'file-unavailable' };
  // Delete-safety gate: recompute directly (see canSafelyMove) — never trust
  // the (path, size, mtime) cache when a Zotero attachment is about to be
  // trashed, or a mtime-preserving drift could pass as "unchanged".
  let currentHash = null;
  try { currentHash = await getFileHash(storedPath); } catch (_e) { currentHash = null; }
  if (!currentHash) return { ok: false, reason: 'file-unavailable' };
  if (currentHash !== record.lastSyncedHash) {
    return {
      ok: false,
      reason: 'hash-drifted',
      currentHash,
      recordedHash: record.lastSyncedHash,
    };
  }
  return { ok: true };
}

// ─── Path helpers ─────────────────────────────────────────────────────────

function _watchRoot() {
  const root = getPref('sourcePath');
  if (!root) throw new Error('mirrorExecutor: sourcePath pref not set');
  return root;
}

/**
 * Resolve a "path-like" value (relative-to-watchRoot OR already absolute)
 * into a platform-native absolute path. Idempotent — an already-absolute
 * input is returned unchanged. Empty / null returns the watch-root.
 *
 * v2 spec says CollectionRecord.localPath / FileRecord.localPath +
 * canonicalLocalPath are sync-root-relative. But watchFolder._processNewFile
 * (and related legacy code) still write absolute paths to those fields
 * (schema-drift bug tracked separately). Until that gets migrated, this
 * function tolerates both representations so the executor doesn't
 * double-join — which would produce paths like
 * `/watch//tmp/watch/file.pdf` and surface as bogus missing-file errors
 * (seen live during CONF.1).
 */
function _absPath(relOrAbs) {
  const root = _watchRoot();
  if (!relOrAbs || relOrAbs === '') return root;
  // Already absolute? POSIX uses leading '/', Windows uses 'C:\…' or
  // 'C:/…'. Return as-is rather than joining with the watch root.
  if (relOrAbs.startsWith('/')) return relOrAbs;
  if (/^[A-Za-z]:[\\/]/.test(relOrAbs)) return relOrAbs;
  const segments = relOrAbs.split('/').filter((s) => s.trim() !== '');
  if (segments.length === 0) return root;
  return PathUtils.join(root, ...segments);
}

/**
 * If `path` is `oldRel` or sits under `oldRel + '/'`, rewrite the prefix
 * to `newRel`. Otherwise return `path` unchanged. Used by moveFolder's
 * second-pass canonicalLocalPath fixup.
 */
function _rewriteIfUnder(path, oldRel, oldPrefix, newRel) {
  if (typeof path !== 'string' || !path) return path;
  if (path === oldRel) return newRel;
  if (path.startsWith(oldPrefix)) return newRel + path.slice(oldRel.length);
  return path;
}

// ─── Action handlers ──────────────────────────────────────────────────────

async function _createFolder(payload) {
  const { collectionKey, parentCollectionKey, relativePath } = payload;
  if (!collectionKey || typeof relativePath !== 'string' || relativePath === '') {
    return { ok: false, reason: 'invalid-payload' };
  }
  return _withLock(`collection:${collectionKey}`, async () => {
    let abs;
    try { abs = _absPath(relativePath); }
    catch (e) { return { ok: false, reason: 'no-watch-root', error: String(e?.message ?? e) }; }
    try {
      await IOUtils.makeDirectory(abs, { ignoreExisting: true, createAncestors: true });
    } catch (e) {
      Zotero.logError(`[WatchFolder] mirrorExecutor createFolder ${abs}: ${e?.message ?? e}`);
      reportWarning({
        category: WARNING_CATEGORY.IO_ERROR,
        actionType: 'createFolder',
        collectionKey,
        path: relativePath,
        reason: 'mkdir-failed',
        message: `Failed to create folder "${relativePath}": ${e?.message ?? e}`,
      });
      return { ok: false, reason: 'io-error', error: String(e?.message ?? e) };
    }
    if (_store) {
      // Preserve any existing record's state (e.g. OUT_OF_SCOPE_SUPPRESSED)
      // rather than clobbering it with CLEAN. A re-emitted add event on a
      // collection the user previously detached must not silently undo
      // their suppression decision.
      const existing = _store.getCollectionRecord(collectionKey);
      _store.add(createCollectionRecord({
        localPath: relativePath,
        zoteroCollectionKey: collectionKey,
        parentCollectionKey: parentCollectionKey ?? existing?.parentCollectionKey ?? null,
        state: existing?.state ?? STATE.CLEAN,
      }));
      try { await _store.save(); } catch (_e) { /* logged inside save() */ }
    }
    Zotero.debug(`[WatchFolder] mirrorExecutor: createFolder ${relativePath} ok`);
    return { ok: true };
  });
}

async function _moveFolder(payload) {
  const {
    collectionKey,
    oldRelativePath,
    newRelativePath,
    newParentCollectionKey,
  } = payload;
  if (!collectionKey
      || typeof newRelativePath !== 'string' || newRelativePath === ''
      || typeof oldRelativePath !== 'string' || oldRelativePath === '') {
    // oldRelativePath MUST be a non-empty string. An empty/undefined value
    // would resolve to the watch-root itself; the executor would then try
    // to move the entire watch folder into one of its own subdirectories.
    return { ok: false, reason: 'invalid-payload' };
  }
  return _withLock(`collection:${collectionKey}`, async () => {
    let oldAbs, newAbs;
    try {
      oldAbs = _absPath(oldRelativePath);
      newAbs = _absPath(newRelativePath);
    } catch (e) {
      return { ok: false, reason: 'no-watch-root', error: String(e?.message ?? e) };
    }
    if (oldAbs === newAbs) {
      Zotero.debug(`[WatchFolder] mirrorExecutor: moveFolder no-op (${newRelativePath})`);
      return { ok: true, reason: 'no-op' };
    }
    // Pre-create the destination's parent so a cross-parent rename works.
    const parent = PathUtils.parent(newAbs);
    if (parent && parent !== newAbs) {
      try {
        await IOUtils.makeDirectory(parent, { ignoreExisting: true, createAncestors: true });
      } catch (e) {
        Zotero.logError(`[WatchFolder] mirrorExecutor moveFolder mkparent ${parent}: ${e?.message ?? e}`);
        reportWarning({
          category: WARNING_CATEGORY.IO_ERROR,
          actionType: 'moveFolder',
          collectionKey,
          path: newRelativePath,
          reason: 'mkparent-failed',
          message: `Failed to create destination parent for "${newRelativePath}": ${e?.message ?? e}`,
        });
        return { ok: false, reason: 'io-error', error: String(e?.message ?? e) };
      }
    }
    const moveResult = await _moveWithFallback(oldAbs, newAbs, /* recursive */ true);
    if (!moveResult.ok) {
      reportWarning({
        category: WARNING_CATEGORY.IO_ERROR,
        actionType: 'moveFolder',
        collectionKey,
        path: newRelativePath,
        reason: moveResult.reason,
        message: `Failed to move "${oldRelativePath}" → "${newRelativePath}": ${moveResult.error || moveResult.reason}`,
      });
      return moveResult;
    }

    if (_store) {
      // Replace the collection record. add() handles both insert and update
      // (the Map is keyed by zoteroCollectionKey).
      const existing = _store.getCollectionRecord(collectionKey);
      _store.add(createCollectionRecord({
        localPath: newRelativePath,
        zoteroCollectionKey: collectionKey,
        parentCollectionKey: (typeof newParentCollectionKey !== 'undefined')
          ? (newParentCollectionKey ?? null)
          : (existing?.parentCollectionKey ?? null),
        state: existing?.state ?? STATE.CLEAN,
      }));
      // Rewrite child file records. Two passes: (1) match on `localPath`
      // to rewrite the Map key + canonicalLocalPath when it equals
      // localPath; (2) match on `canonicalLocalPath` only — covers
      // multi-collection items whose canonical sits under the moved
      // subtree but whose own localPath does NOT (e.g. file lives in
      // collection B but its canonical is collection A which just got
      // renamed). Without pass 2 the canonical pointer would dangle.
      //
      // WP-C #1 perf: parallelize the OUTER loop with a concurrency cap
      // (CHILD_REWRITE_CONCURRENCY). Per-attachment correctness is still
      // guaranteed by the inner `attachment:<key>` lock + re-read under
      // the lock — different children acquire DIFFERENT locks, so they
      // can run in parallel without violating the per-key serialization
      // contract.
      const prefix = oldRelativePath + '/';
      const files = _store.getAllOfType('file');
      const rewritten = new Set();
      // (The earlier TODO suggesting getAllByAttachmentKey here was
      // misplaced — this filter is path-prefix based, not key based.
      // O(n) scan is unavoidable without a per-prefix index.)

      // Pass 1: rewrite localPath + canonicalLocalPath for records whose
      // localPath sits under the moved subtree.
      const pass1Targets = [];
      for (const f of files) {
        const matchesExact = f.localPath === oldRelativePath;
        const matchesNested = f.localPath.startsWith(prefix);
        if (!matchesExact && !matchesNested) continue;
        if (!f.zoteroAttachmentKey) continue; // skip: would collide on `attachment:undefined`
        pass1Targets.push(f);
      }
      await _runWithConcurrency(pass1Targets, CHILD_REWRITE_CONCURRENCY, async (f) => {
        await _withLock(`attachment:${f.zoteroAttachmentKey}`, async () => {
          // Re-read under the lock — a concurrent moveItem completed between
          // the outer enumeration and the lock acquisition may have moved
          // the record out of the subtree.
          const live = _store.getByAttachmentKey(f.zoteroAttachmentKey);
          if (!live) return;
          const stillExact = live.localPath === oldRelativePath;
          const stillNested = live.localPath.startsWith(prefix);
          if (!stillExact && !stillNested) return;
          const suffix = stillExact ? '' : live.localPath.slice(oldRelativePath.length);
          const newPath = newRelativePath + suffix;
          const wasCanonical = live.canonicalLocalPath === live.localPath;
          const newCanonical = wasCanonical
            ? newPath
            : _rewriteIfUnder(live.canonicalLocalPath, oldRelativePath, prefix, newRelativePath);
          // localPath is the Map key — must remove + re-add to re-key.
          _store.remove(live.localPath);
          _store.add(createFileRecord({
            ...live,
            localPath: newPath,
            canonicalLocalPath: newCanonical,
          }));
          rewritten.add(live.zoteroAttachmentKey);
        });
      });

      // Pass 2: canonicalLocalPath fixup for records whose localPath is
      // OUTSIDE the moved subtree (multi-collection items). Split into
      // unlocked (no attachment key) and locked (has key) groups so the
      // locked group can run in parallel under the same cap.
      const pass2Locked = [];
      for (const f of _store.getAllOfType('file')) {
        if (rewritten.has(f.zoteroAttachmentKey)) continue;
        if (!f.zoteroAttachmentKey) {
          // No attachment key → cannot lock safely; mirror previous unlocked behavior.
          const newCanonical = _rewriteIfUnder(f.canonicalLocalPath, oldRelativePath, prefix, newRelativePath);
          if (newCanonical === f.canonicalLocalPath) continue;
          _store.update(f.localPath, { canonicalLocalPath: newCanonical });
          continue;
        }
        pass2Locked.push(f);
      }
      await _runWithConcurrency(pass2Locked, CHILD_REWRITE_CONCURRENCY, async (f) => {
        await _withLock(`attachment:${f.zoteroAttachmentKey}`, async () => {
          const live = _store.getByAttachmentKey(f.zoteroAttachmentKey);
          if (!live) return;
          const newCanonical = _rewriteIfUnder(live.canonicalLocalPath, oldRelativePath, prefix, newRelativePath);
          if (newCanonical === live.canonicalLocalPath) return;
          _store.update(live.localPath, { canonicalLocalPath: newCanonical });
        });
      });
      try { await _store.save(); } catch (_e) { /* logged */ }
    }
    Zotero.debug(`[WatchFolder] mirrorExecutor: moveFolder ${oldRelativePath} → ${newRelativePath} ok`);
    return moveResult; // preserves `copy-fallback` reason when applicable
  });
}

/**
 * `zoteroCollectionDeleted` direction (spec risk #5): a Zotero collection
 * was deleted, so the corresponding LOCAL folder should be trashed. The
 * local files still exist on disk, so the conflict gate is the LOCAL-hash
 * one (`canSafelyMove`) applied per child before the recursive move.
 * Historically this was `deleteFolder`; that name remains a dispatch alias.
 */
async function _zoteroCollectionDeleted(payload) {
  const { collectionKey, oldRelativePath } = payload;
  if (!collectionKey) return { ok: false, reason: 'invalid-payload' };
  return _withLock(`collection:${collectionKey}`, async () => {
    const mode = getPref('mode') || 'mode1';

    // Mode 1 doesn't run the coordinator, so this path isn't reached
    // there. Mode 2 keeps warn-only semantics — local folder untouched,
    // collection record flipped to suppressed, user can resolve via the
    // Phase B folder-resolution UX.
    if (mode !== 'mode3') {
      if (_store) {
        const existing = _store.getCollectionRecord(collectionKey);
        if (existing) {
          _store.add(createCollectionRecord({
            ...existing,
            state: STATE.OUT_OF_SCOPE_SUPPRESSED,
          }));
          try { await _store.save(); } catch (_e) { /* logged */ }
        }
      }
      reportWarning({
        category: WARNING_CATEGORY.SUPPRESSED,
        actionType: 'deleteFolder',
        collectionKey,
        path: oldRelativePath || null,
        reason: 'warn-only-mode2',
        message: `Folder deletion suppressed (Mode 2): "${oldRelativePath || collectionKey}"`,
      });
      Zotero.debug(`[WatchFolder] mirrorExecutor: deleteFolder ${oldRelativePath || collectionKey} suppressed (Mode 2 warn-only)`);
      return { ok: false, reason: 'warn-only-mode2' };
    }

    // First-arm whole-library-delete gate: the first Mode-3 deletion under
    // library scope must be explicitly acknowledged (whole-library blast
    // radius). Refuses if declined or no UI — fail-safe.
    if (!(await confirmFirstLibraryDelete({ scopeMode: getScopeMode() }))) {
      Zotero.debug(`[WatchFolder] mirrorExecutor: zoteroCollectionDeleted ${oldRelativePath || collectionKey} blocked — library-scale deletion not acknowledged`);
      return { ok: false, reason: 'library-delete-not-acknowledged' };
    }

    // Mode 3 — safe-delete: recursive move into plugin trash, drop the
    // collection record + child file records. The contained files are
    // NOT individually tombstoned (the Zotero attachments weren't
    // trashed — only their collection membership was removed; they may
    // still live in other collections). Recovery for "I want this
    // folder back" is via the file manager moving the dir out of
    // `.zotero-watch-trash/`; future work could add a "restore folder"
    // UX in prefs (filed under Track D).
    if (!oldRelativePath) {
      // No path → can't compute a destination. Fall back to dropping
      // tracking + warning the user.
      if (_store) _store.removeCollectionRecord(collectionKey);
      try { if (_store) await _store.save(); } catch (_e) { /* logged */ }
      reportWarning({
        category: WARNING_CATEGORY.SUPPRESSED,
        actionType: 'deleteFolder',
        collectionKey,
        path: null,
        reason: 'no-path',
        message: `Folder deletion: no local path recorded for collection ${collectionKey} — tracking dropped, disk untouched.`,
      });
      return { ok: true, reason: 'no-path' };
    }

    const TRASH_DIRNAME = '.zotero-watch-trash';
    let srcAbs;
    try { srcAbs = _absPath(oldRelativePath); }
    catch (e) { return { ok: false, reason: 'no-watch-root', error: String(e?.message ?? e) }; }

    // Source already gone? Just drop tracking + return success — the
    // disk is already in the desired post-delete state.
    const srcExists = await IOUtils.exists(srcAbs).catch(() => false);
    if (!srcExists) {
      _dropCollectionAndChildren(collectionKey, oldRelativePath);
      try { if (_store) await _store.save(); } catch (_e) { /* logged */ }
      Zotero.debug(`[WatchFolder] mirrorExecutor: deleteFolder ${oldRelativePath} — source already missing, tracking dropped`);
      return { ok: true, reason: 'already-missing' };
    }

    // Bulk-delete protection (Track C). Count tracked files inside the
    // subtree about to be moved; if it crosses the threshold, prompt
    // before proceeding. Refusal returns `{ok:false, reason:'bulk-
    // confirm-denied'}` — leaves the disk + tracking store untouched.
    if (_store) {
      const prefix = oldRelativePath + '/';
      const allFiles = _store.getAllOfType('file');
      let affected = 0;
      for (const r of allFiles) {
        if (r.localPath === oldRelativePath
            || (typeof r.localPath === 'string' && r.localPath.startsWith(prefix))) {
          affected++;
        }
      }
      if (isBulkDelete(affected, allFiles.length)) {
        const approved = await confirmBulkDelete({
          action: 'move to plugin trash',
          path: oldRelativePath,
          affectedCount: affected,
          totalTracked: allFiles.length,
        });
        if (!approved) {
          reportWarning({
            category: WARNING_CATEGORY.SUPPRESSED,
            actionType: 'deleteFolder',
            collectionKey,
            path: oldRelativePath,
            reason: 'bulk-confirm-denied',
            message: `Bulk-delete refused: ${affected}/${allFiles.length} tracked file(s) under "${oldRelativePath}" were not moved to plugin trash (user declined or no UI).`,
          });
          return { ok: false, reason: 'bulk-confirm-denied', affectedCount: affected, totalTracked: allFiles.length };
        }
      }
    }

    // Per-child conflict gate (spec risk #1b) — FAIL-CLOSED. Before moving the
    // whole folder into plugin trash, verify EVERY tracked child file can be
    // PROVEN unchanged since last sync (`gate.ok`). Any non-ok outcome —
    // proven drift, a missing baseline hash, a read/IO error, or a hash
    // failure — blocks the whole move; the only exception is `missing-file`
    // (the child is already gone from disk, so there are no local bytes to
    // protect). Any blocked child aborts the entire folder move and flips the
    // blocked records to CONFLICT_BLOCKED; we never trash a child we cannot
    // confirm is unchanged.
    if (_store) {
      const prefix = oldRelativePath + '/';
      const children = _store.getAllOfType('file').filter((r) =>
        r.localPath === oldRelativePath
        || (typeof r.localPath === 'string' && r.localPath.startsWith(prefix)));
      const blocked = [];
      for (const child of children) {
        let childAbs;
        try { childAbs = _absPath(child.localPath); } catch (_e) { continue; }
        const gate = await canSafelyMove(child, childAbs);
        if (gate.ok) continue;
        if (gate.reason === 'missing-file') continue;
        blocked.push({ child, reason: gate.reason });
      }
      if (blocked.length > 0) {
        for (const { child, reason } of blocked) {
          _store.update(child.localPath, { state: STATE.CONFLICT_BLOCKED });
          reportWarning({
            category: WARNING_CATEGORY.CONFLICT_BLOCKED,
            actionType: 'deleteFolder',
            collectionKey,
            path: child.localPath,
            reason,
            message: `Refused to trash folder "${oldRelativePath}" — child file "${child.localPath}" could not be confirmed unchanged (${reason}). Resolve the conflict first.`,
          });
        }
        try { await _store.save(); } catch (_e) { /* logged */ }
        return { ok: false, reason: 'conflict-blocked', conflictedCount: blocked.length };
      }
    }

    // Compute destination under plugin trash. Collision policy mirrors
    // _moveToPluginTrash (RST.6): never overwrite — suffix with a
    // millisecond timestamp on the folder name.
    let dstRel = `${TRASH_DIRNAME}/${oldRelativePath}`;
    let dstAbs;
    try { dstAbs = _absPath(dstRel); }
    catch (e) { return { ok: false, reason: 'no-watch-root', error: String(e?.message ?? e) }; }
    if (await IOUtils.exists(dstAbs).catch(() => false)) {
      const stamp = Date.now();
      dstRel = `${TRASH_DIRNAME}/${oldRelativePath}.${stamp}`;
      dstAbs = _absPath(dstRel);
    }

    // Pre-create parent so a cross-parent move works.
    const parent = PathUtils.parent(dstAbs);
    if (parent && parent !== dstAbs) {
      try {
        await IOUtils.makeDirectory(parent, { ignoreExisting: true, createAncestors: true });
      } catch (e) {
        Zotero.logError(`[WatchFolder] mirrorExecutor deleteFolder mkparent ${parent}: ${e?.message ?? e}`);
        reportWarning({
          category: WARNING_CATEGORY.IO_ERROR,
          actionType: 'deleteFolder',
          collectionKey,
          path: oldRelativePath,
          reason: 'mkparent-failed',
          message: `Failed to create plugin-trash parent for "${oldRelativePath}": ${e?.message ?? e}`,
        });
        return { ok: false, reason: 'io-error', error: String(e?.message ?? e) };
      }
    }

    const moveResult = await _moveWithFallback(srcAbs, dstAbs, /* recursive */ true);
    if (!moveResult.ok) {
      reportWarning({
        category: WARNING_CATEGORY.IO_ERROR,
        actionType: 'deleteFolder',
        collectionKey,
        path: oldRelativePath,
        reason: moveResult.reason,
        message: `Failed to move folder "${oldRelativePath}" to plugin trash: ${moveResult.error || moveResult.reason}`,
      });
      return moveResult;
    }

    _dropCollectionAndChildren(collectionKey, oldRelativePath);
    try { if (_store) await _store.save(); } catch (_e) { /* logged */ }
    reportWarning({
      category: WARNING_CATEGORY.SUPPRESSED,
      actionType: 'deleteFolder',
      collectionKey,
      path: oldRelativePath,
      reason: 'moved-to-plugin-trash',
      message: `Folder "${oldRelativePath}" moved to plugin trash → "${dstRel}". Tracking dropped; restore by moving the folder out of .zotero-watch-trash/.`,
    });
    Zotero.debug(`[WatchFolder] mirrorExecutor: deleteFolder ${oldRelativePath} → ${dstRel} ok (Mode 3 plugin trash)`);
    return { ok: true, reason: moveResult.reason || 'moved-to-plugin-trash', trashPath: dstRel };
  });
}

/**
 * Drop the collection record and every FileRecord whose localPath sits
 * under `relativePath`. Called by `_deleteFolder` after a successful
 * (or already-missing) folder removal. No-op when `_store` is null.
 */
function _dropCollectionAndChildren(collectionKey, relativePath) {
  if (!_store) return;
  _store.removeCollectionRecord(collectionKey);
  if (!relativePath) return;
  const prefix = relativePath + '/';
  const toRemove = [];
  for (const r of _store.getAllOfType('file')) {
    if (r.localPath === relativePath || (typeof r.localPath === 'string' && r.localPath.startsWith(prefix))) {
      toRemove.push(r.localPath);
    }
  }
  for (const p of toRemove) _store.remove(p);
}

/**
 * `localFolderDeleted` direction (spec risk #5): the user deleted a LOCAL
 * folder, so the change should propagate to Zotero. The local files are
 * already gone, so the conflict gate here is the ZOTERO-side freshness one
 * (`canSafelyTrashZoteroAttachment`) — we only trash a Zotero attachment if
 * its stored bytes still match `lastSyncedHash`.
 *
 * Mode 3 (per the approved product decision — bulk-safe-delete):
 *   1. Enumerate tracked child file records under the folder.
 *   2. Bulk-guard once (>10 files or >20% of the tree → confirm).
 *   3. Per child: freshness gate → clean ⇒ trash the Zotero attachment +
 *      drop record; drifted/unverifiable ⇒ CONFLICT_BLOCKED + warn + keep.
 *      Shadow records whose canonical sibling still lives elsewhere are
 *      dropped without trashing the shared attachment (cascading-trash guard).
 *   4. Trash the Zotero collection (recoverable) + drop its record.
 *
 * Mode 2 stays warn-only (mirror of the other direction): flip the
 * collection record to OUT_OF_SCOPE_SUPPRESSED and warn.
 */
async function _localFolderDeleted(payload) {
  const { collectionKey, oldRelativePath } = payload;
  if (!collectionKey) return { ok: false, reason: 'invalid-payload' };
  return _withLock(`collection:${collectionKey}`, async () => {
    const mode = getPref('mode') || 'mode1';

    if (mode !== 'mode3') {
      if (_store) {
        const existing = _store.getCollectionRecord(collectionKey);
        if (existing) {
          _store.add(createCollectionRecord({
            ...existing,
            state: STATE.OUT_OF_SCOPE_SUPPRESSED,
          }));
          try { await _store.save(); } catch (_e) { /* logged */ }
        }
      }
      reportWarning({
        category: WARNING_CATEGORY.SUPPRESSED,
        actionType: 'localFolderDeleted',
        collectionKey,
        path: oldRelativePath || null,
        reason: 'warn-only-mode2',
        message: `Local folder removal suppressed (Mode 2): "${oldRelativePath || collectionKey}" — Zotero collection kept.`,
      });
      return { ok: false, reason: 'warn-only-mode2' };
    }

    // First-arm whole-library-delete gate (see _zoteroCollectionDeleted).
    if (!(await confirmFirstLibraryDelete({ scopeMode: getScopeMode() }))) {
      Zotero.debug(`[WatchFolder] mirrorExecutor: localFolderDeleted ${oldRelativePath || collectionKey} blocked — library-scale deletion not acknowledged`);
      return { ok: false, reason: 'library-delete-not-acknowledged' };
    }

    // Mode 3 — propagate the deletion to Zotero.
    const syncRoot = await resolveSyncRoot().catch(() => null);
    const libraryID = syncRoot?.libraryID ?? Zotero.Libraries.userLibraryID;

    // Gather tracked child file records (under the folder path).
    let children = [];
    if (_store && oldRelativePath) {
      const prefix = oldRelativePath + '/';
      children = _store.getAllOfType('file').filter((r) =>
        r.localPath === oldRelativePath
        || (typeof r.localPath === 'string' && r.localPath.startsWith(prefix)));
    }

    // Bulk-delete protection — count the attachments that would be trashed.
    if (_store && children.length > 0) {
      const totalTracked = _store.getAllOfType('file').length;
      if (isBulkDelete(children.length, totalTracked)) {
        const approved = await confirmBulkDelete({
          action: 'trash in Zotero (local folder deleted)',
          path: oldRelativePath,
          affectedCount: children.length,
          totalTracked,
        });
        if (!approved) {
          reportWarning({
            category: WARNING_CATEGORY.SUPPRESSED,
            actionType: 'localFolderDeleted',
            collectionKey,
            path: oldRelativePath,
            reason: 'bulk-confirm-denied',
            message: `Bulk Zotero-trash refused: ${children.length}/${totalTracked} attachment(s) under "${oldRelativePath}" left untouched (user declined or no UI).`,
          });
          return { ok: false, reason: 'bulk-confirm-denied', affectedCount: children.length, totalTracked };
        }
      }
    }

    let trashed = 0;
    let blocked = 0;
    for (const child of children) {
      if (!child.zoteroAttachmentKey) { if (_store) _store.remove(child.localPath); continue; }

      // Cascading-trash guard: a shadow (localPath !== canonicalLocalPath)
      // whose canonical sibling still lives elsewhere shares the SAME Zotero
      // attachment — don't trash it. Drop the shadow record only.
      const isShadow = child.localPath !== child.canonicalLocalPath;
      if (isShadow && _store) {
        const canonical = _store.getAllByAttachmentKey(child.zoteroAttachmentKey)
          .find((r) => r.localPath === r.canonicalLocalPath && r !== child);
        if (canonical) {
          _store.remove(child.localPath);
          continue;
        }
      }

      let item = null;
      try {
        item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, child.zoteroAttachmentKey);
      } catch (_e) { item = null; }
      if (!item) {
        // Attachment already gone from Zotero — nothing to trash.
        if (_store) _store.remove(child.localPath);
        continue;
      }

      const gate = await canSafelyTrashZoteroAttachment(child, item);
      if (!gate.ok) {
        if (_store) _store.update(child.localPath, { state: STATE.CONFLICT_BLOCKED });
        blocked++;
        reportWarning({
          category: WARNING_CATEGORY.CONFLICT_BLOCKED,
          actionType: 'localFolderDeleted',
          attachmentKey: child.zoteroAttachmentKey,
          collectionKey,
          path: child.localPath,
          reason: gate.reason,
          message: `Refused to trash Zotero attachment for "${child.localPath}" — ${gate.reason === 'hash-drifted' ? 'Zotero copy changed since last sync' : gate.reason}. Local folder was deleted; resolve before propagating.`,
        });
        continue;
      }

      try {
        if (!item.deleted) {
          item.deleted = true;
          await item.saveTx();
        }
        trashed++;
      } catch (e) {
        Zotero.logError(`[WatchFolder] mirrorExecutor localFolderDeleted trash ${child.zoteroAttachmentKey}: ${e?.message ?? e}`);
      }
      if (_store) _store.remove(child.localPath);
    }

    // Trash the Zotero collection itself (recoverable) — but only if no
    // child was conflict-blocked (a blocked child means the folder isn't
    // safely empty yet; keep the collection so the user can resolve).
    let collectionTrashed = false;
    if (blocked === 0) {
      try {
        const collection = Zotero.Collections.getByLibraryAndKey
          ? Zotero.Collections.getByLibraryAndKey(libraryID, collectionKey)
          : null;
        if (collection) {
          if (!collection.deleted) {
            collection.deleted = true;
            await collection.saveTx();
          }
          collectionTrashed = true;
        }
      } catch (e) {
        Zotero.logError(`[WatchFolder] mirrorExecutor localFolderDeleted trash collection ${collectionKey}: ${e?.message ?? e}`);
      }
      if (_store) _store.removeCollectionRecord(collectionKey);
    }

    try { if (_store) await _store.save(); } catch (_e) { /* logged */ }
    reportWarning({
      category: WARNING_CATEGORY.SUPPRESSED,
      actionType: 'localFolderDeleted',
      collectionKey,
      path: oldRelativePath || null,
      reason: blocked > 0 ? 'partial-conflict' : 'propagated-to-zotero',
      message: `Local folder "${oldRelativePath || collectionKey}" deleted → trashed ${trashed} Zotero attachment(s)${blocked > 0 ? `, ${blocked} blocked (conflict)` : ''}${collectionTrashed ? ', collection trashed' : ''}.`,
    });
    Zotero.debug(`[WatchFolder] mirrorExecutor: localFolderDeleted ${oldRelativePath || collectionKey} — trashed=${trashed} blocked=${blocked} collectionTrashed=${collectionTrashed}`);
    return { ok: true, reason: blocked > 0 ? 'partial-conflict' : 'propagated-to-zotero', trashed, blocked, collectionTrashed };
  });
}

async function _moveItem(payload) {
  const { attachmentKey, oldCanonicalPath, newCanonicalPath, newCanonicalCollectionKey } = payload;
  if (!attachmentKey || typeof newCanonicalPath !== 'string' || !oldCanonicalPath) {
    return { ok: false, reason: 'invalid-payload' };
  }
  return _withLock(`attachment:${attachmentKey}`, async () => {
    if (oldCanonicalPath === newCanonicalPath) return { ok: true, reason: 'no-op' };

    // Re-read the live record AFTER acquiring the lock. A prior action in the
    // same scan-cycle batch (e.g. a moveFolder that rewrote child paths) may
    // have made the queued payload's oldCanonicalPath stale. Trusting the
    // payload here surfaced as spurious missing-file / wrong-source moves.
    // Tracked as TODO Track A #3.
    let liveSourcePath = oldCanonicalPath;
    if (_store) {
      const liveRec = _store.getByAttachmentKey(attachmentKey);
      if (liveRec && liveRec.canonicalLocalPath) {
        liveSourcePath = liveRec.canonicalLocalPath;
      }
    }
    if (liveSourcePath === newCanonicalPath) {
      Zotero.debug(`[WatchFolder] mirrorExecutor: moveItem no-op (already at ${newCanonicalPath})`);
      return { ok: true, reason: 'no-op' };
    }

    let oldAbs, newAbs;
    try {
      oldAbs = _absPath(liveSourcePath);
      newAbs = _absPath(newCanonicalPath);
    } catch (e) {
      return { ok: false, reason: 'no-watch-root', error: String(e?.message ?? e) };
    }

    if (_store) {
      const rec = _store.getByAttachmentKey(attachmentKey);
      if (rec) {
        const gate = await canSafelyMove(rec, oldAbs);
        if (!gate.ok) {
          // Mark the record so the user UX can surface it (Phase D).
          if (gate.reason === 'hash-drifted') {
            _store.update(rec.localPath, { state: STATE.CONFLICT_BLOCKED });
            try { await _store.save(); } catch (_e) { /* logged */ }
            reportWarning({
              category: WARNING_CATEGORY.CONFLICT_BLOCKED,
              actionType: 'moveItem',
              attachmentKey,
              path: oldCanonicalPath,
              reason: 'hash-drifted',
              message: `Refused to move "${oldCanonicalPath}" — file was edited locally since last sync`,
            });
          } else if (gate.reason === 'missing-file') {
            reportWarning({
              category: WARNING_CATEGORY.MISSING_FILE,
              actionType: 'moveItem',
              attachmentKey,
              path: oldCanonicalPath,
              reason: 'missing-file',
              message: `Cannot move "${oldCanonicalPath}" — file not found on disk`,
            });
          } else if (gate.reason === 'invalid-record' || gate.reason === 'hash-failed' || gate.reason === 'io-error') {
            // canSafelyMove rejected for a non-conflict reason — surface it
            // so the user knows the move was dropped. Silent drops here
            // were a review finding (Phase D follow-up).
            reportWarning({
              category: WARNING_CATEGORY.CONFLICT_BLOCKED,
              actionType: 'moveItem',
              attachmentKey,
              path: oldCanonicalPath,
              reason: gate.reason,
              message: `Cannot move "${oldCanonicalPath}" — ${gate.reason} (no safety baseline; move skipped)`,
            });
          }
          Zotero.debug(`[WatchFolder] mirrorExecutor moveItem blocked: ${gate.reason}`);
          return gate;
        }
      }
    }

    const parent = PathUtils.parent(newAbs);
    if (parent && parent !== newAbs) {
      try {
        await IOUtils.makeDirectory(parent, { ignoreExisting: true, createAncestors: true });
      } catch (e) {
        return { ok: false, reason: 'io-error', error: String(e?.message ?? e) };
      }
    }
    const moveResult = await _moveWithFallback(oldAbs, newAbs, /* recursive */ false);
    if (!moveResult.ok) {
      reportWarning({
        category: WARNING_CATEGORY.IO_ERROR,
        actionType: 'moveItem',
        attachmentKey,
        path: oldCanonicalPath,
        reason: moveResult.reason,
        message: `Failed to move "${oldCanonicalPath}" → "${newCanonicalPath}": ${moveResult.error || moveResult.reason}`,
      });
      return moveResult;
    }

    if (_store) {
      const rec = _store.getByAttachmentKey(attachmentKey);
      if (rec) {
        const wasCanonical = rec.canonicalLocalPath === rec.localPath;
        _store.remove(rec.localPath);
        _store.add(createFileRecord({
          ...rec,
          localPath: newCanonicalPath,
          canonicalLocalPath: wasCanonical ? newCanonicalPath : rec.canonicalLocalPath,
          // Keep the canonical-collection field in sync when the caller is
          // re-canonicalizing (A3 path). Undefined → leave existing value.
          canonicalCollectionKey: (typeof newCanonicalCollectionKey !== 'undefined')
            ? (newCanonicalCollectionKey ?? null)
            : rec.canonicalCollectionKey,
        }));
        try { await _store.save(); } catch (_e) { /* logged */ }
      }
    }
    Zotero.debug(`[WatchFolder] mirrorExecutor: moveItem ${oldCanonicalPath} → ${newCanonicalPath} ok`);
    return moveResult; // preserves `copy-fallback` reason when applicable
  });
}

async function _addItemMembership(payload) {
  const { attachmentKey, collectionKey } = payload;
  if (!attachmentKey || !collectionKey) return { ok: false, reason: 'invalid-payload' };
  return _withLock(`attachment:${attachmentKey}`, async () => {
    if (!_store) return { ok: false, reason: 'no-store' };
    const rec = _store.getByAttachmentKey(attachmentKey);
    if (!rec) {
      // The collectionWatcher saw a tracked item that we don't have a
      // FileRecord for. Surface this so the user knows there's drift
      // between Zotero and the local tracking store.
      reportWarning({
        category: WARNING_CATEGORY.UNKNOWN_TARGET,
        actionType: 'addItemMembership',
        attachmentKey,
        collectionKey,
        reason: 'unknown-attachment',
        message: `addItemMembership: no tracking record for attachment ${attachmentKey}`,
      });
      return { ok: false, reason: 'unknown-attachment' };
    }
    const set = new Set(rec.collectionMembershipKeys || []);
    const updates = {};
    if (!set.has(collectionKey)) {
      set.add(collectionKey);
      updates.collectionMembershipKeys = Array.from(set);
    }
    // Safety net: if the record was OUT_OF_SCOPE_SUPPRESSED but a
    // sync-root collection is being re-added, clear the suppression.
    // Zotero (or the user) put it back; treat it as actively synced
    // again. Without this, suppression could "stick" through Zotero
    // reparenting flows (RecognizePDF) where remove fires before/after
    // a no-op add on the parent. USER_DETACHED records intentionally
    // stay detached — only the auto-suppressed state auto-clears.
    if (rec.state === STATE.OUT_OF_SCOPE_SUPPRESSED) {
      try {
        const rel = await collectionKeyToRelativePath(collectionKey);
        if (rel !== null) {
          updates.state = STATE.CLEAN;
          if (!rec.canonicalCollectionKey) updates.canonicalCollectionKey = collectionKey;
        }
      } catch (_e) { /* sync-root unresolvable — leave state alone */ }
    }
    if (Object.keys(updates).length === 0) return { ok: true, reason: 'no-op' };
    _store.update(rec.localPath, updates);
    try { await _store.save(); } catch (_e) { /* logged */ }
    return { ok: true };
  });
}

async function _removeItemMembership(payload) {
  const { attachmentKey, collectionKey } = payload;
  if (!attachmentKey || !collectionKey) return { ok: false, reason: 'invalid-payload' };
  return _withLock(`attachment:${attachmentKey}`, async () => {
    if (!_store) return { ok: false, reason: 'no-store' };
    const rec = _store.getByAttachmentKey(attachmentKey);
    if (!rec) return { ok: false, reason: 'unknown-attachment' };
    const next = (rec.collectionMembershipKeys || []).filter((k) => k !== collectionKey);
    if (next.length === (rec.collectionMembershipKeys || []).length) {
      return { ok: true, reason: 'no-op' };
    }
    const updates = { collectionMembershipKeys: next };
    // Suppression decision must be based on SYNC-ROOT memberships only.
    // Per spec: "Remove `paper-a` from all collections UNDER THE SYNC ROOT
    // → Treat as out-of-scope". If the item still lives in (e.g.) Inbox
    // outside the sync root, that doesn't count toward "still synced" —
    // the plugin should still suppress because no sync-root collection
    // references it anymore. Bug discovered live in SUPP.1 MCP run.
    let syncRootMembershipsRemaining = 0;
    for (const k of next) {
      try {
        const rel = await collectionKeyToRelativePath(k);
        if (rel !== null) syncRootMembershipsRemaining++;
      } catch (_e) { /* sync-root unresolvable — skip count */ }
    }
    // Library scope: losing the last collection membership does NOT take the
    // item out of scope — the whole library is in scope, so the item is now
    // Unfiled. Keep it syncing (state unchanged), clear the canonical key
    // (null = Unfiled/root); itemMembershipHandler recomputes the canonical and
    // moves the file to the watch-folder root. No suppression, no warning.
    const libraryScope = getScopeMode() === 'library';
    if (syncRootMembershipsRemaining === 0 && !libraryScope) {
      updates.state = STATE.OUT_OF_SCOPE_SUPPRESSED;
      if (rec.canonicalCollectionKey) {
        updates.canonicalCollectionKey = null;
      }
    } else if (syncRootMembershipsRemaining === 0 && libraryScope) {
      // Unfiled now — drop the canonical key, keep syncing.
      if (rec.canonicalCollectionKey) updates.canonicalCollectionKey = null;
    } else if (rec.canonicalCollectionKey === collectionKey) {
      // Canonical was just dropped; clear it so A3 can pick a new one.
      updates.canonicalCollectionKey = null;
    }
    _store.update(rec.localPath, updates);
    try { await _store.save(); } catch (_e) { /* logged */ }
    if (syncRootMembershipsRemaining === 0 && !libraryScope) {
      reportWarning({
        category: WARNING_CATEGORY.SUPPRESSED,
        actionType: 'removeItemMembership',
        attachmentKey,
        collectionKey,
        path: rec.localPath,
        reason: 'last-sync-root-membership-removed',
        message: `Item "${rec.localPath}" lost its last sync-root membership — local file kept, sync paused`,
      });
    }
    return { ok: true };
  });
}

// ─── Cross-FS-aware move ──────────────────────────────────────────────────

/**
 * Attempt `IOUtils.move`; on failure (which often indicates EXDEV across
 * filesystems on Linux, or a similar error on macOS/Windows), fall back to
 * a recursive copy + remove. Returns the same {ok, reason} shape as the
 * action handlers.
 */
async function _moveWithFallback(srcAbs, dstAbs, recursive) {
  try {
    await IOUtils.move(srcAbs, dstAbs, { noOverwrite: true });
    return { ok: true };
  } catch (moveErr) {
    Zotero.debug(`[WatchFolder] mirrorExecutor: IOUtils.move failed (${moveErr?.message ?? moveErr}), falling back to copy+remove`);
    try {
      await IOUtils.copy(srcAbs, dstAbs, recursive ? { recursive: true } : undefined);
      await IOUtils.remove(srcAbs, recursive ? { recursive: true } : undefined);
      return { ok: true, reason: 'copy-fallback' };
    } catch (copyErr) {
      // Rollback: best-effort remove of partial destination so the next
      // attempt doesn't see a stale half-copy.
      try { await IOUtils.remove(dstAbs, recursive ? { recursive: true, ignoreAbsent: true } : { ignoreAbsent: true }); }
      catch (_e) { /* best effort */ }
      Zotero.logError(`[WatchFolder] mirrorExecutor: copy-fallback failed: ${copyErr?.message ?? copyErr}`);
      return { ok: false, reason: 'io-error', error: String(copyErr?.message ?? copyErr) };
    }
  }
}
