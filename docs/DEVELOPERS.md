# Developer & technical reference

[![Zotero target version](https://img.shields.io/badge/Zotero-7%2F8%2F9-CC2936?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Latest release](https://img.shields.io/github/v/release/josesiqueira/zotero-watch-folder?style=flat-square&logo=github&label=release)](https://github.com/josesiqueira/zotero-watch-folder/releases/latest)
[![License: GPL v3](https://img.shields.io/github/license/josesiqueira/zotero-watch-folder?style=flat-square)](../LICENSE)

Everything under the hood: architecture, the full feature set described technically, every preference, the build pipeline, and the test layout. If you just want to *use* the plugin, the [README](../README.md) and the [user guide](https://josesiqueira.github.io/zotero-watch-folder/) are the friendlier reads.

> **Working on the code with an AI agent?** Read [`CLAUDE.md`](../CLAUDE.md) first. It holds the load-bearing invariants and "don't touch without understanding" notes that this document deliberately does not repeat.

---

## Architecture at a glance

- **Bootstrapped Zotero add-on.** `bootstrap.js` is the entry point. It registers chrome, initialises default preferences (`prefs.js` at the XPI root is *not* auto-loaded — defaults are seeded in code), loads the bundled subscript, and calls `Zotero.WatchFolder.hooks.*` on the lifecycle events.
- **Plain ES modules, no framework.** Source lives in `content/*.mjs`. The entry module is `content/index.mjs`.
- **esbuild IIFE bundle.** `content/index.mjs` is bundled to `dist/content/scripts/watchFolder.js` (IIFE, `target: firefox128`) and assigned to the global `Zotero.WatchFolder`. **That bundle is what Zotero actually runs** — editing a `.mjs` file does nothing until you re-bundle (see [the pipeline trap](#the-bundle-pipeline-trap)).
- **Only `Zotero.WatchFolder.hooks` is reachable at runtime.** The `WatchFolderService` instance is module-private. To inspect live state, query the DB / prefs / logs rather than reaching into the service.
- **Identity by Zotero key, not numeric ID.** New code identifies items and collections by their 8-character, library-stable Zotero *keys*, not numeric `itemID`s.

The data model is **sync-root-scoped**: one Zotero collection is the "sync root" that anchors everything, and the plugin only ever operates on that collection and its descendants on the Zotero side, mirrored against one folder on disk.

## The three modes, technically

The `mode` preference selects one of three pipelines:

| Mode | Pref value | What gets wired up |
|---|---|---|
| **Import only** | `mode1` | Scan loop + import pipeline only. Notifier trash/modify handlers short-circuit. No mirroring, no deletion. |
| **Mirror without delete** | `mode2` | Adds the `syncCoordinator` pipeline: `collectionWatcher`, `itemAddHandler`, `folderEventDetector`, `itemMembershipHandler`, all mutations through `mirrorExecutor`. Deletions are **warn-only** (flagged to the warning sink, never carried out). |
| **Mirror with safe delete** | `mode3` | Everything Mode 2 wires up, plus real deletion: trashed items move to a recoverable `.zotero-watch-trash/`, with a full restore matrix and bulk-delete confirmation. |

Mode can be switched at runtime — `syncCoordinator` registers an observer on the `mode` pref and starts/stops the right pipeline without a Zotero restart.

## Feature reference

- **Folder polling → import.** A poll loop scans the watch folder on an interval (default 5s) with adaptive backoff (doubles on quiet scans, resets on any non-empty scan). New files matching the configured extensions are imported, metadata is fetched via Zotero's recognizer, and the attachment filename is templated.
- **Two-way folder ↔ collection mirroring (Modes 2/3).** Subfolders become subcollections and vice-versa. Renames and moves propagate in both directions. Disk-side changes flow through `folderEventDetector` + rename detection; Zotero-side changes flow through `collectionWatcher` + `itemMembershipHandler`. All filesystem mutations funnel through a single `mirrorExecutor` guarded by per-key promise-chain locks (`collection:<key>` / `attachment:<key>`).
- **Content-hash deduplication.** Full-file SHA-256 (`HASH_VERSION = 2`). Re-importing the same bytes is recognised and skipped. Hashes are stamped into each item's `Extra` field (`watchfolder-hash:<sha256>`) so dedup survives a tracking-store wipe and travels across machines via Zotero sync. A module-level LRU hash cache keyed by `(path, size, mtime)` avoids redundant disk reads on steady-state scans.
- **Recoverable trash + six-case restore matrix (Mode 3).** Deletions on either side move files into `.zotero-watch-trash/` under the watch root (sync-root-relative subpath preserved, collision-suffixed). Restoring covers: single attachment, parent with multiple attachments, re-attach to a live parent when the attachment was purged, collision handling with a `.restored.<timestamp>` suffix, and whole-folder restore from the settings pane. Tombstone records make hash-based re-linking possible after a trash.
  - **`permanent` is one-time-only, never saved (v2.6.3).** Choosing "Delete permanently" from `_promptDiskDelete` is honored for that single batch (the function's return value), but the "Don't ask again" persist branch downgrades it to `plugin_trash` before writing `diskDeleteOnTrash` and shows a one-time advisory alert — a single click can never arm an unattended every-batch permanent delete. The Mode-3 deletion-disposition picker in `preferences.{xhtml,js}` (`changeDiskDeleteOnTrash`, `DELETION_DISPOSITIONS`) offers only `ask` / `plugin_trash` / `os_trash` / `never`; if `diskDeleteOnTrash` already holds `permanent` (about:config or an old build) the pane surfaces a warn + "Switch to recoverable plugin trash" revert row.
- **Conflict gate.** Before any sync mutation, `canSafelyMove` checks for content drift (annotations, edits). On drift it refuses, flips the record to `conflict-blocked`, and surfaces it for explicit resolution. No sync op ever silently overwrites edited content.
- **Bulk-delete protection.** `bulkGuard` flags operations affecting more than 10 files **or** more than 20% of tracked items and prompts before proceeding. Headless / no-UI contexts **refuse** rather than silently execute.
- **Drive-disconnect safety.** If the watch root becomes unreachable (e.g. an unmounted removable drive), the plugin globally pauses instead of interpreting "everything is missing" as "trash everything."
- **Suppression + warning surfacing.** Out-of-scope and detached items, conflicts, and IO/missing-file warnings are tracked and surfaced in the settings pane with resolve actions (`suppressionResolver`, `warningSink`).
- **Smart rules engine.** Match on title / author / DOI / publication / tags / filename; apply add-to-collection / add-tag / set-field / skip-import. Managed via a JSON editor window opened from the settings pane; each rule is validated on save. Regex matching is ReDoS-hardened (input capped at 8 KB, patterns over 512 chars rejected before compile).
- **First-run setup wizard.** A single XHTML window (`content/setupWizard.{xhtml,js}`) with five steps — watch folder → sync root → mode → PDF storage → confirm — opened via `window.openDialog`. A modal `Services.prompt` sequence is preserved as a fallback when the window can't open. Re-runnable from the settings pane.

### Hardening notes

- **Path-traversal defense** — `canonicalPath.isUnsafeCollectionNameSegment` rejects collection-name segments that are empty / `.` / `..` / contain a separator or NUL, so renaming a collection to `..` can't escape the watch root.
- **Symlink skipping** — the file scanner skips symlinked children so a symlink inside the watch root can't route the recursive scan to arbitrary locations.
- **Prototype-pollution hygiene** — persisted tracking records and parsed smart rules are stripped of `__proto__` / `constructor` / `prototype` keys on load.

## Preferences

All keys live under `extensions.zotero.watchFolder.*` (30 total) and are inspectable via `about:config`. Defaults are seeded by `bootstrap.js`; `prefs.js` is the canonical list.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master on/off. Toggling it starts/stops the scanner in-process. |
| `sourcePath` | `""` | The local folder being watched. |
| `syncRootCollectionKey` | `""` | Zotero collection key that anchors the sync. |
| `syncRootLibraryID` | `1` | Library the sync root lives in (forward-compat; user library only for now). |
| `mode` | `mode1` | `mode1` / `mode2` / `mode3` (see modes table). |
| `pollInterval` | `5` | Seconds between scans; adaptive backoff doubles on quiet scans. |
| `fileTypes` | `pdf` | Comma-separated extensions, e.g. `pdf,epub`. |
| `pdfStorageStrategy` | `stored` | PDF storage layer (orthogonal to `mode`): `stored` / `linked_watch_folder` / `stored_plus_mirror`. Resolved via `storageStrategy.getStorageStrategy()`. |
| `importMode` | `stored` | **Legacy**, superseded by `pdfStorageStrategy`. `stored` or `linked`; `linked` is migrated to `linked_watch_folder`. |
| `postImportAction` | `leave` | `leave` / `delete` / `move` the source file after import. |
| `autoRetrieveMetadata` | `true` | Run Zotero's PDF recognizer after import. |
| `autoRename` | `true` | Rename the attachment after import. |
| `renamePattern` | `{firstCreator} - {year} - {title}` | Template. Vars: `{firstCreator}` `{creators}` `{year}` `{title}` `{shortTitle}` `{DOI}` `{itemType}` `{publicationTitle}`. |
| `diskDeleteOnTrash` | `ask` | Mode 3 deletion behaviour: `ask` / `plugin_trash` / `os_trash` / `permanent` / `never`. |
| `smartRulesEnabled` | `false` | Enable the smart rules engine. |
| `baselineCompletedForRoot` | `""` | Internal: marks the sync root the first-run baseline has reconciled. |

…plus the remaining keys (rename/move targets, debounce tunables, and internal bookkeeping). See `prefs.js` for the complete, authoritative set.

## Build & dev commands

| Command | What it does |
|---|---|
| `npm run bundle` | esbuild: `content/index.mjs` → `dist/content/scripts/watchFolder.js` (IIFE, target firefox128). |
| `npm run build` | Copies root files + `content/` (minus `.mjs` source) + `locale/` into `dist/`. |
| `npm run package` | Zips `dist/` into an `.xpi`, computes SHA-256, writes `update.json`. |
| `npm run release` | `build && bundle && package && release:upload` (uses `gh release upload`). |
| `npm test` / `npm run test:watch` | Vitest. |
| `npm run clean` | Removes `dist/` and `*.xpi`. |

Run a single test file: `npx vitest run test/unit/<module>.test.mjs`. Filter by name: `npx vitest run -t "<test name>"`.

### The bundle-pipeline trap

Editing a `.mjs` file does **not** change what Zotero runs. You must regenerate the bundle:

1. `npm run bundle` — recompiles `dist/content/scripts/watchFolder.js`.
2. `npm run build` — copies the rest of `dist/` (also skips `.mjs` so source isn't shipped).
3. Reload the plugin in Zotero.

Note the order quirk: `npm run release` runs `build` *before* `bundle`. The correct **dev** order is the opposite — bundle → build → reload. If you `npm run build` after editing `.mjs` without `bundle`, you ship stale bundle output.

Version lives in **both** `package.json` and `manifest.json` — keep them in sync. `dist/manifest.json` is regenerated. `update.json` must be committed to `main` (it's served from raw.githubusercontent.com per `manifest.json`) and is **not** auto-uploaded by the release script.

## Tests

Vitest unit suite — **776 passing across 25 files** (zero skipped; strict no-skipped-tests rule). Config in `vitest.config.mjs` (globals, Node env). `test/setup/geckoMocks.js` stubs `Zotero`, `IOUtils`, `PathUtils`, `Services`, `Components`, `ChromeUtils`, and `crypto.subtle`.

To add coverage: create `test/unit/<module>.test.mjs`, import the module under test from `../../content/<module>.mjs`, and mock dependencies per-file with `vi.mock(...)`, resetting in `beforeEach`. Tests that mock `getFileHash` across multiple scenarios must `hashCache.clear()` in `beforeEach` — the cache is a real module singleton, not a per-test mock.

See [`test/README.md`](../test/README.md) for the layered overview.

## Project layout

```
bootstrap.js                 plugin lifecycle + default-pref seeding
content/
  index.mjs                  bundle entry; exports Zotero.WatchFolder.hooks
  watchFolder.mjs            main orchestrator: scan loop, notifier handlers, import pipeline
  canonicalPath.mjs          sync-root scoping + safe path composition
  trackingStore.mjs          v2 schema: file / collection / tombstone records (+ indexes, debounced save)
  syncCoordinator.mjs        Mode 2/3 event-pipeline orchestrator + runtime mode observer
  collectionWatcher.mjs      Zotero notifier observer (collection / collection-item)
  itemMembershipHandler.mjs  collection-item add/remove → canonical recompute
  itemAddHandler.mjs         notifier for late-attached PDFs
  folderEventDetector.mjs    disk-side delete/rename detection
  mirrorExecutor.mjs         single mutation bottleneck, per-key locks, conflict gate
  baseline.mjs               first-run reconcile (copy / mkdir / hash-adopt)
  suppressionResolver.mjs    resolve suppressed items, folders, conflicts; restore trashed folders
  warningSink.mjs            in-memory ring buffer (cap 100) + subscribe API
  bulkGuard.mjs              bulk-delete predicate + confirmation prompt
  storageStrategy.mjs        PDF storage strategy (stored / linked_watch_folder /
                             stored_plus_mirror) + Reclaim & Build-Mirror engines
  _hashCache.mjs             module-level LRU hash cache keyed by (path, size, mtime)
  smartRules.mjs             rule matching engine (ReDoS-hardened)
  setupWizard.{xhtml,js}     single-pane first-run wizard
  preferences.{xhtml,js}     settings pane
  smartRulesEditor.xhtml     standalone JSON rule editor window
dist/content/scripts/watchFolder.js   the esbuild bundle Zotero runs
prefs.js                     canonical default-pref list (30 keys)
build/{bundle,build,package,release-upload}.mjs   release pipeline
test/unit/*.test.mjs         Vitest suite
```

## Documentation map

- **[README.md](../README.md)** — user-facing overview.
- **[architecture.md](architecture.md)** — visual architecture: the layers, the mode × storage-strategy dials, the provider-agnostic cloud layer (WebDAV and folder-sync tools), and runtime-scenario diagrams.
- **[CLAUDE.md](../CLAUDE.md)** — agent working rules, invariants, "don't touch" notes. Read before editing.
- **User guide** (`index.html`, `test-plan.html`, `test-cases.html` at repo root, served via GitHub Pages) — single-file HTML, no build step. Keep in sync at every checkpoint per the policy in `CLAUDE.md`.
- **`.private/`** — gitignored, maintainer-only design history and MCP verification runbooks. Not part of the public repo.

## Contributing

Issues and PRs welcome at <https://github.com/josesiqueira/zotero-watch-folder>. Run `npm test` before opening a PR and add a unit test next to any module you change. The codebase enforces a strict no-skipped-tests rule.

## License

GNU GPL v3.0. See [`LICENSE`](../LICENSE).
