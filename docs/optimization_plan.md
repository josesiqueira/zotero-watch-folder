# Optimization Plan — v2.5.0 perf pass

**Status:** SHIPPED on `main` 2026-05-27.
**Trigger:** v2.4.1 + user report "plugin feels slow".
**Approach:** three parallel work packages (A / B / C) on disjoint
file-ownership slices, executed by three coding agents in isolated
git worktrees, merged in order A → B → C + integration commit.

**Pre-pass baseline:** 569 unit tests across 20 files, bundle 289 KB.
**Post-pass:** 2466 tests across 84 files, bundle 320 KB. All green.

---

## What shipped

### Work Package A — scan loop & I/O hot paths

Merge commit: `0ee76f5`.

| # | What | Commit | Verification |
|---|---|---|---|
| **A1** | Module-level `(path, size, mtime)` LRU hash cache. `content/_hashCache.mjs` (NEW) exports `get` / `set` / `hashFile` / `clear` / `stats` + a `__test_setCapacity` seam. Consumed by `watchFolder.mjs` (move detection + folder-rename detection), `duplicateDetector.findByHash`, `mirrorExecutor.canSafelyMove`, `baseline._hashViaCache`. LRU cap 5,000 entries. | `a53ffff` | `test/unit/hashCache.test.mjs` |
| **A2** | `fileScanner.scanFolder*` returns `{path, mtime, size, isSymlink, relativePath}` — single stat per entry, `relativePath` computed once during the walk. `__test_setSymlinkDetector` seam preserved. | `911655f` | `test/unit/fileScanner.test.mjs` |
| **A3** | `duplicateDetector` title-cache prewarm runs in the background from `init()`; first `findByTitle` returns falsey if not ready instead of blocking the import. `_titleCacheReady` flag; `prewarmTitleCache()` fire-and-forget with a catch on failure. | `9db8a4d` | extends `test/unit/duplicateDetector.test.mjs` |
| **A4** | Batched `Zotero.Items.getAsync([ids])` array form in `watchFolder.mjs` dedup-skip (line ~686) and `duplicateDetector.mjs` search-result iteration. Per-id `Promise.all` fallback cap 8 when the array form is unavailable. | `559b416` | extends both test files |

### Work Package B — tracking store, indexes, path memoization

Merge commit: `8ae51cb`.

| # | What | Commit | Verification |
|---|---|---|---|
| **B1** | `_tombstonesByHash` + `_tombstonesByAttachmentKey` Maps in `trackingStore.mjs`. Built in `_rebuildIndexes`, kept in sync by `addTombstone` + `removeTombstoneByAttachmentKey`. `findTombstoneByHash` / `findTombstoneByAttachmentKey` now O(1). Tombstones stay OUT of `_byHash`. | `6fd966d` | extends `test/unit/trackingStore.test.mjs` |
| **B2** | `_byAttachmentKeyAll: Map<key, FileRecord[]>` parallel index + `getAllByAttachmentKey(key)` public method. Returns canonical + all shadow records. Existing single-record `_byAttachmentKey` left untouched. **Production consumers: none yet — see Open items.** | `b90ce39` | UT-115 in `trackingStore.test.mjs` |
| **B3** | Debounced `save()` (50 ms idle timer). `_saveTimer` + `_pendingSave` deferred-promise plumbing — every `await save()` resolves when the actual write completes; observers still see write errors. `flush()` / `saveNow()` for explicit synchronous-write paths. Integration commit wires `flush()` into `onShutdown` (was deferred from WP-B because `content/index.mjs` was out of scope). | `c158b4b` + integration | extends `trackingStore.test.mjs` |
| **B4** | `collectionKeyToRelativePathCached(key, libraryID)` with `_relativePathCache: Map<libraryID:collectionKey, string>` + `invalidateCanonicalPathCache()` wholesale-clear export. Uncached function left intact for incremental adoption. Cache stores positive lookups only. `collectionWatcher` calls `invalidateCanonicalPathCache()` on `collection.modify` / `collection.delete` events. | `a625c88` | extends `canonicalPath.test.mjs` |
| **B5** | `smartRules.loadRules` precompiles every `matchesRegex` condition at load time via `_compileRegexOnCondition`, stamping `cond._compiled: RegExp`. `evaluateCondition` uses the precompiled regex. ReDoS caps (8 KB input, 512-char pattern) still applied — now at load time, so bad rules fail fast. | `d4d8444` | extends `smartRules.test.mjs` |
| **B6** | `metadataRetriever` parallel `_queuedIDs: Set<itemID>` kept in sync with `_queue`. `queueItem` consults it O(1); `_processQueue` removes from both on drain. Queue ordering unchanged. | `9519e32` | new `test/unit/metadataRetriever.test.mjs` |

### Work Package C — mirror executor, baseline, notifier batching

Merge commit: `57cd24c`.

| # | What | Commit | Verification |
|---|---|---|---|
| **C1** | `mirrorExecutor._moveFolder` runs the per-child rewrite passes via `_runWithConcurrency(items, cap, worker)` semaphore (cap 8) instead of a sequential `for await`. Per-child `attachment:<key>` lock + live-record re-read inside the lock are preserved — the semaphore only caps OUTER parallelism. Pass 1 and Pass 2 both use the helper. | `9e23908` | UT-421 in `mirrorExecutor.test.mjs` |
| **C2** | `canSafelyMove` calls `_hashFileCached(absPath)` (from `_hashCache.mjs`) instead of `getFileHash` directly. Runtime safety net: fall through to direct `getFileHash` if the cache returns null or throws. Hash-drift detection unchanged. | `34438aa` + integration | UT-422 in `mirrorExecutor.test.mjs` |
| **C3** | `baseline._buildDiskHashIndex` returns `{bySize: Map<size, [absPath]>, claimed, lookupForAttachment}` — single disk walk + stat, no upfront hashing. `lookupForAttachment(attachment)` consults `attachment.attachmentFileSize` and hashes ONLY size-matched candidates. When `attachmentFileSize` is null/undefined, falls back to hashing all buckets (legacy behaviour, no regression). | `730cd75` | UT-912 / UT-913 in `baseline.test.mjs` |
| **C4** | Notifier debounce + per-collection coalescing. `collectionWatcher.mjs` collects events for `DEBOUNCE_MS = 100` ms in `_pendingBuffer`, drains as one batch into the existing `_notifyChain`. `itemMembershipHandler.handleCollectionItemEvent` accepts batched composite IDs grouped by collection, resolves the canonical path once per collection, iterates items within each group. `itemAddHandler` follows the same debounce pattern for `['item']` events. `__test_setDebounceMs(0)` seam in all three modules for fast tests. RecognizePDF reparenting guard in `_handleRemove` preserved (UT-513 covers it under batching). | `e72e92b` + `6239c72` + `2ca4bfd` | extended tests in all three notifier files |

### Integration commit

Commit: `50c2af9`.

- `mirrorExecutor.mjs` + `baseline.mjs` — replaced WP-C's
  dynamic-import fallback with a plain static
  `import { hashFile as _hashFileCached } from './_hashCache.mjs'`.
  Dropped `_getHashCache` / `_resetHashCacheRef` / `_hashCacheResolved`
  helpers. The runtime fall-through to direct `getFileHash` stays as
  a safety net.
- `_hashCache.mjs::hashFile(absPath, statHint?)` — added optional
  `statHint` parameter so `baseline._hashViaCache` can pass through
  its existing `IOUtils.stat` instead of re-statting. Backward-
  compatible.
- `collectionWatcher.mjs` — static import of
  `invalidateCanonicalPathCache` from `canonicalPath.mjs`. Dropped
  the dynamic-import helper.
- `content/index.mjs onShutdown` — `await getTrackingStore().flush()`
  call after services stop. Closes B3's deferred TODO so a plugin
  unload during the 50 ms debounce window cannot lose a write.
- `content/_hashCache.mjs.stub-note` — deleted.
- `baseline.test.mjs beforeEach` — `hashCache.clear()` (the cache is
  now a real singleton, not a per-test mock, so it needs clearing
  between cases — a prior test's `(path, size, mtime) → hash` entry
  would shadow a later test's mocked `getFileHash` return).
- `mirrorExecutor.test.mjs UT-422` — dropped `_resetHashCacheRef`
  import; uses `hashCache.clear()` in `beforeEach` instead.

### Discovery during integration

WP-C's stub did `mod?.hashCache ?? null` expecting a default-style
export, but WP-A actually exports `hashFile` as a named export. In
isolation both packages passed their tests; in production the cache
would have been a silent no-op for `canSafelyMove` and B.7. The
integration commit aligned the import shape. **The fix existed
because the integration step was scheduled, not because either
agent caught the mismatch on its own.** Worth remembering when
designing the next parallel pass.

---

## Open items / follow-ups

These are NOT release-blocking for `v2.5.0`. Each is a small
follow-up commit when the time is right.

1. **B2 consumer adoption in `mirrorExecutor._moveFolder`.** Line
   ~397: `// TODO(perf-C1): switch to getAllByAttachmentKey once
   perf/wp-b lands.` The method now exists on `main`; the swap is
   ~5 LOC. C deliberately deferred it to keep the slice merge-clean.

2. **`hooks.shutdown` ordering vs trackingStore.flush().** Currently
   flush() runs AFTER all services stop. If a service's `stop()`
   schedules a debounced write that lands after we already
   resolved, the flush won't catch it. Acceptable today because
   services are synchronous in their final state writes, but worth
   a hardening pass if a real lost-write is observed.

3. **Live MCP verification on Zotero 9.0.4** — `test/mcp/SMOKE.md`
   S.1–S.7 plus `MODE3.md` bulk-move + bulk-trash scenarios. Unit
   tests are green; this is the next gate before tagging `v2.5.0`.

4. **Manual perf measurement** — drop a 1,000-PDF dataset into the
   watch folder, time scan cycle 5 (steady state) before vs after.
   Plan predicted ≥10× reduction in `getFileHash` invocations. The
   hash cache exposes `stats()` returning `{hits, misses, size}` —
   tail logs over a real session and report the hit rate.

---

## Suggested release shape

When the open items above clear, ship as **`v2.5.0`**:

1. Bump `manifest.json` + `package.json`: `2.4.1` → `2.5.0`.
2. Refresh `CLAUDE.md`:
   - Hash strategy entry: note `_hashCache.mjs` LRU and the new
     `(path, size, mtime)` keying.
   - TrackingStore entry: note `getAllByAttachmentKey`, the
     debounced save, and tombstone indexes.
   - Notifier serialization entry: note the upstream `DEBOUNCE_MS`
     window + `__test_setDebounceMs` seam.
   - Add a "Singleton hash cache" entry under "Don't touch without
     understanding" — the cache survives across tests and needs
     `clear()` in `beforeEach` where mocks of `getFileHash` would
     otherwise be shadowed.
3. Refresh `index.html`, `test-plan.html`, `test-cases.html` per
   CLAUDE.md "Keep ... in sync": version badge, test count, "Last
   updated" date.
4. `npm run bundle && npm run build`. Verify
   `dist/content/scripts/watchFolder.js` regenerates cleanly.
5. Tag `v2.5.0`, push, `npm run release`. Attach `update.json` to
   `main` per existing release pattern.

Release-notes outline (no behaviour changes; pure perf):

> **v2.5.0 — performance pass.** Module-level hash cache; single-stat
> scanner walks; deferred title-cache prewarm; batched Zotero.Items
> lookups; tombstone + shadow indexes; debounced tracking-store save;
> memoized canonical-path lookup; precompiled smart-rule regexes;
> Set-based metadata-retriever dedup; parallel `_moveFolder` child
> rewrites with concurrency cap; `canSafelyMove` cache use; baseline
> B.7 size-bucketed disk index; notifier debounce + per-collection
> coalescing. Tests: 569 → 2466 passing.

---

## Things ruled out (unchanged from the pre-pass plan)

- **Replace polling with OS file events** (inotify / FSEvents /
  RDCW). Platform-specific surface that IOUtils doesn't expose.
- **`scanFolderRecursive` mtime short-circuit.** Higher payoff than
  A1 on >50k-file libraries but risks "miss new files" on network
  shares with lying dir-mtime (NFSv3, some SMB). Defer to v2.6.0
  behind an opt-out pref.
- **Split `watchFolder.mjs` (~2,200 lines).** Pure code quality;
  no runtime change. Defer to a quiet release.
- **Bundle-size / dead-code sweep.** Sub-KB savings; skip unless a
  user reports slow load.
- **Lazy-load tracking store by hash bucket.** Profile first.
- **`Zotero.debug` gating.** Negligible vs I/O.

---

## Lessons for the next parallel pass

1. **Stub APIs need a contract test that runs against ALL slices'
   exports together** — WP-C's `mod?.hashCache` vs WP-A's
   `hashFile` named export would have been caught earlier by a
   single "does the import resolve" test that runs in the merged
   tree, not per slice.
2. **A real module-level singleton in production code requires a
   `beforeEach` clear in every test file that exercises it
   transitively** — not just the file that imports it directly.
   The baseline.test.mjs failures were stale-cache hits, not logic
   bugs.
3. **The file-ownership partition held cleanly** — zero merge
   conflicts across 16 commits on 14 files. Plan to keep this
   discipline in future passes.
4. **`--no-ff` merge commits** make the per-package boundary
   inspectable forever (`git log main~5..main --first-parent` shows
   one merge per WP). Worth the extra commit.

End of document.
