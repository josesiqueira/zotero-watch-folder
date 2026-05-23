# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Zotero plugin that polls a folder, imports new PDFs into a target collection, dedupes them, and optionally moves/renames the source files. Targets Zotero 7/8/9 (`strict_min_version: 6.999`).

Plugin ID: `watch-folder@zotero-plugin.org`. Version lives in `package.json` AND `manifest.json` — keep them in sync.

## v2 rewrite in progress — read this before editing

The codebase is mid-rewrite from the original library-root-scoped model to a **sync-root-scoped, mode-based** model. The bundle still runs at v1.2.3 semantics in production, but new code uses the v2 schema and helpers. Spec: `updates_22_05_26.md`. Long-form tour of current state: `docs/CODEBASE_OVERVIEW.md`.

**Landed (v2.0 work-in-progress):**
- **Phase A** (`bfdf3ba`) — sync-root concept, mode enum, v2 tracking schema, identity by Zotero attachment KEY (not numeric itemID), `canonicalPath.mjs`, hash-invariant fix (`HASH_CHUNK_SIZE` is now a single named export).
- **Phase B1** (`377c41a`) — Mode 1 (import-only) end-to-end wiring: imports resolve target collection through `canonicalPath` (sync-root-scoped), build v2 `file` records, surface `SyncRootMissingError`. Move-detection still runs in Mode 1 (local-side moves update Zotero collection membership).
- **Phase B3 + B6** (`cfecfe1`) — dedup priority rewrite (hash → definitive, first; DOI/ISBN/title gated to post-metadata stage); new `content/fileMissing.mjs` classifier (DRIVE_DISCONNECTED / PERMISSION_DENIED / CLOUD_PLACEHOLDER / USER_DELETED) wired into `_handleExternalDeletions` with a whole-mount sanity check at the top.
- **Phase B4 (light)** (`377c41a`) — Mode 1 deletion gating: `_handleZoteroTrash`, `_handleExternalDeletions` trash branch, and `handleNotification('trash')` all no-op when `mode === 'mode1'`. Mode 1 never propagates Zotero deletions to disk.
- **Phase E** (`aab70b2`) — cleanup: deleted `collectionSync.mjs` (+ 5 sibling Phase-2 modules), `bootstrap-old.js`, `bootstrap-simple.js`; trimmed `bulkOperations.reorganizeAll` (library-wide rename incompatible with sync-root model); lifted scanner skip list to a shared `SKIP_DIRNAMES` set (`imported` + `.zotero-watch-trash` reservation for v2.2).
- **Phase C2** (`44a808f`) — prefs UI sync-root picker. Replaces the v1 `targetCollection` text input with `Services.prompt.select` over user-library collections (filtered through `isSpecialCollection`). Adds a read-only mode display.

**Mode 1 is functional end-to-end** in v2.0: install → set watch folder + sync root in prefs → enable → drop files into the watch folder. Imports land in the configured Zotero sync-root collection (or its subcollections matching the local subfolder structure).

**Still v1 / still pending in v2.0:**
- `_handleZoteroTrash` body (gated off in Mode 1; v2.1 rewrites for the safe-delete predicate).
- `firstRunHandler.mjs` (B5 — depends on the full setup wizard from C1).
- Folder rename → Zotero collection rename (B2 — currently each per-file move re-resolves a new collection; the OLD collection is left empty).
- Full setup wizard (C1) and hooks-wiring changes (C3).
- MCP runbooks for end-to-end verification (Phase D3).

**Three sync modes** (`mode` pref): `mode1` (import only — only this is functional), `mode2` (mirror without delete), `mode3` (mirror with safe delete via plugin trash dir).

## Layout

- `bootstrap.js` — bootstrapped-addon entry. Registers chrome, calls `_initDefaultPrefs()` (canonical defaults — `prefs.js` at XPI root is not auto-loaded), loads the bundle subscript, calls `Zotero.WatchFolder.hooks.*`.
- `content/*.mjs` — ES module source. Entry is `content/index.mjs`, which only exports `hooks`.
- `content/canonicalPath.mjs` — v2 sync-root scoping (`resolveSyncRoot`, `relativePathToCollection`, `chooseCanonicalCollection`, `SyncRootMissingError`, `isSpecialCollection`). Replaces the removed `utils.getOrCreateTargetCollection` / `getOrCreateCollectionPath`.
- `content/trackingStore.mjs` — v2 schema (three discriminated record types: `file` / `collection` / `tombstone`; `STATE` frozen enum). Persisted as `zotero-watch-folder-tracking-v2.json`. v1 files refused (no migration — clean break).
- `content/preferences.{xhtml,js}` — prefs UI. Copied verbatim, not bundled. v2-aware via Phase C2: sync-root picker + mode display. The full multi-step setup wizard (C1) is still pending.
- `content/fileMissing.mjs` — v2 missing-file classifier (`classifyMissingFile`, `isWatchRootAvailable`, `MISSING_CLASSIFICATION`, `STATE_FOR_CLASSIFICATION`). Wired into `_handleExternalDeletions`.
- `dist/content/scripts/watchFolder.js` — esbuild IIFE bundle output. **What Zotero actually runs.**
- `prefs.js` — **28 default preference keys** under `extensions.zotero.watchFolder.*` (was 31 in v1).
- `build/{bundle,build,package,release-upload}.mjs` — release pipeline.
- `test/unit/*.test.mjs` + `test/setup/geckoMocks.js` — Vitest, currently **296 passing + 21 skipped across 11 files** (down from 17 files / 449 tests after Phase E deleted the Phase-2-module tests). The 21 skips are v1-schema bodies under `describe.skip` in `watchFolder.test.mjs` (UT-050 / UT-051) — they wait for v2.1's Phase B4 rewrite.
- `test/mcp/` — MCP runbooks against a live Zotero. Entry: `test/mcp/INDEX.md`.
- `test_pdfs/` — local PDF fixtures for manual / MCP runs (gitignored content, present locally).
- `docs/` — `ARCHITECTURE.md` (Zotero 8 platform notes), `CODEBASE_OVERVIEW.md` (long-form per-module tour with file:line refs), `MODULE_DEPENDENCIES.md`, `PHASE{1,2,3}_DESIGN.md`.
- `updates_22_05_26.md` — v2 sync-model spec. **Source of truth for new behavior.**
- `behavior_updates.md` — case-template spec (`INCLUSION` / `EXCLUSION` matrices). Mostly stub; expand here as cases are pinned down.
- `tools/hooks/commit-msg` — strips AI co-author trailers. Install with `git config core.hooksPath tools/hooks` (per-clone).
- (Legacy `bootstrap-old.js` / `bootstrap-simple.js` and the entire Phase 2 `collectionSync.mjs` family were deleted in Phase E.)

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

- **1 MB hash chunk size — now a single source.** `content/utils.mjs` exports `HASH_CHUNK_SIZE`; `content/duplicateDetector.mjs` imports it and has a module-load assertion. The old "two literals must stay equal" trap is fixed — don't re-duplicate the constant.
- **Library hash stamps** (`watchfolder-hash:<sha256>` in item Extra field) remain the fallback when the tracking store is wiped. See `watchFolder.mjs._backfillHashesForExistingItems` (uses v2: `getAllOfType('file')`, `getByLibraryAndKeyAsync`, `record.zoteroAttachmentKey`, `record.lastSyncedHash`).
- **`_processingFiles` Set** in `WatchFolderService` is the only per-file reentrancy guard for the poll loop. `_scanInProgress` is the second guard at the scan level. Don't bypass either.
- **`postImportAction='delete'`** still records `expectedOnDisk=false` semantics on tracking — used by external-deletion sync to avoid trashing the Zotero item. In Mode 1 the trash branch is gated off entirely; v2.1+ reactivates it.
- **`SyncRootMissingError` is load-bearing.** When `syncRootCollectionKey` resolves to nothing, `canonicalPath.resolveSyncRoot()` throws — callers MUST surface this. The old `collectionSync.mjs` silently no-op'd on missing root; that's how it broke in production. Don't add silent fallbacks.
- **`canonicalPath.isSpecialCollection`** filters Duplicates / Unfiled / Trash / My Publications / saved searches (spec Rule 4). Any new code that enumerates Zotero collections must pipe through this filter.
- **Sync-root scoping** — `relativePathToCollection` walks DOWNWARD from the sync root. Don't reintroduce library-root-scoped resolution (the removed `getOrCreateCollectionPath` is the anti-pattern).
- **Mode gates in `watchFolder.mjs`:** `handleNotification('trash')`, `_handleZoteroTrash`, and the `trulyMissing` branch in `_handleExternalDeletions` all check `getPref('mode') === 'mode1'` and short-circuit / state-flip-only. Don't add new Zotero-mutating code paths without a mode gate.
- **`collectionSync.mjs` (Phase 2)** is implementation-complete but never validated in a real Zotero install. Disabled by default. Will likely be partly replaced by Mode 2/3 logic in v2.1/v2.2 — don't invest in it.
- **`metadataRetriever.mjs`** has known fire-and-forget `_processQueue()` calls (lines 122, 177, 370) — errors get swallowed. Be careful adding more; if you do, attach `.catch(e => Zotero.logError(e))`.

## Tests

Three layers — see [`test/README.md`](./test/README.md) for the overview.

- **`test/unit/`** — Vitest, **413 passing + 21 skipped across 16 files** (skipped tests are v1-schema bodies gated off in Mode 1; they reactivate as Phase B4/B5 rewrites the consumers). `vitest.config.mjs` (globals, Node env). `test/setup/geckoMocks.js` stubs `Zotero`, `IOUtils`, `PathUtils`, `Services`, `Components`, `ChromeUtils`, `crypto.subtle`. New test file: `test/unit/<module>.test.mjs` — import the SUT from `../../content/<module>.mjs`, mock deps per-file with `vi.mock(...)`, reset in `beforeEach`.
- **`test/mcp/`** — MCP runbooks Claude executes against a live Zotero via the bridge. Entry point: [`test/mcp/INDEX.md`](./test/mcp/INDEX.md). Replaces the old manual `TEST_PLAN.md` checklist for day-to-day work. Run **SMOKE.md S.1–S.7** before tagging a release.
- Zero unit coverage on `bulkOperations.mjs`, `metadataRetriever.mjs`, `index.mjs` — gaps are intentional, not invitations to skip.

## Open issues / known bugs

Living lists: `updates_22_05_26.md` (v2 spec), `updates_13_05_26.md` (older), `TODO.md`, `test/mcp/INDEX.md` notes from the latest run.

- **Cascading-trash bug (critical, discovered 2026-05-22).** Dedup-skipped files share `itemID` with the matched existing item. When such a file is deleted on disk with `diskDeleteSync=auto`, the plugin trashes the matched item AND prompts `_promptDiskDelete` for every other file currently tracked against that itemID — even ones the user never deleted. Repro: drop a duplicate, let it dedup-track, then `rm` it. Mode 1 gating sidesteps this in v2.0; v2.1's B4 must fix it before re-enabling deletion sync.
- **S.4 trash dialog status corrected.** The 3-button `_promptDiskDelete` DOES fire correctly (verified 2026-05-22). Prior "never fires" reports are outdated. Still gated off in Mode 1.
- **`metadataRetriever` fire-and-forget queue** at lines 122, 177, 370 — swallowed errors.
- **`tracking.json` not saved when all files dedup-skip** — `_trackingStore.add(...)` flips `_dirty=true` but the early `return` skips the `save()`. Crash between scans loses these adds.
- **Hash chunk caps at 1 MB.** Two PDFs differing only after the first 1 MB will SHA-256 identically and one will be marked duplicate. Confirmed bites MCP runs (E.4): appending bytes to the END of a PDF does not bust dedup.
- **Phase 3 bulk ops** (`reorganizeAll`, `retryAllMetadata`, `applyRulesToAll`) — no UI hook AND not reachable via `Zotero.WatchFolder.hooks`. Effectively dormant.
- **Schema drift in some legacy v1 record sites** (importedAt vs importDate, isDuplicate not in typedef). v2 `createFileRecord` is the canonical path; migrate stragglers.

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
