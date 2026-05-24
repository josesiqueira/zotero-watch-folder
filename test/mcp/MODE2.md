# MODE2 runbook — v2.1 Mode 2 (mirror without delete)

Verifies the v2.1 plugin against a live Zotero. Covers the Mode 2
surface added in v2.1: the install-time baseline (B.2 copy, B.6 mkdir,
B.7 hash-reconcile), adopt-into-scope on collection moves, late-attached
PDFs, collection rename → folder rename, item-membership →
moveItem, the suppression UX, the warning sink, and the conflict gate.

Mode 2 is **warn-only** on deletion — disk and Zotero deletes do not
propagate. Mode 3 (safe-delete) is reserved for v2.2 and is intentionally
out of scope here.

Total target: ~40 minutes hands-on (more cases than MODE1; baseline +
adopt scenarios each need a populated Zotero subtree).

Assumes Zotero is open, MCP Bridge installed, an empty
`/tmp/ZoteroWatchTest/inbox2` directory exists, and at least one
attachment is available in Zotero's storage that we can use for the
baseline tests. The runbook creates a fresh sync-root collection named
`ModeTwoTest` for isolation.

---

## Preflight

```
zotero_plugin_list                                              # confirm plugin loaded
zotero_search_prefs { query: "watchFolder" }                    # expect 29 keys (v2.1 schema — added baselineCompletedForRoot)
zotero_get_pref { key: "extensions.zotero.watchFolder.mode" }   # may be mode1 — will switch in SETUP.M2.1
zotero_execute_js {
  code: `
    return {
      hasHooks: typeof Zotero.WatchFolder?.hooks,
      hasWarningSink: typeof Zotero.WatchFolder?.warningSink,
      hasSuppressionResolver: typeof Zotero.WatchFolder?.suppressionResolver,
      hasBaseline: typeof Zotero.WatchFolder?.baseline,
      hasWizard: typeof Zotero.WatchFolder?.runSetupWizard,
    };
  `
}
```

Pass: 29 keys; all `has*` values are 'object' (for namespaces) or 'function' (for runSetupWizard). If any is 'undefined', the v2.1 bundle didn't land — rebuild + reload.

---

## SETUP.M2.1 — Sync root + Mode 2

**Purpose:** Create a fresh sync-root collection and switch to Mode 2.
**MCP-automatable:** full

```
# 1. Create the sync-root collection.
zotero_execute_js {
  code: `
    const lib = Zotero.Libraries.userLibraryID;
    const c = new Zotero.Collection();
    c.libraryID = lib;
    c.name = 'ModeTwoTest';
    await c.saveTx();
    return { key: c.key, id: c.id };
  `
}
# capture key as $SYNC_ROOT_KEY

# 2. Configure prefs. NOTE: clear baselineCompletedForRoot so the
# baseline runs against this fresh root on next coordinator start.
zotero_set_pref { key: "extensions.zotero.watchFolder.syncRootCollectionKey", value: $SYNC_ROOT_KEY }
zotero_set_pref { key: "extensions.zotero.watchFolder.syncRootLibraryID", value: 1 }
zotero_set_pref { key: "extensions.zotero.watchFolder.sourcePath", value: "/tmp/ZoteroWatchTest/inbox2" }
zotero_set_pref { key: "extensions.zotero.watchFolder.mode", value: "mode2" }
zotero_set_pref { key: "extensions.zotero.watchFolder.baselineCompletedForRoot", value: "" }
zotero_set_pref { key: "extensions.zotero.watchFolder.enabled", value: true }
zotero_plugin_reload { pluginId: "watch-folder@zotero-plugin.org" }

# 3. Confirm the coordinator started.
zotero_read_logs { filter: "SyncCoordinator: started in mode2", lines: 5 }
```

**Pass criteria:** log shows `SyncCoordinator: started in mode2`.
**Cleanup:** none.

---

## BASE.1 — B.6 mkdir empty Zotero subcollection on first run

**Purpose:** Baseline creates a local folder for an empty Zotero subcollection.
**MCP-automatable:** full

```
# 1. Add an empty subcollection to the sync root BEFORE baseline runs.
zotero_execute_js {
  code: `
    const root = Zotero.Collections.getByLibraryAndKey(1, '$SYNC_ROOT_KEY');
    const sub = new Zotero.Collection();
    sub.libraryID = 1;
    sub.name = 'EmptySub';
    sub.parentID = root.id;
    await sub.saveTx();
    return { key: sub.key };
  `
}

# 2. Clear baseline + reload to force a fresh baseline run.
zotero_set_pref { key: "extensions.zotero.watchFolder.baselineCompletedForRoot", value: "" }
zotero_plugin_reload { pluginId: "watch-folder@zotero-plugin.org" }

# 3. Verify the directory exists on disk.
Bash: ls /tmp/ZoteroWatchTest/inbox2/EmptySub
```

**Pass criteria:** `EmptySub/` directory exists on disk. Tracking has a collection record.
**Verify tracking:**
```
zotero_execute_js {
  code: `
    const dir = Zotero.DataDirectory.dir;
    const path = PathUtils.join(dir, 'zotero-watch-folder-tracking-v2.json');
    const data = await IOUtils.readJSON(path);
    return data.collections.filter(c => c.localPath === 'EmptySub');
  `
}
```
Expected: 1 record with `state: 'clean'`.
**Cleanup:** none — used by BASE.2.

---

## BASE.2 — B.2 copy Zotero attachment to canonical local path

**Purpose:** Baseline copies an existing Zotero attachment to disk.
**MCP-automatable:** partial (requires a Zotero attachment with a file in storage)

```
# 1. Find or create an attachment under the sync root.
# (Easiest: drag a PDF onto ModeTwoTest in Zotero. Then ask MCP for the key.)
zotero_execute_js {
  code: `
    const root = Zotero.Collections.getByLibraryAndKey(1, '$SYNC_ROOT_KEY');
    const itemIDs = root.getChildItems(false, false).map(i => i.id);
    const items = [];
    for (const id of itemIDs) {
      const it = Zotero.Items.get(id);
      if (!it) continue;
      if (it.isAttachment && it.isAttachment()) {
        items.push({ key: it.key, name: it.attachmentFilename });
      } else {
        const attIDs = it.getAttachments() || [];
        for (const aid of attIDs) {
          const a = Zotero.Items.get(aid);
          if (a) items.push({ key: a.key, name: a.attachmentFilename, parent: it.key });
        }
      }
    }
    return items;
  `
}

# 2. Force a fresh baseline.
zotero_set_pref { key: "extensions.zotero.watchFolder.baselineCompletedForRoot", value: "" }
zotero_plugin_reload { pluginId: "watch-folder@zotero-plugin.org" }
zotero_read_logs { filter: "baseline: complete", lines: 5 }

# 3. Verify the file landed on disk + has a tracking record.
Bash: ls -la /tmp/ZoteroWatchTest/inbox2/
zotero_execute_js {
  code: `
    const path = PathUtils.join(Zotero.DataDirectory.dir, 'zotero-watch-folder-tracking-v2.json');
    const data = await IOUtils.readJSON(path);
    return data.files;
  `
}
```

**Pass criteria:** log shows `baseline: complete (copies=N mkdirs=M …)` with non-zero copies. The attachment filename appears in `inbox2/` (or a subcollection dir if it lives in one). Tracking has a file record with `lastSyncedHash` set.
**Cleanup:** none — used by BASE.3.

---

## BASE.3 — B.7 hash reconcile (don't double-copy)

**Purpose:** A disk file with the same content as a Zotero attachment, at a non-canonical path, is adopted (not duplicated).
**MCP-automatable:** partial

```
# 1. Pick an attachment from BASE.2's list. Read its Zotero-storage path.
zotero_execute_js {
  code: `
    const att = await Zotero.Items.getByLibraryAndKeyAsync(1, '$ATT_KEY');
    return { path: await att.getFilePathAsync(), name: att.attachmentFilename };
  `
}
# capture path as $STORAGE_PATH

# 2. Copy the file to a NON-canonical location under the watch folder.
Bash: mkdir -p /tmp/ZoteroWatchTest/inbox2/elsewhere && cp $STORAGE_PATH /tmp/ZoteroWatchTest/inbox2/elsewhere/copy.pdf

# 3. Delete the canonical location if it exists (so adoption is the only path).
Bash: rm -f /tmp/ZoteroWatchTest/inbox2/<canonical-name.pdf>

# 4. Clear baseline + tracking + reload.
zotero_set_pref { key: "extensions.zotero.watchFolder.baselineCompletedForRoot", value: "" }
zotero_execute_js {
  code: `
    const path = PathUtils.join(Zotero.DataDirectory.dir, 'zotero-watch-folder-tracking-v2.json');
    await IOUtils.remove(path, { ignoreAbsent: true });
    return 'cleared';
  `
}
zotero_plugin_reload { pluginId: "watch-folder@zotero-plugin.org" }
zotero_read_logs { filter: "baseline B.7", lines: 10 }
```

**Pass criteria:** log shows `baseline B.7: linked <ATT_KEY> → existing disk file elsewhere/copy.pdf`. Tracking record's localPath = `elsewhere/copy.pdf` (NOT the canonical path).
**Cleanup:** revert the elsewhere/ dir; clear tracking; re-baseline cleanly before next case.

---

## ADOPT.1 — Drag populated collection into sync root

**Purpose:** collectionWatcher detects a collection moved into the sync root and runs `adoptCollectionSubtree` so the existing attachments get copied to disk.
**MCP-automatable:** partial

```
# 1. Create a collection OUTSIDE the sync root with one attachment.
zotero_execute_js {
  code: `
    const lib = Zotero.Libraries.userLibraryID;
    const ext = new Zotero.Collection();
    ext.libraryID = lib;
    ext.name = 'External';
    await ext.saveTx();
    return { key: ext.key, id: ext.id };
  `
}
# Manually drag an attachment INTO 'External' via Zotero UI.

# 2. Reparent 'External' under the sync root.
zotero_execute_js {
  code: `
    const ext = await Zotero.Collections.getByLibraryAndKeyAsync(1, '$EXT_KEY');
    const root = await Zotero.Collections.getByLibraryAndKeyAsync(1, '$SYNC_ROOT_KEY');
    ext.parentID = root.id;
    await ext.saveTx();
    return 'reparented';
  `
}

# 3. Verify the disk side caught up.
zotero_read_logs { filter: "adopted .* into scope", lines: 5 }
Bash: ls -la /tmp/ZoteroWatchTest/inbox2/External/
```

**Pass criteria:** log shows `collectionWatcher: adopted <EXT_KEY> into scope (copies=N mkdirs=M errors=0)`. `External/` folder exists with the attachment file inside.
**Cleanup:** unparent the External collection.

---

## LATE.1 — Late-attached PDF gets copied

**Purpose:** Attaching a PDF to a parent already in the sync root triggers `itemAddHandler` to copy the file.
**MCP-automatable:** partial

```
# 1. Create a parent item in the sync root with no attachment yet.
zotero_execute_js {
  code: `
    const root = await Zotero.Collections.getByLibraryAndKeyAsync(1, '$SYNC_ROOT_KEY');
    const item = new Zotero.Item('journalArticle');
    item.libraryID = 1;
    item.setField('title', 'LateAttach Test');
    item.addToCollection(root.id);
    await item.saveTx();
    return { key: item.key, id: item.id };
  `
}

# 2. Manually attach a PDF to that item via Zotero UI (right-click → Add Attachment → Attach Stored Copy of File).

# 3. Verify the copy happened.
zotero_read_logs { filter: "itemAddHandler: copied late-attached", lines: 5 }
Bash: ls -la /tmp/ZoteroWatchTest/inbox2/
```

**Pass criteria:** log shows `itemAddHandler: copied late-attached <ATT_KEY>`. The PDF appears on disk under the sync root.
**Cleanup:** delete the test item.

---

## REN.1 — Rename Zotero subcollection → rename disk folder

**Purpose:** A Zotero subcollection rename fires `modify`, collectionWatcher emits `moveFolder`, mirrorExecutor renames the dir + rewrites child file localPaths.
**MCP-automatable:** full

```
# 1. Rename an existing tracked subcollection (e.g. EmptySub from BASE.1).
zotero_execute_js {
  code: `
    const col = await Zotero.Collections.getByLibraryAndKeyAsync(1, '$SUB_KEY');
    col.name = 'RenamedSub';
    await col.saveTx();
    return 'renamed';
  `
}

# 2. Verify disk + tracking.
Bash: ls /tmp/ZoteroWatchTest/inbox2/
zotero_read_logs { filter: "moveFolder", lines: 5 }
```

**Pass criteria:** `RenamedSub/` exists on disk, `EmptySub/` does not. Tracking's collection record `localPath` is `RenamedSub`. All child FileRecords (if any) have rewritten paths.
**Cleanup:** rename back, or delete the collection.

---

## MEM.1 — Item-membership change → moveItem on canonical change

**Purpose:** When a tracked item gains a new collection that becomes its canonical, the file moves to the new canonical path.
**MCP-automatable:** partial

```
# 1. Confirm the test item's current canonical (from BASE.2 or fresh import).
zotero_execute_js {
  code: `
    const path = PathUtils.join(Zotero.DataDirectory.dir, 'zotero-watch-folder-tracking-v2.json');
    const data = await IOUtils.readJSON(path);
    return data.files.filter(f => f.zoteroAttachmentKey === '$ATT_KEY');
  `
}

# 2. Add the parent item to a NEW collection that yields a shorter
# canonical path (rule 4 in chooseCanonicalCollection).
zotero_execute_js {
  code: `
    const att = await Zotero.Items.getByLibraryAndKeyAsync(1, '$ATT_KEY');
    const parent = att.parentItemID ? Zotero.Items.get(att.parentItemID) : att;
    const newCol = await Zotero.Collections.getByLibraryAndKeyAsync(1, '$NEW_COL_KEY');
    parent.addToCollection(newCol.id);
    await parent.saveTx();
    return 'added';
  `
}

# 3. Verify moveItem fired + file moved on disk.
zotero_read_logs { filter: "moveItem", lines: 5 }
Bash: ls -la /tmp/ZoteroWatchTest/inbox2/
```

**Pass criteria:** log shows `mirrorExecutor: moveItem <old> → <new> ok`. The file is at the new canonical path; the old path no longer exists.
**Cleanup:** restore original membership.

---

## SUPP.1 — Suppression on last-membership-removed

**Purpose:** Removing an item from its last sync-root collection flips state to OUT_OF_SCOPE_SUPPRESSED, emits a SUPPRESSED warning, and surfaces in the prefs UI.
**MCP-automatable:** partial (verification via DB + log + prefs visual check)

```
# 1. Remove the test item from its only sync-root collection.
zotero_execute_js {
  code: `
    const att = await Zotero.Items.getByLibraryAndKeyAsync(1, '$ATT_KEY');
    const parent = att.parentItemID ? Zotero.Items.get(att.parentItemID) : att;
    const col = await Zotero.Collections.getByLibraryAndKeyAsync(1, '$ROOT_OR_SUB');
    parent.removeFromCollection(col.id);
    await parent.saveTx();
    return 'removed';
  `
}

# 2. Verify state + warning.
zotero_execute_js {
  code: `
    const path = PathUtils.join(Zotero.DataDirectory.dir, 'zotero-watch-folder-tracking-v2.json');
    const data = await IOUtils.readJSON(path);
    return data.files.filter(f => f.zoteroAttachmentKey === '$ATT_KEY');
  `
}
zotero_execute_js {
  code: `
    return {
      total: Zotero.WatchFolder.warningSink.getTotalCount(),
      categories: Object.fromEntries(Zotero.WatchFolder.warningSink.getCountsByCategory()),
      recent: Zotero.WatchFolder.warningSink.getRecent(3),
    };
  `
}
```

**Pass criteria:**
  - FileRecord `state: 'out-of-scope-suppressed'`, `canonicalCollectionKey: null`.
  - warningSink shows `suppressed: 1` in categories; recent[N] has category=suppressed, attachmentKey=$ATT_KEY.
  - Open Zotero prefs → Watch Folder: "Suppressed items: 1" row visible.

**Resolution flow check (manual):**
  - Click "Resolve…" → confirm the 5-option prompt fires (Re-add / Keep / Trash / Move outside / Skip).
  - Pick "Re-add" → log shows resolution applied; tracking state flips back to `clean`.

**Cleanup:** state should be back to clean after the Re-add resolution.

---

## CONF.1 — Conflict gate refuses moveItem on hash drift

**Purpose:** When a tracked file's bytes differ from `lastSyncedHash`, mirrorExecutor refuses moves and flips state to CONFLICT_BLOCKED.
**MCP-automatable:** full

```
# 1. Pick an existing tracked file. Note its hash.
zotero_execute_js {
  code: `
    const path = PathUtils.join(Zotero.DataDirectory.dir, 'zotero-watch-folder-tracking-v2.json');
    const data = await IOUtils.readJSON(path);
    return data.files.map(f => ({ p: f.localPath, h: f.lastSyncedHash }));
  `
}

# 2. Modify the file on disk (edit-in-place or overwrite).
Bash: echo "drift" >> /tmp/ZoteroWatchTest/inbox2/<file.pdf>

# 3. Trigger a moveItem by reorganizing the parent item's collections
#    so canonical recomputes.
zotero_execute_js {
  code: `
    const att = await Zotero.Items.getByLibraryAndKeyAsync(1, '$ATT_KEY');
    const parent = att.parentItemID ? Zotero.Items.get(att.parentItemID) : att;
    const newCol = await Zotero.Collections.getByLibraryAndKeyAsync(1, '$OTHER_KEY');
    parent.addToCollection(newCol.id);
    await parent.saveTx();
    return 'added';
  `
}

# 4. Verify the gate fired.
zotero_read_logs { filter: "moveItem blocked: hash-drifted", lines: 5 }
zotero_execute_js {
  code: `
    const path = PathUtils.join(Zotero.DataDirectory.dir, 'zotero-watch-folder-tracking-v2.json');
    const data = await IOUtils.readJSON(path);
    return data.files.filter(f => f.zoteroAttachmentKey === '$ATT_KEY');
  `
}
```

**Pass criteria:**
  - log shows `moveItem blocked: hash-drifted` and a CONFLICT_BLOCKED warningSink entry.
  - tracking record's `state: 'conflict-blocked'`.
  - Open prefs → "Conflict-blocked: 1" row visible (Phase B8 surface).
**Cleanup:** restore the file (overwrite back to original bytes from Zotero storage) or accept the conflict marker.

---

## WARN.1 — Warning sink + prefs UI

**Purpose:** The prefs pane surfaces the warning ring buffer and per-category counts.
**MCP-automatable:** partial (UI verification needed)

```
# 1. Force a warning (e.g., trigger CONF.1 above to seed a CONFLICT_BLOCKED).
# 2. Verify counts via the bundle.
zotero_execute_js {
  code: `
    return {
      total: Zotero.WatchFolder.warningSink.getTotalCount(),
      cats: Object.fromEntries(Zotero.WatchFolder.warningSink.getCountsByCategory()),
    };
  `
}

# 3. Open Zotero prefs → Watch Folder.
# Expected UI rows (in order):
#   - Sync warnings: N  [View] [Clear]
#   - Suppressed items: M (+K folders) [Resolve…]
#   - Conflict-blocked: P
# All three rows should be HIDDEN when their respective counts are 0.

# 4. Click "View" → confirm an alert lists recent entries with [category]
#    timestamp + path/key + message lines, and a "Total / per-category"
#    summary header.

# 5. Click "Clear" → counts reset, View now says "No sync warnings recorded".
```

**Pass criteria:** all three rows appear/hide per count. View dialog formats correctly. Clear resets state.

---

## Teardown

```
# Drop all test prefs.
zotero_set_pref { key: "extensions.zotero.watchFolder.enabled", value: false }
zotero_set_pref { key: "extensions.zotero.watchFolder.mode", value: "mode1" }
zotero_set_pref { key: "extensions.zotero.watchFolder.syncRootCollectionKey", value: "" }
zotero_set_pref { key: "extensions.zotero.watchFolder.baselineCompletedForRoot", value: "" }

# Optionally clear tracking + reload.
zotero_execute_js {
  code: `
    const path = PathUtils.join(Zotero.DataDirectory.dir, 'zotero-watch-folder-tracking-v2.json');
    await IOUtils.remove(path, { ignoreAbsent: true });
    return 'cleared';
  `
}
zotero_plugin_reload { pluginId: "watch-folder@zotero-plugin.org" }

# Optionally trash the ModeTwoTest collection.
zotero_execute_js {
  code: `
    const c = await Zotero.Collections.getByLibraryAndKeyAsync(1, '$SYNC_ROOT_KEY');
    if (c) { c.deleted = true; await c.saveTx(); }
    return 'trashed';
  `
}

# Wipe the disk test tree.
Bash: rm -rf /tmp/ZoteroWatchTest/inbox2
```

---

## Pass / fail summary table

| Case | Status | Notes |
|---|---|---|
| Preflight | ✅ | 37 keys (29 v2.1 + 8 v1 stragglers — `bidirectionalSync`, `collectionSyncEnabled`, `conflictResolution`, `lastWatchedPath`, `mirrorPath`, `mirrorPollInterval`, `mirrorRootCollection`, `targetCollection`). All v2.1 exports present (warningSink, suppressionResolver, baseline, runSetupWizard). |
| SETUP.M2.1 | ✅ | ModeTwoTest collection key `H79DCAVM`. **MCP gotcha:** bare `await c.saveTx()` in the IIFE wrapper succeeded but returned undefined and didn't persist. Workaround: wrap in `Zotero.DB.executeTransaction(async () => { await c.save(); })`. |
| BASE.1 (B.6 mkdir) | ✅ | `EmptySub/` created on disk; tracking record `state=clean`, path=`EmptySub` (sync-root-relative). |
| BASE.2 (B.2 copy) | ⚠️ | File copied (3.4 MB), full-file hash computed, attachment + memberships + canonical correct. **Bug surfaced:** `watchFolder._processNewFile`'s dedup-skip path overwrote baseline's relative-path FileRecord with an absolute-path one. Idempotent `_absPath` (commit `68964a3`) defuses the downstream cascade but the underlying schema drift remains (task #25 deferred). |
| BASE.3 (B.7 reconcile) | ❌ | Placed `/watch/Misplaced/relocated.pdf` (same hash as JIM735WQ attachment). Reset baseline + reload. Expected: B.7 adopts existing disk file. Actual: scan loop ran BEFORE baseline, processed `relocated.pdf` via dedup-skip path, called `relativePathToCollection('Misplaced', createIfMissing=true)` → CREATED a Zotero subcollection `Misplaced` under the sync root. Then baseline picked Misplaced as canonical for JIM735WQ, copied from Zotero storage to `/watch/Misplaced/Carlini.pdf` → ended up with TWO copies on disk. Tracks bugs #30 (scan races baseline) + #31 (scan loop's createIfMissing not Mode-2-gated). |
| ADOPT.1 | ✅ | Created `ExternalSub2` outside sync root, added parent 372, then reparented under root. Adopt-into-scope fired: `ExternalSub2/` created on disk + Díaz-Rodríguez PDF (2.5 MB) copied from Zotero storage + FileRecord inserted with correct attachment key (HMWS5URD) and canonical (IHPVWL2H). Trashed parents are correctly skipped (first attempt with parent 373 was in Zotero Trash; adopt saw 0 attachments and exited cleanly). |
| LATE.1 | ✅ | Created parent item (key UYDJIHVD) in sync root with no attachment. Attached `/tmp/late-test.pdf` via Zotero.Attachments.importFromFile. itemAddHandler fired: file copied to `/watch/late-test.pdf` + FileRecord inserted with correct attachment key (5R7CYVLE), canonical=H79DCAVM, state=clean. |
| REN.1 | ✅ | `EmptySub/` → `RenamedSub/` on disk; tracking record `localPath` updated. Full notifier → moveFolder → executor pipeline works. |
| MEM.1 | ❌ | Attempted: removed parent 358 from ModeTwoTest, added to RenamedSub. Handler couldn't find the attachment's tracking record because the scan loop's Extra-field dedup path (bug #29) had stored the PARENT's key (E8EQ8SBC) in `zoteroAttachmentKey` instead of the actual attachment's key (5H2RK95E). All downstream events for the real attachment silently no-op. Re-test after fix #29. |
| SUPP.1 | ✅ (after fix) | First run: ❌ state stayed `clean` because remaining `Inbox` (outside sync root) membership wasn't filtered out. Fix in commit `68964a3` (`_removeItemMembership` now filters by `collectionKeyToRelativePath !== null`). Second run: state correctly flipped to `out-of-scope-suppressed`, canonical cleared, Inbox kept in membership list, SUPPRESSED warning with `last-sync-root-membership-removed`. |
| CONF.1 | ✅ (after fix) | First run: ❌ warning was `missing-file` instead of `hash-drifted` because absolute `oldCanonicalPath` was double-joined with watchRoot. Fix in commit `68964a3` (idempotent `_absPath` returns absolute input unchanged). Second run: `conflict-blocked` / `hash-drifted` warning fires correctly; FileRecord state flips to `conflict-blocked`. |
| WARN.1 | ⚠️ | Partial — warning sink confirmed live via API (`getTotalCount`, `getRecent`, `getCountsByCategory`, `clear`); prefs UI rows not visually verified in this run. |

### Bugs discovered + fixed during this run
- **`_absPath` not idempotent** (mirrorExecutor + baseline + folderEventDetector + suppressionResolver) — fixed in `68964a3`.
- **`_removeItemMembership` ignored sync-root scope** when counting remaining memberships — fixed in `68964a3` (+ UT-415 ×2).

### Bugs discovered + deferred (tracked separately)
- **Task #25** — schema drift in `watchFolder._processNewFile`. Scan loop writes absolute paths to `FileRecord.localPath`/`canonicalLocalPath`. Defensive idempotent `_absPath` makes it non-blocking for v2.1 but the real migration is owed.
- **Task #29** — Extra-field dedup in `_processNewFile` stores PARENT's key as `zoteroAttachmentKey` (the matched Zotero item is the parent, not the attachment). Downstream handlers can't find records → events silently no-op. Blocked MEM.1 + obscured BASE.2's full record provenance.
- **Task #30** — scan loop races baseline. First scan after startup runs before `syncCoordinator.start()` → processes disk files via Mode-1 import flow → creates Zotero sub-collections + records. Then baseline computes a different canonical and copies anyway → double-copy. Surfaced via BASE.3.
- **Task #31** — `relativePathToCollection(rel, { createIfMissing: true })` in the scan loop is not Mode-2-aware. In Mode 2 the disk→Zotero direction should route via MirrorActions, not direct collection creation. Surfaced via BASE.3 (an arbitrary disk subfolder name became a Zotero subcollection without user intent).

### MCP bridge notes
- `Zotero.DB.executeTransaction(async () => { await x.save(); })` is the reliable save pattern; bare `await x.saveTx()` silently returns undefined and may not persist in some IIFE contexts.
- `Zotero.Collection.parentID` is read-only (`_parentID` / `_parentKey` private setters). Use `coll.parentKey = '<key>'` then `await coll.save()` inside an executeTransaction.
- `JSON.stringify` of objects with multiple nested property accesses sometimes returns `undefined` through the bridge — split into smaller queries or build a flat object first.

Update this table inline as cases are run. Any ❌ should reference the
relevant log lines / DB queries so a follow-up can diagnose without
re-running the whole suite.
