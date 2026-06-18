# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Zotero plugin that polls a folder, imports new PDFs into a target collection, dedupes them, and optionally moves/renames the source files. Targets Zotero 7/8/9 (`strict_min_version: 6.999`, `strict_max_version: 9.*`). Live-verified on Zotero 9.0.4 (platform 140.10.0) — see "Zotero 9 verification" note below.

Plugin ID: `watch-folder@zotero-plugin.org`. Version lives in `package.json` AND `manifest.json` — keep them in sync. **Current: `2.6.4`** (patch — testing-feedback features + a data-safety fix). v2.6.4 came out of a multi-agent investigation of live user testing feedback + an ultracode verification pass (fix-then-ship→shipped), and adds five things on top of 2.6.3:
- **FEAT-DASHBOARD:** `storageStrategy.accountingReport()` (read-only; items / stored vs linked / storedBytes / watch-folder usage / **trashed-attachment count+bytes**) surfaced via a prefs "Storage report" button. The watch-folder walk is depth-capped (symlink-loop guard) and skips `imported/` + `.zotero-watch-trash/`.
- **FEAT-EMPTY-TRASH:** `storageStrategy.emptyZoteroTrash()` (typeof-guarded delegation to `Zotero.Items.emptyTrash`; never deletes inside `storage/`) + a prefs button. Permanent, library-wide; behind a `confirmEx` with **Cancel as the default-focused button** (`BUTTON_POS_1_DEFAULT`).
- **UX-MISSING-1:** `trackingStore.getMissingFiles()` + `suppressionResolver.listMissing()`/`stopTrackingMissing()` (tracking-only — no Zotero delete/trash/tombstone, fail-closed, snapshot-rollback) + a prefs "Files removed from disk (kept in Zotero)" panel. The prefs "Stop tracking" passes the STRING localPath (the resolver rejects a record object).
- **DATEFMT-1:** a `{date}` filename token from the item's PUBLICATION date via `fileRenamer.formatPartialDate` (dd.mm.yyyy → mm.yyyy → yyyy; month 0-index +1). Additive; default pattern unchanged.
- **FOLDER-RENAME-EMPTY (data-safety):** `watchFolder._detectFolderRenames` now excludes dead-state collection records (OUT_OF_SCOPE_SUPPRESSED / USER_DETACHED / CONFLICT_BLOCKED / PAUSED / RECOVERABLE / MISSING) from the empty-folder 1:1 orphan count — a single lingering dead orphan under the same parent was poisoning the count, silently disabling a legitimate rename and letting the mode-3 deletion pass trash-and-recreate the renamed empty collection (lost the key). Guarded by `watchFolder.test.mjs` UT-FRE(f), which seeds a dead suppressed orphan. **NOTE: the unit fix is rigorous but the live mode-3 end-to-end re-trace was not cleanly confirmed (bridge/scan-timing) — worth a hands-on UI confirmation.**

**Working-as-designed (NOT bugs — do not "fix"):** the "7 PDFs → 4 imported" dedup (content-hash, byte-identical copies collapse) and "multiple name-variant copies → one Zotero item + all disk copies kept" (shadow records) are correct and intentional.

Prior: **v2.6.3 (released)** — launch-readiness data-safety batch from a multi-agent deploy-readiness audit (HOLD→GO), four data-safety fixes + three hardenings on top of the 2.6.2 prefs-UX/docs work:
- **SYNC-1 (blocker):** the Mode 3 folder-deletion pass (`notifyScanCycle` → `folderEventDetector.detectFolderEvents` → `_localFolderDeleted`) is now gated behind `isWatchRootAvailable` at BOTH the `watchFolder._scan` call site AND inside `detectFolderEvents`, so a transient unmount/cloud-drop can no longer make every tracked folder look deleted and mass-trash collections + clean attachments.
- **DATA-1 (high):** the Zotero→local delete gate in `watchFolder._handleZoteroTrash` (and the per-child gate in `mirrorExecutor`) is now **fail-CLOSED** — delete only on `gate.ok`; every other reason (invalid-record/no-baseline-hash, io-error, hash-failed, hash-drifted) → CONFLICT_BLOCKED, keep. (Was fail-open: deleted on anything except hash-drifted.)
- **FS-1 (high):** new `canonicalPath.sanitizeCollectionNameSegment` + `collectionKeyToDiskRelativePath` (additive, layered AFTER `isUnsafeCollectionNameSegment`); the 4 baseline/storageStrategy disk producers AND the live emitters (`collectionWatcher` dispatch, `itemMembershipHandler._recomputeCanonicalIfChanged`) use the disk variant so Windows-reserved/illegal collection names (CON, `Re:port?`) mirror to a sanitized folder and the stored localPath round-trips.
- **UX-1 (high):** `_promptDiskDelete` never PERSISTS `permanent` (downgrades to `plugin_trash` + one-time alert; per-batch return unchanged); new Mode-3 deletion-disposition picker in `preferences.{xhtml,js}` (`changeDiskDeleteOnTrash` / `DELETION_DISPOSITIONS` = ask/plugin_trash/os_trash/never, no permanent) with a revert row.
- **IMPORT-1 / DATA-3 / DATA-4:** `_waitForFileStable` requires size+mtime stable + a `.pdf`-gated `%PDF-`/`%%EOF` sanity check (non-PDF allowed types import on convergence; no `size>0` fallback); atomic tracking-store write (`writeJSON {tmpPath}`); config-time `utils.isWatchRootUnsafe` rejects a watch root overlapping the Zotero data/storage dir (wired in `index._commitWizardResult` + `preferences.browseForFolder`).
- Plus the **2.6.2 settings UX** (clickable mode/storage option cards with `✓ current` badge, `★ Best for WebDAV` badge + hint), **readability fixes**, the **revamped README** (badges + teaser + Contributors via contrib.rocks, emoji-free), and the **public `docs/` folder** (`docs/DEVELOPERS.md` + `docs/architecture.md`).

**813 unit tests across 25 files** (added: SYNC-1 folderEventDetector UT-607a/b + watchFolder UT-608; DATA-1 fail-closed + updated UT-090/091/094 fixtures; FS-1 canonicalPath UT-206/207/208 + collectionWatcher UT-302-FS1 + itemMembershipHandler revert guard; UX-1 watchFolder UT-096a-d + new `preferences.test.mjs`; DATA-4 utils UT-007a-j; IMPORT-1 UT-IMPORT-1a-k; DATA-3 trackingStore UT-117; new `syncCoordinator.test.mjs` for the mode3→mode1 observer). **30 prefs unchanged.** Plan + audit detail: `.private/docs/LAUNCH_PLAN_2.6.3.md`. Prior: v2.6.1 (patch — safety fix) makes the "Reclaim Zotero Storage" child-item check **fail-closed**: `storageStrategy._classifyAttachmentChildren` now keeps a stored PDF stored unless it can confidently prove zero annotations AND zero notes — a missing/throwing/odd-shaped `getAnnotations`/`getNotes` returns a specific kept-stored reason (`annotation-status-unknown` / `note-status-unknown` / `child-status-unknown`) instead of being presumed safe. Closes the v2.6.0 fail-open gap where an unevaluable annotation API could let an annotated PDF convert and orphan its highlights. **711 unit tests across 23 files** (added UT-907 ×9). Prior: v2.6.0 (minor) — three tracks: (1) **Mode 2/3 deletion-safety hardening** — `canSafelyMove` local-hash gate + new `canSafelyTrashZoteroAttachment` Zotero-freshness gate on every delete path (Zotero-trash→local, local-delete→Zotero-trash, collection-delete→local-folder), Mode 2 (and Mode 3 `never`/failed-trash) **suppress-not-drop** to kill the re-import loop, adopt-into-scope on `collection-item` add after baseline, and the `deleteFolder` action split into `zoteroCollectionDeleted` (trash the local folder) / `localFolderDeleted` (bulk-safe-propagate to Zotero); (2) **docs split** — user-friendly `README.md` + technical `DEVELOPERS.md`; (3) **PDF storage-strategy layer** — `pdfStorageStrategy` (`stored` / `linked_watch_folder` / `stored_plus_mirror`), orthogonal to `mode`, with prefs-pane "Reclaim Zotero Storage" (conservative stored→linked, hash-verified, skips annotated, recoverable) + "Build/Repair Mirror" tools and a wizard step. **702 unit tests across 23 files.** Prior: v2.5.1 (patch — refreshed in-XPI bundled docs to match GH Pages; no code change vs 2.5.0). v2.5.0 ships the full WP-A/B/C performance pass (module-level hash cache, tombstone + shadow indexes on the tracking store, debounced save, memoized canonical-path lookups, precompiled smart-rule regexes, set-based metadata-retriever dedup, parallel `_moveFolder` child rewrites, `canSafelyMove` cache adoption, baseline B.7 size pre-filter, notifier debounce + per-collection coalescing), four small bug fixes (S.7 `enabled` pref-toggle observer, bulk-prompt re-entrancy guard, WP-B2 consumer adoption, `WatchFolderService.destroy` flush ordering), the wizard step-2 `Zotero is not defined` fix, the prefs-pane redesign (live mode picker, doc links to bundled HTML, advanced disclosure, Smart Rules in a separate window), and a `Zotero.WatchFolder.__perf` telemetry hook. **669 unit tests**.

## v2 status — read this before editing

The codebase has completed the v2 rewrite from the library-root-scoped model to a **sync-root-scoped, mode-based** model. Spec: `.private/legacy/updates_22_05_26.md` (maintainer-only). Long-form tour of current state: `.private/docs/CODEBASE_OVERVIEW.md`.

**v2.0 → v2.4.1 (shipped 2026-05-22 → 2026-05-27)** built up the sync-root-scoped, mode-based architecture in waves: **v2.0** Mode 1 import-only (sync-root concept + tracking-v2 schema + identity-by-attachment-key + `canonicalPath.mjs`); **v2.1** Mode 2 mirror (`collectionWatcher` / `folderEventDetector` / `itemMembershipHandler` / `mirrorExecutor` with per-key promise-chain locks, `baseline.mjs` B.2/B.6/B.7, `warningSink`, `suppressionResolver` with 4-action UX) **+ Track A polish** (resolveCollection / resolveConflict + singleton TrackingStore + the `_moveItem`/`_moveFolder` lock-race fixes); **v2.2** Mode 3 safe-delete (cascading-trash fix, `.zotero-watch-trash/` recoverable trash dir, full RST.1–6 restore matrix via tombstones, `bulkGuard.mjs`, runtime `enabled` pref observer, deletion of dormant `bulkOperations.mjs`); **v2.3.0** stable cut + Zotero 9.0.4 live verification (no Zotero-9-specific code changes needed); **v2.3.1** security hardening (`isUnsafeCollectionNameSegment` path-traversal defense + `nsIFile.isSymlink` skip); **v2.3.2** trashed-sync-root hardening (`SyncRootMissingError`); **v2.4.0** C1 single-pane setup wizard (`content/setupWizard.{xhtml,js}`); **v2.4.1** wizard color fix + LOW security hardenings (ReDoS cap on `smartRules.matchesRegex` + proto-pollution `sanitizeUntrustedKeys`).

**The invariants those waves established are codified in "Don't touch without understanding" below** — read that section before touching any of: hash strategy, deletion conflict gates, mode gating, shadow records, tombstones, per-key executor locks, suppress-not-drop, sync-root scoping, the recoverable trash dir, or baseline idempotency. Per-phase file/line/test detail (the original phase-by-phase release-notes narrative) lives in `.private/docs/RELEASE_HISTORY.md`.

**Three sync modes** (`mode` pref): `mode1` (import only — Phase A v2.0), `mode2` (mirror without delete — v2.1), `mode3` (mirror with safe delete — v2.2).

## Keep `index.html`, `test-plan.html`, and `test-cases.html` in sync at every checkpoint

Three user-facing HTML pages at the repo root:
- `index.html` — landing page (overview, features, configure, FAQ, roadmap).
- `test-plan.html` — user-story walkthrough in five chapters (setting up, day-to-day, something looks off, changing setup, second device). Source: drilled down from the technical runbooks and the inclusion/exclusion matrix.
- `test-cases.html` — the two-column behavior spec: every plugin behavior classified as **Inclusion** (something the plugin acts on — imports, copies, restores) or **Exclusion** (something the plugin refuses — duplicates, wrong types, conflicts, suppression). 25 + 29 cases. Coverage is enforced: if a behavior isn't on this page, it's a gap in the plugin OR a gap in the spec.

**Whenever you complete a checkpoint** — feature ships, version bumps, TODO items close, mode behavior changes, scenarios added/changed in the MCP runbooks — refresh both pages so they reflect reality. The pages must never describe features or scenarios that don't ship in the current bundle.

Things to refresh on a checkpoint (index.html):
- Version badge in the hero eyebrow + footer (`v2.2.0-alpha.1` today).
- Hero meta strip (test count, sync modes, prefs count, release-blocking count).
- Modes section (`#modes`) — what each mode does in the current bundle.
- Features grid (`#features`) — only list capabilities that work end-to-end.
- Configure table (`#configure`) — pref keys + defaults + behavior, mirrored from `prefs.js`.
- Roadmap list (`#roadmap`) — move items between Done / Next / Future as the project evolves.
- Footer "Last updated" date.

Things to refresh on a checkpoint (test-plan.html):
- Chapter story counts in the TOC + each chapter's "N stories" sub-label.
- Story cards — add when new user-visible behavior ships; update the "What should happen" lines when behavior changes.
- Per-story technical-case footnote (`Covers:`) — keep aligned with current MCP runbook case IDs.
- Footer "Last updated" date + version.

Things to refresh on a checkpoint (test-cases.html):
- Add a new case to **Inclusion** when the plugin starts acting on a new kind of input; add to **Exclusion** when a new "refuse / skip / suppress" path is added.
- Mode tags (`m1` / `m2` / `m3` / `all`) — keep accurate when modes diverge.
- Top-of-page counts in the summary cards + column headers.
- Footer "Last updated" date + version.

All three are hand-authored single-file HTML (embedded CSS, no JS, no build step). Edit directly; don't introduce a generator.

## Layout

- `bootstrap.js` — bootstrapped-addon entry. Registers chrome, calls `_initDefaultPrefs()` (canonical defaults — `prefs.js` at XPI root is not auto-loaded), loads the bundle subscript, calls `Zotero.WatchFolder.hooks.*`.
- `content/*.mjs` — ES module source. Entry is `content/index.mjs`, which exports `hooks` plus `warningSink`, `suppressionResolver`, `baseline` (re-exports for prefs sandbox + MCP access).
- `content/canonicalPath.mjs` — v2 sync-root scoping (`resolveSyncRoot`, `relativePathToCollection`, `chooseCanonicalCollection`, `SyncRootMissingError`, `isSpecialCollection`).
- `content/trackingStore.mjs` — v2 schema (three discriminated record types: `file` / `collection` / `tombstone`; `STATE` frozen enum incl. `USER_DETACHED`). `getSuppressedFiles` / `getSuppressedCollections` / `getConflictedFiles` for the Phase B/D UX. `findTombstoneByHash` / `findTombstoneByAttachmentKey` / `removeTombstoneByAttachmentKey` for the v2.2 restore matrix. `_byHash` index filtered to syncing states only (review fix: detached records don't satisfy dedup). **Singleton via `initTrackingStore()`** — both `WatchFolderService` and `suppressionResolver` consume the same instance (Track A fix; pre-fix they had separate stores and prefs UI silently showed zero). Persisted as `zotero-watch-folder-tracking-v2.json`. v1 files refused (no migration — clean break).
- `content/setupWizard.{xhtml,js}` — v2.4 C1 single-pane setup wizard. Standalone chrome window opened via `window.openDialog` from `content/index.mjs::_runSetupWizardXHTML`. Result returns via `window.arguments[0].onResult({canceled, watchFolder, syncRootKey, syncRootLibraryID, syncRootLabel, mode})`. The modal-sequence wizard in `content/index.mjs` (helpers `_wizardPick*`, `_modeSafetyNote`) remains as a fallback for environments where `openDialog` fails. Both paths converge on `_commitWizardResult` to write prefs + start services.
- `content/preferences.{xhtml,js}` — prefs UI. Copied verbatim, not bundled. v2-aware: sync-root picker + mode display (C2) + warning sink view/clear (D) + suppressed-items resolve + "Resolve folders…" (Track A) + conflict-blocked resolve (Track A). Full multi-step setup wizard (C1) still pending.
- `content/fileMissing.mjs` — v2 missing-file classifier (`classifyMissingFile`, `isWatchRootAvailable`).
- **v2.1 Mode 2 + v2.2 Mode 3 modules:**
  - `content/syncCoordinator.mjs` — start/stop, runtime mode-pref observer, `notifyScanCycle` bridge, `isRunning()` getter.
  - `content/collectionWatcher.mjs` — Zotero notifier observer (`['collection','collection-item']`). Serialized notify chain.
  - `content/folderEventDetector.mjs` — disk-side delete detection; skips already-SUPPRESSED records.
  - `content/itemMembershipHandler.mjs` — `collection-item` add/remove; canonical recompute.
  - `content/itemAddHandler.mjs` — `['item']` notifier for late-attached PDFs (review fix A8).
  - `content/mirrorExecutor.mjs` — per-key promise-chain locks, `canSafelyMove` conflict gate, cross-FS copy+remove fallback. All FS mutations go through here. `_deleteFolder` Mode 3 = recursive move into plugin trash with `bulkGuard` confirm.
  - `content/baseline.mjs` — `runBaseline` (B.2/B.6/B.7), `adoptCollectionSubtree` (used by collectionWatcher adopt-into-scope path), `copyAttachmentToCanonical` (used by itemAddHandler). Idempotent via `baselineCompletedForRoot` pref.
  - `content/warningSink.mjs` — in-memory ring buffer (cap 100) + subscribe API. `clear()` preserves listeners by contract (don't drop the prefs-pane subscriber on user-Clear).
  - `content/suppressionResolver.mjs` — file-record `resolve()` (4 actions: REINSTATE/KEEP_LOCAL/TRASH/MOVE_OUTSIDE), folder-record `resolveCollection()` (same 4 actions adapted for CollectionRecord), conflict-blocked file `resolveConflict()` (3 actions: RESTAMP_BASELINE / DISCARD_LOCAL / PAUSE_SYNC). All 11 handlers snapshot + roll back on `store.save()` failure (Track A). List helpers `listSuppressed` / `listSuppressedCollections` / `listConflicted` for prefs UI. **v2.2 additions:** `listTrashedFolders()` / `restoreTrashedFolder()` for the restore-folder UX.
  - `content/bulkGuard.mjs` (v2.2) — shared `isBulkDelete(affected, total)` predicate (>10 OR >20%) + `confirmBulkDelete({action, path, affectedCount, totalTracked})` Services.prompt with safe no-UI fallback that REFUSES rather than silently executes. Used by mirrorExecutor + watchFolder bulk-destructive paths.
- `dist/content/scripts/watchFolder.js` — esbuild IIFE bundle output. **What Zotero actually runs.**
- `prefs.js` — **30 default preference keys** under `extensions.zotero.watchFolder.*` (added `pdfStorageStrategy` for the PDF storage-strategy layer). `pdfStorageStrategy`: `"stored"` (default) | `"linked_watch_folder"` | `"stored_plus_mirror"` — orthogonal to `mode`; `importMode` ('stored'/'linked') is now a legacy fallback resolved by `storageStrategy.getStorageStrategy()`. `diskDeleteOnTrash` v2.2 values: `"ask"` (default) | `"plugin_trash"` | `"os_trash"` | `"permanent"` | `"never"`.
- `build/{bundle,build,package,release-upload}.mjs` — release pipeline.
- `test/unit/*.test.mjs` + `test/setup/geckoMocks.js` — Vitest, currently **813 passing across 25 files** (v2.6.3 launch fixes added SYNC-1/DATA-1/FS-1/UX-1/IMPORT-1/DATA-3/DATA-4 cases + new `preferences.test.mjs` and `syncCoordinator.test.mjs`; Mode 2/3 deletion-safety hardening added UT-423/424/425/513 + conflict-gate cases; the PDF storage-strategy layer added `storageStrategy.test.mjs` UT-900–906 + fileImporter UT-060; v2.6.1 added UT-907 ×9 for the fail-closed Reclaim child-item classifier). v2.1 added: collectionWatcher / folderEventDetector / itemMembershipHandler / mirrorExecutor / mirrorExecutor_warnings / itemAddHandler / warningSink / suppressionResolver / baseline. v2.2 added: bulkGuard, plus UT-090 cascading-trash + `_handleZoteroTrash` v2, UT-091 `_moveToPluginTrash` + `'plugin_trash'` + tombstone, UT-092 `_handleZoteroRestore` + RST.6, UT-093 RST.2/RST.4 parent-expand, UT-094 bulk-delete guard for `_handleZoteroTrash` + `_handleExternalDeletions`, UT-095 RST.5 re-attach, UT-107 tombstone queries on trackingStore, UT-110/111 bulkGuard, UT-419/420 deleteFolder Mode 3 + bulk-delete protection, UT-830/831 restore-folder UX. The v1-schema UT-050/UT-051 placeholder describe.skip blocks were removed in the v2.2 cleanup.
- `tools/hooks/commit-msg` — strips AI co-author trailers. Install with `git config core.hooksPath tools/hooks` (per-clone).
- `.private/` — **gitignored, maintainer-only** historical and internal content. Not shipped in the public repo. See `.private/README.md` for the layout. Notable references from this file:
  - `.private/docs/CODEBASE_OVERVIEW.md` — long-form per-module tour with file:line refs.
  - `.private/docs/MODULE_DEPENDENCIES.md`, `.private/docs/PHASE{1,2,3}_DESIGN.md`.
  - `.private/docs/optimization_plan.md` — v2.5.0 perf-pass retrospective.
  - `.private/legacy/updates_22_05_26.md` — v2 sync-model spec, **source of truth for new behavior**.
  - `.private/legacy/behavior_updates.md` — INCLUSION / EXCLUSION case-template stub.
  - `.private/mcp-runbooks/INDEX.md` — MCP-driven verification runbooks against a live Zotero. A `.claude/skills/zotero-mcp-warmup/` skill triggers permission prompts for the 15 read-only Zotero MCP tools so they can be approved on PC before going mobile (mobile doesn't render the prompts — GH #35637).
  - `.private/test-fixtures/test_pdfs/` — local PDF fixtures for manual / MCP runs.
- `index.html` — user-facing landing page (single-file, embedded CSS, no JS).
- `test-plan.html` — user-story walkthrough (5 chapters: setup / day-to-day / something off / changing setup / second device).
- `test-cases.html` — two-column inclusion/exclusion behavior spec (25 + 29 cases). The canonical "every behavior of the plugin in one place" reference.
- All three: single-file HTML, embedded CSS, no JS, no build step. Keep in sync at every checkpoint — see the "Keep ... in sync" section above.
- `docs/` — **public** developer documentation (tracked, ships in the repo): `docs/DEVELOPERS.md` (technical reference) and `docs/architecture.md` (visual architecture — the layers, the mode × storage-strategy dials, the provider-agnostic cloud/WebDAV layer, runtime-scenario Mermaid diagrams, and the Zotero 7/8/9 platform reference; this unifies the former `.private/docs/ARCHITECTURE.md` platform notes).

## Build & dev commands

| Command | What it does |
|---|---|
| `npm run bundle` | esbuild: `content/index.mjs` → `dist/content/scripts/watchFolder.js` (IIFE, target firefox128) |
| `npm run build` | Copies root files + `content/` (minus `.mjs` source) + `locale/` into `dist/` |
| `npm run package` | Zips `dist/` into an `.xpi`, computes SHA-256, writes `update.json` |
| `npm run release` | `build && bundle && package && release:upload` (uses `gh release upload`) |
| `npm test` / `npm run test:watch` | Vitest |
| `npm run clean` | Removes `dist/` and `*.xpi` |

Run a single test file: `npx vitest run test/unit/<module>.test.mjs`. Filter by name: `npx vitest run -t "<test name>"`.

## Bundle-pipeline trap

Editing a `.mjs` file does NOT update what Zotero runs. The build pipeline must regenerate the bundle:

1. `npm run bundle` — recompiles `dist/content/scripts/watchFolder.js`
2. `npm run build` — copies the rest of `dist/` (also skips `.mjs` so source isn't shipped)
3. Reload the plugin in Zotero (`zotero_plugin_reload` via MCP, or reinstall the `.xpi`)

**Order quirk in `npm run release`:** it runs `build` *before* `bundle`. `build.mjs` cleans `dist/` then warns the bundle is missing; `bundle.mjs` then writes into the cleaned dir. The dev order (bundle → build → reload) is the opposite. If you `npm run build` after editing `.mjs` without `bundle`, you ship stale/missing bundle output.

If you change `manifest.json` version, also bump `package.json`. Those two are the only sources of truth; `dist/manifest.json` is regenerated. `update.json` is **not** auto-uploaded by `release-upload.mjs` — it must be committed to `main` (served from raw.githubusercontent.com per `manifest.json`).

## Conventions

- Classes `PascalCase`, functions `camelCase`, private fields/methods prefixed `_`.
- Named exports only. No default exports.
- Async-first; errors go to `Zotero.logError()` (user-visible) or `Zotero.debug()` (dev-only).
- JSDoc on public functions. No linter is configured — be deliberate.
- Identity in new code: Zotero attachment/collection **keys** (8-char, library-stable), not numeric itemIDs. v1 code paths still use itemIDs; if you touch them, migrate to keys.

## Don't touch without understanding

- **Hash strategy is full-file SHA-256 (v2.1+).** `utils.getFileHash` reads the entire file. `duplicateDetector.findByHash` + `storeContentHash` route through the same function — the inline crypto + `HASH_CHUNK_SIZE` invariant assertion is gone. v1 1MB-only hashes stamped into existing Zotero items' Extra fields no longer match; affected users see one round of false re-imports as the new hashes take over. `HASH_VERSION` constant tracks the strategy (`2` today); bump if it ever changes again.
- **Module-level hash cache (v2.5+).** `content/_hashCache.mjs` is a singleton LRU keyed by `` `${absPath}|${size}|${mtime}` `` (default cap 5,000). Same SHA-256 strategy; the cache only avoids redundant disk reads on steady-state scans. Consumed by `watchFolder._handleExternalDeletions`, `watchFolder._detectFolderRenames`, `duplicateDetector.findByHash`, `mirrorExecutor.canSafelyMove`, and `baseline._hashViaCache` (B.7 reconcile). The cache survives plugin reloads only within the same Zotero process; reading `Zotero.WatchFolder.__perf.hashCacheStats()` returns `{size, capacity, hits, misses}`. Tests that mock `getFileHash` and run more than one scenario MUST clear the cache in `beforeEach` (it's a real module singleton, not a per-test mock) — see `test/unit/baseline.test.mjs`.
- **Library hash stamps** (`watchfolder-hash:<sha256>` in item Extra field) remain the fallback when the tracking store is wiped. See `watchFolder.mjs._backfillHashesForExistingItems` (uses v2: `getAllOfType('file')`, `getByLibraryAndKeyAsync`, `record.zoteroAttachmentKey`, `record.lastSyncedHash`).
- **`_processingFiles` Set** in `WatchFolderService` is the only per-file reentrancy guard for the poll loop. `_scanInProgress` is the second guard at the scan level. Don't bypass either.
- **`postImportAction='delete'`** records `expectedOnDisk=false` semantics on tracking — used by external-deletion sync to avoid trashing the Zotero item. In Mode 1 the trash branch is gated off entirely; Mode 2 is warn-only on trash; Mode 3 (v2.2) propagates through `_handleZoteroTrash` v2 with canonical-only disk-delete + plugin trash by default.
- **`SyncRootMissingError` is load-bearing.** When `syncRootCollectionKey` resolves to nothing, `canonicalPath.resolveSyncRoot()` throws — callers MUST surface this. Don't add silent fallbacks.
- **`canonicalPath.isSpecialCollection`** filters Duplicates / Unfiled / Trash / My Publications / saved searches (spec Rule 4). Any code that enumerates Zotero collections must pipe through this filter.
- **Sync-root scoping** — `relativePathToCollection` walks DOWNWARD from the sync root. Don't reintroduce library-root-scoped resolution.
- **Mode gates** — several layers:
  - `watchFolder.mjs` `handleNotification('trash')` short-circuits when `mode === 'mode1'`. Mode 2 + Mode 3 both call `_handleZoteroTrash`; the function itself splits on mode (Mode 2 warn-only — **suppresses** records whose file remains, drops the rest, + warningSink; Mode 3 disk action per `diskDeleteOnTrash` pref, behind the `canSafelyMove` conflict gate).
  - `watchFolder.mjs` `handleNotification('modify')` short-circuits when `mode === 'mode1'`. Mode 2/3 trigger `_handleZoteroRestore` if tombstones exist (RST.1 path).
  - `syncCoordinator.start()`: bails when `mode === 'mode1'`; only Mode 2/3 wires collectionWatcher + itemAddHandler + baseline.
  - **Folder deletion is direction-split (do NOT merge back into one `deleteFolder`).** Two action types in `mirrorExecutor`: `zoteroCollectionDeleted` (Zotero collection gone → trash the LOCAL folder; emitted by `collectionWatcher._handleDelete`) and `localFolderDeleted` (local folder gone → propagate to Zotero; emitted by `folderEventDetector`). `deleteFolder` is a back-compat dispatch alias for `zoteroCollectionDeleted`. Mode 2 = warn-only for both. Mode 3: `zoteroCollectionDeleted` recursive-moves the folder into `.zotero-watch-trash/<rel>` (bulkGuard + a **per-child `canSafelyMove` local-hash gate** — any drifted child aborts the whole move as CONFLICT_BLOCKED); `localFolderDeleted` bulk-safe-deletes — per child runs the **Zotero-side `canSafelyTrashZoteroAttachment` freshness gate** (clean ⇒ trash the attachment; drifted/unverifiable ⇒ CONFLICT_BLOCKED + keep), then trashes the Zotero collection only if no child was blocked.
  - **Deletion conflict gates (spec risk #1/#2) — don't bypass.** `canSafelyMove` (local-hash) gates Zotero→local deletions: `_handleZoteroTrash` Mode 3 won't trash a locally-edited canonical file (→ CONFLICT_BLOCKED). `canSafelyTrashZoteroAttachment` (Zotero-stored-file hash vs `lastSyncedHash`, blocks if unprovable) gates local→Zotero deletions: `_handleExternalDeletions` Mode 3 won't trash a Zotero attachment whose stored bytes changed.
  - **Trash must SUPPRESS, not drop, when the file remains (spec risk #3).** `_handleZoteroTrash` Mode 2 (and Mode 3 `never`/failed-trash) flips records whose local file still exists to OUT_OF_SCOPE_SUPPRESSED instead of removing them — a dropped record + a present file = re-import loop on the next scan (the path-skip guard at `_processNewFile` needs the record to survive).
  - Runtime: `syncCoordinator._modeObserverID` watches the mode pref and starts/stops on the fly — no restart required.
- **Per-key executor locks** — `mirrorExecutor._withLock(key, fn)` serializes ops by `collection:<key>` / `attachment:<key>`. Replaces v1 Phase-2's coarse `_isSyncing` global. Don't bypass; don't reintroduce a global lock.
- **Notifier callback chains** — `collectionWatcher`, `itemMembershipHandler`, and `itemAddHandler` each have a module-level promise chain (`_notifyChain`) that serializes their notify calls. Zotero fires events as fire-and-forget; concurrent batches would otherwise interleave through async `canonicalPath` lookups and read inconsistent store snapshots. **v2.5 adds a 100 ms debounce window upstream of the chain** (`DEBOUNCE_MS` constant, `_pendingBuffer` queue, `__test_setDebounceMs` seam) so bursts of events collapse into one drain. Tests using fake timers MUST call `__test_setDebounceMs(0)` in `beforeEach` to avoid 100 ms idle waits per case.
- **TrackingStore indexes + save semantics (v2.5).** Three index Maps are rebuilt on every mutation: `_byAttachmentKey` (canonical record per key — back-compat), `_byAttachmentKeyAll` (canonical + all shadows; queried via `getAllByAttachmentKey(key) → FileRecord[]`), `_tombstonesByHash` / `_tombstonesByAttachmentKey` (O(1) tombstone lookup). `save()` is debounced 50 ms — multiple mutations in one scope coalesce into one disk write; the returned Promise still resolves when the actual write completes so existing `await store.save()` callers observe write errors. Shutdown paths use `flush()` (alias `saveNow()`) to bypass the debounce — `WatchFolderService.destroy()` and `index.mjs::onShutdown` both call `flush()`.
- **RecognizePDF reparenting guard** in `itemMembershipHandler._handleRemove`. Zotero's RecognizePDF emits `collection-item` REMOVE for an attachment leaving its sync-root collection after a parent item absorbs it; the parent is in that collection so the file's logical membership is unchanged. The handler returns early when `item.isAttachment() && item.parentItem.getCollections().includes(collection.id)`. Don't remove this guard — without it every freshly-imported file ends up OUT_OF_SCOPE_SUPPRESSED with empty memberships. Paired safety-net in `mirrorExecutor._addItemMembership`: re-adding a sync-root membership auto-clears OUT_OF_SCOPE_SUPPRESSED → CLEAN. USER_DETACHED is exempt (it's an explicit user choice via the suppression resolver).
- **Adopt-into-scope on `collection-item` add (spec risk #4)** — `itemMembershipHandler._handleAdd` adopts an UNTRACKED attachment added to a sync-root collection ONLY after baseline has completed for the root (`getPref('baselineCompletedForRoot') === syncRoot.collection.key`); before that, baseline owns the copy and the handler defers. Adoption calls `baseline.copyAttachmentToCanonical` (idempotent — skips notes/links/already-tracked/existing-dest). This is the single-item path; `collectionWatcher._adoptIntoScope` handles whole-collection adds. Don't make `_handleAdd` adopt pre-baseline (double-copy with the baseline walk).
- **`_byHash` excludes detached states** — `trackingStore._rebuildIndexes` only indexes records whose state is `clean/dirty/pending/pending-zotero-file/pending-hydration/external-edit`. USER_DETACHED, OUT_OF_SCOPE_SUPPRESSED, CONFLICT_BLOCKED, etc. are deliberately excluded so the hash-dedup path can't re-link a fresh import to a Zotero item the user already chose to stop syncing.
- **Tombstones are NOT in `_byHash`** but are queryable via `findTombstoneByHash` — the v2.2 restore matrix consults them BEFORE the live-record dedup (`_processNewFile` step 3a). A new file whose hash matches a tombstone un-trashes the Zotero attachment and re-creates the FileRecord; if the attachment was permanently purged, the tombstone is dropped and import falls through.
- **Shadow records (dedup-skip)** — `_processNewFile` creates a second FileRecord with the same `zoteroAttachmentKey` and a different `localPath` when the user puts two copies of the same file under the watch root. Canonical is the one where `localPath === canonicalLocalPath`; shadows are the rest. **Cascading-trash guards** in both `_handleExternalDeletions` (Mode 3) and `_handleZoteroTrash` (v2 rewrite) ensure shadow paths are NEVER disk-deleted — only canonical paths are, and tracking for shadows is dropped without disk action. Don't write a code path that disk-deletes "all records for this attachment key" without the canonical/shadow split.
- **`.zotero-watch-trash/`** — `<watchRoot>/.zotero-watch-trash/` is the plugin's recoverable-trash dir for Mode 3. Created lazily by `_moveToPluginTrash`. Reserved in `fileScanner.SKIP_DIRNAMES` so trashed files don't get re-imported on next scan. Restore (RST.1) moves files back out. The dirname is load-bearing — don't change without updating the skip-list and the trash helpers.
- **`baseline.runBaseline` idempotency** — keyed on `baselineCompletedForRoot` pref. Changing the sync root re-triggers; same root no-ops. Force-rerun via `opts.force` for diagnostic.
- **`metadataRetriever.mjs`** has known fire-and-forget `_processQueue()` calls (lines 122, 177, 370) — errors get swallowed. Tracked as a follow-up.

## Tests

Three layers — see [`test/README.md`](./test/README.md) for the overview.

- **`test/unit/`** — Vitest, **813 passing across 25 files** (zero skipped; v2.6.3 launch fixes SYNC-1/DATA-1/FS-1/UX-1/IMPORT-1/DATA-3/DATA-4 + `preferences.test.mjs` + `syncCoordinator.test.mjs`; UT-512 RecognizePDF guard; v2.5 perf pass `hashCache.test.mjs`; Mode 2/3 deletion-safety UT-423/424/425/513; PDF storage-strategy `storageStrategy.test.mjs` UT-900–906 + UT-907 fail-closed Reclaim classifier). `vitest.config.mjs` (globals, Node env). `test/setup/geckoMocks.js` stubs `Zotero`, `IOUtils`, `PathUtils`, `Services`, `Components`, `ChromeUtils`, `crypto.subtle`. New test file: `test/unit/<module>.test.mjs` — import the SUT from `../../content/<module>.mjs`, mock deps per-file with `vi.mock(...)`, reset in `beforeEach`.
- **`.private/mcp-runbooks/`** — MCP runbooks Claude executes against a live Zotero via the bridge (maintainer-only, gitignored). Entry point: `.private/mcp-runbooks/INDEX.md`. Run **SMOKE.md S.1–S.7** before tagging a release.
- Zero unit coverage on `bulkOperations.mjs`, `metadataRetriever.mjs`, `index.mjs` — gaps are intentional, not invitations to skip.

## Open issues / known bugs

Living lists: `.private/legacy/updates_22_05_26.md` (v2 spec) and `.private/mcp-runbooks/INDEX.md` notes from the latest run. Historical TODO context lives at `.private/legacy/TODO_done_may_2026.md`.

- **Resolver save() rollback for FS mutations** — Track A added rollback for tracking-store save failures across all 11 suppression-resolver handlers. For TRASH / MOVE_OUTSIDE the FS mutation is NOT reversible (file is already trashed/moved); only the tracking-store mutations roll back. Documented inline; not a bug, but worth knowing when investigating "I trashed it, then save failed, where's my file" reports.

**Recently fixed (don't re-introduce):**
- *(Older 2026-05-25 era fixes — Parent-trash child-expand, RecognizePDF reparenting guard, cascading-trash, singleton TrackingStore, `_moveItem`/`_moveFolder` lock-race fixes, suppressionResolver `save()` rollback — rotated to `.private/docs/RELEASE_HISTORY.md`. Don't re-introduce; the corresponding invariants live in "Don't touch without understanding" above.)*
- ~~Hash chunk caps at 1 MB~~ — `utils.getFileHash` is now full-file SHA-256 (`HASH_VERSION=2`); the 1MB-prefix dedup limitation is gone.
- ~~Phase 3 bulk ops dormant~~ — `bulkOperations.mjs` deleted entirely in v2.2; the v1 surface (`reorganizeAll`, `retryAllMetadata`, `applyRulesToAll`) was unreachable in v2 and superseded by the sync-coordinator pipeline.
- ~~`mirrorExecutor._deleteFolder` Mode 3 warn-only~~ — v2.2 wired Mode 3 to recursive-move folders into `.zotero-watch-trash/` with collision-suffix + child tracking cleanup. Mode 2 stays warn-only.
- ~~`metadataRetriever` fire-and-forget queue~~ — all three `_processQueue()` callsites (now lines 124/182/377) wrap with `.catch(e => Zotero.logError(...))`; CLAUDE.md's old note was stale.
- ~~`tracking.json` not saved on dedup-skip~~ — all five `_trackingStore.add(...)` callsites in `_processNewFile` (lines 547 / 582 / 631 / 705 / 767) now `await this._trackingStore.save()` before the early return.
- ~~Schema drift in legacy v1 record sites~~ — fixed in commit `2a98adf` (#25). `_ensureCollectionRecordsForPath` now writes sync-root-relative paths. `folderEventDetector._toAbs` retains an idempotent absolute-or-relative coercion as defensive handling for any latent legacy data, not as a workaround.
- ~~Scanner subfolder pickup felt slow in MODE3 live run~~ — the observed delay traced to (a) the `enabled` pref toggle not restarting the scanner in-process (now fixed via `enabledObserverID`) and (b) adaptive polling backoff which is by design (max 2× base interval, resets on any non-empty scan). `scanFolderRecursive` is correct and fast.

---

## MCP: verifying the plugin via `@introfini/mcp-server-zotero-dev`

The MCP server is wired in `.mcp.json`. Tool names are prefixed `mcp___introfini_mcp-server-zotero-dev__` (omitted in runbooks for readability).

**Canonical verification surface:** the MCP runbooks in `.private/mcp-runbooks/` (maintainer-only). Start at `INDEX.md`, pick the relevant phase file, execute. **SMOKE.md S.1–S.7** is the pre-release checklist.

**What's reachable via `zotero_execute_js`:** the bundle is an esbuild IIFE assigned to `Zotero.WatchFolder`. Only the entry point's exports are visible, which means **only `Zotero.WatchFolder.hooks` exists** — the `WatchFolderService` instance is module-private. Inspect live state via DB queries, prefs, and logs instead.

**Bridge quirks:**
- `zotero_ping` reports "cannot connect" even when the bridge is fully functional (it probes a different actor). Use `zotero_plugin_list` as the real healthcheck.
- `zotero_read_logs`, `zotero_search_prefs`, `zotero_ping`, and `zotero_set_pref` intermittently fail with "Could not find Zotero console actor." When that happens, fall back to `zotero_execute_js` calling `Zotero.Prefs.get/set` or `Zotero.Debug` directly.

**Side-effecting tools — confirm before calling:** `zotero_set_pref`, `zotero_plugin_install`, `zotero_plugin_reload`, `zotero_execute_js` with mutating code, `zotero_db_query` with non-SELECT, `zotero_clear_logs`.

**Quick reference — common probes:**

```
zotero_plugin_list                                          # healthcheck
zotero_plugin_reload { pluginId: "watch-folder@zotero-plugin.org" }
zotero_read_logs { filter: "WatchFolder", lines: 40 }
zotero_read_errors { lines: 20 }
zotero_search_prefs { query: "watchFolder" }                # all 30 keys
zotero_db_query { sql: "SELECT itemID, dateAdded FROM items WHERE dateAdded > datetime('now','-2 minutes') ORDER BY dateAdded DESC LIMIT 5" }
zotero_execute_js { code: "return { hasHooks: typeof Zotero.WatchFolder?.hooks, hookKeys: Object.keys(Zotero.WatchFolder?.hooks || {}) };" }
zotero_screenshot { target: "main-window" }                 # catch stuck dialogs
```
