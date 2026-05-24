# Zotero Watch Folder - TODO

The v2 rewrite is well underway. v2.0 (Mode 1) shipped as `v2.0.0-alpha.1`.
v2.1 (Mode 2) is feature-complete on main and awaits a release tag once the
items in **Pre-release** are done.

## Pre-release (v2.1)

- [ ] **MODE2.md MCP runbook.** `test/mcp/MODE2.md` doesn't exist yet —
      need a sibling to `MODE1.md` covering the new flows (B.2 copy, B.6
      mkdir, B.7 hash reconcile, late-attached PDF, adopt-into-scope,
      collection rename, item-membership change, suppression UX,
      conflict-blocked surface).
- [ ] **Run SMOKE.md S.1–S.7 in a live Zotero install** (still the
      pre-release checklist) plus the new MODE2 cases.
- [ ] **Bump version → 2.1.0-alpha.1** in `package.json` + `manifest.json`,
      build/package, upload via `gh release upload`, commit + push the new
      `update.json` so existing v2.0.0-alpha.1 installs auto-discover.

## Open (v2.1 polish)

- [ ] **Full C1 setup wizard.** Replaces the C2 minimal sync-root picker +
      first-run nudge with a multi-step pane (welcome → pick watch folder →
      pick sync root → pick mode → confirm). Wizard runs until
      `setupCompleted=true`.
- [ ] **Folder + conflict-blocked resolution actions in prefs UI.** The
      counts are surfaced (`getSuppressedCollections`, `getConflictedFiles`)
      but only file records can be resolved via the 4-action menu. Add
      folder actions (REINSTATE collection / KEEP local folder / TRASH /
      MOVE outside) and conflict actions (re-stamp baseline / discard local
      edit / pause sync for this file).
- [ ] **`_moveItem` cross-action stale-`oldCanonicalPath` race.** Read
      `oldCanonicalPath` from the live record instead of the payload so a
      same-cycle `moveFolder` doesn't leave the move stranded with
      missing-file.
- [ ] **Per-attachment lock during `moveFolder` child rewrite.** Notifier
      serialization mitigated most of it but a cross-watcher race window
      remains (folderEventDetector vs collectionWatcher).
- [ ] **Resolver save() rollback.** Currently we surface save failures via
      warningSink but the in-memory mutation has already been applied —
      next restart silently reverts. Rollback semantics needed for
      reinstate/keep-local/trash/move-outside.

## v2.2 — Mode 3 (safe delete)

- [ ] **`_handleZoteroTrash` v2 rewrite** with the safe-delete predicate
      (hash-clean check + attachment-key mapping). Must fix the
      cascading-trash bug below before re-enabling propagation.
- [ ] **`.zotero-watch-trash/` local trash dir.** The scanner skip-list
      already reserves the name. Mode 3 moves local files here instead of
      OS trash for recoverability.
- [ ] **Bulk-delete protection.** Pause + confirm when >10 files or >20%
      of the tree would be deleted, or when the watch volume goes offline.
- [ ] **Restore matrix (RST.1–RST.6).** Restoring a Zotero attachment from
      Trash should restore the local file from plugin trash; restoring a
      local file should re-link to its tombstone.
- [ ] **Tombstone-aware dedup.** `findByHash` should also consult
      tombstones so a restored local file relinks instead of importing as
      new.

## Known bugs (from CLAUDE.md "Open issues / known bugs")

- [ ] **Cascading-trash bug** — dedup-skipped files share itemID with
      matched item; deleting one prompts `_promptDiskDelete` for every
      sibling. Mode 1 + Mode 2 gating sidesteps; must fix before v2.2.
- [ ] **1MB hash chunk cap** — two PDFs differing only after the first
      1MB hash identically and are wrongly marked duplicate. Affects B.7
      reconcile too. Tradeoff: full-file hash vs perf vs sampling
      multiple chunks vs including file size.
- [ ] **`metadataRetriever` fire-and-forget queue** at lines 122, 177,
      370 — swallowed errors. Add `.catch(e => Zotero.logError(e))`.
- [ ] **`tracking.json` not saved when all files dedup-skip** — early
      return in `_processNewFile` skips the `save()` even though
      `add(...)` flipped `_dirty=true`. Crash between scans loses these.
- [ ] **Schema drift in legacy v1 record sites** — `_ensureCollection
      RecordsForPath` writes absolute paths to `localPath` instead of
      sync-root-relative. The folderEventDetector skips records starting
      with `/` as a workaround. Real fix: migrate.
- [ ] **Phase 3 bulk ops** (`reorganizeAll`, `retryAllMetadata`,
      `applyRulesToAll`) — no UI hook AND not reachable via hooks.
      Effectively dormant. Decide: delete or wire up.

## Cleanup / nice-to-haves

- [ ] **Smart rules management UI.** Engine in `content/smartRules.mjs`
      works but rules are JSON in about:config. A prefs-pane editor would
      make the feature usable.
- [ ] **Listener leak in `warningSink`** — `clear()` doesn't drop
      `_listeners`. Currently no live subscriber outside the prefs pane,
      so latent only. Document or fix.

## Done

- **v2.0 (`v2.0.0-alpha.1`)** — sync-root model (Phase A), Mode 1 import
  wiring (B1/B3/B4/B6), prefs sync-root picker (C2), Phase 2 cleanup.
- **v2.1** — Mode 2 functional end-to-end:
  - Phase A1–A6: full event pipeline (collectionWatcher / folderEvent
    Detector / itemMembershipHandler / mirrorExecutor / syncCoordinator
    + per-key locks + conflict gate + notifier serialization)
  - Phase B: 4-action suppression resolver + prefs UX
  - Phase C: baseline B.1–B.7 (mkdir / copy / adopt / late-attach / hash
    reconcile)
  - Phase D: warningSink + prefs surface + suppressed/conflict counts
  - All 15 review findings (7 high, 8 medium) fixed in fb371c4..a57eded
- **Pre-v2** — Phase 1 (watch folder, auto-import, metadata retrieval,
  file renaming, first-run flow, post-import actions), Phase 2 (collection
  ↔ folder mirroring), Phase 3 (smart rules, duplicate detection, bulk
  ops). Two-way deletion sync (now mode-gated per v2). Plugin icons.
