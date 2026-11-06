// Dependency-free text similarity: normalise -> typo-fix -> TF-IDF -> cosine.
import { CATEGORIES } from './categories.js';
import { EXTRA_SYN, PROTECT, TERMS } from './lexicon.js';

const STOP = new Set((
  'a an the and or but if so of to in on at for with without from by is are was were be been am i me my we you it its this that these those ' +
  'when while then than there here have has had do does did not no dont cant wont just very really also can could would should will get got ' +
  'getting gets keep keeps game echo vr play playing played every time always sometimes'
).split(' '));

// Different words players use for the same thing -> one canonical token.
const SYN = {
  crash: ['crashes', 'crashed', 'crashing', 'freeze', 'froze', 'frozen', 'freezes', 'hang', 'hangs', 'closes', 'closed', 'quits'],
  lag: ['laggy', 'lagging', 'latency', 'ping', 'rubberband', 'rubberbanding', 'desync', 'stutter', 'stuttering'],
  disconnect: ['disconnects', 'disconnected', 'dropped', 'drops', 'kicked', 'timeout', 'timeouts'],
  mic: ['microphone', 'voice', 'vc'],
  sound: ['audio', 'noise'],
  login: ['signin', 'authenticate', 'authentication', 'auth'],
  controller: ['controllers', 'touch', 'joystick', 'stick'],
  fps: ['framerate', 'frames', 'frame'],
  match: ['matchmaking', 'lobby', 'queue', 'queueing'],
};
const CANON = new Map();
for (const [c, ws] of Object.entries(SYN)) for (const w of ws) CANON.set(w, c);
for (const [c, ws] of Object.entries(EXTRA_SYN)) for (const w of ws) CANON.set(w, c);

function stem(w) {
  if (CANON.has(w)) return CANON.get(w);
  const s = w.replace(/(ing|ed|es|s)$/, (m) => (w.length - m.length >= 3 ? '' : m));
  return CANON.get(s) ?? s;
}

// ---- fuzzy (typo-tolerant) matching ----
// Domain vocabulary: words we can confidently correct typos towards.
const KNOWN = new Set();
for (const w of [
  ...Object.keys(SYN), ...Object.values(SYN).flat(), ...Object.keys(EXTRA_SYN), ...Object.values(EXTRA_SYN).flat(),
  ...Object.values(CATEGORIES).flat(), ...TERMS, ...PROTECT,
]) {
  if (!w.includes(' ')) { KNOWN.add(w); KNOWN.add(stem(w)); }
}
// Listed words are protected from being "corrected" into something else, but must not be correction TARGETS
// for unrelated typos either, so keep PROTECT words out of the pool the fuzzy matcher searches.
const PROTECTED = new Set(PROTECT);
const isSwap = (a, b) => a.length === b.length && [...a].sort().join('') === [...b].sort().join('');

/** Optimal-string-alignment edit distance (counts a swap like "crahs" as 1). Stops early past `max`. */
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** Map a token to the closest word in `vocab` (1 typo for 4-7 letters, 2 for 8+). Short/numeric tokens are left alone. */
function fuzzyMap(tok, vocab) {
  if (vocab.has(tok) || tok.length < 4 || /\d/.test(tok)) return tok;
  const limit = tok.length >= 8 ? 2 : 1;
  let best = tok;
  let bestD = limit + 1;
  for (const v of vocab) {
    if (PROTECTED.has(v) && vocab === KNOWN) continue;     // never correct towards ordinary words like "beta"/"patch"
    const dist = editDistance(tok, v, limit);
    if (dist >= bestD) continue;
    if (tok.length === 4 && !isSwap(tok, v)) continue;      // 4-letter words: only fix swapped letters ("pnig" -> "ping")
    bestD = dist;
    best = v;
  }
  return best;
}

function unigrams(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .map(stem)
    .map((t) => stem(fuzzyMap(t, KNOWN))); // fix typos of known game/problem words, then canonicalise
}

const withBigrams = (uni) => {
  const out = [...uni];
  for (let i = 0; i < uni.length - 1; i++) out.push(`${uni[i]}_${uni[i + 1]}`);
  return out;
};

export const tokenize = (text) => withBigrams(unigrams(text));

function vectorize(tokens, idf) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  const v = new Map();
  let norm = 0;
  for (const [t, c] of tf) {
    const bigramPenalty = t.includes('_') ? 0.5 : 1;
    const w = (1 + Math.log(c)) * (idf.get(t) ?? 1) * bigramPenalty;
    v.set(t, w);
    norm += w * w;
  }
  return { v, norm: Math.sqrt(norm) || 1 };
}

function cosine(a, b) {
  let dot = 0;
  const [s, l] = a.v.size < b.v.size ? [a, b] : [b, a];
  for (const [t, w] of s.v) {
    const o = l.v.get(t);
    if (o) dot += w * o;
  }
  return dot / (a.norm * b.norm);
}

/** docs: [{id, text}]. Returns [{id, score}] sorted best first. */
export function rankSimilar(query, docs) {
  if (!docs.length) return [];
  const docUni = docs.map((d) => unigrams(d.text));
  // Typos in the query that aren't domain words are snapped to the closest word used in existing issues.
  const docVocab = new Set(docUni.flat());
  const qUni = unigrams(query).map((t) => (KNOWN.has(t) ? t : fuzzyMap(t, docVocab)));
  const docTokens = docUni.map(withBigrams);
  const qTokens = withBigrams(qUni);
  const df = new Map();
  for (const toks of [...docTokens, qTokens]) for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  const N = docs.length + 1;
  const idf = new Map([...df].map(([t, c]) => [t, Math.log(1 + N / c)]));
  const q = vectorize(qTokens, idf);
  return docs
    .map((d, i) => ({ id: d.id, score: cosine(q, vectorize(docTokens[i], idf)) }))
    .sort((a, b) => b.score - a.score);
}
