/**
 * Duplicate Detection Module for Zotero Watch Folder Plugin
 *
 * Pre-import duplicate detection using DOI, ISBN, title similarity, and optional file hash.
 * Prevents importing files that already exist in the Zotero library.
 *
 * Detection Methods:
 * - DOI match: 100% confidence, low cost (indexed)
 * - ISBN match: 100% confidence, low cost (indexed)
 * - Title fuzzy match: Configurable confidence (85% default), medium cost (cache)
 * - Content hash: 100% confidence, high cost (file read)
 *
 * @module duplicateDetector
 */

import { getPref } from './utils.mjs';

// Tag added to items imported despite being duplicates
const DUPLICATE_TAG = '_duplicate';

// Default title similarity threshold (85%)
const DEFAULT_TITLE_THRESHOLD = 0.85;

// Maximum cache size for title cache (LRU eviction)
const MAX_TITLE_CACHE_SIZE = 10000;

// Hash chunk size - MUST match utils.mjs getFileHash (1MB)
const HASH_CHUNK_SIZE = 1024 * 1024;

/**
 * Result from duplicate detection
 * @typedef {Object} DuplicateResult
 * @property {boolean} isDuplicate - Whether a duplicate was found
 * @property {number} confidence - Confidence level (0.0 to 1.0)
 * @property {string} reason - Human-readable reason for the match
 * @property {Zotero.Item} [existingItem] - The existing item if duplicate found
 */

/**
 * DuplicateDetector class
 * Manages detection of duplicate items before import using multiple strategies
 */
export class DuplicateDetector {
  constructor() {
    /** @type {boolean} Whether duplicate checking is enabled */
    this._enabled = true;

    /** @type {boolean} Whether DOI matching is enabled */
    this._matchDOI = true;

    /** @type {boolean} Whether ISBN matching is enabled */
    this._matchISBN = true;

    /** @type {boolean} Whether title matching is enabled */
    this._matchTitle = true;

    /** @type {number} Title similarity threshold (0.0 to 1.0) */
    this._titleThreshold = DEFAULT_TITLE_THRESHOLD;

    /** @type {boolean} Whether content hash matching is enabled */
    this._matchHash = false;

    /** @type {Map<string, {title: string, itemID: number}>} Cache of normalized titles */
    this._titleCache = new Map();

    /** @type {boolean} Whether title cache is populated */
    this._titleCacheReady = false;

    /** @type {string|null} Zotero notifier ID for cache invalidation */
    this._notifierID = null;

    /** @type {boolean} Whether the detector has been initialized */
    this._initialized = false;
  }

  /**
   * Initialize the duplicate detector
   * Loads preferences and registers notifier for cache invalidation
   * @returns {Promise<void>}
   */
  async init() {
    if (this._initialized) {
      Zotero.debug('[WatchFolder] DuplicateDetector already initialized');
      return;
    }

    try {
      // Load preferences
      this._loadPreferences();

      // Register notifier to invalidate title cache when library changes
      this._notifierID = Zotero.Notifier.registerObserver(
        {
          notify: async (event, type, ids, extraData) => {
            await this._handleNotify(event, type, ids, extraData);
          }
        },
        ['item'],
        'watchFolder-duplicateDetector'
      );

      this._initialized = true;
      Zotero.debug('[WatchFolder] DuplicateDetector initialized');

    } catch (error) {
      Zotero.logError(error);
      Zotero.debug(`[WatchFolder] DuplicateDetector initialization error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Load preferences from Zotero prefs
   * @private
   */
  _loadPreferences() {
    this._enabled = getPref('duplicateCheck') !== false;
    this._matchDOI = getPref('duplicateMatchDOI') !== false;
    this._matchISBN = getPref('duplicateMatchISBN') !== false;
    this._matchTitle = getPref('duplicateMatchTitle') !== false;
    this._titleThreshold = getPref('duplicateTitleThreshold') || DEFAULT_TITLE_THRESHOLD;
    this._matchHash = getPref('duplicateMatchHash') === true;

    Zotero.debug(`[WatchFolder] DuplicateDetector prefs loaded: ` +
      `enabled=${this._enabled}, DOI=${this._matchDOI}, ISBN=${this._matchISBN}, ` +
      `title=${this._matchTitle} (threshold=${this._titleThreshold}), hash=${this._matchHash}`);
  }

  /**
   * Handle Zotero notifier events for cache invalidation
   * @param {string} event - Event type
   * @param {string} type - Object type
   * @param {number[]} ids - Affected item IDs
   * @param {Object} extraData - Additional event data
   * @private
   */
  async _handleNotify(event, type, ids, extraData) {
    if (type !== 'item') return;

    // Invalidate cache on add, modify, or delete
    if (event === 'add' || event === 'modify' || event === 'delete' || event === 'trash') {
      // For efficiency, just mark cache as needing refresh rather than rebuilding immediately
      // The cache will be rebuilt on next title search
      if (this._titleCacheReady) {
        // For deletes, remove specific items from cache
        if (event === 'delete' || event === 'trash') {
          for (const id of ids) {
            // Find and remove entries with this itemID
            for (const [normalizedTitle, entry] of this._titleCache.entries()) {
              if (entry.itemID === id) {
                this._titleCache.delete(normalizedTitle);
              }
            }
          }
        } else if (event === 'add') {
          // Add new items to cache incrementally
          for (const id of ids) {
            try {
              const item = await Zotero.Items.getAsync(id);
              if (item && item.isRegularItem() && !item.deleted) {
                const title = item.getField('title');
                if (title) {
                  const normalizedTitle = this.normalizeTitle(title);
                  if (normalizedTitle) {
                    this._titleCache.set(normalizedTitle, {
                      title: title,
                      itemID: id
                    });
                    this._evictTitleCacheIfNeeded();
                  }
                }
              }
            } catch (e) {
              // Item might have been deleted already, ignore
            }
          }
        } else if (event === 'modify') {
          // For modifications, update specific items
          for (const id of ids) {
            try {
              const item = await Zotero.Items.getAsync(id);
              if (item && item.isRegularItem() && !item.deleted) {
                // Remove old entries for this item
                for (const [normalizedTitle, entry] of this._titleCache.entries()) {
                  if (entry.itemID === id) {
                    this._titleCache.delete(normalizedTitle);
                  }
                }
                // Add updated entry
                const title = item.getField('title');
                if (title) {
                  const normalizedTitle = this.normalizeTitle(title);
                  if (normalizedTitle) {
                    this._titleCache.set(normalizedTitle, {
                      title: title,
                      itemID: id
                    });
                  }
                }
              }
            } catch (e) {
              // Item might have been deleted already, ignore
            }
          }
        }
      }
    }
  }

  /**
   * Evict oldest entries from title cache if over max size
   * @private
   */
  _evictTitleCacheIfNeeded() {
    while (this._titleCache.size > MAX_TITLE_CACHE_SIZE) {
      const oldestKey = this._titleCache.keys().next().value;
      this._titleCache.delete(oldestKey);
    }
  }

  /**
   * Build the title cache from the library
   * @private
   * @returns {Promise<void>}
   */
  async _buildTitleCache() {
    if (this._titleCacheReady) {
      return;
    }

    Zotero.debug('[WatchFolder] Building title cache...');
    const startTime = Date.now();

    try {
      this._titleCache.clear();

      // Get all regular items from the user library
      const libraryID = Zotero.Libraries.userLibraryID;
      const s = new Zotero.Search();
      s.libraryID = libraryID;
      s.addCondition('itemType', 'isNot', 'attachment');
      s.addCondition('itemType', 'isNot', 'note');
      s.addCondition('deleted', 'false');

      const itemIDs = await s.search();

      // Process items in batches for better performance
      const batchSize = 500;
      for (let i = 0; i < itemIDs.length; i += batchSize) {
        const batchIDs = itemIDs.slice(i, i + batchSize);
        const items = await Zotero.Items.getAsync(batchIDs);

        for (const item of items) {
          if (!item || item.deleted) continue;

          const title = item.getField('title');
          if (title) {
            const normalizedTitle = this.normalizeTitle(title);
            if (normalizedTitle) {
              this._titleCache.set(normalizedTitle, {
                title: title,
                itemID: item.id
              });
            }
          }
        }
      }

      this._titleCacheReady = true;
      const elapsed = Date.now() - startTime;
      Zotero.debug(`[WatchFolder] Title cache built: ${this._titleCache.size} titles in ${elapsed}ms`);

    } catch (error) {
      Zotero.debug(`[WatchFolder] Error building title cache: ${error.message}`);
      throw error;
    }
  }

  /**
   * Main duplicate detection method
   * Checks metadata against the library using configured methods
   *
   * @param {Object} metadata - Metadata extracted from file
   * @param {string} [metadata.DOI] - Document DOI
   * @param {string} [metadata.ISBN] - Book ISBN
   * @param {string} [metadata.title] - Document title
   * @param {string} [filePath] - File path for hash-based detection
   * @returns {Promise<DuplicateResult>} Detection result
   */
  async checkDuplicate(metadata, filePath = null) {
    // Return not duplicate if checking is disabled
    if (!this._enabled) {
      return {
        isDuplicate: false,
        confidence: 0,
        reason: 'Duplicate checking disabled'
      };
    }

    if (!this._initialized) {
      await this.init();
    }

    try {
      // 1. Check by DOI (highest priority, exact match)
      if (this._matchDOI && metadata && metadata.DOI) {
        const doiResult = await this.findByDOI(metadata.DOI);
        if (doiResult) {
          return {
            isDuplicate: true,
            confidence: 1.0,
            reason: `DOI match: ${metadata.DOI}`,
            existingItem: doiResult
          };
        }
      }

      // 2. Check by ISBN (high priority, exact match)
      if (this._matchISBN && metadata && metadata.ISBN) {
        const isbnResult = await this.findByISBN(metadata.ISBN);
        if (isbnResult) {
          return {
            isDuplicate: true,
            confidence: 1.0,
            reason: `ISBN match: ${metadata.ISBN}`,
            existingItem: isbnResult
          };
        }
      }

      // 3. Check by title similarity (medium priority, fuzzy match)
      if (this._matchTitle && metadata && metadata.title) {
        const titleResult = await this.findByTitle(metadata.title);
        if (titleResult) {
          return titleResult;
        }
      }

      // 4. Check by content hash (lowest priority, expensive)
      if (this._matchHash && filePath) {
        const hashResult = await this.findByHash(filePath);
        if (hashResult) {
          return {
            isDuplicate: true,
            confidence: 1.0,
            reason: 'Content hash match',
            existingItem: hashResult
          };
        }
      }

      // No duplicate found
      return {
        isDuplicate: false,
        confidence: 0,
        reason: 'No duplicate found'
      };

    } catch (error) {
      Zotero.debug(`[WatchFolder] Duplicate check error: ${error.message}`);
      // On error, default to not duplicate to avoid blocking imports
      return {
        isDuplicate: false,
        confidence: 0,
        reason: `Error during check: ${error.message}`
      };
    }
  }

  /**
   * Find an existing item by DOI
   * @param {string} doi - The DOI to search for
   * @returns {Promise<Zotero.Item|null>} Matching item or null
   */
  async findByDOI(doi) {
    if (!doi) return null;

    // Normalize DOI (remove URL prefix if present, lowercase)
    let normalizedDOI = doi.trim().toLowerCase();
    // Handle various DOI URL formats
    normalizedDOI = normalizedDOI.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
    normalizedDOI = normalizedDOI.replace(/^doi:/i, '');

    try {
      const libraryID = Zotero.Libraries.userLibraryID;
      const s = new Zotero.Search();
      s.libraryID = libraryID;
      s.addCondition('DOI', 'is', normalizedDOI);
      s.addCondition('deleted', 'false');

      const itemIDs = await s.search();

      if (itemIDs && itemIDs.length > 0) {
        const item = await Zotero.Items.getAsync(itemIDs[0]);
        Zotero.debug(`[WatchFolder] Found existing item by DOI: ${normalizedDOI} -> ${item.id}`);
        return item;
      }

      // Also try with "doi:" prefix as some items may store it that way
      const s2 = new Zotero.Search();
      s2.libraryID = libraryID;
      s2.addCondition('DOI', 'is', `doi:${normalizedDOI}`);
      s2.addCondition('deleted', 'false');

      const itemIDs2 = await s2.search();

      if (itemIDs2 && itemIDs2.length > 0) {
        const item = await Zotero.Items.getAsync(itemIDs2[0]);
        Zotero.debug(`[WatchFolder] Found existing item by DOI (prefixed): ${normalizedDOI} -> ${item.id}`);
        return item;
      }

      return null;

    } catch (error) {
      Zotero.debug(`[WatchFolder] DOI search error: ${error.message}`);
      return null;
    }
  }

  /**
   * Find an existing item by ISBN
   * Handles both ISBN-10 and ISBN-13 formats and converts between them
   * @param {string} isbn - The ISBN to search for
   * @returns {Promise<Zotero.Item|null>} Matching item or null
   */
  async findByISBN(isbn) {
    if (!isbn) return null;

    // Normalize ISBN (remove hyphens and spaces)
    const normalizedISBN = isbn.replace(/[-\s]/g, '').trim().toUpperCase();

    // Validate ISBN format
    if (normalizedISBN.length !== 10 && normalizedISBN.length !== 13) {
      Zotero.debug(`[WatchFolder] Invalid ISBN length: ${normalizedISBN.length}`);
      return null;
    }

    // Build list of ISBN variants to search
    const isbnVariants = [normalizedISBN];

    // Convert between ISBN-10 and ISBN-13
    if (normalizedISBN.length === 10) {
      // Convert ISBN-10 to ISBN-13
      const isbn13 = this._isbn10to13(normalizedISBN);
      if (isbn13) {
        isbnVariants.push(isbn13);
      }
    } else if (normalizedISBN.length === 13 && normalizedISBN.startsWith('978')) {
      // Convert ISBN-13 to ISBN-10 (only possible for 978 prefix)
      const isbn10 = this._isbn13to10(normalizedISBN);
      if (isbn10) {
        isbnVariants.push(isbn10);
      }
    }

    try {
      const libraryID = Zotero.Libraries.userLibraryID;

      // Search for each ISBN variant
      for (const isbnVariant of isbnVariants) {
        const s = new Zotero.Search();
        s.libraryID = libraryID;
        s.addCondition('ISBN', 'is', isbnVariant);
        s.addCondition('deleted', 'false');

        const itemIDs = await s.search();

        if (itemIDs && itemIDs.length > 0) {
          const item = await Zotero.Items.getAsync(itemIDs[0]);
          Zotero.debug(`[WatchFolder] Found existing item by ISBN: ${isbnVariant} -> ${item.id}`);
          return item;
        }

        // Also try with common hyphenated formats
        if (isbnVariant.length === 13) {
          const formattedISBN = `${isbnVariant.slice(0, 3)}-${isbnVariant.slice(3)}`;
          const s2 = new Zotero.Search();
          s2.libraryID = libraryID;
          s2.addCondition('ISBN', 'is', formattedISBN);
          s2.addCondition('deleted', 'false');

          const itemIDs2 = await s2.search();

          if (itemIDs2 && itemIDs2.length > 0) {
            const item = await Zotero.Items.getAsync(itemIDs2[0]);
            Zotero.debug(`[WatchFolder] Found existing item by ISBN (formatted): ${formattedISBN} -> ${item.id}`);
            return item;
          }
        }
      }

      return null;

    } catch (error) {
      Zotero.debug(`[WatchFolder] ISBN search error: ${error.message}`);
      return null;
    }
  }

  /**
   * Convert ISBN-10 to ISBN-13
   * @param {string} isbn10 - ISBN-10 (10 characters, no hyphens)
   * @returns {string|null} ISBN-13 or null if invalid
   * @private
   */
  _isbn10to13(isbn10) {
    if (!isbn10 || isbn10.length !== 10) return null;

    // ISBN-13 = 978 + first 9 digits of ISBN-10 + new check digit
    const base = '978' + isbn10.slice(0, 9);

    // Calculate ISBN-13 check digit
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      const digit = parseInt(base[i], 10);
      if (isNaN(digit)) return null;
      sum += digit * (i % 2 === 0 ? 1 : 3);
    }
    const checkDigit = (10 - (sum % 10)) % 10;

    return base + checkDigit.toString();
  }

  /**
   * Convert ISBN-13 to ISBN-10 (only works for 978 prefix)
   * @param {string} isbn13 - ISBN-13 (13 characters, no hyphens)
   * @returns {string|null} ISBN-10 or null if invalid or not convertible
   * @private
   */
  _isbn13to10(isbn13) {
    if (!isbn13 || isbn13.length !== 13) return null;
    if (!isbn13.startsWith('978')) return null; // Can only convert 978 prefix

    // ISBN-10 = digits 4-12 of ISBN-13 + new check digit
    const base = isbn13.slice(3, 12);

    // Calculate ISBN-10 check digit
    let sum = 0;
    for (let i = 0; i < 9; i++) {
      const digit = parseInt(base[i], 10);
      if (isNaN(digit)) return null;
      sum += digit * (10 - i);
    }
    const remainder = sum % 11;
    const checkDigit = remainder === 0 ? '0' : (11 - remainder === 10 ? 'X' : (11 - remainder).toString());

    return base + checkDigit;
  }

  /**
   * Find an existing item by fuzzy title match
   * @param {string} title - The title to search for
   * @returns {Promise<DuplicateResult|null>} Duplicate result or null if no match
   */
  async findByTitle(title) {
    if (!title || title.length < 5) return null; // Skip very short titles

    try {
      // Build title cache if needed
      await this._buildTitleCache();

      const normalizedSearchTitle = this.normalizeTitle(title);
      if (!normalizedSearchTitle || normalizedSearchTitle.length < 5) return null;

      // First check for exact normalized match (fastest)
      if (this._titleCache.has(normalizedSearchTitle)) {
        const entry = this._titleCache.get(normalizedSearchTitle);
        const item = await Zotero.Items.getAsync(entry.itemID);
        if (item && !item.deleted) {
          Zotero.debug(`[WatchFolder] Found exact title match: "${title}" -> ${item.id}`);
          return {
            isDuplicate: true,
            confidence: 1.0,
            reason: `Exact title match: "${entry.title}"`,
            existingItem: item
          };
        }
      }

      // Then check for fuzzy matches
      let bestMatch = null;
      let bestSimilarity = 0;

      for (const [normalizedTitle, entry] of this._titleCache.entries()) {
        const similarity = this.calculateSimilarity(normalizedSearchTitle, normalizedTitle);

        if (similarity >= this._titleThreshold && similarity > bestSimilarity) {
          bestSimilarity = similarity;
          bestMatch = entry;
        }
      }

      if (bestMatch) {
        const item = await Zotero.Items.getAsync(bestMatch.itemID);
        if (item && !item.deleted) {
          Zotero.debug(`[WatchFolder] Found fuzzy title match: "${title}" -> "${bestMatch.title}" ` +
            `(${(bestSimilarity * 100).toFixed(1)}%) -> ${item.id}`);
          return {
            isDuplicate: true,
            confidence: bestSimilarity,
            reason: `Title similarity: "${bestMatch.title}" (${(bestSimilarity * 100).toFixed(1)}% match)`,
            existingItem: item
          };
        }
      }

      return null;

    } catch (error) {
      Zotero.debug(`[WatchFolder] Title search error: ${error.message}`);
      return null;
    }
  }

  /**
   * Find an existing item by file content hash
   * Uses first 64KB of file for quick hash calculation
   * @param {string} filePath - Path to the file
   * @returns {Promise<Zotero.Item|null>} Matching item or null
   */
  async findByHash(filePath) {
    if (!filePath) return null;

    try {
      // Calculate hash of first 1MB (MUST match utils.mjs getFileHash)
      const data = await IOUtils.read(filePath, { maxBytes: HASH_CHUNK_SIZE });
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

      Zotero.debug(`[WatchFolder] Calculated file hash: ${hash.substring(0, 16)}...`);

      // Search for items with matching hash stored in Extra field
      const libraryID = Zotero.Libraries.userLibraryID;
      const s = new Zotero.Search();
      s.libraryID = libraryID;
      s.addCondition('extra', 'contains', `watchfolder-hash:${hash}`);
      s.addCondition('deleted', 'false');

      const itemIDs = await s.search();

      if (itemIDs && itemIDs.length > 0) {
        const item = await Zotero.Items.getAsync(itemIDs[0]);
        Zotero.debug(`[WatchFolder] Found existing item by hash: ${hash.substring(0, 16)}... -> ${item.id}`);
        return item;
      }

      return null;

    } catch (error) {
      Zotero.debug(`[WatchFolder] Hash search error: ${error.message}`);
      return null;
    }
  }

  /**
   * Calculate similarity between two strings using Levenshtein distance
   * Returns a value between 0.0 (completely different) and 1.0 (identical)
   * @param {string} str1 - First string
   * @param {string} str2 - Second string
   * @returns {number} Similarity score (0.0 to 1.0)
   */
  calculateSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    if (str1 === str2) return 1;

    const distance = this.levenshteinDistance(str1, str2);
    const maxLength = Math.max(str1.length, str2.length);

    if (maxLength === 0) return 1;

    return 1 - (distance / maxLength);
  }

  /**
   * Calculate Levenshtein distance between two strings
   * Uses dynamic programming approach with space optimization
   * @param {string} str1 - First string
   * @param {string} str2 - Second string
   * @returns {number} Edit distance
   */
  levenshteinDistance(str1, str2) {
    const m = str1.length;
    const n = str2.length;

    // Handle empty strings
    if (m === 0) return n;
    if (n === 0) return m;

    // Use two rows instead of full matrix for space efficiency
    let prevRow = new Array(n + 1);
    let currRow = new Array(n + 1);

    // Initialize first row
    for (let j = 0; j <= n; j++) {
      prevRow[j] = j;
    }

    // Fill in the rest of the matrix
    for (let i = 1; i <= m; i++) {
      currRow[0] = i;

      for (let j = 1; j <= n; j++) {
        const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;

        currRow[j] = Math.min(
          prevRow[j] + 1,      // deletion
          currRow[j - 1] + 1,  // insertion
          prevRow[j - 1] + cost // substitution
        );
      }

      // Swap rows
      [prevRow, currRow] = [currRow, prevRow];
    }

    return prevRow[n];
  }

  /**
   * Normalize a title for comparison
   * - Lowercase
   * - Remove punctuation
   * - Remove extra whitespace
   * - Remove common stop words (optional)
   * @param {string} title - Original title
   * @returns {string} Normalized title
   */
  normalizeTitle(title) {
    if (!title) return '';

    let normalized = title
      // Convert to lowercase
      .toLowerCase()
      // Remove punctuation (keep alphanumeric and spaces)
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      // Collapse multiple spaces
      .replace(/\s+/g, ' ')
      // Trim
      .trim();

    return normalized;
  }

  /**
   * Store a content hash for an item (for future duplicate detection)
   * Stores in the item's Extra field with a prefix
   * @param {Zotero.Item} item - The Zotero item
   * @param {string} filePath - Path to the attachment file
   * @returns {Promise<boolean>} True if hash was stored
   */
  async storeContentHash(item, filePath) {
    if (!item || !filePath) return false;

    try {
      // Calculate hash (MUST match utils.mjs getFileHash - 1MB chunk)
      const data = await IOUtils.read(filePath, { maxBytes: HASH_CHUNK_SIZE });
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

      // Get the parent item (if this is an attachment)
      let targetItem = item;
      if (item.isAttachment() && item.parentID) {
        targetItem = await Zotero.Items.getAsync(item.parentID);
      }

      if (!targetItem) return false;

      // Store in Extra field
      let extra = targetItem.getField('extra') || '';

      // Remove any existing watchfolder-hash
      extra = extra.replace(/watchfolder-hash:[a-f0-9]+\n?/gi, '').trim();

      // Add new hash
      if (extra) {
        extra = `${extra}\nwatchfolder-hash:${hash}`;
      } else {
        extra = `watchfolder-hash:${hash}`;
      }

      targetItem.setField('extra', extra);
      await targetItem.saveTx();

      Zotero.debug(`[WatchFolder] Stored content hash for item ${targetItem.id}`);
      return true;

    } catch (error) {
      Zotero.debug(`[WatchFolder] Error storing content hash: ${error.message}`);
      return false;
    }
  }

  /**
   * Handle duplicate according to configured action
   * @param {Zotero.Item} item - The newly imported item (if imported)
   * @param {DuplicateResult} duplicateResult - The detection result
   * @returns {Promise<string>} Action taken ('skip', 'import', 'tagged')
   */
  async handleDuplicate(item, duplicateResult) {
    const action = getPref('duplicateAction') || 'skip';

    switch (action) {
      case 'skip':
        // Don't import - handled by caller before this method
        return 'skip';

      case 'import':
        // Import anyway but add duplicate tag
        if (item) {
          try {
            item.addTag(DUPLICATE_TAG);
            await item.saveTx();
            Zotero.debug(`[WatchFolder] Tagged imported duplicate: ${item.id}`);
          } catch (error) {
            Zotero.debug(`[WatchFolder] Error tagging duplicate: ${error.message}`);
          }
        }
        return 'tagged';

      case 'ask':
        // For now, default to skip (future: implement prompt)
        // This would require UI integration
        return 'skip';

      default:
        return 'skip';
    }
  }

  /**
   * Update configuration from preferences
   * Call when preferences change
   */
  updateConfig() {
    this._loadPreferences();
    Zotero.debug('[WatchFolder] DuplicateDetector config updated');
  }

  /**
   * Invalidate the title cache (force rebuild on next search)
   */
  invalidateTitleCache() {
    this._titleCache.clear();
    this._titleCacheReady = false;
    Zotero.debug('[WatchFolder] Title cache invalidated');
  }

  /**
   * Get statistics about the detector
   * @returns {Object} Statistics object
   */
  getStats() {
    return {
      enabled: this._enabled,
      matchDOI: this._matchDOI,
      matchISBN: this._matchISBN,
      matchTitle: this._matchTitle,
      matchHash: this._matchHash,
      titleThreshold: this._titleThreshold,
      titleCacheSize: this._titleCache.size,
      titleCacheReady: this._titleCacheReady,
      initialized: this._initialized
    };
  }

  /**
   * Clean up resources
   * Call this when shutting down the plugin
   */
  destroy() {
    // Unregister notifier
    if (this._notifierID) {
      Zotero.Notifier.unregisterObserver(this._notifierID);
      this._notifierID = null;
    }

    // Clear cache
    this._titleCache.clear();
    this._titleCacheReady = false;
    this._initialized = false;

    Zotero.debug('[WatchFolder] DuplicateDetector destroyed');
  }
}

// Singleton instance
let _instance = null;

/**
 * Get the singleton DuplicateDetector instance
 * @returns {DuplicateDetector} The detector instance
 */
export function getDuplicateDetector() {
  if (!_instance) {
    _instance = new DuplicateDetector();
  }
  return _instance;
}

/**
 * Reset the singleton (for testing)
 */
export function resetDuplicateDetector() {
  if (_instance) {
    _instance.destroy();
    _instance = null;
  }
}

/**
 * Initialize and return the duplicate detector
 * Convenience function for plugin startup
 * @returns {Promise<DuplicateDetector>} The initialized detector
 */
export async function initDuplicateDetector() {
  const detector = getDuplicateDetector();
  await detector.init();
  return detector;
}

/**
 * Shutdown the duplicate detector
 * Convenience function for plugin shutdown
 */
export function shutdownDuplicateDetector() {
  if (_instance) {
    _instance.destroy();
    _instance = null;
  }
}

/**
 * Check for duplicates before import
 * Main integration hook for watchFolder.mjs to call before importing a file
 *
 * @param {Object} metadata - Metadata extracted from file
 * @param {string} [metadata.DOI] - Document DOI
 * @param {string} [metadata.ISBN] - Book ISBN
 * @param {string} [metadata.title] - Document title
 * @param {string} [filePath] - File path for hash-based detection
 * @returns {Promise<DuplicateResult>} Detection result
 */
export async function checkForDuplicate(metadata, filePath = null) {
  const detector = getDuplicateDetector();

  if (!detector._initialized) {
    await detector.init();
  }

  return detector.checkDuplicate(metadata, filePath);
}

// Export the duplicate tag for use by other modules
export { DUPLICATE_TAG };
