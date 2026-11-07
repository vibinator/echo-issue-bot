// Self-update: when the GitHub repository has a newer commit, download it, replace the bot's own files and restart.
// Switched on with AUTO_UPDATE=on (docker-compose.yml does this). The container's restart policy brings the bot back up on the new code.
// Your data (database, backups, settings, panel) lives in the data folder and is never touched.
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(path.dirname(process.env.DB_PATH && process.env.DB_PATH !== ':memory:' ? process.env.DB_PATH : 'data/x'));
const SHA_FILE = path.join(DATA, '.code_sha');
const BAD_FILE = path.join(DATA, '.bad_sha');          // a version that failed its checks or kept crashing: never installed again
const PENDING_FILE = path.join(DATA, '.update_pending'); // set while a new version has not yet proved it can start
const ROLLBACK = path.join(DATA, '.rollback');            // copy of the previous version's files
const FILES = ['package.json', 'package-lock.json'];
const REPO = process.env.UPDATE_REPO || 'vibinator/echo-issue-bot';
const BRANCH = process.env.UPDATE_BRANCH || 'main';
const headers = { 'User-Agent': 'echo-issue-bot-updater', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };

const read = (f) => { try { return readFileSync(f, 'utf8').trim(); } catch { return ''; } };

const restoreOld = () => {
  rmSync(path.join(APP, 'src'), { recursive: true, force: true });
  cpSync(path.join(ROLLBACK, 'src'), path.join(APP, 'src'), { recursive: true });
  for (const f of FILES) if (existsSync(path.join(ROLLBACK, f))) cpSync(path.join(ROLLBACK, f), path.join(APP, f));
};

/** The new version has to at least load: import it (against a throw-away in-memory database) and make sure nothing throws. */
const loadCheck = () => run(process.execPath, ['--no-warnings', '--input-type=module', '-e', "await import('./src/index.js'); process.exit(0)"],
  { cwd: APP, timeout: 60_000, env: { ...process.env, DB_PATH: ':memory:', AUTO_UPDATE: 'off', DISCORD_TOKEN: '' } });

/** Called once the bot has logged in to Discord: the version that was just installed works, so stop watching it. */
export function confirmUpdate() {
  try { rmSync(PENDING_FILE, { force: true }); } catch { /* nothing to confirm */ }
}

/**
 * Called at start-up. A freshly installed version gets 2 attempts to log in; if it crashes before that, the previous
 * version is put back and the broken one is remembered so it is not downloaded again. Returns true when it rolled back.
 */
export function rollbackIfCrashLooping() {
  try {
    if (!existsSync(PENDING_FILE)) return false;
    const p = JSON.parse(read(PENDING_FILE) || '{}');
    if ((p.attempts ?? 0) < 2) { writeFileSync(PENDING_FILE, JSON.stringify({ ...p, attempts: (p.attempts ?? 0) + 1 })); return false; }
    if (!existsSync(path.join(ROLLBACK, 'src'))) { rmSync(PENDING_FILE, { force: true }); return false; }
    restoreOld();
    if (p.sha) writeFileSync(BAD_FILE, p.sha);
    if (p.prev) writeFileSync(SHA_FILE, p.prev);
    rmSync(PENDING_FILE, { force: true });
    console.error(`Version ${String(p.sha).slice(0, 7)} failed to start twice – went back to the previous version.`);
    return true;
  } catch (e) { console.error(`Rollback check failed: ${e.message}`); return false; }
}

/** Returns true when an update was installed (the caller should then restart). Never throws. */
export async function checkForUpdate(log = console) {
  const work = path.join(DATA, '.update');
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`, { headers: { ...headers, Accept: 'application/vnd.github.sha' }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`GitHub answered ${r.status} (is the repository public, or GITHUB_TOKEN set?)`);
    const sha = (await r.text()).trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('unexpected answer from GitHub');
    if (sha === read(SHA_FILE) || sha === read(BAD_FILE)) return false;

    rmSync(work, { recursive: true, force: true });
    mkdirSync(path.join(work, 'new'), { recursive: true });
    const tgz = await fetch(`https://api.github.com/repos/${REPO}/tarball/${sha}`, { headers, redirect: 'follow', signal: AbortSignal.timeout(120_000) });
    if (!tgz.ok) throw new Error(`download failed (${tgz.status})`);
    writeFileSync(path.join(work, 'new.tgz'), Buffer.from(await tgz.arrayBuffer()));
    await run('tar', ['-xzf', path.join(work, 'new.tgz'), '-C', path.join(work, 'new'), '--strip-components=1']);

    const src = path.join(work, 'new', 'src');
    if (!existsSync(path.join(src, 'index.js'))) throw new Error('the download did not contain src/index.js');
    for (const f of readdirSync(src).filter((n) => n.endsWith('.js'))) await run(process.execPath, ['--check', path.join(src, f)]); // refuse any file with a syntax error

    const lockChanged = read(path.join(work, 'new', 'package-lock.json')) !== read(path.join(APP, 'package-lock.json'));
    // Keep the current version so a bad one can be undone.
    rmSync(ROLLBACK, { recursive: true, force: true });
    mkdirSync(ROLLBACK, { recursive: true });
    cpSync(path.join(APP, 'src'), path.join(ROLLBACK, 'src'), { recursive: true });
    for (const f of FILES) if (existsSync(path.join(APP, f))) cpSync(path.join(APP, f), path.join(ROLLBACK, f));
    const prev = read(SHA_FILE);
    try {
      rmSync(path.join(APP, 'src'), { recursive: true, force: true });
      cpSync(src, path.join(APP, 'src'), { recursive: true });
      for (const f of FILES) if (existsSync(path.join(work, 'new', f))) cpSync(path.join(work, 'new', f), path.join(APP, f));
      // --ignore-scripts: a changed dependency list must not be able to run install scripts on this machine.
      if (lockChanged) await run('npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd: APP, timeout: 300_000 });
      await loadCheck();
    } catch (e) {
      restoreOld();
      if (lockChanged) await run('npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd: APP, timeout: 300_000 }).catch(() => {});
      writeFileSync(BAD_FILE, sha);
      throw new Error(`version ${sha.slice(0, 7)} failed its checks and was not installed (${String(e.message).split('\n')[0]})`);
    }
    writeFileSync(PENDING_FILE, JSON.stringify({ sha, prev, attempts: 0 }));

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
