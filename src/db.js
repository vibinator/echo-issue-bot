import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';

mkdirSync('data', { recursive: true });
export const db = new DatabaseSync(process.env.DB_PATH ?? 'data/issues.db');

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
addColumn('reports', 'version', 'TEXT');
addColumn('settings', 'dev_channel_id', 'TEXT');
addColumn('settings', 'changelog_channel_id', 'TEXT');
addColumn('settings', 'threshold', 'REAL NOT NULL DEFAULT 0.25');
addColumn('settings', 'stale_days', 'INTEGER NOT NULL DEFAULT 7');
addColumn('settings', 'cooldown_sec', 'INTEGER NOT NULL DEFAULT 60');
addColumn('settings', 'last_digest', 'INTEGER');
addColumn('settings', 'reporter_role_id', 'TEXT');
addColumn('settings', 'status_role_id', 'TEXT');

const now = () => Date.now();
const SETTING_KEYS = ['dev_channel_id', 'changelog_channel_id', 'threshold', 'stale_days', 'cooldown_sec', 'last_digest', 'reporter_role_id', 'status_role_id'];

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
  create: (guild, title, category, priority = 'normal') => Number(db.prepare(
    'INSERT INTO issues (guild_id, title, category, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(guild, title, category, priority, now(), now()).lastInsertRowid),
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
  /** Issues with all report text concatenated, for similarity matching. */
  withText: (guild) => db.prepare(
    `SELECT i.id, i.title || ' ' || COALESCE(GROUP_CONCAT(r.text, ' '), '') AS text
     FROM issues i LEFT JOIN reports r ON r.issue_id = i.id WHERE i.guild_id = ? GROUP BY i.id`
  ).all(guild),
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
  setThread: (id, thread) => db.prepare('UPDATE issues SET thread_id = ? WHERE id = ?').run(thread, id),
  touch: (id) => db.prepare('UPDATE issues SET updated_at = ? WHERE id = ?').run(now(), id),
  delete: (id) => db.prepare('DELETE FROM issues WHERE id = ?').run(id),
};

export const reports = {
  add: (issueId, userId, text, platform, version) => Number(db.prepare(
    'INSERT INTO reports (issue_id, user_id, text, platform, version, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(issueId, userId, text, platform || null, version || null, now()).lastInsertRowid),
  get: (id) => db.prepare('SELECT * FROM reports WHERE id = ?').get(id),
  delete: (id) => db.prepare('DELETE FROM reports WHERE id = ?').run(id),
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

const pairKey = (a, b) => (a < b ? [a, b] : [b, a]);
export const decisions = {
  keepSeparate: (guild, a, b) => db.prepare('INSERT OR IGNORE INTO dup_decisions (guild_id, a, b) VALUES (?, ?, ?)').run(guild, ...pairKey(a, b)),
  has: (guild, a, b) => !!db.prepare('SELECT 1 FROM dup_decisions WHERE guild_id = ? AND a = ? AND b = ?').get(guild, ...pairKey(a, b)),
};
