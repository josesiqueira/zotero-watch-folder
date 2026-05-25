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
- [x] **Phase 3 bulk ops** — deleted `content/bulkOperations.mjs`
      entirely (was 738 lines). The v1-era operations were unreachable
      via `Zotero.WatchFolder.hooks` under v2 and superseded by the
      sync-coordinator pipeline. Removed UT-040 from
      `test/unit/fileScanner.test.mjs` (the only consumer outside the
      module itself was the test for one private helper). Doc cleanup
      in `test/README.md` + `test/mcp/INDEX.md`.
- [x] **Smart rules editor UI.** Added a Smart Rules section to the
      prefs pane: enable checkbox + multi-line JSON textarea + Save /
      Insert example / Reload buttons. Save validates JSON parse +
      per-rule shape (mirrors `_validateRule` in the engine) and shows
      a specific error on bad input. Insert appends a starter rule
      template so users have a concrete shape to edit. Reload re-reads
      the pref (useful after editing in about:config). Kept the JSON
      textarea (rather than a form-based editor) because rule shape
      is small and power-user-friendly is fine for the first cut.
- [x] **Listener leak in `warningSink`.** Resolved by documentation,
      not by code change. Dropping listeners on `clear()` would silently
      unsubscribe the prefs pane the first time the user pressed Clear,
      which is a worse bug than the "leak" (subscribers are bounded —
      only the prefs pane subscribes today, and prefs window unload
      naturally cleans them up). Updated `clear()` and `subscribe()`
      JSDoc to make the contract explicit + added a regression test
      that asserts subscribers survive `clear()`.

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
- [x] **Restore matrix — complete.** All six cases implemented.
      - RST.1 (Zotero attachment restored → move file out of plugin
        trash) — shipped previously via `_handleZoteroRestore`.
      - RST.2 (parent restore expands to all live child attachments)
        — `_handleZoteroRestore` now expands parent IDs into their
        live attachments before the per-key restore loop.
      - RST.3 (local file reappears → re-link via tombstone-aware
        dedup) — shipped previously.
      - RST.4 (parent restored but attachment still trashed → keep
        local file trashed) — the same per-attachment `deleted ===
        false` check skips trashed children, so RST.2's expansion
        naturally honours RST.4. Locked in by UT-093.
      - RST.5 (local-restore after parent deleted; attachment also
        gone) — `_processNewFile` tombstone path now checks the
        original parent (tombstone.zoteroItemKey) and, if still alive,
        attaches the file as a child via `Zotero.Attachments.import
        FromFile({parentItemID})` instead of importing as a new
        top-level item. Falls through to import-as-new when the parent
        is also gone.
      - RST.6 (collision suffix) — shipped previously.
- [x] **`mirrorExecutor.deleteFolder` Mode 3 wiring.** Mode 3 now
      recursive-moves the folder into `.zotero-watch-trash/<rel>`
      via `_moveWithFallback`. Collision policy mirrors
      `_moveToPluginTrash` (RST.6) — suffix the dir name with a
      ms timestamp. Drops the collection record + every FileRecord
      under the path (the contained Zotero attachments are NOT
      individually tombstoned because they aren't trashed —
      collection removal is a scope change, not content deletion).
      Source-already-missing path drops tracking + returns
      `already-missing` instead of erroring. Mode 2 warn-only
      behavior unchanged. 4 new UT-419 tests cover all branches.
      Restore-folder UX is filed under Track D — for now users
      recover by manually moving the dir out of plugin trash.
- [x] **Bulk-delete protection.** Added `_isBulkDelete` (>10 files OR
      >20% of tracked tree) + `_confirmBulkDelete` (Services.prompt
      with safe fallback for no-UI contexts → refuses rather than
      silently executing) helpers in mirrorExecutor. Wired into
      `_deleteFolder` Mode 3 before the recursive move: counts files
      under the subtree, prompts on threshold cross, returns
      `{ok:false, reason:'bulk-confirm-denied'}` on decline.
      Watch-volume-offline check was already handled at a higher
      level in `_handleExternalDeletions` (pauses sync globally via
      `isWatchRootAvailable`), so no extra work needed there.
      5 new UT-420 tests cover both thresholds, under-threshold
      skip, user decline, and the no-prompt-available refusal.
      **NOTE:** the spec mentions `watchFolder._handleZoteroTrash`
      and `_handleExternalDeletions` are also bulk-capable; both
      live in watchFolder.mjs, not mirrorExecutor. Filed as a
      follow-up under Track D.

### Remaining completion work (before tagging v2.2.0-alpha.1)

- [ ] **`test/mcp/MODE3.md` MCP runbook.** Canonical live-Zotero
      validation of everything shipped in v2.2. Should cover:
      - Switch live install to Mode 3.
      - File-side: drop a file → it imports. `rm` it → file moves
        into `.zotero-watch-trash/` (verify path), Zotero attachment
        trashed (verify), tombstone created (verify via DB or store
        dump).
      - Restore the Zotero attachment from trash → file appears back
        at the canonical path; tombstone gone. (RST.1)
      - Restore a parent item with attachments → all live children
        come back. (RST.2 + RST.4 if any child stayed deleted)
      - Drop a file whose hash matches a recoverable tombstone →
        attachment un-trashes + re-links (RST.3).
      - With parent intact + attachment purged: drop the file →
        re-attaches under the parent via `importFromFile({
        parentItemID })` (RST.5).
      - Drop two files with same name to canonical path → second
        gets `.restored.<ts>` suffix (RST.6).
      - Delete a tracked collection in Zotero → its local folder
        moves to plugin trash, child file records dropped.
      - Bulk-delete trigger: rm a folder containing >10 files →
        confirm prompt fires before the trash move.
      - Smoke-check the new "Smart Rules" prefs section renders +
        accepts a valid rule JSON.
      Reuse the patterns from `test/mcp/MODE2.md`.

### Track D — discovered while doing other items (autonomous queue)

- [ ] **Unit test for RST.5 re-attach path** in
      `_processNewFile`. The RST.5 implementation (re-attach to a
      still-living parent when the original attachment was purged)
      has no unit test — `_processNewFile` doesn't have a dedicated
      describe block in `watchFolder.test.mjs`. Live MCP path covers
      it indirectly. Add a focused test or stand up a small
      `_processNewFile` test harness.
- [ ] **Restore-folder UX in prefs pane.** Mode 3 `_deleteFolder`
      now moves folders into `.zotero-watch-trash/`, but the only
      way to recover them today is to manually move the dir out of
      plugin trash. A "restore folder" button in the prefs pane —
      listing dirs in `.zotero-watch-trash/` with a Restore action
      that moves them back + re-creates the collection — would
      close this loop.
- [ ] **Bulk-delete protection for `watchFolder._handleZoteroTrash`
      and `_handleExternalDeletions`.** The new mirrorExecutor
      protection only covers `_deleteFolder`. The same threshold
      logic should apply to `_handleZoteroTrash` (large batch of
      attachment trashes → many disk deletes) and
      `_handleExternalDeletions` Mode 3 (many missing files →
      many Zotero-side trashes). Factor `_isBulkDelete` +
      `_confirmBulkDelete` into a shared module (probably a new
      `content/bulkGuard.mjs`) so all three callers use the same
      thresholds.

---

## Project state at-a-glance

- **Released:** `v2.1.0-alpha.1` (https://github.com/josesiqueira/zotero-watch-folder/releases/tag/v2.1.0-alpha.1).
- **`main` is ahead of the tag** with all of Track A polish + Track B
  cleanup + Track C v2.2 (Mode 3 safe-delete end-to-end). Ready to
  tag `v2.2.0-alpha.1` once `MODE3.md` MCP runbook validates the new
  surface live (see "Remaining completion work" below).
- **Tests:** 19 files / 493 passing + 21 skipped (`npm test`).
- **MCP runbooks:** `test/mcp/MODE1.md` (v2.0) ✅, `test/mcp/MODE2.md`
  (v2.1) ✅ WARN.1 visual UI step completed via MCP screenshot pass.
  `MODE3.md` runbook **still pending** — the canonical pre-tag
  completion test for Mode 3 + restore matrix + plugin-trash +
  bulk-delete protection.
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
- **v2.2 (on main, unreleased — Mode 3 safe-delete end-to-end)**
  — `39ea420`, `7a8ad88`, `a7e0bd1`, `1f86184`, `682e6a8`,
  `2262bde`, `1010b01`, `d98fad2`, `5f845c8`:
  - Cascading-trash bug fix: `_handleExternalDeletions` shadow guard +
    `_handleZoteroTrash` v2 rewrite (canonical-only disk-delete).
  - `.zotero-watch-trash/` plugin trash dir + `'plugin_trash'` action
    + tombstone emission on recoverable trash.
  - Restore matrix RST.1/2/3/4/5/6 (all six cases): parent-expand on
    Zotero restore, deleted-check skip for RST.4, tombstone-aware
    dedup for local restore, parent-re-attach via `importFromFile({
    parentItemID })` for RST.5, collision suffix on restore for RST.6.
  - `mirrorExecutor._deleteFolder` Mode 3 wiring: recursive move into
    plugin trash with same collision policy + child-tracking cleanup.
  - Bulk-delete protection: `_isBulkDelete` (>10 OR >20%) +
    `_confirmBulkDelete` (Services.prompt with safe no-UI fallback)
    in `_deleteFolder`.
  - Smart rules JSON editor in prefs pane (replaces about:config).
  - Deleted dormant `bulkOperations.mjs` (738 lines, unreachable in v2).
  - `warningSink.clear()` contract documented (listeners survive).
- **Pre-v2** — Phase 1 (watch folder, auto-import, metadata retrieval,
  file renaming, first-run flow, post-import actions), Phase 2
  (collection ↔ folder mirroring), Phase 3 (smart rules, duplicate
  detection, bulk ops). Two-way deletion sync (now mode-gated per v2).
  Plugin icons.
