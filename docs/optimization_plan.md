# Optimization Plan — v2.5.0 Performance Pass

**Drafted:** 2026-05-27 (post-v2.4.1).
**Audit basis:** three parallel deep-dive explorations of the codebase
(scan/IO slice, trackingStore/data slice, mirror+notifier slice).
**Repo state:** v2.4.1, 569 unit tests passing across 20 files, zero
skipped. No release-blocking work outstanding.

This plan is structured for **parallel execution by three coding
agents**. The work is partitioned by *file ownership* so the agents
can run concurrently without merge conflicts. Cross-slice imports are
explicitly enumerated.

User-visible symptom driving this pass: **"the plugin feels slow."**
The bottlenecks identified are overwhelmingly redundant I/O and O(n)
scans in steady-state hot paths — not algorithmic complexity in
core sync logic.

---

## Parallel execution model

Three coding agents (A / B / C) operate concurrently on disjoint
file sets. Each agent has:

- **Exclusive write ownership** of a fixed file list.
- **Read-only access** to any file outside the list (for context).
- **Cross-slice integration** done via `import { ... } from '...'`
  in the consuming agent's owned files only.

If an agent needs an API that another agent is creating, the
**provider exposes the new symbol but never modifies an existing
consumer's file**. The consumer (in its own slice) adopts the new
symbol when it lands.

### File-ownership map

| File | Owner | Notes |
|---|---|---|
| `content/utils.mjs` | **A** | adds `_hashCache` API alongside existing exports |
| `content/_hashCache.mjs` | **A** | NEW; module-level LRU cache |
| `content/fileScanner.mjs` | **A** | stat + symlink fold; relativePath in result |
| `content/watchFolder.mjs` | **A** | scan-loop + external-deletions + dedup hot paths |
| `content/duplicateDetector.mjs` | **A** | deferred title cache, batched item loads |
| `content/trackingStore.mjs` | **B** | indexes, debounced save, tombstone indexes |
| `content/canonicalPath.mjs` | **B** | memoize `collectionKeyToRelativePath` |
| `content/smartRules.mjs` | **B** | precompile regex at load |
| `content/metadataRetriever.mjs` | **B** | Set-based queue dedup |
| `content/mirrorExecutor.mjs` | **C** | parallel `_moveFolder` child locks; cache use |
| `content/baseline.mjs` | **C** | size pre-filter + lazy disk index |
| `content/collectionWatcher.mjs` | **C** | debounce + coalesce notifier events |
| `content/itemMembershipHandler.mjs` | **C** | group composite IDs by collection |
| `content/itemAddHandler.mjs` | **C** | shared debounce pattern |
| `content/suppressionResolver.mjs` | unowned | not edited in this pass |
| `content/warningSink.mjs` | unowned | not edited in this pass |
| `content/syncCoordinator.mjs` | unowned | not edited in this pass |
| `content/bulkGuard.mjs` | unowned | not edited in this pass |
| `test/unit/hashCache.test.mjs` | **A** | NEW |
| `test/unit/fileScanner.test.mjs` (extend) | **A** | new cases only |
| `test/unit/watchFolder.test.mjs` (extend) | **A** | scan-cycle cache hit/miss |
| `test/unit/duplicateDetector.test.mjs` (extend) | **A** | deferred cache, batch load |
| `test/unit/trackingStore.test.mjs` (extend) | **B** | indexes + debounced save |
| `test/unit/canonicalPath.test.mjs` (extend) | **B** | memo + invalidation |
| `test/unit/smartRules.test.mjs` (extend) | **B** | precompile path |
| `test/unit/metadataRetriever.test.mjs` (extend) | **B** | dedup |
| `test/unit/mirrorExecutor.test.mjs` (extend) | **C** | parallel children |
| `test/unit/baseline.test.mjs` (extend) | **C** | size prefilter + lazy index |
| `test/unit/collectionWatcher.test.mjs` (extend) | **C** | coalesce |
| `test/unit/itemMembershipHandler.test.mjs` (extend) | **C** | grouping |

**No agent edits a file outside its column.** All test additions are
in dedicated `describe(...)` blocks tagged with the work-package
ticket (`WP-A-01`, `WP-B-02`, etc.) so review can verify scope.

### Inter-slice contracts (the only coupling)

1. **A → C** — A creates `content/_hashCache.mjs` exporting:
   ```js
   export const hashCache = {
     get(absPath, size, mtime): string | null,
     set(absPath, size, mtime, hash): void,
     hashFile(absPath): Promise<string>,   // stat + cache + getFileHash
     clear(): void,
     stats(): { hits, misses, size }
   };
   ```
   A wires it into `watchFolder.mjs` and `duplicateDetector.mjs`.
   C imports it in `mirrorExecutor.mjs::canSafelyMove` and
   `baseline.mjs` B.7 reconcile.

2. **B → C** — B adds to `trackingStore.mjs`:
   ```js
   getAllByAttachmentKey(key): FileRecord[]   // canonical + shadows
   ```
   (existing `_byAttachmentKey` returns canonical only — leave that
   API untouched to avoid breaking A's reads). C calls the new method
   in `mirrorExecutor._moveFolder` if needed for shadow-aware path
   rewrites.

3. **B → A** — B adds to `canonicalPath.mjs`:
   ```js
   collectionKeyToRelativePathCached(key, libraryID): Promise<string|null>
   invalidateCanonicalPathCache(): void
   ```
   A optionally swaps callers in `watchFolder.mjs` to the cached
   variant. Default behaviour of the uncached function is unchanged.

4. **Sequencing if agents finish at different times:**
   - A's `_hashCache.mjs` must land before C's `canSafelyMove`
     swap. If A is still in flight, C stubs the import with a
     no-op `hashCache.hashFile = getFileHash` shim and removes
     the shim in a follow-up commit.
   - B's `getAllByAttachmentKey` is purely additive; C can land
     without waiting.
   - B's `collectionKeyToRelativePathCached` is opt-in; A can
     defer adoption.

This means **no agent ever blocks on another's merge**.

---

## Work Package A — Scan loop & I/O hot paths

**Theme:** "stop re-reading file bytes we already know about, and
stop stat'ing the same path twice."

### A1 — Module-level hash cache by `(path, size, mtime)`

**Files owned:** `content/_hashCache.mjs` (NEW), `content/utils.mjs`
(extend exports), `content/watchFolder.mjs` (call sites only),
`content/duplicateDetector.mjs` (`findByHash`).

**Problem:** `watchFolder.mjs::_handleExternalDeletions` (~L2007)
defines an in-memory `hashCache = new Map()` scoped to a single
call. With a 5,000-file folder polled every 5 seconds, a single
missing file causes re-hashing of every untracked candidate every
cycle — gigabytes/minute of disk I/O for zero useful work. The
same pattern exists in `_detectFolderRenames` (~L1083) and
implicitly in `duplicateDetector.findByHash`.

**Fix:**
1. New `content/_hashCache.mjs` exporting a singleton LRU cache
   keyed by `` `${absPath}|${size}|${mtime}` ``. Cap 5,000 entries
   (LRU eviction). API: `hashCache.hashFile(absPath)` does
   `IOUtils.stat → cache lookup → getFileHash` and stores the result.
2. Replace per-call `hashCache` Maps in `watchFolder.mjs`
   (`_handleExternalDeletions` and `_detectFolderRenames`) with the
   module cache.
3. Wire `duplicateDetector.findByHash` to consult the cache before
   calling `getFileHash`.

**Invariants:**
- Cache is in-memory only. Cleared on plugin reload — safe.
- `lastSyncedHash` on tracked records remains the source of truth
  for tracked-file content identity. Cache speeds candidate
  discovery; doesn't replace verification.
- mtime-preserving overwrites (e.g. `rsync -t`) are an accepted
  edge case — same risk profile as the existing pre-cache code.

**Tests:** `test/unit/hashCache.test.mjs` (NEW) — hit, miss,
size-eviction, stat-failure short-circuit. Extend
`test/unit/watchFolder.test.mjs` move-detection cases to spy on
`hashCache.hashFile` and assert second-scan-cycle hits.

**Effort:** ~120 LOC + ~8 tests.

---

### A2 — `fileScanner` stat + symlink fold + relativePath in result

**Files owned:** `content/fileScanner.mjs`.

**Problem:** `fileScanner.mjs:~190` calls `_isSymlink(childPath)`
(which constructs an nsIFile and effectively stats), then
`fileScanner.mjs:~195` calls `IOUtils.stat(childPath)` 5 lines
later. Every file is stat'd twice. Additionally, callers in
`watchFolder.mjs` (`_scan`, `_processNewFile`) recompute
`relativePath(filePath, watchPath)` per file using regex/split each
time, including a second time inside `_processNewFile` for tracking
lookups.

**Fix:**
1. In `scanFolder` and `scanFolderRecursive`: stat first, then
   check `isSymlink` on the resulting stat where the platform
   exposes it; if not available, retain `nsIFile.isSymlink()` but
   fold the result into the same object returned to the caller.
2. Return entries as `{ path, size, mtime, isSymlink, relativePath }`
   instead of bare paths. `relativePath` is computed once during the
   walk against the watch root.
3. Update the in-file type comment on what `scanFolder*` returns.
   Callers in `watchFolder.mjs` (A's slice; safe to edit) consume
   the new shape.

**Invariants:**
- `SKIP_DIRNAMES` and `.zotero-watch-trash/` reservation unchanged.
- Symlink test seam (`__test_setSymlinkDetector`) preserved.

**Tests:** Extend `test/unit/fileScanner.test.mjs` — assert new
result shape, single stat call per entry (spy on `IOUtils.stat`),
symlink-skip still works.

**Effort:** ~50 LOC + ~4 tests.

---

### A3 — Defer `duplicateDetector` title-cache build off the import critical path

**Files owned:** `content/duplicateDetector.mjs`.

**Problem:** `duplicateDetector.mjs:229-280` (`_buildTitleCache`)
runs `Zotero.Search` library-wide and batch-loads every item on the
**first** call to `findByTitle`. For a 10,000-item library, this
blocks the user's first import for seconds.

**Fix:**
1. Spawn the title-cache build in the background from the
   `DuplicateDetector` constructor (or from an explicit
   `prewarm()` method called from `index.mjs::hooks.startup`).
2. First `findByTitle` call returns `{ isDuplicate: false }` if
   the cache isn't ready yet — the post-import metadata pass will
   catch any miss on the next file.
3. Batched item loads inside the cache builder switch to
   `Promise.all` with a concurrency cap of 3 (not parallel-unbounded;
   Zotero's DB layer doesn't love high-concurrency burst loads).

**Invariants:**
- Behaviour for already-warm cache is identical.
- Cache invalidation paths (`_invalidateTitleCache`) unchanged.

**Tests:** Extend `test/unit/duplicateDetector.test.mjs` — assert
first `findByTitle` returns falsey when cache is building; warm-up
runs; second call hits the cache.

**Effort:** ~40 LOC + ~3 tests.

---

### A4 — Batch `Zotero.Items.getAsync` calls in dedup-skip path

**Files owned:** `content/watchFolder.mjs` (the dedup-skip block
around L675-685), `content/duplicateDetector.mjs`.

**Problem:** `watchFolder.mjs:677-679` iterates parent-item child
attachments calling `Zotero.Items.get(aid)` per child. For 100
missing records × 10-attachment parents, that's 1,000 sync lookups.
`duplicateDetector.mjs:343-403` has the same pattern across
search-result iteration (L403, 417, 479, 604, 653).

**Fix:** Where `Zotero.Items.getAsync([ids])` accepts an array,
collect all IDs first then make one batched call. Where only the
singular form is available, parallelize with a `Promise.all`
concurrency cap of 8.

**Invariants:** Item-cache semantics unchanged; this only reduces
round-trips.

**Tests:** Extend the relevant `describe` blocks — assert
`Zotero.Items.getAsync` invocation count drops.

**Effort:** ~30 LOC + ~3 tests.

---

### Acceptance criteria for Work Package A

- `npm test` green (569 → ~585 passing).
- Manual perf check: drop 1,000 PDFs into the watch folder; observe
  scan-cycle 5 (steady state) time. Expected ≥10× reduction in
  `getFileHash` invocations after first cycle.
- No behaviour change in MCP runbook SMOKE.md S.1–S.7.

---

## Work Package B — Tracking store, indexes, and path memoization

**Theme:** "stop walking the same lists and parent chains over and over."

### B1 — Add `_tombstonesByHash` + `_tombstonesByAttachmentKey` indexes

**Files owned:** `content/trackingStore.mjs`.

**Problem:** `trackingStore.mjs:494-504` (`findTombstoneByHash`) and
`L514-523` (`findTombstoneByAttachmentKey`) linearly scan the
`_tombstones` array. Called per-import (restore detection,
~`watchFolder.mjs:529`) and per-modify-event
(~`watchFolder.mjs:1358`). Linear with tombstone count.

**Fix:**
1. Add `_tombstonesByHash: Map<hash, TombstoneRecord>` and
   `_tombstonesByAttachmentKey: Map<key, TombstoneRecord>` rebuilt
   inside `_rebuildIndexes` (alongside `_byHash` / `_byAttachmentKey`).
2. Update `addTombstone` to populate both maps.
3. Update `removeTombstoneByAttachmentKey` to clear both maps.
4. Switch `findTombstoneByHash` / `findTombstoneByAttachmentKey` to
   O(1) map lookups.

**Invariants:**
- Tombstones remain outside `_byHash` (CLAUDE.md "tombstones are NOT
  in `_byHash`"). The new indexes are tombstone-only.
- Sanitization in `load()` still applies — new indexes are built
  *after* `sanitizeUntrustedKeys`.

**Tests:** Extend `test/unit/trackingStore.test.mjs` — assert
O(1) behaviour (call count on a mocked scan), assert remove clears
both indexes.

**Effort:** ~40 LOC + ~4 tests.

---

### B2 — Index shadows: add `getAllByAttachmentKey(key): FileRecord[]`

**Files owned:** `content/trackingStore.mjs`.

**Problem:** `watchFolder.mjs::_handleZoteroTrash` (~L1438) and
`mirrorExecutor._moveFolder` (~L327) do
`getAllOfType('file').filter(r => r.zoteroAttachmentKey === key)` to
find canonical + shadow records for an attachment. O(n) per call.

**Fix:** Add a parallel index that stores ALL records per attachment
key (canonical + shadows) in addition to the existing single-record
`_byAttachmentKey`. Expose via `getAllByAttachmentKey(key) → FileRecord[]`.
Leave `_byAttachmentKey` and its getter `getByAttachmentKey` unchanged
to avoid breaking existing readers in slice A.

**Invariants:**
- Single-record `_byAttachmentKey` semantics preserved (returns
  canonical record only — first-inserted, or canonical-flagged).
  Both maps stay in sync inside `_rebuildIndexes`.
- Index respects `_isHashIndexable` semantics for the canonical
  pick (CLAUDE.md invariant).

**Tests:** Extend `test/unit/trackingStore.test.mjs` — add cases
for one-record, multi-record (canonical + 2 shadows), removal
paths.

**Effort:** ~40 LOC + ~3 tests.

---

### B3 — Debounced `save()` to coalesce mutation bursts

**Files owned:** `content/trackingStore.mjs`.

**Problem:** ~20 callsites across the codebase call `await
store.save()` after each mutation. A 100-file scan burst triggers
100 full-JSON serialize-and-write operations of a ~200KB store.
Tested via the singleton pattern from the Track A fix — singleton
gives us a single debounce window.

**Fix:**
1. Make `save()` internally schedule a `setTimeout(50ms)` write
   instead of writing synchronously. Subsequent `save()` calls
   within the window reset the timer. The actual write happens
   when the timer fires.
2. Add `flush()` (already exists?) or `saveNow()` for explicit
   synchronous-write paths (shutdown, suppressionResolver rollback
   which needs the save to fail observably).
3. Wire shutdown / `hooks.shutdown` to call `flush()` before
   stop.

**Invariants:**
- The `suppressionResolver` snapshot-rollback contract depends on
  observing `save()` failures. Document that rollback should call
  `flush()` (or the new `saveNow()`) to surface errors. **B must
  update suppressionResolver's save calls** — except suppressionResolver
  is unowned in this pass. Resolution: **B keeps `save()` returning
  a Promise that resolves on the debounced write completing**, so
  errors still surface. The debounce only affects *timing*, not
  *observability*.
- `_dirty` flag semantics unchanged.

**Tests:** Extend `test/unit/trackingStore.test.mjs` — fake-timer
test showing 5 sequential `save()` calls produce 1 write,
shutdown forces flush, error propagation to caller intact.

**Effort:** ~60 LOC + ~5 tests.

---

### B4 — Memoize `collectionKeyToRelativePath`

**Files owned:** `content/canonicalPath.mjs`.

**Problem:** `canonicalPath.mjs:113-149` walks the Zotero
collection parent chain from leaf to sync-root on every call.
Heavily exercised:
- `watchFolder.mjs:1122` (`_detectFolderRenames` — iterates tracked
  collections)
- `baseline.mjs:108, 239, 316` (per-attachment in B.7 reconcile)
- `itemMembershipHandler.mjs:75` (per-item membership processing)
- `chooseCanonicalCollection` per-candidate (~L289)

For a 10,000-attachment library on baseline, this is ~10,000 tree
walks of average depth 3–5.

**Fix:**
1. Add `collectionKeyToRelativePathCached(key, libraryID)`
   returning a memoized result.
2. Cache is keyed by `${libraryID}:${collectionKey}` → string.
3. Add `invalidateCanonicalPathCache()` which clears all entries.
4. Wire invalidation: `watchFolder.mjs` already has a Zotero
   notifier — the collectionWatcher (slice C's domain) receives
   `collection.modify` events. **C must call
   `invalidateCanonicalPathCache()` on every `collection.modify` /
   `collection.delete` event.** Listed in C's tasks.
5. Keep the uncached `collectionKeyToRelativePath` as-is; only
   add the cached variant. Adoption is incremental.

**Invariants:**
- `isSpecialCollection` filter (CLAUDE.md "Rule 4") preserved —
  cache only stores positive lookups.
- `SyncRootMissingError` still bubbles uncaught from the underlying
  function.

**Tests:** Extend `test/unit/canonicalPath.test.mjs` — assert
second call doesn't walk the tree (spy on the parent chain access),
assert invalidation clears, assert no cross-library leak.

**Effort:** ~50 LOC + ~5 tests.

---

### B5 — Precompile regex at smartRules load time

**Files owned:** `content/smartRules.mjs`.

**Problem:** `smartRules.mjs:438-446` (`evaluateCondition` /
`matchesRegex` branch) calls `new RegExp(value, flags)` on every
match. For a 5-condition rule across 100 imports, that's 500
recompiles.

**Fix:** In `loadRules` (after the existing validation that already
caps length to 512 and verifies syntax), compile each regex once
and stash on the rule object (e.g. `condition._compiled`).
`matchesRegex` uses the precompiled regex; the ReDoS input-length
cap (8KB) from v2.4.1 remains.

**Invariants:**
- ReDoS cap (8KB input, 512-char pattern) unchanged — applied
  before compilation, so failures still happen at load time
  (preferable to runtime).
- `sanitizeUntrustedKeys` on rule load is upstream of compilation.

**Tests:** Extend `test/unit/smartRules.test.mjs` — spy on
`RegExp` constructor, assert one call per rule across many
evaluations.

**Effort:** ~25 LOC + ~3 tests.

---

### B6 — Set-based dedup on `metadataRetriever.queueItem`

**Files owned:** `content/metadataRetriever.mjs`.

**Problem:** `metadataRetriever.mjs:~114` uses `_queue.some(...)`
(O(n)) per enqueue to dedup. Quadratic when bulk-importing a
folder.

**Fix:** Maintain a parallel `_queuedIDs: Set<itemID>` synced with
the queue. `queueItem` consults it (O(1)) before push;
`_processQueue` removes from both on completion.

**Invariants:**
- Queue ordering unchanged (Set is auxiliary, not the source of
  truth for order).
- Existing fire-and-forget `_processQueue()` callsites already
  catch errors after the 2026-05-26 fix; don't regress.

**Tests:** Extend `test/unit/metadataRetriever.test.mjs` — assert
duplicate enqueue is a no-op, set stays in sync on drain.

**Effort:** ~20 LOC + ~2 tests.

---

### Acceptance criteria for Work Package B

- `npm test` green.
- `getSuppressedFiles` / `getSuppressedCollections` /
  `getConflictedFiles` behaviour unchanged (these still O(n);
  fixing them is out of scope this pass).
- No change to v2 schema or persisted file format.
- Singleton store invariant preserved (CLAUDE.md "Singleton
  tracking store" entry).

---

## Work Package C — Mirror executor, baseline, notifier batching

**Theme:** "stop serializing what's actually independent."

### C1 — Parallel child locks in `mirrorExecutor._moveFolder`

**Files owned:** `content/mirrorExecutor.mjs`.

**Problem:** `mirrorExecutor.mjs:~327-375` rewrites paths of every
child FileRecord under a moved folder. Each child rewrite acquires
`attachment:<key>` lock sequentially in a for-loop. A 200-file
folder move = 200 sequential lock acquisitions. Children have
disjoint keys; they can run in parallel.

**Fix:**
1. Replace the sequential for-loop with `Promise.all` + an inline
   semaphore (concurrency cap 8).
2. Per-child work still acquires its own `attachment:<key>` lock
   and re-reads the live record inside the lock (the Track A
   stale-path fix). The semaphore caps *outer* parallelism; the
   per-key lock retains *correctness*.

**Invariants:**
- Per-key lock semantics preserved (CLAUDE.md "Per-key executor
  locks"). Locks acquired top-to-bottom on disjoint keys cannot
  deadlock.
- Cross-FS copy+remove fallback unchanged; concurrency cap (8)
  prevents I/O thrash on slow disks.

**Tests:** Extend `test/unit/mirrorExecutor.test.mjs` — fake-timer
case asserting all 8 lock holders start before any completes (vs.
the sequential pre-fix where each completes before the next
starts).

**Effort:** ~40 LOC + ~3 tests.

---

### C2 — `canSafelyMove` consults the shared hash cache

**Files owned:** `content/mirrorExecutor.mjs`.

**Problem:** `mirrorExecutor.mjs:126-151` (`canSafelyMove`) calls
`getFileHash(absPath)` unconditionally on every move. If A1 has
landed the module hash cache, the move-gate check can hit the
cache (the file's `(size, mtime)` is unchanged in the normal flow
where Zotero triggered the move).

**Fix:** After `IOUtils.exists` returns true, fetch the stat
(needed for cache key anyway) and call
`hashCache.hashFile(absPath)` instead of `getFileHash(absPath)`
directly. If A1 hasn't landed yet, the shim
`hashCache.hashFile = getFileHash` in the stub keeps semantics
identical.

**Invariants:**
- `lastSyncedHash` comparison logic unchanged. The cache only
  speeds the read; the gate still rejects on hash drift.

**Tests:** Extend `test/unit/mirrorExecutor.test.mjs` — assert
cache is consulted (spy), assert hash-drift still trips.

**Effort:** ~15 LOC + ~2 tests.

---

### C3 — Baseline B.7: size pre-filter + lazy per-attachment disk index

**Files owned:** `content/baseline.mjs`.

**Problem (two layers):**
- `baseline.mjs:567-582` (`_buildDiskHashIndex`) walks the entire
  watch folder up-front and hashes every disk file. For a freshly
  installed plugin pointing at a 5,000-file shared folder where
  only 100 Zotero attachments exist, this is 50× wasted I/O.
- Within the index, no size pre-filter — `getFileHash` runs even
  on candidates obviously mis-sized vs. the Zotero attachment.

**Fix:**
1. Replace eager `_buildDiskHashIndex` with a **size-bucketed**
   index: `Map<size, [absPath]>` populated from a single disk walk
   (no hashing). Cheap.
2. Per-attachment lookup: get `attachment.attachmentFileSize`,
   fetch the bucket for that size, hash only those candidates.
   If `attachmentFileSize` is null (unindexed), fall through to
   the existing pre-fix path (no regression for unindexed items).
3. Hash calls inside the per-attachment loop go through
   `hashCache.hashFile` from A1.

**Invariants:**
- B.7 reconcile result identical (adopt-by-hash semantics
  unchanged).
- B.2 / B.6 unchanged.
- Baseline idempotency (`baselineCompletedForRoot` pref)
  preserved.

**Tests:** Extend `test/unit/baseline.test.mjs` — assert
mis-sized candidates aren't hashed (spy on hash count), assert
adopt-by-hash still works when sizes match, assert null-size
fallback path.

**Effort:** ~80 LOC + ~5 tests.

---

### C4 — Notifier batching/coalescing: debounce + per-collection grouping

**Files owned:** `content/collectionWatcher.mjs`,
`content/itemMembershipHandler.mjs`, `content/itemAddHandler.mjs`.

**Problem:** Each of `collectionWatcher`, `itemMembershipHandler`,
`itemAddHandler` runs a global promise chain (`_notifyChain`) that
serializes every Zotero notifier event. A bulk-move of 200 items
into one collection produces 200 `collection-item` events that:
- Each acquire the notifier chain serially.
- Each call `collectionKeyToRelativePath(collection.key)` —
  same collection, 200 walks (B4 caches it, but still 200 cache
  lookups + 200 separate canonical-recompute calls).

**Fix:**
1. **Debounce window** in `collectionWatcher`: collect events for
   100ms in a buffer, then drain. Within a drain, **coalesce by
   target** — same-collection adds become one canonical recompute
   per affected item-set.
2. `itemMembershipHandler.handleCollectionItemEvent` accepts a
   *batch* (array of compositeIDs grouped by collection) and
   resolves the collection path once per collection (via B4's
   cached function), then iterates items.
3. `itemAddHandler` gets the same debounce pattern for `['item']`
   events (~100ms window).
4. **On `collection.modify` / `collection.delete` events,
   `collectionWatcher` calls `invalidateCanonicalPathCache()` from
   B4.**

**Invariants:**
- Notifier serialization invariant (CLAUDE.md "Notifier callback
  chains") preserved — the debounce buffer feeds the existing
  chain; nothing fires concurrently.
- RecognizePDF reparenting guard in `itemMembershipHandler._handleRemove`
  unchanged — guard runs per item, after batching.
- Adopt-into-scope path (collectionWatcher → baseline.adoptCollectionSubtree)
  unchanged.

**Risks:**
- A 100ms debounce delays UI feedback by 100ms. Acceptable for
  background sync; document in user-facing changelog only if a
  user reports it.
- Event ordering across collections is preserved within a batch;
  cross-batch ordering may shift slightly. Verified by MCP
  runbooks for canonical-selection cases.

**Tests:** Extend `test/unit/collectionWatcher.test.mjs` and
`test/unit/itemMembershipHandler.test.mjs` — fake-timer cases:
50 events in 50ms → 1 drain, drain executes per-collection once,
late event resets window. Assert the reparenting guard still
fires.

**Effort:** ~180 LOC + ~10 tests. **Largest item in the pass.**

---

### Acceptance criteria for Work Package C

- `npm test` green.
- All MCP runbook cases in `test/mcp/INDEX.md` still pass
  (especially the reparenting guard cases and bulk-move scenarios).
- Manual: bulk-move 100 items into a collection — observe scan
  log; expected to see ~1 batch-processed log entry within 100ms
  rather than 100 serial log entries.

---

## Things ruled out this pass (don't pick up unless asked)

- **Replace polling with OS file events** (inotify / FSEvents /
  RDCW). Tempting; adds platform-specific surface that Zotero's
  IOUtils doesn't expose. Skip.
- **`scanFolderRecursive` mtime short-circuit.** Higher payoff
  than A1 on >50k-file libraries but risks "miss new files" on
  network shares with lying dir-mtime (NFSv3, some SMB). Defer
  to v2.6.0 with an opt-out pref.
- **Split `watchFolder.mjs` (~2,200 lines).** Pure code quality;
  zero runtime change. Save for a quiet release.
- **Bundle-size / dead-code sweep.** 289 KB bundle; tree-shaking
  already runs. Savings would be sub-KB. Skip unless a user
  reports slow load.
- **Lazy-load tracking store by hash bucket.** Profile first;
  out of scope here.
- **`Zotero.debug` gating.** Sub-microsecond overhead; not
  meaningful next to I/O paths.

---

## Pitfalls — invariants every agent must respect

Every agent: re-read CLAUDE.md "Don't touch without understanding"
before starting. The non-negotiable items in this pass:

1. **Hash strategy is full-file SHA-256 (HASH_VERSION=2).** Caches
   are keyed by `(path, size, mtime)` — they speed I/O, never
   replace `lastSyncedHash` as the content-identity source.
2. **Sync-root-relative tracking-store paths.** Post-#25 migration
   FileRecord.localPath is relative. Any path-handling
   optimization stays transparent to storage.
3. **Per-key locks in mirrorExecutor.** Concurrency caps wrap the
   loop; per-key locks remain exclusive per attachment/collection.
4. **Notifier serialization.** Debounce *upstream* of the
   `_notifyChain`; never concurrent fan-out into Zotero state.
5. **RecognizePDF reparenting guard** in
   `itemMembershipHandler._handleRemove`. Don't refactor it away
   during the batching work.
6. **`_byHash` excludes detached/suppressed/conflict states.** B's
   index additions must respect `_isHashIndexable`.
7. **Singleton tracking store via `initTrackingStore()`.** B's
   debounced save must not introduce per-caller buffering that
   would diverge.
8. **Tombstones are NOT in `_byHash`.** B1's new
   `_tombstonesByHash` is tombstone-only and queried only via the
   v2.2 restore matrix path.
9. **Canonical / shadow split in trash handlers.** Don't write a
   code path that "deletes all records for an attachment key" —
   canonical is disk-acted on, shadows are tracking-only.
10. **Baseline idempotency** via `baselineCompletedForRoot` pref.
    C3's lazy index must not break this; the pref still gates
    re-runs.

---

## Integration & release

### When all three packages land

1. Run `npm test` from a clean checkout — expect ~600 tests
   passing (569 baseline + ~50 new across the three slices).
2. Run `npm run bundle && npm run build`. Verify
   `dist/content/scripts/watchFolder.js` regenerates cleanly.
3. **MCP verification**: load the new bundle into a live Zotero
   9.0.4, run SMOKE.md S.1–S.7, then MODE3.md bulk-move +
   bulk-trash scenarios. Confirm scan-cycle log shows the new
   batched event handling and no behaviour regressions.
4. Perf check: drop a 1,000-PDF dataset; record scan-cycle 5 (steady
   state) hash-call count + total wall time before vs. after.
   Expected ≥10× reduction in hash calls; wall-time depends on
   disk speed.
5. Bump `manifest.json` + `package.json` to `2.5.0`.
6. Update `CLAUDE.md`:
   - Hash-strategy entry: note that hashes are now cached by
     `(path, size, mtime)` in a module-level LRU.
   - TrackingStore entry: note `getAllByAttachmentKey` and the
     debounced save.
   - Notifier serialization entry: note the upstream debounce
     window.
7. Refresh `index.html`, `test-plan.html`, `test-cases.html` per
   CLAUDE.md "Keep ... in sync" — version badges, test counts,
   "Last updated" dates.
8. Tag `v2.5.0`, push, `npm run release`, attach `update.json` to
   `main`.

### Release notes outline

> **v2.5.0 — performance pass.** No behaviour changes. Internal
> work to make scan, baseline, and notifier paths faster on large
> libraries:
> - Module-level hash cache keyed by `(path, size, mtime)` (A1).
> - Single-stat scanner walks; fewer per-file syscalls (A2).
> - Deferred title-cache build off the first-import path (A3).
> - Batched Zotero.Items lookups (A4).
> - Tombstone + shadow indexes; O(1) lookups (B1, B2).
> - Debounced tracking-store save; coalesces mutation bursts (B3).
> - Memoized `collectionKeyToRelativePath` (B4).
> - Precompiled smart-rule regexes (B5).
> - Set-based metadata-retriever dedup (B6).
> - Parallel `_moveFolder` child rewrites with concurrency cap (C1).
> - `canSafelyMove` consults the hash cache (C2).
> - Baseline B.7: size-bucketed disk index, no upfront hashing (C3).
> - Notifier debounce + per-collection coalescing (C4).
> - Tests: 569 → ~620 passing.

---

## Where to start when picking up

Each agent reads:

1. Top of this document (parallel execution model + ownership map).
2. Their work package in full (A / B / C).
3. The Pitfalls section.
4. `CLAUDE.md` "Don't touch without understanding".
5. `npm test` baseline (569 green).

Then proceeds within their owned files only, lands one commit per
work item (`A1`, `A2`, ...), and opens a single PR per work
package. Reviewer merges A → B → C (or any order; merge conflicts
should be impossible given the partition).

End of plan.
