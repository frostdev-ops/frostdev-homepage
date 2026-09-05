import type { ChatChannel, ChatMessage, CommsClient, CommsEvent, Whoami } from './types.ts';
import { unsupported } from './types.ts';

// Twilio SMS and WhatsApp over the Messages REST resource: basic auth with
// the account SID (config) and the auth token (sealed), plain fetch to
// api.twilio.com. Inbound is a 30s poll of the Messages list for the ward's
// number — no public webhook route, on purpose. A message is a conversation
// with one counterpart number, so the "channel" IS that number; every text
// is addressed to the bot (mention=yes), and only numbers on the ward's
// allow list are stored or fired — an SMS to a stranger costs money.

const API = 'https://api.twilio.com/2010-04-01';
const POLL_MS = 30_000;
type Fetch = typeof fetch;

export interface TwilioConfig {
  sid: string;
  /** The Twilio number the ward speaks from: +E.164, or whatsapp:+E.164. */
  from: string;
  channel: string;
}

export const NUMBER_RE = /^(whatsapp:)?\+\d{7,15}$/;
const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

/** A Messages resource → ChatMessage. The counterpart number is the channel. */
export function toMessage(r: any, from: string): ChatMessage {
  const inbound = r.direction === 'inbound';
  const counterpart = str(inbound ? r.from : r.to);
  const m: ChatMessage = {
    id: str(r.sid),
    channel: counterpart,
    channelName: counterpart,
    from: { id: inbound ? counterpart : from, name: inbound ? counterpart : 'bot' },
    text: str(r.body),
    at: Date.parse(str(r.date_sent) || str(r.date_created)) || Date.now(),
  };
  const media = Number(r.num_media) || 0;
  if (media) m.attachments = Array.from({ length: Math.min(media, 10) }, (_, i) => ({ url: '', name: `media ${i + 1}` }));
  if (inbound) m.mention = true;
  else m.mine = true;
  return m;
}

async function rest(sid: string, token: string, method: string, path: string, form: Record<string, string> | undefined, fetchImpl: Fetch): Promise<any> {
  const res = await fetchImpl(`${API}/Accounts/${sid}${path}`, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
      ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => null)) as any;
  if (!res.ok) {
    const err = new Error(`Twilio ${res.status}: ${json?.message ?? res.statusText}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return json;
}

const OPS = {
  read: ['numbers (the account\'s phone numbers)', 'message {message}', 'balance'],
  manage: [],
  moderate: [],
};

export function twilioClient(token: string, cfg: TwilioConfig, _key: string, fetchImpl: Fetch = fetch): CommsClient {
  const call = (method: string, path: string, form?: Record<string, string>) => rest(cfg.sid, token, method, path, form, fetchImpl);
  const whatsapp = cfg.from.startsWith('whatsapp:');
  /** A bare number on a WhatsApp sender gets the prefix; a WhatsApp address on an SMS sender is refused by Twilio itself. */
  const dest = (to: string) => (whatsapp && !to.startsWith('whatsapp:') ? `whatsapp:${to}` : to);
  const need = () => {
    if (!/^AC[0-9a-f]{32}$/i.test(cfg.sid) || !NUMBER_RE.test(cfg.from)) throw new Error('set the account SID and the Twilio number under ⚙ Configure');
  };
  const inbox = async (): Promise<ChatMessage[]> => {
    need();
    const r = await call('GET', `/Messages.json?To=${encodeURIComponent(cfg.from)}&PageSize=50`);
    return ((r?.messages ?? []) as any[]).filter((x) => x.direction === 'inbound').map((x) => toMessage(x, cfg.from));
  };

  const client: CommsClient = {
    type: 'twilio',
    destRe: NUMBER_RE,
    maxText: 1600,
    ops: OPS,
    async whoami(): Promise<Whoami> {
      need();
      const acct = await call('GET', '.json');
      return { id: cfg.sid, name: str(acct?.friendly_name) || cfg.sid, extra: { from: cfg.from } };
    },
    channels: async (): Promise<ChatChannel[]> => [],
    nameOf: (id) => id,
    async history(channel, limit) {
      need();
      const to = dest(channel);
      const [inb, out] = await Promise.all([
        call('GET', `/Messages.json?From=${encodeURIComponent(to)}&To=${encodeURIComponent(cfg.from)}&PageSize=${Math.min(limit, 50)}`),
        call('GET', `/Messages.json?From=${encodeURIComponent(cfg.from)}&To=${encodeURIComponent(to)}&PageSize=${Math.min(limit, 50)}`),
      ]);
      return [...((inb?.messages ?? []) as any[]), ...((out?.messages ?? []) as any[])].map((x) => toMessage(x, cfg.from)).sort((a, b) => a.at - b.at);
    },
    async send(channel, text) {
      need();
      const r = await call('POST', '/Messages.json', { To: dest(channel), From: cfg.from, Body: text.slice(0, 1600) });
      return { ...toMessage({ ...r, direction: 'outbound-api' }, cfg.from), mine: true };
    },
    react: async () => unsupported('twilio', 'reactions'),
    async read(what, a) {
      need();
      switch (what) {
        case 'numbers':
          return ((await call('GET', '/IncomingPhoneNumbers.json?PageSize=50'))?.incoming_phone_numbers ?? []).map((n: any) => ({ number: n.phone_number, name: n.friendly_name, sms: !!n.capabilities?.sms, mms: !!n.capabilities?.mms }));
        case 'message':
          return toMessage(await call('GET', `/Messages/${encodeURIComponent(str(a.message))}.json`), cfg.from);
        case 'balance': {
          const b = await call('GET', '/Balance.json');
          return { balance: b?.balance, currency: b?.currency };
        }
        default:
          throw new Error(`unknown read "${what}" — one of: ${OPS.read.join(', ')}`);
      }
    },
    manage: async () => unsupported('twilio', 'server management'),
    moderate: async () => unsupported('twilio', 'moderation'),
    live(onEvent) {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let quiet = true;
      let ready = false;
      const tick = async () => {
        if (stopped) return;
        try {
          const msgs = await inbox();
          if (!ready) {
            ready = true;
            onEvent({ type: 'state', status: 'ready' });
          }
          for (const message of msgs.sort((a, b) => a.at - b.at)) onEvent(quiet ? { type: 'message', message, quiet: true } : { type: 'message', message });
          quiet = false;
        } catch (err) {
          const status = (err as { status?: number }).status;
          if (status === 401 || status === 403) {
            onEvent({ type: 'state', status: 'error', error: 'Twilio refused the account SID / auth token' });
            return;
          }
          onEvent({ type: 'state', status: 'error', error: err instanceof Error ? err.message : String(err) });
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

/** Exported for tests: the events one poll batch means. */
export const pollEvents = (msgs: ChatMessage[], quiet: boolean): CommsEvent[] => msgs.map((message) => (quiet ? { type: 'message', message, quiet: true } : { type: 'message', message }));
