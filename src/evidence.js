// Helpers for report evidence: links and uploaded files (screenshots, logs, videos).
export const KIND_EMOJI = { image: '🖼️', video: '🎥', log: '📄', file: '📎', link: '🔗' };

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

/** Pull up to `max` unique http(s) URLs out of free text. */
export function extractLinks(text = '', max = 5) {
  const out = [];
  for (const raw of text.match(URL_RE) ?? []) {
    const cleaned = raw.replace(/[.,;:!?)\]}]+$/, '');
    try {
      const u = new URL(cleaned);
      if (!['http:', 'https:'].includes(u.protocol)) continue;
      if (!out.includes(u.href)) out.push(u.href);
    } catch { /* not a URL */ }
    if (out.length >= max) break;
  }
  return out;
}

/** image | video | log | file, from an uploaded file's name / MIME type. */
export function kindOfFile(name = '', type = '') {
  const t = type.toLowerCase();
  if (t.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(name)) return 'image';
  if (t.startsWith('video/') || /\.(mp4|mov|webm|mkv|avi)$/i.test(name)) return 'video';
  if (/\.(log|txt|json|ya?ml|csv|dmp|dump|zip|7z|rar)$/i.test(name) || t.startsWith('text/')) return 'log';
  return 'file';
}

/** image | video | link, guessed from the URL. */
export function kindOfLink(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (/(^|\.)(youtube\.com|youtu\.be|streamable\.com|medal\.tv|twitch\.tv|vimeo\.com)$/.test(host) || /\.(mp4|mov|webm)$/i.test(u.pathname)) return 'video';
    if (/(^|\.)(imgur\.com|prnt\.sc|gyazo\.com|prntscr\.com)$/.test(host) || /\.(png|jpe?g|gif|webp)$/i.test(u.pathname)) return 'image';
    if (/(^|\.)(pastebin\.com|gist\.github\.com|hastebin\.com)$/.test(host) || /\.(log|txt)$/i.test(u.pathname)) return 'log';
  } catch { /* ignore */ }
  return 'link';
}

/** Short readable label for a link. */
export function linkName(url) {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname;
    const s = `${u.hostname.replace(/^www\./, '')}${path}`;
    return s.length > 40 ? `${s.slice(0, 39)}…` : s;
  } catch { return url.slice(0, 40); }
}
