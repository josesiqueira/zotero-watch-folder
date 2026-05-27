/**
 * Unit tests for smartRules.mjs — UT-021 through UT-027
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SmartRulesEngine,
  createRule,
  createCondition,
  createAction,
} from '../../content/smartRules.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal mock Zotero item whose getFieldValue returns a given value
 * for ANY field.  We override getFieldValue on the engine instance to keep
 * evaluateCondition isolated.
 */
function makeMockItem(overrides = {}) {
  return {
    getField: vi.fn(() => ''),
    getCreators: vi.fn(() => []),
    getTags: vi.fn(() => []),
    itemType: '',
    itemTypeID: null,
    isAttachment: vi.fn(() => false),
    getFilePath: vi.fn(() => ''),
    getCollections: vi.fn(() => []),
    addToCollection: vi.fn(),
    addTag: vi.fn(),
    setField: vi.fn(),
    saveTx: vi.fn(async () => {}),
    ...overrides,
  };
}

/**
 * Create a fresh engine (no singleton contamination).
 */
function makeEngine() {
  return new SmartRulesEngine();
}

/**
 * Override engine.getFieldValue so that evaluateCondition receives a specific
 * fieldValue regardless of what the mock item provides.
 */
function stubFieldValue(engine, returnValue) {
  vi.spyOn(engine, 'getFieldValue').mockReturnValue(returnValue);
}

// ---------------------------------------------------------------------------
// UT-021 — SmartRulesEngine.evaluateCondition — all operators
// ---------------------------------------------------------------------------
describe('UT-021 — SmartRulesEngine.evaluateCondition — all operators', () => {
  let engine;
  let item;

  beforeEach(() => {
    engine = makeEngine();
    item = makeMockItem();
  });

  // UT-021a
  it('a: contains — field has substring (case-insensitive)', () => {
    stubFieldValue(engine, 'neural networks');
    const cond = { field: 'title', operator: 'contains', value: 'neural', caseSensitive: false };
    expect(engine.evaluateCondition(cond, item)).toBe(true);
  });

  // UT-021b
  it('b: contains — value is uppercase, case-insensitive match', () => {
    stubFieldValue(engine, 'neural networks');
    const cond = { field: 'title', operator: 'contains', value: 'NEURAL', caseSensitive: false };
    expect(engine.evaluateCondition(cond, item)).toBe(true);
  });

  // UT-021c
  it('c: notContains — field does not have value', () => {
    stubFieldValue(engine, 'neural networks');
    const cond = { field: 'title', operator: 'notContains', value: 'quantum', caseSensitive: false };
    expect(engine.evaluateCondition(cond, item)).toBe(true);
  });

  // UT-021d
  it('d: equals — same value', () => {
    stubFieldValue(engine, 'foo');
    const cond = { field: 'title', operator: 'equals', value: 'foo', caseSensitive: false };
    expect(engine.evaluateCondition(cond, item)).toBe(true);
  });

  // UT-021e
  it('e: equals — case-insensitive match', () => {
    stubFieldValue(engine, 'foo');
    const cond = { field: 'title', operator: 'equals', value: 'FOO', caseSensitive: false };
    expect(engine.evaluateCondition(cond, item)).toBe(true);
  });

  // UT-021f
  it('f: equals — case-sensitive mismatch', () => {
    stubFieldValue(engine, 'foo');
    const cond = { field: 'title', operator: 'equals', value: 'FOO', caseSensitive: true };
    expect(engine.evaluateCondition(cond, item)).toBe(false);
  });

  // UT-021g
  it('g: notEquals — different values', () => {
    stubFieldValue(engine, 'foo');
    const cond = { field: 'title', operator: 'notEquals', value: 'bar', caseSensitive: false };
    expect(engine.evaluateCondition(cond, item)).toBe(true);
  });

  // UT-021h
  it('h: startsWith', () => {
    stubFieldValue(engine, 'neural');
    const cond = { field: 'title', operator: 'startsWith', value: 'neu', caseSensitive: false };
    expect(engine.evaluateCondition(cond, item)).toBe(true);
  });

  // UT-021i
  it('i: endsWith', () => {
    stubFieldValue(engine, 'neural');
    const cond = { field: 'title', operator: 'endsWith', value: 'ral', caseSensitive: false };
    expect(engine.evaluateCondition(cond, item)).toBe(true);
  });

  // UT-021j
  it('j: matchesRegex — numeric pattern matches', () => {
    // matchesRegex uses original (not lowercased) fieldValue internally,
    // fetching it via getFieldValue again.  We need getFieldValue to return
    // the right value on both calls.
    vi.spyOn(engine, 'getFieldValue').mockReturnValue('paper-2023');
    const cond = { field: 'title', operator: 'matchesRegex', value: '\\d{4}', caseSensitive: false };
    expect(engine.evaluateCondition(cond, item)).toBe(true);
  });

  // UT-021k
  it('k: matchesRegex — invalid regex returns false without throwing', () => {
    vi.spyOn(engine, 'getFieldValue').mockReturnValue('paper');
    const cond = { field: 'title', operator: 'matchesRegex', value: '[invalid', caseSensitive: false };
    expect(() => engine.evaluateCondition(cond, item)).not.toThrow();
    expect(engine.evaluateCondition(cond, item)).toBe(false);
  });

  // ── ReDoS defense (security audit 2026-05-27) ────────────────────────
  it('k.1: matchesRegex — rejects patterns over the length cap (512 chars)', () => {
    vi.spyOn(engine, 'getFieldValue').mockReturnValue('paper');
    // 513-char pattern — over the cap. Should return false WITHOUT compiling
    // (so even a pathological pattern wouldn't pin the thread).
    const bigPattern = 'a'.repeat(513);
    const cond = { field: 'title', operator: 'matchesRegex', value: bigPattern, caseSensitive: false };
    const start = Date.now();
    const result = engine.evaluateCondition(cond, item);
    expect(result).toBe(false);
    expect(Date.now() - start).toBeLessThan(50); // didn't compile or run
  });

  it('k.2: matchesRegex — caps long input strings to 8 KB before .test()', () => {
    // A simple anchored pattern that would match somewhere in a long string.
    // If the cap is enforced, the slice happens BEFORE .test() and the result
    // is whatever .test() returns on the truncated input.
    const longInput = 'x'.repeat(20000) + 'NEEDLE';
    vi.spyOn(engine, 'getFieldValue').mockReturnValue(longInput);
    const cond = { field: 'title', operator: 'matchesRegex', value: 'NEEDLE', caseSensitive: false };
    // NEEDLE is past the 8KB cap (8192 chars in) — gets truncated away.
    // So the match should NOT find it.
    expect(engine.evaluateCondition(cond, item)).toBe(false);
  });

  it('k.3: matchesRegex — short input still matches (cap doesn\'t affect normal use)', () => {
    vi.spyOn(engine, 'getFieldValue').mockReturnValue('a normal title with NEEDLE in it');
    const cond = { field: 'title', operator: 'matchesRegex', value: 'NEEDLE', caseSensitive: false };
    expect(engine.evaluateCondition(cond, item)).toBe(true);
  });

  it('k.4: matchesRegex — pathological pattern + long input completes quickly thanks to cap', () => {
    // (a+)+$ classic ReDoS pattern against a long string that mostly matches
    // would be exponential WITHOUT the cap. With the 8KB cap and a short
    // enough pattern, it stays bounded.
    vi.spyOn(engine, 'getFieldValue').mockReturnValue('a'.repeat(10000) + 'b');
    const cond = { field: 'title', operator: 'matchesRegex', value: '(a+)+$', caseSensitive: false };
    const start = Date.now();
    engine.evaluateCondition(cond, item);
    // Truncated input still ends with 'a' (the trailing 'b' is past cap),
    // so the regex returns quickly because the truncated input matches.
    // Either way, the elapsed time must stay under 1s.
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('k.5: matchesRegex — non-string pattern rejected', () => {
    vi.spyOn(engine, 'getFieldValue').mockReturnValue('anything');
    const cond = { field: 'title', operator: 'matchesRegex', value: 123, caseSensitive: false };
    expect(engine.evaluateCondition(cond, item)).toBe(false);
  });

  // UT-021l
  it('l: greaterThan — numeric field > string compare value', () => {
    stubFieldValue(engine, 2023);
    const cond = { field: 'year', operator: 'greaterThan', value: '2020' };
    expect(engine.evaluateCondition(cond, item)).toBe(true);
  });

  // UT-021m
  it('m: lessThan — numeric field < string compare value', () => {
    stubFieldValue(engine, 2019);
    const cond = { field: 'year', operator: 'lessThan', value: '2020' };
    expect(engine.evaluateCondition(cond, item)).toBe(true);
  });

  // UT-021n
  it('n: isEmpty — empty string matches', () => {
    stubFieldValue(engine, '');
    const cond = { field: 'title', operator: 'isEmpty' };
    expect(engine.evaluateCondition(cond, item)).toBe(true);
  });

  // UT-021o
  it('o: isNotEmpty — non-empty string matches', () => {
    stubFieldValue(engine, 'value');
    const cond = { field: 'title', operator: 'isNotEmpty' };
    expect(engine.evaluateCondition(cond, item)).toBe(true);
  });

  // UT-021p
  it('p: unknown operator returns false', () => {
    stubFieldValue(engine, 'x');
    const cond = { field: 'title', operator: 'unknownOp', value: 'x' };
    expect(engine.evaluateCondition(cond, item)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// UT-022 — SmartRulesEngine.evaluateConditions — AND logic
// ---------------------------------------------------------------------------
describe('UT-022 — SmartRulesEngine.evaluateConditions — AND logic', () => {
  let engine;
  let item;

  beforeEach(() => {
    engine = makeEngine();
    item = makeMockItem();
  });

  // UT-022a
  it('a: empty conditions array = true (vacuous truth)', () => {
    expect(engine.evaluateConditions([], item)).toBe(true);
  });

  // UT-022b
  it('b: one true condition = true', () => {
    vi.spyOn(engine, 'evaluateCondition').mockReturnValueOnce(true);
    expect(engine.evaluateConditions([{ field: 'title', operator: 'contains', value: 'x' }], item)).toBe(true);
  });

  // UT-022c
  it('c: two true conditions = true', () => {
    vi.spyOn(engine, 'evaluateCondition')
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true);
    expect(engine.evaluateConditions([
      { field: 'title', operator: 'contains', value: 'x' },
      { field: 'title', operator: 'contains', value: 'y' },
    ], item)).toBe(true);
  });

  // UT-022d
  it('d: one true + one false = false', () => {
    vi.spyOn(engine, 'evaluateCondition')
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    expect(engine.evaluateConditions([
      { field: 'title', operator: 'contains', value: 'x' },
      { field: 'title', operator: 'contains', value: 'z' },
    ], item)).toBe(false);
  });

  // UT-022e
  it('e: all false = false', () => {
    vi.spyOn(engine, 'evaluateCondition')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false);
    expect(engine.evaluateConditions([
      { field: 'title', operator: 'contains', value: 'x' },
      { field: 'title', operator: 'contains', value: 'y' },
    ], item)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// UT-023 — SmartRulesEngine._validateRule
// ---------------------------------------------------------------------------
describe('UT-023 — SmartRulesEngine._validateRule', () => {
  let engine;
  beforeEach(() => { engine = makeEngine(); });

  // UT-023a
  it('a: valid rule with all required fields = true', () => {
    const rule = {
      id: '1',
      name: 'r',
      conditions: [],
      actions: [{ type: 'addTag', value: 'x' }],
    };
    expect(engine._validateRule(rule)).toBe(true);
  });

  // UT-023b
  it('b: missing id = false', () => {
    const rule = {
      name: 'r',
      conditions: [],
      actions: [{ type: 'addTag' }],
    };
    expect(engine._validateRule(rule)).toBe(false);
  });

  // UT-023c
  it('c: missing name = false', () => {
    const rule = {
      id: '1',
      conditions: [],
      actions: [{ type: 'addTag' }],
    };
    expect(engine._validateRule(rule)).toBe(false);
  });

  // UT-023d
  it('d: conditions is not an array = false', () => {
    const rule = {
      id: '1',
      name: 'r',
      conditions: 'notarray',
      actions: [],
    };
    expect(engine._validateRule(rule)).toBe(false);
  });

  // UT-023e
  it('e: empty actions array = false', () => {
    const rule = {
      id: '1',
      name: 'r',
      conditions: [],
      actions: [],
    };
    expect(engine._validateRule(rule)).toBe(false);
  });

  // UT-023f
  it('f: null = false', () => {
    expect(engine._validateRule(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// UT-024 — SmartRulesEngine.addRule / removeRule / updateRule
// ---------------------------------------------------------------------------
describe('UT-024 — SmartRulesEngine.addRule / removeRule / updateRule', () => {
  let engine;

  beforeEach(() => {
    engine = makeEngine();
    // Mock getPref to enable smart rules when evaluate() is called
    Zotero.Prefs.get.mockImplementation((key) => {
      if (key.endsWith('smartRulesEnabled')) return true;
      return undefined;
    });
  });

  function validRule(overrides = {}) {
    return {
      name: 'Test Rule',
      conditions: [],
      actions: [{ type: 'addTag', value: 'test' }],
      ...overrides,
    };
  }

  // UT-024a
  it('a: addRule with no id auto-generates an id', () => {
    const rule = engine.addRule(validRule());
    expect(rule.id).toBeTruthy();
    expect(typeof rule.id).toBe('string');
  });

  // UT-024b
  it('b: addRule with valid rule — appears in getAllRules()', () => {
    engine.addRule(validRule({ id: 'r1' }));
    const all = engine.getAllRules();
    expect(all.some(r => r.id === 'r1')).toBe(true);
  });

  // UT-024c
  it('c: addRule with invalid structure throws Error', () => {
    // No actions → invalid
    expect(() => engine.addRule({ id: 'bad', name: 'bad', conditions: [], actions: [] }))
      .toThrow('Invalid rule structure');
  });

  // UT-024d
  it('d: removeRule(existingId) returns true and removes rule', () => {
    engine.addRule(validRule({ id: 'r2' }));
    const result = engine.removeRule('r2');
    expect(result).toBe(true);
    expect(engine.getAllRules().some(r => r.id === 'r2')).toBe(false);
  });

  // UT-024e
  it('e: removeRule(nonexistent) returns false', () => {
    expect(engine.removeRule('nonexistent-id')).toBe(false);
  });

  // UT-024f
  it('f: updateRule — returns updated rule and re-sorts by priority', () => {
    engine.addRule(validRule({ id: 'r3', priority: 1 }));
    engine.addRule(validRule({ id: 'r4', priority: 5 }));
    const updated = engine.updateRule('r3', { priority: 10 });
    expect(updated).not.toBeNull();
    expect(updated.priority).toBe(10);
    // After update, r3 (priority 10) should come before r4 (priority 5)
    const all = engine.getAllRules();
    const idxR3 = all.findIndex(r => r.id === 'r3');
    const idxR4 = all.findIndex(r => r.id === 'r4');
    expect(idxR3).toBeLessThan(idxR4);
  });

  // UT-024g
  it('g: updateRule(nonexistent) returns null', () => {
    expect(engine.updateRule('nonexistent', {})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// UT-025 — SmartRulesEngine — priority-based rule ordering
// ---------------------------------------------------------------------------
describe('UT-025 — SmartRulesEngine — priority-based rule ordering', () => {
  it('rules are sorted descending by priority after addRule', () => {
    const engine = makeEngine();

    engine.addRule({ id: 'p5', name: 'P5', priority: 5, conditions: [], actions: [{ type: 'addTag', value: 'a' }] });
    engine.addRule({ id: 'p10', name: 'P10', priority: 10, conditions: [], actions: [{ type: 'addTag', value: 'a' }] });
    engine.addRule({ id: 'p1', name: 'P1', priority: 1, conditions: [], actions: [{ type: 'addTag', value: 'a' }] });

    const all = engine.getAllRules();
    expect(all[0].id).toBe('p10');
    expect(all[1].id).toBe('p5');
    expect(all[2].id).toBe('p1');
  });
});

// ---------------------------------------------------------------------------
// UT-026 — SmartRulesEngine.evaluate — stopOnMatch behaviour
// ---------------------------------------------------------------------------
describe('UT-026 — SmartRulesEngine.evaluate — stopOnMatch behaviour', () => {
  it('stopOnMatch on first rule prevents second rule actions from being collected', () => {
    const engine = makeEngine();
    const item = makeMockItem();

    // Mock getPref so smart rules are enabled
    Zotero.Prefs.get.mockImplementation((key) => {
      if (key.endsWith('smartRulesEnabled')) return true;
      return undefined;
    });

    // Add two rules — both have empty conditions (always match)
    engine.addRule({
      id: 'first',
      name: 'First',
      enabled: true,
      priority: 10,
      stopOnMatch: true,
      conditions: [],
      actions: [{ type: 'addTag', value: 'tag-from-first' }],
    });

    engine.addRule({
      id: 'second',
      name: 'Second',
      enabled: true,
      priority: 5,
      stopOnMatch: false,
      conditions: [],
      actions: [{ type: 'addTag', value: 'tag-from-second' }],
    });

    const result = engine.evaluate(item);

    // Only the first rule should have matched
    expect(result.matchedRules).toHaveLength(1);
    expect(result.matchedRules[0].id).toBe('first');

    // Only the first rule's action should be in result.actions
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].value).toBe('tag-from-first');
  });
});

// ---------------------------------------------------------------------------
// UT-027 — createRule / createCondition / createAction factory functions
// ---------------------------------------------------------------------------
describe('UT-027 — factory functions', () => {
  // UT-027a
  it('a: createRule() has correct defaults', () => {
    const rule = createRule();
    expect(rule.id).toBeTruthy();
    expect(rule.enabled).toBe(true);
    expect(rule.priority).toBe(0);
    expect(Array.isArray(rule.conditions)).toBe(true);
    expect(rule.conditions).toHaveLength(0);
    expect(Array.isArray(rule.actions)).toBe(true);
    expect(rule.actions).toHaveLength(0);
    expect(rule.stopOnMatch).toBe(false);
  });

  // UT-027b
  it('b: createRule({name, priority}) merges overrides', () => {
    const rule = createRule({ name: 'X', priority: 5 });
    expect(rule.name).toBe('X');
    expect(rule.priority).toBe(5);
    // Other defaults preserved
    expect(rule.enabled).toBe(true);
    expect(rule.stopOnMatch).toBe(false);
  });

  // UT-027c
  it('c: createCondition returns correct object', () => {
    const cond = createCondition('title', 'contains', 'foo');
    expect(cond).toEqual({
      field: 'title',
      operator: 'contains',
      value: 'foo',
      caseSensitive: false,
    });
  });

  // UT-027d
  it('d: createAction without field has no field key', () => {
    const action = createAction('addTag', 'reviewed');
    expect(action).toEqual({ type: 'addTag', value: 'reviewed' });
    expect('field' in action).toBe(false);
  });

  // UT-027e
  it('e: createAction with field includes field key', () => {
    const action = createAction('setField', 'foo', 'title');
    expect(action).toEqual({ type: 'setField', value: 'foo', field: 'title' });
  });
});

// ---------------------------------------------------------------------------
// UT-028 (WP-B / B5) — pre-compile matchesRegex at loadRules time
// ---------------------------------------------------------------------------
describe('UT-028 — pre-compile matchesRegex at loadRules / addRule (WP-B / B5)', () => {
  let engine;
  let item;

  beforeEach(() => {
    engine = makeEngine();
    item = makeMockItem();
    Zotero.Prefs.get.mockReset();
  });

  function rulesPref(rules) {
    return JSON.stringify(rules);
  }

  it('a: loadRules stamps _compiled onto every matchesRegex condition', async () => {
    Zotero.Prefs.get.mockImplementation((key) => {
      if (key.endsWith('smartRules')) {
        return rulesPref([{
          id: 'r1', name: 'R1',
          conditions: [
            { field: 'title', operator: 'matchesRegex', value: '\\d{4}' },
            { field: 'title', operator: 'contains', value: 'foo' },
          ],
          actions: [{ type: 'addTag', value: 't' }],
        }]);
      }
      return undefined;
    });
    await engine.loadRules();
    const rule = engine.getRule('r1');
    expect(rule).toBeTruthy();
    expect(rule.conditions[0]._compiled).toBeInstanceOf(RegExp);
    // Non-matchesRegex condition is not touched.
    expect(rule.conditions[1]._compiled).toBeUndefined();
  });

  it('b: precompiled regex honours the caseSensitive flag (default off → "i")', async () => {
    Zotero.Prefs.get.mockImplementation((key) => {
      if (key.endsWith('smartRules')) {
        return rulesPref([{
          id: 'r1', name: 'R1',
          conditions: [{ field: 'title', operator: 'matchesRegex', value: 'foo' }],
          actions: [{ type: 'addTag', value: 't' }],
        }]);
      }
      return undefined;
    });
    await engine.loadRules();
    const cond = engine.getRule('r1').conditions[0];
    expect(cond._compiled.flags).toBe('i');
  });

  it('c: oversized pattern (>512 chars) is NOT compiled (ReDoS cap enforced at load)', async () => {
    const big = 'a'.repeat(513);
    Zotero.Prefs.get.mockImplementation((key) => {
      if (key.endsWith('smartRules')) {
        return rulesPref([{
          id: 'r1', name: 'R1',
          conditions: [{ field: 'title', operator: 'matchesRegex', value: big }],
          actions: [{ type: 'addTag', value: 't' }],
        }]);
      }
      return undefined;
    });
    await engine.loadRules();
    const cond = engine.getRule('r1').conditions[0];
    expect(cond._compiled).toBe(null);
  });

  it('d: invalid regex (syntax error) is NOT compiled (logged + nulled)', async () => {
    Zotero.Prefs.get.mockImplementation((key) => {
      if (key.endsWith('smartRules')) {
        return rulesPref([{
          id: 'r1', name: 'R1',
          conditions: [{ field: 'title', operator: 'matchesRegex', value: '[invalid' }],
          actions: [{ type: 'addTag', value: 't' }],
        }]);
      }
      return undefined;
    });
    await engine.loadRules();
    const cond = engine.getRule('r1').conditions[0];
    expect(cond._compiled).toBe(null);
  });

  it('e: evaluateCondition reuses the precompiled regex (no recompile on hit)', async () => {
    Zotero.Prefs.get.mockImplementation((key) => {
      if (key.endsWith('smartRules')) {
        return rulesPref([{
          id: 'r1', name: 'R1',
          conditions: [{ field: 'title', operator: 'matchesRegex', value: 'foo' }],
          actions: [{ type: 'addTag', value: 't' }],
        }]);
      }
      return undefined;
    });
    await engine.loadRules();
    const cond = engine.getRule('r1').conditions[0];
    const compiled = cond._compiled;
    expect(compiled).toBeInstanceOf(RegExp);
    // Spy on RegExp construction — if evaluation reuses the compiled
    // regex, no new RegExp should be created.
    const origRegExp = globalThis.RegExp;
    const ctorSpy = vi.fn((...args) => new origRegExp(...args));
    globalThis.RegExp = ctorSpy;
    try {
      vi.spyOn(engine, 'getFieldValue').mockReturnValue('foobar');
      const result = engine.evaluateCondition(cond, item);
      expect(result).toBe(true);
      expect(ctorSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.RegExp = origRegExp;
    }
  });

  it('f: evaluateCondition still works when _compiled is null (falls back to live compile)', () => {
    // Ad-hoc condition with no precompile step.
    const cond = { field: 'title', operator: 'matchesRegex', value: 'foo' };
    vi.spyOn(engine, 'getFieldValue').mockReturnValue('foobar');
    expect(engine.evaluateCondition(cond, item)).toBe(true);
  });

  it('g: addRule precompiles matchesRegex conditions on the new rule', () => {
    const r = engine.addRule({
      name: 'X',
      conditions: [{ field: 'title', operator: 'matchesRegex', value: 'NEEDLE' }],
      actions: [{ type: 'addTag', value: 't' }],
    });
    expect(r.conditions[0]._compiled).toBeInstanceOf(RegExp);
  });

  it('h: updateRule re-compiles when condition.value changes', () => {
    const r = engine.addRule({
      name: 'X',
      conditions: [{ field: 'title', operator: 'matchesRegex', value: 'FOO' }],
      actions: [{ type: 'addTag', value: 't' }],
    });
    const before = r.conditions[0]._compiled.source;
    expect(before).toBe('FOO');
    engine.updateRule(r.id, {
      conditions: [{ field: 'title', operator: 'matchesRegex', value: 'BAR' }],
    });
    const after = engine.getRule(r.id).conditions[0]._compiled.source;
    expect(after).toBe('BAR');
  });

  it('i: evaluateCondition recompiles when value drifts from _compiledPattern', () => {
    // Simulate an externally-mutated value (e.g. test fixture or
    // a code path that didn't go through addRule/updateRule).
    const cond = {
      field: 'title',
      operator: 'matchesRegex',
      value: 'NEW',
      _compiled: /OLD/i,
      _compiledPattern: 'OLD',
      _compiledFlags: 'i',
    };
    vi.spyOn(engine, 'getFieldValue').mockReturnValue('NEW match');
    expect(engine.evaluateCondition(cond, item)).toBe(true);
  });
});
