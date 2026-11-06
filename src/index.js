import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, Client,
  EmbedBuilder, GatewayIntentBits, MessageFlags, ModalBuilder, PermissionFlagsBits, SlashCommandBuilder,
  StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { decisions, issues, reports, settings } from './db.js';
import { CATEGORIES } from './categories.js';
import { PRIORITIES, STATUSES, renderIssue } from './render.js';
import { relatedIssues } from './related.js';
import {
  duplicatePairs, fileReport, mergeIssues, notifyReporters, postChangelog, removeMessage, retireMessage,
  splitReport, syncMessage, threadSay,
} from './service.js';
import { matchKb } from './kb.js';
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
    .addRoleOption((o) => o.setName('status_role').setDescription('Only this role can change ticket status (omit to keep the current setting)')),
].map((c) => c.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ---------- helpers ----------

const cfgOf = (guildId) => ({ threshold: 0.25, stale_days: 7, cooldown_sec: 60, ...settings.get(guildId) });
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
function take(key) {
  const v = pending.get(key);
  pending.delete(key);
  return v && v.exp > Date.now() ? v : null;
}

// ---------- panel, modals & forms ----------

function panelPayload() {
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('Echo VR – Problem Tracker')
    .setDescription('Something broken? Report it here. Known problems get an instant suggested fix, similar reports are grouped together, and developers update the status as they work on it.');
  return {
    embeds: [embed],
    components: [
      row(btn('report', 'Report a problem', '📝', ButtonStyle.Primary), btn('browse', 'Browse issues', '📋')),
      row(btn('dev:settings', 'Settings', '⚙️'), btn('dev:dups', 'Review duplicates', '🔍'), btn('dev:digest', 'Digest', '📊'),
        btn('dev:export', 'Export CSV', '📤'), btn('dev:backup', 'Back up now', '💾')),
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
const platformInput = () => input('platform', 'Headset / platform (optional)', { max: 60, placeholder: 'e.g. Quest 3 via Link, Rift S, Index' });
const versionInput = () => input('version', 'Game / launcher version (optional)', { max: 40, placeholder: 'e.g. 0.13.14' });

const reportModal = () => new ModalBuilder().setCustomId('report').setTitle('Report an Echo VR problem').addComponents(
  input('text', 'What went wrong? (what, when, how often)', { style: TextInputStyle.Paragraph, max: 1000, required: true, min: 15 }),
  platformInput(), versionInput());

const meTooModal = (issue) => new ModalBuilder().setCustomId(`plus:${issue.id}`).setTitle(`I have this too · #${issue.id}`).addComponents(
  input('text', 'Anything to add? (optional)', { style: TextInputStyle.Paragraph, max: 1000 }), platformInput(), versionInput());

const noteModal = (issue) => new ModalBuilder().setCustomId(`note:${issue.id}`).setTitle(`Developer note · #${issue.id}`).addComponents(
  input('text', 'Note shown on the issue (empty clears it)', { style: TextInputStyle.Paragraph, max: 900, value: issue.dev_note }));

const fixedModal = (issue) => new ModalBuilder().setCustomId(`fixed:${issue.id}`).setTitle(`Mark fixed · #${issue.id}`).addComponents(
  input('version', 'Fixed in version (optional)', { max: 40, placeholder: 'e.g. 0.13.15', value: issue.fixed_version }),
  input('text', 'Note for players (optional)', { style: TextInputStyle.Paragraph, max: 900, value: issue.dev_note }));

function kbPayload(kb, key) {
  const e = new EmbedBuilder().setColor(0xfee75c).setTitle(`💡 ${kb.entry.title}`).setDescription(kb.entry.fix)
    .setFooter({ text: `Source: ${kb.entry.source}` });
  return {
    content: 'This looks like a **known problem**. Try this first:',
    embeds: [e],
    components: [row(btn(`kbok:${key}`, 'That fixed it', '✅', ButtonStyle.Success), btn(`kbfile:${key}`, 'Still happening – file my report', '📝'))],
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
    await threadSay(client, fresh, `${s.emoji} <@${i.user.id}> set the status to **${s.label}**${ver}.`);
    if (['fixed', 'in_progress', 'wont_fix', 'cannot_reproduce'].includes(status)) {
      const update = status === 'fixed' && fresh.fixed_version ? `\n**Update to \`${fresh.fixed_version}\` or newer to get the fix.**` : '';
      notifyReporters(client, fresh, `${s.emoji} Update on your Echo VR report **#${fresh.id} – ${fresh.title}**: now **${s.label}**.${update}${fresh.dev_note ? `\n> ${fresh.dev_note}` : ''}`).catch(() => {});
    }
    if (status === 'fixed') await postChangelog(client, fresh, cfgOf(i.guildId).changelog_channel_id);
  }
  return fresh;
}

async function submitReport(i, { text, platform, version }) {
  const cfg = cfgOf(i.guildId);
  const res = fileReport({ guildId: i.guildId, userId: i.user.id, text, platform, version, threshold: cfg.threshold });
  await syncMessage(client, res.issue, cfg.channel_id);
  if (res.reopened) {
    await threadSay(client, res.issue, `⚠️ Reopened by a new report${res.fixedVersion ? ` (it was fixed in \`${res.fixedVersion}\`${version ? `; reporter is on \`${version}\`` : ''})` : ''}.`);
  }
  const fresh = issues.get(res.issue.id);
  const where = fresh.channel_id ? ` in <#${fresh.channel_id}>` : '';
  const content = res.created
    ? `✅ Thanks! Created new issue **#${fresh.id}**${where} (${fresh.category}).`
    : `✅ Thanks! This looks like an existing issue, so I added your report to **#${fresh.id} – ${fresh.title}**${where}.` +
      (res.reopened ? '\n⚠️ It was marked fixed, so it has been reopened for the developers.' : '');
  return {
    content, embeds: [],
    components: res.created ? [] : [row(btn(`split:${res.reportId}`, 'Not the same problem', '↩️'))],
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
      await i.channel.send(panelPayload());
      const rr = reporterRole(i.guildId);
      return i.reply({ content: `✅ Issues will be posted in <#${ch.id}>. Developers: <@&${role.id}> (and anyone with Manage Server). Reports can be created by: ${rr ? `<@&${rr}>` : 'everyone'}. Status can be changed by: ${statusRole(i.guildId) ? `<@&${statusRole(i.guildId)}>` : 'developers'}. Use the ⚙️ **Settings** button on the panel for the digest/changelog channels, matching sensitivity and cooldown.`, flags: EPH });
    }

    // ----- reporting -----
    if (i.isButton() && id === 'report') {
      if (!settings.get(i.guildId)) return i.reply({ content: 'An admin must run `/setup` first.', flags: EPH });
      if (!canReport(i)) return noReportAccess(i);
      const wait = cooldownLeft(i);
      return wait ? i.reply(waitMsg(wait)) : i.showModal(reportModal());
    }
    if (i.isModalSubmit() && id === 'report') {
      if (!canReport(i)) return noReportAccess(i);
      const data = {
        text: i.fields.getTextInputValue('text').trim(),
        platform: i.fields.getTextInputValue('platform').trim(),
        version: i.fields.getTextInputValue('version').trim(),
      };
      const wait = cooldownLeft(i);
      if (wait) return i.reply(waitMsg(wait));
      const kb = matchKb(`${data.text} ${data.platform}`);
      if (kb) return i.reply({ ...kbPayload(kb, stash(data)), flags: EPH });
      return i.reply({ ...(await submitReport(i, data)), flags: EPH });
    }
    if (i.isButton() && id.startsWith('kbok:')) {
      take(id.slice(5));
      return i.update({ content: 'Glad that helped! 🎉 No report was filed.', embeds: [], components: [] });
    }
    if (i.isButton() && id.startsWith('kbfile:')) {
      if (!canReport(i)) return noReportAccess(i);
      const data = take(id.slice(7));
      if (!data) return i.update({ content: 'That took too long – please press **Report a problem** again.', embeds: [], components: [] });
      const wait = cooldownLeft(i);
      if (wait) return i.update({ content: `⏳ Please wait ${wait}s before sending another report.`, embeds: [], components: [] });
      return i.update(await submitReport(i, data));
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
      await syncMessage(client, issues.get(issue.id), trackerChannel(i));
      return i.update(renderIssue(issues.get(issue.id)));
    }
    if (i.isButton() && id.startsWith('assign:')) {
      if (!isDev(i)) return devOnly(i, 'take issues');
      const issue = await loadIssue(i, idOf(i));
      if (!issue) return;
      const mine = issue.owner_id === i.user.id;
      issues.setOwner(issue.id, mine ? null : i.user.id);
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
      const version = i.fields.getTextInputValue('version').trim();
      reports.add(issue.id, i.user.id, i.fields.getTextInputValue('text').trim() || '(me too)', i.fields.getTextInputValue('platform').trim(), version);
      if (issue.status === 'fixed') {
        issues.setStatus(issue.id, 'new', null);
        await threadSay(client, issue, `⚠️ Reopened by another report${issue.fixed_version ? ` (it was fixed in \`${issue.fixed_version}\`${version ? `; reporter is on \`${version}\`` : ''})` : ''}.`);
      } else issues.touch(issue.id);
      await syncMessage(client, issues.get(issue.id), trackerChannel(i));
      return i.reply({ content: `✅ Added your report to **#${issue.id}**.`, flags: EPH });
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
      reports.delete(report.id);
      if (reports.stats(issue.id).total === 0) {
        issues.delete(issue.id);
        await removeMessage(client, issue);
        return i.update({ content: `🗑️ Removed the report. #${issue.id} had no reports left, so the issue was deleted too.`, components: [] });
      }
      await syncMessage(client, issues.get(issue.id), trackerChannel(i));
      return i.update({ content: `🗑️ Removed report #${report.id} from #${issue.id}.`, components: [] });
    }

    // ----- developer tools on the panel -----
    if (i.isButton() && id.startsWith('dev:')) {
      if (!isDev(i)) return devOnly(i, 'use these tools');
      switch (id) {
        case 'dev:settings': return i.reply({ ...settingsPayload(i.guildId), flags: EPH });
        case 'dev:dups': return i.reply({ ...dupPayload(i), flags: EPH });
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
