/**
 * Unit tests for content/watchRootGuard.mjs (v2.7 delete-safety at library scale).
 *
 * Covers:
 *   UT-700 topLevelDirNames — only dirs whose parent IS the watch root
 *   UT-701 fingerprint round-trip (record → read)
 *   UT-702 checkTopLevelCollapse — bootstrap / floor / >50% collapse / healthy
 *   UT-703 checkCycleAggregate — top-level cap / absolute cap / relative cap / small-set no-trip
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../content/utils.mjs', () => ({
  getPref: vi.fn(),
  setPref: vi.fn(),
}));

import {
  topLevelDirNames,
  readFingerprint,
  recordHealthyFingerprint,
  checkTopLevelCollapse,
  checkCycleAggregate,
} from '../../content/watchRootGuard.mjs';
import { getPref, setPref } from '../../content/utils.mjs';

const WATCH = '/watch';

beforeEach(() => {
  vi.clearAllMocks();
  Zotero.debug = vi.fn();
});

// ─── UT-700 ──────────────────────────────────────────────────────────────────
describe('UT-700: topLevelDirNames', () => {
  it('returns only basenames of dirs directly under the watch root', () => {
    const dirs = new Set([
      '/watch/Projects',
      '/watch/Topics',
      '/watch/Projects/Alpha',   // nested — excluded
      '/elsewhere/Other',        // not under root — excluded
    ]);
    const names = topLevelDirNames(dirs, WATCH).sort();
    expect(names).toEqual(['Projects', 'Topics']);
  });

  it('accepts an array as well as a Set', () => {
    expect(topLevelDirNames(['/watch/A', '/watch/B'], WATCH).sort()).toEqual(['A', 'B']);
  });
});

// ─── UT-701 ──────────────────────────────────────────────────────────────────
describe('UT-701: fingerprint round-trip', () => {
  it('recordHealthyFingerprint persists JSON; readFingerprint parses it back', () => {
    let stored;
    setPref.mockImplementation((_k, v) => { stored = v; });
    getPref.mockImplementation(() => stored);
    const fp = recordHealthyFingerprint(['A', 'B', 'C']);
    expect(fp.count).toBe(3);
    expect(readFingerprint()).toEqual({ count: 3, namesHash: 'A/B/C' });
  });

  it('readFingerprint returns null on empty / corrupt pref', () => {
    getPref.mockReturnValue('');
    expect(readFingerprint()).toBe(null);
    getPref.mockReturnValue('{not json');
    expect(readFingerprint()).toBe(null);
  });
});

// ─── UT-702 ──────────────────────────────────────────────────────────────────
describe('UT-702: checkTopLevelCollapse', () => {
  it('bootstraps (not collapsed) when no fingerprint exists', () => {
    getPref.mockReturnValue('');
    const r = checkTopLevelCollapse(['A', 'B']);
    expect(r).toMatchObject({ collapsed: false, bootstrap: true });
  });

  it('does not arm below the floor (prev.count < 2)', () => {
    getPref.mockReturnValue(JSON.stringify({ count: 1, namesHash: 'A' }));
    expect(checkTopLevelCollapse([]).collapsed).toBe(false);
  });

  it('flags a >50% collapse as transient', () => {
    getPref.mockReturnValue(JSON.stringify({ count: 8, namesHash: 'x' }));
    const r = checkTopLevelCollapse(['A', 'B', 'C']); // 3 ≤ 4 (50% of 8)
    expect(r.collapsed).toBe(true);
    expect(r.prevCount).toBe(8);
    expect(r.curCount).toBe(3);
  });

  it('treats a small drop (>50% remain) as healthy', () => {
    getPref.mockReturnValue(JSON.stringify({ count: 4, namesHash: 'x' }));
    expect(checkTopLevelCollapse(['A', 'B', 'C']).collapsed).toBe(false); // 3 of 4
  });

  it('exactly 50% remaining IS a collapse (≤ boundary)', () => {
    getPref.mockReturnValue(JSON.stringify({ count: 4, namesHash: 'x' }));
    expect(checkTopLevelCollapse(['A', 'B']).collapsed).toBe(true); // 2 ≤ 2
  });
});

// ─── UT-703 ──────────────────────────────────────────────────────────────────
describe('UT-703: checkCycleAggregate', () => {
  it('trips when more than 3 top-level folders are missing', () => {
    expect(checkCycleAggregate({ missingTopLevel: 4, missingTotal: 4, totalTracked: 100 }).trip).toBe(true);
  });

  it('trips on a large absolute count even at low relative share', () => {
    expect(checkCycleAggregate({ missingTopLevel: 0, missingTotal: 30, totalTracked: 2000 }).trip).toBe(true);
  });

  it('trips on a high relative share past the floor', () => {
    expect(checkCycleAggregate({ missingTopLevel: 0, missingTotal: 5, totalTracked: 10 }).trip).toBe(true); // 5 > 3 and 50% > 25%
  });

  it('does NOT trip when a small library loses all its (few) folders', () => {
    // 2 of 2 nested folders → not mass deletion; the absolute floor protects.
    expect(checkCycleAggregate({ missingTopLevel: 0, missingTotal: 2, totalTracked: 2 }).trip).toBe(false);
  });

  it('does NOT trip for 3 missing top-level folders (boundary)', () => {
    expect(checkCycleAggregate({ missingTopLevel: 3, missingTotal: 3, totalTracked: 50 }).trip).toBe(false);
  });
});
