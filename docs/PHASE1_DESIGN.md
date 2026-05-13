# Phase 1 Design — Core Watch Folder

Phase 1 is the always-on watcher: detect new files in a configured folder, import them into Zotero, retrieve metadata, optionally rename. Plus a one-shot first-run flow for files already present when the user enables the plugin.

---

## Features

### F1.1 — Watch folder configuration

User configures: source folder path, poll interval, target collection, file types, import mode (stored/linked), and post-import action through `content/preferences.xhtml`.

- Preferences live under `extensions.zotero.watchFolder.*` (see `content/utils.mjs:14 getPref`).
- Folder picker uses Zotero's `FilePicker` wrapper.
- Target collection is auto-created on first import if missing (`utils.mjs:getOrCreateTargetCollection`).
- Toggling enabled starts/stops the watcher (`content/index.mjs:onStartup`).

### F1.2 — Auto-import

`watchFolder.mjs._scan()` runs on a `setTimeout`-driven loop:

1. `scanFolderRecursive(watchPath)` walks the watch path and returns matching files (`content/fileScanner.mjs:91`).
2. Already-tracked paths (by `trackingStore`) and in-flight paths are skipped.
3. For each new file, derive the target collection from the subfolder it sits in (see "Recursive subfolder → collection" below).
4. `_processNewFile(path, collection)`:
   - `_waitForFileStable` — checks size doesn't change between two stats.
   - `getFileHash` — SHA-256 of first 1 MB; if the hash matches an existing tracked record, treat as duplicate and skip.
   - Optional pre-import duplicate check (`duplicateDetector.checkForDuplicate`) when enabled.
   - `importFile(path, { collectionName })` returns the new Zotero item.
   - For `importMode === 'stored'`, runs `handlePostImportAction` (delete / move-to-imported / leave).
   - Tracking record persisted via `trackingStore.add` + `.save()`.
   - Smart rules engine runs against the item (`smartRules.processItemWithRules`).
   - Item is queued on the `metadataRetriever`; on success, optional auto-rename runs.

### Recursive subfolder → collection mapping

`scanFolderRecursive` walks subdirectories (skipping `imported/`). For each found file, `_scan` computes the path relative to the watch root and appends each path segment to the configured target collection:

```
watchPath:    /home/user/Inbox-Mirror
file:         /home/user/Inbox-Mirror/Topics/RE/paper.pdf
target:       Inbox/Topics/RE   (created via utils.mjs:getOrCreateCollectionPath)
```

`getOrCreateCollectionPath` walks/creates each segment under the user library, using `Zotero.Collections.getByParent` for nested lookups (`utils.mjs:148`).

### F1.3 — Metadata retrieval

After import, the item is queued in `metadataRetriever` which calls `Zotero.RecognizeDocument.recognizeItems([item])`. Concurrency is capped and requests are spaced. On failure the parent item is tagged `_needs-review`.

### F1.4 — Auto-rename

After successful metadata retrieval, the post-completion callback in `watchFolder._processNewFile` calls `fileRenamer.renameAttachment(item)`. The rename pattern is templated, defaulting to `{firstCreator} - {year} - {title}`.

Template variables: `{firstCreator}`, `{creators}`, `{year}`, `{title}`, `{shortTitle}`, `{DOI}`. Filename is sanitized via `utils.sanitizeFilename` (illegal chars stripped, length capped by `maxFilenameLength`).

### F1.5 — First-run handling (V2 simple flow)

`content/firstRunHandler.mjs` runs once from `onMainWindowLoad` when the plugin is enabled and a `sourcePath` is set. It is a **one-way scan-and-import flow** — there is no bidirectional reconciliation, no inventory, no merge planning.

Flow (`firstRunHandler.mjs:195 handleFirstRun`):

1. `checkFirstRun()` — returns `isFirstRun: true` if no `lastWatchedPath` pref and tracking store is empty, OR if `sourcePath` differs from the saved `lastWatchedPath`.
2. `scanFolder(sourcePath)` — top-level scan (non-recursive) to count existing files.
3. If 0 files: mark complete and return.
4. Otherwise prompt the user with three choices: **Import All**, **Skip**, **Cancel**.
   - Import All → `importExistingFiles(window, files)` runs `importBatch` with a `Zotero.ProgressWindow`.
   - Skip → mark complete without importing.
   - Cancel → leave state alone; prompt will reappear next session.
5. Mark complete by writing `sourcePath` to the `lastWatchedPath` pref.

`resetFirstRunState()` clears the pref so the next startup re-triggers. `rescanExistingFiles(window)` is the user-facing "re-scan" trigger (resets + runs `handleFirstRun`).

---

## Acceptance criteria

| Feature | Criterion |
|---------|-----------|
| F1.1 | User can pick a folder via FilePicker; settings persist across restarts |
| F1.2 | New files detected within `pollInterval + 2s`; already-imported files not re-imported |
| F1.2 | Files placed in correct nested collection per subfolder |
| F1.3 | Metadata retrieval auto-triggers; failures add `_needs-review` tag |
| F1.4 | Files renamed per pattern after successful metadata retrieval |
| F1.5 | First-run prompt shows correct file count; Import/Skip/Cancel each behave correctly |

---

## Error handling

| Error | Response |
|-------|----------|
| Watch folder missing | Log; `startWatching` aborts; user notified via preferences UI |
| File permission denied | Log; skip file; will retry on next scan |
| File still being written | Stability check fails; skip; retry on next scan |
| Import throws | Logged via `Zotero.logError`; processing set cleared in `finally` |
| Metadata retrieval fails | Tag parent item `_needs-review`; tracking record marked `metadataRetrieved: false` |
| Rename fails | Keep original name; logged |
| Duplicate detected (hash) | Skip; add tracking record marked `isDuplicate: true` to prevent re-check |
| Duplicate detected (DOI/title) with action `skip` | Skip; track as above |
| Duplicate detected with action `import` | Import anyway (so user can compare) |

---

## Data structures

### TrackingRecord (`content/trackingStore.mjs:27`)

```typescript
interface TrackingRecord {
  path: string;             // original file path
  hash: string;             // SHA-256 of first 1 MB
  mtime: number;            // last-modified timestamp
  size: number;             // file size in bytes
  itemID: number;           // Zotero item ID after import
  importDate: string;       // ISO timestamp
  metadataRetrieved: boolean;
  renamed: boolean;
}
```

Persisted as JSON at `<Zotero.DataDirectory>/zotero-watch-folder-tracking.json`. LRU-capped at 5000 entries; oldest evicted on insert.

### First-run state

Single preference: `extensions.zotero.watchFolder.lastWatchedPath`. Presence + match to current `sourcePath` indicates first run already happened.

---

## API usage summary

| Operation | API |
|-----------|-----|
| Check path exists | `await IOUtils.exists(path)` |
| Stat file | `await IOUtils.stat(path)` → `{ size, lastModified, type }` |
| List directory | `await IOUtils.getChildren(path)` |
| Read first 1 MB | `await IOUtils.read(path, { maxBytes: 1048576 })` |
| Hash | `await crypto.subtle.digest('SHA-256', data)` |
| Import stored copy | `await Zotero.Attachments.importFromFile({ file, parentItemID, collections })` |
| Import linked file | `await Zotero.Attachments.linkFromFile({ ... })` |
| Trigger metadata | `await Zotero.RecognizeDocument.recognizeItems([item])` |
| Rename attachment | `await attachment.renameAttachmentFile(newName)` |
| Get/set prefs | `Zotero.Prefs.get/set(key, value)` |
| Observe changes | `Zotero.Notifier.registerObserver(observer, ['item'])` |
| Show progress | `new Zotero.ProgressWindow()` with `ItemProgress` |

---

## Manual testing checklist

- [ ] Configure folder via preferences; toggle on/off
- [ ] Single PDF imports into the correct collection
- [ ] Recursive subfolders map to nested collections (e.g. `Inbox/Topics/RE`)
- [ ] Already-imported file is not re-imported (path or hash match)
- [ ] Cloud-synced folder (Dropbox/pCloud) imports work — partial writes don't import
- [ ] Metadata retrieval runs; failed items receive `_needs-review`
- [ ] Auto-rename applies pattern; long titles truncated
- [ ] First-run prompt appears with correct count
- [ ] First-run "Skip" marks complete without importing
- [ ] First-run "Cancel" leaves state untouched (prompt returns next session)
- [ ] Trash sync: move an imported item to Zotero's trash → dialog asks whether to delete the source file. "Don't ask again" persists the choice as `diskDeleteOnTrash = always` or `never`.
- [ ] Disable plugin → timers and observers released (no leftover polling)
