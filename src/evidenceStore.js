// Private storage for files players attach to a report (screenshots, logs, video).
// Files are saved on the server running the bot – never posted in a channel or thread – and are only handed back
// to the person who sent them and to developers (the bot checks that every time, see index.js).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const EVIDENCE_DIR = process.env.EVIDENCE_DIR ?? path.join('data', 'evidence');
// 10 MB by default = what Discord lets the bot send back in one message, so a stored file can always be shown again.
export const MAX_FILE_MB = Number(process.env.EVIDENCE_MAX_MB) || 10;
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;
/** All stored evidence together may not use more than this (stops anyone filling the disk). */
export const MAX_TOTAL_MB = Number(process.env.EVIDENCE_MAX_TOTAL_MB) || 5000;
/** Programs and scripts are never stored: developers open these files, and they are no use as evidence. */
const BLOCKED_TYPES = /\.(exe|dll|msi|bat|cmd|com|scr|ps1|psm1|vbs|vbe|js|jse|wsf|jar|lnk|hta|reg|apk|sh|appimage|iso|dmg)$/i;

// Attachments in interactions always come from Discord's CDN; refuse anything else.
const DISCORD_HOST = /(^|\.)(discordapp\.com|discordapp\.net|discord\.com|discordcdn\.com)$/i;

/** Bytes already stored (walks the evidence folder; evidence is small enough that this is quick). */
export function usedBytes(dir = EVIDENCE_DIR) {
  let total = 0;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      total += e.isDirectory() ? usedBytes(p) : statSync(p).size;
    }
  } catch { /* folder not created yet */ }
  return total;
}

const safeName = (name) => String(name).replace(/[^A-Za-z0-9._-]/g, '_').slice(-80) || 'file';

/** Download one attachment into the private folder of a report. Returns its path relative to EVIDENCE_DIR. */
export async function saveFromUrl(reportId, index, file) {
  const url = new URL(file.url);
  if (url.protocol !== 'https:' || !DISCORD_HOST.test(url.hostname)) throw new Error('not a Discord attachment');
  if (BLOCKED_TYPES.test(String(file.name))) throw new Error('file type not allowed');
  if (file.size && file.size > MAX_FILE_BYTES) throw new Error('too large');
  if (usedBytes() + (file.size || 0) > MAX_TOTAL_MB * 1024 * 1024) throw new Error('storage full');
  // redirect: 'manual' – the host check above must not be sidestepped by a redirect to somewhere else.
  const res = await fetch(file.url, { redirect: 'manual', signal: AbortSignal.timeout(90_000) });
  if (res.status >= 300 && res.status < 400) throw new Error(`download failed (${res.status})`);
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const declared = Number(res.headers.get('content-length'));
  if (declared && declared > MAX_FILE_BYTES) throw new Error('too large');
  let data;
  if (res.body?.getReader) { // read in pieces and stop as soon as the limit is passed, instead of buffering an unknown amount
    const chunks = [];
    let got = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (got > MAX_FILE_BYTES) { await reader.cancel().catch(() => {}); throw new Error('too large'); }
      chunks.push(value);
    }
    data = Buffer.concat(chunks);
  } else data = Buffer.from(await res.arrayBuffer());
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

/** Size in bytes of a stored file, or null if it is missing (or the path tries to leave the evidence folder). */
export function storedSize(rel) {
  const root = path.resolve(EVIDENCE_DIR);
  const abs = path.resolve(root, rel);
  try { return abs.startsWith(root + path.sep) ? statSync(abs).size : null; } catch { return null; }
}

/** Delete every stored file of a report. */
export function removeReportFiles(reportId) {
  rmSync(path.join(EVIDENCE_DIR, String(reportId)), { recursive: true, force: true });
}
