# Zotero Watch Folder

A Zotero plugin that watches a folder on your computer and keeps it in sync with your Zotero library. Drop a PDF in the folder and it imports into Zotero with metadata and a properly-templated filename. Optionally, your Zotero collection tree is mirrored as folders on disk, in either or both directions, with a recoverable trash for safe-delete syncs.

Compatible with **Zotero 7, 8, and 9** (`strict_min_version: 6.999`, `strict_max_version: 9.*`). Live-verified on Zotero 9.0.4.

**Current release:** [v2.4.1](https://github.com/josesiqueira/zotero-watch-folder/releases/tag/v2.4.1) (stable).

## Three sync modes

Switch any time from the prefs pane — no Zotero restart needed.

| Mode | Direction | Behavior |
|---|---|---|
| **Mode 1** — import only | disk → Zotero | New files import. Deletes don't propagate either way. Safest. |
| **Mode 2** — mirror without delete | disk ↔ Zotero | Renames + moves propagate both ways. Deletes are warn-only. |
| **Mode 3** — mirror with safe delete | disk ↔ Zotero | Full two-way sync with a recoverable `.zotero-watch-trash/`. Bulk ops prompt for confirmation. |

## Install

1. Download the latest `.xpi` from the [Releases](https://github.com/josesiqueira/zotero-watch-folder/releases) page.
2. In Zotero, open `Tools` → `Plugins`.
3. Click the gear icon and choose `Install Add-on From File...`.
4. Select the downloaded `.xpi` and restart Zotero when prompted.
5. Open `Edit` → `Settings` → `Watch Folder` and run the setup wizard — pick the folder, pick the Zotero collection that anchors the sync (the "sync root"), pick a mode, click Enable.

The plugin auto-updates: future releases roll out via Zotero's update mechanism (manifest pinned to `update.json` on `main`, SHA-256 verified).

## Documentation

Three single-file pages live at the repo root and are served via GitHub Pages at <https://josesiqueira.github.io/zotero-watch-folder/>:

- **[`index.html`](https://josesiqueira.github.io/zotero-watch-folder/index.html)** — overview, features, all 29 preferences explained.
- **[`test-plan.html`](https://josesiqueira.github.io/zotero-watch-folder/test-plan.html)** — user-story walkthrough in five chapters (setup / day-to-day / when something looks off / changing the setup / second computer / cloud / drive).
- **[`test-cases.html`](https://josesiqueira.github.io/zotero-watch-folder/test-cases.html)** — every plugin behavior classified as **Inclusion** (acts on) or **Exclusion** (refuses / skips / suppresses). 20 + 23 cases.

## Features

- **Drop a PDF, it's in Zotero in ~5 seconds.** Metadata fetched, filename templated.
- **Subfolders become subcollections** (and vice versa in Modes 2/3). Renames + moves propagate.
- **Smart rules engine** with prefs-pane JSON editor — match on title / author / DOI / publication / tags / filename, apply add-to-collection / add-tag / set-field / skip-import.
- **Content-hash deduplication.** Re-saving the same paper won't create a duplicate. Hash stamps are embedded in Zotero items' `Extra` field so dedup survives a tracking-store wipe and works across computers via Zotero sync.
- **Recoverable trash.** In Mode 3, files trashed on either side go to `.zotero-watch-trash/` under your watch root. Un-trashing the Zotero attachment restores the file to its original path; manually moving a file back is recognized by hash and re-links.
- **Six-case restore matrix.** Restore a single attachment, restore a parent with multiple attachments, re-attach to a live parent when the attachment was purged, handle collisions with a `.restored.<timestamp>` suffix, restore whole folders from prefs.
- **Bulk-delete confirmation.** Operations affecting more than 10 files or more than 20% of your tracked items prompt before propagating. Headless contexts refuse rather than silently execute.
- **Conflict gate.** If a file's content has drifted (annotations, edits), no sync operation will overwrite it. The record flips to `conflict-blocked` and shows in the prefs pane for explicit resolution.
- **Drive-disconnect safe.** If your watch folder is on a removable drive, the plugin globally pauses when the drive is unreachable instead of mass-trashing tracked items.
- **First-run setup wizard.** Four-step XHTML window: watch folder → sync root → mode → confirm, with mode-specific safety notes. Re-runnable from the prefs pane.

## Configure

Open `Edit` → `Settings` → `Watch Folder` (on macOS: `Zotero` → `Settings`).

Core fields:

- **Enable Watch Folder** — master on/off (toggles the scanner in-process).
- **Source Folder** — the local folder being watched.
- **Sync root collection** — the Zotero collection that anchors the sync.
- **Mode** — Mode 1 / 2 / 3 (see table above).
- **Poll Interval** — seconds between scans (default `5`; adaptive backoff doubles on quiet scans).
- **File Types** — comma-separated extensions, e.g. `pdf,epub`.
- **Import Mode** — `stored` (copy into Zotero) or `linked` (link to original file).
- **Post-Import Action** — `leave`, `delete`, or `move` the source file.
- **Auto-Retrieve Metadata** — fetch PDF metadata via Zotero's recognizer after import.
- **Auto-Rename** + **Rename Pattern** — template like `{firstCreator} - {year} - {title}`. Variables: `{firstCreator}`, `{creators}`, `{year}`, `{title}`, `{shortTitle}`, `{DOI}`, `{itemType}`, `{publicationTitle}`.
- **Disk-delete on Zotero trash** (Mode 3) — `ask` / `plugin_trash` (recoverable) / `os_trash` / `permanent` / `never`.
- **Smart rules** — checkbox + JSON editor + validation. See `test-cases.html` for examples.

All 29 preferences live under `extensions.zotero.watchFolder.*` and can be inspected via `about:config`.

## Known limitations

- **Group libraries** aren't supported yet — the plugin operates on the user library only. Forward-compat hooks are in place (`syncRootLibraryID` pref + library-aware resolver).
- **Folder watching is poll-based**, not OS-event-based. Very short poll intervals on huge folders may increase CPU/disk use; the default 5-second interval is safe for tens of thousands of files.
- **No smart-rule form editor** — rules are managed via the prefs-pane JSON textarea. The engine validates each rule on save.

## For developers

Plain ES modules under `content/`, bundled to an IIFE by esbuild, loaded by `bootstrap.js`. No frameworks, no UI build pipeline.

```bash
npm install      # install dev dependencies (esbuild, vitest, archiver)
npm test         # vitest unit suite — 569 passing across 20 files
npm run bundle   # content/index.mjs → dist/content/scripts/watchFolder.js
npm run build    # copy non-source files into dist/
npm run package  # zip dist/ into the .xpi + write update.json with sha256
```

Source-of-truth docs:

- `CLAUDE.md` — module layout, invariants, "don't touch without understanding" notes. **Read this before editing anything bigger than a comment.**
- `test/README.md` — overview of the test layers (currently: unit suite).

Internal / historical notes (maintainer-only, kept locally in `.private/`,
not in the public repo):

- `.private/docs/` — design history (`ARCHITECTURE.md`,
  `CODEBASE_OVERVIEW.md`, `PHASE*_DESIGN.md`, etc.).
- `.private/legacy/updates_22_05_26.md` — v2 sync-model spec.
- `.private/mcp-runbooks/INDEX.md` — MCP-driven verification runbooks
  used for live testing against Zotero.

Useful entry points:

- `bootstrap.js` — plugin lifecycle + default-pref initialization.
- `content/index.mjs` — bundle entry; exports `Zotero.WatchFolder.hooks`.
- `content/watchFolder.mjs` — main orchestrator (scan loop, notifier handlers, import pipeline).
- `content/canonicalPath.mjs` — sync-root scoping + safe path composition.
- `content/syncCoordinator.mjs` — Mode 2/3 event pipeline orchestrator.
- `content/mirrorExecutor.mjs` — single mutation bottleneck behind per-key locks.
- `content/trackingStore.mjs` — v2 schema (file / collection / tombstone records).
- `content/setupWizard.{xhtml,js}` — v2.4 single-pane setup wizard.

## Contributing

Issues and pull requests are welcome at <https://github.com/josesiqueira/zotero-watch-folder>. Please run `npm test` before opening a PR and, where it makes sense, add a unit test next to the module you are changing. The codebase has a strict no-skipped-tests rule.

## License

GNU GPL v3.0. See `LICENSE` for the full text.
