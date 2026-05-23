# Zotero Watch Folder Plugin — Working Sync Model

## Purpose

This document defines the corrected mental model for the Zotero Watch Folder plugin. The main challenge is that a local folder tree and a Zotero collection tree look similar, but they are not the same kind of structure.

A local filesystem folder is a containment hierarchy: one file normally has one path.

A Zotero collection is a membership grouping: one Zotero item can belong to multiple collections at the same time without being duplicated.

Because of this, the plugin must not blindly mirror the whole Zotero library as if it were a normal filesystem tree. It needs a clear sync root, a canonical path rule, and explicit behavior for multi-collection membership.

---

## Core decision

The plugin should require a **Zotero sync root**.

The sync root is the Zotero collection that corresponds to the local watch-folder root.

Recommended default:

```text
Local watch folder root
  = selected Zotero collection
```

Example:

```text
Local:
~/zotero-watch-folder-example/
  paper-a.pdf
  Methods/
    paper-b.pdf

Zotero:
Inbox/
  paper-a
  Methods/
    paper-b
```

In this example, `~/zotero-watch-folder-example/` is not itself mirrored as a collection named `zotero-watch-folder-example`. It is the local mount point for the selected Zotero collection, `Inbox`.

---

## Why full-library mirroring is dangerous

A natural first idea is:

```text
~/zotero-watch-folder-example/
  Inbox/
  Project A/
  Project B/
```

mapped to:

```text
Zotero Library Root
  Inbox/
  Project A/
  Project B/
```

This is dangerous because Zotero’s library root is not a normal folder. The library root shows all items in the library. Collections are not exclusive containers. An item can appear in multiple collections and subcollections without being duplicated.

So the plugin should avoid treating the Zotero library root as a normal filesystem root.

### Product rule

Full-library-root sync should be disabled by default.

If supported later, it should be an advanced mode with special handling for:

* items in multiple collections;
* unfiled items;
* duplicate items;
* trash;
* saved searches;
* collection deletion versus item deletion;
* canonical local paths.

---

## Recommended user-facing setup

During setup, the plugin asks for two things:

```text
1. Local watch folder
   Example: ~/zotero-watch-folder-example

2. Zotero sync root
   Example: Inbox
```

The setup screen should show a preview:

```text
Files directly inside:
~/zotero-watch-folder-example/

will appear directly in:
Zotero > Inbox
```

If the user wants the Zotero collection to have the same name as the folder, the setup screen can offer:

```text
Create new Zotero collection named "zotero-watch-folder-example"
```

Then the mapping becomes:

```text
Local:
~/zotero-watch-folder-example/
  paper.pdf

Zotero:
zotero-watch-folder-example/
  paper.pdf
```

But the local folder should not automatically create an extra nested `Inbox/` folder unless the user is explicitly syncing the Zotero library root.

---

## Sync modes

The plugin supports three user-selectable modes.

| Mode   | Name                    | Direction                                                      | Deletion behavior                                  |
| ------ | ----------------------- | -------------------------------------------------------------- | -------------------------------------------------- |
| Mode 1 | Import only             | Local folder → Zotero                                          | No delete propagation                              |
| Mode 2 | Mirror without deleting | Local ↔ Zotero for adds, updates, renames, folders/collections | Deletes warn only                                  |
| Mode 3 | Mirror with safe delete | Local ↔ Zotero including deletes                               | Deletes go to trash only; conflicts block deletion |

---

## Path and collection mapping rules

### Rule 1 — Local root maps to sync root collection

```text
Local:
/watch-root/file.pdf

Zotero:
Sync Root Collection/file.pdf
```

The local root folder name is not itself part of the Zotero collection hierarchy unless the user selected “create/use collection with same name as folder.”

### Rule 2 — Local subfolders map to Zotero subcollections

```text
Local:
/watch-root/Methods/paper.pdf

Zotero:
Sync Root Collection/Methods/paper.pdf
```

### Rule 3 — Zotero subcollections map to local subfolders in Modes 2 and 3

If the user creates this in Zotero:

```text
Inbox/Methods/
```

then the plugin creates:

```text
/watch-root/Methods/
```

Only in Mode 2 or Mode 3.

Mode 1 does not write Zotero-created collections back to disk.

### Rule 4 — Special Zotero collections are not normal folders

The plugin must not mirror these as ordinary local folders:

* Duplicate Items
* Unfiled Items
* Trash
* My Publications
* Saved Searches

If full-library-root sync is ever supported, these need explicit pseudo-folder or ignore rules.

### Rule 5 — Collection membership is not the same as file location

A Zotero item can belong to multiple collections. A local file usually has one canonical path.

Therefore, the plugin must distinguish:

```text
file path
collection membership
attachment identity
item identity
```

---

## Canonical path rule for multi-collection items

Problem:

```text
Zotero:
Inbox/
  paper-a

Project A/
  paper-a

Important/
  paper-a
```

This might be one Zotero item in three collections, not three files.

The plugin should not create three separate physical local copies by default.

### Recommended default

One Zotero attachment gets one canonical local file path.

Additional Zotero collection memberships are stored in tracking metadata, not duplicated as files.

Example tracking record:

```json
{
  "zoteroItemKey": "ABCD1234",
  "zoteroAttachmentKey": "WXYZ9876",
  "canonicalLocalPath": "Methods/paper-a.pdf",
  "collectionMemberships": [
    "Inbox",
    "Project A",
    "Important"
  ],
  "canonicalCollectionKey": "Inbox/Methods"
}
```

### Canonical path selection order

When a Zotero item belongs to multiple collections under the sync root, choose the local path using this priority:

1. Existing tracked canonical path.
2. User-selected preferred collection, if configured.
3. First collection under the selected sync root where the item appeared.
4. Shortest path under the sync root.
5. Stable deterministic fallback: sort collection paths alphabetically and choose the first.

### Optional advanced strategies

| Strategy                     | Behavior                                                  | Default?          |
| ---------------------------- | --------------------------------------------------------- | ----------------- |
| Single canonical file        | One physical file; memberships tracked as metadata        | Yes               |
| Duplicate physical files     | One copy per collection path                              | No                |
| Symlinks/hardlinks/shortcuts | One real file plus aliases                                | No; advanced only |
| Metadata sidecar             | One file plus `.zotero-watch.json` describing memberships | Maybe later       |

---

## Multi-collection item behavior

This is the central mismatch between Zotero and a local filesystem.

In Zotero, this can be one single item:

```text
Zotero:
Inbox/
  paper-a

Methods/
  paper-a

Important/
  paper-a
```

But on disk, the plugin should not create this by default:

```text
/watch-root/paper-a.pdf
/watch-root/Methods/paper-a.pdf
/watch-root/Important/paper-a.pdf
```

That would create three physical files for one Zotero attachment. If the user edits one of them locally, the plugin would then need to decide whether the other two are copies, aliases, conflicts, or independent files. That is too risky for the default behavior.

### Default behavior: one canonical local file

The plugin chooses one canonical local path:

```text
/watch-root/Methods/paper-a.pdf
```

The Zotero item can still belong to multiple collections:

```text
Zotero memberships:
- Inbox
- Methods
- Important
```

But only one local file exists.

The tracking record stores both the canonical path and the extra collection memberships:

```json
{
  "type": "file",
  "zoteroItemKey": "ITEM123",
  "zoteroAttachmentKey": "ATTACH456",
  "canonicalLocalPath": "Methods/paper-a.pdf",
  "canonicalCollectionKey": "Methods",
  "collectionMembershipKeys": [
    "Inbox",
    "Methods",
    "Important"
  ],
  "state": "clean"
}
```

### What the user sees locally

If the canonical path is `Methods/paper-a.pdf`, the local folder looks like:

```text
/watch-root/
  Methods/
    paper-a.pdf
```

The local folder does not show duplicate copies under `Inbox/` and `Important/`.

### What happens when membership changes

| Zotero action                                                                              | Expected local behavior                                                                            |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Add `paper-a` to another collection                                                        | Update membership metadata only; do not create another local file                                  |
| Remove `paper-a` from a non-canonical collection                                           | Update membership metadata only; do not move or delete local file                                  |
| Remove `paper-a` from its canonical collection but it remains in another synced collection | Choose a new canonical collection or keep existing path as a stable path; do not delete local file |
| Move `paper-a` from one collection to another                                              | In Modes 2/3, move local file only if canonical path changes and the local file is unchanged       |
| Remove `paper-a` from all collections under the sync root                                  | Treat as out-of-scope, not necessarily deletion; warn/suppress unless strict mirror is enabled     |
| Delete the Zotero attachment itself                                                        | This is true attachment deletion; Mode 3 may trash the local file if unchanged                     |
| Delete the Zotero parent item                                                              | This is true parent deletion; Mode 3 may trash matched local files if unchanged                    |

### Local action when one file represents many collection memberships

If the user edits the canonical local file, the edit updates the single Zotero attachment. Since all Zotero collections point to the same item, all Zotero collection views see the updated attachment.

If the user deletes the canonical local file:

* Mode 1: Zotero is unchanged.
* Mode 2: warn only.
* Mode 3: delete/trash the matched Zotero attachment only if unchanged.

Deleting the canonical local file does not mean “remove the item from only one Zotero collection.” A filesystem delete has no way to express which Zotero collection membership the user intended to remove.

### Optional advanced behavior: local collection aliases

Later, the plugin could show multi-collection membership locally using aliases rather than duplicate files:

```text
/watch-root/Methods/paper-a.pdf        <-- real canonical file
/watch-root/Important/paper-a.pdf      <-- alias/shortcut/symlink to canonical file
```

This should not be the default because symlinks, shortcuts, hardlinks, cloud sync tools, and cross-platform behavior are fragile.

### Product rule

```text
One Zotero attachment = one canonical local file.
Multiple Zotero collection memberships = metadata, not duplicate local files.
```

---

## Root-level file examples

### Example 1 — Sync root is Inbox

Settings:

```text
Local watch folder: ~/zotero-watch-folder-example
Zotero sync root: Inbox
Mode: Import only
```

User adds:

```text
~/zotero-watch-folder-example/new-paper.pdf
```

Expected Zotero state:

```text
Inbox/
  new-paper
    new-paper.pdf
```

No local `Inbox/` folder is created.

### Example 2 — User creates a local subfolder

User adds:

```text
~/zotero-watch-folder-example/Methods/method-paper.pdf
```

Expected Zotero state:

```text
Inbox/
  Methods/
    method-paper
      method-paper.pdf
```

### Example 3 — User wants folder name as collection name

Settings:

```text
Local watch folder: ~/zotero-watch-folder-example
Zotero sync root: create/use collection named zotero-watch-folder-example
```

User adds:

```text
~/zotero-watch-folder-example/paper.pdf
```

Expected Zotero state:

```text
zotero-watch-folder-example/
  paper
    paper.pdf
```

---

## Install-time baseline behavior

On first run, the plugin does not know what was deleted, moved, or intentionally absent. Therefore, first run must establish a baseline and must not propagate deletions.

| Case | Local watch folder     | Zotero sync root                             | Mode 1                              | Mode 2                                          | Mode 3                     |
| ---- | ---------------------- | -------------------------------------------- | ----------------------------------- | ----------------------------------------------- | -------------------------- |
| B.1  | Empty                  | Empty                                        | No-op; create baseline              | Same                                            | Same                       |
| B.2  | Empty                  | Has items                                    | Ignore Zotero items                 | Copy Zotero items to local                      | Same as Mode 2; no deletes |
| B.3  | Has files              | Empty                                        | Import files                        | Import files                                    | Import files; no deletes   |
| B.4  | Has folders only       | Empty                                        | Create Zotero subcollections        | Same                                            | Same                       |
| B.5  | Has folders with files | Empty                                        | Create collections and import files | Same                                            | Same                       |
| B.6  | Empty                  | Has empty subcollections                     | Ignore                              | Create local folders                            | Same                       |
| B.7  | Both have content      | Reconcile by hash and identity; never delete | Same plus reverse copy              | Same; safe delete disabled until clean baseline |                            |

---

## Empty folder / empty collection behavior

| Case | Action                                  | Mode 1                                 | Mode 2              | Mode 3                                                   |
| ---- | --------------------------------------- | -------------------------------------- | ------------------- | -------------------------------------------------------- |
| EF.1 | User creates empty local folder         | Create Zotero subcollection            | Same                | Same                                                     |
| EF.2 | User creates empty Zotero subcollection | Ignore                                 | Create local folder | Same                                                     |
| EF.3 | User deletes empty local folder         | Do not delete Zotero collection        | Warn                | Delete/trash Zotero collection only if tracked and empty |
| EF.4 | User deletes empty Zotero collection    | Ignore                                 | Warn                | Remove/trash local folder only if tracked and empty      |
| EF.5 | Folder contains only ignored files      | Treat as empty for collection purposes | Same                | Same                                                     |

---

## Deletion model checkpoint

Deletion is the highest-risk part of the plugin. The plugin must treat Zotero parent items, Zotero attachment items, Zotero collection membership, local files, and local folders as different objects.

Core rule:

```text
A local file maps primarily to a Zotero attachment, not to the whole bibliographic parent item.
```

Therefore, deleting a PDF attachment in Zotero should not automatically delete the whole bibliographic item. Likewise, deleting a local PDF should not automatically delete the parent Zotero entry.

---

## Zotero object types that look like “delete” but mean different things

| User action                                             | Zotero meaning                                              | Plugin interpretation                                          |
| ------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------- |
| Remove item from collection                             | Item remains in library and may remain in other collections | Scope/membership change, not deletion                          |
| Delete collection                                       | Collection is removed; items remain in library              | Collection mapping deletion, not item deletion                 |
| Delete collection and items                             | Collection and contained items are moved/deleted together   | Bulk item deletion candidate                                   |
| Move parent item to Trash                               | Bibliographic item is removed from active library           | True item deletion candidate                                   |
| Delete child attachment/PDF                             | Only that attachment is removed; parent item may remain     | Attachment deletion candidate                                  |
| Delete standalone attachment item                       | The standalone file item is removed                         | Item/attachment deletion candidate                             |
| Delete file from Zotero storage manually outside Zotero | Attachment item may remain but file bytes are missing       | File-missing error, not user-intended item deletion            |
| Empty Zotero Trash                                      | Permanent cleanup of already-trashed items                  | No new local action; prior trash decision should already exist |

---

## Parent item versus attachment deletion

Zotero commonly represents a paper as:

```text
Parent bibliographic item
  child attachment: paper.pdf
  child note(s)
  tags
  collections
```

The watch folder file corresponds to the child attachment, not necessarily to the parent item.

### Product rule

Deleting only the PDF attachment from Zotero should delete or trash only the corresponding local file in Mode 3. It should not delete the parent bibliographic entry by default.

Deleting the local PDF should delete or trash only the corresponding Zotero attachment in Mode 3. It should not delete the parent bibliographic entry by default.

### Why

The user may want to keep citation metadata, notes, tags, related items, and collection membership even after removing the PDF file.

---

## Local file deletion matrix

| Case | User action                                                             | Mode 1 — Import only                                                 | Mode 2 — Mirror without deleting | Mode 3 — Mirror with safe delete                                                           |
| ---- | ----------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------ |
| LD.1 | Delete tracked local PDF; Zotero attachment unchanged                   | Keep Zotero unchanged; mark local missing                            | Warn; keep Zotero unchanged      | Move matching Zotero attachment to Trash/remove attachment only; parent item remains       |
| LD.2 | Delete tracked local PDF; Zotero attachment changed                     | Keep Zotero unchanged                                                | Conflict                         | Conflict; do not delete Zotero attachment                                                  |
| LD.3 | Delete tracked local PDF; parent has multiple attachments               | Keep Zotero unchanged                                                | Warn                             | Delete/trash only the matched attachment; other attachments remain                         |
| LD.4 | Delete last local PDF for a parent item                                 | Keep Zotero parent                                                   | Warn                             | Delete/trash attachment only; parent remains as metadata-only item                         |
| LD.5 | Delete local file for standalone Zotero attachment                      | Keep Zotero standalone item                                          | Warn                             | Move standalone Zotero attachment item to Trash if unchanged                               |
| LD.6 | Delete untracked local file                                             | No action                                                            | No action                        | No action                                                                                  |
| LD.7 | Delete local duplicate/alias file with same hash                        | Do not delete Zotero if another canonical tracked local file remains | Warn                             | Delete only alias record; do not delete Zotero attachment unless canonical file is deleted |
| LD.8 | Move local file outside watch folder                                    | Treat as scope removal, not definite deletion                        | Warn and suppress re-import loop | Safe-delete only if user setting says “moving out means delete”; otherwise warn            |
| LD.9 | Whole local folder disappears, drive disconnected, or permission denied | Pause; not deletion                                                  | Pause; not deletion              | Pause; destructive sync blocked                                                            |

---

## Zotero attachment/PDF deletion matrix

| Case | User action in Zotero                                          | Mode 1 — Import only                               | Mode 2 — Mirror without deleting                                              | Mode 3 — Mirror with safe delete                                                          |
| ---- | -------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| ZA.1 | Delete child PDF attachment; parent item remains               | Local file remains; mark Zotero attachment missing | Warn; local file remains                                                      | Move matched local file to plugin trash/OS trash if unchanged; parent item is not deleted |
| ZA.2 | Delete one of several attachments under same parent            | Local files remain                                 | Warn for that attachment only                                                 | Trash only the matching local file; leave other local files and parent item alone         |
| ZA.3 | Delete last PDF attachment under parent                        | Local file remains                                 | Warn                                                                          | Trash local file only; parent item remains metadata-only                                  |
| ZA.4 | Delete standalone attachment item                              | Local file remains                                 | Warn                                                                          | Trash local file if unchanged; mark Zotero item/attachment tombstone                      |
| ZA.5 | Attachment item remains but stored file is missing/unavailable | No action                                          | Mark pending/missing; retry or offer repair                                   | Same; do not trash local file because Zotero item was not deleted                         |
| ZA.6 | Zotero file sync has not downloaded the stored attachment yet  | Ignore                                             | Mark pending Zotero file availability                                         | Same                                                                                      |
| ZA.7 | Attachment is linked to a file outside the watch folder        | Ignore                                             | Copy into watch folder or warn; do not adopt arbitrary external path silently | Same                                                                                      |
| ZA.8 | Attachment is linked to the watch-folder file                  | Existing local file is source                      | Track existing local file                                                     | Track existing local file; safe-delete still requires unchanged hash                      |

---

## Zotero parent item deletion matrix

| Case | User action in Zotero                                                      | Mode 1                    | Mode 2                           | Mode 3                                                                                |
| ---- | -------------------------------------------------------------------------- | ------------------------- | -------------------------------- | ------------------------------------------------------------------------------------- |
| ZP.1 | Move parent item to Trash; it has one tracked attachment                   | Local file remains        | Warn                             | Trash local file if unchanged; mark item/attachment tombstone                         |
| ZP.2 | Move parent item to Trash; it has multiple tracked attachments             | Local files remain        | Warn for all tracked attachments | Trash each unchanged local file; conflicts block per-file                             |
| ZP.3 | Move parent item to Trash; local file modified                             | Local file remains        | Conflict                         | Conflict; do not trash local file                                                     |
| ZP.4 | Parent item deleted but attachment appears to survive elsewhere            | Local file remains        | Warn/repair tracking             | Do not trash local file unless the tracked attachment itself is confirmed deleted     |
| ZP.5 | Parent item has notes/tags/relations but PDF deleted only                  | Parent remains            | Parent remains                   | Parent remains; only attachment/local file is affected                                |
| ZP.6 | Plugin-created parent becomes metadata-only after last attachment deletion | Parent remains by default | Parent remains by default        | Parent remains by default; optional cleanup setting may move it to Trash only if safe |

### Optional cleanup setting: delete empty plugin-created parent

This should be disabled by default.

If enabled, the plugin may move a parent item to Trash after its last plugin-managed attachment is deleted only when all of these are true:

1. the parent item was created by the plugin from an imported file;
2. the parent item has no remaining attachments;
3. the parent item has no user-created notes;
4. the parent item has no manually added tags, relations, or extra metadata beyond what the plugin created;
5. the parent item is not in any collection outside the sync root;
6. the user is in Mode 3;
7. the operation goes to Zotero Trash, not permanent delete.

Default recommendation: do not auto-delete parent items.

---

## Collection and scope deletion matrix

Zotero collection deletion is not the same as item deletion. Removing an item from a collection is also not the same as deleting the item.

| Case | User action                                                                       | Mode 1                          | Mode 2                                                                        | Mode 3                                                                                                         |
| ---- | --------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| CS.1 | Remove item from synced collection only                                           | Ignore; local file remains      | Warn; local file remains but record becomes out-of-scope/suppressed           | If strict sync-root mirror is enabled and local unchanged, move local file to trash; otherwise warn/suppress   |
| CS.2 | Move item from one synced subcollection to another                                | Ignore Zotero-side move         | Move local file/folder path if canonical collection changes                   | Same                                                                                                           |
| CS.3 | Remove item from canonical collection but it remains in another synced collection | Ignore                          | Choose new canonical path or keep existing path based on canonical path rules | Same; do not trash local file                                                                                  |
| CS.4 | Delete Zotero collection only                                                     | Ignore                          | Warn; local folder remains but collection record is out-of-scope              | Remove/trash local empty folder only if tracked and strict mirror enabled; do not delete item files by default |
| CS.5 | Delete collection and items                                                       | Ignore                          | Warn                                                                          | Bulk safe-delete candidate; each file must pass clean-hash check                                               |
| CS.6 | Delete local folder only                                                          | Do not delete Zotero collection | Warn                                                                          | Delete/trash Zotero collection only if tracked and empty; deleting items requires explicit strict setting      |
| CS.7 | Delete local folder with tracked files                                            | Keep Zotero items               | Warn                                                                          | Bulk safe-delete only after threshold/confirmation and per-file clean checks                                   |

### Suppression rule to prevent re-import loops

If a Zotero item is removed from the sync root but the local file remains, the plugin must not immediately re-import or re-add the file back to Zotero on the next scan.

Instead, mark the record as:

```text
state = out-of-scope-suppressed
reason = removed-from-zotero-collection
```

The user can then choose one of:

```text
Re-add to Zotero sync root
Keep local file but stop syncing it
Move local file to trash
Move local file outside watch folder
```

---

## Bulk deletion safety

Mode 3 must include bulk-delete protection.

Trigger confirmation or block automatic propagation when any of these are true:

* more than N tracked files would be deleted at once;
* more than X percent of the synced tree would be deleted;
* a whole folder or collection disappeared;
* the watch folder path changed;
* the sync root collection changed;
* the local volume became unavailable;
* many Zotero delete events arrive in one batch;
* tracking data is stale, missing, or recently rebuilt.

Recommended default:

```text
If more than 10 files or more than 20% of tracked files would be deleted, pause and ask for confirmation.
```

---

## Local trash and Zotero Trash policy

In Mode 3, deletion must be recoverable.

| Direction                                | Safe-delete behavior                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| Zotero attachment deleted → local file   | Move local file to `.zotero-watch-trash/` or OS trash                               |
| Zotero parent item trashed → local files | Move matched local files to trash if unchanged                                      |
| Local file deleted → Zotero attachment   | Move only the matched attachment item to Zotero Trash                               |
| Local folder deleted → Zotero collection | Delete/trash collection only if tracked and empty, unless strict setting is enabled |
| Collection removal only                  | Treat as scope change, not content deletion                                         |

The plugin should keep tombstone records long enough to support restore and to avoid re-importing deleted files as new items.

---

## Restore behavior after deletion

| Case  | User action                                       | Expected behavior                                                                                    |
| ----- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| RST.1 | Restore Zotero attachment from Trash              | Restore local file from plugin trash if available; otherwise copy from Zotero storage in Modes 2/3   |
| RST.2 | Restore Zotero parent item with attachments       | Restore all matched local files if available and no path conflict exists                             |
| RST.3 | Restore local file from plugin trash              | Re-link to Zotero tombstone if available; otherwise treat as new local add                           |
| RST.4 | Restore parent item but not attachment            | Keep local file trashed unless attachment is restored too                                            |
| RST.5 | Restore local file after parent item was deleted  | Offer to restore/create Zotero attachment under original parent if possible; otherwise import as new |
| RST.6 | Trash file path collides with existing local file | Restore as copy with suffix; never overwrite                                                         |

---

## File-missing versus deletion

The plugin must distinguish “the user deleted an object” from “the bytes are temporarily unavailable.”

| Situation                                              | Classification       | Behavior                                         |
| ------------------------------------------------------ | -------------------- | ------------------------------------------------ |
| Zotero attachment item deleted                         | deletion candidate   | Mode 3 may trash local file if unchanged         |
| Zotero attachment item exists but file path missing    | missing file error   | Do not delete local file; offer repair/copy-back |
| Zotero file sync has not downloaded file yet           | pending availability | Retry later                                      |
| Local file missing because external drive disconnected | folder unavailable   | Pause; no delete propagation                     |
| Local file online-only/cloud placeholder               | not deletion         | Hydrate/read if needed or skip until available   |
| Permission denied reading local file                   | access error         | Pause for that record; no delete propagation     |

---

## Duplicate and collision rules

The plugin must not rely on filenames alone.

| Situation                              | Behavior                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------- |
| Same filename, same hash               | Exact duplicate; do not import again                                      |
| Same filename, different hash          | Collision; keep both with suffix                                          |
| Different filename, same hash          | Same content; do not duplicate by default                                 |
| `paper (copy).pdf`, same hash          | Duplicate content; warn/ignore/link                                       |
| `paper (copy).pdf`, different hash     | Distinct file; import                                                     |
| Same DOI/title/authors, different hash | Possible duplicate reference; import and flag for Zotero duplicate review |
| Zotero duplicate merge happens         | Update tracking to surviving item/attachment                              |
| Same item in multiple collections      | One canonical local file; membership tracked separately                   |

Rule:

```text
Hash match = duplicate content.
Filename match = collision only.
Metadata match = possible duplicate reference.
Collection match = membership, not file identity.
```

---

## Tracking records required

The plugin needs records for both files and folders/collections.

### File record

```json
{
  "type": "file",
  "localPath": "Methods/paper.pdf",
  "canonicalLocalPath": "Methods/paper.pdf",
  "lastSyncedHash": "...",
  "lastSyncedSize": 123456,
  "lastSyncedMtime": "...",
  "zoteroItemKey": "...",
  "zoteroAttachmentKey": "...",
  "canonicalCollectionKey": "...",
  "collectionMembershipKeys": ["..."],
  "state": "clean"
}
```

### Folder / collection record

```json
{
  "type": "collection",
  "localPath": "Methods",
  "zoteroCollectionKey": "...",
  "parentCollectionKey": "...",
  "state": "clean"
}
```

### Tombstone record

```json
{
  "type": "tombstone",
  "objectType": "file",
  "localPath": "Methods/paper.pdf",
  "zoteroAttachmentKey": "...",
  "deletedFrom": "zotero",
  "trashPath": ".zotero-watch-trash/Methods/paper.pdf",
  "deletedAt": "...",
  "state": "recoverable"
}
```

---

## Open design questions

These need explicit product decisions before implementation.

1. Should Mode 1 create Zotero subcollections for empty local folders?

   * Current recommendation: yes, because local → Zotero is allowed in Mode 1.

2. Should Mode 1 update Zotero collection names when local folders are renamed?

   * Current recommendation: yes, if the folder/collection is tracked.

3. Should Zotero root-level unfiled items be mirrorable?

   * Current recommendation: no for first version.

4. Should one Zotero item in multiple synced subcollections appear as one file or many files?

   * Current recommendation: one canonical file.

5. Should users be able to choose duplicate physical copies for multi-collection items?

   * Current recommendation: advanced setting only, not default.

6. Should folder deletion in Mode 3 delete items inside the corresponding Zotero collection?

   * Current recommendation: only if the user explicitly chooses strict mirror behavior and the items are clean/tracked.

7. Should deletion from a Zotero collection count as deletion or just unfiling?

   * Current recommendation: removal from collection is not deletion.

8. What should happen when an item is removed from the synced root but still exists elsewhere in Zotero?

   * Current recommendation: local file remains in Mode 1/2; Mode 3 warns unless strict collection mirror is enabled.

---

## Current recommended product position

The plugin should be described as:

> A safe mirror between a selected local folder and a selected Zotero collection, not a filesystem mirror of the entire Zotero library.

Default setup should be:

```text
Local watch folder root = selected Zotero collection
Subfolders = subcollections
Files = attachments/items
One Zotero attachment = one canonical local file
Deletes propagate only in Mode 3 and only through trash
```

This keeps the file structure understandable while respecting Zotero’s collection model.
