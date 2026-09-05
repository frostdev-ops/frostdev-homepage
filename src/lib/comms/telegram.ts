import type { ChatChannel, ChatMessage, CommsClient, CommsEvent, SendOpts, Whoami } from './types.ts';
import { unsupported } from './types.ts';

// Telegram over the Bot API: plain fetch to api.telegram.org (the token rides
// the URL path, so no error ever echoes a URL), and getUpdates long-polling
// for the live feed — Telegram allows ONE poller per token, which is why the
// manager shares a connection between wards on the same bot. There is no
// history endpoint: the ward's feed is whatever the store has seen. Message
// ids are per chat, so a ChatMessage id is `${chat}:${message_id}`.

const API = 'https://api.telegram.org';
const POLL_TIMEOUT_S = 30;
const UPDATES = ['message', 'channel_post', 'message_reaction', 'chat_member'];

type Fetch = typeof fetch;

export interface TelegramConfig {
  /** The default chat id (a number, negative for groups) or @channelusername. */
  channel: string;
  watch: string;
}

const CHAT_RE = /^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/;

/** `${chat}:${message_id}` → the raw message id Telegram wants. */
export const rawId = (id: string): number => Number(id.includes(':') ? id.slice(id.lastIndexOf(':') + 1) : id);

const personName = (u: any): string => [u?.first_name, u?.last_name].filter(Boolean).join(' ') || (u?.username ? `@${u.username}` : String(u?.id ?? ''));
const chatName = (c: any): string => c?.title || personName(c);

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const need = (v: unknown, what: string): string => {
  const s = str(v).trim();
  if (!s) throw new Error(`${what} is required`);
  return s;
};

/** A message / channel_post → ChatMessage. */
export function toMessage(m: any, self: { id: string; username: string }): ChatMessage {
  const chat = m.chat ?? {};
  const from = m.from ?? m.sender_chat ?? {};
  const fromId = String(from.id ?? '');
  const text = typeof m.text === 'string' ? m.text : typeof m.caption === 'string' ? m.caption : '';
  const out: ChatMessage = {
    id: `${chat.id}:${m.message_id}`,
    channel: String(chat.id),
    channelName: chatName(chat),
    from: { id: fromId, name: from.title || personName(from) },
    text,
    at: (Number(m.date) || Math.floor(Date.now() / 1000)) * 1000,
  };
  // Files are reachable only through getFile + a URL that carries the bot
  // token — never stored, never shown; the name says what arrived.
  const files: { name: string }[] = [];
  if (Array.isArray(m.photo) && m.photo.length) files.push({ name: 'photo' });
  for (const k of ['document', 'video', 'audio', 'voice', 'video_note', 'animation', 'sticker'] as const) {
    if (m[k]) files.push({ name: str(m[k].file_name) || k });
  }
  if (files.length) out.attachments = files.map((f) => ({ url: '', name: f.name }));
  if (m.message_thread_id) out.threadId = String(m.message_thread_id);
  if (m.reply_to_message?.message_id) out.replyTo = `${chat.id}:${m.reply_to_message.message_id}`;
  if (chat.type === 'private') out.direct = true;
  if (fromId && fromId === self.id) out.mine = true;
  else if (from.is_bot) out.bot = true;
  const entities = [...(Array.isArray(m.entities) ? m.entities : []), ...(Array.isArray(m.caption_entities) ? m.caption_entities : [])];
  const mentioned =
    !!self.username &&
    entities.some((e: any) => (e.type === 'mention' && text.slice(e.offset, e.offset + e.length).toLowerCase() === `@${self.username.toLowerCase()}`) || (e.type === 'text_mention' && String(e.user?.id) === self.id));
  if (out.direct || mentioned || String(m.reply_to_message?.from?.id ?? '') === self.id) out.mention = true;
  return out;
}

/** One update → the events it means (a service message can carry several joins). Pure. */
export function parseUpdate(u: any, self: { id: string; username: string }): CommsEvent[] {
  const out: CommsEvent[] = [];
  const m = u?.message ?? u?.channel_post;
  if (m?.chat) {
    if (Array.isArray(m.new_chat_members)) {
      for (const member of m.new_chat_members) if (member?.id && !member.is_bot) out.push({ type: 'member-joined', member: { id: String(member.id), name: personName(member) }, channel: String(m.chat.id) });
    } else {
      const msg = toMessage(m, self);
      if (!msg.mine && !msg.bot && (msg.text || msg.attachments)) out.push({ type: 'message', message: msg });
    }
  }
  const r = u?.message_reaction;
  if (r?.chat && Array.isArray(r.new_reaction) && r.new_reaction.length && String(r.user?.id ?? '') !== self.id) {
    const first = r.new_reaction[0];
    out.push({
      type: 'reaction',
      channel: String(r.chat.id),
      messageId: `${r.chat.id}:${r.message_id}`,
      emoji: first?.type === 'emoji' ? String(first.emoji) : `custom:${first?.custom_emoji_id ?? ''}`,
      from: { id: String(r.user?.id ?? r.actor_chat?.id ?? ''), name: r.user ? personName(r.user) : chatName(r.actor_chat) },
    });
  }
  const cm = u?.chat_member;
  if (cm?.chat && cm.new_chat_member?.user && !cm.new_chat_member.user.is_bot) {
    const was = cm.old_chat_member?.status;
    const now = cm.new_chat_member.status;
    if ((was === 'left' || was === 'kicked' || was === undefined) && (now === 'member' || now === 'administrator' || now === 'restricted')) {
      out.push({ type: 'member-joined', member: { id: String(cm.new_chat_member.user.id), name: personName(cm.new_chat_member.user) }, channel: String(cm.chat.id) });
    }
  }
  return out;
}

async function api(token: string, method: string, body: Record<string, unknown> | undefined, fetchImpl: Fetch, signal?: AbortSignal): Promise<any> {
  const res = await fetchImpl(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok || !json?.ok) {
    const err = new Error(`Telegram ${res.status}: ${json?.description ?? res.statusText}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return json.result;
}

const OPS = {
  read: ['chat {channel}', 'members {channel} (the administrators + the member count)', 'member {channel, user}', 'me'],
  manage: [
    'set_title {channel, title}',
    'set_description {channel, description}',
    'pin {channel, message}',
    'unpin {channel, message?}',
    'create_topic {channel, name} (forum supergroups)',
    'close_topic {channel, topic}',
    'create_invite {channel, expire?: seconds, limit?}',
    'leave {channel}',
  ],
  moderate: ['delete_message {channel, message}', 'ban {channel, user, until?: minutes}', 'unban {channel, user}', 'mute {channel, user, minutes (0 lifts)}'],
};

export function telegramClient(token: string, cfg: TelegramConfig, _key: string, fetchImpl: Fetch = fetch): CommsClient {
  const self = { id: '', username: '' };
  const call = (method: string, body?: Record<string, unknown>, signal?: AbortSignal) => api(token, method, body, fetchImpl, signal);
  const chatId = (v: unknown): string | number => {
    const s = need(v, 'chat');
    return s.startsWith('@') ? s : Number(s);
  };
  const ensureSelf = async () => {
    if (self.id) return;
    const me = await call('getMe');
    self.id = String(me.id);
    self.username = String(me.username ?? '');
  };

  const client: CommsClient = {
    type: 'telegram',
    destRe: CHAT_RE,
    maxText: 4096,
    ops: OPS,
    async whoami(): Promise<Whoami> {
      const me = await call('getMe');
      self.id = String(me.id);
      self.username = String(me.username ?? '');
      return { id: self.id, name: `@${self.username}`, extra: self.username ? { link: `https://t.me/${self.username}` } : undefined };
    },
    // No listing API for a bot: the manager merges the chats the store has seen.
    channels: async (): Promise<ChatChannel[]> => [],
    nameOf: () => undefined,
    history: async () => unsupported('telegram', 'history'),
    async send(channel, text, opts: SendOpts = {}) {
      await ensureSelf();
      const body: Record<string, unknown> = { chat_id: chatId(channel), text: text.slice(0, 4096) };
      if (opts.replyTo) body.reply_parameters = { message_id: rawId(opts.replyTo), allow_sending_without_reply: true };
      const sent = await call('sendMessage', body);
      return { ...toMessage(sent, self), mine: true };
    },
    async react(channel, messageId, emoji) {
      await call('setMessageReaction', { chat_id: chatId(channel), message_id: rawId(need(messageId, 'message')), reaction: [{ type: 'emoji', emoji: need(emoji, 'emoji') }] });
    },
    async read(what, a) {
      switch (what) {
        case 'me':
          return call('getMe');
        case 'chat':
          return call('getChat', { chat_id: chatId(a.channel) });
        case 'members': {
          const [admins, count] = await Promise.all([call('getChatAdministrators', { chat_id: chatId(a.channel) }), call('getChatMemberCount', { chat_id: chatId(a.channel) })]);
          return { count, administrators: (admins as any[]).map((m) => ({ id: m.user?.id, name: personName(m.user), status: m.status, title: m.custom_title ?? null })) };
        }
        case 'member': {
          const m = await call('getChatMember', { chat_id: chatId(a.channel), user_id: Number(need(a.user, 'user')) });
          return { id: m.user?.id, name: personName(m.user), status: m.status, until: m.until_date ?? null };
        }
        default:
          throw new Error(`unknown read "${what}" — one of: ${OPS.read.join(', ')}`);
      }
    },
    async manage(op, a) {
      switch (op) {
        case 'set_title':
          return call('setChatTitle', { chat_id: chatId(a.channel), title: need(a.title, 'title').slice(0, 128) });
        case 'set_description':
          return call('setChatDescription', { chat_id: chatId(a.channel), description: str(a.description).slice(0, 255) });
        case 'pin':
          return call('pinChatMessage', { chat_id: chatId(a.channel), message_id: rawId(need(a.message, 'message')) });
        case 'unpin':
          return a.message ? call('unpinChatMessage', { chat_id: chatId(a.channel), message_id: rawId(str(a.message)) }) : call('unpinAllChatMessages', { chat_id: chatId(a.channel) });
        case 'create_topic':
          return call('createForumTopic', { chat_id: chatId(a.channel), name: need(a.name, 'name').slice(0, 128) });
        case 'close_topic':
          return call('closeForumTopic', { chat_id: chatId(a.channel), message_thread_id: Number(need(a.topic, 'topic')) });
        case 'create_invite': {
          const body: Record<string, unknown> = { chat_id: chatId(a.channel) };
          if (a.expire) body.expire_date = Math.floor(Date.now() / 1000) + Math.max(60, Math.round(Number(a.expire)) || 0);
          if (a.limit) body.member_limit = Math.min(Math.max(Math.round(Number(a.limit)) || 0, 1), 99999);
          const link = await call('createChatInviteLink', body);
          return { url: link.invite_link, expires: link.expire_date ?? null, limit: link.member_limit ?? null };
        }
        case 'leave':
          return call('leaveChat', { chat_id: chatId(a.channel) });
        default:
          throw new Error(`unknown op "${op}" — one of: ${OPS.manage.map((s) => s.split(' ')[0]).join(', ')}`);
      }
    },
    async moderate(op, a) {
      const until = (minutes: unknown) => {
        const n = Math.round(Number(minutes)) || 0;
        return n > 0 ? Math.floor(Date.now() / 1000) + n * 60 : 0;
      };
      switch (op) {
        case 'delete_message':
          return call('deleteMessage', { chat_id: chatId(a.channel), message_id: rawId(need(a.message, 'message')) });
        case 'ban':
          return call('banChatMember', { chat_id: chatId(a.channel), user_id: Number(need(a.user, 'user')), ...(a.until ? { until_date: until(a.until) } : {}) });
        case 'unban':
          return call('unbanChatMember', { chat_id: chatId(a.channel), user_id: Number(need(a.user, 'user')), only_if_banned: true });
        case 'mute': {
          const lift = !(Math.round(Number(a.minutes)) > 0);
          return call('restrictChatMember', {
            chat_id: chatId(a.channel),
            user_id: Number(need(a.user, 'user')),
            permissions: lift ? { can_send_messages: true, can_send_other_messages: true, can_add_web_page_previews: true } : { can_send_messages: false },
            ...(lift ? {} : { until_date: until(a.minutes) }),
          });
        }
        default:
          throw new Error(`unknown op "${op}" — one of: ${OPS.moderate.map((s) => s.split(' ')[0]).join(', ')}`);
      }
    },
    live(onEvent) {
      let stopped = false;
      const ac = new AbortController();
      let offset: number | undefined;
      let quiet = true; // the first batch is what arrived while nobody was listening
      const sleep = (ms: number) => new Promise<void>((r) => {
        const t = setTimeout(r, ms);
        (t as { unref?: () => void }).unref?.();
        ac.signal.addEventListener('abort', () => {
          clearTimeout(t);
          r();
        }, { once: true });
      });
      const loop = async () => {
        onEvent({ type: 'state', status: 'connecting' });
        let ready = false;
        while (!stopped) {
          let updates: any[];
          try {
            await ensureSelf();
            updates = await call('getUpdates', { offset, timeout: POLL_TIMEOUT_S, allowed_updates: UPDATES }, AbortSignal.any([ac.signal, AbortSignal.timeout((POLL_TIMEOUT_S + 10) * 1000)]));
          } catch (err) {
            if (stopped) break;
            const status = (err as { status?: number }).status;
            if (status === 401 || status === 404) {
              onEvent({ type: 'state', status: 'error', error: 'Telegram refused the bot token' });
              return;
            }
            const msg = err instanceof Error ? err.message : String(err);
            onEvent({ type: 'state', status: 'error', error: status === 409 ? 'another poller holds this bot (a webhook or a second process) — Telegram allows one' : msg });
            await sleep(status === 409 ? 30_000 : 5_000);
            continue;
          }
          if (!ready) {
            ready = true;
            onEvent({ type: 'state', status: 'ready' });
          }
          for (const u of Array.isArray(updates) ? updates : []) {
            if (typeof u.update_id === 'number') offset = u.update_id + 1;
            for (const ev of parseUpdate(u, self)) onEvent(ev.type === 'message' && quiet ? { ...ev, quiet: true } : ev);
          }
          quiet = false;
        }
        onEvent({ type: 'state', status: 'closed' });
      };
      void loop().catch((err) => onEvent({ type: 'state', status: 'error', error: err instanceof Error ? err.message : String(err) }));
      return () => {
        stopped = true;
        ac.abort();
      };
    },
  };
  return client;
}
