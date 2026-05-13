# Zotero Watch Folder - Test Plan

Complete test cases to verify all plugin functionality.

## Setup

### Test Environment
1. Create test folders:
```bash
mkdir -p ~/ZoteroWatchTest/inbox
mkdir -p ~/ZoteroWatchTest/mirror
mkdir -p ~/ZoteroWatchTest/processed
```

2. Download sample PDFs for testing (use any academic PDFs with DOIs):
   - PDF with DOI (e.g., from arXiv or any journal)
   - PDF without DOI (any random PDF)
   - Duplicate PDF (copy of one you'll import first)

3. Open Zotero Error Console: `Tools` → `Developer` → `Error Console`

---

## Phase 1: Core Watch Folder

### Test 1.1: Basic Configuration
- [ ] Open `Edit` → `Settings` → `Watch Folder`
- [ ] Verify the crow-eye icon appears in the preferences pane
- [ ] Verify all preference fields are visible:
  - Enable Watch Folder checkbox
  - Source Folder path with Browse button
  - Target Collection field
  - Poll Interval field
  - File Types field
  - Import Mode dropdown
  - Post-Import Action dropdown
  - Auto-Retrieve Metadata checkbox
  - Auto-Rename checkbox
  - Rename Pattern field

**Expected:** All UI elements render correctly.

---

### Test 1.2: Enable Watch Folder
- [ ] Set Source Folder to `~/ZoteroWatchTest/inbox`
- [ ] Set Target Collection to `TestImports`
- [ ] Set Poll Interval to `5` seconds
- [ ] Set File Types to `pdf`
- [ ] Set Import Mode to `Copy file to Zotero storage`
- [ ] Set Post-Import Action to `Leave file in place`
- [ ] Enable Auto-Retrieve Metadata
- [ ] Enable Auto-Rename
- [ ] Check "Enable Watch Folder"
- [ ] Click OK to save

**Expected:**
- Settings save without error
- Debug console shows: `[WatchFolder] Plugin started successfully`
- Debug console shows: `[WatchFolder] Started watching folder`

---

### Test 1.3: Auto-Import PDF
- [ ] Copy a PDF (with DOI if possible) to `~/ZoteroWatchTest/inbox`
- [ ] Wait 5-10 seconds

**Expected:**
- Debug console shows: `[WatchFolder] Found X new file(s)`
- Debug console shows: `[WatchFolder] Imported: filename.pdf`
- Item appears in Zotero under "TestImports" collection
- Original PDF remains in inbox folder

---

### Test 1.4: Metadata Retrieval
- [ ] Wait for metadata retrieval (up to 60 seconds)
- [ ] Check the imported item in Zotero

**Expected:**
- If DOI found: Item has title, authors, publication info
- If no DOI: Item tagged with `_needs-review`
- Debug console shows: `[WatchFolder] Queued item X for metadata retrieval`
- Debug console shows: `[WatchFolder] Recognition completed` or `timed out`

---

### Test 1.5: Auto-Rename After Metadata
- [ ] Check the attachment filename after metadata is retrieved

**Expected:**
- If metadata found: File renamed to pattern (e.g., `Author - 2024 - Title.pdf`)
- Debug console shows: `[WatchFolder] Renamed: "old.pdf" → "new.pdf"`

---

### Test 1.6: Post-Import Action - Delete
- [ ] Change Post-Import Action to `Delete file`
- [ ] Copy another PDF to inbox
- [ ] Wait for import

**Expected:**
- PDF imported to Zotero
- Original file DELETED from inbox folder
- Debug console shows: `[WatchFolder] Deleted source file`

---

### Test 1.7: Post-Import Action - Move
- [ ] Change Post-Import Action to `Move to folder`
- [ ] Set the move destination to `~/ZoteroWatchTest/processed`
- [ ] Copy another PDF to inbox
- [ ] Wait for import

**Expected:**
- PDF imported to Zotero
- Original file MOVED to `processed` folder
- Debug console shows: `[WatchFolder] Moved source file`

---

### Test 1.8: File Type Filtering
- [ ] Set File Types to `pdf`
- [ ] Copy a `.txt` file to inbox
- [ ] Wait 10 seconds

**Expected:**
- TXT file is NOT imported
- TXT file remains in inbox

---

### Test 1.9: Import Mode - Linked
- [ ] Change Import Mode to `Link to file in current location`
- [ ] Copy a PDF to inbox
- [ ] Wait for import

**Expected:**
- Item appears in Zotero
- Attachment is a LINK (not stored in Zotero storage)
- Original file in inbox is the actual file used

---

### Test 1.10: First Run Detection
- [ ] Disable Watch Folder
- [ ] Clear the `extensions.zotero.watchFolder.lastWatchedPath` pref (via `about:config` or the Error Console), or point Source Folder to a different path you have not used before
- [ ] Copy 3 PDFs to that folder
- [ ] Enable Watch Folder

**Expected (V2 simple flow — see `content/firstRunHandler.mjs`):**
- `checkFirstRun()` returns `{ isFirstRun: true, reason: 'fresh_install' }` (or `'path_changed'` if the path differs from the previous one)
- A confirm dialog appears with three buttons: `Import All`, `Skip`, `Cancel`
- Choosing `Import All` runs `importBatch` over the 3 files and shows a progress window with `Imported 3 file(s)`
- Choosing `Skip` saves the current path as `lastWatchedPath` and does not import
- Choosing `Cancel` leaves state untouched so the prompt re-appears next startup
- No Zotero → disk export, no merge-plan dialog, no hash-fallback matching is performed (those were V1 only)

---

### Test 1.11: Zotero -> Disk Deletion Sync

Verifies the 3-button trash-sync dialog driven by `extensions.zotero.watchFolder.diskDeleteOnTrash` in `content/watchFolder.mjs` (`_handleZoteroTrash` / `_promptDiskDelete`).

Preconditions:
- Watch Folder enabled, Source Folder set, at least one imported item present whose source file is still in the watch folder.
- Set `extensions.zotero.watchFolder.diskDeleteOnTrash` to `ask` via `about:config`.

#### 1.11.a: Default button — Move to OS trash
- [ ] Right-click an imported item in Zotero -> `Move Item to Trash`
- [ ] In the 3-button dialog, click `Move to OS trash` (the default)

**Expected:**
- Source file is gone from the watch folder
- File is present in the OS trash (Mac Trash / Windows Recycle Bin / Linux Files trash) and can be restored
- Debug console shows: `[WatchFolder] Trash sync: moved <path> to OS trash`
- Tracking entry for the item is removed

#### 1.11.b: Keep on disk
- [ ] Trash another imported item in Zotero
- [ ] Click `Keep on disk`

**Expected:**
- Source file remains untouched in the watch folder
- Tracking entry is still removed (item is no longer linked to the file)
- No "deleted" debug line appears

#### 1.11.c: Delete permanently
- [ ] Trash another imported item
- [ ] Click `Delete permanently`

**Expected:**
- Source file is permanently removed (not in OS trash)
- Debug console shows: `[WatchFolder] Trash sync: permanently deleted <path>`

#### 1.11.d: "Don't ask again" persists choice
- [ ] Trash another imported item
- [ ] Tick `Don't ask again`, then click `Move to OS trash`
- [ ] Open `about:config` and inspect `extensions.zotero.watchFolder.diskDeleteOnTrash`

**Expected:**
- Pref value is now `os_trash`
- Trash another item: no dialog appears, file goes straight to OS trash
- Repeat the test with `Keep on disk` (-> pref becomes `never`) and `Delete permanently` (-> pref becomes `permanent`) to confirm each choice persists

#### 1.11.e: Linked-mode warning before permanent delete
- [ ] Set Import Mode to `Link to file in current location` and re-import a file
- [ ] Reset `diskDeleteOnTrash` to `ask`
- [ ] Trash the linked item in Zotero

**Expected:**
- Dialog message includes the linked-mode warning: "you are in linked mode — the watch-folder file is the ONLY copy. Permanent delete cannot be undone."
- Clicking `Delete permanently` still proceeds (warning is informational only)

#### 1.11.f: Multi-item batched prompt
- [ ] Reset `diskDeleteOnTrash` to `ask`
- [ ] Select 3+ imported items in Zotero and move them all to trash in one operation

**Expected:**
- A single dialog appears (not one per item) with message starting with `N items were moved to Zotero's bin.`
- The chosen action is applied to every selected file

---

### Test 1.12: Disk -> Zotero Deletion Sync

Verifies the auto-bin-on-disk-delete behaviour driven by `extensions.zotero.watchFolder.diskDeleteSync` in `content/watchFolder.mjs` (`_handleExternalDeletions` / `_showExternalDeletionPopup`).

Preconditions:
- Watch Folder enabled with several tracked files imported (`Leave file in place` post-import action so files stay on disk).
- Set `extensions.zotero.watchFolder.diskDeleteSync` to `auto` via `about:config`.

#### 1.12.a: Single external delete
- [ ] In the OS file manager (or `rm`), delete one tracked file from the watch folder
- [ ] Wait for the next poll cycle (poll interval seconds)

**Expected:**
- The matching Zotero item moves to the bin (`item.deleted = true`)
- A popup appears titled "Zotero Watch Folder" listing the deleted path and the item title
- Popup footer mentions Zotero still has its own copy in storage (stored mode)
- Debug console shows: `[WatchFolder] Detected 1 externally-deleted file(s)`

#### 1.12.b: Multiple deletes batched into one popup
- [ ] Delete 3+ tracked files from the watch folder in a single operation (before the next scan)
- [ ] Wait for the next poll cycle

**Expected:**
- A single popup lists all deleted paths and matching item titles (up to 20, with `…and N more.` if exceeded)
- All matching items are in Zotero's bin
- Only one popup appears, not one per file

#### 1.12.c: `diskDeleteSync=never` disables the feature
- [ ] Set `extensions.zotero.watchFolder.diskDeleteSync` to `never` in `about:config`
- [ ] Delete another tracked file from the watch folder
- [ ] Wait for the next poll cycle

**Expected:**
- The Zotero item is NOT moved to the bin
- No popup appears
- Tracking entry remains (the feature is fully bypassed)

#### 1.12.d: Linked-mode popup wording
- [ ] Reset `diskDeleteSync` to `auto`
- [ ] Set Import Mode to `Link to file in current location`, import a fresh file, then delete it externally from the watch folder
- [ ] Wait for the next poll cycle

**Expected:**
- Popup appears and the matching item is in the bin
- Footer explicitly mentions linked attachments and broken file links (something like "These were linked attachments — the items are now in the bin with broken file links.")

---

## Phase 2: Collection ↔ Folder Sync

### Test 2.1: Enable Collection Sync
- [ ] In Settings → Watch Folder, find Collection Sync section
- [ ] Set Mirror Path to `~/ZoteroWatchTest/mirror`
- [ ] Create a collection called "MirrorTest" in Zotero
- [ ] Set Mirror Root Collection to "MirrorTest"
- [ ] Enable Bidirectional Sync
- [ ] Enable Collection Sync

**Expected:**
- Settings save without error
- Debug console shows: `[WatchFolder] Collection sync service initialized`

---

### Test 2.2: Collection → Folder Sync
- [ ] Create a sub-collection under "MirrorTest" called "Papers"
- [ ] Wait 10 seconds

**Expected:**
- Folder `~/ZoteroWatchTest/mirror/Papers` is created
- Debug console shows collection sync activity

---

### Test 2.3: Item → Folder Sync
- [ ] Drag an item with a linked file into "MirrorTest/Papers"
- [ ] Wait 10 seconds

**Expected:**
- The linked file appears in `~/ZoteroWatchTest/mirror/Papers/`

---

### Test 2.4: Folder → Collection Sync
- [ ] Create a folder `~/ZoteroWatchTest/mirror/NewFolder`
- [ ] Wait 10-15 seconds

**Expected:**
- Collection "NewFolder" appears under "MirrorTest" in Zotero
- Debug console shows: `[WatchFolder] Created collection from folder`

---

### Test 2.5: File → Item Sync
- [ ] Copy a PDF to `~/ZoteroWatchTest/mirror/NewFolder/`
- [ ] Wait 10-15 seconds

**Expected:**
- Item appears in Zotero under "MirrorTest/NewFolder"
- File is linked (not copied)

---

### Test 2.6: Conflict Detection
- [ ] Modify a synced file on disk
- [ ] Modify the same item's metadata in Zotero
- [ ] Wait for sync

**Expected:**
- Conflict is detected
- Resolution applied based on settings (Zotero wins / Disk wins / Newest wins)
- Debug console shows: `[WatchFolder] Conflict detected`

---

## Phase 3: Advanced Features

### Test 3.1: Duplicate Detection - DOI
- [ ] Import a PDF that has a DOI
- [ ] Note the DOI value
- [ ] Try to import another PDF with the SAME DOI

**Expected:**
- Second import is SKIPPED
- Debug console shows: `[WatchFolder] DOI match: 10.xxxx/xxxxx`
- Debug console shows: duplicate check result

---

### Test 3.2: Duplicate Detection - Title
- [ ] Import a PDF with a unique title
- [ ] Try to import another PDF with a very similar title (85%+ match)

**Expected:**
- Second import detected as potential duplicate
- Depending on settings: skipped or tagged with `_duplicate`
- Debug console shows title similarity percentage

---

### Test 3.3: Smart Rules - Create Rule
- [ ] Enable Smart Rules in preferences
- [ ] Create a rule via code (until UI is built):

```javascript
// Run in Zotero's Error Console (Tools → Developer → Run JavaScript)
const { getSmartRulesEngine } = ChromeUtils.importESModule(
  "chrome://zotero-watch-folder/content/smartRules.mjs"
);
const engine = getSmartRulesEngine();
await engine.init();

engine.addRule({
  name: "AI Papers to AI Collection",
  enabled: true,
  priority: 10,
  conditions: [
    { field: "title", operator: "contains", value: "artificial intelligence" }
  ],
  actions: [
    { type: "addToCollection", value: "AI Research" },
    { type: "addTag", value: "ai-paper" }
  ]
});

await engine.saveRules();
```

**Expected:**
- Rule is saved to preferences
- Debug console confirms rule added

---

### Test 3.4: Smart Rules - Rule Execution
- [ ] Import a PDF with "artificial intelligence" in the title
- [ ] Wait for import and rule processing

**Expected:**
- Item is automatically added to "AI Research" collection
- Item has tag `ai-paper`
- Debug console shows: `[WatchFolder] Rule "AI Papers to AI Collection" matched`

---

### Test 3.5: Smart Rules - Skip Import
- [ ] Create a rule with `skipImport` action for files containing "draft" in filename
- [ ] Try to import a file named `draft-paper.pdf`

**Expected:**
- File is NOT imported
- Debug console shows: `[WatchFolder] Skip import triggered by rule`

---

### Test 3.6: Bulk Operations - Reorganize
```javascript
// Run in Zotero's Error Console
const { reorganizeAll } = ChromeUtils.importESModule(
  "chrome://zotero-watch-folder/content/bulkOperations.mjs"
);

// Dry run first
const dryResult = await reorganizeAll({
  dryRun: true,
  onProgress: (p) => Zotero.debug(`Progress: ${p.current}/${p.total} - ${p.currentItem}`)
});
Zotero.debug(`Would rename ${dryResult.success} files`);
```

**Expected:**
- Dry run shows what files would be renamed
- No actual changes made

---

### Test 3.7: Bulk Operations - Retry Metadata
```javascript
// Run in Zotero's Error Console
const { retryAllMetadata } = ChromeUtils.importESModule(
  "chrome://zotero-watch-folder/content/bulkOperations.mjs"
);

const result = await retryAllMetadata({
  dryRun: false,
  onProgress: (p) => Zotero.debug(`Progress: ${p.current}/${p.total}`)
});
Zotero.debug(`Retried ${result.success} items`);
```

**Expected:**
- Items with `_needs-review` tag are queued for metadata retry
- Progress is reported

---

### Test 3.8: Bulk Operations - Apply Rules
```javascript
// Run in Zotero's Error Console
const { applyRulesToAll } = ChromeUtils.importESModule(
  "chrome://zotero-watch-folder/content/bulkOperations.mjs"
);

const result = await applyRulesToAll({
  dryRun: true,
  onProgress: (p) => Zotero.debug(`${p.current}/${p.total}: ${p.currentItem}`)
});
Zotero.debug(`Rules would affect ${result.success} items`);
```

**Expected:**
- Shows which existing items would match rules
- Dry run makes no changes

---

## Edge Cases

### Test E.1: Special Characters in Filename
- [ ] Import a PDF with special characters: `Test (2024) [Final] - Résumé.pdf`

**Expected:**
- File imports successfully
- Filename is sanitized if needed

---

### Test E.2: Very Long Filename
- [ ] Import a PDF with a very long filename (200+ characters)

**Expected:**
- File imports successfully
- Filename is truncated to max length (150 by default)

---

### Test E.3: Empty Folder
- [ ] Point watch folder to an empty directory
- [ ] Wait 10 seconds

**Expected:**
- No errors
- Debug console shows scan completed with 0 files

---

### Test E.4: Rapid Multiple Files
- [ ] Copy 5 PDFs to inbox simultaneously

**Expected:**
- All 5 files are imported
- No duplicates
- No crashes

---

### Test E.5: Plugin Disable/Enable
- [ ] Disable the watch folder
- [ ] Add files to inbox
- [ ] Re-enable watch folder

**Expected:**
- Files added while disabled are detected and imported
- No duplicate imports

---

### Test E.6: Zotero Restart
- [ ] With watch folder enabled, restart Zotero
- [ ] Check if watching resumes

**Expected:**
- Plugin loads on startup
- Watching resumes automatically
- Debug console shows: `[WatchFolder] Plugin started successfully`

---

## Cleanup

After testing, clean up:
```bash
rm -rf ~/ZoteroWatchTest
```

And remove test collections from Zotero.

---

## Test Results Summary

| Phase | Test | Status | Notes |
|-------|------|--------|-------|
| 1.1 | Configuration UI | ⬜ | |
| 1.2 | Enable Watch | ⬜ | |
| 1.3 | Auto-Import | ⬜ | |
| 1.4 | Metadata Retrieval | ⬜ | |
| 1.5 | Auto-Rename | ⬜ | |
| 1.6 | Post-Import Delete | ⬜ | |
| 1.7 | Post-Import Move | ⬜ | |
| 1.8 | File Type Filter | ⬜ | |
| 1.9 | Linked Import | ⬜ | |
| 1.10 | First Run | ⬜ | |
| 1.11 | Zotero -> Disk Deletion | ⬜ | |
| 1.12 | Disk -> Zotero Deletion | ⬜ | |
| 2.1 | Enable Sync | ⬜ | |
| 2.2 | Collection → Folder | ⬜ | |
| 2.3 | Item → Folder | ⬜ | |
| 2.4 | Folder → Collection | ⬜ | |
| 2.5 | File → Item | ⬜ | |
| 2.6 | Conflict Detection | ⬜ | |
| 3.1 | Duplicate DOI | ⬜ | |
| 3.2 | Duplicate Title | ⬜ | |
| 3.3 | Smart Rules Create | ⬜ | |
| 3.4 | Smart Rules Execute | ⬜ | |
| 3.5 | Smart Rules Skip | ⬜ | |
| 3.6 | Bulk Reorganize | ⬜ | |
| 3.7 | Bulk Retry Metadata | ⬜ | |
| 3.8 | Bulk Apply Rules | ⬜ | |
| E.1 | Special Characters | ⬜ | |
| E.2 | Long Filename | ⬜ | |
| E.3 | Empty Folder | ⬜ | |
| E.4 | Rapid Files | ⬜ | |
| E.5 | Disable/Enable | ⬜ | |
| E.6 | Zotero Restart | ⬜ | |

**Legend:** ⬜ Not tested | ✅ Pass | ❌ Fail

---

# Automated Test Cases (vitest)

The cases below are implemented in `test/unit/` and run via `npm test`. Use them as acceptance criteria when modifying the corresponding modules.

Only unit tests (UT-xxx) are implemented today. They target pure or near-pure logic and mock the Gecko/Zotero globals via `test/setup/geckoMocks.js`. Integration tests against a full Zotero mock are not yet in place — `test/integration/` exists but is empty.

### Vitest Setup

Actual `vitest.config.mjs`:

```js
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./test/setup/geckoMocks.js'],
  },
});
```

`test/setup/geckoMocks.js` exposes the following on `globalThis`:

- `Zotero`: `debug`, `logError`, `log`, `warn`, platform flags (`isWin/isMac/isLinux`), `Prefs.get/set`, `Collections.getByLibrary/get/getLoaded`, `Items.get`, `Libraries.userLibraryID`, `Notifier.registerObserver/unregisterObserver`, `Attachments.importFromFile/linkFromFile`, `RecognizeDocument`, `DB.executeTransaction`, `Promise.delay`, `getMainWindows`, and a `ProgressWindow` constructor (with nested `ItemProgress`).
- `IOUtils`: `exists`, `stat`, `read`, `readJSON`, `readUTF8`, `writeJSON`, `writeUTF8`, `getChildren`, `makeDirectory`, `move`, `copy`, `remove`.
- `PathUtils`: `join`, `filename`, `parent`.
- `crypto.subtle.digest` (returns a fake 16-byte `ArrayBuffer`).
- `Services`: `io.newURI`, `prefs.getBranch(...)`, `prompt` with `BUTTON_POS_*`, `BUTTON_TITLE_*`, `confirmEx`.
- `ChromeUtils.importESModule`, `ChromeUtils.defineLazyGetter`.

---

## Unit Tests

### utils.mjs — UT-001 through UT-004

#### UT-001 — `sanitizeFilename` — basic illegal character replacement

**Function:** `sanitizeFilename(filename, maxLength)`

| # | Input | Expected Output | Notes |
|---|-------|-----------------|-------|
| a | `'Hello<World>.pdf'` | `'Hello World .pdf'` (illegal chars → `_`, then multi-space normalised) | `<>` are replaced |
| b | `'File:Name/slash\\back.txt'` | `'File Name slash back.txt'` | `:`, `/`, `\\` replaced |
| c | `'   spaces   .pdf'` | `'spaces .pdf'` | Leading/trailing spaces trimmed |
| d | `'normal.pdf'` | `'normal.pdf'` | Unchanged |
| e | `'a'.repeat(200) + '.pdf'` | 150 chars total, preserves `.pdf` extension | Truncation with extension preserved |
| f | `''` | `''` | Empty string passes through |
| g | `'file'` (no extension, length 200) | Truncated to maxLength | No extension edge case |

**Edge cases:** Null/undefined input; filename with multiple dots; Unicode characters.

---

#### UT-002 — `sanitizeFilename` — extension preservation during truncation

**Function:** `sanitizeFilename(filename, maxLength)`

When the filename exceeds `maxLength`, verify the extension is preserved and total length equals `maxLength`.

| # | Input (`maxLength=20`) | Expected |
|---|------------------------|----------|
| a | `'averylongfilename.pdf'` (21 chars) | 20 chars, ends with `.pdf` |
| b | `'file.verylongextension'` | Extension longer than name — truncate name part |

---

#### UT-003 — `isAllowedFileType` — extension matching

**Function:** `isAllowedFileType(filename)` (mocks `getPref` to return controlled file types)

| # | Mocked `fileTypes` pref | Input filename | Expected |
|---|------------------------|----------------|----------|
| a | `'pdf'` | `'paper.pdf'` | `true` |
| b | `'pdf'` | `'paper.PDF'` | `true` (case-insensitive) |
| c | `'pdf'` | `'paper.epub'` | `false` |
| d | `'pdf,epub'` | `'paper.epub'` | `true` |
| e | `''` (empty) | `'paper.pdf'` | `true` (falls back to `'pdf'`) |
| f | `null` | `'paper.pdf'` | `true` (falls back to `'pdf'`) |
| g | `'pdf'` | `'paper'` (no extension) | `false` |
| h | `'pdf'` | `''` | `false` |

---

#### UT-004 — `delay` — timing

**Function:** `delay(ms)`

Verify it returns a `Promise` that resolves after approximately the given milliseconds. Use Vitest fake timers.

| # | Input | Expected |
|---|-------|----------|
| a | `0` | Resolves on next tick |
| b | `1000` | Resolves after timer advances 1000ms |

---

### fileRenamer.mjs — UT-005 through UT-008

#### UT-005 — `buildFilename` — template substitution

**Function:** `buildFilename(item, pattern)`

Mock `item` as a plain object with `getCreators()`, `getField()`, `itemType`. Mock `getPref` to return controlled values.

| # | Mock metadata | Pattern | Expected result |
|---|---------------|---------|-----------------|
| a | creator:`{lastName:'Smith'}`, year:`'2023'`, title:`'Deep Learning'` | `'{firstCreator} - {year} - {title}'` | `'Smith - 2023 - Deep Learning'` |
| b | No creator, year:`'2023'`, title:`'Deep Learning'` | `'{firstCreator} - {year} - {title}'` | `'2023 - Deep Learning'` (dangling ` - ` cleaned) |
| c | creator:`{lastName:'Smith'}`, no year, title:`'AI'` | `'{firstCreator} - {year} - {title}'` | `'Smith - AI'` (empty year cleaned) |
| d | All empty | `'{firstCreator} - {year} - {title}'` | `''` or minimal non-empty safe string |
| e | title:`'Short'` | `'{shortTitle}'` | `'Short'` (≤50 chars, unchanged) |
| f | title: 60-char string | `'{shortTitle}'` | First 50 chars |
| g | creator:`{name:'Anonymous'}` (no lastName) | `'{firstCreator}'` | `'Anonymous'` (falls back to `name`) |
| h | Two creators | `'{creators}'` | Both last names comma-separated |

---

#### UT-006 — `buildFilename` — separator cleanup

**Function:** `buildFilename(item, pattern)`

Verify empty separators are removed.

| # | Scenario | Expected |
|---|----------|----------|
| a | ` - - ` in middle | collapsed to ` - ` |
| b | Leading ` - ` | stripped |
| c | Trailing ` - ` | stripped |
| d | Multiple consecutive spaces | collapsed to single space |

---

#### UT-007 — `validatePattern` — valid and invalid patterns

**Function:** `validatePattern(pattern)`

| # | Input | Expected `valid` | Expected `errors` count |
|---|-------|-----------------|------------------------|
| a | `'{firstCreator} - {year}'` | `true` | 0 |
| b | `''` | `false` | 2 (empty + no variable) |
| c | `'static string'` | `false` | 1 (no variable) |
| d | `'{unknownVar}'` | `false` | 1 (unknown variable) |
| e | `'{title}{unknownVar}'` | `false` | 1 (unknown) |
| f | `'{firstCreator}{year}{title}'` | `true` | 0 |

---

#### UT-008 — `getTemplateVariables` — completeness

**Function:** `getTemplateVariables()`

Verify returned object contains exactly the 8 documented keys: `firstCreator`, `creators`, `year`, `title`, `shortTitle`, `DOI`, `itemType`, `publicationTitle`.

---

### pathMapper.mjs — UT-009 through UT-010

#### UT-009 — `PathMapper.sanitizeFolderName` — illegal characters

**Class:** `PathMapper`
**Method:** `sanitizeFolderName(name)`

This method is pure (no external calls).

| # | Input | Expected |
|---|-------|----------|
| a | `'Normal Name'` | `'Normal Name'` |
| b | `'Col:lection<Bad>'` | `'Col lection Bad '` (illegal replaced) |
| c | `'.hidden'` | `'_hidden'` (leading dot replaced) |
| d | `'trailing.'` | `'trailing_'` (trailing dot replaced) |
| e | `''` | `'_unnamed'` |
| f | `null` | `'_unnamed'` |
| g | `'  spaces  '` | `'spaces'` (trimmed) |
| h | `'a'.repeat(250)` | Truncated to 200 chars |
| i | `'under___score'` | `'under score'` (multiple underscores → space) |

---

#### UT-010 — `PathMapper._getRelativePath` — path prefix extraction

**Class:** `PathMapper`
**Method:** `_getRelativePath(fullPath)` (private but testable via class instantiation without Zotero calls)

| # | mirrorPath | fullPath | Expected |
|---|------------|----------|----------|
| a | `/mirror` | `/mirror/sub/file` | `'sub/file'` |
| b | `/mirror` | `/other/path` | `null` |
| c | `/mirror/` | `/mirror/sub` | `'sub'` (no leading slash) |
| d | `C:\\mirror` | `C:\\mirror\\sub` | `'sub'` (Windows paths normalised) |

---

### trackingStore.mjs — UT-011 through UT-014

#### UT-011 — `TrackingStore` — in-memory CRUD operations

**Class:** `TrackingStore`

Test the in-memory Map logic **without** calling `init()` (which requires `Zotero.DataDirectory`). Instead call `_ensureInitialized` bypass by setting `this._initialized = true` and `this.records = new Map()` directly, or expose a `_testInit()` helper.

Alternatively: test `createTrackingRecord` and the methods that only touch `this.records`.

| # | Operation | Expected |
|---|-----------|----------|
| a | `createTrackingRecord({path:'/a', hash:'abc'})` | Returns object with all fields, `importDate` is a valid ISO string |
| b | `add({path:'/a', hash:'x', itemID:1})` then `hasPath('/a')` | `true` |
| c | `add({path:'/a'})` then `add({path:'/a'})` | No duplicate, size remains 1 |
| d | `add` then `get('/a')` | Returns the record |
| e | `get('/notexists')` | Returns `null` |
| f | `remove('/a')` after adding | Returns `true`, `hasPath('/a')` → `false` |
| g | `remove('/notexists')` | Returns `false` |
| h | `update('/a', {metadataRetrieved:true})` | Record updated |
| i | `update('/notexists', {...})` | Silently no-ops |
| j | `hasHash('abc')` | `true` after adding record with that hash |
| k | `findByHash('abc')` | Returns the record |
| l | `findByItemID(1)` | Returns the record |
| m | `removeByItemID(1)` | Returns `true`, record gone |
| n | `getPendingMetadata()` — item with `metadataRetrieved:false, itemID:1` | Returns that record |
| o | `getPendingRename()` — item with `metadataRetrieved:true, renamed:false, itemID:1` | Returns that record |

---

#### UT-012 — `TrackingStore` — LRU eviction

Instantiate `TrackingStore(maxEntries=3)`, set `_initialized=true`, add 4 entries. Verify oldest is evicted and size remains 3.

---

#### UT-013 — `TrackingStore.getStats` — statistics calculation

Add a mix of records (some with metadata, some renamed, some pending). Call `getStats()` and verify counts.

| # | State | Expected stats |
|---|-------|----------------|
| a | 2 with metadata, 1 renamed, 1 pending metadata | `{total:3+, withMetadata:2, renamed:1, pending:1}` |

---

#### UT-014 — `createTrackingRecord` — defaults

**Function:** `createTrackingRecord(data)`

| # | Input | Expected |
|---|-------|----------|
| a | `{}` | All fields have defaults: `path:''`, `hash:''`, `mtime:0`, `size:0`, `itemID:0`, `metadataRetrieved:false`, `renamed:false`, `importDate` is ISO string |
| b | `{path:'/x', itemID:42}` | Merges supplied values over defaults |

---

### duplicateDetector.mjs — UT-015 through UT-020

#### UT-015 — `DuplicateDetector.normalizeTitle`

**Class:** `DuplicateDetector`
**Method:** `normalizeTitle(title)`

Pure function — no external dependencies.

| # | Input | Expected |
|---|-------|----------|
| a | `'Deep Learning: A Survey'` | `'deep learning a survey'` (punctuation removed, lowercased) |
| b | `'  Extra   Spaces  '` | `'extra spaces'` |
| c | `''` | `''` |
| d | `null` | `''` |
| e | `'Unicode: über-cool'` | `'unicode über cool'` (Unicode letters kept, hyphen removed) |
| f | `'(2021) Title'` | `'2021 title'` (parens removed) |

---

#### UT-016 — `DuplicateDetector.levenshteinDistance`

**Method:** `levenshteinDistance(str1, str2)`

Pure function — no external dependencies.

| # | str1 | str2 | Expected distance |
|---|------|------|-------------------|
| a | `''` | `''` | 0 |
| b | `''` | `'abc'` | 3 |
| c | `'abc'` | `''` | 3 |
| d | `'abc'` | `'abc'` | 0 |
| e | `'kitten'` | `'sitting'` | 3 |
| f | `'abc'` | `'abd'` | 1 |
| g | `'a'` | `'b'` | 1 |

---

#### UT-017 — `DuplicateDetector.calculateSimilarity`

**Method:** `calculateSimilarity(str1, str2)`

| # | str1 | str2 | Expected (approx) |
|---|------|------|-------------------|
| a | `'hello'` | `'hello'` | 1.0 |
| b | `''` | `'hello'` | 0 |
| c | `'abc'` | `'xyz'` | 0 (all different) |
| d | `'deep learning'` | `'deep learning survey'` | > 0.6 |

---

#### UT-018 — `DuplicateDetector._isbn10to13`

**Method:** `_isbn10to13(isbn10)` (private, test via class instance)

| # | Input | Expected |
|---|-------|----------|
| a | `'0306406152'` | `'9780306406157'` |
| b | `'030640615X'` (X check digit) | Valid ISBN-13 string |
| c | `null` | `null` |
| d | `'12345'` (wrong length) | `null` |
| e | `'abcdefghij'` (non-numeric) | `null` |

---

#### UT-019 — `DuplicateDetector._isbn13to10`

**Method:** `_isbn13to10(isbn13)`

| # | Input | Expected |
|---|-------|----------|
| a | `'9780306406157'` | `'0306406152'` |
| b | `'9791000000000'` (979 prefix) | `null` (not convertible) |
| c | `null` | `null` |
| d | `'12345'` (wrong length) | `null` |

---

#### UT-020 — `DuplicateDetector` — ISBN round-trip

Combined test: convert ISBN-10 → ISBN-13 → ISBN-10 and verify original is recovered for a known set of ISBNs.

---

### smartRules.mjs — UT-021 through UT-027

#### UT-021 — `SmartRulesEngine.evaluateCondition` — all operators

**Class:** `SmartRulesEngine`
**Method:** `evaluateCondition(condition, item, context)`

Mock `item` with `getField`, `getCreators`, `getTags`, `itemType`, `isAttachment`, `getFilePath`. The `getFieldValue` dependency is internal; stub `getFieldValue` to return controlled values to isolate `evaluateCondition`.

| # | operator | fieldValue | compareValue | caseSensitive | Expected |
|---|----------|------------|--------------|---------------|----------|
| a | `contains` | `'neural networks'` | `'neural'` | false | `true` |
| b | `contains` | `'neural networks'` | `'NEURAL'` | false | `true` |
| c | `notContains` | `'neural networks'` | `'quantum'` | false | `true` |
| d | `equals` | `'foo'` | `'foo'` | false | `true` |
| e | `equals` | `'foo'` | `'FOO'` | false | `true` |
| f | `equals` | `'foo'` | `'FOO'` | true | `false` |
| g | `notEquals` | `'foo'` | `'bar'` | false | `true` |
| h | `startsWith` | `'neural'` | `'neu'` | false | `true` |
| i | `endsWith` | `'neural'` | `'ral'` | false | `true` |
| j | `matchesRegex` | `'paper-2023'` | `'\\d{4}'` | false | `true` |
| k | `matchesRegex` | `'paper'` | `'[invalid'` | — | `false` (invalid regex → no throw) |
| l | `greaterThan` | `2023` | `'2020'` | — | `true` |
| m | `lessThan` | `2019` | `'2020'` | — | `true` |
| n | `isEmpty` | `''` | — | — | `true` |
| o | `isNotEmpty` | `'value'` | — | — | `true` |
| p | `unknownOp` | `'x'` | `'x'` | — | `false` |

---

#### UT-022 — `SmartRulesEngine.evaluateConditions` — AND logic

| # | Conditions | Expected |
|---|------------|----------|
| a | `[]` (empty) | `true` (vacuous truth) |
| b | One true condition | `true` |
| c | Two true conditions | `true` |
| d | One true + one false | `false` |
| e | All false | `false` |

---

#### UT-023 — `SmartRulesEngine._validateRule`

**Method:** `_validateRule(rule)`

| # | Input | Expected |
|---|-------|----------|
| a | `{id:'1', name:'r', conditions:[], actions:[{type:'addTag',value:'x'}]}` | `true` |
| b | `{name:'r', conditions:[], actions:[{type:'addTag'}]}` (no id) | `false` |
| c | `{id:'1', conditions:[], actions:[]}` (no name) | `false` |
| d | `{id:'1', name:'r', conditions:'notarray', actions:[]}` | `false` |
| e | `{id:'1', name:'r', conditions:[], actions:[]}` (empty actions) | `false` |
| f | `null` | `false` |

---

#### UT-024 — `SmartRulesEngine.addRule` / `removeRule` / `updateRule`

Mock `getPref` to return `smartRulesEnabled:true`.

| # | Operation | Expected |
|---|-----------|----------|
| a | `addRule` with no id | Auto-generates id |
| b | `addRule` with valid rule | Appears in `getAllRules()` |
| c | `addRule` with invalid structure | Throws `Error` |
| d | `removeRule(existingId)` | Returns `true`, not in `getAllRules()` |
| e | `removeRule('nonexistent')` | Returns `false` |
| f | `updateRule(existingId, {priority:10})` | Returns updated rule; re-sorted by priority |
| g | `updateRule('nonexistent', {})` | Returns `null` |

---

#### UT-025 — `SmartRulesEngine` — priority-based rule ordering

Add three rules with priorities 5, 10, 1. Verify `getAllRules()` returns them sorted by priority descending (10, 5, 1).

---

#### UT-026 — `SmartRulesEngine.evaluate` — stopOnMatch behaviour

Mock `getPref('smartRulesEnabled')` → `true`. Create two rules both matching the item; first has `stopOnMatch:true`. Verify only the first rule's actions appear in `result.actions`.

---

#### UT-027 — `createRule` / `createCondition` / `createAction` — factory functions

| # | Function | Expected |
|---|----------|----------|
| a | `createRule()` | Has id, enabled:true, priority:0, conditions:[], actions:[], stopOnMatch:false |
| b | `createRule({name:'X', priority:5})` | Merges overrides |
| c | `createCondition('title', 'contains', 'foo')` | `{field:'title', operator:'contains', value:'foo', caseSensitive:false}` |
| d | `createAction('addTag', 'reviewed')` | `{type:'addTag', value:'reviewed'}` (no field key) |
| e | `createAction('setField', 'foo', 'title')` | `{type:'setField', value:'foo', field:'title'}` |

---

### conflictResolver.mjs — UT-028 through UT-032

#### UT-028 — `ConflictResolver.detectConflict`

**Method:** `detectConflict(zoteroState, diskState, lastSyncState)`

Pure function — no external calls.

| # | zoteroTimestamp | diskTimestamp | lastSyncTimestamp | Expected |
|---|-----------------|---------------|-------------------|----------|
| a | 100 | 200 | 150 | `null` (Zotero unchanged since sync) |
| b | 200 | 100 | 150 | `null` (disk unchanged since sync) |
| c | 200 | 200 | 100 | conflict object returned |
| d | 150 | 150 | 100 | conflict (both equal but both changed) |
| e | 50 | 50 | 150 | `null` (neither changed since sync) |

---

#### UT-029 — `ConflictResolver` — `_resolveLastWriteWins`

| # | zoteroTimestamp | diskTimestamp | Expected action |
|---|-----------------|---------------|-----------------|
| a | 200 | 100 | `apply_zotero_to_disk` |
| b | 100 | 200 | `apply_disk_to_zotero` |
| c | 150 | 150 | `apply_disk_to_zotero` (equal: disk wins by `else` branch) |

---

#### UT-030 — `ConflictResolver` — `_resolveFileExists`

Test the `resolve({type:'file_exists', ...})` dispatch with each strategy:

| # | Strategy | Expected action |
|---|----------|-----------------|
| a | `DISK_WINS` | `skip` |
| b | `ZOTERO_WINS` | `overwrite` |
| c | `KEEP_BOTH` | `rename` |
| d | `LAST_WRITE_WINS` | `rename` (default) |

---

#### UT-031 — `ConflictResolver._logConflict` / `getConflictLog` / `clearLog`

Verify log entries are prepended (most recent first), log is trimmed to `_maxLogSize`, and `clearLog()` empties it.

---

#### UT-032 — `ConflictResolver.setStrategy` — validates known values

| # | Input | Expected after |
|---|-------|----------------|
| a | `'zotero'` | `getStrategy()` returns `'zotero'` |
| b | `'invalid'` | Strategy unchanged |

---

### syncState.mjs — UT-033 through UT-036

#### UT-033 — `SyncState` — in-memory collection operations

**Class:** `SyncState` (instantiate directly; `init()` requires `Zotero.DataDirectory`)

| # | Operation | Expected |
|---|-----------|----------|
| a | `setCollection(1, {name:'A', parentID:null, folderPath:'/m/A'})` → `getCollection(1)` | Returns state with `name:'A'` |
| b | `hasCollection(1)` | `true` after set |
| c | `removeCollection(1)` → `hasCollection(1)` | `false` |
| d | `getCollectionByPath('/m/A')` | Returns `{id:1, name:'A', ...}` |
| e | `getCollectionsByParent(null)` | Returns collections with `parentID:null` |

---

#### UT-034 — `SyncState` — in-memory item operations

| # | Operation | Expected |
|---|-----------|----------|
| a | `setItem(10, {collectionIDs:[1,2], filePath:'/p/f.pdf', primaryCollectionID:1})` → `getItem(10)` | Returns state |
| b | `hasItem(10)` | `true` |
| c | `removeItem(10)` → `hasItem(10)` | `false` |
| d | `getItemByPath('/p/f.pdf')` | Returns `{id:10, ...}` |
| e | `getItemsByCollection(1)` | Returns items where `1` is in `collectionIDs` |
| f | `addItemToCollection(10, 3)` | `getItem(10).collectionIDs` contains 3 |
| g | `removeItemFromCollection(10, 1)` | `1` removed from collectionIDs, `2` still present |

---

#### UT-035 — `SyncState.getStats` and `markFullSync`

Verify `getStats()` returns `{collectionCount, itemCount, lastFullSync, isDirty}`. After `markFullSync()`, `lastFullSync` is a non-null number and `isDirty()` is `true`.

---

#### UT-036 — `SyncState.clear`

After populating both Maps, call `clear()`. Verify both maps are empty and `lastFullSync` is `null`.

---

### fileScanner.mjs — UT-037

#### UT-037 — `hasFileChanged`

**Function:** `hasFileChanged(oldInfo, newInfo)`

Pure function — no external calls.

| # | oldInfo | newInfo | Expected |
|---|---------|---------|----------|
| a | `{size:100, mtime:1000}` | `{size:100, mtime:1000}` | `false` |
| b | `{size:100, mtime:1000}` | `{size:200, mtime:1000}` | `true` |
| c | `{size:100, mtime:1000}` | `{size:100, mtime:2000}` | `true` |
| d | `null` | `{size:100, mtime:1000}` | `true` |
| e | `{size:100, mtime:1000}` | `null` | `true` |

---

### folderWatcher.mjs — UT-038

#### UT-038 — `FolderWatcher._detectChanges`

**Method:** `_detectChanges(currentState)`

Instantiate `FolderWatcher` with a stub `syncService`. Manually set `_lastScan` and call `_detectChanges`.

| # | lastScan | currentState | Expected changes |
|---|----------|--------------|------------------|
| a | `{}` | `{'/a/f.pdf': {type:'regular', mtime:1, size:10}}` | 1 × `file_created` |
| b | `{'/a/f.pdf': {type:'regular', mtime:1, size:10}}` | `{}` | 1 × `file_deleted` |
| c | `{'/a/f.pdf': {type:'regular', mtime:1, size:10}}` | `{'/a/f.pdf': {type:'regular', mtime:2, size:10}}` | 1 × `file_modified` |
| d | `{}` | `{'/a/dir': {type:'directory', mtime:1, size:0}}` | 1 × `folder_created` |
| e | `{'/a/dir': {type:'directory',...}}` | `{}` | 1 × `folder_deleted` |
| f | Mixed: folder + file created | — | Folder changes sorted before file changes |

---

### fileImporter.mjs — UT-039

#### UT-039 — `isSupportedFileType` and `filterSupportedFiles`

| # | Input | Expected |
|---|-------|----------|
| a | `'/x/paper.pdf'` | `true` |
| b | `'/x/paper.epub'` | `true` |
| c | `'/x/photo.jpg'` | `true` |
| d | `'/x/data.xyz'` | `false` |
| e | `filterSupportedFiles(['/x/a.pdf', '/x/b.xyz', '/x/c.epub'])` | `['/x/a.pdf', '/x/c.epub']` |

---

### bulkOperations.mjs — UT-040

#### UT-040 — `BulkOperations._hasGoodMetadata`

**Method:** `_hasGoodMetadata(item)`

Mock item with `getField`, `getCreators`.

| # | title | creators | Expected |
|---|-------|----------|----------|
| a | `'Deep Learning'` (no extension) | 1 creator | `true` |
| b | `'paper.pdf'` | 1 creator | `false` (looks like filename) |
| c | `''` | 1 creator | `false` |
| d | `null` | [] | `false` |
| e | `'AI'` (short, ≤5 chars) | [] | `false` |
| f | `'AI'` (short) | 1 creator | `true` (has creator) |

---

### collectionWatcher.mjs — UT-041

#### UT-041 — `CollectionWatcher._handleCollectionItemEvent` — composite ID parsing

**Method:** `_handleCollectionItemEvent(event, ids, extraData)`

Mock `syncService` with spy methods. Verify:

| # | ids | event | Expected call |
|---|-----|-------|---------------|
| a | `['5-10']` | `'add'` | `handleItemAddedToCollection(10, 5)` |
| b | `['5-10']` | `'remove'` | `handleItemRemovedFromCollection(10, 5)` |
| c | `['invalid']` | `'add'` | No call, debug log emitted |
| d | `['5-10', '6-20']` | `'add'` | Two separate calls |

---

### firstRunHandler.mjs — UT-049

UT-042 through UT-048 previously targeted private helpers of a V1 bidirectional-reconciliation design (`_relativePath`, `_parentRel`, `buildMergePlan`, etc.). That design is gone — V2 uses a simple detect → scan → confirm dialog → `importBatch` flow — so those cases were removed. Only the `no_path` guard is unit-tested today; the `fresh_install`, `path_changed`, and `normal` branches of `checkFirstRun` are not yet covered and would benefit from added unit tests.

#### UT-049 — `checkFirstRun` — no sourcePath configured

**Function:** `checkFirstRun()`

Mock `getPref('sourcePath')` → `''` (or `null`). Mock `getPref('lastWatchedPath')` → anything.

**Expected:** `{ isFirstRun: false, reason: 'no_path' }` — function returns immediately without touching the tracking store.

**Verify:** `getTrackingStore()` is never called (the tracking store getter must not be invoked when there is no path).

---

### trackingStore.mjs — UT-014b (new fields)

#### UT-014b — `createTrackingRecord` — `postImportAction` and `expectedOnDisk` defaults

**Function:** `createTrackingRecord(data)`

Two new fields were added to `TrackingRecord` to support the deletion-sync scenarios in `watchFolder.mjs` (UT-050 / UT-051):

- `postImportAction` (string): `'leave' | 'delete' | 'move'` — records the post-import disposition so subsequent passes know whether the file was supposed to vanish after import.
- `expectedOnDisk` (boolean): `true` if the file should currently exist at `path`. Set to `false` when `postImportAction === 'delete'` so the external-deletion scanner (Scenario 1) can ignore those entries.

Defaulting rule: `expectedOnDisk` uses `data.expectedOnDisk !== false` so an explicit `false` is preserved; `undefined` defaults to `true`.

| # | Input | Expected |
|---|-------|----------|
| a | `{}` | `postImportAction === 'leave'`, `expectedOnDisk === true` |
| b | `{ postImportAction: 'delete', expectedOnDisk: false }` | both preserved verbatim |
| c | `{ expectedOnDisk: false }` | `expectedOnDisk === false` (not coerced back to true) |
| d | `{ expectedOnDisk: true }` and `{ expectedOnDisk: undefined }` | both → `true` |
| e | `{ postImportAction: 'leave' \| 'delete' \| 'move' }` | all three values accepted as-is |

---

### watchFolder.mjs — UT-050, UT-051

These cases exercise the two deletion-sync scenarios added to `WatchFolderService`. The test file `test/unit/watchFolder.test.mjs` mocks `content/utils.mjs`, `fileScanner.mjs`, `fileImporter.mjs`, `trackingStore.mjs`, `fileRenamer.mjs`, `smartRules.mjs`, and `duplicateDetector.mjs`. Each `it()` constructs a fresh `WatchFolderService` instance, injects a stubbed `_trackingStore`, and adds a fake window to `service._windows`.

#### UT-050 — `WatchFolderService._handleZoteroTrash` (Scenario 2 — Zotero → disk)

**Method:** `_handleZoteroTrash(itemIDs)`

Triggered when items are moved to the Zotero trash. Behaviour is controlled by the new `diskDeleteOnTrash` pref (`ask` / `os_trash` / `permanent` / `never`). The `ask` mode opens a 3-button dialog via `Services.prompt.confirmEx`: button 0 = "Move to OS trash", button 1 = "Keep on disk", button 2 = "Delete permanently", plus a "Don't ask again" checkbox.

| # | Scenario | Expected |
|---|----------|----------|
| a | `mode=never` | No prompt, no disk action; tracking entry dropped |
| b | `mode=os_trash` | `nsIFile.initWithPath(path)` + `nsIFile.moveToTrash()` silently; no `IOUtils.remove`; no prompt |
| c | `mode=permanent` | `IOUtils.remove(path)` silently; no `moveToTrash`; no prompt |
| d | `mode=ask`, user picks button 0 (Move to OS trash) | `moveToTrash` called; `IOUtils.remove` not called |
| e | `mode=ask`, user picks button 1 (Keep on disk) | Neither `moveToTrash` nor `IOUtils.remove` called; tracking still cleared |
| f | `mode=ask`, user picks button 2 (Delete permanently) | `IOUtils.remove(path)` called; `moveToTrash` not called |
| g | `mode=ask` + "Don't ask again" checked + button 0 | `setPref('diskDeleteOnTrash', 'os_trash')` |
| h | `mode=ask` + "Don't ask again" checked + button 2 | `setPref('diskDeleteOnTrash', 'permanent')` |
| i | `mode=ask` + "Don't ask again" checked + button 1 | `setPref('diskDeleteOnTrash', 'never')` |
| j | File already missing on disk (`IOUtils.exists → false`) | No prompt, no action, tracking entry dropped |
| k | Record has `expectedOnDisk === false` (plugin already removed it post-import) | Skipped — no `moveToTrash`; tracking entry dropped |
| l | Multiple items (`[1, 2, 3]`) with `mode=ask` | Single batched prompt; one `moveToTrash` call per item; one `removeByItemID` per item |
| m | OS-trash fallback: `mode=os_trash` but `nsIFile.moveToTrash` is `undefined` (older platform) | Falls back to `IOUtils.remove(path)` |

#### UT-051 — `WatchFolderService._handleExternalDeletions` (Scenario 1 — disk → Zotero)

**Method:** `_handleExternalDeletions(diskPaths)` — `diskPaths` is a `Set<string>` of paths still present on disk after the latest scan.

For every tracking record whose `path` is no longer in `diskPaths`, the corresponding Zotero item is moved to the bin and the user gets a single batched popup. Behaviour gated by the `diskDeleteSync` pref (`auto` / `never`). Records with `expectedOnDisk === false` are always skipped (the plugin deleted those files itself post-import).

| # | Scenario | Expected |
|---|----------|----------|
| a | `mode=never` | No `Zotero.Items.getAsync`, no popup, no tracking changes |
| b | `mode=auto`, tracked file missing from disk, `importMode=stored` | `item.deleted = true`, `item.saveTx()` called, popup shown, tracking entry removed |
| c | Tracked file still on disk (path appears in `diskPaths` set) | Skipped — no Zotero call, no popup |
| d | Record has `expectedOnDisk === false` | Skipped — plugin deleted the file post-import, no Zotero call |
| e | Item missing from `Zotero.Items.getAsync` (returns `null`) | Tracking entry cleared, no popup |
| f | Item already trashed (`fakeItem.deleted === true`) | Skips `saveTx`, but still listed in the batched popup |
| g | Multiple deletions | Single batched popup; `removeByItemID` called once per record |
| h | `importMode=linked` | Popup wording contains `"linked attachments"` and `"broken file links"` |

---

## Coverage Summary

Test files live under `test/unit/`. `test/integration/` is empty — integration coverage is a future TODO.

| Module | Test file | Unit Tests |
|--------|-----------|-----------|
| `utils.mjs` | `test/unit/utils.test.mjs` | UT-001 to UT-004 |
| `fileRenamer.mjs` | `test/unit/fileRenamer.test.mjs` | UT-005 to UT-008 |
| `pathMapper.mjs` | `test/unit/pathMapper.test.mjs` | UT-009, UT-010 |
| `trackingStore.mjs` | `test/unit/trackingStore.test.mjs` | UT-011 to UT-014, UT-014b |
| `duplicateDetector.mjs` | `test/unit/duplicateDetector.test.mjs` | UT-015 to UT-020 |
| `smartRules.mjs` | `test/unit/smartRules.test.mjs` | UT-021 to UT-027 |
| `conflictResolver.mjs` | `test/unit/conflictResolver.test.mjs` | UT-028 to UT-032 |
| `syncState.mjs` | `test/unit/syncState.test.mjs` | UT-033 to UT-036 |
| `fileScanner.mjs`, `folderWatcher.mjs`, `fileImporter.mjs`, `bulkOperations.mjs`, `collectionWatcher.mjs` | `test/unit/fileScanner.test.mjs` | UT-037 to UT-041 |
| `firstRunHandler.mjs` | `test/unit/firstRunHandler.test.mjs` | UT-049 (only `no_path` guard) |
| `watchFolder.mjs` | `test/unit/watchFolder.test.mjs` | UT-050, UT-051 |

Modules with no automated coverage yet: `metadataRetriever.mjs`, `collectionSync.mjs`. (`fileImporter.mjs` was previously listed here; a sibling agent added `test/unit/fileImporter.test.mjs` this session — that table row is owned by them.)

**Total automated test cases (this section's accounting):** UT-001 through UT-041, plus UT-049, UT-050, UT-051, and the new UT-014b — 241 individual `it()` assertions across 11 test files within the rows documented above. UT-042 through UT-048 were intentionally removed when the V1 bidirectional-reconciliation handler was deleted. A 12th file (`test/unit/fileImporter.test.mjs`, covering UT-053+) was added concurrently this session and is documented by the owning agent — combined `npx vitest run` totals will be higher.

### Known documentation/test gaps

- `checkFirstRun` branches `fresh_install`, `path_changed`, and `normal` are documented in `content/firstRunHandler.mjs` but only the `no_path` branch has a unit test.
- No tests yet exercise the full `handleFirstRun` flow (dialog → scan → import); manual Test 1.10 covers it.
- `collectionSync.mjs` (the largest module at ~36 KB) has no unit tests; manual Phase 2 covers it.
- `watchFolder.mjs` is now partially covered (UT-050, UT-051) but the public surface — `start/stop`, scan loop, observer registration, `_promptDiskDelete` UI strings, and the `_moveToOSTrash` helper in isolation — is still untested.
- `fileImporter.handlePostImportAction`'s new `{ action, finalPath }` return shape has no direct unit test (only indirect coverage via UT-050 fixtures that assume a record's `expectedOnDisk` will be set correctly post-import).
