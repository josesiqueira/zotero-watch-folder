# Module Dependencies

Captures the dependency relationships between plugin features and code modules: the critical path through the feature set, the runtime module graph, and per-feature risk levels with mitigations.

---

## Critical Path

The **critical path** (longest sequential dependency chain) is:

```
Infrastructure → F1.1 → F1.2 → F1.3 → F1.4 → F2.1 → F2.2 → F2.3 → F2.4
```

This is the minimum sequential work required for full functionality.

### Sequential dependencies (cannot be parallelized)

| Task A | Task B | Why Sequential? |
|--------|--------|-----------------|
| F1.1 Config | F1.2 Import | Import needs config to know what/where |
| F1.2 Import | F1.3 Metadata | Metadata needs imported items |
| F1.3 Metadata | F1.4 Rename | Rename needs metadata for filename |
| F2.1-F2.3 | F2.4 Conflict | Conflict resolution needs sync operations |
| Infrastructure | All features | Features need bootstrap/prefs |

---

## Module Dependency Graph (Code Level)

```
bootstrap.js
    │
    ├──► watchFolder.mjs ◄─────────────────────┐
    │        │                                  │
    │        ├──► fileScanner.mjs              │
    │        ├──► fileImporter.mjs ◄───────────┼──► duplicateDetector.mjs
    │        ├──► metadataRetriever.mjs        │
    │        ├──► fileRenamer.mjs              │
    │        ├──► trackingStore.mjs            │
    │        └──► smartRules.mjs ◄─────────────┘
    │
    ├──► collectionSync.mjs (Phase 2)
    │        │
    │        ├──► syncState.mjs
    │        ├──► collectionWatcher.mjs
    │        ├──► folderWatcher.mjs
    │        ├──► pathMapper.mjs
    │        └──► conflictResolver.mjs
    │
    └──► bulkOperations.mjs (Phase 3)
             │
             ├──► watchFolder.mjs (uses fileRenamer)
             └──► collectionSync.mjs (uses for reorganize)
```

### Infrastructure components

| Component | Depends On | Blocks |
|-----------|------------|--------|
| manifest.json | Nothing | All features |
| bootstrap.js | manifest.json | All features |
| prefs.js | Nothing | preferences.xhtml |
| Fluent (.ftl) | Nothing | UI strings |
| preferences.xhtml | prefs.js, Fluent | User configuration |
| preferences.js | preferences.xhtml | None |
| Build system | All source files | Release |

### Phase 1 feature dependencies

| Feature | Depends On | Blocks |
|---------|------------|--------|
| **F1.1** Watch Config | Infrastructure | F1.2, F1.3, F1.4, F1.5 |
| **F1.2** Auto-Import | F1.1 | F1.3, F1.5, F3.1, F3.2 |
| **F1.3** Auto-Metadata | F1.2 | F1.4 |
| **F1.4** Auto-Rename | F1.3 | Phase 2 (for linked files) |
| **F1.5** Existing Files | F1.2 | None |

### Phase 2 feature dependencies

| Feature | Depends On | Blocks |
|---------|------------|--------|
| **F2.1** Collection→Folder | Phase 1 complete, Linked Files mode | F2.2 |
| **F2.2** Item Movement | F2.1 | F2.3 |
| **F2.3** Folder→Collection | F2.2 | F2.4 |
| **F2.4** Conflict Resolution | F2.1, F2.2, F2.3 | None |

### Phase 3 feature dependencies

| Feature | Depends On | Blocks |
|---------|------------|--------|
| **F3.1** Smart Rules | F1.2 (import flow) | F3.3 (partially) |
| **F3.2** Duplicate Detection | F1.2 (pre-import check) | F3.3 (partially) |
| **F3.3** Bulk Operations | F1.3, F1.4, F3.1, F3.2 | None |

---

## Risk Assessment by Dependency

| Feature | Risk Level | Risk Reason | Mitigation |
|---------|------------|-------------|------------|
| F1.1 | Low | Simple config, well-understood | None needed |
| F1.2 | Medium | File system edge cases | Extensive testing |
| F1.3 | High | External API (metadata services) | Graceful degradation, retry logic |
| F1.4 | Low | String manipulation | Edge case testing |
| F1.5 | Medium | Batch processing, UI feedback | Progress indicators |
| F2.1-F2.4 | High | Bidirectional sync, conflicts | Conservative conflict handling |
| F3.1 | Medium | Rule engine complexity | Start simple, iterate |
| F3.2 | Medium | Fuzzy matching accuracy | Configurable thresholds |
| F3.3 | Low | Uses existing components | Integration testing |

### Why the high-risk items are high-risk

- **F1.3 (Auto-Metadata)** — Depends on Zotero's recognition service plus external DOI/CrossRef resolvers. Network failure, rate limits, or unrecognizable PDFs are normal cases that must degrade gracefully (tag with `_needs-review` rather than failing the whole import).
- **F2.1-F2.4 (Collection/Folder sync)** — The hardest features in the plugin. Bidirectional sync with two independent change sources (Zotero notifier events and filesystem polling) introduces races, feedback loops, and edge cases (rename + move in same tick, multi-collection items, case-insensitive filesystems). Mitigation: pause one side while applying changes from the other, persist a full sync-state snapshot, conservative conflict tagging instead of silent overwrites.
