/**
 * Unit tests for content/metadataRetriever.mjs.
 *
 * Current coverage: only the queueItem dedup Set introduced in
 * WP-B / B6. The broader retrieve / notifier behaviour is exercised
 * by the MCP runbooks against a live Zotero — CLAUDE.md notes that
 * `metadataRetriever.mjs` intentionally has zero unit coverage for
 * the recognition path (it depends on Zotero.RecognizeDocument).
 *
 * Covers:
 *   UT-029 (WP-B / B6) queueItem dedup via _queuedIDs Set
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MetadataRetriever } from '../../content/metadataRetriever.mjs';

function makeRetriever() {
  return new MetadataRetriever();
}

beforeEach(() => {
  // Reset Zotero stubs so debug/logError calls from earlier tests don't
  // affect spies we set up here.
  vi.resetAllMocks();
  Zotero.debug = vi.fn();
  Zotero.logError = vi.fn();
  Zotero.Prefs = { get: vi.fn((_k, fallback) => fallback) };
  Zotero.Notifier = { registerObserver: vi.fn(() => 'observer-1'), unregisterObserver: vi.fn() };
});

// ─── UT-029 (WP-B / B6) ─────────────────────────────────────────────────────

describe('UT-029 — queueItem dedup via _queuedIDs Set (WP-B / B6)', () => {
  it('a: enqueuing a new itemID grows both _queue and _queuedIDs', () => {
    const r = makeRetriever();
    r._isRunning = false; // prevent _processQueue from draining
    r.queueItem(123);
    expect(r._queue).toHaveLength(1);
    expect(r._queuedIDs.has(123)).toBe(true);
  });

  it('b: re-queuing the same itemID is rejected (Set-backed dedup)', () => {
    const r = makeRetriever();
    r._isRunning = false;
    r.queueItem(123);
    r.queueItem(123);
    r.queueItem(123);
    expect(r._queue).toHaveLength(1);
    expect(r._queuedIDs.size).toBe(1);
  });

  it('c: distinct itemIDs all queue (no false positives)', () => {
    const r = makeRetriever();
    r._isRunning = false;
    r.queueItem(1);
    r.queueItem(2);
    r.queueItem(3);
    expect(r._queue).toHaveLength(3);
    expect(r._queuedIDs.size).toBe(3);
  });

  it('d: _processQueue removes from both _queue and _queuedIDs on drain', async () => {
    const r = makeRetriever();
    r._isRunning = true;
    // Stub the actual retrieval to a no-op so the test doesn't hit
    // Zotero.RecognizeDocument or wait for the inter-item delay.
    r._retrieveMetadata = vi.fn(async () => true);
    r._delayBetween = 0;
    r.queueItem(1);
    r.queueItem(2);
    // Let the queue drain.
    await new Promise(res => setTimeout(res, 30));
    // Both items should be gone from the Set.
    expect(r._queuedIDs.has(1)).toBe(false);
    expect(r._queuedIDs.has(2)).toBe(false);
    expect(r._queue).toHaveLength(0);
  });

  it('e: clearQueue empties both _queue and _queuedIDs', () => {
    const r = makeRetriever();
    r._isRunning = false;
    r.queueItem(1);
    r.queueItem(2);
    r.queueItem(3);
    r.clearQueue();
    expect(r._queue).toHaveLength(0);
    expect(r._queuedIDs.size).toBe(0);
  });

  it('f: queueItems iterates and dedupes the same as queueItem', () => {
    const r = makeRetriever();
    r._isRunning = false;
    r.queueItems([1, 2, 2, 3, 1]);
    expect(r._queue).toHaveLength(3);
    expect([...r._queuedIDs].sort()).toEqual([1, 2, 3]);
  });

  it('g: after drain, the same itemID can be queued again (Set entry was released)', async () => {
    const r = makeRetriever();
    r._isRunning = true;
    r._retrieveMetadata = vi.fn(async () => true);
    r._delayBetween = 0;
    r.queueItem(42);
    await new Promise(res => setTimeout(res, 20));
    expect(r._queuedIDs.has(42)).toBe(false);
    // Stop processing so the next enqueue can't immediately drain.
    r._isRunning = false;
    r.queueItem(42);
    expect(r._queuedIDs.has(42)).toBe(true);
    expect(r._queue).toHaveLength(1);
  });

  it('h: queue ordering is preserved (FIFO) — Set is parallel, not primary', async () => {
    const r = makeRetriever();
    r._isRunning = true;
    const order = [];
    r._retrieveMetadata = vi.fn(async (id) => { order.push(id); return true; });
    r._delayBetween = 0;
    r._maxConcurrent = 1; // serial processing
    r.queueItem(10);
    r.queueItem(20);
    r.queueItem(30);
    await new Promise(res => setTimeout(res, 50));
    expect(order).toEqual([10, 20, 30]);
  });
});
