import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder } from 'discord.js';
import { articles, db, decisions, events, evidence, issues, prefs, reports, seen, settings, watchers } from './db.js';
import { refreshBoard } from './board.js';
import { kindOfFile, kindOfLink, linkName } from './evidence.js';
import { readStored, removeReportFiles, saveFromUrl } from './evidenceStore.js';
import { readImageText } from './ocr.js';
import { rankSimilar, similarPairs } from './similarity.js';
import { detectCategory, INSTALL_CATEGORY } from './categories.js';
import { renderIssue, STATUSES } from './render.js';
import { trunc } from './text.js';

/** Default score at/above which a new report is attached to an existing issue (configurable per server). */
export const MATCH_THRESHOLD = 0.25;


// Opening lines that say nothing about the problem ("Hi there, hope someone can help.") – skipped when another sentence follows.
const FILLER = /^(hi|hello|hey|yo|hiya|heya|howdy|greetings|good (morning|afternoon|evening|day)|dear|hope|hoping|please|pls|plz|help|can (someone|anyone|somebody|you) (please )?help|i need help|need help|question|quick question|sorry|first of all|not sure if this is the right place|is this the right place|does anyone|anyone else|thanks|thank you|ty)\b/i;
/** The issue title: the first sentence that actually describes the problem (greetings and "please help" openers are skipped). */
export const makeTitle = (text) => {
  const sentences = String(text).trim().split(/(?<=[.!?])\s+|\n+/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const filler = (s) => FILLER.test(s.replace(/^[^a-z0-9]+/i, '')) || s.split(' ').length < 3;
  const first = sentences.find((s, n) => !filler(s) || n === sentences.length - 1) ?? sentences[0] ?? String(text).trim();
  return trunc(first, 150);
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

/** If this text would join an issue that is already marked fixed, return that issue (so the reporter can be told first). */
export function findFixedMatch({ guildId, text, kind = 'bug', threshold = MATCH_THRESHOLD }) {
  const best = rankSimilar(text, issues.withText(guildId, kind))[0];
  if (!best || best.score < threshold) return null;
  const issue = issues.get(best.id);
  return issue?.status === 'fixed' ? issue : null;
}

/** Undo an auto-match: move one report into its own new issue. */
export function splitReport(reportId) {
  const r = reports.get(reportId);
  if (!r) return null;
  const old = issues.get(r.issue_id);
  if (!old) return null;
  // Already the only report on its issue: splitting would just recreate the issue and delete the original together with
  // everything developers did on it (status, owner, note, history). Nothing to separate, so do nothing.
  if (reports.stats(old.id).total <= 1) return { alone: true, old };
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

/** Returns the ids of the people who reported or followed the merged-away issue, so they can be told where it stands. */
export function mergeIssues(fromId, intoId) {
  const moved = [...new Set([...reports.forIssue(fromId).map((r) => r.user_id), ...watchers.forIssue(fromId)])];
  const from = issues.get(fromId);
  if (from?.article_id && !issues.get(intoId)?.article_id) issues.setArticle(intoId, from.article_id); // keep the linked answer
  reports.moveAll(fromId, intoId);
  evidence.moveAll(fromId, intoId);
  watchers.moveAll(fromId, intoId);
  events.moveAll(fromId, intoId);
  events.add(intoId, 'merged', null, `#${fromId} merged into this issue`);
  issues.touch(intoId);
  issues.delete(fromId);
  return moved;
}

/**
 * Candidate duplicate pairs for the review queue: related issues the matcher did NOT merge,
 * minus pairs developers already marked "keep separate" and pairs of two closed issues.
 */
const dupCache = new Map();
/** Changes whenever an issue or report is added, removed or edited, so a cached answer is only reused while nothing changed. */
const dupSignature = (g) => {
  const a = db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), 0) AS m, COALESCE(SUM(id), 0) AS s FROM issues WHERE guild_id = ?').get(g);
  const b = db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(COALESCE(r.edited_at, 0) + r.id), 0) AS m FROM reports r JOIN issues i ON i.id = r.issue_id WHERE i.guild_id = ?').get(g);
  return `${a.n}/${a.m}/${a.s}/${b.n}/${b.m}`;
};
const DUP_MAX_ISSUES = 3000; // comparing is quadratic and blocks the bot while it runs: only the newest issues are compared
export function duplicatePairs(guildId, floor = 0.12) {
  const sig = `${floor}|${dupSignature(guildId)}`;
  const hit = dupCache.get(guildId);
  const live = (p) => issues.get(p.a) && issues.get(p.b) && !decisions.has(guildId, p.a, p.b);
  if (hit?.sig === sig) return hit.pairs.filter(live);
  const pairs = computeDuplicatePairs(guildId, floor);
  dupCache.set(guildId, { sig, pairs });
  return pairs;
}
function computeDuplicatePairs(guildId, floor) {
  const closed = new Set(['fixed', 'wont_fix', 'cannot_reproduce']);
  const status = new Map(issues.list(guildId).map((it) => [it.id, it.status]));
  return similarPairs(issues.withText(guildId).sort((x, y) => y.id - x.id).slice(0, DUP_MAX_ISSUES), floor)
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
  if (fresh?.talk_thread_id) await talkSay(client, fresh, text); // developers see every event here too
  if (!fresh?.thread_id) return;
  try { await (await client.channels.fetch(fresh.thread_id)).send(text); } catch { /* thread gone */ }
}

const MAX_REPORT_FILES = 15; // attachments (files and links) one report may hold in total

/**
 * Save a report's links and uploaded files. Nothing is posted in Discord: files are downloaded into the bot's
 * private evidence folder and links are stored as text, so only the reporter and developers can ever be shown them
 * (the bot checks this when someone asks to view them). Returns { saved, failed: [{ name, reason }] }.
 */
export async function attachEvidence(client, issue, userId, reportId, { links = [], files = [] } = {}) {
  const result = { saved: 0, failed: [] };
  const base = { issue_id: issue.id, report_id: reportId, user_id: userId };
  for (const l of links.slice(0, Math.max(0, MAX_REPORT_FILES - evidence.forReport(reportId).length))) {
    evidence.add({ ...base, kind: kindOfLink(l), name: linkName(l), url: l });
    result.saved++;
  }
  const already = evidence.forReport(reportId).length; // keeps file names unique across later additions
  for (const [n, f] of files.entries()) {
    try {
      if (already + n >= MAX_REPORT_FILES) throw new Error('too many files');
      const rel = await saveFromUrl(reportId, already + n, f);
      evidence.add({ ...base, kind: kindOfFile(f.name, f.contentType), name: f.name, url: '', path: rel });
      result.saved++;
    } catch (e) {
      result.failed.push({ name: f.name, reason: e.message });
    }
  }
  return result;
}

const OCR_IMAGES_PER_REPORT = 4; // reading is CPU-heavy; a report rarely needs more than a few screenshots read

/**
 * Read the text in a report's screenshots (once each; the result is stored with the attachment, so it is erased with it).
 * Returns all the text found, or '' if there's none or OCR isn't available.
 */
export async function readScreenshots(reportId) {
  const found = [];
  const images = evidence.forReport(reportId).filter((r) => r.kind === 'image' && r.path && /\.(png|jpe?g|bmp|webp)$/i.test(r.name));
  for (const r of images.slice(0, OCR_IMAGES_PER_REPORT)) {
    let text = r.ocr_text;
    if (text == null) {
      const data = readStored(r.path);
      text = data ? await readImageText(data) : '';
      if (text === null) continue; // OCR could not run: leave it unread so a later report or a fixed setup can still read it
      evidence.setOcr(r.id, text);
    }
    if (text) found.push(text);
  }
  return found.join('\n').slice(0, 3000);
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

// ---------- developer discussion threads (one per open issue, in the developer hub channel; players are NOT in them) ----------

const OPEN_STATUSES = ['new', 'seen', 'in_progress'];
const talkLocks = new Map();
const threadWarned = new Map();

/** Thread title: the status first, so the thread list reads like the board ("Seen · #10 title"). */
export const talkName = (issue) => trunc(`${STATUSES[issue.status]?.label ?? issue.status} · #${issue.id} ${issue.title.replace(/\s+/g, ' ')}`, 100);

/** Rename the thread to match the issue's status (Discord limits renames, so a refusal is ignored). */
async function renameTalk(t, issue) {
  const name = talkName(issue);
  if (t.name === name) return;
  const wasArchived = t.archived;
  if (wasArchived) await t.setArchived(false).catch(() => {}); // an archived thread cannot be renamed
  await t.setName(name, 'Issue status changed').catch(() => {});
  if (wasArchived) await t.setArchived(true).catch(() => {});
}

/** A Fixed / Can't reproduce / Won't fix issue's thread stays archived (hidden from the channel's active list) even after the bot posts in it. */
async function keepHidden(t, issue) {
  if (!OPEN_STATUSES.includes(issue.status) && !issues.byTalkThread(t.id).some((x) => OPEN_STATUSES.includes(x.status))) await t.setArchived(true).catch(() => {});
}

/** The first message of an issue's developer thread: what it is, a status menu for developers, and the note / merge buttons. */
export function talkIntro(issue) {
  // one button per other status: a click moves the issue there
  const moves = Object.entries(STATUSES).filter(([value]) => value !== issue.status).map(([value, st]) =>
    new ButtonBuilder().setCustomId(`stbtn:${issue.id}:${value}`).setLabel(st.label).setEmoji(st.emoji).setStyle(['fixed', 'cannot_reproduce', 'wont_fix'].includes(value) ? ButtonStyle.Secondary : ButtonStyle.Success));
  return {
    content: `🧵 **#${issue.id} – ${trunc(issue.title, 150)}**
Status: **${STATUSES[issue.status]?.emoji ?? ''} ${STATUSES[issue.status]?.label ?? issue.status}**. Use the buttons to move it to another status. Notes to requesters, status changes and new activity from players are posted here by the bot. Merge it with another issue (and so its thread) only if it is the same problem. Locked: only people with Manage Threads (and the bot) can write in it.`,
    components: [new ActionRowBuilder().addComponents(...moves), new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`note:${issue.id}`).setLabel('Note to requesters').setEmoji('💬').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`merge:${issue.id}`).setLabel('Same problem as another issue…').setEmoji('🔀').setStyle(ButtonStyle.Secondary))],
  };
}

/** Open (or find and un-archive) the issue's developer thread in the hub channel. */
export async function openTalkThread(client, issue) {
  const fresh = issues.get(issue.id);
  const hubId = settings.get(fresh.guild_id)?.board_channel_id;
  if (fresh.talk_thread_id) {
    try {
      const t = await client.channels.fetch(fresh.talk_thread_id);
      if (t.archived) await t.setArchived(false).catch(() => {});
      await renameTalk(t, fresh);
      return { thread: t, existing: true };
    } catch { /* gone: make a new one */ }
  }
  if (!hubId) throw new Error('no-hub');
  const hub = await client.channels.fetch(hubId);
  const thread = await hub.threads.create({
    name: talkName(fresh), type: ChannelType.PublicThread,
    autoArchiveDuration: 1440, reason: `Developer thread for issue #${fresh.id}`,
  });
  issues.setTalkThread(fresh.id, thread.id);
  await thread.send(talkIntro(fresh)).catch(() => {});
  await postTalkHistory(client, fresh, thread);
  await thread.setLocked(true, 'Only developers write here').catch(() => {}); // a locked thread can only be written in by people with Manage Threads (and the bot)
  return { thread, existing: false };
}

/**
 * Keep the thread in step with the issue: New / Seen / Being fixed issues each have one (created automatically once a hub
 * channel is set); a closed issue's thread is archived unless another open issue still uses it. Serialised per issue so two
 * reports at once never make two threads. Never throws.
 */
export function syncTalkThread(client, issue) {
  const turn = (talkLocks.get(issue.id) ?? Promise.resolve()).catch(() => {}).then(async () => {
    try {
      const fresh = issues.get(issue.id);
      if (!fresh || !settings.get(fresh.guild_id)?.board_channel_id) return;
      if (OPEN_STATUSES.includes(fresh.status)) await openTalkThread(client, fresh);
      else if (fresh.talk_thread_id && !issues.byTalkThread(fresh.talk_thread_id).some((x) => OPEN_STATUSES.includes(x.status))) {
        const t = await client.channels.fetch(fresh.talk_thread_id);
        await renameTalk(t, fresh);
        if (!t.archived) await t.setArchived(true, `Issue ${fresh.status}`);
      }
    } catch (e) {
      console.error('Developer thread sync failed:', e.message);
      // Say so in the hub (at most once an hour) instead of failing silently, usually a missing permission.
      const g = issue.guild_id, hub = settings.get(g)?.board_channel_id;
      if (hub && Date.now() - (threadWarned.get(g) ?? 0) > 3600e3) {
        threadWarned.set(g, Date.now());
        try { await (await client.channels.fetch(hub)).send(`⚠️ I couldn't create the thread for issue #${issue.id}: ${e.message}\nCheck the bot has **Create Public Threads**, **Send Messages in Threads** and **Manage Threads** in this channel, then press **Developer → Process previous requests into threads**.`); } catch { /* no access at all */ }
      }
    }
  });
  talkLocks.set(issue.id, turn);
  turn.finally(() => { if (talkLocks.get(issue.id) === turn) talkLocks.delete(issue.id); });
  return turn;
}

/**
 * A developer merged `from` into `into`: the merged-away issue's thread gets a pointer and is archived (or, if the surviving
 * issue had none, it takes that thread over). Call BEFORE mergeIssues. Never throws.
 */
export async function carryTalkOnMerge(client, from, into) {
  try {
    const src = issues.get(from.id);
    const dst = issues.get(into.id);
    if (!src?.talk_thread_id || !dst || src.talk_thread_id === dst.talk_thread_id) return;
    const old = src.talk_thread_id;
    const o = await client.channels.fetch(old);
    if (o.archived) await o.setArchived(false).catch(() => {});
    if (dst.talk_thread_id) {
      issues.setTalkThread(src.id, null);
      await o.send(`🔀 Merged into #${dst.id}; the discussion continues in <#${dst.talk_thread_id}>.`).catch(() => {});
      try { const t = await client.channels.fetch(dst.talk_thread_id); await t.send(`🔀 Issue **#${src.id} – ${trunc(src.title, 120)}** was merged into this one (earlier discussion: <#${old}>).`).catch(() => {}); } catch { /* gone */ }
      if (!issues.byTalkThread(old).length) await o.setArchived(true, 'Issue merged');
    } else {
      issues.setTalkThread(dst.id, old); // the surviving issue takes the thread over
      await o.send(`🔀 Issue **#${src.id}** was merged into **#${dst.id} – ${trunc(dst.title, 120)}**; this thread now covers it.`).catch(() => {});
    }
  } catch (e) { console.error('Thread merge failed:', e.message); }
}

/**
 * Post what is already known about an issue into its thread: every report (who, when, platform/version, text), the developer note,
 * the owner and the recent activity. Once per issue. Never throws. Returns true when it was posted.
 */
export async function postTalkHistory(client, issue, thread = null) {
  try {
    const fresh = issues.get(issue.id);
    if (!fresh || fresh.talk_history) return false;
    const t = thread ?? await client.channels.fetch(fresh.talk_thread_id);
    const when = (ms) => `<t:${Math.floor(ms / 1000)}:d>`;
    const lines = ['📜 **History so far**'];
    const list = [...reports.forIssue(fresh.id)].reverse();
    list.forEach((r, n) => {
      const who = r.user_id === '0' ? '_removed user_' : `<@${r.user_id}>`;
      const meta = [r.platform, r.version && `v${r.version}`].filter(Boolean).join(' · ');
      lines.push(`**${n === 0 ? 'Requester' : 'Report'}** ${who} ${when(r.created_at)}${meta ? ` · ${meta}` : ''}\n> ${trunc(String(r.text).replace(/\s+/g, ' '), 600)}`);
    });
    if (fresh.owner_id) lines.push(`🙌 Owner: <@${fresh.owner_id}>`);
    if (fresh.dev_note) lines.push(`💬 **Developer note:** ${trunc(fresh.dev_note, 600)}`);
    const evs = events.forIssue(fresh.id, 15).reverse();
    if (evs.length) lines.push('**Activity**\n' + evs.map((e) => `${when(e.created_at)} ${e.kind}${e.detail ? `: ${trunc(e.detail, 120)}` : ''}`).join('\n'));
    let chunk = '';
    for (const line of lines) {
      if (chunk && chunk.length + line.length + 2 > 1900) { await t.send(chunk); chunk = ''; }
      chunk += (chunk ? '\n\n' : '') + line;
    }
    if (chunk) await t.send(chunk);
    issues.setTalkHistory(fresh.id, 1);
    return true;
  } catch (e) { console.error('Posting thread history failed:', e.message); return false; }
}

/**
 * Process all earlier requests into threads: every New / Seen / Being fixed issue gets its thread (if missing) and has its history
 * posted into it (if not already). Nobody is notified. Returns { threads, histories, failed }.
 */
export async function processPrevious(client, guildId) {
  const out = { threads: 0, histories: 0, failed: 0 };
  for (const x of issues.list(guildId)) {
    if (!OPEN_STATUSES.includes(x.status)) continue;
    if (x.talk_thread_id) { // a thread someone deleted: forget it, so a new one is made and its history is posted again
      try { await client.channels.fetch(x.talk_thread_id); }
      catch (e) { if (e.code === 10003 || e.status === 404) { issues.setTalkThread(x.id, null); issues.setTalkHistory(x.id, 0); } }
    }
    const had = !!issues.get(x.id).talk_thread_id;
    await syncTalkThread(client, x);
    let cur = issues.get(x.id);
    if (!cur?.talk_thread_id) { out.failed++; continue; }
    if (!had) out.threads++;
    if (had) try { // older threads: give the first (bot) message the status menu too
      const t = await client.channels.fetch(cur.talk_thread_id);
      const first = (await t.messages.fetch({ after: '0', limit: 1 })).first();
      if (first?.author.id === client.user.id && !first.components.some((r) => r.components.some((c) => c.customId?.startsWith('stbtn:')))) await first.edit(talkIntro(cur));
    } catch { /* leave it */ }
    if (!cur.talk_history && await postTalkHistory(client, cur)) out.histories++;
  }
  return out;
}

/** Post a line in the issue's developer thread (notes, status changes, player activity). Never throws. */
export async function talkSay(client, issue, text) {
  const fresh = issues.get(issue.id);
  if (!fresh?.talk_thread_id) return;
  try { const t = await client.channels.fetch(fresh.talk_thread_id); await t.send(text); await keepHidden(t, fresh); } catch { /* thread gone */ }
}

/**
 * Post a player's own words into the issue's developer thread, live: who, what kind of action, platform/version and the text itself.
 * Call BEFORE syncTalkThread so a thread created just now (whose history already holds this report) does not get it twice. Never throws.
 */
export async function talkReport(client, issue, { label, userId, text, platform, version }) {
  const fresh = issues.get(issue.id);
  if (!fresh?.talk_thread_id) return;
  const meta = [platform, version && `v${version}`].filter(Boolean).join(' · ');
  const body = String(text ?? '').trim();
  try {
    const t = await client.channels.fetch(fresh.talk_thread_id);
    await t.send({
      content: trunc(`${label} <@${userId}>${meta ? ` · ${meta}` : ''}${body ? `\n> ${body.replace(/\s+/g, ' ')}` : ''}`, 1900),
      allowedMentions: { parse: [] },
    });
    await keepHidden(t, fresh);
  } catch { /* thread gone */ }
}

/** Delete an issue's tracker message and thread (used when an issue is removed outright). */
export async function removeMessage(client, issue) {
  if (!issue) return;
  const sharedTalk = issue.talk_thread_id && issues.byTalkThread(issue.talk_thread_id).some((x) => x.id !== issue.id);
  for (const [ch, msg] of [[issue.thread_id, null], [sharedTalk ? null : issue.talk_thread_id, null], [issue.channel_id, issue.message_id]]) {
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
  const sharedTalk = issue.talk_thread_id && issues.byTalkThread(issue.talk_thread_id).some((x) => x.id !== issue.id);
  for (const th of [issue.thread_id, sharedTalk ? null : issue.talk_thread_id]) {
    if (th) try { const t = await client.channels.fetch(th); await t.setLocked(true); await t.setArchived(true); } catch { /* gone */ }
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
  const affected = new Set(); // every issue the person's text was on
  let removed = 0;
  let anonymised = 0;
  for (const r of reports.byUser(guildId, userId)) {
    const issue = issues.get(r.issue_id);
    if (!issue) continue;
    affected.add(issue.id);
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
  // A proposed (unpublished) knowledge article copies text from the reports on its issue: drop those drafts too.
  for (const id of affected) { const a = articles.forIssue(id); if (a?.draft) articles.delete(a.id); }
  watchers.removeUser(guildId, userId);
  events.clearActor(userId);
  prefs.delete(userId);
  seen.removeUser(userId);
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

const DM_GAP_MS = Number(process.env.DM_GAP_MS ?? 150);

/** DM everyone who reported or follows the issue and hasn't turned DMs off (best effort). */
export async function notifyReporters(client, issue, text, only = null) {
  const ids = [...new Set([...reports.forIssue(issue.id).map((r) => r.user_id), ...watchers.forIssue(issue.id)])]
    .filter((id) => (!only || only.includes(id)) && id !== '0' && !prefs.dmOff(id)).slice(0, 500);
  for (const id of ids) {
    try { await (await client.users.fetch(id)).send(text); } catch { /* DMs closed */ }
    if (DM_GAP_MS) await new Promise((r) => setTimeout(r, DM_GAP_MS)); // a long run of DMs sent back to back looks like spam to Discord
  }
}

