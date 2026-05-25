# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Zotero plugin that polls a folder, imports new PDFs into a target collection, dedupes them, and optionally moves/renames the source files. Targets Zotero 7/8/9 (`strict_min_version: 6.999`).

Plugin ID: `watch-folder@zotero-plugin.org`. Version lives in `package.json` AND `manifest.json` — keep them in sync.

## v2 status — read this before editing

The codebase has completed the v2 rewrite from the library-root-scoped model to a **sync-root-scoped, mode-based** model. Spec: `updates_22_05_26.md`. Long-form tour of current state: `docs/CODEBASE_OVERVIEW.md`.

**v2.0 (shipped as `v2.0.0-alpha.1`) — Mode 1 functional end-to-end:**
- **Phase A** (`bfdf3ba`) — sync-root concept, mode enum, v2 tracking schema, identity by Zotero attachment KEY (not numeric itemID), `canonicalPath.mjs`, hash-invariant fix (`HASH_CHUNK_SIZE` single export).
- **Phase B1/B3/B4/B6** — Mode 1 import-only wiring, dedup priority rewrite (hash first, DOI/ISBN/title gated to post-metadata), `fileMissing.mjs` classifier, Mode 1 deletion gating.
- **Phase C2** — prefs UI sync-root picker via `Services.prompt.select`.
- **Phase E** — cleanup: deleted `collectionSync.mjs` + Phase-2 modules + legacy bootstraps.

**v2.1 (shipped as `v2.1.0-alpha.1`, tag `v2.1.0-alpha.1`) — Mode 2 functional end-to-end:**
- **Phase A1** — `collectionWatcher.mjs` registers Zotero.Notifier for `['collection','collection-item']`, dispatches MirrorActions, sync-root scope-gated, notifier callbacks serialized via a module-level promise chain.
- **Phase A2** — `folderEventDetector.mjs` disk-side diff; emits `deleteFolder` for tracked collections whose path vanished. Hooked into `watchFolder._scan` via `syncCoordinator.notifyScanCycle`, gated on `coordinator.isRunning()` so Mode 1 doesn't pay the recursive-dir-walk cost.
- **Phase A3** — `itemMembershipHandler.mjs` handles `collection-item` add/remove with canonical-path-rule logic; recomputes canonical via `chooseCanonicalCollection` and emits `moveItem` when canonical changes.
- **Phase A4** — `mirrorExecutor.mjs` single mutation bottleneck behind a per-key promise-chain lock (`collection:<key>` / `attachment:<key>`). Real handlers: createFolder / moveFolder / deleteFolder / moveItem / addItemMembership / removeItemMembership. Cross-FS fallback: `IOUtils.move` fails → `copy + remove` with partial-dest rollback.
- **Phase A5** — `canSafelyMove(record, absPath)` conflict gate: refuses on hash drift, flips state to CONFLICT_BLOCKED, reports via warningSink.
- **Phase A6** — `syncCoordinator.mjs` wires A1/A2/A3/A4 in start/stop. Runtime mode-pref observer (Zotero.Prefs.registerObserver) — toggling mode at runtime starts/stops without restart.
- **Phase B** — `suppressionResolver.mjs` 4-action UX for OUT_OF_SCOPE_SUPPRESSED FileRecords (REINSTATE / KEEP_LOCAL / TRASH / MOVE_OUTSIDE). `STATE.USER_DETACHED` for the KEEP_LOCAL outcome. Prefs UI: "Suppressed items: N (Resolve…)" row iterates records with `Services.prompt.select`.
- **Phase C** — `baseline.mjs` first-run reconcile: **B.1** (no-op), **B.2** (copy Zotero attachment files to canonical local paths), **B.4/B.5** (existing scan loop), **B.6** (mkdir empty subcollections), **B.7** (hash-based cross-path reconcile — adopt existing disk file at non-canonical path instead of duplicating). Adopt-into-scope variant `adoptCollectionSubtree` called from collectionWatcher when an existing populated collection appears under sync root. Late-attached PDF handler `itemAddHandler.mjs` subscribes to `['item']` notifier for new attachments under sync-root parents.
- **Phase D** — `warningSink.mjs` in-memory ring buffer (cap 100) + subscribe API. Categories: CONFLICT_BLOCKED / MISSING_FILE / IO_ERROR / SUPPRESSED / UNKNOWN_TARGET. Prefs UI: "Sync warnings: N (View / Clear)" + per-category counts.

**v2.1 Track A polish (post-release `v2.1.0-alpha.1`, on `main`):**
- **Folder + conflict resolution UX** — `suppressionResolver.resolveCollection()` (REINSTATE / KEEP_LOCAL / TRASH / MOVE_OUTSIDE for CollectionRecords) + `resolveConflict()` (RESTAMP_BASELINE / DISCARD_LOCAL / PAUSE_SYNC for CONFLICT_BLOCKED FileRecords). Prefs UI gets "Resolve folders…" and conflict "Resolve…" buttons.
- **`mirrorExecutor._moveItem` stale-path race fix** — reads live `canonicalLocalPath` from the store after acquiring `attachment:<key>` lock; short-circuits no-op when live path already equals payload's `newCanonicalPath`.
- **`mirrorExecutor._moveFolder` per-attachment locks** — each child file rewrite acquires `attachment:<key>` sequentially with re-read inside the lock.
- **`suppressionResolver` save() rollback** — all 11 handlers snapshot pre-mutation state and restore on `store.save()` failure. FS mutations for TRASH/MOVE_OUTSIDE aren't reversed (file is already trashed/moved) — only the tracking-store mutations roll back.
- **Singleton tracking store** — `WatchFolderService` now routes through `initTrackingStore()` instead of `new TrackingStore()`. Pre-fix the suppression UX read from an empty singleton while the service held the real records in a private instance — prefs UI silently reported zero suppressed/conflicted items. Both consumers now share the singleton.

**Mode 2 flow** (sync-root scoped, mirror without delete): install → set sync root + mode in prefs → enable → SyncCoordinator runs baseline (B.2/B.6/B.7), registers collectionWatcher + itemAddHandler, bridges into the scan loop. Disk changes flow through `_detectFolderRenames` + `folderEventDetector`; Zotero changes flow through `collectionWatcher` + `itemMembershipHandler`. All mutations go through `mirrorExecutor` with per-key locks + conflict gate. Zotero-side trash → `_handleZoteroTrash` warns + drops tracking + reports to warningSink (no disk action).

**v2.2 in progress (on `main`, unreleased) — Mode 3 — safe delete:**
- **Cascading-trash bug fixed.** Two patches stop a chain that would activate the moment Mode 3 turned on:
  - `_handleExternalDeletions` Mode 3 branch — when a SHADOW record (`localPath !== canonicalLocalPath`, produced by dedup-skip) is missing but its canonical sibling is still on disk, drops only the shadow tracking; never trashes the Zotero attachment.
  - `_handleZoteroTrash` — full v2-schema rewrite. Translates numeric IDs → attachment keys, collapses per-attachment, disk-deletes ONLY the canonical path, drops shadows from tracking without disk action. Mode 2 warn-only path also implemented.
- **`.zotero-watch-trash/` local trash dir.** `_moveToPluginTrash(absPath)` preserves the sync-root-relative subpath; collision suffix `<name>.<ms-timestamp>.<ext>` per RST.6; cross-FS fallback. New `'plugin_trash'` value for `diskDeleteOnTrash` and is the default-recoverable button in `_promptDiskDelete`. Tombstone records emitted on successful trash (plugin or OS) so RST.1/RST.3 can re-link.
- **Restore matrix RST.1 / RST.3 / RST.6 + tombstone-aware dedup.** New `_handleZoteroRestore(ids)` on the `'modify'` notifier branch (gated on tombstones existing) moves files out of plugin trash when an attachment is un-trashed in Zotero. `_processNewFile` consults `trackingStore.findTombstoneByHash` before normal dedup — on match, un-trashes the Zotero attachment if still trashed and re-creates the FileRecord; if attachment is permanently purged, drops the tombstone and imports as new. RST.6 collision in the restore direction: `<name>.restored.<ms-timestamp>.<ext>`.

**Still pending in v2.2:**
- `mirrorExecutor._deleteFolder` Mode 3 wiring — currently warn-only in both Mode 2 and Mode 3. Should route through plugin trash.
- Bulk-delete protection — pause + confirm prompt when >10 files or >20% of tree would be trashed, or when the watch volume goes offline.
- Restore matrix RST.2 / RST.4 / RST.5 — multi-attachment parent restore, partial restore (parent without attachment), local-restore-after-parent-deletion.

**Still pending in v2.1 polish:**
- C1 full setup wizard (multi-step pane; the C2 minimal picker + first-run nudge is in place).
- Phase E `test/mcp/MODE2.md` runbook for live-Zotero validation.

**Three sync modes** (`mode` pref): `mode1` (import only — Phase A v2.0), `mode2` (mirror without delete — v2.1), `mode3` (mirror with safe delete — v2.2 in progress on `main`).

## Layout

- `bootstrap.js` — bootstrapped-addon entry. Registers chrome, calls `_initDefaultPrefs()` (canonical defaults — `prefs.js` at XPI root is not auto-loaded), loads the bundle subscript, calls `Zotero.WatchFolder.hooks.*`.
- `content/*.mjs` — ES module source. Entry is `content/index.mjs`, which exports `hooks` plus `warningSink`, `suppressionResolver`, `baseline` (re-exports for prefs sandbox + MCP access).
- `content/canonicalPath.mjs` — v2 sync-root scoping (`resolveSyncRoot`, `relativePathToCollection`, `chooseCanonicalCollection`, `SyncRootMissingError`, `isSpecialCollection`).
- `content/trackingStore.mjs` — v2 schema (three discriminated record types: `file` / `collection` / `tombstone`; `STATE` frozen enum incl. `USER_DETACHED`). `getSuppressedFiles` / `getSuppressedCollections` / `getConflictedFiles` for the Phase B/D UX. `findTombstoneByHash` / `findTombstoneByAttachmentKey` / `removeTombstoneByAttachmentKey` for the v2.2 restore matrix. `_byHash` index filtered to syncing states only (review fix: detached records don't satisfy dedup). **Singleton via `initTrackingStore()`** — both `WatchFolderService` and `suppressionResolver` consume the same instance (Track A fix; pre-fix they had separate stores and prefs UI silently showed zero). Persisted as `zotero-watch-folder-tracking-v2.json`. v1 files refused (no migration — clean break).
- `content/preferences.{xhtml,js}` — prefs UI. Copied verbatim, not bundled. v2-aware: sync-root picker + mode display (C2) + warning sink view/clear (D) + suppressed-items resolve + "Resolve folders…" (Track A) + conflict-blocked resolve (Track A). Full multi-step setup wizard (C1) still pending.
- `content/fileMissing.mjs` — v2 missing-file classifier (`classifyMissingFile`, `isWatchRootAvailable`).
- **v2.1 Mode 2 modules:**
  - `content/syncCoordinator.mjs` — start/stop, runtime mode-pref observer, `notifyScanCycle` bridge, `isRunning()` getter.
  - `content/collectionWatcher.mjs` — Zotero notifier observer (`['collection','collection-item']`). Serialized notify chain.
  - `content/folderEventDetector.mjs` — disk-side delete detection; skips already-SUPPRESSED records.
  - `content/itemMembershipHandler.mjs` — `collection-item` add/remove; canonical recompute.
  - `content/itemAddHandler.mjs` — `['item']` notifier for late-attached PDFs (review fix A8).
  - `content/mirrorExecutor.mjs` — per-key promise-chain locks, `canSafelyMove` conflict gate, cross-FS copy+remove fallback. All FS mutations go through here.
  - `content/baseline.mjs` — `runBaseline` (B.2/B.6/B.7), `adoptCollectionSubtree` (used by collectionWatcher adopt-into-scope path), `copyAttachmentToCanonical` (used by itemAddHandler). Idempotent via `baselineCompletedForRoot` pref.
  - `content/warningSink.mjs` — in-memory ring buffer (cap 100) + subscribe API.
  - `content/suppressionResolver.mjs` — file-record `resolve()` (4 actions: REINSTATE/KEEP_LOCAL/TRASH/MOVE_OUTSIDE), folder-record `resolveCollection()` (same 4 actions adapted for CollectionRecord), conflict-blocked file `resolveConflict()` (3 actions: RESTAMP_BASELINE / DISCARD_LOCAL / PAUSE_SYNC). All 11 handlers snapshot + roll back on `store.save()` failure (Track A). List helpers `listSuppressed` / `listSuppressedCollections` / `listConflicted` for prefs UI.
- `dist/content/scripts/watchFolder.js` — esbuild IIFE bundle output. **What Zotero actually runs.**
- `prefs.js` — **29 default preference keys** under `extensions.zotero.watchFolder.*` (added `baselineCompletedForRoot` in v2.1). `diskDeleteOnTrash` v2.2 values: `"ask"` (default) | `"plugin_trash"` | `"os_trash"` | `"permanent"` | `"never"`.
- `build/{bundle,build,package,release-upload}.mjs` — release pipeline.
- `test/unit/*.test.mjs` + `test/setup/geckoMocks.js` — Vitest, currently **493 passing + 21 skipped across 19 files**. New v2.1 test files: collectionWatcher / folderEventDetector / itemMembershipHandler / mirrorExecutor / mirrorExecutor_warnings / itemAddHandler / warningSink / suppressionResolver / baseline. v2.2 in-progress additions: UT-090 cascading-trash + `_handleZoteroTrash` v2 rewrite, UT-091 `_moveToPluginTrash` + `'plugin_trash'` action + tombstone, UT-092 `_handleZoteroRestore` + RST.6 collision, UT-107 tombstone queries on trackingStore. The 21 skips are v1-schema bodies under `describe.skip` in `watchFolder.test.mjs` (UT-050 / UT-051) — they predate the v2 rewrite and are superseded by UT-090..UT-092; remove or port at the next test-suite cleanup.
- `test/mcp/` — MCP runbooks against a live Zotero. Entry: `test/mcp/INDEX.md`. `MODE2.md` runbook pending (Phase E). A `.claude/skills/zotero-mcp-warmup/` skill triggers permission prompts for the 15 read-only Zotero MCP tools so they can be approved on PC before going mobile (mobile doesn't render the prompts — GH #35637).
- `test_pdfs/` — local PDF fixtures for manual / MCP runs (gitignored content, present locally).
- `docs/` — `ARCHITECTURE.md` (Zotero 8 platform notes), `CODEBASE_OVERVIEW.md` (long-form per-module tour with file:line refs), `MODULE_DEPENDENCIES.md`, `PHASE{1,2,3}_DESIGN.md`.
- `updates_22_05_26.md` — v2 sync-model spec. **Source of truth for new behavior.**
- `behavior_updates.md` — case-template spec (`INCLUSION` / `EXCLUSION` matrices). Mostly stub; expand here as cases are pinned down.
- `tools/hooks/commit-msg` — strips AI co-author trailers. Install with `git config core.hooksPath tools/hooks` (per-clone).

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
- **Library hash stamps** (`watchfolder-hash:<sha256>` in item Extra field) remain the fallback when the tracking store is wiped. See `watchFolder.mjs._backfillHashesForExistingItems` (uses v2: `getAllOfType('file')`, `getByLibraryAndKeyAsync`, `record.zoteroAttachmentKey`, `record.lastSyncedHash`).
- **`_processingFiles` Set** in `WatchFolderService` is the only per-file reentrancy guard for the poll loop. `_scanInProgress` is the second guard at the scan level. Don't bypass either.
- **`postImportAction='delete'`** records `expectedOnDisk=false` semantics on tracking — used by external-deletion sync to avoid trashing the Zotero item. In Mode 1 the trash branch is gated off entirely; Mode 2 is warn-only on trash; Mode 3 (v2.2 in-progress) reactivates the propagation through `_handleZoteroTrash` v2 with canonical-only disk-delete + plugin trash by default.
- **`SyncRootMissingError` is load-bearing.** When `syncRootCollectionKey` resolves to nothing, `canonicalPath.resolveSyncRoot()` throws — callers MUST surface this. Don't add silent fallbacks.
- **`canonicalPath.isSpecialCollection`** filters Duplicates / Unfiled / Trash / My Publications / saved searches (spec Rule 4). Any code that enumerates Zotero collections must pipe through this filter.
- **Sync-root scoping** — `relativePathToCollection` walks DOWNWARD from the sync root. Don't reintroduce library-root-scoped resolution.
- **Mode gates** — four layers:
  - `watchFolder.mjs` `handleNotification('trash')` short-circuits when `mode === 'mode1'`. Mode 2 + Mode 3 both call `_handleZoteroTrash`; the function itself splits on mode (Mode 2 warn-only drop tracking + warningSink, Mode 3 disk action per `diskDeleteOnTrash` pref).
  - `watchFolder.mjs` `handleNotification('modify')` short-circuits when `mode === 'mode1'`. Mode 2/3 trigger `_handleZoteroRestore` if tombstones exist (RST.1 path).
  - `syncCoordinator.start()`: bails when `mode === 'mode1'`; only Mode 2/3 wires collectionWatcher + itemAddHandler + baseline.
  - `mirrorExecutor._deleteFolder`: Mode 2 warn-only (state flip to OUT_OF_SCOPE_SUPPRESSED + warningSink); Mode 3 still warn-only TODAY (pending Track C item — should route through plugin trash).
  - Runtime: `syncCoordinator._modeObserverID` watches the mode pref and starts/stops on the fly — no restart required.
- **Per-key executor locks** — `mirrorExecutor._withLock(key, fn)` serializes ops by `collection:<key>` / `attachment:<key>`. Replaces v1 Phase-2's coarse `_isSyncing` global. Don't bypass; don't reintroduce a global lock.
- **Notifier callback chains** — `collectionWatcher` and `itemAddHandler` each have a module-level promise chain (`_notifyChain`) that serializes their notify calls. Zotero fires events as fire-and-forget; concurrent batches would otherwise interleave through async `canonicalPath` lookups and read inconsistent store snapshots.
- **`_byHash` excludes detached states** — `trackingStore._rebuildIndexes` only indexes records whose state is `clean/dirty/pending/pending-zotero-file/pending-hydration/external-edit`. USER_DETACHED, OUT_OF_SCOPE_SUPPRESSED, CONFLICT_BLOCKED, etc. are deliberately excluded so the hash-dedup path can't re-link a fresh import to a Zotero item the user already chose to stop syncing.
- **Tombstones are NOT in `_byHash`** but are queryable via `findTombstoneByHash` — the v2.2 restore matrix consults them BEFORE the live-record dedup (`_processNewFile` step 3a). A new file whose hash matches a tombstone un-trashes the Zotero attachment and re-creates the FileRecord; if the attachment was permanently purged, the tombstone is dropped and import falls through.
- **Shadow records (dedup-skip)** — `_processNewFile` creates a second FileRecord with the same `zoteroAttachmentKey` and a different `localPath` when the user puts two copies of the same file under the watch root. Canonical is the one where `localPath === canonicalLocalPath`; shadows are the rest. **Cascading-trash guards** in both `_handleExternalDeletions` (Mode 3) and `_handleZoteroTrash` (v2 rewrite) ensure shadow paths are NEVER disk-deleted — only canonical paths are, and tracking for shadows is dropped without disk action. Don't write a code path that disk-deletes "all records for this attachment key" without the canonical/shadow split.
- **`.zotero-watch-trash/`** — `<watchRoot>/.zotero-watch-trash/` is the plugin's recoverable-trash dir for Mode 3. Created lazily by `_moveToPluginTrash`. Reserved in `fileScanner.SKIP_DIRNAMES` so trashed files don't get re-imported on next scan. Restore (RST.1) moves files back out. The dirname is load-bearing — don't change without updating the skip-list and the trash helpers.
- **`baseline.runBaseline` idempotency** — keyed on `baselineCompletedForRoot` pref. Changing the sync root re-triggers; same root no-ops. Force-rerun via `opts.force` for diagnostic.
- **`metadataRetriever.mjs`** has known fire-and-forget `_processQueue()` calls (lines 122, 177, 370) — errors get swallowed. Tracked as a follow-up.

## Tests

Three layers — see [`test/README.md`](./test/README.md) for the overview.

- **`test/unit/`** — Vitest, **493 passing + 21 skipped across 19 files**. The 21 skips are v1-schema bodies in `watchFolder.test.mjs` (`UT-050` / `UT-051`) that predate the v2 schema and are superseded by `UT-090`..`UT-092`; safe to delete at next cleanup. `vitest.config.mjs` (globals, Node env). `test/setup/geckoMocks.js` stubs `Zotero`, `IOUtils`, `PathUtils`, `Services`, `Components`, `ChromeUtils`, `crypto.subtle`. New test file: `test/unit/<module>.test.mjs` — import the SUT from `../../content/<module>.mjs`, mock deps per-file with `vi.mock(...)`, reset in `beforeEach`.
- **`test/mcp/`** — MCP runbooks Claude executes against a live Zotero via the bridge. Entry point: [`test/mcp/INDEX.md`](./test/mcp/INDEX.md). Replaces the old manual `TEST_PLAN.md` checklist for day-to-day work. Run **SMOKE.md S.1–S.7** before tagging a release.
- Zero unit coverage on `bulkOperations.mjs`, `metadataRetriever.mjs`, `index.mjs` — gaps are intentional, not invitations to skip.

## Open issues / known bugs

Living lists: `updates_22_05_26.md` (v2 spec), `TODO.md`, `test/mcp/INDEX.md` notes from the latest run.

- **`metadataRetriever` fire-and-forget queue** at lines 122, 177, 370 — swallowed errors.
- **`tracking.json` not saved when all files dedup-skip** — `_trackingStore.add(...)` flips `_dirty=true` but the early `return` skips the `save()`. Crash between scans loses these adds.
- **Hash chunk caps at 1 MB.** Two PDFs differing only after the first 1 MB SHA-256 identically and one will be marked duplicate. Confirmed in MCP run E.4: appending bytes to the END of a PDF does not bust dedup. Affects B.7 reconcile too — large PDFs sharing a 1MB prefix would be falsely linked. **NOTE:** v2.1 switched `utils.getFileHash` to full-file SHA-256 (`HASH_VERSION=2`), so this caveat applies only to legacy sites that haven't migrated. Audit `duplicateDetector.findByHash` callsites before relying on the cap.
- **Phase 3 bulk ops** (`reorganizeAll`, `retryAllMetadata`, `applyRulesToAll`) — no UI hook AND not reachable via `Zotero.WatchFolder.hooks`. Effectively dormant.
- **Schema drift in legacy v1 record sites** — `_ensureCollectionRecordsForPath` (watchFolder.mjs) writes `localPath: absDir` (absolute) while v2 spec is sync-root-relative. `folderEventDetector` skips records where `localPath.startsWith('/')` as a workaround. Real fix: migrate v1 write sites.
- **Resolver save() rollback for FS mutations** — Track A added rollback for tracking-store save failures across all 11 suppression-resolver handlers. For TRASH / MOVE_OUTSIDE the FS mutation is NOT reversible (file is already trashed/moved); only the tracking-store mutations roll back. Documented inline; not a bug, but worth knowing when investigating "I trashed it, then save failed, where's my file" reports.
- **`mirrorExecutor._deleteFolder` Mode 3** — still warn-only (same as Mode 2). Pending Track C item: route Mode 3 folder deletes through plugin trash + bulk-delete protection.

**Recently fixed (don't re-introduce):**
- ~~Cascading-trash bug~~ — fixed in `_handleExternalDeletions` (Mode 3 shadow guard) + `_handleZoteroTrash` v2 rewrite (canonical-only disk-delete).
- ~~Singleton tracking store divergence~~ — fixed by routing `WatchFolderService` through `initTrackingStore()`.
- ~~`_moveItem` cross-action stale `oldCanonicalPath`~~ — fixed; reads live record after lock acquisition.
- ~~`_moveFolder` child rewrite without per-attachment locks~~ — fixed; each child wrapped in `attachment:<key>` lock.
- ~~suppressionResolver `save()` failures invisible~~ — fixed; snapshot + rollback + warningSink notification.

---

## MCP: verifying the plugin via `@introfini/mcp-server-zotero-dev`

The MCP server is wired in `.mcp.json`. Tool names are prefixed `mcp___introfini_mcp-server-zotero-dev__` (omitted in runbooks for readability).

**Canonical verification surface:** the MCP runbooks in [`test/mcp/`](./test/mcp/INDEX.md). Start at `INDEX.md`, pick the relevant phase file, execute. **SMOKE.md S.1–S.7** is the pre-release checklist.

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
zotero_search_prefs { query: "watchFolder" }                # all 29 keys
zotero_db_query { sql: "SELECT itemID, dateAdded FROM items WHERE dateAdded > datetime('now','-2 minutes') ORDER BY dateAdded DESC LIMIT 5" }
zotero_execute_js { code: "return { hasHooks: typeof Zotero.WatchFolder?.hooks, hookKeys: Object.keys(Zotero.WatchFolder?.hooks || {}) };" }
zotero_screenshot { target: "main-window" }                 # catch stuck dialogs
```
