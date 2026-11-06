// Dependency-free text similarity: normalise -> typo-fix -> TF-IDF -> cosine.
import { CATEGORIES } from './categories.js';
import { EXTRA_SYN, PROTECT, TERMS } from './lexicon.js';

const STOP = new Set((
  'a an the and or but if so of to in on at for with without from by is are was were be been am i me my we you it its this that these those ' +
  'when while then than there here have has had do does did not no dont cant wont just very really also can could would should will get got ' +
  'getting gets keep keeps game echo vr play playing played every time always sometimes ' +
  'want wanna need go going please pls plz help hi hello thanks thank im ive id some any anything something nothing percent happens happen'
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

// Strip common word endings so "connecting / connection / connected" and "installer / installing" meet in the middle.
const SUFFIXES = [['ations', 4], ['ation', 4], ['tions', 4], ['tion', 4], ['ments', 4], ['ment', 4], ['ness', 4], ['ings', 3], ['ing', 3],
  ['ers', 4], ['er', 4], ['ied', 3], ['ies', 3], ['ed', 3], ['es', 3], ['ly', 4], ['s', 3]];
function stem(w) {
  if (CANON.has(w)) return CANON.get(w);
  let s = w;
  for (const [suffix, minStem] of SUFFIXES) {
    if (w.endsWith(suffix) && w.length - suffix.length >= minStem) { s = w.slice(0, -suffix.length); break; }
  }
  return CANON.get(s) ?? s;
}

// Multi-word phrases players write in many ways -> one token each (applied before the text is split into words).
const PHRASES = [
  [/\bblack\s*screen\b/g, ' blackscreen '],
  [/\bgame\s*data\b/g, ' gamedata '],
  [/\b(log|sign)\s*(in|on)\b/g, ' login '],
  [/\bframe\s*rate\b/g, ' fps '],
  [/\brubber\s*band\w*/g, ' lag '],
  [/\b(?:will not|wo ?n ?t|doesn ?t|does not|do not|don ?t|did not|didn ?t|can ?not|can ?t|couldn ?t|unable to|fails? to|failed to|stopped)\s+(work|start|open|launch|load|run|install|update|connect|download|log ?in|join|hear|see)\w*/g, ' broken $1 '],
  [/\bnot\s+(working|responding|loading|starting|opening|launching|installing|updating|connecting|downloading)\b/g, ' broken '],
  [/\b(?:how|where|what)\s+(?:do|to|can|should)\s+(?:i|we|you)\b|\bhow\s+to\b|\bstep by step\b/g, ' howto '],
  [/\bstuck\s+(?:at|on|in)\b/g, ' stuck '],
  // everyday ways of saying the same thing
  [/\bsteam\s*vr\b/g, ' steamvr '],
  [/\bgame\s*files?\b/g, ' gamedata '],
  [/\b(?:is\s*n ?t|is not|are\s*n ?t|are not|not|no longer)\s+(?:moving|progressing|going anywhere)\b|\bno progress\b|\bnot budging\b/g, ' stuck '],
  [/\b(?:went|goes|go|gone|going)\s+away\b|\bdisappear\w*\b|\bvanish\w*\b/g, ' vanish '],
  [/\bpop ?ups?\b|\bdialog\b|\bprompt\b|\bmessage box\b|\bbox\b/g, ' popup '],
  [/\b(?:what ?s|whats)\s+the\s+(?:way|best way|easiest way)\s+to\b|\bways? to\b/g, ' howto '],
  [/\bget\b[^.]{0,25}\bonto\b/g, ' install '],
  [/\b(?:eats?|hogs?|hogging|uses?|using|drains?|draining|maxes?|maxing)\b(?=[^.]{0,20}\b(?:cpu|gpu|memory|ram|battery|resources?)\b)/g, ' usage '],
  [/\bnot\s+(?:playing|doing anything|in use|using it)\b|\bwhen\s+(?:i\s*m\s+)?(?:idle|doing nothing)\b|\beven when\b[^.]{0,20}\bnot\b/g, ' idle '],
  [/\b(?:cuts?|drops?|dropping|cutting|goes?)\s+out\b/g, ' dropout '],
  [/\bload(?:s|ing|ed)?\s+(?:in|into|onto)\b/g, ' join '],
];

/** Lower-case, remove apostrophes ("doesn't" -> "doesnt"), then collapse known phrases. */
function normalize(text) {
  let t = text.toLowerCase().replace(/['’`]/g, '');
  t = t.replace(/\b(wont|doesnt|dont|didnt|cant|couldnt|isnt|arent|wasnt)\b/g, (m) => ({ wont: 'wo n t', doesnt: 'doesn t', dont: 'don t', didnt: 'didn t', cant: 'can t', couldnt: 'couldn t', isnt: 'isn t', arent: 'aren t', wasnt: 'wasn t' }[m]));
  for (const [re, to] of PHRASES) t = t.replace(re, to);
  return t;
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

// Three reusable rows for the edit-distance calculation (no allocation per call). Words are capped well below this size.
const MAX_WORD = 48;
const rowA = new Int32Array(MAX_WORD + 2);
const rowB = new Int32Array(MAX_WORD + 2);
const rowC = new Int32Array(MAX_WORD + 2);

/** Optimal-string-alignment edit distance (counts a swap like "crahs" as 1). Stops early past `max`. */
function editDistance(a, b, max) {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev2 = rowA; let prev = rowB; let cur = rowC;
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= lb; j++) {
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1));
      if (i > 1 && j > 1 && a.charCodeAt(i - 1) === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1; // no way to get back under the limit
    const t = prev2; prev2 = prev; prev = cur; cur = t;
  }
  return prev[lb];
}

/** Group a vocabulary by word length, so a typo is only compared with words of about its own length. */
function bucketize(vocab) {
  const buckets = new Map();
  for (const w of vocab) {
    let b = buckets.get(w.length);
    if (!b) buckets.set(w.length, (b = []));
    b.push(w);
  }
  return buckets;
}
const KNOWN_BUCKETS = bucketize(KNOWN);

/** Map a token to the closest word in `vocab` (1 typo for 4-7 letters, 2 for 8+). Short/numeric tokens are left alone. */
function fuzzyMap(tok, vocab, buckets = vocab === KNOWN ? KNOWN_BUCKETS : bucketize(vocab)) {
  if (vocab.has(tok) || tok.length < 4 || tok.length > MAX_WORD || /\d/.test(tok)) return tok;
  const limit = tok.length >= 8 ? 2 : 1;
  let best = tok;
  let bestD = limit + 1;
  for (let len = tok.length - limit; len <= tok.length + limit; len++) {
    for (const v of buckets.get(len) ?? []) {
      if (PROTECTED.has(v) && vocab === KNOWN) continue;     // never correct towards ordinary words like "beta"/"patch"
      const dist = editDistance(tok, v, limit);
      if (dist >= bestD) continue;
      if (tok.length === 4 && !isSwap(tok, v)) continue;      // 4-letter words: only fix swapped letters ("pnig" -> "ping")
      bestD = dist;
      best = v;
    }
  }
  return best;
}

// The same words come up again and again across reports, so each word is spell-checked and stemmed once, not once per
// mention. Whole texts are remembered too (issue texts are re-read on every card, match and duplicate check).
const WORD_CACHE = new Map();
function canonWord(w) {
  let c = WORD_CACHE.get(w);
  if (c === undefined) {
    c = stem(fuzzyMap(stem(w), KNOWN)); // fix typos of known game/problem words, then canonicalise
    if (WORD_CACHE.size >= 30000) WORD_CACHE.clear();
    WORD_CACHE.set(w, c);
  }
  return c;
}
const TEXT_CACHE = new Map();
function unigrams(text) {
  const hit = TEXT_CACHE.get(text);
  if (hit) return hit;
  // Keep letters and numbers of ANY language (accented letters, Cyrillic, …) – only punctuation and symbols are dropped.
  const out = normalize(text).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
    .filter((w) => w && !STOP.has(w) && !/^\d$/.test(w)) // single digits ("quest 3") are noise; error codes like 78 stay
    .map(canonWord);
  if (TEXT_CACHE.size >= 3000) TEXT_CACHE.delete(TEXT_CACHE.keys().next().value); // drop the oldest
  TEXT_CACHE.set(text, out);
  return out;
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

/**
 * Every pair of documents that is at least `floor` alike, in ONE pass: an inverted index (word -> documents that use it)
 * means only documents sharing a word are ever compared, instead of ranking every document against every other.
 * Returns [{ a, b, score }] (a, b = doc ids), best first.
 */
export function similarPairs(docs, floor = 0.12) {
  const n = docs.length;
  if (n < 2) return [];
  const toks = docs.map((d) => withBigrams(unigrams(d.text)));
  const df = new Map();
  for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1);
  const idf = new Map([...df].map(([t, c]) => [t, Math.log(1 + n / c)]));
  const vecs = toks.map((t) => vectorize(t, idf));

  const postings = new Map();
  vecs.forEach((vec, i) => {
    for (const [t, w] of vec.v) {
      let p = postings.get(t);
      if (!p) postings.set(t, (p = []));
      p.push([i, w]);
    }
  });
  const dots = new Map(); // (i * n + j), i < j  ->  running dot product
  const tooCommon = Math.max(50, n / 2); // a word nearly everyone uses says little about two issues, and would make this slow
  for (const p of postings.values()) {
    if (p.length > tooCommon) continue;
    for (let x = 0; x < p.length; x++) {
      for (let y = x + 1; y < p.length; y++) {
        const key = p[x][0] * n + p[y][0];
        dots.set(key, (dots.get(key) ?? 0) + p[x][1] * p[y][1]);
      }
    }
  }
  const out = [];
  for (const [key, dot] of dots) {
    const i = Math.floor(key / n);
    const j = key % n;
    const score = dot / (vecs[i].norm * vecs[j].norm);
    if (score >= floor) out.push({ a: docs[i].id, b: docs[j].id, score });
  }
  return out.sort((x, y) => y.score - x.score);
}

/** docs: [{id, text}]. Returns [{id, score}] sorted best first. */
export function rankSimilar(query, docs) {
  if (!docs.length) return [];
  const docUni = docs.map((d) => unigrams(d.text));
  // Typos in the query that aren't domain words are snapped to the closest word used in existing issues.
  const docVocab = new Set(docUni.flat());
  let docBuckets = null; // only built if the query actually contains a word that needs checking
  const qUni = unigrams(query).map((t) => (KNOWN.has(t) || docVocab.has(t) ? t : fuzzyMap(t, docVocab, (docBuckets ??= bucketize(docVocab)))));
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
