// Zotero Watch Folder - Default Preferences
// These preferences are registered when the plugin loads.
//
// IMPORTANT: prefs.js at the XPI root is NOT auto-loaded by Zotero. The
// canonical source of defaults at runtime is `_initDefaultPrefs()` in
// `bootstrap.js`. This file exists for tooling/documentation parity only;
// every entry here MUST have a matching `_set(...)` line in bootstrap.js.

// Core watch settings
pref("extensions.zotero.watchFolder.enabled", false);
pref("extensions.zotero.watchFolder.sourcePath", "");
pref("extensions.zotero.watchFolder.pollInterval", 5);
pref("extensions.zotero.watchFolder.fileTypes", "pdf");
pref("extensions.zotero.watchFolder.importMode", "stored");  // legacy: "stored" or "linked" — superseded by pdfStorageStrategy
pref("extensions.zotero.watchFolder.pdfStorageStrategy", "stored");  // "stored" | "linked_watch_folder" | "stored_plus_mirror"
pref("extensions.zotero.watchFolder.postImportAction", "leave");  // "leave", "delete", "move"
pref("extensions.zotero.watchFolder.autoRetrieveMetadata", true);  // Auto-fetch PDF metadata
pref("extensions.zotero.watchFolder.diskDeleteOnTrash", "ask");  // "ask" | "plugin_trash" | "os_trash" | "permanent" | "never" — when an item is trashed in Zotero, what to do with the source file. plugin_trash moves to .zotero-watch-trash/ under the watch root (recoverable + scanner-skipped, v2.2 default if user picks it from the dialog). No-op in Mode 1; consumed by v2.1/v2.2. NOTE (v2.6.3): "permanent" is honored only for a single batch when chosen from the trash prompt — it is NEVER persisted as the standing value (the prompt downgrades it to "plugin_trash" on persist), and the Mode-3 prefs-pane disposition picker deliberately omits it. A "permanent" value here can only arrive via about:config or an old build; the prefs pane shows a warn+revert row when it does.
pref("extensions.zotero.watchFolder.diskDeleteSync", "auto");  // "auto" | "never" — when a file is externally deleted from the watch folder, auto-move the matching Zotero item to the bin and show a popup ("auto") or do nothing ("never"). No-op in Mode 1; consumed by v2.1/v2.2.

// v2.0 sync model — sync root + mode
pref("extensions.zotero.watchFolder.scopeMode", "collection");  // 'collection' (single sync-root) | 'library' (whole-library mirror). Default flips to 'library' when the 2.7.0 whole-library feature is complete.
pref("extensions.zotero.watchFolder.syncRootCollectionKey", "");  // 8-char Zotero collection key. Empty = not yet configured (setup wizard required). Used only in scopeMode 'collection'.
pref("extensions.zotero.watchFolder.syncRootLibraryID", 1);  // Default = user library. Forward-compat for group libraries.
pref("extensions.zotero.watchFolder.mode", "mode1");  // "mode1" | "mode2" | "mode3". Only mode1 is functional in v2.0.
pref("extensions.zotero.watchFolder.setupCompleted", false);  // Gates whether the normal poll loop runs; setup wizard runs until true.
pref("extensions.zotero.watchFolder.localTrashFolderName", ".zotero-watch-trash");  // Reserved for v2.2; defined now so it can be referenced from scanner skip-list.
pref("extensions.zotero.watchFolder.baselineCompletedForRoot", "");  // v2.1 Phase C: sync-root key the install-time baseline has completed against. Empty = not yet run.
pref("extensions.zotero.watchFolder.watchRootTopLevelFingerprint", "");  // v2.7 SYNC-1: JSON {count, namesHash} of top-level dirs at last healthy scan. A >50% collapse vs this fingerprint pauses the folder-deletion pass (transient unmount / cloud-eviction guard). Empty = not yet bootstrapped.
pref("extensions.zotero.watchFolder.mode3LibraryDeleteAcknowledged", false);  // v2.7: set true after the one-time first-arm dialog warning that Mode-3 deletes at library scope have whole-library blast radius. Until then, the first propagated deletion under scopeMode 'library' prompts.

// File naming settings
pref("extensions.zotero.watchFolder.renamePattern", "{firstCreator} - {year} - {title}");
pref("extensions.zotero.watchFolder.maxFilenameLength", 150);
pref("extensions.zotero.watchFolder.autoRename", true);

// Duplicate detection (Phase 3)
pref("extensions.zotero.watchFolder.duplicateCheck", true);
pref("extensions.zotero.watchFolder.duplicateMatchDOI", true);
pref("extensions.zotero.watchFolder.duplicateMatchISBN", true);
pref("extensions.zotero.watchFolder.duplicateMatchTitle", true);
pref("extensions.zotero.watchFolder.duplicateTitleThreshold", 85);  // stored as int (0.85 * 100)
pref("extensions.zotero.watchFolder.duplicateMatchHash", true);  // Library-wide hash lookup: catches re-imports even when local tracking is wiped
pref("extensions.zotero.watchFolder.duplicateAction", "skip");  // "skip", "import", "ask"

// Smart rules (Phase 3)
pref("extensions.zotero.watchFolder.smartRulesEnabled", false);
pref("extensions.zotero.watchFolder.smartRules", "[]");

// Performance
pref("extensions.zotero.watchFolder.adaptivePolling", true);
pref("extensions.zotero.watchFolder.maxConcurrentMetadata", 2);
