import { EmbedBuilder } from 'discord.js';
import { issues, prefs, settings } from './db.js';
import { weakAnswers } from './health.js';
import { PRIORITIES, STATUSES, person } from './render.js';
import { trunc } from './text.js';

const DAY = 864e5;
const lines = (arr, fmt, max = 8) => {
  if (!arr.length) return '_None_';
  const shown = arr.slice(0, max).map(fmt).join('\n');
  return trunc(arr.length > max ? `${shown}\n…and ${arr.length - max} more` : shown, 1024);
};
const fmt = (i) => `${(PRIORITIES[i.priority] ?? PRIORITIES.normal).emoji} **#${i.id}** ${trunc(i.title, 55)} · ${i.reporters} 👥${i.owner_id ? ` · ${person(i.owner_id, i.guild_id)}` : ''}`;

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

  const weak = weakAnswers(guildId);
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('📊 Weekly issue digest')
    .setDescription(`**${open.length}** open · **${newIssues.length}** new this week · **${fixed.length}** fixed this week`)
    .addFields(
      { name: '🆕 New this week', value: lines(newIssues, fmt) },
      { name: '🔥 Most-reported issues (top 5)', value: lines(top, fmt, 5) },
      { name: '✅ Fixed this week', value: lines(fixed, (i) => `**#${i.id}** ${trunc(i.title, 55)}${i.fixed_version ? ` · \`${i.fixed_version}\`` : ''}`) },
      { name: `⏳ Gone quiet – nothing for ${staleDays}+ days (New or ${STATUSES.in_progress.label})`, value: lines(stale, fmt) },
      { name: '🚨 Urgent issues nobody is working on', value: lines(needsOwner, fmt) },
    ).setTimestamp();
  if (weak.length) {
    embed.addFields({
      name: '📉 Suggested answers that aren\'t helping',
      value: trunc(`${weak.slice(0, 4).map((w) => `**${trunc(w.title, 50)}** – shown ${w.shown}×, only ${w.helped} said it fixed it`).join('\n')}${weak.length > 4 ? `\n…and ${weak.length - 4} more` : ''}\nRewrite or switch them off under Developer → Knowledge articles → Results.`, 700),
    });
  }
  return embed;
}

const ACTIVE = ['new', 'seen', 'in_progress'];

/** DM each developer a short list of the issues they own that have gone quiet. Returns how many people were messaged. */
export async function nudgeOwners(client, guildId) {
  const cfg = { stale_days: 7, ...settings.get(guildId) };
  const cutoff = Date.now() - cfg.stale_days * DAY;
  const byOwner = new Map();
  for (const i of issues.list(guildId)) {
    if (!ACTIVE.includes(i.status) || !i.owner_id || i.updated_at >= cutoff) continue;
    (byOwner.get(i.owner_id) ?? byOwner.set(i.owner_id, []).get(i.owner_id)).push(i);
  }
  const server = client.guilds?.cache?.get(guildId)?.name ?? 'your server';
  let sent = 0;
  for (const [owner, list] of byOwner) {
    if (prefs.dmOff(owner)) continue; // anyone who turned off the bot's messages is left alone
    list.sort((a, b) => a.updated_at - b.updated_at);
    const text = `⏳ **${list.length} issue${list.length === 1 ? '' : 's'} you're on ${list.length === 1 ? 'has' : 'have'} gone quiet** in **${server}** (nothing for ${cfg.stale_days}+ days):\n`
      + list.slice(0, 10).map((i) => `• **#${i.id}** ${trunc(i.title.replace(/\s+/g, ' '), 70)} – ${STATUSES[i.status]?.label ?? i.status}, quiet for ${Math.floor((Date.now() - i.updated_at) / DAY)} days`).join('\n')
      + (list.length > 10 ? `\n…and ${list.length - 10} more` : '')
      + '\nOpen **Developer → Board** to move them along, or hand them to someone else. This reminder comes once a week.';
    try { await (await client.users.fetch(owner)).send({ content: text, allowedMentions: { parse: [] } }); sent++; } catch { /* DMs closed */ }
  }
  return sent;
}

/** Called hourly: reminds issue owners once a week. */
export async function runNudges(client) {
  for (const cfg of settings.all()) {
    if (!cfg.last_nudge) { settings.update(cfg.guild_id, { last_nudge: Date.now() }); continue; } // first run: start the weekly clock, don't message anyone yet
    if (Date.now() - cfg.last_nudge < 7 * DAY) continue;
    settings.update(cfg.guild_id, { last_nudge: Date.now() }); // set first so a failure can't cause a message storm every hour
    try { await nudgeOwners(client, cfg.guild_id); } catch (e) { console.error('Nudge failed:', e.message); }
  }
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
