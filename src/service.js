import { EmbedBuilder } from 'discord.js';
import { decisions, events, evidence, issues, prefs, reports, watchers } from './db.js';
import { refreshBoard } from './board.js';
import { kindOfFile, kindOfLink, linkName } from './evidence.js';
import { removeReportFiles, saveFromUrl } from './evidenceStore.js';
import { rankSimilar, similarPairs } from './similarity.js';
import { detectCategory, INSTALL_CATEGORY } from './categories.js';
import { renderIssue } from './render.js';
import { trunc } from './text.js';

/** Default score at/above which a new report is attached to an existing issue (configurable per server). */
export const MATCH_THRESHOLD = 0.25;


const makeTitle = (text) => {
  const first = text.trim().split(/(?<=[.!?\n])\s/)[0].replace(/\s+/g, ' ');
  return trunc(first, 90);
};

/** Crashes start at High priority; developers adjust from there. */
const priorityFor = (category) => (category === 'Crash / Freeze' ? 'high' : 'normal');

/** The reporter picks "Install issue" or "Bug in game"; install issues all share one category. */
export const KINDS = {
  install: { label: 'Install issue', emoji: '🔧' },
  bug: { label: 'Bug in game', emoji: '🐞' },
};
const categoryFor = (text, kind) => (kind === 'install' ? INSTALL_CATEGORY : detectCategory(text, [INSTALL_CATEGORY]));

/**
 * File a report. Attaches it to the most similar existing issue when similar enough,
 * otherwise opens a new issue. Returns { issue, reportId, created, reopened, fixedVersion, score }.
 */
export function fileReport({ guildId, userId, text, platform, version, kind = 'bug', threshold = MATCH_THRESHOLD }) {
  // Only compare with issues of the same type: an install problem is never merged into a game bug.
  const ranked = rankSimilar(text, issues.withText(guildId, kind));
  const best = ranked[0];

  if (best && best.score >= threshold) {
    const issue = issues.get(best.id);
    const reportId = reports.add(issue.id, userId, text, platform, version);
    // A "fixed" issue that gets new reports is a possible regression.
    const reopened = issue.status === 'fixed';
    if (reopened) {
      issues.setStatus(issue.id, 'new', null);
      events.add(issue.id, 'reopened', userId, issue.fixed_version ? `was fixed in ${issue.fixed_version}` : null);
    } else issues.touch(issue.id);
    return { issue: issues.get(issue.id), reportId, created: false, reopened, fixedVersion: issue.fixed_version, score: best.score };
  }

  const category = categoryFor(text, kind);
  const id = issues.create(guildId, makeTitle(text), category, priorityFor(category), kind);
  const reportId = reports.add(id, userId, text, platform, version);
  events.add(id, 'created', userId, `${KINDS[kind]?.label ?? kind} · ${category}`);
  return { issue: issues.get(id), reportId, created: true, reopened: false, fixedVersion: null, score: best?.score ?? 0 };
}

/** Undo an auto-match: move one report into its own new issue. */
export function splitReport(reportId) {
  const r = reports.get(reportId);
  if (!r) return null;
  const old = issues.get(r.issue_id);
  const category = categoryFor(r.text, old.kind);
  const id = issues.create(old.guild_id, makeTitle(r.text), category, priorityFor(category), old.kind);
  reports.move(r.id, id);
  evidence.moveReport(r.id, id);
  decisions.keepSeparate(old.guild_id, old.id, id); // the reporter said these are different problems: never suggest merging them back
  const emptied = reports.stats(old.id).total === 0;
  // If this very report had reopened a "fixed" issue, taking it out means the issue should be fixed again.
  const lastEvent = events.forIssue(old.id, 1)[0];
  if (!emptied && lastEvent?.kind === 'reopened' && lastEvent.actor_id === r.user_id && issues.get(old.id).status === 'new') {
    issues.setStatus(old.id, 'fixed', null, old.fixed_version);
    events.add(old.id, 'status', null, 'Back to Fixed – the report that reopened it turned out to be a different problem');
  }
  if (emptied) issues.delete(old.id);
  return { fresh: issues.get(id), old: emptied ? null : issues.get(old.id), emptiedIssue: emptied ? old : null };
}

/**
 * Re-check where one report belongs after its text (or evidence) changed.
 * Moves it to a clearly better-matching issue, splits it out if it no longer fits where it is, or leaves it.
 * Returns { action: 'same' | 'moved' | 'split', from, to, fromDeleted, reopened, score }.
 */
export function rematchReport(reportId, actorId, threshold = MATCH_THRESHOLD) {
  const r = reports.get(reportId);
  if (!r) return null;
  const cur = issues.get(r.issue_id);
  const only = reports.stats(cur.id).total === 1;
  // Developers have already worked on this issue? Then it must never be removed because its only report moved away.
  const devTouched = cur.status !== 'new' || !!cur.owner_id || !!cur.dev_note;
  // The issue's text without this report (and, if it's the issue's only report, without the issue itself) –
  // and never an issue someone already decided is a different problem (a "make it a separate issue" choice).
  const docs = issues.withTextExcluding(cur.guild_id, r.id, cur.kind)
    .filter((d) => !(only && d.id === cur.id))
    .filter((d) => d.id === cur.id || !decisions.has(cur.guild_id, cur.id, d.id));
  const best = rankSimilar(`${r.text} ${r.platform ?? ''}`, docs)[0];
  const score = best?.score ?? 0;

  let to;
  let action;
  if (best && score >= threshold) {
    if (best.id === cur.id || (only && devTouched)) return { action: 'same', from: cur, to: cur, score };
    to = issues.get(best.id);
    action = 'moved';
  } else if (!only) {
    const category = categoryFor(r.text, cur.kind);
    to = issues.get(issues.create(cur.guild_id, makeTitle(r.text), category, priorityFor(category), cur.kind));
    events.add(to.id, 'created', r.user_id, `${category} (split from #${cur.id})`);
    action = 'split';
  } else {
    return { action: 'same', from: cur, to: cur, score };
  }

  reports.move(r.id, to.id);
  evidence.moveReport(r.id, to.id);
  let reopened = false;
  if (action === 'moved' && to.status === 'fixed') {
    issues.setStatus(to.id, 'new', null);
    events.add(to.id, 'reopened', r.user_id, to.fixed_version ? `was fixed in ${to.fixed_version}` : null);
    reopened = true;
  } else issues.touch(to.id);
  events.add(to.id, 'rematched', actorId, `report #${r.id} ${action === 'moved' ? `moved here from #${cur.id}` : `split from #${cur.id}`}`);
  const fromDeleted = only;
  if (fromDeleted) issues.delete(cur.id);
  return { action, from: cur, to: issues.get(to.id), fromDeleted, reopened, score };
}

export function mergeIssues(fromId, intoId) {
  reports.moveAll(fromId, intoId);
  evidence.moveAll(fromId, intoId);
  watchers.moveAll(fromId, intoId);
  events.moveAll(fromId, intoId);
  events.add(intoId, 'merged', null, `#${fromId} merged into this issue`);
  issues.touch(intoId);
  issues.delete(fromId);
}

/**
 * Candidate duplicate pairs for the review queue: related issues the matcher did NOT merge,
 * minus pairs developers already marked "keep separate" and pairs of two closed issues.
 */
export function duplicatePairs(guildId, floor = 0.12) {
  const closed = new Set(['fixed', 'wont_fix', 'cannot_reproduce']);
  const status = new Map(issues.list(guildId).map((it) => [it.id, it.status]));
  return similarPairs(issues.withText(guildId), floor)
    .map((p) => (p.a < p.b ? p : { a: p.b, b: p.a, score: p.score }))
    .filter((p) => !decisions.has(guildId, p.a, p.b))
    .filter((p) => !(closed.has(status.get(p.a)) && closed.has(status.get(p.b))))
    .slice(0, 500); // the review shows one pair at a time, best first – no need to hold thousands
}

// ---------- Discord messaging helpers ----------

/**
 * Keep an issue's card up to date. New issues have no Discord message at all (they are opened from "Known issues"),
 * so this only refreshes the board. Older issues that still have a thread or channel card keep that card edited in place.
 */
export function syncMessage(client, issue, channelId) {
  // Updates for the SAME issue run one after another. Without this, two people reporting the same new problem at the
  // same moment each saw "no thread yet" and each created one – two threads for one issue.
  const previous = syncLocks.get(issue.id) ?? Promise.resolve();
  const turn = previous.catch(() => {}).then(() => syncMessageNow(client, issue, channelId));
  syncLocks.set(issue.id, turn);
  turn.catch(() => {}).finally(() => { if (syncLocks.get(issue.id) === turn) syncLocks.delete(issue.id); });
  return turn;
}
const syncLocks = new Map();

async function syncMessageNow(client, issue, channelId) {
  const fresh = issues.get(issue.id); // always the latest, so a queued update sees the thread an earlier one just created
  if (!fresh) return;
  const payload = renderIssue(fresh);

  if (fresh.message_id && fresh.channel_id) {
    try {
      const ch = await client.channels.fetch(fresh.channel_id);
      if (ch.archived) { await ch.setArchived(false).catch(() => {}); issues.setThreadArchived(fresh.id, 0); } // messages in an archived thread can't be edited
      await ch.messages.edit(fresh.message_id, payload); // one call to Discord (no separate fetch of the message first)
      refreshBoard(client, fresh.guild_id);
      return;
    } catch { /* card deleted, or written by a previous bot account (Discord only lets a bot edit its own messages) */ }
  }
  // The thread is still there but the card can't be edited (bot re-invited / re-created, or card deleted):
  // put a fresh card in the SAME thread rather than starting a duplicate one.
  if (fresh.thread_id) {
    try {
      const t = await client.channels.fetch(fresh.thread_id);
      if (t.archived) { await t.setArchived(false).catch(() => {}); issues.setThreadArchived(fresh.id, 0); }
      const newCard = await t.send(payload);
      issues.setMessage(fresh.id, t.id, newCard.id);
      refreshBoard(client, fresh.guild_id);
      return;
    } catch { /* thread is gone too -> create a new one below */ }
  }
  // New issues post nothing in Discord: they live in the database and are opened from "Known issues".
  refreshBoard(client, fresh.guild_id);
}

export async function threadSay(client, issue, text) {
  const fresh = issues.get(issue.id);
  if (!fresh?.thread_id) return;
  try { await (await client.channels.fetch(fresh.thread_id)).send(text); } catch { /* thread gone */ }
}

/**
 * Save a report's links and uploaded files. Nothing is posted in Discord: files are downloaded into the bot's
 * private evidence folder and links are stored as text, so only the reporter and developers can ever be shown them
 * (the bot checks this when someone asks to view them). Returns { saved, failed: [{ name, reason }] }.
 */
export async function attachEvidence(client, issue, userId, reportId, { links = [], files = [] } = {}) {
  const result = { saved: 0, failed: [] };
  const base = { issue_id: issue.id, report_id: reportId, user_id: userId };
  for (const l of links) {
    evidence.add({ ...base, kind: kindOfLink(l), name: linkName(l), url: l });
    result.saved++;
  }
  const already = evidence.forReport(reportId).length; // keeps file names unique across later additions
  for (const [n, f] of files.entries()) {
    try {
      const rel = await saveFromUrl(reportId, already + n, f);
      evidence.add({ ...base, kind: kindOfFile(f.name, f.contentType), name: f.name, url: '', path: rel });
      result.saved++;
    } catch (e) {
      result.failed.push({ name: f.name, reason: e.message });
    }
  }
  return result;
}

/** Remove a report's evidence: stored files, rows, and (for older reports) any thread message that held the files. */
export async function purgeEvidence(client, reportId) {
  const rows = evidence.forReport(reportId);
  for (const m of new Map(rows.filter((r) => r.message_id).map((r) => [r.message_id, r])).values()) {
    try { await (await (await client.channels.fetch(m.channel_id)).messages.fetch(m.message_id)).delete(); } catch { /* gone */ }
  }
  removeReportFiles(reportId);
  evidence.deleteForReport(reportId);
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
    await ch.messages.edit(issue.message_id, { content: `🔀 This issue was merged into **#${intoId}** – please continue the discussion there.`, embeds: [], components: [] });
  } catch { /* gone */ }
  if (issue.thread_id) {
    try { const t = await client.channels.fetch(issue.thread_id); await t.setLocked(true); await t.setArchived(true); } catch { /* gone */ }
  }
}

/** Archive (not lock) the threads of issues that have been fixed and quiet for `days` days. Any new activity reopens the thread. */
export async function archiveFixedThreads(client, guildId, days = 180) {
  for (const it of issues.fixedToArchive(guildId, Date.now() - days * 86_400_000)) {
    try { const t = await client.channels.fetch(it.thread_id); if (!t.archived) await t.setArchived(true, 'Issue fixed'); } catch { /* thread gone */ }
    issues.setThreadArchived(it.id, 1); // also when it is gone, so it is not retried every hour
  }
}

/** Pairs at/above this score are treated as the same problem when a server turns on automatic merging. */
export const AUTO_MERGE_SCORE = 0.8;

/** Merge near-identical issues that nobody has started on (same type, both still New and unowned). The older issue is kept. Returns the number merged. */
export async function autoMergeDuplicates(client, guildId, channelId) {
  let merged = 0;
  const untouched = (it) => it && it.status === 'new' && !it.owner_id && !it.dev_note;
  for (const p of duplicatePairs(guildId)) {
    if (p.score < AUTO_MERGE_SCORE) break; // sorted best first
    const a = issues.get(p.a); const b = issues.get(p.b);
    if (!untouched(a) || !untouched(b) || a.kind !== b.kind) continue;
    const [keep, drop] = a.id < b.id ? [a, b] : [b, a];
    await retireMessage(client, drop, keep.id);
    mergeIssues(drop.id, keep.id);
    events.add(keep.id, 'merged', null, `automatic: #${drop.id} was ${Math.round(p.score * 100)}% alike`);
    await syncMessage(client, issues.get(keep.id), channelId);
    await threadSay(client, keep, `🔀 Issue #${drop.id} (“${trunc(drop.title, 80)}”) looked like the same problem (${Math.round(p.score * 100)}% alike) and was merged into this one automatically. Developers can still split a report out.`);
    merged++;
  }
  return merged;
}

/**
 * Erase everything the bot holds about one user in a server (their reports, evidence, follows, preferences).
 * If their report is the only one on an issue developers have already worked on, the report is anonymised instead
 * of deleted so the developers' work isn't lost. Returns { removed, anonymised }.
 */
export async function eraseUser(client, guildId, userId) {
  const touched = new Set();
  let removed = 0;
  let anonymised = 0;
  for (const r of reports.byUser(guildId, userId)) {
    const issue = issues.get(r.issue_id);
    if (!issue) continue;
    await purgeEvidence(client, r.id);
    const total = reports.stats(issue.id).total;
    const devTouched = issue.status !== 'new' || !!issue.owner_id || !!issue.dev_note;
    const wasFirst = reports.earliest(issue.id)?.id === r.id;
    if (total === 1 && devTouched) {
      reports.anonymize(r.id);
      issues.setTitle(issue.id, 'Details removed at the reporter\'s request');
      anonymised++;
      touched.add(issue.id);
    } else if (total === 1) {
      reports.delete(r.id);
      issues.delete(issue.id);
      await removeMessage(client, issue);
      removed++;
    } else {
      reports.delete(r.id);
      // the title was taken from the first report – re-derive it from what is left
      if (wasFirst) issues.setTitle(issue.id, makeTitle(reports.earliest(issue.id).text));
      removed++;
      touched.add(issue.id);
    }
  }
  watchers.removeUser(guildId, userId);
  events.clearActor(userId);
  prefs.delete(userId);
  for (const id of touched) {
    const issue = issues.get(id);
    if (issue) await syncMessage(client, issue, issue.channel_id ?? undefined);
  }
  return { removed, anonymised };
}

/** Optional retention: delete closed issues (and their threads) with no activity for `days`. Returns how many. */
export async function purgeExpired(client, guildId, days) {
  if (!days || days < 1) return 0;
  const old = issues.closedBefore(guildId, Date.now() - days * 864e5);
  for (const issue of old) {
    await removeMessage(client, issue);
    for (const r of reports.forIssue(issue.id)) removeReportFiles(r.id); // the uploaded files go too
    reports.deleteForIssue(issue.id);
    issues.delete(issue.id);
  }
  return old.length;
}

/** DM everyone who reported or follows the issue and hasn't turned DMs off (best effort). */
export async function notifyReporters(client, issue, text) {
  const ids = [...new Set([...reports.forIssue(issue.id).map((r) => r.user_id), ...watchers.forIssue(issue.id)])]
    .filter((id) => id !== '0' && !prefs.dmOff(id)).slice(0, 100);
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
      { name: 'Fixed in', value: issue.fixed_version ? `\`${issue.fixed_version}\`` : 'The next update', inline: true },
      { name: 'Reported by', value: `${stats.users} player${stats.users === 1 ? '' : 's'}`, inline: true },
    ).setTimestamp();
  if (issue.dev_note) embed.setDescription(trunc(issue.dev_note, 1000));
  try { await (await client.channels.fetch(channelId)).send({ embeds: [embed] }); } catch (e) { console.error('Changelog post failed:', e.message); }
}
