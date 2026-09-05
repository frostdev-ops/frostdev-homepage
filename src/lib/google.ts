import { liveToken } from './linked-accounts.ts';
import { cached } from './cache.ts';
import type { MailAccount } from './wards.ts';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CAL = 'https://www.googleapis.com/calendar/v3';

async function api<T>(token: string, url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`google api ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export interface MailMessage {
  id: string;
  threadId?: string;
  from: { name: string; address: string };
  subject: string;
  snippet: string;
  at: string;
  unread: boolean;
  starred: boolean;
  hasAttachments: boolean;
  /** Which mailbox it came from — set by the merged inbox (lib/mail.ts). */
  account?: MailAccount;
}

/** "Display Name <a@b.com>" | "a@b.com" → parts. */
export function parseAddress(raw: string): { name: string; address: string } {
  const m = raw.match(/^\s*(?:"?([^"<]*)"?\s*)?<([^>]+)>\s*$/);
  if (m) return { name: (m[1] ?? '').trim(), address: m[2]!.trim() };
  return { name: '', address: raw.trim() };
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

interface GmailMeta {
  id: string;
  threadId: string;
  snippet?: string;
  labelIds?: string[];
  payload?: GmailPart;
}

function header(msg: GmailMeta, name: string): string {
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

export function gmailInbox(userId: number, limit: number): Promise<MailMessage[]> {
  return cached(`gmail:inbox:${userId}:${limit}`, 60_000, async () => {
    const token = await liveToken(userId, 'google');
    const list = await api<{ messages?: { id: string }[] }>(
      token,
      `${GMAIL}/messages?labelIds=INBOX&maxResults=${limit}`
    );
    const ids = (list.messages ?? []).map((m) => m.id);
    const metas = await Promise.all(
      ids.map((id) =>
        api<GmailMeta>(
          token,
          `${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`
        )
      )
    );
    return metas.map((m) => ({
      id: m.id,
      threadId: m.threadId,
      from: parseAddress(header(m, 'From')),
      subject: header(m, 'Subject'),
      snippet: m.snippet ?? '',
      at: new Date(header(m, 'Date') || Date.now()).toISOString(),
      unread: m.labelIds?.includes('UNREAD') ?? false,
      starred: m.labelIds?.includes('STARRED') ?? false,
      // format=metadata may omit parts; degrades to false — never worse than before.
      hasAttachments: (m.payload?.parts ?? []).some((p) => !!p.filename),
    }));
  });
}

export function gmailUnreadCount(userId: number): Promise<number> {
  return cached(`gmail:unread:${userId}`, 60_000, async () => {
    const token = await liveToken(userId, 'google');
    const label = await api<{ messagesUnread?: number }>(token, `${GMAIL}/labels/INBOX`);
    return label.messagesUnread ?? 0;
  });
}

/** The reply headers Gmail threading needs, fetched at draft time. */
export async function gmailReplyContext(
  userId: number,
  messageId: string
): Promise<{ threadId: string; messageIdHeader: string; subject: string; fromAddress: string }> {
  const token = await liveToken(userId, 'google');
  const m = await api<GmailMeta>(
    token,
    `${GMAIL}/messages/${messageId}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=Subject&metadataHeaders=From`
  );
  return {
    threadId: m.threadId,
    messageIdHeader: header(m, 'Message-ID'),
    subject: header(m, 'Subject'),
    fromAddress: parseAddress(header(m, 'From')).address,
  };
}

export async function gmailSendRaw(userId: number, raw: string, threadId?: string): Promise<string> {
  const token = await liveToken(userId, 'google');
  const res = await api<{ id: string }>(token, `${GMAIL}/messages/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(threadId ? { raw, threadId } : { raw }),
  });
  return res.id;
}

export interface CalEvent {
  id: string;
  source: 'google' | 'microsoft' | 'notion' | 'icloud';
  calendar: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  /** A meeting link (Meet, Teams…), when the provider carries one. */
  joinUrl?: string;
}

export function googleCalendar(userId: number, days: number): Promise<CalEvent[]> {
  return cached(`gcal:${userId}:${days}`, 5 * 60_000, async () => {
    const token = await liveToken(userId, 'google');
    const now = new Date();
    const max = new Date(now.getTime() + days * 86_400_000);
    const data = await api<{
      items?: {
        id: string;
        summary?: string;
        location?: string;
        start?: { date?: string; dateTime?: string };
        end?: { date?: string; dateTime?: string };
        hangoutLink?: string;
      }[];
    }>(
      token,
      `${CAL}/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=50&timeMin=${encodeURIComponent(now.toISOString())}&timeMax=${encodeURIComponent(max.toISOString())}`
    );
    return (data.items ?? []).map((ev) => ({
      id: ev.id,
      source: 'google' as const,
      calendar: 'primary',
      title: ev.summary ?? '',
      start: ev.start?.dateTime ?? (ev.start?.date ? `${ev.start.date}T00:00:00` : ''),
      end: ev.end?.dateTime ?? (ev.end?.date ? `${ev.end.date}T00:00:00` : ''),
      allDay: !ev.start?.dateTime,
      location: ev.location ?? '',
      ...(ev.hangoutLink ? { joinUrl: ev.hangoutLink } : {}),
    }));
  });
}

// ------------------------------------------------------- reading one message

export interface MailAttachment {
  id: string;
  name: string;
  size: number;
  mime: string;
}

export interface MailBody {
  id: string;
  subject: string;
  from: { name: string; address: string };
  to: { name: string; address: string }[];
  cc: { name: string; address: string }[];
  at: string;
  unread: boolean;
  starred: boolean;
  /** Raw provider HTML — the caller sanitizes. Empty when text-only. */
  html: string;
  text: string;
  attachments: MailAttachment[];
}

const addrList = (raw: string): { name: string; address: string }[] =>
  // Split on commas outside quotes/angles — enough for real From/To headers.
  raw
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseAddress);

/** Depth-first walk collecting the best text/html and text/plain, plus files. */
function walk(part: GmailPart, out: { html: string; text: string; att: MailAttachment[] }): void {
  const mime = (part.mimeType ?? '').toLowerCase();
  const data = part.body?.data;
  if (part.filename && part.body?.attachmentId) {
    out.att.push({
      id: part.body.attachmentId,
      name: part.filename,
      size: part.body.size ?? 0,
      mime: mime || 'application/octet-stream',
    });
  } else if (data && mime === 'text/html' && !out.html) {
    out.html = Buffer.from(data, 'base64url').toString('utf8');
  } else if (data && mime === 'text/plain' && !out.text) {
    out.text = Buffer.from(data, 'base64url').toString('utf8');
  }
  for (const child of part.parts ?? []) walk(child, out);
}

export async function gmailMessage(userId: number, id: string): Promise<MailBody> {
  const token = await liveToken(userId, 'google');
  const m = await api<GmailMeta>(token, `${GMAIL}/messages/${encodeURIComponent(id)}?format=full`);
  const parts = { html: '', text: '', att: [] as MailAttachment[] };
  if (m.payload) walk(m.payload, parts);
  return {
    id: m.id,
    subject: header(m, 'Subject'),
    from: parseAddress(header(m, 'From')),
    to: addrList(header(m, 'To')),
    cc: addrList(header(m, 'Cc')),
    at: new Date(header(m, 'Date') || Date.now()).toISOString(),
    unread: m.labelIds?.includes('UNREAD') ?? false,
    starred: m.labelIds?.includes('STARRED') ?? false,
    html: parts.html,
    text: parts.text,
    attachments: parts.att,
  };
}

export async function gmailAttachment(
  userId: number,
  messageId: string,
  attachmentId: string
): Promise<Buffer> {
  const token = await liveToken(userId, 'google');
  const a = await api<{ data?: string }>(
    token,
    `${GMAIL}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
  );
  return Buffer.from(a.data ?? '', 'base64url');
}

export type MailOp = 'read' | 'unread' | 'star' | 'unstar' | 'archive' | 'trash';

const GMAIL_LABELS: Record<Exclude<MailOp, 'trash'>, { addLabelIds?: string[]; removeLabelIds?: string[] }> = {
  read: { removeLabelIds: ['UNREAD'] },
  unread: { addLabelIds: ['UNREAD'] },
  star: { addLabelIds: ['STARRED'] },
  unstar: { removeLabelIds: ['STARRED'] },
  archive: { removeLabelIds: ['INBOX'] },
};

export async function gmailModify(userId: number, id: string, op: MailOp): Promise<void> {
  const token = await liveToken(userId, 'google');
  const path = `${GMAIL}/messages/${encodeURIComponent(id)}`;
  await api(token, op === 'trash' ? `${path}/trash` : `${path}/modify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(op === 'trash' ? {} : GMAIL_LABELS[op]),
  });
}
