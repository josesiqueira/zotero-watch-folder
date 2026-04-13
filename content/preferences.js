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

            Zotero.debug('[Watch Folder] Preferences panel initialized successfully');
        } catch (e) {
            Zotero.logError(`[Watch Folder] Preferences init error: ${e.message}`);
        }
    }

    // Expose to window so oncommand attributes in the XHTML can reach browseForFolder.
    window.WatchFolderPrefs = { 
        browseForFolder,
        onLoad: init
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
