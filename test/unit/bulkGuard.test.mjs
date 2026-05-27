/**
 * Unit tests for content/bulkGuard.mjs.
 *
 * Covers:
 *   UT-110: isBulkDelete (count + percent thresholds)
 *   UT-111: confirmBulkDelete (prompt + decline + missing-services refusal)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isBulkDelete, confirmBulkDelete, __test_resetPromptInFlight } from '../../content/bulkGuard.mjs';

describe('UT-110: isBulkDelete', () => {
  it('returns false for 0 or 1 affected', () => {
    expect(isBulkDelete(0, 100)).toBe(false);
    expect(isBulkDelete(1, 100)).toBe(false);
  });

  it('returns true when affected > 10 regardless of total', () => {
    expect(isBulkDelete(11, 1000)).toBe(true);
    expect(isBulkDelete(11, 100)).toBe(true);
    expect(isBulkDelete(50, 1000)).toBe(true);
  });

  it('returns true when affected/total > 20% (even if affected ≤ 10)', () => {
    // 3 out of 10 = 30% > 20% → bulk
    expect(isBulkDelete(3, 10)).toBe(true);
    // 2 out of 5 = 40% → bulk
    expect(isBulkDelete(2, 5)).toBe(true);
  });

  it('returns false when both thresholds NOT exceeded', () => {
    // 2 out of 50 = 4% → safe
    expect(isBulkDelete(2, 50)).toBe(false);
    // 10 out of 100 = 10% → safe (10 is not > 10, and 10% < 20%)
    expect(isBulkDelete(10, 100)).toBe(false);
  });

  it('handles unknown totalTracked (0) gracefully — only count threshold applies', () => {
    expect(isBulkDelete(5, 0)).toBe(false);
    expect(isBulkDelete(11, 0)).toBe(true);
  });
});

describe('UT-111: confirmBulkDelete', () => {
  beforeEach(() => {
    // Reset the geckoMocks Services.prompt default (returns 0 = approve).
    Services.prompt.confirmEx.mockClear();
    Services.prompt.confirmEx.mockReturnValue(0);
    __test_resetPromptInFlight();
  });

  it('returns true when user picks button 0 (Proceed)', async () => {
    Services.prompt.confirmEx.mockReturnValue(0);
    const ok = await confirmBulkDelete({
      action: 'trash', path: '/x', affectedCount: 50, totalTracked: 200,
    });
    expect(ok).toBe(true);
    expect(Services.prompt.confirmEx).toHaveBeenCalledTimes(1);
  });

  it('returns false when user picks button 1 (Cancel)', async () => {
    Services.prompt.confirmEx.mockReturnValue(1);
    const ok = await confirmBulkDelete({
      action: 'trash', path: '/x', affectedCount: 50, totalTracked: 200,
    });
    expect(ok).toBe(false);
  });

  it('refuses (false) when Services.prompt is unavailable', async () => {
    const original = Services.prompt;
    Services.prompt = undefined;
    try {
      const ok = await confirmBulkDelete({
        action: 'trash', path: '/x', affectedCount: 50, totalTracked: 200,
      });
      expect(ok).toBe(false);
    } finally {
      Services.prompt = original;
    }
  });

  it('refuses (false) when Services itself is unavailable', async () => {
    const original = globalThis.Services;
    globalThis.Services = undefined;
    try {
      const ok = await confirmBulkDelete({
        action: 'trash', path: '/x', affectedCount: 50, totalTracked: 200,
      });
      expect(ok).toBe(false);
    } finally {
      globalThis.Services = original;
    }
  });

  it('formats the prompt message with percent + count + path', async () => {
    Services.prompt.confirmEx.mockReturnValue(0);
    await confirmBulkDelete({
      action: 'trash', path: 'Methods', affectedCount: 30, totalTracked: 100,
    });
    const args = Services.prompt.confirmEx.mock.calls[0];
    // Arg 2 is the message; should include "30", "30% of 100", "Methods", "trash"
    expect(args[2]).toContain('30 tracked file(s)');
    expect(args[2]).toContain('30% of 100');
    expect(args[2]).toContain('"Methods"');
    expect(args[2]).toContain('trash');
  });

  // ── Re-entrancy guard (fix for the 2026-05-27 DEL.3 stacked-modal find).
  it('declines a re-entrant call while a prompt is in flight', async () => {
    // Simulate the Mozilla nested-event-loop case: while confirmEx is
    // synchronously executing, another call to confirmBulkDelete
    // reaches the guard. The re-entrant call must return false
    // WITHOUT invoking confirmEx again — otherwise it would stack a
    // second modal on top of the first (live-observed during the
    // 2026-05-27 MCP run). Sync mock here matches production semantics
    // (`Services.prompt.confirmEx` returns a number, not a Promise).
    let reentrantPromise = null;
    Services.prompt.confirmEx.mockImplementation(() => {
      // _promptInFlight is set NOW (synchronously, before the body's
      // first await), so the reentrant call's guard check fires
      // immediately and returns a Promise resolving to false.
      reentrantPromise = confirmBulkDelete({
        action: 'second-call', path: '/y', affectedCount: 20, totalTracked: 50,
      });
      return 0; // outer "Proceed"
    });
    const outer = await confirmBulkDelete({
      action: 'first-call', path: '/x', affectedCount: 50, totalTracked: 200,
    });
    const reentrantResult = await reentrantPromise;
    expect(outer).toBe(true);
    expect(reentrantResult).toBe(false);
    // Only ONE confirmEx call total — the reentrant one was short-circuited.
    expect(Services.prompt.confirmEx).toHaveBeenCalledTimes(1);
  });

  it('clears the in-flight flag after the prompt resolves (next call works)', async () => {
    // First call returns Proceed.
    Services.prompt.confirmEx.mockReturnValueOnce(0);
    const a = await confirmBulkDelete({
      action: 'a', path: '/x', affectedCount: 20, totalTracked: 100,
    });
    expect(a).toBe(true);
    // Second call (after the first resolved) should reach confirmEx normally.
    Services.prompt.confirmEx.mockReturnValueOnce(1);
    const b = await confirmBulkDelete({
      action: 'b', path: '/y', affectedCount: 20, totalTracked: 100,
    });
    expect(b).toBe(false);
    expect(Services.prompt.confirmEx).toHaveBeenCalledTimes(2);
  });

  it('clears the in-flight flag if confirmEx throws', async () => {
    // First call: confirmEx throws. Flag must still be cleared so a
    // subsequent call can reach the prompt.
    Services.prompt.confirmEx.mockImplementationOnce(() => { throw new Error('mock-throw'); });
    let threw = null;
    try {
      await confirmBulkDelete({
        action: 'a', path: '/x', affectedCount: 20, totalTracked: 100,
      });
    } catch (e) { threw = e; }
    expect(threw?.message).toBe('mock-throw');
    // Second call works.
    Services.prompt.confirmEx.mockReturnValueOnce(0);
    const b = await confirmBulkDelete({
      action: 'b', path: '/y', affectedCount: 20, totalTracked: 100,
    });
    expect(b).toBe(true);
  });
});
