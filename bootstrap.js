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
  await Zotero.WatchFolder.hooks.onStartup();
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
    await Zotero.WatchFolder.hooks.onShutdown();
  }

  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

function uninstall(data, reason) {}

// ---------------------------------------------------------------------------
// Default preferences  (mirrors prefs.js but using the Services API so it
// works regardless of where the file is located in the XPI).
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

  _set("enabled",                false);
  _set("sourcePath",             "");
  _set("pollInterval",           5);
  _set("targetCollection",       "Inbox");
  _set("fileTypes",              "pdf");
  _set("importMode",             "stored");
  _set("postImportAction",       "leave");
  _set("autoRetrieveMetadata",   true);
  _set("lastWatchedPath",        "");
  _set("renamePattern",          "{firstCreator} - {year} - {title}");
  _set("maxFilenameLength",      150);
  _set("autoRename",             true);
  _set("duplicateCheck",         true);
  _set("duplicateMatchDOI",      true);
  _set("duplicateMatchISBN",     true);
  _set("duplicateMatchTitle",    true);
  _set("duplicateTitleThreshold",85);   // stored as int, 0.85 * 100
  _set("duplicateMatchHash",     false);
  _set("duplicateAction",        "skip");
  _set("smartRulesEnabled",      false);
  _set("smartRules",             "[]");
  _set("adaptivePolling",        true);
  _set("maxConcurrentMetadata",  2);
  _set("collectionSyncEnabled",  false);
  _set("mirrorPath",             "");
  _set("mirrorRootCollection",   "");
  _set("mirrorPollInterval",     10);
  _set("bidirectionalSync",      false);
  _set("conflictResolution",     "last");
}
