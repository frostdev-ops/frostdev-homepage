import type { ChatChannel, ChatMessage, CommsClient, CommsEvent, SendOpts, Whoami } from './types.ts';

// Slack over the Web API (bot token, xoxb-) with Socket Mode for the live
// feed (an app-level token, xapp-, optional: without it reads and sends work
// and nothing arrives on its own). Socket Mode URLs are one-shot — every
// reconnect asks apps.connections.open again; every envelope is acked at
// once by envelope_id. Message ids are per channel (ts), so a ChatMessage id
// is `${channel}:${ts}`. parseEnvelope() is pure; names are filled after.

const API = 'https://slack.com/api';
type Fetch = typeof fetch;

export interface SlackConfig {
  channel: string;
  watch: string;
}

const CHANNEL_RE = /^[CDG][A-Z0-9]{5,}$/;
export const rawTs = (id: string): string => (id.includes(':') ? id.slice(id.indexOf(':') + 1) : id);

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const need = (v: unknown, what: string): string => {
  const s = str(v).trim();
  if (!s) throw new Error(`${what} is required`);
  return s;
};

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, fn: (ev: any) => void): void;
}

/** A message / reaction / join event → what it means. Names are ids here. */
export function parseEvent(event: any, selfId: string): CommsEvent | null {
  switch (event?.type) {
    case 'message': {
      if (event.subtype && event.subtype !== 'file_share' && event.subtype !== 'thread_broadcast') return null;
      if (event.bot_id || !event.user || event.user === selfId) return null;
      const channel = String(event.channel ?? '');
      const ts = String(event.ts ?? '');
      if (!channel || !ts) return null;
      const text = typeof event.text === 'string' ? event.text : '';
      const m: ChatMessage = { id: `${channel}:${ts}`, channel, from: { id: String(event.user), name: String(event.user) }, text, at: Math.round(Number(ts) * 1000) || Date.now() };
      if (event.thread_ts && event.thread_ts !== ts) {
        m.threadId = String(event.thread_ts);
        m.replyTo = `${channel}:${event.thread_ts}`;
      }
      const files = Array.isArray(event.files) ? event.files : [];
      if (files.length) m.attachments = files.map((f: any) => ({ url: str(f.permalink), name: str(f.name) || str(f.title) || 'file', size: Number(f.size) || undefined }));
      if (event.channel_type === 'im') m.direct = true;
      if (m.direct || (selfId && text.includes(`<@${selfId}>`))) m.mention = true;
      return { type: 'message', message: m };
    }
    case 'reaction_added': {
      if (!event.user || event.user === selfId || event.item?.type !== 'message') return null;
      const channel = String(event.item.channel ?? '');
      return { type: 'reaction', channel, messageId: `${channel}:${event.item.ts}`, emoji: String(event.reaction ?? ''), from: { id: String(event.user), name: String(event.user) } };
    }
    case 'member_joined_channel':
      if (!event.user || event.user === selfId) return null;
      return { type: 'member-joined', member: { id: String(event.user), name: String(event.user) }, channel: String(event.channel ?? '') };
    default:
      return null; // app_mention duplicates the message event; the rest is noise here
  }
}

async function web(token: string, method: string, params: Record<string, unknown>, fetchImpl: Fetch): Promise<any> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    body.set(k, Array.isArray(v) ? v.join(',') : typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetchImpl(`${API}/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 429 && attempt === 0) {
      const wait = Math.min((Number(res.headers.get('retry-after')) || 1) * 1000, 10_000);
      await new Promise((r) => {
        const t = setTimeout(r, wait);
        (t as { unref?: () => void }).unref?.();
      });
      continue;
    }
    const json = (await res.json().catch(() => null)) as any;
    if (!res.ok || !json?.ok) throw new Error(`Slack ${method}: ${json?.error ?? res.statusText}`);
    return json;
  }
  throw new Error(`Slack ${method}: rate limited`);
}

const OPS = {
  read: ['channels', 'channel {channel}', 'members {channel}', 'users {query?}', 'user {user}', 'replies {channel, message}', 'pins {channel}'],
  manage: [
    'create_channel {name, private?}',
    'rename_channel {channel, name}',
    'archive_channel {channel}',
    'unarchive_channel {channel}',
    'invite {channel, users: [ids]}',
    'set_topic {channel, topic}',
    'set_purpose {channel, purpose}',
    'pin {channel, message}',
    'unpin {channel, message}',
    'join {channel}',
    'leave {channel}',
  ],
  moderate: ['delete_message {channel, message}', 'kick {channel, user}'],
};

const kindOf = (c: any): string => (c.is_im ? 'dm' : c.is_mpim ? 'group' : c.is_private ? 'private' : 'text');

export function slackClient(token: string, appToken: string | null, cfg: SlackConfig, _key: string, fetchImpl: Fetch = fetch, ws?: (url: string) => WebSocketLike): CommsClient {
  const names = new Map<string, string>(); // channel id → name
  const users = new Map<string, string>(); // user id → display name
  let selfId = '';
  const call = (method: string, params: Record<string, unknown> = {}) => web(token, method, params, fetchImpl);

  const ensureSelf = async () => {
    if (selfId) return;
    const me = await call('auth.test');
    selfId = String(me.user_id ?? '');
  };
  const userName = async (id: string): Promise<string> => {
    if (!id) return '';
    const hit = users.get(id);
    if (hit) return hit;
    try {
      const u = (await call('users.info', { user: id })).user;
      const name = str(u?.profile?.display_name) || str(u?.real_name) || str(u?.name) || id;
      users.set(id, name);
      return name;
    } catch {
      return id;
    }
  };
  const withNames = async (m: ChatMessage): Promise<ChatMessage> => ({ ...m, from: { ...m.from, name: await userName(m.from.id) }, channelName: m.channelName ?? names.get(m.channel) });
  const listChannels = async (): Promise<ChatChannel[]> => {
    const out: ChatChannel[] = [];
    let cursor = '';
    for (let page = 0; page < 5; page++) {
      const r = await call('conversations.list', { types: 'public_channel,private_channel,mpim,im', exclude_archived: true, limit: 200, cursor });
      for (const c of r.channels ?? []) {
        const ch: ChatChannel = { id: String(c.id), name: c.is_im ? `dm:${await userName(str(c.user))}` : str(c.name) || String(c.id), kind: kindOf(c) };
        names.set(ch.id, ch.name);
        out.push(ch);
      }
      cursor = str(r.response_metadata?.next_cursor);
      if (!cursor) break;
    }
    return out;
  };

  const client: CommsClient = {
    type: 'slack',
    destRe: CHANNEL_RE,
    maxText: 4000,
    ops: OPS,
    async whoami(): Promise<Whoami> {
      const me = await call('auth.test');
      selfId = String(me.user_id ?? '');
      return { id: selfId, name: str(me.user) || 'bot', extra: { team: str(me.team), url: str(me.url) } };
    },
    channels: listChannels,
    nameOf: (id) => names.get(id),
    async history(channel, limit) {
      await ensureSelf();
      const r = await call('conversations.history', { channel: need(channel, 'channel'), limit: Math.min(Math.max(limit, 1), 100) });
      const out: ChatMessage[] = [];
      for (const e of (r.messages ?? []).slice().reverse()) {
        const ev = parseEvent({ ...e, type: 'message', channel }, '');
        if (ev?.type !== 'message') continue;
        const m = ev.message;
        if (m.from.id === selfId) m.mine = true;
        out.push(await withNames(m));
      }
      return out;
    },
    async send(channel, text, opts: SendOpts = {}) {
      await ensureSelf();
      const c = need(channel, 'channel');
      const r = await call('chat.postMessage', { channel: c, text: text.slice(0, 4000), thread_ts: opts.thread && opts.replyTo ? rawTs(opts.replyTo) : undefined });
      const ts = String(r.ts);
      return { id: `${c}:${ts}`, channel: c, channelName: names.get(c), from: { id: selfId, name: 'bot' }, text, at: Math.round(Number(ts) * 1000) || Date.now(), mine: true, ...(opts.thread && opts.replyTo ? { threadId: rawTs(opts.replyTo) } : {}) };
    },
    async react(channel, messageId, emoji) {
      await call('reactions.add', { channel: need(channel, 'channel'), timestamp: rawTs(need(messageId, 'message')), name: need(emoji, 'emoji').replace(/^:|:$/g, '') });
    },
    async read(what, a) {
      switch (what) {
        case 'channels':
          return listChannels();
        case 'channel': {
          const c = (await call('conversations.info', { channel: need(a.channel, 'channel') })).channel;
          return { id: c.id, name: c.name, kind: kindOf(c), topic: c.topic?.value ?? '', purpose: c.purpose?.value ?? '', members: c.num_members ?? null, archived: !!c.is_archived };
        }
        case 'members': {
          const ids: string[] = ((await call('conversations.members', { channel: need(a.channel, 'channel'), limit: 100 })).members ?? []).slice(0, 50);
          return Promise.all(ids.map(async (id) => ({ id, name: await userName(id) })));
        }
        case 'users': {
          const q = str(a.query).toLowerCase();
          const list = ((await call('users.list', { limit: 200 })).members ?? []) as any[];
          return list
            .filter((u) => !u.deleted && !u.is_bot && u.id !== 'USLACKBOT')
            .map((u) => ({ id: u.id, name: str(u.profile?.display_name) || str(u.real_name) || str(u.name), email: str(u.profile?.email) || undefined, admin: !!u.is_admin }))
            .filter((u) => !q || `${u.name} ${u.email ?? ''}`.toLowerCase().includes(q))
            .slice(0, 100);
        }
        case 'user': {
          const u = (await call('users.info', { user: need(a.user, 'user') })).user;
          return { id: u.id, name: str(u.profile?.display_name) || str(u.real_name) || str(u.name), email: str(u.profile?.email) || undefined, title: str(u.profile?.title) || undefined, tz: u.tz, admin: !!u.is_admin, bot: !!u.is_bot };
        }
        case 'replies': {
          const c = need(a.channel, 'channel');
          const r = await call('conversations.replies', { channel: c, ts: rawTs(need(a.message, 'message')), limit: 50 });
          const out: ChatMessage[] = [];
          for (const e of r.messages ?? []) {
            const ev = parseEvent({ ...e, type: 'message', channel: c }, '');
            if (ev?.type === 'message') out.push(await withNames(ev.message));
          }
          return out;
        }
        case 'pins': {
          const c = need(a.channel, 'channel');
          return ((await call('pins.list', { channel: c })).items ?? []).filter((i: any) => i.type === 'message').map((i: any) => ({ id: `${c}:${i.message?.ts}`, text: str(i.message?.text), user: str(i.message?.user) }));
        }
        default:
          throw new Error(`unknown read "${what}" — one of: ${OPS.read.join(', ')}`);
      }
    },
    async manage(op, a) {
      switch (op) {
        case 'create_channel': {
          const c = (await call('conversations.create', { name: need(a.name, 'name').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 80), is_private: a.private === true })).channel;
          names.set(String(c.id), str(c.name));
          return { id: c.id, name: c.name, kind: kindOf(c) };
        }
        case 'rename_channel': {
          const c = (await call('conversations.rename', { channel: need(a.channel, 'channel'), name: need(a.name, 'name') })).channel;
          names.set(String(c.id), str(c.name));
          return { id: c.id, name: c.name };
        }
        case 'archive_channel':
          await call('conversations.archive', { channel: need(a.channel, 'channel') });
          return { ok: true };
        case 'unarchive_channel':
          await call('conversations.unarchive', { channel: need(a.channel, 'channel') });
          return { ok: true };
        case 'invite': {
          const ids = (Array.isArray(a.users) ? a.users : [a.users]).map(String).filter(Boolean);
          if (!ids.length) throw new Error('users is required');
          await call('conversations.invite', { channel: need(a.channel, 'channel'), users: ids.join(',') });
          return { ok: true, invited: ids.length };
        }
        case 'set_topic':
          await call('conversations.setTopic', { channel: need(a.channel, 'channel'), topic: str(a.topic).slice(0, 250) });
          return { ok: true };
        case 'set_purpose':
          await call('conversations.setPurpose', { channel: need(a.channel, 'channel'), purpose: str(a.purpose).slice(0, 250) });
          return { ok: true };
        case 'pin':
          await call('pins.add', { channel: need(a.channel, 'channel'), timestamp: rawTs(need(a.message, 'message')) });
          return { ok: true };
        case 'unpin':
          await call('pins.remove', { channel: need(a.channel, 'channel'), timestamp: rawTs(need(a.message, 'message')) });
          return { ok: true };
        case 'join':
          await call('conversations.join', { channel: need(a.channel, 'channel') });
          return { ok: true };
        case 'leave':
          await call('conversations.leave', { channel: need(a.channel, 'channel') });
          return { ok: true };
        default:
          throw new Error(`unknown op "${op}" — one of: ${OPS.manage.map((s) => s.split(' ')[0]).join(', ')}`);
      }
    },
    async moderate(op, a) {
      switch (op) {
        case 'delete_message':
          await call('chat.delete', { channel: need(a.channel, 'channel'), ts: rawTs(need(a.message, 'message')) });
          return { ok: true };
        case 'kick':
          await call('conversations.kick', { channel: need(a.channel, 'channel'), user: need(a.user, 'user') });
          return { ok: true };
        default:
          throw new Error(`unknown op "${op}" — one of: ${OPS.moderate.map((s) => s.split(' ')[0]).join(', ')}`);
      }
    },
    live(onEvent) {
      if (!appToken) {
        // Reads and sends still work; nothing arrives on its own.
        void ensureSelf()
          .then(() => onEvent({ type: 'state', status: 'ready', note: 'No app-level token: the ward reads and sends, but nothing arrives live. Add an xapp- token with connections:write (Socket Mode on) for messages, mentions and reactions.' }))
          .catch((err) => onEvent({ type: 'state', status: 'error', error: err instanceof Error ? err.message : String(err) }));
        return () => {};
      }
      let stopped = false;
      let sock: WebSocketLike | null = null;
      let backoff = 1_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const later = (fn: () => void, ms: number) => {
        timer = setTimeout(fn, ms);
        (timer as { unref?: () => void }).unref?.();
      };
      const reconnect = () => {
        if (stopped) return;
        later(open, backoff * (0.8 + Math.random() * 0.4));
        backoff = Math.min(backoff * 2, 60_000);
      };
      const open = async () => {
        if (stopped) return;
        onEvent({ type: 'state', status: 'connecting' });
        let url: string;
        try {
          await ensureSelf();
          void listChannels().catch(() => {});
          url = String((await web(appToken, 'apps.connections.open', {}, fetchImpl)).url);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          onEvent({ type: 'state', status: 'error', error: /invalid_auth|not_authed|invalid_token/.test(msg) ? `Slack refused a token (${msg})` : msg });
          if (!/invalid_auth|not_authed/.test(msg)) reconnect();
          return;
        }
        let s: WebSocketLike;
        try {
          s = (ws ?? ((u) => new WebSocket(u) as unknown as WebSocketLike))(url);
        } catch (err) {
          onEvent({ type: 'state', status: 'error', error: err instanceof Error ? err.message : String(err) });
          reconnect();
          return;
        }
        sock = s;
        s.addEventListener('message', (ev) => {
          if (s !== sock) return;
          let p: any;
          try {
            p = JSON.parse(String(ev.data));
          } catch {
            return;
          }
          if (p.envelope_id) {
            try {
              s.send(JSON.stringify({ envelope_id: p.envelope_id }));
            } catch {}
          }
          if (p.type === 'hello') {
            backoff = 1_000;
            onEvent({ type: 'state', status: 'ready' });
          } else if (p.type === 'disconnect') {
            s.close(1000, 'refresh');
          } else if (p.type === 'events_api' && p.payload?.type === 'event_callback') {
            const parsed = parseEvent(p.payload.event, selfId);
            if (!parsed) return;
            void fill(parsed).then(onEvent);
          }
        });
        s.addEventListener('close', () => {
          if (s !== sock) return;
          sock = null;
          if (!stopped) reconnect();
        });
        s.addEventListener('error', () => {});
      };
      const fill = async (ev: CommsEvent): Promise<CommsEvent> => {
        if (ev.type === 'message') return { ...ev, message: await withNames(ev.message) };
        if (ev.type === 'reaction') return { ...ev, from: { ...ev.from, name: await userName(ev.from.id) } };
        if (ev.type === 'member-joined') return { ...ev, member: { ...ev.member, name: await userName(ev.member.id) } };
        return ev;
      };
      void open();
      return () => {
        stopped = true;
        clearTimeout(timer);
        try {
          sock?.close(1000, 'bye');
        } catch {}
        sock = null;
        onEvent({ type: 'state', status: 'closed' });
      };
    },
  };
  return client;
}
