import { EmbedBuilder } from 'discord.js';
import { decisions, issues, reports } from './db.js';
import { rankSimilar } from './similarity.js';
import { detectCategory } from './categories.js';
import { relatedIssues } from './related.js';
import { renderIssue } from './render.js';

/** Default score at/above which a new report is attached to an existing issue (configurable per server). */
export const MATCH_THRESHOLD = 0.25;

const trunc = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const makeTitle = (text) => {
  const first = text.trim().split(/(?<=[.!?\n])\s/)[0].replace(/\s+/g, ' ');
  return trunc(first, 90);
};

/** Crashes start at High priority; developers adjust from there. */
const priorityFor = (category) => (category === 'Crash / Freeze' ? 'high' : 'normal');

/**
 * File a report. Attaches it to the most similar existing issue when similar enough,
 * otherwise opens a new issue. Returns { issue, reportId, created, reopened, fixedVersion, score }.
 */
export function fileReport({ guildId, userId, text, platform, version, threshold = MATCH_THRESHOLD }) {
  const ranked = rankSimilar(text, issues.withText(guildId));
  const best = ranked[0];

  if (best && best.score >= threshold) {
    const issue = issues.get(best.id);
    const reportId = reports.add(issue.id, userId, text, platform, version);
    // A "fixed" issue that gets new reports is a possible regression.
    const reopened = issue.status === 'fixed';
    if (reopened) issues.setStatus(issue.id, 'new', null); else issues.touch(issue.id);
    return { issue: issues.get(issue.id), reportId, created: false, reopened, fixedVersion: issue.fixed_version, score: best.score };
  }

  const category = detectCategory(text);
  const id = issues.create(guildId, makeTitle(text), category, priorityFor(category));
  const reportId = reports.add(id, userId, text, platform, version);
  return { issue: issues.get(id), reportId, created: true, reopened: false, fixedVersion: null, score: best?.score ?? 0 };
}

/** Undo an auto-match: move one report into its own new issue. */
export function splitReport(reportId) {
  const r = reports.get(reportId);
  if (!r) return null;
  const old = issues.get(r.issue_id);
  const category = detectCategory(r.text);
  const id = issues.create(old.guild_id, makeTitle(r.text), category, priorityFor(category));
  reports.move(r.id, id);
  const emptied = reports.stats(old.id).total === 0;
  if (emptied) issues.delete(old.id);
  return { fresh: issues.get(id), old: emptied ? null : issues.get(old.id), emptiedIssue: emptied ? old : null };
}

export function mergeIssues(fromId, intoId) {
  reports.moveAll(fromId, intoId);
  issues.touch(intoId);
  issues.delete(fromId);
}

/**
 * Candidate duplicate pairs for the review queue: related issues the matcher did NOT merge,
 * minus pairs developers already marked "keep separate" and pairs of two closed issues.
 */
export function duplicatePairs(guildId, floor = 0.12) {
  const best = new Map();
  for (const it of issues.list(guildId)) {
    for (const r of relatedIssues(it, { limit: 5, min: floor })) {
      const [a, b] = it.id < r.id ? [it.id, r.id] : [r.id, it.id];
      const key = `${a}-${b}`;
      best.set(key, { a, b, score: Math.max(best.get(key)?.score ?? 0, r.score) });
    }
  }
  const closed = new Set(['fixed', 'wont_fix', 'cannot_reproduce']);
  return [...best.values()]
    .filter((p) => !decisions.has(guildId, p.a, p.b))
    .filter((p) => !(closed.has(issues.get(p.a)?.status) && closed.has(issues.get(p.b)?.status)))
    .sort((x, y) => y.score - x.score);
}

// ---------- Discord messaging helpers ----------

/** Create or refresh the tracker message (and its discussion thread) for an issue. */
export async function syncMessage(client, issue, channelId) {
  const payload = renderIssue(issues.get(issue.id));
  const targetChannel = issue.channel_id ?? channelId;
  try {
    if (issue.message_id && targetChannel) {
      const ch = await client.channels.fetch(targetChannel);
      const msg = await ch.messages.fetch(issue.message_id);
      await msg.edit(payload);
      return;
    }
  } catch { /* message deleted -> repost below */ }
  if (!channelId) return;
  try {
    const ch = await client.channels.fetch(channelId);
    const msg = await ch.send(payload);
    issues.setMessage(issue.id, ch.id, msg.id);
    try {
      const thread = await msg.startThread({ name: trunc(`#${issue.id} ${issue.title}`, 100), autoArchiveDuration: 10080 });
      issues.setThread(issue.id, thread.id);
      await thread.send('💬 Use this thread for logs, screenshots and discussion about this issue.');
    } catch { /* missing thread permissions – the tracker still works */ }
  } catch (e) {
    console.error('Could not post tracker message:', e.message);
  }
}

export async function threadSay(client, issue, text) {
  const fresh = issues.get(issue.id);
  if (!fresh?.thread_id) return;
  try { await (await client.channels.fetch(fresh.thread_id)).send(text); } catch { /* thread gone */ }
}

/** Delete an issue's tracker message and thread (used when an issue is removed outright). */
export async function removeMessage(client, issue) {
  if (!issue) return;
  for (const [ch, msg] of [[issue.thread_id, null], [issue.channel_id, issue.message_id]]) {
    if (!ch) continue;
    try {
      const c = await client.channels.fetch(ch);
      if (msg) await (await c.messages.fetch(msg)).delete(); else await c.delete();
    } catch { /* already gone */ }
  }
}

/** After a merge: keep the old message as a pointer and lock its thread, so the discussion is preserved. */
export async function retireMessage(client, issue, intoId) {
  if (!issue) return;
  try {
    const ch = await client.channels.fetch(issue.channel_id);
    await (await ch.messages.fetch(issue.message_id)).edit({ content: `🔀 Merged into **#${intoId}**.`, embeds: [], components: [] });
  } catch { /* gone */ }
  if (issue.thread_id) {
    try { const t = await client.channels.fetch(issue.thread_id); await t.setLocked(true); await t.setArchived(true); } catch { /* gone */ }
  }
}

/** DM everyone who reported the issue (best effort). */
export async function notifyReporters(client, issue, text) {
  const ids = [...new Set(reports.forIssue(issue.id).map((r) => r.user_id))].slice(0, 50);
  for (const id of ids) {
    try { await (await client.users.fetch(id)).send(text); } catch { /* DMs closed */ }
  }
}

/** Release-note style post for the public changelog channel. */
export async function postChangelog(client, issue, channelId) {
  if (!channelId) return;
  const stats = reports.stats(issue.id);
  const embed = new EmbedBuilder().setColor(0x2ecc71).setTitle(trunc(`✅ Fixed: ${issue.title}`, 256))
    .addFields(
      { name: 'Category', value: issue.category, inline: true },
      { name: 'Fixed in', value: issue.fixed_version ? `\`${issue.fixed_version}\`` : 'Next update', inline: true },
      { name: 'Reported by', value: `${stats.users} player${stats.users === 1 ? '' : 's'}`, inline: true },
    ).setTimestamp();
  if (issue.dev_note) embed.setDescription(trunc(issue.dev_note, 1000));
  try { await (await client.channels.fetch(channelId)).send({ embeds: [embed] }); } catch (e) { console.error('Changelog post failed:', e.message); }
}
