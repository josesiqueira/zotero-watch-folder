/**
 * Item-Membership Handler — v2.1 Phase A3 skeleton.
 *
 * Handles `collection-item` Zotero notifier events: items added to or
 * removed from collections. The hard problem is the **canonical-path
 * rule** for multi-collection items (spec §"Canonical path rule for
 * multi-collection items"):
 *
 *   - A new item joining a sync-root collection that the plugin has
 *     never seen → trigger B.2-style copy-to-local (Phase C work).
 *   - A tracked item whose `collectionMembershipKeys` changes →
 *     re-resolve canonical via `canonicalPath.chooseCanonicalCollection`.
 *     If the canonical key changes AND the local file is unchanged
 *     (conflict-gate passes), move the local file to match the new
 *     canonical path.
 *   - A tracked item that loses ALL memberships under the sync root →
 *     mark `state = out-of-scope-suppressed`. Do NOT delete the local
 *     file. The user picks a resolution via the suppression UX (Phase B).
 *
 * Not implemented in this v2.1 starter.
 *
 * @module itemMembershipHandler
 */

/**
 * Handle a `collection-item` notifier event.
 *
 * @param {'add'|'remove'|'modify'} event
 * @param {string[]} compositeIDs - 'collectionID-itemID' strings
 * @param {object} extraData
 * @param {object} coordinator
 */
export async function handleCollectionItemEvent(event, compositeIDs, extraData, coordinator) {
  // TODO(v2.1):
  // For each compositeID 'C-I':
  //   1. Resolve item via Zotero.Items.get(I), collection via .get(C)
  //   2. Gate on isUnderSyncRoot(collection)
  //   3. Look up tracking record by item.key
  //   4. event === 'add' + no record → flag as new-from-Zotero (route to baseline copy in C)
  //   5. event === 'add' + record → update collectionMembershipKeys + recompute canonical
  //   6. event === 'remove' + record → if last sync-root membership lost, mark out-of-scope-suppressed
  void event; void compositeIDs; void extraData; void coordinator;
}
