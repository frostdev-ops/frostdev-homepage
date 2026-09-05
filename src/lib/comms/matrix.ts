import { guardedFetch } from './guarded.ts';
import type { ChatChannel, ChatMessage, CommsClient, CommsEvent, SendOpts, Whoami } from './types.ts';

// Matrix over the client-server API on the user's own homeserver (so every
// request goes through the SSRF guard), with an access token sealed on the
// ward. The live feed is /sync long-polling: the first sync (no `since`) is
// stored quiet, every later one fires. Invites are accepted — a bot must be
// joinable. Encrypted rooms are opaque without keys: their events are
// skipped and counted so the ward can say so. Event ids are global, room ids
// are the channels; files are named, never linked (mxc:// needs the token).

type Fetch = typeof fetch;

export interface MatrixConfig {
  homeserver: string;
  channel: string;
  watch: string;
}

export const ROOM_RE = /^[!#][^\s:]+:[^\s/]+$/;
const V3 = '/_matrix/client/v3';
const SYNC_TIMEOUT_MS = 25_000;
const FILTER = JSON.stringify({ room: { timeline: { limit: 30 }, state: { lazy_load_members: true } }, presence: { types: [] } });

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const need = (v: unknown, what: string): string => {
  const s = str(v).trim();
  if (!s) throw new Error(`${what} is required`);
  return s;
};
const localpart = (userId: string) => userId.replace(/^@/, '').split(':')[0] ?? userId;

export interface ParsedSync {
  events: CommsEvent[];
  /** room id → name, from m.room.name state seen in this sync. */
  names: Map<string, string>;
  /** user id → display name, from m.room.member state. */
  members: Map<string, string>;
  invites: string[];
  encrypted: number;
  next: string;
}

/** One timeline event → ChatMessage (null for anything but a message). */
export function toMessage(ev: any, room: string, self: { id: string; name: string }, members: Map<string, string>): ChatMessage | null {
  if (ev?.type !== 'm.room.message' || !ev.event_id) return null;
  const c = ev.content ?? {};
  const sender = str(ev.sender);
  const body = str(c.body);
  const m: ChatMessage = {
    id: String(ev.event_id),
    channel: room,
    from: { id: sender, name: members.get(sender) || localpart(sender) },
    text: c.msgtype === 'm.text' || c.msgtype === 'm.notice' || c.msgtype === 'm.emote' || !c.msgtype ? body : '',
    at: Number(ev.origin_server_ts) || Date.now(),
  };
  if (c.msgtype === 'm.image' || c.msgtype === 'm.file' || c.msgtype === 'm.video' || c.msgtype === 'm.audio') m.attachments = [{ url: '', name: body || c.msgtype.slice(2) }];
  const rel = c['m.relates_to'] ?? {};
  if (rel.rel_type === 'm.thread' && rel.event_id) m.threadId = String(rel.event_id);
  const reply = rel['m.in_reply_to']?.event_id;
  if (reply) m.replyTo = String(reply);
  if (sender === self.id) m.mine = true;
  const mentions = c['m.mentions']?.user_ids;
  const named = !!self.name && body.toLowerCase().includes(self.name.toLowerCase());
  if ((Array.isArray(mentions) && mentions.includes(self.id)) || str(c.formatted_body).includes(`matrix.to/#/${self.id}`) || body.includes(self.id) || named) m.mention = true;
  return m;
}

/** A /sync response → what it means. Pure; `quiet` marks the initial batch. */
export function parseSync(body: any, self: { id: string; name: string }, quiet: boolean, known: Map<string, string> = new Map()): ParsedSync {
  const out: ParsedSync = { events: [], names: new Map(), members: new Map(known), invites: Object.keys(body?.rooms?.invite ?? {}), encrypted: 0, next: str(body?.next_batch) };
  const joined = body?.rooms?.join ?? {};
  for (const [room, data] of Object.entries<any>(joined)) {
    const stateEvents = [...(data?.state?.events ?? []), ...(data?.timeline?.events ?? [])];
    for (const ev of stateEvents) {
      if (ev?.type === 'm.room.name' && ev.content?.name) out.names.set(room, String(ev.content.name));
      if (ev?.type === 'm.room.member' && ev.state_key && ev.content?.displayname) out.members.set(String(ev.state_key), String(ev.content.displayname));
    }
    for (const ev of data?.timeline?.events ?? []) {
      if (ev?.type === 'm.room.encrypted') {
        out.encrypted++;
        continue;
      }
      if (ev?.type === 'm.room.message') {
        const m = toMessage(ev, room, self, out.members);
        if (!m || m.mine) continue;
        out.events.push(quiet ? { type: 'message', message: m, quiet: true } : { type: 'message', message: m });
      } else if (ev?.type === 'm.reaction') {
        const rel = ev.content?.['m.relates_to'];
        if (rel?.rel_type !== 'm.annotation' || !rel.event_id || ev.sender === self.id) continue;
        out.events.push({ type: 'reaction', channel: room, messageId: String(rel.event_id), emoji: str(rel.key), from: { id: str(ev.sender), name: out.members.get(str(ev.sender)) || localpart(str(ev.sender)) } });
      } else if (ev?.type === 'm.room.member' && ev.content?.membership === 'join' && ev.state_key && ev.state_key !== self.id) {
        const was = ev.unsigned?.prev_content?.membership;
        if (was !== 'join') out.events.push({ type: 'member-joined', member: { id: String(ev.state_key), name: str(ev.content.displayname) || localpart(String(ev.state_key)) }, channel: room });
      }
    }
  }
  return out;
}

async function api(base: string, token: string, method: string, path: string, body: unknown, fetchImpl: Fetch): Promise<any> {
  const res = await fetchImpl(`${base}${V3}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(SYNC_TIMEOUT_MS + 5_000),
  });
  const json = (await res.json().catch(() => null)) as any;
  if (!res.ok) {
    const err = new Error(`Matrix ${res.status}: ${json?.error ?? json?.errcode ?? res.statusText}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return json;
}

const OPS = {
  read: ['room {channel}', 'members {channel}', 'user {user}'],
  manage: ['create_room {name, topic?, private?, invite?: [user ids]}', 'invite {channel, user}', 'set_name {channel, name}', 'set_topic {channel, topic}', 'join {channel}', 'leave {channel}'],
  moderate: ['kick {channel, user, reason?}', 'ban {channel, user, reason?}', 'unban {channel, user}', 'redact {channel, message, reason?}'],
};

export function matrixClient(token: string, cfg: MatrixConfig, _key: string, fetchImpl: Fetch = guardedFetch): CommsClient {
  const base = cfg.homeserver.replace(/\/+$/, '');
  const names = new Map<string, string>();
  const members = new Map<string, string>();
  const aliases = new Map<string, string>();
  const self = { id: '', name: '' };
  let txn = 0;
  const nextTxn = () => `rw${Date.now()}-${++txn}`;
  const call = (method: string, path: string, body?: unknown) => {
    if (!/^https?:\/\//.test(base)) throw new Error('set the homeserver under ⚙ Configure');
    return api(base, token, method, path, body, fetchImpl);
  };
  const enc = encodeURIComponent;
  const ensureSelf = async () => {
    if (self.id) return;
    const me = await call('GET', '/account/whoami');
    self.id = str(me.user_id);
    try {
      self.name = str((await call('GET', `/profile/${enc(self.id)}/displayname`)).displayname);
    } catch {}
  };
  /** A #alias resolves to its !room id once. */
  const room = async (v: unknown): Promise<string> => {
    const s = need(v, 'room');
    if (!s.startsWith('#')) return s;
    const hit = aliases.get(s);
    if (hit) return hit;
    const id = str((await call('GET', `/directory/room/${enc(s)}`)).room_id);
    if (!id) throw new Error(`alias ${s} does not resolve`);
    aliases.set(s, id);
    return id;
  };
  const nameOf = async (id: string): Promise<string> => {
    const hit = names.get(id);
    if (hit) return hit;
    let name = '';
    try {
      name = str((await call('GET', `/rooms/${enc(id)}/state/m.room.name`)).name);
    } catch {}
    if (!name) {
      try {
        name = str((await call('GET', `/rooms/${enc(id)}/state/m.room.canonical_alias`)).alias);
      } catch {}
    }
    names.set(id, name || id);
    return name || id;
  };
  const withNames = (m: ChatMessage): ChatMessage => ({ ...m, channelName: m.channelName ?? names.get(m.channel), from: { ...m.from, name: members.get(m.from.id) || m.from.name } });

  const client: CommsClient = {
    type: 'matrix',
    destRe: ROOM_RE,
    maxText: 8000,
    ops: OPS,
    async whoami(): Promise<Whoami> {
      await ensureSelf();
      return { id: self.id, name: self.name || localpart(self.id), extra: { homeserver: base } };
    },
    async channels(): Promise<ChatChannel[]> {
      const ids: string[] = ((await call('GET', '/joined_rooms')).joined_rooms ?? []).slice(0, 50);
      const out = await Promise.all(ids.map(async (id) => ({ id, name: await nameOf(id), kind: 'room' })));
      return out;
    },
    nameOf: (id) => names.get(id),
    async history(channel, limit) {
      await ensureSelf();
      const id = await room(channel);
      const r = await call('GET', `/rooms/${enc(id)}/messages?dir=b&limit=${Math.min(Math.max(limit, 1), 100)}&filter=${enc(JSON.stringify({ types: ['m.room.message'] }))}`);
      const out: ChatMessage[] = [];
      for (const ev of r.chunk ?? []) {
        const m = toMessage(ev, id, self, members);
        if (m) out.push(withNames(m));
      }
      return out.reverse();
    },
    async send(channel, text, opts: SendOpts = {}) {
      await ensureSelf();
      const id = await room(channel);
      const content: Record<string, unknown> = { msgtype: 'm.text', body: text.slice(0, 8000) };
      if (opts.replyTo) {
        content['m.relates_to'] = opts.thread
          ? { rel_type: 'm.thread', event_id: opts.replyTo, is_falling_back: true, 'm.in_reply_to': { event_id: opts.replyTo } }
          : { 'm.in_reply_to': { event_id: opts.replyTo } };
      }
      const r = await call('PUT', `/rooms/${enc(id)}/send/m.room.message/${nextTxn()}`, content);
      return { id: str(r.event_id), channel: id, channelName: names.get(id), from: { id: self.id, name: self.name || 'bot' }, text, at: Date.now(), mine: true, ...(opts.thread && opts.replyTo ? { threadId: opts.replyTo } : {}) };
    },
    async react(channel, messageId, emoji) {
      const id = await room(channel);
      await call('PUT', `/rooms/${enc(id)}/send/m.reaction/${nextTxn()}`, { 'm.relates_to': { rel_type: 'm.annotation', event_id: need(messageId, 'message'), key: need(emoji, 'emoji') } });
    },
    async read(what, a) {
      switch (what) {
        case 'room': {
          const id = await room(a.channel);
          const [name, topic, joined] = await Promise.all([nameOf(id), call('GET', `/rooms/${enc(id)}/state/m.room.topic`).catch(() => ({})), call('GET', `/rooms/${enc(id)}/joined_members`).catch(() => ({ joined: {} }))]);
          return { id, name, topic: str(topic?.topic), members: Object.keys(joined?.joined ?? {}).length };
        }
        case 'members': {
          const id = await room(a.channel);
          const joined = (await call('GET', `/rooms/${enc(id)}/joined_members`)).joined ?? {};
          return Object.entries<any>(joined)
            .slice(0, 200)
            .map(([uid, m]) => ({ id: uid, name: str(m?.display_name) || localpart(uid) }));
        }
        case 'user': {
          const uid = need(a.user, 'user');
          const p = await call('GET', `/profile/${enc(uid)}`);
          return { id: uid, name: str(p?.displayname) || localpart(uid) };
        }
        default:
          throw new Error(`unknown read "${what}" — one of: ${OPS.read.join(', ')}`);
      }
    },
    async manage(op, a) {
      switch (op) {
        case 'create_room': {
          const invite = (Array.isArray(a.invite) ? a.invite : []).map(String).filter(Boolean);
          const r = await call('POST', '/createRoom', { name: need(a.name, 'name'), topic: str(a.topic) || undefined, preset: a.private === true ? 'private_chat' : 'public_chat', invite });
          names.set(str(r.room_id), need(a.name, 'name'));
          return { id: r.room_id, name: a.name };
        }
        case 'invite':
          await call('POST', `/rooms/${enc(await room(a.channel))}/invite`, { user_id: need(a.user, 'user') });
          return { ok: true };
        case 'set_name': {
          const id = await room(a.channel);
          await call('PUT', `/rooms/${enc(id)}/state/m.room.name`, { name: need(a.name, 'name') });
          names.set(id, need(a.name, 'name'));
          return { ok: true };
        }
        case 'set_topic':
          await call('PUT', `/rooms/${enc(await room(a.channel))}/state/m.room.topic`, { topic: str(a.topic) });
          return { ok: true };
        case 'join': {
          const r = await call('POST', `/join/${enc(need(a.channel, 'room'))}`, {});
          return { id: r.room_id };
        }
        case 'leave':
          await call('POST', `/rooms/${enc(await room(a.channel))}/leave`, {});
          return { ok: true };
        default:
          throw new Error(`unknown op "${op}" — one of: ${OPS.manage.map((s) => s.split(' ')[0]).join(', ')}`);
      }
    },
    async moderate(op, a) {
      const reason = str(a.reason) || undefined;
      switch (op) {
        case 'kick':
          await call('POST', `/rooms/${enc(await room(a.channel))}/kick`, { user_id: need(a.user, 'user'), reason });
          return { ok: true };
        case 'ban':
          await call('POST', `/rooms/${enc(await room(a.channel))}/ban`, { user_id: need(a.user, 'user'), reason });
          return { ok: true };
        case 'unban':
          await call('POST', `/rooms/${enc(await room(a.channel))}/unban`, { user_id: need(a.user, 'user') });
          return { ok: true };
        case 'redact':
          await call('PUT', `/rooms/${enc(await room(a.channel))}/redact/${enc(need(a.message, 'message'))}/${nextTxn()}`, { reason });
          return { ok: true };
        default:
          throw new Error(`unknown op "${op}" — one of: ${OPS.moderate.map((s) => s.split(' ')[0]).join(', ')}`);
      }
    },
    live(onEvent) {
      let stopped = false;
      let since = '';
      let wake: (() => void) | null = null;
      const sleep = (ms: number) =>
        new Promise<void>((r) => {
          const t = setTimeout(r, ms);
          (t as { unref?: () => void }).unref?.();
          wake = () => {
            clearTimeout(t);
            r();
          };
        });
      const loop = async () => {
        onEvent({ type: 'state', status: 'connecting' });
        let ready = false;
        while (!stopped) {
          let body: any;
          try {
            await ensureSelf();
            body = await call('GET', `/sync?filter=${enc(FILTER)}&timeout=${since ? SYNC_TIMEOUT_MS : 0}${since ? `&since=${enc(since)}` : ''}`);
          } catch (err) {
            if (stopped) break;
            const status = (err as { status?: number }).status;
            if (status === 401 || status === 403) {
              onEvent({ type: 'state', status: 'error', error: 'the homeserver refused the access token' });
              return;
            }
            onEvent({ type: 'state', status: 'error', error: err instanceof Error ? err.message : String(err) });
            await sleep(5_000);
            continue;
          }
          const parsed = parseSync(body, self, !since, members);
          for (const [k, v] of parsed.names) names.set(k, v);
          for (const [k, v] of parsed.members) members.set(k, v);
          for (const r of parsed.invites) void call('POST', `/join/${enc(r)}`, {}).catch(() => {});
          if (parsed.next) since = parsed.next;
          if (!ready) {
            ready = true;
            onEvent({ type: 'state', status: 'ready', note: parsed.encrypted ? 'Some rooms are end-to-end encrypted — their messages cannot be read here.' : undefined });
          }
          for (const ev of parsed.events) onEvent(ev.type === 'message' ? { ...ev, message: withNames(ev.message) } : ev);
        }
        onEvent({ type: 'state', status: 'closed' });
      };
      void loop().catch((err) => onEvent({ type: 'state', status: 'error', error: err instanceof Error ? err.message : String(err) }));
      // ponytail: an in-flight /sync finishes on its own (≤30s); the guard's fetch has no abort
      return () => {
        stopped = true;
        wake?.();
      };
    },
  };
  return client;
}
