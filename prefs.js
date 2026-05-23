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
pref("extensions.zotero.watchFolder.importMode", "stored");  // "stored" or "linked"
pref("extensions.zotero.watchFolder.postImportAction", "leave");  // "leave", "delete", "move"
pref("extensions.zotero.watchFolder.autoRetrieveMetadata", true);  // Auto-fetch PDF metadata
pref("extensions.zotero.watchFolder.diskDeleteOnTrash", "ask");  // "ask" | "os_trash" | "permanent" | "never" — when an item is trashed in Zotero, what to do with the source file in the watch folder. No-op in Mode 1; consumed by v2.1/v2.2.
pref("extensions.zotero.watchFolder.diskDeleteSync", "auto");  // "auto" | "never" — when a file is externally deleted from the watch folder, auto-move the matching Zotero item to the bin and show a popup ("auto") or do nothing ("never"). No-op in Mode 1; consumed by v2.1/v2.2.

// v2.0 sync model — sync root + mode
pref("extensions.zotero.watchFolder.syncRootCollectionKey", "");  // 8-char Zotero collection key. Empty = not yet configured (setup wizard required).
pref("extensions.zotero.watchFolder.syncRootLibraryID", 1);  // Default = user library. Forward-compat for group libraries.
pref("extensions.zotero.watchFolder.mode", "mode1");  // "mode1" | "mode2" | "mode3". Only mode1 is functional in v2.0.
pref("extensions.zotero.watchFolder.setupCompleted", false);  // Gates whether the normal poll loop runs; setup wizard runs until true.
pref("extensions.zotero.watchFolder.localTrashFolderName", ".zotero-watch-trash");  // Reserved for v2.2; defined now so it can be referenced from scanner skip-list.

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
