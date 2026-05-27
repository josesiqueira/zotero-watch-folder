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
 *   deleteFolder            — Mode 2 warns only; Mode 3 recursive-moves into plugin trash
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
import { collectionKeyToRelativePath } from './canonicalPath.mjs';
import { isBulkDelete, confirmBulkDelete } from './bulkGuard.mjs';

// WP-C #2: optional hash cache (perf/wp-a). Resolved lazily via dynamic
// import so this slice merges cleanly when WP-A is not yet present —
// missing-module errors fall through to direct `getFileHash`.
// TODO(perf-C2-integration): remove fallback once perf/wp-a lands.
let _hashCacheResolved = false;
let _hashCacheRef = null;
async function _getHashCache() {
  if (_hashCacheResolved) return _hashCacheRef;
  _hashCacheResolved = true;
  try {
    const mod = await import('./_hashCache.mjs');
    _hashCacheRef = mod?.hashCache ?? null;
  } catch (_e) {
    _hashCacheRef = null; // module not present yet
  }
  return _hashCacheRef;
}

/**
 * Test seam — reset the lazy hash-cache reference so a test can re-mock
 * `./_hashCache.mjs` between cases. Internal; not part of the public API.
 */
export function _resetHashCacheRef() {
  _hashCacheResolved = false;
  _hashCacheRef = null;
}

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
    case 'deleteFolder':         return _deleteFolder(payload);
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
  // WP-C #2: try the (path, size, mtime) hash cache before paying for a
  // full SHA-256 read. The cache is keyed so an unchanged file hits
  // O(1); an edited file (mtime advances) naturally misses and falls
  // through to a fresh hash. Cache absent (module not yet merged) →
  // fall through to direct `getFileHash`.
  // TODO(perf-C2-integration): collapse to a plain import when WP-A lands.
  let currentHash = null;
  const cache = await _getHashCache();
  if (cache && typeof cache.hashFile === 'function') {
    let statHint = null;
    try { statHint = await IOUtils.stat(absPath); } catch (_e) { /* fall through */ }
    try {
      currentHash = await cache.hashFile(absPath, statHint);
    } catch (_e) {
      currentHash = null; // cache failed → fall through to direct hash
    }
  }
  if (!currentHash) {
    currentHash = await getFileHash(absPath);
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
      // TODO(perf-C1): switch to getAllByAttachmentKey once perf/wp-b lands.

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

async function _deleteFolder(payload) {
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
    if (syncRootMembershipsRemaining === 0) {
      updates.state = STATE.OUT_OF_SCOPE_SUPPRESSED;
      if (rec.canonicalCollectionKey) {
        updates.canonicalCollectionKey = null;
      }
    } else if (rec.canonicalCollectionKey === collectionKey) {
      // Canonical was just dropped; clear it so A3 can pick a new one.
      updates.canonicalCollectionKey = null;
    }
    _store.update(rec.localPath, updates);
    try { await _store.save(); } catch (_e) { /* logged */ }
    if (syncRootMembershipsRemaining === 0) {
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
