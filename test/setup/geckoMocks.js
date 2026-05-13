// Mock Zotero/Mozilla globals for Vitest
import { vi } from 'vitest';

// --- Zotero ---
globalThis.Zotero = {
  debug: vi.fn(),
  logError: vi.fn(),
  log: vi.fn(),
  warn: vi.fn(),
  isWin: false,
  isMac: false,
  isLinux: true,
  Prefs: {
    get: vi.fn((key, fallback) => fallback),
    set: vi.fn(),
  },
  Collections: {
    getByLibrary: vi.fn(() => []),
    get: vi.fn(),
    getLoaded: vi.fn(),
  },
  Items: {
    get: vi.fn(),
  },
  Libraries: {
    userLibraryID: 1,
  },
  Notifier: {
    registerObserver: vi.fn(() => 'observer-1'),
    unregisterObserver: vi.fn(),
  },
  Attachments: {
    importFromFile: vi.fn(),
    linkFromFile: vi.fn(),
  },
  RecognizeDocument: {
    recognizeItems: vi.fn(),
    autoRecognizeItems: vi.fn(),
  },
  DB: {
    executeTransaction: vi.fn(async (fn) => fn()),
  },
  Promise: {
    delay: vi.fn((ms) => new Promise((r) => setTimeout(r, ms))),
  },
  getMainWindows: vi.fn(() => []),
  hiDPI: false,
  // ProgressWindow is invoked as a constructor by firstRunHandler.
  // The returned instance also exposes ItemProgress as a nested constructor.
  ProgressWindow: vi.fn(function () {
    return {
      changeHeadline: vi.fn(),
      addDescription: vi.fn(),
      addLines: vi.fn(),
      show: vi.fn(),
      startCloseTimer: vi.fn(),
      close: vi.fn(),
      ItemProgress: vi.fn(function () {
        return {
          setProgress: vi.fn(),
          setText: vi.fn(),
          setIcon: vi.fn(),
        };
      }),
      progress: {
        setProgress: vi.fn(),
        setText: vi.fn(),
      },
    };
  }),
};

// --- IOUtils ---
globalThis.IOUtils = {
  exists: vi.fn(async () => true),
  stat: vi.fn(async (path) => ({
    type: 'regular',
    size: 1024,
    lastModified: Date.now(),
    path,
  })),
  read: vi.fn(async () => new Uint8Array([1, 2, 3])),
  readJSON: vi.fn(async () => ({})),
  readUTF8: vi.fn(async () => ''),
  writeJSON: vi.fn(async () => {}),
  writeUTF8: vi.fn(async () => {}),
  getChildren: vi.fn(async () => []),
  makeDirectory: vi.fn(async () => {}),
  move: vi.fn(async () => {}),
  copy: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
};

// --- PathUtils ---
globalThis.PathUtils = {
  join: vi.fn((...parts) => parts.join('/')),
  filename: vi.fn((path) => {
    const sep = path.includes('\\') ? '\\' : '/';
    return path.split(sep).pop();
  }),
  parent: vi.fn((path) => {
    const sep = path.includes('\\') ? '\\' : '/';
    const parts = path.split(sep);
    parts.pop();
    return parts.join(sep);
  }),
};

// --- crypto.subtle ---
if (!globalThis.crypto) {
  globalThis.crypto = {};
}
if (!globalThis.crypto.subtle) {
  globalThis.crypto.subtle = {
    digest: vi.fn(async (algo, data) => {
      // Return a fake 16-byte ArrayBuffer for testing
      return new ArrayBuffer(16);
    }),
  };
}

// --- Services ---
globalThis.Services = {
  io: {
    newURI: vi.fn((uri) => ({ spec: uri })),
  },
  prefs: {
    getBranch: vi.fn(() => ({
      getCharPref: vi.fn(() => ''),
      setCharPref: vi.fn(),
      getIntPref: vi.fn(() => 0),
      setIntPref: vi.fn(),
      getBoolPref: vi.fn(() => false),
      setBoolPref: vi.fn(),
    })),
  },
  prompt: {
    BUTTON_POS_0: 1,
    BUTTON_POS_1: 256,
    BUTTON_POS_2: 65536,
    BUTTON_POS_0_DEFAULT: 0x01000000,
    BUTTON_TITLE_IS_STRING: 127,
    BUTTON_TITLE_CANCEL: 1,
    confirmEx: vi.fn(() => 0), // default: approve
    alert: vi.fn(),
  },
};

// --- Components (XPCOM) ---
// Minimal stub that lets watchFolder._moveToOSTrash exercise the
// nsIFile.moveToTrash path. Tests can override Components.classes[...] etc.
function _makeMockNsIFile() {
  return {
    initWithPath: vi.fn(),
    moveToTrash: vi.fn(),
  };
}
globalThis.Components = {
  classes: {
    '@mozilla.org/file/local;1': {
      createInstance: vi.fn(() => _makeMockNsIFile()),
    },
  },
  interfaces: {
    nsIFile: {},
  },
};
globalThis._makeMockNsIFile = _makeMockNsIFile;

// --- ChromeUtils ---
globalThis.ChromeUtils = {
  importESModule: vi.fn(),
  defineLazyGetter: vi.fn(),
};

// --- TextEncoder/TextDecoder (already available in Node, but ensure) ---
if (!globalThis.TextEncoder) {
  globalThis.TextEncoder = TextEncoder;
}
if (!globalThis.TextDecoder) {
  globalThis.TextDecoder = TextDecoder;
}
