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
- [ ] Copy 3 PDFs to inbox
- [ ] Change Source Folder to a different path, then back to inbox
- [ ] Enable Watch Folder

**Expected:**
- Dialog appears asking to import existing files
- All 3 files are imported as a batch
- Debug console shows: `[WatchFolder] First run handled, imported 3 files`

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

The cases below are implemented in the `test/` directory and run via `npm test`. Use them as acceptance criteria when modifying the corresponding modules.

These cases were ported from the V1 TEST-PLAN. Unit tests (UT-xxx) target pure or near-pure logic by mocking the few Gecko/Zotero globals they touch (`Zotero.debug`, `Zotero.Prefs`, `IOUtils`, `PathUtils`, `crypto.subtle`). Integration tests (IT-xxx) need a fuller mocked Zotero environment (`Zotero.Items`, `Zotero.Collections`, `Zotero.Attachments`, `Zotero.Search`, `Zotero.Notifier`, `Zotero.Libraries.userLibraryID`).

### Recommended Vitest Setup

```
// vitest.config.mjs
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',  // or 'jsdom'
    setupFiles: ['./test/setup/geckoMocks.js']
  }
});
```

The mock shim (`geckoMocks.js`) needs to expose on `globalThis`:
- `Zotero.debug`, `Zotero.logError`, `Zotero.Prefs.get`, `Zotero.Prefs.set`
- `IOUtils.exists`, `IOUtils.stat`, `IOUtils.read`, `IOUtils.readJSON`, `IOUtils.writeJSON`, `IOUtils.getChildren`, `IOUtils.makeDirectory`, `IOUtils.move`, `IOUtils.remove`
- `PathUtils.join`, `PathUtils.filename`, `PathUtils.parent`
- `crypto.subtle.digest`

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

UT-042 through UT-048 previously targeted private helpers of a different (bidirectional reconciliation) design and have been removed along with that code path.

#### UT-049 — `checkFirstRun` — no sourcePath configured

**Function:** `checkFirstRun()`

Mock `getPref('sourcePath')` → `''` (or `null`). Mock `getPref('lastWatchedPath')` → anything.

**Expected:** `{ isFirstRun: false, reason: 'no_path' }` — function returns immediately without touching the tracking store.

**Verify:** `getTrackingStore()` is never called (the tracking store getter must not be invoked when there is no path).

---

## Integration Tests

Integration tests require a more complete Zotero mock: `Zotero.Items`, `Zotero.Collections`, `Zotero.Attachments`, `Zotero.Search`, `Zotero.Notifier`, `Zotero.Libraries.userLibraryID`. Use Vitest with a custom mock factory that returns fake Zotero item/collection objects.

### utils.mjs — IT-001 through IT-004

#### IT-001 — `getOrCreateTargetCollection` — finds existing collection

Mock `Zotero.Collections.getByLibrary` to return a collection with `name:'Inbox'`. Call `getOrCreateTargetCollection('Inbox')`. Verify the existing collection is returned and `saveTx()` is NOT called.

---

#### IT-002 — `getOrCreateTargetCollection` — creates new collection

Mock `Zotero.Collections.getByLibrary` to return empty array. Mock `new Zotero.Collection()`. Verify `saveTx()` is called once.

---

#### IT-003 — `getOrCreateTargetCollection` — empty name returns null

Call with `''` or `'  '`. Verify result is `null` and no Zotero call is made.

---

#### IT-004 — `getFileHash` — SHA-256 calculation

Mock `IOUtils.read` to return a known byte array. Mock `crypto.subtle.digest` to return a known hash buffer. Verify returned hex string matches expected.

Edge case: `IOUtils.read` throws → returns `null`.

---

### fileScanner.mjs — IT-005 through IT-013

#### IT-005 — `scanFolder` — normal directory

Mock `IOUtils.exists` → `true`, `IOUtils.stat(folderPath)` → `{type:'directory'}`, `IOUtils.getChildren` → `['/watch/a.pdf', '/watch/b.txt']`. Mock per-file stats. Mock `isAllowedFileType` (or mock pref) so only `.pdf` passes.

Expected: returns `[{path:'/watch/a.pdf', mtime:..., size:...}]`.

---

#### IT-006 — `scanFolder` — folder does not exist

Mock `IOUtils.exists` → `false`. Expected: returns `[]`.

---

#### IT-007 — `scanFolder` — path is a file, not directory

Mock `IOUtils.stat` → `{type:'regular'}`. Expected: returns `[]`.

---

#### IT-008 — `scanFolder` — permission error

Mock `IOUtils.getChildren` to throw `{name:'NotAllowedError'}`. Expected: returns `[]` (no throw propagated).

---

#### IT-009 — `scanFolderRecursive` — maxDepth prevents infinite loops

Mock a deep directory tree. Call with `maxDepth=2`. Verify directories beyond depth 2 are not recursed.

---

#### IT-010 — `isFileStable` — stable file

Mock `IOUtils.stat` to return same size on both calls. Mock `delay` to be instant. Expected: `true`.

---

#### IT-011 — `isFileStable` — file still growing

Mock `IOUtils.stat` to return increasing sizes. Expected: `false`.

---

#### IT-012 — `isFileStable` — zero-size file

Mock `IOUtils.stat` → `{size:0}`. Expected: `false` (without even waiting for second check).

---

#### IT-013 — `isFileStableWithRetry` — succeeds on second attempt

First call to `isFileStable` returns `false`, second returns `true`. Verify overall return is `true`.

---

### fileImporter.mjs — IT-014 through IT-021

#### IT-014 — `importFile` — stored mode

Mock `IOUtils.exists` → `true`. Mock `Zotero.Attachments.importFromFile` to return a fake item. Mock `getOrCreateTargetCollection`. Verify `importFromFile` called with correct arguments.

---

#### IT-015 — `importFile` — linked mode

Mock prefs: `importMode:'linked'`. Verify `Zotero.Attachments.linkFromFile` is called instead of `importFromFile`.

---

#### IT-016 — `importFile` — file does not exist

Mock `IOUtils.exists` → `false`. Expect the function to throw an error with message containing "does not exist".

---

#### IT-017 — `handlePostImportAction` — delete mode

Mock `IOUtils.remove`. Verify it is called with the correct file path.

---

#### IT-018 — `handlePostImportAction` — move mode

Mock `PathUtils.parent`, `PathUtils.join`, `IOUtils.exists`, `IOUtils.makeDirectory`, `IOUtils.move`. Verify file is moved to `<parent>/imported/<filename>`.

---

#### IT-019 — `handlePostImportAction` — leave mode

Verify neither `IOUtils.remove` nor `IOUtils.move` is called.

---

#### IT-020 — `importBatch` — progress callback

Call `importBatch` with 3 files. Provide an `onProgress` spy. Verify it is called 3 times with `(1,3)`, `(2,3)`, `(3,3)`.

---

#### IT-021 — `importBatch` — continues after individual failure

Mock one file to throw during import. Verify other files are still imported and the failed one appears in `results.failed`.

---

### duplicateDetector.mjs — IT-022 through IT-027

#### IT-022 — `DuplicateDetector.findByDOI` — normalisation

Mock `Zotero.Search` to return a result when queried with the normalised DOI. Test variants:

| # | Input DOI | Normalised DOI searched |
|---|-----------|-------------------------|
| a | `'https://doi.org/10.1000/xyz'` | `'10.1000/xyz'` |
| b | `'doi:10.1000/xyz'` | `'10.1000/xyz'` |
| c | `'10.1000/xyz'` | `'10.1000/xyz'` |
| d | `'HTTP://DX.DOI.ORG/10.1000/xyz'` | `'10.1000/xyz'` |

---

#### IT-023 — `DuplicateDetector.checkDuplicate` — respects disabled flag

Mock `getPref('duplicateCheck')` → `false`. Verify `checkDuplicate` returns `{isDuplicate:false}` without calling any search.

---

#### IT-024 — `DuplicateDetector.checkDuplicate` — DOI takes priority over title

If DOI matches, title check should NOT be performed. Verify `findByTitle` spy is not called.

---

#### IT-025 — `DuplicateDetector.storeContentHash` — modifies Extra field

Mock `IOUtils.read`, `crypto.subtle.digest`, and item's `getField('extra')` / `setField` / `saveTx`. Verify:
- Hash is appended to Extra in format `watchfolder-hash:<hex>`
- Existing `watchfolder-hash:` entry is replaced, not duplicated

---

#### IT-026 — `DuplicateDetector.handleDuplicate` — skip action

Mock `getPref('duplicateAction')` → `'skip'`. Verify action returned is `'skip'` and `item.addTag` is NOT called.

---

#### IT-027 — `DuplicateDetector.handleDuplicate` — import+tag action

Mock `getPref('duplicateAction')` → `'import'`. Verify `item.addTag('_duplicate')` is called and `item.saveTx()` is called.

---

### trackingStore.mjs — IT-028 through IT-030

#### IT-028 — `TrackingStore.save` and `load` — serialisation round-trip

Mock `IOUtils.writeJSON` to capture what is written. Mock `IOUtils.readJSON` to return that captured data. After `save()` then `load()`, verify all records are restored identically.

---

#### IT-029 — `TrackingStore.load` — corrupt JSON

Mock `IOUtils.readJSON` to throw `SyntaxError`. Verify store initialises with empty map (no throw propagated).

---

#### IT-030 — `TrackingStore.load` — invalid data structure

Mock `IOUtils.readJSON` → `{version:1, records:'not-an-array'}`. Verify store initialises with empty map.

---

### smartRules.mjs — IT-031 through IT-037

#### IT-031 — `SmartRulesEngine.getOrCreateCollectionPath` — nested path creation

Mock `Zotero.Collections.getByLibrary` to return empty collections. Mock `new Zotero.Collection()` factory. Call `getOrCreateCollectionPath('A/B/C')`. Verify 3 collections are created with correct parent IDs.

---

#### IT-032 — `SmartRulesEngine.getOrCreateCollectionPath` — existing path

Mock `Zotero.Collections.getByLibrary` to return a collection tree `A > B > C`. Verify no `saveTx()` calls are made — existing collections are reused.

---

#### IT-033 — `SmartRulesEngine.executeAction` — addToCollection

Mock `getOrCreateCollectionPath`. Mock item with `getCollections()` returning `[]`, `addToCollection()`, `saveTx()`. Verify `addToCollection` and `saveTx` are called.

---

#### IT-034 — `SmartRulesEngine.executeAction` — addTag

Mock item with `getTags()` returning `[]`. Verify `addTag` and `saveTx` called.

---

#### IT-035 — `SmartRulesEngine.executeAction` — addTag — no duplicate tag

Mock item `getTags()` returning `[{tag:'reviewed'}]`. Call with `addTag, 'reviewed'`. Verify `saveTx` is NOT called (tag already present).

---

#### IT-036 — `SmartRulesEngine.executeAction` — setField

Mock item with `setField`, `saveTx`. Verify `setField('notes', 'imported')` and `saveTx` called.

---

#### IT-037 — `SmartRulesEngine.executeAction` — setField — missing field name

Call `executeAction({type:'setField', value:'foo'}, item)` (no `field` property). Verify returns `false`.

---

### metadataRetriever.mjs — IT-038 through IT-040

#### IT-038 — `MetadataRetriever.queueItem` — deduplication

Set `_isRunning = false` (to prevent processing). Queue same itemID twice. Verify `_queue.length === 1`.

---

#### IT-039 — `MetadataRetriever._hasMetadata` — attachment with titled parent

Mock parent item returned by `Zotero.Items.get` with `getField('title')` returning a real title. Verify `_hasMetadata` returns `true`.

---

#### IT-040 — `MetadataRetriever._hasMetadata` — attachment whose title is a filename

Mock parent `getField('title')` → `'paper.pdf'`. Verify returns `false`.

---

### watchFolder.mjs — IT-041 through IT-042

#### IT-041 — `WatchFolderService._waitForFileStable`

Access `_waitForFileStable` via class instantiation or expose for test. Mock `IOUtils.stat` and `delay`.

| # | Scenario | Expected |
|---|----------|----------|
| a | Size stable after first check (same as initial) | `true` on first comparison |
| b | Size stabilises on second attempt | `true` |
| c | Size never stable over maxAttempts | Falls through to final stat check |
| d | File disappears during check | `false` |

---

#### IT-042 — `WatchFolderService.handleNotification` — delete event

Mock `_trackingStore.removeByItemID`. Call `handleNotification('delete', 'item', [42], {})`. Verify `removeByItemID(42)` called.

---

### firstRunHandler.mjs — IT-043 through IT-045

IT-051 through IT-080 previously targeted the bidirectional reconciliation API (`matchInventories`, `executeDiskToZotero`, `executeZoteroToDisk`, `_getOrCreateCollectionFromPath`) and have been removed along with that code path. The remaining cases cover `checkFirstRun` on V2's simpler flow.

#### IT-043 — `firstRunHandler.checkFirstRun` — fresh install

Mock prefs: `sourcePath:'/watch'`, `lastWatchedPath:''`. Mock `trackingStore.getStats()` → `{total:0}`. Verify returns `{isFirstRun:true, reason:'fresh_install'}`.

---

#### IT-044 — `firstRunHandler.checkFirstRun` — path changed

Mock prefs: `sourcePath:'/new'`, `lastWatchedPath:'/old'`. Verify `{isFirstRun:true, reason:'path_changed'}`.

---

#### IT-045 — `firstRunHandler.checkFirstRun` — normal run

Mock prefs: `sourcePath:'/watch'`, `lastWatchedPath:'/watch'`. Mock `trackingStore.getStats()` → `{total:5}`. Verify `{isFirstRun:false, reason:'normal'}`.

---

### pathMapper.mjs — IT-046 through IT-050

#### IT-046 — `PathMapper.getPathForCollection` — path construction

Mock `PathUtils.join` to use simple string concatenation. Mock `Zotero.Collections.get` to return parent collections. Call `getPathForCollection` on a nested collection. Verify the path includes all ancestor sanitized names.

---

#### IT-047 — `PathMapper.getPathForCollection` — cache behaviour

Call twice for same collection. Verify `Zotero.Collections.get` is called only once (second call uses cache).

---

#### IT-048 — `PathMapper.getUniqueFilePath` — no conflict

Mock `IOUtils.exists` → `false`. Verify returns `folderPath/desiredFilename`.

---

#### IT-049 — `PathMapper.getUniqueFilePath` — conflict resolution

Mock `IOUtils.exists` → `true` for first 2 attempts, then `false`. Verify returns filename with ` (2)` suffix.

---

#### IT-050 — `PathMapper.getUniqueFilePath` — exceeds 100 attempts

Mock `IOUtils.exists` always `true`. Verify throws `Error('Could not find unique filename')`.

---

## Coverage Summary

| Module | Unit Tests | Integration Tests |
|--------|-----------|-------------------|
| `utils.mjs` | UT-001 to UT-004 | IT-001 to IT-004 |
| `fileScanner.mjs` | UT-037 | IT-005 to IT-013 |
| `fileRenamer.mjs` | UT-005 to UT-008 | — |
| `fileImporter.mjs` | UT-039 | IT-014 to IT-021 |
| `trackingStore.mjs` | UT-011 to UT-014 | IT-028 to IT-030 |
| `duplicateDetector.mjs` | UT-015 to UT-020 | IT-022 to IT-027 |
| `smartRules.mjs` | UT-021 to UT-027 | IT-031 to IT-037 |
| `conflictResolver.mjs` | UT-028 to UT-032 | — |
| `pathMapper.mjs` | UT-009, UT-010 | IT-046 to IT-050 |
| `syncState.mjs` | UT-033 to UT-036 | — |
| `collectionWatcher.mjs` | UT-041 | — |
| `folderWatcher.mjs` | UT-038 | — |
| `metadataRetriever.mjs` | — | IT-038 to IT-040 |
| `watchFolder.mjs` | — | IT-041 to IT-042 |
| `bulkOperations.mjs` | UT-040 | — |
| `firstRunHandler.mjs` | UT-049 | IT-043 to IT-045 |

**Total automated test cases:** 49 Unit + 80 Integration = 129
