/**
 * Shorten text to at most `n` characters, ending with "…". Never cuts an emoji (a surrogate pair) in half, which Discord
 * rejects as invalid text and would stop a card or message from being sent.
 */
export function trunc(s, n) {
  const text = String(s ?? '');
  if (text.length <= n) return text;
  let end = n - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1; // the cut would land between the two halves of an emoji
  return `${text.slice(0, end)}…`;
}
