// Meaning-based matching ("embeddings") that works alongside the word-based matcher in kb.js.
//
// A small sentence model (all-MiniLM-L6-v2, ~23 MB, runs on the CPU) turns text into a vector; two texts that mean the same
// thing end up close together even when they share no words ("my hands stop moving" ~ "controllers not tracking").
// It is strictly an add-on: if the model can't load (no internet on first start, unsupported CPU, EMBEDDINGS=off) every
// function here quietly returns nothing and the bot keeps matching by words exactly as before.
import os from 'node:os';
import path from 'node:path';
import { KB } from './kb.js';

const OFF = /^(off|0|false|no)$/i.test(process.env.EMBEDDINGS ?? '');
const MODEL = process.env.EMBED_MODEL || 'Xenova/all-MiniLM-L6-v2';
const DB_PATH = process.env.DB_PATH ?? 'data/issues.db';
const CACHE_DIR = process.env.EMBED_CACHE_DIR || (DB_PATH === ':memory:' ? path.join(os.tmpdir(), 'evr-models') : path.join(path.dirname(DB_PATH), 'models'));
const RETRY_MS = 3_600_000; // after a failed load, try again in an hour

let embedder = null;        // (texts: string[]) => Promise<number[][]> of unit vectors
let loading = null;
let failedAt = 0;
let override = false;

/** Tests (and anyone who wants another model) can supply their own embedder. */
export function setEmbedder(fn) { embedder = fn; override = !!fn; loading = null; failedAt = 0; vecCache.clear(); queryCache.clear(); }

export const embeddingsReady = () => !!embedder;

async function load() {
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = CACHE_DIR;
  env.allowLocalModels = true;
  const pipe = await pipeline('feature-extraction', MODEL, { dtype: 'q8' });
  embedder = async (texts) => (await pipe(texts, { pooling: MODEL.includes('bge') ? 'cls' : 'mean', normalize: true })).tolist();
}

/** Start loading the model in the background (once). Resolves to true when it is ready. Never throws. */
export function warmEmbeddings() {
  if (OFF && !override) return Promise.resolve(false);
  if (embedder) return Promise.resolve(true);
  if (loading) return loading;
  if (failedAt && Date.now() - failedAt < RETRY_MS) return Promise.resolve(false);
  loading = load().then(() => { console.log(`Meaning-based matching is on (${MODEL}).`); return true; })
    .catch((e) => { failedAt = Date.now(); console.warn(`Meaning-based matching is off (${e.message}); matching by words only.`); return false; })
    .finally(() => { loading = null; });
  return loading;
}

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const vecCache = new Map();   // "a:12" | "kb:gpu_hang" -> { sig, vecs }
const queryCache = new Map(); // recent query text -> vector

async function embedOne(text) {
  const key = text.slice(0, 600);
  if (queryCache.has(key)) return queryCache.get(key);
  const [v] = await embedder([key]);
  queryCache.set(key, v);
  if (queryCache.size > 200) queryCache.delete(queryCache.keys().next().value);
  return v;
}

/** The short pieces of an article that get their own vector: its title, each "how players describe it" line, and what linked issues taught it. */
function linesOf(a) {
  const lines = [a.title, ...(a.symptoms ?? '').split('\n')];
  const learned = (a.linked_text ?? '').trim();
  for (let i = 0; i < Math.min(learned.length, 1200); i += 300) lines.push(learned.slice(i, i + 300));
  return [...new Set(lines.map((l) => l.trim()).filter((l) => l.length >= 3))].slice(0, 14);
}

async function vectorsFor(id, lines) {
  const sig = lines.join('\n');
  const hit = vecCache.get(id);
  if (hit?.sig === sig) return hit.vecs;
  const vecs = await embedder(lines);
  vecCache.set(id, { sig, vecs });
  return vecs;
}

/**
 * How close in meaning is `text` to each answer? Returns Map(id -> cosine 0..1) using the same ids as suggest()
 * ("a:12" for server articles, "kb:id" for built-in answers). Empty when the model isn't ready, so callers never wait on it.
 */
export async function semanticScores(text, custom = []) {
  const out = new Map();
  try {
    if (!embedder) { warmEmbeddings(); return out; }
    const q = text.trim();
    if (q.length < 4) return out;
    const qv = await embedOne(q);
    const score = async (id, lines) => { const vs = await vectorsFor(id, lines); out.set(id, Math.max(...vs.map((v) => dot(v, qv)))); };
    for (const e of KB) await score(`kb:${e.id}`, linesOf({ title: e.title, symptoms: e.symptoms }));
    for (const a of custom) await score(`a:${a.id}`, linesOf(a));
  } catch (e) { console.warn('Meaning-based matching failed for one request:', e.message); out.clear(); }
  return out;
}
