import { EmbedBuilder } from 'discord.js';
import { issues, settings } from './db.js';
import { PRIORITIES, STATUSES } from './render.js';
import { trunc } from './text.js';

const DAY = 864e5;
const lines = (arr, fmt, max = 8) => {
  if (!arr.length) return '_None_';
  const shown = arr.slice(0, max).map(fmt).join('\n');
  return trunc(arr.length > max ? `${shown}\n…and ${arr.length - max} more` : shown, 1024);
};
const fmt = (i) => `${(PRIORITIES[i.priority] ?? PRIORITIES.normal).emoji} **#${i.id}** ${trunc(i.title, 55)} · ${i.reporters} 👥${i.owner_id ? ` · <@${i.owner_id}>` : ''}`;

export function buildDigest(guildId, staleDays = 7) {
  const now = Date.now();
  const all = issues.list(guildId);
  const open = all.filter((i) => ['new', 'seen', 'in_progress'].includes(i.status));
  const newIssues = all.filter((i) => i.created_at >= now - 7 * DAY);
  const fixed = all.filter((i) => i.status === 'fixed' && i.fixed_at >= now - 7 * DAY);
  const top = [...open].sort((a, b) => b.reporters - a.reporters).slice(0, 5);
  const stale = all.filter((i) => ['new', 'in_progress'].includes(i.status) && i.updated_at < now - staleDays * DAY)
    .sort((a, b) => a.updated_at - b.updated_at);
  const needsOwner = open.filter((i) => !i.owner_id && ['critical', 'high'].includes(i.priority));

  return new EmbedBuilder().setColor(0x5865f2).setTitle('📊 Weekly issue digest')
    .setDescription(`**${open.length}** open · **${newIssues.length}** new this week · **${fixed.length}** fixed this week`)
    .addFields(
      { name: '🆕 New this week', value: lines(newIssues, fmt) },
      { name: '🔥 Most-reported issues (top 5)', value: lines(top, fmt, 5) },
      { name: '✅ Fixed this week', value: lines(fixed, (i) => `**#${i.id}** ${trunc(i.title, 55)}${i.fixed_version ? ` · \`${i.fixed_version}\`` : ''}`) },
      { name: `⏳ Gone quiet – nothing for ${staleDays}+ days (New or ${STATUSES.in_progress.label})`, value: lines(stale, fmt) },
      { name: '🚨 Urgent issues nobody is working on', value: lines(needsOwner, fmt) },
    ).setTimestamp();
}

export async function postDigest(client, guildId) {
  const cfg = settings.get(guildId);
  if (!cfg?.dev_channel_id) return false;
  const ch = await client.channels.fetch(cfg.dev_channel_id);
  await ch.send({ embeds: [buildDigest(guildId, cfg.stale_days)] });
  settings.update(guildId, { last_digest: Date.now() });
  return true;
}

/** Called hourly: posts each guild's digest once a week. */
export async function runDigests(client) {
  for (const cfg of settings.all()) {
    if (!cfg.dev_channel_id) continue;
    if (!cfg.last_digest) { settings.update(cfg.guild_id, { last_digest: Date.now() }); continue; }
    if (Date.now() - cfg.last_digest >= 7 * DAY) {
      try { await postDigest(client, cfg.guild_id); } catch (e) { console.error('Digest failed:', e.message); }
    }
  }
}
