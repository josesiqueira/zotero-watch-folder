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

**v2.1 (current main, awaiting release tag) — Mode 2 functional end-to-end:**
- **Phase A1** — `collectionWatcher.mjs` registers Zotero.Notifier for `['collection','collection-item']`, dispatches MirrorActions, sync-root scope-gated, notifier callbacks serialized via a module-level promise chain.
- **Phase A2** — `folderEventDetector.mjs` disk-side diff; emits `deleteFolder` for tracked collections whose path vanished. Hooked into `watchFolder._scan` via `syncCoordinator.notifyScanCycle`, gated on `coordinator.isRunning()` so Mode 1 doesn't pay the recursive-dir-walk cost.
- **Phase A3** — `itemMembershipHandler.mjs` handles `collection-item` add/remove with canonical-path-rule logic; recomputes canonical via `chooseCanonicalCollection` and emits `moveItem` when canonical changes.
- **Phase A4** — `mirrorExecutor.mjs` single mutation bottleneck behind a per-key promise-chain lock (`collection:<key>` / `attachment:<key>`). Real handlers: createFolder / moveFolder / deleteFolder / moveItem / addItemMembership / removeItemMembership. Cross-FS fallback: `IOUtils.move` fails → `copy + remove` with partial-dest rollback.
- **Phase A5** — `canSafelyMove(record, absPath)` conflict gate: refuses on hash drift, flips state to CONFLICT_BLOCKED, reports via warningSink.
- **Phase A6** — `syncCoordinator.mjs` wires A1/A2/A3/A4 in start/stop. Runtime mode-pref observer (Zotero.Prefs.registerObserver) — toggling mode at runtime starts/stops without restart.
- **Phase B** — `suppressionResolver.mjs` 4-action UX for OUT_OF_SCOPE_SUPPRESSED FileRecords (REINSTATE / KEEP_LOCAL / TRASH / MOVE_OUTSIDE). `STATE.USER_DETACHED` for the KEEP_LOCAL outcome. Prefs UI: "Suppressed items: N (Resolve…)" row iterates records with `Services.prompt.select`.
- **Phase C** — `baseline.mjs` first-run reconcile: **B.1** (no-op), **B.2** (copy Zotero attachment files to canonical local paths), **B.4/B.5** (existing scan loop), **B.6** (mkdir empty subcollections), **B.7** (hash-based cross-path reconcile — adopt existing disk file at non-canonical path instead of duplicating). Adopt-into-scope variant `adoptCollectionSubtree` called from collectionWatcher when an existing populated collection appears under sync root. Late-attached PDF handler `itemAddHandler.mjs` subscribes to `['item']` notifier for new attachments under sync-root parents.
- **Phase D** — `warningSink.mjs` in-memory ring buffer (cap 100) + subscribe API. Categories: CONFLICT_BLOCKED / MISSING_FILE / IO_ERROR / SUPPRESSED / UNKNOWN_TARGET. Prefs UI: "Sync warnings: N (View / Clear)" + per-category counts.

**Mode 2 flow** (sync-root scoped, mirror without delete): install → set sync root + mode in prefs → enable → SyncCoordinator runs baseline (B.2/B.6/B.7), registers collectionWatcher + itemAddHandler, bridges into the scan loop. Disk changes flow through `_detectFolderRenames` + `folderEventDetector`; Zotero changes flow through `collectionWatcher` + `itemMembershipHandler`. All mutations go through `mirrorExecutor` with per-key locks + conflict gate.

**Still pending in v2.1:**
- C1 full setup wizard (multi-step pane; the C2 minimal picker + first-run nudge is in place).
- Folder + conflict-blocked **resolution actions** in prefs UI (counts are surfaced via `getSuppressedCollections` / `getConflictedFiles`; the 4-button resolve flow only exists for file records).
- `_moveItem` cross-action stale-`oldCanonicalPath` race (mitigated by notifier serialization; a real fix reads from the live record).
- Phase E `test/mcp/MODE2.md` runbook for live-Zotero validation.

**Still pending in v2.2 (Mode 3 — safe delete):**
- `_handleZoteroTrash` v2 rewrite with the safe-delete predicate (cascading-trash bug below).
- `.zotero-watch-trash/` local trash dir writes (the scanner skip-list already reserves the name).
- Bulk-delete protection (>10 files or >20% of tree).
- Restore matrix (RST.1–RST.6) — tombstone-aware re-link on file/attachment restore.

**Three sync modes** (`mode` pref): `mode1` (import only — Phase A v2.0), `mode2` (mirror without delete — Phase A1–A6 + B + C + D, v2.1), `mode3` (mirror with safe delete — pending v2.2).

## Layout

- `bootstrap.js` — bootstrapped-addon entry. Registers chrome, calls `_initDefaultPrefs()` (canonical defaults — `prefs.js` at XPI root is not auto-loaded), loads the bundle subscript, calls `Zotero.WatchFolder.hooks.*`.
- `content/*.mjs` — ES module source. Entry is `content/index.mjs`, which exports `hooks` plus `warningSink`, `suppressionResolver`, `baseline` (re-exports for prefs sandbox + MCP access).
- `content/canonicalPath.mjs` — v2 sync-root scoping (`resolveSyncRoot`, `relativePathToCollection`, `chooseCanonicalCollection`, `SyncRootMissingError`, `isSpecialCollection`).
- `content/trackingStore.mjs` — v2 schema (three discriminated record types: `file` / `collection` / `tombstone`; `STATE` frozen enum incl. `USER_DETACHED`). `getSuppressedFiles` / `getSuppressedCollections` / `getConflictedFiles` for the Phase B/D UX. `_byHash` index filtered to syncing states only (review fix: detached records don't satisfy dedup). Persisted as `zotero-watch-folder-tracking-v2.json`. v1 files refused (no migration — clean break).
- `content/preferences.{xhtml,js}` — prefs UI. Copied verbatim, not bundled. v2-aware: sync-root picker + mode display (C2) + warning sink view/clear (D) + suppressed-items resolve (B) + conflict-blocked count (B8 fix). Full multi-step setup wizard (C1) still pending.
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
  - `content/suppressionResolver.mjs` — 4 resolution actions for suppressed FileRecords; `listSuppressed`/`listSuppressedCollections`/`listConflicted` for prefs UI.
- `dist/content/scripts/watchFolder.js` — esbuild IIFE bundle output. **What Zotero actually runs.**
- `prefs.js` — **29 default preference keys** under `extensions.zotero.watchFolder.*` (added `baselineCompletedForRoot` in v2.1).
- `build/{bundle,build,package,release-upload}.mjs` — release pipeline.
- `test/unit/*.test.mjs` + `test/setup/geckoMocks.js` — Vitest, currently **432 passing + 21 skipped across 19 files**. New v2.1 test files: collectionWatcher / folderEventDetector / itemMembershipHandler / mirrorExecutor / mirrorExecutor_warnings / itemAddHandler / warningSink / suppressionResolver / baseline. The 21 skips are v1-schema bodies under `describe.skip` in `watchFolder.test.mjs` (UT-050 / UT-051) — they wait for v2.2's `_handleZoteroTrash` rewrite.
- `test/mcp/` — MCP runbooks against a live Zotero. Entry: `test/mcp/INDEX.md`. `MODE2.md` runbook pending (Phase E).
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
- **`postImportAction='delete'`** records `expectedOnDisk=false` semantics on tracking — used by external-deletion sync to avoid trashing the Zotero item. In Mode 1 the trash branch is gated off entirely; v2.1 keeps Mode 2 warn-only on trash; v2.2 reactivates the propagation.
- **`SyncRootMissingError` is load-bearing.** When `syncRootCollectionKey` resolves to nothing, `canonicalPath.resolveSyncRoot()` throws — callers MUST surface this. Don't add silent fallbacks.
- **`canonicalPath.isSpecialCollection`** filters Duplicates / Unfiled / Trash / My Publications / saved searches (spec Rule 4). Any code that enumerates Zotero collections must pipe through this filter.
- **Sync-root scoping** — `relativePathToCollection` walks DOWNWARD from the sync root. Don't reintroduce library-root-scoped resolution.
- **Mode gates** — three layers:
  - `watchFolder.mjs` legacy: `handleNotification('trash')` and `_handleZoteroTrash` short-circuit when `mode === 'mode1'`.
  - `syncCoordinator.start()`: bails when `mode === 'mode1'`; only Mode 2/3 wires collectionWatcher + itemAddHandler + baseline.
  - `mirrorExecutor._deleteFolder`: Mode 2 warn-only (state flip to OUT_OF_SCOPE_SUPPRESSED + warningSink); Mode 3 deferred to v2.2.
  - Runtime: `syncCoordinator._modeObserverID` watches the mode pref and starts/stops on the fly — no restart required.
- **Per-key executor locks** — `mirrorExecutor._withLock(key, fn)` serializes ops by `collection:<key>` / `attachment:<key>`. Replaces v1 Phase-2's coarse `_isSyncing` global. Don't bypass; don't reintroduce a global lock.
- **Notifier callback chains** — `collectionWatcher` and `itemAddHandler` each have a module-level promise chain (`_notifyChain`) that serializes their notify calls. Zotero fires events as fire-and-forget; concurrent batches would otherwise interleave through async `canonicalPath` lookups and read inconsistent store snapshots.
- **`_byHash` excludes detached states** — `trackingStore._rebuildIndexes` only indexes records whose state is `clean/dirty/pending/pending-zotero-file/pending-hydration/external-edit`. USER_DETACHED, OUT_OF_SCOPE_SUPPRESSED, CONFLICT_BLOCKED, etc. are deliberately excluded so the hash-dedup path can't re-link a fresh import to a Zotero item the user already chose to stop syncing.
- **`baseline.runBaseline` idempotency** — keyed on `baselineCompletedForRoot` pref. Changing the sync root re-triggers; same root no-ops. Force-rerun via `opts.force` for diagnostic.
- **`metadataRetriever.mjs`** has known fire-and-forget `_processQueue()` calls (lines 122, 177, 370) — errors get swallowed. Tracked as a follow-up.

## Tests

Three layers — see [`test/README.md`](./test/README.md) for the overview.

- **`test/unit/`** — Vitest, **432 passing + 21 skipped across 19 files** (skipped tests are v1-schema bodies gated off in Mode 1; they reactivate when v2.2's `_handleZoteroTrash` rewrite lands). `vitest.config.mjs` (globals, Node env). `test/setup/geckoMocks.js` stubs `Zotero`, `IOUtils`, `PathUtils`, `Services`, `Components`, `ChromeUtils`, `crypto.subtle`. New test file: `test/unit/<module>.test.mjs` — import the SUT from `../../content/<module>.mjs`, mock deps per-file with `vi.mock(...)`, reset in `beforeEach`.
- **`test/mcp/`** — MCP runbooks Claude executes against a live Zotero via the bridge. Entry point: [`test/mcp/INDEX.md`](./test/mcp/INDEX.md). Replaces the old manual `TEST_PLAN.md` checklist for day-to-day work. Run **SMOKE.md S.1–S.7** before tagging a release.
- Zero unit coverage on `bulkOperations.mjs`, `metadataRetriever.mjs`, `index.mjs` — gaps are intentional, not invitations to skip.

## Open issues / known bugs

Living lists: `updates_22_05_26.md` (v2 spec), `TODO.md`, `test/mcp/INDEX.md` notes from the latest run.

- **Cascading-trash bug (critical, from 2026-05-22 MCP).** Dedup-skipped files share `itemID` with the matched existing item; deleting one with `diskDeleteSync=auto` would prompt `_promptDiskDelete` for every other file tracked against that itemID. Mode 1 + Mode 2 sidestep this (deletion not propagated). Must fix before v2.2's `_handleZoteroTrash` rewrite re-enables propagation.
- **`metadataRetriever` fire-and-forget queue** at lines 122, 177, 370 — swallowed errors.
- **`tracking.json` not saved when all files dedup-skip** — `_trackingStore.add(...)` flips `_dirty=true` but the early `return` skips the `save()`. Crash between scans loses these adds.
- **Hash chunk caps at 1 MB.** Two PDFs differing only after the first 1 MB SHA-256 identically and one will be marked duplicate. Confirmed in MCP run E.4: appending bytes to the END of a PDF does not bust dedup. Affects B.7 reconcile too — large PDFs sharing a 1MB prefix would be falsely linked.
- **Phase 3 bulk ops** (`reorganizeAll`, `retryAllMetadata`, `applyRulesToAll`) — no UI hook AND not reachable via `Zotero.WatchFolder.hooks`. Effectively dormant.
- **Schema drift in legacy v1 record sites** — `_ensureCollectionRecordsForPath` (watchFolder.mjs) writes `localPath: absDir` (absolute) while v2 spec is sync-root-relative. `folderEventDetector` skips records where `localPath.startsWith('/')` as a workaround. Real fix: migrate v1 write sites.
- **v2.1 deferrals from the review pass** — `_moveItem` reads `oldCanonicalPath` from the payload (can be stale after a same-cycle `moveFolder`); resolver `save()` failures are surfaced via warningSink but not rolled back; per-attachment lock in `moveFolder` child rewrite is mostly mitigated by notifier serialization but still has a cross-watcher window.

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
zotero_search_prefs { query: "watchFolder" }                # all 28 keys
zotero_db_query { sql: "SELECT itemID, dateAdded FROM items WHERE dateAdded > datetime('now','-2 minutes') ORDER BY dateAdded DESC LIMIT 5" }
zotero_execute_js { code: "return { hasHooks: typeof Zotero.WatchFolder?.hooks, hookKeys: Object.keys(Zotero.WatchFolder?.hooks || {}) };" }
zotero_screenshot { target: "main-window" }                 # catch stuck dialogs
```
