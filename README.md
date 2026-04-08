# zotero-watch-folder-zotero8

# ⚠️ IMPORTANT NOTICE: AS-IS fork for Zotero 8
> This repository is an as-is fork of [`josesiqueira/zotero-watch-folder`](https://github.com/josesiqueira/zotero-watch-folder), maintained for Zotero 8 compatibility.

A powerful Zotero 8 plugin that automatically monitors a folder for new files and imports them into your Zotero library with metadata retrieval, smart organization, and collection synchronization.

## Features

### Phase 1: Auto-Import
- **Watch Folder Monitoring** - Automatically detect new PDF files in a designated folder
- **Automatic Metadata Retrieval** - Fetch metadata from online sources for imported PDFs
- **Smart File Renaming** - Rename files based on metadata using customizable patterns (e.g., `{firstCreator} - {year} - {title}`)
- **First-Run Detection** - Option to import existing files when first configured
- **Post-Import Actions** - Choose to leave, delete, or move files after import
- **File Type Filtering** - Configure which file types to monitor (PDF, EPUB, etc.)

### Phase 2: Collection Sync
- **Bidirectional Mirroring** - Sync Zotero collections with folder structure on disk
- **Item Movement Tracking** - Moving items between collections updates folder structure
- **Folder to Collection Sync** - Creating folders on disk creates corresponding collections
- **Conflict Resolution** - Multiple strategies for handling sync conflicts (Zotero wins, disk wins, newest wins, keep both)

### Phase 3: Advanced Features
- **Smart Rules Engine** - Create rules to automatically categorize imports based on:
  - Title, author, DOI, publication, tags, filename, and more
  - Actions: add to collection, add tag, set field, skip import
  - Support for nested collection paths (e.g., "Research/AI/Papers")
- **Duplicate Detection** - Prevent duplicate imports using:
  - DOI matching (100% confidence)
  - ISBN matching (100% confidence)
  - Fuzzy title matching (configurable threshold)
  - Content hash matching (optional)
- **Bulk Operations** - Mass operations for library maintenance:
  - Reorganize all files using current naming pattern
  - Retry metadata for failed items
  - Apply smart rules to existing library items

## Requirements

- Zotero 8.0 or later
- Windows, macOS, or Linux

## Installation

1. Download the latest `.xpi` file from [Releases](../../releases)
2. In Zotero, go to `Tools` → `Add-ons`
3. Click the gear icon and select `Install Add-on From File...`
4. Select the downloaded `.xpi` file
5. Restart Zotero

## Configuration

After installation, configure the plugin in `Edit` → `Settings` → `Watch Folder`:

### Basic Settings
- **Enable Watch Folder** - Turn monitoring on/off
- **Source Folder** - The folder to monitor for new files
- **Target Collection** - Where to place imported items (default: "Inbox")
- **Poll Interval** - How often to check for new files (seconds)
- **File Types** - Comma-separated list of extensions to monitor

### Import Options
- **Import Mode** - Store files in Zotero or link to original location
- **Post-Import Action** - What to do with source files after import
- **Auto-Retrieve Metadata** - Automatically fetch metadata for PDFs

### File Naming
- **Auto-Rename** - Rename files after metadata is retrieved
- **Rename Pattern** - Template for new filenames
  - Available variables: `{firstCreator}`, `{creators}`, `{year}`, `{title}`, `{shortTitle}`, `{DOI}`, `{itemType}`, `{publicationTitle}`
- **Max Filename Length** - Truncate long filenames

### Duplicate Detection
- **Enable Duplicate Check** - Check for duplicates before import
- **Match by DOI/ISBN/Title** - Configure detection methods
- **Title Similarity Threshold** - For fuzzy title matching (0.0-1.0)

## Building from Source

```bash
# Clone the repository
git clone https://github.com/josesiqueira/zotero-watch-folder-zotero8.git
cd zotero-watch-folder-zotero8

# Install dependencies
npm install

# Build the plugin
npm run build

# Package as XPI
npm run package

# Build + package + upload XPI to the matching GitHub release tag
npm run release
```

The XPI file will be created in the project root directory.

## Project Structure

```
zotero-watch-folder-zotero8/
├── manifest.json           # Plugin manifest for Zotero 8
├── bootstrap.js            # Plugin lifecycle (startup/shutdown)
├── prefs.js               # Default preference values
├── content/
│   ├── watchFolder.mjs    # Main orchestration service
│   ├── fileScanner.mjs    # Folder scanning logic
│   ├── fileImporter.mjs   # Zotero import integration
│   ├── trackingStore.mjs  # Import history tracking
│   ├── metadataRetriever.mjs  # PDF metadata fetching
│   ├── fileRenamer.mjs    # Template-based renaming
│   ├── firstRunHandler.mjs    # Initial setup wizard
│   ├── collectionSync.mjs     # Collection sync coordinator
│   ├── collectionWatcher.mjs  # Zotero collection observer
│   ├── folderWatcher.mjs      # Disk folder observer
│   ├── pathMapper.mjs         # Path ↔ collection mapping
│   ├── syncState.mjs          # Sync state persistence
│   ├── conflictResolver.mjs   # Sync conflict handling
│   ├── smartRules.mjs         # Rules engine
│   ├── duplicateDetector.mjs  # Duplicate detection
│   ├── bulkOperations.mjs     # Mass operations
│   ├── utils.mjs              # Shared utilities
│   ├── preferences.xhtml      # Settings UI
│   └── preferences.js         # Settings logic
├── locale/
│   └── en-US/
│       └── zotero-watch-folder.ftl  # Localization strings
└── build/
    ├── build.mjs          # Build script
    └── package.mjs        # XPI packaging script
```

## Technical Details

This plugin is built for Zotero 8 using modern web technologies:
- **ES Modules** (`.mjs`) - No legacy `.jsm` files
- **Native async/await** - No Bluebird promises
- **IOUtils/PathUtils** - Modern Mozilla file APIs
- **Fluent Localization** - `.ftl` files for i18n

## License

MIT License - see [LICENSE](LICENSE) for details.

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

## Acknowledgments

- Built for [Zotero](https://www.zotero.org/) - the free, easy-to-use tool for collecting, organizing, and citing research
