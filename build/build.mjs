/**
 * Zotero Watch Folder - Build Script
 *
 * This script copies all necessary plugin files to the dist/ directory
 * for packaging into an XPI file.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

// Files and folders to copy to dist/
const FILES_TO_COPY = [
    'manifest.json',
    'bootstrap.js',
    'prefs.js'
];

const FOLDERS_TO_COPY = [
    'content',
    'locale'
];

/**
 * Remove directory recursively
 */
async function cleanDir(dir) {
    try {
        await fs.rm(dir, { recursive: true, force: true });
    } catch (err) {
        // Directory might not exist, that's fine
    }
}

/**
 * Copy a file from src to dest
 */
async function copyFile(src, dest) {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
}

/**
 * Copy a directory recursively
 */
async function copyDir(src, dest) {
    await fs.mkdir(dest, { recursive: true });

    const entries = await fs.readdir(src, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (entry.isDirectory()) {
            await copyDir(srcPath, destPath);
        } else {
            await copyFile(srcPath, destPath);
        }
    }
}

/**
 * Check if a file or directory exists
 */
async function exists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

/**
 * Main build function
 */
async function build() {
    console.log('='.repeat(50));
    console.log('Zotero Watch Folder - Build Script');
    console.log('='.repeat(50));
    console.log();

    // Step 1: Clean dist directory
    console.log('Cleaning dist/ directory...');
    await cleanDir(DIST_DIR);
    await fs.mkdir(DIST_DIR, { recursive: true });
    console.log('  ✓ dist/ directory cleaned and created');
    console.log();

    // Step 2: Copy individual files
    console.log('Copying files...');
    for (const file of FILES_TO_COPY) {
        const srcPath = path.join(ROOT_DIR, file);
        const destPath = path.join(DIST_DIR, file);

        if (await exists(srcPath)) {
            await copyFile(srcPath, destPath);
            console.log(`  ✓ Copied: ${file}`);
        } else {
            console.log(`  ⚠ Skipped (not found): ${file}`);
        }
    }
    console.log();

    // Step 3: Copy content files (excluding .mjs source files)
    console.log('Copying content files...');
    const contentDir = path.join(ROOT_DIR, 'content');
    const distContentDir = path.join(DIST_DIR, 'content');

    const contentEntries = await fs.readdir(contentDir, { withFileTypes: true });
    for (const entry of contentEntries) {
        const srcPath = path.join(contentDir, entry.name);
        const destPath = path.join(distContentDir, entry.name);

        if (entry.isDirectory()) {
            // Copy directories (icons, scripts)
            await copyDir(srcPath, destPath);
            console.log(`  ✓ Copied directory: content/${entry.name}/`);
        } else if (!entry.name.endsWith('.mjs')) {
            // Copy non-.mjs files only
            await copyFile(srcPath, destPath);
            console.log(`  ✓ Copied: content/${entry.name}`);
        } else {
            console.log(`  ⊗ Skipped source: content/${entry.name}`);
        }
    }
    console.log();

    // Step 4: Copy locale folder
    console.log('Copying locale...');
    const localeDir = path.join(ROOT_DIR, 'locale');
    if (await exists(localeDir)) {
        await copyDir(localeDir, path.join(DIST_DIR, 'locale'));
        console.log(`  ✓ Copied: locale/`);
    }
    console.log();

    // Step 5: Bundle user-facing HTML docs into dist/content/docs/ so the
    // prefs pane can link to them via chrome://zotero-watch-folder/content/docs/...
    // The three HTML pages live at the repo root; copy them in so users get
    // offline docs that ship with the XPI.
    console.log('Copying user-facing HTML docs...');
    const docsOut = path.join(DIST_DIR, 'content', 'docs');
    await fs.mkdir(docsOut, { recursive: true });
    const docPages = ['index.html', 'test-plan.html', 'test-cases.html'];
    for (const page of docPages) {
        const src = path.join(ROOT_DIR, page);
        if (await exists(src)) {
            await copyFile(src, path.join(docsOut, page));
            console.log(`  ✓ Copied: content/docs/${page}`);
        } else {
            console.log(`  ⚠ Skipped (not found): ${page}`);
        }
    }
    console.log();

    // Verify bundled script exists
    const bundledScript = path.join(DIST_DIR, 'content', 'scripts', 'watchFolder.js');
    if (await exists(bundledScript)) {
        console.log(`✓ Bundled script verified: content/scripts/watchFolder.js`);
    } else {
        console.log(`⚠ Bundled script not present yet — run 'npm run bundle' next (package will HARD-FAIL without it).`);
    }
    console.log();

    // Step 4: Summary
    console.log('='.repeat(50));
    console.log('Build complete!');
    console.log(`Output directory: ${DIST_DIR}`);
    console.log('='.repeat(50));
}

// Run build
build().catch((err) => {
    console.error('Build failed:', err);
    process.exit(1);
});
