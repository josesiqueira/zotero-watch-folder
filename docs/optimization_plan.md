# Optimization Plan

**Drafted:** 2026-05-27, after v2.4.1 ship.
**Status of repo at draft time:** v2.4.1 (stable, on Latest); 569 unit
tests passing across 20 files, zero skipped; Zotero 7 / 8 / 9 verified
on Zotero 9.0.4. No release-blocking work outstanding.

This document captures performance / code-quality opportunities a
session can pick up without re-deriving them. Items are ranked by
user-visible impact × bounded effort, **not** by what's interesting.

---

## Recommended first batch — ship together

**Theme:** "stop re-reading file bytes we already know about."

These two items share infrastructure (file content-hash) and have the
same risk profile. Bundle them into a single commit + release:
`v2.5.0` (minor — they're optimizations, no behavior change).

---

### 1. Hash caching by `(path, size, mtime)` during scan cycles

**Highest leverage. Recommended for first batch.**

#### Motivation

`watchFolder.mjs::_handleExternalDeletions` runs move detection on
every scan cycle (default every 5 seconds). When at least one tracked
file is missing AND there are untracked files on disk, it hashes
every untracked candidate via `getFileHash(candidate)` to find a
hash match. `getFileHash` reads the **entire file** (full-file
SHA-256 since v2.1; see `utils.mjs::HASH_VERSION = 2`).

For a user with a stable 5,000-file folder and 5-second polling, a
single missing file triggers re-hashing of every other untracked file
on every cycle. Potentially gigabytes of disk reads per minute for
zero useful work.

#### Current code

```
content/watchFolder.mjs ~1985-2018 (the `_handleExternalDeletions` move
                                    detection loop):

  const hashCache = new Map();              // ← already exists, but
  const hashOf = async (p) => {             //   scoped to one call,
    if (!hashCache.has(p)) {                //   so it's only useful
      hashCache.set(p, await getFileHash(p));
    }                                       //   if MULTIPLE missing
    return hashCache.get(p);                //   records search the
  };                                        //   same candidate.
```

The existing `hashCache` is per-invocation, scoped to one missing-list.
It doesn't survive between scan cycles, so a re-scan with the same
disk contents re-hashes everything.

#### Proposed change

Promote the cache to a module-level (or service-level)
`Map<cacheKey, {hash, computedAt}>` keyed by
`` `${absPath}|${size}|${mtime}` ``. Invalidation is implicit: a file
with the same `(size, mtime)` triple is the same file content (any
edit advances mtime). Cap the cache size (suggested 5,000 entries,
LRU-evict) so a pathological run doesn't grow unbounded.

Wire in two places:
1. **`_handleExternalDeletions` move detection** — replace the
   per-invocation `hashCache` with the module cache.
2. **`baseline.runBaseline` B.7 reconcile** — same pattern; the
   baseline walks disk files and hashes each.

#### Scope

- Add `_hashCache.mjs` (or extend `utils.mjs`) with a small LRU.
- Replace 2 call sites.
- Test: dedicated unit test for the cache (hit / miss / size-eviction),
  plus extend `watchFolder.test.mjs` move-detection tests to assert
  the cache is consulted.

Probably **~80 lines of code + ~5 tests**.

#### Success measure

- Drop a 1,000-PDF dataset into the watch folder.
- Time `_scan` cycle 5 (steady state) before vs after.
- Expected: roughly 1 hash read per actually-changed file post-fix
  vs N candidates per cycle pre-fix. Order-of-magnitude reduction in
  disk I/O on the steady-state path.

#### Risks

- **Stale cache after external file edit.** mtime advances on edit, so
  the key changes — the cache entry won't be matched. Safe.
- **Cache key collision across reboots.** Cache is in-memory, cleared
  on plugin reload. No persistence.
- **Files with identical (path, size, mtime) but different content.**
  Theoretically possible if a tool preserves mtime when overwriting
  (e.g. `rsync -t`). Mitigation: existing `lastSyncedHash` on tracked
  records is the source of truth for tracked files; the cache only
  speeds up the candidate-discovery path, not the tracked-state
  invariant.

---

### 2. Size pre-filter on baseline B.7 reconcile

**Recommended for first batch (alongside #1).**

#### Motivation

`baseline.runBaseline` B.7 finds Zotero attachments whose file exists
on disk at a non-canonical path and links them in place (instead of
double-copying). It currently iterates Zotero attachments and, for
each, hashes candidate files to find a match.

For a 10,000-attachment library on first install, this is potentially
10,000 × N hash reads — and most candidates are obviously wrong by
size. Comparing sizes first cuts the hash-read count dramatically.

#### Current code

```
content/baseline.mjs (the B.7 reconcile branch — re-read for exact
                       line refs at implementation time).
```

The exact line refs are likely to shift between sessions; the change
target is "the inner loop where each candidate disk file is hashed
against the Zotero attachment's hash". Look for `getFileHash` calls
inside `runBaseline`.

#### Proposed change

Before computing a disk file's hash, compare:

```js
const stat = await IOUtils.stat(candidatePath);
if (stat.size !== attachment.attachmentFileSize) continue;
```

Zotero exposes attachment size via `item.attachmentFileSize` (sync
property on imported-file attachments).  When sizes don't match,
they're guaranteed not to be the same file — skip the hash entirely.

#### Scope

- One conditional in `baseline.mjs`.
- One unit test asserting that mis-sized candidates aren't hashed
  (spy on `getFileHash`, count calls).

Probably **~15 lines + 1 test**.

#### Success measure

- 10,000-item library first-install baseline: time before vs after.
- Expected: 50–100× reduction in hash reads on typical libraries
  (where size collisions are rare).

#### Risks

- **Attachment without an indexed size.** `attachmentFileSize` is
  populated lazily — for items never opened, it may be null. Fallback:
  if attachment size is unknown, fall through to the existing hash
  comparison (no regression).
- **Sparse-file edge case.** Cloud-sync placeholders may report
  size = 0 or = full-extent. The existing file-stability check in
  the scan loop already filters 0-byte files; B.7 may need the same
  filter for placeholders. Verify during implementation.

---

## Lower-priority items (consider for v2.5.x patches)

### 3. Replace `getAllOfType('file')` inside hot paths

**Code quality + small perf win.**

Several handlers do `store.getAllOfType('file').filter(r => ...)`:

- `watchFolder.mjs::_handleZoteroTrash` — for shadow record discovery.
- `watchFolder.mjs::_handleExternalDeletions` — for shadow guard.
- `mirrorExecutor.mjs::_moveFolder` — for child-record path rewrites.

Each is O(n) per call. The tracking store already maintains
`_byAttachmentKey` and `_byHash` indexes; adding a
`_byCanonicalPath` index (or `_byCollection`) would let these
operations be O(log n) or O(1) with the right key.

**Effort:** ~100 lines + index rebuild test cases. Probably 30 minutes.
**Win:** Negligible on libraries < 10,000 files; meaningful on
100k+. Mostly a code-quality refactor — gets these O(n) scans off
the hot path before they become a problem.

### 4. `scanFolderRecursive` mtime short-circuit

**Higher payoff than (1) on very large folders. Higher risk.**

Linux/macOS dir-mtime updates when the directory's contents change.
The scanner could maintain a per-dir mtime snapshot and skip
unchanged subtrees on subsequent scans.

**Effort:** ~150 lines + careful tests covering the edge cases.
**Win:** Order of magnitude on libraries > 50k files.
**Risk:** Network filesystems sometimes lie about dir mtime (NFSv3,
some SMB shares). The fix is a soft optimization — wrong direction
on a lie would be "we miss new files until next full scan", which is
bad. **Don't ship this without an opt-out pref.**

### 5. Split `watchFolder.mjs` (~2,200 lines)

**Pure code quality, zero runtime change.**

Natural splits:
- `content/trashHandlers.mjs` — `_handleZoteroTrash` +
  `_handleZoteroRestore` + tombstone helpers (~600 lines).
- `content/scanLoop.mjs` — `_scan`, `_detectFolderRenames`,
  `_ensureCollectionsForExistingFolders` (~500 lines).
- `content/index.mjs::watchFolder` proper — service wiring +
  `_processNewFile` + the post-import path.

**Effort:** ~half a day with careful imports + tests.
**Win:** Navigability. Easier code review. No runtime change.
**Risk:** Merge-conflict pain if there are pending patches in flight.
**Recommendation:** Do this only when the file is otherwise quiet
(no active feature branches). Defer until a natural pause.

### 6. Bundle size / dead-code sweep

**Probably not worth the time.**

The esbuild IIFE bundle is 289 KB. Tree-shaking already kicks in.
A quick `rollup-plugin-visualizer` equivalent + checking for unused
exports would surface anything, but the realistic savings are
hundreds of bytes, not kilobytes. **Skip unless a user reports
slow load times.**

---

## Things considered but ruled out

- **Replace polling with OS file events** (inotify / FSEvents /
  ReadDirectoryChangesW). Tempting but adds platform-specific
  surface area to a Mozilla chrome environment. Zotero's IOUtils
  doesn't expose this. Would need native modules. Not worth the
  complexity for a desktop plugin.
- **Lazy-load tracking store by hash bucket.** Tracking store is
  fully in-memory. For users with 100k+ files this could matter,
  but profiling first would tell us — pre-optimization without
  data.
- **`Zotero.debug` gating via a pref.** Each debug call has
  function-call overhead even when debug output is off, but the cost
  is minuscule vs anything I/O-bound. Skip unless profiling shows
  it matters.
- **Parallelize `_handleExternalDeletions` candidate hashing via
  `Promise.all` with concurrency cap.** Tempting but interacts
  badly with the cache (#1) — once the cache is in place, parallel
  re-hashing is only useful on first scan, which is rare.

---

## Suggested release shape

Bundle items **1 + 2** into a single `v2.5.0` release:

- **Title:** "v2.5.0 — scan + baseline performance"
- **Bullets:** hash caching across scan cycles, size pre-filter on
  B.7 reconcile.
- **No behavior change.** Tests pass identically; the only difference
  is measurable I/O reduction on libraries > a few hundred files.
- **Live verification:** drop a large dataset (1,000+ PDFs), confirm
  scan cycle time drops by an order of magnitude after the first scan.

Cut **3** as a follow-up `v2.5.1` if the indexes prove useful.

Defer **4** and **5** to dedicated minor releases (`v2.6.0` for the
scanner short-circuit; `v2.7.0` or just a refactor commit on main for
the file split).

---

## Implementation order when picking up

1. **Read this file in full** before starting — context for the why.
2. **Read `CLAUDE.md`** "Don't touch without understanding" section —
   the hash strategy + per-key locks + notifier serialization are
   load-bearing invariants the optimizer must respect.
3. **Run `npm test`** — baseline at 569 passing.
4. **Item 2 first** (smaller scope, lower risk, validates the
   pattern). Land it as its own commit, verify tests, then move to
   item 1.
5. **Item 1** — add the cache, replace the call sites, add tests,
   verify perf on a real dataset.
6. **Combine into one release commit** with a clear before/after
   measurement in the commit body.
7. **Tag + push + GitHub release** per the existing release pattern
   (see `TODO.md::Release inventory`).
8. **Update CLAUDE.md** notes if the hash strategy section changes
   (it probably should — note that hashes are now cached by
   `(path, size, mtime)`).

---

## Where things live (quick refs for the next session)

- Scan loop entry: `content/watchFolder.mjs::_scan`.
- Move detection (cache target): `content/watchFolder.mjs::_handleExternalDeletions`,
  around the `const hashCache = new Map()` line.
- Baseline reconcile (size pre-filter target):
  `content/baseline.mjs::runBaseline` — the B.7 branch.
- Hash function: `content/utils.mjs::getFileHash`.
- Hash strategy + invariants: `CLAUDE.md` "Don't touch without
  understanding" → "Hash strategy is full-file SHA-256 (v2.1+)" entry.
- Tracking-store indexes (for item 3): `content/trackingStore.mjs::_rebuildIndexes`.

End of plan. Future session: read top-to-bottom, then start at
"Implementation order when picking up".
