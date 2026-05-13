# Module Dependencies

How the code modules wire together and where the risk lives. Use this when navigating the source.

---

## Runtime dependency graph

```
bootstrap.js
    │
    └──► content/index.mjs (hooks)
             │
             ├──► watchFolder.mjs ◄──────────────────┐
             │        │                               │
             │        ├──► fileScanner.mjs           │
             │        ├──► fileImporter.mjs ────────►│ duplicateDetector.mjs
             │        ├──► metadataRetriever.mjs    │
             │        ├──► fileRenamer.mjs          │
             │        ├──► trackingStore.mjs        │
             │        └──► smartRules.mjs ◄─────────┘
             │
             ├──► firstRunHandler.mjs
             │        ├──► fileScanner.mjs
             │        ├──► fileImporter.mjs
             │        └──► trackingStore.mjs
             │
             ├──► collectionSync.mjs (Phase 2 — lazy)
             │        ├──► syncState.mjs
             │        ├──► collectionWatcher.mjs
             │        ├──► folderWatcher.mjs
             │        ├──► pathMapper.mjs
             │        └──► conflictResolver.mjs
             │
             └──► bulkOperations.mjs (Phase 3)
                      ├──► fileRenamer.mjs
                      └──► metadataRetriever.mjs

All modules ──► utils.mjs (getPref, setPref, delay, getFileHash,
                           sanitizeFilename, getOrCreateCollectionPath)
```

`utils.mjs:getOrCreateCollectionPath` is what lets the recursive folder scan in `watchFolder.mjs._scan` build nested collection paths like `Inbox/Topics/RE` from a relative subfolder path.

## Infrastructure

| Component | Depends On | Blocks |
|-----------|------------|--------|
| manifest.json | nothing | all features |
| bootstrap.js | manifest.json | all features |
| prefs.js | nothing | preferences UI |
| Fluent (.ftl) | nothing | UI strings |
| preferences.xhtml / .js | prefs.js, Fluent | user configuration |

## Phase 1 — core watcher

| Feature | Module(s) | Depends on |
|---------|-----------|------------|
| Watch config | `preferences.{xhtml,js}` | infrastructure |
| Folder polling | `watchFolder.mjs`, `fileScanner.mjs` | config |
| Import | `fileImporter.mjs` | folder polling |
| Metadata | `metadataRetriever.mjs` | import |
| Rename | `fileRenamer.mjs` | metadata |
| Tracking | `trackingStore.mjs` | import |
| First run | `firstRunHandler.mjs` | config, scanner, importer |
| Recursive subfolder → collection | `watchFolder.mjs._scan` + `utils.mjs:getOrCreateCollectionPath` | import |

## Phase 2 — collection ↔ folder sync (linked files only)

| Feature | Module |
|---------|--------|
| Coordinator | `collectionSync.mjs` |
| Zotero side watcher | `collectionWatcher.mjs` |
| Disk side watcher | `folderWatcher.mjs` |
| Path translation | `pathMapper.mjs` |
| Conflict strategies | `conflictResolver.mjs` |
| Persisted state | `syncState.mjs` |

Phase 2 only operates on items whose attachment is `LINK_MODE_LINKED_FILE`. Stored-copy attachments are skipped because Zotero owns those paths.

## Phase 3 — advanced

| Feature | Module | Depends on |
|---------|--------|------------|
| Smart rules | `smartRules.mjs` | Phase 1 import flow |
| Duplicate detection | `duplicateDetector.mjs` | Phase 1 import flow |
| Bulk operations | `bulkOperations.mjs` | metadata, rename; optional Phase 2 for reorganize |

---

## Risk assessment

| Module / area | Risk | Why | Mitigation |
|---------------|------|-----|------------|
| `fileImporter.mjs` | Medium | Filesystem edge cases (cloud sync delays, permissions, locks) | Stability check, retry on next scan |
| `metadataRetriever.mjs` | High | External services (Zotero recognition, DOI/CrossRef); failures are normal | Tag `_needs-review`, throttle, queue |
| `fileRenamer.mjs` | Low | Pure string + filesystem; bounded by `sanitizeFilename` | Edge-case tests for long names, illegal chars |
| `collectionSync.mjs` + watchers | High | Bidirectional sync with two independent change sources; races, feedback loops | `_isSyncing` reentrancy guard, pause-other-side pattern, persisted state, conservative tagging |
| `pathMapper.mjs` | Medium | Cross-platform name sanitization, case-insensitive filesystems | Sanitize at boundary, cache resolutions |
| `smartRules.mjs` | Medium | User-defined regex and condition combinatorics | Validate on load, sort by priority, AND within rule |
| `duplicateDetector.mjs` | Medium | Fuzzy title threshold tuning | Try indexed methods (DOI/ISBN) first, configurable threshold |
| `bulkOperations.mjs` | Low | Composes existing modules | Batch + progress callback, dry-run mode |

The two high-risk areas to be careful around:

- **Metadata retrieval** — graceful degradation matters more than success rate. Network/rate limits and unrecognizable PDFs are normal cases. Surface them via the `_needs-review` tag, never block the import.
- **Phase 2 sync** — two independent change sources (Zotero notifier and filesystem polling) makes feedback loops the default failure mode. The codebase prevents them via `_isSyncing` / `_pendingCollections` / `_pendingItems` guards in `collectionSync.mjs`; do not remove those guards when refactoring.
