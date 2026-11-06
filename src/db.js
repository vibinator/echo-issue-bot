import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';

const DB_PATH = process.env.DB_PATH ?? 'data/issues.db';
/** Where backups go. Point this at a different folder/share than the database so one accident can't take both. */
export const BACKUP_DIR = process.env.BACKUP_DIR ?? path.join('data', 'backups');

mkdirSync(path.dirname(DB_PATH) === '.' ? 'data' : path.dirname(DB_PATH), { recursive: true });

// Self-healing: if the database file is gone (folder deleted, new volume…) but a backup survives, restore the
// newest backup before opening, so everything – issues, reports, articles, settings, panel/thread ids – comes back.
export let restoredFrom = null;
if (DB_PATH !== ':memory:' && !existsSync(DB_PATH) && existsSync(BACKUP_DIR)) {
  const newest = readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.db')).sort().at(-1);
  if (newest) {
    copyFileSync(path.join(BACKUP_DIR, newest), DB_PATH);
    restoredFrom = newest;
    console.log(`Database was missing – restored from backup ${newest}`);
  }
}

export const db = new DatabaseSync(DB_PATH);

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  guild_id TEXT PRIMARY KEY, channel_id TEXT, dev_role_id TEXT
);
CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  dev_note TEXT,
  handled_by TEXT,
  channel_id TEXT, message_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL REFERENCES issues(id),
  user_id TEXT NOT NULL,
  text TEXT NOT NULL,
  platform TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dup_decisions (
  guild_id TEXT NOT NULL, a INTEGER NOT NULL, b INTEGER NOT NULL, PRIMARY KEY (guild_id, a, b)
);
CREATE TABLE IF NOT EXISTS evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL,
  report_id INTEGER,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  channel_id TEXT, message_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS watchers (
  issue_id INTEGER NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (issue_id, user_id)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL, kind TEXT NOT NULL, actor_id TEXT, detail TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_issue ON events(issue_id);
CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  title TEXT NOT NULL,
  symptoms TEXT NOT NULL,        -- how players describe it (fuzzy matched)
  phrases TEXT,                  -- exact error text, one per line (always matches)
  body TEXT NOT NULL,            -- the answer
  link TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kb_stats (
  guild_id TEXT NOT NULL, article_id TEXT NOT NULL,
  shown INTEGER NOT NULL DEFAULT 0, helped INTEGER NOT NULL DEFAULT 0,
  denied INTEGER NOT NULL DEFAULT 0, filed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, article_id)
);
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id TEXT PRIMARY KEY, dm_off INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_evidence_issue ON evidence(issue_id);
CREATE INDEX IF NOT EXISTS idx_issues_guild ON issues(guild_id, status);
CREATE INDEX IF NOT EXISTS idx_reports_issue ON reports(issue_id);
`);

// Lightweight migrations so databases created by older versions keep working.
function addColumn(table, col, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}
addColumn('issues', 'priority', "TEXT NOT NULL DEFAULT 'normal'");
addColumn('issues', 'owner_id', 'TEXT');
addColumn('issues', 'fixed_version', 'TEXT');
addColumn('issues', 'fixed_at', 'INTEGER');
addColumn('issues', 'thread_id', 'TEXT');
addColumn('issues', 'kind', "TEXT NOT NULL DEFAULT 'bug'"); // 'install' (install issue) | 'bug' (bug in game)
addColumn('reports', 'version', 'TEXT');
addColumn('settings', 'dev_channel_id', 'TEXT');
addColumn('settings', 'changelog_channel_id', 'TEXT');
addColumn('settings', 'threshold', 'REAL NOT NULL DEFAULT 0.25');
addColumn('settings', 'stale_days', 'INTEGER NOT NULL DEFAULT 7');
addColumn('settings', 'cooldown_sec', 'INTEGER NOT NULL DEFAULT 60');
addColumn('settings', 'last_digest', 'INTEGER');
addColumn('settings', 'reporter_role_id', 'TEXT');
addColumn('settings', 'status_role_id', 'TEXT');
addColumn('settings', 'board_channel_id', 'TEXT');
addColumn('settings', 'board_message_id', 'TEXT');
addColumn('reports', 'edited_at', 'INTEGER');
addColumn('evidence', 'path', 'TEXT'); // uploaded files live in the private evidence folder; this is their relative path
addColumn('settings', 'article_role_id', 'TEXT');    // can manage knowledge articles without being a full developer
addColumn('settings', 'panel_channel_id', 'TEXT');   // the one public control-panel message
addColumn('settings', 'panel_message_id', 'TEXT');
addColumn('settings', 'retention_days', 'INTEGER NOT NULL DEFAULT 0'); // 0 = keep closed issues until deleted by hand

const now = () => Date.now();
const SETTING_KEYS = ['dev_channel_id', 'changelog_channel_id', 'threshold', 'stale_days', 'cooldown_sec', 'last_digest', 'reporter_role_id', 'status_role_id', 'board_channel_id', 'board_message_id', 'retention_days', 'article_role_id', 'panel_channel_id', 'panel_message_id'];

/** What is stored for a server – shown after /setup so you can see nothing was lost. */
export const summary = (guild) => ({
  issues: db.prepare('SELECT COUNT(*) AS n FROM issues WHERE guild_id = ?').get(guild).n,
  reports: db.prepare('SELECT COUNT(*) AS n FROM reports r JOIN issues i ON i.id = r.issue_id WHERE i.guild_id = ?').get(guild).n,
  articles: db.prepare('SELECT COUNT(*) AS n FROM articles WHERE guild_id = ?').get(guild).n,
});

export const settings = {
  get: (g) => db.prepare('SELECT * FROM settings WHERE guild_id = ?').get(g),
  all: () => db.prepare('SELECT * FROM settings').all(),
  set: (g, channel, role) => db.prepare(
    `INSERT INTO settings (guild_id, channel_id, dev_role_id) VALUES (?, ?, ?)
     ON CONFLICT(guild_id) DO UPDATE SET channel_id = excluded.channel_id, dev_role_id = excluded.dev_role_id`
  ).run(g, channel, role),
  update: (g, patch) => {
    for (const [k, v] of Object.entries(patch)) {
      if (!SETTING_KEYS.includes(k)) throw new Error(`Unknown setting ${k}`);
      db.prepare(`UPDATE settings SET ${k} = ? WHERE guild_id = ?`).run(v, g);
    }
  },
};

export const issues = {
  get: (id) => db.prepare('SELECT * FROM issues WHERE id = ?').get(id),
  create: (guild, title, category, priority = 'normal', kind = 'bug') => Number(db.prepare(
    'INSERT INTO issues (guild_id, title, category, priority, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(guild, title, category, priority, kind, now(), now()).lastInsertRowid),
  /** owner: undefined = anyone, 'none' = unassigned, otherwise a user id. Sorted by priority, then affected players. */
  list: (guild, { status, category, owner } = {}) => {
    let sql = `SELECT i.*, (SELECT COUNT(DISTINCT user_id) FROM reports r WHERE r.issue_id = i.id) AS reporters
               FROM issues i WHERE guild_id = ?`;
    const args = [guild];
    if (status) { sql += ' AND status = ?'; args.push(status); }
    if (category) { sql += ' AND category = ?'; args.push(category); }
    if (owner === 'none') sql += ' AND owner_id IS NULL';
    else if (owner) { sql += ' AND owner_id = ?'; args.push(owner); }
    return db.prepare(
      `${sql} ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
       reporters DESC, updated_at DESC`
    ).all(...args);
  },
  /** Issues with all report text concatenated, for similarity matching. `kind` limits it to install issues or game bugs. */
  withText: (guild, kind = null) => db.prepare(
    `SELECT i.id, i.title || ' ' || COALESCE(GROUP_CONCAT(r.text, ' '), '') AS text
     FROM issues i LEFT JOIN reports r ON r.issue_id = i.id WHERE i.guild_id = ? AND (? IS NULL OR i.kind = ?) GROUP BY i.id`
  ).all(guild, kind, kind),
  /** Like withText, but one report's text is left out (used to re-check where that report belongs). */
  withTextExcluding: (guild, reportId, kind = null) => db.prepare(
    `SELECT i.id, i.title || ' ' || COALESCE(GROUP_CONCAT(r.text, ' '), '') AS text
     FROM issues i LEFT JOIN reports r ON r.issue_id = i.id AND r.id != ? WHERE i.guild_id = ? AND (? IS NULL OR i.kind = ?) GROUP BY i.id`
  ).all(reportId, guild, kind, kind),
  setStatus: (id, status, userId, fixedVersion) => {
    db.prepare('UPDATE issues SET status = ?, handled_by = COALESCE(?, handled_by), updated_at = ? WHERE id = ?')
      .run(status, userId, now(), id);
    if (status === 'fixed') {
      db.prepare('UPDATE issues SET fixed_at = ?, fixed_version = COALESCE(?, fixed_version) WHERE id = ?')
        .run(now(), fixedVersion || null, id);
    }
  },
  setPriority: (id, p, userId) => db.prepare('UPDATE issues SET priority = ?, handled_by = ?, updated_at = ? WHERE id = ?').run(p, userId, now(), id),
  setOwner: (id, owner) => db.prepare('UPDATE issues SET owner_id = ?, updated_at = ? WHERE id = ?').run(owner, now(), id),
  setNote: (id, note, userId) => db.prepare(
    'UPDATE issues SET dev_note = ?, handled_by = ?, updated_at = ? WHERE id = ?'
  ).run(note, userId, now(), id),
  setMessage: (id, channel, message) => db.prepare('UPDATE issues SET channel_id = ?, message_id = ? WHERE id = ?').run(channel, message, id),
  setTitle: (id, title) => db.prepare('UPDATE issues SET title = ? WHERE id = ?').run(title, id),
  /** Closed issues with no activity since `ts` (for the optional retention clean-up). */
  closedBefore: (guild, ts) => db.prepare(
    "SELECT * FROM issues WHERE guild_id = ? AND status IN ('fixed', 'wont_fix', 'cannot_reproduce') AND updated_at < ?"
  ).all(guild, ts),
  setThread: (id, thread) => db.prepare('UPDATE issues SET thread_id = ? WHERE id = ?').run(thread, id),
  touch: (id) => db.prepare('UPDATE issues SET updated_at = ? WHERE id = ?').run(now(), id),
  delete: (id) => {
    db.prepare('DELETE FROM evidence WHERE issue_id = ?').run(id);
    db.prepare('DELETE FROM watchers WHERE issue_id = ?').run(id);
    db.prepare('DELETE FROM events WHERE issue_id = ?').run(id);
    db.prepare('DELETE FROM issues WHERE id = ?').run(id);
  },
};

export const evidence = {
  add: (e) => Number(db.prepare(
    `INSERT INTO evidence (issue_id, report_id, user_id, kind, name, url, path, channel_id, message_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(e.issue_id, e.report_id ?? null, e.user_id, e.kind, e.name, e.url ?? '', e.path ?? null, e.channel_id ?? null, e.message_id ?? null, now()).lastInsertRowid),
  forIssue: (issueId) => db.prepare('SELECT * FROM evidence WHERE issue_id = ? ORDER BY report_id, id').all(issueId),
  forReport: (reportId) => db.prepare('SELECT * FROM evidence WHERE report_id = ?').all(reportId),
  moveReport: (reportId, to) => db.prepare('UPDATE evidence SET issue_id = ? WHERE report_id = ?').run(to, reportId),
  moveAll: (from, to) => db.prepare('UPDATE evidence SET issue_id = ? WHERE issue_id = ?').run(to, from),
  deleteForReport: (reportId) => db.prepare('DELETE FROM evidence WHERE report_id = ?').run(reportId),
};

export const reports = {
  add: (issueId, userId, text, platform, version) => Number(db.prepare(
    'INSERT INTO reports (issue_id, user_id, text, platform, version, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(issueId, userId, text, platform || null, version || null, now()).lastInsertRowid),
  get: (id) => db.prepare('SELECT * FROM reports WHERE id = ?').get(id),
  delete: (id) => db.prepare('DELETE FROM reports WHERE id = ?').run(id),
  update: (id, { text, platform, version }) => db.prepare(
    'UPDATE reports SET text = ?, platform = ?, version = ?, edited_at = ? WHERE id = ?'
  ).run(text, platform || null, version || null, now(), id),
  /** Everything a user has reported in this server, newest first. */
  byUser: (guild, userId) => db.prepare(
    `SELECT r.* FROM reports r JOIN issues i ON i.id = r.issue_id
     WHERE i.guild_id = ? AND r.user_id = ? ORDER BY r.created_at DESC`
  ).all(guild, userId),
  deleteForIssue: (issueId) => db.prepare('DELETE FROM reports WHERE issue_id = ?').run(issueId),
  /** Keeps the row (so developers' work on the issue isn't lost) but removes everything personal. */
  anonymize: (id) => db.prepare(
    "UPDATE reports SET user_id = '0', text = '[removed at the reporter''s request]', platform = NULL, version = NULL WHERE id = ?"
  ).run(id),
  earliest: (issueId) => db.prepare('SELECT * FROM reports WHERE issue_id = ? ORDER BY created_at, id LIMIT 1').get(issueId),
  latestByUser: (issueId, userId) => db.prepare(
    'SELECT * FROM reports WHERE issue_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(issueId, userId),
  forIssue: (issueId) => db.prepare('SELECT * FROM reports WHERE issue_id = ? ORDER BY created_at DESC').all(issueId),
  forGuild: (guild) => db.prepare(
    'SELECT r.*, i.title AS issue_title FROM reports r JOIN issues i ON i.id = r.issue_id WHERE i.guild_id = ? ORDER BY r.id'
  ).all(guild),
  hasUser: (issueId, userId) => !!db.prepare('SELECT 1 FROM reports WHERE issue_id = ? AND user_id = ?').get(issueId, userId),
  lastByUser: (guild, userId) => db.prepare(
    'SELECT MAX(r.created_at) AS t FROM reports r JOIN issues i ON i.id = r.issue_id WHERE i.guild_id = ? AND r.user_id = ?'
  ).get(guild, userId)?.t ?? null,
  versions: (issueId) => db.prepare(
    'SELECT DISTINCT version FROM reports WHERE issue_id = ? AND version IS NOT NULL ORDER BY version'
  ).all(issueId).map((r) => r.version),
  moveAll: (from, to) => db.prepare('UPDATE reports SET issue_id = ? WHERE issue_id = ?').run(to, from),
  move: (reportId, to) => db.prepare('UPDATE reports SET issue_id = ? WHERE id = ?').run(to, reportId),
  stats: (issueId) => db.prepare(
    'SELECT COUNT(*) AS total, COUNT(DISTINCT user_id) AS users FROM reports WHERE issue_id = ?'
  ).get(issueId),
};

export const watchers = {
  add: (issueId, userId) => db.prepare('INSERT OR IGNORE INTO watchers (issue_id, user_id) VALUES (?, ?)').run(issueId, userId),
  remove: (issueId, userId) => db.prepare('DELETE FROM watchers WHERE issue_id = ? AND user_id = ?').run(issueId, userId),
  has: (issueId, userId) => !!db.prepare('SELECT 1 FROM watchers WHERE issue_id = ? AND user_id = ?').get(issueId, userId),
  forIssue: (issueId) => db.prepare('SELECT user_id FROM watchers WHERE issue_id = ?').all(issueId).map((r) => r.user_id),
  forUser: (guild, userId) => db.prepare(
    'SELECT i.id FROM watchers w JOIN issues i ON i.id = w.issue_id WHERE i.guild_id = ? AND w.user_id = ?'
  ).all(guild, userId).map((r) => r.id),
  removeUser: (guild, userId) => db.prepare(
    'DELETE FROM watchers WHERE user_id = ? AND issue_id IN (SELECT id FROM issues WHERE guild_id = ?)'
  ).run(userId, guild),
  moveAll: (from, to) => {
    db.prepare('INSERT OR IGNORE INTO watchers (issue_id, user_id) SELECT ?, user_id FROM watchers WHERE issue_id = ?').run(to, from);
    db.prepare('DELETE FROM watchers WHERE issue_id = ?').run(from);
  },
};

/** Timeline of what happened to an issue (created, status/priority/owner changes, merges, reopenings). */
export const events = {
  add: (issueId, kind, actorId, detail) => db.prepare(
    'INSERT INTO events (issue_id, kind, actor_id, detail, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(issueId, kind, actorId ?? null, detail ?? null, now()),
  forIssue: (issueId, limit = 10) => db.prepare('SELECT * FROM events WHERE issue_id = ? ORDER BY id DESC LIMIT ?').all(issueId, limit),
  clearActor: (userId) => db.prepare('UPDATE events SET actor_id = NULL WHERE actor_id = ?').run(userId),
  moveAll: (from, to) => db.prepare('UPDATE events SET issue_id = ? WHERE issue_id = ?').run(to, from),
};

/** Knowledge articles written by developers; matched against new reports before an issue is filed. */
export const articles = {
  add: (a) => Number(db.prepare(
    `INSERT INTO articles (guild_id, title, symptoms, phrases, body, link, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(a.guild_id, a.title, a.symptoms, a.phrases || null, a.body, a.link || null, a.created_by ?? null, now(), now()).lastInsertRowid),
  get: (id) => db.prepare('SELECT * FROM articles WHERE id = ?').get(id),
  list: (guild, { enabledOnly = false } = {}) => db.prepare(
    `SELECT * FROM articles WHERE guild_id = ? ${enabledOnly ? 'AND enabled = 1' : ''} ORDER BY title COLLATE NOCASE`
  ).all(guild),
  update: (id, a) => db.prepare(
    'UPDATE articles SET title = ?, symptoms = ?, phrases = ?, body = ?, link = ?, updated_at = ? WHERE id = ?'
  ).run(a.title, a.symptoms, a.phrases || null, a.body, a.link || null, now(), id),
  setEnabled: (id, enabled) => db.prepare('UPDATE articles SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, now(), id),
  delete: (id) => db.prepare('DELETE FROM articles WHERE id = ?').run(id),
};

/** Per-user choices (currently: whether the bot may DM them progress updates). */
export const prefs = {
  dmOff: (userId) => !!db.prepare('SELECT dm_off FROM user_prefs WHERE user_id = ?').get(userId)?.dm_off,
  setDmOff: (userId, off) => db.prepare(
    'INSERT INTO user_prefs (user_id, dm_off) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET dm_off = excluded.dm_off'
  ).run(userId, off ? 1 : 0),
  delete: (userId) => db.prepare('DELETE FROM user_prefs WHERE user_id = ?').run(userId),
};

const STAT_FIELDS = ['shown', 'helped', 'denied', 'filed'];
export const kbStats = {
  bump: (guild, articleId, field) => {
    if (!STAT_FIELDS.includes(field)) throw new Error(`Unknown stat ${field}`);
    db.prepare('INSERT OR IGNORE INTO kb_stats (guild_id, article_id) VALUES (?, ?)').run(guild, articleId);
    db.prepare(`UPDATE kb_stats SET ${field} = ${field} + 1 WHERE guild_id = ? AND article_id = ?`).run(guild, articleId);
  },
  get: (guild, articleId) => db.prepare('SELECT * FROM kb_stats WHERE guild_id = ? AND article_id = ?').get(guild, articleId)
    ?? { shown: 0, helped: 0, denied: 0, filed: 0 },
  forGuild: (guild) => db.prepare('SELECT * FROM kb_stats WHERE guild_id = ? ORDER BY shown DESC').all(guild),
};

const pairKey = (a, b) => (a < b ? [a, b] : [b, a]);
export const decisions = {
  keepSeparate: (guild, a, b) => db.prepare('INSERT OR IGNORE INTO dup_decisions (guild_id, a, b) VALUES (?, ?, ?)').run(guild, ...pairKey(a, b)),
  has: (guild, a, b) => !!db.prepare('SELECT 1 FROM dup_decisions WHERE guild_id = ? AND a = ? AND b = ?').get(guild, ...pairKey(a, b)),
};
