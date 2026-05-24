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
     * Refresh the mode display ("Mode 1 — Import only", etc.).
     */
    function refreshModeDisplay() {
        const display = document.getElementById('watch-folder-mode-display');
        if (!display) return;
        const mode = getPref('mode') || 'mode1';
        const labels = {
            mode1: 'Mode 1 — Import only (active)',
            mode2: 'Mode 2 — Mirror without delete (v2.1, not yet active)',
            mode3: 'Mode 3 — Mirror with safe delete (v2.2, not yet active)',
        };
        display.value = labels[mode] || `Unknown mode: ${mode}`;
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
            refreshModeDisplay();
            refreshWarningsDisplay();
            refreshSuppressedDisplay();
            refreshConflictedDisplay();

            Zotero.debug('[Watch Folder] Preferences panel initialized successfully');
        } catch (e) {
            Zotero.logError(`[Watch Folder] Preferences init error: ${e.message}`);
        }
    }

    // Expose to window so oncommand attributes in the XHTML can reach these.
    window.WatchFolderPrefs = {
        browseForFolder,
        pickSyncRoot,
        viewWarnings,
        clearWarnings,
        resolveSuppressed,
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
