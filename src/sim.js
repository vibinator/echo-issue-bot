// A small simulation of Discord, good enough to drive the bot's real handlers end to end without a network:
// channels, threads, messages, DMs, and interactions that enforce Discord's own rules (answer within 3 seconds, one
// first reply only, edit only after acknowledging). Used by e2e.js.
import { MessageFlags } from 'discord.js';

export const sim = { t: 0, apiCalls: 0, LATENCY: 700 }; // every Discord call costs 700 simulated ms – a slow network
export const tick = () => { sim.t += sim.LATENCY; sim.apiCalls++; };

const unknown = (code, message) => Object.assign(new Error(message), { code });

let nextId = 1000;
export const newId = () => String(nextId++);

/** Round-trips through JSON so builders are validated exactly as Discord's API would see them. */
export const plain = (x) => JSON.parse(JSON.stringify(x));

export class FakeMessage {
  constructor(channel, payload, author = 'bot') {
    this.id = newId(); this.channel = channel; this.payload = payload; this.author = author; this.deleted = false;
    this.url = `https://discord.com/channels/G/${channel.id}/${this.id}`;
  }
  async delete() { tick(); this.deleted = true; this.channel.messages.map.delete(this.id); }
}

export class FakeChannel {
  constructor(id, name, { canThread = true, permissionsMissing = [] } = {}) {
    this.id = id; this.name = name; this.sent = []; this.canThread = canThread; this.permissionsMissing = permissionsMissing;
    this.threadsList = [];
    const ch = this;
    this.messages = {
      map: new Map(),
      async fetch(mid) { tick(); const m = ch.messages.map.get(mid); if (!m) throw unknown(10008, 'Unknown Message'); return m; },
      async edit(mid, payload) {
        tick(); const m = ch.messages.map.get(mid);
        if (!m) throw unknown(10008, 'Unknown Message');
        if (ch.archived) throw unknown(50083, 'Thread is archived');
        m.payload = payload; return m;
      },
    };
    this.threads = {
      async create(opts) {
        tick();
        if (!ch.canThread) throw unknown(50013, 'Missing Permissions');
        const th = new FakeThread(newId(), opts.name, ch);
        ch.threadsList.push(th); sim.registry.set(th.id, th); return th;
      },
    };
  }
  async send(payload) { tick(); const m = new FakeMessage(this, payload); this.messages.map.set(m.id, m); this.sent.push(m); return m; }
  permissionsFor() { return { missing: () => this.permissionsMissing }; }
  async delete() { tick(); sim.registry.delete(this.id); this.deleted = true; }
}

export class FakeThread extends FakeChannel {
  constructor(id, name, parent) {
    super(id, name); this.parent = parent; this.archived = false; this.locked = false; this.memberIds = new Set();
    const th = this;
    this.members = { async add(u) { tick(); if (sim.cannotAdd?.has(u)) throw unknown(50001, 'Missing Access'); th.memberIds.add(u); } };
  }
  async setArchived(v) { tick(); this.archived = v; return this; }
  async setLocked(v) { tick(); this.locked = v; return this; }
  async setName(n) { tick(); this.name = n; return this; }
  async send(payload) { if (this.archived) { this.archived = false; } return super.send(payload); } // sending reopens a thread
}

sim.registry = new Map(); // channel/thread id -> object
sim.dms = [];             // { to, content }
sim.users = new Map();

export function installClient(client) {
  client.channels.fetch = async (id) => { tick(); const c = sim.registry.get(id); if (!c) throw unknown(10003, 'Unknown Channel'); return c; };
  client.users.fetch = async (id) => ({
    id, username: `user_${id}`,
    send: async (payload) => { tick(); if (sim.closedDms?.has(id)) throw unknown(50007, 'Cannot send messages to this user'); sim.dms.push({ to: id, content: payload.content ?? payload }); },
  });
}

/** A member of the fake server. */
export const person = (id, { roles = [], manageGuild = false } = {}) => ({ id, username: `user_${id}`, roles, manageGuild });

const ack = new Set(['reply', 'update', 'deferReply', 'deferUpdate', 'showModal']);

/**
 * Builds an interaction the way discord.js would hand it to the bot.
 *  kind: 'button' | 'select' | 'modal' | 'command'
 *  screen: the message the component sits on ({ payload, ephemeral, id }) – for buttons/selects/modals-from-a-component
 */
export function interaction({ kind, customId, who, values, fields = {}, files = [], screen, channel, options = {}, commandName, guildId = 'G' }) {
  const startedAt = sim.t;
  const rows = screen ? plain(screen.payload).components ?? [] : [];
  const message = screen && {
    id: screen.id, flags: { has: (f) => screen.ephemeral && f === MessageFlags.Ephemeral },
    components: rows.map((r) => ({ components: (r.components ?? []).map((c) => ({ customId: c.custom_id, type: c.type })) })),
  };
  const i = {
    guildId, user: { id: who.id, username: who.username }, customId, values, channel, channelId: channel?.id ?? null, message, // channelId: where it was pressed (a thread's id inside a thread)
    guild: { members: { fetchMe: async () => { tick(); return { id: 'bot' }; } } },
    // Discord hands roles over as a manager, or as a plain list of ids when the server isn't cached – support both
    member: { roles: who.rolesAsList ? [...who.roles] : { cache: { has: (rid) => who.roles.includes(rid) } } },
    memberPermissions: { has: () => who.manageGuild },
    commandName,
    options: {
      getChannel: (k) => options[k] ?? null, getRole: (k) => options[k] ?? null, getInteger: (k) => options[k] ?? null, getBoolean: (k) => options[k] ?? null,
    },
    fields: {
      getTextInputValue: (k) => { if (!(k in fields)) throw new Error(`Modal field "${k}" is not in this form`); return fields[k]; },
      getUploadedFiles: (k) => (files.length ? new Map(files.map((f, n) => [String(n), f])) : null),
      getStringSelectValues: (k) => { if (!(k in fields)) throw new Error(`Modal field "${k}" is not in this form`); return [].concat(fields[k]); },
    },
    isChatInputCommand: () => kind === 'command', isButton: () => kind === 'button', isModalSubmit: () => kind === 'modal',
    isStringSelectMenu: () => kind === 'select', isChannelSelectMenu: () => kind === 'channelselect', isUserSelectMenu: () => kind === 'userselect',
    isFromMessage: () => kind === 'modal' && !!screen,
    replied: false, deferred: false, responses: [], lateAck: false, ackAfterMs: null, calls: 0, startedAt,
  };
  const record = (type, payload) => { i.responses.push({ type, payload: payload === undefined ? undefined : plain(payload) }); };
  const guardAck = (type) => {
    if (i.ackAfterMs === null) {
      i.ackAfterMs = sim.t - startedAt;
      if (i.ackAfterMs > 3000) { i.lateAck = true; throw unknown(10062, 'Unknown interaction'); } // Discord has forgotten it by now
    } else if (ack.has(type)) throw unknown(40060, 'Interaction has already been acknowledged');
  };
  const needAck = () => { if (i.ackAfterMs === null) throw new Error('editReply/followUp before the interaction was acknowledged'); };
  const fakeMsg = () => ({ id: screen?.id ?? newId() });
  i.reply = async (p) => { guardAck('reply'); i.replied = true; record('reply', p); return fakeMsg(); };
  i.update = async (p) => { if (!screen) throw new Error('update() on an interaction with no message'); guardAck('update'); i.replied = true; record('update', p); touch(); return fakeMsg(); };
  i.deferReply = async () => { guardAck('deferReply'); i.deferred = true; record('deferReply'); };
  i.deferUpdate = async () => { if (!screen) throw new Error('deferUpdate() on an interaction with no message'); guardAck('deferUpdate'); i.deferred = true; record('deferUpdate'); };
  const touch = () => { if (channel instanceof FakeThread && screen && !screen.ephemeral) channel.archived = false; }; // like Discord: redrawing a message in a thread reopens it
  i.editReply = async (p) => { needAck(); record('editReply', p); touch(); return fakeMsg(); };
  i.followUp = async (p) => { needAck(); record('followUp', p); return fakeMsg(); };
  i.showModal = async (m) => { guardAck('showModal'); i.replied = true; record('showModal', m); };
  return i;
}

/** The visible result of an interaction: the last payload shown, plus a modal if one was opened. */
export function outcome(i) {
  const shown = [...i.responses].reverse().find((r) => ['reply', 'update', 'editReply'].includes(r.type) && r.payload);
  const modal = i.responses.find((r) => r.type === 'showModal');
  return { payload: shown?.payload ?? null, modal: modal?.payload ?? null, type: shown?.type, responded: i.responses.length > 0 };
}

export const textOf = (payload) => {
  if (!payload) return '';
  if (typeof payload === 'string') return payload; // editReply('text') is allowed by discord.js
  const parts = [payload.content ?? ''];
  for (const e of payload.embeds ?? []) parts.push(e.title ?? '', e.description ?? '', ...(e.fields ?? []).flatMap((f) => [f.name, f.value]));
  return parts.join('\n');
};
export const embedChars = (embeds = []) => embeds.reduce((n, e) => n + (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.text?.length ?? 0)
  + (e.fields ?? []).reduce((m, f) => m + f.name.length + f.value.length, 0), 0);
export const buttonsOf = (payload) => (payload?.components ?? []).flatMap((r) => r.components ?? []);
