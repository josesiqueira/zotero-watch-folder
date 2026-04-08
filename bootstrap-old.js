/* eslint-disable no-unused-vars */
/**
 * Zotero Watch Folder - Bootstrap Entry Point
 *
 * This file handles the plugin lifecycle for Zotero 8.
 * Uses ESM modules, native async/await, and IOUtils (no .jsm, no Bluebird, no OS.File).
 */

var Cc = globalThis.Cc || Components.classes;
var Ci = globalThis.Ci || Components.interfaces;
var Cu = globalThis.Cu || Components.utils;
var Services = globalThis.Services || (globalThis.ChromeUtils ? ChromeUtils.importServices() : Cu.import("resource://gre/modules/Services.jsm").Services);
var ChromeUtils = globalThis.ChromeUtils || (globalThis.ChromeUtils ? globalThis.ChromeUtils : Cu.import("resource://gre/modules/ChromeUtils.jsm").ChromeUtils);

var chromeHandle;
var watchFolderService;
var metadataRetriever;
var collectionSyncService;
var firstRunHandled = false;

const PREF_BRANCH = "extensions.zotero.watchFolder.";

/**
 * Called when the plugin is first installed or enabled
 */
function install(data, reason) {
    // Nothing to do on install
}

/**
 * Called when the plugin is uninstalled or disabled
 */
function uninstall(data, reason) {
    // Nothing to do on uninstall
}

/**
 * Called when the plugin starts up
 * @param {Object} data - Add-on data including id, version, rootURI
 * @param {number} reason - Startup reason constant
 */
async function startup({ id, version, resourceURI, rootURI }, reason) {
    if (!rootURI) {
        rootURI = resourceURI.spec;
    }
    
    // Register chrome content and locale paths
    const aomStartup = Cc["@mozilla.org/addons/addon-manager-startup;1"]
        .getService(Ci.amIAddonManagerStartup);

    const manifestURI = Services.io.newURI(rootURI + "manifest.json");
    chromeHandle = aomStartup.registerChrome(manifestURI, [
        ["content", "zotero-watch-folder", "content/"],
        ["locale", "zotero-watch-folder", "en-US", "locale/en-US/"]
    ]);

    // Wait for Zotero to be fully initialized
    await Zotero.initializationPromise;

    // Register preference pane
    Zotero.PreferencePanes.register({
        pluginID: "watch-folder@zotero-plugin.org",
        src: rootURI + "content/preferences.xhtml",
        label: "Watch Folder",
        image: rootURI + "content/icons/watch-folder-16.png"
    });

    // Initialize default preferences if not set
    initDefaultPreferences();

    // Lazy load and initialize the watch folder service
    try {
        // Import WatchFolderService singleton getter
        const { getWatchFolderService } = ChromeUtils.importESModule(
            "chrome://zotero-watch-folder/content/watchFolder.mjs"
        );

        // Import MetadataRetriever
        const { initMetadataRetriever } = ChromeUtils.importESModule(
            "chrome://zotero-watch-folder/content/metadataRetriever.mjs"
        );

        // Initialize metadata retriever first (it will be used by the watch service)
        metadataRetriever = await initMetadataRetriever();

        // Initialize watch folder service (using singleton getter)
        watchFolderService = getWatchFolderService();
        await watchFolderService.init();

        // Connect metadata retriever to watch folder service
        watchFolderService.setMetadataRetriever(metadataRetriever);

        // Start watching if enabled in preferences
        if (getPref("enabled")) {
            await watchFolderService.startWatching();
        }

        // Initialize collection sync service (Phase 2)
        try {
            const { initCollectionSync } = ChromeUtils.importESModule(
                "chrome://zotero-watch-folder/content/collectionSync.mjs"
            );
            collectionSyncService = await initCollectionSync();
            Zotero.debug("Zotero Watch Folder: Collection sync service initialized");
        } catch (syncError) {
            Zotero.debug(`Zotero Watch Folder: Collection sync not initialized - ${syncError.message}`);
            // Collection sync is optional, don't fail startup
        }

        Zotero.debug("Zotero Watch Folder: Plugin started successfully");
    } catch (error) {
        Zotero.logError(`Zotero Watch Folder: Failed to initialize service - ${error.message}`);
        Zotero.debug(error.stack);
    }
}

/**
 * Called when the plugin shuts down
 * @param {Object} data - Add-on data
 * @param {number} reason - Shutdown reason constant
 */
async function shutdown({ id, version, resourceURI, rootURI }, reason) {
    if (!rootURI) {
        rootURI = resourceURI.spec;
    }
    
    // Skip cleanup if Zotero is shutting down entirely
    if (reason === APP_SHUTDOWN) {
        return;
    }

    Zotero.debug("Zotero Watch Folder: Shutting down plugin");

    // Stop the watch folder service
    if (watchFolderService) {
        try {
            await watchFolderService.stopWatching();
            await watchFolderService.destroy();
            watchFolderService = null;
        } catch (error) {
            Zotero.logError(`Zotero Watch Folder: Error during service shutdown - ${error.message}`);
        }
    }

    // Shutdown metadata retriever
    if (metadataRetriever) {
        try {
            const { shutdownMetadataRetriever } = ChromeUtils.importESModule(
                "chrome://zotero-watch-folder/content/metadataRetriever.mjs"
            );
            shutdownMetadataRetriever();
            metadataRetriever = null;
        } catch (error) {
            Zotero.logError(`Zotero Watch Folder: Error during metadata retriever shutdown - ${error.message}`);
        }
    }

    // Shutdown collection sync service (Phase 2)
    if (collectionSyncService) {
        try {
            const { shutdownCollectionSync } = ChromeUtils.importESModule(
                "chrome://zotero-watch-folder/content/collectionSync.mjs"
            );
            await shutdownCollectionSync();
            collectionSyncService = null;
        } catch (error) {
            Zotero.logError(`Zotero Watch Folder: Error during collection sync shutdown - ${error.message}`);
        }
    }

    // Shutdown duplicate detector (Phase 3)
    try {
        const { shutdownDuplicateDetector } = ChromeUtils.importESModule(
            "chrome://zotero-watch-folder/content/duplicateDetector.mjs"
        );
        shutdownDuplicateDetector();
    } catch (error) {
        Zotero.debug(`Zotero Watch Folder: Error during duplicate detector shutdown - ${error.message}`);
    }

    // Unregister chrome
    if (chromeHandle) {
        chromeHandle.destruct();
        chromeHandle = null;
    }

    // Reset first run state
    firstRunHandled = false;

    Zotero.debug("Zotero Watch Folder: Plugin shutdown complete");
}

/**
 * Called when a main Zotero window loads
 * @param {Object} params - Contains window reference
 */
async function onMainWindowLoad({ window }) {
    // Insert FTL localization file for Fluent
    window.MozXULElement.insertFTLIfNeeded("zotero-watch-folder.ftl");

    // Store window reference if needed for UI updates
    if (watchFolderService) {
        watchFolderService.addWindow(window);
    }

    // Handle first run (check for existing files to import)
    if (!firstRunHandled && getPref("enabled") && getPref("sourcePath")) {
        try {
            const { handleFirstRun } = ChromeUtils.importESModule(
                "chrome://zotero-watch-folder/content/firstRunHandler.mjs"
            );
            const result = await handleFirstRun(window);
            if (result.handled) {
                firstRunHandled = true;
                Zotero.debug(`Zotero Watch Folder: First run handled, imported ${result.imported} files`);
            }
        } catch (error) {
            Zotero.logError(`Zotero Watch Folder: First run handler error - ${error.message}`);
        }
    }

    Zotero.debug("Zotero Watch Folder: Main window loaded");
}

/**
 * Called when a main Zotero window unloads
 * @param {Object} params - Contains window reference
 */
function onMainWindowUnload({ window }) {
    // Clean up window references
    if (watchFolderService) {
        watchFolderService.removeWindow(window);
    }

    Zotero.debug("Zotero Watch Folder: Main window unloaded");
}

/**
 * Initialize default preference values
 */
function initDefaultPreferences() {
    // Match keys defined in preferences.xhtml plus additional runtime preferences
    const defaults = {
        // Core watch settings
        "enabled": false,
        "sourcePath": "",
        "pollInterval": 5,
        "fileTypes": "pdf",
        "targetCollection": "Inbox",
        "importMode": "stored",
        "postImportAction": "leave",
        "autoRetrieveMetadata": true,
        "maxConcurrentMetadata": 2,
        "lastWatchedPath": "",
        // File naming
        "autoRename": true,
        "renamePattern": "{firstCreator} - {year} - {title}",
        "maxFilenameLength": 150,
        // Duplicate detection (Phase 3)
        "duplicateCheck": true,
        "duplicateMatchDOI": true,
        "duplicateMatchISBN": true,
        "duplicateMatchTitle": true,
        "duplicateTitleThreshold": 0.85,
        "duplicateMatchHash": false,
        "duplicateAction": "skip",
        // Smart rules (Phase 3)
        "smartRulesEnabled": false,
        "smartRules": "[]",
        // Phase 2: Collection Sync
        "adaptivePolling": true,
        "collectionSyncEnabled": false,
        "mirrorPath": "",
        "mirrorRootCollection": "",
        "mirrorPollInterval": 10,
        "bidirectionalSync": false,
        "conflictResolution": "last"
    };

    for (const [key, value] of Object.entries(defaults)) {
        if (!hasPref(key)) {
            setPref(key, value);
        }
    }
}

/**
 * Get a preference value
 * @param {string} key - Preference key (without branch prefix)
 * @returns {*} Preference value
 */
function getPref(key) {
    const branch = Services.prefs.getBranch(PREF_BRANCH);
    const type = branch.getPrefType(key);

    switch (type) {
        case Services.prefs.PREF_BOOL:
            return branch.getBoolPref(key);
        case Services.prefs.PREF_INT:
            return branch.getIntPref(key);
        case Services.prefs.PREF_STRING:
            return branch.getStringPref(key);
        default:
            return null;
    }
}

/**
 * Set a preference value
 * @param {string} key - Preference key (without branch prefix)
 * @param {*} value - Value to set
 */
function setPref(key, value) {
    const branch = Services.prefs.getBranch(PREF_BRANCH);

    switch (typeof value) {
        case "boolean":
            branch.setBoolPref(key, value);
            break;
        case "number":
            branch.setIntPref(key, value);
            break;
        case "string":
            branch.setStringPref(key, value);
            break;
        default:
            throw new Error(`Unsupported preference type: ${typeof value}`);
    }
}

/**
 * Check if a preference exists
 * @param {string} key - Preference key (without branch prefix)
 * @returns {boolean} True if preference exists
 */
function hasPref(key) {
    const branch = Services.prefs.getBranch(PREF_BRANCH);
    return branch.getPrefType(key) !== Services.prefs.PREF_INVALID;
}
