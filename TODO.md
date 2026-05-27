# Zotero Watch Folder — TODO

**Status:** **`v2.4.1`** stable (latest GitHub release, marked Latest). Builds
on the v2.3.x stable line + the v2.4.0 single-pane setup wizard. All three
modes ship end-to-end: Mode 1 (import only), Mode 2 (mirror without delete),
Mode 3 (mirror with safe delete). **569 unit tests** passing across 20 files,
zero skipped. **Compatible with Zotero 7, 8, 9** (live-verified on Zotero 9.0.4).
Security audit closed: zero MEDIUM findings, zero LOW findings, zero
release-blocking issues.

---

## Open work

**Nothing release-blocking.** Both remaining items are MCP runbook
follow-ups — manual live-test passes that confirm behavior the unit
suite already covers.

### Small follow-ups (not blocking)

- [~] **Phase E `test/mcp/MODE2.md` runbook live pass.** Mostly done
      during the 2026-05-25c run: BASE.1, MEM.1, REN.1, SUPP.1
      (with safety-net auto-clear), CONF.1, WARN.1, plus a new
      RecognizePDF-import sanity case all passed live against the
      post-fix bundle. Still pending: BASE.2 (B.2 copy from Zotero
      storage), BASE.3 (B.7 hash reconcile), ADOPT.1 (drag populated
      collection into scope), LATE.1 (late-attached PDF). All four
      were live-passed in the original 2026-05 run, so this is
      partial-completeness housekeeping more than discovery work.

- [ ] **Larger live-MCP coverage of Mode 3 scenarios we skipped.**
      DEL.3 (>10 distinct PDFs), RST.2 (parent restore with multiple
      attachments), RST.4 (selective restore), RST.5 (re-attach to
      live parent), FDEL.2 (bulk folder delete). All unit-tested
      (UT-090 ×2 for parent-expand, UT-091..094 for the restore
      matrix, UT-419/420 for deleteFolder). Live-pass deferred from
      the 2026-05-27 attempt because the Zotero JAR cache rejected
      the post-`zotero_plugin_install` bundle without a full Zotero
      restart. Needs: a fresh Zotero process + 10+ distinct PDFs
      + a multi-attachment-parent setup.

### Bigger directions to consider

Pull these into a track when you want a v2.5+ milestone:

- **Cross-library / group library sync.** Forward-compat work is
  already in place: `syncRootLibraryID` pref + load-time library
  resolution. Adding group-library support means changing the
  Zotero notifier handlers + canonical-path resolver to be
  library-aware in all their lookups, plus a UI surface in the
  wizard to pick the library.
- **Smart-rule UI form editor.** The engine handles all rule
  shapes; the JSON textarea in prefs is the friction point. A
  form-based editor with operator dropdowns, field autocomplete,
  and per-action argument hints would make rules approachable
  for non-developers.
- **File-naming template upgrades.** Current variables:
  `{firstCreator}`, `{creators}`, `{year}`, `{title}`,
  `{shortTitle}`, `{DOI}`, `{itemType}`, `{publicationTitle}`.
  Worth adding: `{collection}` (the leaf-collection name),
  `{year-2}` (just last two digits), `{n}` (counter for batch
  imports), template conditionals.
- **Cross-platform symlink + reparse-point hardening.** v2.4.1's
  symlink-skip is correct on Linux/macOS via `nsIFile.isSymlink()`.
  Windows reparse points and macOS firmlinks have edge cases the
  current detector treats as non-symlinks. Low risk on a single-
  user system; worth a sweep before exposing the plugin to
  multi-user environments.
- **`docs/CODEBASE_OVERVIEW.md` refresh.** Partially stale from
  the v1 era. `CLAUDE.md` is the current source of truth for
  module layout + invariants — the overview doc should either be
  rewritten or removed in favor of CLAUDE.md.

---

## Quick commands

```sh
npm test                              # vitest, 569 passing / 0 skipped
npm run bundle                        # rebuild dist/content/scripts/watchFolder.js
npm run build && npm run bundle && npm run package
                                      # full XPI rebuild → zotero-watch-folder-2.4.1.xpi
gh release view v2.4.1                # latest release page
```

When working with the live Zotero MCP bridge:
- Health check: `zotero_plugin_list` (not `zotero_ping` — known broken).
- If the bridge wedges with "Could not find Zotero console actor",
  just retry — it's intermittent. If port 6100 stops listening,
  Zotero needs a restart.
- `Zotero.DB.executeTransaction(async () => { await x.save(); })` is
  the reliable save pattern; bare `await x.saveTx()` silently fails
  in the bridge's IIFE wrapper.
- After `zotero_plugin_install`, the JAR cache rejects the new
  bundle silently. A full Zotero restart is the only reliable way
  to load post-install changes (discovered 2026-05-27).
- Pre-warm MCP permissions before mobile sessions with the
  `zotero-mcp-warmup` skill — see `.claude/skills/zotero-mcp-warmup/SKILL.md`.

---

## Where things live

- `CLAUDE.md` — project layout, invariants, "don't touch without
  understanding" notes. **Source of truth.** Read this BEFORE
  editing anything bigger than a comment.
- `updates_22_05_26.md` — the v2 sync-model spec. Source of truth
  for behavior (restore matrix RST.1–RST.6, suppression rule,
  mode definitions).
- `behavior_updates.md` — inclusion/exclusion case template (mostly
  stub); the canonical "every behavior in one place" reference
  lives at `test-cases.html` now.
- `index.html`, `test-plan.html`, `test-cases.html` — three user-
  facing HTML pages at the repo root. Single-file, embedded CSS,
  no JS, no build step. Served via GitHub Pages at
  https://josesiqueira.github.io/zotero-watch-folder/.
- `test/README.md` — three test layers (unit / mcp / integration).
- `test/mcp/INDEX.md` — per-runbook status table.
- `test/mcp/MODE2.md` — Mode 2 runbook, with the 2026-05-25c run
  notes covering the v2.3 post-fix live pass.
- `test/mcp/MODE3.md` — Mode 3 runbook with three live-pass runs
  (2026-05-25, 25b, 25c) covering the cascading-trash, restore,
  and parent-trash work.
- `docs/CODEBASE_OVERVIEW.md` — long-form module tour. **Partially
  stale** from the v1 era; CLAUDE.md is the current state.

---

## Done

### v2.4.x

- **v2.4.1** (commit `89d18c0`, tag `v2.4.1`, 2026-05-27, sha256
  `67a493d7…`) — wizard color fix + two LOW security hardenings.
  - Pinned every color in `setupWizard.xhtml` explicitly so headings
    render dark-on-cream regardless of system theme (pre-fix,
    `chrome://global/skin/global.css` dark-theme defaults on
    Cinnamon/Linux made headings render white-on-cream).
  - ReDoS defense in `smartRules.matchesRegex`: 8 KB input cap,
    512-char pattern cap, applied before compile + before `.test()`.
  - Proto-pollution hygiene via new `sanitizeUntrustedKeys()` in
    `utils.mjs`, applied in `trackingStore.load()` (every persisted
    record) and `smartRules.loadRules()` (every parsed rule).
  - 555 → 569 unit tests.

- **v2.4.0** (commit `24ac624`, tag `v2.4.0`, 2026-05-27, sha256
  `29d42b13…`) — C1 full setup wizard (single-pane XHTML).
  - `content/setupWizard.xhtml` + `content/setupWizard.js` open
    via `parentWindow.openDialog('chrome://zotero-watch-folder/
    content/setupWizard.xhtml', ...)` from `runSetupWizard`.
  - Four steps in one window with Back / Next / Cancel / Enable
    navigation, per-step validation, indented collection list,
    mode-specific safety note in the confirm step.
  - Pre-v2.4 modal sequence preserved as fallback. Both paths
    converge on `_commitWizardResult`.

### v2.3.x

- **v2.3.2** (commit `32af712`, tag `v2.3.2`, 2026-05-27, sha256
  `f219814f…`) — trashed-sync-root hardening.
  - `resolveSyncRoot()` now throws `SyncRootMissingError` with a
    clear "restore from Bin" message when the sync-root collection
    is in Zotero's trash.
  - Closes the live-finding from the 2026-05-26 Zotero 9
    verification pass (silent OUT_OF_SCOPE_SUPPRESSED on every
    import).
  - 552 → 555 unit tests.

- **v2.3.1** (commit `6e70eed`, tag `v2.3.1`, 2026-05-27, sha256
  `c69eaafe…`) — security hardening (two MEDIUM findings).
  - **Path-traversal defense** in `canonicalPath.mjs`. New
    `isUnsafeCollectionNameSegment(name)` rejects `.`, `..`,
    empty, names containing `/`, `\`, or NUL. Wired into
    `collectionKeyToRelativePath` (returns null on bad chain)
    and `relativePathToCollection` (returns null on bad input).
  - **Symlink-skip** in `fileScanner.mjs` via `nsIFile.isSymlink()`.
    Applied in both `scanFolder` and `scanFolderRecursive` with a
    `__test_setSymlinkDetector` test seam.
  - 532 → 552 unit tests.

- **v2.3.0** (commit `b2ec00a`, tag `v2.3.0`, 2026-05-26) — stable
  cut + Zotero 9 verification.
  - Drops the `alpha` suffix.
  - Live-verified on Zotero 9.0.4 (platform 140.10.0).
  - **RecognizePDF reparenting bug** fixed: reparenting guard in
    `itemMembershipHandler._handleRemove` + auto-clear safety net
    in `mirrorExecutor._addItemMembership`. The original ticket
    was filed as a DEL.2 shadow-lifecycle quirk; the true scope
    was every freshly-imported file losing its membership after
    metadata recognition.
  - **Parent-trash propagation bug** fixed: `_handleZoteroTrash`
    expands non-attachment items to their child attachments via
    `getAttachments(true)`, so parent-level trashes correctly
    propagate to disk in Mode 3.
  - Setup wizard exposes Mode 3 in the picker with mode-specific
    safety descriptions + confirm-step safety note.
  - 523 → 532 unit tests.

### v2.2 → v2.2.0-alpha.1 (pre-stable)

- **v2.2.0-alpha.1** (commit `aebfe31`, tag `v2.2.0-alpha.1`,
  2026-05-25) — Mode 3 safe-delete end-to-end. Shipped via
  `39ea420`, `7a8ad88`, `a7e0bd1`, `1f86184`, `682e6a8`, `2262bde`,
  `1010b01`, `d98fad2`, `5f845c8`, `af807f5`, `6880b0b`, `aebfe31`,
  plus post-tag follow-ups `4b3da64`, `018fe04`, `e24da86`,
  `25c5eb2`, `651b9e4`, `71f82c7`, `7bb395a`:
  - Cascading-trash bug fix: `_handleExternalDeletions` shadow guard +
    `_handleZoteroTrash` v2 rewrite (canonical-only disk-delete).
  - `.zotero-watch-trash/` plugin trash dir + `'plugin_trash'` action +
    tombstone emission on recoverable trash.
  - Restore matrix RST.1/2/3/4/5/6 (all six): parent-expand on Zotero
    restore (RST.2), deleted-check skip for RST.4, tombstone-aware
    dedup for local restore (RST.3), parent-re-attach via
    `importFromFile({parentItemID})` for RST.5, collision suffix on
    restore for RST.6.
  - `mirrorExecutor._deleteFolder` Mode 3 wiring: recursive move into
    plugin trash with same collision policy + child-tracking cleanup.
  - Bulk-delete protection via `content/bulkGuard.mjs` (>10 OR
    >20% threshold; Services.prompt with safe no-UI fallback that
    REFUSES). Applied to `_deleteFolder`, `_handleZoteroTrash`,
    `_handleExternalDeletions`.
  - Restore-folder UX in prefs pane (`listTrashedFolders` +
    `restoreTrashedFolder` + new "Trashed folders: N
    [Restore folders…]" row).
  - Smart rules JSON editor in prefs pane.
  - `enabled` pref runtime observer — toggling enabled in-process
    starts/stops the scanner symmetrically.
  - Mode display label fix (was "(v2.2, not yet active)").
  - Deleted dormant `bulkOperations.mjs` (738 lines, unreachable
    in v2).
  - `warningSink.clear()` contract documented (listeners survive
    Clear).
  - `test/mcp/MODE3.md` runbook written + two live passes.

- **v2.1.0-alpha.1** — Mode 2 end-to-end (Phase A1–A6 event pipeline,
  Phase B suppression resolver, Phase C install-time baseline,
  Phase D warningSink, hash strategy → full-file SHA-256, schema-drift
  fix, 15 review + 8 live-MCP fixes).

- **v2.1 Track A polish** (commits `9fc1dde`, `71ca635`) — folder +
  conflict resolution UX, `_moveItem` stale-path race fix,
  `_moveFolder` per-attachment locks, resolver `save()` rollback,
  singleton TrackingStore.

- **v2.0.0-alpha.1** — sync-root model (Phase A), Mode 1 import wiring
  (B1/B3/B4/B6), prefs sync-root picker (C2), Phase 2 cleanup.

### Pre-v2

- Phase 1 (watch folder, auto-import, metadata retrieval, file
  renaming, first-run flow, post-import actions).
- Phase 2 (collection ↔ folder mirroring).
- Phase 3 (smart rules, duplicate detection, bulk ops).
- Two-way deletion sync (now mode-gated per v2).
- Plugin icons.

---

## Release inventory

| Tag                  | Date       | Notes                                                   | sha256 (XPI)    |
| -------------------- | ---------- | ------------------------------------------------------- | --------------- |
| `v2.4.1` **Latest**  | 2026-05-27 | Wizard color fix + ReDoS + proto-pollution hardenings   | `67a493d7…`     |
| `v2.4.0`             | 2026-05-27 | C1 full setup wizard (single-pane XHTML)                | `29d42b13…`     |
| `v2.3.2`             | 2026-05-27 | Trashed-sync-root hardening                             | `f219814f…`     |
| `v2.3.1`             | 2026-05-27 | Security hardening (path-traversal + symlink-skip)      | `c69eaafe…`     |
| `v2.2.0-alpha.1`     | 2026-05-25 | Mode 3 safe-delete end-to-end                           | `cb128499…`     |
| `v2.1.0-alpha.1`     | 2026-05-24 | Mode 2 mirror without delete                            | —               |
| `v2.0.0-alpha.1`     | 2026-05-24 | Mode 1 import only                                      | —               |
| `v1.2.3`             | 2026-05-13 | Pre-v2 series end                                       | —               |
