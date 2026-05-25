# Tests

Three layers, three audiences.

## `unit/` — Vitest, fast, no Zotero

**432 passing + 21 skipped across 19 files** (as of v2.1). Run with `npm test`. Stubs `Zotero`, `IOUtils`, `PathUtils`, `Services`, `Components`, `ChromeUtils`, `crypto.subtle` via `setup/geckoMocks.js`. Use these for pure-function logic and isolated module behavior. Add a new test file as `unit/<module>.test.mjs` matching the source name.

The 21 skipped tests are v1-schema bodies under `describe.skip` in `watchFolder.test.mjs` (UT-050 / UT-051) — gated off in Mode 1 + 2; they reactivate when v2.2's `_handleZoteroTrash` rewrite lands.

v2.1 added 9 new files covering the Mode 2 pipeline: collectionWatcher, folderEventDetector, itemMembershipHandler, mirrorExecutor, mirrorExecutor_warnings, itemAddHandler, warningSink, suppressionResolver, baseline.

**Known coverage gaps** (deliberate):
- `index.mjs` — bootstrap lifecycle, 0 tests
- `metadataRetriever.mjs` — async queue, 0 tests

## `mcp/` — MCP runbooks, real Zotero, Claude-driven

Markdown runbooks that a Claude Code session executes against a live Zotero instance via the `@introfini/mcp-server-zotero-dev` bridge. Replaces the manual `TEST_PLAN.md` checklist. Entry point: [`mcp/INDEX.md`](./mcp/INDEX.md).

Not runnable from Vitest — MCP tools are only callable from a Claude Code session that has the bridge connected.

## `integration/` — reserved

Currently empty. Kept for future Node-driven integration tests if/when that path becomes practical (e.g., MCP-over-stdio harness).

## `setup/` — shared mocks

`geckoMocks.js` is loaded by Vitest's `setupFiles` and pre-populates `globalThis.Zotero`, `globalThis.IOUtils`, etc. Don't import it directly; reference modules from `../../content/` and let the mocks fill the globals.
