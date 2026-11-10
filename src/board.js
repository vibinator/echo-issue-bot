// A Trello-style board for developers: one embed of columns (inline fields) per workflow stage.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder } from 'discord.js';
import { issues, settings } from './db.js';
import { PRIORITIES, STATUSES, person } from './render.js';
import { trunc } from './text.js';

const DAY = 864e5;
const MAX_CARDS = 6;
const ACTIVE = ['new', 'seen', 'in_progress'];
const DONE = ['fixed', 'cannot_reproduce', 'wont_fix'];

function card(it, staleBefore) {
  const stale = ACTIVE.includes(it.status) && it.updated_at < staleBefore ? ' ⏳' : '';
  return `${(PRIORITIES[it.priority] ?? PRIORITIES.normal).emoji}${it.kind === 'install' ? '🔧' : '🐞'} **#${it.id}** ${trunc(it.title.replace(/\s+/g, ' '), 70)} ·${it.reporters}👥${stale}${it.owner_id ? ` 🙌${person(it.owner_id, it.guild_id)}` : ''}`; // the remembered name, like the cards (a raw mention shows as a number to anyone who hasn't met them)
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

/** Step 3 of moving a card: say exactly what will happen and ask for a yes (a stray click can message real players). */
export function confirmMovePayload(issue, status, notifies) {
  const to = STATUSES[status];
  const from = STATUSES[issue.status];
  return {
    content: `**Move #${issue.id} – ${trunc(issue.title.replace(/\s+/g, ' '), 80)}?**\n${from?.emoji ?? ''} **${from?.label ?? issue.status}**  ➜  ${to.emoji} **${to.label}**${notifies ? '\n📨 Everyone who reported or follows this issue will get a message about it.' : ''}`,
    embeds: [],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`bmv:${issue.id}:${status}`).setLabel('Yes, move it').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`bmvback:${issue.id}`).setLabel('Pick another section').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('dev:board').setLabel('Cancel').setEmoji('✖️').setStyle(ButtonStyle.Secondary),
    )],
  };
}

const SECTION_PAGE = 10;
/** Every card in one section, paged (the board itself only shows the first few of each). */
export function sectionPayload(guildId, status, page = 0) {
  const cfg = { stale_days: 7, ...settings.get(guildId) };
  const staleBefore = Date.now() - cfg.stale_days * DAY;
  const st = STATUSES[status];
  const items = issues.list(guildId).filter((i) => i.status === status && onBoard(i));
  const pages = Math.max(1, Math.ceil(items.length / SECTION_PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const shown = items.slice(page * SECTION_PAGE, (page + 1) * SECTION_PAGE);
  const embed = new EmbedBuilder().setColor(0x3498db).setTitle(`${st.emoji} ${st.label} (${items.length})`)
    .setDescription(shown.map((i) => card(i, staleBefore)).join('\n\n') || '_empty_')
    .setFooter({ text: pages > 1 ? `Page ${page + 1} of ${pages} · most important first` : 'most important first' });
  const b = (id, label, emoji) => new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(ButtonStyle.Secondary);
  const components = [];
  if (shown.length) {
    components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('bfb').setPlaceholder('Open a card…').addOptions(shown.map((it) => ({
      label: trunc(`#${it.id} ${it.title}`, 100),
      description: trunc(`${(PRIORITIES[it.priority] ?? PRIORITIES.normal).label} · ${it.category} · ${it.reporters} players${it.owner_id ? ' · assigned' : ''}`, 100),
      emoji: st.emoji,
      value: String(it.id),
    })))));
  }
  components.push(new ActionRowBuilder().addComponents(
    b(`bsp:${status}:${page - 1}`, 'Previous', '◀️').setDisabled(page === 0),
    b(`bsp:${status}:${page + 1}`, 'Next', '▶️').setDisabled(page >= pages - 1),
    b('dev:board', 'Back to board', '⬅️'),
  ));
  return { content: '', embeds: [embed], components };
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
  components.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('bsec').setPlaceholder('See everything in a section…').addOptions(
      [...ACTIVE, ...DONE].map((v) => ({ label: STATUSES[v].label, emoji: STATUSES[v].emoji, value: v, description: `${list.filter((i) => i.status === v && onBoard(i)).length} cards` })))));
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
  const msg = await channel.send(boardPayload(guildId)); // post first: if this fails, the previous board and settings are untouched
  if (cfg?.board_message_id && cfg.board_channel_id && cfg.board_message_id !== msg.id) {
    try { await (await (await client.channels.fetch(cfg.board_channel_id)).messages.fetch(cfg.board_message_id)).delete(); } catch { /* gone */ }
  }
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
      if (e.code === 10003) settings.update(guildId, { board_channel_id: null, board_message_id: null }); // channel deleted
      else if (e.code === 10008) { // only the board message was deleted: keep the hub (threads depend on it) and post the board again
        try { await postBoard(client, guildId, await client.channels.fetch(cfg.board_channel_id)); } catch { /* retry on the next change */ }
      }
    }
  }, 3000);
  t.unref?.();
  timers.set(guildId, t);
}
