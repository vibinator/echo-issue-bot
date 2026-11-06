import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, Client,
  EmbedBuilder, FileUploadBuilder, GatewayIntentBits, LabelBuilder, MessageFlags, ModalBuilder, PermissionFlagsBits, SlashCommandBuilder,
  StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { articles, decisions, events, evidence, issues, kbStats, prefs, reports, restoredFrom, settings, summary, watchers } from './db.js';
import { erasePayload, privacyPayload, termsPayload } from './legal.js';
import { CATEGORIES } from './categories.js';
import { PRIORITIES, STATUSES, renderIssue } from './render.js';
import { relatedIssues } from './related.js';
import { extractLinks } from './evidence.js';
import {
  attachEvidence, purgeEvidence, duplicatePairs, fileReport, mergeIssues, notifyReporters, postChangelog, removeMessage, retireMessage,
  eraseUser, purgeExpired, rematchReport, splitReport, syncMessage, threadSay,
} from './service.js';
import { faqEntries, KB, suggest } from './kb.js';
import { boardPayload, dropBoard } from './board.js';
import { buildDigest, postDigest, runDigests } from './digest.js';
import { exportCsv } from './export.js';
import { backupNow, maybeBackup } from './backup.js';

const EPH = MessageFlags.Ephemeral;
const NONE = '-'; // "no filter" placeholder inside custom ids
const trunc = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const row = (...c) => new ActionRowBuilder().addComponents(...c);
const btn = (id, label, emoji, style = ButtonStyle.Secondary) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style);

// The only slash command: it bootstraps the control panel. Everything else is buttons, menus and modals.
const commands = [
  new SlashCommandBuilder().setName('setup').setDescription('Set up the issue tracker and post its control panel in this channel (admins)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((o) => o.setName('issues_channel').setDescription('Channel where each issue gets its own thread').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addRoleOption((o) => o.setName('dev_role').setDescription('Developer role – can manage issues and use the Developer menu').setRequired(true))
    .addRoleOption((o) => o.setName('reporter_role').setDescription('Only this role can send reports (leave empty to keep the current setting)'))
    .addIntegerOption((o) => o.setName('retention_days').setDescription('Delete closed issues after this many days of no activity (0 = keep them)').setMinValue(0).setMaxValue(3650)),
].map((c) => c.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ---------- helpers ----------

const cfgOf = (guildId) => ({ threshold: 0.25, stale_days: 7, cooldown_sec: 60, retention_days: 0, ...settings.get(guildId) });
const trackerChannel = (i) => settings.get(i.guildId)?.channel_id;
const idOf = (i) => Number(i.customId.split(':')[1]);

function isDev(i) {
  const cfg = settings.get(i.guildId);
  if (i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  return !!(cfg?.dev_role_id && i.member?.roles?.cache?.has(cfg.dev_role_id));
}
/** Role required to create reports: the /setup value, else REPORTER_ROLE_ID from .env, else nobody is restricted. */
const reporterRole = (guildId) => settings.get(guildId)?.reporter_role_id || process.env.REPORTER_ROLE_ID || null;

/** Developers can always report; everyone else needs the reporter role (when one is configured). */
function canReport(i) {
  const role = reporterRole(i.guildId);
  return !role || isDev(i) || !!i.member?.roles?.cache?.has(role);
}
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
const card = (i, issue) => renderIssue(issue, { back: backOf(i) });

// The one-line "describe it" a player typed while looking through known problems. Kept in memory only (never
// stored in the database), for 15 minutes, to rank the list and to pre-fill the report form.
const drafts = new Map();
const setDraft = (userId, text) => (text ? drafts.set(userId, { text, exp: Date.now() + 15 * 60_000 }) : drafts.delete(userId));
const getDraft = (userId) => {
  const d = drafts.get(userId);
  return d && d.exp > Date.now() ? d.text : '';
};

// ---------- panel, modals & forms ----------

function panelPayload() {
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('Echo VR – Problem Tracker')
    .setDescription([
      'Something not working? Let the developers know here.',
      '',
      '📝 **Report a problem** – we\'ll first show quick fixes for common problems. If none help, you can send a report.',
      '📋 **Browse issues** – see what has already been reported and how it\'s going.',
      '📌 **My reports** – follow your reports, add details, and turn update messages on or off.',
      '',
      '_Everything you open from these buttons is private – only you can see it._',
    ].join('\n'));
  return {
    embeds: [embed],
    components: [
      row(btn('report', 'Report a problem', '📝', ButtonStyle.Primary), btn('browse', 'Browse issues', '📋'), btn('mine', 'My reports', '📌'),
        btn('legal:privacy', 'Data & privacy', '🔒'), btn('legal:terms', 'Terms of use', '📜')),
      row(btn('dev:menu', 'Developer', '🛠️')),
    ],
  };
}

/** Everything developers need, one hidden menu behind a single button on the panel. */
function devMenuPayload() {
  return {
    content: '**🛠️ Developer menu** – only you can see this.',
    embeds: [],
    components: [
      row(btn('dev:board', 'Board', '📌'), btn('dev:dups', 'Review duplicates', '🔍'), btn('dev:articles', 'Knowledge articles', '📚')),
      row(btn('dev:settings', 'Settings', '⚙️'), btn('dev:digest', 'Digest', '📊')),
      row(btn('dev:export', 'Export CSV', '📤'), btn('dev:backup', 'Back up now', '💾')),
    ],
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
const versionField = () => labelled('Game / launcher version (optional)', lText('version', { max: 40, placeholder: 'e.g. 0.13.14' }));
const evidenceFields = () => [
  labelled('Links: screenshots, logs, videos (optional)',
    lText('links', { style: TextInputStyle.Paragraph, max: 1000, placeholder: 'https://…  (one per line)' }),
    'YouTube, Streamable, Medal, Imgur, Pastebin… up to 5 links'),
  new LabelBuilder().setLabel('Upload images, logs or videos (optional)')
    .setDescription('Up to 5 files. For large videos, paste a link above instead.')
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
function faqPayload(guildId, kind, matches = []) {
  const entries = faqEntries(kind, articles.list(guildId, { enabledOnly: true }));
  const helped = (e) => kbStats.get(guildId, e.id).helped;
  const matchScore = new Map(matches.map((m) => [m.id, m.score]));
  const rest = [...entries.filter((e) => e.custom), ...entries.filter((e) => !e.custom).sort((a, b) => helped(b) - helped(a))];
  const sorted = [...entries.filter((e) => matchScore.has(e.id)).sort((a, b) => matchScore.get(b.id) - matchScore.get(a.id)),
    ...rest.filter((e) => !matchScore.has(e.id))].slice(0, 25);
  const label = kind === 'install' ? '🔧 **Install issue**' : '🐞 **Bug in game**';
  const hint = matchScore.size ? '⭐ marks the closest matches to what you wrote.' : 'Pick the one that sounds like yours to see the fix.';
  return {
    content: `${label} – does one of these sound like your problem? ${hint}\nIf not, press **None of these** to send a report.`,
    embeds: [],
    components: [
      row(new StringSelectMenuBuilder().setCustomId(`faq:${kind}`).setPlaceholder('Pick the one that matches…')
        .addOptions(sorted.map((e) => ({
          label: trunc(e.title, 100), value: e.id, emoji: matchScore.has(e.id) ? '⭐' : e.custom ? '📚' : '💡',
          ...(matchScore.has(e.id) ? { description: `Closest match · ${Math.round(matchScore.get(e.id) * 100)}%` } : {}),
        })))),
      row(btn(`rform:${kind}`, 'None of these – send a report', '📝', ButtonStyle.Primary)),
    ],
  };
}

/** The list for this player, ranked by what they described (if anything). */
const faqFor = (i, kind) => {
  const text = getDraft(i.user.id);
  return faqPayload(i.guildId, kind, text ? suggest(text, articles.list(i.guildId, { enabledOnly: true }), 25, kind) : []);
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

/** Browse view: status / category / owner filters + issue picker. f = {s, c, o} (each NONE or a value). */
function browsePayload(i, f) {
  const owner = f.o === 'me' ? i.user.id : f.o === 'unassigned' ? 'none' : undefined;
  const list = issues.list(i.guildId, { status: f.s === NONE ? undefined : f.s, category: f.c === NONE ? undefined : f.c, owner });
  const menu = (id, placeholder, allLabel, current, opts) => new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder)
    .addOptions([{ label: allLabel, value: NONE, default: current === NONE }, ...opts.map((o) => ({ ...o, default: o.value === current }))]);
  const components = [
    row(menu(`bfs:${f.c}|${f.o}`, 'Show: status', 'Any status', f.s,
      Object.entries(STATUSES).map(([value, s]) => ({ label: s.label, emoji: s.emoji, value })))),
    row(menu(`bfc:${f.s}|${f.o}`, 'Show: category', 'Any category', f.c,
      [...Object.keys(CATEGORIES), 'Other'].map((c) => ({ label: c, value: c })))),
    row(menu(`bfo:${f.s}|${f.c}`, 'Show: who\'s on it', 'Anyone', f.o,
      [{ label: 'Nobody yet', value: 'unassigned', emoji: '🙈' }, { label: 'Assigned to me', value: 'me', emoji: '🙌' }])),
  ];
  if (list.length) {
    components.push(row(new StringSelectMenuBuilder().setCustomId('bfv').setPlaceholder('Pick an issue to open…').addOptions(list.slice(0, 25).map(issueOption))));
  }
  const content = list.length
    ? `**${list.length}** issue${list.length === 1 ? '' : 's'} found – the most important and most-reported are first${list.length > 25 ? ' (showing the top 25)' : ''}. Pick one to see the details.`
    : 'No issues match those filters. Try choosing "All" in one of the menus.';
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
      `• Closed issues are ${c.retention_days ? `deleted after **${c.retention_days} days** without activity` : '**kept** until deleted by hand'} _(change with \`/setup retention_days:\`)_`,
      `• Weekly digest goes to: ${c.dev_channel_id ? `<#${c.dev_channel_id}>` : '_not set_'} · fixed-issue announcements go to: ${c.changelog_channel_id ? `<#${c.changelog_channel_id}>` : '_not set_'}`,
    ].join('\n'),
    embeds: [],
    components: [
      pick('set_thr', 'How alike must reports be to group together?', [['Strict – fewer groups', 0.35, 'Keeps more reports as separate issues'], ['Balanced', 0.25, 'Recommended'], ['Loose – more groups', 0.18, 'Groups similar reports more eagerly']], c.threshold),
      pick('set_stale', 'Flag issues that go quiet after…', [['3 days', 3], ['7 days', 7], ['14 days', 14], ['30 days', 30]], c.stale_days),
      pick('set_cd', 'Pause between one player\'s reports', [['No pause', 0], ['30 seconds', 30], ['1 minute', 60], ['5 minutes', 300]], c.cooldown_sec),
      chanMenu('set_devch', 'Where should the weekly digest go? (developers)', c.dev_channel_id),
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
  mergeIssues(from.id, into.id);
  await syncMessage(client, issues.get(into.id), trackerChannel(i));
  await threadSay(client, into, `🔀 Issue #${from.id} (“${trunc(from.title, 80)}”) was merged into this one.`);
}

/** The DM people get when an issue they reported or follow changes – says what the status means for them. */
const STATUS_DM = {
  in_progress: (t) => `🛠️ The developers have started working on **${t}**.`,
  fixed: (t) => `✅ Good news – **${t}** is now fixed!`,
  cannot_reproduce: (t) => `❓ The developers couldn't make **${t}** happen on their side. More details can help: open **My reports** on the panel, then choose **Edit report** or **Add evidence**.`,
  wont_fix: (t) => `🚫 The developers have decided not to fix **${t}**.`,
};

async function applyStatus(i, issue, status, { version, note } = {}) {
  const old = issue.status;
  issues.setStatus(issue.id, status, i.user.id, version);
  if (note) issues.setNote(issue.id, note, i.user.id);
  const fresh = issues.get(issue.id);
  await syncMessage(client, fresh, trackerChannel(i));
  if (status !== old) {
    const s = STATUSES[status];
    const ver = status === 'fixed' && fresh.fixed_version ? ` (fixed in \`${fresh.fixed_version}\`)` : '';
    events.add(issue.id, 'status', i.user.id, `${STATUSES[old]?.label} → ${s.label}${ver}`);
    await threadSay(client, fresh, `${s.emoji} <@${i.user.id}> set the status to **${s.label}**${ver}.`);
    if (STATUS_DM[status]) {
      const update = status === 'fixed' && fresh.fixed_version ? `\nUpdate to version \`${fresh.fixed_version}\` (or newer) to get the fix.` : '';
      const devNote = fresh.dev_note ? `\n> ${fresh.dev_note}` : '';
      notifyReporters(client, fresh, `${STATUS_DM[status](`#${fresh.id} – ${trunc(fresh.title, 120)}`)}${update}${devNote}\n_You can turn these messages off under **My reports**._`).catch(() => {});
    }
    if (status === 'fixed') await postChangelog(client, fresh, cfgOf(i.guildId).changelog_channel_id);
  }
  return fresh;
}

async function submitReport(i, { text, platform, version, evidence, kind = 'bug' }) {
  const cfg = cfgOf(i.guildId);
  const res = fileReport({ guildId: i.guildId, userId: i.user.id, text, platform, version, kind, threshold: cfg.threshold });
  await syncMessage(client, res.issue, cfg.channel_id);
  const saved = await attachEvidence(client, res.issue, i.user.id, res.reportId, evidence);
  if (saved) await syncMessage(client, issues.get(res.issue.id), cfg.channel_id);
  if (res.reopened) {
    await threadSay(client, res.issue, `⚠️ Reopened by a new report${res.fixedVersion ? ` (it was fixed in \`${res.fixedVersion}\`${version ? `; reporter is on \`${version}\`` : ''})` : ''}.`);
  }
  const fresh = issues.get(res.issue.id);
  const where = fresh.channel_id ? ` You can follow the discussion in <#${fresh.channel_id}>.` : '';
  const content = res.created
    ? `✅ **Thanks – your report has been sent!**\nIt's now ${fresh.kind === 'install' ? '🔧 install issue' : '🐞 issue'} **#${fresh.id}** (${fresh.category}).${where}`
    : `✅ **Thanks – your report has been added!**\nOther players have reported something similar, so it joined **#${fresh.id} – ${trunc(fresh.title, 100)}**.${where}` +
      (res.reopened ? '\n⚠️ That issue had been marked fixed, so it has been reopened for the developers to look at again.' : '');
  const evidenceLine = saved ? `\n📎 Saved ${saved} attachment${saved === 1 ? '' : 's'}/link${saved === 1 ? '' : 's'} with your report.` : '';
  const next = '\nYou\'ll get a message when its status changes. See everything under **My reports**.';
  return {
    content: `${content}${evidenceLine}${next}`, embeds: [],
    components: res.created ? [] : [row(btn(`split:${res.reportId}`, 'This is a different problem', '↩️'))],
  };
}

// ---------- tracking: my reports, editing, timeline ----------

const EVENT_LABEL = {
  created: '🆕 Reported', status: '🔄 Status', priority: '⚑ Priority', owner: '🙌 Owner',
  merged: '🔀 Merged', reopened: '⚠️ Reopened', rematched: '🔁 Report moved',
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
    .sort((a, b) => b.it.updated_at - a.it.updated_at).slice(0, 25);
  const dmOff = prefs.dmOff(i.user.id);
  const dmRow = row(btn('dm:toggle', dmOff ? 'Turn update messages on' : 'Turn update messages off', dmOff ? '🔔' : '🔕'), btn('legal:privacy', 'Data & privacy', '🔒'));
  if (!list.length) {
    return { content: "You haven't sent or followed any reports yet. Press **Report a problem** on the panel, or 🔔 **Follow** on any issue to get updates.", embeds: [], components: [dmRow] };
  }
  return {
    content: `**📌 My reports** (${list.length}) – pick one to see how it's going, add details or edit it.\nUpdate messages: **${dmOff ? 'off 🔕' : 'on 🔔'}** – use the button below to change this.`,
    embeds: [],
    components: [row(new StringSelectMenuBuilder().setCustomId('mine_view').setPlaceholder('Open one…').addOptions(list.map(({ it, tag }) => ({
      label: trunc(`#${it.id} ${it.title}`, 100),
      description: trunc(`${tag} · ${STATUSES[it.status]?.label} · ${(PRIORITIES[it.priority] ?? PRIORITIES.normal).label}`, 100),
      emoji: STATUSES[it.status]?.emoji,
      value: String(it.id),
    })))), dmRow],
  };
}

/** Personal progress card for one issue: status, your report, timeline, and the edit / re-check / withdraw buttons. */
function trackPayload(i, issue) {
  const st = STATUSES[issue.status] ?? STATUSES.new;
  const pr = PRIORITIES[issue.priority] ?? PRIORITIES.normal;
  const mine = reports.latestByUser(issue.id, i.user.id);
  const stats = reports.stats(issue.id);
  const mineEv = mine ? evidence.forReport(mine.id).length : 0;
  const embed = new EmbedBuilder().setColor(st.color).setTitle(trunc(`${pr.emoji} #${issue.id} · ${issue.title}`, 256))
    .addFields(
      { name: 'Status', value: `${st.emoji} ${st.label}${issue.status === 'fixed' && issue.fixed_version ? ` in \`${issue.fixed_version}\`` : ''}`, inline: true },
      { name: 'Priority', value: `${pr.emoji} ${pr.label}`, inline: true },
      { name: "Who's on it", value: issue.owner_id ? `<@${issue.owner_id}>` : '_nobody yet_', inline: true },
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
      btn(`rematch:${mine.id}`, 'Recalculate match', '🔄'), btn(`wd:${mine.id}`, 'Withdraw', '🗑️')));
  }
  const nav = [btn('mine:back', 'Back', '⬅️')];
  if (!mine) nav.push(btn(`follow:${issue.id}`, watchers.has(issue.id, i.user.id) ? 'Unfollow' : 'Follow', watchers.has(issue.id, i.user.id) ? '🔕' : '🔔'));
  rows.push(row(...nav));
  return { content: '', embeds: [embed], components: rows };
}

const editModal = (report) => new ModalBuilder().setCustomId(`edit:${report.id}`).setTitle(`Edit your report · #${report.issue_id}`).addLabelComponents(
  labelled('What went wrong?', lText('text', { style: TextInputStyle.Paragraph, max: 1000, required: true, min: 15, value: report.text })),
  labelled('Headset / platform (optional)', lText('platform', { max: 60, value: report.platform })),
  labelled('Game / launcher version (optional)', lText('version', { max: 40, value: report.version })),
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

function articleView(a) {
  const s = kbStats.get(a.guild_id, `a:${a.id}`);
  const embed = new EmbedBuilder().setColor(a.enabled ? 0xfee75c : 0x95a5a6).setTitle(`📚 ${trunc(a.title, 240)}${a.enabled ? '' : ' (disabled)'}`)
    .addFields(
      { name: 'Matches players who write', value: trunc(a.symptoms, 1024) },
      ...(a.phrases ? [{ name: 'Always matches this exact text', value: trunc(a.phrases, 1024) }] : []),
      { name: 'Answer players see', value: trunc(a.link ? `${a.body}\n\n🔗 ${a.link}` : a.body, 1024) },
      { name: 'How it\'s doing', value: `Viewed ${s.shown}× · ✅ fixed it ${s.helped}× · 🙅 not their problem ${s.denied}× · 📝 sent a report anyway ${s.filed}×` },
    );
  return {
    content: '', embeds: [embed],
    components: [row(btn(`art:edit:${a.id}`, 'Edit', '✏️'), btn(`art:tog:${a.id}`, a.enabled ? 'Disable' : 'Enable', a.enabled ? '⏸️' : '▶️'),
      btn(`art:del:${a.id}`, 'Delete', '🗑️'), btn('art:back', 'Back', '⬅️'))],
  };
}

function articlesPayload(guildId) {
  const list = articles.list(guildId).slice(0, 25);
  const components = [];
  if (list.length) {
    components.push(row(new StringSelectMenuBuilder().setCustomId('art_pick').setPlaceholder('Open an article…').addOptions(list.map((a) => {
      const s = kbStats.get(guildId, `a:${a.id}`);
      return { label: trunc(a.title, 100), description: trunc(`${a.enabled ? 'on' : 'off'} · shown ${s.shown} · helped ${s.helped} · denied ${s.denied}`, 100), value: String(a.id) };
    }))));
  }
  components.push(row(btn('art:new', 'New article', '➕', ButtonStyle.Success), btn('art:stats', 'Results', '📊'), btn('art:test', 'Test matching', '🧪'),
    btn('dev:menu', 'Developer menu', '⬅️')));
  return {
    content: `**📚 Knowledge articles** – ${list.length} of your own, plus ${KB.length} built-in answers.\nBefore anyone sends a report, they see a list of known problems (your articles first, and the closest matches to what they typed are moved to the top, even with typos). **Results** shows which answers actually help, and **Test matching** shows what a player would see for a sample sentence.`,
    embeds: [], components,
  };
}

function articleStats(guildId) {
  const title = (id) => (id.startsWith('kb:') ? KB.find((e) => `kb:${e.id}` === id)?.title : articles.get(Number(id.slice(2)))?.title) ?? '(deleted)';
  const rows = kbStats.forGuild(guildId).filter((s) => s.shown > 0).slice(0, 15);
  const lines = rows.map((s) => {
    const flag = s.denied >= 3 && s.denied > s.helped ? ' ⚠️ often denied' : '';
    return `**${trunc(title(s.article_id), 60)}** — viewed ${s.shown}× · ✅ ${s.helped} · 🙅 ${s.denied} · 📝 ${s.filed}${flag}`;
  });
  return {
    content: '', components: [row(btn('art:back', 'Back', '⬅️'))],
    embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📊 How suggestions are doing')
      .setDescription(lines.join('\n') || '_No answers have been viewed yet._')
      .setFooter({ text: '✅ = "That fixed it" · 🙅 = "That\'s not my problem" · 📝 = "Didn\'t help – send a report"' })],
  };
}

// ---------- interactions ----------

client.on('interactionCreate', async (i) => {
  try {
    if (!i.guildId) return;
    const id = i.customId ?? '';

    // /setup
    if (i.isChatInputCommand() && i.commandName === 'setup') {
      const ch = i.options.getChannel('issues_channel', true);
      const role = i.options.getRole('dev_role', true);
      const prev = settings.get(i.guildId);
      try { backupNow(); } catch (e) { console.error('Backup before /setup failed:', e.message); } // a safety copy before anything changes
      settings.set(i.guildId, ch.id, role.id); // upsert: every other saved setting is kept
      const reporter = i.options.getRole('reporter_role');
      if (reporter) settings.update(i.guildId, { reporter_role_id: reporter.id });
      const retention = i.options.getInteger('retention_days');
      if (retention !== null) settings.update(i.guildId, { retention_days: retention });
      // Only ONE public message: replace the previous panel (and any old live board) instead of adding another.
      if (prev?.panel_message_id && prev.panel_channel_id) {
        try { await (await (await client.channels.fetch(prev.panel_channel_id)).messages.fetch(prev.panel_message_id)).delete(); } catch { /* gone */ }
      }
      await dropBoard(client, i.guildId);
      const panelMsg = await i.channel.send(panelPayload());
      settings.update(i.guildId, { panel_channel_id: i.channel.id, panel_message_id: panelMsg.id });
      const rr = reporterRole(i.guildId);
      const have = summary(i.guildId);
      const kept = have.issues || have.articles
        ? `\n♻️ Existing data found and kept: **${have.issues}** issue${have.issues === 1 ? '' : 's'}, **${have.reports}** report${have.reports === 1 ? '' : 's'}, **${have.articles}** knowledge article${have.articles === 1 ? '' : 's'}${restoredFrom ? ` (restored from backup \`${restoredFrom}\`)` : ''}.`
        : '';
      return i.reply({
        content: [
          '✅ **All set!** The control panel is posted above.',
          `• Each issue gets its own thread in <#${ch.id}>`,
          `• Developers: <@&${role.id}> (and anyone with Manage Server) – they can change an issue's status and use the Developer menu`,
          `• Who can send reports: ${rr ? `<@&${rr}>` : 'everyone'}`,
          ...(kept ? [kept.trim()] : []),
          '',
          'Next: press **🛠️ Developer → ⚙️ Settings** to choose where the weekly digest and "fixed" announcements go.',
        ].join('\n'),
        allowedMentions: { parse: [] },
        flags: EPH,
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
      return show(i, faqFor(i, id.slice(5)));
    }
    if (i.isStringSelectMenu() && id.startsWith('faq:')) {
      const kind = id.slice(4);
      const entry = faqEntries(kind, articles.list(i.guildId, { enabledOnly: true })).find((e) => e.id === i.values[0]);
      if (!entry) return i.update(faqFor(i, kind));
      kbStats.bump(i.guildId, entry.id, 'shown');
      return i.update(faqAnswerPayload(entry, kind));
    }
    if (i.isButton() && id.startsWith('faqok:')) {
      const [, , ...rest] = id.split(':');
      kbStats.bump(i.guildId, rest.join(':'), 'helped');
      return i.update({ content: 'Great, glad that helped! 🎉 No report was needed.', embeds: [], components: [] });
    }
    if (i.isButton() && id.startsWith('faqno:')) {
      const [, kind, ...rest] = id.split(':');
      kbStats.bump(i.guildId, rest.join(':'), 'denied');
      return i.update(faqFor(i, kind));
    }
    // "None of these" / "Still happening": open the form.
    if (i.isButton() && id.startsWith('rform:')) {
      if (!canReport(i)) return noReportAccess(i);
      const [, kind, ...rest] = id.split(':');
      if (rest.length) kbStats.bump(i.guildId, rest.join(':'), 'filed');
      const wait = cooldownLeft(i);
      return wait ? i.reply(waitMsg(wait)) : i.showModal(reportModal(kind, getDraft(i.user.id))); // pre-filled with what they already wrote
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
      // The player already went through the known-problems list and chose to report: file it, no more searching.
      setDraft(i.user.id, '');
      await deferHidden(i); // re-hosting files can take longer than Discord's 3s limit
      return i.editReply(await submitReport(i, data));
    }
    if (i.isButton() && id.startsWith('split:')) {
      const report = reports.get(idOf(i));
      if (!report || report.user_id !== i.user.id) return i.reply({ content: 'You can only change your own reports.', flags: EPH });
      const res = splitReport(report.id);
      if (res.old) await syncMessage(client, res.old, trackerChannel(i));
      else await removeMessage(client, res.emptiedIssue);
      await syncMessage(client, res.fresh, trackerChannel(i));
      return i.update({ content: `✅ Got it – your report is now its own issue, **#${res.fresh.id}**.`, components: [] });
    }

    // ----- browsing -----
    if (i.isButton() && id === 'browse') return show(i, browsePayload(i, { s: NONE, c: NONE, o: NONE }));
    if (i.isStringSelectMenu() && id.startsWith('bfs:')) {
      const [c, o] = id.slice(4).split('|');
      return i.update(browsePayload(i, { s: i.values[0], c, o }));
    }
    if (i.isStringSelectMenu() && id.startsWith('bfc:')) {
      const [s, o] = id.slice(4).split('|');
      return i.update(browsePayload(i, { s, c: i.values[0], o }));
    }
    if (i.isStringSelectMenu() && id.startsWith('bfo:')) {
      const [s, c] = id.slice(4).split('|');
      return i.update(browsePayload(i, { s, c, o: i.values[0] }));
    }
    if (i.isStringSelectMenu() && id === 'bfv') {
      const issue = await loadIssue(i, Number(i.values[0]));
      return issue && i.update(renderIssue(issue, { back: 'browse' }));
    }
    if (i.isStringSelectMenu() && id === 'bfb') { // a card picked on the developer board
      const issue = await loadIssue(i, Number(i.values[0]));
      return issue && i.update(renderIssue(issue, { back: 'dev:board' }));
    }

    // ----- issue message: status / priority / owner -----
    if (i.isStringSelectMenu() && id.startsWith('status:')) {
      if (!isDev(i)) return devOnly(i, "change an issue's status");
      const issue = await loadIssue(i, idOf(i));
      if (!issue) return;
      const status = i.values[0];
      if (status === 'fixed' && issue.status !== 'fixed') return i.showModal(fixedModal(issue));
      return i.update(card(i, await applyStatus(i, issue, status)));
    }
    if (i.isModalSubmit() && id.startsWith('fixed:')) {
      if (!isDev(i)) return devOnly(i, "change an issue's status");
      const issue = await loadIssue(i, idOf(i));
      if (!issue) return;
      const fresh = await applyStatus(i, issue, 'fixed', {
        version: i.fields.getTextInputValue('version').trim(),
        note: i.fields.getTextInputValue('text').trim(),
      });
      return i.isFromMessage() ? i.update(card(i, fresh)) : i.reply({ content: `Marked #${issue.id} fixed.`, flags: EPH });
    }
    if (i.isStringSelectMenu() && id.startsWith('prio:')) {
      if (!isDev(i)) return devOnly(i, 'change priority');
      const issue = await loadIssue(i, idOf(i));
      if (!issue) return;
      issues.setPriority(issue.id, i.values[0], i.user.id);
      events.add(issue.id, 'priority', i.user.id, `${PRIORITIES[issue.priority]?.label} → ${PRIORITIES[i.values[0]]?.label}`);
      await syncMessage(client, issues.get(issue.id), trackerChannel(i));
      return i.update(card(i, issues.get(issue.id)));
    }
    if (i.isButton() && id.startsWith('assign:')) {
      if (!isDev(i)) return devOnly(i, 'take issues');
      const issue = await loadIssue(i, idOf(i));
      if (!issue) return;
      const mine = issue.owner_id === i.user.id;
      issues.setOwner(issue.id, mine ? null : i.user.id);
      events.add(issue.id, 'owner', i.user.id, mine ? 'unassigned' : 'took the issue');
      await syncMessage(client, issues.get(issue.id), trackerChannel(i));
      if (!mine) await threadSay(client, issue, `🙌 <@${i.user.id}> took this issue${issue.owner_id ? ` (from <@${issue.owner_id}>)` : ''}.`);
      return i.update(card(i, issues.get(issue.id)));
    }

    // ----- issue message: I have this too -----
    if (i.isButton() && id.startsWith('plus:')) {
      const issue = await loadIssue(i, idOf(i));
      if (!issue) return;
      if (!canReport(i)) return noReportAccess(i);
      if (reports.hasUser(issue.id, i.user.id)) return i.reply({ content: 'You\'ve already added your report to this issue. 👍 To add more, use **My reports** → **Edit my report** or **Add screenshots / logs**.', flags: EPH });
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
      await i.deferReply({ flags: EPH });
      const version = i.fields.getTextInputValue('version').trim();
      const reportId = reports.add(issue.id, i.user.id, i.fields.getTextInputValue('text').trim() || '(me too)', i.fields.getTextInputValue('platform').trim(), version);
      const saved = await attachEvidence(client, issue, i.user.id, reportId, readEvidence(i));
      if (issue.status === 'fixed') {
        issues.setStatus(issue.id, 'new', null);
        await threadSay(client, issue, `⚠️ Reopened by another report${issue.fixed_version ? ` (it was fixed in \`${issue.fixed_version}\`${version ? `; reporter is on \`${version}\`` : ''})` : ''}.`);
      } else issues.touch(issue.id);
      await syncMessage(client, issues.get(issue.id), trackerChannel(i));
      return i.editReply({ content: `✅ **Thanks – your report was added to #${issue.id}.**${saved ? `\n📎 Saved ${saved} attachment${saved === 1 ? '' : 's'}/link${saved === 1 ? '' : 's'} with it.` : ''}\nYou'll get a message when its status changes. See everything under **My reports**.` });
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
      issues.setNote(issue.id, i.fields.getTextInputValue('text').trim() || null, i.user.id);
      await syncMessage(client, issues.get(issue.id), trackerChannel(i));
      return i.reply({ content: `Note saved on #${issue.id}.`, flags: EPH });
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
        content: `Merge **#${issue.id} – ${trunc(issue.title, 80)}** into which issue? Its reports move over and its thread is locked. ⭐ marks issues that look alike.`,
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
      await doMerge(i, from, into);
      return i.update({ content: `🔀 Merged #${from.id} into #${into.id}.`, components: [] });
    }

    // ----- issue message: remove a (spam) report -----
    if (i.isButton() && id.startsWith('rmrep:')) {
      if (!isDev(i)) return devOnly(i, 'remove reports');
      const issue = await loadIssue(i, idOf(i));
      if (!issue) return;
      const list = reports.forIssue(issue.id).slice(0, 25);
      const names = await Promise.all(list.map((r) => client.users.fetch(r.user_id).then((u) => u.username).catch(() => r.user_id)));
      return i.reply({
        content: `Which report on **#${issue.id}** should be removed? (Newest first.)`,
        components: [row(new StringSelectMenuBuilder().setCustomId(`rmsel:${issue.id}`).setPlaceholder('Choose a report to remove…')
          .addOptions(list.map((r, n) => ({
            label: trunc(`${names[n]}: ${r.text.replace(/\s+/g, ' ')}`, 100),
            description: `Report #${r.id} · ${new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' ')}`,
            value: String(r.id),
          }))))],
        flags: EPH,
      });
    }
    if (i.isStringSelectMenu() && id.startsWith('rmsel:')) {
      if (!isDev(i)) return devOnly(i, 'remove reports');
      const issue = issues.get(idOf(i));
      const report = reports.get(Number(i.values[0]));
      if (!issue || !report || report.issue_id !== issue.id || issue.guild_id !== i.guildId) {
        return i.update({ content: 'That report no longer exists.', components: [] });
      }
      const { issueDeleted } = await dropReport(i, issue, report);
      return i.update({
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
        content: `🗑️ Done. Removed ${removed} report${removed === 1 ? '' : 's'}${anonymised ? ` and removed your details from ${anonymised} issue${anonymised === 1 ? '' : 's'} developers had already worked on` : ''}, plus your follows and settings.\nMessages you wrote yourself in issue threads are separate – ask a moderator to remove them.`,
        embeds: [], components: [],
      });
    }
    if (i.isButton() && id === 'dm:toggle') {
      prefs.setDmOff(i.user.id, !prefs.dmOff(i.user.id));
      return i.update(minePayload(i));
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
      return i.reply({ content: `🔔 You're now following **#${issue.id}** – you'll get a message when its status changes. You can find everything you follow under **My reports**.`, flags: EPH });
    }
    if (i.isButton() && id.startsWith('history:')) {
      const issue = await loadIssue(i, idOf(i));
      if (!issue) return;
      return i.reply({
        embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(trunc(`📜 History · #${issue.id} ${issue.title}`, 250)).setDescription(timeline(issue.id, isDev(i), 15))],
        flags: EPH,
      });
    }

    // edit my report / add evidence – from the issue message (find my latest report) or from My reports (report id)
    if (i.isButton() && (id.startsWith('editmine:') || id.startsWith('addev:'))) {
      if (!canReport(i)) return noReportAccess(i);
      const issue = await loadIssue(i, idOf(i));
      if (!issue) return;
      const mine = reports.latestByUser(issue.id, i.user.id);
      if (!mine) return i.reply({ content: "You haven't added a report to this issue yet – press **I have this too** first.", flags: EPH });
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
      await deferHidden(i); // replaces the "My reports" card in place when opened from there
      const editing = id.startsWith('edit:');
      if (editing) {
        reports.update(report.id, {
          text: i.fields.getTextInputValue('text').trim(),
          platform: i.fields.getTextInputValue('platform').trim(),
          version: i.fields.getTextInputValue('version').trim(),
        });
      }
      const issue = issues.get(report.issue_id);
      const saved = await attachEvidence(client, issue, i.user.id, report.id, readEvidence(i));
      issues.touch(issue.id);
      await syncMessage(client, issues.get(issue.id), trackerChannel(i));
      const added = saved ? ` and added ${saved} attachment${saved === 1 ? '' : 's'}/link${saved === 1 ? '' : 's'}` : '';
      await threadSay(client, issue, `✏️ A reporter ${editing ? 'edited their report' : 'added evidence'}${editing ? added : ''}.`);
      return i.editReply({
        content: `✅ ${editing ? `Your report was updated${added}.` : saved ? `Saved ${saved} attachment${saved === 1 ? '' : 's'}/link${saved === 1 ? '' : 's'} with your report.` : 'Nothing new was added.'}\nIf your new details change what the problem is, press **Recalculate match** and I'll check whether your report belongs with a different issue.`,
        components: [row(btn(`rematch:${report.id}`, 'Recalculate match', '🔄', ButtonStyle.Primary), btn(`trk:${issue.id}`, 'See how it\'s going', '📌'))],
      });
    }
    if (i.isButton() && id.startsWith('rematch:')) {
      const report = reports.get(idOf(i));
      if (!report || report.user_id !== i.user.id) return i.reply({ content: 'You can only change your own reports.', flags: EPH });
      const res = rematchReport(report.id, i.user.id, cfgOf(i.guildId).threshold);
      if (res.action === 'same') {
        return i.update({
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
      return i.update({
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
      const { issueDeleted } = await dropReport(i, issues.get(report.issue_id), report);
      return i.update({ content: issueDeleted ? '🗑️ Your report was withdrawn. Because it was the only one, the issue was removed too.' : '🗑️ Your report was withdrawn.', embeds: [], components: [] });
    }

    // ----- knowledge articles (developers) -----
    if (id === 'art_pick' || id.startsWith('art:') || (id.startsWith('mkart:') && i.isButton())) {
      if (!isDev(i)) return devOnly(i, 'manage knowledge articles');
      const own = (a) => a && a.guild_id === i.guildId;
      const artFromId = () => articles.get(Number(id.split(':')[2]));
      if (id.startsWith('mkart:')) {
        const issue = await loadIssue(i, idOf(i));
        if (!issue) return;
        const sample = reports.forIssue(issue.id).slice(0, 3).map((r) => r.text.replace(/\s+/g, ' ').slice(0, 200));
        return i.showModal(articleModal(null, { title: issue.title, symptoms: trunc([issue.title, ...sample].join('\n'), 1000), body: issue.dev_note ?? '' }));
      }
      if (i.isStringSelectMenu() && id === 'art_pick') {
        const a = articles.get(Number(i.values[0]));
        return own(a) ? i.update(articleView(a)) : i.update({ content: 'That article no longer exists.', embeds: [], components: [] });
      }
      if (i.isModalSubmit() && id === 'art:testm') {
        const found = suggest(i.fields.getTextInputValue('sample'), articles.list(i.guildId, { enabledOnly: true }));
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
        return show(i, articleView(a));
      }
      if (i.isButton()) {
        const [, action] = id.split(':');
        if (action === 'back') return i.update(articlesPayload(i.guildId));
        if (action === 'new') return i.showModal(articleModal(null));
        if (action === 'stats') return i.update(articleStats(i.guildId));
        if (action === 'test') {
          return i.showModal(new ModalBuilder().setCustomId('art:testm').setTitle('Test article matching').addComponents(
            input('sample', 'A sample report', { style: TextInputStyle.Paragraph, max: 1000, required: true, placeholder: 'Type what a player might write…' })));
        }
        const a = artFromId();
        if (!own(a)) return i.update({ content: 'That article no longer exists.', embeds: [], components: [] });
        if (action === 'edit') return i.showModal(articleModal(a));
        if (action === 'view') return i.update(articleView(a));
        if (action === 'tog') { articles.setEnabled(a.id, !a.enabled); return i.update(articleView(articles.get(a.id))); }
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

    // ----- developer menu (one button on the panel; everything below is hidden) -----
    if (i.isButton() && id.startsWith('dev:')) {
      if (!isDev(i)) return devOnly(i, 'use these tools');
      switch (id) {
        case 'dev:menu': return show(i, devMenuPayload());
        case 'dev:settings': return show(i, settingsPayload(i.guildId));
        case 'dev:dups': return show(i, dupPayload(i));
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
          return i.editReply(`💾 Backup saved: \`${backupNow()}\`\nA backup is also made every day, and the 14 newest are kept.`);
        }
        case 'dev:digest': {
          if (cfgOf(i.guildId).dev_channel_id) {
            await postDigest(client, i.guildId);
            return i.reply({ content: `📊 The digest was posted in <#${cfgOf(i.guildId).dev_channel_id}>.`, flags: EPH });
          }
          return i.reply({ content: 'Here\'s the digest. 💡 Choose a digest channel in ⚙️ Settings and it will be posted there every week.', embeds: [buildDigest(i.guildId, cfgOf(i.guildId).stale_days)], flags: EPH });
        }
      }
      return;
    }

    // ----- settings menus -----
    if ((i.isStringSelectMenu() || i.isChannelSelectMenu()) && id.startsWith('set_')) {
      if (!isDev(i)) return devOnly(i, 'change settings');
      const v = i.values[0];
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
      return i.update(dupPayload(i));
    }
  } catch (err) {
    console.error(err);
    const reply = { content: 'Sorry, something went wrong on our side. Please try again in a moment – if it keeps happening, let a developer know.', flags: EPH };
    if (i.replied || i.deferred) i.followUp(reply).catch(() => {}); else i.reply(reply).catch(() => {});
  }
});

client.once('clientReady', async () => {
  const guild = process.env.GUILD_ID;
  if (guild) await (await client.guilds.fetch(guild)).commands.set(commands);
  else await client.application.commands.set(commands);
  console.log(`Logged in as ${client.user.tag}; commands registered ${guild ? `to guild ${guild}` : 'globally'}.`);

  // Hourly housekeeping: weekly digests, daily DB backup, expire stashed reports.
  const tick = () => {
    runDigests(client).catch((e) => console.error('Digest error:', e.message));
    for (const cfg of settings.all()) {
      if (cfg.retention_days > 0) purgeExpired(client, cfg.guild_id, cfg.retention_days).catch((e) => console.error('Retention error:', e.message));
    }
    try { const f = maybeBackup(); if (f) console.log(`Backup written: ${f}`); } catch (e) { console.error('Backup failed:', e.message); }
    for (const [k, v] of drafts) if (v.exp < Date.now()) drafts.delete(k);
  };
  setTimeout(tick, 30_000);
  setInterval(tick, 3_600_000);
});

if (!process.env.DISCORD_TOKEN) {
  console.error('Set DISCORD_TOKEN (copy .env.example to .env, then run: npm start)');
  process.exit(1);
}
// A network blip (for example a DNS lookup failing right at startup) must not take the bot down: keep retrying.
// Only a bad token or missing intents are permanent, so those stop the bot with a clear message.
process.on('unhandledRejection', (e) => console.error('Unhandled error:', e?.message ?? e));

async function start() {
  for (let attempt = 1; ; attempt++) {
    try {
      await client.login(process.env.DISCORD_TOKEN);
      return;
    } catch (e) {
      if (['TokenInvalid', 'DisallowedIntents', 'MissingIntents'].includes(e.code)) {
        console.error(`Cannot log in (${e.code}): check DISCORD_TOKEN.`);
        process.exit(1);
      }
      const wait = Math.min(60, 5 * attempt);
      console.error(`Login failed (${e.code ?? e.message}); retrying in ${wait}s (attempt ${attempt})…`);
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    }
  }
}
start();
