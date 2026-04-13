/**
 * Main entry point for Zotero Watch Folder plugin
 * This file exports hooks that bootstrap.js will call
 */

import { getWatchFolderService } from './watchFolder.mjs';
import { initMetadataRetriever, shutdownMetadataRetriever } from './metadataRetriever.mjs';
import { handleFirstRun } from './firstRunHandler.mjs';

// Global references
let watchFolderService = null;
let metadataRetriever = null;
let firstRunHandled = false;

const PREF_BRANCH = "extensions.zotero.watchFolder.";

function getPref(key) {
    return Zotero.Prefs.get(PREF_BRANCH + key, true);
}

export const hooks = {
    async onStartup() {
        Zotero.debug("Zotero Watch Folder: Starting up");

        // Register preference pane
        const rootURI = this._rootURI || '';
        if (rootURI) {
            await Zotero.PreferencePanes.register({
                pluginID: "watch-folder@zotero-plugin.org",
                src: rootURI + "content/preferences.xhtml",
                label: "Watch Folder",
                image: rootURI + "content/icons/watch-folder-16.png",
                scripts: [rootURI + "content/preferences.js"],
            });
        }

        // Initialize services
        try {
            metadataRetriever = await initMetadataRetriever();
            watchFolderService = getWatchFolderService();
            await watchFolderService.init();
            watchFolderService.setMetadataRetriever(metadataRetriever);

            if (getPref("enabled")) {
                await watchFolderService.startWatching();
            }

            Zotero.debug("Zotero Watch Folder: Started successfully");
        } catch (error) {
            Zotero.logError(`Zotero Watch Folder: Failed to start - ${error.message}`);
        }
    },

    async onMainWindowLoad(window) {
        Zotero.debug("Zotero Watch Folder: Main window loaded");

        // Insert FTL localization
        window.MozXULElement.insertFTLIfNeeded("zotero-watch-folder.ftl");

        // Handle first run
        if (!firstRunHandled && getPref("enabled") && getPref("sourcePath")) {
            try {
                const result = await handleFirstRun(window);
                if (result.handled) {
                    firstRunHandled = true;
                    Zotero.debug(`Zotero Watch Folder: First run handled, imported ${result.imported} files`);
                }
            } catch (error) {
                Zotero.logError(`Zotero Watch Folder: First run error - ${error.message}`);
            }
        }
    },

    async onMainWindowUnload(window) {
        Zotero.debug("Zotero Watch Folder: Main window unloaded");
    },

    async onShutdown() {
        Zotero.debug("Zotero Watch Folder: Shutting down");

        if (watchFolderService) {
            try {
                await watchFolderService.stopWatching();
                await watchFolderService.destroy();
                watchFolderService = null;
            } catch (error) {
                Zotero.logError(`Zotero Watch Folder: Shutdown error - ${error.message}`);
            }
        }

        if (metadataRetriever) {
            try {
                await shutdownMetadataRetriever();
                metadataRetriever = null;
            } catch (error) {
                Zotero.logError(`Zotero Watch Folder: Metadata retriever shutdown error - ${error.message}`);
            }
        }
    }
};
