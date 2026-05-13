# Phase 1 Design — Core Watch Folder (MVP)

Design reference for Phase 1: acceptance criteria for features F1.1–F1.5, the error-handling response matrix, the persisted tracking record schema, and the manual testing checklist.

---

## Acceptance Criteria

### F1.1 — Watch Folder Configuration

**Description:** User configures a source folder path, poll interval, target collection, file types to watch, and import mode through a preference pane.

**Dependencies:** Infrastructure only (bootstrap.js, prefs.js, preferences.xhtml)

**User-Facing Elements:**
- Preference pane accessible via Edit > Preferences > Watch Folder
- Source folder path with "Browse" button using Zotero's FilePicker
- Poll interval slider/input (1-60 seconds, default 5)
- Target collection dropdown (creates "Inbox" if not exists)
- File types text field (default: "pdf", optional: "pdf,epub,djvu")
- Import mode dropdown: "Stored Copy" or "Linked File"
- Enable/disable toggle checkbox

**Technical Requirements:**
- Store all settings via `Zotero.Prefs` with prefix `extensions.zotero.watchFolder.*`
- Validate folder path exists on enable
- Create target collection if it does not exist
- Re-initialize watcher when settings change

**Acceptance:**
- [ ] User can select a folder via FilePicker
- [ ] User can set poll interval (1-60 seconds)
- [ ] Settings persist across Zotero restarts

### F1.2 — Auto-Import

**Description:** When a new file is detected in the watch folder, wait for it to stabilize, then import it into Zotero.

**Dependencies:** F1.1 (needs configuration values)

**Behavior:**
1. Polling loop detects new file (not in `knownFiles` cache or `mtime` changed)
2. Wait 2 seconds for file write completion (cloud sync, network mount)
3. Verify file size stability (check twice with 1-second delay)
4. Import file using `Zotero.Attachments.importFromFile()` or `linkFromFile()`
5. Place item in configured target collection
6. Add file to `knownFiles` tracking cache
7. Persist tracking data across restarts

**Post-Import Actions (configurable):**
- "Leave in place" - file stays in watch folder
- "Delete" - remove source file after successful import
- "Move to subfolder" - move to `watch-folder/imported/`

**Acceptance:**
- [ ] New files detected within poll interval + 2 seconds
- [ ] Files imported to correct collection
- [ ] Already-imported files not re-imported

### F1.3 — Auto-Retrieve Metadata

**Description:** After import, automatically trigger Zotero's built-in metadata retrieval.

**Dependencies:** F1.2 (needs imported attachment items)

**Behavior:**
1. After import completes, check if item can be recognized
2. Queue item for recognition via `Zotero.RecognizeDocument.recognizeItems([item])`
3. Throttle: max 2 concurrent metadata lookups, 1-2 second delay between requests
4. On success: item gets title, authors, year, DOI populated
5. On failure: add tag `_needs-review` so user can filter and manually fix

**Acceptance:**
- [ ] Metadata retrieval triggers automatically
- [ ] Failed retrieval adds `_needs-review` tag

### F1.4 — Auto-Rename Files

**Description:** After metadata retrieval succeeds, rename the attachment file based on a configurable pattern.

**Dependencies:** F1.3 (needs metadata for filename generation)

**Behavior:**
1. Listen for metadata retrieval completion
2. Build filename from template: default `{firstCreator} - {year} - {title}`
3. Sanitize filename (remove illegal characters, truncate)
4. Rename via `Zotero.Attachments.renameAttachmentFile()`

**Template Variables:**
- `{firstCreator}` - First author's last name
- `{creators}` - All authors (comma-separated)
- `{year}` - Publication year
- `{title}` - Full title
- `{shortTitle}` - First 50 chars of title
- `{DOI}` - DOI value

**Acceptance:**
- [ ] Files renamed after metadata retrieval
- [ ] Rename pattern configurable and works

### F1.5 — Existing Files on First Run

**Description:** On first enable or when watch folder path changes, handle existing files.

**Dependencies:** F1.2 (uses import functionality)

**Can Run In Parallel With:** F1.3, F1.4 (independent functionality)

**Behavior:**
1. Detect "first run" condition: no tracking data exists OR path changed
2. Scan folder for all files matching configured extensions
3. Prompt user: "Found X files in watch folder. Import all?"
4. Process sequentially with progress indicator
5. Show completion summary

**Acceptance:**
- [ ] First run detected correctly
- [ ] User prompted with file count
- [ ] Batch import with progress

---

## Error Handling Strategy

| Error Type | Response |
|------------|----------|
| Folder not found | Disable watching, notify user |
| File permission denied | Skip file, log, retry next scan |
| File locked | Defer import, retry next scan |
| Import failed | Add to retry queue (max 3 attempts) |
| Metadata retrieval failed | Tag with `_needs-review` |
| Rename failed | Keep original name, log |

Additional error semantics inherited from the overall design:
- File permission errors → log and skip, notify user
- Network errors during metadata retrieval → queue for retry
- Corrupt PDFs → import but tag with `_import-error`
- Watch folder path doesn't exist → disable watching, notify user

---

## Data Structures

### TrackingRecord

```typescript
interface TrackingRecord {
  path: string;
  hash: string;
  mtime: number;
  size: number;
  itemID: number;
  importDate: string;
  metadataRetrieved: boolean;
  renamed: boolean;
}
```

The hash is computed over the first 1 MB of the file (MD5) so a replaced file with a different version is detected as new. Records are kept in a bounded LRU cache (cap ~5000) and persisted via `IOUtils.writeJSON()` / `IOUtils.readJSON()` so state survives restart.

---

## API Usage Summary

| Operation | API |
|-----------|-----|
| Check file exists | `await IOUtils.exists(path)` |
| Get file info | `await IOUtils.stat(path)` |
| List directory | `await IOUtils.getChildren(path)` |
| Import stored copy | `await Zotero.Attachments.importFromFile({...})` |
| Import linked file | `await Zotero.Attachments.linkFromFile({...})` |
| Trigger metadata | `await Zotero.RecognizeDocument.recognizeItems([item])` |
| Rename file | `await attachment.renameAttachmentFile(newName)` |
| Get/set preferences | `Zotero.Prefs.get/set(key, value)` |
| Register observer | `Zotero.Notifier.registerObserver(...)` |

---

## Testing Checklist

- [ ] Configure watch folder via preferences
- [ ] Enable/disable toggle works
- [ ] Single PDF imports correctly
- [ ] Multiple PDFs import sequentially
- [ ] Metadata retrieval triggers automatically
- [ ] Files renamed after metadata retrieval
- [ ] Cloud-synced folders work (file stability check)
- [ ] First run detects existing files
- [ ] Plugin enable/disable cycle clean
