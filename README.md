# Zotero Watch Folder

A Zotero plugin that watches a folder on disk and automatically imports new PDFs (and other configured file types) into your library, with optional metadata retrieval, smart renaming, and collection mirroring.

Built for Zotero 8, also compatible with Zotero 7 and the upcoming Zotero 9 (`strict_min_version: 6.999`, `strict_max_version: 9.*`).

## What it does

Drop a file into your watched folder and the plugin imports it into a target collection in Zotero. Optionally, it fetches metadata, renames the file from a template, and keeps a collection tree mirrored against a folder tree on disk.

## Install

1. Download the latest `.xpi` from the [Releases](https://github.com/josesiqueira/zotero-watch-folder/releases) page.
2. In Zotero, open `Tools` -> `Add-ons`.
3. Click the gear icon and choose `Install Add-on From File...`.
4. Select the downloaded `.xpi` and restart Zotero when prompted.

## Configure

Open `Edit` -> `Settings` -> `Watch Folder` (on macOS: `Zotero` -> `Settings`).

Core settings:

- **Enable Watch Folder** - master on/off switch.
- **Source Folder** - the folder to monitor.
- **Target Collection** - where imported items land (default `Inbox`).
- **Poll Interval** - seconds between scans (default `5`).
- **File Types** - comma-separated extensions, e.g. `pdf,epub`.
- **Import Mode** - `stored` (copy into Zotero) or `linked` (link to original).
- **Post-Import Action** - `leave`, `delete`, or `move` the source file.
- **Auto-Retrieve Metadata** - fetch PDF metadata after import.
- **Auto-Rename** + **Rename Pattern** - template like `{firstCreator} - {year} - {title}`. Available variables: `{firstCreator}`, `{creators}`, `{year}`, `{title}`, `{shortTitle}`, `{DOI}`, `{itemType}`, `{publicationTitle}`.

Optional collection mirroring (Phase 2):

- **Mirror Path** and **Mirror Root Collection** - keep a collection subtree and a folder subtree in sync.
- **Bidirectional Sync** - propagate changes both ways.
- **Conflict Resolution** - `zotero`, `disk`, `last`, `both`, or `manual`.

All preferences live under `extensions.zotero.watchFolder.*` and can be inspected in `about:config`.

## Features

**Auto-import (Phase 1)**

- Polling-based folder watcher with adaptive interval.
- Recursive subfolder scan: `WatchFolder/Research/AI/paper.pdf` imports into `TargetCollection/Research/AI`.
- Metadata retrieval queue with throttling and a `_needs-review` tag for failures.
- Template-based file renaming with sanitization and a configurable max length.
- First-run detection: when the watch folder is set for the first time (or changed), the plugin scans existing files and offers `Import All`, `Skip`, or `Cancel`. Imports run in a batch with a progress window.
- Two-way deletion sync (Phase 1):
  - **Zotero → disk**: when you move an imported item to Zotero's bin, a 3-button dialog asks: `Move to OS trash` (default), `Keep on disk`, or `Delete permanently`. The OS trash (Mac Trash / Windows Recycle Bin / Linux XDG Trash) keeps the file recoverable. "Don't ask again" persists the chosen action via `extensions.zotero.watchFolder.diskDeleteOnTrash` (`ask` / `os_trash` / `permanent` / `never`).
  - **Disk → Zotero**: when you delete a tracked file from the watch folder, the next scan auto-moves the matching Zotero item to Zotero's bin and shows a popup summarising what changed. The wording adjusts for stored vs linked mode. Controlled by `extensions.zotero.watchFolder.diskDeleteSync` (`auto` / `never`).

**Collection mirroring (Phase 2)**

- Collection tree on disk reflects the Zotero collection tree (and optionally vice versa).
- Item moves between collections are mirrored as file moves on disk.
- New folders on disk can create matching collections.
- Multiple conflict-resolution strategies for divergent state.

**Smart features (Phase 3)**

- Smart rules engine: match on title, author, DOI, publication, tags, filename, etc.; apply actions like add-to-collection, add-tag, set-field, or skip-import. Supports nested collection paths.
- Duplicate detection: DOI, ISBN, fuzzy title (configurable threshold), and optional content hash.
- Bulk operations: re-apply naming pattern, retry failed metadata, apply rules across the existing library.

## Known limitations

- Smart rules are evaluated correctly, but there is no GUI for editing them yet. Rules are stored as JSON in `extensions.zotero.watchFolder.smartRules` and must be edited via `about:config` or a small script.
- Folder watching is poll-based, not OS-event-based. Very short poll intervals on large folders may increase CPU/disk use.
- Manual end-to-end test coverage in a live Zotero 8 instance is still in progress (see `TEST_PLAN.md`).

## For developers

The code is plain ES modules under `content/`, loaded by `bootstrap.js`.

```bash
npm install      # install dev dependencies (esbuild, vitest, archiver)
npm run build    # produce build output
npm run package  # produce the .xpi
npm test         # run the vitest unit suite (215 tests across 10 files)
```

Module-level design docs live in `docs/`:

- `docs/ARCHITECTURE.md` - high-level layout.
- `docs/MODULE_DEPENDENCIES.md` - which module depends on which.
- `docs/PHASE1_DESIGN.md` - watch + import + rename.
- `docs/PHASE2_DESIGN.md` - collection/folder sync.
- `docs/PHASE3_AND_PERFORMANCE.md` - rules, duplicates, bulk ops, perf notes.

Useful entry points:

- `bootstrap.js` - plugin lifecycle.
- `content/watchFolder.mjs` - main orchestrator.
- `content/firstRunHandler.mjs` - the simple scan-and-prompt first-run flow.
- `content/collectionSync.mjs` - Phase 2 sync coordinator.
- `content/smartRules.mjs`, `content/duplicateDetector.mjs`, `content/bulkOperations.mjs` - Phase 3.

## Contributing

Issues and pull requests are welcome at <https://github.com/josesiqueira/zotero-watch-folder>. Please run `npm test` before opening a PR and, where it makes sense, add a unit test next to the module you are changing.

## License

MIT. See `LICENSE`.
