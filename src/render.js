import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder,
} from 'discord.js';
import { evidence, issues, prefs, reports, watchers } from './db.js';
import { relatedIssues } from './related.js';
import { trunc } from './text.js';

export const STATUSES = {
  new:               { label: 'New',                emoji: '🆕', color: 0x95a5a6 },
  seen:              { label: 'Seen',               emoji: '👀', color: 0x3498db },
  in_progress:       { label: 'Being fixed',        emoji: '🛠️', color: 0xf39c12 },
  fixed:             { label: 'Fixed',              emoji: '✅', color: 0x2ecc71 },
  cannot_reproduce:  { label: "Can't reproduce",    emoji: '❓', color: 0x9b59b6 },
  wont_fix:          { label: "Won't fix",          emoji: '🚫', color: 0xe74c3c },
};

export const PRIORITIES = {
  critical: { label: 'Critical', emoji: '🔴' },
  high:     { label: 'High',     emoji: '🟠' },
  normal:   { label: 'Normal',   emoji: '🟡' },
  low:      { label: 'Low',      emoji: '🟢' },
};


/** A person on a card: their name when known (a raw <@id> shows as a number to anyone whose client hasn't seen them), else a mention. */
export function person(id) {
  const n = prefs.name(id)?.replace(/[\*_~`>|<@#:\[\]()]/g, '').trim();
  return n ? `**${trunc(n, 32)}**` : `<@${id}>`;
}

/** The "requester" = whoever sent the first report; others who hit the same problem are counted. */
function requesterText(issueId, stats) {
  const first = reports.earliest(issueId);
  const who = !first ? '_unknown_' : first.user_id === '0' ? '_removed user_' : person(first.user_id);
  const others = Math.max(0, stats.users - 1);
  return others ? `${who} + ${others} other${others === 1 ? '' : 's'}` : who;
}

/**
 * `back`: custom id of a button to add that returns to the menu this card was opened from (hidden views only).
 * `viewer`: { dev, report, article, userId } – when given, controls the viewer can't use are left out. Without it
 * (the shared card of an older issue, which everyone sees) every control is shown and the click is checked instead.
 */
export function renderIssue(issue, { back, viewer } = {}) {
  const may = (k) => !viewer || !!viewer[k];
  const st = STATUSES[issue.status] ?? STATUSES.new;
  const pr = PRIORITIES[issue.priority] ?? PRIORITIES.normal;
  const stats = reports.stats(issue.id);
  const latest = reports.forIssue(issue.id).slice(0, 3);  const versions = reports.versions(issue.id);

  const embed = new EmbedBuilder()
    .setTitle(trunc(`${pr.emoji} #${issue.id} · ${issue.title}`, 256))
    .setColor(st.color)
    .addFields(
      { name: 'Status', value: `${st.emoji} ${st.label}${issue.status === 'fixed' && issue.fixed_version ? ` in \`${issue.fixed_version}\`` : ''}`, inline: true },
      { name: 'Priority', value: `${pr.emoji} ${pr.label}`, inline: true },
      { name: 'Type', value: issue.kind === 'install' ? '🔧 Install issue' : '🐞 Bug in game', inline: true },
      { name: 'Category', value: issue.category, inline: true },
      { name: 'Requested by', value: requesterText(issue.id, stats), inline: true },
      { name: "Who's on it", value: issue.owner_id ? person(issue.owner_id) : '_Nobody yet_', inline: true },
      { name: 'Players affected', value: `${stats.users} (${stats.total} report${stats.total === 1 ? '' : 's'})`, inline: true },
    )
    .setTimestamp(issue.updated_at);

  if (versions.length) embed.addFields({ name: 'Game versions', value: trunc(versions.map((v) => `\`${v}\``).join(', '), 300), inline: true });

  if (latest.length) {
    // One field per report so each can show (nearly) its full text instead of a short preview.
    latest.forEach((r, n) => {
      const meta = [r.platform, r.version].filter(Boolean).map((x) => trunc(x, 30)).join(' · ');
      const who = `${r.user_id === '0' ? '_removed user_' : person(r.user_id)}${meta ? ` _(${meta})_` : ''}${r.edited_at ? ' ✏️' : ''}`;
      embed.addFields({
        name: n === 0 ? 'Latest reports' : '​',
        value: `• ${who}:\n${trunc(r.text.trim(), 1024 - who.length - 4)}`,
        inline: false,
      });
    });
  }
  // Attachments are private: this public card only says how many there are, never what or where they are.
  const ev = evidence.forIssue(issue.id);
  if (ev.length) {
    embed.addFields({ name: '📎 Screenshots, logs & links', value: `${ev.length} attached – only the requester (whoever sent them) and the developers can open them.`, inline: false });
  }
  const related = relatedIssues(issue).map((r) => issues.get(r.id)).filter(Boolean);
  if (related.length) {
    embed.addFields({
      name: '🔗 Possibly related',
      value: trunc(related.map((r) => `• **#${r.id}** ${trunc(r.title, 60)} (${(STATUSES[r.status] ?? STATUSES.new).label})`).join('\n'), 600),
    });
  }
  if (issue.dev_note) embed.addFields({ name: '💬 Developer note', value: trunc(issue.dev_note, 1024) });
  if (issue.handled_by) embed.setFooter({ text: 'Last updated by a developer' });

  const statusMenu = new StringSelectMenuBuilder().setCustomId(`status:${issue.id}`).setPlaceholder('Change status (developers only)')
    .addOptions(Object.entries(STATUSES).map(([value, s]) => ({ label: s.label, value, emoji: s.emoji, default: value === issue.status })));
  const prioMenu = new StringSelectMenuBuilder().setCustomId(`prio:${issue.id}`).setPlaceholder('Change priority (developers only)')
    .addOptions(Object.entries(PRIORITIES).map(([value, p]) => ({ label: p.label, value, emoji: p.emoji, default: value === issue.priority })));

  const btn = (id, label, emoji) => new ButtonBuilder().setCustomId(`${id}:${issue.id}`).setLabel(label).setEmoji(emoji).setStyle(ButtonStyle.Secondary);
  const mine = !viewer || reports.forIssue(issue.id).some((r) => r.user_id === viewer.userId);
  const rows = [
    ...(may('dev') ? [new ActionRowBuilder().addComponents(statusMenu), new ActionRowBuilder().addComponents(prioMenu)] : []),
    [
      may('report') && btn('plus', 'I have this too', '🙋'),
      may('dev') && btn('assign', 'Assign to me', '🙌'),
      may('dev') && btn('note', 'Developer note', '💬'),
      may('dev') && btn('merge', 'Merge into…', '🔀'),
      may('dev') && btn('rmrep', 'Remove a report', '🗑️'),
    ],
    [
      btn('follow', 'Follow', '🔔'),
      may('report') && mine && btn('editmine', 'Edit my report', '✏️'),
      may('report') && (mine || watchers.has(issue.id, viewer.userId)) && btn('addev', 'Add screenshots / logs', '📎'), // your own issues, or ones you follow
      btn('history', 'History', '📜'),
      (may('dev') || may('article')) && btn('mkart', 'Make knowledge article', '📚'),
    ],
    // Last row: open the private attachments (the bot only shows them to the reporter and developers), plus Back in menus.
    [
      (!viewer || viewer.dev || ev.some((e) => e.user_id === viewer.userId)) && btn('evall', 'View attachments', '📎'), // others' attachments are private
      back && new ButtonBuilder().setCustomId(back).setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
    ],
  ].map((r) => (Array.isArray(r) ? r.filter(Boolean) : r)).filter((r) => (r.components ? r.components.length : r.length))
    .map((r) => (r.components ? r : new ActionRowBuilder().addComponents(r)));

  return {
    embeds: [embed],
    components: rows,
  };
}
