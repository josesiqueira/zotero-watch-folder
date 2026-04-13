/**
 * Zotero Watch Folder - Package Script
 *
 * This script creates an XPI file from the dist/ directory,
 * calculates the SHA256 hash, and generates an update.json file.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createWriteStream } from 'fs';
import { createHash } from 'crypto';
import archiver from 'archiver';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

// Plugin configuration
const ADDON_ID = 'watch-folder@zotero-plugin.org';
const GITHUB_USERNAME = process.env.GITHUB_USERNAME || 'josesiqueira';
const GITHUB_REPO = process.env.GITHUB_REPO || 'zotero-watch-folder-zotero8';
const MIN_ZOTERO_VERSION = '6.999';

/**
 * Read the manifest.json and extract version
 */
async function getVersion() {
    const manifestPath = path.join(DIST_DIR, 'manifest.json');

    try {
        const content = await fs.readFile(manifestPath, 'utf-8');
        const manifest = JSON.parse(content);
        return manifest.version;
    } catch (err) {
        throw new Error(`Failed to read manifest.json: ${err.message}`);
    }
}

/**
 * Create XPI file from dist/ directory
 */
async function createXPI(version) {
    const xpiName = `zotero-watch-folder-${version}.xpi`;
    const xpiPath = path.join(ROOT_DIR, xpiName);

    return new Promise((resolve, reject) => {
        const output = createWriteStream(xpiPath);
        const archive = archiver('zip', {
            zlib: { level: 9 } // Maximum compression
        });

        output.on('close', () => {
            resolve(xpiPath);
        });

        archive.on('error', (err) => {
            reject(err);
        });

        archive.pipe(output);

        // Add all files from dist/ to the archive
        archive.directory(DIST_DIR, false);

        archive.finalize();
    });
}

/**
 * Calculate SHA256 hash of a file
 */
async function calculateHash(filePath) {
    const content = await fs.readFile(filePath);
    const hash = createHash('sha256').update(content).digest('hex');
    return hash;
}

/**
 * Generate update.json file
 */
async function generateUpdateJSON(version, hash) {
    const updateManifest = {
        addons: {
            [ADDON_ID]: {
                updates: [
                    {
                        version: version,
                        update_link: `https://github.com/${GITHUB_USERNAME}/${GITHUB_REPO}/releases/download/v${version}/zotero-watch-folder-${version}.xpi`,
                        update_hash: `sha256:${hash}`,
                        applications: {
                            zotero: {
                                strict_min_version: MIN_ZOTERO_VERSION
                            }
                        }
                    }
                ]
            }
        }
    };

    const updatePath = path.join(ROOT_DIR, 'update.json');
    await fs.writeFile(updatePath, JSON.stringify(updateManifest, null, 2));

    return updatePath;
}

/**
 * Check if dist/ directory exists
 */
async function checkDistDir() {
    try {
        await fs.access(DIST_DIR);
        return true;
    } catch {
        return false;
    }
}

/**
 * Main package function
 */
async function package_() {
    console.log('='.repeat(50));
    console.log('Zotero Watch Folder - Package Script');
    console.log('='.repeat(50));
    console.log();

    // Step 1: Check if dist/ exists
    if (!await checkDistDir()) {
        console.error('Error: dist/ directory not found.');
        console.error('Please run "npm run build" first.');
        process.exit(1);
    }

    // Step 2: Read version from manifest
    console.log('Reading version from manifest.json...');
    const version = await getVersion();
    console.log(`  Version: ${version}`);
    console.log();

    // Step 3: Create XPI file
    console.log('Creating XPI file...');
    const xpiPath = await createXPI(version);
    const xpiStats = await fs.stat(xpiPath);
    console.log(`  ✓ Created: ${path.basename(xpiPath)}`);
    console.log(`  Size: ${(xpiStats.size / 1024).toFixed(2)} KB`);
    console.log();

    // Step 4: Calculate hash
    console.log('Calculating SHA256 hash...');
    const hash = await calculateHash(xpiPath);
    console.log(`  Hash: sha256:${hash}`);
    console.log();

    // Step 5: Generate update.json
    console.log('Generating update.json...');
    const updatePath = await generateUpdateJSON(version, hash);
    console.log(`  ✓ Created: ${path.basename(updatePath)}`);
    console.log();

    // Step 6: Summary
    console.log('='.repeat(50));
    console.log('Package complete!');
    console.log('='.repeat(50));
    console.log();
    console.log('Output files:');
    console.log(`  XPI: ${xpiPath}`);
    console.log(`  Update manifest: ${updatePath}`);
    console.log();
    console.log('SHA256 Hash:');
    console.log(`  ${hash}`);
    console.log();
    console.log('Next steps:');
    console.log('  1. Set GITHUB_USERNAME/GITHUB_REPO env vars if needed');
    console.log('  2. Run "npm run release:upload" to attach the XPI to release v' + version);
    console.log('  3. Host update.json for auto-updates');
}

// Run package
package_().catch((err) => {
    console.error('Package failed:', err);
    process.exit(1);
});
