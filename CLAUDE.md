# CLAUDE.md

Zotero plugin: watches a folder, imports PDFs, mirrors a Zotero library to disk, and (Mode 3) syncs deletions two-way. Targets Zotero 7/8/9 (`strict_min_version 6.999`, live-verified on 9.0.4). Plugin ID `watch-folder@zotero-plugin.org`. Per-release detail lives in git history + `.private/docs/RELEASE_HISTORY.md` — do NOT grow this file with changelogs.

# CRITICAL RULES — MUST FOLLOW

## RESPONSES
- Be concise and direct. Lead with the answer; skip preamble and option-surveys unless asked.
- Report outcomes faithfully: failing tests, skipped steps, unverified work — say so plainly.
- This is a data-safety-critical plugin (it can trash a real Zotero library + the user's files). When a choice risks live data, prefer the safe default and say what you chose; surface genuinely irreversible decisions before acting.

## PLANNING MODE
- For non-trivial work, scout first (list files, find the call sites, scope the diff), then plan; don't assume the design or invariants — read the "DON'T TOUCH" section below.
- Use read-only sub-agents (Explore/Plan) to research breadth and to adversarially review a plan or a risky diff before acting. For data-safety changes, run an adversarial multi-agent review (find → verify → synthesize) before shipping.
- Green-preserving staging: when a change is large, build the new path ALONGSIDE the old (gated by a pref/flag, suite stays green), then flip the default at the end.

## EDIT / CHANGE MODE
- **Bundle trap (the #1 footgun):** editing a `.mjs` does NOT change what Zotero runs. Always `npm run bundle && npm run build`, then reload (`zotero_plugin_reload` or reinstall the `.xpi`). The dev order is bundle→build; `npm run release` runs build→bundle internally — don't hand-run them backwards.
- **No linter exists** — the esbuild bundle IS the syntax/import-cycle check. A clean `npm run bundle` is the lint gate. Be deliberate.
- Version lives in `package.json` AND `manifest.json` — keep them identical. `dist/manifest.json` is regenerated. `update.json` is served from `main` and is NOT auto-uploaded — commit + push it.
- Conventions: classes `PascalCase`, functions `camelCase`, private `_`-prefixed. Named exports only. Async-first. Errors → `Zotero.logError` (user) / `Zotero.debug` (dev). JSDoc public fns. Identity by 8-char Zotero keys, not numeric itemIDs.
- For complex multi-part work, prefer delegating disjoint slices to parallel sub-agents and coordinating; keep live-MCP testing serial (one flaky bridge).

## TESTING — never assume it works
- Run `npx vitest run` (single file: `npx vitest run test/unit/<m>.test.mjs`; by name: `-t "<name>"`). Suite must stay green before any commit/checkpoint. **899 tests across 27 files** — update this count when it changes.
- New module → `test/unit/<m>.test.mjs`, import SUT from `../../content/<m>.mjs`, `vi.mock` deps per-file, reset in `beforeEach`. `test/setup/geckoMocks.js` stubs `Zotero`/`IOUtils`/`PathUtils`/`Services`/`crypto.subtle`. The `_hashCache.mjs` singleton must be cleared in `beforeEach` if you mock `getFileHash`.
- Live verification = `.private/mcp-runbooks/` (maintainer-only). Run **SMOKE.md S.1–S.7** before tagging a release. Version-guard first: `zotero_plugin_list` must equal source version, else you're testing stale code.

## DOCS IN SYNC — at every checkpoint
- Three hand-authored single-file HTML pages at repo root (embedded CSS, no JS, no build): `index.html` (landing), `test-plan.html` (5-chapter user stories), `test-cases.html` (inclusion/exclusion behavior spec). Every behavior must appear in `test-cases.html`.
- On any feature ship / version bump / behavior change: refresh version badges, footer dates, the hero meta strip (test/pref/mode counts), the configure table (mirrors `prefs.js`), and the affected story/case cards. Never describe features that aren't in the current bundle.
- Public dev docs in `docs/` (`DEVELOPERS.md`, `architecture.md`). Pref count + test count also appear in `CLAUDE.md` here and the HTML — keep all occurrences equal.

# SCOPE MODEL (v2.7)
- `scopeMode` pref, the primary dial:
  - **`library`** (default) — the whole library mirrors to the watch root: a root-level drop → Unfiled Zotero item, every top-level collection → a top-level folder, nested → nested. `isSpecialCollection` keeps virtual views out.
  - `collection` (legacy) — a single chosen sync-root collection anchors everything; `relativePathToCollection` walks DOWN from it.
- Migration (`bootstrap.js::_migrateScopeModeForExistingInstall`) PINS every pre-2.7 install to `collection` so the default flip never silently escalates an existing Mode-3 install's delete blast radius from a subtree to the whole library. FAIL-CLOSED (any error → pin to `collection`). The collection-scope code paths + this migration are LOAD-BEARING — never delete them as "dead code".
- New installs onboard to `library` via the setup wizard (`setupWizard.{xhtml,js}` → `_commitWizardResult`); a configured install gates the poll loop on `enabled`/`setupCompleted`.
- `mode` pref (orthogonal to scope): `mode1` import-only | `mode2` mirror-no-delete | `mode3` mirror-with-safe-delete. `pdfStorageStrategy` (orthogonal again): `stored` | `linked_watch_folder` | `stored_plus_mirror` (legacy `importMode` resolved via `storageStrategy.getStorageStrategy`).

# DON'T TOUCH WITHOUT UNDERSTANDING
- **Hash = full-file SHA-256** (`utils.getFileHash`, `HASH_VERSION=2`). `_hashCache.mjs` is a singleton LRU keyed `absPath|size|mtime` — read-avoidance only.
- **`isSpecialCollection` is the SOLE scope boundary** — prefix-matches treeViewID (D/U/T/P/S/F/L virtual; `C`=real). Anything enumerating collections MUST pipe through it; a gap mirrors/deletes a virtual view (Trash/Duplicates/saved-search). Trash excluded; My Publications items sync via their real collection (no duplicate folder).
- **`UNFILED` sentinel ≠ `null`.** `relativePathToCollection('')`→UNFILED (root); `null`=skip. NEVER deref `.key`/`.id` on UNFILED — guard `=== UNFILED` first (truthy frozen object).
- **Delete safety is all fail-CLOSED — never make a delete path fail-open.** A delete proceeds only on a positive `gate.ok`; every uncertain reason (no baseline hash, io-error, hash-failed/drifted) keeps the file + marks `CONFLICT_BLOCKED`.
  - Per-file hash gates: `canSafelyMove` (Zotero→local delete won't clobber a locally-edited file); `canSafelyTrashZoteroAttachment` (local→Zotero trash won't fire if the stored bytes drifted/unprovable).
  - Library-scale nets in `watchRootGuard.mjs`: SYNC-1 top-level-dir fingerprint (a >50% collapse vs last healthy = suspected cloud-eviction → pause; refresh the fingerprint ONLY on a fully-clean cycle so a drip can't ratchet the baseline down); cycle-aggregate cap (refuses N-small-deletes that evade per-action limits).
  - `bulkGuard`: prompt at `>10` files / `>20%` / `>200` absolute; `confirmFirstLibraryDelete` = one-time whole-library blast-radius ack, fail-closed with no UI (so library-scale Mode-3 deletes are effectively disabled on headless/mobile — the safe default). Wired into BOTH folder paths and the two attachment paths (`_handleZoteroTrash`, `_handleExternalDeletions`).
  - These nets are universal across scopes by design (they only ever REFUSE) — the pCloud/WebDAV transient-unmount-then-evict is the single highest-risk trigger for a whole-library wipe.
- **Folder deletion is direction-split** (`mirrorExecutor`): `zoteroCollectionDeleted` (Zotero gone → trash local folder) vs `localFolderDeleted` (disk gone → propagate to Zotero). `deleteFolder` is a back-compat alias. Mode 2 = warn-only both. Don't merge them.
- **Suppress-not-drop:** when a trashed/removed record's local file still exists, flip to `OUT_OF_SCOPE_SUPPRESSED` (collection scope) / move-to-root Unfiled (library scope) — never drop the record, or the next scan re-imports.
- **Shadow records:** two copies of one file under the root → one Zotero item + multiple FileRecords (canonical = `localPath===canonicalLocalPath`). NEVER disk-delete "all records for a key" — only the canonical path is disk-acted; shadows drop tracking only.
- **Tombstones** (`.zotero-watch-trash/` recoverable dir, in `fileScanner.SKIP_DIRNAMES`) drive the RST restore matrix; consulted BEFORE live-record dedup in `_processNewFile`. `_byHash` excludes detached/suppressed states + tombstones.
- **Per-key executor locks** (`mirrorExecutor._withLock` by `collection:`/`attachment:`) + per-module notifier promise-chains with a 100ms debounce (`__test_setDebounceMs(0)` in fake-timer tests). Don't reintroduce a global lock.
- **TrackingStore singleton** (`initTrackingStore`) shared by service + resolver; indexes rebuilt per mutation; `save()` debounced 50ms, `flush()`/`saveNow()` on shutdown. Persisted as `…-tracking-v2.json` (v1 refused).
- **RecognizePDF reparent guard** in `itemMembershipHandler._handleRemove` — don't remove (else fresh imports go suppressed). `SyncRootMissingError`/`LibraryUnavailableError` are load-bearing: callers catch→pause, no silent fallback.
- **`baseline.runBaseline` idempotency** keyed on `baselineCompletedForRoot` (`__library__:<id>` in library scope; `baselineKeyFor` is the shared accessor). Known: `metadataRetriever` fire-and-forget queue swallows errors (tracked).
- **Reentrancy guards** in `WatchFolderService`: `_processingFiles` (per-file) + `_scanInProgress` (per-scan). Don't bypass either. `postImportAction='delete'` records `expectedOnDisk=false` so external-deletion sync won't trash the Zotero item.
- **Library hash stamps** (`watchfolder-hash:<sha256>` in item Extra) are the cross-install dedup anchor when the tracking store is wiped (`_backfillHashesForExistingItems`).
- **Path safety:** `isUnsafeCollectionNameSegment` (path-traversal/NUL/`..`) + `sanitizeCollectionNameSegment` (Windows-reserved/illegal → safe disk folder, round-trips). Watch root may not overlap the Zotero data/storage dir (`utils.isWatchRootUnsafe`, enforced at config time).
- **Working-as-designed, NOT bugs:** "7 PDFs → 4 imported" (content-hash dedup) and "many name-variant copies → 1 item + all disk copies kept" (shadows).

# LAYOUT
- `bootstrap.js` — addon entry: `_initDefaultPrefs` (canonical defaults; `prefs.js` is doc-parity only), migration, loads the bundle, calls `Zotero.WatchFolder.hooks.*`.
- `content/*.mjs` — ES source; entry `content/index.mjs` (exports `hooks` + re-exports for the prefs sandbox/MCP). Key modules:
  - Core: `canonicalPath` (scope resolution, `UNFILED`, `isSpecialCollection`), `trackingStore` (file/collection/tombstone records, singleton), `watchFolder` (poll loop, `_processNewFile`, `_handleZoteroTrash`/`_handleExternalDeletions`/`_handleFileMoves`), `utils`, `fileScanner`, `fileImporter`, `fileRenamer`, `duplicateDetector`.
  - Mirror (Mode 2/3): `syncCoordinator` (start/stop + mode observer + scan bridge), `collectionWatcher`, `folderEventDetector`, `itemMembershipHandler`, `itemAddHandler`, `mirrorExecutor` (ALL fs mutations + per-key locks), `baseline`.
  - Safety/UX: `bulkGuard`, `watchRootGuard`, `suppressionResolver`, `warningSink`, `fileMissing`, `storageStrategy`, `reconcile` (Check & Repair: detect() READ-ONLY + applyRepairs() additive-only, re-validates each finding at apply time), `_hashCache`.
- `content/preferences.{xhtml,js}` + `content/setupWizard.{xhtml,js}` — copied verbatim, not bundled.
- `dist/content/scripts/watchFolder.js` — esbuild IIFE bundle. **What Zotero runs.**
- `prefs.js` / bootstrap `_set` — **33 default keys** under `extensions.zotero.watchFolder.*` (kept in lockstep). `build/*.mjs` — release pipeline. `.private/` — gitignored maintainer docs/runbooks. `tools/hooks/commit-msg` strips AI trailers (`git config core.hooksPath tools/hooks`).

# COMMANDS
| Cmd | Does |
|---|---|
| `npm run bundle` | esbuild `content/index.mjs` → `dist/…/watchFolder.js` |
| `npm run build` | copy root + `content/` (minus `.mjs`) + `locale/` → `dist/` |
| `npm run package` | zip `dist/` → `.xpi`, sha256, write `update.json` |
| `npm run release` | build → bundle → package → `release:upload` |
| `npm test` / `npx vitest run` | unit tests |
| `npm run clean` | removes `dist/` + `*.xpi` |

# RELEASE (opt-in — only when the user says ship/release/push)
1. Checkpoint green: tests pass, version synced in both files, bundle rebuilt + verified, docs/counts refreshed.
2. Commit (`release: vX.Y.Z — <summary>`). Never `--amend`; never force-push `main`; never skip the commit-msg hook.
3. `npm run build && npm run bundle && npm run package` (regenerates `update.json` + `.xpi`); prune stale `.xpi`s.
4. Commit `update.json` alone, then push `main` FIRST (so the tag lands on the right commit + served `update.json` is current).
5. `git tag vX.Y.Z && git push origin vX.Y.Z`, then `npm run release:upload`.
6. Verify rollout: release not-draft + asset attached, asset URL → 200, served `update.json` shows the new version+hash, `sha256sum` of the `.xpi` matches `update_hash`.
- Do NOT run bare `npm run release` for a real ship — it tags against the remote's current `main` before your push.

# MCP (`@introfini/mcp-server-zotero-dev`, wired in `.mcp.json`)
- Healthcheck: `zotero_plugin_list` (NOT `zotero_ping` — it false-negatives). Only `Zotero.WatchFolder.hooks` is reachable via `zotero_execute_js` (service is module-private) — inspect via DB/prefs/logs.
- Side-effecting (confirm first): `zotero_set_pref`, `zotero_plugin_install/reload`, mutating `zotero_execute_js`, non-SELECT `zotero_db_query`, `zotero_clear_logs`.
- Console-actor flakiness: if `zotero_read_logs`/`zotero_search_prefs`/`zotero_set_pref` fail, fall back to `zotero_execute_js` calling `Zotero.Prefs`/`Zotero.Debug` directly.
- Common probes: `zotero_read_logs {filter:"WatchFolder"}`, `zotero_read_errors`, `zotero_search_prefs {query:"watchFolder"}`, `zotero_screenshot` (catch stuck dialogs). Live perf: `Zotero.WatchFolder.__perf.hashCacheStats()`.

# REFERENCE (maintainer-only, gitignored under `.private/`)
- `.private/legacy/updates_22_05_26.md` — sync-model spec (source of truth for behavior). `.private/docs/CODEBASE_OVERVIEW.md` — per-module tour with file:line refs. `.private/docs/RELEASE_HISTORY.md` — the per-release narrative this file no longer carries.
- `.private/docs/WHOLE_LIBRARY_DESIGN.md` — the v2.7 whole-library design + safety plan. `.private/mcp-runbooks/INDEX.md` — live-verification runbooks (start here; `SMOKE.md` before release).
