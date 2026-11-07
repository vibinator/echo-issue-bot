// Reads the text in screenshots players attach, so error messages in an image can be matched against known fixes.
// It runs entirely on the bot's own server (tesseract.js, WebAssembly): images are never sent to any outside service.
// The English language data (~5 MB) is downloaded once on first use and cached in data/ocr; after that it works offline.
// If OCR isn't available (library missing, no network on first run, OCR=off) every function quietly returns '' – reporting
// never depends on it.
import path from 'node:path';

export const OCR_ENABLED = process.env.OCR !== 'off';
const CACHE_DIR = process.env.OCR_CACHE_DIR ?? path.join('data', 'ocr');
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 60_000;
const IDLE_MS = 5 * 60_000; // free the engine's memory when nobody has sent a screenshot for a while
const MAX_CHARS = 2000;
const MAX_PIXELS = 25_000_000; // a small file can unpack to a gigantic picture; refuse those before the engine sees them

/** Width x height read from the file header (PNG, JPEG, BMP, WebP-VP8X), or 0 when unknown. */
export function pixelsOf(b) {
  try {
    if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return b.readUInt32BE(16) * b.readUInt32BE(20);
    if (b.length > 26 && b[0] === 0x42 && b[1] === 0x4d) return Math.abs(b.readInt32LE(18)) * Math.abs(b.readInt32LE(22));
    if (b.length > 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
      if (b.toString('latin1', 12, 16) === 'VP8X') return (1 + b.readUIntLE(24, 3)) * (1 + b.readUIntLE(27, 3));
      return 0;
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
      for (let p = 2; p + 9 < b.length;) {
        if (b[p] !== 0xff) { p++; continue; }
        const m = b[p + 1];
        if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return b.readUInt16BE(p + 5) * b.readUInt16BE(p + 7);
        p += 2 + b.readUInt16BE(p + 2);
      }
    }
  } catch { /* truncated header */ }
  return 0;
}

let override = null; // tests plug in a fake reader here
export const setRecognizer = (fn) => { override = fn; };

let workerPromise = null;
let idleTimer = null;
let queue = Promise.resolve(); // one image at a time: OCR is CPU-heavy and a NAS is small
let warned = false;

async function getWorker() {
  workerPromise ??= (async () => {
    const { createWorker } = await import('tesseract.js');
    return createWorker('eng', 1, { cachePath: CACHE_DIR, logger: () => {} });
  })().catch((e) => { workerPromise = null; throw e; });
  return workerPromise;
}

async function stopWorker() {
  const p = workerPromise; workerPromise = null;
  try { await (await p)?.terminate(); } catch { /* already gone */ }
}

/** Keep the readable lines of OCR output: drop lines that are mostly symbols (icons, borders), squash blank space. */
export function cleanOcrText(raw = '') {
  const lines = String(raw).split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => {
    if (l.length < 3) return false;
    const letters = (l.match(/[\p{L}\p{N}]/gu) ?? []).length;
    return letters / l.length >= 0.5;
  });
  return lines.join('\n').slice(0, MAX_CHARS);
}

/**
 * Text found in one image (a Buffer): '' when the image has no readable text (or is not safe to read), and null when OCR could
 * not run at all (switched off, engine or language data unavailable) so the caller does not record that as "nothing found".
 * Never throws.
 */
export function readImageText(buf) {
  if (!OCR_ENABLED) return Promise.resolve(null);
  if (!buf?.length || buf.length > MAX_IMAGE_BYTES) return Promise.resolve('');
  const job = queue.then(async () => {
    try {
      if (override) return cleanOcrText(await override(buf));
      const px = pixelsOf(buf);
      if (!px || px > MAX_PIXELS) return '';
      const worker = await getWorker();
      const { data } = await Promise.race([
        worker.recognize(buf),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), TIMEOUT_MS)),
      ]);
      clearTimeout(idleTimer);
      idleTimer = setTimeout(stopWorker, IDLE_MS); idleTimer.unref?.();
      return data.confidence >= 30 ? cleanOcrText(data.text) : ''; // very low confidence = it was a photo / art, not text
    } catch (e) {
      if (!warned) { warned = true; console.error(`Screenshot text reading is unavailable (${e.message}). Reports still work normally.`); }
      await stopWorker();
      return null;
    }
  });
  queue = job.catch(() => {});
  return job;
}
