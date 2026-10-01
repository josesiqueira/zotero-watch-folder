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
import * as storageStrategy from './storageStrategy.mjs';
import * as reconcile from './reconcile.mjs';
import * as hashCache from './_hashCache.mjs';
import { isWatchRootUnsafe } from './utils.mjs';
import * as mappings from './mappings.mjs';
import {
  getActiveMappings, readMappings, writeMappings, validateMapping, mintMappingId, LEGACY_MAPPING_ID,
} from './mappings.mjs';

// Re-export so the prefs script (which can't `import` modules from the
// sandbox) can reach these via Zotero.WatchFolder.{warningSink,suppressionResolver,baseline,storageStrategy,reconcile,mappings}.
export { warningSink, suppressionResolver, baseline, storageStrategy, reconcile, mappings };

// Diagnostic surface — read-only stats from the WP-A1 hash cache plus
// a clear hook for fresh measurements. Used to verify steady-state
// scan cycles hit the cache instead of re-hashing files. Reached from
// `zotero_execute_js` as `Zotero.WatchFolder.__perf.hashCacheStats()`.
// Side-effect-free except for `hashCacheClear()` which resets counters
// and evicts entries (used to start a clean measurement window).
export const __perf = {
    hashCacheStats: () => hashCache.stats(),
    hashCacheClear: () => hashCache.clear(),
};
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

    // Single unified "add a watch folder" flow — used for first-run, the prefs
    // "＋ Add watch folder" button, and re-run. Prefer the single-pane XHTML
    // wizard (folder → target → confirm); fall back to the modal sequence if the
    // chrome window can't open. Both converge on `_commitWizardResult`, which
    // APPENDS a validated mapping to `watchMappings` (sync mode + PDF storage are
    // global settings now, so the flow never asks per folder).
    const xhtmlResult = await _runSetupWizardXHTML(window).catch((e) => {
        try { Zotero.logError(`[WatchFolder] XHTML wizard failed, falling back to modal sequence: ${e?.message ?? e}`); } catch (_) {}
        return null; // null → fall through to the modal sequence
    });
    if (xhtmlResult && xhtmlResult.opened) {
        if (xhtmlResult.canceled) return false;
        const committed = await _commitWizardResult({
            window,
            watchFolder: xhtmlResult.watchFolder,
            scopeMode: xhtmlResult.scopeMode,
            syncRootKey: xhtmlResult.syncRootKey,
            syncRootLibraryID: xhtmlResult.syncRootLibraryID,
            syncRootLabel: xhtmlResult.syncRootLabel,
        });
        return committed;
    }

    // ─── Modal-sequence fallback (chrome window couldn't open) ───────────
    // Step 1: watch folder.
    const watchFolder = await _wizardPickWatchFolder(window);
    if (!watchFolder) return false;

    // Step 2: target — whole library OR a specific collection.
    const targetOut = {};
    const targetOk = Services.prompt.select(
        window, 'Watch Folder — Target',
        `Where should files dropped in "${watchFolder}" go?`,
        ['The whole library (Unfiled + every collection)', 'A specific collection (subfolders become subcollections)'],
        targetOut,
    );
    if (!targetOk) return false;
    let scopeMode = 'library';
    let syncRootKey = '';
    let syncRootLibraryID = Zotero.Libraries.userLibraryID;
    let syncRootLabel = 'Whole library';
    if (targetOut.value === 1) {
        const root = await _wizardPickSyncRoot(window);
        if (!root) return false;
        scopeMode = 'collection';
        syncRootKey = root.key;
        syncRootLibraryID = root.libraryID;
        syncRootLabel = root.label;
    }

    // Step 3: confirm.
    const confirmFlags =
          Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING
        | Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_CANCEL
        | Services.prompt.BUTTON_POS_0_DEFAULT;
    const confirm = Services.prompt.confirmEx(
        window,
        "Watch Folder — Confirm",
        `Add this watch folder?\n\n`
          + `Folder: ${watchFolder}\n`
          + `Target: ${syncRootLabel}\n\n`
          + `Import only — new files are imported into Zotero; nothing on disk is moved or deleted. `
          + `Sync mode and PDF storage are set once for all folders in Watch Folder settings. `
          + `Imports start on the next scan cycle (default every 5s).`,
        confirmFlags,
        "Enable",
        null, null,
        null,
        {},
    );
    if (confirm !== 0) return false;

    const committed = await _commitWizardResult({
        window, watchFolder, scopeMode, syncRootKey, syncRootLibraryID, syncRootLabel,
    });
    return committed;
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
                    scopeMode: payload.scopeMode,
                    syncRootKey: payload.syncRootKey,
                    syncRootLibraryID: payload.syncRootLibraryID,
                    syncRootLabel: payload.syncRootLabel,
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
 *
 * DATA-4: before committing, reject a watch root that dangerously overlaps the
 * Zotero data directory (or its `storage/` subdir). Fails open when the data
 * dir is unresolvable. On a reason, alerts the user and aborts WITHOUT writing
 * any pref or starting services.
 *
 * @returns {Promise<boolean>} true if committed, false if blocked.
 * @private
 */
async function _commitWizardResult({ window, watchFolder, syncRootKey, syncRootLibraryID, syncRootLabel, scopeMode }) {
    // Validate the candidate against existing mappings + the Zotero data dir
    // (overlap / unsafe-root). validateMapping subsumes the old isWatchRootUnsafe
    // check. On a reason, alert + abort WITHOUT writing any pref.
    const dataDir = Zotero?.DataDirectory?.dir;
    const reason = validateMapping({ sourcePath: watchFolder }, readMappings(), dataDir);
    if (reason) {
        try { Zotero.logError(`[WatchFolder] Add folder blocked: ${reason}`); } catch (_) {}
        try { if (Services && Services.prompt) Services.prompt.alert(window || null, "Watch Folder — Cannot add folder", reason); } catch (_) {}
        return false;
    }

    const effectiveScope = scopeMode === 'collection' ? 'collection' : 'library';
    const mapping = {
        id: mintMappingId(),
        sourcePath: watchFolder,
        scopeMode: effectiveScope,
        syncRootCollectionKey: effectiveScope === 'collection' ? (syncRootKey || '') : '',
        syncRootLibraryID: (typeof syncRootLibraryID === 'number') ? syncRootLibraryID : Zotero.Libraries.userLibraryID,
        // Sync mode + PDF storage are GLOBAL (import-only enforced today); these
        // per-mapping fields are kept only for schema shape and are ignored.
        mode: 'mode1',
        pdfStorageStrategy: getPref('pdfStorageStrategy') || 'stored',
    };

    const next = readMappings();
    // Folding: on the first mapping of a legacy single-root install, keep the
    // existing scalar-configured folder watched alongside the new one.
    if (next.length === 0) {
        const legacySource = getPref('sourcePath');
        if (legacySource && legacySource !== watchFolder) {
            next.push({
                id: LEGACY_MAPPING_ID,
                sourcePath: legacySource,
                scopeMode: getPref('scopeMode') === 'library' ? 'library' : 'collection',
                syncRootCollectionKey: getPref('syncRootCollectionKey') || '',
                syncRootLibraryID: getPref('syncRootLibraryID') || 1,
                mode: 'mode1',
                pdfStorageStrategy: getPref('pdfStorageStrategy') || 'stored',
            });
        }
    }
    next.push(mapping);
    writeMappings(next);
    setPref('watchMappingsMulti', true);   // one unified folder-list model
    setPref('setupCompleted', true);
    setPref('enabled', true);

    try {
        // Re-evaluate the sync pipeline for the updated folder set, mirroring
        // the onStartup order (coordinator first so its per-mapping baseline
        // runs before the first scan). coordinator.start() self-gates on the
        // effective mode — idle in Mode 1, active in Mode 2/3 — so adding a
        // folder while in Mode 2 correctly (re)activates mirroring instead of
        // leaving the coordinator stopped.
        if (syncCoordinator) await syncCoordinator.stop();
        if (watchFolderService) watchFolderService.stopWatching();
        if (syncCoordinator) await syncCoordinator.start();
        if (watchFolderService) await watchFolderService.startWatching();
    } catch (e) {
        Zotero.logError(`[WatchFolder] add folder: failed to (re)start services - ${e?.message ?? e}`);
    }
    Zotero.debug(`[WatchFolder] Added watch folder ${mapping.id} (watch=${watchFolder} scope=${effectiveScope} target=${syncRootLabel || (effectiveScope === 'library' ? '(whole library)' : syncRootKey)})`);
    return true;
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
        .filter((c) => !c.isVirtual && !c.deleted)
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

function _wizardPickStorageStrategy(window) {
    const strategies = [
        { key: "stored", label: "Store PDFs in Zotero (best Zotero experience; uses Zotero Storage/WebDAV)" },
        { key: "linked_watch_folder", label: "Link PDFs from watch folder (saves Zotero Storage; your folder-sync backs them up)" },
        { key: "stored_plus_mirror", label: "Store in Zotero AND mirror to watch folder (redundant backup; no storage savings)" },
    ];
    const out = {};
    const ok = Services.prompt.select(
        window,
        "Where should PDFs live?",
        "Zotero syncs your metadata, notes, and highlights. PDF FILES are separate.\n\n"
          + "Store in Zotero: Zotero manages the PDFs and syncs them via Zotero Storage or WebDAV.\n\n"
          + "Link from watch folder: PDFs stay in your folder (saves Zotero Storage); a folder-sync tool backs them up. May not open in Zotero mobile apps.\n\n"
          + "Store + mirror: keeps Zotero's copy plus a copy in the watch folder. You can change this later in the preferences pane.",
        strategies.map((s) => s.label),
        out,
    );
    if (!ok) return null;
    return strategies[out.value] ?? null;
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
    // Already configured but `setupCompleted` somehow unset? Absorb the case
    // (manual about:config setup) without nagging. Collection scope is
    // "configured" once a sync root is picked; library scope (v2.7) is
    // configured once a watch folder is set (no sync root to pick).
    const syncRootKey = getPref("syncRootCollectionKey");
    const libraryScopeConfigured = getPref("scopeMode") === 'library' && !!getPref("sourcePath");
    if (syncRootKey || libraryScopeConfigured) {
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

/**
 * Add a watch folder → target mapping. Kept as a named export for back-compat,
 * but the flow is now unified: it delegates to {@link runSetupWizard}, the single
 * folder → target → confirm flow used by first-run, the prefs "＋ Add watch
 * folder" button, and re-run. Sync mode + PDF storage are global (import-only
 * enforced today), so this never asks per folder.
 *
 * @param {Window} window
 * @returns {Promise<boolean>} true if a mapping was added.
 */
export async function runAddMappingWizard(window) {
  return runSetupWizard(window);
}

/**
 * Interactive remove: pick a configured mapping and delete it (with its
 * tracking records). Files already imported into Zotero are kept. When the last
 * mapping is removed, multi-mapping is turned back off (the plugin reverts to
 * the single-folder scalar config).
 * @param {Window} window
 * @returns {Promise<boolean>}
 */
export async function removeMappingInteractive(window) {
  if (!Services || !Services.prompt) return false;
  const list = readMappings();
  if (list.length === 0) {
    try { Services.prompt.alert(window, 'Watch Folder', 'No watch folders are configured.'); } catch (_) {}
    return false;
  }
  const labels = list.map((m) => `${m.sourcePath}  →  ${m.scopeMode === 'library' ? '(whole library)' : (m.syncRootCollectionKey || '(collection)')}`);
  const out = {};
  const ok = Services.prompt.select(window, 'Watch Folder — Remove a folder',
    'Pick a watch folder to stop watching. Files already imported into Zotero are kept; only the watch mapping and its local tracking records are removed.',
    labels, out);
  if (!ok) return false;
  const victim = list[out.value];
  if (!victim) return false;
  return _removeMappingById(victim.id);
}

/**
 * Remove one mapping by id, with a confirm. Used by the per-row "Remove" button
 * in the prefs "Watch folders" list. Files already imported into Zotero are kept.
 * @param {Window} window
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function removeMappingById(window, id) {
  if (!Services || !Services.prompt || !id) return false;
  const victim = readMappings().find((m) => m.id === id);
  if (!victim) {
    try { Services.prompt.alert(window, 'Watch Folder', 'That watch folder is no longer configured.'); } catch (_) {}
    return false;
  }
  const target = victim.scopeMode === 'library' ? '(whole library)' : (victim.syncRootCollectionKey || '(collection)');
  const ok = Services.prompt.confirm(window, 'Remove watch folder?',
    `Stop watching:\n${victim.sourcePath}\n→ ${target}\n\n`
    + 'Files already imported into Zotero are kept — only this watch folder and its local tracking records are removed.');
  if (!ok) return false;
  return _removeMappingById(id);
}

/**
 * Shared removal: purge the mapping's tracking records, drop it from
 * `watchMappings`, and restart the scan loop. Stays in the unified folder-list
 * model at zero folders (never flips the gate off — that would resurrect the
 * legacy single-root scalars).
 * @private
 */
async function _removeMappingById(id) {
  const list = readMappings();
  const victim = list.find((m) => m.id === id);
  if (!victim) return false;
  try {
    const store = getTrackingStore();
    if (store && typeof store.getAllOfType === 'function') {
      for (const r of store.getAllOfType('file')) {
        if ((r.mappingId || LEGACY_MAPPING_ID) === victim.id) store.remove(r.localPath, r.mappingId);
      }
      for (const c of store.getAllOfType('collection')) {
        if ((c.mappingId || LEGACY_MAPPING_ID) === victim.id) store.removeCollectionRecord(c.zoteroCollectionKey);
      }
      if (typeof store.save === 'function') await store.save();
    }
  } catch (e) {
    Zotero.logError(`[WatchFolder] removeMapping: purge failed - ${e?.message ?? e}`);
  }

  const remaining = list.filter((m) => m.id !== victim.id);
  writeMappings(remaining);
  if (remaining.length === 0) setPref('setupCompleted', false);
  try {
    // Re-evaluate both halves for the reduced folder set (coordinator first,
    // mirroring onStartup). coordinator.start() self-gates on the mode, so this
    // keeps Mode 2/3 mirroring active for the remaining folders.
    if (syncCoordinator) await syncCoordinator.stop();
    if (watchFolderService) watchFolderService.stopWatching();
    if (syncCoordinator) await syncCoordinator.start();
    if (watchFolderService) await watchFolderService.startWatching();
  } catch (e) {
    Zotero.logError(`[WatchFolder] removeMapping: restart failed - ${e?.message ?? e}`);
  }
  Zotero.debug(`[WatchFolder] Removed mapping ${victim.id}; ${remaining.length} remaining`);
  return true;
}

/**
 * Short human-readable summary of the active mappings, for the prefs pane.
 * @returns {string}
 */
export function describeMappings() {
  const ms = getActiveMappings().filter((m) => m && m.sourcePath);
  if (ms.length === 0) return 'No watch folders yet — click “＋ Add watch folder…”.';
  return `${ms.length} folder${ms.length === 1 ? '' : 's'}:\n` + ms.map((m) =>
    `• ${m.sourcePath} → ${m.scopeMode === 'library' ? '(whole library)' : (m.syncRootCollectionKey || '(collection)')}`,
  ).join('\n');
}

/**
 * Health of each active mapping's Zotero target — so the prefs pane can show a
 * "Paused" state instead of a misleading "Watching" when a target collection is
 * gone or in the Trash (import fail-closed-pauses on such a target, see
 * canonicalPath.resolveSyncRoot). Synchronous: reads live Zotero + prefs, no
 * disk/await. Works for single-root (one synthesized mapping) and multi.
 *
 * @returns {Array<{id:string, sourcePath:string, scopeMode:string, targetLabel:string, ok:boolean, reason:(null|'trashed'|'missing'|'library-unavailable')}>}
 */
export function getMappingHealth() {
  const out = [];
  const userLib = (Zotero.Libraries && Zotero.Libraries.userLibraryID) || 1;
  for (const m of getActiveMappings()) {
    if (!m || !m.sourcePath) continue;
    let ok = true;
    let reason = null;
    let targetLabel = '(whole library)';
    const libraryID = m.syncRootLibraryID || userLib;
    try {
      if (m.scopeMode === 'library') {
        const lib = (Zotero.Libraries && typeof Zotero.Libraries.get === 'function')
          ? Zotero.Libraries.get(libraryID) : true;
        if (!lib) { ok = false; reason = 'library-unavailable'; }
      } else {
        const key = m.syncRootCollectionKey;
        const col = key ? Zotero.Collections.getByLibraryAndKey(libraryID, key) : null;
        if (!col) { ok = false; reason = 'missing'; targetLabel = '(no collection set)'; }
        else if (col.deleted) { ok = false; reason = 'trashed'; targetLabel = col.name; }
        else { targetLabel = col.name; }
      }
    } catch (_e) {
      // A thrown lookup means we can't confirm the target is healthy — treat as
      // blocked (conservative), matching the fail-closed import pause.
      ok = false;
      reason = reason || 'missing';
    }
    out.push({ id: m.id, sourcePath: m.sourcePath, scopeMode: m.scopeMode, targetLabel, ok, reason });
  }
  return out;
}

export const hooks = {
    async onStartup() {
        Zotero.debug("Zotero Watch Folder: Starting up");

        // Register preference pane. Isolated in its own try-catch: the pane is
        // NOT load-bearing for watching/mirroring, so a registration failure
        // (bad XHTML, missing icon, Zotero API change) must NOT abort the
        // service init below — it would dark-fail the whole plugin otherwise.
        const rootURI = this._rootURI || '';
        if (rootURI) {
            try {
                await Zotero.PreferencePanes.register({
                    pluginID: "watch-folder@zotero-plugin.org",
                    src: rootURI + "content/preferences.xhtml",
                    label: "Watch Folder",
                    image: rootURI + "content/icons/watch-folder-16.png",
                    scripts: [rootURI + "content/preferences.js"],
                });
            } catch (e) {
                Zotero.logError(`[WatchFolder] preference pane registration failed (continuing startup): ${e && e.message ? e.message : e}`);
            }
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

    /**
     * Manual trigger for the standalone-metadata backfill. Re-queues every
     * plugin-managed standalone PDF attachment (no parent registry item)
     * for metadata retrieval + parent-creation fallback. Reachable from
     * `zotero_execute_js` as `Zotero.WatchFolder.hooks.retrieveMissingMetadata()`.
     * @returns {Promise<{queued: number}>}
     */
    async retrieveMissingMetadata() {
        if (!watchFolderService) {
            Zotero.debug("[WatchFolder] retrieveMissingMetadata: service not initialized");
            return { queued: 0 };
        }
        return watchFolderService.backfillStandaloneMetadata();
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
