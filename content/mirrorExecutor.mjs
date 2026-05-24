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
 *   deleteFolder            — Mode 2 warns only; Mode 3 deferred to v2.2
 *   moveItem                — gated by conflict-gate; move single file
 *   addItemMembership       — tracking-only (collectionMembershipKeys union)
 *   removeItemMembership    — tracking-only (collectionMembershipKeys minus)
 *
 * The executor does NOT read the `mode` preference itself. The coordinator
 * decides which actions to emit per-mode; the executor is a pure handler.
 *
 * @module mirrorExecutor
 */

import { getPref, getFileHash, HASH_CHUNK_SIZE } from './utils.mjs';
import { createFileRecord, createCollectionRecord, STATE } from './trackingStore.mjs';

// HASH_CHUNK_SIZE imported so callers reading lastSyncedHash know what byte
// budget was used. Kept in the import list to make the dependency explicit.
void HASH_CHUNK_SIZE;

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
  const currentHash = await getFileHash(absPath);
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
 * Resolve a forward-slash-joined relative path under the watch root into a
 * platform-native absolute path. Empty / null relative paths return the
 * watch-root path itself.
 */
function _absPath(relPath) {
  const root = _watchRoot();
  if (!relPath || relPath === '') return root;
  const segments = relPath.split('/').filter((s) => s.trim() !== '');
  if (segments.length === 0) return root;
  return PathUtils.join(root, ...segments);
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
      return { ok: false, reason: 'io-error', error: String(e?.message ?? e) };
    }
    if (_store) {
      _store.add(createCollectionRecord({
        localPath: relativePath,
        zoteroCollectionKey: collectionKey,
        parentCollectionKey: parentCollectionKey ?? null,
        state: STATE.CLEAN,
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
  if (!collectionKey || typeof newRelativePath !== 'string' || newRelativePath === '') {
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
        return { ok: false, reason: 'io-error', error: String(e?.message ?? e) };
      }
    }
    const moveResult = await _moveWithFallback(oldAbs, newAbs, /* recursive */ true);
    if (!moveResult.ok) return moveResult;

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
      // Rewrite child file records. Match on `localPath` either equal to
      // oldRelativePath OR starting with `oldRelativePath + '/'`.
      const prefix = oldRelativePath ? oldRelativePath + '/' : '';
      const files = _store.getAllOfType('file');
      for (const f of files) {
        const matchesExact = oldRelativePath && f.localPath === oldRelativePath;
        const matchesNested = prefix && f.localPath.startsWith(prefix);
        if (!matchesExact && !matchesNested) continue;
        const suffix = matchesExact ? '' : f.localPath.slice(oldRelativePath.length);
        const newPath = newRelativePath + suffix;
        const wasCanonical = f.canonicalLocalPath === f.localPath;
        // localPath is the Map key — must remove + re-add to re-key.
        _store.remove(f.localPath);
        _store.add(createFileRecord({
          ...f,
          localPath: newPath,
          canonicalLocalPath: wasCanonical ? newPath : f.canonicalLocalPath,
        }));
      }
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
    // Mode 2 (v2.1) policy: warn only — do NOT delete the local folder.
    // Mark the collection record as out-of-scope-suppressed so the user
    // can resolve via the suppression UX (Phase B). Mode 3 (v2.2) will
    // add safe trash to `.zotero-watch-trash/`.
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
    Zotero.debug(`[WatchFolder] mirrorExecutor: deleteFolder ${oldRelativePath || collectionKey} suppressed (Mode 2 warn-only)`);
    return { ok: false, reason: 'warn-only-mode2' };
  });
}

async function _moveItem(payload) {
  const { attachmentKey, oldCanonicalPath, newCanonicalPath, newCanonicalCollectionKey } = payload;
  if (!attachmentKey || typeof newCanonicalPath !== 'string' || !oldCanonicalPath) {
    return { ok: false, reason: 'invalid-payload' };
  }
  return _withLock(`attachment:${attachmentKey}`, async () => {
    if (oldCanonicalPath === newCanonicalPath) return { ok: true, reason: 'no-op' };

    let oldAbs, newAbs;
    try {
      oldAbs = _absPath(oldCanonicalPath);
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
    if (!moveResult.ok) return moveResult;

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
    if (!_store) return { ok: true, reason: 'no-store' };
    const rec = _store.getByAttachmentKey(attachmentKey);
    if (!rec) return { ok: false, reason: 'unknown-attachment' };
    const set = new Set(rec.collectionMembershipKeys || []);
    if (set.has(collectionKey)) return { ok: true, reason: 'no-op' };
    set.add(collectionKey);
    _store.update(rec.localPath, { collectionMembershipKeys: Array.from(set) });
    try { await _store.save(); } catch (_e) { /* logged */ }
    return { ok: true };
  });
}

async function _removeItemMembership(payload) {
  const { attachmentKey, collectionKey } = payload;
  if (!attachmentKey || !collectionKey) return { ok: false, reason: 'invalid-payload' };
  return _withLock(`attachment:${attachmentKey}`, async () => {
    if (!_store) return { ok: true, reason: 'no-store' };
    const rec = _store.getByAttachmentKey(attachmentKey);
    if (!rec) return { ok: false, reason: 'unknown-attachment' };
    const next = (rec.collectionMembershipKeys || []).filter((k) => k !== collectionKey);
    if (next.length === (rec.collectionMembershipKeys || []).length) {
      return { ok: true, reason: 'no-op' };
    }
    const updates = { collectionMembershipKeys: next };
    // If we just removed the last sync-root membership, mark suppressed so
    // the user can resolve via the suppression UX (Phase B).
    if (next.length === 0) {
      updates.state = STATE.OUT_OF_SCOPE_SUPPRESSED;
    } else if (rec.canonicalCollectionKey === collectionKey) {
      // Canonical was just dropped; clear it so A3 can pick a new one.
      updates.canonicalCollectionKey = null;
    }
    _store.update(rec.localPath, updates);
    try { await _store.save(); } catch (_e) { /* logged */ }
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
