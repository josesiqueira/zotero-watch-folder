# Smoke runbooks — S.1 to S.7

> **v2 status note (2026-05-23):** these were authored against v1.2.3.
> Several cases reference removed code or v1-only behaviour:
>
> - **S.1** key-count check expects 31 prefs; v2 has 28. Update assertion to 28 before re-running. Also expects `targetCollection` — that key is gone, replaced by `syncRootCollectionKey`.
> - **S.4** first-run prompt — v2's first-run flow is replaced by the Phase C1 setup wizard (pending) + the C2 sync-root picker in prefs. The v1 `Import All / Skip / Cancel` dialog no longer exists. Stub this case until the wizard ships.
> - **S.5** 3-button trash dialog — Mode 1 never fires it (gated off). Defer to v2.1's MODE2.md.
> - **S.6** auto-bin popup on external delete — Mode 1 never fires it; behaviour is "mark record state=missing, no Zotero side effect". Verified by MODE1.md LD.1.
>
> v2.0 verification flow: run **MODE1.md** end-to-end. Re-pass S.1/S.2/S.3/S.7 against v2 once their assertions are updated.

Run all seven before tagging a release. Total target: ~10 minutes hands-on. Assumes Zotero is open, MCP Bridge installed, and a `TestImports` collection exists.

---

## S.1 — Settings render and save

**Purpose:** Pref pane renders, values persist, plugin starts watching.
**MCP-automatable:** partial (user opens the pref pane and types values)

**Human prep:** `Edit → Settings → Watch Folder`. Set Source = `/tmp/ZoteroWatchTest/inbox`, Target Collection = `TestImports`, File Types = `pdf`, tick Enable, OK.

**Steps:**
1. `zotero_plugin_list` — confirm Watch Folder is loaded at the expected version.
2. `zotero_search_prefs { query: "watchFolder" }` — expect all 31 keys present.
3. `zotero_get_pref { key: "extensions.zotero.watchFolder.enabled" }` → `true`
4. `zotero_get_pref { key: "extensions.zotero.watchFolder.sourcePath" }` → `/tmp/ZoteroWatchTest/inbox`
5. `zotero_get_pref { key: "extensions.zotero.watchFolder.targetCollection" }` → `TestImports`
6. `zotero_read_logs { filter: "WatchFolder", lines: 40 }` — expect `Started successfully` and `Started watching`.
7. `zotero_read_errors { lines: 10 }` — expect no `[WatchFolder]` errors.

**Pass criteria:** prefs persisted, no errors, watch loop running.
**Cleanup:** none (state needed for S.2).

---

## S.2 — Auto-import a PDF with metadata retrieval

**Purpose:** Drop → import → metadata retrieved (or `_needs-review` tag).
**MCP-automatable:** partial (user drops a PDF)

**Human prep:** copy a PDF with a known DOI into `/tmp/ZoteroWatchTest/inbox`. Wait `pollInterval` + ~5s.

**Steps:**
1. `zotero_read_logs { filter: "WatchFolder", lines: 60 }` — expect `Found 1 new file` and `Imported:`.
2. `zotero_db_query { sql: "SELECT itemID, dateAdded FROM items WHERE dateAdded > datetime('now','-2 minutes') ORDER BY dateAdded DESC LIMIT 5" }` — expect ≥ 1 new row.
3. Wait up to 60s for metadata retrieval, then `zotero_read_logs { filter: "metadata", lines: 60 }` — expect either `Recognition completed` or `timed out`.
4. `zotero_execute_js { code: "const lib=Zotero.Libraries.userLibraryID; const items=await Zotero.Items.getAll(lib); const last=items.slice(-1)[0]; return { id:last.id, title:last.getField('title'), DOI:last.getField('DOI'), tags:last.getTags().map(t=>t.tag) };" }` — expect non-empty title OR `_needs-review` in tags.

**Pass criteria:** item created, ends up either fully populated or tagged `_needs-review`. Source PDF still in inbox.
**Cleanup:** leave; S.3 reuses it.

---

## S.3 — Duplicate detection

**Purpose:** Re-importing the same PDF is skipped and `tracking.json` is still saved.
**MCP-automatable:** partial

**Human prep:** copy the same PDF from S.2 into the inbox a second time (different filename is fine; content hash matches). Wait one poll cycle.

**Steps:**
1. `zotero_read_logs { filter: "WatchFolder", lines: 60 }` — expect a dedupe log line (`DOI match`, `hash match`, or `Duplicate`).
2. `zotero_db_query { sql: "SELECT COUNT(*) FROM items WHERE dateAdded > datetime('now','-1 minute')" }` — expect 0 new items.
3. `zotero_execute_js { code: "const f=PathUtils.join(Zotero.DataDirectory.dir,'zotero-watch-folder-tracking.json'); const stat=await IOUtils.stat(f); return { exists:true, mtimeAgoSec:Math.round((Date.now()-stat.lastModified)/1000) };" }` — expect `mtimeAgoSec` < 60 (tracking file was updated even on a skip — guards the known bug).

**Pass criteria:** no new item, dedupe log present, tracking.json touched within the last minute.
**Cleanup:** remove the duplicate file from the inbox.

---

## S.4 — First-run prompt (`fresh_install` branch) — **STUBBED in v2**

**v2 status:** the v1 `Import All / Skip / Cancel` dialog was removed. The
v2 first-run flow ships in Phase C1 (full setup wizard, not yet built) and
B5 (baseline orchestrator). Until both land, the v2 plugin's first-run UX
is the C2 prefs-pane picker — the user just opens prefs and picks a sync
root. No modal dialog.

Re-enable this case (with new pass criteria) once C1 + B5 ship. The new
behaviour is documented in `updates_22_05_26.md` §"Install-time baseline
behavior" (B.1–B.5 matrix).

---

## S.5 — Zotero → disk deletion sync (3-button dialog)

**Purpose:** Trashing an item in Zotero offers `OS trash / Keep / Permanent` for the disk file.
**MCP-automatable:** manual-only (right-click menu + modal dialog)
**Known status: 🐛** — dialog historically never fired.

**Human prep:**
1. `zotero_set_pref { key: "extensions.zotero.watchFolder.diskDeleteOnTrash", value: "ask" }`
2. Right-click an imported item → `Move Item to Bin`. Choose `Move to OS trash`.

**Steps:**
1. `zotero_screenshot { target: "main-window" }` — must show the 3-button dialog. Absence = bug.
2. `zotero_read_logs { filter: "Trash sync|_handleZoteroTrash", lines: 60 }` — expect `Trash sync: moved <path> to OS trash`.
3. Bash: confirm the source file is now in the OS trash (e.g., `ls ~/.local/share/Trash/files/` on Linux).
4. `zotero_db_query { sql: "SELECT deleted FROM items WHERE itemID = <ITEMID>" }` → `1`.

**Pass criteria:** dialog appeared, choice was logged, file ended up in OS trash, item is in Zotero Bin.
**Cleanup:** restore item from Bin if needed; reset `diskDeleteOnTrash` to `ask`.

---

## S.6 — Disk → Zotero deletion sync (auto-bin popup)

**Purpose:** External delete of a tracked file moves the matching item to the Bin with a popup.
**MCP-automatable:** partial

**Human prep:**
1. `zotero_set_pref { key: "extensions.zotero.watchFolder.diskDeleteSync", value: "auto" }`
2. Ensure an item from S.2 is still imported with its source file present in the inbox.
3. Bash: `rm /tmp/ZoteroWatchTest/inbox/<filename>.pdf`. Wait one poll cycle + ~5s.

**Steps:**
1. `zotero_read_logs { filter: "externally-deleted|Detected", lines: 60 }` — expect `Detected 1 externally-deleted file(s)`.
2. `zotero_screenshot { target: "main-window" }` — popup appears listing the deleted path and item title.
3. `zotero_db_query { sql: "SELECT itemID, deleted FROM items WHERE itemID = <ITEMID>" }` → `deleted = 1`.

**Pass criteria:** popup shown, item in Bin.
**Cleanup:** restore item from Bin; reset `diskDeleteSync` to `auto` (default).

---

## S.7 — Plugin disable/enable cleanup

**Purpose:** Disable stops polling cleanly; re-enable resumes and picks up files added during downtime.
**MCP-automatable:** partial (user toggles the Add-ons checkbox)

**Human prep:** `Tools → Add-ons → Watch Folder → Disable`. Wait 10s.

**Steps:**
1. `zotero_plugin_list` — Watch Folder shows `disabled`.
2. Bash: `cp /path/to/some.pdf /tmp/ZoteroWatchTest/inbox/while_disabled.pdf`. Wait 15s.
3. `zotero_read_logs { filter: "WatchFolder", lines: 40 }` — expect NO new `Found` / `Imported` lines for `while_disabled.pdf`.
4. `zotero_db_query { sql: "SELECT COUNT(*) FROM items WHERE dateAdded > datetime('now','-1 minute')" }` → `0`.
5. Re-enable the plugin in the Add-ons UI. Wait `pollInterval` + 5s.
6. `zotero_read_logs { filter: "WatchFolder", lines: 60 }` — expect `Imported: while_disabled.pdf`.
7. `zotero_db_query { sql: "SELECT itemID, dateAdded FROM items WHERE dateAdded > datetime('now','-1 minute') ORDER BY dateAdded DESC LIMIT 1" }` → 1 new row.

**Pass criteria:** silent while disabled, picks up the file on re-enable, no duplicate imports.
**Cleanup:** remove the test PDF from the inbox.
