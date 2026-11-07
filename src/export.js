import { issues, reports } from './db.js';

// Cells starting with = + - @ (or a tab / carriage return) are prefixed so spreadsheets don't run user text as a formula.
const esc = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (header, rows) => `﻿${[header, ...rows].map((r) => r.map(esc).join(',')).join('\r\n')}`;
const iso = (ms) => (ms ? new Date(ms).toISOString() : '');

export function exportCsv(guildId) {
  const issueRows = issues.list(guildId).map((i) => [
    i.id, i.title, i.category, i.status, i.priority, i.owner_id, i.fixed_version, i.reporters,
    reports.versions(i.id).join('; '), i.dev_note, iso(i.created_at), iso(i.updated_at), iso(i.fixed_at),
  ]);
  const reportRows = reports.forGuild(guildId).map((r) => [
    r.id, r.issue_id, r.issue_title, r.user_id, r.platform, r.version, r.text, iso(r.created_at),
  ]);
  return {
    issues: Buffer.from(csv(['id', 'title', 'category', 'status', 'priority', 'owner_id', 'fixed_version', 'affected_players',
      'versions', 'dev_note', 'created', 'updated', 'fixed'], issueRows)),
    reports: Buffer.from(csv(['id', 'issue_id', 'issue_title', 'user_id', 'platform', 'version', 'text', 'created'], reportRows)),
  };
}
