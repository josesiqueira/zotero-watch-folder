/**
 * Zotero Watch Folder - Preferences Panel Script
 * Handles preference UI interactions for Zotero 8
 */

(function() {
    'use strict';

    const { FilePicker } = ChromeUtils.importESModule(
        'chrome://zotero/content/modules/filePicker.mjs'
    );

    const PREF_PREFIX = 'extensions.zotero.watchFolder.';

    /**
     * Get a preference value
     * @param {string} name - Preference name without prefix
     * @returns {*} Preference value
     */
    function getPref(name) {
        return Zotero.Prefs.get(PREF_PREFIX + name, true);
    }

    /**
     * Set a preference value
     * @param {string} name - Preference name without prefix
     * @param {*} value - Value to set
     */
    function setPref(name, value) {
        Zotero.Prefs.set(PREF_PREFIX + name, value, true);
    }

    /**
     * Open folder picker dialog and update source path
     */
    async function browseForFolder() {
        const fp = new FilePicker();
        fp.init(window, Zotero.getString('dataDir.selectDir'), fp.modeGetFolder);

        // Set initial directory to current source path if it exists
        const currentPath = getPref('sourcePath');
        if (currentPath) {
            try {
                fp.displayDirectory = currentPath;
            } catch (e) {
                // Ignore if path doesn't exist
            }
        }

        const result = await fp.show();

        if (result === fp.returnOK) {
            const selectedPath = fp.file;
            if (selectedPath) {
                // Update the preference
                setPref('sourcePath', selectedPath);

                // Update the text input display
                const pathInput = document.getElementById('watch-folder-source-path');
                if (pathInput) {
                    pathInput.value = selectedPath;
                }

                Zotero.debug(`[Watch Folder] Source path set to: ${selectedPath}`);
            }
        }
    }

    /**
     * Validate that the source folder exists
     * @param {string} path - Path to validate
     * @returns {Promise<boolean>} True if path exists and is a directory
     */
    async function validateSourcePath(path) {
        if (!path) {
            return false;
        }

        try {
            const file = Zotero.File.pathToFile(path);
            return file.exists() && file.isDirectory();
        } catch (e) {
            Zotero.debug(`[Watch Folder] Path validation error: ${e.message}`);
            return false;
        }
    }

    /**
     * Handle enable checkbox change
     * Validates that a valid source folder is configured before enabling
     */
    async function handleEnableChange(event) {
        const checkbox = event.target;
        const isEnabled = checkbox.checked;

        if (isEnabled) {
            const sourcePath = getPref('sourcePath');
            const isValid = await validateSourcePath(sourcePath);

            if (!isValid) {
                // Prevent enabling without valid path
                checkbox.checked = false;
                setPref('enabled', false);

                // Show alert to user
                const promptService = Services.prompt;
                promptService.alert(
                    window,
                    'Watch Folder',
                    Zotero.getString('general.error') + ': ' +
                    'Please select a valid watch folder before enabling.'
                );

                return;
            }
        }

        setPref('enabled', isEnabled);
        Zotero.debug(`[Watch Folder] Watch folder ${isEnabled ? 'enabled' : 'disabled'}`);
    }

    /**
     * Initialize preferences panel
     */
    function init() {
        // Wire up browse button
        const browseBtn = document.getElementById('watch-folder-browse-btn');
        if (browseBtn) {
            browseBtn.addEventListener('click', browseForFolder);
        }

        // Wire up enable checkbox validation
        const enableCheckbox = document.getElementById('watch-folder-enabled');
        if (enableCheckbox) {
            enableCheckbox.addEventListener('change', handleEnableChange);
        }

        // Load current source path into display
        const pathInput = document.getElementById('watch-folder-source-path');
        if (pathInput) {
            const currentPath = getPref('sourcePath');
            if (currentPath) {
                pathInput.value = currentPath;
            }
        }

        Zotero.debug('[Watch Folder] Preferences panel initialized');
    }

    // Initialize when document is ready
    if (document.readyState === 'complete') {
        init();
    } else {
        window.addEventListener('load', init);
    }

})();
