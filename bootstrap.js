/**
 * Zotero Watch Folder - Bootstrap Entry Point
 * Loads bundled script for Zotero 7/8 compatibility.
 */

var chromeHandle;

function install(data, reason) {}

async function startup({ id, version, resourceURI, rootURI }, reason) {
  // Chrome must be registered before awaiting, so preference panes and
  // chrome:// URLs resolve correctly when Zotero initialises.
  var aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  var manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "zotero-watch-folder", rootURI + "content/"],
    ["locale",  "zotero-watch-folder", "en-US", rootURI + "locale/en-US/"]
  ]);

  await Zotero.initializationPromise;

  // Set default preferences so Zotero.Prefs.get() works before the user
  // has opened the pref pane (prefs.js at XPI root is not auto-loaded).
  _initDefaultPrefs();

  // v2.7 migration: the scopeMode default flipped to 'library' (whole-library
  // mirror). An existing collection-scoped install has NO user-branch scopeMode
  // value, so it would silently read the new default and ESCALATE its delete
  // blast radius from one sync-root subtree to the entire library — exactly the
  // catastrophe the whole safety layer guards against. Pin such installs to
  // 'collection' on the USER branch so the upgrade NEVER changes their behavior.
  // New installs (no configured sync root yet) are untouched and get 'library'.
  // The pref-pane / wizard surfaces the opt-in switch to whole-library mode.
  _migrateScopeModeForExistingInstall();

  // Load the esbuild bundle into the Zotero global scope.
  // rootURI already ends with "/", so do NOT add another slash.
  const ctx = { rootURI };
  ctx._globalThis = ctx;

  try {
    Services.scriptloader.loadSubScript(
      rootURI + "content/scripts/watchFolder.js",
      ctx
    );
  } catch (e) {
    Zotero.logError(`[WatchFolder] Failed to load bundle: ${e}`);
    return;
  }

  if (!Zotero.WatchFolder || !Zotero.WatchFolder.hooks) {
    Zotero.logError("[WatchFolder] Bundle loaded but Zotero.WatchFolder not set — aborting startup.");
    return;
  }

  // Set _rootURI BEFORE calling onStartup() so preference pane registration works
  Zotero.WatchFolder.hooks._rootURI = rootURI;
  // Defensive: an uncaught rejection here would wedge plugin init with no log.
  try {
    await Zotero.WatchFolder.hooks.onStartup();
  } catch (e) {
    Zotero.logError("[WatchFolder] onStartup failed: " + (e && e.message ? e.message : e));
  }
}

async function onMainWindowLoad({ window }, reason) {
  if (Zotero.WatchFolder && Zotero.WatchFolder.hooks) {
    await Zotero.WatchFolder.hooks.onMainWindowLoad(window);
  }
}

async function onMainWindowUnload({ window }, reason) {
  if (Zotero.WatchFolder && Zotero.WatchFolder.hooks) {
    await Zotero.WatchFolder.hooks.onMainWindowUnload(window);
  }
}

async function shutdown({ id, version, resourceURI, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) return;

  if (Zotero.WatchFolder && Zotero.WatchFolder.hooks) {
    // Wrap so a shutdown throw can't skip the chrome cleanup below (which would
    // leak the chrome registration and block a clean reload/reinstall).
    try {
      await Zotero.WatchFolder.hooks.onShutdown();
    } catch (e) {
      Zotero.logError("[WatchFolder] onShutdown failed: " + (e && e.message ? e.message : e));
    }
  }

  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

function uninstall(data, reason) {}

// ---------------------------------------------------------------------------
// Default preferences  (canonical source of defaults at runtime — `prefs.js`
// at the XPI root is NOT auto-loaded by Zotero). MUST stay in sync with
// `prefs.js` — every `_set(...)` line below has a matching `pref(...)` line
// there, and vice versa.
// ---------------------------------------------------------------------------
function _initDefaultPrefs() {
  const branch = Services.prefs.getDefaultBranch("extensions.zotero.watchFolder.");
  function _set(key, val) {
    try {
      switch (typeof val) {
        case "boolean": branch.setBoolPref(key, val); break;
        case "number":  branch.setIntPref(key, val);  break;
        case "string":  branch.setCharPref(key, val); break;
      }
    } catch (_) {}
  }

  // Core watch settings
  _set("enabled",                false);
  _set("sourcePath",             "");
  _set("pollInterval",           5);
  _set("fileTypes",              "pdf");
  _set("importMode",             "stored"); // legacy — superseded by pdfStorageStrategy
  _set("pdfStorageStrategy",     "stored"); // "stored" | "linked_watch_folder" | "stored_plus_mirror"
  _set("postImportAction",       "leave");
  _set("autoRetrieveMetadata",   true);
  _set("diskDeleteOnTrash",      "ask");  // "ask" | "plugin_trash" | "os_trash" | "permanent" | "never" — no-op in Mode 1; consumed by v2.1/v2.2. plugin_trash = move to .zotero-watch-trash/ under watch root.
  _set("diskDeleteSync",         "auto"); // "auto" | "never" — no-op in Mode 1; consumed by v2.1/v2.2.

  // v2.0 sync model — sync root + mode
  _set("scopeMode",             "library"); // 'library' (whole-library mirror, default since 2.7.0) | 'collection' (legacy single sync-root, internal fallback).
  _set("syncRootCollectionKey",  "");      // 8-char Zotero collection key. Empty = not yet configured. Used only in scopeMode 'collection'.
  _set("syncRootLibraryID",      1);       // Default = user library. Forward-compat for group libraries.
  _set("mode",                   "mode1"); // "mode1" | "mode2" | "mode3". Only mode1 is functional in v2.0.
  _set("setupCompleted",         false);   // Gates whether the normal poll loop runs; setup wizard runs until true.
  _set("localTrashFolderName",   ".zotero-watch-trash"); // Reserved for v2.2; defined now so it can be referenced from scanner skip-list.
  _set("baselineCompletedForRoot", "");    // v2.1 Phase C: stores the sync-root key the install-time baseline has completed against. Empty = baseline not yet run (or sync root changed).
  _set("watchRootTopLevelFingerprint", ""); // v2.7 SYNC-1: JSON {count, namesHash} of top-level dirs at last healthy scan; a >50% collapse pauses folder-deletion (transient unmount / cloud-eviction guard).
  _set("mode3LibraryDeleteAcknowledged", false); // v2.7: true after the one-time first-arm whole-library-delete-blast-radius dialog.

  // File naming settings
  _set("renamePattern",          "{firstCreator} - {year} - {title}");
  _set("maxFilenameLength",      150);
  _set("autoRename",             true);

  // Duplicate detection
  _set("duplicateCheck",         true);
  _set("duplicateMatchDOI",      true);
  _set("duplicateMatchISBN",     true);
  _set("duplicateMatchTitle",    true);
  _set("duplicateTitleThreshold",85);   // stored as int, 0.85 * 100
  _set("duplicateMatchHash",     true);
  _set("duplicateAction",        "skip");

  // Smart rules (Phase 3)
  _set("smartRulesEnabled",      false);
  _set("smartRules",             "[]");

  // Performance
  _set("adaptivePolling",        true);
  _set("maxConcurrentMetadata",  2);
}

// ---------------------------------------------------------------------------
// v2.7 scopeMode migration. The default flipped to 'library'; this pins an
// EXISTING collection-scoped install to 'collection' on the user branch so the
// upgrade is behavior-preserving (no silent blast-radius escalation). Idempotent
// and conservative: only acts when it's confident the install pre-dates 2.7.0.
// ---------------------------------------------------------------------------
function _migrateScopeModeForExistingInstall() {
  const PREFIX = "extensions.zotero.watchFolder.";
  let user = null;
  try {
    user = Services.prefs.getBranch(PREFIX);
    // Already has an explicit scopeMode choice → nothing to migrate.
    if (user.prefHasUserValue("scopeMode")) return;
    // Signature of a pre-2.7.0 configured install: it has a sync-root collection
    // key on the user branch (the wizard/prefs always co-set setupCompleted, but
    // an about:config-only user may have set the key + sourcePath alone — so the
    // sync-root key is the load-bearing signal). A fresh 2.7.0 install has none,
    // so it is left on the new 'library' default.
    //
    // getBoolPref throws if a pref was hand-edited to the wrong type; isolate it
    // so a corrupt setupCompleted can't abort the whole migration (M5).
    let hadSetup = false;
    try {
      hadSetup = user.prefHasUserValue("setupCompleted") && user.getBoolPref("setupCompleted", false);
    } catch (_e) { hadSetup = false; }
    let syncRootKey = "";
    try {
      if (user.prefHasUserValue("syncRootCollectionKey")) syncRootKey = user.getCharPref("syncRootCollectionKey", "") || "";
    } catch (_e) { syncRootKey = ""; }
    let sourcePath = "";
    try {
      if (user.prefHasUserValue("sourcePath")) sourcePath = user.getCharPref("sourcePath", "") || "";
    } catch (_e) { sourcePath = ""; }
    // Pin to 'collection' if EITHER the wizard/prefs signature (setup + key) OR a
    // hand-configured install (key + a watch folder) is present (M11).
    const looksPreV27 = (hadSetup && syncRootKey.length > 0) || (syncRootKey.length > 0 && sourcePath.length > 0);
    if (looksPreV27) {
      user.setCharPref("scopeMode", "collection");
      try { Zotero.debug("[WatchFolder] v2.7 migration: pinned existing install to scopeMode 'collection' (behavior-preserving; whole-library mode is opt-in via setup)."); }
      catch (_e) { /* Zotero may not be ready */ }
    }
  } catch (e) {
    // FAIL CLOSED (M1): the new default is 'library' (whole-library deletes), so
    // leaving prefs "as-is" on an error would silently escalate an existing
    // install's blast radius. Pin to the SAFE 'collection' value instead — a
    // false pin only means a real fresh install must opt in via setup, which is
    // strictly safer than an accidental whole-library escalation.
    try { user = user || Services.prefs.getBranch(PREFIX); user.setCharPref("scopeMode", "collection"); } catch (_e) { /* */ }
    try { Zotero.logError(`[WatchFolder] v2.7 scopeMode migration error — pinned to 'collection' (fail-safe): ${e}`); } catch (_e) { /* */ }
  }
}
