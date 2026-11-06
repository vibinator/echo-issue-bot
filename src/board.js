// A Trello-style board for developers: one embed of columns (inline fields) per workflow stage.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder } from 'discord.js';
import { issues, settings } from './db.js';
import { PRIORITIES, STATUSES } from './render.js';

const DAY = 864e5;
const MAX_CARDS = 7;
const trunc = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const ACTIVE = ['new', 'seen', 'in_progress'];
const DONE = ['fixed', 'cannot_reproduce', 'wont_fix'];

function card(it, staleBefore) {
  const stale = ACTIVE.includes(it.status) && it.updated_at < staleBefore ? ' ⏳' : '';
  return `${(PRIORITIES[it.priority] ?? PRIORITIES.normal).emoji}${it.kind === 'install' ? '🔧' : '🐞'} **#${it.id}** ${trunc(it.title.replace(/\s+/g, ' '), 40)} · ${it.reporters}👥${stale}${it.owner_id ? ` 🙌<@${it.owner_id}>` : ''}`;
}

function column(list, status, staleBefore) {
  const st = STATUSES[status];
  const items = list.filter((i) => i.status === status && (status !== 'fixed' || (i.fixed_at ?? 0) >= Date.now() - 14 * DAY));
  const shown = items.slice(0, MAX_CARDS).map((i) => card(i, staleBefore));
  if (items.length > MAX_CARDS) shown.push(`_…and ${items.length - MAX_CARDS} more_`);
  return { name: `${st.emoji} ${st.label} (${items.length})`, value: shown.join('\n') || '_empty_', inline: true };
}

/** owner: restrict to one developer's cards. title: heading override. */
export function boardPayload(guildId, { owner, title } = {}) {
  const cfg = { stale_days: 7, ...settings.get(guildId) };
  const staleBefore = Date.now() - cfg.stale_days * DAY;
  const list = issues.list(guildId, { owner });
  const active = new EmbedBuilder().setColor(0x3498db).setTitle(title ?? '📌 Developer board')
    .setDescription(`Updated <t:${Math.floor(Date.now() / 1000)}:R> · sorted by priority, then affected players · ⏳ = no activity for ${cfg.stale_days}+ days`)
    .addFields(ACTIVE.map((s) => column(list, s, staleBefore)));
  const done = new EmbedBuilder().setColor(0x2ecc71).setTitle('Done (fixed shown for 14 days)')
    .addFields(DONE.map((s) => column(list, s, staleBefore)));

  const open = list.filter((i) => ACTIVE.includes(i.status)).slice(0, 25);
  const components = [];
  if (open.length) {
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('bfb').setPlaceholder('Open a card…').addOptions(open.map((it) => ({
        label: trunc(`#${it.id} ${it.title}`, 100),
        description: trunc(`${(PRIORITIES[it.priority] ?? PRIORITIES.normal).label} · ${it.category} · ${it.reporters} players${it.owner_id ? ' · assigned' : ''}`, 100),
        emoji: STATUSES[it.status].emoji,
        value: String(it.id),
      })))));
  }
  const b = (id, label, emoji) => new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(ButtonStyle.Secondary);
  // On a personal ("My cards") view, Refresh keeps showing the personal view.
  components.push(new ActionRowBuilder().addComponents(...(owner
    ? [b('board:mine', 'Refresh', '🔄'), b('board:refresh', 'Whole board', '📌'), b('dev:menu', 'Developer menu', '⬅️')]
    : [b('board:refresh', 'Refresh', '🔄'), b('board:mine', 'My cards', '🙌'), b('dev:menu', 'Developer menu', '⬅️')])));
  return { content: '', embeds: [active, done], components };
}

/** Remove a leftover live board message (older versions posted one publicly; the board is now a hidden view). */
export async function dropBoard(client, guildId) {
  const cfg = settings.get(guildId);
  if (!cfg?.board_message_id) return;
  try { await (await (await client.channels.fetch(cfg.board_channel_id)).messages.fetch(cfg.board_message_id)).delete(); } catch { /* gone */ }
  settings.update(guildId, { board_channel_id: null, board_message_id: null });
}

/** (Legacy) Post the live board in `channel` (replacing the previous one) and remember it so it auto-updates. */
export async function postBoard(client, guildId, channel) {
  const cfg = settings.get(guildId);
  if (cfg?.board_message_id && cfg.board_channel_id) {
    try { await (await (await client.channels.fetch(cfg.board_channel_id)).messages.fetch(cfg.board_message_id)).delete(); } catch { /* gone */ }
  }
  const msg = await channel.send(boardPayload(guildId));
  settings.update(guildId, { board_channel_id: channel.id, board_message_id: msg.id });
  return msg;
}

const timers = new Map();
/** Debounced: refresh the live board a few seconds after the last change. */
export function refreshBoard(client, guildId) {
  if (!settings.get(guildId)?.board_message_id) return;
  clearTimeout(timers.get(guildId));
  const t = setTimeout(async () => {
    timers.delete(guildId);
    const cfg = settings.get(guildId);
    if (!cfg?.board_message_id) return;
    try {
      const ch = await client.channels.fetch(cfg.board_channel_id);
      await (await ch.messages.fetch(cfg.board_message_id)).edit(boardPayload(guildId));
    } catch (e) {
      if ([10003, 10008].includes(e.code)) settings.update(guildId, { board_channel_id: null, board_message_id: null }); // deleted
    }
  }, 3000);
  t.unref?.();
  timers.set(guildId, t);
}
