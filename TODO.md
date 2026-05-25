# Zotero Watch Folder — TODO

**v2.1.0-alpha.1 shipped** (commit `dc4ad27`, tag `v2.1.0-alpha.1`).
Mode 2 (mirror without delete) is functional end-to-end against a real
Zotero install. v2.0 (Mode 1) remains shipped and unchanged.

---

## Start here next session

Open this file first. Pick one of the three tracks below depending on
what feels right. Each item is self-contained — none block the others.

### Track A — finish Mode 2 polish (small, well-defined)

**All 5 done.** Track A complete.

- [x] **Folder + conflict resolution actions in prefs UI.** Added
      `resolveCollection()` (4 actions: REINSTATE / KEEP_LOCAL / TRASH /
      MOVE_OUTSIDE) + `resolveConflict()` (3 actions: RESTAMP_BASELINE /
      DISCARD_LOCAL / PAUSE_SYNC) to `suppressionResolver.mjs`. Prefs
      pane wired up with two new "Resolve…" buttons matching the
      existing per-record `Services.prompt.select` loop.
- [x] **WARN.1 visual prefs UI verification.** Live-tested via MCP: all
      three rows render with correct counts ("Sync warnings: 2 [View]
      [Clear]" + "Suppressed items: 1 (+1 folders) [Resolve…] [Resolve
      folders…]" + "Conflict-blocked: 1 [Resolve…]"). Verification also
      surfaced a singleton-store bug: WatchFolderService instantiated its
      own TrackingStore via `new TrackingStore()` while suppressionResolver
      read from the module-level singleton via `getTrackingStore()` —
      two different stores, so the prefs UI silently reported zero
      suppressed/conflicted items even when state existed. Fixed by
      routing WatchFolderService through `initTrackingStore()` so both
      consumers share the singleton (watchFolder.mjs:143).
- [x] **`_moveItem` cross-action stale-`oldCanonicalPath` race.**
      Re-reads live `canonicalLocalPath` from the store after acquiring
      `attachment:<key>` lock. If the live path already equals the
      payload's `newCanonicalPath`, short-circuits as no-op.
- [x] **Per-attachment lock during `moveFolder` child rewrite.** Both
      rewrite passes acquire `attachment:<key>` per child (sequentially,
      to avoid lock-order issues) and re-read the record inside the
      lock before mutating.
- [x] **Resolver `save()` rollback.** All 11 handlers (4 file + 4
      collection + 3 conflict) now snapshot pre-mutation state and
      restore on `save()` failure. For TRASH/MOVE_OUTSIDE the FS
      mutation is not reversed (file is already trashed/moved), only
      the tracking-store mutations roll back — documented inline.

### Track B — fix the v1-era known bugs

These come from CLAUDE.md's "Open issues / known bugs" section and are
mostly orthogonal to v2.2.

- [x] **Cascading-trash bug** (was CRITICAL before v2.2). Two patches:
      - `_handleExternalDeletions` Mode 3 branch: when a SHADOW record
        (`localPath !== canonicalLocalPath`) is missing but its canonical
        sibling is still on disk, drop only the shadow tracking record —
        don't trash the Zotero attachment. Stops the cascade at its
        source.
      - `_handleZoteroTrash`: full v2-schema rewrite. Collapses per
        attachment key (not per record), disk-deletes only the canonical
        path, drops shadows from tracking without disk action. Mode 2
        warn-only path also implemented (drops tracking + warningSink).
        9 new UT-090 tests cover both directions across Mode 1/2/3
        and edge cases (missing canonical, non-attachment items,
        diskDeleteOnTrash=never).
- [ ] **Phase 3 bulk ops** (`reorganizeAll`, `retryAllMetadata`,
      `applyRulesToAll`) — no UI hook AND not reachable via
      `Zotero.WatchFolder.hooks`. Effectively dormant. Decide: delete
      from `content/bulkOperations.mjs` or wire up via prefs.
- [ ] **Smart rules editor UI.** Engine in `content/smartRules.mjs`
      works but rules are JSON in `about:config`. A small prefs-pane
      editor would make the feature usable for non-developers.
- [ ] **Listener leak in `warningSink`.** `clear()` doesn't drop
      `_listeners`. Currently no live subscriber outside the prefs pane,
      so latent only. Document the contract OR drop listeners in
      `clear()` (only `_resetForTesting` does so today).

### Track C — start v2.2 (Mode 3 — safe delete)

Bigger scope. Reserve a longer session.

- [x] **Cascading-trash bug fixed first.** Both
      `_handleExternalDeletions` and `_handleZoteroTrash` v2 rewrite
      shipped with full test coverage. Mode 3 can now propagate safely.
- [x] **`_handleZoteroTrash` v2 rewrite.** Done as part of the
      cascading-trash fix. Translates numeric IDs → attachment keys,
      collapses per-attachment, disk-deletes only canonical paths,
      drops shadows from tracking without disk action. Mode 2 warn-only
      path implemented too. Routes through plugin trash by default in
      Mode 3.
- [x] **`.zotero-watch-trash/` local trash dir.** `_moveToPluginTrash`
      moves files into `.zotero-watch-trash/<sync-root-relative-path>`,
      preserving subpath for restore. RST.6 collision handling via
      `<name>.<ms-timestamp>.<ext>` suffix. Cross-FS fallback (copy +
      remove) for the rare same-watch-root cross-mount case. New
      `'plugin_trash'` action in `_handleZoteroTrash`'s
      `diskDeleteOnTrash` policy + replaces "Move to OS trash" as the
      default-recoverable button in `_promptDiskDelete`. Tombstone
      records emitted on successful trash (plugin or OS) so RST.1/RST.3
      can re-link.
- [x] **Tombstone-aware dedup.** `trackingStore.findTombstoneByHash`
      added; `_processNewFile` step 3a consults tombstones before
      regular hash-dedup. Match → un-trash Zotero attachment if still
      trashed, re-create FileRecord, drop tombstone. Attachment purged
      → drop tombstone, fall through to import-as-new.
- [~] **Restore matrix — partial.** RST.1 (Zotero attachment restored
      → move file out of plugin trash; new `_handleZoteroRestore` on
      `'modify'` notifier, gated on tombstones-existing pre-filter),
      RST.3 (local file reappears → re-link via tombstone-aware
      dedup), RST.6 (collision suffix `<name>.restored.<ts>.<ext>`).
      Still pending: RST.2 (multi-attachment parent restore), RST.4
      (parent restored without attachment), RST.5 (local-restore after
      parent was deleted).
- [ ] **`mirrorExecutor.deleteFolder` Mode 3 wiring.** Currently
      warn-only in both Mode 2 and Mode 3. Mode 3 should route folder
      deletes through plugin trash too — recursive move into
      `.zotero-watch-trash/<original-subpath>/` with the same
      collision policy.
- [ ] **Bulk-delete protection.** Pause + confirm prompt when >10 files
      or >20% of the tree would be deleted, or when the watch volume
      goes offline. Add in `mirrorExecutor` before any bulk destructive
      op runs.

---

## Project state at-a-glance

- **Released:** `v2.1.0-alpha.1` (https://github.com/josesiqueira/zotero-watch-folder/releases/tag/v2.1.0-alpha.1).
- **`main` is ahead of the tag** with v2.1 Track A polish + v2.2 in-progress
  (cascading-trash fix, `.zotero-watch-trash/`, restore matrix RST.1/3/6,
  tombstone-aware dedup, singleton-store fix). Bump to `v2.2.0-alpha.1`
  once the remaining Track C items land (`_deleteFolder` Mode 3,
  bulk-delete protection, RST.2/4/5).
- **Tests:** 19 files / 486 passing + 21 skipped (`npm test`).
- **MCP runbooks:** `test/mcp/MODE1.md` (v2.0) ✅, `test/mcp/MODE2.md`
  (v2.1) ✅ WARN.1 visual UI step completed via MCP screenshot pass.
  `MODE3.md` runbook still pending for Mode 3 / restore matrix
  live-validation.
- **Auto-update:** `update.json` on `main` points at the v2.1 XPI;
  existing v2.0 installs auto-discover.
- **Architecture docs:** `CLAUDE.md` (project layout + invariants),
  `updates_22_05_26.md` (v2 sync-model spec, source of truth for
  behavior), `docs/CODEBASE_OVERVIEW.md` (long-form module tour —
  partially stale; see CLAUDE.md for the current state).

## Quick commands

```sh
npm test                              # vitest
npm run bundle                        # rebuild dist/content/scripts/watchFolder.js
npm run build && npm run bundle && npm run package
                                      # full XPI rebuild
gh release view v2.1.0-alpha.1        # release page
```

When working with the live Zotero MCP bridge:
- Health check: `zotero_plugin_list` (not `zotero_ping` — known broken)
- If the bridge wedges with "Could not find Zotero console actor",
  just retry — it's intermittent. If port 6100 stops listening,
  Zotero needs a restart.
- `Zotero.DB.executeTransaction(async () => { await x.save(); })` is
  the reliable save pattern; bare `await x.saveTx()` silently fails
  in the bridge's IIFE wrapper.

---

## Done

- **v2.0 (`v2.0.0-alpha.1`)** — sync-root model (Phase A), Mode 1 import
  wiring (B1/B3/B4/B6), prefs sync-root picker (C2), Phase 2 cleanup.
- **v2.1 (`v2.1.0-alpha.1`)** — Mode 2 end-to-end:
  - Phase A1–A6 event pipeline (collectionWatcher / folderEventDetector
    / itemMembershipHandler / itemAddHandler / mirrorExecutor /
    syncCoordinator with per-key promise locks + canSafelyMove conflict
    gate + cross-FS move fallback + runtime mode-pref observer +
    notifier serialization).
  - Phase B 4-action suppression resolver + prefs UX.
  - Phase C install-time baseline (B.1–B.7: mkdir / copy / adopt-into-
    scope / late-attached PDF / hash reconcile).
  - Phase C1 multi-step setup wizard.
  - Phase D warningSink + prefs surface + suppressed/conflict counts.
  - Hash strategy migrated to full-file SHA-256 (HASH_VERSION=2).
  - Schema-drift fix: localPath/canonicalLocalPath consistently
    sync-root-relative throughout watchFolder.mjs.
  - 15 review findings + 8 live-MCP bugs fixed in commits
    `fb371c4`..`2a98adf`.
- **v2.1 Track A polish (on main, post-tag)** — `9fc1dde`, `71ca635`:
  - Folder + conflict resolution UX in suppressionResolver
    (resolveCollection / resolveConflict) + prefs UI Resolve buttons.
  - mirrorExecutor `_moveItem` stale-path race fix; `_moveFolder`
    per-attachment locks during child rewrite.
  - Resolver `save()` rollback across all 11 handlers.
  - Singleton TrackingStore fix — WatchFolderService now shares the
    suppressionResolver's singleton via `initTrackingStore()`.
- **v2.2 in-progress (on main, unreleased)** — `39ea420`, `7a8ad88`,
  `a7e0bd1`:
  - Cascading-trash bug fix: `_handleExternalDeletions` shadow guard +
    `_handleZoteroTrash` v2 rewrite (canonical-only disk-delete).
  - `.zotero-watch-trash/` plugin trash dir + `'plugin_trash'` action
    + tombstone emission on recoverable trash.
  - Restore matrix RST.1 + RST.3 + RST.6 + tombstone-aware dedup.
- **Pre-v2** — Phase 1 (watch folder, auto-import, metadata retrieval,
  file renaming, first-run flow, post-import actions), Phase 2
  (collection ↔ folder mirroring), Phase 3 (smart rules, duplicate
  detection, bulk ops). Two-way deletion sync (now mode-gated per v2).
  Plugin icons.
