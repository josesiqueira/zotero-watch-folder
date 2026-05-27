# MCP Runbook Index

Executable verification runbooks for `watch-folder@zotero-plugin.org`, driven by `@introfini/mcp-server-zotero-dev`.

## How to use

1. Confirm Zotero is running with MCP Bridge installed: call `zotero_plugin_list` (do NOT use `zotero_ping` — known broken).
2. Pick a runbook below, open its file, execute the listed MCP tool calls in order, evaluate against the pass criteria, then run the cleanup block.
3. After a run, update the **Last run / Status** column below. If you discover the runbook is wrong, fix the runbook in the same change.

All MCP tools are prefixed `mcp___introfini_mcp-server-zotero-dev__` (omitted in runbooks for readability).

## Conventions

- **MCP-automatable** levels:
  - `full` — no human action, runs entirely via MCP + Bash
  - `partial` — human places/removes a file or clicks something, but verification is MCP
  - `manual-only` — requires a user interaction MCP can't synthesize (right-click menus, modal dialogs)
- **Side-effecting MCP tools** (confirm before calling): `zotero_set_pref`, `zotero_plugin_install`, `zotero_plugin_reload`, `zotero_execute_js` with mutation, `zotero_clear_logs`, any `zotero_db_query` with non-SELECT.
- **Watch-folder probe surface**: only `Zotero.WatchFolder.hooks` is reachable from `zotero_execute_js`. The `WatchFolderService` instance is module-private — use `zotero_db_query`, `zotero_get_pref`, and `zotero_read_logs` for state.
- **Test paths**: runbooks assume `/tmp/ZoteroWatchTest/inbox` as the source folder and a `TestImports` collection. Adjust per-environment.

## Status table

Status legend: `✅ pass` · `❌ fail` · `🐛 known-bug` · `⬜ unverified` · `–` not run this cycle.

| Phase | File | Cases | Last run / Status |
|---|---|---|---|
| **v2.0 Mode 1** | [MODE1.md](./MODE1.md) | SETUP.1, ADD.1–3, DUP.1, RENAME.1, LD.1, ZA.1, FM.1 | **Run 2026-05-23 against v2.0.0-alpha.1 build.** Re-run before tagging v2.1 to confirm Mode-1 didn't regress under the new SyncCoordinator wiring (the coordinator is idle in Mode 1 but is now instantiated unconditionally). |
| **v2.1 Mode 2** | [MODE2.md](./MODE2.md) | SETUP.M2.1, BASE.1–3 (B.2/B.6/B.7), ADOPT.1–2, LATE.1, REN.1, MEM.1, SUPP.1, CONF.1, WARN.1 | **Pending.** Sketched during v2.1 work; populate before tagging v2.1.0-alpha.1. Covers the new Mode 2 surface end-to-end. |
| **v2.2 Mode 3** | [MODE3.md](./MODE3.md) | SETUP.M3.1, DEL.1–3, RST.1–6, FDEL.1–2, FRST.1, SR.1 | **Document complete + three live passes (2026-05-25 partial, 2026-05-25b fuller — v2.2.0-alpha.1; 2026-05-27 bulk-focused — v2.5.0-alpha.1).** DEL.1, DEL.1.b, DEL.2 shadow guard, RST.1, RST.3, RST.6, FDEL.1, FRST.1, SR.1 all ✅. **DEL.3 ✅ NEW 2026-05-27** (bulk-delete prompt fires correctly with accurate count + percentage; Cancel demotes 12 records to `missing` state, items untouched). RST.2 / RST.4 / RST.5 / FDEL.2 still deferred to unit-test coverage. Also validated perf-pass paths: bulk-import (12 PDFs into a sub-collection in one cycle, exercises C4 notifier debounce + B3 debounced save); **C1 parallel `_moveFolder` with 12 children** via Zotero-side collection rename — completed in 233 ms with all tracking records updated to new path. |
| Smoke | [SMOKE.md](./SMOKE.md) | S.1, S.2, S.3, S.4, S.5, S.6, S.7 | **Run 2026-05-27 against v2.5.0-alpha.1 (perf pass).** S.1 ✅ · S.2 ✅ · S.3 ✅ · S.4 ⏭️ (stubbed in v2) · S.5 ⬜ (manual-only, not run) · S.6 ✅ (Mode-2 warn-only — record flipped to `missing`, no item trash) · S.7 ⚠️ **partial — `AddonManager.disable()` path works correctly; `enabled` pref-toggle path does NOT stop the scan loop (real bug, pre-existing)**. See post-run notes below. |
| Phase 1 — core | [P1.md](./P1.md) | 1.1 – 1.12 (incl. 1.11.a–f, 1.12.a–d) | **Run 2026-05-22 (v1.2.3):** 1.6 ✅ · 1.8 ✅ · others ⬜. Many cases reference v1 schema fields and need a v2 re-pass. |
| Edge cases | [EDGE.md](./EDGE.md) | E.1 – E.6 | **Run 2026-05-22 (v1.2.3):** E.1 ✅ · E.4 ⚠️ · others ⬜. |
| ~~Phase 2 — collection sync~~ | — | — | **Deleted in Phase E** along with `collectionSync.mjs` & siblings. v2.1's MODE2.md covers the new surface. |
| ~~Phase 3 — advanced~~ | — | — | **Fully deleted (v2.2 cleanup).** `bulkOperations.mjs` removed — the entire v1-era bulk-ops surface (`reorganizeAll`, `retryAllMetadata`, `applyRulesToAll`) was unreachable via `Zotero.WatchFolder.hooks` under v2 and superseded by the sync-coordinator pipeline. |

### Notes from 2026-05-27 run (v2.5.0-alpha.1 — perf-pass verification)

- **S.7 pref-toggle bug (real, pre-existing).** Setting `extensions.zotero.watchFolder.enabled=false` via `Zotero.Prefs.set` does NOT stop the scan loop. Confirmed by dropping two PDFs over 20+ seconds with `enabled=false` — both were imported. `AddonManager.disable()` works correctly (third PDF dropped while truly disabled was ignored, picked up on re-enable). The `enabledObserverID` runtime observer in `content/index.mjs` (added v2.2) isn't actually halting the scanner. Bug is independent of the WP-A/B/C perf pass. Action: investigate + fix as a follow-up patch; document as known limitation until then.
- **DEL.3 bulk-delete prompt UX (new live verification).** `confirmBulkDelete` renders accurately: *"About to trash in Zotero (external-deletion sync) 12 tracked file(s) — roughly 67% of 18 tracked under \"12 missing file(s)\". This is a bulk destructive action. Proceed?"* with Cancel + Proceed. Cancel correctly demotes to `state=missing` for all affected records; Zotero items remain untouched. **Note:** the prompt is modal and the scanner blocks on it — multiple stacked instances can pile up if subsequent scan cycles re-detect the same missing set before the first dialog is dismissed. Worth a debounce or pending-prompt guard in a follow-up.
- **Mozilla Prompter en-GB locale noise.** Zotero 9.0.4 logs `Missing resource in locale en-GB: toolkit/global/commonDialog.ftl` and `uncaught exception: undefined at Prompter.sys.mjs:1272` whenever `confirmEx` fires. The dialog still renders correctly — these are Firefox-platform localization warnings, not blocking. Plugin isn't responsible; not fixable from the plugin layer.
- **C1 parallel `_moveFolder` verified live.** Renaming the `Methods` sub-collection (12 tracked children) → completed in 233 ms with all 12 tracking records updated to the new path (`MethodsRenamed/`), 0 stragglers under the old path, disk dir moved. Semaphore cap 8 means 2 waves of 8 + 4 children.
- **C4 notifier debounce + B3 debounced save exercised.** Bulk import of 12 PDFs into a new sub-collection completed cleanly with no event-storm or wedged tracking state. No errors in 12 collection-item events processed.
- **A1 hash cache + S.3 shadow dedup verified live.** Dropping the same PDF with a different filename → shadow tracking record with `canonicalLocalPath` pointing back to the original, same hash, NO new Zotero item.
- **`H79DCAVM` sync root was in Zotero's trash during orient.** v2.3.2 hardening fired correctly with the spec'd error message and paused the plugin. Test env was switched to a fresh `MWELV57K` (SmokeTest) sync root for the rest of the run.
- **`zotero_execute_js` return-relay flakiness.** Calls that include `await Zotero.DB.queryAsync(...)` returning rows with column aliases intermittently get `undefined` back at the MCP layer (the JS itself ran fine). Workaround: wrap returns in `JSON.stringify(...)` consistently. Different symptom from CLAUDE.md's noted "console actor" issue.

### Notes from 2026-05-22 run

- **Hash-bust limitation**: appending bytes to the END of a PDF does NOT change the dedup hash, because the plugin only hashes the FIRST 1 MB (`utils.mjs` `CHUNK_SIZE` / `duplicateDetector.mjs` `HASH_CHUNK_SIZE`). 1.7 and 1.9 need wholly distinct PDFs to drive new imports.
- **Cascading-trash bug (critical)** discovered during 1.7 prep: dedup-skipped files have tracking records pointing to the matched existing item's `itemID`. When such a file is deleted on disk (`diskDeleteSync=auto`), the plugin trashes the matched item and then prompts `_promptDiskDelete` for EVERY other file currently tracked against that itemID — even ones the user never deleted. Repro: drop a duplicate, let it dedup-track, then `rm` the duplicate.
- **S.4/S.5 dialog status**: the 3-button `_promptDiskDelete` dialog DOES fire and is correctly themed (`Delete permanently` / `Keep on disk` / `Move to OS trash` with `Don't ask again`). Historical bug report in `updates_13_05_26.md` appears outdated.
- **Bridge actor flakiness**: `zotero_read_logs`, `zotero_search_prefs`, `zotero_ping`, and `zotero_set_pref` intermittently fail with "Could not find Zotero console actor". `zotero_execute_js` is the reliable workaround for prefs (via `Zotero.Prefs.set/get`) and for log inspection (via `Zotero.Debug` API).

## Pre-release checklist (v2.1)

Before tagging v2.1.0-alpha.1:
1. **MODE1.md end-to-end** — confirm v2.0 Mode-1 behaviour didn't regress under the v2.1 SyncCoordinator wiring (coordinator instantiated unconditionally but stays idle in Mode 1).
2. **MODE2.md end-to-end** — the new Mode-2 surface. Must populate the runbook first.
3. **SMOKE.md S.1–S.7** — re-run against v2.1 (S.1 key count moved 28 → 29).

The v1 cases that exercise removed code (full-library reorganize, collection sync) are obsolete and won't be re-run.

## Known bugs runbooks should detect

- **`metadataRetriever` fire-and-forget queue** (3 sites at `:122/:177/:370`): swallowed errors, can exceed `maxConcurrent`. No direct runbook; surfaces in P1 1.4 if logs are missing.
- **v1 only — kept for historical reference:** S.4 first-run dialog not firing; `tracking.json` not saved on dedup-skip. The v2 rewrite addresses both via the new schema + save-every-mutation discipline; MODE1.md exercises the new paths.
