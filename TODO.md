# Zotero Watch Folder - TODO

Phase 1, Phase 2, and Phase 3 features are all implemented. The remaining open items are listed below.

## Open

- [ ] **Manual end-to-end testing in a live Zotero install.** `TEST_PLAN.md` contains 32 manual cases covering import, metadata, renaming, first-run, collection sync, smart rules, and duplicate detection. None are checked off yet. Top priority before the next release.
- [ ] **Smart rules management UI.** The engine in `content/smartRules.mjs` works, but rules currently have to be authored as JSON in the `extensions.zotero.watchFolder.smartRules` preference. A small editor in the preferences pane would make the feature usable for non-developers.

## Done

- Phase 1: watch folder, auto-import, metadata retrieval, file renaming, first-run flow, post-import actions.
- Phase 2: collection <-> folder mirroring, item-move sync, folder-to-collection sync, conflict resolution.
- Phase 3: smart rules engine, duplicate detection (DOI / ISBN / fuzzy title / hash), bulk operations.
- Two-way deletion sync: 3-button dialog (OS trash / Keep / Permanent) when Zotero items are trashed; auto-bin + popup when watch-folder files are deleted externally.
- Plugin icons (16/48/96 + source SVG).
- Vitest unit suite covering the modules above (`npm test`, 236 tests).
