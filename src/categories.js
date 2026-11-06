// Keyword-based categories tuned for Echo VR. Highest score wins.
export const CATEGORIES = {
  'Install / Setup':        ['install', 'installer', 'uninstall', 'apk', 'sideload', 'download', 'game data', 'launcher', 'package installer', 'unknown sources'],
  'Crash / Freeze':         ['crash', 'freeze', 'hang', 'black screen', 'not responding', 'closes', 'quits'],
  'Network / Lag':          ['lag', 'ping', 'latency', 'rubberband', 'desync', 'packet', 'disconnect', 'timeout', 'connection', 'server'],
  'Matchmaking / Lobby':    ['matchmaking', 'queue', 'lobby', 'match', 'party', 'spectate', 'private match', 'region'],
  'Login / Account':        ['login', 'log in', 'sign in', 'account', 'oculus', 'meta', 'auth', 'banned', 'password', 'config'],
  'Controls / Input':       ['controller', 'input', 'tracking', 'grab', 'throw', 'boost', 'drift', 'stick', 'haptic'],
  'Audio / Voice':          ['audio', 'sound', 'voice', 'mic', 'microphone', 'mute', 'volume'],
  'Graphics / Performance': ['fps', 'frame', 'stutter', 'graphics', 'resolution', 'texture', 'flicker', 'performance', 'gpu', 'visual'],
  'UI / Menus':             ['menu', 'ui', 'button', 'screen', 'settings', 'text', 'scoreboard', 'layout'],
  'Gameplay / Bugs':        ['goal', 'disc', 'score', 'arena', 'combat', 'map', 'stuck', 'glitch', 'clip', 'respawn', 'bug'],
  'Cosmetics / Store':      ['cosmetic', 'store', 'purchase', 'skin', 'emote', 'decal', 'unlock', 'currency'],
};

export const INSTALL_CATEGORY = 'Install / Setup';

/** `exclude`: categories that must not be picked (e.g. game bugs are never "Install / Setup"). */
export function detectCategory(text, exclude = []) {
  const t = text.toLowerCase();
  let best = 'Other';
  let bestScore = 0;
  for (const [cat, words] of Object.entries(CATEGORIES)) {
    if (exclude.includes(cat)) continue;
    const score = words.reduce((s, w) => s + (t.includes(w) ? 1 : 0), 0);
    if (score > bestScore) { best = cat; bestScore = score; }
  }
  return best;
}
