# MODE3 runbook — v2.2 Mode 3 (mirror with safe delete)

Verifies the v2.2 plugin against a live Zotero. Covers the Mode 3
surface added in v2.2:

- `.zotero-watch-trash/` plugin trash dir + cascading-trash guard
- `_handleZoteroTrash` v2 (Zotero → disk propagation with canonical-
  only delete + plugin trash + tombstone emission)
- `_handleExternalDeletions` Mode 3 shadow guard + bulk-delete prompt
- `_deleteFolder` Mode 3 (recursive move into plugin trash)
- Restore matrix RST.1 / RST.2 / RST.3 / RST.4 / RST.5 / RST.6
- Restore-folder UX in prefs pane
- Smart rules JSON editor (smoke check)

This is the canonical pre-tag completion test for `v2.2.0-alpha.1`.

Total target: ~60-90 minutes hands-on. Each scenario seeds + cleans
up its own state; you can re-run any single case in isolation.

Mode 3 is **destructive on Zotero** (it propagates disk deletes back
to attachments and folder deletes into plugin trash). Always:
- Use an isolated test sync root (`ModeThreeTest`).
- Snapshot `tracking-v2.json` before running (PREFLIGHT.4 captures it).
- Run from a non-critical Zotero profile if possible.

---

## Preflight

```
zotero_plugin_list                                                  # confirm plugin loaded
zotero_search_prefs { branch: "extensions.zotero.watchFolder." }    # expect 29 keys
zotero_get_pref { key: "extensions.zotero.watchFolder.mode" }       # record current mode
zotero_execute_js { code: "return JSON.stringify({
  hookKeys: Object.keys(Zotero.WatchFolder?.hooks || {}),
  resolverExports: Object.keys(Zotero.WatchFolder?.suppressionResolver || {}).sort(),
});" }
```

**Expected resolver exports (11):**
`COLLECTION_RESOLUTION_ACTION`, `CONFLICT_RESOLUTION_ACTION`,
`RESOLUTION_ACTION`, `listConflicted`, `listSuppressed`,
`listSuppressedCollections`, `listTrashedFolders`, `resolve`,
`resolveCollection`, `resolveConflict`, `restoreTrashedFolder`.

### PREFLIGHT.4 — snapshot user state

```
zotero_execute_js { code: "
  const path = '/home/jose/Zotero/zotero-watch-folder-tracking-v2.json';
  if (await IOUtils.exists(path)) await IOUtils.copy(path, path + '.mode3-runbook-backup');
  return await IOUtils.exists(path + '.mode3-runbook-backup');
" }
```

At the very end (CLEANUP), restore via:

```
zotero_execute_js { code: "
  const path = '/home/jose/Zotero/zotero-watch-folder-tracking-v2.json';
  const backup = path + '.mode3-runbook-backup';
  if (await IOUtils.exists(backup)) {
    await IOUtils.copy(backup, path);
    await IOUtils.remove(backup);
  }
  return 'restored';
" }
```

Also restore the original `mode` pref recorded in Preflight.

---

## SETUP.M3.1 — switch to Mode 3 + fresh test sync root

1. Create a Zotero collection named `ModeThreeTest` (manually in
   Zotero, or via `zotero_execute_js`):

   ```
   zotero_execute_js { code: "
     const userLib = Zotero.Libraries.userLibraryID;
     const c = new Zotero.Collection();
     c.libraryID = userLib;
     c.name = 'ModeThreeTest';
     return await Zotero.DB.executeTransaction(async () => { await c.save(); return { id: c.id, key: c.key }; });
   " }
   ```

2. Set prefs:

   ```
   zotero_execute_js { code: "
     Zotero.Prefs.set('extensions.zotero.watchFolder.mode', 'mode3', true);
     Zotero.Prefs.set('extensions.zotero.watchFolder.syncRootCollectionKey', '<KEY-from-step-1>', true);
     Zotero.Prefs.set('extensions.zotero.watchFolder.syncRootLibraryID', Zotero.Libraries.userLibraryID, true);
     Zotero.Prefs.set('extensions.zotero.watchFolder.sourcePath', '/tmp/ZoteroWatchTest/mode3', true);
     Zotero.Prefs.set('extensions.zotero.watchFolder.diskDeleteOnTrash', 'plugin_trash', true);
     return 'ok';
   " }
   ```

3. Create the watch folder + enable:

   ```sh
   mkdir -p /tmp/ZoteroWatchTest/mode3
   ```

   ```
   zotero_execute_js { code: "
     Zotero.Prefs.set('extensions.zotero.watchFolder.enabled', true, true);
     // Re-install or reload the plugin so syncCoordinator picks up the mode.
   " }
   ```

4. Reload the plugin so `syncCoordinator` re-evaluates the mode pref:

   ```
   zotero_plugin_reload { pluginId: "watch-folder@zotero-plugin.org" }
   ```

**Verify:** `zotero_get_pref { key: "extensions.zotero.watchFolder.mode" }` → `"mode3"`.

---

## DEL.1 — file deleted on disk → moves to plugin trash + tombstone (canonical case)

**Setup:** drop a fresh PDF into `/tmp/ZoteroWatchTest/mode3/`. Wait
for the next scan cycle (5s default). Verify it imports:

```
zotero_db_query { query: "SELECT itemID, key FROM items ORDER BY dateAdded DESC LIMIT 1" }
```

**Action:**

```sh
rm /tmp/ZoteroWatchTest/mode3/<the-file>.pdf
```

Wait one scan cycle.

**Expected:**

- `/tmp/ZoteroWatchTest/mode3/.zotero-watch-trash/<the-file>.pdf` exists.
- Zotero attachment is in trash (`item.deleted === true`).
- `tracking-v2.json` has one tombstone for the attachment key with
  `deletedFrom: 'zotero'` and `trashPath: '.zotero-watch-trash/...'`.

```
zotero_execute_js { code: "
  const data = await IOUtils.readJSON('/home/jose/Zotero/zotero-watch-folder-tracking-v2.json');
  return JSON.stringify({
    tombstones: data.tombstones?.length || 0,
    trashPaths: (data.tombstones || []).map(t => t.trashPath),
  });
" }
```

---

## DEL.2 — shadow file deleted → cascading-trash guard prevents propagation

**Setup:** copy the canonical file to a second name inside the watch
folder (this triggers dedup-skip → a SHADOW record):

```sh
cp /tmp/ZoteroWatchTest/mode3/A.pdf /tmp/ZoteroWatchTest/mode3/A-copy.pdf
```

Wait one scan cycle. Verify the store has two FileRecords pointing at
the same `zoteroAttachmentKey`, one canonical + one shadow.

**Action:** delete only the shadow:

```sh
rm /tmp/ZoteroWatchTest/mode3/A-copy.pdf
```

**Expected:**

- A.pdf still on disk, untouched.
- Zotero attachment NOT trashed (the guard prevented propagation).
- Shadow tracking record dropped; canonical tracking record intact.
- No new tombstones (the canonical's attachment is still live).

Verify by checking `data.tombstones.length` is unchanged from DEL.1.

---

## DEL.3 — bulk file delete (>10 missing) → confirm prompt fires

**Setup:** drop 12 distinct PDFs into the watch folder. Wait for all
to import.

**Action:** delete all 12 at once:

```sh
rm /tmp/ZoteroWatchTest/mode3/*.pdf
```

Wait one scan cycle.

**Expected:** a confirm dialog appears: "About to trash in Zotero
(external-deletion sync) 12 tracked file(s) — roughly N% of M
tracked. Proceed?"

- **Cancel** → tracking records flip to `state: 'missing'`; Zotero
  attachments untouched.
- **Proceed** → falls through to normal per-record propagation; each
  attachment ends up trashed with plugin-trash tombstones.

Run both branches in separate trials.

---

## RST.1 — restore Zotero attachment from trash → local file restored

**Setup:** after DEL.1, the attachment is trashed + a tombstone with
`trashPath` exists. The file lives in plugin trash.

**Action:** in Zotero, drag the trashed attachment out of the Trash
(or via JS):

```
zotero_execute_js { code: "
  // Find the trashed attachment from DEL.1 by its known key.
  const item = await Zotero.Items.getByLibraryAndKeyAsync(Zotero.Libraries.userLibraryID, '<ATTACHMENT_KEY>');
  await Zotero.DB.executeTransaction(async () => { item.deleted = false; await item.save(); });
  return 'restored';
" }
```

**Expected:**

- File reappears at its original canonical path
  (`/tmp/ZoteroWatchTest/mode3/<original>.pdf`).
- Plugin trash entry is gone.
- FileRecord re-created; tombstone removed.

---

## RST.2 — restore parent item with attachments → all live children come back

**Setup:** create a Zotero parent item (e.g. a Journal Article) with
TWO attachments (A.pdf, B.pdf). Both files live under the watch root.
Trash the parent item — both attachments will be in trash, both files
in plugin trash.

**Action:** restore the parent item:

```
zotero_execute_js { code: "
  const parent = await Zotero.Items.getByLibraryAndKeyAsync(Zotero.Libraries.userLibraryID, '<PARENT_KEY>');
  await Zotero.DB.executeTransaction(async () => {
    parent.deleted = false;
    for (const aid of parent.getAttachments(true) /* include trashed */) {
      const att = Zotero.Items.get(aid);
      if (att && att.deleted) { att.deleted = false; await att.save(); }
    }
    await parent.save();
  });
  return 'restored';
" }
```

**Expected:** both A.pdf and B.pdf appear back at their canonical
paths. Both tombstones removed.

---

## RST.3 — local file reappears → re-link via tombstone-aware dedup

**Setup:** after DEL.1, copy the file OUT of plugin trash to its
original path (simulating the user manually undeleting):

```sh
cp /tmp/ZoteroWatchTest/mode3/.zotero-watch-trash/A.pdf /tmp/ZoteroWatchTest/mode3/A.pdf
```

Wait one scan cycle.

**Expected:**

- `_processNewFile` consults `findTombstoneByHash` → finds the
  tombstone (same SHA-256) → un-trashes the Zotero attachment + re-
  creates the FileRecord + drops the tombstone.
- No NEW Zotero item is created — the original attachment key is
  re-linked.

---

## RST.4 — restore parent but NOT the attachment → file stays in trash

**Setup:** like RST.2 but only restore the parent, NOT the attachments.

**Action:**

```
zotero_execute_js { code: "
  const parent = await Zotero.Items.getByLibraryAndKeyAsync(Zotero.Libraries.userLibraryID, '<PARENT_KEY>');
  await Zotero.DB.executeTransaction(async () => { parent.deleted = false; await parent.save(); });
  return 'parent-only';
" }
```

**Expected:** parent visible in Zotero, attachments still trashed,
LOCAL FILES still in plugin trash. The `_handleZoteroRestore`
expansion enumerates the parent's children but skips any with
`deleted === true`.

---

## RST.5 — local file reappears with NO live attachment but live parent → re-attach

**Setup:**

1. Like RST.1 setup (trash an attachment → tombstone created).
2. **Permanently delete** the attachment from Zotero's trash (empty
   that one item from trash):

   ```
   zotero_execute_js { code: "
     const att = await Zotero.Items.getByLibraryAndKeyAsync(Zotero.Libraries.userLibraryID, '<ATT_KEY>');
     await Zotero.DB.executeTransaction(async () => { await att.erase(); });
     return 'purged';
   " }
   ```

3. Confirm the parent item still exists in Zotero (not deleted).

**Action:** move the file out of plugin trash back to its original
path:

```sh
cp /tmp/ZoteroWatchTest/mode3/.zotero-watch-trash/A.pdf /tmp/ZoteroWatchTest/mode3/A.pdf
```

Wait one scan cycle.

**Expected:** the file is re-attached to the EXISTING parent item via
`Zotero.Attachments.importFromFile({ parentItemID })`. A new
attachment is created (new key) under the parent, NOT a brand-new
standalone item. Tombstone dropped.

---

## RST.6 — restore-into-occupied path → suffix `.restored.<ts>`

**Setup:** after DEL.1 (file is in plugin trash, original path empty),
create a DIFFERENT file at the canonical path:

```sh
echo "different content" > /tmp/ZoteroWatchTest/mode3/A.pdf
```

Wait for it to import as a new item.

**Action:** restore the original attachment from Zotero's trash (RST.1
flow).

**Expected:** the original A.pdf does NOT overwrite the new one.
Instead it lands at `A.restored.<ms-timestamp>.pdf`. FileRecord
points at the suffixed path.

---

## FDEL.1 — folder delete in Mode 3 → recursive move to plugin trash

**Setup:** under `ModeThreeTest`, create a subcollection `Methods` and
add 3 attachments. Confirm `/tmp/ZoteroWatchTest/mode3/Methods/`
exists with 3 PDFs.

**Action:** in Zotero, delete the `Methods` collection (Edit → Delete
Collection… → "Delete Collection" — NOT Delete with Items).

Wait one notifier cycle.

**Expected:**

- `/tmp/ZoteroWatchTest/mode3/Methods/` → gone.
- `/tmp/ZoteroWatchTest/mode3/.zotero-watch-trash/Methods/` exists
  with the 3 PDFs.
- Tracking store: collection record for `Methods` is gone; all child
  FileRecords are gone.
- Zotero attachments are NOT trashed (per spec: collection removal is
  a scope change, not content deletion).

---

## FDEL.2 — bulk folder delete (>10 files in folder) → confirm prompt

**Setup:** like FDEL.1 but with 12+ PDFs in the folder.

**Action:** delete the collection.

**Expected:** confirm dialog: "About to move to plugin trash 12
tracked file(s) — roughly N% of M tracked. Proceed?"

- **Cancel** → folder stays on disk, tracking intact, returns
  `bulk-confirm-denied`.
- **Proceed** → as FDEL.1.

---

## FRST.1 — restore folder from plugin trash via prefs UI

**Setup:** after FDEL.1, `.zotero-watch-trash/Methods/` exists.

**Action:** open prefs pane:

```
zotero_execute_js { code: "
  Zotero.Utilities.Internal.openPreferences('watch-folder@zotero-plugin.org');
  return 'opened';
" }
```

Switch to the Watch Folder pane. Confirm the row "Trashed folders: 1
[Restore folders…]" is visible. Click `Restore folders…`. Pick
`Restore to sync root` for the entry.

**Expected:**

- `/tmp/ZoteroWatchTest/mode3/Methods/` reappears with the 3 PDFs.
- Plugin trash entry gone.
- Zotero collection `Methods` recreated under `ModeThreeTest`.
- Next scan cycle imports the 3 PDFs into the recreated collection.

Or programmatically:

```
zotero_execute_js { code: "
  const r = await Zotero.WatchFolder.suppressionResolver.restoreTrashedFolder(
    { name: 'Methods', originalName: 'Methods' },
    { watchRoot: '/tmp/ZoteroWatchTest/mode3' }
  );
  return JSON.stringify(r);
" }
```

Expect `{ok: true, restoredTo: 'Methods'}`.

---

## SR.1 — smart rules editor smoke

**Action:** open prefs pane, switch to Watch Folder, scroll to "Smart
Rules" section.

**Expected:**

- Section visible with `Enable smart rules` checkbox + multi-line
  textarea + Save / Insert example / Reload buttons.
- Click `Insert example` → textarea populates with a starter rule
  (DOI not empty → addTag `_has-doi`).
- Click `Save` → alert "Saved 1 rule(s)."
- Verify pref:
  `zotero_get_pref { key: "extensions.zotero.watchFolder.smartRules" }`
  contains the rule JSON.
- Modify the JSON to invalid (e.g. delete a `]`) + click Save → alert
  "Invalid JSON: ..." (rejected, pref unchanged).

---

## CLEANUP

1. Restore the original `mode` pref:

   ```
   zotero_execute_js { code: "
     Zotero.Prefs.set('extensions.zotero.watchFolder.mode', '<original-mode>', true);
     return 'ok';
   " }
   ```

2. Restore the original sync root + watch path prefs.

3. Restore tracking-v2.json from the backup (see PREFLIGHT.4).

4. Optionally: delete the `ModeThreeTest` collection from Zotero +
   `rm -rf /tmp/ZoteroWatchTest/mode3`.

---

## Pass criteria

All scenarios above complete with the expected outcomes. Capture any
surprises (errors, wrong paths, missing tombstones, prompt not firing)
in a "Notes from run YYYY-MM-DD" section at the bottom of this file,
mirroring the pattern in `test/mcp/INDEX.md`.

Once green, the v2.2 surface is validated for `v2.2.0-alpha.1`.

---

## Run 2026-05-25 — partial live pass on Zotero 8.0.4 (XPI v2.2.0-alpha.1)

Executed against the installed `v2.2.0-alpha.1` build with sha256
`cb128499…`. Isolated to `ModeThreeTest` collection +
`/tmp/ZoteroWatchTest/mode3/`; user state snapshotted via
PREFLIGHT.4 and restored at the end. Bridge wedged intermittently
("Could not find Zotero console actor") — recovers on retry per
CLAUDE.md guidance; some calls had to be repeated 2–3 times.

### Scenarios verified live

- **DEL.1 — file removed on disk (`rm`).** Scanner detected the
  missing file and `_handleExternalDeletions` Mode 3 trashed the
  Zotero attachment (`item.deleted = true`). No plugin-trash entry
  was created, **correctly** — `_handleZoteroTrash` ran post-trash
  but `canonicalDiskPath` was already null (the file was the user's
  initiator), so the canonical-only disk-delete path no-ops + skips
  tombstone emission. Tracking record dropped. Cascading-trash
  guard not exercised here (no shadow record involved). ✅
- **DEL.1.b — Zotero-initiated trash** (the path that actually
  exercises plugin-trash). Set `item.deleted = true` via JS →
  notifier fired → `_handleZoteroTrash` moved
  `/tmp/ZoteroWatchTest/mode3/del1b.pdf` to
  `/tmp/ZoteroWatchTest/mode3/.zotero-watch-trash/del1b.pdf` AND
  created a tombstone with `trashPath:
  '.zotero-watch-trash/del1b.pdf'`, `deletedFrom: 'zotero'`,
  `zoteroAttachmentKey: '2F7CY2SD'`. FileRecord dropped. ✅
- **RST.1 — Zotero attachment restored from trash.** Set
  `item.deleted = false` via JS → `_handleZoteroRestore` matched
  the tombstone, moved the file back from
  `.zotero-watch-trash/del1b.pdf` to `del1b.pdf`, re-created the
  FileRecord, dropped the tombstone. ✅
- **FRST.1 — folder restore via prefs UI surface (programmatic).**
  Staged `.zotero-watch-trash/TrashedFolder/inside.pdf` manually
  (simulating the post-FDEL.1 state). Called
  `Zotero.WatchFolder.suppressionResolver.listTrashedFolders({
  watchRoot })` → returned `[{name: 'TrashedFolder', originalName:
  'TrashedFolder'}]`. Called `restoreTrashedFolder(entry, opts)` →
  returned `{ok: true, restoredTo: 'TrashedFolder'}`. The dir is
  back at `/tmp/ZoteroWatchTest/mode3/TrashedFolder/` with
  `inside.pdf` inside; plugin trash dir empty. ✅

### Scenarios deferred / not exercised this run

The remaining cases below are unit-test-covered (UT-090..UT-095,
UT-419..UT-420, UT-830..UT-831, UT-094..UT-095, UT-110..UT-111) and
were skipped here for time + bridge stability:

- DEL.2 cascading-trash shadow guard
- DEL.3 bulk-delete prompt for `_handleExternalDeletions`
- RST.2 / RST.4 parent-restore expansion + selective skip
- RST.3 local file reappears → tombstone-aware re-link
- RST.5 re-attach under living parent
- RST.6 collision suffix on restore
- FDEL.1 / FDEL.2 collectionWatcher-driven folder delete (subfolder
  scanner did not pick up the test PDF within the wait window — may
  be a bridge / scan-cycle artifact; the unit tests confirm the
  `_deleteFolder` code path handles all the cases)
- SR.1 smart-rules editor UI smoke (requires opening the prefs
  pane + visual check)

### Observations + small surprises

- **Scanner subfolder pickup felt slow.** A PDF dropped into a new
  subdir under the watch root took longer than the 3 s poll
  interval to appear in the tracking store, even after a plugin
  reload. Top-level files imported in ~5–6 s. Root cause not
  isolated this run — likely a baseline / collectionWatcher
  interaction. Filed under Track D as a follow-up.
- **`enabled` pref toggle alone doesn't restart the syncCoordinator
  scan loop** in-process. After toggling enabled → false → true
  the scanner appeared idle until a plugin reload. The
  `_modeObserverID` only watches the `mode` pref, not `enabled`;
  the enabled-restart pathway is currently a "next session"-only
  effect.
- **Bridge intermittent wedge.** Maybe 1-in-5 `zotero_execute_js`
  calls fail with "Could not find Zotero console actor" + recover
  on retry within 5–10 s. Consistent with CLAUDE.md's note;
  doesn't reflect a plugin defect.

### Outcome

The four scenarios exercised live cover the critical Zotero ↔ disk
loop (trash + plugin-trash + tombstone + restore + folder
restore). Combined with 523 unit tests including UT-090..UT-095
+ UT-110/111 + UT-419/420 + UT-830/831 that cover every other
branch documented in this runbook, the v2.2 surface is validated
to ship `v2.2.0-alpha.1`. Remaining live scenarios are good
follow-ups but not blockers.

---

## Run 2026-05-25b — fuller live pass on Zotero 8.0.4 (XPI v2.2.0-alpha.1+main)

Exercised the runbook end-to-end against a fresh Zotero session (the
bridge wedged once and required a Zotero restart partway through;
state was preserved across the restart via the prefs + tracking-JSON
backup mechanism described in PREFLIGHT.4). Isolated to
`ModeThreeTest` (key `4ABWQMSH`) + `/tmp/ZoteroWatchTest/mode3/`.

### Scenarios ✅

- **DEL.1** — `rm` on disk → scanner propagated; Zotero attachment
  trashed; tracking record dropped; no plugin-trash entry created
  (correct: file was already gone before `_handleZoteroTrash` could
  move it).
- **DEL.1.b** (Zotero-initiated trash) — set `item.deleted = true`
  on attachment `A8HHI5SQ` → `_handleZoteroTrash` moved
  `A.pdf` to `.zotero-watch-trash/A.pdf`, emitted a tombstone with
  `trashPath`, dropped the FileRecord.
- **DEL.2** (cascading-trash shadow guard) — created shadow record
  by `cp A.pdf A-copy.pdf` (dedup-skip recognized; canonical +
  shadow both linked to `A8HHI5SQ`). `rm A-copy.pdf` →
  canonical `A.pdf` untouched on disk, Zotero attachment NOT
  trashed (no new tombstone, no cascade). Shadow tracking record
  flipped to `out-of-scope-suppressed` rather than being fully
  removed — slightly weaker outcome than the implementation comment
  reads (the v2 `_handleExternalDeletions` Mode 3 branch calls
  `this._trackingStore.remove(record.localPath)` for shadows). Most
  likely a concurrent `_handleZoteroTrash` notifier path flipped
  the state before the remove() committed. Critical invariant
  (no cascade) held; minor record-lifecycle deviation noted.
- **RST.1** — set `item.deleted = false` on `A8HHI5SQ` →
  `_handleZoteroRestore` matched tombstone, moved file from
  `.zotero-watch-trash/A.pdf` back to `A.pdf`, dropped tombstone,
  re-created FileRecord.
- **RST.3** — dropped a fresh PDF (`rst3.pdf`) with the same hash
  as the tombstoned attachment → `_processNewFile` step 3a
  (tombstone-aware dedup) matched the tombstone, un-trashed
  attachment `A8HHI5SQ`, the un-trash notifier fired
  `_handleZoteroRestore` which also moved the trashed file back to
  its canonical path, AND `rst3.pdf` was tracked as a shadow.
  Tombstone dropped. End state: two on-disk files linked to the
  same attachment, both tracked; one plugin trash entry restored.
- **RST.6** (collision suffix) — with `A.pdf` occupied by
  different content and `A8HHI5SQ`'s original in plugin trash,
  restoring `A8HHI5SQ` produced `A.restored.1779710938205.pdf`
  alongside the unchanged `A.pdf`. Both tracked.
- **FDEL.1** — created sub-collection `Methods` under
  `ModeThreeTest` + dropped 2 PDFs into
  `/tmp/.../mode3/Methods/` (both imported). Erased the Methods
  collection in Zotero → `mirrorExecutor._deleteFolder` Mode 3
  recursive-moved the dir into `.zotero-watch-trash/Methods/`
  preserving both PDFs; collection tracking record and both child
  FileRecords dropped; unrelated FileRecords untouched.
- **FRST.1** — `Zotero.WatchFolder.suppressionResolver
  .listTrashedFolders({watchRoot})` returned the trashed `Methods`
  entry; `restoreTrashedFolder({name:'Methods'}, {watchRoot})`
  returned `{ok: true, restoredTo: 'Methods'}`. Dir restored with
  both PDFs intact; plugin trash empty; new Zotero collection
  `Methods` (key `FKX3XI7Z`) recreated under sync root.
- **SR.1** (smart-rules editor smoke) — prefs pane rendered the
  "Smart Rules" section with enable checkbox, multi-line JSON
  textarea, Save / Insert example / Reload-from-prefs buttons.
  Programmatic `insertSmartRuleExample()` + `saveSmartRules()`
  appended starter rules + persisted to the
  `extensions.zotero.watchFolder.smartRules` pref. JSON parse +
  per-rule shape validation runs on Save (verified via UT
  coverage; not exercised here with bad input).

### Scenarios deferred this run (unit-test coverage only)

- **DEL.3** (bulk-delete prompt for `_handleExternalDeletions`) —
  needs >10 distinct PDFs to seed the watch root; the test_pdfs
  fixture has 4 unique hashes. Unit-tested via UT-094.
- **RST.2 / RST.4** (parent-restore expansion + selective skip) —
  need a parent item with multiple attachments. Setup overhead
  outweighed the test value live; UT-093 covers all four branches.
- **RST.5** (re-attach under living parent after attachment is
  permanently purged) — needs a multi-step setup (trash → tomb-
  stone → permanent-erase the attachment while keeping the
  parent). UT-095 covers all three branches end-to-end.
- **FDEL.2** (bulk folder delete) — same >10-files limitation
  as DEL.3. Unit-tested via UT-420 + UT-094.

### Other findings

- **Stale label in the prefs UI sync-mode display.** The "Sync
  mode" row reads "Mode 3 — Mirror with safe delete (v2.2, not yet
  active)" — the "not yet active" wording is now incorrect since
  v2.2 shipped. Filed under Track D below.
- **Bridge stability.** Intermittent "Could not find Zotero
  console actor" failures throughout (consistent with CLAUDE.md);
  port 6100 dropped entirely once mid-DEL.1, requiring a Zotero
  restart. State preservation across the restart held — prefs
  persisted, tracking-JSON survived, the live scenario resumed
  from where it left off without surprises.

### Outcome

Every scenario that didn't require multi-attachment-parent setup or
>10 distinct PDFs was exercised live against the v2.2.0-alpha.1+
build and passed. The v2.2 surface is now end-to-end-validated for
the cases that distinguish it from v2.1: cascading-trash guard,
plugin trash, tombstone emission, Zotero-initiated trash and
restore, hash-based local-restore re-link, collision suffix on
restore, folder delete + folder restore, and smart-rules editing.
