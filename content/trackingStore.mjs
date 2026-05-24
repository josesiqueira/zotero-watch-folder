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
 * @property {string|null} lastSyncedHash - SHA-256 of first HASH_CHUNK_SIZE bytes.
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
    this.dataFile = null;
    this._dirty = false;
    this._initialized = false;
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
    for (const rec of this._files.values()) {
      if (rec.zoteroAttachmentKey) this._byAttachmentKey.set(rec.zoteroAttachmentKey, rec);
      // Detached / suppressed / conflict-blocked records are intentionally
      // OMITTED from _byHash so the hash-dedup path in watchFolder can't
      // re-link a fresh import to a Zotero item the user explicitly
      // detached or that's in a frozen state. attachmentKey lookups still
      // see them (the user may want to resolve via suppression UX).
      if (rec.lastSyncedHash && _isHashIndexable(rec.state)) {
        this._byHash.set(rec.lastSyncedHash, rec);
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
   * Persist to disk if dirty. No-op if nothing changed since last save.
   */
  async save() {
    this._ensureInitialized();
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
   * Persist unconditionally (used by shutdown paths where we'd rather over-
   * write the file than risk losing a recently-touched record that didn't
   * flip the dirty flag due to a bug).
   */
  async flush() {
    this._dirty = true;
    await this.save();
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
      for (const rec of (data.files ?? [])) {
        if (rec?.localPath && rec.type === 'file') this._files.set(rec.localPath, rec);
      }
      for (const rec of (data.collections ?? [])) {
        if (rec?.zoteroCollectionKey && rec.type === 'collection') {
          this._collections.set(rec.zoteroCollectionKey, rec);
        }
      }
      for (const rec of (data.tombstones ?? [])) {
        if (rec?.type === 'tombstone') this._tombstones.push(rec);
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
    this._files.clear();
    this._collections.clear();
    this._tombstones.length = 0;
    this._byAttachmentKey.clear();
    this._byHash.clear();
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
