// Self-update: when the GitHub repository has a newer commit, download it, replace the bot's own files and restart.
// Switched on with AUTO_UPDATE=on (docker-compose.yml does this). The container's restart policy brings the bot back up on the new code.
// Your data (database, backups, settings, panel) lives in the data folder and is never touched.
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(path.dirname(process.env.DB_PATH && process.env.DB_PATH !== ':memory:' ? process.env.DB_PATH : 'data/x'));
const SHA_FILE = path.join(DATA, '.code_sha');
const REPO = process.env.UPDATE_REPO || 'vibinator/echo-issue-bot';
const BRANCH = process.env.UPDATE_BRANCH || 'main';
const headers = { 'User-Agent': 'echo-issue-bot-updater', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };

const read = (f) => { try { return readFileSync(f, 'utf8').trim(); } catch { return ''; } };

/** Returns true when an update was installed (the caller should then restart). Never throws. */
export async function checkForUpdate(log = console) {
  const work = path.join(DATA, '.update');
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`, { headers: { ...headers, Accept: 'application/vnd.github.sha' }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`GitHub answered ${r.status} (is the repository public, or GITHUB_TOKEN set?)`);
    const sha = (await r.text()).trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('unexpected answer from GitHub');
    if (sha === read(SHA_FILE)) return false;

    rmSync(work, { recursive: true, force: true });
    mkdirSync(path.join(work, 'new'), { recursive: true });
    const tgz = await fetch(`https://api.github.com/repos/${REPO}/tarball/${sha}`, { headers, redirect: 'follow', signal: AbortSignal.timeout(120_000) });
    if (!tgz.ok) throw new Error(`download failed (${tgz.status})`);
    writeFileSync(path.join(work, 'new.tgz'), Buffer.from(await tgz.arrayBuffer()));
    await run('tar', ['-xzf', path.join(work, 'new.tgz'), '-C', path.join(work, 'new'), '--strip-components=1']);

    const src = path.join(work, 'new', 'src');
    if (!existsSync(path.join(src, 'index.js'))) throw new Error('the download did not contain src/index.js');
    await run(process.execPath, ['--check', path.join(src, 'index.js')]); // refuse a file with a syntax error

    const lockChanged = read(path.join(work, 'new', 'package-lock.json')) !== read(path.join(APP, 'package-lock.json'));
    cpSync(src, path.join(APP, 'src'), { recursive: true });
    for (const f of ['package.json', 'package-lock.json']) if (existsSync(path.join(work, 'new', f))) cpSync(path.join(work, 'new', f), path.join(APP, f));
    if (lockChanged) await run('npm', ['ci', '--omit=dev'], { cwd: APP, timeout: 300_000 });

    writeFileSync(SHA_FILE, sha);
    log.log(`Updated to ${sha.slice(0, 7)} – restarting on the new version.`);
    return true;
  } catch (e) {
    log.error(`Update check failed: ${e.message}`);
    return false;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
