/**
 * Zotero Watch Folder - Preferences Panel Script
 * Loaded via the `scripts` array in PreferencePanes.register().
 * Runs inside a Cu.Sandbox(window) BEFORE the pane fragment is inserted,
 * so DOM lookups must be deferred until Zotero fires 'load' on our vbox.
 */

(function () {
    'use strict';

    // Load FTL into the preferences window's l10n context.
    // Must happen before document.l10n.translateFragment() is called by Zotero.
    if (typeof MozXULElement !== 'undefined') {
        MozXULElement.insertFTLIfNeeded("zotero-watch-folder.ftl");
    }

    const { FilePicker } = ChromeUtils.importESModule(
        'chrome://zotero/content/modules/filePicker.mjs'
    );

    const PREF_PREFIX = 'extensions.zotero.watchFolder.';

    function getPref(name) {
        return Zotero.Prefs.get(PREF_PREFIX + name, true);
    }

    function setPref(name, value) {
        Zotero.Prefs.set(PREF_PREFIX + name, value, true);
    }

    /**
     * Build the human-readable path of a collection by walking parent chain.
     * Used to show "Inbox" or "Inbox / Methods" in the sync-root display.
     */
    function collectionDisplayPath(collection) {
        const segments = [];
        let cursor = collection;
        for (let i = 0; i < 64 && cursor; i++) {
            segments.push(cursor.name);
            if (!cursor.parentID) break;
            cursor = Zotero.Collections.get(cursor.parentID);
        }
        return segments.reverse().join(' / ');
    }

    /**
     * Refresh the sync-root readonly display from the stored key.
     */
    function refreshSyncRootDisplay() {
        const display = document.getElementById('watch-folder-sync-root-display');
        if (!display) return;
        const key = getPref('syncRootCollectionKey');
        if (!key) {
            display.value = '(not configured — click Change… to pick one)';
            return;
        }
        try {
            const libraryID = getPref('syncRootLibraryID') || Zotero.Libraries.userLibraryID;
            const collection = Zotero.Collections.getByLibraryAndKey(libraryID, key);
            display.value = collection
                ? collectionDisplayPath(collection)
                : `(collection missing — was ${key})`;
        } catch (e) {
            display.value = `(error resolving: ${e.message})`;
        }
    }

    /**
     * Refresh the sync-warnings row from the bundle's warningSink.
     * Hidden when there are no warnings.
     */
    function refreshWarningsDisplay() {
        const row = document.getElementById('watch-folder-warnings-row');
        const countEl = document.getElementById('watch-folder-warnings-count');
        if (!row || !countEl) return;
        const sink = Zotero.WatchFolder && Zotero.WatchFolder.warningSink;
        const total = sink ? sink.getTotalCount() : 0;
        countEl.value = String(total);
        row.hidden = total === 0;
    }

    /**
     * Open an alert with the recent warning entries (newest first).
     * Caps display at the most recent 30 to keep the alert legible.
     */
    function viewWarnings() {
        const sink = Zotero.WatchFolder && Zotero.WatchFolder.warningSink;
        if (!sink) {
            Services.prompt.alert(window, 'Watch Folder', 'Warning sink not available — plugin not fully loaded?');
            return;
        }
        const recent = sink.getRecent(30);
        if (recent.length === 0) {
            Services.prompt.alert(window, 'Watch Folder', 'No sync warnings recorded.');
            return;
        }
        const lines = recent.slice().reverse().map((w) => {
            const ts = new Date(w.timestamp).toLocaleString();
            const where = w.path ? ` (${w.path})` : (w.collectionKey ? ` (col ${w.collectionKey})` : '');
            return `[${w.category}] ${ts}${where}\n  ${w.message || w.reason || ''}`;
        });
        const counts = sink.getCountsByCategory();
        const summary = [...counts.entries()]
            .map(([cat, n]) => `${cat}: ${n}`)
            .join(' · ');
        Services.prompt.alert(
            window,
            'Watch Folder — Sync warnings',
            `Total ${sink.getTotalCount()}  (${summary})\n\n${lines.join('\n\n')}`,
        );
    }

    function clearWarnings() {
        const sink = Zotero.WatchFolder && Zotero.WatchFolder.warningSink;
        if (!sink) return;
        sink.clear();
        refreshWarningsDisplay();
    }

    /**
     * Refresh the conflict-blocked row count. Currently a display-only
     * surface — full conflict-resolution actions are a follow-up.
     */
    function refreshConflictedDisplay() {
        const row = document.getElementById('watch-folder-conflicted-row');
        const countEl = document.getElementById('watch-folder-conflicted-count');
        if (!row || !countEl) return;
        const resolver = Zotero.WatchFolder && Zotero.WatchFolder.suppressionResolver;
        const records = resolver && typeof resolver.listConflicted === 'function'
            ? resolver.listConflicted() : [];
        countEl.value = String(records.length);
        row.hidden = records.length === 0;
    }

    /**
     * Refresh the suppressed-items row count. Shows file count, and
     * appends "(+M folders)" when there are also suppressed collection
     * records (folder-resolution UX is still pending — surfacing the
     * count keeps the user from being blind to them).
     */
    function refreshSuppressedDisplay() {
        const row = document.getElementById('watch-folder-suppressed-row');
        const countEl = document.getElementById('watch-folder-suppressed-count');
        if (!row || !countEl) return;
        const resolver = Zotero.WatchFolder && Zotero.WatchFolder.suppressionResolver;
        const files = resolver ? resolver.listSuppressed() : [];
        const folders = resolver && typeof resolver.listSuppressedCollections === 'function'
            ? resolver.listSuppressedCollections()
            : [];
        countEl.value = folders.length > 0
            ? `${files.length} (+${folders.length} folders)`
            : String(files.length);
        row.hidden = files.length === 0 && folders.length === 0;
        // The folders Resolve button is independent of the files one: a user
        // may have suppressed folders but no suppressed files (or vice versa).
        const foldersBtn = document.getElementById('watch-folder-suppressed-resolve-folders-btn');
        if (foldersBtn) foldersBtn.hidden = folders.length === 0;
        const filesBtn = document.getElementById('watch-folder-suppressed-resolve-btn');
        if (filesBtn) filesBtn.hidden = files.length === 0;
    }

    /**
     * Iterate through suppressed FileRecords and ask the user what to do
     * for each. Uses Services.prompt.select (an option list) because the
     * 3-button confirmEx caps at 3 buttons but we need 4 actions + skip.
     *
     * For "Move outside watch folder" we open a FilePicker to choose the
     * target directory. For all others the resolver does the work and we
     * just refresh the display.
     */
    async function resolveSuppressed() {
        const resolver = Zotero.WatchFolder && Zotero.WatchFolder.suppressionResolver;
        if (!resolver) {
            Services.prompt.alert(window, 'Watch Folder', 'Suppression resolver not available — plugin not fully loaded?');
            return;
        }
        const records = resolver.listSuppressed();
        if (records.length === 0) {
            Services.prompt.alert(window, 'Watch Folder', 'No suppressed items.');
            return;
        }

        const ACTIONS = [
            { label: 'Re-add to Zotero sync root',         key: resolver.RESOLUTION_ACTION.REINSTATE },
            { label: 'Keep local file, stop syncing it',   key: resolver.RESOLUTION_ACTION.KEEP_LOCAL },
            { label: 'Move local file to trash',           key: resolver.RESOLUTION_ACTION.TRASH },
            { label: 'Move local file outside watch folder', key: resolver.RESOLUTION_ACTION.MOVE_OUTSIDE },
            { label: 'Skip for now',                       key: null },
        ];
        const labels = ACTIONS.map((a) => a.label);

        let i = 0;
        for (const record of records) {
            i++;
            const out = {};
            const ok = Services.prompt.select(
                window,
                `Suppressed item ${i} of ${records.length}`,
                `"${record.localPath}" lost its last Zotero sync-root membership.\n\nWhat do you want to do?`,
                labels,
                out,
            );
            if (!ok) break; // user cancelled the whole flow
            const choice = ACTIONS[out.value];
            if (!choice || !choice.key) continue; // skip-for-now

            let opts = {};
            if (choice.key === resolver.RESOLUTION_ACTION.MOVE_OUTSIDE) {
                const fp = new FilePicker();
                fp.init(window, 'Pick destination folder (outside watch folder)', fp.modeGetFolder);
                const fpResult = await fp.show();
                if (fpResult !== fp.returnOK) continue;
                // FilePicker.file returns an nsIFile; suppressionResolver
                // expects a string path. Different Zotero builds expose
                // `.path`; fall back to String() if it's already a string.
                opts.targetDir = (fp.file && typeof fp.file === 'object' && fp.file.path)
                    ? fp.file.path
                    : String(fp.file);
            }

            try {
                const result = await resolver.resolve(record, choice.key, opts);
                if (!result.ok) {
                    Services.prompt.alert(
                        window,
                        'Watch Folder',
                        `Failed to ${choice.label.toLowerCase()} for "${record.localPath}":\n${result.reason || ''}${result.error ? '\n' + result.error : ''}`,
                    );
                }
            } catch (e) {
                Services.prompt.alert(window, 'Watch Folder', `Error: ${e.message}`);
            }
        }
        refreshSuppressedDisplay();
        refreshWarningsDisplay();
    }

    /**
     * Iterate through suppressed CollectionRecords (folders whose Zotero
     * collection lost its last sync-root membership) and ask the user what
     * to do for each. Mirrors resolveSuppressed() but dispatches to
     * resolver.resolveCollection() with the COLLECTION_RESOLUTION_ACTION
     * enum. For MOVE_OUTSIDE we open FilePicker to pick a target directory.
     */
    async function resolveSuppressedFolders() {
        const resolver = Zotero.WatchFolder && Zotero.WatchFolder.suppressionResolver;
        if (!resolver) {
            Services.prompt.alert(window, 'Watch Folder', 'Suppression resolver not available — plugin not fully loaded?');
            return;
        }
        if (typeof resolver.resolveCollection !== 'function'
            || !resolver.COLLECTION_RESOLUTION_ACTION) {
            Services.prompt.alert(window, 'Watch Folder', 'Folder resolution unavailable — plugin not fully loaded?');
            return;
        }
        const records = typeof resolver.listSuppressedCollections === 'function'
            ? resolver.listSuppressedCollections()
            : [];
        if (records.length === 0) {
            Services.prompt.alert(window, 'Watch Folder', 'No suppressed folders.');
            return;
        }

        const ACTIONS = [
            { label: 'Re-create the Zotero collection',           key: resolver.COLLECTION_RESOLUTION_ACTION.REINSTATE },
            { label: 'Keep local folder, stop syncing it',        key: resolver.COLLECTION_RESOLUTION_ACTION.KEEP_LOCAL },
            { label: 'Move local folder to trash',                key: resolver.COLLECTION_RESOLUTION_ACTION.TRASH },
            { label: 'Move local folder outside watch folder',    key: resolver.COLLECTION_RESOLUTION_ACTION.MOVE_OUTSIDE },
            { label: 'Skip for now',                              key: null },
        ];
        const labels = ACTIONS.map((a) => a.label);

        let i = 0;
        for (const record of records) {
            i++;
            const out = {};
            const ok = Services.prompt.select(
                window,
                `Suppressed folder ${i} of ${records.length}`,
                `"${record.localPath}" lost its last Zotero sync-root membership.\n\nWhat do you want to do?`,
                labels,
                out,
            );
            if (!ok) break;
            const choice = ACTIONS[out.value];
            if (!choice || !choice.key) continue;

            let opts = {};
            if (choice.key === resolver.COLLECTION_RESOLUTION_ACTION.MOVE_OUTSIDE) {
                const fp = new FilePicker();
                fp.init(window, 'Pick destination folder (outside watch folder)', fp.modeGetFolder);
                const fpResult = await fp.show();
                if (fpResult !== fp.returnOK) continue;
                opts.targetDir = (fp.file && typeof fp.file === 'object' && fp.file.path)
                    ? fp.file.path
                    : String(fp.file);
            }

            try {
                const result = await resolver.resolveCollection(record, choice.key, opts);
                if (!result.ok) {
                    Services.prompt.alert(
                        window,
                        'Watch Folder',
                        `Failed to ${choice.label.toLowerCase()} for "${record.localPath}":\n${result.reason || ''}${result.error ? '\n' + result.error : ''}`,
                    );
                }
            } catch (e) {
                Services.prompt.alert(window, 'Watch Folder', `Error: ${e.message}`);
            }
        }
        refreshSuppressedDisplay();
        refreshWarningsDisplay();
    }

    /**
     * Iterate through conflict-blocked FileRecords (local hash drifted from
     * the baseline; mirrorExecutor's conflict gate flipped to CONFLICT_BLOCKED)
     * and ask the user how to resolve each. No targetDir needed — all three
     * actions are local-state flips on the tracking record.
     */
    async function resolveConflicts() {
        const resolver = Zotero.WatchFolder && Zotero.WatchFolder.suppressionResolver;
        if (!resolver) {
            Services.prompt.alert(window, 'Watch Folder', 'Suppression resolver not available — plugin not fully loaded?');
            return;
        }
        if (typeof resolver.resolveConflict !== 'function'
            || !resolver.CONFLICT_RESOLUTION_ACTION) {
            Services.prompt.alert(window, 'Watch Folder', 'Conflict resolution unavailable — plugin not fully loaded?');
            return;
        }
        const records = typeof resolver.listConflicted === 'function'
            ? resolver.listConflicted()
            : [];
        if (records.length === 0) {
            Services.prompt.alert(window, 'Watch Folder', 'No conflict-blocked items.');
            return;
        }

        const ACTIONS = [
            { label: 'Re-stamp baseline from current file (trust local edit)', key: resolver.CONFLICT_RESOLUTION_ACTION.RESTAMP_BASELINE },
            { label: 'Discard local edit (restore from Zotero)',               key: resolver.CONFLICT_RESOLUTION_ACTION.DISCARD_LOCAL },
            { label: 'Pause syncing this file',                                key: resolver.CONFLICT_RESOLUTION_ACTION.PAUSE_SYNC },
            { label: 'Skip for now',                                           key: null },
        ];
        const labels = ACTIONS.map((a) => a.label);

        let i = 0;
        for (const record of records) {
            i++;
            const out = {};
            const ok = Services.prompt.select(
                window,
                `Conflict-blocked item ${i} of ${records.length}`,
                `"${record.localPath}" has a local edit that diverged from the baseline hash.\n\nHow do you want to resolve it?`,
                labels,
                out,
            );
            if (!ok) break;
            const choice = ACTIONS[out.value];
            if (!choice || !choice.key) continue;

            try {
                const result = await resolver.resolveConflict(record, choice.key, {});
                if (!result.ok) {
                    Services.prompt.alert(
                        window,
                        'Watch Folder',
                        `Failed to ${choice.label.toLowerCase()} for "${record.localPath}":\n${result.reason || ''}${result.error ? '\n' + result.error : ''}`,
                    );
                }
            } catch (e) {
                Services.prompt.alert(window, 'Watch Folder', `Error: ${e.message}`);
            }
        }
        refreshConflictedDisplay();
        refreshWarningsDisplay();
    }

    /**
     * Refresh the mode picker (radiogroup) to match the stored pref.
     * Replaces the previous read-only display.
     */
    function refreshModeRadio() {
        const radio = document.getElementById('watch-folder-mode-radio');
        if (!radio) return;
        const mode = getPref('mode') || 'mode1';
        // Only valid modes set the radio; unknown values leave it cleared.
        if (mode === 'mode1' || mode === 'mode2' || mode === 'mode3') {
            radio.value = mode;
        }
    }

    /**
     * Confirm-and-apply on mode change. The radiogroup's oncommand fires
     * when the user clicks a different radio; we confirm before
     * persisting. Cancel reverts the visual selection.
     */
    function changeMode(newMode) {
        if (!newMode || (newMode !== 'mode1' && newMode !== 'mode2' && newMode !== 'mode3')) return;
        const current = getPref('mode') || 'mode1';
        if (newMode === current) return;

        const descriptions = {
            mode1: 'Import only — copy files in, never touch your Zotero collections from disk.',
            mode2: 'Mirror without delete — keep Zotero collections in sync with folder layout. Disk deletions warn-only.',
            mode3: 'Mirror with safe delete — also propagate deletions, with confirmations for bulk operations.',
        };
        const ok = Services.prompt.confirm(
            window,
            'Change sync mode?',
            `Switching from "${current}" to "${newMode}".\n\n${descriptions[newMode]}\n\n`
            + 'This changes how the plugin handles deletions and folder structure. '
            + 'Existing tracked items keep their state; the new mode applies to subsequent changes.\n\nContinue?'
        );
        if (!ok) {
            // Revert the visual selection.
            refreshModeRadio();
            return;
        }
        setPref('mode', newMode);
        Zotero.debug(`[Watch Folder] Mode changed via prefs UI: ${current} → ${newMode}`);
    }

    // ─── PDF storage strategy (orthogonal to sync mode) ───────────────────
    const STORAGE_STRATEGIES = ['stored', 'linked_watch_folder', 'stored_plus_mirror'];

    function _storageStrategyAPI() {
        return Zotero.WatchFolder && Zotero.WatchFolder.storageStrategy;
    }

    function getStorageStrategyPref() {
        const api = _storageStrategyAPI();
        if (api && typeof api.getStorageStrategy === 'function') return api.getStorageStrategy();
        return getPref('pdfStorageStrategy') || 'stored';
    }

    function refreshStorageStrategyUI() {
        const strategy = getStorageStrategyPref();
        const radio = document.getElementById('watch-folder-storage-radio');
        if (radio && STORAGE_STRATEGIES.includes(strategy)) radio.value = strategy;

        const api = _storageStrategyAPI();
        const which = (api && typeof api.buttonForStrategy === 'function')
            ? api.buttonForStrategy(strategy)
            : (strategy === 'linked_watch_folder' ? 'reclaim'
                : strategy === 'stored_plus_mirror' ? 'mirror' : null);
        const reclaimBtn = document.getElementById('watch-folder-storage-reclaim-btn');
        const mirrorBtn = document.getElementById('watch-folder-storage-mirror-btn');
        if (reclaimBtn) reclaimBtn.hidden = which !== 'reclaim';
        if (mirrorBtn) mirrorBtn.hidden = which !== 'mirror';

        const isLinked = strategy === 'linked_watch_folder';
        const warn = document.getElementById('watch-folder-storage-warning');
        const restore = document.getElementById('watch-folder-storage-restore');
        if (warn) warn.hidden = !isLinked;
        if (restore) restore.hidden = !isLinked;
    }

    function changeStorageStrategy(value) {
        if (!STORAGE_STRATEGIES.includes(value)) return;
        const current = getStorageStrategyPref();
        if (value === current) return;
        const labels = {
            stored: 'Store PDFs in Zotero',
            linked_watch_folder: 'Link PDFs from watch folder',
            stored_plus_mirror: 'Store in Zotero and mirror to watch folder',
        };
        const ok = Services.prompt.confirm(
            window,
            'Change PDF storage strategy?',
            `Switching to "${labels[value]}".\n\n`
            + 'This changes how NEWLY imported PDFs are stored. It does not move or convert your '
            + 'existing PDFs — use the conversion button below for that.\n\nContinue?'
        );
        if (!ok) { refreshStorageStrategyUI(); return; }
        setPref('pdfStorageStrategy', value);
        Zotero.debug(`[Watch Folder] PDF storage strategy changed: ${current} → ${value}`);
        refreshStorageStrategyUI();
    }

    async function reclaimStorage() {
        const api = _storageStrategyAPI();
        if (!api || typeof api.previewReclaim !== 'function') {
            Services.prompt.alert(window, 'Watch Folder', 'Storage tools not available — plugin not fully loaded?');
            return;
        }
        try {
            const preview = await api.previewReclaim();
            if (!preview.ok) {
                Services.prompt.alert(window, 'Reclaim Zotero Storage', 'Set up a watch folder and sync root first.');
                return;
            }
            const mb = (preview.totalBytes / (1024 * 1024)).toFixed(1);
            const note = api.RECLAIM_CONFIRM_NOTE
                || 'This moves PDF file storage out of Zotero. Zotero will still sync metadata, notes, and annotations.';
            const msg =
                `${preview.convertible.length} PDF(s) (~${mb} MB) can be converted to linked files in your watch folder.\n`
                + `${preview.keptStored.length} PDF(s) with Zotero annotations, notes, or unknown annotation status will be KEPT stored to protect your data.\n\n`
                + note + '\n\nConvert now?';
            const ok = Services.prompt.confirm(window, 'Reclaim Zotero Storage Space', msg);
            if (!ok) return;
            const result = await api.runReclaim({ apply: true });
            Services.prompt.alert(window, 'Reclaim complete',
                `Converted ${result.converted} PDF(s) to linked files.\n`
                + `Kept ${result.keptStored} stored (had highlights/notes).\n`
                + (result.failed ? `${result.failed} could not be verified and were left stored.\n` : '')
                + 'The old stored copies are in Zotero’s trash — empty it once you’ve confirmed everything looks right.');
            refreshStorageStrategyUI();
        } catch (e) {
            Services.prompt.alert(window, 'Watch Folder', `Reclaim failed: ${e?.message ?? e}`);
        }
    }

    async function buildRepairMirror() {
        const api = _storageStrategyAPI();
        if (!api || typeof api.previewMirror !== 'function') {
            Services.prompt.alert(window, 'Watch Folder', 'Storage tools not available — plugin not fully loaded?');
            return;
        }
        try {
            const preview = await api.previewMirror();
            if (!preview.ok) {
                Services.prompt.alert(window, 'Build/Repair Mirror', 'Set up a watch folder and sync root first.');
                return;
            }
            const ok = Services.prompt.confirm(window, 'Build/Repair Watch Folder Mirror',
                `${preview.copies} PDF(s) would be copied to your watch folder. `
                + 'Your Zotero stored attachments stay exactly as they are.\n\nContinue?');
            if (!ok) return;
            const result = await api.runMirror();
            Services.prompt.alert(window, 'Mirror complete',
                `Copied ${result.copies} PDF(s) to the watch folder`
                + (result.errors ? `, ${result.errors} error(s).` : '.'));
        } catch (e) {
            Services.prompt.alert(window, 'Watch Folder', `Build/Repair failed: ${e?.message ?? e}`);
        }
    }

    /**
     * Toggle the Advanced section's visibility + caret arrow.
     */
    function toggleAdvanced() {
        const body = document.getElementById('watch-folder-advanced-body');
        const caret = document.getElementById('watch-folder-advanced-caret');
        if (!body || !caret) return;
        body.hidden = !body.hidden;
        caret.value = body.hidden ? '▸' : '▾';
    }

    /**
     * Open one of the bundled HTML user-docs in the user's default
     * browser. Strategy:
     *   1. Extract all three pages from the chrome:// resource (inside
     *      the JAR'd XPI) to a real filesystem path under Zotero's
     *      data dir on first use. Overwrites every session so plugin
     *      updates bring fresh docs along.
     *   2. Hand the resulting `file://` URL to Zotero.launchURL, which
     *      routes through the OS external-protocol handler and opens
     *      in the user's default browser (Firefox, Chrome, etc).
     *
     * Why not Zotero.openInViewer (which DID accept the chrome URL):
     * the basicViewer intercepts every in-page link click and prompts
     * "Open in external application?" before doing anything — and the
     * follow-through is unreliable. Cross-page navigation between
     * index.html / test-plan.html / test-cases.html breaks. The OS
     * default browser handles all of this natively.
     *
     * Why not Zotero.launchURL on chrome:// directly: launchURL only
     * accepts http/https/file/mailto for safety. chrome:// is rejected.
     */
    async function _ensureDocsExtracted() {
        const destDir = PathUtils.join(Zotero.DataDirectory.dir, 'watch-folder-docs');
        await IOUtils.makeDirectory(destDir, { ignoreExisting: true });
        const pages = ['index.html', 'test-plan.html', 'test-cases.html'];
        for (const page of pages) {
            const src = `chrome://zotero-watch-folder/content/docs/${page}`;
            const dest = PathUtils.join(destDir, page);
            try {
                const r = await fetch(src);
                if (!r.ok) continue;
                const text = await r.text();
                await IOUtils.writeUTF8(dest, text);
            } catch (e) {
                Zotero.debug(`[Watch Folder] Could not extract ${page}: ${e?.message ?? e}`);
            }
        }
        return destDir;
    }

    async function openDocs(which) {
        const map = {
            'index': 'index.html',
            'test-plan': 'test-plan.html',
            'test-cases': 'test-cases.html',
        };
        const fileName = map[which];
        if (!fileName) return;
        try {
            const destDir = await _ensureDocsExtracted();
            const localPath = PathUtils.join(destDir, fileName);
            // nsIFile.launch() asks the OS to open the file with its
            // default handler — for .html that's the user's default
            // browser (Firefox, Chrome, etc), not Zotero's basicViewer.
            // We tried Zotero.launchURL(file://...) but it refuses
            // file scheme. We tried Zotero.openInViewer(chrome://...)
            // but its basicViewer prompts on every link click and
            // doesn't follow cross-page navigation. nsIFile.launch is
            // the cross-platform Mozilla primitive that just works.
            const nsIFile = Components.classes['@mozilla.org/file/local;1']
                .createInstance(Components.interfaces.nsIFile);
            nsIFile.initWithPath(localPath);
            nsIFile.launch();
        } catch (e) {
            Services.prompt.alert(window, 'Watch Folder',
                `Could not open documentation: ${e?.message ?? e}`);
        }
    }

    /**
     * Open the standalone Smart Rules editor window. Keeps the JSON
     * textarea + Save/Insert-example/Reload controls out of the main
     * prefs pane (those controls only matter to power users).
     */
    function openSmartRulesEditor() {
        try {
            const url = 'chrome://zotero-watch-folder/content/smartRulesEditor.xhtml';
            // Reuse existing window if one is open.
            const existing = Services.wm.getMostRecentWindow('watch-folder-smart-rules');
            if (existing) { existing.focus(); return; }
            window.openDialog(url, 'watch-folder-smart-rules',
                'chrome,centerscreen,resizable=yes,dialog=no');
        } catch (e) {
            Services.prompt.alert(window, 'Watch Folder',
                `Could not open Smart Rules editor: ${e.message}`);
        }
    }

    /**
     * Open a collection picker over the user library and store the chosen
     * collection's key as `syncRootCollectionKey`. Skips Zotero virtual
     * collections (Duplicates, Unfiled, Trash, etc.).
     *
     * Uses Services.prompt.select for the picker — not pretty, but it's
     * the only UI primitive that doesn't require shipping a separate XUL
     * dialog from this prefs pane. The full setup-wizard (Phase C1) will
     * eventually replace this with a proper tree.
     */
    async function pickSyncRoot() {
        const libraryID = Zotero.Libraries.userLibraryID;
        let collections;
        try {
            collections = Zotero.Collections.getByLibrary(libraryID) || [];
        } catch (e) {
            Services.prompt.alert(window, 'Watch Folder',
                `Could not enumerate collections: ${e.message}`);
            return;
        }
        // Build sorted, path-labeled options. Skip virtual collections.
        const usable = collections
            .filter(c => !c.isVirtual)
            .map(c => ({ key: c.key, label: collectionDisplayPath(c) }))
            .sort((a, b) => a.label.localeCompare(b.label));
        if (usable.length === 0) {
            Services.prompt.alert(window, 'Watch Folder',
                'No collections found in your library. Create one in Zotero first, then come back.');
            return;
        }
        const labels = usable.map(u => u.label);
        const out = {};
        const ok = Services.prompt.select(
            window,
            'Pick sync root collection',
            'Files added to your watch folder will be imported into the collection you pick here. Subfolders on disk become subcollections under this root.',
            labels,
            out
        );
        if (!ok) return;
        const chosen = usable[out.value];
        if (!chosen) return;
        setPref('syncRootCollectionKey', chosen.key);
        setPref('syncRootLibraryID', libraryID);
        // Mark the C1 first-run nudge handled — the user has completed
        // the minimum-viable setup. The full Phase C1 wizard will
        // eventually own this too.
        setPref('setupCompleted', true);
        refreshSyncRootDisplay();
        Zotero.debug(`[Watch Folder] Sync root set to ${chosen.label} (key=${chosen.key})`);
    }

    /**
     * Open folder picker and write the chosen path to the preference + UI.
     * Exposed on window so the XHTML oncommand="WatchFolderPrefs.browseForFolder()"
     * attribute can reach it (oncommand evals in window scope, not the sandbox).
     */
    async function browseForFolder() {
        const fp = new FilePicker();
        fp.init(window, Zotero.getString('dataDir.selectDir'), fp.modeGetFolder);

        const currentPath = getPref('sourcePath');
        if (currentPath) {
            try { fp.displayDirectory = currentPath; } catch (_) {}
        }

        const result = await fp.show();
        if (result === fp.returnOK) {
            const selectedPath = fp.file;
            if (selectedPath) {
                setPref('sourcePath', selectedPath);
                const pathInput = document.getElementById('watch-folder-source-path');
                if (pathInput) pathInput.value = selectedPath;
                Zotero.debug(`[Watch Folder] Source path set to: ${selectedPath}`);
            }
        }
    }

    async function validateSourcePath(path) {
        if (!path) return false;
        try {
            const info = await IOUtils.stat(path);
            return info.type === "directory";
        } catch (e) {
            Zotero.debug(`[Watch Folder] Path validation error: ${e.message}`);
            return false;
        }
    }

    /**
     * Extra validation on the enable checkbox: reject enable if no valid path.
     * Listens to 'command' (same event Zotero's pref binding uses), then
     * reverts both the UI and the pref if the path is invalid.
     */
    async function handleEnableCommand(event) {
        const checkbox = event.target;
        if (!checkbox.checked) return; // disabling is always OK

        const sourcePath = getPref('sourcePath');
        const isValid = await validateSourcePath(sourcePath);
        if (!isValid) {
            checkbox.checked = false;
            setPref('enabled', false);
            Services.prompt.alert(
                window,
                'Watch Folder',
                'Please select a valid watch folder before enabling.'
            );
        }
    }

    /**
     * Refresh the trashed-folders row count. Reads from
     * `Zotero.WatchFolder.suppressionResolver.listTrashedFolders()` which
     * lists top-level dirs inside `.zotero-watch-trash/` (folders that
     * mirrorExecutor.deleteFolder moved out of the watch root in Mode 3).
     */
    async function refreshTrashedFoldersDisplay() {
        const row = document.getElementById('watch-folder-trashed-folders-row');
        const countEl = document.getElementById('watch-folder-trashed-folders-count');
        if (!row || !countEl) return;
        const resolver = Zotero.WatchFolder && Zotero.WatchFolder.suppressionResolver;
        let entries = [];
        if (resolver && typeof resolver.listTrashedFolders === 'function') {
            try { entries = await resolver.listTrashedFolders(); }
            catch (_e) { entries = []; }
        }
        countEl.value = String(entries.length);
        row.hidden = entries.length === 0;
    }

    /**
     * Iterate trashed folders and offer Restore / Skip per entry.
     * Restore moves the dir back to its original sync-root-relative path
     * (RST.6 collision suffix on the target side) and re-creates the
     * Zotero collection chain via `relativePathToCollection({
     * createIfMissing: true })`. The next scan cycle picks up the
     * contained files and imports them.
     */
    async function restoreTrashedFolders() {
        const resolver = Zotero.WatchFolder && Zotero.WatchFolder.suppressionResolver;
        if (!resolver || typeof resolver.listTrashedFolders !== 'function') {
            Services.prompt.alert(window, 'Watch Folder', 'Folder restore unavailable — plugin not fully loaded?');
            return;
        }
        let entries = [];
        try { entries = await resolver.listTrashedFolders(); }
        catch (e) {
            Services.prompt.alert(window, 'Watch Folder', `Could not list trashed folders: ${e.message}`);
            return;
        }
        if (entries.length === 0) {
            Services.prompt.alert(window, 'Watch Folder', 'No trashed folders.');
            return;
        }

        const ACTIONS = [
            { label: 'Restore to sync root', key: 'restore' },
            { label: 'Skip for now',         key: null },
        ];
        const labels = ACTIONS.map(a => a.label);

        let i = 0;
        for (const entry of entries) {
            i++;
            const out = {};
            const ok = Services.prompt.select(
                window,
                `Trashed folder ${i} of ${entries.length}`,
                `"${entry.name}" is in the plugin trash.\n\nRestore it to "${entry.originalName}" under the sync root?`,
                labels,
                out,
            );
            if (!ok) break;
            const choice = ACTIONS[out.value];
            if (!choice || !choice.key) continue;
            try {
                const result = await resolver.restoreTrashedFolder(entry);
                if (!result.ok) {
                    Services.prompt.alert(
                        window,
                        'Watch Folder',
                        `Failed to restore "${entry.name}": ${result.reason || ''}${result.error ? '\n' + result.error : ''}`,
                    );
                } else if (result.warning) {
                    Services.prompt.alert(
                        window,
                        'Watch Folder',
                        `Restored to "${result.restoredTo}". Warning: ${result.warning}`,
                    );
                }
            } catch (e) {
                Services.prompt.alert(window, 'Watch Folder', `Error: ${e.message}`);
            }
        }
        await refreshTrashedFoldersDisplay();
    }

    /**
     * Load the current `smartRules` pref into the editor textarea. Pretty-
     * printed for human editing; saved back compacted by the engine.
     */
    function reloadSmartRules() {
        const editor = document.getElementById('watch-folder-smart-rules-editor');
        if (!editor) return;
        const raw = getPref('smartRules') || '[]';
        try {
            editor.value = JSON.stringify(JSON.parse(raw), null, 2);
        } catch (_e) {
            // Pref holds invalid JSON — show as-is so the user can fix it.
            editor.value = raw;
        }
    }

    /**
     * Validate the textarea contents (parse + per-rule shape check) and
     * persist to the pref on success. Rejects with an alert on parse or
     * structural errors.
     */
    function saveSmartRules() {
        const editor = document.getElementById('watch-folder-smart-rules-editor');
        if (!editor) return;
        let parsed;
        try {
            parsed = JSON.parse(editor.value);
        } catch (e) {
            Services.prompt.alert(window, 'Watch Folder', `Invalid JSON: ${e.message}`);
            return;
        }
        if (!Array.isArray(parsed)) {
            Services.prompt.alert(window, 'Watch Folder', 'Top-level value must be an array of rule objects.');
            return;
        }
        // Mirror the engine's `_validateRule` shape check so users hear about
        // problems here rather than silently losing rules at engine load.
        for (let i = 0; i < parsed.length; i++) {
            const r = parsed[i];
            if (!r || typeof r !== 'object') {
                Services.prompt.alert(window, 'Watch Folder', `Rule ${i + 1}: not an object.`);
                return;
            }
            if (!r.id || !r.name) {
                Services.prompt.alert(window, 'Watch Folder', `Rule ${i + 1}: missing required field "id" or "name".`);
                return;
            }
            if (!Array.isArray(r.conditions) || !Array.isArray(r.actions)) {
                Services.prompt.alert(window, 'Watch Folder', `Rule ${i + 1} (${r.id}): conditions and actions must both be arrays.`);
                return;
            }
            if (r.actions.length === 0) {
                Services.prompt.alert(window, 'Watch Folder', `Rule ${i + 1} (${r.id}): at least one action is required.`);
                return;
            }
        }
        setPref('smartRules', JSON.stringify(parsed));
        // Pretty-print on success so editing continues to be readable.
        editor.value = JSON.stringify(parsed, null, 2);
        Services.prompt.alert(window, 'Watch Folder', `Saved ${parsed.length} rule(s).`);
    }

    /**
     * Append a starter rule template to the editor so the user has a
     * concrete shape to edit. Doesn't save — the user reviews + presses
     * Save themselves.
     */
    function insertSmartRuleExample() {
        const editor = document.getElementById('watch-folder-smart-rules-editor');
        if (!editor) return;
        let existing;
        try { existing = JSON.parse(editor.value || '[]'); }
        catch (_e) { existing = []; }
        if (!Array.isArray(existing)) existing = [];
        existing.push({
            id: 'example-' + Date.now(),
            name: 'Example: tag PDFs with DOI as "_has-doi"',
            enabled: true,
            priority: 0,
            stopOnMatch: false,
            conditions: [{ field: 'DOI', operator: 'isNotEmpty', value: '' }],
            actions: [{ type: 'addTag', tag: '_has-doi' }],
        });
        editor.value = JSON.stringify(existing, null, 2);
    }

    /**
     * Called after Zotero inserts and translates the pane fragment.
     * At this point all elements with id="watch-folder-*" exist in the DOM.
     */
    function init() {
        try {
            Zotero.debug('[Watch Folder] Initializing preferences panel');

            // Enable checkbox — extra path-validation on top of the pref binding
            const enableCheckbox = document.getElementById('watch-folder-enabled');
            if (enableCheckbox) {
                enableCheckbox.addEventListener('command', handleEnableCommand);
            }

            // Populate the read-only path display (the pref binding handles saving,
            // but the <input readonly> won't show the saved value without this).
            const pathInput = document.getElementById('watch-folder-source-path');
            if (pathInput) {
                const currentPath = getPref('sourcePath');
                if (currentPath) pathInput.value = currentPath;
            }

            // Sync-root + mode displays — v2.
            refreshSyncRootDisplay();
            refreshModeRadio();
            refreshStorageStrategyUI();
            refreshWarningsDisplay();
            refreshSuppressedDisplay();
            refreshConflictedDisplay();
            refreshTrashedFoldersDisplay();

            Zotero.debug('[Watch Folder] Preferences panel initialized successfully');
        } catch (e) {
            Zotero.logError(`[Watch Folder] Preferences init error: ${e.message}`);
        }
    }

    /**
     * Re-run the setup wizard from the prefs pane. Delegates to the
     * bundle's runSetupWizard (re-exported via Zotero.WatchFolder), so
     * the same multi-step flow used at first-run is reused here. After
     * the wizard returns, refresh the sync-root + mode displays.
     */
    async function runSetupWizard() {
        const fn = Zotero.WatchFolder && Zotero.WatchFolder.runSetupWizard;
        if (typeof fn !== 'function') {
            Services.prompt.alert(window, 'Watch Folder', 'Setup wizard not available — plugin not fully loaded?');
            return;
        }
        try {
            await fn(window);
        } catch (e) {
            Services.prompt.alert(window, 'Watch Folder', `Wizard error: ${e.message}`);
        }
        refreshSyncRootDisplay();
        refreshModeRadio();
        refreshStorageStrategyUI();
    }

    // Expose to window so oncommand attributes in the XHTML can reach these.
    window.WatchFolderPrefs = {
        browseForFolder,
        pickSyncRoot,
        viewWarnings,
        clearWarnings,
        resolveSuppressed,
        resolveSuppressedFolders,
        resolveConflicts,
        restoreTrashedFolders,
        runSetupWizard,
        // v2.5: new live mode picker + advanced disclosure + bundled docs + smart rules window.
        changeMode,
        toggleAdvanced,
        openDocs,
        openSmartRulesEditor,
        // PDF storage strategy + conversion tools.
        changeStorageStrategy,
        reclaimStorage,
        buildRepairMirror,
        onLoad: init,
    };

    // The script runs before Zotero inserts our XHTML fragment, so we cannot call
    // getElementById yet. Zotero dispatches a synthetic 'load' event on each top-level
    // child of the pane container after insertion + translation. We listen in capture
    // phase so we catch it on the way down to our <vbox id="watch-folder-preferences">.
    document.addEventListener('load', function onPaneLoad(e) {
        if (e.target && e.target.id === 'watch-folder-preferences') {
            document.removeEventListener('load', onPaneLoad, true);
            init();
        }
    }, true);

})();
