/**
 * Metadata Fallback Module for Zotero Watch Folder Plugin
 *
 * When Zotero's online recognizer (`Zotero.RecognizeDocument`) cannot
 * identify an imported PDF (it returns "No matching references found"),
 * the attachment is left as a bare standalone item with no parent
 * bibliographic record. This module provides a CONSERVATIVE fallback so
 * every imported PDF still ends up with a parent registry item:
 *
 *   1. Extract a high-confidence identifier (DOI / arXiv / ISBN) from the
 *      FIRST PAGE ONLY. A document's own identifier lives in the title
 *      block / header; *cited* DOIs live in the reference list on deeper
 *      pages. Restricting to page 1 is what stops us from attaching a
 *      cited reference's metadata to the file (live finding: the EU Data
 *      Act PDF yields a spurious Oxford-law DOI on page 4 — never page 1).
 *      We also require EXACTLY ONE distinct identifier of a kind before
 *      trusting it; multiple candidates means we can't disambiguate.
 *   2. Look the identifier up via Zotero's search translators and reparent
 *      the attachment under the newly created bibliographic item.
 *   3. If no trustworthy identifier is found (or the lookup yields nothing),
 *      create a minimal parent item titled from the filename so the PDF is
 *      never left a bare orphan. The user can then edit it.
 *
 * Everything here is ADDITIVE (it only ever creates a parent + reparents);
 * it never deletes or trashes, so it sits outside the delete-safety nets.
 */

/** Item type used for the last-resort, filename-titled parent. */
const PARENT_ITEM_TYPE = 'document';

/**
 * Strip a single trailing extension and surrounding whitespace from a
 * filename to use as a human-editable title. Never returns empty.
 * @param {string} filename
 * @returns {string}
 */
export function titleFromFilename(filename) {
  if (!filename || typeof filename !== 'string') return 'Untitled';
  const base = filename.replace(/\.[^.\\/]+$/, '').trim();
  return base || 'Untitled';
}

/**
 * Initialisms kept upper-cased in a generated title. Singular forms only —
 * a trailing plural "s" is preserved lower-case (e.g. `llm` → `LLMs`).
 */
const ACRONYMS = new Set([
  'ai', 'ml', 'llm', 'nlp', 'genai', 'agi', 'rag', 'gpt', 'iot',
  'eu', 'us', 'usa', 'uk', 'un', 'uae',
  'api', 'sdk', 'ui', 'ux', 'cpu', 'gpu', 'os', 'http', 'https', 'url', 'uri',
  'html', 'css', 'json', 'xml', 'pdf', 'csv', 'sql', 'ocr',
  'doi', 'isbn', 'issn', 'faq', 'ceo', 'cto', 'gdpr', 'hleg', 'owasp',
  'ieee', 'acm', 'aaai', 'nist', 'iso',
]);

/** Words kept lower-case in title case unless first or last. */
const SMALL_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into',
  'nor', 'of', 'on', 'onto', 'or', 'over', 'per', 'the', 'to', 'vs', 'via',
  'with', 'within', 'without',
]);

/**
 * Turn a raw filename into a clean, human-readable title for a placeholder
 * parent item: strip the extension and machine-id junk some exporters append,
 * turn separators into spaces, and Title Case the result (acronyms stay
 * upper-cased, small words stay lower-cased). It is a best-effort cosmetic
 * default — the user can always edit — so it stays conservative rather than
 * risk mangling a real title.
 *
 *   "ai-privacy-risks-and-mitigations-in-llms.pdf"
 *     → "AI Privacy Risks and Mitigations in LLMs"
 *
 * @param {string} filename
 * @returns {string}
 */
export function prettifyTitle(filename) {
  let base = titleFromFilename(filename);
  if (base === 'Untitled') return base;

  // Strip exporter-appended machine ids: UUID-shaped blobs, long hex runs
  // (that contain at least one digit, so real words like "facade" survive),
  // and long numeric ids. Conservative — short numbers/years stay. We use
  // explicit alphanumeric-boundary lookarounds instead of \b because the
  // underscore that separates these ids is itself a \w char (so \b fails
  // right where we need it).
  base = base
    .replace(/(?<![A-Za-z0-9])[0-9A-Fa-f]{8}(?![A-Za-z0-9])(?:[ _-][0-9A-Fa-f]{4,}(?![A-Za-z0-9]))+/g, ' ')
    .replace(/(?<![A-Za-z0-9])(?=[0-9A-Fa-f]*\d)[0-9A-Fa-f]{12,}(?![A-Za-z0-9])/g, ' ')
    .replace(/(?<![A-Za-z0-9])\d{5,}(?![A-Za-z0-9])/g, ' ');

  // Separators → spaces; collapse.
  base = base.replace(/[._\-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!base) return 'Untitled';

  const words = base.split(' ');
  const last = words.length - 1;
  return words.map((w, i) => {
    const bare = w.toLowerCase().replace(/[^a-z0-9]/g, '');
    const isPluralAcronym = bare.endsWith('s') && ACRONYMS.has(bare.slice(0, -1));
    if (isPluralAcronym) return bare.slice(0, -1).toUpperCase() + 's';
    if (ACRONYMS.has(bare)) return w.toUpperCase();
    // Down-case a small word only when the source already had it lower-case.
    // An explicitly-capitalised article (e.g. "A" / "The" starting a subtitle)
    // is left capitalised rather than wrongly demoted to "a Legal Assessment".
    if (i !== 0 && i !== last && SMALL_WORDS.has(bare) && w[0] === w[0].toLowerCase()) {
      return w.toLowerCase();
    }
    // Preserve an already-intentional CamelCase token (e.g. "DeepMind").
    if (/[a-z][A-Z]/.test(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');
}

/**
 * Strip trailing punctuation a greedy DOI regex tends to grab (sentence
 * periods, closing brackets, trailing semicolons).
 * @param {string} raw
 * @returns {string}
 */
function _cleanDoi(raw) {
  return raw.replace(/[.,;:)\]]+$/, '');
}

/**
 * Extract a single high-confidence identifier from PDF page-1 text.
 *
 * Returns the first identifier kind that has EXACTLY ONE distinct value on
 * the page, preferring arXiv (least ambiguous) > DOI > ISBN. Returns null
 * when nothing trustworthy is present — the caller then falls back to a
 * filename-titled parent rather than guessing.
 *
 * @param {string} text - Plain text of the PDF's first page
 * @returns {{DOI: string}|{arXiv: string}|{ISBN: string}|null}
 */
export function extractIdentifierFromText(text) {
  if (!text || typeof text !== 'string') return null;

  // 1. arXiv — unambiguous; rarely appears as a spurious citation on page 1.
  const arxiv = new Set();
  for (const m of text.matchAll(/arxiv:\s*(\d{4}\.\d{4,5})(?:v\d+)?/ig)) arxiv.add(m[1]);
  for (const m of text.matchAll(/arxiv:\s*([a-z-]+(?:\.[a-z]{2})?\/\d{7})/ig)) arxiv.add(m[1]);
  if (arxiv.size === 1) return { arXiv: [...arxiv][0] };

  // 2. DOI — accept only when the page yields exactly ONE distinct DOI.
  //    More than one usually means mixed citations and we can't tell which
  //    (if any) is the document's own.
  const dois = new Set();
  for (const m of text.matchAll(/\b10\.\d{4,9}\/[-._;()/:a-z0-9]+/ig)) {
    dois.add(_cleanDoi(m[0]).toLowerCase());
  }
  if (dois.size === 1) return { DOI: [...dois][0] };

  // 3. ISBN — books; accept exactly one distinct normalised value.
  const isbns = new Set();
  for (const m of text.matchAll(/\bisbn(?:-1[03])?:?\s*((?:97[89][\s-]?)?(?:\d[\s-]?){9}[\dxX])/ig)) {
    isbns.add(m[1].replace(/[\s-]/g, '').toUpperCase());
  }
  if (isbns.size === 1) return { ISBN: [...isbns][0] };

  return null;
}

/**
 * Read the attachment's first page and extract a trustworthy identifier.
 * @param {Zotero.Item} attachmentItem
 * @returns {Promise<{DOI: string}|{arXiv: string}|{ISBN: string}|null>}
 */
export async function extractIdentifierFromPdf(attachmentItem) {
  try {
    // maxPages = 1: a document's own identifier is on the first page; the
    // reference list (full of cited DOIs) is never there.
    const ft = await Zotero.PDFWorker.getFullText(attachmentItem.id, 1);
    const text = ft && ft.text ? ft.text : '';
    return extractIdentifierFromText(text);
  } catch (e) {
    Zotero.debug(`[WatchFolder] metadataFallback: page-1 text extraction failed for ${attachmentItem.id}: ${e?.message ?? e}`);
    return null;
  }
}

/**
 * Look an identifier up via Zotero's search translators, saving the result
 * into the given library + collections.
 * @param {{DOI?: string, arXiv?: string, ISBN?: string}} identifier
 * @param {{libraryID: number, collections: number[]}} opts
 * @returns {Promise<Zotero.Item|null>} The created parent item, or null
 */
export async function lookupByIdentifier(identifier, opts = {}) {
  try {
    const translate = new Zotero.Translate.Search();
    translate.setIdentifier(identifier);
    const translators = await translate.getTranslators();
    if (!translators || translators.length === 0) {
      Zotero.debug(`[WatchFolder] metadataFallback: no translator for ${JSON.stringify(identifier)}`);
      return null;
    }
    translate.setTranslator(translators);
    const newItems = await translate.translate({
      libraryID: opts.libraryID,
      collections: opts.collections || [],
      saveAttachments: false,
    });
    return newItems && newItems.length ? newItems[0] : null;
  } catch (e) {
    Zotero.debug(`[WatchFolder] metadataFallback: identifier lookup failed (${JSON.stringify(identifier)}): ${e?.message ?? e}`);
    return null;
  }
}

/**
 * Reparent a standalone attachment under a (just-created) parent item.
 * @param {Zotero.Item} attachmentItem
 * @param {Zotero.Item} parentItem
 */
async function _reparent(attachmentItem, parentItem) {
  attachmentItem.parentID = parentItem.id;
  await attachmentItem.saveTx();
}

/**
 * Create a minimal parent bibliographic item titled from the attachment's
 * filename, place it in the attachment's collections, and reparent the
 * attachment under it.
 * @param {Zotero.Item} attachmentItem
 * @param {{libraryID: number, collections: number[]}} opts
 * @returns {Promise<Zotero.Item>} the created parent item
 */
export async function createFilenameParent(attachmentItem, opts = {}) {
  const filename = attachmentItem.attachmentFilename
    || (typeof attachmentItem.getField === 'function' ? attachmentItem.getField('title') : '')
    || 'Untitled';
  const parent = new Zotero.Item(PARENT_ITEM_TYPE);
  parent.libraryID = opts.libraryID ?? attachmentItem.libraryID;
  parent.setField('title', prettifyTitle(filename));
  for (const cid of opts.collections || []) parent.addToCollection(cid);
  await parent.saveTx();
  await _reparent(attachmentItem, parent);
  return parent;
}

/**
 * Orchestrate the full fallback chain for one standalone attachment.
 * Returns a result describing how (or whether) a parent was attached.
 *
 * @param {Zotero.Item} attachmentItem
 * @returns {Promise<{ok: boolean, via: string, parentItem?: Zotero.Item, identifier?: object, error?: Error}>}
 */
export async function createParentFallback(attachmentItem) {
  if (!attachmentItem || typeof attachmentItem.isAttachment !== 'function' || !attachmentItem.isAttachment()) {
    return { ok: false, via: 'not-an-attachment' };
  }
  // Race guard: recognition (or a prior fallback) may have parented it.
  if (attachmentItem.parentID) {
    return { ok: true, via: 'already-parented' };
  }

  const libraryID = attachmentItem.libraryID;
  const collections = (typeof attachmentItem.getCollections === 'function')
    ? attachmentItem.getCollections()
    : [];

  // 1 + 2: high-confidence identifier → translator lookup → reparent.
  const identifier = await extractIdentifierFromPdf(attachmentItem);
  if (identifier) {
    const parent = await lookupByIdentifier(identifier, { libraryID, collections });
    if (parent) {
      try {
        await _reparent(attachmentItem, parent);
        const kind = Object.keys(identifier)[0];
        Zotero.debug(`[WatchFolder] metadataFallback: parented ${attachmentItem.id} via ${kind} lookup`);
        return { ok: true, via: 'identifier', identifier, parentItem: parent };
      } catch (e) {
        Zotero.debug(`[WatchFolder] metadataFallback: reparent after lookup failed for ${attachmentItem.id}: ${e?.message ?? e}`);
        // fall through to filename parent
      }
    }
  }

  // 3: last resort — filename-titled parent so it is never a bare orphan.
  try {
    const parent = await createFilenameParent(attachmentItem, { libraryID, collections });
    Zotero.debug(`[WatchFolder] metadataFallback: parented ${attachmentItem.id} via filename`);
    return { ok: true, via: 'filename', parentItem: parent };
  } catch (e) {
    Zotero.debug(`[WatchFolder] metadataFallback: filename parent creation failed for ${attachmentItem.id}: ${e?.message ?? e}`);
    return { ok: false, via: 'error', error: e };
  }
}
