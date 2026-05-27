# Tests

## `unit/` — Vitest, fast, no Zotero

**669+ tests passing across 22 files** (as of v2.5.0). Run with `npm test`. Stubs `Zotero`, `IOUtils`, `PathUtils`, `Services`, `Components`, `ChromeUtils`, `crypto.subtle` via `setup/geckoMocks.js`. Use these for pure-function logic and isolated module behavior. Add a new test file as `unit/<module>.test.mjs` matching the source name.

v2.1 added 9 files covering the Mode 2 pipeline: collectionWatcher, folderEventDetector, itemMembershipHandler, mirrorExecutor, mirrorExecutor_warnings, itemAddHandler, warningSink, suppressionResolver, baseline. v2.2 added bulkGuard + UT-090..UT-095 + UT-107 + UT-110/111 + UT-419/420 + UT-830/831. v2.5 added hashCache + extended trackingStore / canonicalPath / smartRules / metadataRetriever / mirrorExecutor / baseline / collectionWatcher / itemMembershipHandler / watchFolder coverage for the perf pass.

**Known coverage gaps** (deliberate):
- `index.mjs` — bootstrap lifecycle, 0 tests
- `metadataRetriever.mjs` — minimal (queue dedup only)

## `setup/` — shared mocks

`geckoMocks.js` is loaded by Vitest's `setupFiles` and pre-populates `globalThis.Zotero`, `globalThis.IOUtils`, etc. Don't import it directly; reference modules from `../../content/` and let the mocks fill the globals.

---

Live-Zotero verification (MCP-driven runbooks) and historical notes live in `.private/mcp-runbooks/` — maintainer-only, kept out of the public repo.
