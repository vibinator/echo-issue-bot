// Private storage for files players attach to a report (screenshots, logs, video).
// Files are saved on the server running the bot – never posted in a channel or thread – and are only handed back
// to the person who sent them and to developers (the bot checks that every time, see index.js).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const EVIDENCE_DIR = process.env.EVIDENCE_DIR ?? path.join('data', 'evidence');
export const MAX_FILE_MB = Number(process.env.EVIDENCE_MAX_MB) || 25;
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;

// Attachments in interactions always come from Discord's CDN; refuse anything else.
const DISCORD_HOST = /(^|\.)(discordapp\.com|discordapp\.net|discord\.com|discordcdn\.com)$/i;

const safeName = (name) => String(name).replace(/[^A-Za-z0-9._-]/g, '_').slice(-80) || 'file';

/** Download one attachment into the private folder of a report. Returns its path relative to EVIDENCE_DIR. */
export async function saveFromUrl(reportId, index, file) {
  const url = new URL(file.url);
  if (url.protocol !== 'https:' || !DISCORD_HOST.test(url.hostname)) throw new Error('not a Discord attachment');
  if (file.size && file.size > MAX_FILE_BYTES) throw new Error('too large');
  const res = await fetch(file.url, { signal: AbortSignal.timeout(90_000) });
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const declared = Number(res.headers.get('content-length'));
  if (declared && declared > MAX_FILE_BYTES) throw new Error('too large');
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > MAX_FILE_BYTES) throw new Error('too large');

  const rel = `${reportId}/${index}-${safeName(file.name)}`;
  const abs = path.join(EVIDENCE_DIR, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, data);
  return rel;
}

/** Read a stored file back (null if missing, or if the path tries to leave the evidence folder). */
export function readStored(rel) {
  const root = path.resolve(EVIDENCE_DIR);
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep) || !existsSync(abs)) return null;
  return readFileSync(abs);
}

/** Delete every stored file of a report. */
export function removeReportFiles(reportId) {
  rmSync(path.join(EVIDENCE_DIR, String(reportId)), { recursive: true, force: true });
}
