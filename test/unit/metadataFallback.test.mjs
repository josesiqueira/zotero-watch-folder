/**
 * Unit tests for content/metadataFallback.mjs.
 *
 * The fallback creates a parent bibliographic item when Zotero's online
 * recognizer can't identify an imported PDF, so no import is left a bare
 * orphan attachment. The single highest-value safety property here is the
 * page-1 / single-candidate identifier gate: it must REFUSE to guess when
 * a page carries multiple DOIs (a reference list), because attaching a
 * *cited* reference's metadata to the file is worse than an orphan.
 *
 * Covers:
 *   UT-043 titleFromFilename
 *   UT-044 extractIdentifierFromText (arXiv / DOI / ISBN + ambiguity guard)
 *   UT-045 createParentFallback orchestration (lookup → filename fallback)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  titleFromFilename,
  prettifyTitle,
  extractIdentifierFromText,
  createParentFallback,
} from '../../content/metadataFallback.mjs';

beforeEach(() => {
  vi.resetAllMocks();
  Zotero.debug = vi.fn();
  Zotero.logError = vi.fn();
});

// ─── UT-043 — titleFromFilename ─────────────────────────────────────────────

describe('UT-043 — titleFromFilename', () => {
  it('a: strips a single trailing extension', () => {
    expect(titleFromFilename('OWASP Top 10 for LLM Applications 2025.pdf'))
      .toBe('OWASP Top 10 for LLM Applications 2025');
  });
  it('b: keeps dots that are not the final extension', () => {
    expect(titleFromFilename('v2.8.4 release notes.pdf')).toBe('v2.8.4 release notes');
  });
  it('c: empty / non-string falls back to Untitled', () => {
    expect(titleFromFilename('')).toBe('Untitled');
    expect(titleFromFilename(null)).toBe('Untitled');
    expect(titleFromFilename('.pdf')).toBe('Untitled');
  });
});

// ─── UT-043b — prettifyTitle ────────────────────────────────────────────────

describe('UT-043b — prettifyTitle', () => {
  it('a: the canonical case — hyphen-separated lowercase → Title Case w/ acronyms', () => {
    expect(prettifyTitle('ai-privacy-risks-and-mitigations-in-llms.pdf'))
      .toBe('AI Privacy Risks and Mitigations in LLMs');
  });
  it('b: underscores as separators, small words lower-cased', () => {
    expect(prettifyTitle('the_eu_data_act_in_context.pdf'))
      .toBe('The EU Data Act in Context');
  });
  it('c: keeps already-upper acronyms and a year', () => {
    expect(prettifyTitle('OWASP Top 10 for LLM Applications 2025.pdf'))
      .toBe('OWASP Top 10 for LLM Applications 2025');
  });
  it('d: strips exporter UUID + trailing numeric id junk', () => {
    expect(prettifyTitle('ai_hleg_ethics_guidelines_for_trustworthy_ai_87F84A41-A6E8-F38C-BFF661481B40077B_60419.pdf'))
      .toBe('AI HLEG Ethics Guidelines for Trustworthy AI');
  });
  it('e: a leading small word is still capitalised (first word rule)', () => {
    expect(prettifyTitle('a-survey-of-rag.pdf')).toBe('A Survey of RAG');
  });
  it('f: plural acronym keeps a lower-case s (api → APIs)', () => {
    expect(prettifyTitle('designing-good-apis.pdf')).toBe('Designing Good APIs');
  });
  it('g: a real hex-letter word is NOT stripped (no digit → kept)', () => {
    expect(prettifyTitle('the-facade-pattern.pdf')).toBe('The Facade Pattern');
  });
  it('h: empty / junk-only → Untitled', () => {
    expect(prettifyTitle('.pdf')).toBe('Untitled');
    expect(prettifyTitle('')).toBe('Untitled');
  });
  it('i: a source-capitalised article (subtitle "A") is preserved, not demoted', () => {
    expect(prettifyTitle('The EU Data Act in Context A Legal Assessment.pdf'))
      .toBe('The EU Data Act in Context A Legal Assessment');
  });
});

// ─── UT-044 — extractIdentifierFromText ─────────────────────────────────────

describe('UT-044 — extractIdentifierFromText', () => {
  it('a: single arXiv (new format, with version) → {arXiv}', () => {
    expect(extractIdentifierFromText('Preprint arXiv:2301.12345v2 [cs.AI]'))
      .toEqual({ arXiv: '2301.12345' });
  });
  it('b: single old-style arXiv id → {arXiv}', () => {
    expect(extractIdentifierFromText('See arXiv:math.GT/0309136 for details'))
      .toEqual({ arXiv: 'math.GT/0309136' });
  });
  it('c: single DOI → lowercased, trailing punctuation stripped', () => {
    expect(extractIdentifierFromText('https://doi.org/10.1145/3442188.3445922.'))
      .toEqual({ DOI: '10.1145/3442188.3445922' });
  });
  it('d: SAFETY — two distinct DOIs on a page → null (no guessing)', () => {
    const refs = 'Refs: 10.1093/law/aaa123 and 10.1145/3442188.3445922';
    expect(extractIdentifierFromText(refs)).toBeNull();
  });
  it('e: arXiv wins when both an arXiv id and a DOI are present', () => {
    const t = 'arXiv:2301.12345 doi:10.1145/3442188.3445922';
    expect(extractIdentifierFromText(t)).toEqual({ arXiv: '2301.12345' });
  });
  it('f: single ISBN → normalised (hyphens/spaces removed, upper-cased)', () => {
    expect(extractIdentifierFromText('ISBN: 978-0-13-468599-1'))
      .toEqual({ ISBN: '9780134685991' });
  });
  it('g: no identifier present → null', () => {
    expect(extractIdentifierFromText('Self-Efficacy by Albert Bandura, Stanford University'))
      .toBeNull();
  });
  it('h: empty / non-string → null', () => {
    expect(extractIdentifierFromText('')).toBeNull();
    expect(extractIdentifierFromText(null)).toBeNull();
  });
});

// ─── UT-045 — createParentFallback orchestration ────────────────────────────

/** Build a fake standalone PDF attachment item. */
function makeAttachment(overrides = {}) {
  return {
    id: 313,
    libraryID: 1,
    parentID: null,
    attachmentFilename: 'Some Paper.pdf',
    isAttachment: () => true,
    getCollections: () => [7],
    getField: () => '',
    saveTx: vi.fn(async () => {}),
    ...overrides,
  };
}

/** Stub Zotero.Translate.Search to return a given parent (or null). */
function stubTranslate(parentItem) {
  Zotero.Translate = {
    Search: vi.fn(function () {
      this.setIdentifier = vi.fn();
      this.getTranslators = vi.fn(async () => (parentItem ? [{ label: 't' }] : []));
      this.setTranslator = vi.fn();
      this.translate = vi.fn(async () => (parentItem ? [parentItem] : []));
    }),
  };
}

/** Stub the Zotero.Item constructor used for the filename parent. */
function stubItemConstructor() {
  const created = [];
  Zotero.Item = vi.fn(function (type) {
    this.id = 9000 + created.length;
    this.itemType = type;
    this.libraryID = null;
    this._fields = {};
    this._collections = [];
    this.setField = vi.fn((k, v) => { this._fields[k] = v; });
    this.addToCollection = vi.fn((c) => this._collections.push(c));
    this.saveTx = vi.fn(async () => {});
    created.push(this);
  });
  return created;
}

describe('UT-045 — createParentFallback', () => {
  it('a: non-attachment input → ok:false', async () => {
    const r = await createParentFallback({ isAttachment: () => false });
    expect(r.ok).toBe(false);
    expect(r.via).toBe('not-an-attachment');
  });

  it('b: already-parented attachment → ok:true, no work done', async () => {
    const att = makeAttachment({ parentID: 555 });
    const r = await createParentFallback(att);
    expect(r).toEqual({ ok: true, via: 'already-parented' });
    expect(att.saveTx).not.toHaveBeenCalled();
  });

  it('c: page-1 identifier + successful lookup → reparents under looked-up item', async () => {
    Zotero.PDFWorker = { getFullText: vi.fn(async () => ({ text: 'arXiv:2301.12345' })) };
    const parent = { id: 4242, key: 'PARENTKY' };
    stubTranslate(parent);
    const att = makeAttachment();

    const r = await createParentFallback(att);

    expect(r.ok).toBe(true);
    expect(r.via).toBe('identifier');
    expect(r.parentItem).toBe(parent);
    expect(att.parentID).toBe(4242);          // reparented
    expect(att.saveTx).toHaveBeenCalledTimes(1);
  });

  it('d: identifier present but lookup yields nothing → falls back to filename parent', async () => {
    Zotero.PDFWorker = { getFullText: vi.fn(async () => ({ text: 'arXiv:2301.12345' })) };
    stubTranslate(null); // no translator / no result
    const created = stubItemConstructor();
    const att = makeAttachment({ attachmentFilename: 'EU Data Act.pdf' });

    const r = await createParentFallback(att);

    expect(r.ok).toBe(true);
    expect(r.via).toBe('filename');
    expect(created).toHaveLength(1);
    expect(created[0]._fields.title).toBe('EU Data Act');
    expect(created[0].libraryID).toBe(1);
    expect(created[0]._collections).toEqual([7]); // inherits attachment's collections
    expect(att.parentID).toBe(created[0].id);     // reparented under filename parent
  });

  it('e: no identifier on page 1 → filename parent (the common safe path)', async () => {
    Zotero.PDFWorker = { getFullText: vi.fn(async () => ({ text: 'Self-Efficacy, Bandura' })) };
    stubTranslate(null);
    const created = stubItemConstructor();
    const att = makeAttachment({ attachmentFilename: 'Self Efficacy_Bandura.pdf' });

    const r = await createParentFallback(att);

    expect(r.via).toBe('filename');
    expect(created[0]._fields.title).toBe('Self Efficacy Bandura'); // prettified
    // lookup must NOT have been attempted (no identifier to look up)
    expect(Zotero.Translate.Search).not.toHaveBeenCalled();
  });

  it('f: filename-parent creation throws → ok:false, via:error', async () => {
    Zotero.PDFWorker = { getFullText: vi.fn(async () => ({ text: 'no id here' })) };
    Zotero.Item = vi.fn(function () {
      this.setField = () => {};
      this.addToCollection = () => {};
      this.saveTx = async () => { throw new Error('db locked'); };
    });
    const att = makeAttachment();

    const r = await createParentFallback(att);

    expect(r.ok).toBe(false);
    expect(r.via).toBe('error');
  });

  it('g: PDF text extraction failure is swallowed → still creates filename parent', async () => {
    Zotero.PDFWorker = { getFullText: vi.fn(async () => { throw new Error('worker died'); }) };
    const created = stubItemConstructor();
    const att = makeAttachment({ attachmentFilename: 'Broken.pdf' });

    const r = await createParentFallback(att);

    expect(r.via).toBe('filename');
    expect(created[0]._fields.title).toBe('Broken');
  });
});
