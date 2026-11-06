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

/** Text found in one image (a Buffer), or '' if there's none or OCR isn't available. Never throws. */
export function readImageText(buf) {
  if (!OCR_ENABLED || !buf?.length || buf.length > MAX_IMAGE_BYTES) return Promise.resolve('');
  const job = queue.then(async () => {
    try {
      if (override) return cleanOcrText(await override(buf));
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
      return '';
    }
  });
  queue = job.catch(() => {});
  return job;
}
