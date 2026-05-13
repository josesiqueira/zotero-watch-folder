# Phase 2 Design — Collection ↔ Folder Mirroring

Optional bidirectional sync between a Zotero "mirror root" collection and a folder on disk. When enabled, the folder tree mirrors the collection tree and attachment files live in the matching folder. Only applies to items with **linked-file attachments**; stored copies are skipped because Zotero owns those paths.

---

## Features

### F2.1 — Collection → folder

| Zotero action | Disk action |
|---------------|-------------|
| Create collection under mirror root | Create matching folder (`IOUtils.makeDirectory` with `createAncestors`) |
| Rename collection | Rename folder |
| Move collection (change parent) | Move folder to new parent path |
| Delete collection | Delete or archive folder (configurable) |

Only collections under the configured `mirrorRootCollection` are synced. See `content/collectionSync.mjs:327 syncCollectionToFolder`.

### F2.2 — Item movement → file movement

| Zotero action | Disk action |
|---------------|-------------|
| Add linked-file item to collection | Move file to that collection's folder |
| Remove item from collection | Move appropriately |
| Item in multiple collections | File lives in primary collection's folder |

### F2.3 — Folder → collection (reverse direction)

| Disk action | Zotero action |
|-------------|---------------|
| Create new subfolder | Create matching collection |
| Rename folder | Rename collection |
| Move file between folders | Update item's collection membership |
| New file appears in subfolder | Import into the matching collection (Phase 1 import path) |

### F2.4 — Conflict resolution

If both sides change between reconciliation passes, the configured strategy applies. See `content/conflictResolver.mjs:9 ResolutionStrategy`:

- `zotero` — Zotero state wins, applied to disk.
- `disk` — disk state wins, applied to Zotero.
- `last` — most recent `timestamp` wins (default).
- `both` — keep both versions; affected item tagged `_sync-conflict`.
- `manual` — log only, tag for user review.

`KEEP_BOTH` and `MANUAL` tag the parent item via `_addConflictTag` so the user can filter on it.

---

## Sync algorithm

Implemented in `content/collectionSync.mjs`.

```
init()                       // load prefs, build watchers, lazy
└─ start()
   ├─ performFullSync()      // initial reconciliation
   │  ├─ ensure mirror dir exists
   │  ├─ for each collection under root:
   │  │    syncCollectionToFolder(c)        // create folder, write state
   │  ├─ for each collection:
   │  │    _syncCollectionItems(c)          // record item paths in syncState
   │  └─ syncState.markFullSync(); save()
   ├─ collectionWatcher.register()          // Zotero notifier side
   └─ folderWatcher.start()                 // filesystem poll side
```

Incremental sync (per event):

```
On Zotero change (collection or item):
  guard with _isSyncing + _pendingCollections / _pendingItems
  apply change to disk via pathMapper
  update syncState

On disk change (folderWatcher poll):
  guard with _isSyncing
  apply change to Zotero
  update syncState

Before applying any change:
  conflictResolver.detectConflict(zoteroState, diskState, lastSyncState)
    → if both moved past lastSync → run configured strategy
```

The `_isSyncing` flag and per-id pending sets are the "pause the other side while applying" mechanism. They prevent feedback loops where a change you just made on disk re-fires a Zotero notifier that tries to re-apply itself.

---

## Platform considerations

### Multi-collection items

Real symlinks aren't supported via `IOUtils` (no creation API), and Windows symlinks need elevated permissions. The plugin uses a **primary-only** strategy: the file lives in the first/primary collection's folder; other collection memberships exist only in Zotero. If you need cross-platform copies for multi-collection items, use the `KEEP_BOTH` conflict strategy.

### Path sanitization

Always use `PathUtils` for cross-platform joins. Sanitize folder names against the union of platform restrictions — `pathMapper.mjs:88 sanitizeFolderName`:

```javascript
sanitizeFolderName(name) {
  if (!name) return '_unnamed';
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[\s_]+/g, ' ')
    .trim();
  // (leading-dot and length handling follow)
}
```

---

## Data structures

### Sync state (`content/syncState.mjs`)

```javascript
{
  version: 1,
  lastFullSync: number,                 // timestamp of last reconciliation
  collections: Map<collectionID, {
    name: string,
    parentID: number | null,
    folderPath: string,
    lastSynced: number
  }>,
  items: Map<itemID, {
    collectionIDs: number[],
    filePath: string,
    primaryCollectionID: number,
    lastSynced: number
  }>
}
```

Persisted as JSON at `<Zotero.DataDirectory>/zotero-watch-folder-sync-state.json`. `lastSynced` per entity is what the conflict detector compares against to decide whether the other side has also moved.

### Conflict log

`ConflictResolver` keeps an in-memory log of the last 100 conflicts (`_conflictLog`), with type, timestamps, path, collectionID, itemID. Available via `getConflictLog()`.

---

## Error handling

| Error | Handling |
|-------|----------|
| Permission denied on disk | Log, notify user, skip operation |
| Path too long | Truncate, warn |
| Sync conflict | Apply configured strategy; tag if `both` / `manual` |
| Folder vanished | Re-sync or remove from state |
| Mirror mount unavailable | Pause sync, retry on next watcher tick |

---

## Manual testing checklist

### F2.1
- [ ] Creating a collection under mirror root creates the folder
- [ ] Renaming a collection renames the folder
- [ ] Moving a collection moves the folder
- [ ] Deleting a collection cleans up the folder (per setting)
- [ ] Nested collections produce nested folders

### F2.2
- [ ] Adding a linked-file item to a collection moves the file
- [ ] Stored-copy attachments are skipped (no movement attempted)
- [ ] Multi-collection items end up in the primary collection's folder

### F2.3
- [ ] Creating a subfolder creates a collection
- [ ] Moving a file between folders updates collection membership
- [ ] New file dropped into a subfolder imports into that collection (Phase 1 flow)

### F2.4
- [ ] Simultaneous Zotero+disk change triggers conflict detection
- [ ] `last`, `zotero`, `disk`, `both`, `manual` each behave per spec
- [ ] `_sync-conflict` tag applied for `both` / `manual`
