/* eslint-disable no-undef */
/**
 * Watch Folder Setup Wizard — UI controller (C1, v2.4 / 2026-05-27).
 *
 * Loaded by `content/setupWizard.xhtml` inside a Mozilla chrome window
 * opened via `window.openDialog`. Runs in the privileged chrome context
 * (full Zotero / IOUtils / Services access).
 *
 * Result-passing contract:
 *   window.arguments[0] = {
 *     onResult: function ({ canceled, watchFolder, syncRootKey, syncRootLibraryID, syncRootLabel, mode })
 *   }
 *
 * The wizard calls onResult once before closing — either with
 * `{ canceled: true }` if the user cancelled, or with the full config
 * payload if they clicked Enable. The opener (content/index.mjs::runSetupWizard)
 * awaits a Promise that resolves when onResult fires.
 *
 * Steps:
 *   1. Pick watch folder (FilePicker)
 *   2. Pick sync-root collection (flat list, indented by depth)
 *   3. Pick mode (mode1 / mode2 / mode3 radio)
 *   4. Pick PDF storage strategy (stored / linked_watch_folder / stored_plus_mirror)
 *   5. Confirm (summary + mode-specific safety note)
 */

const WatchFolderSetup = (function () {
  "use strict";

  // The setup wizard runs inside a standalone XHTML chrome window
  // opened via `window.openDialog(...)`. Unlike `zoteroPane.xhtml`,
  // this window does NOT get `Zotero` auto-injected into its global
  // scope, so every `Zotero.*` call in this file would throw
  // "Zotero is not defined" (bug surfaced 2026-05-28 at Step 2 of the
  // wizard: collection enumeration).
  //
  // Resolution order:
  //   1. globalThis.Zotero — set if the loader injected it.
  //   2. window.opener.Zotero — the window that opened the wizard
  //      (prefs pane or main browser window) has the live singleton.
  // Components.classes is deliberately NOT used here: in some chrome
  // contexts the access throws SecurityError synchronously at script
  // parse time, which would make the entire wizard fail to construct.
  let Zotero = (typeof globalThis !== "undefined" && globalThis.Zotero)
    || (typeof window !== "undefined" && window.opener && window.opener.Zotero)
    || null;

  // Try ChromeUtils as a last-resort, wrapped in try/catch so a denied
  // import can't tank the whole script. ChromeUtils is generally
  // available in chrome:// pages without the Components-access caveat.
  if (!Zotero) {
    try {
      const { Zotero: Z } = ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs");
      Zotero = Z;
    } catch (_e) { /* fall through with Zotero null */ }
  }

  if (!Zotero) {
    document.addEventListener("DOMContentLoaded", () => {
      const err = document.getElementById("coll-error") || document.body;
      if (err) err.textContent = "Setup wizard cannot reach Zotero (window scope missing). Try re-opening from Edit → Settings → Watch Folder.";
    });
  }

  const state = {
    step: 1,
    watchFolder: "",
    scopeMode: "collection",
    syncRootKey: "",
    syncRootLibraryID: 1,
    syncRootLabel: "",
    mode: "mode1",
    storageStrategy: "stored",
    result: null,
  };

  let $ = (id) => document.getElementById(id);

  function _safeWindow() { return window; }
  function _onResult(payload) {
    state.result = payload;
    try {
      const args = (typeof window.arguments !== "undefined" && window.arguments[0]) || null;
      if (args && typeof args.onResult === "function") {
        args.onResult(payload);
      }
    } catch (e) {
      try { Zotero.logError(`[WatchFolder] setupWizard onResult: ${e.message}`); } catch (_) {}
    }
  }

  // ─── Step navigation ──────────────────────────────────────────────────

  function showStep(n) {
    state.step = n;
    const steps = document.querySelectorAll(".step");
    steps.forEach((el) => el.removeAttribute("data-active"));
    const target = document.querySelector(`.step[data-step="${n}"]`);
    if (target) target.setAttribute("data-active", "1");
    $("step-num").textContent = String(n);

    // Footer button visibility
    const back = $("btn-back");
    const next = $("btn-next");
    const enable = $("btn-enable");
    if (n === 1) back.setAttribute("hidden", "hidden");
    else back.removeAttribute("hidden");
    if (n === 3) {
      next.setAttribute("hidden", "hidden");
      enable.removeAttribute("hidden");
    } else {
      next.removeAttribute("hidden");
      enable.setAttribute("hidden", "hidden");
    }

    // Per-step entry hooks. Step 2 lets the user choose whole-library scope or a
    // specific sync-root collection; the collection list is populated lazily the
    // first time "A specific collection" is selected. Sync mode + PDF storage are
    // now global settings (all folders), so the wizard is folder → target → confirm.
    if (n === 2) _syncScopePicker();
    if (n === 3) renderConfirm();
  }

  function validateStep(n) {
    if (n === 1) {
      if (!state.watchFolder) {
        $("folder-error").textContent = "Pick a folder to continue.";
        return false;
      }
      $("folder-error").textContent = "";
      return true;
    }
    if (n === 2) {
      const checked = document.querySelector('input[name="scope"]:checked');
      state.scopeMode = checked && checked.value === "collection" ? "collection" : "library";
      if (state.scopeMode === "collection" && !state.syncRootKey) {
        $("coll-error").textContent = "Pick a collection to continue, or choose “Whole library” above.";
        return false;
      }
      $("coll-error").textContent = "";
      return true;
    }
    return true;
  }

  function next() {
    if (!validateStep(state.step)) return;
    if (state.step < 3) showStep(state.step + 1);
  }

  function back() {
    if (state.step > 1) showStep(state.step - 1);
  }

  function cancel() {
    _onResult({ canceled: true });
    _safeWindow().close();
  }

  function enable() {
    if (!validateStep(1)) { showStep(1); return; }
    if (!validateStep(2)) { showStep(2); return; }
    _onResult({
      canceled: false,
      watchFolder: state.watchFolder,
      scopeMode: state.scopeMode,
      syncRootKey: state.scopeMode === "collection" ? state.syncRootKey : "",
      syncRootLibraryID: state.syncRootLibraryID,
      syncRootLabel: state.scopeMode === "collection" ? state.syncRootLabel : "Whole library",
    });
    _safeWindow().close();
  }

  // ─── Step 1: folder picker ────────────────────────────────────────────

  async function browseFolder() {
    try {
      const { FilePicker } = ChromeUtils.importESModule(
        "chrome://zotero/content/modules/filePicker.mjs",
      );
      const fp = new FilePicker();
      fp.init(window, "Pick the local folder to watch", fp.modeGetFolder);
      if (state.watchFolder) {
        try { fp.displayDirectory = state.watchFolder; } catch (_) { /* best effort */ }
      }
      const result = await fp.show();
      if (result !== fp.returnOK) return;
      const f = fp.file;
      if (!f) return;
      state.watchFolder = (typeof f === "object" && f.path) ? f.path : String(f);
      $("folder-path").value = state.watchFolder;
      $("folder-error").textContent = "";
    } catch (e) {
      $("folder-error").textContent = `Folder picker error: ${e.message}`;
    }
  }

  // ─── Step 2: scope choice (whole library vs. one collection) ──────────

  /**
   * Wire the scope radios and show/hide the collection picker. Populates the
   * collection list lazily the first time "A specific collection" is active, so
   * an all-library setup never pays the enumeration cost. Idempotent — safe to
   * call on every entry to step 2.
   */
  function _syncScopePicker() {
    const radios = document.querySelectorAll('input[name="scope"]');
    const picker = $("coll-picker");
    const apply = () => {
      const checked = document.querySelector('input[name="scope"]:checked');
      const isCollection = !!(checked && checked.value === "collection");
      state.scopeMode = isCollection ? "collection" : "library";
      if (picker) picker.hidden = !isCollection;
      if (isCollection) {
        populateCollections();
      } else {
        // Reverting to whole-library clears any stale collection pick so the
        // confirm/summary and committed prefs stay consistent.
        state.syncRootKey = "";
        state.syncRootLabel = "";
        $("coll-error").textContent = "";
      }
    };
    radios.forEach((r) => {
      if (r.dataset.wired === "1") return;
      r.addEventListener("change", apply);
      r.dataset.wired = "1";
    });
    apply();
  }

  // ─── Step 2: collection list ──────────────────────────────────────────

  function _displayPath(collection) {
    const segments = [];
    let cursor = collection;
    for (let i = 0; i < 64 && cursor; i++) {
      segments.push(cursor.name);
      if (!cursor.parentID) break;
      cursor = Zotero.Collections.get(cursor.parentID);
    }
    return segments.reverse().join(" / ");
  }

  function _depthOf(collection) {
    let d = 0;
    let cursor = collection;
    for (let i = 0; i < 64 && cursor; i++) {
      if (!cursor.parentID) break;
      cursor = Zotero.Collections.get(cursor.parentID);
      d++;
    }
    return d;
  }

  function populateCollections(force) {
    const list = $("coll-list");
    if (!force && list.dataset.populated === "1") return;

    const libraryID = (typeof Zotero !== "undefined" && Zotero.Libraries)
      ? Zotero.Libraries.userLibraryID : 1;
    state.syncRootLibraryID = libraryID;

    let collections = [];
    try {
      collections = Zotero.Collections.getByLibrary(libraryID) || [];
    } catch (e) {
      $("coll-error").textContent = `Could not enumerate collections: ${e.message}`;
      return;
    }

    const usable = collections
      .filter((c) => !c.isVirtual && !c.deleted)
      .map((c) => ({
        key: c.key,
        label: _displayPath(c),
        depth: _depthOf(c),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));

    // NB: no early "no collections" bail — the user can create one with the
    // "＋ Create" control below even when the library has none yet.
    list.innerHTML = "";
    for (const u of usable) {
      const row = document.createElement("div");
      row.className = "coll-row";
      row.setAttribute("data-key", u.key);
      const indent = "  ".repeat(u.depth);
      const depthSpan = document.createElement("span");
      depthSpan.className = "depth";
      depthSpan.textContent = indent;
      row.appendChild(depthSpan);
      const labelText = document.createTextNode(u.label);
      row.appendChild(labelText);
      row.addEventListener("click", () => {
        list.querySelectorAll(".coll-row").forEach((r) => r.removeAttribute("data-selected"));
        row.setAttribute("data-selected", "1");
        state.syncRootKey = u.key;
        state.syncRootLabel = u.label;
        $("coll-error").textContent = "";
      });
      // Double-click to advance
      row.addEventListener("dblclick", () => {
        if (state.syncRootKey) next();
      });
      list.appendChild(row);
    }
    list.dataset.populated = "1";

    // Reflect the currently-selected key (e.g. a just-created collection).
    if (state.syncRootKey) {
      const sel = list.querySelector(`.coll-row[data-key="${state.syncRootKey}"]`);
      if (sel) sel.setAttribute("data-selected", "1");
    }
  }

  /**
   * Create a new collection in the user library from the "＋ Create" input, then
   * re-render the list and select it. Runs in the wizard's chrome context, so it
   * uses the live Zotero.Collection API (async saveTx).
   */
  async function createNewCollection() {
    const input = $("new-coll-name");
    const name = input && input.value ? input.value.trim() : "";
    if (!name) {
      $("coll-error").textContent = "Type a name for the new collection first.";
      return;
    }
    try {
      const libraryID = (typeof Zotero !== "undefined" && Zotero.Libraries)
        ? Zotero.Libraries.userLibraryID : 1;
      const coll = new Zotero.Collection();
      coll.libraryID = libraryID;
      coll.name = name;
      await coll.saveTx();
      // Select the new collection and re-render so it appears in the list.
      state.syncRootLibraryID = libraryID;
      state.syncRootKey = coll.key;
      state.syncRootLabel = _displayPath(coll);
      if (input) input.value = "";
      $("coll-error").textContent = "";
      populateCollections(true);
    } catch (e) {
      $("coll-error").textContent = `Could not create collection: ${e && e.message ? e.message : e}`;
    }
  }

  // ─── Step 4: confirm + safety note ────────────────────────────────────

  function _modeLabel(mode) {
    if (mode === "mode1") return "Mode 1 — Import only";
    if (mode === "mode2") return "Mode 2 — Mirror without delete";
    if (mode === "mode3") return "Mode 3 — Mirror with safe delete";
    return mode;
  }

  /**
   * The CURRENT effective global sync mode, so the confirm step reflects the
   * user's actual selection instead of a hardcoded "Import only". Sync mode is
   * global (set once in Watch Folder settings); the folder-list model clamps a
   * Mode-3 pref to Mode 2 (deletes deferred), so mirror the same clamp here to
   * avoid promising safe-delete that won't run yet.
   */
  function _currentMode() {
    try {
      const m = (Zotero && Zotero.Prefs && Zotero.Prefs.get("extensions.zotero.watchFolder.mode", true)) || "mode1";
      const multi = !!(Zotero && Zotero.Prefs && Zotero.Prefs.get("extensions.zotero.watchFolder.watchMappingsMulti", true) === true);
      if (multi && m === "mode3") return "mode2";
      return (m === "mode1" || m === "mode2" || m === "mode3") ? m : "mode1";
    } catch (_e) { return "mode1"; }
  }

  function _modeSafetyText(mode) {
    if (mode === "mode1") {
      return "Safety: nothing in Zotero will be modified by disk changes. Files you delete on disk stay in your library; collections renamed in Zotero do not rename folders on disk.";
    }
    if (mode === "mode2") {
      return "Safety: collection renames and item moves propagate both ways. Destructive operations (folder/file deletes) are warn-only — nothing is deleted, but you'll see a notice in the prefs pane.";
    }
    if (mode === "mode3") {
      return "Safety: deletes propagate both ways with a recoverable trash. Files trashed by either side go to '.zotero-watch-trash/' under your watch folder. Any single operation affecting more than 10 files or 20% of your tracked items will prompt for confirmation.";
    }
    return "";
  }

  function _storageLabel(strategy) {
    if (strategy === "stored") return "Store PDFs in Zotero";
    if (strategy === "linked_watch_folder") return "Link PDFs from watch folder";
    if (strategy === "stored_plus_mirror") return "Store in Zotero and mirror to watch folder";
    return strategy;
  }

  function renderConfirm() {
    $("sum-folder").textContent = state.watchFolder || "—";
    $("sum-coll").textContent = state.scopeMode === "collection"
      ? (state.syncRootLabel || "(collection)")
      : "Whole library";
    // Sync mode + PDF storage are global (set once in Watch Folder settings), so
    // the confirm step doesn't restate storage per folder — but it DOES reflect
    // the current effective sync mode so the note matches the user's selection
    // (e.g. "Mirror without delete" once they've switched off Import only).
    const mode = _currentMode();
    const note = $("safety-note");
    if (note) {
      // CSS keys are m1 (green/safe) / m3 (red/danger); m2 falls through to the
      // neutral base style. Matches the current effective mode.
      const cls = mode === "mode1" ? "m1" : mode === "mode3" ? "m3" : "m2";
      note.className = "safety-note " + cls;
      note.textContent = `${_modeLabel(mode)}. ${_modeSafetyText(mode)} Sync mode and PDF storage are set once for all folders in Watch Folder settings.`;
    }
  }

  // ─── Init ─────────────────────────────────────────────────────────────

  function init() {
    $("btn-cancel").addEventListener("click", cancel);
    $("btn-back").addEventListener("click", back);
    $("btn-next").addEventListener("click", next);
    $("btn-enable").addEventListener("click", enable);
    $("folder-browse").addEventListener("click", browseFolder);
    const createBtn = $("new-coll-create");
    if (createBtn) createBtn.addEventListener("click", () => { createNewCollection(); });
    const nameInput = $("new-coll-name");
    if (nameInput) nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); createNewCollection(); }
    });

    // Close button on the title bar is a cancel too
    window.addEventListener("unload", () => {
      // If the user clicked the OS-level close button, state.result is still
      // null — emit a canceled result so the opener's promise resolves.
      if (state.result === null) _onResult({ canceled: true });
    });

    showStep(1);
  }

  return {
    init,
    // Test seams (only used in unit tests):
    _state: state,
    _showStep: showStep,
    _validateStep: validateStep,
    _modeSafetyText,
    _modeLabel,
  };
})();

// Auto-init when the body's onload doesn't fire (e.g., script appears after
// DOMContentLoaded). This is a no-op if init has already run.
if (typeof document !== "undefined" && document.readyState !== "loading") {
  WatchFolderSetup.init();
} else if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", WatchFolderSetup.init);
}
