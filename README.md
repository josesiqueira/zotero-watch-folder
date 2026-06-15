# Zotero Watch Folder

**Drop a PDF into a folder on your computer — it shows up in Zotero a few seconds later, with its metadata filled in and a tidy filename. No dragging, no clicking, no manual import.**

Point the plugin at a folder, pick the Zotero collection it belongs to, and that's it. From then on, anything you save into that folder is pulled into your library automatically. If you like, the plugin can also keep your folders and your Zotero collections mirrored to each other — so the way you organise things on disk and the way you organise them in Zotero stay the same.

📖 **[Open the user guide →](https://josesiqueira.github.io/zotero-watch-folder/)** — a friendly walkthrough with screenshots-in-words, a full settings reference, and answers to common questions. The same guide ships inside the plugin and opens straight from the settings pane.

Works with **Zotero 7, 8, and 9**. Tested on the latest Zotero 9.

---

> [!WARNING]
> **Back up your folder and your Zotero library before you start.**
>
> Depending on the mode you choose, this plugin can **rename, move, and even delete files on your disk** to keep your folder and Zotero in step. It can also create and rename **Zotero collections** to match your folders. That's the whole point — but it means a wrong setting on a folder full of papers you care about can ruin your day.
>
> Two minutes of insurance before you flip it on:
> - **Copy your folder somewhere safe** (drag it to a backup drive, let your cloud service snapshot it — anything).
> - **Back up your Zotero library** — either make sure Zotero Sync is up to date, or use `File → Export Library… → Zotero RDF`.
> - **Start in Mode 1 (Import only).** It only ever *adds* things. Get a feel for it before trying the mirror modes.
>
> Mode 3 keeps a recoverable trash folder so most mistakes can be undone — but a backup is still the thing that lets you sleep at night.

---

## What it does, in plain terms

- **You save a PDF, it lands in Zotero.** Drop a file into your watched folder and within a few seconds it's an item in your library — metadata looked up, filename cleaned up (e.g. `Smith - 2021 - A Great Paper.pdf`).
- **Your folders and Zotero collections can stay in sync.** Make a subfolder, get a subcollection. Rename one, the other follows. (Optional — only in the mirror modes.)
- **It won't make duplicates.** Save the same paper twice and the plugin recognises it and skips it.
- **Nothing gets lost by surprise.** It refuses to overwrite a file you've edited, pauses if your folder goes missing (e.g. an unplugged drive), and asks before doing anything that affects a lot of files at once.
- **Mistakes are recoverable.** In the delete-capable mode, removed files go to a recoverable trash inside your folder, and you can put them back.

## Pick how hands-on it is: three modes

You choose a mode during setup, and you can switch any time from the settings — no restart needed.

| Mode | What it does | Who it's for |
|---|---|---|
| **Mode 1 — Import only** | New files get imported. Nothing is ever moved or deleted. The safest option. | Most people. Start here. |
| **Mode 2 — Mirror, no deleting** | Your folders and Zotero collections mirror each other both ways. Renames and moves follow along. Deletions are only flagged, never carried out. | People who organise in folders and want Zotero to match. |
| **Mode 3 — Mirror with safe delete** | Full two-way sync, including deletions — but deleted files go to a recoverable trash, and big deletions ask first. | People who want their folder and Zotero to be exact mirrors. |

## Install

1. Download the latest `.xpi` from the **[Releases page](https://github.com/josesiqueira/zotero-watch-folder/releases)**.
2. In Zotero, open **Tools → Plugins**.
3. Click the gear icon → **Install Add-on From File…**
4. Choose the `.xpi` you downloaded, and restart Zotero if asked.
5. Open **Edit → Settings → Watch Folder** (on a Mac: **Zotero → Settings**) and click **Set up Watch Folder…**. The wizard walks you through it: pick the folder, pick the Zotero collection that anchors everything, pick a mode, and turn it on.

After that you don't have to think about it. New releases install themselves automatically through Zotero.

## A few things worth knowing

**Will it rename or move my files on disk?**
In Mode 1, no — it only imports. In Modes 2 and 3, yes: keeping your folder and Zotero mirrored means the plugin renames and moves files to match. That's expected behaviour, not a bug. If you don't want your files touched, stay in Mode 1.

**Does it sync my PDFs to my phone / other computers?**
Not by itself — the plugin works on your computer. What reaches your phone is whatever **Zotero's own sync** carries. Zotero syncs all your item *information* (titles, authors, collections) for free and without limit, so you'll always see your papers listed everywhere. The PDF *files* only sync if you have room in your **Zotero storage quota** (the free tier is 300 MB). If you import a lot of PDFs the normal way ("stored" files), you can fill that up — at which point new files stay on your computer but stop uploading. You can either buy more Zotero storage, or set the plugin to **linked** files (it then points at the files in your folder instead of copying them into Zotero, so they don't count against your quota — but they also won't open on your phone).

**What if my folder is on a cloud drive (Dropbox, pCloud, etc.)?**
That works well on a single computer. Across several computers it gets tricky, because two machines syncing the same folder *and* talking to Zotero can step on each other. If you go multi-device, prefer letting Zotero handle the syncing, and keep the watch folder local.

**Something looks off — where do I look?**
The settings pane surfaces anything that needs your attention: suppressed items, conflicts, sync warnings, and a "restore trashed folders" option. Each comes with a button to resolve it. The [user guide](https://josesiqueira.github.io/zotero-watch-folder/) has a whole chapter on "when something looks off."

## Getting help

Found a bug or have an idea? Open an issue at **[github.com/josesiqueira/zotero-watch-folder/issues](https://github.com/josesiqueira/zotero-watch-folder/issues)**.

## License

GNU GPL v3.0 — free and open source. See [`LICENSE`](LICENSE) for the full text.

---

*Building from source, contributing, or just curious how it works under the hood? See **[docs/DEVELOPERS.md](docs/DEVELOPERS.md)** and the visual **[docs/architecture.md](docs/architecture.md)**.*
