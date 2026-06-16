# Zotero Watch Folder — Fluent Localization (en-US)
# All identifiers prefixed with "watch-folder-" to avoid namespace collisions

# ─── Preference pane sections ─────────────────────────────────────
watch-folder-pref-section-about = About this plugin
watch-folder-pref-section-setup = Get started
watch-folder-pref-section-watch = Watch Folder
watch-folder-pref-section-naming = File Naming
watch-folder-pref-section-advanced = Advanced settings
watch-folder-pref-section-import = Import Settings
watch-folder-pref-section-smart-rules = Smart Rules

# ─── About box ────────────────────────────────────────────────────
watch-folder-pref-about-blurb = Watch Folder watches a folder you pick. Drop a PDF in — the plugin imports it into Zotero, fetches metadata, renames the file, and (in mirror modes) keeps your Zotero collections in sync with the folder layout on disk.

watch-folder-pref-docs-userguide = User guide
watch-folder-pref-docs-modes = Modes explained
watch-folder-pref-docs-behavior = Behavior reference

# Legacy (kept for compatibility — no longer rendered)
watch-folder-pref-about-text = Watch Folder watches a folder you pick and imports new PDFs into Zotero with automatic metadata + renaming. See the user guide for details.
watch-folder-pref-about-storage = Imported files are copied into Zotero's storage (~/Zotero/storage/) by default; the original stays in your watch folder untouched.
watch-folder-pref-about-trash = If you move an imported item to Zotero's bin, the plugin asks what to do with the source file. Disk deletions in mirror modes propagate back to Zotero with confirmation prompts for bulk operations.

# ─── Get started ──────────────────────────────────────────────────
watch-folder-pref-setup-blurb = First time here, or want to start fresh? The setup wizard walks you through picking your watch folder, the Zotero collection to sync into, and the sync mode that matches how you work.
watch-folder-pref-setup-cta = Set up Watch Folder…

# ─── Watch folder essentials ──────────────────────────────────────
watch-folder-pref-enabled = Enable watch folder monitoring
watch-folder-pref-source-path = Source folder:
watch-folder-pref-browse = Browse…
watch-folder-pref-sync-root = Zotero collection:
watch-folder-pref-sync-root-change = Change…
watch-folder-pref-mode = Sync mode:

watch-folder-pref-mode1-label = Import only
watch-folder-pref-mode1-desc = Copy files in. Never modify your Zotero collections from the disk side. Safest — recommended if you want the plugin to stay out of your way after import.

watch-folder-pref-mode2-label = Mirror, no delete
watch-folder-pref-mode2-desc = Keep Zotero collections aligned with the folder layout. Add a subfolder on disk → add a subcollection in Zotero. Disk deletions DO NOT trash Zotero items (warn-only).

watch-folder-pref-mode3-label = Mirror, safe delete
watch-folder-pref-mode3-desc = Full two-way sync. Adds, renames, AND deletions propagate from disk to Zotero. Bulk deletions ask for confirmation. Deleted files go to a recoverable plugin trash, not permanent deletion.

watch-folder-pref-rerun-wizard = Re-run setup wizard…

# ─── PDF storage strategy (orthogonal to sync mode) ───────────────
watch-folder-pref-section-storage = PDF storage strategy
watch-folder-pref-storage-explainer = Zotero data sync protects your library metadata, notes, collections, and Zotero highlights. PDF files are separate. If you choose linked watch-folder files, Zotero will remember the papers and annotations, while your folder-sync provider protects the PDF files.
watch-folder-pref-storage-webdav-hint = Using WebDAV file sync (pCloud, Nextcloud, a NAS…)? Choose "Store PDFs in Zotero" below — only stored PDFs upload to WebDAV and reach your other devices, including the mobile apps.
watch-folder-pref-storage-webdav-badge = ★ Best for WebDAV / cloud sync
watch-folder-pref-current-badge = ✓ current
watch-folder-pref-storage-stored-label = Store PDFs in Zotero
watch-folder-pref-storage-stored-desc = Best Zotero experience, and the right choice if you use WebDAV file sync (pCloud, Nextcloud, a NAS…) or Zotero Storage. Zotero stores each PDF and uploads it to your file-sync provider, so it reaches every device, including the mobile apps.
watch-folder-pref-storage-linked-label = Link PDFs from watch folder
watch-folder-pref-storage-linked-desc = Saves Zotero Storage space, but these PDFs are NOT uploaded by Zotero or WebDAV — they won't appear on your other devices or in the Zotero mobile apps. Their files only travel if the watch folder itself is synced by pCloud Sync, Dropbox, Syncthing, etc.
watch-folder-pref-storage-mirror-label = Store in Zotero and mirror to watch folder
watch-folder-pref-storage-mirror-desc = Keeps Zotero's normal stored attachment — which DOES sync via Zotero Storage or WebDAV — plus a local copy in your watch folder. Good for a browsable local backup; uses the same storage as "Store PDFs in Zotero".
watch-folder-pref-storage-linked-warning = Linked PDFs are not synced by Zotero or WebDAV, so they won't be available in the Zotero mobile apps or on your other computers.
watch-folder-pref-storage-restore = If this computer is lost, install Zotero and sign in to restore metadata, notes, and annotations. Then install your folder-sync app, let it download the watch folder, and set Zotero's linked attachment base directory so Zotero can find the PDFs again.
watch-folder-pref-storage-reclaim = Reclaim Zotero Storage Space…
watch-folder-pref-storage-build-mirror = Build/Repair Watch Folder Mirror…

# ─── Deletion disposition (Mode 3 only) ──────────────────────────
watch-folder-pref-section-deletion = When a source file is deleted
watch-folder-pref-deletion-explainer = In "Mirror with safe delete" mode, when you move an item to Zotero's bin the plugin can also act on the matching file in your watch folder. Choose what happens to that source file. (Permanent deletion is never saved as a standing choice — if you ever pick it from the prompt, it applies to that one batch only.)
watch-folder-pref-deletion-recommended-badge = ★ Recommended
watch-folder-pref-deletion-ask-label = Ask me each time
watch-folder-pref-deletion-ask-desc = Show a prompt every time files are removed, so you decide per batch.
watch-folder-pref-deletion-plugin-trash-label = Move to plugin trash (recoverable)
watch-folder-pref-deletion-plugin-trash-desc = Move the file into a .zotero-watch-trash folder under your watch root. Fully recoverable, and it stays on the same drive or network share as the original — the safe default.
watch-folder-pref-deletion-os-trash-label = Move to system trash
watch-folder-pref-deletion-os-trash-desc = Move the file to your operating system's Trash / Recycle Bin. Recoverable from there, but may not work on network shares or external drives.
watch-folder-pref-deletion-never-label = Leave the file on disk
watch-folder-pref-deletion-never-desc = Never touch the source file. Zotero's bin and your watch folder can drift apart, but nothing on disk is ever removed by the plugin.
watch-folder-pref-deletion-permanent-warn = Your current setting permanently deletes source files with no way to recover them. This is not offered here because it is unsafe as a standing choice.
watch-folder-pref-deletion-revert = Switch to recoverable plugin trash

# ─── Attention rows (only shown when non-zero) ────────────────────
watch-folder-pref-warnings = Sync warnings:
watch-folder-pref-warnings-view = View
watch-folder-pref-warnings-clear = Clear
watch-folder-pref-suppressed = Suppressed items:
watch-folder-pref-suppressed-resolve = Resolve…
watch-folder-pref-suppressed-resolve-folders = Resolve folders…
watch-folder-pref-conflicted = Conflict-blocked:
watch-folder-pref-conflicted-resolve = Resolve…
watch-folder-pref-trashed-folders = Trashed folders:
watch-folder-pref-trashed-folders-restore = Restore folders…

# ─── File naming ──────────────────────────────────────────────────
watch-folder-pref-auto-rename = Auto-rename files after metadata retrieval
watch-folder-pref-rename-pattern = Rename pattern:
watch-folder-pref-rename-pattern-help = Variables: {"{firstCreator}"}, {"{year}"}, {"{title}"}, {"{shortTitle}"}, {"{DOI}"}

# ─── Advanced settings ────────────────────────────────────────────
watch-folder-pref-advanced-blurb = These options have sensible defaults and most users don't need to change them.

watch-folder-pref-poll-interval = Poll interval:
watch-folder-pref-poll-interval-suffix = seconds
watch-folder-pref-poll-interval-help = How often the plugin checks the folder for new files. Lower = faster pickup, higher = less CPU. Default 5.

watch-folder-pref-file-types = File types to watch:
watch-folder-pref-file-types-help = Comma-separated extensions, e.g. "pdf, epub". PDF is what almost everyone wants.

watch-folder-pref-max-filename = Maximum filename length:
watch-folder-pref-max-filename-suffix = characters

watch-folder-pref-smart-rules-enabled = Enable smart rules
watch-folder-pref-smart-rules-blurb = Smart rules apply automatic tags, collection assignments, or item-field updates to imports. Rules are JSON; click "Open editor" to author or paste them. Leave disabled if you're not sure.
watch-folder-pref-smart-rules-open-editor = Open Smart Rules editor…

# ─── Status and notifications (used elsewhere) ────────────────────
watch-folder-status-watching = Watching folder: { $path }
watch-folder-status-disabled = Watch folder disabled
watch-folder-import-complete = Imported { $count } file(s)
watch-folder-import-error = Failed to import: { $filename }
watch-folder-metadata-failed = Metadata retrieval failed for: { $title }
watch-folder-folder-not-found = Watch folder not found: { $path }

# ─── First run / existing files (legacy modal — kept for fallback) ──
watch-folder-first-run-title = Existing Files Detected
watch-folder-first-run-message = Found { $count } file(s) in the watch folder. Would you like to import them?
watch-folder-first-run-import = Import All
watch-folder-first-run-skip = Skip

# ─── Tags ─────────────────────────────────────────────────────────
watch-folder-tag-needs-review = _needs-review
watch-folder-tag-import-error = _import-error

# ─── Smart rules editor (separate window) — legacy strings kept ───
# These three are unused in the redesigned prefs pane but kept so the
# in-window Smart Rules editor (chrome://.../smartRulesEditor.xhtml)
# can still pick them up if it ever switches to FTL.
watch-folder-pref-smart-rules-save = Save
watch-folder-pref-smart-rules-insert-example = Insert example
watch-folder-pref-smart-rules-reload = Reload from prefs
watch-folder-pref-smart-rules-help = Rules below are JSON. Each rule has an id, name, conditions (AND logic), and actions.
