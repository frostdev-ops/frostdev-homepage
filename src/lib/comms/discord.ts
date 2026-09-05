import { cached } from '../cache.ts';
import type { ChatChannel, ChatMessage, CommsClient, CommsEvent, SendOpts, Whoami } from './types.ts';

// Discord over the bot API: REST v10 with plain fetch (a fixed vendor host,
// like google.ts) and the gateway websocket for the live feed — Node's global
// WebSocket, no library. One DiscordGateway per bot token; the manager in
// index.ts owns it. parseDispatch() and the gateway state machine are pure
// (injectable socket + timers) so tests drive them without a network.

const API = 'https://discord.com/api/v10';
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const UA = 'DiscordBot (https://github.com/frostdev-ops/frostdev-homepage, 1.0)';

export const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1, // privileged
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  DIRECT_MESSAGES: 1 << 12,
  DIRECT_MESSAGE_REACTIONS: 1 << 13,
  MESSAGE_CONTENT: 1 << 15, // privileged
} as const;
export const PRIVILEGED = INTENTS.GUILD_MEMBERS | INTENTS.MESSAGE_CONTENT;
export const ALL_INTENTS = Object.values(INTENTS).reduce((a, b) => a | b, 0);

/** What the invite link asks for: run the server, not administer it. */
const INVITE_PERMS = [0, 1, 2, 4, 5, 6, 10, 11, 13, 14, 15, 16, 27, 28, 34, 35, 36, 38, 40].reduce((a, bit) => a | (1n << BigInt(bit)), 0n);

// ---------------------------------------------------------------- gateway

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, fn: (ev: any) => void): void;
}

export interface GatewayOpts {
  token: string;
  intents: number;
  onDispatch: (t: string, d: any) => void;
  onState: (s: { status: 'connecting' | 'ready' | 'error' | 'closed'; error?: string; note?: string }) => void;
  /** Test seam: the socket factory (default: the global WebSocket). */
  ws?: (url: string) => WebSocketLike;
}

/** Close codes that no reconnect can fix. 4014 (disallowed intents) is
 *  handled first: one retry without the privileged bits, then fatal. */
const FATAL: Record<number, string> = {
  4004: 'authentication failed — check the bot token',
  4010: 'invalid shard',
  4011: 'sharding required — this bot is in too many servers for one connection',
  4012: 'invalid API version',
  4013: 'invalid intents',
  4014: 'disallowed intents — enable Message Content and Server Members under Bot → Privileged Gateway Intents in the developer portal',
};
/** Session gone: identify afresh, never resume. */
const REIDENTIFY = new Set([1000, 1001, 4007, 4009]);

const MAX_BACKOFF = 60_000;
const IDENTIFY_GAP_MS = 5_000; // Discord: one identify per 5s per token
const lastIdentify = new Map<string, number>();

const unref = (t: ReturnType<typeof setTimeout>) => {
  (t as { unref?: () => void }).unref?.();
  return t;
};

export class DiscordGateway {
  selfId = '';
  private ws: WebSocketLike | null = null;
  private seq: number | null = null;
  private sessionId = '';
  private resumeUrl = '';
  private hb: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private acked = true;
  private stopped = false;
  private backoff = 1_000;
  private intents: number;
  /** After a 4014 retry: what the ward should tell the user. */
  note = '';
  private opts: GatewayOpts;

  constructor(opts: GatewayOpts) {
    this.opts = opts;
    this.intents = opts.intents;
  }

  start(): void {
    this.open(GATEWAY_URL);
  }

  /** Synchronous — the SIGTERM path cannot await. Close 1000 ends the session
   *  server-side; nothing about it is persisted anyway. */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.hb);
    clearTimeout(this.reconnectTimer);
    try {
      this.ws?.close(1000, 'bye');
    } catch {}
    this.ws = null;
    this.opts.onState({ status: 'closed' });
  }

  private open(url: string): void {
    this.opts.onState({ status: 'connecting', note: this.note });
    let ws: WebSocketLike;
    try {
      ws = (this.opts.ws ?? ((u) => new WebSocket(u) as unknown as WebSocketLike))(url);
    } catch (err) {
      this.opts.onState({ status: 'error', error: err instanceof Error ? err.message : String(err) });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.addEventListener('message', (ev) => this.onMessage(ws, String(ev.data)));
    ws.addEventListener('close', (ev) => this.onClose(ws, Number(ev?.code) || 1006, String(ev?.reason ?? '')));
    ws.addEventListener('error', () => {}); // the close that follows carries the code
  }

  private send(op: number, d: unknown): void {
    try {
      this.ws?.send(JSON.stringify({ op, d }));
    } catch {}
  }

  private onMessage(ws: WebSocketLike, raw: string): void {
    if (ws !== this.ws) return;
    let p: { op: number; d?: any; s?: number | null; t?: string };
    try {
      p = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof p.s === 'number') this.seq = p.s;
    switch (p.op) {
      case 10: {
        const interval = Number(p.d?.heartbeat_interval) || 41_250;
        this.acked = true;
        this.scheduleBeat(interval * Math.random(), interval);
        if (this.sessionId) this.send(6, { token: this.opts.token, session_id: this.sessionId, seq: this.seq });
        else this.identify();
        break;
      }
      case 11:
        this.acked = true;
        break;
      case 1:
        this.beat();
        break;
      case 7:
        // Reconnect and resume — a non-1000 close keeps the session resumable.
        ws.close(4000, 'reconnect requested');
        break;
      case 9:
        if (p.d === true) this.send(6, { token: this.opts.token, session_id: this.sessionId, seq: this.seq });
        else {
          this.sessionId = '';
          this.seq = null;
          unref(setTimeout(() => this.identify(), 1_000 + Math.random() * 4_000));
        }
        break;
      case 0:
        this.dispatch(p.t ?? '', p.d);
        break;
    }
  }

  private scheduleBeat(delay: number, interval: number): void {
    clearTimeout(this.hb);
    this.hb = unref(
      setTimeout(() => {
        if (!this.acked) {
          // Zombie: no ack since the last beat. A non-1000 close resumes.
          this.ws?.close(4000, 'heartbeat not acknowledged');
          return;
        }
        this.beat();
        this.scheduleBeat(interval, interval);
      }, delay)
    );
  }

  private beat(): void {
    this.acked = false;
    this.send(1, this.seq);
  }

  private identify(): void {
    const key = this.opts.token.slice(-12);
    const wait = (lastIdentify.get(key) ?? 0) + IDENTIFY_GAP_MS - Date.now();
    if (wait > 0) {
      unref(setTimeout(() => this.identify(), wait));
      return;
    }
    lastIdentify.set(key, Date.now());
    this.send(2, { token: this.opts.token, intents: this.intents, properties: { os: 'linux', browser: 'rimeward', device: 'rimeward' } });
  }

  private dispatch(t: string, d: any): void {
    if (t === 'READY') {
      this.sessionId = String(d?.session_id ?? '');
      this.resumeUrl = typeof d?.resume_gateway_url === 'string' ? `${d.resume_gateway_url}/?v=10&encoding=json` : '';
      this.selfId = String(d?.user?.id ?? '');
      this.backoff = 1_000;
      this.opts.onState({ status: 'ready', note: this.note });
    } else if (t === 'RESUMED') {
      this.backoff = 1_000;
      this.opts.onState({ status: 'ready', note: this.note });
    }
    this.opts.onDispatch(t, d);
  }

  private onClose(ws: WebSocketLike, code: number, reason: string): void {
    if (ws !== this.ws) return;
    clearTimeout(this.hb);
    this.ws = null;
    if (this.stopped) return;
    if (code === 4014 && this.intents & PRIVILEGED) {
      // Retry without the privileged intents: the bot still connects, message
      // text and member joins are what it loses until the portal toggles flip.
      this.intents &= ~PRIVILEGED;
      this.sessionId = '';
      this.seq = null;
      this.note = 'Message Content and Server Members intents are off in the developer portal — message text is empty and member joins are invisible until they are enabled.';
      this.open(GATEWAY_URL);
      return;
    }
    if (FATAL[code]) {
      this.opts.onState({ status: 'error', error: `gateway closed ${code}: ${reason ? `${reason} — ` : ''}${FATAL[code]}` });
      return;
    }
    if (REIDENTIFY.has(code)) {
      this.sessionId = '';
      this.seq = null;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = this.backoff * (0.8 + Math.random() * 0.4);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF);
    this.reconnectTimer = unref(setTimeout(() => this.open(this.sessionId && this.resumeUrl ? this.resumeUrl : GATEWAY_URL), delay));
  }
}

// ---------------------------------------------------------------- payloads → events

const CHANNEL_KINDS: Record<number, string> = { 0: 'text', 2: 'voice', 4: 'category', 5: 'announcement', 10: 'thread', 11: 'thread', 12: 'thread', 13: 'stage', 15: 'forum', 16: 'media' };

const userName = (u: any): string => String(u?.global_name || u?.username || u?.id || '');

export function toChannel(c: any): ChatChannel {
  const out: ChatChannel = { id: String(c.id), name: String(c.name ?? c.id), kind: CHANNEL_KINDS[Number(c.type)] ?? String(c.type) };
  if (c.parent_id) out.parent = String(c.parent_id);
  return out;
}

/** A REST or gateway message object → ChatMessage. */
export function toMessage(d: any, selfId: string): ChatMessage {
  const author = d.author ?? {};
  const m: ChatMessage = {
    id: String(d.id),
    channel: String(d.channel_id),
    from: { id: String(author.id ?? ''), name: userName(author) },
    text: typeof d.content === 'string' ? d.content : '',
    at: Date.parse(d.timestamp) || Date.now(),
  };
  const attachments = Array.isArray(d.attachments) ? d.attachments : [];
  if (attachments.length) m.attachments = attachments.map((a: any) => ({ url: String(a.url ?? ''), name: String(a.filename ?? 'file'), size: Number(a.size) || undefined }));
  const ref = d.referenced_message?.id ?? d.message_reference?.message_id;
  if (ref) m.replyTo = String(ref);
  if (d.guild_id) m.guild = String(d.guild_id);
  else m.direct = true;
  if (author.id && author.id === selfId) m.mine = true;
  else if (author.bot || d.webhook_id) m.bot = true;
  const mentioned = Array.isArray(d.mentions) && d.mentions.some((u: any) => u?.id === selfId);
  if (mentioned || !d.guild_id || d.referenced_message?.author?.id === selfId) m.mention = true;
  return m;
}

/** Internal events the client keeps to itself (the channel-name cache). */
export type DiscordEvent = CommsEvent | { type: 'channels'; channels: ChatChannel[]; guild: string } | { type: 'channel-gone'; id: string };

/** One gateway dispatch → the event it means, or null for the rest. Pure. */
export function parseDispatch(t: string, d: any, selfId: string): DiscordEvent | null {
  switch (t) {
    case 'MESSAGE_CREATE': {
      const m = toMessage(d, selfId);
      if (m.mine || m.bot) return null; // own echoes and other bots never fire
      return { type: 'message', message: m };
    }
    case 'MESSAGE_REACTION_ADD': {
      if (!d?.user_id || d.user_id === selfId) return null;
      const e = d.emoji ?? {};
      return {
        type: 'reaction',
        channel: String(d.channel_id),
        messageId: String(d.message_id),
        emoji: e.id ? `${e.name}:${e.id}` : String(e.name ?? ''),
        from: { id: String(d.user_id), name: userName(d.member?.user) || String(d.user_id) },
        ...(d.guild_id ? { guild: String(d.guild_id) } : {}),
      };
    }
    case 'GUILD_MEMBER_ADD':
      if (!d?.user?.id || d.user.bot) return null;
      return { type: 'member-joined', member: { id: String(d.user.id), name: userName(d.user) }, guild: String(d.guild_id ?? '') };
    case 'GUILD_CREATE': {
      // Keep only the channel list — the payload carries the whole server.
      const channels = [...(Array.isArray(d?.channels) ? d.channels : []), ...(Array.isArray(d?.threads) ? d.threads : [])].map(toChannel);
      return { type: 'channels', channels, guild: String(d?.id ?? '') };
    }
    case 'CHANNEL_CREATE':
    case 'CHANNEL_UPDATE':
    case 'THREAD_CREATE':
    case 'THREAD_UPDATE':
      return d?.id ? { type: 'channels', channels: [toChannel(d)], guild: String(d.guild_id ?? '') } : null;
    case 'CHANNEL_DELETE':
    case 'THREAD_DELETE':
      return d?.id ? { type: 'channel-gone', id: String(d.id) } : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------- REST

type Fetch = typeof fetch;

async function rest(token: string, method: string, path: string, body?: unknown, fetchImpl: Fetch = fetch, reason?: string): Promise<any> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers: Record<string, string> = { authorization: `Bot ${token}`, 'user-agent': UA };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (reason) headers['x-audit-log-reason'] = encodeURIComponent(reason.slice(0, 200));
    const res = await fetchImpl(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    if (res.status === 429 && attempt === 0) {
      const j = (await res.json().catch(() => ({}))) as { retry_after?: number };
      await new Promise((r) => unref(setTimeout(r, Math.min((Number(j.retry_after) || 1) * 1000, 10_000))));
      continue;
    }
    if (res.status === 204) return null;
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    if (!res.ok) throw new Error(`Discord ${res.status}: ${json?.message ?? text.slice(0, 200) ?? res.statusText}`);
    return json;
  }
  throw new Error('Discord rate limited');
}

export interface DiscordConfig {
  guild: string;
  channel: string;
  watch: string;
}

const ID_RE = /^\d{5,25}$/;
const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const need = (v: unknown, what: string): string => {
  const s = str(v).trim();
  if (!s) throw new Error(`${what} is required`);
  return s;
};

const OPS = {
  read: ['channels', 'guild', 'roles', 'members {limit?, query?}', 'member {user}', 'threads', 'pins {channel}', 'channel {channel}', 'message {channel, message}', 'bans', 'invites'],
  manage: [
    'create_channel {name, kind?: text|voice|category|forum|announcement, parent?, topic?, nsfw?}',
    'edit_channel {channel, name?, topic?, parent?, nsfw?, slowmode?, position?}',
    'create_thread {channel, name, message?, private?}',
    'archive_thread {thread, archived?, locked?}',
    'pin {channel, message}',
    'unpin {channel, message}',
    'create_role {name, color?: hex, permissions?, hoist?, mentionable?}',
    'edit_role {role, name?, color?, permissions?, hoist?, mentionable?}',
    'assign_role {user, role}',
    'remove_role {user, role}',
    'set_permissions {channel, id, type: role|member, allow?, deny?}',
    'create_invite {channel, max_age?: seconds, max_uses?}',
    'set_nickname {user, nick}',
    'edit_guild {name?, description?}',
  ],
  moderate: [
    'delete_message {channel, message}',
    'bulk_delete {channel, messages: [ids]}',
    'delete_channel {channel}',
    'delete_role {role}',
    'kick {user, reason?}',
    'ban {user, reason?, delete_days?}',
    'unban {user}',
    'timeout {user, minutes (0 lifts), reason?}',
  ],
};

const KIND_CODES: Record<string, number> = { text: 0, voice: 2, category: 4, announcement: 5, forum: 15 };

const roleView = (r: any) => ({ id: r.id, name: r.name, color: r.color, position: r.position, permissions: r.permissions, hoist: !!r.hoist, mentionable: !!r.mentionable });
const memberView = (m: any) => ({ id: m.user?.id, name: userName(m.user), nick: m.nick ?? null, bot: !!m.user?.bot, roles: m.roles ?? [], joined: m.joined_at, timeout_until: m.communication_disabled_until ?? null });

/** One bot on one server. `key` scopes the channel-list cache. */
export function discordClient(token: string, cfg: DiscordConfig, key: string, fetchImpl: Fetch = fetch, ws?: GatewayOpts['ws']): CommsClient {
  const names = new Map<string, string>();
  let selfId = '';
  const call = (method: string, path: string, body?: unknown, reason?: string) => rest(token, method, path, body, fetchImpl, reason);
  const guild = (): string => {
    if (!ID_RE.test(cfg.guild)) throw new Error('set the server id under ⚙ Configure');
    return cfg.guild;
  };
  const remember = (list: ChatChannel[]) => {
    for (const c of list) names.set(c.id, c.name);
  };
  const color = (v: unknown): number | undefined => {
    const s = str(v).trim().replace(/^#/, '');
    return /^[0-9a-f]{6}$/i.test(s) ? parseInt(s, 16) : undefined;
  };

  const channels = (): Promise<ChatChannel[]> =>
    cached(`comms:channels:${key}`, 5 * 60_000, async () => {
      const g = guild();
      const [chans, threads] = await Promise.all([call('GET', `/guilds/${g}/channels`), call('GET', `/guilds/${g}/threads/active`).catch(() => ({ threads: [] }))]);
      const list = [...(Array.isArray(chans) ? chans : []), ...(Array.isArray(threads?.threads) ? threads.threads : [])].map(toChannel);
      remember(list);
      return list;
    });

  const client: CommsClient = {
    type: 'discord',
    destRe: ID_RE,
    maxText: 2000,
    ops: OPS,
    async whoami(): Promise<Whoami> {
      const me = await call('GET', '/users/@me');
      selfId = String(me.id);
      const out: Whoami = { id: selfId, name: userName(me) };
      const app = await call('GET', '/oauth2/applications/@me').catch(() => null);
      if (app?.id) out.extra = { application: String(app.id), invite: `https://discord.com/oauth2/authorize?client_id=${app.id}&scope=bot%20applications.commands&permissions=${INVITE_PERMS}` };
      return out;
    },
    channels,
    nameOf: (id) => names.get(id),
    async history(channel, limit) {
      const rows = await call('GET', `/channels/${need(channel, 'channel')}/messages?limit=${Math.min(Math.max(limit, 1), 100)}`);
      return (Array.isArray(rows) ? rows : []).map((r) => ({ ...toMessage(r, selfId), channelName: names.get(String(r.channel_id)) })).reverse();
    },
    async send(channel, text, opts: SendOpts = {}) {
      const c = need(channel, 'channel');
      const body: Record<string, unknown> = { content: text.slice(0, 2000), allowed_mentions: { parse: ['users'], replied_user: true } };
      let target = c;
      if (opts.thread && opts.replyTo) {
        // A thread off the message; a message that already has one (or is
        // in one) refuses, and the reply then lands in the channel itself.
        const t = await call('POST', `/channels/${c}/messages/${opts.replyTo}/threads`, { name: text.replace(/\s+/g, ' ').slice(0, 60) || 'thread' }).catch(() => null);
        if (t?.id) {
          target = String(t.id);
          names.set(target, String(t.name ?? 'thread'));
        }
      }
      if (target === c && opts.replyTo) body.message_reference = { message_id: opts.replyTo, fail_if_not_exists: false };
      const sent = await call('POST', `/channels/${target}/messages`, body);
      return { ...toMessage(sent, selfId), mine: true, channelName: names.get(target) };
    },
    async react(channel, messageId, emoji) {
      await call('PUT', `/channels/${need(channel, 'channel')}/messages/${need(messageId, 'message')}/reactions/${encodeURIComponent(need(emoji, 'emoji'))}/@me`);
    },
    async read(what, a) {
      switch (what) {
        case 'channels':
          return channels();
        case 'guild': {
          const g = await call('GET', `/guilds/${guild()}?with_counts=true`);
          return { id: g.id, name: g.name, description: g.description, owner: g.owner_id, members: g.approximate_member_count, online: g.approximate_presence_count, features: g.features };
        }
        case 'roles':
          return ((await call('GET', `/guilds/${guild()}/roles`)) as any[]).map(roleView);
        case 'members': {
          const limit = Math.min(Math.max(Math.round(Number(a.limit)) || 50, 1), 200);
          const q = str(a.query).trim();
          const rows = q
            ? await call('GET', `/guilds/${guild()}/members/search?query=${encodeURIComponent(q)}&limit=${limit}`)
            : await call('GET', `/guilds/${guild()}/members?limit=${limit}`);
          return (rows as any[]).map(memberView);
        }
        case 'member':
          return memberView(await call('GET', `/guilds/${guild()}/members/${need(a.user, 'user')}`));
        case 'threads': {
          const r = await call('GET', `/guilds/${guild()}/threads/active`);
          return (r?.threads ?? []).map((t: any) => ({ ...toChannel(t), archived: !!t.thread_metadata?.archived, messages: t.message_count }));
        }
        case 'pins':
          return ((await call('GET', `/channels/${need(a.channel, 'channel')}/pins`)) as any[]).map((m) => toMessage(m, selfId));
        case 'channel': {
          const c = await call('GET', `/channels/${need(a.channel, 'channel')}`);
          return { ...toChannel(c), topic: c.topic ?? null, nsfw: !!c.nsfw, slowmode: c.rate_limit_per_user ?? 0, position: c.position };
        }
        case 'message':
          return toMessage(await call('GET', `/channels/${need(a.channel, 'channel')}/messages/${need(a.message, 'message')}`), selfId);
        case 'bans':
          return ((await call('GET', `/guilds/${guild()}/bans?limit=100`)) as any[]).map((b) => ({ user: b.user?.id, name: userName(b.user), reason: b.reason ?? null }));
        case 'invites':
          return ((await call('GET', `/guilds/${guild()}/invites`)) as any[]).map((i) => ({ code: i.code, url: `https://discord.gg/${i.code}`, channel: i.channel?.id, uses: i.uses, max_uses: i.max_uses, expires: i.expires_at }));
        default:
          throw new Error(`unknown read "${what}" — one of: ${OPS.read.join(', ')}`);
      }
    },
    async manage(op, a) {
      switch (op) {
        case 'create_channel': {
          const kind = str(a.kind || 'text');
          if (!(kind in KIND_CODES)) throw new Error(`kind must be one of ${Object.keys(KIND_CODES).join('|')}`);
          const c = await call('POST', `/guilds/${guild()}/channels`, { name: need(a.name, 'name'), type: KIND_CODES[kind], parent_id: str(a.parent) || undefined, topic: str(a.topic) || undefined, nsfw: a.nsfw === true });
          const ch = toChannel(c);
          names.set(ch.id, ch.name);
          return ch;
        }
        case 'edit_channel': {
          const body: Record<string, unknown> = {};
          if (a.name !== undefined) body.name = need(a.name, 'name');
          if (a.topic !== undefined) body.topic = str(a.topic);
          if (a.parent !== undefined) body.parent_id = str(a.parent) || null;
          if (a.nsfw !== undefined) body.nsfw = a.nsfw === true;
          if (a.slowmode !== undefined) body.rate_limit_per_user = Math.max(0, Math.round(Number(a.slowmode)) || 0);
          if (a.position !== undefined) body.position = Math.round(Number(a.position)) || 0;
          const c = await call('PATCH', `/channels/${need(a.channel, 'channel')}`, body);
          const ch = toChannel(c);
          names.set(ch.id, ch.name);
          return ch;
        }
        case 'create_thread': {
          const c = need(a.channel, 'channel');
          const name = need(a.name, 'name').slice(0, 100);
          const t = str(a.message)
            ? await call('POST', `/channels/${c}/messages/${str(a.message)}/threads`, { name })
            : await call('POST', `/channels/${c}/threads`, { name, type: a.private === true ? 12 : 11 });
          const ch = toChannel(t);
          names.set(ch.id, ch.name);
          return ch;
        }
        case 'archive_thread':
          return toChannel(await call('PATCH', `/channels/${need(a.thread, 'thread')}`, { archived: a.archived !== false, ...(a.locked !== undefined ? { locked: a.locked === true } : {}) }));
        case 'pin':
          await call('PUT', `/channels/${need(a.channel, 'channel')}/pins/${need(a.message, 'message')}`);
          return { ok: true };
        case 'unpin':
          await call('DELETE', `/channels/${need(a.channel, 'channel')}/pins/${need(a.message, 'message')}`);
          return { ok: true };
        case 'create_role':
          return roleView(await call('POST', `/guilds/${guild()}/roles`, { name: need(a.name, 'name'), color: color(a.color), permissions: str(a.permissions) || undefined, hoist: a.hoist === true, mentionable: a.mentionable === true }));
        case 'edit_role': {
          const body: Record<string, unknown> = {};
          if (a.name !== undefined) body.name = need(a.name, 'name');
          if (a.color !== undefined) body.color = color(a.color) ?? 0;
          if (a.permissions !== undefined) body.permissions = str(a.permissions);
          if (a.hoist !== undefined) body.hoist = a.hoist === true;
          if (a.mentionable !== undefined) body.mentionable = a.mentionable === true;
          return roleView(await call('PATCH', `/guilds/${guild()}/roles/${need(a.role, 'role')}`, body));
        }
        case 'assign_role':
          await call('PUT', `/guilds/${guild()}/members/${need(a.user, 'user')}/roles/${need(a.role, 'role')}`);
          return { ok: true };
        case 'remove_role':
          await call('DELETE', `/guilds/${guild()}/members/${need(a.user, 'user')}/roles/${need(a.role, 'role')}`);
          return { ok: true };
        case 'set_permissions':
          await call('PUT', `/channels/${need(a.channel, 'channel')}/permissions/${need(a.id, 'id')}`, { type: a.type === 'member' ? 1 : 0, allow: str(a.allow) || '0', deny: str(a.deny) || '0' });
          return { ok: true };
        case 'create_invite': {
          const i = await call('POST', `/channels/${need(a.channel, 'channel')}/invites`, { max_age: Math.max(0, Math.round(Number(a.max_age)) || 86400), max_uses: Math.max(0, Math.round(Number(a.max_uses)) || 0) });
          return { code: i.code, url: `https://discord.gg/${i.code}` };
        }
        case 'set_nickname':
          await call('PATCH', `/guilds/${guild()}/members/${need(a.user, 'user')}`, { nick: str(a.nick).slice(0, 32) || null });
          return { ok: true };
        case 'edit_guild': {
          const body: Record<string, unknown> = {};
          if (a.name !== undefined) body.name = need(a.name, 'name');
          if (a.description !== undefined) body.description = str(a.description);
          const g = await call('PATCH', `/guilds/${guild()}`, body);
          return { id: g.id, name: g.name, description: g.description };
        }
        default:
          throw new Error(`unknown op "${op}" — one of: ${OPS.manage.map((s) => s.split(' ')[0]).join(', ')}`);
      }
    },
    async moderate(op, a) {
      const reason = str(a.reason) || undefined;
      switch (op) {
        case 'delete_message':
          await call('DELETE', `/channels/${need(a.channel, 'channel')}/messages/${need(a.message, 'message')}`, undefined, reason);
          return { ok: true };
        case 'bulk_delete': {
          const ids = (Array.isArray(a.messages) ? a.messages : []).map(String).slice(0, 100);
          if (ids.length < 2) throw new Error('bulk_delete needs 2–100 message ids');
          await call('POST', `/channels/${need(a.channel, 'channel')}/messages/bulk-delete`, { messages: ids }, reason);
          return { ok: true, deleted: ids.length };
        }
        case 'delete_channel':
          await call('DELETE', `/channels/${need(a.channel, 'channel')}`, undefined, reason);
          names.delete(str(a.channel));
          return { ok: true };
        case 'delete_role':
          await call('DELETE', `/guilds/${guild()}/roles/${need(a.role, 'role')}`, undefined, reason);
          return { ok: true };
        case 'kick':
          await call('DELETE', `/guilds/${guild()}/members/${need(a.user, 'user')}`, undefined, reason);
          return { ok: true };
        case 'ban':
          await call('PUT', `/guilds/${guild()}/bans/${need(a.user, 'user')}`, { delete_message_seconds: Math.min(Math.max(Math.round(Number(a.delete_days)) || 0, 0), 7) * 86400 }, reason);
          return { ok: true };
        case 'unban':
          await call('DELETE', `/guilds/${guild()}/bans/${need(a.user, 'user')}`, undefined, reason);
          return { ok: true };
        case 'timeout': {
          const minutes = Math.min(Math.max(Math.round(Number(a.minutes)) || 0, 0), 28 * 24 * 60);
          await call('PATCH', `/guilds/${guild()}/members/${need(a.user, 'user')}`, { communication_disabled_until: minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : null }, reason);
          return { ok: true, minutes };
        }
        default:
          throw new Error(`unknown op "${op}" — one of: ${OPS.moderate.map((s) => s.split(' ')[0]).join(', ')}`);
      }
    },
    live(onEvent) {
      const gw = new DiscordGateway({
        token,
        intents: ALL_INTENTS,
        ws,
        onState: (s) => onEvent({ type: 'state', ...s }),
        onDispatch: (t, d) => {
          if (t === 'READY') selfId = gw.selfId;
          const ev = parseDispatch(t, d, gw.selfId);
          if (!ev) return;
          if (ev.type === 'channels') return remember(ev.channels);
          if (ev.type === 'channel-gone') return void names.delete(ev.id);
          if (ev.type === 'message' && !ev.message.channelName) ev.message.channelName = names.get(ev.message.channel);
          onEvent(ev);
        },
      });
      gw.start();
      return () => gw.stop();
    },
  };
  return client;
}
