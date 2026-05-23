# Edge-case runbooks

Failure modes and unusual inputs. Each should be quick.

---

## E.1 — Special characters in filename

**MCP-automatable:** full
**Steps:**
1. Bash: `cp /path/to/sample.pdf "/tmp/ZoteroWatchTest/inbox/Test (2024) [Final] - Résumé.pdf"`. Wait poll + 5s.
2. `zotero_read_logs { filter: "Imported|sanitiz", lines: 60 }` — expect import log.
3. `zotero_db_query { sql: "SELECT COUNT(*) FROM items WHERE dateAdded > datetime('now','-1 minute')" }` → `1`.
4. `zotero_execute_js { code: "const items=await Zotero.Items.getAll(Zotero.Libraries.userLibraryID); const it=items.slice(-1)[0]; const att=await Zotero.Items.getAsync(it.getAttachments()[0]); return att.attachmentFilename;" }` — filename present, no fatal characters (`/ \\ : * ? \" < > |`).

**Pass criteria:** import succeeded; stored filename is sanitized.

---

## E.2 — Very long filename

**MCP-automatable:** full
**Steps:**
1. Bash: `cp /path/to/sample.pdf "/tmp/ZoteroWatchTest/inbox/$(python3 -c 'print(\"a\"*220)').pdf"`. Wait poll + 5s.
2. `zotero_execute_js { code: "const items=await Zotero.Items.getAll(Zotero.Libraries.userLibraryID); const it=items.slice(-1)[0]; const att=await Zotero.Items.getAsync(it.getAttachments()[0]); return att.attachmentFilename.length;" }` — expect ≤ `maxFilenameLength` pref (default `150`).

**Pass criteria:** filename truncated, import succeeded.

---

## E.3 — Empty folder

**MCP-automatable:** full
**Steps:**
1. `zotero_set_pref { key: "extensions.zotero.watchFolder.sourcePath", value: "/tmp/ZoteroWatchTest/empty" }`
2. Bash: `mkdir -p /tmp/ZoteroWatchTest/empty && rm -f /tmp/ZoteroWatchTest/empty/*`.
3. `zotero_plugin_reload { pluginId: "watch-folder@zotero-plugin.org" }`. Wait poll + 5s.
4. `zotero_read_errors { lines: 20 }` — no `[WatchFolder]` errors.
5. `zotero_read_logs { filter: "Scan|scan|Found", lines: 40 }` — scan completed with 0 files.

**Pass criteria:** no errors, no items created.
**Cleanup:** restore previous `sourcePath`.

---

## E.4 — Rapid batch of files

**MCP-automatable:** full
**Steps:**
1. Bash: `for i in $(seq 1 5); do cp /path/to/sample.pdf /tmp/ZoteroWatchTest/inbox/batch_$i.pdf; done`. Wait poll + 10s.
2. `zotero_read_logs { filter: "Found .* new file", lines: 40 }` — expect `Found 5 new file(s)`.
3. `zotero_db_query { sql: "SELECT COUNT(*) FROM items WHERE dateAdded > datetime('now','-2 minutes')" }` → ≥ 5 (more if dedup is off).
4. `zotero_read_errors { lines: 20 }` — no concurrency errors.

**Pass criteria:** all 5 imported, no crashes, no exceeded-concurrency errors. This is also the canary for the `metadataRetriever` queue bug — watch for missing `Recognition completed` logs that should match the queued count.
**Cleanup:** remove the 5 test files.

---

## E.5 — Files added while plugin disabled

**MCP-automatable:** partial (uses Add-ons UI)
**Steps:**
1. Disable Watch Folder via `Tools → Add-ons`.
2. Bash: `cp /path/to/sample.pdf /tmp/ZoteroWatchTest/inbox/added_while_off.pdf`.
3. Re-enable Watch Folder. Wait poll + 5s.
4. `zotero_read_logs { filter: "added_while_off", lines: 40 }` — expect `Imported`.
5. `zotero_db_query { sql: "SELECT COUNT(*) FROM items WHERE dateAdded > datetime('now','-1 minute')" }` → `1`.

**Pass criteria:** file picked up after re-enable, no duplicate from any later poll.

---

## E.6 — Zotero restart resumes watching

**MCP-automatable:** partial (Zotero restart is manual)
**Steps:**
1. Confirm `enabled=true` pre-restart: `zotero_get_pref { key: "extensions.zotero.watchFolder.enabled" }`.
2. Quit Zotero. Reopen.
3. Wait ~10s. `zotero_plugin_list` — Watch Folder loaded.
4. `zotero_read_logs { filter: "Started watching|Plugin started", lines: 60 }` — expect both lines.
5. Bash: `cp /path/to/sample.pdf /tmp/ZoteroWatchTest/inbox/after_restart.pdf`. Wait poll + 5s.
6. `zotero_read_logs { filter: "after_restart", lines: 40 }` → `Imported`.

**Pass criteria:** plugin auto-resumes, new files are imported.
