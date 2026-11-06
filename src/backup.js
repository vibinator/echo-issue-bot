import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { BACKUP_DIR, db } from './db.js';

const DIR = BACKUP_DIR;
const KEEP = 168; // hourly backups: one week of history
const EVERY_MS = 55 * 60_000; // a little under an hour, so the hourly check never skips one because of timing jitter

const files = () => { mkdirSync(DIR, { recursive: true }); return readdirSync(DIR).filter((f) => f.endsWith('.db')).sort(); };

/** Consistent snapshot of the live database (safe while the bot is running). */
export function backupNow() {
  mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `issues-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const all = files();
  for (const f of all.slice(0, Math.max(0, all.length - KEEP))) rmSync(path.join(DIR, f));
  return file;
}

/** Back up if the newest backup is about an hour old (called every hour). Returns the file or null. */
export function maybeBackup() {
  const latest = files().at(-1);
  if (latest && Date.now() - statSync(path.join(DIR, latest)).mtimeMs < EVERY_MS) return null;
  return backupNow();
}
