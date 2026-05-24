# Zotero Watch Folder — TODO

**v2.1.0-alpha.1 shipped** (commit `dc4ad27`, tag `v2.1.0-alpha.1`).
Mode 2 (mirror without delete) is functional end-to-end against a real
Zotero install. v2.0 (Mode 1) remains shipped and unchanged.

---

## Start here next session

Open this file first. Pick one of the three tracks below depending on
what feels right. Each item is self-contained — none block the others.

### Track A — finish Mode 2 polish (small, well-defined)

These close out the residual v2.1 work. Good for a short session.

- [ ] **Folder + conflict resolution actions in prefs UI.** Counts are
      surfaced via `Zotero.WatchFolder.suppressionResolver.listSuppressed
      Collections()` + `.listConflicted()`, but only file records have a
      4-action menu. Mirror that for folders (REINSTATE collection / KEEP
      local folder / TRASH / MOVE outside) and conflicts (re-stamp baseline
      from disk / discard local edit / pause sync for this file). Touch
      points: `content/suppressionResolver.mjs`,
      `content/preferences.{xhtml,js}`, FTL.
- [ ] **WARN.1 visual prefs UI verification.** Live-test the prefs pane
      rows ("Sync warnings: N (View) (Clear)" + "Suppressed items: N
      (Resolve…)" + "Conflict-blocked: N"). API surface is already
      verified by `test/mcp/MODE2.md`; just confirm the XHTML rows render
      + interact correctly. May need a `zotero_screenshot` pass.
- [ ] **`_moveItem` cross-action stale-`oldCanonicalPath` race.** A
      `moveItem` action queued in the same scan-cycle batch as a
      `moveFolder` action can be issued with an `oldCanonicalPath`
      that's already been rewritten. Fix: in
      `content/mirrorExecutor.mjs:_moveItem`, read the current
      `record.canonicalLocalPath` fresh from the store at execution
      time rather than trusting the payload value. Notifier serialization
      mitigates most of this but a cross-watcher window remains.
- [ ] **Per-attachment lock during `moveFolder` child rewrite.** Acquire
      `attachment:<key>` locks while rewriting child file records in
      `_moveFolder` so concurrent `moveItem` actions on the same
      attachments wait.
- [ ] **Resolver `save()` rollback.** `suppressionResolver` surfaces
      tracking-store save failures via warningSink, but the in-memory
      mutation has already been applied. Decide: rollback on save
      failure, or accept the divergence as a known limitation and
      document.

### Track B — fix the v1-era known bugs

These come from CLAUDE.md's "Open issues / known bugs" section and are
mostly orthogonal to v2.2.

- [ ] **Cascading-trash bug** (CRITICAL before v2.2). Dedup-skipped
      files share `itemID` with the matched existing item; deleting one
      with `diskDeleteSync=auto` prompts `_promptDiskDelete` for every
      sibling. Mode 1 + Mode 2 gating sidesteps; must fix before v2.2's
      `_handleZoteroTrash` rewrite enables propagation. Repro: drop a
      duplicate, let it dedup-track, then `rm` it.
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

- [ ] **Fix cascading-trash bug first** (see Track B). Mode 3 propagates
      disk deletions back to Zotero — the cascading-trash logic must not
      ship.
- [ ] **`_handleZoteroTrash` v2 rewrite** with the safe-delete predicate
      (hash-clean check + attachment-key mapping). Lives in
      `content/watchFolder.mjs` ~line 1085+. Currently gated off in Mode
      1/2; v2.2 turns it on.
- [ ] **`.zotero-watch-trash/` local trash dir.** Scanner skip-list
      already reserves the name (`content/fileScanner.mjs`
      `SKIP_DIRNAMES`). Mode 3 moves local files here instead of OS
      trash for recoverability. Wire via `mirrorExecutor.deleteFolder`
      and the disk-deletion path.
- [ ] **Bulk-delete protection.** Pause + confirm prompt when >10 files
      or >20% of the tree would be deleted, or when the watch volume
      goes offline. Add in `mirrorExecutor` before any bulk destructive
      op runs.
- [ ] **Restore matrix (RST.1–RST.6 in `updates_22_05_26.md`).**
      Restoring a Zotero attachment from Trash should restore the local
      file from plugin trash; restoring a local file should re-link to
      its tombstone.
- [ ] **Tombstone-aware dedup.** `trackingStore.findByHash` should also
      consult tombstones so a restored local file relinks instead of
      importing as new.

---

## Project state at-a-glance

- **Released:** `v2.1.0-alpha.1` (https://github.com/josesiqueira/zotero-watch-folder/releases/tag/v2.1.0-alpha.1).
- **Tests:** 19 files / 435 passing + 21 skipped (`npm test`).
- **MCP runbooks:** `test/mcp/MODE1.md` (v2.0) ✅, `test/mcp/MODE2.md`
  (v2.1) ✅ except WARN.1 visual UI step.
- **Auto-update:** `update.json` on `main` points at the v2.1 XPI;
  existing v2.0 installs auto-discover.
- **Architecture docs:** `CLAUDE.md` (project layout + invariants),
  `updates_22_05_26.md` (v2 sync-model spec, source of truth for
  behavior), `docs/CODEBASE_OVERVIEW.md`.

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
- **Pre-v2** — Phase 1 (watch folder, auto-import, metadata retrieval,
  file renaming, first-run flow, post-import actions), Phase 2
  (collection ↔ folder mirroring), Phase 3 (smart rules, duplicate
  detection, bulk ops). Two-way deletion sync (now mode-gated per v2).
  Plugin icons.
