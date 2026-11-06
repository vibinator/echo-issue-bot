// The bot's version: the number in package.json plus the short code id (set by the auto-updater, or read from git when run from a checkout).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => { try { return readFileSync(f, 'utf8').trim(); } catch { return ''; } };

export const VERSION = (() => { try { return JSON.parse(read(path.join(APP, 'package.json'))).version || '0.0.0'; } catch { return '0.0.0'; } })();

const dataDir = path.resolve(path.dirname(process.env.DB_PATH && process.env.DB_PATH !== ':memory:' ? process.env.DB_PATH : 'data/x'));
export const BUILD = (() => {
  const sha = read(path.join(dataDir, '.code_sha'));
  if (/^[0-9a-f]{40}$/.test(sha)) return sha.slice(0, 7);
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: APP, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; }
})();

export const versionLabel = () => `v${VERSION}${BUILD ? ` (${BUILD})` : ''}`;
