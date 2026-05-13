# Phase 3 Design and Performance

Design reference for Phase 3 advanced features (Smart Rules, Duplicate Detection, Bulk Operations) and the cross-cutting performance optimization strategy (adaptive polling, LRU cache, benchmark targets).

---

## F3.1 — Smart Rules Engine

User-defined automation rules that fire during the import flow to categorize, tag, or skip items based on their metadata.

**Dependencies:** F1.2 Auto-Import (hooks into import flow). Can be developed in parallel with F3.2.

### Rule Structure

```javascript
const rule = {
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
};
```

### Available Condition Fields
- `title`, `firstCreator`, `creators`, `year`
- `publicationTitle`, `DOI`, `doiPrefix`
- `abstractNote`, `itemType`, `tags`, `filename`

### Available Operators
- `contains`, `notContains`, `equals`, `notEquals`
- `startsWith`, `endsWith`, `matchesRegex`
- `greaterThan`, `lessThan`, `isEmpty`, `isNotEmpty`

### Available Actions
- `addToCollection` (supports nested paths: "Topics/RE/Surveys")
- `addTag`
- `setField`
- `skipImport`

### Evaluation Semantics

Rules are evaluated in priority order. All conditions within a rule are AND-ed (every condition must match). When a rule matches, its actions are appended to the queue. If `stopOnMatch` is true, evaluation halts; otherwise lower-priority rules continue to run, so a single item can pick up multiple tags and collection memberships.

**Acceptance:**
- [ ] Rules can be created/edited/removed
- [ ] Rules execute on import
- [ ] Nested collection paths work

---

## F3.2 — Duplicate Detection

Pre-import check that flags items already in the library, allowing skip/import/ask behavior to be configured.

**Dependencies:** F1.2 Auto-Import (pre-import check). Can be developed in parallel with F3.1.

### Detection Methods

| Method | Confidence | Cost |
|--------|------------|------|
| DOI match | 100% | Low (indexed) |
| ISBN match | 100% | Low (indexed) |
| Title fuzzy match | Configurable (85% default) | Medium (cache) |
| Content hash | 100% | High (file read) |

### Evaluation Order

Methods are tried in increasing cost order; the first positive result short-circuits the rest:

1. **DOI** — exact match against indexed `DOI` field; near-zero cost, perfect confidence.
2. **ISBN** — same, for books.
3. **Title fuzzy match** — Levenshtein-based similarity against an in-memory title cache. Returns a confidence score between 0 and 1; user-configurable threshold (default 0.85).
4. **Content hash** — MD5 of the file. Catches re-downloads of the same PDF under different filenames, but requires reading the file, so only run if enabled in prefs.

Similarity calculation:
```javascript
calculateSimilarity(str1, str2) {
  const distance = this.levenshteinDistance(str1, str2);
  return 1 - distance / Math.max(str1.length, str2.length);
}
```

**Acceptance:**
- [ ] DOI matching works
- [ ] Title fuzzy matching works
- [ ] Configurable actions (skip/import/ask)

---

## F3.3 — Bulk Operations

Mass operations applied to existing library items.

**Dependencies:** F1.3 (metadata), F1.4 (rename), F3.1 (rules), F3.2 (duplicates). Phase 2 optional, used for the reorganize path when collection sync is enabled.

### Operations

1. **Reorganize All Items** — Iterate every item with an attachment and re-apply the current naming pattern and (if Phase 2 is on) collection folder placement. Supports `dryRun` mode so users can preview the changes before committing.
2. **Retry Failed Metadata** — Iterate items tagged `_needs-review` and re-trigger `Zotero.RecognizeDocument`. Successful retrievals remove the tag automatically.
3. **Apply Rules to Existing** — Run the Smart Rules engine over existing library items (not just newly imported ones), so a newly added rule retroactively categorizes the back catalog.

All bulk operations report incremental progress via an `onProgress({ current, total })` callback so the UI can drive a progress bar.

**Acceptance:**
- [ ] Reorganize respects naming pattern
- [ ] Retry metadata works
- [ ] Progress indicator updates

---

## Performance Optimization

### Adaptive Polling

Polling interval scales with activity. After repeated empty scans, the interval grows by 1.5x up to a maximum (default 120s). On any non-empty scan, the interval resets to the base value (5s). This gives near-instant detection during active work and near-zero cost during idle periods.

```javascript
export class AdaptivePoller {
  constructor() {
    this.baseInterval = 5000;
    this.maxInterval = 120000;
    this.currentInterval = this.baseInterval;
    this.consecutiveEmptyScans = 0;
  }

  reportScanResult(filesFound) {
    if (filesFound > 0) {
      this.currentInterval = this.baseInterval;
      this.consecutiveEmptyScans = 0;
    } else {
      this.consecutiveEmptyScans++;
      if (this.consecutiveEmptyScans > 10) {
        this.currentInterval = Math.min(
          this.currentInterval * 1.5,
          this.maxInterval
        );
      }
    }
  }
}
```

Additional adaptive policies inherited from the architecture spec:
- When Zotero window is focused, poll faster; when minimized/unfocused, slow down.
- If the system is on battery power, reduce poll frequency further.
- After a wake from sleep, do one immediate scan then resume normal schedule.

### LRU Cache for Import History

Imported-file tracking is bounded with a fixed-size LRU cache (default 5000 entries). On insert, oldest entries are evicted. This caps RAM regardless of library size.

```javascript
export class LRUCache {
  constructor(maxSize = 5000) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  set(key, value) {
    if (this.cache.has(key)) this.cache.delete(key);
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
    this.cache.set(key, value);
  }
}
```

For libraries past ~10000 files, a Bloom filter is an alternative if the false-positive risk is acceptable (a re-import attempt would be skipped silently). The LRU approach is the default because it has no false positives.

### Other Optimization Levers

- **No `setInterval`** — use `setTimeout` to chain scans so a slow scan can never overlap with the next.
- **Cheap diffing** — one `stat()` on the directory; only walk children if `mtime` or count changed.
- **Concurrency cap** — max 2 concurrent metadata lookups with 1-2s spacing to avoid hammering Zotero's recognition service and external DOI resolvers.
- **Debounced bulk drops** — when many files appear in one scan, process sequentially with a small delay, not all in parallel.
- **Lazy init** — allocate nothing until the user enables the feature; on disable, release every timer, observer, and cache.

### Performance Targets

| Metric | Target |
|--------|--------|
| Idle CPU | < 0.1% |
| RAM (idle) | < 5 MB |
| RAM (scanning 1000 files) | < 15 MB |
| File detection | ≤ poll interval + 2s |
| Single import + metadata | < 30s |
| Bulk import (50 files) | < 10 min |
