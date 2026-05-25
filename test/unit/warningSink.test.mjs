/**
 * Unit tests for content/warningSink.mjs (v2.1 Phase D).
 *
 * Covers:
 *   UT-701 report() records, increments counts, fires listeners
 *   UT-702 ring buffer eviction at RING_CAPACITY
 *   UT-703 getRecent(n) returns newest n
 *   UT-704 subscribe / unsubscribe
 *   UT-705 clear() drops state, notifies listeners with cleared marker
 *   UT-706 report() ignores invalid input
 *   UT-707 counts survive ring eviction
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  report,
  getRecent,
  getTotalCount,
  getCountsByCategory,
  subscribe,
  clear,
  WARNING_CATEGORY,
  _resetForTesting,
} from '../../content/warningSink.mjs';

beforeEach(() => {
  Zotero.debug = vi.fn();
  Zotero.logError = vi.fn();
  _resetForTesting();
});

// ─── UT-701 ────────────────────────────────────────────────────────────────

describe('UT-701: report() records, counts, notifies', () => {
  it('stores the entry and increments per-category counts', () => {
    const stored = report({
      category: WARNING_CATEGORY.CONFLICT_BLOCKED,
      message: 'hash drift on X',
      attachmentKey: 'ATT1',
    });
    expect(stored).toBeTruthy();
    expect(stored.category).toBe('conflict-blocked');
    expect(stored.timestamp).toBeGreaterThan(0);
    expect(getTotalCount()).toBe(1);
    expect(getCountsByCategory().get('conflict-blocked')).toBe(1);
  });

  it('fires subscribers synchronously', () => {
    const seen = [];
    subscribe((entry) => seen.push(entry));
    report({ category: WARNING_CATEGORY.MISSING_FILE, message: 'gone' });
    expect(seen.length).toBe(1);
    expect(seen[0].message).toBe('gone');
  });
});

// ─── UT-702 ────────────────────────────────────────────────────────────────

describe('UT-702: ring buffer eviction', () => {
  it('drops oldest entries past capacity (100)', () => {
    for (let i = 0; i < 105; i++) {
      report({ category: WARNING_CATEGORY.IO_ERROR, message: `msg${i}` });
    }
    const recent = getRecent(105);
    expect(recent.length).toBe(100);
    expect(recent[0].message).toBe('msg5');
    expect(recent[99].message).toBe('msg104');
  });
});

// ─── UT-703 ────────────────────────────────────────────────────────────────

describe('UT-703: getRecent(n) returns newest n', () => {
  it('returns the tail oldest-first', () => {
    for (let i = 0; i < 10; i++) {
      report({ category: WARNING_CATEGORY.IO_ERROR, message: `m${i}` });
    }
    const recent = getRecent(3);
    expect(recent.map((r) => r.message)).toEqual(['m7', 'm8', 'm9']);
  });

  it('returns [] for n<=0 or non-number', () => {
    report({ category: WARNING_CATEGORY.IO_ERROR, message: 'x' });
    expect(getRecent(0)).toEqual([]);
    expect(getRecent(-5)).toEqual([]);
    expect(getRecent('not a number')).toEqual([]);
    expect(getRecent(NaN)).toEqual([]);
  });
});

// ─── UT-704 ────────────────────────────────────────────────────────────────

describe('UT-704: subscribe / unsubscribe', () => {
  it('returns an unsubscribe function', () => {
    const seen = [];
    const unsub = subscribe((e) => seen.push(e));
    report({ category: WARNING_CATEGORY.IO_ERROR });
    unsub();
    report({ category: WARNING_CATEGORY.IO_ERROR });
    expect(seen.length).toBe(1);
  });

  it('non-function subscribers return a no-op unsub', () => {
    const unsub = subscribe('not a fn');
    expect(typeof unsub).toBe('function');
    expect(() => unsub()).not.toThrow();
  });

  it('subscriber errors do not propagate', () => {
    subscribe(() => { throw new Error('boom'); });
    expect(() => report({ category: WARNING_CATEGORY.IO_ERROR })).not.toThrow();
    expect(Zotero.logError).toHaveBeenCalled();
  });
});

// ─── UT-705 ────────────────────────────────────────────────────────────────

describe('UT-705: clear()', () => {
  it('empties ring + counts and notifies with cleared marker', () => {
    const seen = [];
    subscribe((e) => seen.push(e));
    report({ category: WARNING_CATEGORY.IO_ERROR });
    report({ category: WARNING_CATEGORY.IO_ERROR });
    clear();
    expect(getTotalCount()).toBe(0);
    expect(getRecent(10)).toEqual([]);
    expect(seen[seen.length - 1]).toMatchObject({ cleared: true });
  });

  it('keeps listeners alive — subscribers still receive new entries after clear()', () => {
    const seen = [];
    subscribe((e) => seen.push(e));
    report({ category: WARNING_CATEGORY.IO_ERROR, message: 'before clear' });
    clear();
    report({ category: WARNING_CATEGORY.IO_ERROR, message: 'after clear' });
    // Expect: original entry, the synthetic `cleared` marker, and the
    // post-clear entry — proving the subscriber wasn't dropped.
    expect(seen).toHaveLength(3);
    expect(seen[0]).toMatchObject({ message: 'before clear' });
    expect(seen[1]).toMatchObject({ cleared: true });
    expect(seen[2]).toMatchObject({ message: 'after clear' });
  });
});

// ─── UT-706 ────────────────────────────────────────────────────────────────

describe('UT-706: invalid input', () => {
  it('returns null for null / non-object / missing category', () => {
    expect(report(null)).toBe(null);
    expect(report(undefined)).toBe(null);
    expect(report('string')).toBe(null);
    expect(report({})).toBe(null);
    expect(report({ category: 42 })).toBe(null);
    expect(getTotalCount()).toBe(0);
  });
});

// ─── UT-707 ────────────────────────────────────────────────────────────────

describe('UT-707: counts survive ring eviction', () => {
  it('keeps total count accurate even after ring overflow', () => {
    for (let i = 0; i < 150; i++) {
      report({ category: WARNING_CATEGORY.IO_ERROR, message: `m${i}` });
    }
    expect(getTotalCount()).toBe(150);
    expect(getRecent(1000).length).toBe(100);
  });
});
