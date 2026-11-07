import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, Client,
  EmbedBuilder, FileUploadBuilder, GatewayIntentBits, LabelBuilder, MessageFlags, ModalBuilder, PermissionFlagsBits, SlashCommandBuilder,
  StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { semanticScores, warmEmbeddings } from './embed.js';
import { articles, restoreArticles, db, decisions, events, evidence, issues, kbStats, prefs, reports, restoredFrom, seen, settings, summary, watchers } from './db.js';
import { erasePayload, privacyPayload, termsPayload } from './legal.js';
import { CATEGORIES } from './categories.js';
import { PRIORITIES, STATUSES, person, renderIssue } from './render.js';
import { relatedIssues } from './related.js';
import { extractLinks, KIND_EMOJI } from './evidence.js';
import { errorMessage, explainError, fileFailureReason } from './errors.js';
import { pathToFileURL } from 'node:url';
import { MAX_FILE_MB, readStored, storedSize } from './evidenceStore.js';
import {
  attachEvidence, readScreenshots, purgeEvidence, duplicatePairs, fileReport, findFixedMatch, mergeIssues, notifyReporters, postChangelog, removeMessage, retireMessage,
  eraseUser, purgeExpired, archiveFixedThreads, autoMergeDuplicates, rematchReport, splitReport, syncMessage, threadSay, openTalkThread, joinTalkThread, talkSay,
} from './service.js';
import { faqEntries, KB, suggest } from './kb.js';
import { boardPayload, confirmMovePayload, movePayload, postBoard, sectionPayload } from './board.js';
import { buildDigest, postDigest, runDigests, runNudges } from './digest.js';
import { answerTitle, isWeak, weakAnswers } from './health.js';
import { seedArticles } from './seed.js';
import { exportCsv } from './export.js';
import { backupNow, maybeBackup } from './backup.js';
import { trunc } from './text.js';
import { versionLabel } from './version.js';
import { confirmUpdate, rollbackIfCrashLooping } from './updater.js';

const EPH = MessageFlags.Ephemeral;
/** One count per person, per answer, per kind of reaction, per hour – so nobody can steer the answer ranking by clicking in a loop. */
const statSeen = new Map();
function bumpStat(i, articleId, field) {
  const key = `${i.guildId}|${i.user.id}|${articleId}|${field}`;
  if ((statSeen.get(key) ?? 0) > Date.now()) return;
  statSeen.set(key, Date.now() + 3_600_000);
  kbStats.bump(i.guildId, articleId, field);
}
/** People whose report is being sent right now: a second click/submit meanwhile would slip past the cooldown. */
const filing = new Set();
const busyMsg = { content: '⏳ Your report is still being sent – one moment.', flags: EPH };
const NONE = '-'; // "no filter" placeholder inside custom ids
const row = (...c) => new ActionRowBuilder().addComponents(...c);
const btn = (id, label, emoji, style = ButtonStyle.Secondary) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style);

// The only slash command: it bootstraps the control panel. Everything else is buttons, menus and modals.
const commands = [
  new SlashCommandBuilder().setName('setup').setDescription('Set up the issue tracker and post its control panel in this channel (admins)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((o) => o.setName('issues_channel').setDescription('Channel for the control panel').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addRoleOption((o) => o.setName('dev_role').setDescription('Developer role – can manage issues and use the Developer menu').setRequired(true))
    .addRoleOption((o) => o.setName('reporter_role').setDescription('Only this role can send reports (leave empty to keep the current setting)'))
    .addRoleOption((o) => o.setName('article_role').setDescription('Can create, edit and delete knowledge articles without being a developer'))
    .addIntegerOption((o) => o.setName('retention_days').setDescription('Delete closed issues after this many days of no activity (0 = keep them)').setMinValue(0).setMaxValue(3650))
    .addBooleanOption((o) => o.setName('auto_merge').setDescription('Automatically merge open issues that are almost identical (80%+ alike)')),
].map((c) => c.toJSON());

// Nothing the bot sends may ping anyone by accident: players' own words (an issue title like "@everyone fix this") end up in
// thread messages, so mentions are switched off for every message unless a call asks otherwise.
const client = new Client({ intents: [GatewayIntentBits.Guilds], allowedMentions: { parse: [], repliedUser: false } });

// ---------- helpers ----------

const cfgOf = (guildId) => ({ threshold: 0.25, stale_days: 7, cooldown_sec: 60, retention_days: 0, ...settings.get(guildId) });
const trackerChannel = (i) => settings.get(i.guildId)?.channel_id;
const idOf = (i) => Number(i.customId.split(':')[1]);

/** Does the person holding this interaction have the role? Discord hands over the roles as a manager OR (when the server isn't cached) a plain list of ids. */
function hasRole(i, roleId) {
  const roles = i.member?.roles;
  if (!roleId || !roles) return false;
  return Array.isArray(roles) ? roles.includes(roleId) : !!roles.cache?.has(roleId);
}

function isDev(i) {
  const cfg = settings.get(i.guildId);
  if (i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  return hasRole(i, cfg?.dev_role_id);
}
/** Role required to create reports: the /setup value, else REPORTER_ROLE_ID from .env, else nobody is restricted. */
const reporterRole = (guildId) => settings.get(guildId)?.reporter_role_id || process.env.REPORTER_ROLE_ID || null;

/** Developers can always report; everyone else needs the reporter role (when one is configured). */
function canReport(i) {
  const role = reporterRole(i.guildId);
  return !role || isDev(i) || hasRole(i, role);
}
/** Role that may manage knowledge articles without being a full developer: the /setup value, else ARTICLE_ROLE_ID from .env. */
const articleRole = (guildId) => settings.get(guildId)?.article_role_id || process.env.ARTICLE_ROLE_ID || null;

/** Developers can always manage knowledge articles; so can members of the article editor role. Nothing else is unlocked. */
function canManageArticles(i) {
  const role = articleRole(i.guildId);
  return isDev(i) || hasRole(i, role);
}
const noArticleAccess = (i) => i.reply({
  content: articleRole(i.guildId)
    ? `🔒 Knowledge articles can only be changed by developers and members with the <@&${articleRole(i.guildId)}> role.`
    : '🔒 Knowledge articles can only be changed by developers.',
  allowedMentions: { parse: [] },
  flags: EPH,
});

const noReportAccess = (i) => i.reply({
  content: `🔒 Sending reports is limited to members with the <@&${reporterRole(i.guildId)}> role. You can still browse issues and read the answers.`,
  allowedMentions: { parse: [] },
  flags: EPH,
});

const devOnly = (i, what) => i.reply({ content: `🔒 This is for developers only – only developers can ${what}.`, flags: EPH });

async function loadIssue(i, id) {
  const issue = issues.get(id);
  if (!issue || issue.guild_id !== i.guildId) {
    await i.reply({ content: `Issue #${id} isn't available any more – it may have been merged into another issue or removed.`, flags: EPH });
    return null;
  }
  return issue;
}

/** Seconds a (non-developer) user must still wait before filing another report. */
function cooldownLeft(i) {
  const cd = cfgOf(i.guildId).cooldown_sec;
  if (!cd || isDev(i)) return 0;
  const last = reports.lastByUser(i.guildId, i.user.id);
  return last ? Math.max(0, Math.ceil((last + cd * 1000 - Date.now()) / 1000)) : 0;
}
const waitMsg = (s) => ({ content: `⏳ Hang on a moment – you can send another report in ${s} second${s === 1 ? '' : 's'}. (This pause stops spam.)`, flags: EPH });

// ---- "one public message, everything else hidden" helpers ----
/** Is this interaction coming from a hidden (ephemeral) message? */
const hidden = (i) => !!i.message?.flags?.has(MessageFlags.Ephemeral);
/** Show a screen privately: replace the hidden menu we came from, or open a new hidden message from a public one. */
const show = (i, payload) => (hidden(i) ? i.update(payload) : i.reply({ ...payload, flags: EPH }));
const deferHidden = (i) => (hidden(i) ? i.deferUpdate() : i.deferReply({ flags: EPH }));
/** If an issue card was opened from a menu, keep its Back button when the card is redrawn. */
const backOf = (i) => i.message?.components?.flatMap((r) => r.components ?? []).find((c) => ['browse', 'dev:board'].includes(c.customId))?.customId;
/** What this person may do, so an issue card only shows the controls they can use. */
const viewerOf = (i) => ({ dev: isDev(i), report: canReport(i), article: canManageArticles(i), userId: i.user.id });
const card = (i, issue) => renderIssue(issue, { back: backOf(i), viewer: viewerOf(i) });

// The one-line "describe it" a player typed while looking through known problems. Kept in memory only (never
// stored in the database), for 15 minutes, to rank the list and to pre-fill the report form.
const drafts = new Map();
const setDraft = (userId, text) => (text ? drafts.set(userId, { text, exp: Date.now() + 15 * 60_000 }) : drafts.delete(userId));
const getDraft = (userId) => {
  const d = drafts.get(userId);
  return d && d.exp > Date.now() ? d.text : '';
};

// A report waiting on the "this was already fixed" screen: kept in memory only, for 30 minutes, until the player decides.
const pendingFixed = new Map();

/** Shown before a report is filed when it looks like a problem developers already fixed. */
function alreadyFixedPayload(issue) {
  const embed = new EmbedBuilder().setColor(0x2ecc71).setTitle(trunc(`✅ Already fixed: #${issue.id} · ${issue.title}`, 256))
    .addFields({ name: 'Fixed in', value: issue.fixed_version ? `\`${issue.fixed_version}\` (or newer)` : 'The next update', inline: true });
  if (issue.dev_note) embed.addFields({ name: 'Developer note', value: trunc(issue.dev_note, 1000) });
  return {
    content: `✅ **This looks like a problem that has already been fixed.**\n${issue.fixed_version ? `Update to version \`${issue.fixed_version}\` (or newer) and check if it still happens.` : 'Check if it still happens after the next update.'}\nYour report has **not** been sent yet.`,
    embeds: [embed],
    components: [row(btn(`fxok:${issue.id}`, 'That fixed it', '🎉', ButtonStyle.Success), btn(`fxsend:${issue.id}`, 'Still happening – send my report', '📝'))],
  };
}

// ---------- panel, modals & forms ----------

/** What developers should look at: brand-new issues nobody has opened, issues gone quiet, and open high-priority ones. */
function attention(guildId) {
  const staleBefore = Date.now() - cfgOf(guildId).stale_days * 864e5;
  const list = issues.list(guildId);
  const fresh = list.filter((x) => x.status === 'new').length;
  const stale = list.filter((x) => (x.status === 'seen' || x.status === 'in_progress') && x.updated_at < staleBefore).length;
  const urgent = list.filter((x) => ['new', 'seen', 'in_progress'].includes(x.status) && ['critical', 'high'].includes(x.priority)).length;
  const staleIds = new Set(list.filter((x) => (x.status === 'seen' || x.status === 'in_progress') && x.updated_at < staleBefore).map((x) => x.id));
  const followups = issues.followUps(guildId).filter((id) => !staleIds.has(id)).length; // a player wrote again after the last developer reply
  return { fresh, stale, urgent, followups, total: fresh + stale + followups, days: cfgOf(guildId).stale_days };
}

/** Redraw the public panel so its Developer button shows the current count. Debounced: a burst of reports edits it once. */
const panelTimers = new Map();
const panelShown = new Map(); // what each panel last showed, so the live counts are only re-posted when they change
function refreshPanel(guildId) {
  if (panelTimers.has(guildId)) return;
  const t = setTimeout(async () => {
    panelTimers.delete(guildId);
    const cfg = settings.get(guildId);
    if (!cfg?.panel_channel_id || !cfg.panel_message_id) return;
    try {
      const payload = panelPayload(guildId);
      const key = JSON.stringify(payload.embeds[0].toJSON()) + JSON.stringify(payload.components.map((c) => c.toJSON()));
      if (panelShown.get(guildId) === key) return; // nothing changed: don't edit the message
      await (await (await client.channels.fetch(cfg.panel_channel_id)).messages.fetch(cfg.panel_message_id)).edit(payload);
      panelShown.set(guildId, key);
    } catch (e) { console.error(`Could not refresh the panel in ${guildId}: ${e.message}`); }
  }, 5000);
  t.unref?.();
  panelTimers.set(guildId, t);
}

/** A new issue was filed or a fixed one came back: tell the developers where they'll see it (pinging them only when it's urgent). */
const lastPing = new Map();
const PING_GAP_MS = Number(process.env.ROLE_PING_GAP_MIN ?? 10) * 60_000;
async function alertDevs(issue, why) {
  try {
    const chId = cfgOf(issue.guild_id).dev_channel_id;
    if (!chId) return; // no developer channel chosen: the panel button and developer menu still show the count
    const urgent = why === 'reopened' || ['critical', 'high'].includes(issue.priority);
    let role = urgent ? settings.get(issue.guild_id)?.dev_role_id : null;
    // A player can write "crash…" to make an urgent issue, so the role is pinged at most once per 10 minutes per server.
    if (role && Date.now() - (lastPing.get(issue.guild_id) ?? 0) < PING_GAP_MS) role = null;
    if (role) lastPing.set(issue.guild_id, Date.now());
    const pr = PRIORITIES[issue.priority] ?? PRIORITIES.normal;
    await (await client.channels.fetch(chId)).send({
      content: `${role ? `<@&${role}> ` : ''}${why === 'reopened' ? '⚠️ **Reopened**' : '🆕 **New issue**'} #${issue.id} · ${pr.emoji} ${pr.label} · ${trunc(issue.title.replace(/\s+/g, ' '), 150)}`,
      components: [row(btn(`alert:open:${issue.id}`, 'Open card', '📋', ButtonStyle.Primary))],
      allowedMentions: role ? { roles: [role] } : { parse: [] },
    });
  } catch (e) { console.error('Could not alert the developers:', e.message); }
}

function panelPayload(guildId) {
  const todo = guildId ? attention(guildId).total : 0;
  const open = guildId ? issues.list(guildId) : [];
  const waiting = open.filter((x) => x.status === 'new').length;
  const answered = open.filter((x) => ['seen', 'fixed', 'cannot_reproduce', 'wont_fix'].includes(x.status)).length;
  const working = open.filter((x) => x.status === 'in_progress').length;
  const kbCount = guildId ? articles.list(guildId).filter((a) => !a.draft).length : 0;
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('Echo VR – Problem Tracker').setFooter({ text: `Bot ${versionLabel()}` })
    .setDescription([
      'Something not working? Let the developers know here.',
      '',
      '📝 **Report a problem** – we\'ll first show quick fixes for common problems. If none help, you can send a report.',
      '',
      '📋 **Known issues** – see what has already been reported and how it\'s going.',
      `• **${waiting}** waiting for a developer reply`,
      `• **${answered}** answered by a developer`,
      `• **${working}** being worked on`,
      '',
      '📌 **My issues** – follow your reports, see developer replies (marked 🔴 until you read them), add details, and turn update messages on or off.',
      '',
      '📚 **Knowledge articles** – quick fixes players see before sending a report.',
      `• **${KB.length}** built-in answers`,
      `• **${kbCount}** written by the team`,
      '',
      '_Everything you open from these buttons is private – only you can see it._',
    ].join('\n'));
  return {
    embeds: [embed],
    components: [
      row(btn('report', 'Report a problem', '📝', ButtonStyle.Primary), btn('browse', 'Known issues', '📋'), btn('mine', 'My issues', '📌'),
        btn('legal:privacy', 'Data & privacy', '🔒'), btn('legal:terms', 'Terms of use', '📜')),
      row(todo ? btn('dev:menu', `Developer · ${todo} need attention`, '🔴', ButtonStyle.Danger) : btn('dev:menu', 'Developer', '🛠️'), btn('dev:articles', 'Knowledge articles', '📚')),
    ],
  };
}

/** Everything developers need, one hidden menu behind a single button on the panel. */
function devMenuPayload(guildId) {
  const a = guildId ? attention(guildId) : null;
  const parts = a ? [a.fresh && `🆕 **${a.fresh}** new issue${a.fresh === 1 ? '' : 's'} nobody has looked at`, a.stale && `⏳ **${a.stale}** quiet for ${a.days}+ days`, a.followups && `💬 **${a.followups}** where a player wrote again after your last reply`, a.urgent && `🔴 **${a.urgent}** open with high or critical priority`].filter(Boolean) : [];
  return {
    content: `**🛠️ Developer menu** · bot ${versionLabel()} – only you can see this.\n${parts.length ? `⚠️ **Needs attention:** ${parts.join(' · ')}` : '✅ Nothing needs attention right now.'}`,
    embeds: [],
    components: [
      row(btn('dev:board', a?.fresh ? `Board (${a.fresh} new)` : 'Board', '📌', a?.total ? ButtonStyle.Danger : ButtonStyle.Secondary), btn('dev:dups', 'Review duplicates', '🔍'), btn('dev:articles', 'Knowledge articles', '📚')),
      row(btn('dev:settings', 'Settings', '⚙️'), btn('dev:digest', 'Digest', '📊')),
      row(btn('dev:export', 'Export CSV', '📤'), btn('dev:backup', 'Back up now', '💾')),
    ],
  };
}

/** What an article editor (not a developer) sees behind the panel's Developer button: just the article tools. */
function articleMenuPayload() {
  return {
    content: '**📚 Knowledge article editor** – only you can see this. You can create, edit, disable and delete the answers players are shown, and see how well they work.',
    embeds: [],
    components: [row(btn('dev:articles', 'Knowledge articles', '📚', ButtonStyle.Primary))],
  };
}

const input = (id, label, { style = TextInputStyle.Short, max = 100, required = false, placeholder, value, min } = {}) => {
  const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setMaxLength(max).setRequired(required);
  if (placeholder) t.setPlaceholder(placeholder);
  if (value) t.setValue(value);
  if (min) t.setMinLength(min);
  return row(t);
};
// Report forms use labelled fields so they can include a file-upload box next to the text boxes.
const labelled = (label, textInput, description) => {
  const l = new LabelBuilder().setLabel(label).setTextInputComponent(textInput);
  return description ? l.setDescription(description) : l;
};
const lText = (id, { style = TextInputStyle.Short, max = 100, required = false, placeholder, min, value } = {}) => {
  const t = new TextInputBuilder().setCustomId(id).setStyle(style).setMaxLength(max).setRequired(required);
  if (placeholder) t.setPlaceholder(placeholder);
  if (value) t.setValue(String(value).slice(0, max));
  if (min) t.setMinLength(min);
  return t;
};
const platformField = () => labelled('Headset / platform (optional)', lText('platform', { max: 60, placeholder: 'e.g. Quest 3 via Link, Rift S, Index' }));
const versionField = () => labelled('When did you last update / Version Number', lText('version', { max: 60, placeholder: 'e.g. 0.13.14, or last week' }), 'Optional');
const evidenceFields = () => [
  labelled('Links: screenshots, logs, videos (optional)',
    lText('links', { style: TextInputStyle.Paragraph, max: 1000, placeholder: 'https://…  (one per line)' }),
    'YouTube, Imgur, Pastebin… up to 5. Only you and the developers can open them.'),
  new LabelBuilder().setLabel('Upload images, logs or videos (optional)')
    .setDescription(`Up to 5 files, ${MAX_FILE_MB} MB each. Only you and developers can open them. Big videos: use a link.`)
    .setFileUploadComponent(new FileUploadBuilder().setCustomId('files').setMinValues(0).setMaxValues(5).setRequired(false)),
];

const reportModal = (kind = 'bug', prefill = '') => new ModalBuilder().setCustomId(`report:${kind}`)
  .setTitle(kind === 'install' ? 'Report an install issue' : 'Report a bug in the game').addLabelComponents(
    labelled(kind === 'install' ? 'What happened? (device, step, error)' : 'What went wrong? (what, when, how often)',
      lText('text', { style: TextInputStyle.Paragraph, max: 1000, required: true, min: 15, value: prefill })),
    platformField(), versionField(), ...evidenceFields());

/** A one-line box shown before the list of known problems. Only used to put the most likely fixes first. */
const quickModal = (kind) => new ModalBuilder().setCustomId(`faqq:${kind}`)
  .setTitle(kind === 'install' ? 'Install issue' : 'Bug in the game').addLabelComponents(
    labelled('What\'s going wrong? (optional)',
      lText('text', { style: TextInputStyle.Paragraph, max: 300, placeholder: 'e.g. the game crashes when the lobby loads' }),
      'A few words are enough. We\'ll use them to show the most likely fixes first. You can skip this.'));

/** Step 1 of reporting: is it an install problem or a bug in the game? */
const reportTypePayload = () => ({
  content: '**What kind of problem do you have?**\n🔧 **Install issue** – you can\'t install, update or download Echo VR (or its installer / launcher)\n🐞 **Bug in game** – something goes wrong while you\'re playing',
  embeds: [],
  components: [row(btn('rtype:install', 'Install issue', '🔧', ButtonStyle.Primary), btn('rtype:bug', 'Bug in game', '🐞', ButtonStyle.Primary))],
});

/**
 * Step 2: try to answer it before any ticket exists – "is your problem one of these?"
 * `matches` = fuzzy matches for what the player just described (best first); the rest follow, so nothing is hidden.
 */
const FAQ_PAGE = 25; // a dropdown holds at most 25 options, so longer lists are paged
function faqPayload(guildId, kind, matches = [], page = 0) {
  const entries = faqEntries(kind, articles.list(guildId, { enabledOnly: true }));
  const helped = (e) => kbStats.get(guildId, e.id).helped;
  const matchScore = new Map(matches.map((m) => [m.id, m.score]));
  const rest = [...entries.filter((e) => e.custom), ...entries.filter((e) => !e.custom).sort((a, b) => helped(b) - helped(a))];
  const sorted = [...entries.filter((e) => matchScore.has(e.id)).sort((a, b) => matchScore.get(b.id) - matchScore.get(a.id)),
    ...rest.filter((e) => !matchScore.has(e.id))];
  const pages = Math.max(1, Math.ceil(sorted.length / FAQ_PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const shown = sorted.slice(page * FAQ_PAGE, (page + 1) * FAQ_PAGE);
  const label = kind === 'install' ? '🔧 **Install issue**' : '🐞 **Bug in game**';
  const hint = matchScore.size ? '⭐ marks the closest matches to what you wrote.' : 'Pick the one that sounds like yours to see the fix.';
  return {
    content: `${label} – does one of these sound like your problem? ${hint}\nIf not, press **None of these** to send a report.`,
    embeds: [],
    components: [
      row(new StringSelectMenuBuilder().setCustomId(`faq:${kind}`).setPlaceholder('Pick the one that matches…')
        .addOptions(shown.map((e) => ({
          label: trunc(e.title, 100), value: e.id, emoji: matchScore.has(e.id) ? '⭐' : e.custom ? '📚' : '💡',
          ...(matchScore.has(e.id) ? { description: `Closest match · ${Math.round(matchScore.get(e.id) * 100)}%` } : {}),
        })))),
      row(btn(`rform:${kind}`, 'None of these – send a report', '📝', ButtonStyle.Primary)),
      ...(pages > 1 ? [row(btn(`faqp:${kind}:${page - 1}`, 'Previous', '◀️').setDisabled(page === 0), btn('faqp:noop', `Page ${page + 1} of ${pages}`, '📄').setDisabled(true),
        btn(`faqp:${kind}:${page + 1}`, 'Next', '▶️').setDisabled(page >= pages - 1))] : []),
    ],
  };
}

/**
 * What players' reactions teach the matcher: answers that often fix the problem rank a little higher, and ones
 * players keep calling "not my problem" rank a little lower (only after at least 5 views, and never by more than 20%).
 */
function kbBoosts(guildId) {
  const boosts = new Map();
  for (const s of kbStats.forGuild(guildId)) {
    if (s.shown >= 5) boosts.set(s.article_id, 1 + 0.2 * Math.max(-1, Math.min(1, (s.helped - s.denied) / s.shown)));
  }
  return boosts;
}

/** The list for this player, ranked by what they described (if anything). */
const faqFor = async (i, kind, page = 0) => {
  const text = getDraft(i.user.id);
  const list = articles.list(i.guildId, { enabledOnly: true });
  const matches = text ? suggest(text, list, 25, kind, kbBoosts(i.guildId), await semanticScores(text, list)) : [];
  return faqPayload(i.guildId, kind, matches, page);
};

/** The answer screen: did it fix it, is it not your problem (back to the list), or report it anyway. */
function faqAnswerPayload(entry, kind) {
  const embed = new EmbedBuilder().setColor(0xfee75c).setTitle(`💡 ${trunc(entry.title, 250)}`).setDescription(trunc(entry.fix, 4000))
    .setFooter({ text: `Source: ${entry.source}` });
  return {
    content: 'Give this a try:',
    embeds: [embed],
    components: [row(
      btn(`faqok:${kind}:${entry.id}`, 'That fixed it!', '✅', ButtonStyle.Success),
      btn(`faqno:${kind}:${entry.id}`, "That's not my problem", '🙅'),
      btn(`rform:${kind}:${entry.id}`, "Didn't help – send a report", '📝'),
    )],
  };
}

const meTooModal = (issue) => new ModalBuilder().setCustomId(`plus:${issue.id}`).setTitle(`I have this too · #${issue.id}`).addLabelComponents(
  labelled('Anything to add? (optional)', lText('text', { style: TextInputStyle.Paragraph, max: 1000 })),
  platformField(), versionField(), ...evidenceFields());

const countLine = (n) => `${n} attachment${n === 1 ? '' : 's'}/link${n === 1 ? '' : 's'}`;
/** A "couldn't save" line for uploaded files that failed (too large, download problem). */
const failNote = (ev) => (ev.failed.length
  ? `\n⚠️ Couldn't save ${ev.failed.map((f) => `**${trunc(f.name, 40)}** (${fileFailureReason(f.reason, MAX_FILE_MB)})`).join(', ')}.${ev.failed.some((f) => f.reason === 'too large') ? ' For big videos, paste a link instead.' : ''}`
  : '');

/**
 * Show attachments privately in a hidden message. Callers have already checked that the viewer is the person who
 * sent them or a developer – this is the only place stored files ever leave the bot.
 */
const SEND_LIMIT = 9 * 1024 * 1024; // what fits safely in one Discord message
const MAX_ATTACHED = 30;            // files shown per request; the rest are listed by name
async function sendEvidence(i, rows, heading) {
  if (!rows.length) return i.reply({ content: 'There are no attachments yet.', flags: EPH });
  await i.deferReply({ flags: EPH }); // reading and uploading files can take a while – acknowledge first
  const lines = [heading];
  // Plan first (sizes only), read files only while sending: a big issue never has all its files in memory at once, and
  // every message stays under Discord's size and count limits so one large file cannot make the whole view fail.
  const batches = [[]];
  let batchBytes = 0;
  let attached = 0;
  let lastReport = null;
  for (const r of rows) {
    if (r.report_id !== lastReport) {
      lastReport = r.report_id;
      lines.push(`\n**Report #${r.report_id}** – requested by ${r.user_id === '0' ? 'a removed user' : `<@${r.user_id}>`}`);
    }
    const emoji = KIND_EMOJI[r.kind] ?? '📎';
    if (!r.path) { lines.push(`• ${emoji} ${r.url}`); continue; }
    const size = storedSize(r.path);
    if (size == null) lines.push(`• ${emoji} ${trunc(r.name, 80)} _(file is no longer available)_`);
    else if (size > SEND_LIMIT) lines.push(`• ${emoji} ${trunc(r.name, 80)} _(${(size / 1048576).toFixed(1)} MB – too big to show here)_`);
    else if (attached >= MAX_ATTACHED) lines.push(`• ${emoji} ${trunc(r.name, 80)} _(not shown – too many files at once; open one report at a time)_`);
    else {
      let batch = batches.at(-1);
      if (batch.length >= 10 || batchBytes + size > SEND_LIMIT) { batch = []; batches.push(batch); batchBytes = 0; }
      batch.push(r); batchBytes += size; attached++;
      lines.push(`• ${emoji} ${trunc(r.name, 80)} _(attached)_`);
      if (r.ocr_text) lines.push(`  🔎 _Text read from the image:_ ${trunc(r.ocr_text.replace(/\s+/g, ' '), 220)}`);
    }
  }
  const build = (batch) => batch.flatMap((r) => { const data = readStored(r.path); return data ? [new AttachmentBuilder(data, { name: r.name })] : []; });
  await i.editReply({ content: trunc(lines.join('\n'), 1900), allowedMentions: { parse: [] }, files: build(batches[0]) });
  for (const batch of batches.slice(1)) await i.followUp({ files: build(batch), flags: EPH });
}

/**
 * Read the text in a report's screenshots and, if it matches a known fix, send the player that fix privately. Runs in the
 * background after the confirmation reply, never throws, and never posts the screenshot text anywhere public.
 */
async function scanScreenshots(i, { reportId, text, kind }) {
  try {
    const found = await readScreenshots(reportId);
    if (!found) return;
    const list = articles.list(i.guildId, { enabledOnly: true });
    const both = `${text}\n${found.slice(0, 800)}`;
    const matches = suggest(both, list, 3, kind, kbBoosts(i.guildId), await semanticScores(both, list));
    if (!matches.length) return;
    for (const m of matches) bumpStat(i, m.id, 'shown');
    await i.followUp({
      content: `🔎 **I read the text in your screenshot** and found ${matches.length === 1 ? 'a known fix' : 'some known fixes'} that may help while the developers look at your report:`,
      embeds: matches.map((m) => new EmbedBuilder().setColor(0xfee75c).setTitle(`💡 ${trunc(m.title, 250)}`).setDescription(trunc(m.fix, 4000)).setFooter({ text: `Source: ${m.source}` })),
      flags: EPH,
    });
  } catch (e) { console.error('Reading the screenshot failed:', e.message); }
}

/** Start reading screenshots right after this interaction's confirmation reply has been sent (not before: Discord needs that first). */
function scanAfterReply(i, info) {
  const send = i.editReply.bind(i);
  i.editReply = async (...args) => {
    i.editReply = send;
    const out = await send(...args);
    scanScreenshots(i, info);
    return out;
  };
}

/** Links + uploaded files from a submitted report form. */
function readEvidence(i) {
  let files = [];
  try {
    files = [...(i.fields.getUploadedFiles('files')?.values() ?? [])]
      .map((f) => ({ name: f.name, url: f.url, size: f.size, contentType: f.contentType ?? '' }));
  } catch { /* no upload field / nothing uploaded */ }
  return { links: extractLinks(i.fields.getTextInputValue('links')), files };
}

const noteModal = (issue) => new ModalBuilder().setCustomId(`note:${issue.id}`).setTitle(`Developer note · #${issue.id}`).addComponents(
  input('text', 'Note shown on the issue (empty clears it)', { style: TextInputStyle.Paragraph, max: 900, value: issue.dev_note }));

const fixedModal = (issue) => new ModalBuilder().setCustomId(`fixed:${issue.id}`).setTitle(`Mark fixed · #${issue.id}`).addComponents(
  input('version', 'Fixed in version (optional)', { max: 40, placeholder: 'e.g. 0.13.15', value: issue.fixed_version }),
  input('text', 'Note for players (optional)', { style: TextInputStyle.Paragraph, max: 900, value: issue.dev_note }));

const issueOption = (it) => ({
  label: trunc(`#${it.id} ${it.title}`, 100),
  description: trunc(`${it.likely ? '⭐ Likely duplicate · ' : ''}${(PRIORITIES[it.priority] ?? PRIORITIES.normal).label} · ${STATUSES[it.status]?.label ?? it.status} · ${it.category} · ${it.reporters ?? '?'} players`, 100),
  emoji: STATUSES[it.status]?.emoji,
  value: String(it.id),
});

const OPEN = 'open'; // status filter value: everything that is not closed yet (the default)
const CLOSED = new Set(['fixed', 'wont_fix', 'cannot_reproduce']);
const BROWSE_PAGE = 25; // a select menu holds at most 25 options

/** Known issues: status / category / owner filters + issue picker, 25 per page. f = {s, c, o, p} (s/c/o: NONE or a value; p: page, from 0). */
function browsePayload(i, f) {
  const owner = f.o === 'me' ? i.user.id : f.o === 'unassigned' ? 'none' : undefined;
  const list = issues.list(i.guildId, { status: f.s === NONE || f.s === OPEN ? undefined : f.s, category: f.c === NONE ? undefined : f.c, owner })
    .filter((it) => f.s !== OPEN || !CLOSED.has(it.status));
  const pages = Math.max(1, Math.ceil(list.length / BROWSE_PAGE));
  const page = Math.min(Math.max(0, f.p ?? 0), pages - 1);
  const shown = list.slice(page * BROWSE_PAGE, (page + 1) * BROWSE_PAGE);
  const menu = (id, placeholder, allLabel, current, opts, first = []) => new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder)
    .addOptions([...first, { label: allLabel, value: NONE }, ...opts].map((o) => ({ ...o, default: o.value === current })));
  const components = [
    row(menu(`bfs:${f.c}|${f.o}`, 'Show: status', 'Any status', f.s,
      Object.entries(STATUSES).map(([value, s]) => ({ label: s.label, emoji: s.emoji, value })), [{ label: 'Open issues', value: OPEN, emoji: '📂' }])),
    row(menu(`bfc:${f.s}|${f.o}`, 'Show: category', 'Any category', f.c,
      [...Object.keys(CATEGORIES), 'Other'].map((c) => ({ label: c, value: c })))),
    row(menu(`bfo:${f.s}|${f.c}`, "Show: who's on it", 'Anyone', f.o,
      [{ label: 'Nobody yet', value: 'unassigned', emoji: '🙈' }, ...(isDev(i) ? [{ label: 'Assigned to me', value: 'me', emoji: '🙌' }] : [])])), // only developers take issues
  ];
  if (shown.length) {
    components.push(row(new StringSelectMenuBuilder().setCustomId('bfv').setPlaceholder('Pick an issue to open…').addOptions(shown.map(issueOption))));
  }
  if (pages > 1) {
    const go = (p) => `bfp:${f.s}|${f.c}|${f.o}|${p}`;
    components.push(row(
      btn(go(page - 1), 'Previous', '⬅️').setDisabled(page === 0),
      btn('bfn', `Page ${page + 1} of ${pages}`, '📄').setDisabled(true),
      btn(go(page + 1), 'Next', '➡️').setDisabled(page >= pages - 1),
    ));
  }
  const what = f.s === OPEN ? 'open issue' : 'issue';
  const content = list.length
    ? `**${list.length}** ${what}${list.length === 1 ? '' : 's'} found – the most important and most-reported are first${pages > 1 ? ` (showing ${page * BROWSE_PAGE + 1}–${page * BROWSE_PAGE + shown.length})` : ''}. Pick one to see the details.${f.s === OPEN ? ' Fixed and closed issues are hidden – change **Show: status** to see them.' : ''}`
    : 'No issues match those filters. Try choosing "Any" in one of the menus.';
  return { content, embeds: [], components };
}

function settingsPayload(guildId) {
  const c = cfgOf(guildId);
  const pick = (id, placeholder, opts, current) => row(new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder)
    .addOptions(opts.map(([label, value, description]) => ({ label, value: String(value), description, default: Math.abs(Number(value) - current) < 0.001 }))));
  const chanMenu = (id, placeholder, current) => {
    const m = new ChannelSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder).setChannelTypes(ChannelType.GuildText);
    if (current) m.setDefaultChannels(current);
    return row(m);
  };
  return {
    content: [
      '**⚙️ Settings** – pick a value from any menu below; it saves straight away.',
      `• Grouping: reports are grouped when they're at least **${Math.round(c.threshold * 100)}% alike**`,
      `• Quiet issues: flagged after **${c.stale_days} days** without activity`,
      `• Pause between a player's reports: **${c.cooldown_sec ? `${c.cooldown_sec} seconds` : 'none'}**`,
      `• Who can send reports: ${reporterRole(guildId) ? `<@&${reporterRole(guildId)}>` : '_everyone_'} _(change with \`/setup\`)_ · developers can change an issue's status`,
      `• Who can edit knowledge articles: developers${articleRole(guildId) ? ` and <@&${articleRole(guildId)}>` : ''} _(editor role: \`/setup article_role:\`)_`,
      `• Closed issues are ${c.retention_days ? `deleted after **${c.retention_days} days** without activity` : '**kept** until deleted by hand'} _(change with \`/setup retention_days:\`)_`,
      `• Developer hub (live board, alerts, weekly digest, private threads with players – keep it developers-only): ${c.dev_channel_id ? `<#${c.dev_channel_id}>` : '_not set_'} · fixed-issue announcements go to: ${c.changelog_channel_id ? `<#${c.changelog_channel_id}>` : '_not set_'}`,
    ].join('\n'),
    embeds: [],
    components: [
      pick('set_thr', 'How alike must reports be to group together?', [['Strict – fewer groups', 0.35, 'Keeps more reports as separate issues'], ['Balanced', 0.25, 'Recommended'], ['Loose – more groups', 0.18, 'Groups similar reports more eagerly']], c.threshold),
      pick('set_stale', 'Flag issues that go quiet after…', [['3 days', 3], ['7 days', 7], ['14 days', 14], ['30 days', 30]], c.stale_days),
      pick('set_cd', 'Pause between one player\'s reports', [['No pause', 0], ['30 seconds', 30], ['1 minute', 60], ['5 minutes', 300]], c.cooldown_sec),
      chanMenu('set_devch', 'Developer hub: live board, alerts, digest, private threads (developers only)', c.dev_channel_id),
      chanMenu('set_logch', 'Where should "fixed" announcements go? (public)', c.changelog_channel_id),
    ],
  };
}

// ---------- duplicates review ----------

const skipped = new Map(); // userId -> Set of "a-b" skipped this session
function dupSummary(it, tag) {
  const stats = reports.stats(it.id);
  const latest = reports.forIssue(it.id)[0];
  return new EmbedBuilder().setColor(STATUSES[it.status]?.color ?? 0x95a5a6)
    .setTitle(trunc(`${tag} · #${it.id} ${it.title}`, 256))
    .setDescription(trunc(`${it.category} · ${STATUSES[it.status]?.label} · ${stats.users} player${stats.users === 1 ? '' : 's'}${latest ? `\n> ${trunc(latest.text.replace(/\s+/g, ' '), 300)}` : ''}`, 4000));
}
function dupPayload(i) {
  const sk = skipped.get(i.user.id) ?? new Set();
  const pairs = duplicatePairs(i.guildId).filter((p) => !sk.has(`${p.a}-${p.b}`));
  if (!pairs.length) return { content: '🎉 Nothing left to review – no issues look like duplicates right now.', embeds: [], components: [row(btn('dev:menu', 'Developer menu', '⬅️'))] };
  const p = pairs[0];
  return {
    content: `**Are these two the same problem?** (${pairs.length} pair${pairs.length === 1 ? '' : 's'} to review · these look about ${Math.round(p.score * 100)}% alike)\n**Merge** combines them, **Keep separate** remembers they're different, **Skip** decides later.`,
    embeds: [dupSummary(issues.get(p.a), 'A'), dupSummary(issues.get(p.b), 'B')],
    components: [row(
      btn(`dupm:${p.a}:${p.b}`, 'Merge', '🔀', ButtonStyle.Success),
      btn(`dupk:${p.a}:${p.b}`, 'Keep separate', '↔️'),
      btn(`dups:${p.a}:${p.b}`, 'Skip', '⏭️'),
      btn('dev:menu', 'Developer menu', '⬅️'),
    )],
  };
}

// ---------- actions ----------

async function doMerge(i, from, into) {
  await retireMessage(client, from, into.id);
  const moved = mergeIssues(from.id, into.id);
  await syncMessage(client, issues.get(into.id), trackerChannel(i));
  await tellMerged(issues.get(into.id), moved);
  await threadSay(client, into, `🔀 Issue #${from.id} (“${trunc(from.title, 80)}”) was merged into this one.`);
}

/** The DM people get when an issue they reported or follow changes – says what the status means for them. */
const STATUS_DM = {
  in_progress: (t) => `🛠️ The developers have started working on **${t}**.`,
  fixed: (t) => `✅ Good news – **${t}** is now fixed!`,
  cannot_reproduce: (t) => `❓ The developers couldn't make **${t}** happen on their side. More details can help: open **My issues** on the panel, then choose **Edit report** or **Add evidence**.`,
  wont_fix: (t) => `🚫 The developers have decided not to fix **${t}**.`,
};

/** People whose report was merged into an issue that already has an answer (fixed, being fixed, can't reproduce, won't fix) are told that answer straight away. */
async function tellMerged(into, userIds) {
  if (!STATUS_DM[into.status] || !userIds.length) return;
  const update = into.status === 'fixed' && into.fixed_version ? `\nUpdate to version \`${into.fixed_version}\` (or newer) to get the fix.` : '';
  const devNote = into.dev_note ? `\n> ${into.dev_note}` : '';
  await notifyReporters(client, into, `🔀 Your report was merged into #${into.id}, which is already known.\n${STATUS_DM[into.status](`#${into.id} – ${trunc(into.title, 120)}`)}${update}${devNote}\n_You can turn these messages off under **My issues**._`, userIds).catch(() => {});
}

async function applyStatus(i, issue, status,{ version, note } = {}) {
  const old = issue.status;
  issues.setStatus(issue.id, status, i.user.id, version);
  if (note !== undefined) issues.setNote(issue.id, note || null, i.user.id); // an empty box clears the note
  const fresh = issues.get(issue.id);
  await syncMessage(client, fresh, trackerChannel(i));
  if (status !== old) {
    const s = STATUSES[status];
    const ver = status === 'fixed' && fresh.fixed_version ? ` (fixed in \`${fresh.fixed_version}\`)` : '';
    events.add(issue.id, 'status', i.user.id, `${STATUSES[old]?.label} → ${s.label}${ver}`);
    await threadSay(client, fresh, `${s.emoji} <@${i.user.id}> set the status to **${s.label}**${ver}.`);
    await talkSay(client, fresh, `${s.emoji} Status is now **${s.label}**${ver}.`);
    if (STATUS_DM[status]) {
      const update = status === 'fixed' && fresh.fixed_version ? `\nUpdate to version \`${fresh.fixed_version}\` (or newer) to get the fix.` : '';
      const devNote = fresh.dev_note ? `\n> ${fresh.dev_note}` : '';
      notifyReporters(client, fresh, `${STATUS_DM[status](`#${fresh.id} – ${trunc(fresh.title, 120)}`)}${update}${devNote}\n_You can turn these messages off under **My issues**._`).catch(() => {});
    }
    if (status === 'fixed') {
      await postChangelog(client, fresh, cfgOf(i.guildId).changelog_channel_id);
      await proposeArticle(fresh, i.user.id);
    }
    refreshPanel(i.guildId);
  }
  return fresh;
}

/**
 * After a report is filed: the knowledge article a developer linked to its issue, plus the closest fuzzy matches of what
 * the player wrote, as embeds to show right under the confirmation. Returns [] when nothing fits.
 */
async function articleHints(i, issue, text, kind) {
  const pool = articles.list(i.guildId, { enabledOnly: true }).filter((a) => !a.draft);
  const found = [];
  const linked = pool.find((a) => a.id === issue.article_id);
  if (linked) found.push({ id: `a:${linked.id}`, title: linked.title, fix: linked.link ? `${linked.body}

🔗 ${linked.link}` : linked.body, source: 'Linked to this issue by the developers' });
  for (const m of suggest(text, pool, 3, kind, kbBoosts(i.guildId), await semanticScores(text, pool))) if (m.custom && !found.some((f) => f.id === m.id)) found.push(m);
  const top = found.slice(0, 2);
  for (const m of top) bumpStat(i, m.id, 'shown');
  return top.map((m) => new EmbedBuilder().setColor(0xfee75c).setTitle(`📚 Might help while you wait: ${trunc(m.title, 200)}`).setDescription(trunc(m.fix, 4000)).setFooter({ text: `Source: ${m.source}` }));
}

async function submitReport(i, { text, platform, version, evidence, kind = 'bug' }) {
  rememberName(i);
  const cfg = cfgOf(i.guildId);
  const res = fileReport({ guildId: i.guildId, userId: i.user.id, text, platform, version, kind, threshold: cfg.threshold });
  await syncMessage(client, res.issue, cfg.channel_id);
  const ev = await attachEvidence(client, res.issue, i.user.id, res.reportId, evidence);
  const saved = ev.saved;
  if (saved) scanAfterReply(i, { reportId: res.reportId, text, kind });
  if (saved) await syncMessage(client, issues.get(res.issue.id), cfg.channel_id);
  if (res.reopened) {
    await threadSay(client, res.issue, `⚠️ Reopened by a new report${res.fixedVersion ? ` (it was fixed in \`${res.fixedVersion}\`${version ? `; reporter is on \`${version}\`` : ''})` : ''}.`);
  }
  const fresh = issues.get(res.issue.id);
  if (!res.created) joinTalkThread(client, fresh, i.user.id).catch(() => {});
  if (res.created) alertDevs(fresh, 'new'); else if (res.reopened) alertDevs(fresh, 'reopened');
  refreshPanel(i.guildId);
  const where = fresh.channel_id ? ` You can follow the discussion in <#${fresh.channel_id}>.` : '';
  const evidenceLine = (saved ? `\n📎 Saved ${countLine(saved)} with your report – only you and the developers can see them.` : '') + failNote(ev);
  const next = '\nYou\'ll get a message when its status changes. See everything under **My issues**.';
  const hints = await articleHints(i, fresh, text, kind);

  if (res.created) {
    return {
      content: `✅ **Thanks – your report has been sent!**\nIt's now ${fresh.kind === 'install' ? '🔧 install issue' : '🐞 issue'} **#${fresh.id}** (${fresh.category}).${where}${evidenceLine}${next}`,
      embeds: hints, components: [],
    };
  }

  // The report matched an issue that already exists: say so loudly, show what it matched, and offer to separate it.
  const sim = Math.round(res.score * 100);
  const stats = reports.stats(fresh.id);
  await threadSay(client, fresh, `➕ Another player's report was added to this issue (it looked about ${sim}% alike).`);
  const embed = new EmbedBuilder().setColor(0xf39c12).setTitle(trunc(`🔗 Similar issue found: #${fresh.id} · ${fresh.title}`, 256))
    .setDescription('Your report looked like this issue that someone already reported, so it was **added to it** instead of creating a duplicate.')
    .addFields(
      { name: 'How alike', value: `About **${sim}%**`, inline: true },
      { name: 'Status', value: `${STATUSES[fresh.status]?.emoji ?? ''} ${STATUSES[fresh.status]?.label ?? fresh.status}`, inline: true },
      { name: 'Players affected', value: String(stats.users), inline: true },
    );
  if (fresh.dev_note) embed.addFields({ name: 'Developer note', value: trunc(fresh.dev_note, 1000) });
  return {
    content: `🔗 **We found a similar issue, so your report was added to it.**\nIf that's not the same problem, press **Make it a separate issue**.${res.reopened ? '\n⚠️ That issue had been marked fixed, so it has been reopened for the developers to look at again.' : ''}${where}${evidenceLine}${next}`,
    embeds: [embed, ...hints],
    components: [row(
      btn(`keep:${res.reportId}`, 'Yes, same problem', '👍', ButtonStyle.Success),
      btn(`split:${res.reportId}`, 'Make it a separate issue', '↩️', ButtonStyle.Danger),
    )],
  };
}

// ---------- tracking: my reports, editing, timeline ----------

const EVENT_LABEL = {
  created: '🆕 Reported', status: '🔄 Status', priority: '⚑ Priority', owner: '🙌 Owner',
  merged: '🔀 Merged', article: '📚 Article', reopened: '⚠️ Reopened', rematched: '🔁 Report moved',
};
function timeline(issueId, showActors, limit = 8) {
  const evs = events.forIssue(issueId, limit);
  if (!evs.length) return '_No activity yet._';
  return trunc(evs.map((e) => `<t:${Math.floor(e.created_at / 1000)}:d> ${EVENT_LABEL[e.kind] ?? e.kind}${e.detail ? `: ${trunc(e.detail, 80)}` : ''}${showActors && e.actor_id ? ` — <@${e.actor_id}>` : ''}`).join('\n'), 1024);
}

/** Everything the user reported or follows, newest activity first. */
function minePayload(i) {
  const tags = new Map();
  for (const r of reports.byUser(i.guildId, i.user.id)) if (!tags.has(r.issue_id)) tags.set(r.issue_id, '📝 Your report');
  for (const id of watchers.forUser(i.guildId, i.user.id)) if (!tags.has(id)) tags.set(id, '🔔 Following');
  const list = [...tags].map(([id, tag]) => ({ it: issues.get(id), tag })).filter((x) => x.it)
    .map((x) => ({ ...x, unread: seen.unread(x.it, i.user.id) }))
    .sort((a, b) => (b.unread - a.unread) || (b.it.updated_at - a.it.updated_at)).slice(0, 25);
  const unread = list.filter((x) => x.unread).length;
  const dmOff = prefs.dmOff(i.user.id);
  const dmRow = row(btn('dm:toggle', dmOff ? 'Turn update messages on' : 'Turn update messages off', dmOff ? '🔔' : '🔕'), btn('legal:privacy', 'Data & privacy', '🔒'));
  if (!list.length) {
    return { content: "You haven't sent or followed any reports yet. Press **Report a problem** on the panel, or 🔔 **Follow** on any issue to get updates.", embeds: [], components: [dmRow] };
  }
  return {
    content: `**📌 My issues** (${list.length}) – pick one to see how it's going, add details or edit it.${unread ? `\n🔴 **${unread}** ${unread === 1 ? 'has' : 'have'} a new reply from the developers – marked below.` : ''}\nUpdate messages: **${dmOff ? 'off 🔕' : 'on 🔔'}** – use the button below to change this.`,
    embeds: [],
    components: [row(new StringSelectMenuBuilder().setCustomId('mine_view').setPlaceholder('Open one…').addOptions(list.map(({ it, tag, unread: isNew }) => ({
      label: trunc(`${isNew ? '🔴 ' : ''}#${it.id} ${it.title}`, 100),
      description: trunc(`${isNew ? 'New developer reply · ' : ''}${tag} · ${STATUSES[it.status]?.label} · ${(PRIORITIES[it.priority] ?? PRIORITIES.normal).label}`, 100),
      emoji: STATUSES[it.status]?.emoji,
      value: String(it.id),
    })))), dmRow],
  };
}

/** Personal progress card for one issue: status, your report, timeline, and the edit / re-check / withdraw buttons. */
function trackPayload(i, issue) {
  seen.mark(issue.id, i.user.id); // opening the card counts as reading the developers' latest reply
  const st = STATUSES[issue.status] ?? STATUSES.new;
  const pr = PRIORITIES[issue.priority] ?? PRIORITIES.normal;
  const mine = reports.latestByUser(issue.id, i.user.id);
  const stats = reports.stats(issue.id);
  const mineEv = mine ? evidence.forReport(mine.id).length : 0;
  const embed = new EmbedBuilder().setColor(st.color).setTitle(trunc(`${pr.emoji} #${issue.id} · ${issue.title}`, 256))
    .addFields(
      { name: 'Status', value: `${st.emoji} ${st.label}${issue.status === 'fixed' && issue.fixed_version ? ` in \`${issue.fixed_version}\`` : ''}`, inline: true },
      { name: 'Priority', value: `${pr.emoji} ${pr.label}`, inline: true },
      { name: "Who's on it", value: issue.owner_id ? person(issue.owner_id, issue.guild_id) : '_nobody yet_', inline: true },
      { name: 'Players affected', value: String(stats.users), inline: true },
    );
  if (mine) {
    const meta = [mine.platform, mine.version].filter(Boolean).join(' · ');
    embed.addFields({
      name: `Your report${mine.edited_at ? ' (edited)' : ''}${meta ? ` · ${meta}` : ''}${mineEv ? ` · 📎 ${mineEv}` : ''}`,
      value: trunc(mine.text, 1000),
    });
  }
  if (issue.dev_note) embed.addFields({ name: '💬 Developer note', value: trunc(issue.dev_note, 1024) });
  embed.addFields({ name: '📜 Timeline', value: timeline(issue.id, false) });

  const rows = [];
  if (mine) {
    rows.push(row(btn(`edit:${mine.id}`, 'Edit my report', '✏️'), btn(`addevr:${mine.id}`, 'Add screenshots / logs', '📎'),
      btn(`rematch:${mine.id}`, 'Recalculate match', '🔄'), btn(`wd:${mine.id}`, 'Withdraw', '🗑️'),
      ...(mineEv ? [btn(`evview:${mine.id}`, `My attachments (${mineEv})`, '🖼️')] : [])));
  }
  const nav = [btn('mine:back', 'Back', '⬅️')];
  // Joined an issue with other players? You can always take your report out into its own issue.
  if (mine && stats.total > 1) nav.push(btn(`split:${mine.id}`, 'Make it a separate issue', '↩️'));
  if (!mine) nav.push(btn(`follow:${issue.id}`, watchers.has(issue.id, i.user.id) ? 'Unfollow' : 'Follow', watchers.has(issue.id, i.user.id) ? '🔕' : '🔔'));
  rows.push(row(...nav));
  return { content: '', embeds: [embed], components: rows };
}

const editModal = (report) => new ModalBuilder().setCustomId(`edit:${report.id}`).setTitle(`Edit your report · #${report.issue_id}`).addLabelComponents(
  labelled('What went wrong?', lText('text', { style: TextInputStyle.Paragraph, max: 1000, required: true, min: 15, value: report.text })),
  labelled('Headset / platform (optional)', lText('platform', { max: 60, value: report.platform })),
  labelled('When did you last update / Version Number', lText('version', { max: 60, value: report.version }), 'Optional'),
  ...evidenceFields());

const addEvidenceModal = (report) => new ModalBuilder().setCustomId(`addevr:${report.id}`).setTitle('Add screenshots, logs or video')
  .addLabelComponents(...evidenceFields());

/** Delete a report (spam clean-up by a developer, or a user withdrawing their own). Removes the issue if it was the last report. */
async function dropReport(i, issue, report) {
  await purgeEvidence(client, report.id);
  reports.delete(report.id);
  if (reports.stats(issue.id).total === 0) {
    issues.delete(issue.id);
    await removeMessage(client, issue);
    return { issueDeleted: true };
  }
  await syncMessage(client, issues.get(issue.id), trackerChannel(i));
  return { issueDeleted: false };
}

// ---------- knowledge articles (developer-managed) ----------

const articleModal = (a, prefill = {}) => new ModalBuilder().setCustomId(`art:save:${a?.id ?? 'new'}`).setTitle(a ? 'Edit article' : 'New knowledge article').addComponents(
  input('title', 'Article title', { max: 100, required: true, value: a?.title ?? prefill.title }),
  input('symptoms', 'How players describe it (one per line)', { style: TextInputStyle.Paragraph, max: 1000, required: true, value: a?.symptoms ?? prefill.symptoms, placeholder: 'game crashes when I join\nblack screen after the logo' }),
  input('phrases', 'Exact error text (optional, one per line)', { style: TextInputStyle.Paragraph, max: 500, value: a?.phrases ?? prefill.phrases }),
  input('body', 'The answer / fix players should try', { style: TextInputStyle.Paragraph, max: 1500, required: true, value: a?.body ?? prefill.body }),
  input('link', 'Link for more info (optional)', { max: 200, value: a?.link ?? prefill.link }));

const canDeleteArticle = (i, a) => isDev(i) || (!!a.created_by && a.created_by === i.user.id); // editors may delete only articles they created
function articleView(a, canDelete = true) {
  const s = kbStats.get(a.guild_id, `a:${a.id}`);
  const embed = new EmbedBuilder().setColor(a.draft ? 0x3498db : a.enabled ? 0xfee75c : 0x95a5a6).setTitle(`📚 ${trunc(a.title, 240)}${a.draft ? ' (draft – players can\'t see it yet)' : a.enabled ? '' : ' (disabled)'}`)
    .addFields(
      { name: 'Matches players who write', value: trunc(a.symptoms, 1024) },
      ...(a.phrases ? [{ name: 'Always matches this exact text', value: trunc(a.phrases, 1024) }] : []),
      { name: 'Answer players see', value: trunc(a.link ? `${a.body}\n\n🔗 ${a.link}` : a.body, 1024) },
      { name: 'How it\'s doing', value: `Viewed ${s.shown}× · ✅ fixed it ${s.helped}× · 🙅 not their problem ${s.denied}× · 📝 sent a report anyway ${s.filed}×` },
    );
  if (a.draft) embed.setFooter({ text: `Proposed from the fix for issue #${a.source_issue_id}. Check the wording, then press Publish.` });
  return {
    content: '', embeds: [embed],
    components: [row(btn(`art:edit:${a.id}`, 'Edit', '✏️'),
      a.draft ? btn(`art:tog:${a.id}`, 'Publish', '✅', ButtonStyle.Success) : btn(`art:tog:${a.id}`, a.enabled ? 'Disable' : 'Enable', a.enabled ? '⏸️' : '▶️'),
      ...(canDelete ? [btn(`art:del:${a.id}`, 'Delete', '🗑️')] : []), btn('art:back', 'Back', '⬅️'))],
  };
}

const ART_PAGE = 25; // Discord allows 25 options in a dropdown, so longer lists are paged
function articlesPayload(guildId, page = 0) {
  const all = articles.list(guildId);
  const pages = Math.max(1, Math.ceil(all.length / ART_PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const list = all.slice(page * ART_PAGE, (page + 1) * ART_PAGE);
  const components = [];
  if (list.length) {
    components.push(row(new StringSelectMenuBuilder().setCustomId('art_pick').setPlaceholder(pages > 1 ? `Open an article… (${page * ART_PAGE + 1}–${page * ART_PAGE + list.length} of ${all.length})` : 'Open an article…').addOptions(list.map((a) => {
      const s = kbStats.get(guildId, `a:${a.id}`);
      return { label: trunc(a.title, 100), description: trunc(`${a.enabled ? 'on' : 'off'} · shown ${s.shown} · helped ${s.helped} · denied ${s.denied}`, 100), value: String(a.id) };
    }))));
  }
  components.push(row(btn('art:new', 'New article', '➕', ButtonStyle.Success), btn('art:all:0', 'View all knowledge', '📖'), btn('art:stats', 'Results', '📊'),
    btn('art:test', 'Test matching', '🧪'), btn('dev:menu', 'Developer menu', '⬅️')));
  const draftCount = articles.drafts(guildId).length;
  if (draftCount) components.push(row(btn('art:drafts', `Drafts to review (${draftCount})`, '📝', ButtonStyle.Primary)));
  if (pages > 1) {
    components.push(row(btn(`art:page:${page - 1}`, 'Previous', '◀️').setDisabled(page === 0), btn('art:noop', `Page ${page + 1} of ${pages}`, '📄').setDisabled(true),
      btn(`art:page:${page + 1}`, 'Next', '▶️').setDisabled(page >= pages - 1)));
  }
  return {
    content: `**📚 Knowledge articles** – ${all.length} of your own, plus ${KB.length} built-in answers.\nBefore anyone sends a report, they see a list of known problems (your articles first, and the closest matches to what they typed are moved to the top, even with typos). **Results** shows which answers actually help, and **Test matching** shows what a player would see for a sample sentence.`,
    embeds: [], components,
  };
}

const ALL_PAGE = 10;
/** Everything players can be shown: your own articles first (even disabled ones), then the built-in answers. */
const allKnowledge = (guildId) => [
  ...articles.list(guildId).map((a) => ({ value: String(a.id), title: a.title, own: true, off: !a.enabled, draft: !!a.draft })),
  ...KB.map((e) => ({ value: `kb:${e.id}`, title: e.title, own: false })),
];
/** Paged list of all knowledge with a dropdown to open any of them. */
function allKnowledgePayload(guildId, page = 0) {
  const all = allKnowledge(guildId);
  const ownCount = all.filter((e) => e.own).length;
  const pages = Math.max(1, Math.ceil(all.length / ALL_PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const list = all.slice(page * ALL_PAGE, (page + 1) * ALL_PAGE);
  const components = [];
  if (list.length) {
    components.push(row(new StringSelectMenuBuilder().setCustomId('art_pick').setPlaceholder(`Open an article… (${page * ALL_PAGE + 1}–${page * ALL_PAGE + list.length} of ${all.length})`)
      .addOptions(list.map((e) => ({ label: trunc(e.title, 100), value: e.value, emoji: e.own ? '📚' : '💡', description: e.own ? (e.draft ? 'your article · draft' : e.off ? 'your article · off' : 'your article') : 'built-in answer' })))));
  }
  if (pages > 1) {
    components.push(row(btn(`art:all:${page - 1}`, 'Previous', '◀️').setDisabled(page === 0), btn('art:noop', `Page ${page + 1} of ${pages}`, '📄').setDisabled(true),
      btn(`art:all:${page + 1}`, 'Next', '▶️').setDisabled(page >= pages - 1)));
  }
  components.push(row(btn('art:back', 'Back', '⬅️')));
  return {
    content: '', components,
    embeds: [new EmbedBuilder().setColor(0xfee75c).setTitle(`📖 All knowledge – ${ownCount} of your own, ${all.length - ownCount} built-in`)
      .setDescription(list.map((e) => `${e.own ? '📚' : '💡'} ${e.own ? `**${trunc(e.title, 90)}**` : trunc(e.title, 90)}${e.draft ? ' _(draft)_' : e.off ? ' _(disabled)_' : ''}`).join('\n') || '_Nothing yet._')
      .setFooter({ text: '📚 = your article (editable) · 💡 = built-in answer (read-only)' })],
  };
}

/** Read-only view of a built-in answer, with Back returning to the page of the full list it came from. */
function builtInView(guildId, entry) {
  const s = kbStats.get(guildId, `kb:${entry.id}`);
  const page = Math.floor(allKnowledge(guildId).findIndex((e) => e.value === `kb:${entry.id}`) / ALL_PAGE);
  return {
    content: '', components: [row(btn(`art:all:${page}`, 'Back', '⬅️'))],
    embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`💡 ${trunc(entry.title, 240)}`)
      .addFields({ name: 'Answer players see', value: trunc(entry.fix, 1024) },
        { name: 'How it\'s doing', value: `Viewed ${s.shown}× · ✅ fixed it ${s.helped}× · 🙅 not their problem ${s.denied}× · 📝 sent a report anyway ${s.filed}×` })
      .setFooter({ text: `Built-in answer – it can't be edited. Source: ${entry.source}` })],
  };
}

/** Drafts proposed from resolved issues, waiting for a person to publish them. */
function draftsPayload(guildId) {
  const list = articles.drafts(guildId).slice(0, 25);
  const components = [];
  if (list.length) {
    components.push(row(new StringSelectMenuBuilder().setCustomId('art_pick').setPlaceholder('Open a draft to review…')
      .addOptions(list.map((a) => ({ label: trunc(a.title, 100), description: trunc(`from the fix for issue #${a.source_issue_id}`, 100), value: String(a.id) })))));
  }
  components.push(row(btn('art:back', 'Back', '⬅️')));
  return {
    content: list.length
      ? "**📝 Drafts to review** – answers proposed from issues that were marked fixed. Players can't see them until you press **Publish**. Open one to edit the wording, publish it, or delete it."
      : '🎉 No drafts waiting – every proposed answer has been reviewed.',
    embeds: [], components,
  };
}

/**
 * When an issue is marked Fixed and the developer wrote a note, propose a knowledge article from it – saved as a draft that
 * players can't see, and announced to the developers (digest channel) for review. One draft per issue; never throws.
 */
async function proposeArticle(issue, byUserId) {
  try {
    if (!issue.dev_note?.trim() || articles.forIssue(issue.id)) return;
    const sample = reports.forIssue(issue.id).slice(0, 3).map((r) => trunc(r.text.replace(/\s+/g, ' '), 200));
    const seen = evidence.forIssue(issue.id).flatMap((e) => (e.ocr_text ?? '').split('\n')).filter((l) => /error|fail|exception|cannot|can't|unable|crash|denied|invalid/i.test(l)).slice(0, 3).map((l) => trunc(l, 150));
    const ver = issue.fixed_version ? `\n\n_Fixed in version ${issue.fixed_version} – update to it if you haven't._` : '';
    const id = articles.add({
      guild_id: issue.guild_id, title: trunc(issue.title, 100), symptoms: trunc([issue.title, ...sample, ...seen].join('\n'), 1000),
      body: trunc(`${issue.dev_note.trim()}${ver}`, 1500), created_by: byUserId, draft: true, source_issue_id: issue.id,
    });
    const chId = cfgOf(issue.guild_id).dev_channel_id;
    if (!chId) return; // no developer channel set: the draft still waits under Knowledge articles → Drafts to review
    const a = articles.get(id);
    await (await client.channels.fetch(chId)).send({
      content: `📝 **A knowledge article was proposed** from the fix for issue #${issue.id}. Players won't see it until it's published.`,
      embeds: [new EmbedBuilder().setColor(0x3498db).setTitle(`📚 ${trunc(a.title, 240)}`).addFields(
        { name: 'Matches players who write', value: trunc(a.symptoms, 1024) }, { name: 'Answer players would see', value: trunc(a.body, 1024) })],
      components: [row(btn(`art:dpub:${id}`, 'Publish', '✅', ButtonStyle.Success), btn(`art:drev:${id}`, 'Review / edit', '✏️'), btn(`art:ddis:${id}`, 'Discard', '🗑️'))],
      allowedMentions: { parse: [] },
    });
  } catch (e) { console.error('Could not propose an article for issue', issue.id, e.message); }
}

function articleStats(guildId) {
  const rows = kbStats.forGuild(guildId).filter((s) => s.shown > 0).slice(0, 15);
  const lines = rows.map((s) => {
    const flag = isWeak(s) ? ' ⚠️ not helping' : '';
    return `**${trunc(answerTitle(s.article_id), 60)}** — viewed ${s.shown}× · ✅ ${s.helped} · 🙅 ${s.denied} · 📝 ${s.filed}${flag}`;
  });
  const weak = weakAnswers(guildId);
  const advice = weak.length
    ? `⚠️ **${weak.length} answer${weak.length === 1 ? '' : 's'} may need a rewrite** – most people who see ${weak.length === 1 ? 'it' : 'them'} say it's not their problem or still send a report. Make the "how players describe it" text more specific, or switch ${weak.length === 1 ? 'it' : 'them'} off.\n\n`
    : '';
  return {
    content: '', components: [row(btn('art:back', 'Back', '⬅️'))],
    embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📊 How suggestions are doing')
      .setDescription(trunc(advice + (lines.join('\n') || '_No answers have been viewed yet._'), 4000))
      .setFooter({ text: '✅ = "That fixed it" · 🙅 = "That\'s not my problem" · 📝 = "Didn\'t help – send a report"' })],
  };
}

// ---------- interactions ----------

/**
 * A click, menu choice or form failed. Log it, tell the person WHY (when Discord still lets us answer) and carry on.
 * Never throws – a failure on one click must never be able to stop the bot.
 */
async function failInteraction(i, err) {
  const { reason } = explainError(err);
  console.error(`Interaction ${i?.customId ?? i?.commandName ?? '?'} failed because ${reason}:`, err?.code ?? '', err?.message ?? err);
  if (err?.code === 10062) return; // Discord has already forgotten this interaction (answered too late) – there is nothing left to reply to
  try {
    const reply = { content: errorMessage(err), flags: EPH }; // says WHY it failed and what to do, not just "something went wrong"
    if (i.replied || i.deferred) await i.followUp(reply); else await i.reply(reply);
  } catch { /* could not even tell them – already logged above */ }
}

const knownNames = new Map(); // "server:user" -> the name last saved, so the database is only written when a name changes
/** Remember the name this person uses in THIS server. Called only when they file a report or take an issue – not for people who just look around. */
function rememberName(i) {
  const name = (i.member?.displayName ?? i.user?.globalName ?? i.user?.username ?? '').toString().trim().slice(0, 40);
  const key = `${i.guildId}:${i.user?.id}`;
  if (!name || !i.guildId || !i.user?.id || knownNames.get(key) === name) return;
  knownNames.set(key, name);
  try { prefs.setName(i.user.id, i.guildId, name); } catch (e) { console.error(`Could not save a display name: ${e.message}`); }
}

async function handleInteraction(i) {
  try {
    if (!i.guildId) { // used in a private message: the bot only works inside a server
      if (i.isRepliable?.() ?? true) await i.reply({ content: 'This only works inside a server, not in private messages.', flags: EPH });
      return;
    }
    const id = i.customId ?? '';

    // /setup
    if (i.isChatInputCommand() && i.commandName === 'setup') {
      // Discord's default "admins only" for this command can be loosened in Server Settings → Integrations, so check here too.
      if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return i.reply({ content: '🔒 Only members with the **Manage Server** permission can run `/setup`.', flags: EPH });
      }
      const everyone = (r) => r && r.id === i.guildId;
      if (everyone(i.options.getRole('dev_role', true)) || everyone(i.options.getRole('article_role'))) {
        return i.reply({ content: "⚠️ `@everyone` can't be the developer or article-editor role – that would give every member those tools. Please pick a real role.", flags: EPH });
      }
      await i.deferReply({ flags: EPH }); // setup makes a backup and several Discord calls – answer Discord first
      const ch = i.options.getChannel('issues_channel', true);
      const role = i.options.getRole('dev_role', true);
      const prev = settings.get(i.guildId);
      try { backupNow(); } catch (e) { console.error('Backup before /setup failed:', e.message); } // a safety copy before anything changes
      settings.set(i.guildId, ch.id, role.id); // upsert: every other saved setting is kept
      const reporter = i.options.getRole('reporter_role');
      if (reporter) settings.update(i.guildId, { reporter_role_id: reporter.id });
      const articleR = i.options.getRole('article_role');
      if (articleR) settings.update(i.guildId, { article_role_id: articleR.id });
      const retention = i.options.getInteger('retention_days');
      if (retention !== null) settings.update(i.guildId, { retention_days: retention });
      const autoMerge = i.options.getBoolean('auto_merge');
      if (autoMerge !== null) settings.update(i.guildId, { auto_merge: autoMerge ? 1 : 0 });
      // Only ONE public message: post the new panel first (if that fails nothing is lost), then remove the previous one.
      const target = i.channel; // the panel goes where /setup is run (see README)
      const panelMsg = await target.send(panelPayload(i.guildId));
      if (prev?.panel_message_id && prev.panel_channel_id) {
        try { await (await (await client.channels.fetch(prev.panel_channel_id)).messages.fetch(prev.panel_message_id)).delete(); } catch { /* gone */ }
      }
      settings.update(i.guildId, { panel_channel_id: target.id, panel_message_id: panelMsg.id });
      const rr = reporterRole(i.guildId);
      // Check up front what the bot can't do in the issues channel and say why it matters, instead of failing later.
      let permissionWarning = '';
      try {
        const me = await i.guild.members.fetchMe();
        const missing = ch.permissionsFor(me)?.missing([
          PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory,
        ]) ?? [];
        if (missing.length) {
          permissionWarning = `\n⚠️ **The bot is missing permissions in <#${ch.id}>:** ${missing.map((m) => m.replace(/([a-z])([A-Z])/g, '$1 $2')).join(', ')}. Please grant them in the channel's permission settings.`;
        }
      } catch { /* couldn't check – not critical */ }
      const readded = restoreArticles(); // bring back any saved knowledge articles the database is missing
      seedArticles(i.guildId);
      const have = summary(i.guildId);
      const kept = have.issues || have.articles
        ? `\n♻️ Existing data found and kept: **${have.issues}** issue${have.issues === 1 ? '' : 's'}, **${have.reports}** report${have.reports === 1 ? '' : 's'}, **${have.articles}** knowledge article${have.articles === 1 ? '' : 's'}${restoredFrom ? ` (restored from backup \`${restoredFrom}\`)` : ''}${readded ? ` – **${readded}** re-added from the saved articles file` : ''}.`
        : '';
      return i.editReply({
        content: [
          `✅ **All set!** The control panel is posted in <#${target.id}>.`,
          `• Issues are not posted in <#${ch.id}> – everything is opened from **Known issues** on the control panel`,
          `• Developers: <@&${role.id}> (and anyone with Manage Server) – they can change an issue's status and use the Developer menu`,
          `• Who can send reports: ${rr ? `<@&${rr}>` : 'everyone'}`,
          `• Who can edit knowledge articles: developers${articleRole(i.guildId) ? ` and <@&${articleRole(i.guildId)}>` : ' (add a separate editor role with `/setup article_role:`)'}`,
          ...(kept ? [kept.trim()] : []),
          ...(permissionWarning ? [permissionWarning.trim()] : []),
          '',
          'Next: press **🛠️ Developer → ⚙️ Settings** to choose where the weekly digest and "fixed" announcements go.',
        ].join('\n'),
        allowedMentions: { parse: [] },
      });
    }

    // ----- reporting -----
    if (i.isButton() && id === 'report') {
      if (!settings.get(i.guildId)) return i.reply({ content: "This isn't ready yet – a server admin needs to run `/setup` first.", flags: EPH });
      if (!canReport(i)) return noReportAccess(i);
      const wait = cooldownLeft(i);
      return wait ? i.reply(waitMsg(wait)) : i.reply({ ...reportTypePayload(), flags: EPH });
    }
    // Step 2: show the known problems for this ticket type before any form opens.
    if (i.isButton() && (id === 'rtype:install' || id === 'rtype:bug')) {
      if (!canReport(i)) return noReportAccess(i);
      setDraft(i.user.id, ''); // a new report starts clean
      return i.showModal(quickModal(id.slice(6)));
    }
    // The one-line description: rank the known problems by it, then show the list.
    if (i.isModalSubmit() && (id === 'faqq:install' || id === 'faqq:bug')) {
      if (!canReport(i)) return noReportAccess(i);
      setDraft(i.user.id, i.fields.getTextInputValue('text').trim());
      return show(i, await faqFor(i, id.slice(5)));
    }
    if (i.isStringSelectMenu() && id.startsWith('faq:')) {
      const kind = id.slice(4);
      const entry = faqEntries(kind, articles.list(i.guildId, { enabledOnly: true })).find((e) => e.id === i.values[0]);
      if (!entry) return i.update(await faqFor(i, kind));
      bumpStat(i, entry.id, 'shown');
      return i.update(faqAnswerPayload(entry, kind));
    }
    if (i.isButton() && id.startsWith('faqp:')) {
      const [, kind, page] = id.split(':');
      return i.update(await faqFor(i, kind === 'install' ? 'install' : 'bug', Number(page) || 0));
    }
    if (i.isButton() && id.startsWith('faqok:')) {
      const [, , ...rest] = id.split(':');
      bumpStat(i, rest.join(':'), 'helped');
      return i.update({ content: 'Great, glad that helped! 🎉 No report was needed.', embeds: [], components: [] });
    }
    if (i.isButton() && id.startsWith('faqno:')) {
      const [, kind, ...rest] = id.split(':');
      bumpStat(i, rest.join(':'), 'denied');
      return i.update(await faqFor(i, kind));
    }
    // "None of these" / "Still happening": open the form.
    if (i.isButton() && id.startsWith('rform:')) {
      if (!canReport(i)) return noReportAccess(i);
      const [, kind, ...rest] = id.split(':');
      const wait = cooldownLeft(i);
      if (wait) return i.reply(waitMsg(wait));
      if (rest.length) bumpStat(i, rest.join(':'), 'filed');
      return i.showModal(reportModal(kind, getDraft(i.user.id))); // pre-filled with what they already wrote
    }
    if (i.isModalSubmit() && (id === 'report:install' || id === 'report:bug')) {
      if (!canReport(i)) return noReportAccess(i);
      const data = {
        kind: id.slice(7),
        text: i.fields.getTextInputValue('text').trim(),
        platform: i.fields.getTextInputValue('platform').trim(),
        version: i.fields.getTextInputValue('version').trim(),
        evidence: readEvidence(i),
      };
      const wait = cooldownLeft(i);
      if (wait) return i.reply(waitMsg(wait));
      // Does this look like a problem that has already been fixed? Say so first, and let them send the report anyway.
      const fixedMatch = findFixedMatch({ guildId: i.guildId, text: `${data.text} ${data.platform}`, kind: data.kind, threshold: cfgOf(i.guildId).threshold });
      if (fixedMatch) {
        pendingFixed.set(i.user.id, { data, exp: Date.now() + 30 * 60_000 });
        return show(i, alreadyFixedPayload(fixedMatch));
      }
      // The player already went through the known-problems list and chose to report: file it, no more searching.
      if (filing.has(i.user.id)) return i.reply(busyMsg);
      filing.add(i.user.id);
      try {
        setDraft(i.user.id, '');
        await deferHidden(i); // re-hosting files can take longer than Discord's 3s limit
        const payload = await submitReport(i, data); // (not inlined: submitReport may wrap i.editReply, so look it up afterwards)
        return await i.editReply(payload);
      } finally { filing.delete(i.user.id); }
    }
    if (i.isButton() && id.startsWith('fxok:')) {
      pendingFixed.delete(i.user.id); setDraft(i.user.id, '');
      return i.update({ content: 'Great, glad that is sorted! 🎉 No report was needed.', embeds: [], components: [] });
    }
    if (i.isButton() && id.startsWith('fxsend:')) {
      if (!canReport(i)) return noReportAccess(i);
      const p = pendingFixed.get(i.user.id);
      if (!p || p.exp < Date.now()) return i.update({ content: 'That took a while, so your report was not kept. Open **Report a problem** to start again.', embeds: [], components: [] });
      const wait = cooldownLeft(i);
      if (wait) return i.reply(waitMsg(wait));
      if (filing.has(i.user.id)) return i.reply(busyMsg);
      filing.add(i.user.id);
      try {
        pendingFixed.delete(i.user.id); setDraft(i.user.id, '');
        await deferHidden(i);
        const payload = await submitReport(i, p.data);
        return await i.editReply(payload);
      } finally { filing.delete(i.user.id); }
    }
    if (i.isButton() && id.startsWith('keep:')) {
      const report = reports.get(idOf(i));
      if (!report || report.user_id !== i.user.id) return i.reply({ content: 'You can only change your own reports.', flags: EPH });
      const issue = issues.get(report.issue_id);
      return i.update({
        content: `👍 Great – your report stays with **#${issue.id} – ${trunc(issue.title, 80)}**. You'll get a message when its status changes. (Changed your mind? Open **My issues** and choose **Make it a separate issue**.)`,
        embeds: [], components: [],
      });
    }
    if (i.isButton() && id.startsWith('split:')) {
      const report = reports.get(idOf(i));
      if (!report || report.user_id !== i.user.id) return i.reply({ content: 'You can only change your own reports.', flags: EPH });
      await i.deferUpdate(); // answer Discord straight away; the work below talks to Discord several times
      const before = issues.get(report.issue_id);
      const res = splitReport(report.id);
      if (!res || res.alone) {
        return i.editReply({ content: `ℹ️ Yours is the only report on **#${before.id}**, so it is already its own issue – nothing to separate.`, embeds: [], components: [row(btn(`trk:${before.id}`, 'See how it\'s going', '📌'))] });
      }
      if (res.old) await syncMessage(client, res.old, trackerChannel(i));
      else await removeMessage(client, res.emptiedIssue);
      await syncMessage(client, res.fresh, trackerChannel(i));
      await threadSay(client, res.fresh, `↩️ This report was separated from #${before.id} because it's a different problem.`);
      return i.editReply({
        content: `✅ **Done – your report is now its own issue, #${res.fresh.id}.** It was taken out of #${before.id}, so the two are no longer linked. You'll get updates for #${res.fresh.id}.`,
        embeds: [], components: [row(btn(`trk:${res.fresh.id}`, 'See how it\'s going', '📌'))],
      });
    }

    // ----- browsing -----
    if (i.isButton() && id === 'browse') return show(i, browsePayload(i, { s: OPEN, c: NONE, o: NONE, p: 0 }));
    if (i.isStringSelectMenu() && id.startsWith('bfs:')) {
      const [c, o] = id.slice(4).split('|');
      return i.update(browsePayload(i, { s: i.values[0], c, o, p: 0 }));
    }
    if (i.isStringSelectMenu() && id.startsWith('bfc:')) {
      const [s, o] = id.slice(4).split('|');
      return i.update(browsePayload(i, { s, c: i.values[0], o, p: 0 }));
    }
    if (i.isStringSelectMenu() && id.startsWith('bfo:')) {
      const [s, c] = id.slice(4).split('|');
      return i.update(browsePayload(i, { s, c, o: i.values[0], p: 0 }));
    }
    if (i.isButton() && id.startsWith('bfp:')) {
      const [s, c, o, p] = id.slice(4).split('|');
      return i.update(browsePayload(i, { s, c, o, p: Number(p) || 0 }));
    }
    if (i.isButton() && id === 'bfn') return i.deferUpdate(); // the page counter
    if (i.isStringSelectMenu() && id === 'bfv') {
      const issue = await loadIssue(i, Number(i.values[0]));
      return issue && i.update(renderIssue(issue, { back: 'browse', viewer: viewerOf(i) }));
    }
    if (i.isButton() && id.startsWith('alert:open:')) { // from the "new issue" alert in the developer channel
      if (!isDev(i)) return devOnly(i, 'open this issue');
      const issue = await loadIssue(i, Number(id.split(':')[2]));
      return issue && i.reply({ ...renderIssue(issue, { viewer: viewerOf(i) }), flags: EPH });
    }
    if (i.isStringSelectMenu() && id === 'bfb') { // a card picked on the developer board
      if (!isDev(i)) return devOnly(i, 'use the board');
      const issue = await loadIssue(i, Number(i.values[0]));
      return issue && show(i, renderIssue(issue, { back: 'dev:board', viewer: viewerOf(i) }));
    }

    if (i.isStringSelectMenu() && id === 'bfm') { // "Move a card": step 1, a card was picked
      if (!isDev(i)) return devOnly(i, 'move cards');
      const issue = await loadIssue(i, Number(i.values[0]));
      return issue && show(i, movePayload(issue));
    }
    if (i.isStringSelectMenu() && id.startsWith('bfd:')) { // step 2, a destination section was picked
      if (!isDev(i)) return devOnly(i, 'move cards');
      const issue = await loadIssue(i, idOf(i));
      if (!issue) return;
      const status = i.values[0];
      if (status === issue.status) return i.update(boardPayload(i.guildId));
      if (status === 'fixed') return i.showModal(fixedModal(issue)); // the form asks for the version, so it doubles as the confirmation
      return i.update(confirmMovePayload(issue, status, !!STATUS_DM[status]));
    }
    if (i.isButton() && id.startsWith('bmv:')) { // step 3, confirmed
      if (!isDev(i)) return devOnly(i, 'move cards');
      const [, issueId, status] = id.split(':');
      const issue = await loadIssue(i, Number(issueId));
      if (!issue) return;
      if (!STATUSES[status] || status === 'fixed' || status === issue.status) return i.update(boardPayload(i.guildId));
      await i.deferUpdate(); // moving a card edits its message and sends DMs
      await applyStatus(i, issue, status);
      return i.editReply(boardPayload(i.guildId));
    }
    if (i.isButton() && id.startsWith('bmvback:')) {
      if (!isDev(i)) return devOnly(i, 'move cards');
      const issue = await loadIssue(i, idOf(i));
      return issue && i.update(movePayload(issue));
    }
    if (i.isStringSelectMenu() && id === 'bsec') { // "See everything in a section"
      if (!isDev(i)) return devOnly(i, 'use the board');
      return show(i, sectionPayload(i.guildId, STATUSES[i.values[0]] ? i.values[0] : 'new'));
    }
    if (i.isButton() && id.startsWith('bsp:')) {
      if (!isDev(i)) return devOnly(i, 'use the board');
      const [, status, page] = id.split(':');
      return i.update(sectionPayload(i.guildId, STATUSES[status] ? status : 'new', Number(page) || 0));
    }

    // ----- issue message: status / priority / owner -----
    if (i.isStringSelectMenu() && id.startsWith('status:')) {
      if (!isDev(i)) return devOnly(i, "change an issue's status");
      const issue = await loadIssue(i, idOf(i));
      if (!issue) return;
      const status = i.values[0];
      if (status === 'fixed' && issue.status !== 'fixed') return i.showModal(fixedModal(issue));
      await i.deferUpdate(); // acknowledge first: changing a status edits the card and sends DMs
      return i.editReply(card(i, await applyStatus(i, issue, status)));
    }
    if (i.isModalSubmit() && id.startsWith('fixed:')) {
      if (!isDev(i)) return devOnly(i, "change an issue's status");
      const issue = await loadIssue(i, idOf(i));
      if (!issue) return;
      const fromCard = i.isFromMessage();
      if (fromCard) await i.deferUpdate(); else await i.deferReply({ flags: EPH });
      const fresh = await applyStatus(i, issue, 'fixed', {
        version: i.fields.getTextInputValue('version').trim(),
        note: i.fields.getTextInputValue('text').trim(),
      });
      const fromMove = fromCard && i.message?.components?.some((r) => r.components?.some((c) => c.customId?.startsWith('bfd:')));
      return i.editReply(fromMove ? boardPayload(i.guildId) : fromCard ? card(i, fresh) : { content: `Marked #${issue.id} fixed.` });
    }
    if (i.isStringSelectMenu() && id.startsWith('prio:')) {
      if (!isDev(i)) return devOnly(i, 'change priority');
      const issue = await loadIssue(i, idOf(i));
      if (!issue) return;
      await i.deferUpdate();
      issues.setPriority(issue.id, i.values[0], i.user.id);
      events.add(issue.id, 'priority', i.user.id, `${PRIORITIES[issue.priority]?.label} → ${PRIORITIES[i.values[0]]?.label}`);
      await syncMessage(client, issues.get(issue.id), trackerChannel(i));
      return i.editReply(card(i, issues.get(issue.id)));
    }
    if (i.isButton() && id.startsWith('assign:')) {
      if (!isDev(i)) return devOnly(i, 'take issues');
      const issue = await loadIssue(i, idOf(i));
      if (!issue) return;
      await i.deferUpdate();
      rememberName(i);
      const mine = issue.owner_id === i.user.id;
      issues.setOwner(issue.id, mine ? null : i.user.id);
      events.add(issue.id, 'owner', i.user.id, mine ? 'unassigned' : 'took the issue');
      await syncMessage(client, issues.get(issue.id), trackerChannel(i));
      if (!mine) await threadSay(client, issue, `🙌 <@${i.user.id}> took this issue${issue.owner_id ? ` (from <@${issue.owner_id}>)` : ''}.`);
      return i.editReply(card(i, issues.get(issue.id)));
    }

    // ----- private thread with the players of an issue (developer hub) -----
    if (i.isButton() && (id.startsWith('talk:') || id.startsWith('talkok:'))) {
      if (!isDev(i)) return devOnly(i, 'start a private thread');
      const issue = await loadIssue(i, idOf(i));
      if (!issue) return;
      const hubId = cfgOf(i.guildId).board_channel_id;
      if (!hubId) return i.reply({ content: 'Pick a **Developer hub** channel first: Developer → ⚙️ Settings.', flags: EPH });
      const people = new Set(reports.forIssue(issue.id).map((r) => r.user_id).filter((u) => u && u !== '0'));
      if (id.startsWith('talk:') && !issue.talk_thread_id) {
        return i.reply({
          content: `🧵 **Talk to the players of #${issue.id}?**
This creates a private thread in <#${hubId}> and **adds ${people.size} player${people.size === 1 ? '' : 's'}** who reported it (they get a notification). Everyone in the thread sees each other's names and messages. Players who report it later are added automatically.`,
          components: [row(btn(`talkok:${issue.id}`, 'Yes, create the thread', '🧵', ButtonStyle.Success))], flags: EPH,
        });
      }
      await i.deferReply({ flags: EPH });
      try {
        const r = await openTalkThread(client, issue, i.user.id);
        events.add(issue.id, 'thread', i.user.id, r.existing ? 'opened the private thread' : `started a private thread with ${r.invited} player${r.invited === 1 ? '' : 's'}`);
        await syncMessage(client, issues.get(issue.id), trackerChannel(i));
        return i.editReply({ content: `🧵 ${r.existing ? 'Here is the thread' : `Created the thread with **${r.invited}** player${r.invited === 1 ? '' : 's'}`}: <#${r.thread.id}>${r.failed.length ? `
⚠️ Couldn't add ${r.failed.length} (they may have left the server or can't see the channel).` : ''}` });
      } catch (e) {
        return i.editReply({ content: `⚠️ I couldn't create the thread: ${e.message === 'no-hub' ? 'no Developer hub channel is set' : errorMessage(e)}. The bot needs Create Private Threads, Send Messages in Threads and Manage Threads in <#${hubId}>.` });
      }
    }

    // ----- issue message: I have this too -----
    if (i.isButton() && id.startsWith('plus:')) {
      const issue = await loadIssue(i, idOf(i));
      if (!issue) return;
      if (!canReport(i)) return noReportAccess(i);
      if (reports.hasUser(issue.id, i.user.id)) return i.reply({ content: 'You\'ve already added your report to this issue. 👍 To add more, use **My issues** → **Edit my report** or **Add screenshots / logs**.', flags: EPH });
      const wait = cooldownLeft(i);
      return wait ? i.reply(waitMsg(wait)) : i.showModal(meTooModal(issue));
    }
    if (i.isModalSubmit() && id.startsWith('plus:')) {
      if (!canReport(i)) return noReportAccess(i);
      const issue = await loadIssue(i, idOf(i));
      if (!issue) return;
      if (reports.hasUser(issue.id, i.user.id)) return i.reply({ content: 'You\'ve already added your report to this issue. 👍', flags: EPH });
      const wait = cooldownLeft(i);
      if (wait) return i.reply(waitMsg(wait));
      if (filing.has(i.user.id)) return i.reply(busyMsg);
      filing.add(i.user.id);
      try {
      await i.deferReply({ flags: EPH });
      rememberName(i);
      const version = i.fields.getTextInputValue('version').trim();
      const reportId = reports.add(issue.id, i.user.id, i.fields.getTextInputValue('text').trim() || '(me too)', i.fields.getTextInputValue('platform').trim(), version);
      const ev = await attachEvidence(client, issue, i.user.id, reportId, readEvidence(i));
      const saved = ev.saved;
      if (saved) scanAfterReply(i, { reportId, text: i.fields.getTextInputValue('text').trim(), kind: issue.kind });
      const reopened = issue.status === 'fixed';
      if (reopened) {
        issues.setStatus(issue.id, 'new', null);
        events.add(issue.id, 'reopened', i.user.id, issue.fixed_version ? `was fixed in ${issue.fixed_version}` : null);
        await threadSay(client, issue, `⚠️ Reopened by another report${issue.fixed_version ? ` (it was fixed in \`${issue.fixed_version}\`${version ? `; reporter is on \`${version}\`` : ''})` : ''}.`);
      } else issues.touch(issue.id);
      await syncMessage(client, issues.get(issue.id), trackerChannel(i));
      if (reopened) { alertDevs(issues.get(issue.id), 'reopened'); refreshPanel(i.guildId); }
      return i.editReply({ content: `✅ **Thanks – your report was added to #${issue.id}.**${saved ? `\n📎 Saved ${countLine(saved)} with it – only you and the developers can see them.` : ''}${failNote(ev)}\nYou'll get a message when its status changes. See everything under **My issues**.` });
      } finally { filing.delete(i.user.id); }
    }

    // ----- issue message: dev note -----
    if (i.isButton() && id.startsWith('note:')) {
      if (!isDev(i)) return devOnly(i, 'add notes');
      const issue = await loadIssue(i, idOf(i));
      return issue && i.showModal(noteModal(issue));
    }
    if (i.isModalSubmit() && id.startsWith('note:')) {
      if (!isDev(i)) return devOnly(i, 'add notes');
      const issue = await loadIssue(i, idOf(i));
      if (!issue) return;
      await i.deferReply({ flags: EPH });
      const noteText = i.fields.getTextInputValue('text').trim() || null;
      const noteChanged = noteText && noteText !== issue.dev_note;
      issues.setNote(issue.id, noteText, i.user.id);
      await syncMessage(client, issues.get(issue.id), trackerChannel(i));
      if (noteChanged) { // a note is a reply too: tell the players, not only when the status moves
        notifyReporters(client, issues.get(issue.id), `💬 The developers left a note on **#${issue.id} – ${trunc(issue.title, 120)}**:
> ${trunc(noteText, 900)}
_You can turn these messages off under **My issues**._`).catch(() => {});
        refreshPanel(i.guildId);
      }
      return i.editReply({ content: `Note saved on #${issue.id}.` });
    }

    // ----- issue message: merge into… -----
    if (i.isButton() && id.startsWith('merge:')) {
      if (!isDev(i)) return devOnly(i, 'merge issues');
      const issue = await loadIssue(i, idOf(i));
      if (!issue) return;
      const scores = new Map(relatedIssues(issue, { limit: 100, min: 0 }).map((r) => [r.id, r.score]));
      const others = issues.list(i.guildId).filter((x) => x.id !== issue.id)
        .sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0)).slice(0, 25)
        .map((x) => ({ ...x, likely: (scores.get(x.id) ?? 0) >= 0.12 }));
      if (!others.length) return i.reply({ content: 'There are no other issues to merge this one into yet.', flags: EPH });
      return i.reply({
        content: `Merge **#${issue.id} – ${trunc(issue.title, 80)}** into which issue? Its reports move over and it is removed from the list. ⭐ marks issues that look alike.`,
        components: [row(new StringSelectMenuBuilder().setCustomId(`mergeto:${issue.id}`).setPlaceholder('Choose the issue to keep…').addOptions(others.map(issueOption)))],
        flags: EPH,
      });
    }
    if (i.isStringSelectMenu() && id.startsWith('mergeto:')) {
      if (!isDev(i)) return devOnly(i, 'merge issues');
      const from = issues.get(idOf(i));
      const into = issues.get(Number(i.values[0]));
      if (!from || !into || from.guild_id !== i.guildId || into.guild_id !== i.guildId) {
        return i.update({ content: 'One of those issues no longer exists.', components: [] });
      }
      await i.deferUpdate();
      await doMerge(i, from, into);
      return i.editReply({ content: `🔀 Merged #${from.id} into #${into.id}.`, components: [] });
    }

    // ----- issue message: remove a (spam) report -----
    if (i.isButton() && id.startsWith('rmrep:')) {
      if (!isDev(i)) return devOnly(i, 'remove reports');
      const issue = await loadIssue(i, idOf(i));
      if (!issue) return;
      await i.deferReply({ flags: EPH }); // looking up up to 25 usernames talks to Discord – acknowledge first
      const list = reports.forIssue(issue.id).slice(0, 25);
      const names = await Promise.all(list.map((r) => client.users.fetch(r.user_id).then((u) => u.username).catch(() => r.user_id)));
      return i.editReply({
        content: `Which report on **#${issue.id}** should be removed? (Newest first.)`,
        components: [row(new StringSelectMenuBuilder().setCustomId(`rmsel:${issue.id}`).setPlaceholder('Choose a report to remove…')
          .addOptions(list.map((r, n) => ({
            label: trunc(`${names[n]}: ${r.text.replace(/\s+/g, ' ')}`, 100),
            description: `Report #${r.id} · ${new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' ')}`,
            value: String(r.id),
          }))))],
      });
    }
    if (i.isStringSelectMenu() && id.startsWith('rmsel:')) {
      if (!isDev(i)) return devOnly(i, 'remove reports');
      const issue = issues.get(idOf(i));
      const report = reports.get(Number(i.values[0]));
      if (!issue || !report || report.issue_id !== issue.id || issue.guild_id !== i.guildId) {
        return i.update({ content: 'That report no longer exists.', components: [] });
      }
      await i.deferUpdate();
      const { issueDeleted } = await dropReport(i, issue, report);
      return i.editReply({
        content: issueDeleted ? `🗑️ Removed the report. #${issue.id} had no reports left, so the issue was deleted too.` : `🗑️ Removed report #${report.id} from #${issue.id}.`,
        components: [],
      });
    }

    // ----- data & privacy, terms, DM preference -----
    if (i.isButton() && (id === 'legal:privacy' || id === 'legal:terms')) {
      const payload = id === 'legal:privacy'
        ? privacyPayload(settings.get(i.guildId)?.dev_role_id, cfgOf(i.guildId).retention_days)
        : termsPayload(settings.get(i.guildId)?.dev_role_id);
      // From the panel (public message) open a private reply; from inside a private view, replace it.
      return i.message?.flags?.has(MessageFlags.Ephemeral)
        ? i.update({ ...payload, allowedMentions: { parse: [] } })
        : i.reply({ ...payload, allowedMentions: { parse: [] }, flags: EPH });
    }
    if (i.isButton() && id === 'legal:erase') return i.update(erasePayload());
    if (i.isButton() && id === 'legal:eraseok') {
      await i.deferUpdate();
      const { removed, anonymised } = await eraseUser(client, i.guildId, i.user.id);
      return i.editReply({
        content: `🗑️ Done. Removed ${removed} report${removed === 1 ? '' : 's'}${anonymised ? ` and removed your details from ${anonymised} issue${anonymised === 1 ? '' : 's'} developers had already worked on` : ''}, plus your follows and settings.\nMessages you wrote yourself in Discord channels are separate – ask a moderator to remove them.`,
        embeds: [], components: [],
      });
    }
    if (i.isButton() && id === 'dm:toggle') {
      prefs.setDmOff(i.user.id, !prefs.dmOff(i.user.id));
      return i.update(minePayload(i));
    }

    // ----- private attachments: only the person who sent them, and developers -----
    if (i.isButton() && id.startsWith('evview:')) {
      const report = reports.get(idOf(i));
      if (!report || (report.user_id !== i.user.id && !isDev(i))) {
        return i.reply({ content: 'You can only open the attachments of your own reports.', flags: EPH });
      }
      return sendEvidence(i, evidence.forReport(report.id), `📎 **Attachments on your report #${report.id}** – you're the requester, so only you and the developers can see these.`);
    }
    if (i.isButton() && id.startsWith('evall:')) {
      const issue = await loadIssue(i, idOf(i));
      if (!issue) return;
      const rows = evidence.forIssue(issue.id);
      if (isDev(i)) return sendEvidence(i, rows, `📎 **Attachments on #${issue.id}**`);
      const mine = rows.filter((r) => r.user_id === i.user.id);
      if (!mine.length) {
        return i.reply({
          content: rows.length
            ? 'Attachments are private: only the requester (the person who sent them) and the developers can open them. You can add your own with **Add screenshots / logs**.'
            : 'Nobody has attached anything to this issue yet.',
          flags: EPH,
        });
      }
      return sendEvidence(i, mine, `📎 **Your attachments on #${issue.id}**`);
    }

    // ----- my reports & tracking -----
    if (i.isButton() && id === 'mine') {
      return i.message?.flags?.has(MessageFlags.Ephemeral) ? i.update(minePayload(i)) : i.reply({ ...minePayload(i), flags: EPH });
    }
    if (i.isButton() && id === 'mine:back') return i.update(minePayload(i));
    if (i.isStringSelectMenu() && id === 'mine_view') {
      const issue = await loadIssue(i, Number(i.values[0]));
      return issue && i.update(trackPayload(i, issue));
    }
    if (i.isButton() && id.startsWith('trk:')) {
      const issue = await loadIssue(i, idOf(i));
      return issue && i.update(trackPayload(i, issue));
    }
    if (i.isButton() && id.startsWith('follow:')) {
      const issue = await loadIssue(i, idOf(i));
      if (!issue) return;
      if (reports.hasUser(issue.id, i.user.id)) return i.reply({ content: 'You sent a report for this issue, so you already get its updates. 🔔', flags: EPH });
      if (watchers.has(issue.id, i.user.id)) {
        watchers.remove(issue.id, i.user.id);
        return i.reply({ content: `🔕 You've stopped following **#${issue.id}**.`, flags: EPH });
      }
      watchers.add(issue.id, i.user.id);
      return i.reply({ content: `🔔 You're now following **#${issue.id}** – you'll get a message when its status changes. You can find everything you follow under **My issues**.`, flags: EPH });
    }
    if (i.isButton() && id.startsWith('history:')) {
      const issue = await loadIssue(i, idOf(i));
      if (!issue) return;
      return i.reply({
        embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(trunc(`📜 History · #${issue.id} ${issue.title}`, 250)).setDescription(timeline(issue.id, isDev(i), 15))],
        flags: EPH,
      });
    }

    // edit my report / add evidence – from the issue message (find my latest report) or from My issues (report id)
    if (i.isButton() && (id.startsWith('editmine:') || id.startsWith('addev:'))) {
      if (!canReport(i)) return noReportAccess(i);
      const issue = await loadIssue(i, idOf(i));
      if (!issue) return;
      const mine = reports.latestByUser(issue.id, i.user.id);
      // Following but never reported: the same form as "I have this too" – it adds their report and saves the files with it.
      if (!mine) {
        if (id.startsWith('editmine:')) return i.reply({ content: "You haven't added a report to this issue yet – press **I have this too** first.", flags: EPH });
        const wait = cooldownLeft(i);
        return wait ? i.reply(waitMsg(wait)) : i.showModal(meTooModal(issue));
      }
      return i.showModal(id.startsWith('editmine:') ? editModal(mine) : addEvidenceModal(mine));
    }
    if (i.isButton() && (id.startsWith('edit:') || id.startsWith('addevr:'))) {
      const report = reports.get(idOf(i));
      if (!report || report.user_id !== i.user.id) return i.reply({ content: 'You can only change your own reports.', flags: EPH });
      if (!canReport(i)) return noReportAccess(i);
      return i.showModal(id.startsWith('edit:') ? editModal(report) : addEvidenceModal(report));
    }
    if (i.isModalSubmit() && (id.startsWith('edit:') || id.startsWith('addevr:'))) {
      const report = reports.get(idOf(i));
      if (!report || report.user_id !== i.user.id) return i.reply({ content: 'You can only change your own reports.', flags: EPH });
      if (!canReport(i)) return noReportAccess(i);
      await deferHidden(i); // replaces the "My issues" card in place when opened from there
      const editing = id.startsWith('edit:');
      if (editing) {
        reports.update(report.id, {
          text: i.fields.getTextInputValue('text').trim(),
          platform: i.fields.getTextInputValue('platform').trim(),
          version: i.fields.getTextInputValue('version').trim(),
        });
      }
      const issue = issues.get(report.issue_id);
      const ev = await attachEvidence(client, issue, i.user.id, report.id, readEvidence(i));
      const saved = ev.saved;
      if (saved) scanAfterReply(i, { reportId: report.id, text: report.text, kind: issue.kind });
      issues.touch(issue.id);
      await syncMessage(client, issues.get(issue.id), trackerChannel(i));
      const added = saved ? ` and added ${saved} attachment${saved === 1 ? '' : 's'}/link${saved === 1 ? '' : 's'}` : '';
      await threadSay(client, issue, `✏️ A reporter ${editing ? 'edited their report' : 'added evidence'}${editing ? added : ''}.`);
      return i.editReply({
        content: `✅ ${editing ? `Your report was updated${added}.` : saved ? `Saved ${countLine(saved)} with your report – only you and the developers can see them.` : 'Nothing new was added.'}${failNote(ev)}\nIf your new details change what the problem is, press **Recalculate match** and I'll check whether your report belongs with a different issue.`,
        components: [row(btn(`rematch:${report.id}`, 'Recalculate match', '🔄', ButtonStyle.Primary), btn(`trk:${issue.id}`, 'See how it\'s going', '📌'))],
      });
    }
    if (i.isButton() && id.startsWith('rematch:')) {
      const report = reports.get(idOf(i));
      if (!report || report.user_id !== i.user.id) return i.reply({ content: 'You can only change your own reports.', flags: EPH });
      await i.deferUpdate();
      const res = rematchReport(report.id, i.user.id, cfgOf(i.guildId).threshold);
      if (res.action === 'same') {
        return i.editReply({
          content: `🔄 I checked again, and your report still fits best with **#${res.to.id} – ${trunc(res.to.title, 80)}**. Nothing needs to change.`,
          embeds: [], components: [row(btn(`trk:${res.to.id}`, 'See how it\'s going', '📌'))],
        });
      }
      if (res.fromDeleted) await retireMessage(client, res.from, res.to.id);
      else await syncMessage(client, issues.get(res.from.id), trackerChannel(i));
      await syncMessage(client, res.to, trackerChannel(i));
      await threadSay(client, res.to, res.action === 'moved'
        ? `🔁 A report was re-matched here from #${res.from.id} after its details changed.`
        : `✂️ A report was split out of #${res.from.id} after its details changed.`);
      return i.editReply({
        content: (res.action === 'moved'
          ? `🔁 With your new details, your report fits **#${res.to.id} – ${trunc(res.to.title, 80)}** better, so I moved it there.`
          : `✂️ Your new details no longer match **#${res.from.id}**, so your report is now its own issue, **#${res.to.id}**.`) +
          (res.reopened ? '\n⚠️ That issue had been marked fixed, so it was reopened for the developers.' : ''),
        embeds: [], components: [row(btn(`trk:${res.to.id}`, 'See how it\'s going', '📌'))],
      });
    }
    if (i.isButton() && id.startsWith('wd:')) {
      const report = reports.get(idOf(i));
      if (!report || report.user_id !== i.user.id) return i.reply({ content: 'You can only change your own reports.', flags: EPH });
      const issue = issues.get(report.issue_id);
      const last = reports.stats(issue.id).total === 1;
      if (last && (issue.status !== 'new' || issue.owner_id || issue.dev_note)) {
        return i.reply({ content: `The developers are already working on **#${issue.id}** and yours is the only report, so it can't be withdrawn. If it no longer applies, ask a developer to close it.`, flags: EPH });
      }
      return i.update({
        content: `Take back your report from **#${issue.id} – ${trunc(issue.title, 80)}**?${last ? ' Yours is the only report, so the issue will be removed.' : ' The issue stays open for the other players who reported it.'}`,
        embeds: [],
        components: [row(btn(`wdok:${report.id}`, 'Yes, withdraw it', '🗑️', ButtonStyle.Danger), btn(`trk:${issue.id}`, 'No, keep it', '↩️'))],
      });
    }
    if (i.isButton() && id.startsWith('wdok:')) {
      const report = reports.get(idOf(i));
      if (!report || report.user_id !== i.user.id) return i.reply({ content: 'You can only change your own reports.', flags: EPH });
      await i.deferUpdate();
      const { issueDeleted } = await dropReport(i, issues.get(report.issue_id), report);
      return i.editReply({ content: issueDeleted ? '🗑️ Your report was withdrawn. Because it was the only one, the issue was removed too.' : '🗑️ Your report was withdrawn.', embeds: [], components: [] });
    }

    // ----- issue message: link a knowledge article -----
    if (id.startsWith('lkart:') || id.startsWith('lkartto:')) { // link an existing knowledge article to this issue
      if (!canManageArticles(i)) return noArticleAccess(i);
      const issue = await loadIssue(i, idOf(i));
      if (!issue) return;
      if (i.isButton()) {
        const pool = articles.list(i.guildId, { enabledOnly: true }).filter((a) => !a.draft);
        if (!pool.length) return i.reply({ content: 'There are no published knowledge articles yet. Use **Make knowledge article** to write one.', flags: EPH });
        const text = [issue.title, ...reports.forIssue(issue.id).slice(0, 3).map((r) => r.text)].join('\n');
        const score = new Map(suggest(text, pool, 25, null, new Map(), await semanticScores(text, pool)).filter((s) => s.custom).map((s) => [s.id.replace('a:', ''), s.score]));
        const ranked = [...pool].sort((a, b) => (score.get(`${b.id}`) ?? 0) - (score.get(`${a.id}`) ?? 0)).slice(0, 24);
        const options = ranked.map((a) => ({ label: trunc(a.title, 100), description: trunc(`${score.has(`${a.id}`) ? '⭐ Looks related · ' : ''}${a.body.replace(/\s+/g, ' ')}`, 100), value: String(a.id), default: a.id === issue.article_id }));
        if (issue.article_id) options.push({ label: 'Remove the linked article', value: 'none', emoji: '🚫' });
        return i.reply({
          content: `Link which knowledge article to **#${issue.id} – ${trunc(issue.title, 80)}**? Players who reported it are sent the answer. ⭐ marks articles that look related.`,
          components: [row(new StringSelectMenuBuilder().setCustomId(`lkartto:${issue.id}`).setPlaceholder('Choose an article…').addOptions(options))],
          flags: EPH,
        });
      }
      const pick = i.values[0];
      if (pick === 'none') {
        issues.setArticle(issue.id, null);
        events.add(issue.id, 'article', i.user.id, 'Linked article removed');
        await syncMessage(client, issues.get(issue.id), trackerChannel(i));
        return i.update({ content: `Removed the linked article from #${issue.id}.`, components: [] });
      }
      const art = articles.get(Number(pick));
      if (!art || art.guild_id !== i.guildId) return i.update({ content: 'That article no longer exists.', components: [] });
      if (art.id === issue.article_id) return i.update({ content: 'That article is already linked.', components: [] });
      await i.deferUpdate();
      issues.setArticle(issue.id, art.id);
      events.add(issue.id, 'article', i.user.id, trunc(art.title, 80));
      await syncMessage(client, issues.get(issue.id), trackerChannel(i));
      notifyReporters(client, issues.get(issue.id), `📚 The developers linked a knowledge article to **#${issue.id} – ${trunc(issue.title, 120)}**:
**${trunc(art.title, 150)}**
> ${trunc(art.body, 700)}${art.link ? `
🔗 ${art.link}` : ''}
_You can turn these messages off under **My issues**._`).catch(() => {});
      refreshPanel(i.guildId);
      return i.editReply({ content: `🔗 Linked **${trunc(art.title, 100)}** to #${issue.id}.`, components: [] });
    }

    // ----- knowledge articles (developers) -----
    if (id === 'art_pick' || id.startsWith('art:') || (id.startsWith('mkart:') && i.isButton())) {
      if (!canManageArticles(i)) return noArticleAccess(i);
      const own = (a) => a && a.guild_id === i.guildId;
      const artFromId = () => articles.get(Number(id.split(':')[2]));
      if (id.startsWith('mkart:')) {
        const issue = await loadIssue(i, idOf(i));
        if (!issue) return;
        const sample = reports.forIssue(issue.id).slice(0, 3).map((r) => trunc(r.text.replace(/\s+/g, ' '), 200));
        return i.showModal(articleModal(null, { title: issue.title, symptoms: trunc([issue.title, ...sample].join('\n'), 1000), body: issue.dev_note ?? '' }));
      }
      if (i.isStringSelectMenu() && id === 'art_pick') {
        if (i.values[0].startsWith('kb:')) {
          const entry = KB.find((e) => `kb:${e.id}` === i.values[0]);
          return entry ? i.update(builtInView(i.guildId, entry)) : i.update({ content: 'That answer no longer exists.', embeds: [], components: [] });
        }
        const a = articles.get(Number(i.values[0]));
        return own(a) ? i.update(articleView(a, canDeleteArticle(i, a))) : i.update({ content: 'That article no longer exists.', embeds: [], components: [] });
      }
      if (i.isModalSubmit() && id === 'art:testm') {
        const sample = i.fields.getTextInputValue('sample');
        const list = articles.list(i.guildId, { enabledOnly: true });
        const found = suggest(sample, list, 3, null, kbBoosts(i.guildId), await semanticScores(sample, list));
        return show(i, {
          content: found.length
            ? `**A player who wrote that would see these first:**\n${found.map((s, n) => `${n + 1}. ${s.custom ? '📚' : '💡'} **${trunc(s.title, 80)}** — ${Math.round(s.score * 100)}% match`).join('\n')}`
            : 'Nothing matches that text closely, so the player would just see the full list of known problems.',
          embeds: [], components: [row(btn('art:back', 'Back', '⬅️'))],
        });
      }
      if (i.isModalSubmit() && id.startsWith('art:save:')) {
        const get = (k) => i.fields.getTextInputValue(k).trim();
        const data = { title: get('title'), symptoms: get('symptoms'), phrases: get('phrases'), body: get('body'), link: extractLinks(get('link'), 1)[0] ?? null };
        const rawId = id.split(':')[2];
        let a;
        if (rawId === 'new') a = articles.get(articles.add({ guild_id: i.guildId, ...data, created_by: i.user.id }));
        else {
          a = articles.get(Number(rawId));
          if (!own(a)) return i.reply({ content: 'That article no longer exists.', flags: EPH });
          articles.update(a.id, data);
          a = articles.get(a.id);
        }
        return show(i, articleView(a, canDeleteArticle(i, a)));
      }
      if (i.isButton()) {
        const [, action, arg] = id.split(':');
        if (action === 'page') return i.update(articlesPayload(i.guildId, Number(arg) || 0));
        if (action === 'back') return i.update(articlesPayload(i.guildId));
        if (action === 'drafts') return i.update(draftsPayload(i.guildId));
        if (action === 'all') return i.update(allKnowledgePayload(i.guildId, Number(arg) || 0));
        if (action === 'new') return i.showModal(articleModal(null));
        if (action === 'stats') return i.update(articleStats(i.guildId));
        if (action === 'test') {
          return i.showModal(new ModalBuilder().setCustomId('art:testm').setTitle('Test article matching').addComponents(
            input('sample', 'A sample report', { style: TextInputStyle.Paragraph, max: 1000, required: true, placeholder: 'Type what a player might write…' })));
        }
        const a = artFromId();
        if (!own(a)) return i.update({ content: 'That article no longer exists.', embeds: [], components: [] });
        // buttons on the proposal posted in the developer channel
        if (action === 'dpub') { articles.setEnabled(a.id, true); return i.update({ content: `✅ **${trunc(a.title, 100)}** was published by <@${i.user.id}>. Players can see it now.`, embeds: [], components: [], allowedMentions: { parse: [] } }); }
        if (action === 'drev') return i.reply({ ...articleView(a, canDeleteArticle(i, a)), flags: EPH });
        if (action === 'ddis') {
          if (!canDeleteArticle(i, a)) return i.reply({ content: "🔒 You can only discard drafts you created yourself. Ask a developer to remove this one.", flags: EPH });
          articles.delete(a.id);
          return i.update({ content: `🗑️ The proposed article **${trunc(a.title, 100)}** was discarded by <@${i.user.id}>.`, embeds: [], components: [], allowedMentions: { parse: [] } });
        }
        if (action === 'edit') return i.showModal(articleModal(a));
        if (action === 'view') return i.update(articleView(a, canDeleteArticle(i, a)));
        if (action === 'tog') { articles.setEnabled(a.id, !a.enabled); return i.update(articleView(articles.get(a.id), canDeleteArticle(i, a))); }
        if ((action === 'del' || action === 'delok') && !canDeleteArticle(i, a)) {
          return i.reply({ content: '🔒 You can only delete knowledge articles you created yourself. Ask a developer to remove this one.', flags: EPH });
        }
        if (action === 'del') {
          return i.update({
            content: `Delete **${trunc(a.title, 100)}**? Players will no longer be shown it.`, embeds: [],
            components: [row(btn(`art:delok:${a.id}`, 'Delete', '🗑️', ButtonStyle.Danger), btn(`art:view:${a.id}`, 'Cancel', '↩️'))],
          });
        }
        if (action === 'delok') { articles.delete(a.id); return i.update(articlesPayload(i.guildId)); }
      }
      return;
    }

    // ----- developer board -----
    if (i.isButton() && (id === 'board:refresh' || id === 'board:mine')) {
      if (!isDev(i)) return devOnly(i, 'use the board');
      return show(i, id === 'board:refresh' ? boardPayload(i.guildId) : boardPayload(i.guildId, { owner: i.user.id, title: '🙌 Your cards' }));
    }

    // ----- article editors (not developers) get only the knowledge-article tools behind the same button -----
    if (i.isButton() && (id === 'dev:menu' || id === 'dev:articles') && !isDev(i)) {
      if (!canManageArticles(i)) return id === 'dev:articles' ? noArticleAccess(i) : devOnly(i, 'use these tools');
      return show(i, id === 'dev:menu' ? articleMenuPayload() : articlesPayload(i.guildId));
    }

    // ----- developer menu (one button on the panel; everything below is hidden) -----
    if (i.isButton() && id.startsWith('dev:')) {
      if (!isDev(i)) return devOnly(i, 'use these tools');
      switch (id) {
        case 'dev:menu': return show(i, devMenuPayload(i.guildId));
        case 'dev:settings': return show(i, settingsPayload(i.guildId));
        case 'dev:dups': { await deferHidden(i); return i.editReply(dupPayload(i)); } // comparing many issues can take a few seconds
        case 'dev:articles': return show(i, articlesPayload(i.guildId));
        case 'dev:board': return show(i, boardPayload(i.guildId));
        case 'dev:export': {
          const files = exportCsv(i.guildId);
          return i.reply({
            content: '📤 Here are your exports. They contain Discord user IDs, so keep them private.',
            files: [new AttachmentBuilder(files.issues, { name: 'issues.csv' }), new AttachmentBuilder(files.reports, { name: 'reports.csv' })],
            flags: EPH,
          });
        }
        case 'dev:backup': {
          await i.deferReply({ flags: EPH });
          return i.editReply(`💾 Backup saved: \`${backupNow()}\`\nA backup of everything (issues, reports, knowledge articles, settings) is also made every hour, and the 168 newest (one week) are kept.`);
        }
        case 'dev:digest': {
          await i.deferReply({ flags: EPH });
          if (cfgOf(i.guildId).dev_channel_id) {
            await postDigest(client, i.guildId);
            return i.editReply({ content: `📊 The digest was posted in <#${cfgOf(i.guildId).dev_channel_id}>.` });
          }
          return i.editReply({ content: 'Here\'s the digest. 💡 Choose a digest channel in ⚙️ Settings and it will be posted there every week.', embeds: [buildDigest(i.guildId, cfgOf(i.guildId).stale_days)] });
        }
      }
      return;
    }

    // ----- settings menus -----
    if ((i.isStringSelectMenu() || i.isChannelSelectMenu()) && id.startsWith('set_')) {
      if (!isDev(i)) return devOnly(i, 'change settings');
      const v = i.values[0];
      if (id === 'set_devch') { // the hub: alerts + digest go here, and the live board is posted here (replacing the previous one)
        await i.deferUpdate();
        settings.update(i.guildId, { dev_channel_id: v, last_digest: Date.now() });
        try { await postBoard(client, i.guildId, await client.channels.fetch(v)); } catch (e) {
          await i.followUp({ content: `⚠️ I couldn't post the board in <#${v}>: ${errorMessage(e)}. Give the bot View Channel, Send Messages, Embed Links, Create Private Threads and Send Messages in Threads there.`, flags: EPH });
        }
        return i.editReply(settingsPayload(i.guildId));
      }
      const patch = {
        set_thr: { threshold: Number(v) },
        set_stale: { stale_days: Number(v) },
        set_cd: { cooldown_sec: Number(v) },
        set_devch: { dev_channel_id: v, last_digest: Date.now() },
        set_logch: { changelog_channel_id: v },
      }[id];
      if (patch) settings.update(i.guildId, patch);
      return i.update(settingsPayload(i.guildId));
    }

    // ----- duplicates review -----
    if (i.isButton() && /^dup[mks]:/.test(id)) {
      if (!isDev(i)) return devOnly(i, 'review duplicates');
      await i.deferUpdate(); // merging talks to Discord; acknowledge first
      const [kind, a, b] = [id.slice(0, 4), Number(id.split(':')[1]), Number(id.split(':')[2])];
      const A = issues.get(a);
      const B = issues.get(b);
      if (kind === 'dupm' && A && B) {
        // Keep the issue with more affected players (ties: the older one).
        const [keep, drop] = reports.stats(A.id).users >= reports.stats(B.id).users ? [A, B] : [B, A];
        await doMerge(i, drop, keep);
      } else if (kind === 'dupk') decisions.keepSeparate(i.guildId, a, b);
      else if (kind === 'dups') {
        if (!skipped.has(i.user.id)) skipped.set(i.user.id, new Set());
        skipped.get(i.user.id).add(`${a}-${b}`);
      }
      return i.editReply(dupPayload(i));
    }
  } catch (err) {
    await failInteraction(i, err);
  }
}

// Many handlers end with `return i.update(...)`; if that reply fails the rejection travels out of handleInteraction (a returned
// promise is not caught by the try/catch above), so it is caught here. Together they cover every way a click can fail.
client.on('interactionCreate', (i) => { handleInteraction(i).catch((err) => failInteraction(i, err)); });

// discord.js turns any stray rejection from a listener into an 'error' event, which crashes Node when nobody listens.
client.on('error', (err) => console.error('Discord client error:', err?.code ?? '', err?.message ?? err));

client.once('clientReady', async () => {
  const guild = process.env.GUILD_ID;
  confirmUpdate(); // the bot got as far as logging in: a freshly installed version is good
  // A failure here (bad GUILD_ID, Discord hiccup, rate limit) must not stop the rest of the start-up work below.
  try {
    if (guild) await (await client.guilds.fetch(guild)).commands.set(commands);
    else await client.application.commands.set(commands);
    console.log(`Logged in as ${client.user.tag}; commands registered ${guild ? `to guild ${guild}` : 'globally'}.`);
  } catch (e) {
    console.error(`Logged in as ${client.user.tag}, but registering the slash commands failed: ${e.message}. The bot keeps running; fix GUILD_ID / permissions and restart to register /setup.`);
  }
  warmEmbeddings(); // load the meaning model in the background (the bot answers by words until it's ready)
  suggest('warm up the word cache so the first player is not slower than the rest', [], 1); // fills the matcher's caches
  for (const cfg of settings.all()) try { for (const t of issues.withText(cfg.guild_id)) suggest(t.text, [], 1); } catch { /* not critical */ }

  // Hourly housekeeping: weekly digests, hourly DB backup, expire stashed reports.
  const tick = () => {
    runDigests(client).catch((e) => console.error('Digest error:', e.message));
    runNudges(client).catch((e) => console.error('Nudge error:', e.message));
    for (const cfg of settings.all()) {
      archiveFixedThreads(client, cfg.guild_id).catch((e) => console.error('Archive error:', e.message));
      if (cfg.auto_merge) autoMergeDuplicates(client, cfg.guild_id, cfg.channel_id).catch((e) => console.error('Auto-merge error:', e.message));
      if (cfg.retention_days > 0) purgeExpired(client, cfg.guild_id, cfg.retention_days).catch((e) => console.error('Retention error:', e.message));
    }
    for (const cfg of settings.all()) refreshPanel(cfg.guild_id); // issues go quiet with time, so the count can change without any click
    try { const f = maybeBackup(); if (f) console.log(`Backup written: ${f}`); } catch (e) { console.error('Backup failed:', e.message); }
    for (const [k, v] of drafts) if (v.exp < Date.now()) drafts.delete(k);
    for (const [k, v] of pendingFixed) if (v.exp < Date.now()) pendingFixed.delete(k);
    for (const [k, t] of statSeen) if (t < Date.now()) statSeen.delete(k);
  };
  setTimeout(tick, 30_000);
  setInterval(tick, 3_600_000);

  for (const cfg of settings.all()) seedArticles(cfg.guild_id); // starter articles for fast-changing answers, added once per server

  // Redraw each server's control panel so new buttons appear after an update without running /setup again.
  for (const cfg of settings.all()) {
    if (!cfg.panel_channel_id || !cfg.panel_message_id) continue;
    try { await (await (await client.channels.fetch(cfg.panel_channel_id)).messages.fetch(cfg.panel_message_id)).edit(panelPayload(cfg.guild_id)); }
    catch (e) { console.error(`Could not refresh the panel in ${cfg.guild_id}: ${e.message}`); }
  }

  // Counts on the panel come straight from the database; re-check every minute so merges, removals, withdrawals and article changes show up too.
  setInterval(() => { for (const cfg of settings.all()) if (cfg.panel_message_id) refreshPanel(cfg.guild_id); }, 60_000).unref?.();

  // Self-update (AUTO_UPDATE=on): look for a newer version every 10 minutes; install it and restart.
  if (process.env.AUTO_UPDATE === 'on') {
    const { checkForUpdate } = await import('./updater.js');
    const look = async () => { if (await checkForUpdate()) process.kill(process.pid, 'SIGTERM'); };
    setTimeout(look, 60_000);
    setInterval(look, 600_000);
  }
});

// The screens are exported so the tests can build every one of them (and catch Discord limit mistakes before a release).
export {
  panelPayload, devMenuPayload, reportTypePayload, reportModal, quickModal, meTooModal, editModal, addEvidenceModal, noteModal, fixedModal,
  faqPayload, faqAnswerPayload, browsePayload, settingsPayload, dupPayload, minePayload, trackPayload, articlesPayload, articleView,
  articleStats, articleModal, commands, timeline, failNote, canManageArticles, isDev, articleMenuPayload, client, failInteraction,
  handleInteraction,
};

// A network blip (for example a DNS lookup failing right at startup) must not take the bot down: keep retrying.
// Only a bad token or missing intents are permanent, so those stop the bot with a clear message.
async function start() {
  if (!process.env.DISCORD_TOKEN) {
    console.error('No bot token found: set DISCORD_TOKEN (copy .env.example to .env, or add it to the YAML), then start the bot again.');
    process.exit(1);
  }
  if (rollbackIfCrashLooping()) process.exit(1); // a just-installed version keeps failing: old code is back, the restart policy relaunches it
  process.on('unhandledRejection', (e) => console.error('Unhandled error:', e?.message ?? e));
  // `docker stop` sends SIGTERM: leave Discord and close the database cleanly (finishes writing its journal) instead of being cut off.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      console.log(`Received ${signal}, shutting down…`);
      try { client.destroy(); } catch { /* already closed */ }
      try { db.close(); } catch { /* already closed */ }
      process.exit(0);
    });
  }
  for (let attempt = 1; ; attempt++) {
    try {
      await client.login(process.env.DISCORD_TOKEN);
      return;
    } catch (e) {
      if (['TokenInvalid', 'DisallowedIntents', 'MissingIntents'].includes(e.code)) {
        console.error(`Discord rejected the bot token (${e.code}). Reset the token in the Developer Portal (Bot → Reset Token) and update DISCORD_TOKEN.`);
        process.exit(1);
      }
      const wait = Math.min(60, 5 * attempt);
      console.error(`Couldn't log in to Discord because ${explainError(e).reason}. Retrying in ${wait}s (attempt ${attempt})…`);
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    }
  }
}
// Only start when run directly (node src/index.js), not when imported by the tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) start();
