/**
 * Main entry point for Zotero Watch Folder plugin
 * This file exports hooks that bootstrap.js will call
 */

import { getWatchFolderService } from './watchFolder.mjs';
import { initMetadataRetriever, shutdownMetadataRetriever } from './metadataRetriever.mjs';
import { shutdownDuplicateDetector } from './duplicateDetector.mjs';
import { getSyncCoordinator, resetSyncCoordinator } from './syncCoordinator.mjs';
// v2.1 Mode 2 modules (collectionWatcher / folderEventDetector /
// itemMembershipHandler / mirrorExecutor) are skeletons today — they
// exist so the lifecycle wires through SyncCoordinator. The coordinator
// stays idle for Mode 1 (the only mode that ships in v2.0).
// firstRunHandler.mjs deleted in v2 cleanup — the v1 "Import All / Skip /
// Cancel" dialog is replaced by the C2 sync-root picker in prefs (and,
// once C1's full wizard ships, a proper multi-step onboarding flow).
// The lightweight first-run NUDGE below points the user at prefs the
// first time they open a Zotero window after install.

// Global references
let watchFolderService = null;
let metadataRetriever = null;
let syncCoordinator = null;
let firstRunNudgeShown = false;

const PREF_BRANCH = "extensions.zotero.watchFolder.";

function getPref(key) {
    return Zotero.Prefs.get(PREF_BRANCH + key, true);
}

function setPref(key, value) {
    Zotero.Prefs.set(PREF_BRANCH + key, value, true);
}

/**
 * v2 first-run nudge. Shown once per Zotero session when the plugin
 * isn't configured yet (no sync root). Offers to open the Watch Folder
 * preferences pane directly so the user can pick a sync root via the
 * C2 picker. Calling `setupCompleted=true` suppresses the nudge on
 * future runs.
 *
 * This is the minimal v2 onboarding surface — the full multi-step setup
 * wizard (Phase C1) replaces this with a guided flow once it ships.
 *
 * @param {Window} window - The Zotero main window.
 */
async function maybeShowFirstRunNudge(window) {
    // Already set up? Nothing to do.
    if (getPref("setupCompleted") === true) return;
    // Sync root already picked but `setupCompleted` somehow unset? Mark
    // complete and bail — the C2 picker is the canonical setter, but
    // this absorbs the case where a user wired things up via about:config
    // (or a manual pref import) before the nudge fired.
    const syncRootKey = getPref("syncRootCollectionKey");
    if (syncRootKey) {
        setPref("setupCompleted", true);
        return;
    }
    if (!Services || !Services.prompt) return;

    const title = "Zotero Watch Folder";
    const msg = "Welcome! Watch Folder isn't configured yet.\n\n"
              + "To start syncing, open Edit → Settings → Watch Folder, "
              + "pick a local folder to watch, then click 'Change…' next "
              + "to 'Zotero sync root' to choose where imports should land.\n\n"
              + "Open settings now?";
    const flags =
          Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING
        | Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_CANCEL
        | Services.prompt.BUTTON_POS_0_DEFAULT;

    const result = Services.prompt.confirmEx(
        window,
        title,
        msg,
        flags,
        "Open settings",
        null, null,
        null,
        {},
    );
    // result === 0 → user clicked "Open settings"; result === 1 → cancelled.
    if (result === 0) {
        try {
            // Zotero exposes openPreferences with a paneID parameter.
            const paneID = "zotero-prefpane-watch-folder";
            if (window.Zotero?.Utilities?.Internal?.openPreferences) {
                window.Zotero.Utilities.Internal.openPreferences(paneID);
            } else if (window.openPreferences) {
                window.openPreferences(paneID);
            } else {
                Zotero.debug("[WatchFolder] Could not auto-open prefs — host doesn't expose openPreferences");
            }
        } catch (e) {
            Zotero.debug(`[WatchFolder] Failed to open prefs: ${e.message}`);
        }
    }
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

            // v2.1 Mode 2 coordinator — initialised here so it shares the
            // tracking store with WatchFolderService. Stays idle in Mode 1.
            syncCoordinator = getSyncCoordinator();
            await syncCoordinator.init(watchFolderService._trackingStore);
            // A2: bridge the scan loop into the coordinator (no-op in Mode 1).
            watchFolderService.setSyncCoordinator(syncCoordinator);

            if (getPref("enabled")) {
                await watchFolderService.startWatching();
                await syncCoordinator.start();
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

        // First-run nudge: if the plugin hasn't been configured yet
        // (no sync root key OR `setupCompleted` pref unset), show a
        // one-time modal pointing the user at the prefs pane. This is
        // the minimal v2 first-run UX — the full multi-step setup
        // wizard (Phase C1) replaces this in a future release.
        if (!firstRunNudgeShown) {
            firstRunNudgeShown = true; // suppress further windows in this session
            try {
                await maybeShowFirstRunNudge(window);
            } catch (error) {
                Zotero.logError(`Zotero Watch Folder: first-run nudge error - ${error.message}`);
            }
        }
    },

    async onMainWindowUnload(window) {
        Zotero.debug("Zotero Watch Folder: Main window unloaded");
    },

    async onShutdown() {
        Zotero.debug("Zotero Watch Folder: Shutting down");

        if (syncCoordinator) {
            try {
                await syncCoordinator.stop();
                resetSyncCoordinator();
                syncCoordinator = null;
            } catch (error) {
                Zotero.logError(`Zotero Watch Folder: SyncCoordinator shutdown error - ${error.message}`);
            }
        }

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

        // duplicateDetector is lazily initialized. Its shutdown helper is
        // idempotent — safe to call even if never inited.
        try {
            shutdownDuplicateDetector();
        } catch (error) {
            Zotero.logError(`Zotero Watch Folder: Duplicate detector shutdown error - ${error.message}`);
        }
    }
};
