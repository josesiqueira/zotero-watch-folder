# Codebase Overview — Zotero Watch Folder

Long-form companion to `CLAUDE.md`. Written for a teammate who has never seen this code. Every non-trivial claim carries a `file:line` reference so you can navigate. Synthesised from three independent deep-dive audits.

---

## 1. What this plugin does

A Zotero "bootstrapped" plugin (no MV3 background) that polls a folder on disk, imports new PDFs into a target collection, dedupes them with multiple strategies, and optionally moves/renames the source files. Targets Zotero 7/8/9 (`manifest.json` `strict_min_version: 6.999`).

- Plugin ID: `watch-folder@zotero-plugin.org`
- Current version: `1.2.3` (`manifest.json:4` and `package.json:3` — in sync)
- Bundle entry: `content/index.mjs` → esbuild IIFE → `dist/content/scripts/watchFolder.js`
- Boot entry: `bootstrap.js`

The bundle exposes **only** `Zotero.WatchFolder.hooks` to the running Zotero. The `WatchFolderService` instance is module-private — inspect live state via DB queries, prefs, and logs (per `CLAUDE.md` MCP section).

---

## 2. Repo layout

| Path | Role |
|---|---|
| `bootstrap.js` | Zotero bootstrapped-addon entry. Loads the IIFE subscript and calls `Zotero.WatchFolder.hooks.*`. |
| `bootstrap-old.js`, `bootstrap-simple.js` | **Legacy, ignore.** Not referenced from `manifest.json`. |
| `content/index.mjs` | Bundle entry. Only exports `hooks`. |
| `content/watchFolder.mjs` | `WatchFolderService` — poll loop, import, post-import, trash/move handlers, backfill. ~1250 lines. |
| `content/utils.mjs` | Hashing, filename sanitization, collection-path resolution. |
| `content/fileScanner.mjs` | Recursive disk walk. Skips `imported/`. |
| `content/fileImporter.mjs` | Import + post-import action (move/delete/leave). |
| `content/fileRenamer.mjs` | Template-based attachment renaming. |
| `content/duplicateDetector.mjs` | DOI/ISBN/title/hash dedup pipeline + Extra-field hash stamp. |
| `content/trackingStore.mjs` | LRU `Map`-backed JSON persistence of imported files. |
| `content/metadataRetriever.mjs` | Singleton queue around `Zotero.RecognizeDocument`. |
| `content/collectionSync.mjs` | Phase 2 bidirectional collection↔folder mirror. Disabled by default. |
| `content/bulkOperations.mjs` | Phase 3 bulk ops. Console-only, no UI hook. |
| `content/preferences.{xhtml,js}` | Prefs UI. Copied verbatim, not bundled. |
| `prefs.js` | 30 default preference keys (31 counting `lastWatchedPath`) under `extensions.zotero.watchFolder.*`. |
| `dist/content/scripts/watchFolder.js` | esbuild IIFE bundle output — what Zotero actually runs. |
| `build/{bundle,build,package,release-upload}.mjs` | Release pipeline. |
| `test/unit/` | Vitest, ~375 tests. `test/setup/geckoMocks.js` stubs Gecko globals. |
| `test/mcp/` | MCP runbooks against a live Zotero. Entry: `test/mcp/INDEX.md`. |
| `docs/` | Design notes — this file is the overview; existing files: `ARCHITECTURE.md`, `MODULE_DEPENDENCIES.md`, `PHASE1_DESIGN.md`, `PHASE2_DESIGN.md`, `PHASE3_AND_PERFORMANCE.md`. |
| `TEST_PLAN.md`, `updates_13_05_26.md`, `TODO.md` | Manual checklist + open issues + roadmap. |

---

## 3. Boot & lifecycle

`bootstrap.js`:

- **`startup({id, version, resourceURI, rootURI}, reason)`** at `bootstrap.js:10`
  1. Registers chrome aliases (`content`, `locale`) **before** the first `await` (`bootstrap.js:13-20`) so `chrome://zotero-watch-folder/...` URLs resolve.
  2. Awaits `Zotero.initializationPromise` (`bootstrap.js:22`).
  3. Calls `_initDefaultPrefs()` (`bootstrap.js:26`, defined at `:84-127`) — sets defaults for all 31 prefs on the **default branch** via `Services.prefs.getDefaultBranch(...)`. This is the workaround for `prefs.js` not being auto-loaded from an XPI root.
  4. Loads the bundle via `Services.scriptloader.loadSubScript(rootURI + "content/scripts/watchFolder.js", ctx)` (`bootstrap.js:34-37`). The IIFE assigns to `Zotero.WatchFolder`.
  5. **Stamps `Zotero.WatchFolder.hooks._rootURI = rootURI` BEFORE calling `onStartup()`** (`bootstrap.js:49-50`). Load-bearing — prefs-pane registration in `index.mjs` reads `this._rootURI`.
- `onMainWindowLoad/Unload` (`bootstrap.js:53-63`) forward to hooks.
- `shutdown` (`bootstrap.js:65-76`) short-circuits on `APP_SHUTDOWN`, otherwise calls `onShutdown()` then `chromeHandle.destruct()`.
- `install` / `uninstall` are no-ops (`bootstrap.js:8`, `:78`).

`content/index.mjs` exports a `hooks` object only:

- **`hooks.onStartup()`** (`index.mjs:24-54`) — registers prefs pane via `Zotero.PreferencePanes.register({...})` using `rootURI`; `initMetadataRetriever()`; constructs the singleton `WatchFolderService` via `getWatchFolderService()`; wires retriever into service; if `enabled` pref true, `startWatching()`.
- **`hooks.onMainWindowLoad(window)`** (`index.mjs:56-74`) — `MozXULElement.insertFTLIfNeeded("zotero-watch-folder.ftl")`, conditionally runs `handleFirstRun(window)` (one-shot `firstRunHandled` flag).
- **`hooks.onShutdown()`** (`index.mjs:80-115`) — `stopWatching()` → `destroy()`, then `shutdownMetadataRetriever()`, then idempotent `shutdownDuplicateDetector()` and `shutdownCollectionSync()`.

`WatchFolderService` is constructed lazily by `getWatchFolderService()` (`watchFolder.mjs:1219-1224`), never at module load.

---

## 4. The poll loop

`WatchFolderService` lifecycle:

- **`init()`** (`watchFolder.mjs:72-115`) — creates `TrackingStore`, registers `Zotero.Notifier` observer on `'item'` (`:86-94`), seeds `_currentInterval` from `pollInterval` pref (`:97`), kicks off **hash-stamp backfill** fire-and-forget (`:106-108`, errors debug-logged only — sharp edge: silent partial-backfill).
- **`startWatching()`** (`watchFolder.mjs:122-162`) — verifies `sourcePath` via `IOUtils.exists`, sets `_isWatching=true`, runs immediate `_scan()` (`:158`), then `_scheduleNextScan()`.
- **`_scheduleNextScan()`** (`watchFolder.mjs:224-233`) — chained `setTimeout` from each completed scan. **Not `setInterval`** — prevents pile-up if a scan runs long.
- **`stopWatching()`** (`:168-181`) clears timer; **`destroy()`** (`:188-217`) tears down notifier, persists tracking, clears `_processingFiles` and `_metadataQueue`.

### Reentrancy — two guards, both required

1. **`_scanInProgress`** boolean (`watchFolder.mjs:31`, gated at `:242-245`, set at `:247`, cleared in `finally` at `:348`) — prevents two `_scan()` invocations from interleaving.
2. **`_processingFiles: Set<string>`** (`watchFolder.mjs:46`) — per-file lock. Added at `_processNewFile:361`, removed in `finally` at `:539`. Checked at `_scan:277-279`. **The only per-file reentrancy guard.** `CLAUDE.md` explicitly warns against bypassing it.

### Adaptive polling

After 10 consecutive empty scans, interval ramps ×1.2 per scan, capped at 2× base (`watchFolder.mjs:330-341`). Reset to base on any file find at `:321-322`. The `adaptivePolling` pref exists but isn't read in `watchFolder.mjs` — the behaviour is hard-coded here.

---

## 5. Import flow

`_scan()` (`watchFolder.mjs:240-350`) drives one cycle:

1. **`scanFolderRecursive(watchPath)`** (`fileScanner.mjs:91-146`) — walks via `IOUtils.getChildren` + `IOUtils.stat`, depth-capped at 10. **Critical**: skips any directory literally named `imported` (`fileScanner.mjs:119-122`) so post-import-`move`d files don't get re-processed. Extension filter via `isAllowedFileType` (`utils.mjs:32-41`) reading `fileTypes` pref (default `pdf`).
2. **`_handleExternalDeletions(diskPaths, files)`** runs **before** the new-file pass (`watchFolder.mjs:266`), so move-detection can claim candidate paths (§7).
3. For each scanned file: skip if `_processingFiles.has(path)` or `_trackingStore.hasPath(path)`; otherwise compute **target collection** from the relative subfolder path under `sourcePath` (`:290-311`), slash-joined like `Inbox/Research/AI`.
4. **`_processNewFile(filePath, targetCollection)`** — the spine, lines 359-541:
   - **Step 1** `_waitForFileStable(filePath, 3)` (`:551-589`) polls `IOUtils.stat(path).size` up to 3× with 1 s gaps; "stable" = two equal sizes. Final fallback at `:582-583`: size > 0 after max attempts.
   - **Step 2** Hash-based pre-check (`:373-389`): `getFileHash` (`utils.mjs:81-94`) SHA-256s the first 1 MB. If `_trackingStore.findByHash(hash)` matches, record this new path as `isDuplicate:true` and return.
   - **Step 2b** Full `checkForDuplicate({}, filePath)` (`:391-423`) — out-of-scope to import flow itself, see §6.
   - **Step 3** `importFile(filePath, { collectionName: targetCollection })` (`fileImporter.mjs:19-77`). Resolves/creates collection (single-segment via `getOrCreateTargetCollection`, `utils.mjs:111-140`; slash-paths via `getOrCreateCollectionPath`, `utils.mjs:148-196`). Branches on `importMode`: `'linked'` → `Zotero.Attachments.linkFromFile` (`fileImporter.mjs:51-54`); `'stored'` (default) → `Zotero.Attachments.importFromFile` (`:58-62`).
   - **Step 3b** Post-import action (`watchFolder.mjs:436-446`) **only** for `importMode==='stored'`. See §6.
   - **Step 4** Tracking record (`:452-464`) — `path`, `hash`, `itemID`, `importedAt`, `postImportAction`, **`expectedOnDisk = postImportResult.finalPath !== null`**. The `'delete'` action sets this to `false`, which gates external-deletion sync (§7).
   - **Step 4a** Stamp `watchfolder-hash:<sha256>` into the parent item's Extra field via `getDuplicateDetector().storeContentHash(item, finalPath)` (`:470-477`). Non-fatal on error. This is the tracking-wipe survival mechanism (§6).
   - **Step 4b** `processItemWithRules(item, {filename, filePath})` (`:480-488`).
   - **Step 5** If `autoRetrieveMetadata` and retriever is wired, `_metadataRetriever.queueItem(itemID, callback)` (`:491-525`). Callback updates tracking, then if `autoRename` is on, calls `renameAttachment(attachmentItem)` (`fileRenamer.mjs:113-169`). Template default `{firstCreator} - {year} - {title}`, sanitized via `utils.mjs:50-73` (max 150 chars, illegal-char regex `[<>:"/\\|?*\x00-\x1f]`).
   - `finally` at `:537-540` removes path from `_processingFiles`.

### Post-import actions — `fileImporter.mjs:87-142`

Reads `postImportAction` pref if not passed in.

| Action | Behaviour | `finalPath` | Resulting `expectedOnDisk` |
|---|---|---|---|
| `'leave'` (default) | No-op | `filePath` | `true` |
| `'delete'` | `IOUtils.remove(filePath)` | `null` | **`false`** |
| `'move'` | Move to `<watchPath>/imported/<relative-subdir>/<filename>` with `IOUtils.makeDirectory({createAncestors:true})` | new path | `true` |

Linked-mode imports **bypass** `handlePostImportAction` entirely (`watchFolder.mjs:439-446`) — source file is the only copy, can't be moved/deleted. Fallback `{action:'leave', finalPath:filePath}` at `:438` records the original path.

---

## 6. Deduplication, hashing, tracking

### 6.1 Hashing — the chunk-size invariant

**One primitive, two physical copies. They MUST stay byte-identical.**

Primitive: SHA-256 over the **first 1 MB** of the file, hex-encoded.

- `content/utils.mjs:81-94` — `getFileHash(filePath)`. `CHUNK_SIZE = 1024 * 1024` at line **83**, `IOUtils.read(filePath, { maxBytes: CHUNK_SIZE })` at 85, `crypto.subtle.digest('SHA-256', data)`. Returns hex or `null`.
- `content/duplicateDetector.mjs:28` — `HASH_CHUNK_SIZE = 1024 * 1024` with comment "MUST match utils.mjs getFileHash (1MB)". Used at `:627` (`findByHash`) and `:758` (`storeContentHash`).

**Invariant verified.** Both are literally `1024 * 1024`. Bumping one without the other silently breaks dedup for files > 1 MB.

**Edge case**: two PDFs that differ only after the first 1 MB will SHA-256 identically and one will be marked duplicate. Acceptable trade-off, but worth knowing.

### 6.2 Dedup decision flow (source priority)

Two decision points: fast pre-import (`watchFolder.mjs:359-423`) → full pipeline (`duplicateDetector.mjs:290-368`).

**Pre-import**:
1. Tracking-store hash lookup (`watchFolder.mjs:374-389`).
2. `checkForDuplicate({}, filePath)` → content-hash branch only (empty metadata).
3. If `isDuplicate=true` and `duplicateAction==='skip'`: add duplicate sentinel and skip.

**Full pipeline — strict priority** (`duplicateDetector.mjs:290-368`), each pref-gated:

1. **DOI** (`:305-316`, impl `:375-419`) — normalizes (`https://(dx.)?doi.org/`, `doi:`, lowercase), runs `Zotero.Search` with `DOI is <doi>` + `deleted false`. Confidence 1.0.
2. **ISBN** (`:318-329`, impl `:427-499`) — strips hyphens/spaces, validates length 10/13, generates ISBN-10↔13 variants. Confidence 1.0.
3. **Title fuzzy** (`:331-337`, impl `:556-614`) — lazily builds `_titleCache` (`_buildTitleCache:226-277`, batched 500). Exact normalized hit first, then Levenshtein; best score ≥ threshold (default 0.85). Cache stays fresh via `Zotero.Notifier` observer `_handleNotify` (`:137-208`).
4. **Content hash (library-stamp lookup)** (`:339-350`, impl `:622-655`) — `Zotero.Search` for `extra contains "watchfolder-hash:<sha>"` + `deleted false`. **Load-bearing for tracking-wipe survival.**

Any throw inside `checkDuplicate` returns `isDuplicate:false` (`:359-367`) — deliberate, never blocks imports.

### 6.3 Tracking store — `content/trackingStore.mjs`

Persisted to `<Zotero data dir>/zotero-watch-folder-tracking.json` (`trackingStore.mjs:79`).

**Record schema** — typedef `:9-23`, factory `:30-43`:

```
path                — final disk location AFTER any post-import move
hash                — SHA-256 hex of first 1MB
mtime, size         — captured at import
itemID              — Zotero item ID
importDate          — ISO timestamp (BUT see schema drift below)
metadataRetrieved, renamed — workflow flags
postImportAction    — 'leave' | 'delete' | 'move'
expectedOnDisk      — false when postImportAction was 'delete'
                      (external-deletion scan ignores these — :803)
```

**Schema drift, noted.** `watchFolder.mjs` builds records with `importedAt: Date.now()` and `isDuplicate: true` (`:380-386, :406-412, :453-460`). The typedef has `importDate` and no `isDuplicate`. Survives in JSON, but a consumer filtering on `importDate` will miss dedup-skip rows.

**Persistence mechanics**:
- In-memory `Map<path, TrackingRecord>` (`:56`). Insertion order → LRU eviction (`_evictIfNeeded:139-146`), `maxEntries` default 5000.
- `_dirty` set on `add` (`:126`), `update` (`:239`), `remove` (`:256`), `removeByItemID` (`:277`), `clear` (`:425`). Cleared after successful `save` (`:349`) or `load` (`:395`).
- `save()` (`:322-356`) — writes `{ version: 1, lastSaved, records: [...] }` via `IOUtils.writeJSON`. **Early-returns if `!_dirty`** (`:325`).

**Save call sites in `watchFolder.mjs`**: `:202, :463, :523, :696, :892, :977`.

### 6.4 Library hash-stamp fallback (`watchfolder-hash:<sha256>` in Extra)

Two write paths, one read path.

**Write A — at import time** (`watchFolder.mjs:466-477`). `getDuplicateDetector().storeContentHash(item, finalPath)`. Impl `duplicateDetector.mjs:753-794`: re-reads first 1 MB, re-hashes, walks up to parent if attachment (`:765-767`), **scrubs any pre-existing `watchfolder-hash:` line** via regex `/watchfolder-hash:[a-f0-9]+\n?/gi` (`:775`), appends fresh stamp on its own line, `saveTx`.

**Write B — startup backfill** (`watchFolder.mjs:1059-1105`, `_backfillHashesForExistingItems`). Kicked off fire-and-forget at `:106-108` (swallowed `.catch`). For each tracking record with `itemID` + `hash`:
1. Resolve item (skip if deleted).
2. **If attachment, walk to `parentID`** (`:1079-1082`).
3. **Idempotent skip** if `extra.includes('watchfolder-hash:<hash>')` (`:1084`).
4. Append, `saveTx` (`:1088-1092`).

**Read path** (`duplicateDetector.mjs:622-655`) — `Zotero.Search` for `extra contains "watchfolder-hash:<sha>"` + `deleted false`. Theoretical false-positive if a user pasted that prefix manually.

**Why this exists** — if `zotero-watch-folder-tracking.json` is deleted or the plugin reinstalled, next scan of the same file: chunk-size invariant ⇒ same hex ⇒ tracking-store miss ⇒ falls through to Extra-field search ⇒ finds the original item ⇒ dedupes per `duplicateAction`.

### 6.5 Move-within-folder detection

Hashing disambiguates "drag into subfolder" from "delete + re-add."

Trigger: every `_scan()` calls `_handleExternalDeletions(diskPaths, files)` (`watchFolder.mjs:266`) **before** the new-file pass. Both the set AND the file list are passed so move detection can iterate candidates.

`_handleExternalDeletions` (`:795-898`):
1. Build `missing` (`:798-812`): tracked records where `expectedOnDisk` is true and `record.path` no longer on disk. Double-checks via `IOUtils.exists` to avoid scan-snapshot races.
2. **Move detection** (`:821-857`): for each missing record with a `hash`, scan candidate files (untracked + not in `_processingFiles`). Lazy-hash via memoized `hashOf` closure (`:831-834`). First match wins; matched candidate is `splice()`'d (`:850`) so two missing records can't both grab the same on-disk file.
3. Records without `hash` skip move detection (`:837`) → straight to `trulyMissing`.
4. Confirmed moves → `_handleFileMoves(moves)` (`:861`).

`_handleFileMoves` (`:908-978`):
1. `collectionPathFor` helper (`:914-925`) mirrors the directory→collection mapping from `_scan` (`:286-311`). Computes old and new auto-mapped paths.
2. If mapped collection changed (`:937`): `getOrCreateCollectionPath(new)` + `_findCollectionByPath(old)`, then `removeFromCollection(old)` + `addToCollection(new)` + `saveTx`. **Manually-added collection memberships are preserved** — only the auto-mapped one moves.
3. Tracking: `remove(record.path)` (`:962-966`) then `add({ ...record, path: newPath })` (`:967-971`). Comment notes no in-place `update(path)` exists.
4. `save()` (`:977`).

---

## 7. External-event handlers

### 7.1 Trash events — `_handleZoteroTrash` (`watchFolder.mjs:649-697`)

Driven by `Zotero.Notifier` `'trash'` event registered at `init`:`86-94`.

1. For each trashed itemID, look up tracking record. **Skip** if no record, no path, or `expectedOnDisk===false` (`:658`) — the `postImportAction='delete'` invariant.
2. If record exists but file already gone (`:662-666`), just clear tracking.
3. Otherwise branch on `diskDeleteOnTrash` pref (`:673-679`): `'never' | 'os_trash' | 'permanent' | 'ask'`. For `'ask'`, `_promptDiskDelete(targets)` (`:710-755`) shows a 3-button `Services.prompt.confirmEx` with "Don't ask again" that persists choice via `setPref('diskDeleteOnTrash', action)` (`:751-753`). Linked mode adds a warning that the watch-folder file is the **only** copy (`:719-722`).
4. Execute per target: `_moveToOSTrash(path)` (`:764-786`) uses `nsIFile.moveToTrash()` if available, falls back to `IOUtils.remove`. `'permanent'` → `IOUtils.remove` directly. Either way, drop the tracking entry.

**Open issue S.4 — trash dialog never fires on right-click → Move to Bin.** This handler is reached only via the notifier `'trash'` event; if some code path bins items without firing it, the whole flow is silently bypassed. No fix in this code.

### 7.2 External-deletion sync — `_handleExternalDeletions` (`watchFolder.mjs:795-898`)

See §6.5 for the move-detection branch. The non-move path:

- `trulyMissing` records → `item.deleted = true; await item.saveTx()` (`:876-879`), collect title, remove tracking.
- After the loop, one batched `_showExternalDeletionPopup(trashed)` (`:1019-1048`) shows a `Services.prompt.alert` with up to 20 paths and mode-specific footer text.

Bails immediately if `diskDeleteSync === 'never'`.

### 7.3 Library hash-stamp backfill on startup — see §6.4.

---

## 8. Metadata Retriever — `content/metadataRetriever.mjs`

Singleton wrapping `Zotero.RecognizeDocument.recognizeItems()`. Exports: `MetadataRetriever` class (`:18`), `getMetadataRetriever` (`:456`), `initMetadataRetriever` (`:468`), `shutdownMetadataRetriever` (`:479`), `NEEDS_REVIEW_TAG = '_needs-review'` (`:11`).

### Queue model

- `_queue: Array<{itemID, onComplete}>` (`:21`)
- `_maxConcurrent = 2`, sourced from pref `maxConcurrentMetadata` (`:42`)
- `_delayBetween = 1500ms` (`:27`), applied in `finally` at `:172-174` only if more items remain
- Public: `queueItem` (`:112`), `queueItems` (`:130`), `start/stop/clearQueue` (`:367/376/384`), `destroy` (`:427`)

### Recognition completion detection

`Zotero.RecognizeDocument.recognizeItems()` returns before recognition actually completes. The bridge uses a `Zotero.Notifier` observer registered in `init()` (`:46-54`). `_handleNotify` (`:67-105`) watches:

1. `add` of a regular item whose children include a tracked attachment → resolve (`:80-92`).
2. `modify` of an attachment that just gained `parentID` → resolve (`:95-103`).

`_pendingRecognition: Map<itemID, {resolve, timeout}>` (`:33`) holds the bridge. Each `_retrieveMetadata` call creates a **60 s timeout** (`:220-226`) that resolves `false` if no event arrives — safety net for unrecognizable PDFs.

### Three fire-and-forget `_processQueue()` calls — verified exact lines

1. **Line 122** — inside `queueItem()`: kicks off the worker after enqueueing.
2. **Line 177** — inside `_processQueue()`'s own `finally`, self-recursive drain. Main loop driver; missing `await` is by design (each call independent and concurrent up to `_maxConcurrent`), but missing `.catch` is the swallowing point.
3. **Line 370** — inside `start()` when transitioning to running.

`_processQueue` is `async`, so any throw outside the inner try/catch/finally (`:150-178`) becomes an **unhandled promise rejection**. Common paths are absorbed; a fourth fire-and-forget without `.catch(e => Zotero.logError(e))` would be a real regression.

### Other details

- `_hasMetadata` (`:258-299`), `_addNeedsReviewTag` (`:305-334`), `removeNeedsReviewTag` (`:341-362`) use **synchronous** `Zotero.Items.get(parentID)` (`:266, :313, :347`) — valid in Zotero 7/8 for single-ID lookups.
- Tagging prefers parent item over attachment when one exists (`:309-318`) — surfaces the warning at bibliographic level.

---

## 9. Collection Sync — Phase 2 (`content/collectionSync.mjs`, 1046 lines)

Status: **implementation-complete but never validated in a real Zotero install. Disabled by default** — `prefs.js:40` `collectionSyncEnabled = false`.

### Design

`CollectionSyncService` coordinator delegating to five collaborators (`:33-46`):
- `SyncState` — JSON persistence of collection↔folder-path and item↔collection-set maps
- `CollectionWatcher` — `Zotero.Notifier` observer on collections/collection-items
- `FolderWatcher` — periodic disk scan (`mirrorPollInterval`, default 10 s)
- `PathMapper` — `Zotero.Collection` → filesystem path under `mirrorPath`
- `ConflictResolver` — handles `file_exists` per `conflictResolution` pref (skip/rename/overwrite/last/zotero/disk/manual)

`init()` (`:111-146`) reads `mirrorPath`, `mirrorRootCollection` (int), `collectionSyncEnabled`. If anything missing or root collection gone, init **silently bails** (`:119-129`).

### Event handlers — entry points

**Collection → Folder (F2.1)**:
- `handleCollectionCreated` (`:355`): `IOUtils.makeDirectory(path, {createAncestors: true})`
- `handleCollectionRenamed` (`:377`): `IOUtils.move(oldPath, newPath)` at `:400`. Then `_updateChildCollectionPaths` (`:933`) and `_updateItemPathsForCollection` (`:960`).
- `handleCollectionDeleted` (`:428`): folder removed only if empty (`:440-445`); non-empty folders kept.
- `handleCollectionMoved` (`:457`): cross-scope movement. `IOUtils.move` at `:496`.

**Item → Folder (F2.2)**: `handleItemAddedToCollection` (`:525`) moves the file (`:586`), then `item.relinkAttachmentFile(targetPath)` (`:590`). Safety: `:591-601` catch relink failures and **attempt to restore the file** to its original location.

**Folder → Collection (F2.3)**: `handleFolderCreated/Renamed/Deleted` (`:665/714/748`), `handleFileAdded` (`:781`), `handleFileDeletedFromMirror` (`:827`). On file deletion, **item is removed from collections but the Zotero item itself is preserved** (`:845-857`) — deliberate per comment at `:846`.

### Sharp edges

1. **Cross-filesystem `IOUtils.move` will silently fail.** `:400, :496, :586` precheck only `IOUtils.exists`. **Mount-unavailable handling is essentially absent.**
2. **Recursive child-path updates are state-only** (`_updateChildCollectionPaths:933-951`). When a parent moves, OS carries children physically — function then updates `syncState` without re-verifying each child actually transported.
3. **`handleCollectionDeleted` keeps non-empty folders** (`:440-445`) but stops tracking them. Folder-watcher could re-import them as new collections.
4. **No item deletion when file disappears** (`:845-857`) — only collection membership removed. Item becomes a standalone broken-link attachment.
5. **`PathUtils.parent` / `PathUtils.filename`** (`:677, :681, :723, :792`) — Windows backslash behaviour not validated per `CLAUDE.md`.
6. **`_isSyncing` is global** (`:53`). If an exception escapes before the inner `finally` (`:613-615`), the flag stays stuck and the service deadlocks itself.
7. **`Zotero.Attachments.linkFromFile`** (`:802-805`) — single library only (`userLibraryID` via root collection, `:687`). Group libraries unsupported.

---

## 10. Bulk Operations — Phase 3 (`content/bulkOperations.mjs`)

Status: **no UI, console-only.** No preference UI hook, no menu entry.

### Class shape

`BulkOperations` (`:59`), singleton via `getBulkOperations()` (`:708`):
- `_isRunning` (`:61`) + `_cancelRequested` (`:64`) — single-operation lockout
- `requestCancel` (`:87`) sets the flag; `_processBatch` (`:180`) honours it at every iteration boundary (`:198-201`)

### Three entry points

| Export | Class method | Behaviour |
|---|---|---|
| `reorganizeAll(options)` (`:734`) | `reorganizeAllItems` (`:371`) → `reorganizeItem` (`:294`) | Re-applies `renamePattern` to every item's attachments. Per-call `pattern` override supported. |
| `retryAllMetadata(options)` (`:744`) | `retryFailedMetadata` (`:506`) → `retryMetadataForItem` (`:411`) | Finds items tagged `_needs-review` (`:512`), removes tag (`:460`), re-queues into `MetadataRetriever` (`:464`). |
| `applyRulesToAll(options)` (`:754`) | `applyRulesToExisting` (`:651`) → `applyRulesToItem` (`:558`) | Runs smart-rules engine over every regular item. **Dynamically imports `./smartRules.mjs`** (`:573`) and gracefully skips if absent (`:575-582`). |

Aux: `isBulkOperationRunning` (`:763`), `cancelBulkOperation` (`:770`), `resetBulkOperations` (`:718`).

### Batching

`_processBatch` (`:180-280`) — shared engine. Reports `processing → success/error/skipped`. Every `batchSize` (default 10) items, `await delay(100ms)` (`:264-266`). `dryRun=true` produces previews without mutations.

### How a user invokes them

Per `CLAUDE.md` these are console-only. But the bundle only exposes `Zotero.WatchFolder.hooks`, so **there is no path to invoke these from a live Zotero session** — they're reachable only by unit tests. Effectively dormant until wired into a hook or UI button.

---

## 11. Preferences UI ↔ `prefs.js`

UI: `content/preferences.xhtml` + `content/preferences.js`. Both ship verbatim (`build/build.mjs:125-131` skips `.mjs`).

### Sections

**About** (`preferences.xhtml:7-15`): three FTL-bound paragraphs (`watch-folder-pref-about-text`, `…-storage`, `…-trash`) from `locale/en-US/zotero-watch-folder.ftl:5-13`. Explain that files are copied into `~/Zotero/storage/`, sources are left in place by default, and trash actions prompt.

**Watch Folder** (`preferences.xhtml:18-57`):

| Control | Pref (`extensions.zotero.watchFolder.*`) | XHTML | prefs.js |
|---|---|---|---|
| `watch-folder-enabled` | `enabled` | `:23-24` | `:5` |
| `watch-folder-source-path` (readonly + Browse) | `sourcePath` | `:29-33` | `:6` |
| `watch-folder-poll-interval` (1-60) | `pollInterval` | `:38-40` | `:7` |
| `watch-folder-file-types` | `fileTypes` | `:46-48` | `:9` |
| `watch-folder-target-collection` | `targetCollection` | `:53-55` | `:8` |

**File Naming** (`preferences.xhtml:65-92`):

| Control | Pref | XHTML | prefs.js |
|---|---|---|---|
| `watch-folder-auto-rename` | `autoRename` | `:70-71` | `:20` |
| `watch-folder-rename-pattern` | `renamePattern` | `:76-78` | `:18` |
| `watch-folder-max-filename` (50-255) | `maxFilenameLength` | `:87-89` | `:19` |

### Hidden prefs (no UI)

`preferences.xhtml:59-62` has an in-source comment: `importMode` and `postImportAction` are **removed from the visible UI** but remain functional (defaults `stored` / `leave`). Reason: `postImportAction='delete'` sets `expectedOnDisk=false` — exposing it casually is a foot-gun.

`prefs.js` defines 30 explicit `pref(...)` calls (`:5-46`); `CLAUDE.md`'s "31" matches if `lastWatchedPath` (`:13`) is counted. **Only 8 keys are in the UI.** The other 23 are hidden:

- **Import workflow** (4): `importMode`, `postImportAction`, `autoRetrieveMetadata`, `lastWatchedPath`
- **Trash sync** (2): `diskDeleteOnTrash` (ask|os_trash|permanent|never), `diskDeleteSync` (auto|never)
- **Duplicate detection** (7): `duplicateCheck`, `duplicateMatchDOI`, `duplicateMatchISBN`, `duplicateMatchTitle`, `duplicateTitleThreshold` (int 0-100), `duplicateMatchHash`, `duplicateAction`
- **Smart rules** (2): `smartRulesEnabled`, `smartRules` (JSON string)
- **Performance** (2): `adaptivePolling`, `maxConcurrentMetadata`
- **Collection sync** (6): `collectionSyncEnabled`, `mirrorPath`, `mirrorRootCollection`, `mirrorPollInterval`, `bidirectionalSync`, `conflictResolution`

### `preferences.js` mechanics

- FTL loaded via `MozXULElement.insertFTLIfNeeded("zotero-watch-folder.ftl")` (`:14`) before Zotero translates the fragment.
- Script runs in `Cu.Sandbox(window)` **before** Zotero inserts the XHTML; `getElementById` is invalid at load time. Two redundant init triggers: capture-phase `'load'` listener on the pane vbox (`:128-133`) and inline `onload="WatchFolderPrefs.onLoad()"` on the root vbox (XHTML `:5`).
- `window.WatchFolderPrefs` (`:119-122`) exposes `browseForFolder`/`onLoad` for the inline `oncommand=` attribute (XHTML `:33`), which evaluates in window scope, not the sandbox.
- `handleEnableCommand` (`:73-88`) adds extra validation on top of XUL `preference=` binding: if user enables with an invalid `sourcePath`, the checkbox AND pref are both reverted and `Services.prompt.alert` fires.
- `browseForFolder` (`:36-55`) uses `chrome://zotero/content/modules/filePicker.mjs`'s `FilePicker` in `modeGetFolder`.

---

## 12. Build & release pipeline

### Command graph (`package.json:7-16`)

```
npm run release  →  build && bundle && package && release:upload
```

**Order quirk**: `release` runs `build` *before* `bundle`. `build.mjs` cleans `dist/` (`:91`) and warns if the bundle is missing (`:149`). The warning fires harmlessly because `bundle.mjs` writes into the cleaned directory afterwards. The `CLAUDE.md` "Bundle-pipeline trap" describes the correct **dev** order (bundle → build → reload) — opposite of release. If you run `npm run build` after editing a `.mjs` without running `bundle`, dist has stale or no bundle output.

### `build/bundle.mjs` (43 lines)

- Entry: `content/index.mjs`
- Format: `iife` with `globalName: '_ZoteroWatchFolderTemp'` (`:21`)
- Target: `firefox128` — Zotero 8 baseline (`:23`)
- `external: ['zotero*']` (`:25`) — keeps `Zotero.*` unresolved
- Footer (`:29-31`) hand-writes `Zotero.WatchFolder = _ZoteroWatchFolderTemp` with `_globalThis.Zotero` fallback
- Output: `dist/content/scripts/watchFolder.js` (what `bootstrap.js` loads as a subscript)

### `build/build.mjs` (165 lines)

1. `cleanDir(DIST_DIR)` (`:91`)
2. Copy `manifest.json`, `bootstrap.js`, `prefs.js` to `dist/` (`:18-22, :97-108`)
3. Copy `content/` recursively but **filter out `.mjs`** (`:125`: `if (!entry.name.endsWith('.mjs'))`)
4. Copy `locale/` recursively (`:138`)
5. Verify bundle exists at `dist/content/scripts/watchFolder.js` — informational only (`:145-149`)

Legacy `bootstrap-old.js` / `bootstrap-simple.js` excluded because `FILES_TO_COPY` only lists `bootstrap.js`.

### `build/package.mjs` (186 lines)

1. Reads version from **`dist/manifest.json`** (`:29-39`) — so `build` must run first.
2. Creates `zotero-watch-folder-${version}.xpi` at repo root with `archiver` zlib level 9 (`:44-69`). XPI is a ZIP of `dist/` contents (`:65`: `archive.directory(DIST_DIR, false)` flattens `dist/`).
3. SHA-256 hash via `crypto.createHash` (`:74-78`).
4. Writes `update.json` at repo root (`:83-107`):
   - `addons[<ADDON_ID>].updates[0]` with `version`, `update_link` (GitHub releases URL), `update_hash: sha256:<hex>`, `applications.zotero.strict_min_version: "6.999"`
   - `ADDON_ID = 'watch-folder@zotero-plugin.org'` (`:21`)
   - `GITHUB_USERNAME` defaults `'josesiqueira'` (`:22`, env-overridable)
   - `GITHUB_REPO` defaults `'zotero-watch-folder'` (`:23`, env-overridable)

### `build/release-upload.mjs` (72 lines)

1. Verifies `gh` CLI present (`:54`).
2. Reads version from `dist/manifest.json` (`:55`).
3. Target repo from `GITHUB_REPOSITORY` env or parsed from `git remote get-url origin` (`:31-37`).
4. `ensureRelease(tag, repo)` — `gh release view` or creates (`:45-51`).
5. `gh release upload tag xpiPath --repo repo --clobber` (`:63`).

**Critical**: only the `.xpi` is uploaded. `update.json` is **not** pushed by this script. Per `manifest.json:14`, it's served from `raw.githubusercontent.com/josesiqueira/zotero-watch-folder/main/update.json` — must be **committed to `main`** for auto-updates to work. The script doesn't remind you.

### Version sync

- `manifest.json:4` `"version": "1.2.3"`
- `package.json:3` `"version": "1.2.3"`
- ✓ In sync (verified 2026-05-22).

---

## 13. Tests

Three layers — see `test/README.md` for the overview.

- **`test/unit/`** — Vitest, ~375 tests, `vitest.config.mjs` (globals, Node env). `test/setup/geckoMocks.js` stubs `Zotero`, `IOUtils`, `PathUtils`, `Services`, `Components`, `ChromeUtils`, `crypto.subtle`. New test file: `test/unit/<module>.test.mjs` → import SUT from `../../content/<module>.mjs`, mock deps per-file with `vi.mock(...)`, reset in `beforeEach`.
- **`test/mcp/`** — MCP runbooks Claude executes against a live Zotero via `@introfini/mcp-server-zotero-dev`. Entry: `test/mcp/INDEX.md`. Replaces the old manual `TEST_PLAN.md` for day-to-day work. Run `SMOKE.md` S.1–S.7 before tagging a release.
- **Zero unit coverage** on `bulkOperations.mjs`, `metadataRetriever.mjs`, `index.mjs` — gaps are intentional, not invitations to skip.

---

## 14. Invariants to preserve

Distilled from `CLAUDE.md`'s "Don't touch without understanding" section, each verified against the actual code:

1. **1 MB hash chunk size duplicated.** `utils.mjs:83` `CHUNK_SIZE` and `duplicateDetector.mjs:28` `HASH_CHUNK_SIZE` MUST stay equal. Divergence silently breaks dedup and move detection.
2. **Library hash stamps (`watchfolder-hash:<sha256>` in Extra)** are the fallback when `tracking.json` is wiped. Stamped at import (`watchFolder.mjs:466-477`) and on startup via `_backfillHashesForExistingItems` (`:1059-1105`).
3. **`_processingFiles: Set`** is the only per-file reentrancy guard for the poll loop. Add at `watchFolder.mjs:361`, remove in `finally` at `:539`.
4. **`postImportAction='delete'` ⇒ `expectedOnDisk=false`** in the tracking record. External-deletion sync (`:803`) and trash handler (`:658`) both skip these to avoid trashing the Zotero item.
5. **`scanFolderRecursive` skips `imported/`** by exact directory-name match (`fileScanner.mjs:119-122`). Renaming the post-import destination away from `imported` re-imports everything in a loop.
6. **`_rootURI` must be set before `onStartup()`** (`bootstrap.js:49`). Prefs pane registration in `index.mjs:28-37` would silently skip otherwise.
7. **Linked mode skips post-import.** `watchFolder.mjs:440` and `fileImporter.mjs:181-191`. Don't add a code path that moves/deletes a linked-mode source file.
8. **`collectionSync.mjs` (Phase 2)** is implementation-complete but never validated in a real Zotero install. Disabled by default — assume sharp edges.
9. **`metadataRetriever.mjs`** has known fire-and-forget `_processQueue()` calls at **lines 122, 177, 370**. Errors get swallowed. Be careful adding more.

---

## 15. Open issues & known bugs

From `updates_13_05_26.md`, `TODO.md`, `CLAUDE.md`, and visible in code:

- **S.4 trash-dialog never fires** on right-click → Move to Bin. `watchFolder.mjs._handleZoteroTrash` / `_promptDiskDelete` are reached only via the notifier `'trash'` event, which apparently doesn't fire on that path.
- **`metadataRetriever` fire-and-forget queue** (3 sites at `:122, :177, :370`). Errors silently swallowed when thrown outside the inner try/catch/finally.
- **`tracking.json` not saved when all files are dedup-skipped.** `watchFolder.mjs:374-388` and `:391-423` call `_trackingStore.add(...)` (sets `_dirty=true`) then return without `await _trackingStore.save()`. Compare `:463` which explicitly saves on import-success. Crash between scans loses these adds. Fix: one `save()` before each early `return`, or a `_dirty`-guarded flush at end of `_scan`.
- **Phase 2 collection sync** — physical folder move on collection rename works (`IOUtils.move` at `:400`), but mount-unavailable handling is absent; cross-filesystem move precheck is only `IOUtils.exists`; recursive child-path updates are state-only (don't re-verify each child moved); `_isSyncing` global flag can deadlock the service if an exception escapes before `finally`.
- **Phase 3 bulk ops** (`reorganizeAll`, `retryAllMetadata`, `applyRulesToAll`) — no UI hook AND not reachable via `Zotero.WatchFolder.hooks`. Effectively dormant.
- **Schema drift in tracking records.** `watchFolder.mjs` writes `importedAt`+`isDuplicate` but typedef has `importDate` and no `isDuplicate`. Consumers filtering on `importDate` will miss dedup-skip rows.
- **Move detection requires `record.hash`.** Records without a stored hash (`watchFolder.mjs:837`) go straight to `trulyMissing` — they'll be trashed even if the file actually moved. Older tracking entries lacking hashes are false-positive at risk.
- **Hash chunk caps at 1 MB.** Two PDFs differing only after 1 MB SHA-256 identically; one will be marked duplicate.
- **Backfill failures swallowed** (`watchFolder.mjs:106-108` fire-and-forget, `:1094-1097` debug-only). A partial backfill leaves a mixed-state library silently.
- **`_handleFileMoves` tracking update is remove-then-add** (`:961-971`). If interrupted between remove and add, tracking entry vanishes and file will be re-imported.
- **`Extra contains` substring risk** in `findByHash` — theoretical false positive if a user pastes `watchfolder-hash:<sha>` into Extra manually.
- **Dead-letter `_metadataQueue`.** Items pushed at `watchFolder.mjs:528-531` when `autoRetrieveMetadata` is off and/or no retriever wired. `dequeueMetadataItem` (`:1177`) exists but has no internal caller.
- **`update.json` not auto-uploaded.** `release-upload.mjs` pushes only the `.xpi`; auto-updates require committing `update.json` to `main`. Easy to forget.

---

## 16. Suggested follow-ups & refactoring opportunities

Synthesised from all three agent reports. Not prescriptive — sized roughly by ease.

**Quick wins (defensive):**
- Save tracking store on dedup-skip code paths in `watchFolder.mjs:374-423` (fixes the silent-loss bug).
- Add `.catch(e => Zotero.logError(e))` to the three `_processQueue()` fire-and-forget call sites.
- Add `.catch(e => Zotero.logError(e))` to the backfill kickoff at `watchFolder.mjs:106-108` (today swallowed at debug level).
- Wrap `_isSyncing` releases in `collectionSync.mjs` so an exception escaping the inner `try` doesn't permanently lock the service.

**Schema cleanup:**
- Standardize tracking record creation via `createTrackingRecord` from `trackingStore.mjs` to eliminate `importedAt` vs `importDate` drift.
- Extend the typedef in `trackingStore.mjs:9-23` to formalize `isDuplicate` if it's load-bearing, or drop it.

**Invariant enforcement:**
- Export `HASH_CHUNK_SIZE` from `utils.mjs` and import in `duplicateDetector.mjs` so the 1 MB constant lives in one place. Eliminates the silent-drift class of bugs CLAUDE.md warns about.
- Add a runtime assertion at module load that `getFileHash` and `findByHash` use the same chunk size.

**Phase 2 hardening (before enabling by default):**
- Detect mount unavailability before `IOUtils.move` in `collectionSync.mjs:400, :496, :586` (e.g., `IOUtils.stat` on the mirror root + free-space sanity check) and short-circuit cleanly.
- Verify each child collection actually transported physically in `_updateChildCollectionPaths` (`:933-951`) before updating state.
- Decide whether `handleCollectionDeleted` should also clean non-empty folders, or whether the folder-watcher should refuse to re-import them.
- Validate Windows backslash behaviour of `PathUtils.parent`/`filename` (lines `:677, :681, :723, :792`).
- Either support group libraries in F2.3 (`linkFromFile` at `:802-805`) or guard with an explicit "user library only" check.

**Phase 3 plumbing:**
- Expose the three bulk-ops entry points via `Zotero.WatchFolder.hooks` (or a hidden menu item) so they can be invoked from a real session, not just unit tests.

**Misc:**
- `release-upload.mjs` could also `git add update.json && git commit && git push` (or at least warn loudly) so auto-updates aren't broken by an easy-to-forget step.
- The dead-letter `_metadataQueue` fallback (`watchFolder.mjs:528-531`) either needs a dequeuer or should be removed.
- The `imported/` directory-name guard (`fileScanner.mjs:119-122`) should probably be derived from a constant shared with `fileImporter.mjs` rather than two hard-coded strings.
- Hash-chunk-size as configurable pref? Currently 1 MB is arbitrary; making it pref-driven would let users trade off hash collisions vs. import speed for large PDF libraries. (Counter-argument: invariant becomes harder to enforce across the two read sites.)

---

## 17. Quick-reference cheat sheet

| Concept | File:Line |
|---|---|
| Plugin boot | `bootstrap.js:10` (`startup`), `:49-50` (`_rootURI` + `onStartup`) |
| Hooks export | `content/index.mjs:23-116` |
| Service singleton | `watchFolder.mjs:1219-1224` |
| Poll loop | `watchFolder.mjs:224-233` (schedule), `:240-350` (`_scan`) |
| Reentrancy guards | `watchFolder.mjs:46` (`_processingFiles`), `:31` (`_scanInProgress`), `:361/:539` (add/remove) |
| Import flow | `watchFolder.mjs:359-541`; `fileImporter.mjs:19-77` |
| Post-import actions | `fileImporter.mjs:87-142` |
| Hash primitive (canonical) | `content/utils.mjs:81-94`, `CHUNK_SIZE` at `:83` |
| Hash constant (mirror) | `content/duplicateDetector.mjs:28` |
| Dedup priority pipeline | `duplicateDetector.mjs:290-368` |
| `findByDOI/ISBN/Title/Hash` | `:375-419` / `:427-499` / `:556-614` / `:622-655` |
| Extra-field stamp | `duplicateDetector.mjs:753-794` |
| Tracking record schema | `trackingStore.mjs:9-43` |
| Tracking JSON path | `trackingStore.mjs:79` |
| Tracking save sites | `watchFolder.mjs:202, :463, :523, :696, :892, :977` |
| Library hash backfill | `watchFolder.mjs:1059-1105` (kickoff `:106-108`) |
| Trash handler | `watchFolder.mjs:649-697`; `_promptDiskDelete` `:710-755` |
| External-deletion sync | `watchFolder.mjs:795-898` (move detection `:821-857`) |
| File moves | `watchFolder.mjs:908-978` |
| Metadata retriever fire-and-forget | `metadataRetriever.mjs:122, :177, :370` |
| Collection sync coordinator | `collectionSync.mjs:33-46`, `init:111-146` |
| Bulk-ops entry points | `bulkOperations.mjs:734, :744, :754` |
| Prefs UI controls | `preferences.xhtml:23-89` |
| Default prefs | `prefs.js:5-46` (30 explicit) |
| Build entry | `build/bundle.mjs`, `build/build.mjs`, `build/package.mjs`, `build/release-upload.mjs` |
