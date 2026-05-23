# Zotero Watch Folder — CLAUDE.md

Zotero plugin that polls a folder, imports new PDFs into a target collection, dedupes them, and optionally moves/renames the source files. Targets Zotero 7/8/9 (`strict_min_version: 6.999`).

Plugin ID: `watch-folder@zotero-plugin.org`. Current version in `package.json` and `manifest.json` (keep in sync).

## Layout

- `bootstrap.js` — Zotero bootstrapped-addon entry. Loads the bundled IIFE as a subscript and calls `Zotero.WatchFolder.hooks.*`.
- `content/*.mjs` — ES module **source**. Entry is `content/index.mjs`, which only exports `hooks`.
- `content/preferences.{xhtml,js}` — prefs UI (copied verbatim, not bundled).
- `dist/content/scripts/watchFolder.js` — esbuild IIFE **bundle output**. This is what actually runs in Zotero.
- `prefs.js` — 31 default preference keys under `extensions.zotero.watchFolder.*`.
- `build/{bundle,build,package,release-upload}.mjs` — release pipeline.
- `test/unit/*.test.mjs` + `test/setup/geckoMocks.js` — Vitest, ~375 tests.
- `docs/` + `TEST_PLAN.md` + `updates_13_05_26.md` + `TODO.md` — design notes, manual test checklist, open issues.
- `bootstrap-old.js`, `bootstrap-simple.js` — **legacy, ignore**. Only `bootstrap.js` is referenced from `manifest.json`.

## Build & dev commands

| Command | What it does |
|---|---|
| `npm run bundle` | esbuild: `content/index.mjs` → `dist/content/scripts/watchFolder.js` (IIFE, target firefox128) |
| `npm run build` | Copies root files + `content/` (minus `.mjs` source) + `locale/` into `dist/` |
| `npm run package` | Zips `dist/` into an `.xpi`, computes SHA-256, writes `update.json` |
| `npm run release` | `build && bundle && package && release:upload` (uses `gh release upload`) |
| `npm test` / `npm run test:watch` | Vitest |
| `npm run clean` | Removes `dist/` and `*.xpi` |

## Bundle-pipeline trap

Editing a `.mjs` file does NOT update what Zotero runs. The build pipeline must regenerate the bundle:

1. `npm run bundle` — recompiles `dist/content/scripts/watchFolder.js`
2. `npm run build` — copies the rest of `dist/` (also skips `.mjs` so source isn't shipped)
3. Reload the plugin in Zotero (or reinstall the `.xpi`)

If you change `manifest.json` version, also bump `package.json` version. Those two files are the only sources of truth; `dist/manifest.json` is regenerated.

## Conventions

- Classes `PascalCase`, functions `camelCase`, private fields/methods prefixed `_`.
- Named exports only. No default exports.
- Async-first; errors go to `Zotero.logError()` (user-visible) or `Zotero.debug()` (dev-only).
- JSDoc on public functions. No linter is configured — be deliberate.

## Don't touch without understanding

- **1 MB hash chunk size** is duplicated. `content/utils.mjs` `CHUNK_SIZE` and `content/duplicateDetector.mjs` `HASH_CHUNK_SIZE` MUST stay equal — divergence silently breaks dedup and move detection.
- **Library hash stamps** (`watchfolder-hash:<sha256>` in item Extra field) are the fallback when the tracking store is wiped. See `watchFolder.mjs` backfill on startup.
- **`_processingFiles` Set** in `WatchFolderService` is the only reentrancy guard for the poll loop. Don't bypass it.
- **`postImportAction='delete'`** sets `expectedOnDisk=false` in the tracking record. External-deletion sync uses that flag to avoid trashing the Zotero item. Preserve it.
- **`collectionSync.mjs` (Phase 2)** is implementation-complete but never validated in a real Zotero install. Disabled by default — assume sharp edges.
- **`metadataRetriever.mjs`** has known fire-and-forget `_processQueue()` calls (~lines 122, 177, 370) — errors get swallowed. Be careful adding more.

## Tests

Three layers — see [`test/README.md`](./test/README.md) for the full overview.

- **`test/unit/`** — Vitest, ~375 tests, `vitest.config.mjs` (globals, Node env). `test/setup/geckoMocks.js` stubs `Zotero`, `IOUtils`, `PathUtils`, `Services`, `Components`, `ChromeUtils`, `crypto.subtle`. New test file: `test/unit/<module>.test.mjs` — import the SUT from `../../content/<module>.mjs`, mock deps per-file with `vi.mock(...)`, reset in `beforeEach`.
- **`test/mcp/`** — MCP runbooks Claude executes against a live Zotero via the bridge. Entry point: [`test/mcp/INDEX.md`](./test/mcp/INDEX.md). Replaces the old manual `TEST_PLAN.md` checklist for day-to-day work. Run **SMOKE.md** before tagging a release.
- Zero unit coverage on `bulkOperations.mjs`, `metadataRetriever.mjs`, `index.mjs` — gaps are intentional, not invitations to skip.

## Open issues (see `updates_13_05_26.md`, `TODO.md`)

- S.4 trash-dialog never fires (right-click → Move to Bin) — `watchFolder.mjs` `_handleZoteroTrash` / `_promptDiskDelete`.
- `metadataRetriever` fire-and-forget queue (3 sites).
- `tracking.json` not saved when all files are dedup-skipped.
- Phase 2 collection sync — physical folder move on collection rename, mount-unavailable handling.
- Phase 3 bulk ops (`reorganizeAll`, `retryAllMetadata`, `applyRulesToAll`) — no UI, console-only.

---

## MCP: verifying the plugin via `@introfini/mcp-server-zotero-dev`

The MCP server is wired in `.mcp.json`. Tool names are prefixed `mcp___introfini_mcp-server-zotero-dev__` (omitted in runbooks for readability).

**Canonical verification surface:** the MCP runbooks in [`test/mcp/`](./test/mcp/INDEX.md). Start at `INDEX.md`, pick the relevant phase file, execute. **SMOKE.md S.1–S.7** is the pre-release checklist.

**What's reachable via `zotero_execute_js`:** the bundle is an esbuild IIFE assigned to `Zotero.WatchFolder`. Only the entry point's exports are visible, which means **only `Zotero.WatchFolder.hooks` exists** — the `WatchFolderService` instance is module-private. Inspect live state via DB queries, prefs, and logs instead.

**Bridge quirk:** `zotero_ping` reports "cannot connect" even when the bridge is fully functional (it probes a different actor). Use `zotero_plugin_list` as the real healthcheck.

**Side-effecting tools — confirm before calling:** `zotero_set_pref`, `zotero_plugin_install`, `zotero_plugin_reload`, `zotero_execute_js` with mutating code, `zotero_db_query` with non-SELECT, `zotero_clear_logs`.

**Quick reference — common probes:**

```
zotero_plugin_list                                          # healthcheck
zotero_plugin_reload { pluginId: "watch-folder@zotero-plugin.org" }
zotero_read_logs { filter: "WatchFolder", lines: 40 }
zotero_read_errors { lines: 20 }
zotero_search_prefs { query: "watchFolder" }                # all 31 keys
zotero_db_query { sql: "SELECT itemID, dateAdded FROM items WHERE dateAdded > datetime('now','-2 minutes') ORDER BY dateAdded DESC LIMIT 5" }
zotero_execute_js { code: "return { hasHooks: typeof Zotero.WatchFolder?.hooks, hookKeys: Object.keys(Zotero.WatchFolder?.hooks || {}) };" }
zotero_screenshot { target: "main-window" }                 # catch stuck dialogs
```
