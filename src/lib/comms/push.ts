import { guardedFetch } from './guarded.ts';
import type { ChatMessage, CommsClient, Whoami } from './types.ts';
import { unsupported } from './types.ts';

// Push notifications — outbound only. ntfy (any server, the user's own or
// ntfy.sh, so the guarded fetch; an access token optional) or Pushover (a
// fixed host; the app token sealed, the user key is the destination). The
// first line of a multi-line text is the title. No feed, no live, no ops:
// chat.send and agent.ask's deliverTo are what a push ward is for.

const PUSHOVER = 'https://api.pushover.net/1';
type Fetch = typeof fetch;

export interface PushConfig {
  service: 'ntfy' | 'pushover';
  /** ntfy only: the server, default https://ntfy.sh. */
  server: string;
  /** The topic (ntfy) or the user key (Pushover). */
  channel: string;
}

export const TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const USER_KEY_RE = /^[A-Za-z0-9]{30}$/;

/** "Title\nbody…" → the two halves; a single line is all body. */
export function splitTitle(text: string): { title: string; body: string } {
  const nl = text.indexOf('\n');
  if (nl > 0 && nl <= 100) return { title: text.slice(0, nl).trim(), body: text.slice(nl + 1).trim() };
  return { title: '', body: text.trim() };
}

/** ntfy's Title header is a plain header: non-ASCII goes RFC 2047 encoded. */
const headerText = (s: string): string => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);

export function pushClient(token: string, cfg: PushConfig, _key: string, fetchImpl?: Fetch): CommsClient {
  const ntfy = cfg.service === 'ntfy';
  const doFetch: Fetch = fetchImpl ?? (ntfy ? guardedFetch : fetch);
  const server = (cfg.server || 'https://ntfy.sh').replace(/\/+$/, '');
  let n = 0;
  const client: CommsClient = {
    type: 'push',
    destRe: ntfy ? TOPIC_RE : USER_KEY_RE,
    maxText: ntfy ? 4000 : 1024,
    ops: { read: [], manage: [], moderate: [] },
    async whoami(): Promise<Whoami> {
      if (ntfy) return { id: server, name: `ntfy · ${server.replace(/^https?:\/\//, '')}` };
      if (!token) throw new Error('Pushover needs an application token — paste it on the ward');
      const res = await doFetch(`${PUSHOVER}/users/validate.json`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token, user: cfg.channel }).toString(), signal: AbortSignal.timeout(15_000) });
      const j = (await res.json().catch(() => null)) as any;
      if (!res.ok || j?.status !== 1) throw new Error(`Pushover: ${(j?.errors ?? []).join(', ') || res.statusText}`);
      return { id: cfg.channel, name: `Pushover · ${(j.devices ?? []).join(', ') || 'all devices'}` };
    },
    channels: async () => [],
    nameOf: () => undefined,
    history: async () => [],
    async send(channel, text) {
      const { title, body } = splitTitle(text);
      const at = Date.now();
      const id = `push-${at}-${++n}`;
      if (ntfy) {
        const headers: Record<string, string> = { 'content-type': 'text/plain; charset=utf-8' };
        if (title) headers.title = headerText(title);
        if (token) headers.authorization = `Bearer ${token}`;
        const res = await doFetch(`${server}/${channel}`, { method: 'POST', headers, body: body || title, signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`ntfy ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200) || res.statusText}`);
      } else {
        if (!token) throw new Error('Pushover needs an application token — paste it on the ward');
        const form = new URLSearchParams({ token, user: channel, message: body || title });
        if (title) form.set('title', title);
        const res = await doFetch(`${PUSHOVER}/messages.json`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString(), signal: AbortSignal.timeout(15_000) });
        const j = (await res.json().catch(() => null)) as any;
        if (!res.ok || j?.status !== 1) throw new Error(`Pushover: ${(j?.errors ?? []).join(', ') || res.statusText}`);
      }
      const m: ChatMessage = { id, channel, channelName: ntfy ? `#${channel}` : 'Pushover', from: { id: 'bot', name: 'bot' }, text, at, mine: true };
      return m;
    },
    react: async () => unsupported('push', 'reactions'),
    read: async () => unsupported('push', 'reads'),
    manage: async () => unsupported('push', 'management'),
    moderate: async () => unsupported('push', 'moderation'),
    live(onEvent) {
      onEvent({ type: 'state', status: 'ready' });
      return () => {};
    },
  };
  return client;
}
