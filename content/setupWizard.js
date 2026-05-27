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
 *   4. Confirm (summary + mode-specific safety note)
 */

const WatchFolderSetup = (function () {
  "use strict";

  const state = {
    step: 1,
    watchFolder: "",
    syncRootKey: "",
    syncRootLibraryID: 1,
    syncRootLabel: "",
    mode: "mode1",
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
    if (n === 4) {
      next.setAttribute("hidden", "hidden");
      enable.removeAttribute("hidden");
    } else {
      next.removeAttribute("hidden");
      enable.setAttribute("hidden", "hidden");
    }

    // Per-step entry hooks
    if (n === 2) populateCollections();
    if (n === 4) renderConfirm();
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
      if (!state.syncRootKey) {
        $("coll-error").textContent = "Pick a Zotero collection to continue.";
        return false;
      }
      $("coll-error").textContent = "";
      return true;
    }
    if (n === 3) {
      const checked = document.querySelector('input[name="mode"]:checked');
      state.mode = checked ? checked.value : "mode1";
      return true;
    }
    return true;
  }

  function next() {
    if (!validateStep(state.step)) return;
    if (state.step < 4) showStep(state.step + 1);
  }

  function back() {
    if (state.step > 1) showStep(state.step - 1);
  }

  function cancel() {
    _onResult({ canceled: true });
    _safeWindow().close();
  }

  function enable() {
    if (!validateStep(3)) return;
    _onResult({
      canceled: false,
      watchFolder: state.watchFolder,
      syncRootKey: state.syncRootKey,
      syncRootLibraryID: state.syncRootLibraryID,
      syncRootLabel: state.syncRootLabel,
      mode: state.mode,
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

  function populateCollections() {
    const list = $("coll-list");
    if (list.dataset.populated === "1") return;

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

    if (usable.length === 0) {
      $("coll-error").textContent =
        "No collections found in your library. Create a collection in Zotero, then re-run setup.";
      return;
    }

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
  }

  // ─── Step 4: confirm + safety note ────────────────────────────────────

  function _modeLabel(mode) {
    if (mode === "mode1") return "Mode 1 — Import only";
    if (mode === "mode2") return "Mode 2 — Mirror without delete";
    if (mode === "mode3") return "Mode 3 — Mirror with safe delete";
    return mode;
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

  function renderConfirm() {
    const checked = document.querySelector('input[name="mode"]:checked');
    state.mode = checked ? checked.value : state.mode;
    $("sum-folder").textContent = state.watchFolder || "—";
    $("sum-coll").textContent = state.syncRootLabel || state.syncRootKey || "—";
    $("sum-mode").textContent = _modeLabel(state.mode);
    const note = $("safety-note");
    note.className = "safety-note " + state.mode;
    note.textContent = _modeSafetyText(state.mode);
  }

  // ─── Init ─────────────────────────────────────────────────────────────

  function init() {
    $("btn-cancel").addEventListener("click", cancel);
    $("btn-back").addEventListener("click", back);
    $("btn-next").addEventListener("click", next);
    $("btn-enable").addEventListener("click", enable);
    $("folder-browse").addEventListener("click", browseFolder);

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
