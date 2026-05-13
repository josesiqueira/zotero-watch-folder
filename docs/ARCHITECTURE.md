# Architecture Reference

Platform notes for building this plugin against Zotero 8: the bootstrapped plugin model, key APIs, file layout, technical considerations, and a pre-release gotchas checklist. Compatibility target is Zotero 7/8/9 (see manifest); prose below focuses on Zotero 8 since that is the primary development target.

---

## 1. Zotero 8 Plugin Platform

Zotero 8 is based on Firefox 140 (Zotero 7 was Firefox 115). Practical consequences:

1. All code is ES Modules. `.jsm` is gone — use `.mjs` or `.js` with `import`. All ESMs run in strict mode.
2. Imports MUST be assigned to a variable; no global imports.
3. Bluebird is removed. Use native `Promise` and `async/await`.
   - `Zotero.Promise.delay()` / `defer()` still exist for compat, but `defer()` is not a constructor.
   - `.map()`, `.filter()`, `.each()`, `.cancel()`, `Zotero.spawn()` are gone — use loops/awaits.
4. `Services` is global — do not import `Services.jsm`.
5. `nsIScriptableUnicodeConverter` is gone — use `TextEncoder` / `TextDecoder`.
6. `XPCOMUtils.defineLazyGetter` → `ChromeUtils.defineLazyGetter`.
7. `OS.File` / `OS.Path` are gone — use `IOUtils` / `PathUtils`.
8. `Zotero.platform` and `Zotero.oscpu` are gone — use `Zotero.isWin/isMac/isLinux`.
9. Preference panes run in their own global scope; assign to `window` to share across panes.
10. Button labels: use the `label` property, not attribute.
11. `DataTransfer#types`: `.contains()` → `.includes()`.

### Compatibility table

| Zotero | Status | Notes |
|--------|--------|-------|
| 7      | Compatible | Same ESM model; runtime is Firefox 115 |
| 8      | Primary target | Firefox 140 |
| 9      | Compatible per manifest (`strict_max_version: "9.*"`) | Untested in production |

### Plugin structure

A bootstrapped plugin is a `.xpi` (ZIP) containing:

- `manifest.json` — WebExtension-style metadata
- `bootstrap.js` — Lifecycle and window hooks
- `prefs.js` — Default preferences (in plugin root, NOT `defaults/preferences/`)
- `content/` — ESM modules and UI files
- `locale/<lang>/*.ftl` — Fluent localization

The global `Zotero` object plus `Services`, `Cc`, `Ci`, `ChromeUtils`, `IOUtils`, `PathUtils` are auto-available in bootstrap scope.

### bootstrap.js — lifecycle and window hooks

```javascript
// Lifecycle hooks: ({ id, version, rootURI }, reason)
// reason: APP_STARTUP, APP_SHUTDOWN, ADDON_ENABLE, ADDON_DISABLE,
//         ADDON_INSTALL, ADDON_UNINSTALL, ADDON_UPGRADE, ADDON_DOWNGRADE

var chromeHandle;

async function startup({ id, version, rootURI }, reason) {
  var aomStartup = Cc["@mozilla.org/addons/addon-manager-startup;1"]
    .getService(Ci.amIAddonManagerStartup);
  var manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "zotero-watch-folder", "content/"],
    ["locale", "zotero-watch-folder", "en-US", "locale/en-US/"],
  ]);

  Zotero.PreferencePanes.register({
    pluginID: 'watch-folder@zotero-plugin',
    src: rootURI + 'content/preferences.xhtml',
    scripts: [rootURI + 'content/preferences.js'],
  });
}

function shutdown({ id, version, rootURI }, reason) {
  // Bootstrapped plugins can be disabled without restart.
  // MUST release every timer, observer, DOM element, chrome handle.
  chromeHandle?.destruct();
  chromeHandle = null;
}

// Window hooks: ({ window })
function onMainWindowLoad({ window }) { /* must re-apply per window */ }
function onMainWindowUnload({ window }) { /* must release all refs */ }
```

### Zotero 8 Menu Manager (preferred over manual DOM injection)

```javascript
let menuID = Zotero.MenuManager.registerMenu({
  menuID: "watch-folder-import",
  pluginID: "watch-folder@zotero-plugin",
  target: "main/library/item",
  menus: [{
    menuType: "menuitem",
    l10nID: "watch-folder-reimport",
    onShowing: (event, context) => { /* visibility */ },
    onCommand: (event, context) => { /* handle click */ },
  }],
});
```

Menu targets: `main/menubar/{file,edit,tools,help}`, `main/library/{item,collection,addAttachment}`, `main/tab`, `sidenav/locate`.

### Key Zotero APIs

```javascript
// Collections
Zotero.Collections.getByLibrary(libraryID)
Zotero.Collections.getByParent(parentID, libraryID)
Zotero.Collections.get(collectionID)
collection.getChildItems()

// Items
let item = new Zotero.Item('journalArticle')
item.setField('title', 'Paper Title')
await item.saveTx()

// Attachments
await Zotero.Attachments.importFromFile({ file, parentItemID, collections })
await Zotero.Attachments.linkFromFile({ file, parentItemID, collections })
// Link mode constants: Zotero.Attachments.LINK_MODE_LINKED_FILE etc.

// Metadata recognition
await Zotero.RecognizeDocument.recognizeItems([item])

// File I/O — OS.File is gone, use IOUtils + PathUtils
await IOUtils.read(path, { maxBytes })
await IOUtils.write(path, data)
await IOUtils.exists(path)
await IOUtils.stat(path)           // { size, lastModified, type: 'regular'|'directory' }
await IOUtils.getChildren(path)
await IOUtils.makeDirectory(path, { ignoreExisting, createAncestors })
await IOUtils.move(src, dst)
await IOUtils.copy(src, dst)
PathUtils.join(dir, filename)
PathUtils.filename(path)
PathUtils.parent(path)

// Transactions — async/await, NOT generators
await Zotero.DB.executeTransaction(async function () { /* ... */ });

// Notifier
let notifierID = Zotero.Notifier.registerObserver({
  notify: async (event, type, ids, extraData) => { /* ... */ }
}, ['item', 'collection']);
// MUST unregister in shutdown:
Zotero.Notifier.unregisterObserver(notifierID);

// File picker (use Zotero's wrapper, not raw nsIFilePicker)
var { FilePicker } = ChromeUtils.importESModule(
  'chrome://zotero/content/modules/filePicker.mjs'
);

// Platform detection
Zotero.isWin / Zotero.isMac / Zotero.isLinux
```

### Localization — Fluent only

`.ftl` files in `locale/<lang>/` are auto-registered. Use in XHTML:

```xml
<linkset>
  <html:link rel="localization" href="zotero-watch-folder.ftl"/>
</linkset>
```

Or programmatically:
```javascript
win.MozXULElement.insertFTLIfNeeded("zotero-watch-folder.ftl");
// shutdown: doc.querySelector('[href="zotero-watch-folder.ftl"]').remove();

var msg = await document.l10n.formatValue('watch-folder-import-complete', { count: 5 });
```

Prefix ALL Fluent identifiers with `watch-folder-` to avoid namespace collisions.

### File watching

Gecko has no `fs.watch`. The plugin polls with `setTimeout` (NOT `setInterval` — that would let scans overlap). Adaptive polling backs off when no new files appear; see `content/watchFolder.mjs` `_scheduleNextScan` and `_scan`.

---

## 2. Plugin File Structure

```
zotero-watch-folder/
├── manifest.json              # WebExtension-style metadata
├── bootstrap.js               # Lifecycle + window hooks
├── prefs.js                   # Default preferences (must be in root)
├── locale/<lang>/zotero-watch-folder.ftl
└── content/
    ├── index.mjs              # Entry — wired from bootstrap.js
    ├── watchFolder.mjs        # Polling + orchestration
    ├── fileScanner.mjs        # Folder walk (incl. recursive)
    ├── fileImporter.mjs       # importFromFile / linkFromFile wrapper
    ├── metadataRetriever.mjs  # Queue around Zotero.RecognizeDocument
    ├── fileRenamer.mjs        # Pattern-based rename
    ├── trackingStore.mjs      # LRU + JSON persistence of imports
    ├── firstRunHandler.mjs    # One-shot scan + import prompt
    ├── smartRules.mjs         # Phase 3: rule engine
    ├── duplicateDetector.mjs  # Phase 3: DOI/ISBN/title/hash
    ├── bulkOperations.mjs     # Phase 3: reorganize, retry, apply rules
    ├── collectionSync.mjs     # Phase 2: collection ↔ folder coordinator
    ├── collectionWatcher.mjs  # Phase 2: Zotero notifier side
    ├── folderWatcher.mjs      # Phase 2: filesystem polling side
    ├── pathMapper.mjs         # Phase 2: collection ↔ path translation
    ├── conflictResolver.mjs   # Phase 2: conflict strategies
    ├── syncState.mjs          # Phase 2: persisted sync state
    ├── utils.mjs              # getPref/setPref, sanitize, hash, etc.
    ├── preferences.xhtml      # Preferences pane UI
    └── preferences.js         # Preferences pane logic
```

### manifest.json (current)

```json
{
  "manifest_version": 2,
  "name": "Zotero Watch Folder",
  "version": "1.1.0",
  "applications": {
    "zotero": {
      "id": "watch-folder@zotero-plugin.org",
      "strict_min_version": "6.999",
      "strict_max_version": "9.*"
    }
  }
}
```

### prefs.js (default preferences)

```javascript
pref("extensions.zotero.watchFolder.enabled", false);
pref("extensions.zotero.watchFolder.sourcePath", "");
pref("extensions.zotero.watchFolder.pollInterval", 5);
pref("extensions.zotero.watchFolder.targetCollection", "Inbox");
pref("extensions.zotero.watchFolder.fileTypes", "pdf");
pref("extensions.zotero.watchFolder.importMode", "stored");
pref("extensions.zotero.watchFolder.renamePattern", "{firstCreator} - {year} - {title}");
pref("extensions.zotero.watchFolder.maxFilenameLength", 150);
pref("extensions.zotero.watchFolder.autoRename", true);
pref("extensions.zotero.watchFolder.postImportAction", "leave");
```

---

## 3. Technical Considerations

### Cloud storage compatibility

Watch path can be any local/cloud/FUSE mount (pCloud, Dropbox, OneDrive, Syncthing, NAS, etc.). The plugin makes no assumption about the folder type. To avoid importing partially-written files, file size is checked twice with a delay (see `content/fileScanner.mjs:154 isFileStable` and `content/watchFolder.mjs:511 _waitForFileStable`).

### Persistence

- Import history persists to `<Zotero.DataDirectory>/zotero-watch-folder-tracking.json` via `IOUtils.writeJSON` (see `content/trackingStore.mjs`).
- A SHA-256 of the first 1 MB of each file is used as a hash key so the same content imported under a different filename is detected (`content/utils.mjs:81 getFileHash`).
- Phase 2 sync state lives in `<Zotero.DataDirectory>/zotero-watch-folder-sync-state.json` (`content/syncState.mjs`).

### Performance and resource use

The plugin runs inside Zotero (already a Gecko app) — it must be nearly invisible.

- **Adaptive polling.** `_scan()` increases the interval by 1.2x after 10 consecutive empty scans, up to 2x the base. Files found resets to base. See `content/watchFolder.mjs:_scan` and `:_scheduleNextScan`.
- **No `setInterval`.** Chain via `setTimeout` so a slow scan never overlaps the next.
- **Cheap diffing.** Tracked-paths short-circuit; only new paths trigger stability check + hash.
- **Bounded tracking.** `TrackingStore` is an LRU capped at 5000 entries.
- **Concurrency cap.** Metadata recognition queue caps concurrent lookups and inserts delays between requests (`content/metadataRetriever.mjs`).
- **Lazy init.** `collectionSync` and `duplicateDetector` are initialized lazily; shutdown handlers are idempotent.

### Benchmarks (targets)

| Metric | Target |
|--------|--------|
| Idle CPU (watching, no new files) | < 0.1% |
| RAM overhead (idle) | < 5 MB |
| RAM overhead (1000-file scan) | < 15 MB |
| Time to detect a new file | ≤ poll interval + 2s |
| Single import + metadata | < 30s |
| Bulk import (50 files) | < 10 min |

### Platform support

- Linux — primary target.
- macOS — should work; verify path handling.
- Windows — should work; `PathUtils` handles separators.
- Use `Zotero.isWin/isMac/isLinux` for branching. Do NOT use removed `Zotero.platform` or `Zotero.oscpu`.

---

## 4. Zotero Gotchas Checklist

Before release, verify:

- [ ] No `.jsm` files — all ESM (`.mjs` or `.js` with `import`)
- [ ] No Bluebird usage (`.map()`, `.filter()`, `.each()`, `.cancel()`, `Zotero.spawn()`)
- [ ] No `OS.File` / `OS.Path` — use `IOUtils` / `PathUtils`
- [ ] No `Services.jsm` manual imports
- [ ] No `nsIScriptableUnicodeConverter` — use `TextEncoder` / `TextDecoder`
- [ ] No `XPCOMUtils.defineLazyGetter` — use `ChromeUtils.defineLazyGetter`
- [ ] No `Zotero.platform` / `Zotero.oscpu` — use `Zotero.isWin/isMac/isLinux`
- [ ] No `<preference>` tags in XHTML — bind directly via `preference="..."`
- [ ] All Fluent IDs prefixed with `watch-folder-`
- [ ] `shutdown()` releases ALL timers, observers, DOM, chrome handles
- [ ] `onMainWindowUnload()` removes ALL window references
- [ ] `prefs.js` is in plugin root (not `defaults/preferences/`)
- [ ] Menu items use `Zotero.MenuManager` (no manual DOM injection)
- [ ] DB transactions use `async` functions (not generators)
- [ ] Button labels via `.label` property
- [ ] `DataTransfer#types` uses `.includes()`
- [ ] `setTimeout`, not `setInterval`, for polling
