# Phase 3 Design and Performance

Phase 3 features (Smart Rules, Duplicate Detection, Bulk Operations) plus the cross-cutting performance strategy.

---

## F3.1 — Smart Rules Engine

User-defined automation rules that run during the import flow to categorize, tag, or skip items based on metadata. Implemented in `content/smartRules.mjs`.

### Rule shape

```javascript
{
  id: '1706234567890',
  name: 'RE Papers',
  enabled: true,
  priority: 10,
  conditions: [
    { field: 'title', operator: 'contains', value: 'requirements', caseSensitive: false }
  ],
  actions: [
    { type: 'addToCollection', value: 'Topics/RE' },
    { type: 'addTag', value: 'requirements-engineering' }
  ],
  stopOnMatch: false
}
```

### Fields

`title`, `firstCreator`, `creators`, `year`, `publicationTitle`, `DOI`, `doiPrefix`, `abstractNote`, `itemType`, `tags`, `filename` (see `smartRules.mjs:16 CONDITION_FIELDS`).

### Operators

`contains`, `notContains`, `equals`, `notEquals`, `startsWith`, `endsWith`, `matchesRegex`, `greaterThan`, `lessThan`, `isEmpty`, `isNotEmpty` (`smartRules.mjs:34`).

### Actions

`addToCollection` (supports nested paths like `Topics/RE/Surveys` via `utils.getOrCreateCollectionPath`), `addTag`, `setField`, `skipImport` (`smartRules.mjs:52`).

### Evaluation

Rules are sorted by priority (descending) at load time (`smartRules.mjs:108`). Conditions within a rule are AND-ed. On match, the rule's actions are applied. If `stopOnMatch` is true, evaluation halts; otherwise lower-priority rules continue, so an item can pick up multiple tags and collection memberships from successive matches.

Rules are persisted as JSON in the `smartRules` preference.

---

## F3.2 — Duplicate Detection

Pre-import / post-import check against the existing library. Implemented in `content/duplicateDetector.mjs`. Action on duplicate (`skip` / `import`) is configurable via the `duplicateAction` preference.

### Methods (in cost order)

| Method | Confidence | Cost |
|--------|------------|------|
| DOI match | 100% | low (indexed) |
| ISBN match | 100% | low (indexed) |
| Title fuzzy match | configurable (Levenshtein, default 0.85) | medium |
| Content hash (SHA-256 first 1 MB) | 100% on identical bytes | high (file read) |

First positive result short-circuits. `checkForDuplicate(metadata, filePath)` is callable both pre-import (file hash only — metadata not yet known) and post-import (full metadata-based detection).

Similarity:
```javascript
calculateSimilarity(str1, str2) {
  const distance = this.levenshteinDistance(str1, str2);
  return 1 - distance / Math.max(str1.length, str2.length);
}
```

`watchFolder.mjs:_processNewFile` calls `checkForDuplicate({}, filePath)` before import when `duplicateCheck` pref is enabled.

---

## F3.3 — Bulk Operations

Mass operations over existing library items. Implemented in `content/bulkOperations.mjs`. All operations support a `dryRun` mode and report progress through an `onProgress({ current, total, currentItem, status })` callback.

| Operation | Function | What it does |
|-----------|----------|--------------|
| Reorganize all | `reorganizeAll(options)` | Iterate items with attachments, re-apply naming pattern; if Phase 2 is enabled, also re-place into collection folder |
| Retry failed metadata | `retryAllMetadata(options)` | Iterate items tagged `_needs-review`, re-run `Zotero.RecognizeDocument`; tag removed on success |
| Apply rules to existing | `applyRulesToAll(options)` | Run the Smart Rules engine over all existing items so a new rule retroactively categorizes the back catalog |

Other helpers: `isBulkOperationRunning()`, `cancelBulkOperation()`. Batches default to 10 items with a 100 ms inter-batch delay to keep the UI responsive.

---

## Performance Optimization

### Adaptive polling

Polling interval scales with activity. After repeated empty scans the interval grows; on any non-empty scan it resets to the base. See `watchFolder.mjs:_scan` for the live implementation, which uses a 1.2x growth factor after 10 empty scans and caps at 2x the base interval. The simpler reference shape:

```javascript
reportScanResult(filesFound) {
  if (filesFound > 0) {
    this.currentInterval = this.baseInterval;
    this.consecutiveEmptyScans = 0;
  } else if (++this.consecutiveEmptyScans > 10) {
    this.currentInterval = Math.min(
      this.currentInterval * 1.5,
      this.maxInterval
    );
  }
}
```

### LRU import history (`content/trackingStore.mjs`)

Tracking is bounded with a fixed-size LRU (default 5000 entries). On insert past capacity, oldest entry is evicted:

```javascript
set(key, value) {
  if (this.cache.has(key)) this.cache.delete(key);
  if (this.cache.size >= this.maxSize) {
    const oldest = this.cache.keys().next().value;
    this.cache.delete(oldest);
  }
  this.cache.set(key, value);
}
```

For libraries past ~10000 files a Bloom filter is an alternative; LRU is the default because it has no false positives (a Bloom filter would silently skip a legitimate re-import).

### Other levers

- **No `setInterval`** — chain via `setTimeout` so a slow scan can never overlap the next.
- **Cheap diffing** — already-tracked paths short-circuit; stability check + hash only runs on new paths.
- **Concurrency cap** — `metadataRetriever` caps concurrent lookups and spaces requests to avoid hammering Zotero's recognition service and external DOI resolvers.
- **Lazy init** — `collectionSync` and `duplicateDetector` are initialized on first use; idempotent shutdown handlers.
- **Disable releases resources** — `WatchFolderService.destroy()` clears timers, unregisters the notifier, saves and drops the tracking store, clears window refs.

### Targets

| Metric | Target |
|--------|--------|
| Idle CPU | < 0.1% |
| RAM (idle) | < 5 MB |
| RAM (scanning 1000 files) | < 15 MB |
| File detection | ≤ poll interval + 2s |
| Single import + metadata | < 30s |
| Bulk import (50 files) | < 10 min |
