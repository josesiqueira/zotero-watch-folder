# Zotero Watch Folder - TODO

Phase 1, Phase 2, and Phase 3 features are all implemented. The remaining open items are listed below.

## Open

- [ ] **Run the 10-minute Smoke Test in a live Zotero install** (`TEST_PLAN.md` → Smoke Test section, cases S.1 through S.7). Covers the dangerous failure paths. Required before any release. The full Exhaustive Verification section (~30 cases) is optional and can be run on a rainy day.
- [ ] **Smart rules management UI.** The engine in `content/smartRules.mjs` works, but rules currently have to be authored as JSON in the `extensions.zotero.watchFolder.smartRules` preference. A small editor in the preferences pane would make the feature usable for non-developers.

## Done

- Phase 1: watch folder, auto-import, metadata retrieval, file renaming, first-run flow, post-import actions.
- Phase 2: collection <-> folder mirroring, item-move sync, folder-to-collection sync, conflict resolution.
- Phase 3: smart rules engine, duplicate detection (DOI / ISBN / fuzzy title / hash), bulk operations.
- Two-way deletion sync: 3-button dialog (OS trash / Keep / Permanent) when Zotero items are trashed; auto-bin + popup when watch-folder files are deleted externally.
- Plugin icons (16/48/96 + source SVG).
- Vitest unit suite covering the modules above (`npm test`, 236 tests).
