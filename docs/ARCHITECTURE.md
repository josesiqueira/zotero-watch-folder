# Architecture Reference

Platform-level architectural notes for the Zotero Watch Folder plugin: the Zotero 8 plugin model, on-disk file structure, technical considerations for cloud storage and persistence, performance targets, and a pre-release verification checklist for Zotero 8 specifics.

---

## 1. Zotero 8 Plugin System / API Reference

### Critical Zotero 8 Platform Facts

Zotero 8 is based on **Firefox 140** (upgraded from Firefox 115 in Zotero 7). This brings major changes:

1. **All code must use ES Modules (ESM)** — `.jsm` files are dead. Use `.mjs` or standard `.js` with `import` statements. Zotero 8 uses standard JavaScript modules: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules
2. **All ESMs run in strict mode** — no implicit globals, no sloppy mode
3. **Global imports are NOT supported** — imported modules MUST be assigned to a variable
4. **Bluebird promises are REMOVED** — use native JavaScript `Promise`, `async/await` everywhere
   - `Zotero.Promise.delay()` and `Zotero.Promise.defer()` still work for compatibility
   - `defer()` can NO longer be called as a constructor
   - Bluebird methods like `.map()`, `.filter()`, `.each()`, `.isResolved()`, `.isPending()`, `.cancel()` are gone — use iteration or awaits
   - `Zotero.spawn()` was removed
5. **`Services.jsm` imports must be removed** — `Services` is available globally
6. **`nsIScriptableUnicodeConverter` was removed** — use `TextEncoder`/`TextDecoder`
7. **Preference panes run in their own global scope** — `var` in one pane is NOT accessible in others. Set on `window` explicitly to share.
8. **Button labels: use `label` property, not attribute**
9. **`XPCOMUtils.defineLazyGetter` → `ChromeUtils.defineLazyGetter`**
10. **`DataTransfer#types`: `contains()` → `includes()`** (now a standard array)

### Plugin Structure (Zotero 8 Bootstrapped Plugin)

Plugins are `.xpi` files (ZIP archives) with:
- `manifest.json` — WebExtension-style metadata
- `bootstrap.js` — Entry point with lifecycle and window hooks
- `prefs.js` — Default preferences (in plugin root, NOT `defaults/preferences/`)
- Zotero APIs accessed via the global `Zotero` object (available in bootstrap scope automatically)
- `Services`, `Cc`, `Ci`, and other Mozilla/browser objects are also auto-available

### bootstrap.js — Lifecycle & Window Hooks

```javascript
// LIFECYCLE HOOKS — called with ({ id, version, rootURI }, reason)
// reason constants: APP_STARTUP, APP_SHUTDOWN, ADDON_ENABLE, ADDON_DISABLE,
//                   ADDON_INSTALL, ADDON_UNINSTALL, ADDON_UPGRADE, ADDON_DOWNGRADE

var chromeHandle;

function install(data, reason) {}

async function startup({ id, version, rootURI }, reason) {
  // Register chrome resources (for locale files, content scripts)
  var aomStartup = Cc["@mozilla.org/addons/addon-manager-startup;1"]
    .getService(Ci.amIAddonManagerStartup);
  var manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "zotero-watch-folder", "content/"],
    ["locale", "zotero-watch-folder", "en-US", "locale/en-US/"],
  ]);

  // Register preference pane
  Zotero.PreferencePanes.register({
    pluginID: 'watch-folder@zotero-plugin',
    src: rootURI + 'content/preferences.xhtml',
    scripts: [rootURI + 'content/preferences.js'],
  });
}

function shutdown({ id, version, rootURI }, reason) {
  // CRITICAL: Remove ALL references, timers, DOM elements, listeners
  // Bootstrapped plugins can be disabled without restart

  chromeHandle?.destruct();
  chromeHandle = null;

  var windows = Zotero.getMainWindows();
  for (let win of windows) {
    // Remove any injected DOM elements
  }
}

function uninstall(data, reason) {}

// WINDOW HOOKS — called with { window }
function onMainWindowLoad({ window }) {
  // Add toolbar button, modify UI, bind shortcuts
  // MUST re-apply on every window open
}

function onMainWindowUnload({ window }) {
  // CRITICAL: Remove ALL references to window objects
  // Cancel any timers referencing this window
  // Failure to clean up = memory leak
}
```

### Zotero 8 Menu Manager API (NEW in Zotero 8)

Use the official `Zotero.MenuManager` API for context menus — do NOT manually inject DOM:

```javascript
let menuID = Zotero.MenuManager.registerMenu({
  menuID: "watch-folder-import",
  pluginID: "watch-folder@zotero-plugin",
  target: "main/library/item",
  menus: [
    {
      menuType: "menuitem",
      l10nID: "watch-folder-reimport",
      onShowing: (event, context) => { /* visibility */ },
      onCommand: (event, context) => { /* handle click */ },
    },
  ],
});

// Auto-removed when plugin disabled/uninstalled, or manually:
Zotero.MenuManager.unregisterMenu(menuID);
```

**Available menu targets:**
- `main/menubar/file`, `main/menubar/edit`, `main/menubar/tools`, `main/menubar/help`
- `main/library/item` — Context menu for library items
- `main/library/collection` — Context menu for collections
- `main/library/addAttachment` — "Add attachment" button/menu
- `main/tab` — Tab context menus
- `sidenav/locate` — Side navigation locate button

### Key Zotero APIs

```javascript
// Collections
Zotero.Collections.getByLibrary(libraryID)
Zotero.Collections.get(collectionID)
collection.getChildItems()
collection.addItem(item)

// Items
Zotero.Items.get(itemID)
let item = new Zotero.Item('journalArticle')
item.setField('title', 'Paper Title')
item.setField('DOI', '10.xxxx/xxxxx')
await item.saveTx()

// Attachments
await Zotero.Attachments.importFromFile({
  file: filePath,
  parentItemID: item.id,
  collections: [collectionID]
})
await Zotero.Attachments.linkFromFile({
  file: filePath,
  parentItemID: item.id,
  collections: [collectionID]
})

// Metadata retrieval
// Zotero.RecognizeDocument.recognizeItems([item])

// File operations (IOUtils + PathUtils — OS.File is REMOVED)
await IOUtils.read(path)
await IOUtils.write(path, data)
await IOUtils.exists(path)
await IOUtils.makeDirectory(path)
await IOUtils.move(source, dest)
await IOUtils.copy(source, dest)
PathUtils.join(dir, filename)
PathUtils.filename(path)
PathUtils.parent(path)

// DB transactions — use async/await (NOT generators)
await Zotero.DB.executeTransaction(async function () { /* ... */ });

// Notifier — observe changes to items, collections, etc.
let notifierID = Zotero.Notifier.registerObserver({
  notify: async function (event, type, ids, extraData) {
    // event: 'add', 'modify', 'delete', 'move'
    // type: 'item', 'collection', etc.
  }
}, ['item', 'collection']);

// MUST unregister in shutdown():
Zotero.Notifier.unregisterObserver(notifierID);

// File picker (use Zotero's module, NOT raw nsIFilePicker)
var { FilePicker } = ChromeUtils.importESModule(
  'chrome://zotero/content/modules/filePicker.mjs'
);

// Platform detection
Zotero.isWin   // boolean
Zotero.isMac   // boolean
Zotero.isLinux // boolean
// Note: Zotero.platform and Zotero.oscpu are REMOVED
```

### Localization (Fluent, NOT .dtd/.properties)

Zotero 8 uses Mozilla's Fluent localization system. Create `.ftl` files:

```
locale/en-US/zotero-watch-folder.ftl
locale/pt-BR/zotero-watch-folder.ftl
```

`.ftl` files in locale subfolders are auto-registered. Use in XHTML:
```xml
<linkset>
  <html:link rel="localization" href="zotero-watch-folder.ftl"/>
</linkset>
```

Or dynamically in a window:
```javascript
win.MozXULElement.insertFTLIfNeeded("zotero-watch-folder.ftl");
// Remove in shutdown:
doc.querySelector('[href="zotero-watch-folder.ftl"]').remove();
```

**CRITICAL:** Prefix ALL Fluent identifiers with plugin name to avoid namespace collisions (e.g., `watch-folder-pref-source-dir`).

For programmatic strings:
```javascript
var msg = await document.l10n.formatValue('watch-folder-import-complete', { count: 5 });
```

### File Watching Mechanism

Since Zotero runs on Gecko engine, native `fs.watch` is not available. Options:

1. **Polling with `setTimeout`** — Check folder contents every N seconds (simplest, most reliable)
2. **OS-level file watching via `nsIFile` observers** — More complex, may not work on all platforms

**Recommendation: Use polling (Option 1) with adaptive intervals.** Use `setTimeout`, NOT `setInterval` (prevents overlap).

---

## 2. Plugin File Structure

```
zotero-watch-folder/
├── manifest.json                 # WebExtension-style metadata (Zotero 8)
├── bootstrap.js                  # Entry point (lifecycle + window hooks)
├── prefs.js                      # Default preferences (MUST be in plugin root)
├── README.md
├── LICENSE
├── locale/
│   ├── en-US/
│   │   └── zotero-watch-folder.ftl   # Fluent localization (NOT .dtd/.properties)
│   └── pt-BR/
│       └── zotero-watch-folder.ftl
├── content/
│   ├── watchFolder.mjs           # Core watch folder logic (ESM)
│   ├── fileImporter.mjs          # Import files into Zotero (ESM)
│   ├── metadataRetriever.mjs     # Trigger metadata retrieval (ESM)
│   ├── fileRenamer.mjs           # Rename files based on metadata (ESM)
│   ├── collectionSync.mjs        # Collection ↔ folder mirroring - Phase 2 (ESM)
│   ├── preferences.xhtml         # Preferences pane UI (XUL/XHTML fragment)
│   ├── preferences.js            # Preferences pane logic
│   └── utils.mjs                 # Shared utilities (ESM)
└── build/
    └── (build scripts to package .xpi)
```

**Note on ESM files:** Zotero 8 converted all `.jsm` to ESM. Use `.mjs` extension for ES module files. Import with standard `import` statements or `ChromeUtils.importESModule()` for chrome-registered modules. All ESMs run in strict mode.

### manifest.json

```json
{
  "manifest_version": 2,
  "name": "Zotero Watch Folder",
  "version": "1.0.0",
  "description": "Automatically import PDFs from a watched folder into Zotero with metadata retrieval and file organization.",
  "icons": {
    "48": "content/icons/icon48.png",
    "96": "content/icons/icon96.png"
  },
  "applications": {
    "zotero": {
      "id": "watch-folder@zotero-plugin",
      "update_url": "https://raw.githubusercontent.com/YOUR_USERNAME/zotero-watch-folder/main/updates.json",
      "strict_min_version": "8.0",
      "strict_max_version": "8.*"
    }
  },
  "author": "Jose",
  "homepage_url": "https://github.com/YOUR_USERNAME/zotero-watch-folder"
}
```

### prefs.js (Default Preferences — in plugin root)

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

### Cloud Storage Compatibility

- The watch folder can be ANY local or cloud-synced directory (pCloud, Dropbox, Google Drive, OneDrive, Syncthing, NAS mounts, etc.)
- Cloud-synced or FUSE-mounted folders may have delays in file availability
- **Solution:** After detecting a new file, wait for file size to stabilize (check size twice with a delay) before importing
- **Solution:** Use file locking detection — if file is still being written, skip and retry next poll
- The plugin makes ZERO assumptions about the folder type — it just watches a path

```javascript
async function isFileReady(filePath) {
  const info1 = await IOUtils.stat(filePath);
  await new Promise(r => setTimeout(r, 1000)); // NOT Zotero.Promise.delay — use native
  const info2 = await IOUtils.stat(filePath);
  return info1.size === info2.size && info2.size > 0;
}
```

### Persistence

- Track imported files using a JSON file or Zotero's preference system
- Store: `{ filePath: string, importDate: string, itemID: number, hash: string }`
- Use file hash (MD5 of first 1MB) to detect if a file was replaced with a different version
- Use `IOUtils.writeJSON()` / `IOUtils.readJSON()` for persistence file

### Performance & Resource Optimization

**This plugin MUST be lightweight. It runs inside Zotero which is a Gecko-based app already consuming resources. The plugin should be virtually invisible in terms of CPU and RAM impact.**

#### CPU Optimization
- **Adaptive polling:** Start with a long interval (30s). When Zotero window is focused, poll faster (5s). When minimized/unfocused, slow down to 60s. When no new files detected for 10 minutes, back off to 120s.
- **Efficient file diffing:** Don't re-read the entire folder each poll. Cache the file list + modification timestamps. Only compare against the cache — if `mtime` and file count haven't changed, skip the scan entirely (cost: one `stat()` call on the directory, not on each file).
- **No busy loops:** Use `setTimeout` (not `setInterval`) to prevent overlapping scans if a scan takes longer than the poll interval.
- **Debounce bulk drops:** If 20 files are dropped at once, detect the batch (multiple new files in one scan) and process them sequentially with a small delay between each, not all in parallel.
- **Metadata retrieval throttling:** Max 2 concurrent metadata lookups. Queue the rest. Add 1-2s delay between requests to avoid hammering Zotero's internal services and external DOI resolvers.

#### RAM Optimization
- **Don't load file contents into memory.** Only read file paths, names, sizes, and modification times during scanning.
- **Bounded import history:** The "already imported" tracking set should use a fixed-size LRU cache or a bloom filter. For 10,000+ files, a full Map of hashes would waste memory. Cap at ~5000 entries, evict oldest.
- **Lazy initialization:** Don't start the watcher or allocate resources until the user enables the feature. If disabled, the plugin should consume near-zero memory.
- **Clean up on disable:** When watching is turned off, release all timers, clear caches, null references. Full cleanup. This is especially important because Zotero 8 bootstrapped plugins can be disabled without restart — the `shutdown()` function MUST release everything.
- **No in-memory file queues that grow unbounded.** Process and discard. If processing fails, persist to a small retry queue (max 50 items).

#### Battery / Laptop Considerations
- **Respect system idle:** If possible, detect if the system is on battery power and reduce poll frequency further.
- **No wake-on-timer:** Don't prevent system sleep. If the system was sleeping and wakes up, do one immediate scan then resume normal schedule.

#### Benchmarks to Target

| Metric | Target |
|--------|--------|
| Idle CPU (watching, no new files) | < 0.1% |
| RAM overhead (idle) | < 5 MB |
| RAM overhead (scanning 1000-file folder) | < 15 MB |
| Time to detect a new file | ≤ poll interval + 2s |
| Time to import + retrieve metadata (1 file) | < 30s |
| Bulk import (50 files) | < 10 minutes |

### Platform Compatibility
- Linux: Full support (primary target)
- macOS: Should work (test path handling)
- Windows: Should work (handle backslash paths via `PathUtils`, no symlinks in Phase 2)
- Use `Zotero.isWin`, `Zotero.isMac`, `Zotero.isLinux` for platform-specific code
- **Do NOT use** `Zotero.platform` or `Zotero.oscpu` (removed in Zotero 7+)

---

## 4. Zotero 8 Gotchas Checklist

Before releasing, verify:

- [ ] No `.jsm` files — all ESM (`.mjs` or `.js` with `import`)
- [ ] No Bluebird usage (`.map()`, `.filter()`, `.each()`, `.cancel()`, `Zotero.spawn()`)
- [ ] No `OS.File` or `OS.Path` — use `IOUtils` and `PathUtils`
- [ ] No `Services.jsm` manual imports
- [ ] No `nsIScriptableUnicodeConverter` — use `TextEncoder`/`TextDecoder`
- [ ] No `XPCOMUtils.defineLazyGetter` — use `ChromeUtils.defineLazyGetter`
- [ ] No `Zotero.platform` or `Zotero.oscpu` — use `Zotero.isWin/isMac/isLinux`
- [ ] No `<preference>` tags in XHTML — bind directly with `preference="..."` attribute
- [ ] All Fluent IDs prefixed with plugin name
- [ ] `shutdown()` cleans up ALL timers, observers, DOM elements, chrome handles
- [ ] `onMainWindowUnload()` removes ALL window references
- [ ] `prefs.js` is in plugin root (not `defaults/preferences/`)
- [ ] Menu items use `Zotero.MenuManager` API (not manual DOM injection)
- [ ] DB transactions use `async` functions (not generators)
- [ ] Button labels set via `.label` property (not attribute)
- [ ] `DataTransfer#types` uses `.includes()` (not `.contains()`)
- [ ] strict_min_version set to "8.0" in manifest.json
