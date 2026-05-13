// Zotero Watch Folder - Default Preferences
// These preferences are registered when the plugin loads

// Core watch settings
pref("extensions.zotero.watchFolder.enabled", false);
pref("extensions.zotero.watchFolder.sourcePath", "");
pref("extensions.zotero.watchFolder.pollInterval", 5);
pref("extensions.zotero.watchFolder.targetCollection", "Inbox");
pref("extensions.zotero.watchFolder.fileTypes", "pdf");
pref("extensions.zotero.watchFolder.importMode", "stored");  // "stored" or "linked"
pref("extensions.zotero.watchFolder.postImportAction", "leave");  // "leave", "delete", "move"
pref("extensions.zotero.watchFolder.autoRetrieveMetadata", true);  // Auto-fetch PDF metadata
pref("extensions.zotero.watchFolder.lastWatchedPath", "");  // For first-run detection
pref("extensions.zotero.watchFolder.diskDeleteOnTrash", "ask");  // "ask" | "os_trash" | "permanent" | "never" — when an item is trashed in Zotero, what to do with the source file in the watch folder
pref("extensions.zotero.watchFolder.diskDeleteSync", "auto");  // "auto" | "never" — when a file is externally deleted from the watch folder, auto-move the matching Zotero item to the bin and show a popup ("auto") or do nothing ("never")

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

// Phase 2: Collection ↔ Folder Mirroring
pref("extensions.zotero.watchFolder.collectionSyncEnabled", false);
pref("extensions.zotero.watchFolder.mirrorPath", "");
pref("extensions.zotero.watchFolder.mirrorRootCollection", "");
pref("extensions.zotero.watchFolder.mirrorPollInterval", 10);
pref("extensions.zotero.watchFolder.bidirectionalSync", false);
pref("extensions.zotero.watchFolder.conflictResolution", "last");  // "zotero", "disk", "last", "both", "manual"
