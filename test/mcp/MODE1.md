# MODE1 runbook — v2.0 Mode 1 (import-only)

Verifies the v2.0 plugin against a live Zotero. Covers the import-only
surface that ships in v2.0: sync-root scoping, canonical-path resolution,
folder rename → collection rename, file-missing classification, and the
Mode 1 deletion gates (Zotero / disk deletes never propagate in Mode 1).

Total target: ~20 minutes hands-on (most cases are full-MCP after the
one-time setup).

Assumes Zotero is open, MCP Bridge installed, and an empty
`/tmp/ZoteroWatchTest/inbox` directory exists. The runbook creates a
fresh sync-root collection named `ModeOneTest` for isolation.

---

## Preflight

```
zotero_plugin_list                                              # confirm plugin loaded
zotero_search_prefs { query: "watchFolder" }                    # expect 28 keys (v2 schema)
zotero_get_pref { key: "extensions.zotero.watchFolder.mode" }   # expect "mode1"
```

Pass: 28 keys (was 31 in v1), mode is `mode1`. If a v1 install was
upgraded, also confirm `extensions.zotero.watchFolder.targetCollection`
is GONE (`zotero_get_pref` should return null/undefined for it).

---

## SETUP.1 — Create sync root + configure plugin

**Purpose:** Set `syncRootCollectionKey` to a fresh collection and confirm
`resolveSyncRoot()` returns it.
**MCP-automatable:** full

**Steps:**

```
# 1. Create a sync-root collection named ModeOneTest.
zotero_execute_js {
  code: `
    const lib = Zotero.Libraries.userLibraryID;
    const c = new Zotero.Collection();
    c.libraryID = lib;
    c.name = 'ModeOneTest';
    await c.saveTx();
    return { key: c.key, id: c.id, name: c.name, libraryID: lib };
  `
}
# capture the returned key as $SYNC_ROOT_KEY

# 2. Write the sync-root prefs.
zotero_set_pref { key: "extensions.zotero.watchFolder.syncRootCollectionKey", value: $SYNC_ROOT_KEY }
zotero_set_pref { key: "extensions.zotero.watchFolder.syncRootLibraryID", value: 1 }
zotero_set_pref { key: "extensions.zotero.watchFolder.sourcePath", value: "/tmp/ZoteroWatchTest/inbox" }
zotero_set_pref { key: "extensions.zotero.watchFolder.fileTypes", value: "pdf" }
zotero_set_pref { key: "extensions.zotero.watchFolder.mode", value: "mode1" }
zotero_set_pref { key: "extensions.zotero.watchFolder.enabled", value: true }

# 3. Reload the plugin so the new prefs take effect.
zotero_plugin_reload { pluginId: "watch-folder@zotero-plugin.org" }

# 4. Confirm resolveSyncRoot resolves to the expected collection.
zotero_execute_js {
  code: `
    // The service singleton is module-private, but canonicalPath is invokable
    // via the bundle's hooks if exposed. Otherwise verify via DB.
    const key = Zotero.Prefs.get('extensions.zotero.watchFolder.syncRootCollectionKey', true);
    const lib = Zotero.Prefs.get('extensions.zotero.watchFolder.syncRootLibraryID', true);
    const col = await Zotero.Collections.getByLibraryAndKeyAsync(lib, key);
    return { resolved: !!col, name: col?.name, key: col?.key };
  `
}
```

**Pass criteria:** `resolved: true`, `name: 'ModeOneTest'`.
**Cleanup:** none (state needed for ADD cases).

---

## ADD.1 — File at watch-folder root imports into sync root

**Purpose:** A PDF dropped directly under the watch folder lands as an
attachment under the sync-root collection (no subcollection).
**MCP-automatable:** partial (human places one PDF)

**Human prep:** copy `paper.pdf` into `/tmp/ZoteroWatchTest/inbox/`.
Wait `pollInterval + ~5s`.

**Steps:**

```
zotero_read_logs { filter: "WatchFolder", lines: 60 }
  # expect: 'Found 1 new file', 'Processing new file', 'Imported successfully'

zotero_db_query {
  sql: "SELECT i.itemID, i.key, c.name AS coll FROM items i JOIN collectionItems ci ON ci.itemID=i.itemID JOIN collections c ON c.collectionID=ci.collectionID WHERE c.name='ModeOneTest' ORDER BY i.itemID DESC LIMIT 5"
}
  # expect: ≥ 1 row with coll='ModeOneTest'
```

**Pass criteria:** new item exists, its collection is `ModeOneTest` (the
sync root itself — no subcollection auto-created).
**Cleanup:** leave file for DUP.1.

---

## ADD.2 — File in subfolder creates Zotero subcollection

**Purpose:** A PDF dropped in `inbox/Methods/` creates a `Methods`
subcollection under the sync root and imports there.
**MCP-automatable:** partial

**Human prep:** `mkdir -p /tmp/ZoteroWatchTest/inbox/Methods/` and copy
`method-paper.pdf` into it. Wait one poll cycle.

**Steps:**

```
zotero_read_logs { filter: "WatchFolder", lines: 80 }
  # expect: 'sync-root dir "Methods"', 'created subcollection "Methods"' (from canonicalPath)

zotero_db_query {
  sql: "SELECT c.key, c.collectionName AS name, p.collectionName AS parent FROM collections c LEFT JOIN collections p ON p.collectionID=c.parentCollectionID WHERE c.collectionName='Methods'"
}
  # expect: parent='ModeOneTest'

zotero_db_query {
  sql: "SELECT i.itemID, i.key FROM items i JOIN collectionItems ci ON ci.itemID=i.itemID JOIN collections c ON c.collectionID=ci.collectionID WHERE c.collectionName='Methods' ORDER BY i.itemID DESC LIMIT 5"
}
  # expect: the new attachment
```

**Pass criteria:** `Methods` subcollection exists with `ModeOneTest` as
parent; the new attachment is in `Methods`.

---

## ADD.3 — Empty subfolder is harmless

**Purpose:** An empty subfolder doesn't crash the scanner and doesn't
create a Zotero subcollection until a file is dropped.
**MCP-automatable:** full

**Steps:**

```bash
# Bash:
mkdir /tmp/ZoteroWatchTest/inbox/Empty
```

```
zotero_read_logs { filter: "WatchFolder", lines: 40 }
  # expect: scan ran, no errors

zotero_db_query {
  sql: "SELECT COUNT(*) AS n FROM collections WHERE collectionName='Empty'"
}
  # expect: n=0
```

**Pass criteria:** no error, no `Empty` collection created yet.
**Cleanup:** `rmdir /tmp/ZoteroWatchTest/inbox/Empty`.

---

## DUP.1 — Hash-match dedup (no re-import)

**Purpose:** Same content under a different filename is deduped via the
v2 hash-first priority (B3 promotion).
**MCP-automatable:** partial

**Human prep:** `cp /tmp/ZoteroWatchTest/inbox/paper.pdf /tmp/ZoteroWatchTest/inbox/paper-copy.pdf`.

**Steps:**

```
zotero_read_logs { filter: "WatchFolder", lines: 60 }
  # expect: 'already tracked by hash' OR 'Duplicate detected (Content hash match)'

zotero_db_query {
  sql: "SELECT COUNT(*) AS n FROM items WHERE dateAdded > datetime('now','-1 minute')"
}
  # expect: n=0 (no new item from the duplicate)
```

**Pass criteria:** no new item; log mentions hash match.
**Cleanup:** `rm /tmp/ZoteroWatchTest/inbox/paper-copy.pdf`.

---

## RENAME.1 — Folder rename → Zotero collection rename (B2)

**Purpose:** Renaming `Methods/` → `Procedures/` on disk renames the
existing Zotero collection in place (same key, new name) AND updates
descendant tracking records so per-file move detection no-ops.
**MCP-automatable:** partial

**Human prep:** `mv /tmp/ZoteroWatchTest/inbox/Methods /tmp/ZoteroWatchTest/inbox/Procedures`.
Wait one poll cycle.

**Steps:**

```
zotero_read_logs { filter: "WatchFolder", lines: 80 }
  # expect: 'Folder rename detected: Methods → Procedures'

zotero_db_query {
  sql: "SELECT c.key, c.collectionName AS name FROM collections c WHERE c.collectionName IN ('Methods','Procedures')"
}
  # expect: ONE row, name='Procedures', with the SAME key seen in ADD.2

zotero_db_query {
  sql: "SELECT i.itemID FROM items i JOIN collectionItems ci ON ci.itemID=i.itemID JOIN collections c ON c.collectionID=ci.collectionID WHERE c.collectionName='Procedures'"
}
  # expect: same item count as before — file membership preserved by the rename
```

**Pass criteria:** Zotero shows the renamed collection holding the same
items. No empty `Methods` collection left behind. No new `Procedures`
collection was created from scratch.
**Cleanup:** leave for LD.1.

---

## LD.1 — Mode 1 refuses to propagate local deletion

**Purpose:** Deleting a tracked PDF from disk does NOT trash its Zotero
attachment in Mode 1; the tracking record is just marked `state=missing`.
**MCP-automatable:** partial

**Human prep:** `rm /tmp/ZoteroWatchTest/inbox/Procedures/method-paper.pdf`.
Wait one poll cycle.

**Steps:**

```
zotero_read_logs { filter: "WatchFolder", lines: 80 }
  # expect: 'Mode 1: …missing from disk — marked, not trashed'
  # MUST NOT see: 'auto-bin', 'Detected … externally-deleted', 'item.deleted=true'

zotero_db_query {
  sql: "SELECT i.itemID, i.key, i.deleted FROM items i WHERE i.itemID IN (SELECT itemID FROM collectionItems WHERE collectionID IN (SELECT collectionID FROM collections WHERE collectionName='Procedures'))"
}
  # expect: i.deleted=0 for the item that was missing on disk

# Inspect the v2 tracking store to confirm state=missing
zotero_execute_js {
  code: `
    const f = PathUtils.join(Zotero.DataDirectory.dir, 'zotero-watch-folder-tracking-v2.json');
    const data = await IOUtils.readJSON(f);
    return data.files
      .filter(r => r.localPath.includes('method-paper'))
      .map(r => ({ path: r.localPath, state: r.state }));
  `
}
  # expect: at least one record, all with state='missing'
```

**Pass criteria:** Zotero item still alive (`deleted=0`), tracking state
flipped to `missing`.

---

## ZA.1 — Mode 1 refuses to propagate Zotero trash

**Purpose:** Right-click → Move to Bin on the attachment in Zotero does
NOT delete the on-disk source file in Mode 1.
**MCP-automatable:** partial (human right-clicks)

**Human prep:** drop a fresh `za-paper.pdf` into `/tmp/ZoteroWatchTest/inbox/`,
wait for import. Then in Zotero: right-click the imported attachment →
Move to Bin → confirm.

**Steps:**

```
zotero_read_logs { filter: "WatchFolder", lines: 60 }
  # expect: 'Mode 1: ignoring trash event for items …'
  # MUST NOT see: '_promptDiskDelete', 'moveToTrash', 'IOUtils.remove'

# Disk file still there:
zotero_execute_js {
  code: `return await IOUtils.exists('/tmp/ZoteroWatchTest/inbox/za-paper.pdf');`
}
  # expect: true
```

**Pass criteria:** Mode-1-gate log line emitted, disk file still exists.

---

## FM.1 — File-missing classifier: drive disconnected → state=paused

**Purpose:** When the watch root becomes unreachable mid-session, the
external-deletion scan short-circuits and marks every tracked file as
`paused` instead of mass-flagging them all `missing`.
**MCP-automatable:** full (simulate via permission change)

**Steps:**

```bash
# Bash — make the watch root unstat-able:
chmod 000 /tmp/ZoteroWatchTest/inbox
```

```
# Wait one poll cycle, then:
zotero_read_logs { filter: "WatchFolder", lines: 60 }
  # expect: 'Watch root unavailable — pausing external-deletion scan'

zotero_execute_js {
  code: `
    const f = PathUtils.join(Zotero.DataDirectory.dir, 'zotero-watch-folder-tracking-v2.json');
    const data = await IOUtils.readJSON(f);
    const states = data.files.map(r => r.state);
    return {
      total: states.length,
      paused: states.filter(s => s === 'paused').length,
      missing: states.filter(s => s === 'missing').length,
    };
  `
}
  # expect: paused === total (all flipped to paused), missing === 0
```

**Cleanup:** `chmod 755 /tmp/ZoteroWatchTest/inbox` and wait one poll
cycle. Records should flow back to `clean` on the next scan when files
are seen on disk again.

**Pass criteria:** every tracked file flipped to `paused`, no `missing`
state pollution.

---

## End-of-runbook cleanup

```
zotero_set_pref { key: "extensions.zotero.watchFolder.enabled", value: false }
zotero_set_pref { key: "extensions.zotero.watchFolder.syncRootCollectionKey", value: "" }

# Remove ModeOneTest collection AND its subcollections:
zotero_execute_js {
  code: `
    const lib = Zotero.Libraries.userLibraryID;
    const all = Zotero.Collections.getByLibrary(lib);
    const toTrash = all.filter(c => c.name === 'ModeOneTest' || (c.parentID && all.find(p => p.id === c.parentID && p.name === 'ModeOneTest')));
    for (const c of toTrash) { c.deleted = true; await c.saveTx(); }
    return { trashed: toTrash.length };
  `
}
```

```bash
rm -rf /tmp/ZoteroWatchTest/inbox/*
```

---

## Cases deferred to v2.1 / v2.2

These come back to MCP runbooks once their behaviour ships:

- **ZP.1, CS.1** — Mode 1 already ignores parent-item and collection
  deletions (covered by the universal Mode-1 trash gate). The matrix
  rows that require non-no-op responses are Mode 2 / Mode 3 territory.
- **EF.1 mirror direction** — create empty Zotero subcollection → local
  folder. Mode 2 (v2.1) behaviour; no-op in Mode 1.
- **B.6 / B.7 first-run baseline** — depends on the C1 setup wizard
  landing first.
- **The 3-button trash dialog** (S.4 in SMOKE.md) — Mode 1 doesn't fire
  it; SMOKE.md S.4 is now stubbed pending v2.1.
