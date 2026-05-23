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

            Zotero.debug('[Watch Folder] Preferences panel initialized successfully');
        } catch (e) {
            Zotero.logError(`[Watch Folder] Preferences init error: ${e.message}`);
        }
    }

    // Expose to window so oncommand attributes in the XHTML can reach these.
    window.WatchFolderPrefs = {
        browseForFolder,
        pickSyncRoot,
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
