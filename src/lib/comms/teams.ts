import type { ChatChannel, ChatMessage, CommsClient, CommsEvent, SendOpts, Whoami } from './types.ts';
import { unsupported } from './types.ts';

// Microsoft Teams over Graph, on the user's OWN linked Microsoft account —
// no bot, no sealed ward token: the ward speaks as the user, through the
// same refresh-token machinery Outlook mail uses (liveToken), once the link
// carries the Teams scopes. A ward is either the user's chats (no team) or
// one team's channels (config.team). Inbound is a 60s poll of the watched
// conversations — Graph change notifications need a public endpoint and
// this app has none. Channel reads need ChannelMessage.Read.All, which most
// tenants gate behind admin consent; chats work with delegated scopes.

const GRAPH = 'https://graph.microsoft.com/v1.0';
const POLL_MS = 60_000;
const MAX_POLL = 5;
type Fetch = typeof fetch;

export interface TeamsConfig {
  /** A team id → its channels; empty → the user's chats. */
  team: string;
  channel: string;
  watch: string;
}

export const ID_RE = /^[A-Za-z0-9:@._%-]{8,200}$/;
const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const need = (v: unknown, what: string): string => {
  const s = str(v).trim();
  if (!s) throw new Error(`${what} is required`);
  return s;
};

/** Graph bodies are HTML: the text, with mentions and tags flattened. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A chatMessage resource → ChatMessage; null for system events. */
export function toMessage(m: any, channel: string, selfId: string): ChatMessage | null {
  if (!m?.id || (m.messageType && m.messageType !== 'message')) return null;
  const fromUser = m.from?.user;
  const fromApp = m.from?.application;
  const out: ChatMessage = {
    id: String(m.id),
    channel,
    from: { id: str(fromUser?.id ?? fromApp?.id), name: str(fromUser?.displayName ?? fromApp?.displayName) || 'unknown' },
    text: m.body?.contentType === 'html' ? htmlToText(str(m.body?.content)) : str(m.body?.content),
    at: Date.parse(str(m.createdDateTime)) || Date.now(),
  };
  const files = (Array.isArray(m.attachments) ? m.attachments : []).filter((a: any) => a?.name);
  if (files.length) out.attachments = files.map((a: any) => ({ url: '', name: str(a.name) }));
  if (m.replyToId) out.replyTo = String(m.replyToId);
  if (fromUser?.id && fromUser.id === selfId) out.mine = true;
  else if (fromApp) out.bot = true;
  if (Array.isArray(m.mentions) && m.mentions.some((x: any) => x?.mentioned?.user?.id === selfId)) out.mention = true;
  return out;
}

async function graph(getToken: () => Promise<string>, method: string, path: string, body: unknown, fetchImpl: Fetch): Promise<any> {
  const token = await getToken();
  const res = await fetchImpl(`${GRAPH}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 202 || res.status === 204) return null;
  const json = (await res.json().catch(() => null)) as any;
  if (!res.ok) {
    const err = new Error(`Graph ${res.status}: ${json?.error?.message ?? res.statusText}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return json;
}

const OPS = {
  read: ['chats', 'teams', 'channels', 'members {channel}', 'replies {channel, message} (team channels)'],
  manage: ['create_channel {name, description?} (a team ward)', 'set_topic {channel, topic} (a group chat)', 'add_member {channel, user} (a group chat; user = the Entra user id)'],
  moderate: ['delete_message {channel, message} (soft delete)'],
};

export function teamsClient(getToken: () => Promise<string>, cfg: TeamsConfig, _key: string, fetchImpl: Fetch = fetch): CommsClient {
  const names = new Map<string, string>();
  const self = { id: '', name: '' };
  const call = (method: string, path: string, body?: unknown) => graph(getToken, method, path, body, fetchImpl);
  const team = cfg.team.trim();
  const msgPath = (conv: string) => (team ? `/teams/${enc(team)}/channels/${enc(conv)}/messages` : `/chats/${enc(conv)}/messages`);
  const enc = encodeURIComponent;
  const ensureSelf = async () => {
    if (self.id) return;
    const me = await call('GET', '/me?$select=id,displayName');
    self.id = str(me?.id);
    self.name = str(me?.displayName);
  };
  const listChannels = async (): Promise<ChatChannel[]> => {
    await ensureSelf();
    const out: ChatChannel[] = [];
    if (team) {
      for (const c of (await call('GET', `/teams/${enc(team)}/channels?$select=id,displayName,membershipType`))?.value ?? []) out.push({ id: str(c.id), name: str(c.displayName), kind: c.membershipType === 'private' ? 'private' : 'text' });
    } else {
      const chats = (await call('GET', '/me/chats?$expand=members($select=displayName,userId)&$top=50&$orderby=lastMessagePreview/createdDateTime desc'))?.value ?? [];
      for (const c of chats) {
        const others = (c.members ?? []).map((m: any) => str(m.displayName)).filter((n: string) => n && n !== self.name);
        out.push({ id: str(c.id), name: str(c.topic) || others.join(', ') || str(c.id), kind: c.chatType === 'oneOnOne' ? 'dm' : c.chatType === 'meeting' ? 'meeting' : 'group' });
      }
    }
    for (const c of out) names.set(c.id, c.name);
    return out;
  };
  const withName = (m: ChatMessage): ChatMessage => ({ ...m, channelName: m.channelName ?? names.get(m.channel) });
  const consent = (err: unknown): Error => {
    const status = (err as { status?: number }).status;
    if (status === 403) return new Error(team ? 'Graph 403: reading channel messages needs ChannelMessage.Read.All, which your tenant admin must consent to' : 'Graph 403: reconnect Microsoft with Teams access (Account → Accounts)');
    if (status === 401) return new Error('Graph 401: reconnect Microsoft (Account → Accounts)');
    return err instanceof Error ? err : new Error(String(err));
  };

  const client: CommsClient = {
    type: 'teams',
    destRe: ID_RE,
    maxText: 4000,
    ops: OPS,
    async whoami(): Promise<Whoami> {
      await ensureSelf();
      return { id: self.id, name: self.name, extra: team ? { team } : undefined };
    },
    channels: listChannels,
    nameOf: (id) => names.get(id),
    async history(channel, limit) {
      await ensureSelf();
      const conv = need(channel, 'chat');
      try {
        const r = await call('GET', `${msgPath(conv)}?$top=${Math.min(Math.max(limit, 1), 50)}`);
        const out: ChatMessage[] = [];
        for (const raw of r?.value ?? []) {
          const m = toMessage(raw, conv, self.id);
          if (m) out.push(withName(m));
        }
        return out.sort((a, b) => a.at - b.at);
      } catch (err) {
        throw consent(err);
      }
    },
    async send(channel, text, opts: SendOpts = {}) {
      await ensureSelf();
      const conv = need(channel, 'chat');
      const path = team && opts.replyTo ? `${msgPath(conv)}/${enc(opts.replyTo)}/replies` : msgPath(conv);
      let r: any;
      try {
        r = await call('POST', path, { body: { contentType: 'text', content: text.slice(0, 4000) } });
      } catch (err) {
        throw consent(err);
      }
      const m = toMessage(r, conv, self.id) ?? { id: str(r?.id) || `t${Date.now()}`, channel: conv, from: { id: self.id, name: self.name }, text, at: Date.now() };
      return { ...withName(m), mine: true };
    },
    async react(channel, messageId, emoji) {
      await call('POST', `${msgPath(need(channel, 'chat'))}/${enc(need(messageId, 'message'))}/setReaction`, { reactionType: need(emoji, 'emoji') });
    },
    async read(what, a) {
      await ensureSelf();
      switch (what) {
        case 'chats':
        case 'channels':
          return listChannels();
        case 'teams':
          return ((await call('GET', '/me/joinedTeams'))?.value ?? []).map((t: any) => ({ id: t.id, name: t.displayName, description: t.description ?? '' }));
        case 'members': {
          const conv = need(a.channel, 'chat');
          const r = await call('GET', team ? `/teams/${enc(team)}/members` : `/chats/${enc(conv)}/members`);
          return (r?.value ?? []).map((m: any) => ({ membership: m.id, user: m.userId, name: m.displayName, email: m.email ?? undefined, roles: m.roles ?? [] }));
        }
        case 'replies': {
          if (!team) throw new Error('replies are a team-channel read');
          const r = await call('GET', `${msgPath(need(a.channel, 'channel'))}/${enc(need(a.message, 'message'))}/replies?$top=50`);
          return ((r?.value ?? []) as any[]).map((raw) => toMessage(raw, str(a.channel), self.id)).filter(Boolean);
        }
        default:
          throw new Error(`unknown read "${what}" — one of: ${OPS.read.join(', ')}`);
      }
    },
    async manage(op, a) {
      switch (op) {
        case 'create_channel': {
          if (!team) throw new Error('create_channel needs a team ward');
          const c = await call('POST', `/teams/${enc(team)}/channels`, { displayName: need(a.name, 'name').slice(0, 50), description: str(a.description) || undefined });
          names.set(str(c.id), str(c.displayName));
          return { id: c.id, name: c.displayName };
        }
        case 'set_topic':
          if (team) throw new Error('set_topic is for a group chat');
          await call('PATCH', `/chats/${enc(need(a.channel, 'chat'))}`, { topic: str(a.topic).slice(0, 250) });
          return { ok: true };
        case 'add_member':
          if (team) throw new Error('add_member is for a group chat');
          await call('POST', `/chats/${enc(need(a.channel, 'chat'))}/members`, {
            '@odata.type': '#microsoft.graph.aadUserConversationMember',
            roles: ['owner'],
            'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${need(a.user, 'user')}')`,
          });
          return { ok: true };
        default:
          throw new Error(`unknown op "${op}" — one of: ${OPS.manage.map((s) => s.split(' ')[0]).join(', ')}`);
      }
    },
    async moderate(op, a) {
      switch (op) {
        case 'delete_message':
          await call('POST', `${msgPath(need(a.channel, 'chat'))}/${enc(need(a.message, 'message'))}/softDelete`, {});
          return { ok: true };
        default:
          throw new Error(`unknown op "${op}" — one of: ${OPS.moderate.map((s) => s.split(' ')[0]).join(', ')}`);
      }
    },
    live(onEvent) {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let quiet = true;
      let ready = false;
      const watch = cfg.watch && cfg.watch !== 'all' ? cfg.watch.split(',').map((s) => s.trim()).filter(Boolean) : null;
      const tick = async () => {
        if (stopped) return;
        try {
          await ensureSelf();
          let targets = watch ?? (await listChannels()).map((c) => c.id);
          if (cfg.channel && !targets.includes(cfg.channel)) targets = [cfg.channel, ...targets];
          for (const conv of targets.slice(0, MAX_POLL)) {
            const r = await call('GET', `${msgPath(conv)}?$top=20`);
            const batch: ChatMessage[] = [];
            for (const raw of r?.value ?? []) {
              const m = toMessage(raw, conv, self.id);
              if (m && !m.mine && !m.bot) batch.push(withName(m));
            }
            for (const message of batch.sort((a, b) => a.at - b.at)) onEvent(quiet ? { type: 'message', message, quiet: true } : { type: 'message', message });
          }
          if (!ready) {
            ready = true;
            onEvent({ type: 'state', status: 'ready' });
          }
          quiet = false;
        } catch (err) {
          const e = consent(err);
          onEvent({ type: 'state', status: 'error', error: e.message });
          if ((err as { status?: number }).status === 401) return;
        }
        if (stopped) return;
        timer = setTimeout(() => void tick(), POLL_MS);
        (timer as { unref?: () => void }).unref?.();
      };
      onEvent({ type: 'state', status: 'connecting' });
      void tick();
      return () => {
        stopped = true;
        clearTimeout(timer);
        onEvent({ type: 'state', status: 'closed' });
      };
    },
  };
  return client;
}

export const pollEventsForTests = (msgs: ChatMessage[]): CommsEvent[] => msgs.map((message) => ({ type: 'message', message }));
export const notSupported = (what: string): never => unsupported('teams', what);
