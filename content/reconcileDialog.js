/* eslint-disable no-undef */
/**
 * Check & Repair dialog controller (v2.8).
 *
 * Loaded by content/reconcileDialog.xhtml in a chrome window opened via
 * window.openDialog from the prefs pane. On load it runs
 * Zotero.WatchFolder.reconcile.detect() (read-only), renders one card per
 * finding (high-value items — those with annotations/notes — first, gold-badged,
 * never defaulted to a destructive action), and on "Apply" runs
 * reconcile.applyRepairs() with only the selected actions.
 */
const ReconcileDialog = (function () {
  "use strict";

  // Same Zotero-acquisition fallback chain as the setup wizard: a standalone
  // chrome window does not get Zotero auto-injected.
  let Zotero = (typeof globalThis !== "undefined" && globalThis.Zotero)
    || (typeof window !== "undefined" && window.opener && window.opener.Zotero)
    || null;
  if (!Zotero) {
    try {
      const { Zotero: Z } = ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs");
      Zotero = Z;
    } catch (_e) { /* null */ }
  }

  let _findings = [];

  function $(id) { return document.getElementById(id); }

  function _api() {
    return (Zotero && Zotero.WatchFolder && Zotero.WatchFolder.reconcile) || null;
  }

  function _fail(msg) {
    const e = $("error"); if (e) e.textContent = msg;
    const s = $("subtitle"); if (s) s.textContent = "";
  }

  async function load() {
    const api = _api();
    if (!api || typeof api.detect !== "function") {
      _fail("Check & Repair is unavailable — the plugin is not fully loaded. Try reopening Settings.");
      return;
    }
    let result;
    try { result = await api.detect(); }
    catch (e) { _fail("Scan failed: " + (e && e.message ? e.message : e)); return; }

    if (!result || !result.ok) {
      const reasonMap = {
        'no-sync-root': 'Set up a watch folder first (Settings → Watch Folder).',
        'no-watch-root': 'No watch folder is configured yet.',
        'no-store': 'The tracking store is not ready.',
      };
      _fail(reasonMap[result && result.reason] || ("Could not scan" + (result && result.reason ? ": " + result.reason : ".")));
      return;
    }

    _findings = result.findings || [];
    _render(result.highValueCount || 0);
  }

  function _render(highValueCount) {
    const list = $("list");
    while (list.firstChild) list.removeChild(list.firstChild);

    if (_findings.length === 0) {
      $("subtitle").textContent = "";
      $("empty").style.display = "block";
      $("apply-btn").setAttribute("disabled", "disabled");
      $("status").textContent = "";
      return;
    }

    // Build the subtitle from DOM nodes (no innerHTML — avoids any injection
    // surface even though only integers are interpolated).
    const sub = $("subtitle");
    while (sub.firstChild) sub.removeChild(sub.firstChild);
    sub.appendChild(document.createTextNode(
      `Found ${_findings.length} inconsistenc${_findings.length === 1 ? "y" : "ies"}. `));
    if (highValueCount > 0) {
      const b = document.createElement("b");
      b.textContent = `${highValueCount} involve item(s) with annotations or notes`;
      sub.appendChild(b);
      sub.appendChild(document.createTextNode(" — shown first and never deleted. "));
    }
    sub.appendChild(document.createTextNode(
      "Review each suggested fix, then apply. Nothing changes until you click Apply."));

    for (const f of _findings) {
      list.appendChild(_card(f));
    }
    $("apply-btn").removeAttribute("disabled");
    _updateStatus();
  }

  function _card(f) {
    const card = document.createElement("div");
    card.className = "card" + (f.highValue ? " high" : "");

    const row1 = document.createElement("div");
    row1.className = "row1";
    const dot = document.createElement("span");
    dot.className = "dot " + (f.severity || "low");
    row1.appendChild(dot);
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = f.title || "Inconsistency";
    row1.appendChild(title);
    if (f.highValue) {
      const badge = document.createElement("span");
      badge.className = "badge";
      const c = f.counts || {};
      badge.textContent = c.unknown
        ? "★ may have annotations/notes"
        : "★ " + (c.annotations || 0) + " annotation(s) · " + (c.notes || 0) + " note(s)";
      row1.appendChild(badge);
    }
    card.appendChild(row1);

    const detail = document.createElement("div");
    detail.className = "detail";
    detail.textContent = f.detail || "";
    card.appendChild(detail);

    if (f.path) {
      const path = document.createElement("div");
      path.className = "path";
      path.textContent = f.path;
      card.appendChild(path);
    }

    const act = document.createElement("div");
    act.className = "act";
    const lbl = document.createElement("label");
    lbl.textContent = "Fix:";
    act.appendChild(lbl);
    const sel = document.createElement("select");
    sel.setAttribute("data-finding", f.id);
    for (const a of (f.actions || [])) {
      const opt = document.createElement("option");
      opt.value = a.id;
      opt.textContent = a.label + (a.destructive ? "  (deletes data)" : "");
      if (a.destructive) opt.className = "destructive";
      // Pre-select the finding's default (recommended) action. High-value
      // items already carry a non-destructive default from the engine.
      if (a.id === f.defaultActionId) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener("change", _updateStatus);
    act.appendChild(sel);
    card.appendChild(act);

    return card;
  }

  function _decisions() {
    const sels = document.querySelectorAll("select[data-finding]");
    const d = {};
    for (const s of sels) d[s.getAttribute("data-finding")] = s.value;
    return d;
  }

  function _updateStatus() {
    const d = _decisions();
    let willApply = 0;
    for (const id in d) if (d[id] && d[id] !== "skip") willApply++;
    $("status").textContent = willApply + " of " + _findings.length + " will be fixed";
  }

  async function apply() {
    const api = _api();
    if (!api || typeof api.applyRepairs !== "function") { _fail("Repair unavailable."); return; }
    const decisions = _decisions();
    $("apply-btn").setAttribute("disabled", "disabled");
    $("status").textContent = "Applying…";
    let res;
    try { res = await api.applyRepairs(_findings, decisions); }
    catch (e) { _fail("Repair failed: " + (e && e.message ? e.message : e)); return; }

    const applied = (res && res.applied) || 0;
    const failed = (res && res.failed) || 0;
    const skipped = (res && res.skipped) || 0;
    try {
      Zotero.WatchFolder.__lastRepair = res; // for diagnostics
    } catch (_e) { /* */ }

    // Re-scan so the list reflects the new state (and any newly-exposed issues).
    await load();
    const tail = failed > 0 ? `, ${failed} could not be applied` : "";
    $("status").textContent = `Applied ${applied}, skipped ${skipped}${tail}.`;
  }

  function close() {
    try { window.close(); } catch (_e) { /* */ }
  }

  // Wire up on load.
  if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", () => { load(); });
  }

  return { apply, close, load };
})();
