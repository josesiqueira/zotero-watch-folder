/**
 * Tracking Store — v2 schema.
 *
 * Persists three discriminated record types under one JSON file:
 *
 *   - file       : a tracked local file ↔ Zotero attachment
 *   - collection : a tracked local folder ↔ Zotero subcollection
 *   - tombstone  : a record of something that was deleted, recoverable
 *
 * Identity uses Zotero collection/attachment **keys** (8-char strings, stable
 * across libraries) — not numeric itemIDs (per X1 cross-phase decision).
 *
 * Persisted as `zotero-watch-folder-tracking-v2.json`. A v1 file on disk is
 * ignored; this is a clean break (no users exist).
 *
 * @module trackingStore
 */

import { sanitizeUntrustedKeys } from './utils.mjs';

const TRACKING_FILENAME = 'zotero-watch-folder-tracking-v2.json';
const SCHEMA_VERSION = 2;

/**
 * States that should remain queryable by content hash for dedup. Any
 * record state OUTSIDE this set (e.g. user-detached, suppressed,
 * conflict-blocked) is intentionally excluded from `_byHash` so a fresh
 * file import does not silently rebind to a Zotero item the user
 * already chose to stop syncing.
 */
function _isHashIndexable(state) {
  return state === 'clean'
    || state === 'dirty'
    || state === 'pending'
    || state === 'pending-zotero-file'
    || state === 'pending-hydration'
    || state === 'external-edit';
}

/**
 * Valid state values for the `state` field on file / collection / tombstone
 * records. v2.0 (Mode 1) only writes `clean | pending | missing | paused`;
 * the other values are reserved for v2.1 (Mode 2) and v2.2 (Mode 3) and
 * declared here so consumers can reference them by name.
 */
export const STATE = Object.freeze({
  CLEAN: 'clean',
  DIRTY: 'dirty',
  PENDING: 'pending',
  MISSING: 'missing',
  PAUSED: 'paused',
  RECOVERABLE: 'recoverable',
  OUT_OF_SCOPE_SUPPRESSED: 'out-of-scope-suppressed',
  /** User chose "keep local but stop syncing" via the suppression UX. */
  USER_DETACHED: 'user-detached',
  CONFLICT_BLOCKED: 'conflict-blocked',
  CONFLICT_REFUSED: 'conflict-refused',
  PENDING_ZOTERO_FILE: 'pending-zotero-file',
  EXTERNAL_EDIT: 'external-edit',
  PENDING_HYDRATION: 'pending-hydration',
  MISSING_FILE: 'missing-file',
});

/**
 * @typedef {Object} FileRecord
 * @property {'file'} type
 * @property {string} localPath - Path under sync root, forward-slash joined.
 * @property {string} canonicalLocalPath - Single canonical local path for a
 *   Zotero attachment that may belong to multiple collections. Equals
 *   `localPath` until membership changes pick a different canonical.
 * @property {string|null} lastSyncedHash - Full-file SHA-256 (see utils.getFileHash).
 * @property {number} lastSyncedSize
 * @property {number} lastSyncedMtime
 * @property {string|null} zoteroItemKey - Parent item key, if attachment has one.
 * @property {string} zoteroAttachmentKey
 * @property {string|null} canonicalCollectionKey
 * @property {string[]} collectionMembershipKeys
 * @property {string} state - One of STATE.*
 * @property {string} importDate - ISO timestamp.
 */

/**
 * @typedef {Object} CollectionRecord
 * @property {'collection'} type
 * @property {string} localPath - Folder path under sync root.
 * @property {string} zoteroCollectionKey
 * @property {string|null} parentCollectionKey
 * @property {string} state
 */

/**
 * @typedef {Object} TombstoneRecord
 * @property {'tombstone'} type
 * @property {'file'|'collection'} objectType
 * @property {string} localPath
 * @property {string|null} canonicalLocalPath
 * @property {string|null} zoteroAttachmentKey
 * @property {string|null} zoteroItemKey
 * @property {'zotero'|'local'} deletedFrom
 * @property {string|null} trashPath - Location in plugin trash dir if file was
 *   moved there; null for collection tombstones.
 * @property {string} deletedAt - ISO timestamp.
 * @property {string|null} originalHash
 * @property {string} state - Typically STATE.RECOVERABLE.
 */

/**
 * Factory: create a fully-formed file record from a partial spec. Missing
 * fields are filled with conservative defaults.
 * @param {Partial<FileRecord>} data
 * @returns {FileRecord}
 */
export function createFileRecord(data) {
  return {
    type: 'file',
    localPath: data.localPath ?? '',
    canonicalLocalPath: data.canonicalLocalPath ?? data.localPath ?? '',
    lastSyncedHash: data.lastSyncedHash ?? null,
    lastSyncedSize: data.lastSyncedSize ?? 0,
    lastSyncedMtime: data.lastSyncedMtime ?? 0,
    zoteroItemKey: data.zoteroItemKey ?? null,
    zoteroAttachmentKey: data.zoteroAttachmentKey ?? '',
    canonicalCollectionKey: data.canonicalCollectionKey ?? null,
    collectionMembershipKeys: Array.isArray(data.collectionMembershipKeys)
      ? [...data.collectionMembershipKeys]
      : (data.canonicalCollectionKey ? [data.canonicalCollectionKey] : []),
    state: data.state ?? STATE.CLEAN,
    importDate: data.importDate ?? new Date().toISOString(),
  };
}

/**
 * @param {Partial<CollectionRecord>} data
 * @returns {CollectionRecord}
 */
export function createCollectionRecord(data) {
  return {
    type: 'collection',
    localPath: data.localPath ?? '',
    zoteroCollectionKey: data.zoteroCollectionKey ?? '',
    parentCollectionKey: data.parentCollectionKey ?? null,
    state: data.state ?? STATE.CLEAN,
  };
}

/**
 * @param {Partial<TombstoneRecord>} data
 * @returns {TombstoneRecord}
 */
export function createTombstoneRecord(data) {
  return {
    type: 'tombstone',
    objectType: data.objectType ?? 'file',
    localPath: data.localPath ?? '',
    canonicalLocalPath: data.canonicalLocalPath ?? null,
    zoteroAttachmentKey: data.zoteroAttachmentKey ?? null,
    zoteroItemKey: data.zoteroItemKey ?? null,
    deletedFrom: data.deletedFrom ?? 'zotero',
    trashPath: data.trashPath ?? null,
    deletedAt: data.deletedAt ?? new Date().toISOString(),
    originalHash: data.originalHash ?? null,
    state: data.state ?? STATE.RECOVERABLE,
  };
}

/**
 * Legacy alias retained so the v1 bundle still imports successfully while the
 * Mode-1 behaviour rewrite (Phase B) is in flight. New code should use the
 * type-specific factories above.
 * @deprecated
 */
export function createTrackingRecord(data) {
  return createFileRecord(data);
}

/**
 * TrackingStore — three discriminated record collections + derived indexes.
 *
 * Primary storage:
 *   - _files       : Map<localPath, FileRecord>       (LRU by insertion order)
 *   - _collections : Map<zoteroCollectionKey, CollectionRecord>
 *   - _tombstones  : Array<TombstoneRecord>           (scanned linearly)
 *
 * Derived indexes (rebuilt on every mutation; cheap because file count is
 * bounded by `maxFiles`):
 *   - _byAttachmentKey : Map<key, FileRecord>
 *   - _byHash          : Map<hash, FileRecord>
 *
 * LRU eviction applies only to `_files`. `_collections` and `_tombstones`
 * are unbounded — both are small in practice.
 */
export class TrackingStore {
  /**
   * @param {number} maxFiles - Max number of file records before LRU eviction.
   */
  constructor(maxFiles = 5000) {
    this.maxFiles = maxFiles;
    this._files = new Map();
    this._collections = new Map();
    this._tombstones = [];
    this._byAttachmentKey = new Map();
    this._byHash = new Map();
    // WP-B / B2: parallel index that returns ALL FileRecords for an
    // attachment key (canonical + shadows produced by dedup-skip). Distinct
    // from `_byAttachmentKey` (single record only — preserved for backwards
    // compatibility with existing readers).
    this._byAttachmentKeyAll = new Map();
    // WP-B / B1: tombstone indexes. Keyed by originalHash and
    // zoteroAttachmentKey respectively; values are arrays because multiple
    // tombstones can share either key (different files happened to share
    // content, or the same attachment was trashed → restored → trashed
    // again before a save). Tombstones are intentionally NOT in `_byHash`
    // (see CLAUDE.md invariant: `_byHash` is live syncing records only).
    this._tombstonesByHash = new Map();
    this._tombstonesByAttachmentKey = new Map();
    this.dataFile = null;
    this._dirty = false;
    this._initialized = false;
    // WP-B / B3: debounced save plumbing. Multiple `save()` calls within
    // a small window coalesce into one disk write so a busy scan cycle
    // doesn't write the tracking file dozens of times per second.
    //
    //   _saveTimer       : NodeJS.Timeout|null
    //   _pendingSave     : Promise|null — resolves when the next disk
    //                      write completes. Callers awaiting `save()`
    //                      observe the write outcome (including errors).
    //   _resolvePending  : function to resolve _pendingSave.
    //   _rejectPending   : function to reject _pendingSave.
    this._saveTimer = null;
    this._pendingSave = null;
    this._resolvePending = null;
    this._rejectPending = null;
  }

  /**
   * Debounce delay for `save()` coalescing (milliseconds). 50ms is short
   * enough that any human-driven workflow waits invisibly; long enough that
   * a chatty scan cycle batches into one disk write.
   * @private
   */
  get _saveDebounceMs() {
    return 50;
  }

  /**
   * Initialize: resolve data-file path under Zotero data dir, load existing
   * records (if any).
   */
  async init() {
    if (this._initialized) return;
    try {
      const dataDir = Zotero.DataDirectory.dir;
      this.dataFile = PathUtils.join(dataDir, TRACKING_FILENAME);
      Zotero.debug(`[WatchFolder] TrackingStore: data file ${this.dataFile}`);
      await this.load();
      this._initialized = true;
      Zotero.debug(`[WatchFolder] TrackingStore: initialized (files=${this._files.size} collections=${this._collections.size} tombstones=${this._tombstones.length})`);
    } catch (e) {
      Zotero.logError(`[WatchFolder] TrackingStore init: ${e?.message ?? e}`);
      this._files.clear();
      this._collections.clear();
      this._tombstones.length = 0;
      this._rebuildIndexes();
      this._initialized = true;
    }
  }

  _ensureInitialized() {
    if (!this._initialized) {
      throw new Error('TrackingStore not initialized. Call init() first.');
    }
  }

  // ─── Mutations ─────────────────────────────────────────────────────────

  /**
   * Insert or replace a record. Dispatches on `record.type`. For file
   * records, LRU semantics apply (re-adding a path moves it to the tail).
   * @param {FileRecord|CollectionRecord|TombstoneRecord} record
   */
  add(record) {
    this._ensureInitialized();
    if (!record || typeof record !== 'object') {
      Zotero.debug('[WatchFolder] TrackingStore.add: ignored falsy record');
      return;
    }
    switch (record.type) {
      case 'file':
        return this._addFile(record);
      case 'collection':
        return this._addCollection(record);
      case 'tombstone':
        return this.addTombstone(record);
      default:
        Zotero.logError(`[WatchFolder] TrackingStore.add: unknown record type ${record.type}`);
    }
  }

  _addFile(record) {
    if (!record.localPath) {
      Zotero.debug('[WatchFolder] TrackingStore: file record missing localPath');
      return;
    }
    if (this._files.has(record.localPath)) {
      this._files.delete(record.localPath); // move-to-end semantics
    }
    this._files.set(record.localPath, record);
    this._evictIfNeeded();
    this._rebuildIndexes();
    this._dirty = true;
  }

  _addCollection(record) {
    if (!record.zoteroCollectionKey) {
      Zotero.debug('[WatchFolder] TrackingStore: collection record missing zoteroCollectionKey');
      return;
    }
    this._collections.set(record.zoteroCollectionKey, record);
    this._dirty = true;
  }

  /**
   * Append a tombstone (does not deduplicate — a path may be deleted, restored,
   * and deleted again, producing multiple tombstones with different deletedAt).
   * @param {TombstoneRecord} record
   */
  addTombstone(record) {
    this._ensureInitialized();
    if (!record || record.type !== 'tombstone') {
      Zotero.logError('[WatchFolder] TrackingStore.addTombstone: not a tombstone record');
      return;
    }
    this._tombstones.push(record);
    // WP-B / B1: keep tombstone indexes in sync incrementally so the next
    // findTombstoneBy* call doesn't pay a full rebuild cost.
    if (record.originalHash) {
      let list = this._tombstonesByHash.get(record.originalHash);
      if (!list) {
        list = [];
        this._tombstonesByHash.set(record.originalHash, list);
      }
      list.push(record);
    }
    if (record.zoteroAttachmentKey) {
      let list = this._tombstonesByAttachmentKey.get(record.zoteroAttachmentKey);
      if (!list) {
        list = [];
        this._tombstonesByAttachmentKey.set(record.zoteroAttachmentKey, list);
      }
      list.push(record);
    }
    this._dirty = true;
  }

  _evictIfNeeded() {
    while (this._files.size > this.maxFiles) {
      const oldest = this._files.keys().next().value;
      this._files.delete(oldest);
      Zotero.debug(`[WatchFolder] TrackingStore: evicted ${oldest}`);
    }
  }

  _rebuildIndexes() {
    this._byAttachmentKey.clear();
    this._byHash.clear();
    this._byAttachmentKeyAll.clear();
    this._tombstonesByHash.clear();
    this._tombstonesByAttachmentKey.clear();
    for (const rec of this._files.values()) {
      if (rec.zoteroAttachmentKey) {
        // Legacy single-record index (unchanged contract: keeps the
        // most-recently-inserted record per attachment key when duplicates
        // exist — typical for canonical vs shadow records).
        this._byAttachmentKey.set(rec.zoteroAttachmentKey, rec);
        // WP-B / B2: parallel multi-record index returns canonical + shadows.
        let list = this._byAttachmentKeyAll.get(rec.zoteroAttachmentKey);
        if (!list) {
          list = [];
          this._byAttachmentKeyAll.set(rec.zoteroAttachmentKey, list);
        }
        list.push(rec);
      }
      // Detached / suppressed / conflict-blocked records are intentionally
      // OMITTED from _byHash so the hash-dedup path in watchFolder can't
      // re-link a fresh import to a Zotero item the user explicitly
      // detached or that's in a frozen state. attachmentKey lookups still
      // see them (the user may want to resolve via suppression UX).
      if (rec.lastSyncedHash && _isHashIndexable(rec.state)) {
        this._byHash.set(rec.lastSyncedHash, rec);
      }
    }
    // WP-B / B1: tombstone indexes — separate maps so live-record hash
    // dedup (`_byHash`) stays isolated from restore-path lookups.
    for (const t of this._tombstones) {
      if (t.originalHash) {
        let list = this._tombstonesByHash.get(t.originalHash);
        if (!list) {
          list = [];
          this._tombstonesByHash.set(t.originalHash, list);
        }
        list.push(t);
      }
      if (t.zoteroAttachmentKey) {
        let list = this._tombstonesByAttachmentKey.get(t.zoteroAttachmentKey);
        if (!list) {
          list = [];
          this._tombstonesByAttachmentKey.set(t.zoteroAttachmentKey, list);
        }
        list.push(t);
      }
    }
  }

  /**
   * Apply partial updates to an existing file record (keyed by localPath).
   * No-op if no such record exists.
   * @param {string} localPath
   * @param {Partial<FileRecord>} updates
   */
  update(localPath, updates) {
    this._ensureInitialized();
    const rec = this._files.get(localPath);
    if (!rec) {
      Zotero.debug(`[WatchFolder] TrackingStore.update: no file record at ${localPath}`);
      return;
    }
    Object.assign(rec, updates);
    this._rebuildIndexes();
    this._dirty = true;
  }

  /**
   * Remove a file record by localPath.
   * @returns {boolean} true if removed.
   */
  remove(localPath) {
    this._ensureInitialized();
    const removed = this._files.delete(localPath);
    if (removed) {
      this._rebuildIndexes();
      this._dirty = true;
    }
    return removed;
  }

  /**
   * Remove a file record by Zotero attachment key.
   * @returns {boolean} true if removed.
   */
  removeByAttachmentKey(attachmentKey) {
    this._ensureInitialized();
    if (!attachmentKey) return false;
    const rec = this._byAttachmentKey.get(attachmentKey);
    if (!rec) return false;
    return this.remove(rec.localPath);
  }

  /**
   * Remove a collection record by collection key.
   * @returns {boolean}
   */
  removeCollectionRecord(zoteroCollectionKey) {
    this._ensureInitialized();
    const removed = this._collections.delete(zoteroCollectionKey);
    if (removed) this._dirty = true;
    return removed;
  }

  /** Clear all records (file + collection + tombstone). */
  clear() {
    this._ensureInitialized();
    this._files.clear();
    this._collections.clear();
    this._tombstones.length = 0;
    this._rebuildIndexes();
    this._dirty = true;
  }

  // ─── Queries ───────────────────────────────────────────────────────────

  /** @returns {FileRecord|null} */
  getByLocalPath(localPath) {
    this._ensureInitialized();
    return this._files.get(localPath) ?? null;
  }

  /** @returns {FileRecord|null} */
  getByAttachmentKey(attachmentKey) {
    this._ensureInitialized();
    if (!attachmentKey) return null;
    return this._byAttachmentKey.get(attachmentKey) ?? null;
  }

  /**
   * Return ALL FileRecords for an attachment key — canonical record plus
   * any shadow records produced by dedup-skip (the user dropping a second
   * copy of the same file under the watch root). WP-B / B2.
   *
   * Distinct from `getByAttachmentKey`, which returns a single record
   * (whichever happens to be the most-recently-inserted under the
   * legacy `_byAttachmentKey` map). Callers that need to operate on
   * every record for a given attachment (e.g. `mirrorExecutor._moveFolder`
   * rewriting all paths for an attachment when its parent folder moves)
   * should use this instead of `getAllOfType('file').filter(...)`.
   *
   * @param {string} attachmentKey
   * @returns {FileRecord[]} Empty array if no records / falsy key.
   *   Returned array is a defensive copy — mutating it does not affect
   *   the store's internal index.
   */
  getAllByAttachmentKey(attachmentKey) {
    this._ensureInitialized();
    if (!attachmentKey) return [];
    const list = this._byAttachmentKeyAll.get(attachmentKey);
    return list ? list.slice() : [];
  }

  /**
   * Find a live file record by content hash. Tombstones are NOT returned
   * here (use `getRecoverableTombstones` for those) so callers can't
   * accidentally treat a deleted item as a live duplicate.
   * @returns {FileRecord|null}
   */
  findByHash(hash) {
    this._ensureInitialized();
    if (!hash) return null;
    return this._byHash.get(hash) ?? null;
  }

  /** @returns {CollectionRecord|null} */
  getCollectionRecord(zoteroCollectionKey) {
    this._ensureInitialized();
    return this._collections.get(zoteroCollectionKey) ?? null;
  }

  /**
   * @param {'file'|'collection'|'tombstone'} type
   * @returns {Array<FileRecord|CollectionRecord|TombstoneRecord>}
   */
  getAllOfType(type) {
    this._ensureInitialized();
    switch (type) {
      case 'file': return Array.from(this._files.values());
      case 'collection': return Array.from(this._collections.values());
      case 'tombstone': return this._tombstones.slice();
      default: return [];
    }
  }

  /** All records across all types, in a single array. */
  getAll() {
    this._ensureInitialized();
    return [
      ...this._files.values(),
      ...this._collections.values(),
      ...this._tombstones,
    ];
  }

  /** Convenience: does a file record exist at this path? */
  hasPath(localPath) {
    this._ensureInitialized();
    return this._files.has(localPath);
  }

  /**
   * All FileRecords currently flagged OUT_OF_SCOPE_SUPPRESSED — the
   * input list for the Phase B resolution UX.
   * @returns {FileRecord[]}
   */
  getSuppressedFiles() {
    this._ensureInitialized();
    const out = [];
    for (const rec of this._files.values()) {
      if (rec.state === STATE.OUT_OF_SCOPE_SUPPRESSED) out.push(rec);
    }
    return out;
  }

  /**
   * All FileRecords currently flagged CONFLICT_BLOCKED. The conflict
   * gate refuses a move/delete when the file's content has drifted from
   * the lastSyncedHash; the record is left in this state until the
   * user picks a resolution (re-stamp baseline / discard local edit /
   * pause syncing this file). Currently the prefs UI just surfaces
   * the count — full resolution actions are a follow-up.
   * @returns {FileRecord[]}
   */
  getConflictedFiles() {
    this._ensureInitialized();
    const out = [];
    for (const rec of this._files.values()) {
      if (rec.state === STATE.CONFLICT_BLOCKED) out.push(rec);
    }
    return out;
  }

  /**
   * Find a tombstone by content hash. Used by the v2.2 restore matrix
   * (RST.3): when the scanner sees a new file whose hash matches a
   * tombstone, the import flow re-links to the Zotero attachment
   * (un-trashing it if still in the Zotero trash) instead of importing
   * the file as new. Returns the most-recent matching tombstone if
   * several share a hash (different files happened to share content).
   * @param {string} hash
   * @returns {TombstoneRecord|null}
   */
  findTombstoneByHash(hash) {
    this._ensureInitialized();
    if (!hash) return null;
    // WP-B / B1: O(1) bucket lookup. Inside the bucket we still walk to
    // pick the most-recent RECOVERABLE entry — buckets are tiny in practice
    // (hash collisions across tombstones are rare) so a linear scan is fine.
    const bucket = this._tombstonesByHash.get(hash);
    if (!bucket) return null;
    let best = null;
    for (const t of bucket) {
      if (t.state === STATE.RECOVERABLE) {
        if (!best || (t.deletedAt > best.deletedAt)) best = t;
      }
    }
    return best;
  }

  /**
   * Find a tombstone by Zotero attachment key. Used by RST.1: when a
   * Zotero attachment is restored from the trash, the restore handler
   * looks up the tombstone to find the local plugin-trash path and
   * moves the file back to its canonical location.
   * @param {string} attachmentKey
   * @returns {TombstoneRecord|null}
   */
  findTombstoneByAttachmentKey(attachmentKey) {
    this._ensureInitialized();
    if (!attachmentKey) return null;
    // WP-B / B1: O(1) bucket lookup. First RECOVERABLE tombstone wins
    // (same contract as before — order is insertion order, which is
    // chronological because the array is append-only).
    const bucket = this._tombstonesByAttachmentKey.get(attachmentKey);
    if (!bucket) return null;
    for (const t of bucket) {
      if (t.state === STATE.RECOVERABLE) return t;
    }
    return null;
  }

  /**
   * Remove all tombstone(s) matching an attachment key. Called after a
   * successful restore (RST.1 / RST.3) so a future trash event can
   * create a fresh tombstone without ambiguity.
   * @param {string} attachmentKey
   * @returns {number} count removed
   */
  removeTombstoneByAttachmentKey(attachmentKey) {
    this._ensureInitialized();
    if (!attachmentKey) return 0;
    let removed = 0;
    const removedHashes = new Set();
    for (let i = this._tombstones.length - 1; i >= 0; i--) {
      const t = this._tombstones[i];
      if (t.zoteroAttachmentKey === attachmentKey) {
        if (t.originalHash) removedHashes.add(t.originalHash);
        this._tombstones.splice(i, 1);
        removed++;
      }
    }
    if (removed > 0) {
      // WP-B / B1: keep tombstone indexes in sync. Drop the attachment-key
      // bucket entirely (every entry shared the key being removed). For
      // hash buckets, filter out the removed tombstones — other tombstones
      // may share a hash and must survive.
      this._tombstonesByAttachmentKey.delete(attachmentKey);
      for (const hash of removedHashes) {
        const list = this._tombstonesByHash.get(hash);
        if (!list) continue;
        const filtered = list.filter(t => t.zoteroAttachmentKey !== attachmentKey);
        if (filtered.length === 0) {
          this._tombstonesByHash.delete(hash);
        } else {
          this._tombstonesByHash.set(hash, filtered);
        }
      }
      this._dirty = true;
    }
    return removed;
  }

  /**
   * All CollectionRecords currently flagged OUT_OF_SCOPE_SUPPRESSED.
   * Mode 2 flips these when Zotero deletes a tracked subcollection
   * (mirrorExecutor._deleteFolder warn-only path). Phase B's full
   * folder-resolution UX is pending; for now the prefs pane just
   * surfaces the count so the user can act manually.
   * @returns {CollectionRecord[]}
   */
  getSuppressedCollections() {
    this._ensureInitialized();
    const out = [];
    for (const rec of this._collections.values()) {
      if (rec.state === STATE.OUT_OF_SCOPE_SUPPRESSED) out.push(rec);
    }
    return out;
  }

  /** Total file records (for backwards-compat with callers expecting `size`). */
  get size() {
    return this._files.size;
  }

  get count() {
    return this._files.size;
  }

  get isDirty() {
    return this._dirty;
  }

  // ─── Persistence ───────────────────────────────────────────────────────

  /**
   * Persist to disk if dirty (DEBOUNCED — WP-B / B3). Multiple `save()`
   * calls within {@link _saveDebounceMs} coalesce into a single disk
   * write. The returned promise resolves (or rejects) when the actual
   * write completes, so existing `await store.save()` callers still
   * observe write errors as before.
   *
   * The first call schedules a timer and creates a deferred promise.
   * Subsequent calls reset the timer (debounce: idle-trigger semantics)
   * and return the same shared promise. When the timer fires, `_doSave`
   * runs once and resolves the deferred for every awaiting caller.
   *
   * For shutdown paths or anywhere a synchronous write is required,
   * see {@link flush} (alias: {@link saveNow}).
   *
   * @returns {Promise<void>}
   */
  save() {
    this._ensureInitialized();
    if (!this.dataFile) return Promise.resolve();
    // If a save is already pending, just (re)schedule the timer and
    // hand back the same promise. The first caller created it; later
    // callers share it.
    if (!this._pendingSave) {
      this._pendingSave = new Promise((resolve, reject) => {
        this._resolvePending = resolve;
        this._rejectPending = reject;
      });
    }
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
    }
    this._saveTimer = setTimeout(() => {
      // _flushPending performs the actual write and settles the
      // deferred promise. Callers awaiting `save()` await this.
      this._flushPending();
    }, this._saveDebounceMs);
    return this._pendingSave;
  }

  /**
   * Persist unconditionally and synchronously (no debounce). Used by
   * shutdown paths where we'd rather over-write the file than risk
   * losing a recently-touched record that didn't flip the dirty flag.
   *
   * Cancels any pending debounce timer so a stale save doesn't fire
   * after we've already written.
   *
   * @returns {Promise<void>}
   */
  async flush() {
    this._dirty = true;
    // Cancel and inherit the pending promise so callers awaiting an
    // earlier `save()` also observe this write's outcome.
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (!this._pendingSave) {
      this._pendingSave = new Promise((resolve, reject) => {
        this._resolvePending = resolve;
        this._rejectPending = reject;
      });
    }
    const promise = this._pendingSave;
    this._flushPending();
    await promise;
  }

  /** Alias for {@link flush}. */
  async saveNow() {
    return this.flush();
  }

  /**
   * Internal: perform the actual write and settle the deferred promise.
   * Should not be called directly — use `save()` (debounced) or `flush()`
   * (immediate).
   * @private
   */
  _flushPending() {
    const resolve = this._resolvePending;
    const reject = this._rejectPending;
    // Detach the deferred before the write so a save() call MADE DURING
    // the write registers a NEW deferred, not this one.
    this._pendingSave = null;
    this._resolvePending = null;
    this._rejectPending = null;
    this._saveTimer = null;
    // _doSave returns a promise; chain the deferred to its outcome.
    this._doSave().then(
      (val) => { if (resolve) resolve(val); },
      (err) => { if (reject) reject(err); },
    );
  }

  /**
   * Internal: the actual `writeJSON` call. Same behaviour as the pre-B3
   * `save()` — no-op when not dirty, error logged + rethrown on failure.
   * @private
   */
  async _doSave() {
    if (!this._dirty) return;
    if (!this.dataFile) return;
    try {
      const data = {
        version: SCHEMA_VERSION,
        lastSaved: new Date().toISOString(),
        files: Array.from(this._files.values()),
        collections: Array.from(this._collections.values()),
        tombstones: this._tombstones.slice(),
      };
      await IOUtils.writeJSON(this.dataFile, data);
      this._dirty = false;
      Zotero.debug(`[WatchFolder] TrackingStore: saved (files=${data.files.length} collections=${data.collections.length} tombstones=${data.tombstones.length})`);
    } catch (e) {
      Zotero.logError(`[WatchFolder] TrackingStore.save: ${e?.message ?? e}`);
      throw e;
    }
  }

  /**
   * Load from disk. A missing file, malformed JSON, or non-v2 schema all
   * result in an empty store (no crash, no recovery attempt — clean break).
   */
  async load() {
    if (!this.dataFile) return;
    this._files.clear();
    this._collections.clear();
    this._tombstones.length = 0;
    try {
      const exists = await IOUtils.exists(this.dataFile);
      if (!exists) {
        Zotero.debug('[WatchFolder] TrackingStore.load: no file');
        this._rebuildIndexes();
        this._dirty = false;
        return;
      }
      const data = await IOUtils.readJSON(this.dataFile);
      if (!data || data.version !== SCHEMA_VERSION) {
        Zotero.debug(`[WatchFolder] TrackingStore.load: refusing schema version ${data?.version} (expected ${SCHEMA_VERSION}) — starting empty`);
        this._rebuildIndexes();
        this._dirty = false;
        return;
      }
      // Proto-pollution hygiene (security audit 2026-05-27): strip
      // __proto__/constructor/prototype keys from every persisted record
      // before they enter the in-memory store. Downstream `Object.assign(
      // rec, updates)` sites would otherwise be a vector if a malicious
      // local actor crafted the tracking JSON.
      for (const rec of (data.files ?? [])) {
        if (rec?.localPath && rec.type === 'file') {
          this._files.set(rec.localPath, sanitizeUntrustedKeys(rec));
        }
      }
      for (const rec of (data.collections ?? [])) {
        if (rec?.zoteroCollectionKey && rec.type === 'collection') {
          this._collections.set(rec.zoteroCollectionKey, sanitizeUntrustedKeys(rec));
        }
      }
      for (const rec of (data.tombstones ?? [])) {
        if (rec?.type === 'tombstone') this._tombstones.push(sanitizeUntrustedKeys(rec));
      }
      this._rebuildIndexes();
      this._dirty = false;
      Zotero.debug(`[WatchFolder] TrackingStore.load: ok (files=${this._files.size} collections=${this._collections.size} tombstones=${this._tombstones.length})`);
    } catch (e) {
      Zotero.logError(`[WatchFolder] TrackingStore.load: ${e?.message ?? e} — starting empty`);
      this._files.clear();
      this._collections.clear();
      this._tombstones.length = 0;
      this._rebuildIndexes();
      this._dirty = false;
    }
  }

  /** Reload from disk, discarding any unsaved state. */
  async reload() {
    this._ensureInitialized();
    await this.load();
  }

  destroy() {
    // WP-B / B3: cancel any pending debounce timer so a stale save
    // doesn't fire after the store is gone. Reject any awaiters.
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (this._rejectPending) {
      try { this._rejectPending(new Error('TrackingStore destroyed')); } catch (_e) { /* ignore */ }
    }
    this._pendingSave = null;
    this._resolvePending = null;
    this._rejectPending = null;
    this._files.clear();
    this._collections.clear();
    this._tombstones.length = 0;
    this._byAttachmentKey.clear();
    this._byHash.clear();
    this._byAttachmentKeyAll.clear();
    this._tombstonesByHash.clear();
    this._tombstonesByAttachmentKey.clear();
    this._initialized = false;
    this._dirty = false;
  }
}

// ─── Module-level singleton ────────────────────────────────────────────

let _defaultStore = null;

/**
 * Get-or-create the default tracking store singleton.
 * @returns {TrackingStore}
 */
export function getTrackingStore() {
  if (!_defaultStore) _defaultStore = new TrackingStore();
  return _defaultStore;
}

/**
 * Initialize the default tracking store and return it.
 * @returns {Promise<TrackingStore>}
 */
export async function initTrackingStore() {
  const store = getTrackingStore();
  await store.init();
  return store;
}

/** Reset the singleton (test seam only). */
export function resetTrackingStore() {
  _defaultStore = null;
}
