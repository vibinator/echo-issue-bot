import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder,
} from 'discord.js';
import { issues, reports } from './db.js';
import { relatedIssues } from './related.js';

export const STATUSES = {
  new:               { label: 'New',                emoji: '🆕', color: 0x95a5a6 },
  seen:              { label: 'Seen',               emoji: '👀', color: 0x3498db },
  in_progress:       { label: 'Fix in progress',    emoji: '🛠️', color: 0xf39c12 },
  fixed:             { label: 'Fixed',              emoji: '✅', color: 0x2ecc71 },
  cannot_reproduce:  { label: 'Cannot reproduce',   emoji: '❓', color: 0x9b59b6 },
  wont_fix:          { label: "Won't fix",          emoji: '🚫', color: 0xe74c3c },
};

export const PRIORITIES = {
  critical: { label: 'Critical', emoji: '🔴' },
  high:     { label: 'High',     emoji: '🟠' },
  normal:   { label: 'Normal',   emoji: '🟡' },
  low:      { label: 'Low',      emoji: '🟢' },
};

const trunc = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function renderIssue(issue) {
  const st = STATUSES[issue.status] ?? STATUSES.new;
  const pr = PRIORITIES[issue.priority] ?? PRIORITIES.normal;
  const stats = reports.stats(issue.id);
  const latest = reports.forIssue(issue.id).slice(0, 3);
  const versions = reports.versions(issue.id);

  const embed = new EmbedBuilder()
    .setTitle(trunc(`${pr.emoji} #${issue.id} · ${issue.title}`, 256))
    .setColor(st.color)
    .addFields(
      { name: 'Status', value: `${st.emoji} ${st.label}${issue.status === 'fixed' && issue.fixed_version ? ` in \`${issue.fixed_version}\`` : ''}`, inline: true },
      { name: 'Priority', value: `${pr.emoji} ${pr.label}`, inline: true },
      { name: 'Category', value: issue.category, inline: true },
      { name: 'Owner', value: issue.owner_id ? `<@${issue.owner_id}>` : '_Unassigned_', inline: true },
      { name: 'Affected players', value: `${stats.users} (${stats.total} report${stats.total === 1 ? '' : 's'})`, inline: true },
    )
    .setTimestamp(issue.updated_at);

  if (versions.length) embed.addFields({ name: 'Reported on', value: trunc(versions.map((v) => `\`${v}\``).join(', '), 1024), inline: true });

  if (latest.length) {
    embed.addFields({
      name: 'Latest reports',
      value: trunc(latest.map((r) => {
        const meta = [r.platform, r.version].filter(Boolean).map((x) => trunc(x, 30)).join(' · ');
        return `• <@${r.user_id}>${meta ? ` _(${meta})_` : ''}: ${trunc(r.text.replace(/\s+/g, ' '), 180)}`;
      }).join('\n'), 1024),
    });
  }
  const related = relatedIssues(issue).map((r) => issues.get(r.id)).filter(Boolean);
  if (related.length) {
    embed.addFields({
      name: '🔗 Possibly related',
      value: trunc(related.map((r) => `• **#${r.id}** ${trunc(r.title, 60)} (${(STATUSES[r.status] ?? STATUSES.new).label})`).join('\n'), 1024),
    });
  }
  if (issue.dev_note) embed.addFields({ name: '💬 Developer note', value: trunc(issue.dev_note, 1024) });
  if (issue.handled_by) embed.setFooter({ text: 'Last updated by a developer' });

  const statusMenu = new StringSelectMenuBuilder().setCustomId(`status:${issue.id}`).setPlaceholder('Developers: set status')
    .addOptions(Object.entries(STATUSES).map(([value, s]) => ({ label: s.label, value, emoji: s.emoji, default: value === issue.status })));
  const prioMenu = new StringSelectMenuBuilder().setCustomId(`prio:${issue.id}`).setPlaceholder('Developers: set priority')
    .addOptions(Object.entries(PRIORITIES).map(([value, p]) => ({ label: p.label, value, emoji: p.emoji, default: value === issue.priority })));

  const btn = (id, label, emoji) => new ButtonBuilder().setCustomId(`${id}:${issue.id}`).setLabel(label).setEmoji(emoji).setStyle(ButtonStyle.Secondary);
  const buttons = new ActionRowBuilder().addComponents(
    btn('plus', 'I have this too', '🙋'),
    btn('assign', 'Assign to me', '🙌'),
    btn('note', 'Dev note', '💬'),
    btn('merge', 'Merge into…', '🔀'),
    btn('rmrep', 'Remove report', '🗑️'),
  );

  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(statusMenu), new ActionRowBuilder().addComponents(prioMenu), buttons],
  };
}
