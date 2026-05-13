# Zotero Watch Folder - Fluent Localization (en-US)
# All identifiers prefixed with "watch-folder-" to avoid namespace collisions

# Preference pane sections
watch-folder-pref-section-about = About this plugin
watch-folder-pref-section-watch = Watch Folder
watch-folder-pref-section-import = Import Settings
watch-folder-pref-section-naming = File Naming

# About box (top of preferences pane)
watch-folder-pref-about-text = This plugin watches a folder you pick and automatically imports any PDFs (or other file types you list) into Zotero. When a new file appears, the plugin imports it, retrieves metadata, and renames the attachment using a template.
watch-folder-pref-about-storage = Each imported file is copied into Zotero's own storage (under ~/Zotero/storage/). By default the original file is left in your watch folder untouched, so you have two copies — your library is safe even if you later delete from the watch folder.
watch-folder-pref-about-trash = If you move an imported item to Zotero's bin, the plugin asks what to do with the source file (move to OS trash, keep, or delete permanently). If you delete a tracked file from the watch folder, the matching Zotero item moves to the bin and a popup notifies you.

# Watch folder settings
watch-folder-pref-source-dir = Source Folder:
watch-folder-pref-source-path = Source Folder:
watch-folder-pref-browse = Browse…
watch-folder-pref-enabled = Enable watch folder monitoring
watch-folder-pref-poll-interval = Poll interval:
watch-folder-pref-poll-interval-suffix = seconds
watch-folder-pref-file-types = File types to watch:
watch-folder-pref-file-types-desc = Comma-separated extensions (e.g., pdf,epub,djvu)
watch-folder-pref-target-collection = Target collection:

# Import settings
watch-folder-pref-import-mode = Import mode:
watch-folder-pref-import-mode-stored = Stored Copy (copy file to Zotero storage)
watch-folder-pref-import-mode-linked = Linked File (keep file in original location)
watch-folder-pref-post-import = After import:
watch-folder-pref-post-import-leave = Leave file in watch folder
watch-folder-pref-post-import-delete = Delete source file
watch-folder-pref-post-import-move = Move to 'imported' subfolder

# File naming settings
watch-folder-pref-rename-pattern = Rename pattern:
watch-folder-pref-rename-pattern-desc = Available: {"{firstCreator}"}, {"{year}"}, {"{title}"}, {"{shortTitle}"}, {"{DOI}"}
watch-folder-pref-rename-pattern-help = Variables: {"{firstCreator}"}, {"{year}"}, {"{title}"}, {"{shortTitle}"}, {"{DOI}"}
watch-folder-pref-auto-rename = Auto-rename files after metadata retrieval
watch-folder-pref-max-length = Maximum filename length:
watch-folder-pref-max-filename = Maximum filename length:
watch-folder-pref-max-filename-suffix = characters

# Status and notifications
watch-folder-status-watching = Watching folder: { $path }
watch-folder-status-disabled = Watch folder disabled
watch-folder-import-complete = Imported { $count } file(s)
watch-folder-import-error = Failed to import: { $filename }
watch-folder-metadata-failed = Metadata retrieval failed for: { $title }
watch-folder-folder-not-found = Watch folder not found: { $path }

# First run / existing files
watch-folder-first-run-title = Existing Files Detected
watch-folder-first-run-message = Found { $count } file(s) in the watch folder. Would you like to import them?
watch-folder-first-run-import = Import All
watch-folder-first-run-skip = Skip

# Tags
watch-folder-tag-needs-review = _needs-review
watch-folder-tag-import-error = _import-error
