# Phase 2 Design — Collection ↔ Folder Mirroring

Design reference for Phase 2: feature behavior matrices for F2.1–F2.4, the sync algorithm (initialization, reconciliation, conflict detection), platform considerations (symlinks vs copies, path sanitization), and persisted sync-state schema.

### Critical Requirement: Linked Files

**Phase 2 ONLY works with linked files**, not stored copies:
- Stored copies live in Zotero's internal storage (`<profile>/storage/<key>/`)
- Moving stored copies breaks Zotero's management
- Linked files can be freely moved on disk

---

## Feature Behavior

### F2.1 — Collection → Folder Sync (Zotero to Disk)

**Description:** Mirror Zotero collection structure as folders on disk.

**Dependencies:** Phase 1 complete

**Behavior:**

| Zotero Action | Disk Action |
|---------------|-------------|
| Create collection under mirror root | Create corresponding folder |
| Rename collection | Rename folder |
| Move collection (change parent) | Move folder to new parent |
| Delete collection | Delete/archive folder |

**Scope:** Only collections under a designated "Mirror Root Collection" are synced.

**Acceptance:**
- [ ] Folder created within 5 seconds of collection creation
- [ ] Nested hierarchies correctly represented
- [ ] Collections outside mirror root ignored

### F2.2 — Item Movement Sync (Zotero to Disk)

**Description:** When items move between collections, move their files.

**Dependencies:** F2.1 (needs folder structure to exist)

**Behavior:**

| Zotero Action | Disk Action |
|---------------|-------------|
| Add item to collection | Move file to collection's folder |
| Remove item from collection | Move file appropriately |
| Item in multiple collections | Primary folder has file; others get copies |

**Acceptance:**
- [ ] File moved when item added to collection
- [ ] Attachment path updated correctly

### F2.3 — Folder → Collection Sync (Disk to Zotero)

**Description:** Detect disk changes and reflect in Zotero.

**Dependencies:** F2.2 (bidirectional sync builds on unidirectional)

**Behavior:**

| Disk Action | Zotero Action |
|-------------|---------------|
| Create new subfolder | Create corresponding collection |
| Rename folder | Rename collection |
| Move file between folders | Update item's collection membership |
| Add new file to subfolder | Import to correct collection |

**Acceptance:**
- [ ] Collection created for new folder (if bidirectional enabled)
- [ ] File movements update collections

### F2.4 — Conflict Resolution

**Description:** Handle simultaneous changes on both sides.

**Dependencies:** F2.1, F2.2, F2.3 (needs all sync paths working)

**Resolution Strategies:**
- **Last-write-wins**: Most recent change wins
- **Both-versions**: Keep both, tag with `_sync-conflict`
- **Manual**: Log for user review

**Acceptance:**
- [ ] Conflicts detected when both sides change
- [ ] Items with conflicts tagged appropriately

---

## Sync Algorithm

### Overview

```
1. INITIALIZATION
   - Load sync state from disk
   - Build collection tree for mirror root
   - Build folder tree for mirror directory
   - Initialize path mapper

2. FULL RECONCILIATION (on first sync)
   - Match collections to folders
   - Create missing folders/collections
   - Record state

3. INCREMENTAL SYNC (on events)
   On Zotero change:
     - Pause disk watcher
     - Apply change to disk
     - Update sync state
     - Resume disk watcher

   On disk change:
     - Pause Notifier handling
     - Apply change to Zotero
     - Update sync state
     - Resume Notifier

4. CONFLICT DETECTION
   Before applying change:
     - Check if other side also changed
     - If both changed: CONFLICT
     - Apply resolution strategy
```

The "pause one side while applying changes from the other" pattern is essential to prevent feedback loops where the change you just made on disk re-fires a Zotero notifier event that tries to re-apply itself.

---

## Platform Considerations

### Symlinks vs Copies

| Platform | Multi-Collection Strategy |
|----------|---------------------------|
| Linux | Could use symlinks (but IOUtils doesn't support creation) |
| macOS | Could use symlinks (same limitation) |
| Windows | No symlink support |

**Recommendation:** Use file copies for cross-platform compatibility, or "primary-only" strategy where file exists only in primary collection's folder.

### Path Handling

Always use `PathUtils` for cross-platform path construction. Sanitize folder names against the union of all platforms' illegal characters:

```javascript
// Always use PathUtils for cross-platform
const path = PathUtils.join(baseDir, folder, file);

// Sanitize for all platforms
function sanitizeFolderName(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/^\.+/, '_')
    .replace(/\.+$/, '')
    .trim()
    .substring(0, 200);
}
```

Also from the simpler in-engine variant used by `PathMapper`:

```javascript
sanitizeFolderName(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 255);
}
```

---

## Conflict Resolution Strategies

Conflicts are detected when the sync engine sees changes on *both* sides between two reconciliation passes. The user can configure which strategy to apply:

- **Last-write-wins** — Compare timestamps; the most recent change wins. Simple but can silently overwrite work.
- **Both-versions** — Keep both. Tag the affected items with `_sync-conflict` so the user can resolve manually.
- **Manual** — Apply nothing. Log the conflict and surface it in a notification for user review.

Default is "Both-versions" — it is the most conservative and never destroys data.

### Error Handling

| Error | Handling |
|-------|----------|
| Permission denied | Log, notify user, skip |
| Path too long | Truncate name, warn |
| Sync conflict | Apply configured strategy |
| Missing folder | Recreate or clean up state |
| Network mount unavailable | Pause sync, retry later |

---

## Data Structures

### Sync State

```javascript
{
  version: 1,
  lastFullSync: timestamp,
  collections: {
    [collectionID]: {
      name: string,
      parentID: number,
      folderPath: string,
      lastSynced: timestamp
    }
  },
  items: {
    [itemID]: {
      collectionIDs: number[],
      filePath: string,
      primaryCollectionID: number,
      lastSynced: timestamp
    }
  }
}
```

`lastFullSync` is the timestamp of the last successful reconciliation. `lastSynced` per-entity is the timestamp of the last change applied; it is what conflict detection compares against to decide whether the "other side" has also moved since.

---

## Testing Checklist

### F2.1
- [ ] Creating collection creates folder
- [ ] Renaming collection renames folder
- [ ] Moving collection moves folder
- [ ] Deleting collection handles folder correctly
- [ ] Nested collections create nested folders

### F2.2
- [ ] Adding item to collection moves file
- [ ] Removing item moves file appropriately
- [ ] Multi-collection items handled correctly

### F2.3
- [ ] Creating folder creates collection
- [ ] Moving file updates collection membership
- [ ] New file in folder imports correctly

### F2.4
- [ ] Conflicts detected correctly
- [ ] Resolution strategies work
- [ ] Conflict tags applied
