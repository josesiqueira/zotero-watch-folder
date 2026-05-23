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
| **v2.0 Mode 1** | [MODE1.md](./MODE1.md) | SETUP.1, ADD.1–3, DUP.1, RENAME.1, LD.1, ZA.1, FM.1 | **Not yet run on a live Zotero.** Built 2026-05-23 against B1+B2+B3+B4+B6+C2+E. Run all cases before tagging v2.0. |
| Smoke | [SMOKE.md](./SMOKE.md) | S.1, S.2, S.3, S.4, S.5, S.6, S.7 | **Run 2026-05-22 (v1.2.3):** S.1 ✅ · S.2 ✅ · S.3 ✅ · S.4 ✅ (v1) · S.5 ✅ · S.6 ⚠️ · S.7 ⬜. **Not re-run since v2 rewrite — S.1 will fail (31→28 key count); S.4 is now Mode-1-gated and should be reframed.** |
| Phase 1 — core | [P1.md](./P1.md) | 1.1 – 1.12 (incl. 1.11.a–f, 1.12.a–d) | **Run 2026-05-22 (v1.2.3):** 1.6 ✅ · 1.7 ⬜ · 1.8 ✅ · 1.9 ⬜ · others ⬜. **Many cases reference v1 schema fields and need a v2 re-pass.** |
| Edge cases | [EDGE.md](./EDGE.md) | E.1 – E.6 | **Run 2026-05-22 (v1.2.3):** E.1 ✅ · E.4 ⚠️ · others ⬜. |
| ~~Phase 2 — collection sync~~ | — | — | **Deleted in Phase E** along with `collectionSync.mjs` & siblings. v2.1 will write a fresh `MODE2.md`. |
| ~~Phase 3 — advanced~~ | — | — | **Deleted in Phase E**. `reorganizeAll` removed; `retryAllMetadata` + `applyRulesToAll` survived. Reduced surface — no separate runbook now. |

### Notes from 2026-05-22 run

- **Hash-bust limitation**: appending bytes to the END of a PDF does NOT change the dedup hash, because the plugin only hashes the FIRST 1 MB (`utils.mjs` `CHUNK_SIZE` / `duplicateDetector.mjs` `HASH_CHUNK_SIZE`). 1.7 and 1.9 need wholly distinct PDFs to drive new imports.
- **Cascading-trash bug (critical)** discovered during 1.7 prep: dedup-skipped files have tracking records pointing to the matched existing item's `itemID`. When such a file is deleted on disk (`diskDeleteSync=auto`), the plugin trashes the matched item and then prompts `_promptDiskDelete` for EVERY other file currently tracked against that itemID — even ones the user never deleted. Repro: drop a duplicate, let it dedup-track, then `rm` the duplicate.
- **S.4/S.5 dialog status**: the 3-button `_promptDiskDelete` dialog DOES fire and is correctly themed (`Delete permanently` / `Keep on disk` / `Move to OS trash` with `Don't ask again`). Historical bug report in `updates_13_05_26.md` appears outdated.
- **Bridge actor flakiness**: `zotero_read_logs`, `zotero_search_prefs`, `zotero_ping`, and `zotero_set_pref` intermittently fail with "Could not find Zotero console actor". `zotero_execute_js` is the reliable workaround for prefs (via `Zotero.Prefs.set/get`) and for log inspection (via `Zotero.Debug` API).

## Pre-release checklist (v2.0)

Before tagging v2.0, run **MODE1.md end-to-end** plus any v1 cases in SMOKE / P1 / EDGE that still match the v2 surface. The v1 cases that exercise removed code (full-library reorganize, collection sync) are obsolete and won't be re-run.

## Known bugs runbooks should detect

- **`metadataRetriever` fire-and-forget queue** (3 sites at `:122/:177/:370`): swallowed errors, can exceed `maxConcurrent`. No direct runbook; surfaces in P1 1.4 if logs are missing.
- **v1 only — kept for historical reference:** S.4 first-run dialog not firing; `tracking.json` not saved on dedup-skip. The v2 rewrite addresses both via the new schema + save-every-mutation discipline; MODE1.md exercises the new paths.
