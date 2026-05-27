/**
 * Item-Membership Handler — v2.1 Phase A3.
 *
 * Handles `collection-item` Zotero notifier events: items added to or
 * removed from collections. Owns the canonical-path rule for
 * multi-collection items (spec §"Canonical path rule for multi-collection
 * items"):
 *
 *   - A new item joining a sync-root collection that the plugin has
 *     never seen → log + defer. The full B.2 baseline copy lives in
 *     Phase C (first-run baseline) and isn't part of A3.
 *   - A tracked item whose collectionMembershipKeys changes → emit an
 *     addItemMembership / removeItemMembership MirrorAction to the
 *     executor. Then re-resolve the canonical via
 *     `canonicalPath.chooseCanonicalCollection`. If the canonical key
 *     changes, emit a moveItem MirrorAction (the executor's conflict
 *     gate handles "user edited the file" refusal).
 *   - A tracked item that loses ALL memberships under the sync root →
 *     handled by `_removeItemMembership` in the executor: the record's
 *     `state` flips to `out-of-scope-suppressed`. The user picks a
 *     resolution via the suppression UX (Phase B).
 *
 * Zotero's data model: only PARENT items live in collections, not
 * attachments. The plugin's FileRecord is keyed by attachment key, so
 * for each parent item in an event we resolve its attachment children
 * and look up each. Standalone attachments (no parent) are handled by
 * the `item.isAttachment()` short-circuit.
 *
 * @module itemMembershipHandler
 */

import {
  resolveSyncRoot,
  collectionKeyToRelativePath,
  chooseCanonicalCollection,
} from './canonicalPath.mjs';
import * as mirrorExecutor from './mirrorExecutor.mjs';

/**
 * Handle a `collection-item` notifier event.
 *
 * @param {'add'|'remove'|'modify'} event
 * @param {string[]} compositeIDs - 'collectionID-itemID' strings.
 * @param {object} extraData
 * @param {object} coordinator - SyncCoordinator instance (carries _trackingStore).
 */
export async function handleCollectionItemEvent(event, compositeIDs, extraData, coordinator) {
  void extraData; // reserved for future use (e.g., batch-trash diagnostics)
  if (event !== 'add' && event !== 'remove') return;
  if (!Array.isArray(compositeIDs) || compositeIDs.length === 0) return;

  const store = coordinator?._trackingStore;
  if (!store) return;

  let syncRoot;
  try {
    syncRoot = await resolveSyncRoot();
  } catch (e) {
    Zotero.logError(`[WatchFolder] itemMembershipHandler resolveSyncRoot: ${e?.message ?? e}`);
    return;
  }
  if (!syncRoot) return;

  // WP-C #4: group composite ids by collection so per-collection
  // resolution (collection lookup + collectionKeyToRelativePath +
  // scope-gate) runs ONCE per collection rather than once per item.
  // The RecognizePDF reparenting guard in `_handleRemove` still runs
  // per-item — batching only shares the constant overhead, not the
  // per-item decision.
  const byCollection = new Map();
  for (const compositeID of compositeIDs) {
    const parsed = _parseCompositeID(compositeID);
    if (!parsed) continue;
    const { collectionID, itemID } = parsed;
    let bucket = byCollection.get(collectionID);
    if (!bucket) { bucket = []; byCollection.set(collectionID, bucket); }
    bucket.push({ itemID, compositeID });
  }

  for (const [collectionID, entries] of byCollection.entries()) {
    let collection;
    try {
      collection = Zotero.Collections.get(collectionID);
    } catch (_e) { continue; }
    if (!collection) continue;

    // Sync-root scope gate — events on collections outside the configured
    // sync root are dropped. Resolved ONCE for the group.
    let collectionRelPath = null;
    try {
      collectionRelPath = await collectionKeyToRelativePath(collection.key);
    } catch (e) {
      Zotero.logError(`[WatchFolder] itemMembershipHandler collectionKeyToRelativePath: ${e?.message ?? e}`);
      continue;
    }
    if (collectionRelPath === null) continue;

    for (const { itemID, compositeID } of entries) {
      try {
        const item = Zotero.Items.get(itemID);
        if (!item) continue;

        const attachmentKeys = _resolveAttachmentKeys(item);
        if (attachmentKeys.length === 0) continue;

        for (const attachmentKey of attachmentKeys) {
          const record = store.getByAttachmentKey(attachmentKey);
          if (event === 'add') {
            await _handleAdd({ record, attachmentKey, collection, item, syncRoot });
          } else {
            await _handleRemove({ record, attachmentKey, collection, item, syncRoot, store });
          }
        }
      } catch (e) {
        Zotero.logError(`[WatchFolder] itemMembershipHandler ${event}/${compositeID}: ${e?.message ?? e}`);
      }
    }
  }
}

// ─── Event handlers ────────────────────────────────────────────────────────

async function _handleAdd({ record, attachmentKey, collection, item, syncRoot }) {
  if (!record) {
    // Untracked item appeared in a sync-root collection. This is the B.2
    // case from the install-time baseline matrix (Zotero has the item; the
    // plugin hasn't tracked it). Full handling lives in Phase C
    // (first-run baseline / baseline-copy-from-Zotero-storage). For now
    // we just log so the event is observable in MCP runbooks.
    Zotero.debug(`[WatchFolder] itemMembershipHandler: untracked attachment ${attachmentKey} added to ${collection.key} (deferring — Phase C)`);
    return;
  }
  // Idempotent union update.
  await mirrorExecutor.execute({
    type: 'addItemMembership',
    payload: { attachmentKey, collectionKey: collection.key },
  });
  await _recomputeCanonicalIfChanged({ record, item, syncRoot });
}

async function _handleRemove({ record, attachmentKey, collection, item, syncRoot, store }) {
  if (!record) return;
  if (!(record.collectionMembershipKeys || []).includes(collection.key)) return;

  // Zotero reparenting guard. In Zotero's data model only PARENT items
  // live in collections; attachments don't have direct collection
  // membership. When RecognizePDF (or any reparenting flow) moves a
  // standalone attachment under a new parent, Zotero fires a `remove`
  // collection-item event for the attachment leaving the collection,
  // even though the parent stays there. From the FileRecord's POV the
  // file is still "in" that collection via its parent — don't
  // propagate as a user-initiated removal (which would otherwise flip
  // state to OUT_OF_SCOPE_SUPPRESSED and strip canonicalCollectionKey).
  try {
    const isAttachmentEvent = (typeof item?.isAttachment === 'function') && item.isAttachment();
    const parent = isAttachmentEvent ? (item.parentItem ?? null) : null;
    if (parent && typeof parent.getCollections === 'function') {
      const parentCollIDs = parent.getCollections() || [];
      if (parentCollIDs.includes(collection.id)) {
        Zotero.debug(`[WatchFolder] itemMembershipHandler: remove of attachment ${attachmentKey} from ${collection.key} is a Zotero reparent (parent ${parent.key} still in collection) — skipping suppression`);
        return;
      }
    }
  } catch (_e) { /* fall through to normal handling */ }

  const wasCanonical = record.canonicalCollectionKey === collection.key;

  await mirrorExecutor.execute({
    type: 'removeItemMembership',
    payload: { attachmentKey, collectionKey: collection.key },
  });

  if (!wasCanonical) return;
  // The canonical collection was just dropped. If the item still belongs
  // to other sync-root collections, pick a new canonical and move the
  // local file to match. If no memberships remain, the executor has
  // already flipped state to OUT_OF_SCOPE_SUPPRESSED — leave the local
  // file in place (user resolves via suppression UX, Phase B).
  const updated = store.getByAttachmentKey(attachmentKey);
  if (!updated || (updated.collectionMembershipKeys || []).length === 0) return;
  await _recomputeCanonicalIfChanged({ record: updated, item, syncRoot });
}

// ─── Canonical recompute ───────────────────────────────────────────────────

async function _recomputeCanonicalIfChanged({ record, item, syncRoot }) {
  const newCanonical = await chooseCanonicalCollection(item, syncRoot.collection, {
    existingTrackingRecord: record,
  });
  if (!newCanonical) return;
  if (newCanonical.key === record.canonicalCollectionKey) return;

  const newRelPath = await collectionKeyToRelativePath(newCanonical.key);
  if (newRelPath === null) return;

  // The filename is preserved across the canonical move — we only change
  // the directory, not the leaf name.
  const filename = _filenameOf(record.canonicalLocalPath || record.localPath);
  if (!filename) return;
  const newCanonicalLocalPath = newRelPath === '' ? filename : `${newRelPath}/${filename}`;
  if (newCanonicalLocalPath === record.canonicalLocalPath) return;

  await mirrorExecutor.execute({
    type: 'moveItem',
    payload: {
      attachmentKey: record.zoteroAttachmentKey,
      oldCanonicalPath: record.canonicalLocalPath,
      newCanonicalPath: newCanonicalLocalPath,
      newCanonicalCollectionKey: newCanonical.key,
    },
  });
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function _parseCompositeID(compositeID) {
  if (typeof compositeID !== 'string') return null;
  const [a, b] = compositeID.split('-');
  const collectionID = parseInt(a, 10);
  const itemID = parseInt(b, 10);
  if (!Number.isFinite(collectionID) || !Number.isFinite(itemID)) return null;
  return { collectionID, itemID };
}

/**
 * Resolve the list of attachment keys associated with `item`:
 *   - Standalone attachment items → [item.key]
 *   - Parent items → keys of all child attachments
 *   - Anything else → []
 */
function _resolveAttachmentKeys(item) {
  if (!item) return [];
  try {
    if (typeof item.isAttachment === 'function' && item.isAttachment()) {
      return item.key ? [item.key] : [];
    }
    const attachmentIDs = (typeof item.getAttachments === 'function')
      ? (item.getAttachments() || [])
      : [];
    const keys = [];
    for (const id of attachmentIDs) {
      const att = Zotero.Items.get(id);
      if (att?.key) keys.push(att.key);
    }
    return keys;
  } catch (_e) {
    return [];
  }
}

function _filenameOf(path) {
  if (typeof path !== 'string' || !path) return '';
  const parts = path.split('/');
  return parts[parts.length - 1] || '';
}
