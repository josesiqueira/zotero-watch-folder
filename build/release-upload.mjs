import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_MANIFEST = path.join(ROOT_DIR, 'dist', 'manifest.json');

function run(cmd, args) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { cwd: ROOT_DIR }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(`${cmd} ${args.join(' ')}\n${stderr || stdout || error.message}`));
                return;
            }
            resolve(stdout.trim());
        });
    });
}

function parseGitHubRepo(remoteUrl) {
    const httpsMatch = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/i);
    if (!httpsMatch) {
        throw new Error(`Unsupported remote URL: ${remoteUrl}`);
    }
    return `${httpsMatch[1]}/${httpsMatch[2]}`;
}

async function getTargetRepo() {
    if (process.env.GITHUB_REPOSITORY) {
        return process.env.GITHUB_REPOSITORY;
    }
    const remoteUrl = await run('git', ['config', '--get', 'remote.origin.url']);
    return parseGitHubRepo(remoteUrl);
}

async function getVersion() {
    const manifestRaw = await fs.readFile(DIST_MANIFEST, 'utf-8');
    const manifest = JSON.parse(manifestRaw);
    return manifest.version;
}

async function ensureRelease(tag, repo) {
    try {
        await run('gh', ['release', 'view', tag, '--repo', repo]);
    } catch {
        await run('gh', ['release', 'create', tag, '--repo', repo, '--title', tag, '--notes', `Release ${tag}`]);
    }
}

async function main() {
    await run('gh', ['--version']);
    const version = await getVersion();
    const tag = `v${version}`;
    const xpiName = `zotero-watch-folder-${version}.xpi`;
    const xpiPath = path.join(ROOT_DIR, xpiName);
    const repo = await getTargetRepo();

    await fs.access(xpiPath);
    await ensureRelease(tag, repo);
    await run('gh', ['release', 'upload', tag, xpiPath, '--repo', repo, '--clobber']);

    console.log(`Uploaded ${xpiName} to ${repo} release ${tag}`);
}

main().catch((err) => {
    console.error(`Release upload failed: ${err.message}`);
    process.exit(1);
});
