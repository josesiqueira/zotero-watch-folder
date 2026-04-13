/**
 * Bundle ESM modules into a single script for Zotero
 */
import * as esbuild from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

async function bundle() {
    console.log('==================================================');
    console.log('Zotero Watch Folder - Bundle Script');
    console.log('==================================================\n');

    try {
        const result = await esbuild.build({
            entryPoints: [path.join(projectRoot, 'content/index.mjs')],
            bundle: true,
            format: 'iife',
            globalName: '_ZoteroWatchFolderTemp',
            platform: 'browser',
            target: 'firefox128',   // Zotero 8 is based on Gecko/Firefox 128-140
            outfile: path.join(projectRoot, 'dist/content/scripts/watchFolder.js'),
            external: ['zotero*'],
            banner: {
                js: '// Bundled with esbuild for Zotero\n',
            },
            footer: {
                js: '\n// Attach to Zotero namespace\nif (typeof _globalThis !== "undefined" && typeof _globalThis.Zotero !== "undefined") {\n  _globalThis.Zotero.WatchFolder = _ZoteroWatchFolderTemp;\n} else if (typeof Zotero !== "undefined") {\n  Zotero.WatchFolder = _ZoteroWatchFolderTemp;\n}',
            },
        });

        console.log('✓ Bundle created successfully');
        console.log(`  Output: dist/content/scripts/watchFolder.js`);
    } catch (error) {
        console.error('✗ Bundle failed:', error.message);
        process.exit(1);
    }
}

bundle();
