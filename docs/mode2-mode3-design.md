# Design: Sync Mode 2 & Mode 3 for the folder-list model

Status: **PROPOSED** (not yet implemented) · Target: v3.1 (Mode 2) → v3.2 (Mode 3)
Author: fork maintainer · Date: 2026-07-25

## 1. Goal

Re-enable the two mirror modes so they work in the current **always-multi folder-list
model**, applied **globally to all watch folders** (one shared mode — the user's
"same for all folders").

| Mode | Name | Direction & effect | Deletes? |
|------|------|--------------------|----------|
| `mode1` | Import only (current, default) | disk → Zotero, import PDFs | never |
| `mode2` | Mirror without delete | disk ↔ Zotero: collection renames/moves + item moves reflected both ways; **all deletions are warn-only** | never |
| `mode3` | Mirror with safe delete | mode2 **plus** propagate deletions (folder→trash-collection, disk-delete→trash-attachment) behind fail-closed gates | yes, gated |

**Non-goals.** No per-folder mode (the `mode` pref stays global; per-mapping `mode`
field stays inert). No change to import-only behavior or its defaults. No new sync
directions beyond what single-root Mode 2/3 already did.

## 2. Core principle: global policy, per-mapping routing

The single hardest fact about this change:

> **Mode (policy) is global. Scope (routing) is per-mapping.**

- **Policy is trivial to make global:** "do we mirror? do we delete?" is one pref read.
- **Routing is the real work:** there are now *N* watch roots on disk and *N* target
  collections in Zotero. Every event — a collection renamed in Zotero, a folder deleted
  on disk, an item added to a collection — must be attributed to **exactly one owning
  mapping** so it uses that mapping's watch root and sync-root. Get this wrong and an
  edit in folder A fans out into folder B's tree (Mode 2) or deletes from it (Mode 3).

Most of the *data* layer is already per-mapping (see §3). The gap is the *event* layer:
the notifier observers and the mirror executor still resolve a single global watch
root / sync root.

## 3. Current state (verified against code)

### Already per-mapping ready — reuse as-is
- **trackingStore** — records carry `mappingId`; composite key `mappingId\0localPath`.
- **canonicalPath** — every `collectionKeyTo*` resolver takes an optional `ctx`.
- **baseline** (`content/baseline.mjs`) — `runBaseline({mapping})` threads `ctx`;
  per-mapping completion pref `baselineCompletedByMapping` already exists
  (`baseline.mjs:61-99`).
- **reconcile** (`content/reconcile.mjs`) — `_detectMulti` loops `getActiveMappings()`;
  findings carry `mappingId`; `applyRepairs` routes per finding.
- **Per-file delete gates** — `canSafelyMove(record, absPath)` /
  `canSafelyTrashZoteroAttachment(record, item)` (`mirrorExecutor.mjs:192-288`) are
  pure per-record functions; they recompute SHA-256 **directly** (never via the mtime
  cache) so a mtime-preserving overwrite can't fail them open. Records carry `mappingId`,
  so scoping is the caller's job — already satisfied.
- **The scan loop** — `_scan()` already loops `getActiveMappings()` → `_scanMapping(ctx)`
  (`watchFolder.mjs:364-433`); every tracking mutation inside is `ctx`-scoped.

### Single-root only — must be made per-mapping
- **`_effectiveMode(ctx)`** (`watchFolder.mjs:117-120`): `if (isMultiMappingActive()) return 'mode1';`
  — the blanket force-off. Also note the fallback `return (ctx && ctx.mode) || getPref('mode')…`
  prefers the (always-`'mode1'`) inert `ctx.mode`; once un-forced it must read the
  **global** pref, ignoring `ctx.mode`, to honor "same for all folders".
- **`syncCoordinator.start()`** (`syncCoordinator.mjs:110`):
  `const mode = isMultiMappingActive() ? 'mode1' : (getPref('mode')…)` — coordinator
  stays idle in multi. Must read the global mode and wire the observers.
- **`mirrorExecutor._watchRoot()`** (`mirrorExecutor.mjs:292-296`): returns
  `getPref('sourcePath')`. **Hard blocker** — every fs mutation resolves one global root.
  Must resolve from the action's owning mapping.
- **`collectionWatcher`** (`collectionWatcher.mjs`): one global `Zotero.Notifier`
  observer (`:154`); scope resolution via global `getPref('sourcePath')` (`:405`) and
  `collectionKeyToDiskRelativePath(key)` **without** ctx (`:288`). Must route each event
  to its owning mapping.
- **`folderEventDetector.detectFolderEvents()`** (`folderEventDetector.mjs:50-87`):
  enumerates **all** `collection` records globally. Must run per-mapping (filter records
  by `mappingId`, use `ctx.sourcePath` as the root).
- **`itemMembershipHandler`** (`itemMembershipHandler.mjs`): `resolveSyncRoot()` /
  `collectionKeyToDiskRelativePath()` called without ctx (`:62,96,223,245,338`). Must
  resolve the owning mapping per event.
- **`watchRootGuard`** (`watchRootGuard.mjs`): the SYNC-1 collapse fingerprint is a
  **single global pref** `watchRootTopLevelFingerprint` (`:83,99`). Must be per-mapping,
  else one folder's cloud-eviction blocks/aliases another's.
- **`bulkGuard.confirmFirstLibraryDelete()`** (`bulkGuard.mjs:151`): one-time ack via
  global `mode3LibraryDeleteAcknowledged`. A per-mapping pref `mode3AckByMapping` is
  already scaffolded in `bootstrap.js` — switch to it.
- **`validateMapping`** (`mappings.mjs:196`): rejects overlapping **disk paths** only.
  Does **not** reject overlapping **target collections**. Harmless for import-only;
  a routing hazard for mirroring (see §4).

## 4. New risks unique to multi-folder mirroring

These do not exist in single-root Mode 2/3 and must be designed for:

1. **Cross-mapping contamination.** An item can live in collections belonging to
   different mappings; a collection can be dragged from one mapping's subtree into
   another's. The canonical-path rule and every mirror action must be scoped to one
   owning mapping and must **refuse to act** when ownership is ambiguous (fail-closed).

2. **Overlapping / nested target collections.** Mapping A → "Papers", Mapping B →
   "Papers/Draft". **Resolution (decision: auto-pick):** the **nearest sync-root ancestor
   wins** — walk a collection's ancestor chain, and the first mapping sync-root you hit
   owns it. So B owns "Papers/Draft" and its subtree; A owns the rest of "Papers". This is
   deterministic (no runtime coin-flip). Nesting is **allowed**; only two mappings whose
   sync-roots are the *exact same collection* is a genuine tie with no winner — that stays
   a hard `validateMapping` reject (it's also meaningless for imports).

3. **Library-scope collisions.** A whole-library mapping plus a collection-scope mapping
   in the *same* library. **Resolution:** same nearest-ancestor rule — the collection-scope
   mapping owns its subtree, the library-scope mapping owns everything else in the library
   (it's the fallback owner when no collection sync-root is an ancestor). Allowed; the only
   reject is two library-scope mappings on the *same* library (exact tie).

4. **Shared guard state.** The collapse fingerprint and the first-delete ack were global.
   Per-mapping slots are required so a benign event in one folder can't unlock or block a
   destructive path in another.

5. **Bulk-delete accounting.** "> 20% of tracked files" must be computed **per mapping**
   (a 200-file folder shouldn't dilute a 3-file folder's collapse) **and** an aggregate
   absolute cap (`>200` across the cycle) still applies. Keep both.

## 5. The owning-mapping resolver (new, shared)

A single new helper is the backbone of Stage A. Add to `content/mappings.mjs` (or a new
`content/mappingRouter.mjs`):

```
mappingForCollection(collection) -> ctx | null
  // NEAREST SYNC-ROOT ANCESTOR WINS (deterministic auto-pick).
  // Walk the collection's ancestor chain from the collection upward:
  //   - the first mapping whose collection-scope syncRoot == a node on that chain owns it;
  //   - if none, and a library-scope mapping covers collection.libraryID, that mapping owns it;
  //   - else null (this collection belongs to no watch folder — skip).

mappingForItem(item) -> ctx | null
  // The item's canonical collection (chosen by the existing canonical-path rule,
  // scoped to a single mapping's subtree) -> mappingForCollection. One owner by
  // construction of the nearest-ancestor rule; no runtime ambiguity.
```

Because ownership is decided by *nearest ancestor*, there is never a runtime tie: every
collection has at most one closest sync-root above it. The exact-duplicate sync-root case
(the only true tie) is eliminated at config time by `validateMapping` (§4.2/4.3), so the
resolver never has to guess.

## 6. Stage A — Mode 2 (mirror, NO delete)

**Safety envelope:** Mode 2 never deletes. The worst possible failure is a stray folder
or a suppressed tracking record — recoverable, no data loss. This is why it ships first
and does **not** require the full adversarial gate review that Stage B does.

### A1. Un-force the mode (read the global pref)
- `watchFolder.mjs` `_effectiveMode(ctx)`: drop the `isMultiMappingActive()` short-circuit;
  return `getPref('mode') || 'mode1'` (ignore inert `ctx.mode`).
- `syncCoordinator.mjs` `start()` / `_onModeChanged()`: read `getPref('mode')`; when the
  global mode is `mode2`/`mode3`, wire the observers.

### A2. Owning-mapping routing (§5) wired into the event layer
- **mirrorExecutor:** every action payload gains `mappingId`; `_watchRoot(action)`
  resolves the root from `getMappingById(action.mappingId)` (fall back to legacy synth for
  single-root installs). No action executes without a resolved owner.
- **collectionWatcher:** on each collection / collection-item event, call
  `mappingForCollection`; skip events with no owner; thread `ctx` into
  `collectionKeyToDiskRelativePath(key, ctx)` and stamp `mappingId` on emitted actions.
  (The one global observer stays — routing happens inside the handler; do not register N
  observers.)
- **folderEventDetector:** call once per mapping from the scan loop — filter
  `getAllOfType('collection')` by `mappingId`, use `ctx.sourcePath` as `watchRoot`.
- **itemMembershipHandler:** resolve owner per event via `mappingForItem`; thread `ctx`
  through all `resolveSyncRoot`/`collectionKeyTo*` calls; scope the canonical-collection
  choice to the owning mapping's subtree only.

### A3. Per-mapping baseline on activation
- On first transition to `mode ≥ 2`, run `baseline.runBaseline({mapping: ctx})` for each
  active mapping (already ctx-ready; completion tracked in `baselineCompletedByMapping`).
  Baseline is additive (copies attachments to canonical disk paths, mkdirs empty
  subcollections) — no deletes.

### A4. Config validation (§4.2, §4.3)
- Extend `validateMapping` to reject only the genuine tie: a new mapping whose sync-root
  is the **exact same** collection as an existing mapping's, or a second **library-scope**
  mapping on a library that already has one. Nesting/overlap is **allowed** — the
  nearest-ancestor resolver (§5) picks the owner deterministically at runtime.

### A5. UI
- `preferences.xhtml`: enable the **mode2** card — remove `disabled="true"`,
  `opacity:0.5`, the "Coming soon" badge; restore `onclick="…changeMode('mode2')"`.
  Leave **mode3** disabled until Stage B. `changeMode` already handles mode2 end-to-end.

### A6. Tests (Stage A)
- New `mappingRouter` unit tests: owner resolution, ancestor match, library scope,
  **ambiguity → null**.
- `validateMapping` target-overlap + library-collision cases.
- Multi-mapping Mode 2 integration: rename collection in A → folder renamed under A's
  root only; item moved in A → not reflected in B; folder deleted on disk under A →
  **warn-only**, record `OUT_OF_SCOPE_SUPPRESSED`, nothing deleted, B untouched.
- Cross-mapping isolation assertions on every action type.
- Adjust existing single-root Mode 2 tests only where the executor payload gains
  `mappingId` (default to `legacy`).

## 7. Stage B — Mode 3 (mirror + safe delete)

**This stage deletes files and trashes Zotero items.** It ships only after the
adversarial multi-agent review mandated by CLAUDE.md (find → verify → synthesize).

### B1. Per-mapping guard state
- **Collapse fingerprint:** replace the global `watchRootTopLevelFingerprint` with a
  per-mapping map (`watchRootFingerprintByMapping`, mirroring the
  `baselineCompletedByMapping` pattern). `checkTopLevelCollapse` keyed by `mappingId`.
- **First-library-delete ack:** switch `confirmFirstLibraryDelete` to `mode3AckByMapping`
  (already scaffolded in bootstrap). One ack per library-scope mapping.

### B2. Delete arms (already exist in mirrorExecutor — re-scope, don't rewrite)
- `_zoteroCollectionDeleted` (`:551`) and `_localFolderDeleted` (`:804`) already implement
  the mode2-suppress vs mode3-delete branches. Route them through the owning mapping's
  root/sync-root and per-mapping guard state. Every attachment trash stays behind
  `canSafelyTrashZoteroAttachment`; every local move behind `canSafelyMove`.

### B3. Bulk accounting (§4.5)
- `bulkGuard.isBulkDelete` computed **per mapping** (affected vs that mapping's tracked
  count) **and** an aggregate absolute cap per scan cycle. Confirmation modal names the
  affected folder.

### B4. UI
- Enable the **mode3** card; the Mode-3-only deletion-disposition group
  (`refreshDeletionUI`) and external-deletion group (`refreshExtDelUI`) already gate on
  `mode === 'mode3'`.

### B5. Adversarial review (gate to ship)
Multi-agent find → verify → synthesize focused on: fail-open holes in the re-scoped
delete paths; cross-mapping deletion leakage; ambiguity handling; collapse-guard bypass;
ack-state confusion; ordering (baseline vs delete) races. Only CONFIRMED-safe ships.

### B6. Tests (Stage B)
- Per-mapping collapse fingerprint (eviction in A pauses A only, never B).
- Per-mapping first-delete ack.
- Cross-mapping deletion isolation: mode3 delete in A never trashes B's items/files.
- Hash-drift refusal on trash/move (fail-closed) per mapping.
- Bulk threshold per mapping + aggregate cap.

## 8. Prefs summary

| Pref | Change |
|------|--------|
| `mode` | unchanged (global; now honored in multi) |
| `watchRootFingerprintByMapping` | **new** JSON map, replaces global fingerprint for multi |
| `mode3AckByMapping` | **use** (already scaffolded) instead of `mode3LibraryDeleteAcknowledged` |
| `baselineCompletedByMapping` | already used |
| per-mapping `mode` / `pdfStorageStrategy` | stay **inert** (global wins) |

No net new user-facing prefs; the additions are internal state maps.

## 9. Build / release

**Decision: build both, release together as a single version (v3.1.0).** The *internal*
build is still staged for tractability and safety — Mode 2 implemented and fully green
first, then Mode 3 layered on top — but there is one published artifact.

- Implement Stage A (Mode 2), suite green, bundle clean.
- Implement Stage B (Mode 3) on top, suite green, bundle clean.
- **Adversarial delete-review (§B5) gates the release** — nothing publishes until Mode 3's
  re-scoped delete paths are CONFIRMED safe. (This satisfies CLAUDE.md's "review before
  shipping delete-capable code": the review is about what gets *published*, and the
  combined artifact contains delete code.)
- Trial `.xpi` → archive to `xpi-builds/` → live-verify Mode 2 mirroring *and* Mode 3
  deletes on a throwaway library → release **v3.1.0** (both cards enabled).
- Suite stays green (currently 1011 / 29 files); esbuild bundle clean before packaging.

## 10. Rollback / safety posture

- Setting `mode` back to `mode1` instantly returns to import-only (the scan loop and
  `_effectiveMode` read it live) — no data migration to undo.
- Mode 2 is non-destructive by construction. Mode 3's every delete passes a per-record
  direct-hash gate + bulk guard + per-mapping collapse guard + first-delete ack; any gate
  failing → suppress-not-delete (fail-closed), matching the single-root contract.

## 11. Decisions (resolved 2026-07-25)

1. **Bulk thresholds:** per-mapping **plus** an aggregate absolute cap per scan cycle.
2. **Overlapping targets:** **auto-pick via nearest-ancestor** — nesting allowed, resolved
   deterministically at runtime; only exact-duplicate / double-library-scope sync-roots are
   rejected at config time (§4.2/4.3, §5).
3. **Release:** build both modes, **release together as v3.1.0**; the adversarial delete
   review still gates the combined release (§9).
