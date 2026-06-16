/**
 * Unit tests for content/preferences.js — UX-1 Mode-3 deletion-disposition
 * picker (changeDiskDeleteOnTrash + refreshDeletionUI).
 *
 * preferences.js is NOT an ES module — it is a verbatim-copied IIFE loaded
 * into a Cu.Sandbox(window). It has no imports we can mock; instead we eval
 * the file's source inside a function scope with `window`, `document`,
 * `Zotero`, `Services`, `ChromeUtils`, etc. provided, and drive its public
 * surface via the `window.WatchFolderPrefs` object it exports.
 *
 * Covers:
 *   UT-220: changeDiskDeleteOnTrash('permanent') → setPref NOT called
 *   UT-221: changeDiskDeleteOnTrash(allowed) → persisted once
 *   UT-222: refreshDeletionUI hides the group outside Mode 3
 *   UT-223: permanent armed in Mode 3 → warn row visible, no card carries wf-sel
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PREFS_JS = path.resolve(__dirname, '../../content/preferences.js');
const SOURCE = fs.readFileSync(PREFS_JS, 'utf8');

// ── Minimal fake DOM ───────────────────────────────────────────────────────
// getElementById returns a fake element for ANY id (so init()'s other refresh
// helpers don't crash). Elements expose the surface the UX-1 code touches:
// classList.toggle / .hidden / .value / addEventListener. We retain them in a
// registry so tests can assert on specific ids.
function makeFakeElement(id) {
  const classes = new Set();
  return {
    id,
    hidden: false,
    value: undefined,
    classList: {
      _set: classes,
      toggle(name, on) {
        if (on === undefined) on = !classes.has(name);
        if (on) classes.add(name); else classes.delete(name);
        return on;
      },
      contains: (name) => classes.has(name),
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    appendChild: vi.fn(),
    setAttribute: vi.fn(),
  };
}

function makeFakeDocument() {
  const registry = new Map();
  return {
    _registry: registry,
    get(id) {
      if (!registry.has(id)) registry.set(id, makeFakeElement(id));
      return registry.get(id);
    },
    getElementById(id) {
      if (!registry.has(id)) registry.set(id, makeFakeElement(id));
      return registry.get(id);
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    createElement: () => makeFakeElement('created'),
    createXULElement: () => makeFakeElement('created-xul'),
    l10n: { translateFragment: vi.fn(async () => {}) },
  };
}

/**
 * Load preferences.js into a fresh scope. Returns { prefs, document, store }
 * where `store` is the in-memory pref backing for getPref/setPref.
 */
function loadPrefs(initialPrefs = {}) {
  const store = { ...initialPrefs };

  Zotero.Prefs.get = vi.fn((key) => {
    const short = key.replace('extensions.zotero.watchFolder.', '');
    return store[short];
  });
  Zotero.Prefs.set = vi.fn((key, value) => {
    const short = key.replace('extensions.zotero.watchFolder.', '');
    store[short] = value;
  });

  // `const { FilePicker } = ChromeUtils.importESModule(...)` must not throw.
  ChromeUtils.importESModule = vi.fn(() => ({ FilePicker: function () {} }));

  // changeMode() uses Services.prompt.confirm (not in geckoMocks by default).
  Services.prompt.confirm = vi.fn(() => true);

  const fakeWindow = {};
  const document = makeFakeDocument();

  // Run the IIFE in a controlled scope: shadow the free globals it reads.
  // eslint-disable-next-line no-new-func
  const run = new Function(
    'window', 'document', 'Zotero', 'Services', 'ChromeUtils',
    'MozXULElement', 'globalThis',
    SOURCE
  );
  run(fakeWindow, document, Zotero, Services, ChromeUtils, undefined, globalThis);

  return { prefs: fakeWindow.WatchFolderPrefs, document, store };
}

describe('UX-1 preferences: deletion-disposition picker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('UT-220: changeDiskDeleteOnTrash("permanent") is rejected — setPref NOT called', () => {
    const { prefs, store } = loadPrefs({ diskDeleteOnTrash: 'plugin_trash', mode: 'mode3' });
    Zotero.Prefs.set.mockClear();

    prefs.changeDiskDeleteOnTrash('permanent');

    expect(Zotero.Prefs.set).not.toHaveBeenCalled();
    expect(store.diskDeleteOnTrash).toBe('plugin_trash'); // unchanged
  });

  it('UT-221: an allowed value persists exactly once', () => {
    const { prefs, store } = loadPrefs({ diskDeleteOnTrash: 'plugin_trash', mode: 'mode3' });
    Zotero.Prefs.set.mockClear();

    prefs.changeDiskDeleteOnTrash('os_trash');

    expect(Zotero.Prefs.set).toHaveBeenCalledTimes(1);
    expect(Zotero.Prefs.set).toHaveBeenCalledWith(
      'extensions.zotero.watchFolder.diskDeleteOnTrash', 'os_trash', true
    );
    expect(store.diskDeleteOnTrash).toBe('os_trash');
  });

  it('UT-222: refreshDeletionUI hides the group outside Mode 3', () => {
    // Mode 1 → group hidden. (init() runs refreshDeletionUI via onLoad.)
    const { prefs, document } = loadPrefs({ diskDeleteOnTrash: 'plugin_trash', mode: 'mode1' });
    prefs.onLoad();
    expect(document.get('watch-folder-deletion-group').hidden).toBe(true);

    // Switching into Mode 3 reveals it; switching back hides it again.
    Services.prompt.confirm = vi.fn(() => true);
    prefs.changeMode('mode3');
    expect(document.get('watch-folder-deletion-group').hidden).toBe(false);

    prefs.changeMode('mode1');
    expect(document.get('watch-folder-deletion-group').hidden).toBe(true);
  });

  it('UT-223: permanent armed in Mode 3 → warn row visible, no card carries wf-sel', () => {
    const { prefs, document } = loadPrefs({ diskDeleteOnTrash: 'permanent', mode: 'mode3' });
    prefs.onLoad();

    const group = document.get('watch-folder-deletion-group');
    const warn = document.get('watch-folder-deletion-permanent-warn');
    expect(group.hidden).toBe(false);          // Mode 3 → group shown
    expect(warn.hidden).toBe(false);            // permanent → warn/revert row revealed

    // None of the four offered cards is marked as the current selection,
    // because 'permanent' is not one of them.
    for (const v of ['ask', 'plugin_trash', 'os_trash', 'never']) {
      const card = document.get('wf-deletion-opt-' + v);
      expect(card.classList.contains('wf-sel')).toBe(false);
    }

    // Reverting to plugin_trash hides the warn row and marks that card.
    prefs.changeDiskDeleteOnTrash('plugin_trash');
    expect(document.get('watch-folder-deletion-permanent-warn').hidden).toBe(true);
    expect(document.get('wf-deletion-opt-plugin_trash').classList.contains('wf-sel')).toBe(true);
  });
});
