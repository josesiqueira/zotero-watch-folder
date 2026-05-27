# Zotero Watch Folder — TODO

**Status:** **`v2.4.0`** (minor — new UI feature). Lands the C1 full setup
wizard as a single XHTML window with Back / Next / Cancel / Enable navigation.
Builds on `2.3.2` (no behavior change to the import / sync / restore pipelines —
this is a setup-time UX upgrade). Unit-test-covered (**555 passing across 20
files**, zero skipped). Modal-sequence fallback preserved for any environment
where `openDialog` fails. **Compatible with Zotero 7, 8, 9.**

---

## Open work

**Nothing release-blocking.** Tracks A / B / C and the autonomous
Track D queue are all closed. Pick from the smaller follow-up items
below when you have time, or pick a new feature direction.

### Small follow-ups (not blocking)

- [ ] **Phase E `test/mcp/MODE2.md` runbook live pass.** Document
      exists in `test/mcp/MODE2.md`; sketched during v2.1 work.
      A WARN.1 visual screenshot pass was done (Track A item #2),
      but the BASE/ADOPT/LATE/REN/MEM/SUPP/CONF scenarios haven't
      been run end-to-end on a live Zotero against the post-v2.2
      bundle. Lower priority than MODE3 since Mode 2 is older and
      stable.
- [x] ~~**C1 full setup wizard.**~~ **Done in v2.4.0 (2026-05-27)** —
      single-pane XHTML window at `content/setupWizard.xhtml` opened
      via `window.openDialog` from `runSetupWizard`. Four steps in
      one window with Back / Next / Cancel / Enable navigation, per-
      step validation, indented collection list, mode-specific safety
      note in the confirm step. The pre-v2.4 modal sequence remains
      as a fallback if the chrome window fails to open. Both paths
      converge on `_commitWizardResult` to write prefs + start
      services.
- [x] ~~**DEL.2 shadow-guard record lifecycle quirk**~~ — **Fixed
      2026-05-25.** Root cause was deeper than the live finding read:
      every freshly-imported file ended up `out-of-scope-suppressed`
      with empty `collectionMembershipKeys`, not just shadows.
      Mechanism: Zotero's `RecognizePDF` creates a parent item, places
      it in the sync-root collection, reparents the attachment under
      the parent, and fires a `collection-item` REMOVE event for the
      attachment leaving the collection. The mirror watcher
      (`itemMembershipHandler._handleRemove`) interpreted this as the
      user un-syncing the attachment. Fix: added a Zotero-reparenting
      guard that returns early when the attachment's `parentItem` is
      still in the same collection. Also added a safety net in
      `mirrorExecutor._addItemMembership` that auto-clears
      OUT_OF_SCOPE_SUPPRESSED → CLEAN when a sync-root collection is
      re-added (USER_DETACHED stays detached). UT-512 (4 cases) +
      UT-409 (3 new cases) cover both. Verified live: imported a
      fresh PDF (state=clean, membership=[syncRoot]), then dropped a
      shadow copy and `rm`'d it — shadow record fully removed, canonical
      untouched, Zotero attachment not trashed. 530 unit tests
      passing (was 523).
- [ ] **Larger live-MCP coverage of Mode 3 scenarios we skipped.**
      DEL.3 / RST.2 / RST.4 / RST.5 / FDEL.2 are all unit-tested
      but only DEL.1/1.b, DEL.2, RST.1, RST.3, RST.6, FDEL.1,
      FRST.1, SR.1 have been live-pass'd. Need >10 distinct PDFs
      (DEL.3 / FDEL.2) and a multi-attachment-parent setup
      (RST.2 / RST.4 / RST.5).

### Bigger directions to consider

- New features in `updates_22_05_26.md` that haven't been pulled
  into a track yet (e.g. cross-library sync, smart-rule UI form
  editor rather than JSON, file-naming template upgrades).
- Migration to Zotero 9 once Zotero ships it (we already declare
  `strict_max_version: 9.*`).
- A v2.3 release tag once a meaningful set of polish items lands.

---

## Quick commands

```sh
npm test                              # vitest, 523 passing / 0 skipped
npm run bundle                        # rebuild dist/content/scripts/watchFolder.js
npm run build && npm run bundle && npm run package
                                      # full XPI rebuild → zotero-watch-folder-2.2.0-alpha.1.xpi
gh release view v2.2.0-alpha.1        # release page
```

When working with the live Zotero MCP bridge:
- Health check: `zotero_plugin_list` (not `zotero_ping` — known broken).
- If the bridge wedges with "Could not find Zotero console actor",
  just retry — it's intermittent. If port 6100 stops listening,
  Zotero needs a restart.
- `Zotero.DB.executeTransaction(async () => { await x.save(); })` is
  the reliable save pattern; bare `await x.saveTx()` silently fails
  in the bridge's IIFE wrapper.
- Pre-warm MCP permissions before mobile sessions with the
  `zotero-mcp-warmup` skill — see `.claude/skills/zotero-mcp-warmup/SKILL.md`.

---

## Where things live

- `CLAUDE.md` — project layout, invariants, "don't touch without
  understanding" notes. Read this BEFORE editing anything bigger
  than a comment.
- `updates_22_05_26.md` — the v2 sync-model spec. Source of truth
  for behavior (restore matrix RST.1–RST.6, suppression rule,
  mode definitions).
- `test/README.md` — three test layers (unit / mcp / integration).
- `test/mcp/INDEX.md` — per-runbook status table.
- `test/mcp/MODE3.md` — the canonical v2.2 live-validation runbook
  with run notes from 2026-05-25 and 2026-05-25b.
- `docs/CODEBASE_OVERVIEW.md` — long-form module tour. **Partially
  stale** from the v1 era; CLAUDE.md is the current state.

---

## Done

- **v2.0 (`v2.0.0-alpha.1`)** — sync-root model (Phase A), Mode 1
  import wiring (B1/B3/B4/B6), prefs sync-root picker (C2), Phase 2
  cleanup.
- **v2.1 (`v2.1.0-alpha.1`)** — Mode 2 end-to-end: Phase A1–A6 event
  pipeline (collectionWatcher / folderEventDetector /
  itemMembershipHandler / itemAddHandler / mirrorExecutor /
  syncCoordinator with per-key promise locks + canSafelyMove
  conflict gate + cross-FS move fallback + runtime mode-pref
  observer + notifier serialization). Phase B 4-action suppression
  resolver + prefs UX. Phase C install-time baseline (B.1–B.7).
  Phase C1 multi-step setup wizard. Phase D warningSink + prefs
  surface. Hash strategy → full-file SHA-256 (HASH_VERSION=2).
  Schema-drift fix (localPath consistently sync-root-relative
  throughout watchFolder.mjs). 15 review findings + 8 live-MCP
  bugs fixed in commits `fb371c4`..`2a98adf`.
- **v2.1 Track A polish (on main, post-tag)** — `9fc1dde`,
  `71ca635`:
  - Folder + conflict resolution UX in suppressionResolver
    (`resolveCollection` / `resolveConflict`) + prefs UI Resolve
    buttons.
  - `mirrorExecutor._moveItem` stale-path race fix;
    `_moveFolder` per-attachment locks during child rewrite.
  - Resolver `save()` rollback across all 11 handlers.
  - Singleton `TrackingStore` fix — `WatchFolderService` now
    shares the resolver's singleton via `initTrackingStore()`.
- **v2.2 (`v2.2.0-alpha.1`)** — Mode 3 safe-delete end-to-end —
  shipped via `39ea420`, `7a8ad88`, `a7e0bd1`, `1f86184`, `682e6a8`,
  `2262bde`, `1010b01`, `d98fad2`, `5f845c8`, `af807f5`, `6880b0b`,
  `aebfe31`, plus post-tag follow-ups `4b3da64`, `018fe04`, `e24da86`,
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
- **Pre-v2** — Phase 1 (watch folder, auto-import, metadata retrieval,
  file renaming, first-run flow, post-import actions), Phase 2
  (collection ↔ folder mirroring), Phase 3 (smart rules, duplicate
  detection, bulk ops). Two-way deletion sync (now mode-gated per v2).
  Plugin icons.
