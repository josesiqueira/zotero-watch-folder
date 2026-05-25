/**
 * Unit tests for content/bulkGuard.mjs.
 *
 * Covers:
 *   UT-110: isBulkDelete (count + percent thresholds)
 *   UT-111: confirmBulkDelete (prompt + decline + missing-services refusal)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isBulkDelete, confirmBulkDelete } from '../../content/bulkGuard.mjs';

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
});
