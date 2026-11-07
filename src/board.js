// A Trello-style board for developers: one embed of columns (inline fields) per workflow stage.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder } from 'discord.js';
import { issues, settings } from './db.js';
import { PRIORITIES, STATUSES } from './render.js';
import { trunc } from './text.js';

const DAY = 864e5;
const MAX_CARDS = 6;
const ACTIVE = ['new', 'seen', 'in_progress'];
const DONE = ['fixed', 'cannot_reproduce', 'wont_fix'];

function card(it, staleBefore) {
  const stale = ACTIVE.includes(it.status) && it.updated_at < staleBefore ? ' ⏳' : '';
  return `${(PRIORITIES[it.priority] ?? PRIORITIES.normal).emoji}${it.kind === 'install' ? '🔧' : '🐞'} **#${it.id}** ${trunc(it.title.replace(/\s+/g, ' '), 70)} ·${it.reporters}👥${stale}${it.owner_id ? ` 🙌<@${it.owner_id}>` : ''}`;
}

/** Is this issue shown on the board? (Fixed issues drop off after 14 days.) */
const onBoard = (i) => i.status !== 'fixed' || (i.fixed_at ?? 0) >= Date.now() - 14 * DAY;

/** The screen shown after picking a card to move: choose which section it goes to. */
export function movePayload(issue) {
  return {
    content: `**Move #${issue.id} – ${trunc(issue.title.replace(/\s+/g, ' '), 80)}**\nNow in **${STATUSES[issue.status]?.label ?? issue.status}**. Choose the section to move it to:`,
    embeds: [],
    components: [
      new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`bfd:${issue.id}`).setPlaceholder('Move to…')
        .addOptions(Object.entries(STATUSES).map(([value, s]) => ({ label: s.label, value, emoji: s.emoji, default: value === issue.status })))),
      new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('dev:board').setLabel('Back to board').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)),
    ],
  };
}

const LINE = '─'.repeat(30); // divider drawn under a section
function column(list, status, staleBefore, last = false) {
  const st = STATUSES[status];
  const items = list.filter((i) => i.status === status && onBoard(i));
  const shown = items.slice(0, MAX_CARDS).map((i) => card(i, staleBefore));
  if (items.length > MAX_CARDS) shown.push(`_…and ${items.length - MAX_CARDS} more_`);
  return { name: `${st.emoji} ${st.label} (${items.length})`, value: (shown.join('\n') || '_empty_') + (last ? '' : `\n${LINE}`), inline: false };
}

/** owner: restrict to one developer's cards. title: heading override. */
export function boardPayload(guildId, { owner, title } = {}) {
  const cfg = { stale_days: 7, ...settings.get(guildId) };
  const staleBefore = Date.now() - cfg.stale_days * DAY;
  const list = issues.list(guildId, { owner });
  const active = new EmbedBuilder().setColor(0x3498db).setTitle(title ?? '📌 Developer board')
    .setDescription(`Updated <t:${Math.floor(Date.now() / 1000)}:R> · most important first · ⏳ = quiet for ${cfg.stale_days}+ days · 🙌 = who's on it`)
    .addFields(ACTIVE.map((s, n) => column(list, s, staleBefore, n === ACTIVE.length - 1)));
  const done = new EmbedBuilder().setColor(0x2ecc71).setTitle('✔️ Finished (fixed issues stay here for 14 days)')
    .addFields(DONE.map((s, n) => column(list, s, staleBefore, n === DONE.length - 1)));

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
  const movable = list.filter(onBoard).slice(0, 25);
  if (movable.length) {
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('bfm').setPlaceholder('Move a card to another section…').addOptions(movable.map((it) => ({
        label: trunc(`#${it.id} ${it.title}`, 100),
        description: trunc(`Now: ${STATUSES[it.status]?.label ?? it.status}`, 100),
        emoji: STATUSES[it.status]?.emoji,
        value: String(it.id),
      })))));
  }
  const b = (id, label, emoji) => new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(ButtonStyle.Secondary);
  // On a personal ("My cards") view, Refresh keeps showing the personal view.
  components.push(new ActionRowBuilder().addComponents(...(owner
    ? [b('board:mine', 'Refresh', '🔄'), b('board:refresh', 'Show everyone\'s', '📌'), b('dev:menu', 'Developer menu', '⬅️')]
    : [b('board:refresh', 'Refresh', '🔄'), b('board:mine', 'Only mine', '🙌'), b('dev:menu', 'Developer menu', '⬅️')])));
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
