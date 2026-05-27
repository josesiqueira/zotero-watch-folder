/**
 * Main entry point for Zotero Watch Folder plugin
 * This file exports hooks that bootstrap.js will call
 */

import { getWatchFolderService } from './watchFolder.mjs';
import { initMetadataRetriever, shutdownMetadataRetriever } from './metadataRetriever.mjs';
import { shutdownDuplicateDetector } from './duplicateDetector.mjs';
import { getTrackingStore } from './trackingStore.mjs';
import { getSyncCoordinator, resetSyncCoordinator } from './syncCoordinator.mjs';
import * as warningSink from './warningSink.mjs';
import * as suppressionResolver from './suppressionResolver.mjs';
import * as baseline from './baseline.mjs';

// Re-export so the prefs script (which can't `import` modules from the
// sandbox) can reach these via Zotero.WatchFolder.{warningSink,suppressionResolver,baseline}.
export { warningSink, suppressionResolver, baseline };
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
/** Pref-observer ID for `enabled` so runtime toggles start/stop the
 *  scanner + coordinator without a plugin reload. Symmetric with
 *  syncCoordinator's `_modeObserverID`. */
let enabledObserverID = null;

const PREF_BRANCH = "extensions.zotero.watchFolder.";

function getPref(key) {
    return Zotero.Prefs.get(PREF_BRANCH + key, true);
}

function setPref(key, value) {
    Zotero.Prefs.set(PREF_BRANCH + key, value, true);
}

/**
 * Runtime handler for the `enabled` pref. Starts both the
 * syncCoordinator (mode2/3) and the watchFolderService scan loop
 * when enabled goes false → true; stops both on the inverse
 * transition. Mirrors the onStartup ordering (coordinator first so
 * baseline finishes before the first scan).
 *
 * No-op when the service isn't initialized yet (shutdown in flight,
 * or plugin not fully loaded). Idempotent — guards on
 * `watchFolderService._isWatching` so repeated true→true or
 * false→false events don't double-start or double-stop.
 */
async function onEnabledChanged() {
    if (!watchFolderService) return;
    const wantEnabled = !!getPref("enabled");
    const isWatching = watchFolderService._isWatching === true;
    if (wantEnabled && !isWatching) {
        if (syncCoordinator) {
            try { await syncCoordinator.start(); }
            catch (e) { Zotero.logError(`Zotero Watch Folder: coordinator.start on enabled→true failed - ${e?.message ?? e}`); }
        }
        try { await watchFolderService.startWatching(); }
        catch (e) { Zotero.logError(`Zotero Watch Folder: startWatching on enabled→true failed - ${e?.message ?? e}`); }
        Zotero.debug("Zotero Watch Folder: enabled→true at runtime — started");
    } else if (!wantEnabled && isWatching) {
        try { watchFolderService.stopWatching(); }
        catch (e) { Zotero.logError(`Zotero Watch Folder: stopWatching on enabled→false failed - ${e?.message ?? e}`); }
        if (syncCoordinator) {
            try { await syncCoordinator.stop(); }
            catch (e) { Zotero.logError(`Zotero Watch Folder: coordinator.stop on enabled→false failed - ${e?.message ?? e}`); }
        }
        Zotero.debug("Zotero Watch Folder: enabled→false at runtime — stopped");
    }
}

/**
 * v2.1 Phase C1 — full setup wizard. Multi-step modal flow:
 *   1. Welcome / continue confirmation
 *   2. Pick local watch folder (FilePicker)
 *   3. Pick Zotero sync-root collection (Services.prompt.select over
 *      non-virtual user-library collections)
 *   4. Pick sync mode (Mode 1 — import only, Mode 2 — mirror without delete)
 *   5. Confirm summary + enable
 *
 * Returns true if the user completed setup, false if they cancelled at
 * any step. Sets the relevant prefs + `setupCompleted=true` + `enabled=true`
 * on success.
 *
 * Re-runnable: prefs pane exposes a "Re-run setup wizard…" button via
 * Zotero.WatchFolder.runSetupWizard(window).
 *
 * @param {Window} window - The Zotero main window (or prefs window).
 * @returns {Promise<boolean>}
 */
export async function runSetupWizard(window) {
    if (!Services || !Services.prompt) return false;

    // v2.4: prefer the single-pane XHTML wizard. Falls back to the modal
    // sequence below if the chrome window can't open for any reason (chrome
    // not registered, embedding context, etc.). Both paths converge on the
    // same `_commitWizardResult` to write prefs + start services.
    const xhtmlResult = await _runSetupWizardXHTML(window).catch((e) => {
        try { Zotero.logError(`[WatchFolder] XHTML wizard failed, falling back to modal sequence: ${e?.message ?? e}`); } catch (_) {}
        return null; // null → fall through to the modal sequence
    });
    if (xhtmlResult && xhtmlResult.opened) {
        if (xhtmlResult.canceled) return false;
        await _commitWizardResult({
            watchFolder: xhtmlResult.watchFolder,
            syncRootKey: xhtmlResult.syncRootKey,
            syncRootLibraryID: xhtmlResult.syncRootLibraryID,
            modeKey: xhtmlResult.mode,
            modeLabel: _modeLabelFor(xhtmlResult.mode),
            syncRootLabel: xhtmlResult.syncRootLabel,
        });
        return true;
    }

    // ─── Modal-sequence fallback (pre-v2.4 path) ─────────────────
    // ─── Step 1: welcome ─────────────────────────────────────────
    const welcomeFlags =
          Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING
        | Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_CANCEL
        | Services.prompt.BUTTON_POS_0_DEFAULT;
    const welcome = Services.prompt.confirmEx(
        window,
        "Watch Folder — Setup",
        "Set up Watch Folder in 4 steps?\n\n"
          + "1. Pick a local folder the plugin should watch\n"
          + "2. Pick the Zotero collection imports should land in\n"
          + "3. Pick a sync mode\n"
          + "4. Confirm and enable\n\n"
          + "You can re-run the wizard later from Edit → Settings → Watch Folder.",
        welcomeFlags,
        "Continue",
        null, null,
        null,
        {},
    );
    if (welcome !== 0) return false;

    // ─── Step 2: watch folder ────────────────────────────────────
    const watchFolder = await _wizardPickWatchFolder(window);
    if (!watchFolder) return false;

    // ─── Step 3: sync root collection ────────────────────────────
    const syncRootChoice = await _wizardPickSyncRoot(window);
    if (!syncRootChoice) return false;

    // ─── Step 4: sync mode ───────────────────────────────────────
    const modeChoice = _wizardPickMode(window);
    if (!modeChoice) return false;

    // ─── Step 5: confirm ─────────────────────────────────────────
    const confirmFlags =
          Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING
        | Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_CANCEL
        | Services.prompt.BUTTON_POS_0_DEFAULT;
    const safetyNote = _modeSafetyNote(modeChoice.key);
    const confirm = Services.prompt.confirmEx(
        window,
        "Watch Folder — Confirm",
        `Ready to enable:\n\n`
          + `Watch folder: ${watchFolder}\n`
          + `Zotero sync root: ${syncRootChoice.label}\n`
          + `Mode: ${modeChoice.label}\n\n`
          + `${safetyNote}\n\n`
          + `Imports will start on the next scan cycle (default every 5s). You can change any of these in Edit → Settings → Watch Folder.`,
        confirmFlags,
        "Enable",
        null, null,
        null,
        {},
    );
    if (confirm !== 0) return false;

    await _commitWizardResult({
        watchFolder,
        syncRootKey: syncRootChoice.key,
        syncRootLibraryID: syncRootChoice.libraryID,
        modeKey: modeChoice.key,
        modeLabel: modeChoice.label,
        syncRootLabel: syncRootChoice.label,
    });
    return true;
}

/**
 * Open the single-pane XHTML wizard window. Returns:
 *   { opened: false }                       — couldn't open (caller falls back)
 *   { opened: true, canceled: true }        — user cancelled
 *   { opened: true, canceled: false, ... }  — user clicked Enable; payload
 *                                             includes watchFolder, syncRootKey,
 *                                             syncRootLibraryID, syncRootLabel, mode.
 *
 * @param {Window} parentWindow
 * @returns {Promise<{opened: boolean, canceled?: boolean, watchFolder?: string,
 *   syncRootKey?: string, syncRootLibraryID?: number, syncRootLabel?: string,
 *   mode?: string}>}
 * @private
 */
async function _runSetupWizardXHTML(parentWindow) {
    if (!parentWindow || typeof parentWindow.openDialog !== 'function') {
        return { opened: false };
    }
    return await new Promise((resolve) => {
        let resolved = false;
        const args = {
            onResult: (payload) => {
                if (resolved) return;
                resolved = true;
                if (!payload || payload.canceled) {
                    resolve({ opened: true, canceled: true });
                    return;
                }
                resolve({
                    opened: true,
                    canceled: false,
                    watchFolder: payload.watchFolder,
                    syncRootKey: payload.syncRootKey,
                    syncRootLibraryID: payload.syncRootLibraryID,
                    syncRootLabel: payload.syncRootLabel,
                    mode: payload.mode,
                });
            },
        };
        try {
            // `modal,dependent` keeps it on top of the main Zotero window;
            // `centerscreen` self-explanatory; `resizable` lets the collection
            // list grow on small screens.
            parentWindow.openDialog(
                'chrome://zotero-watch-folder/content/setupWizard.xhtml',
                'watchFolderSetup',
                'chrome,centerscreen,resizable,modal,dependent',
                args,
            );
            // If the dialog closed without calling onResult (e.g., load
            // error), resolve as not-opened so the modal-sequence fallback
            // runs. The XHTML's unload handler ALSO emits a canceled result
            // — whichever fires first wins via the `resolved` guard.
            setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    resolve({ opened: false });
                }
            }, 250);
        } catch (e) {
            if (!resolved) {
                resolved = true;
                resolve({ opened: false });
            }
            try { Zotero.logError(`[WatchFolder] openDialog setupWizard.xhtml failed: ${e?.message ?? e}`); } catch (_) {}
        }
    });
}

/**
 * Common commit path for both the XHTML wizard and the modal-sequence
 * fallback. Writes the 6 prefs + starts services.
 * @private
 */
async function _commitWizardResult({ watchFolder, syncRootKey, syncRootLibraryID, modeKey, modeLabel, syncRootLabel }) {
    setPref("sourcePath", watchFolder);
    setPref("syncRootCollectionKey", syncRootKey);
    setPref("syncRootLibraryID", syncRootLibraryID);
    setPref("mode", modeKey);
    setPref("setupCompleted", true);
    setPref("enabled", true);
    try {
        if (watchFolderService) await watchFolderService.startWatching();
        if (syncCoordinator) await syncCoordinator.start();
    } catch (e) {
        Zotero.logError(`[WatchFolder] runSetupWizard: failed to start services - ${e.message}`);
    }
    Zotero.debug(`[WatchFolder] Setup wizard complete (watch=${watchFolder} root=${syncRootKey} label=${syncRootLabel} mode=${modeKey}/${modeLabel})`);
}

function _modeLabelFor(modeKey) {
    if (modeKey === 'mode1') return 'Mode 1 — Import only (safest; no two-way sync)';
    if (modeKey === 'mode2') return 'Mode 2 — Mirror without delete (two-way; deletes are warn-only)';
    if (modeKey === 'mode3') return 'Mode 3 — Mirror with safe delete (two-way; recoverable trash + bulk confirm)';
    return modeKey;
}

async function _wizardPickWatchFolder(window) {
    try {
        const { FilePicker } = ChromeUtils.importESModule(
            'chrome://zotero/content/modules/filePicker.mjs',
        );
        const fp = new FilePicker();
        fp.init(window, "Pick the local folder to watch", fp.modeGetFolder);
        const current = getPref("sourcePath");
        if (current) {
            try { fp.displayDirectory = current; } catch (_) { /* best effort */ }
        }
        const result = await fp.show();
        if (result !== fp.returnOK) return null;
        const f = fp.file;
        if (!f) return null;
        return (typeof f === "object" && f.path) ? f.path : String(f);
    } catch (e) {
        Services.prompt.alert(window, "Watch Folder", `Folder picker error: ${e.message}`);
        return null;
    }
}

async function _wizardPickSyncRoot(window) {
    const libraryID = Zotero.Libraries.userLibraryID;
    let collections;
    try {
        collections = Zotero.Collections.getByLibrary(libraryID) || [];
    } catch (e) {
        Services.prompt.alert(window, "Watch Folder", `Could not enumerate collections: ${e.message}`);
        return null;
    }
    const usable = collections
        .filter((c) => !c.isVirtual)
        .map((c) => ({ key: c.key, label: _displayPath(c), libraryID }))
        .sort((a, b) => a.label.localeCompare(b.label));
    if (usable.length === 0) {
        Services.prompt.alert(
            window,
            "Watch Folder",
            "No collections found in your library. Create one in Zotero first, then re-run setup.",
        );
        return null;
    }
    const labels = usable.map((u) => u.label);
    const out = {};
    const ok = Services.prompt.select(
        window,
        "Pick sync root collection",
        "Files added to your watch folder will be imported into the collection you pick here. "
          + "Subfolders on disk become subcollections under this root.",
        labels,
        out,
    );
    if (!ok) return null;
    return usable[out.value] ?? null;
}

function _wizardPickMode(window) {
    // All three modes ship in v2.2. Mode 1 is the safe default for
    // first-time users; Mode 3 is for users who trust the mirror enough
    // to let it propagate disk deletes (recoverable via the plugin's
    // `.zotero-watch-trash/` directory + bulk-delete confirmation).
    const modes = [
        { key: "mode1", label: "Mode 1 — Import only (safest; no two-way sync)" },
        { key: "mode2", label: "Mode 2 — Mirror without delete (two-way; deletes are warn-only)" },
        { key: "mode3", label: "Mode 3 — Mirror with safe delete (two-way; recoverable trash + bulk confirm)" },
    ];
    const out = {};
    const ok = Services.prompt.select(
        window,
        "Pick sync mode",
        "Mode 1 only watches the local folder for new files.\n\n"
          + "Mode 2 also reflects changes you make in Zotero (rename, reorganize) back to disk — destructive operations are warn-only.\n\n"
          + "Mode 3 additionally propagates deletes in both directions. Disk-trashed files move to .zotero-watch-trash/ under your watch root (recoverable). Any single op affecting >10 files or >20% of your tree prompts for confirmation. You can always switch modes later from the preferences pane.",
        modes.map((m) => m.label),
        out,
    );
    if (!ok) return null;
    return modes[out.value] ?? null;
}

function _modeSafetyNote(modeKey) {
    if (modeKey === "mode1") {
        return "Safety: nothing in Zotero will be modified by disk changes. Files you delete on disk stay in your library; collections renamed in Zotero do not rename folders on disk.";
    }
    if (modeKey === "mode2") {
        return "Safety: collection renames and item moves propagate both ways. Destructive operations (folder/file deletes) are warn-only — nothing is deleted, but you'll see a notice in the prefs pane.";
    }
    if (modeKey === "mode3") {
        return "Safety: deletes propagate both ways with a recoverable trash. Files trashed by either side go to `.zotero-watch-trash/` under your watch folder; restore via Zotero (un-trash the attachment) or the prefs pane's \"Trashed folders\" row. Any single operation affecting more than 10 files or 20% of your tracked items will prompt for confirmation.";
    }
    return "";
}

function _displayPath(collection) {
    const segments = [];
    let cursor = collection;
    for (let i = 0; i < 64 && cursor; i++) {
        segments.push(cursor.name);
        if (!cursor.parentID) break;
        cursor = Zotero.Collections.get(cursor.parentID);
    }
    return segments.reverse().join(" / ");
}

/**
 * First-run hook. If the plugin isn't configured yet, offers the
 * setup wizard. Suppressed permanently once `setupCompleted=true`.
 * @param {Window} window - The Zotero main window.
 */
async function maybeShowFirstRunNudge(window) {
    if (getPref("setupCompleted") === true) return;
    // Sync root already picked but `setupCompleted` somehow unset?
    // Absorb the case (manual about:config setup) without nagging.
    const syncRootKey = getPref("syncRootCollectionKey");
    if (syncRootKey) {
        setPref("setupCompleted", true);
        return;
    }
    if (!Services || !Services.prompt) return;

    const flags =
          Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING
        | Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_CANCEL
        | Services.prompt.BUTTON_POS_0_DEFAULT;
    const result = Services.prompt.confirmEx(
        window,
        "Watch Folder",
        "Watch Folder isn't configured yet.\n\nRun the setup wizard now?",
        flags,
        "Run setup",
        null, null,
        null,
        {},
    );
    if (result !== 0) return;
    try {
        await runSetupWizard(window);
    } catch (e) {
        Zotero.logError(`[WatchFolder] first-run wizard error - ${e.message}`);
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
                // Order matters: coordinator.start() runs the install-time
                // baseline (B.2/B.6/B.7) before collectionWatcher registers.
                // Must precede watchFolderService.startWatching() — the
                // first scan would otherwise process disk files through
                // the Mode-1 import flow, beating baseline to creating
                // sub-collections + tracking records and causing
                // duplicate-copy outcomes (live BASE.3 / bug #30).
                // In Mode 1 coordinator.start() short-circuits, so this
                // is a no-op for Mode 1 users (no extra latency).
                await syncCoordinator.start();
                await watchFolderService.startWatching();
            }

            // Runtime `enabled` pref observer (MODE3 live finding
            // 2026-05-25): toggling enabled false → true used to leave
            // the scanner idle until a plugin reload. Now we start/stop
            // both halves in-process, mirroring onStartup's order.
            try {
                if (Zotero.Prefs && typeof Zotero.Prefs.registerObserver === 'function') {
                    // Third arg MUST be `true` (global) when passing a full
                    // `extensions.zotero.X` path. Zotero.Prefs.registerObserver
                    // prepends `extensions.zotero.` to `name` when global is
                    // falsy, so passing it with `false` registers the observer
                    // on a double-prefixed path that the actual pref set/get
                    // never touches — the handler then silently never fires
                    // (S.7 bug, shipped broken since v2.2).
                    enabledObserverID = Zotero.Prefs.registerObserver(
                        PREF_BRANCH + 'enabled',
                        () => { onEnabledChanged().catch((e) => Zotero.logError(`Zotero Watch Folder: enabled observer error - ${e?.message ?? e}`)); },
                        true,
                    );
                }
            } catch (e) {
                Zotero.debug(`Zotero Watch Folder: could not register enabled observer - ${e?.message ?? e}`);
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

        if (enabledObserverID && Zotero.Prefs && typeof Zotero.Prefs.unregisterObserver === 'function') {
            try { Zotero.Prefs.unregisterObserver(enabledObserverID); }
            catch (_e) { /* best effort */ }
            enabledObserverID = null;
        }

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

        // WP-B3 belt-and-suspenders: each shutdown step above already
        // awaits its own store.flush() where it touches tracking
        // (watchFolderService.destroy() does), but any code that
        // schedules a debounced save during shutdown and doesn't await
        // it (notifier handler still in flight, async cleanup race)
        // would leak across plugin unload. Final flush() on the
        // singleton catches those. No-op when the store was never
        // initialized (uninitialised → dataFile null → _doSave
        // short-circuits).
        try {
            const store = getTrackingStore();
            if (store && typeof store.flush === 'function') {
                await store.flush();
            }
        } catch (error) {
            Zotero.logError(`Zotero Watch Folder: Tracking store flush error - ${error.message}`);
        }
    }
};
