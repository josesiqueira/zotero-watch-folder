# Behavior Updates — expected behavior reference

A living spec of what the Watch Folder plugin **should** do in every scenario, written from simplest to most complex. Each case is the source of truth for both manual review and for writing/updating tests.

Two broad sections:

- **INCLUSION** — scenarios where files arrive (on disk or in Zotero). What does the plugin do, and what does it leave alone?
- **EXCLUSION** — scenarios where files or items disappear (on disk or in Zotero). What propagates where, and what doesn't?

## Case template

Each case follows the same shape. Future cases just fill the slots.

```
### <CODE> — <Title>

Brief one-paragraph description.

Diagram:                  (ASCII boxes/arrows)

Start file structure:     (tree of disk + Zotero state)
Expected end state:       (same tree, but after the action)

Example usage:            (concrete user-facing scenario)
```

Status legend for each case:

- ✅ **spec'd and matches code** — verified by manual run or unit test
- 🚧 **spec'd, not verified** — written here, not yet exercised
- ❌ **spec'd, code disagrees** — bug to fix; this file is the target, code is wrong

---

## INCLUSION

### I.1 — Empty watch folder, empty Zotero

**Status:** 🚧

**Description.** The plugin is enabled and pointed at a brand-new (empty) source folder. Zotero has no items (or at least none from this folder). This is the null case — it establishes that the plugin does **nothing** until something arrives, and clarifies the plugin's **directional model**: data flows disk → Zotero, never the reverse, unless `collectionSync` (Phase 2) is explicitly enabled.

Two sub-questions are answered here:

1. *Empty folder + empty Zotero → what happens?* — Nothing. The plugin records the path as "seen" (`lastWatchedPath`) and enters its idle polling loop.
2. *Empty folder + Zotero already has items → are those items "downloaded" to the folder?* — **No.** Items in Zotero are not pushed to disk. The watch folder is import-only in the default mode.

**Diagram:**

```
              ┌──────────────────┐                    ┌──────────────────┐
   I.1.a      │   Watch folder   │                    │  Zotero library  │
   both       │      (disk)      │                    │                  │
   empty      │                  │      no-op         │                  │
              │     [empty]      │     ─ ─ ─ ─ ─►     │     [empty]      │
              └──────────────────┘                    └──────────────────┘
                       ▲
                       │  plugin enables, scans, finds nothing,
                       │  saves lastWatchedPath, idles


              ┌──────────────────┐                    ┌──────────────────┐
   I.1.b      │   Watch folder   │                    │  Zotero library  │
   folder     │      (disk)      │                    │                  │
   empty,     │                  │   NO reverse flow  │   item A         │
   library    │     [empty]      │     ✗ ✗ ✗ ✗ ✗      │   item B         │
   not        │                  │                    │   item C         │
              └──────────────────┘                    └──────────────────┘

                Zotero items stay in Zotero. Disk stays empty.
                (To mirror Zotero → disk, enable collectionSync — Phase 2.)
```

**Start file structure:**

```
~/MyWatchFolder/         <-- sourcePath, just created
   (empty)

Zotero library
   └── Inbox/            <-- targetCollection
         (empty)

Plugin prefs
   enabled              = true
   sourcePath           = /home/.../MyWatchFolder
   targetCollection     = Inbox
   lastWatchedPath      = ""       <-- key: empty means "first run"
   collectionSyncEnabled = false   <-- default; no reverse flow
```

**Expected end state (after first poll cycle):**

```
~/MyWatchFolder/
   (still empty)

Zotero library
   └── Inbox/
         (still empty)

Plugin prefs
   lastWatchedPath      = /home/.../MyWatchFolder   <-- now recorded
   (everything else unchanged)

tracking.json            <-- created if missing, with zero records
   { records: {} }

Debug log (Zotero.debug)
   [WatchFolder] Plugin started successfully
   [WatchFolder] Started watching folder
   [WatchFolder] Scan complete: 0 new file(s)
   (no first-run dialog — there are no existing files to offer importing)
```

**Variant — Zotero already has items (I.1.b):** identical to above. None of the existing Zotero items are written to disk. The watch folder remains empty. The plugin treats the two stores as independent unless and until a file is dropped on disk OR collection sync is explicitly turned on.

**Example usage.** A user installs the plugin for the first time, opens Settings → Watch Folder, picks `~/MyWatchFolder` (a folder they just created and haven't put anything in), sets target collection to `Inbox`, ticks Enable, and clicks OK. They might have been using Zotero for years and have thousands of items already. **Nothing visible happens.** No popup, no new items, no files appearing on disk. The plugin is now waiting for files to arrive in `~/MyWatchFolder`. Until they drop something in, the plugin's only job is to silently scan the (empty) folder every `pollInterval` seconds.

**Why this matters for design.** This case fixes the plugin's mental model:

- **Source of truth for content is the disk.** A file on disk is what triggers everything else.
- **Zotero is the destination, not a mirror back to disk** (unless `collectionSyncEnabled=true`).
- **First-run UX must be silent when there's nothing to offer.** No empty "import 0 files?" prompts.

---

## EXCLUSION

*(cases to be added — start with the simplest exclusion scenario when ready)*
