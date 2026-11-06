import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, Client,
  EmbedBuilder, FileUploadBuilder, GatewayIntentBits, LabelBuilder, MessageFlags, ModalBuilder, PermissionFlagsBits, SlashCommandBuilder,
  StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { articles, decisions, events, evidence, issues, kbStats, prefs, reports, settings, watchers } from './db.js';
import { erasePayload, privacyPayload, termsPayload } from './legal.js';
import { CATEGORIES } from './categories.js';
import { PRIORITIES, STATUSES, renderIssue } from './render.js';
import { relatedIssues } from './related.js';
import { extractLinks } from './evidence.js';
import {
  attachEvidence, purgeEvidence, duplicatePairs, fileReport, mergeIssues, notifyReporters, postChangelog, removeMessage, retireMessage,
  eraseUser, purgeExpired, rematchReport, splitReport, syncMessage, threadSay,
} from './service.js';
import { KB, suggest } from './kb.js';
import { boardPayload, postBoard } from './board.js';
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
  new SlashCommandBuilder().setName('setup').setDescription('Configure the tracker and post the control panel here (admin)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((o) => o.setName('issues_channel').setDescription('Channel where issues are posted').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addRoleOption((o) => o.setName('dev_role').setDescription('Role allowed to manage issues').setRequired(true))
    .addRoleOption((o) => o.setName('reporter_role').setDescription('Only this role can create reports (omit to keep the current setting)'))
    .addRoleOption((o) => o.setName('status_role').setDescription('Only this role can change ticket status (omit to keep the current setting)'))
    .addIntegerOption((o) => o.setName('retention_days').setDescription('Delete closed issues after this many days without activity (0 = keep)').setMinValue(0).setMaxValue(3650)),
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
/** Role required to change a ticket's status: the /setup value, else STATUS_ROLE_ID from .env, else any developer. */
const statusRole = (guildId) => settings.get(guildId)?.status_role_id || process.env.STATUS_ROLE_ID || null;

/** When a status role is configured ONLY its members may change status (Manage Server does not bypass it). */
function canSetStatus(i) {
  const role = statusRole(i.guildId);
  return role ? !!i.member?.roles?.cache?.has(role) : isDev(i);
}
const noStatusAccess = (i) => i.reply({
  content: `🔒 Only members with the <@&${statusRole(i.guildId)}> role can change a ticket's status.`,
  allowedMentions: { parse: [] },
  flags: EPH,
});

const noReportAccess = (i) => i.reply({
  content: `🔒 Only members with the <@&${reporterRole(i.guildId)}> role can create reports.`,
  allowedMentions: { parse: [] },
  flags: EPH,
});

const devOnly = (i, what) => i.reply({ content: `🔒 Only developers can ${what}.`, flags: EPH });

async function loadIssue(i, id) {
  const issue = issues.get(id);
  if (!issue || issue.guild_id !== i.guildId) {
    await i.reply({ content: `Issue #${id} no longer exists.`, flags: EPH });
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
const waitMsg = (s) => ({ content: `⏳ Please wait ${s}s before sending another report.`, flags: EPH });

// Reports held while a user decides whether a suggested fix solved their problem.
const pending = new Map();
function stash(data) {
  const key = Math.random().toString(36).slice(2, 10);
  pending.set(key, { ...data, exp: Date.now() + 15 * 60_000 });
  return key;
}
function peek(key) {
  const v = pending.get(key);
  return v && v.exp > Date.now() ? v : null;
}
function take(key) {
  const v = peek(key);
  pending.delete(key);
  return v;
}

// ---------- panel, modals & forms ----------

function panelPayload() {
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('Echo VR – Problem Tracker')
    .setDescription('Something broken? Report it here. Known problems get an instant suggested fix, similar reports are grouped together, and developers update the status as they work on it.');
  return {
    embeds: [embed],
    components: [
      row(btn('report', 'Report a problem', '📝', ButtonStyle.Primary), btn('browse', 'Browse issues', '📋'), btn('mine', 'My reports', '📌'),
        btn('legal:privacy', 'Data & privacy', '🔒'), btn('legal:terms', 'Terms of use', '📜')),
      row(btn('dev:settings', 'Settings', '⚙️'), btn('dev:dups', 'Review duplicates', '🔍'), btn('dev:digest', 'Digest', '📊'),
        btn('dev:export', 'Export CSV', '📤'), btn('dev:backup', 'Back up now', '💾')),
      row(btn('dev:board', 'Post live board', '📌'), btn('dev:articles', 'Knowledge articles', '📚')),
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

const reportModal = (kind = 'bug') => new ModalBuilder().setCustomId(`report:${kind}`)
  .setTitle(kind === 'install' ? 'Report an install issue' : 'Report a bug in the game').addLabelComponents(
    labelled(kind === 'install' ? 'What happened? (device, step, error)' : 'What went wrong? (what, when, how often)',
      lText('text', { style: TextInputStyle.Paragraph, max: 1000, required: true, min: 15 })),
    platformField(), versionField(), ...evidenceFields());

/** First step of reporting: is it an install problem or a bug in the game? */
const reportTypePayload = () => ({
  content: '**What kind of problem is it?**\n🔧 **Install issue** – installing, updating or downloading Echo VR or the installer/launcher\n🐞 **Bug in game** – something goes wrong while playing',
  embeds: [],
  components: [row(btn('rtype:install', 'Install issue', '🔧', ButtonStyle.Primary), btn('rtype:bug', 'Bug in game', '🐞', ButtonStyle.Primary))],
});

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

/** Shows suggestion `idx` of `sugg`; the user can accept it, deny it (next suggestion / file), or file anyway. */
function kbPayload(sugg, idx, key) {
  const s = sugg[idx];
  const e = new EmbedBuilder().setColor(0xfee75c).setTitle(`💡 ${trunc(s.title, 250)}`).setDescription(trunc(s.fix, 4000))
    .setFooter({ text: `Source: ${s.source}${sugg.length > 1 ? ` · suggestion ${idx + 1} of ${sugg.length}` : ''}` });
  return {
    content: 'This looks like a **known problem**. Try this first:',
    embeds: [e],
    components: [row(
      btn(`kbok:${key}`, 'That fixed it', '✅', ButtonStyle.Success),
      btn(`kbno:${key}`, idx + 1 < sugg.length ? 'Not my problem – next' : 'Not my problem', '🙅'),
      btn(`kbfile:${key}`, 'Still happening – file my report', '📝'),
    )],
  };
}

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
    row(menu(`bfs:${f.c}|${f.o}`, 'Filter by status', 'All statuses', f.s,
      Object.entries(STATUSES).map(([value, s]) => ({ label: s.label, emoji: s.emoji, value })))),
    row(menu(`bfc:${f.s}|${f.o}`, 'Filter by category', 'All categories', f.c,
      [...Object.keys(CATEGORIES), 'Other'].map((c) => ({ label: c, value: c })))),
    row(menu(`bfo:${f.s}|${f.c}`, 'Filter by owner', 'Any owner', f.o,
      [{ label: 'Unassigned', value: 'unassigned', emoji: '🙈' }, { label: 'Assigned to me', value: 'me', emoji: '🙌' }])),
  ];
  if (list.length) {
    components.push(row(new StringSelectMenuBuilder().setCustomId('bfv').setPlaceholder('Open an issue…').addOptions(list.slice(0, 25).map(issueOption))));
  }
  const content = list.length
    ? `**${list.length}** issue${list.length === 1 ? '' : 's'} – highest priority and most affected first${list.length > 25 ? ' (showing top 25)' : ''}. Pick one to open it.`
    : 'No issues match these filters.';
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
      '**⚙️ Tracker settings**',
      `Match sensitivity: **${c.threshold}** · Stale after: **${c.stale_days} days** · Report cooldown: **${c.cooldown_sec ? `${c.cooldown_sec}s` : 'off'}**`,
      `Reporter role: ${reporterRole(guildId) ? `<@&${reporterRole(guildId)}>` : '_everyone_'} · Status role: ${statusRole(guildId) ? `<@&${statusRole(guildId)}>` : '_developers_'} (change with \`/setup\`)`,
      `Data retention: ${c.retention_days ? `closed issues deleted after **${c.retention_days} days** without activity` : '**keep** (set with `/setup retention_days:`)'}`,
      `Digest channel: ${c.dev_channel_id ? `<#${c.dev_channel_id}>` : '_not set_'} · Changelog channel: ${c.changelog_channel_id ? `<#${c.changelog_channel_id}>` : '_not set_'}`,
    ].join('\n'),
    embeds: [],
    components: [
      pick('set_thr', 'Duplicate matching sensitivity', [['Strict', 0.35, 'Fewer auto-merges, more separate issues'], ['Balanced', 0.25, 'Recommended'], ['Loose', 0.18, 'Merges more aggressively']], c.threshold),
      pick('set_stale', 'Flag issues with no activity after…', [['3 days', 3], ['7 days', 7], ['14 days', 14], ['30 days', 30]], c.stale_days),
      pick('set_cd', 'Report cooldown per user', [['Off', 0], ['30 seconds', 30], ['1 minute', 60], ['5 minutes', 300]], c.cooldown_sec),
      chanMenu('set_devch', 'Developer channel for the weekly digest', c.dev_channel_id),
      chanMenu('set_logch', 'Public channel for the fixed-issues changelog', c.changelog_channel_id),
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
  if (!pairs.length) return { content: '🎉 No duplicate candidates left to review.', embeds: [], components: [] };
  const p = pairs[0];
  return {
    content: `**Are these the same problem?** Pair 1 of ${pairs.length} · similarity ${Math.round(p.score * 100)}%`,
    embeds: [dupSummary(issues.get(p.a), 'A'), dupSummary(issues.get(p.b), 'B')],
    components: [row(
      btn(`dupm:${p.a}:${p.b}`, 'Merge', '🔀', ButtonStyle.Success),
      btn(`dupk:${p.a}:${p.b}`, 'Keep separate', '↔️'),
      btn(`dups:${p.a}:${p.b}`, 'Skip', '⏭️'),
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
    if (['fixed', 'in_progress', 'wont_fix', 'cannot_reproduce'].includes(status)) {
      const update = status === 'fixed' && fresh.fixed_version ? `\n**Update to \`${fresh.fixed_version}\` or newer to get the fix.**` : '';
      notifyReporters(client, fresh, `${s.emoji} Update on your Echo VR report **#${fresh.id} – ${fresh.title}**: now **${s.label}**.${update}${fresh.dev_note ? `\n> ${fresh.dev_note}` : ''}`).catch(() => {});
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
  const where = fresh.channel_id ? ` in <#${fresh.channel_id}>` : '';
  const content = res.created
    ? `✅ Thanks! Created new ${fresh.kind === 'install' ? '🔧 install issue' : '🐞 bug'} **#${fresh.id}**${where} (${fresh.category}).`
    : `✅ Thanks! This looks like an existing issue, so I added your report to **#${fresh.id} – ${fresh.title}**${where}.` +
      (res.reopened ? '\n⚠️ It was marked fixed, so it has been reopened for the developers.' : '');
  const withEvidence = saved ? `${content}\n📎 ${saved} attachment${saved === 1 ? '' : 's'}/link${saved === 1 ? '' : 's'} saved with the issue.` : content;
  return {
    content: withEvidence, embeds: [],
    components: res.created ? [] : [row(btn(`split:${res.reportId}`, 'Not the same problem', '↩️'))],
  };
}

// ---------- tracking: my reports, editing, timeline ----------

const EVENT_LABEL = {
  created: '🆕 Reported', status: '🔄 Status', priority: '⚑ Priority', owner: '🙌 Owner',
  merged: '🔀 Merged', reopened: '⚠️ Reopened', rematched: '🔁 Re-matched',
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
  const dmRow = row(btn('dm:toggle', dmOff ? 'Turn DMs on' : 'Turn DMs off', dmOff ? '🔔' : '🔕'), btn('legal:privacy', 'Data & privacy', '🔒'));
  if (!list.length) {
    return { content: "You haven't reported or followed anything yet. Use **Report a problem**, or 🔔 **Follow** on any issue.", embeds: [], components: [dmRow] };
  }
  return {
    content: `**Your reports & followed issues** (${list.length}) – pick one to see its progress, edit your report or re-check its match.\nProgress DMs: **${dmOff ? 'off' : 'on'}**.`,
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
      { name: 'Developer', value: issue.owner_id ? `<@${issue.owner_id}> is on it` : '_not assigned yet_', inline: true },
      { name: 'Affected players', value: String(stats.users), inline: true },
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
    rows.push(row(btn(`edit:${mine.id}`, 'Edit report', '✏️'), btn(`rematch:${mine.id}`, 'Recalculate match', '🔄'),
      btn(`addevr:${mine.id}`, 'Add evidence', '📎'), btn(`wd:${mine.id}`, 'Withdraw', '🗑️')));
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
      { name: 'Results', value: `Shown ${s.shown} · ✅ helped ${s.helped} · 🙅 denied ${s.denied} · 📝 filed anyway ${s.filed}` },
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
  components.push(row(btn('art:new', 'New article', '➕', ButtonStyle.Success), btn('art:stats', 'Results', '📊'), btn('art:test', 'Test matching', '🧪')));
  return {
    content: `**📚 Knowledge articles** – ${list.length} of your own · ${KB.length} built-in.\nBefore a report is filed, players are shown the best-matching answers (typo tolerant). They can say **Not my problem** to see the next one or file anyway, and the results below show which articles actually help.`,
    embeds: [], components,
  };
}

function articleStats(guildId) {
  const title = (id) => (id.startsWith('kb:') ? KB.find((e) => `kb:${e.id}` === id)?.title : articles.get(Number(id.slice(2)))?.title) ?? '(deleted)';
  const rows = kbStats.forGuild(guildId).filter((s) => s.shown > 0).slice(0, 15);
  const lines = rows.map((s) => {
    const flag = s.denied >= 3 && s.denied > s.helped ? ' ⚠️ often denied' : '';
    return `**${trunc(title(s.article_id), 60)}** — shown ${s.shown} · ✅ ${s.helped} · 🙅 ${s.denied} · 📝 ${s.filed}${flag}`;
  });
  return {
    content: '', components: [row(btn('art:back', 'Back', '⬅️'))],
    embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📊 How suggestions are doing')
      .setDescription(lines.join('\n') || '_Nothing has been suggested yet._')
      .setFooter({ text: '✅ helped = "That fixed it" · 🙅 denied = "Not my problem" · 📝 = filed a report anyway' })],
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
      settings.set(i.guildId, ch.id, role.id);
      const reporter = i.options.getRole('reporter_role');
      if (reporter) settings.update(i.guildId, { reporter_role_id: reporter.id });
      const statusR = i.options.getRole('status_role');
      if (statusR) settings.update(i.guildId, { status_role_id: statusR.id });
      const retention = i.options.getInteger('retention_days');
      if (retention !== null) settings.update(i.guildId, { retention_days: retention });
      await i.channel.send(panelPayload());
      const rr = reporterRole(i.guildId);
      return i.reply({ content: `✅ Issues will be posted in <#${ch.id}>. Developers: <@&${role.id}> (and anyone with Manage Server). Reports can be created by: ${rr ? `<@&${rr}>` : 'everyone'}. Status can be changed by: ${statusRole(i.guildId) ? `<@&${statusRole(i.guildId)}>` : 'developers'}. Use the ⚙️ **Settings** button on the panel for the digest/changelog channels, matching sensitivity and cooldown.`, flags: EPH });
    }

    // ----- reporting -----
    if (i.isButton() && id === 'report') {
      if (!settings.get(i.guildId)) return i.reply({ content: 'An admin must run `/setup` first.', flags: EPH });
      if (!canReport(i)) return noReportAccess(i);
      const wait = cooldownLeft(i);
      return wait ? i.reply(waitMsg(wait)) : i.reply({ ...reportTypePayload(), flags: EPH });
    }
    if (i.isButton() && (id === 'rtype:install' || id === 'rtype:bug')) {
      if (!canReport(i)) return noReportAccess(i);
      const wait = cooldownLeft(i);
      return wait ? i.reply(waitMsg(wait)) : i.showModal(reportModal(id.slice(6)));
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
      // Suggest known fixes (built-in + the developers' knowledge articles) before filing anything.
      const sugg = suggest(`${data.text} ${data.platform}`, articles.list(i.guildId, { enabledOnly: true }), 3, data.kind);
      if (sugg.length) {
        const key = stash({ ...data, sugg, idx: 0 });
        kbStats.bump(i.guildId, sugg[0].id, 'shown');
        return i.reply({ ...kbPayload(sugg, 0, key), flags: EPH });
      }
      await i.deferReply({ flags: EPH }); // re-hosting files can take longer than Discord's 3s limit
      return i.editReply(await submitReport(i, data));
    }
    if (i.isButton() && id.startsWith('kbok:')) {
      const d = take(id.slice(5));
      if (d) kbStats.bump(i.guildId, d.sugg[d.idx].id, 'helped');
      return i.update({ content: 'Glad that helped! 🎉 No report was filed.', embeds: [], components: [] });
    }
    // The user denies the suggestion: show the next one, or file the report if there are no more.
    if (i.isButton() && id.startsWith('kbno:')) {
      const key = id.slice(5);
      const d = peek(key);
      if (!d) return i.update({ content: 'That took too long – please press **Report a problem** again.', embeds: [], components: [] });
      kbStats.bump(i.guildId, d.sugg[d.idx].id, 'denied');
      if (d.idx + 1 < d.sugg.length) {
        d.idx += 1;
        kbStats.bump(i.guildId, d.sugg[d.idx].id, 'shown');
        return i.update(kbPayload(d.sugg, d.idx, key));
      }
      take(key);
      if (!canReport(i)) return noReportAccess(i);
      const wait = cooldownLeft(i);
      if (wait) return i.update({ content: `⏳ Please wait ${wait}s before sending another report.`, embeds: [], components: [] });
      await i.deferUpdate();
      return i.editReply(await submitReport(i, d));
    }
    if (i.isButton() && id.startsWith('kbfile:')) {
      if (!canReport(i)) return noReportAccess(i);
      const data = take(id.slice(7));
      if (!data) return i.update({ content: 'That took too long – please press **Report a problem** again.', embeds: [], components: [] });
      kbStats.bump(i.guildId, data.sugg[data.idx].id, 'filed');
      const wait = cooldownLeft(i);
      if (wait) return i.update({ content: `⏳ Please wait ${wait}s before sending another report.`, embeds: [], components: [] });
      await i.deferUpdate();
      return i.editReply(await submitReport(i, data));
    }
    if (i.isButton() && id.startsWith('split:')) {
      const report = reports.get(idOf(i));
      if (!report || report.user_id !== i.user.id) return i.reply({ content: 'That is not your report.', flags: EPH });
      const res = splitReport(report.id);
      if (res.old) await syncMessage(client, res.old, trackerChannel(i));
      else await removeMessage(client, res.emptiedIssue);
      await syncMessage(client, res.fresh, trackerChannel(i));
      return i.update({ content: `✅ Understood — filed as separate issue **#${res.fresh.id}**.`, components: [] });
    }

    // ----- browsing -----
    if (i.isButton() && id === 'browse') return i.reply({ ...browsePayload(i, { s: NONE, c: NONE, o: NONE }), flags: EPH });
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
      return issue && i.reply({ ...renderIssue(issue), flags: EPH });
    }

    // ----- issue message: status / priority / owner -----
    if (i.isStringSelectMenu() && id.startsWith('status:')) {
      if (!canSetStatus(i)) return noStatusAccess(i);
      const issue = await loadIssue(i, idOf(i));
      if (!issue) return;
      const status = i.values[0];
      if (status === 'fixed' && issue.status !== 'fixed') return i.showModal(fixedModal(issue));
      return i.update(renderIssue(await applyStatus(i, issue, status)));
    }
    if (i.isModalSubmit() && id.startsWith('fixed:')) {
      if (!canSetStatus(i)) return noStatusAccess(i);
      const issue = await loadIssue(i, idOf(i));
      if (!issue) return;
      const fresh = await applyStatus(i, issue, 'fixed', {
        version: i.fields.getTextInputValue('version').trim(),
        note: i.fields.getTextInputValue('text').trim(),
      });
      return i.isFromMessage() ? i.update(renderIssue(fresh)) : i.reply({ content: `Marked #${issue.id} fixed.`, flags: EPH });
    }
    if (i.isStringSelectMenu() && id.startsWith('prio:')) {
      if (!isDev(i)) return devOnly(i, 'change priority');
      const issue = await loadIssue(i, idOf(i));
      if (!issue) return;
      issues.setPriority(issue.id, i.values[0], i.user.id);
      events.add(issue.id, 'priority', i.user.id, `${PRIORITIES[issue.priority]?.label} → ${PRIORITIES[i.values[0]]?.label}`);
      await syncMessage(client, issues.get(issue.id), trackerChannel(i));
      return i.update(renderIssue(issues.get(issue.id)));
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
      return i.update(renderIssue(issues.get(issue.id)));
    }

    // ----- issue message: I have this too -----
    if (i.isButton() && id.startsWith('plus:')) {
      const issue = await loadIssue(i, idOf(i));
      if (!issue) return;
      if (!canReport(i)) return noReportAccess(i);
      if (reports.hasUser(issue.id, i.user.id)) return i.reply({ content: 'You already reported this one. 👍', flags: EPH });
      const wait = cooldownLeft(i);
      return wait ? i.reply(waitMsg(wait)) : i.showModal(meTooModal(issue));
    }
    if (i.isModalSubmit() && id.startsWith('plus:')) {
      if (!canReport(i)) return noReportAccess(i);
      const issue = await loadIssue(i, idOf(i));
      if (!issue) return;
      if (reports.hasUser(issue.id, i.user.id)) return i.reply({ content: 'You already reported this one. 👍', flags: EPH });
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
      return i.editReply({ content: `✅ Added your report to **#${issue.id}**.${saved ? ` 📎 ${saved} attachment${saved === 1 ? '' : 's'}/link${saved === 1 ? '' : 's'} saved.` : ''}` });
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
      if (!others.length) return i.reply({ content: 'There are no other issues to merge into.', flags: EPH });
      return i.reply({
        content: `Merge **#${issue.id} – ${trunc(issue.title, 80)}** into which issue? (Its reports move over; its thread is locked.)`,
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
      if (reports.hasUser(issue.id, i.user.id)) return i.reply({ content: 'You reported this one, so you already get its updates. 🔔', flags: EPH });
      if (watchers.has(issue.id, i.user.id)) {
        watchers.remove(issue.id, i.user.id);
        return i.reply({ content: `🔕 You no longer follow **#${issue.id}**.`, flags: EPH });
      }
      watchers.add(issue.id, i.user.id);
      return i.reply({ content: `🔔 You'll get a DM when **#${issue.id}** changes. Everything you follow is under **My reports**.`, flags: EPH });
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
      if (!mine) return i.reply({ content: "You haven't reported this issue yet – use **I have this too** to add your report.", flags: EPH });
      return i.showModal(id.startsWith('editmine:') ? editModal(mine) : addEvidenceModal(mine));
    }
    if (i.isButton() && (id.startsWith('edit:') || id.startsWith('addevr:'))) {
      const report = reports.get(idOf(i));
      if (!report || report.user_id !== i.user.id) return i.reply({ content: 'That is not your report.', flags: EPH });
      if (!canReport(i)) return noReportAccess(i);
      return i.showModal(id.startsWith('edit:') ? editModal(report) : addEvidenceModal(report));
    }
    if (i.isModalSubmit() && (id.startsWith('edit:') || id.startsWith('addevr:'))) {
      const report = reports.get(idOf(i));
      if (!report || report.user_id !== i.user.id) return i.reply({ content: 'That is not your report.', flags: EPH });
      if (!canReport(i)) return noReportAccess(i);
      await i.deferReply({ flags: EPH });
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
        content: `✅ ${editing ? `Report updated${added}.` : saved ? `Saved ${saved} attachment${saved === 1 ? '' : 's'}/link${saved === 1 ? '' : 's'}.` : 'Nothing new to add.'}\nDoes the new information change what the problem is? Re-check which issue it belongs to:`,
        components: [row(btn(`rematch:${report.id}`, 'Recalculate match', '🔄', ButtonStyle.Primary), btn(`trk:${issue.id}`, 'View progress', '📌'))],
      });
    }
    if (i.isButton() && id.startsWith('rematch:')) {
      const report = reports.get(idOf(i));
      if (!report || report.user_id !== i.user.id) return i.reply({ content: 'That is not your report.', flags: EPH });
      const res = rematchReport(report.id, i.user.id, cfgOf(i.guildId).threshold);
      if (res.action === 'same') {
        return i.update({
          content: `🔄 Checked again – your report still fits **#${res.to.id} – ${trunc(res.to.title, 80)}** best. No change.`,
          embeds: [], components: [row(btn(`trk:${res.to.id}`, 'View progress', '📌'))],
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
          ? `🔁 With the new details your report fits **#${res.to.id} – ${trunc(res.to.title, 80)}** better, so it was moved there.`
          : `✂️ The new details no longer match **#${res.from.id}**, so your report was filed as its own issue **#${res.to.id}**.`) +
          (res.reopened ? '\n⚠️ That issue was marked fixed, so it has been reopened.' : ''),
        embeds: [], components: [row(btn(`trk:${res.to.id}`, 'View progress', '📌'))],
      });
    }
    if (i.isButton() && id.startsWith('wd:')) {
      const report = reports.get(idOf(i));
      if (!report || report.user_id !== i.user.id) return i.reply({ content: 'That is not your report.', flags: EPH });
      const issue = issues.get(report.issue_id);
      const last = reports.stats(issue.id).total === 1;
      if (last && (issue.status !== 'new' || issue.owner_id || issue.dev_note)) {
        return i.reply({ content: `Developers are already working on **#${issue.id}** and yours is its only report, so it can't be withdrawn. Ask a developer to close it if it no longer applies.`, flags: EPH });
      }
      return i.update({
        content: `Withdraw your report from **#${issue.id} – ${trunc(issue.title, 80)}**?${last ? ' It is the only report, so the issue will be removed.' : ' The issue stays open for the other reporters.'}`,
        embeds: [],
        components: [row(btn(`wdok:${report.id}`, 'Yes, withdraw', '🗑️', ButtonStyle.Danger), btn(`trk:${issue.id}`, 'Keep it', '↩️'))],
      });
    }
    if (i.isButton() && id.startsWith('wdok:')) {
      const report = reports.get(idOf(i));
      if (!report || report.user_id !== i.user.id) return i.reply({ content: 'That is not your report.', flags: EPH });
      const { issueDeleted } = await dropReport(i, issues.get(report.issue_id), report);
      return i.update({ content: issueDeleted ? '🗑️ Withdrawn. It was the only report, so the issue was removed.' : '🗑️ Withdrawn.', embeds: [], components: [] });
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
        return i.reply({
          content: found.length
            ? `**Players writing that would be shown, in order:**\n${found.map((s, n) => `${n + 1}. ${s.custom ? '📚' : '💡'} **${trunc(s.title, 80)}** — ${Math.round(s.score * 100)}% match`).join('\n')}`
            : 'No suggestion would be shown for that text – the report would be filed straight away.',
          flags: EPH,
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
        return i.reply({ ...articleView(a), flags: EPH });
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
    if (i.isButton() && id === 'board:refresh') return i.update(boardPayload(i.guildId));
    if (i.isButton() && id === 'board:mine') {
      const payload = boardPayload(i.guildId, { owner: i.user.id, title: '🙌 Your cards' });
      return i.message?.flags?.has(MessageFlags.Ephemeral) ? i.update(payload) : i.reply({ ...payload, flags: EPH });
    }

    // ----- developer tools on the panel -----
    if (i.isButton() && id.startsWith('dev:')) {
      if (!isDev(i)) return devOnly(i, 'use these tools');
      switch (id) {
        case 'dev:settings': return i.reply({ ...settingsPayload(i.guildId), flags: EPH });
        case 'dev:dups': return i.reply({ ...dupPayload(i), flags: EPH });
        case 'dev:articles': return i.reply({ ...articlesPayload(i.guildId), flags: EPH });
        case 'dev:board': {
          await postBoard(client, i.guildId, i.channel);
          return i.reply({ content: '📌 Live board posted here. It updates by itself whenever an issue changes. Tip: post it in a developers-only channel.', flags: EPH });
        }
        case 'dev:export': {
          const files = exportCsv(i.guildId);
          return i.reply({
            content: '📤 Export (contains user IDs – keep it private).',
            files: [new AttachmentBuilder(files.issues, { name: 'issues.csv' }), new AttachmentBuilder(files.reports, { name: 'reports.csv' })],
            flags: EPH,
          });
        }
        case 'dev:backup': {
          await i.deferReply({ flags: EPH });
          return i.editReply(`💾 Database backed up to \`${backupNow()}\` (the newest 14 are kept; backups also run daily).`);
        }
        case 'dev:digest': {
          if (cfgOf(i.guildId).dev_channel_id) {
            await postDigest(client, i.guildId);
            return i.reply({ content: `📊 Digest posted in <#${cfgOf(i.guildId).dev_channel_id}>.`, flags: EPH });
          }
          return i.reply({ content: 'Tip: set a digest channel in ⚙️ Settings to get this weekly.', embeds: [buildDigest(i.guildId, cfgOf(i.guildId).stale_days)], flags: EPH });
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
    const reply = { content: 'Something went wrong. Please try again.', flags: EPH };
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
    for (const [k, v] of pending) if (v.exp < Date.now()) pending.delete(k);
  };
  setTimeout(tick, 30_000);
  setInterval(tick, 3_600_000);
});

if (!process.env.DISCORD_TOKEN) {
  console.error('Set DISCORD_TOKEN (copy .env.example to .env, then run: npm start)');
  process.exit(1);
}
client.login(process.env.DISCORD_TOKEN);
