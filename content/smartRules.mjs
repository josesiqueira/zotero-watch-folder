/**
 * Smart Rules Engine for Zotero Watch Folder Plugin
 *
 * Provides a rules engine that allows users to define automation rules
 * for categorization and processing of imported files.
 *
 * @module smartRules
 */

import { getPref, setPref } from './utils.mjs';

/**
 * Available condition fields for rule matching
 * @type {string[]}
 */
export const CONDITION_FIELDS = [
  'title',
  'firstCreator',
  'creators',
  'year',
  'publicationTitle',
  'DOI',
  'doiPrefix',
  'abstractNote',
  'itemType',
  'tags',
  'filename'
];

/**
 * Available operators for condition matching
 * @type {string[]}
 */
export const OPERATORS = [
  'contains',
  'notContains',
  'equals',
  'notEquals',
  'startsWith',
  'endsWith',
  'matchesRegex',
  'greaterThan',
  'lessThan',
  'isEmpty',
  'isNotEmpty'
];

/**
 * Available action types
 * @type {string[]}
 */
export const ACTION_TYPES = [
  'addToCollection',
  'addTag',
  'setField',
  'skipImport'
];

/**
 * Smart Rules Engine class
 * Manages rule evaluation and execution for imported items
 */
export class SmartRulesEngine {
  constructor() {
    /** @type {Array<Object>} Array of rule objects */
    this._rules = [];

    /** @type {boolean} Whether the engine has been initialized */
    this._initialized = false;

    /** @type {Map<string, Zotero.Collection>} Cache for collection lookups */
    this._collectionCache = new Map();
  }

  /**
   * Initialize the rules engine
   * Loads rules from preferences
   * @returns {Promise<void>}
   */
  async init() {
    if (this._initialized) {
      Zotero.debug('[WatchFolder] SmartRulesEngine already initialized');
      return;
    }

    try {
      Zotero.debug('[WatchFolder] Initializing SmartRulesEngine...');
      await this.loadRules();
      this._initialized = true;
      Zotero.debug(`[WatchFolder] SmartRulesEngine initialized with ${this._rules.length} rules`);
    } catch (e) {
      Zotero.logError(e);
      Zotero.debug(`[WatchFolder] SmartRulesEngine init error: ${e.message}`);
      throw e;
    }
  }

  /**
   * Load rules from preferences
   * @returns {Promise<void>}
   */
  async loadRules() {
    try {
      const rulesJson = getPref('smartRules') || '[]';
      const rules = JSON.parse(rulesJson);

      // Validate and sort rules by priority (higher priority first)
      this._rules = rules
        .filter(rule => this._validateRule(rule))
        .sort((a, b) => (b.priority || 0) - (a.priority || 0));

      Zotero.debug(`[WatchFolder] Loaded ${this._rules.length} rules from preferences`);
    } catch (e) {
      Zotero.debug(`[WatchFolder] Error loading rules: ${e.message}`);
      this._rules = [];
    }
  }

  /**
   * Save rules to preferences
   * @returns {Promise<void>}
   */
  async saveRules() {
    try {
      const rulesJson = JSON.stringify(this._rules);
      setPref('smartRules', rulesJson);
      Zotero.debug(`[WatchFolder] Saved ${this._rules.length} rules to preferences`);
    } catch (e) {
      Zotero.logError(e);
      Zotero.debug(`[WatchFolder] Error saving rules: ${e.message}`);
      throw e;
    }
  }

  /**
   * Validate a rule object
   * @private
   * @param {Object} rule - Rule to validate
   * @returns {boolean} True if valid
   */
  _validateRule(rule) {
    if (!rule || typeof rule !== 'object') {
      return false;
    }

    // Required fields
    if (!rule.id || !rule.name) {
      Zotero.debug(`[WatchFolder] Rule missing id or name`);
      return false;
    }

    // Must have conditions and actions arrays
    if (!Array.isArray(rule.conditions) || !Array.isArray(rule.actions)) {
      Zotero.debug(`[WatchFolder] Rule ${rule.id} missing conditions or actions array`);
      return false;
    }

    // Must have at least one action
    if (rule.actions.length === 0) {
      Zotero.debug(`[WatchFolder] Rule ${rule.id} has no actions`);
      return false;
    }

    return true;
  }

  /**
   * Add a new rule
   * @param {Object} rule - Rule object to add
   * @returns {Object} The added rule with generated ID if needed
   */
  addRule(rule) {
    // Generate ID if not provided
    if (!rule.id) {
      rule.id = Date.now().toString();
    }

    // Set defaults
    rule.enabled = rule.enabled !== false;
    rule.priority = rule.priority || 0;
    rule.stopOnMatch = rule.stopOnMatch || false;
    rule.conditions = rule.conditions || [];
    rule.actions = rule.actions || [];

    if (!this._validateRule(rule)) {
      throw new Error('Invalid rule structure');
    }

    this._rules.push(rule);

    // Re-sort by priority
    this._rules.sort((a, b) => (b.priority || 0) - (a.priority || 0));

    Zotero.debug(`[WatchFolder] Added rule: ${rule.name} (${rule.id})`);
    return rule;
  }

  /**
   * Remove a rule by ID
   * @param {string} id - Rule ID to remove
   * @returns {boolean} True if rule was found and removed
   */
  removeRule(id) {
    const index = this._rules.findIndex(r => r.id === id);
    if (index === -1) {
      return false;
    }

    const removed = this._rules.splice(index, 1)[0];
    Zotero.debug(`[WatchFolder] Removed rule: ${removed.name} (${id})`);
    return true;
  }

  /**
   * Update an existing rule
   * @param {string} id - Rule ID to update
   * @param {Object} updates - Properties to update
   * @returns {Object|null} Updated rule or null if not found
   */
  updateRule(id, updates) {
    const rule = this._rules.find(r => r.id === id);
    if (!rule) {
      return null;
    }

    // Apply updates
    Object.assign(rule, updates);

    // Preserve ID
    rule.id = id;

    if (!this._validateRule(rule)) {
      throw new Error('Invalid rule structure after update');
    }

    // Re-sort by priority if priority changed
    if ('priority' in updates) {
      this._rules.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    }

    Zotero.debug(`[WatchFolder] Updated rule: ${rule.name} (${id})`);
    return rule;
  }

  /**
   * Get a rule by ID
   * @param {string} id - Rule ID
   * @returns {Object|null} Rule object or null
   */
  getRule(id) {
    return this._rules.find(r => r.id === id) || null;
  }

  /**
   * Get all rules
   * @returns {Array<Object>} Array of all rules
   */
  getAllRules() {
    return [...this._rules];
  }

  /**
   * Get only enabled rules
   * @returns {Array<Object>} Array of enabled rules
   */
  getEnabledRules() {
    return this._rules.filter(r => r.enabled);
  }

  /**
   * Extract a field value from an item for condition matching
   * @param {Zotero.Item} item - Zotero item
   * @param {string} field - Field name to extract
   * @param {Object} context - Additional context (e.g., filename)
   * @returns {*} Field value
   */
  getFieldValue(item, field, context = {}) {
    try {
      switch (field) {
        case 'title':
          return item.getField('title') || '';

        case 'firstCreator':
          return item.getField('firstCreator') || '';

        case 'creators': {
          const creators = item.getCreators();
          return creators.map(c => `${c.firstName || ''} ${c.lastName || ''}`.trim()).join('; ');
        }

        case 'year': {
          const date = item.getField('date');
          if (date) {
            const match = date.match(/(\d{4})/);
            return match ? parseInt(match[1], 10) : null;
          }
          return null;
        }

        case 'publicationTitle':
          return item.getField('publicationTitle') || '';

        case 'DOI':
          return item.getField('DOI') || '';

        case 'doiPrefix': {
          const doi = item.getField('DOI') || '';
          // Extract DOI prefix (e.g., "10.1109" from "10.1109/TSE.2020.12345")
          const match = doi.match(/^(10\.\d+)/);
          return match ? match[1] : '';
        }

        case 'abstractNote':
          return item.getField('abstractNote') || '';

        case 'itemType':
          return item.itemType || Zotero.ItemTypes.getName(item.itemTypeID) || '';

        case 'tags': {
          const tags = item.getTags();
          return tags.map(t => t.tag).join('; ');
        }

        case 'filename':
          // For attachments, get the filename; use context for pre-import
          if (context.filename) {
            return context.filename;
          }
          if (item.isAttachment()) {
            const path = item.getFilePath();
            return path ? PathUtils.filename(path) : '';
          }
          return '';

        default:
          // Try to get as a generic field
          try {
            return item.getField(field) || '';
          } catch {
            return '';
          }
      }
    } catch (e) {
      Zotero.debug(`[WatchFolder] Error getting field ${field}: ${e.message}`);
      return '';
    }
  }

  /**
   * Evaluate a single condition against an item
   * @param {Object} condition - Condition object
   * @param {Zotero.Item} item - Zotero item
   * @param {Object} context - Additional context
   * @returns {boolean} True if condition matches
   */
  evaluateCondition(condition, item, context = {}) {
    const { field, operator, value, caseSensitive = false } = condition;

    let fieldValue = this.getFieldValue(item, field, context);
    let compareValue = value;

    // Handle case sensitivity for string comparisons
    if (typeof fieldValue === 'string' && typeof compareValue === 'string' && !caseSensitive) {
      fieldValue = fieldValue.toLowerCase();
      compareValue = compareValue.toLowerCase();
    }

    try {
      switch (operator) {
        case 'contains':
          return String(fieldValue).includes(String(compareValue));

        case 'notContains':
          return !String(fieldValue).includes(String(compareValue));

        case 'equals':
          if (typeof fieldValue === 'number' && typeof compareValue === 'string') {
            return fieldValue === parseInt(compareValue, 10);
          }
          return fieldValue === compareValue;

        case 'notEquals':
          if (typeof fieldValue === 'number' && typeof compareValue === 'string') {
            return fieldValue !== parseInt(compareValue, 10);
          }
          return fieldValue !== compareValue;

        case 'startsWith':
          return String(fieldValue).startsWith(String(compareValue));

        case 'endsWith':
          return String(fieldValue).endsWith(String(compareValue));

        case 'matchesRegex': {
          // Use original value for regex (not lowercased compareValue)
          // The 'i' flag handles case insensitivity for regex
          const flags = caseSensitive ? '' : 'i';
          try {
            const regex = new RegExp(value, flags);
            // Use original fieldValue for regex test, not lowercased
            const originalFieldValue = this.getFieldValue(item, field, context);
            return regex.test(String(originalFieldValue));
          } catch (regexError) {
            Zotero.debug(`[WatchFolder] Invalid regex pattern "${value}": ${regexError.message}`);
            return false;
          }
        }

        case 'greaterThan': {
          const numField = typeof fieldValue === 'number' ? fieldValue : parseFloat(fieldValue);
          const numCompare = typeof compareValue === 'number' ? compareValue : parseFloat(compareValue);
          return !isNaN(numField) && !isNaN(numCompare) && numField > numCompare;
        }

        case 'lessThan': {
          const numField = typeof fieldValue === 'number' ? fieldValue : parseFloat(fieldValue);
          const numCompare = typeof compareValue === 'number' ? compareValue : parseFloat(compareValue);
          return !isNaN(numField) && !isNaN(numCompare) && numField < numCompare;
        }

        case 'isEmpty':
          return fieldValue === '' || fieldValue === null || fieldValue === undefined;

        case 'isNotEmpty':
          return fieldValue !== '' && fieldValue !== null && fieldValue !== undefined;

        default:
          Zotero.debug(`[WatchFolder] Unknown operator: ${operator}`);
          return false;
      }
    } catch (e) {
      Zotero.debug(`[WatchFolder] Error evaluating condition: ${e.message}`);
      return false;
    }
  }

  /**
   * Evaluate all conditions for a rule (AND logic)
   * @param {Array<Object>} conditions - Array of condition objects
   * @param {Zotero.Item} item - Zotero item
   * @param {Object} context - Additional context
   * @returns {boolean} True if all conditions match
   */
  evaluateConditions(conditions, item, context = {}) {
    // Empty conditions array means rule always matches
    if (!conditions || conditions.length === 0) {
      return true;
    }

    // All conditions must match (AND logic)
    return conditions.every(condition =>
      this.evaluateCondition(condition, item, context)
    );
  }

  /**
   * Evaluate all rules against an item and return matching actions
   * @param {Zotero.Item} item - Zotero item
   * @param {Object} context - Additional context (e.g., filename)
   * @returns {Object} Result with matched rules and aggregated actions
   */
  evaluate(item, context = {}) {
    const result = {
      matchedRules: [],
      actions: [],
      skipImport: false
    };

    // Check if smart rules are enabled
    if (!getPref('smartRulesEnabled')) {
      return result;
    }

    const enabledRules = this.getEnabledRules();

    for (const rule of enabledRules) {
      // Check if all conditions match
      if (this.evaluateConditions(rule.conditions, item, context)) {
        result.matchedRules.push({
          id: rule.id,
          name: rule.name
        });

        // Add all actions from this rule
        for (const action of rule.actions) {
          result.actions.push({
            ...action,
            ruleId: rule.id,
            ruleName: rule.name
          });

          // Check for skipImport action
          if (action.type === 'skipImport') {
            result.skipImport = true;
          }
        }

        // Stop processing more rules if stopOnMatch is true
        if (rule.stopOnMatch) {
          Zotero.debug(`[WatchFolder] Rule "${rule.name}" matched with stopOnMatch, skipping remaining rules`);
          break;
        }
      }
    }

    if (result.matchedRules.length > 0) {
      Zotero.debug(`[WatchFolder] ${result.matchedRules.length} rule(s) matched for item`);
    }

    return result;
  }

  /**
   * Get or create a nested collection path
   * @param {string} path - Collection path (e.g., "Topics/RE/Surveys")
   * @param {number} [libraryID] - Library ID (defaults to user library)
   * @returns {Promise<Zotero.Collection>} The leaf collection
   */
  async getOrCreateCollectionPath(path, libraryID = Zotero.Libraries.userLibraryID) {
    if (!path || typeof path !== 'string') {
      throw new Error('Invalid collection path');
    }

    // Check cache first
    const cacheKey = `${libraryID}:${path}`;
    if (this._collectionCache.has(cacheKey)) {
      const cached = this._collectionCache.get(cacheKey);
      // Verify collection still exists
      // Zotero.Collections.get() is synchronous in Zotero 7
      try {
        const exists = Zotero.Collections.get(cached.id);
        if (exists) {
          return cached;
        }
      } catch {
        // Collection no longer exists, remove from cache
        this._collectionCache.delete(cacheKey);
      }
    }

    // Split path into segments
    const segments = path.split('/').map(s => s.trim()).filter(s => s.length > 0);

    if (segments.length === 0) {
      throw new Error('Empty collection path');
    }

    let parentID = null;
    let currentCollection = null;

    // Traverse/create each segment
    for (const segmentName of segments) {
      currentCollection = await this._findOrCreateCollection(segmentName, parentID, libraryID);
      parentID = currentCollection.id;
    }

    // Cache the result
    this._collectionCache.set(cacheKey, currentCollection);

    return currentCollection;
  }

  /**
   * Find or create a collection with optional parent
   * @private
   * @param {string} name - Collection name
   * @param {number|null} parentID - Parent collection ID or null for root
   * @param {number} libraryID - Library ID
   * @returns {Promise<Zotero.Collection>} The collection
   */
  async _findOrCreateCollection(name, parentID, libraryID) {
    // Get all collections in library
    const collections = Zotero.Collections.getByLibrary(libraryID);

    // Find existing collection with matching name and parent
    // Note: Root collections may have parentID as false, null, or undefined
    for (const collection of collections) {
      const collectionParentID = collection.parentID || null;
      const targetParentID = parentID || null;
      if (collection.name === name && collectionParentID === targetParentID) {
        return collection;
      }
    }

    // Create new collection
    const collection = new Zotero.Collection();
    collection.libraryID = libraryID;
    collection.name = name;
    if (parentID) {
      collection.parentID = parentID;
    }
    await collection.saveTx();

    Zotero.debug(`[WatchFolder] Created collection: ${name} (parent: ${parentID || 'root'})`);
    return collection;
  }

  /**
   * Execute a single action on an item
   * @param {Object} action - Action object
   * @param {Zotero.Item} item - Zotero item
   * @returns {Promise<boolean>} True if action succeeded
   */
  async executeAction(action, item) {
    const { type, value, field } = action;

    try {
      switch (type) {
        case 'addToCollection': {
          // Support nested collection paths
          const collection = await this.getOrCreateCollectionPath(value);

          // Add item to collection if not already present
          // Use item.getCollections() to check membership (Zotero 7 API)
          const itemCollections = item.getCollections();
          if (!itemCollections.includes(collection.id)) {
            item.addToCollection(collection.id);
            await item.saveTx();
            Zotero.debug(`[WatchFolder] Added item ${item.id} to collection: ${value}`);
          }
          return true;
        }

        case 'addTag': {
          // Add tag if not already present
          const existingTags = item.getTags().map(t => t.tag);
          if (!existingTags.includes(value)) {
            item.addTag(value);
            await item.saveTx();
            Zotero.debug(`[WatchFolder] Added tag "${value}" to item ${item.id}`);
          }
          return true;
        }

        case 'setField': {
          // Set a field value (action should have 'field' and 'value')
          if (!field) {
            Zotero.debug('[WatchFolder] setField action missing field name');
            return false;
          }

          item.setField(field, value);
          await item.saveTx();
          Zotero.debug(`[WatchFolder] Set field "${field}" to "${value}" for item ${item.id}`);
          return true;
        }

        case 'skipImport': {
          // This is handled at evaluation time, not execution
          // Just log and return true
          Zotero.debug(`[WatchFolder] skipImport action for item ${item.id}`);
          return true;
        }

        default:
          Zotero.debug(`[WatchFolder] Unknown action type: ${type}`);
          return false;
      }
    } catch (e) {
      Zotero.logError(e);
      Zotero.debug(`[WatchFolder] Error executing action ${type}: ${e.message}`);
      return false;
    }
  }

  /**
   * Execute all actions on an item
   * @param {Array<Object>} actions - Array of action objects
   * @param {Zotero.Item} item - Zotero item
   * @returns {Promise<Object>} Result with success/failure counts
   */
  async executeActions(actions, item) {
    const result = {
      total: actions.length,
      succeeded: 0,
      failed: 0,
      errors: []
    };

    for (const action of actions) {
      try {
        const success = await this.executeAction(action, item);
        if (success) {
          result.succeeded++;
        } else {
          result.failed++;
          result.errors.push({
            action: action.type,
            error: 'Action returned false'
          });
        }
      } catch (e) {
        result.failed++;
        result.errors.push({
          action: action.type,
          error: e.message
        });
      }
    }

    Zotero.debug(`[WatchFolder] Executed ${result.succeeded}/${result.total} actions successfully`);
    return result;
  }

  /**
   * Clear the collection cache
   */
  clearCache() {
    this._collectionCache.clear();
    Zotero.debug('[WatchFolder] SmartRulesEngine cache cleared');
  }

  /**
   * Get engine statistics
   * @returns {Object} Statistics object
   */
  getStats() {
    return {
      initialized: this._initialized,
      totalRules: this._rules.length,
      enabledRules: this._rules.filter(r => r.enabled).length,
      cacheSize: this._collectionCache.size
    };
  }
}

// Singleton instance
let _instance = null;

/**
 * Get the singleton SmartRulesEngine instance
 * @returns {SmartRulesEngine}
 */
export function getSmartRulesEngine() {
  if (!_instance) {
    _instance = new SmartRulesEngine();
  }
  return _instance;
}

/**
 * Reset the singleton (for testing)
 */
export function resetSmartRulesEngine() {
  if (_instance) {
    _instance.clearCache();
    _instance = null;
  }
}

/**
 * Process an item with smart rules after import
 * This is the main integration hook for watchFolder.mjs
 *
 * @param {Zotero.Item} item - The imported Zotero item
 * @param {Object} context - Additional context
 * @param {string} [context.filename] - Original filename
 * @param {string} [context.filePath] - Original file path
 * @returns {Promise<Object>} Processing result
 */
export async function processItemWithRules(item, context = {}) {
  const result = {
    processed: false,
    matchedRules: [],
    actionsExecuted: 0,
    skipImport: false,
    errors: []
  };

  // Check if smart rules are enabled
  if (!getPref('smartRulesEnabled')) {
    return result;
  }

  try {
    // Get or initialize the engine
    const engine = getSmartRulesEngine();
    if (!engine._initialized) {
      await engine.init();
    }

    // Extract filename from context or item
    if (!context.filename && context.filePath) {
      context.filename = PathUtils.filename(context.filePath);
    }

    // Evaluate rules against the item
    const evaluation = engine.evaluate(item, context);

    result.matchedRules = evaluation.matchedRules;
    result.skipImport = evaluation.skipImport;

    // If skipImport is triggered, don't execute other actions
    if (evaluation.skipImport) {
      Zotero.debug('[WatchFolder] Skip import triggered by rule');
      result.processed = true;
      return result;
    }

    // Execute matched actions
    if (evaluation.actions.length > 0) {
      const executionResult = await engine.executeActions(evaluation.actions, item);
      result.actionsExecuted = executionResult.succeeded;
      result.errors = executionResult.errors;
    }

    result.processed = true;

  } catch (e) {
    Zotero.logError(e);
    result.errors.push({
      action: 'processItemWithRules',
      error: e.message
    });
  }

  return result;
}

/**
 * Check if smart rules would skip an import (pre-import check)
 * Useful for checking before actual import
 *
 * @param {Object} metadata - Preliminary metadata
 * @param {Object} context - Context including filename
 * @returns {Promise<boolean>} True if import should be skipped
 */
export async function shouldSkipImport(metadata, context = {}) {
  // Check if smart rules are enabled
  if (!getPref('smartRulesEnabled')) {
    return false;
  }

  try {
    const engine = getSmartRulesEngine();
    if (!engine._initialized) {
      await engine.init();
    }

    // Create a mock item-like object for evaluation
    const mockItem = {
      getField: (field) => metadata[field] || '',
      getCreators: () => metadata.creators || [],
      getTags: () => metadata.tags || [],
      itemType: metadata.itemType || '',
      itemTypeID: null,
      isAttachment: () => true,
      getFilePath: () => context.filePath || ''
    };

    const evaluation = engine.evaluate(mockItem, context);
    return evaluation.skipImport;

  } catch (e) {
    Zotero.debug(`[WatchFolder] Error in shouldSkipImport: ${e.message}`);
    return false;
  }
}

/**
 * Create a new rule with defaults
 * @param {Object} overrides - Properties to override
 * @returns {Object} New rule object
 */
export function createRule(overrides = {}) {
  return {
    id: Date.now().toString(),
    name: 'New Rule',
    enabled: true,
    priority: 0,
    conditions: [],
    actions: [],
    stopOnMatch: false,
    ...overrides
  };
}

/**
 * Create a new condition
 * @param {string} field - Field to match
 * @param {string} operator - Comparison operator
 * @param {string} value - Value to compare
 * @param {boolean} [caseSensitive=false] - Case sensitivity
 * @returns {Object} Condition object
 */
export function createCondition(field, operator, value, caseSensitive = false) {
  return {
    field,
    operator,
    value,
    caseSensitive
  };
}

/**
 * Create a new action
 * @param {string} type - Action type
 * @param {string} value - Action value
 * @param {string} [field] - Field name (for setField action)
 * @returns {Object} Action object
 */
export function createAction(type, value, field = null) {
  const action = { type, value };
  if (field) {
    action.field = field;
  }
  return action;
}
