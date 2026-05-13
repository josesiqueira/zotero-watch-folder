# Updates — 2026-05-13

Final wrap-up for the day. What shipped, what was tested, what was audited, what's still broken, what needs to happen next.

---

## Releases shipped today

Four releases on `https://github.com/josesiqueira/zotero-watch-folder/releases`.

### v1.2.0 — Two-way deletion sync
- 3-button dialog when a Zotero item is moved to the bin: `Move to OS trash` / `Keep on disk` / `Delete permanently`, with "Don't ask again" persistence.
- Auto-bin popup when an imported file is externally deleted from the watch folder.
- 3 bug fixes restored from V1 testing (sanitization, title normalization, first-run guard).
- Shutdown wiring for `duplicateDetector` and `collectionSync` services.
- `handlePostImportAction` returns `{action, finalPath}` so tracking reflects actual disk state.
- vitest suite added (215 tests across 11 files).
- `docs/` folder created with five distilled design documents.

### v1.2.1 — Library-side dedup fix
- After every successful import, the SHA-256 content hash is stamped into the Zotero item's `Extra` field as `watchfolder-hash:...`.
- On plugin startup, one-pass backfill stamps any tracked item whose `Extra` doesn't yet carry the hash.
- Default `duplicateMatchHash` flipped from `false` to `true`.
- Re-installs / profile resets / `tracking.json` wipes no longer cause duplicate items in Zotero.
- 267 tests passing.

### v1.2.2 — File-move detection + UX cleanup
- When a tracked file moves within the watch folder (dragged into a subfolder), the plugin now recognizes it as a move via hash matching against untracked candidate files. No bin, no popup, no re-import.
- Preferences pane: new "About this plugin" section at the top with three short paragraphs.
- Import Mode and After-Import dropdowns removed from the visible UI (still settable via `about:config`).
- Stark1tty fork references removed from `manifest.json` and `build/package.mjs`.
- V2 icon set restored.
- 274 tests passing across 12 files.

### v1.2.3 — Bug fix + massive test coverage expansion
- **Bug fix:** `importBatch` referenced undefined variable `filePaths.length` (3 places). Any non-empty batch would have thrown `ReferenceError`. Fixed to `files.length`.
- Three new unit test files for previously-untested modules: `collectionSync.test.mjs`, `collectionWatcher.test.mjs`, `folderWatcher.test.mjs`.
- Extended `firstRunHandler.test.mjs` from 2 cases to 25 cases (all branches covered).
- Extended `fileImporter.test.mjs` from 18 cases to 29 cases (importBatch + error paths).
- **375 tests passing across 15 files** (was 274/12).

---

## What was actually tested by the user in a real Zotero install

| Smoke test | Status |
|---|---|
| **S.1** Settings render and save | Passed — pref pane opens, values persist |
| **S.2** Auto-import a PDF with metadata retrieval | Passed — "Connecting the dots" paper imported with full metadata, attachment auto-renamed |
| **S.3** Duplicate detection | Passed — same PDF dropped twice produced no second item |
| **S.4** Zotero → disk 3-button trash dialog | **NEVER FIRED. Confirmed bug.** Right-click Move Item to Bin did not show the dialog. |
| **S.5** Disk → Zotero auto-bin popup | Passed once — `rm`-ed a tracked file, popup appeared, item moved to bin |
| **S.6** First-run prompt | Unverified — tracking JSON still had records each time, so `fresh_install` branch never triggered |
| **S.7** Plugin disable/enable cleanup | Not tested |

**Score: 3 verified / 1 confirmed bug / 3 untested in a real Zotero install.**

The exhaustive verification list in `TEST_PLAN.md` (~30 cases across Phase 1/2/3/Edge) is otherwise untouched. v1.2.2's move-detection and v1.2.3's bug fix have not been verified in a real Zotero install at all.

---

## Audits performed today

Three documentation-vs-code audits, one full codebase health scan.

### PHASE1_DESIGN.md audit (v1.2.1 scope)
All core features implemented. Trash sync + hash stamping are newer than the doc body but covered by the manual checklist at the bottom. No major drift.

### PHASE2_DESIGN.md audit
Phase 2 (`collectionSync.mjs` + 5 supporting modules) is implementation-complete per spec, but with significant testing/safety caveats. As of this session: 3 new test files cover the critical paths (init/start/stop, performFullSync, collection-added/renamed/deleted, item moves, file moves, file/folder created from disk side). Still NOT covered: `handleCollectionMoved` across mirror-scope boundary, relink-failure restore path. **Phase 2 still disabled by default.** The user has never enabled it.

Specific gaps in code that the doc claims or implies:
- Conflict detection only fires for file-move conflicts, not for collection or item renames where both sides changed simultaneously
- Folder physical move on collection rename is not implemented — old folder is orphaned on disk, new folder created
- No user notification when the mirror folder goes away (silent pause)

### PHASE3_AND_PERFORMANCE.md audit
Smart rules, duplicate detection, bulk operations, adaptive polling all match the spec.

- F3.1 Smart Rules: schema, 11 condition fields, 11 operators, 4 actions — all implemented and unit-tested
- F3.2 Duplicate detection: DOI / ISBN / title-fuzzy / hash — all implemented; hash uses Extra-field stamps (v1.2.1)
- F3.3 Bulk operations: `reorganizeAll`, `retryAllMetadata`, `applyRulesToAll` all exist with dry-run + progress callbacks, **but have NO UI to trigger them**. Reachable only from a console.
- Performance: adaptive polling uses 1.2x growth (doc says 1.5x — minor doc drift; code's 1.2 is the live value). LRU caches in place.

The performance "targets" in the doc (idle CPU, RAM, latencies) are aspirational — no runtime profiling or assertions verify them.

### Whole-codebase health scan

Overall rating from the scan: **FAIR**. The plugin functions for basic use but has latent issues. Concrete findings:

**Bugs (HIGH/MEDIUM):**
- Fire-and-forget `_processQueue()` in `metadataRetriever.mjs:122/177/370` — Promises not awaited; errors silently lost; can exceed concurrency limit under load.
- `_backfillHashesForExistingItems` errors logged at `debug` level (`watchFolder.mjs:106-108`). If the backfill fails the user has no visible signal.
- Watch folder scan errors logged at debug only (`watchFolder.mjs:344-349`). A persistent failure (permission denied, disk unavailable) is invisible.

**Resource / lifecycle (MEDIUM):**
- `metadataRetriever.mjs` and `duplicateDetector.mjs` notifiers register in `init()` but only unregister in `destroy()`. If destroy isn't called (error during shutdown), they leak. Same observation for `watchFolder.mjs`.
- `_pollTimer` only cleared in `stopWatching()`. Race possible if `startWatching()` is called without a prior stop.

**Test coverage gaps (HIGH):**
- `bulkOperations.mjs` — zero tests for any of the 3 bulk operations.
- `index.mjs` — bootstrap lifecycle (onStartup / onMainWindowLoad / onShutdown) has no tests.
- `metadataRetriever.mjs` — queue logic, concurrency cap, callbacks all untested.

**Misc (LOW):**
- Path construction in `watchFolder.mjs:290-314` doesn't validate against `..` traversal in relative paths. Mitigated by Zotero's file access controls, but worth tightening.
- Build script has no validation that copy operations succeed — silent miscopy possible.

---

## Things you did NOT do (highest-priority TODOs)

### Critical — fix before next release attempt

1. **Reproduce and fix Test S.4 trash-dialog bug.** Right-click → Move Item to Bin should show the 3-button dialog. It didn't, ever, in this session. Capture Error Console output during a reproducible test. The notifier observer for `trash` events fires (log already shows `[WatchFolder] Items trashed: ...`); the failure is inside `_handleZoteroTrash` or `_promptDiskDelete`.

2. **Re-run all 7 smoke-test cases on v1.2.3.** All but S.1 and S.2 are stale — multiple releases shipped since.

3. **Verify v1.2.2 move detection and v1.2.3 fileImporter bug fix** in a real Zotero install. Neither has been tested with hands on keyboard.

4. **Fix `metadataRetriever` async-queue bugs.** Three places where `_processQueue()` Promise is dropped on the floor. Concurrent processing can exceed the `maxConcurrent` cap; errors silently disappear. ~10 line fix.

### Important — known issues to address

5. **Clean up orphan duplicates and the empty "teste de folder" collection** in your Zotero library from this session's testing rounds. Use `Edit → Find Duplicates` and merge.

6. **`tracking.json` doesn't save when every file in a scan is dedup-skipped.** Tracking entries are added in memory but `save()` is only called after a successful import. Easy fix in `_processNewFile`.

7. **Escalate `[WatchFolder] Scan error: ...` from debug to warn or error level.** If the watch folder becomes unreadable (USB unplugged, permission change), there is currently no visible signal.

### Phase 2 — implementation-complete but not safe for real libraries

8. **Add `handleCollectionMoved` test** (cross-mirror-scope move) and **`relinkAttachmentFile` failure rollback test**. Both are real code paths in `collectionSync.mjs` that the new test file explicitly skipped because the mock fixtures would balloon.

9. **Implement physical folder move when a collection is renamed/moved.** Current code updates state but leaves the old folder behind.

10. **Show user-visible warning when the mirror folder is unavailable.** Currently silent.

11. **Add pre-change conflict detection for collection/item renames.** Currently only file-move conflicts fire `detectConflict()`.

### Phase 3 — features exist but no entry points or testing

12. **Build a UI for bulk operations.** `bulkOperations.mjs` has three operations that can only be triggered from a console. Add three buttons to the preferences pane.

13. **Build a UI (or even a textarea) for smart rules.** Rules are JSON-only via `about:config` today.

14. **End-to-end test Phase 3 features** (DOI/ISBN/title-fuzzy/hash dedup in real Zotero, smart rules applied to real imports, bulk operations on a real library). Currently zero hands-on verification.

15. **Write tests for `bulkOperations.mjs`, `index.mjs`, `metadataRetriever.mjs`.** Three modules with zero coverage — flagged HIGH by the health scan.

### Cloud storage and backup — recommendations made, not validated

16. **`pCloud Sync` (real local copy) recommended over `pCloud Drive` (virtual mount).** Logic is sound but not validated. Same caveat for Dropbox, iCloud, OneDrive.

17. **README should document the watch-folder-as-backup pattern** for users without paid Zotero storage. It's a real selling point.

---

## What success looks like

For this plugin to be "ready for a non-developer to install and rely on":

1. **All 7 smoke-test cases pass on a clean v1.2.3 install.** Currently 3/7.
2. **Test S.4 (3-button trash dialog) bug is fixed.** Only confirmed shipping bug.
3. **`metadataRetriever` async-queue bugs fixed.** Latent but real.
4. **README "Quick Start" section** with screenshots or a short GIF. Currently links to a developer-targeted `TEST_PLAN.md`.
5. **Phase 2 either explicitly gated behind a "experimental" warning** in the UI, or properly hardened (physical folder move, mount-unavailable notification, full integration tests).
6. **Phase 3 bulk operations get a UI** (3 buttons) and smart rules get at least a textarea + Validate button.
7. **At least one user other than you has run it for a full week** on a real library.
8. **Tests added for `bulkOperations.mjs`, `metadataRetriever.mjs`, `index.mjs`** lifecycle.

Items 1-3 are short effort, unblock real-world testing. Items 4-8 are longer tail but each meaningfully reduces the chance of someone hitting a bug we missed.

---

## Suggested order for the next session

Rough priority:

1. **Reproduce + fix Test S.4 trash-dialog bug.** Should be the first hour. Captures the only confirmed shipping bug.
2. **Fix `metadataRetriever` async-queue bugs.** ~30 minutes including tests.
3. **Re-run S.4, S.6, S.7** properly with logging captured.
4. **Verify v1.2.2 move detection and v1.2.3 fileImporter fix** by actually using them.
5. **Clean up your Zotero library** from this session's testing artifacts (Find Duplicates flow).
6. **Add README Quick Start** section.
7. **Decide on Phase 2:** invest in hardening (folder move + mount-unavailable + conflict timing + integration tests) or formally mark as experimental in the UI.
8. **Add bulk operations UI** (lowest-effort Phase 3 win).
9. **Add tests for `bulkOperations.mjs`, `metadataRetriever.mjs`, `index.mjs`** lifecycle.

---

## Test inventory at end of session

| File | Tests | Notes |
|---|---|---|
| `test/unit/utils.test.mjs` | ~30 | Sanitization, hash, prefs, file ops |
| `test/unit/fileRenamer.test.mjs` | ~25 | Template rendering, validation |
| `test/unit/pathMapper.test.mjs` | ~25 | Path↔collection, sanitize, cache |
| `test/unit/trackingStore.test.mjs` | 25 | Includes UT-014b for new fields |
| `test/unit/duplicateDetector.test.mjs` | ~40 | DOI/ISBN/title/hash + Levenshtein |
| `test/unit/smartRules.test.mjs` | ~35 | Conditions/operators/actions |
| `test/unit/conflictResolver.test.mjs` | ~20 | All 5 strategies |
| `test/unit/syncState.test.mjs` | ~15 | Load/save/migration |
| `test/unit/fileScanner.test.mjs` | ~20 | Recursive, filter, stability |
| `test/unit/firstRunHandler.test.mjs` | 25 | All branches incl. UT-054-063 |
| `test/unit/watchFolder.test.mjs` | ~30 | UT-050/051/052/053: trash, deletion, backfill, moves |
| `test/unit/fileImporter.test.mjs` | 29 | UT-053..073 |
| `test/unit/collectionSync.test.mjs` | 11 blocks | NEW: UT-054..064 |
| `test/unit/collectionWatcher.test.mjs` | ~16 | NEW: UT-065 sub-cases |
| `test/unit/folderWatcher.test.mjs` | ~12 | NEW: UT-066 sub-cases |
| **Total** | **375** | **15 files** |

**Still no tests for:** `bulkOperations.mjs`, `metadataRetriever.mjs`, `index.mjs` lifecycle, `watchFolder.mjs` scan/start/stop loop (only the deletion/trash/move handlers are covered).

---

## Code locations relevant to the open work

| Area | File |
|---|---|
| Trash-dialog bug (S.4) | `content/watchFolder.mjs` `_handleZoteroTrash` (~line 605), `_promptDiskDelete` (~line 660) |
| metadataRetriever async bugs | `content/metadataRetriever.mjs:122`, `:177`, `:370` |
| Tracking JSON save-on-dedup-skip | `content/watchFolder.mjs` `_processNewFile` step 2 |
| Phase 2 orchestrator | `content/collectionSync.mjs` (~1000 lines) |
| Phase 2 missing: folder physical move | `content/collectionSync.mjs` `handleCollectionRenamed`, `handleCollectionMoved` |
| Smart rules UI gap | `content/preferences.xhtml` + `content/smartRules.mjs` |
| Bulk operations UI gap | `content/preferences.xhtml` + `content/bulkOperations.mjs` |
| README Quick Start | `README.md` |
| Manual smoke test cases | `TEST_PLAN.md` top section (S.1-S.7) |
| Design docs | `docs/ARCHITECTURE.md`, `docs/PHASE1_DESIGN.md`, `docs/PHASE2_DESIGN.md`, `docs/PHASE3_AND_PERFORMANCE.md`, `docs/MODULE_DEPENDENCIES.md` |

All tests in `test/unit/`. Run with `npm test`. 375 passing across 15 files.

---

## Honest summary

The plugin is in a much better state than this morning. Two-way deletion sync, file-move detection, library-side dedup, and 161 new tests all shipped. The codebase isn't perfect — there are latent bugs in `metadataRetriever`, the trash dialog has a confirmed bug, and Phase 2 / Phase 3 have implementation but no UI or end-to-end testing.

That said, **none of the remaining issues are showstoppers for a single-user workflow**. You can use this plugin on your own library tomorrow. The TODO list is what stands between "I use it" and "I share it with my friends".

Start the next session with the trash dialog bug. The rest can wait.
