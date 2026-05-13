/**
 * First Run Handler Module for Zotero Watch Folder Plugin
 *
 * Detects first run conditions and prompts users to import existing files
 * when the plugin is first enabled or when the watch folder path changes.
 */

import { getPref, setPref } from './utils.mjs';
import { scanFolder, scanFolderRecursive } from './fileScanner.mjs';
import { importBatch } from './fileImporter.mjs';
import { getTrackingStore } from './trackingStore.mjs';

// Preference key to track last watched path
const PREF_LAST_PATH = 'lastWatchedPath';

/**
 * Check if this is a first run condition
 *
 * First run is detected when:
 * - No tracking data exists (fresh install)
 * - Watch folder path has changed
 * - User explicitly requests re-scan (via resetFirstRunState)
 *
 * @returns {Promise<{isFirstRun: boolean, reason: string}>} First run status and reason
 */
export async function checkFirstRun() {
  const currentPath = getPref('sourcePath');
  const lastPath = getPref(PREF_LAST_PATH);
  const trackingStore = getTrackingStore();

  // No path configured - nothing to do
  if (!currentPath) {
    return { isFirstRun: false, reason: 'no_path' };
  }

  // Path changed from previous configuration
  if (lastPath && lastPath !== currentPath) {
    return { isFirstRun: true, reason: 'path_changed' };
  }

  // No tracking data (fresh install or cleared)
  const stats = trackingStore.getStats();
  if (!lastPath && stats.total === 0) {
    return { isFirstRun: true, reason: 'fresh_install' };
  }

  return { isFirstRun: false, reason: 'normal' };
}

/**
 * Get count of existing files in the watch folder
 *
 * Scans the configured watch folder and returns file information.
 *
 * @returns {Promise<{count: number, files: Array}>} File count and file list
 */
export async function getExistingFilesCount() {
  const sourcePath = getPref('sourcePath');
  if (!sourcePath) {
    return { count: 0, files: [] };
  }

  try {
    const files = await scanFolderRecursive(sourcePath);
    return { count: files.length, files };
  } catch (error) {
    Zotero.debug(`[WatchFolder] Error scanning for existing files: ${error.message}`);
    return { count: 0, files: [] };
  }
}

/**
 * Show first run prompt to user
 *
 * Displays a dialog asking the user what to do with existing files:
 * - Import All: Import all existing files into Zotero
 * - Skip: Mark first run as complete without importing
 * - Cancel: Do nothing and check again next time
 *
 * @param {Window} window - Parent window for dialog
 * @param {number} fileCount - Number of files found
 * @returns {Promise<'import'|'skip'|'cancel'>} User's choice
 */
export async function showFirstRunPrompt(window, fileCount) {
  const promptService = Services.prompt;

  // Get localized strings (fallback to English if not available)
  let title = 'Existing Files Detected';
  let message = `Found ${fileCount} file(s) in the watch folder. Would you like to import them?`;

  try {
    title = await window.document.l10n.formatValue('watch-folder-first-run-title');
    message = await window.document.l10n.formatValue('watch-folder-first-run-message', { count: fileCount });
  } catch (e) {
    // Use fallback strings if localization fails
  }

  // Configure dialog buttons
  const flags = promptService.BUTTON_POS_0 * promptService.BUTTON_TITLE_IS_STRING +
                promptService.BUTTON_POS_1 * promptService.BUTTON_TITLE_IS_STRING +
                promptService.BUTTON_POS_2 * promptService.BUTTON_TITLE_CANCEL;

  const result = promptService.confirmEx(
    window,
    title,
    message,
    flags,
    'Import All',  // Button 0
    'Skip',        // Button 1
    null,          // Button 2 (Cancel)
    null,          // Checkbox label
    {}             // Checkbox state
  );

  switch (result) {
    case 0: return 'import';
    case 1: return 'skip';
    default: return 'cancel';
  }
}

/**
 * Import existing files with progress dialog
 *
 * Shows a progress window while importing files and provides feedback
 * on the number of successful and failed imports.
 *
 * @param {Window} window - Parent window
 * @param {Array} files - Files to import (from scanFolder)
 * @returns {Promise<{imported: number, failed: number, cancelled: boolean}>} Import results
 */
export async function importExistingFiles(window, files) {
  if (!files || files.length === 0) {
    return { imported: 0, failed: 0, cancelled: false };
  }

  // Create progress window
  const progressWin = new Zotero.ProgressWindow({
    closeOnClick: false
  });
  progressWin.changeHeadline('Importing Watch Folder Files');
  progressWin.addDescription(`Importing ${files.length} file(s)...`);

  const itemProgress = new progressWin.ItemProgress(
    'chrome://zotero/skin/spinner-16px.png',
    `0 / ${files.length}`
  );
  progressWin.show();

  let cancelled = false;

  const sourcePath = getPref('sourcePath');
  const baseTarget = getPref('targetCollection') || 'Inbox';

  // Extract file paths and collections from file objects
  const filesToImport = files.map(f => {
    let collection = baseTarget;
    if (f.path.startsWith(sourcePath)) {
        let relative = f.path.substring(sourcePath.length);
        if (relative.startsWith('/') || relative.startsWith('\\')) relative = relative.substring(1);
        const parts = relative.split(/[/\\]/);
        parts.pop(); // filename
        if (parts.length > 0) {
            collection = baseTarget + '/' + parts.join('/');
        }
    }
    return { path: f.path, collection };
  });

  // Import with progress callback
  const results = await importBatch(filesToImport, {
    onProgress: (current, total) => {
      if (cancelled) return;
      itemProgress.setText(`${current} / ${total}`);
      itemProgress.setProgress((current / total) * 100);
    },
    delayBetween: 300  // Slightly faster for batch imports
  });

  // Update progress window with final results
  itemProgress.setProgress(100);
  if (results.failed.length > 0) {
    itemProgress.setIcon('chrome://zotero/skin/cross.png');
    itemProgress.setText(`Imported ${results.success.length}, Failed ${results.failed.length}`);
  } else {
    itemProgress.setIcon('chrome://zotero/skin/tick.png');
    itemProgress.setText(`Imported ${results.success.length} file(s)`);
  }

  // Auto-close progress window after delay
  progressWin.startCloseTimer(4000);

  return {
    imported: results.success.length,
    failed: results.failed.length,
    cancelled
  };
}

/**
 * Handle the full first run flow
 *
 * Main entry point for first run handling. Checks if first run,
 * scans for existing files, prompts user, and imports if requested.
 *
 * @param {Window} window - Parent window
 * @returns {Promise<{handled: boolean, imported: number}>} Whether first run was handled and import count
 */
export async function handleFirstRun(window) {
  // Check if this is a first run condition
  const { isFirstRun, reason } = await checkFirstRun();

  if (!isFirstRun) {
    return { handled: false, imported: 0 };
  }

  Zotero.debug(`[WatchFolder] First run detected (reason: ${reason})`);

  // Get existing files in watch folder
  const { count, files } = await getExistingFilesCount();

  if (count === 0) {
    // No files to import, just mark as handled
    await markFirstRunComplete();
    return { handled: true, imported: 0 };
  }

  // Show prompt to user
  const choice = await showFirstRunPrompt(window, count);

  if (choice === 'cancel') {
    // User cancelled - don't mark as complete, check again next time
    return { handled: false, imported: 0 };
  }

  if (choice === 'skip') {
    // User chose to skip - mark as complete without importing
    await markFirstRunComplete();
    return { handled: true, imported: 0 };
  }

  // Import files
  const results = await importExistingFiles(window, files);

  // Mark first run complete
  await markFirstRunComplete();

  return {
    handled: true,
    imported: results.imported
  };
}

/**
 * Mark first run as complete
 *
 * Saves the current watch folder path to preferences so subsequent
 * runs don't trigger the first run flow.
 *
 * @private
 */
async function markFirstRunComplete() {
  const currentPath = getPref('sourcePath');
  if (currentPath) {
    setPref(PREF_LAST_PATH, currentPath);
  }
  Zotero.debug('[WatchFolder] First run marked complete');
}

/**
 * Reset first run state
 *
 * Clears the saved path so the next startup will trigger first run detection.
 * Useful for testing or when user explicitly requests a re-scan.
 */
export function resetFirstRunState() {
  setPref(PREF_LAST_PATH, '');
  Zotero.debug('[WatchFolder] First run state reset');
}

/**
 * Force re-scan of existing files (user-triggered)
 *
 * Resets the first run state and immediately triggers the first run flow.
 * Can be called from a menu item or preferences panel.
 *
 * @param {Window} window - Parent window
 * @returns {Promise<{handled: boolean, imported: number}>} Result of first run handling
 */
export async function rescanExistingFiles(window) {
  resetFirstRunState();
  return handleFirstRun(window);
}
