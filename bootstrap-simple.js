/**
 * Zotero Watch Folder - Bootstrap Entry Point
 * Simplified bootstrap that loads bundled script
 */

var chromeHandle;

function install(data, reason) {}

async function startup({ id, version, resourceURI, rootURI }, reason) {
  await Zotero.initializationPromise;

  var aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  var manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "zotero-watch-folder", rootURI + "content/"],
    ["locale", "zotero-watch-folder", "en-US", rootURI + "locale/en-US/"]
  ]);

  // Load bundled script
  const ctx = { rootURI };
  ctx._globalThis = ctx;

  Services.scriptloader.loadSubScript(
    `${rootURI}/content/scripts/watchFolder.js`,
    ctx,
  );
  
  // Initialize from bundled script
  if (Zotero.WatchFolder) {
    await Zotero.WatchFolder.hooks.onStartup();
  }
}

async function onMainWindowLoad({ window }, reason) {
  if (Zotero.WatchFolder) {
    await Zotero.WatchFolder.hooks.onMainWindowLoad(window);
  }
}

async function onMainWindowUnload({ window }, reason) {
  if (Zotero.WatchFolder) {
    await Zotero.WatchFolder.hooks.onMainWindowUnload(window);
  }
}

async function shutdown({ id, version, resourceURI, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) {
    return;
  }

  if (Zotero.WatchFolder) {
    await Zotero.WatchFolder.hooks.onShutdown();
  }

  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

function uninstall(data, reason) {}
