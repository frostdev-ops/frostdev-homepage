import { getLink, getMeta, liveToken, ReconnectError } from './linked-accounts.ts';
import { cached } from './cache.ts';
import { parseAddress } from './google.ts';
import type { MailMessage, MailBody, MailAttachment, MailOp } from './google.ts';

// Zoho Mail, ported from PMA Office's /mail. The wire notes that matter:
//   header   Authorization: Zoho-oauthtoken <token>   (not Bearer)
//   list     GET  /api/accounts/{acc}/messages/view?folderId=&start=&limit=
//   content  GET  /api/accounts/{acc}/folders/{f}/messages/{m}/content
//   details  GET  /api/accounts/{acc}/folders/{f}/messages/{m}/details
//   send     POST /api/accounts/{acc}/messages
//   reply    POST /api/accounts/{acc}/messages/{m}   { action: 'reply', … }
//   ops      PUT  /api/accounts/{acc}/updatemessage  { mode, messageId: [] }
//
// A Zoho message is addressed by (folderId, messageId), but every route here
// hands the ward ONE opaque id — so ids on the wire are `folderId:messageId`.
// Ids stay strings: Zoho's are 19 digits, past Number.MAX_SAFE_INTEGER.

/** Zoho data centres. The OAuth callback reports `location`; the Mail API host
 *  follows it. Unknown locations fall back to .com. */
export const ZOHO_API_BASES: Record<string, string> = {
  us: 'https://mail.zoho.com',
  eu: 'https://mail.zoho.eu',
  in: 'https://mail.zoho.in',
  au: 'https://mail.zoho.com.au',
  jp: 'https://mail.zoho.jp',
  ca: 'https://mail.zohocloud.ca',
};

interface Ctx {
  userId: number;
  token: string;
  apiBase: string;
  accountId: string;
  email: string;
}

async function ctx(userId: number): Promise<Ctx> {
  const link = getLink(userId, 'zoho');
  if (!link) throw new ReconnectError('zoho');
  const meta = getMeta(link);
  return {
    userId,
    token: await liveToken(userId, 'zoho'),
    apiBase: String(meta.api_base ?? ZOHO_API_BASES.us),
    accountId: String(meta.account_id ?? ''),
    email: link.account_label,
  };
}

async function api<T>(c: Ctx, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${c.apiBase}/api${path}`, {
    ...init,
    headers: {
      authorization: `Zoho-oauthtoken ${c.token}`,
      accept: 'application/json',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json().catch(() => ({}))) as { status?: { description?: string }; data?: T };
  if (res.status === 401) throw new ReconnectError('zoho');
  if (!res.ok) throw new Error(`zoho mail ${res.status}: ${data.status?.description ?? ''}`);
  return data.data as T;
}

/** The one place a Zoho account is looked up outside a mailbox call — the
 *  connect callback, which has a token but no stored link yet. */
export async function zohoPrimaryAccount(
  apiBase: string,
  token: string
): Promise<{ accountId: string; email: string }> {
  const res = await fetch(`${apiBase}/api/accounts`, {
    headers: { authorization: `Zoho-oauthtoken ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json().catch(() => ({}))) as {
    data?: { accountId?: string; primaryEmailAddress?: string; mailboxAddress?: string; incomingUserName?: string }[];
  };
  const acc = data.data?.[0];
  if (!res.ok || !acc?.accountId) throw new Error('no Zoho Mail account on that login');
  return {
    accountId: String(acc.accountId),
    email: acc.primaryEmailAddress ?? acc.mailboxAddress ?? acc.incomingUserName ?? 'zoho',
  };
}

// Zoho's REST API returns its text fields HTML-ENCODED — a sender of
// '"Jane" <jane@x.com>' arrives as '&quot;Jane&quot; &lt;jane@x.com&gt;'.
// Decode once, right here at the boundary, or the escaping leaks into every
// address match and every screen.
const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s: string | undefined | null): string {
  return String(s ?? '').replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, ent: string) => {
    const e = ent.toLowerCase();
    if (e.startsWith('#x')) {
      const c = parseInt(e.slice(2), 16);
      return Number.isFinite(c) && c > 0 ? String.fromCodePoint(c) : whole;
    }
    if (e.startsWith('#')) {
      const c = parseInt(e.slice(1), 10);
      return Number.isFinite(c) && c > 0 ? String.fromCodePoint(c) : whole;
    }
    return ENTITY[e] ?? whole;
  });
}

const addr = (raw: unknown) => parseAddress(decodeEntities(raw as string));
const addrList = (raw: unknown) =>
  decodeEntities(raw as string)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseAddress(s));

interface ZohoRow {
  messageId: string;
  folderId: string;
  sender?: string;
  fromAddress?: string;
  toAddress?: string;
  ccAddress?: string;
  subject?: string;
  summary?: string;
  receivedTime?: string; // epoch ms, as a string
  status?: string; // '0' unread, '1' read
  hasAttachment?: string; // '0' | '1'
  flagid?: string;
}

/** `folderId:messageId` → its parts. */
function split(id: string): { folderId: string; messageId: string } {
  const at = id.indexOf(':');
  if (at < 1) throw new Error('bad zoho message id');
  return { folderId: id.slice(0, at), messageId: id.slice(at + 1) };
}

const isStarred = (flag?: string): boolean => !!flag && flag !== 'flag_not_set';

function row(m: ZohoRow): MailMessage {
  return {
    id: `${m.folderId}:${m.messageId}`,
    from: m.sender ? { ...addr(m.fromAddress), name: decodeEntities(m.sender) } : addr(m.fromAddress),
    subject: decodeEntities(m.subject),
    snippet: decodeEntities(m.summary).slice(0, 300),
    at: new Date(Number(m.receivedTime) || Date.now()).toISOString(),
    unread: m.status === '0',
    starred: isStarred(m.flagid),
    hasAttachments: m.hasAttachment === '1',
  };
}

// ------------------------------------------------------------------ folders

interface ZohoFolder {
  folderId: string;
  folderName: string;
  folderType?: string;
  unreadCount?: number;
}

/** Folders change rarely and every read needs the inbox id — one 5-minute
 *  cache serves the ward, the unread count and the trash lookup. */
function folders(c: Ctx): Promise<ZohoFolder[]> {
  return cached(`zoho:folders:${c.userId}`, 5 * 60_000, async () =>
    (await api<ZohoFolder[]>(c, `/accounts/${c.accountId}/folders`)) ?? []
  );
}

async function folderOfType(c: Ctx, type: string, name: RegExp): Promise<ZohoFolder> {
  const list = await folders(c);
  const hit = list.find((f) => f.folderType === type) ?? list.find((f) => name.test(f.folderName));
  if (!hit) throw new Error(`zoho mailbox has no ${type} folder`);
  return hit;
}

// -------------------------------------------------------------------- reads

export function zohoInbox(userId: number, limit: number): Promise<MailMessage[]> {
  return cached(`zoho:inbox:${userId}:${limit}`, 60_000, async () => {
    const c = await ctx(userId);
    const inbox = await folderOfType(c, 'Inbox', /^inbox$/i);
    const q = new URLSearchParams({ folderId: inbox.folderId, start: '1', limit: String(limit), includeto: 'true' });
    const rows = (await api<ZohoRow[]>(c, `/accounts/${c.accountId}/messages/view?${q}`)) ?? [];
    return rows.map(row);
  });
}

export function zohoUnreadCount(userId: number): Promise<number> {
  return cached(`zoho:unread:${userId}`, 60_000, async () => {
    const c = await ctx(userId);
    return (await folderOfType(c, 'Inbox', /^inbox$/i)).unreadCount ?? 0;
  });
}

export async function zohoMessage(userId: number, id: string): Promise<MailBody> {
  const c = await ctx(userId);
  const { folderId, messageId } = split(id);
  const base = `/accounts/${c.accountId}/folders/${encodeURIComponent(folderId)}/messages/${encodeURIComponent(messageId)}`;
  const [details, content, attachments] = await Promise.all([
    api<ZohoRow>(c, `${base}/details`).catch(() => ({}) as ZohoRow),
    api<{ content?: string }>(c, `${base}/content`).catch(() => ({}) as { content?: string }),
    api<{ attachments?: { attachmentId: string; attachmentName?: string; attachmentSize?: number }[] }>(
      c,
      `${base}/attachmentinfo`
    ).catch(() => ({ attachments: [] })),
  ]);
  return {
    id,
    subject: decodeEntities(details.subject),
    from: details.sender
      ? { ...addr(details.fromAddress), name: decodeEntities(details.sender) }
      : addr(details.fromAddress),
    to: addrList(details.toAddress),
    cc: addrList(details.ccAddress),
    at: new Date(Number(details.receivedTime) || Date.now()).toISOString(),
    unread: details.status === '0',
    starred: isStarred(details.flagid),
    // Zoho serves the body as HTML whatever the source was.
    html: content.content ?? '',
    text: '',
    attachments: (attachments.attachments ?? []).map<MailAttachment>((a) => ({
      id: a.attachmentId,
      name: decodeEntities(a.attachmentName) || 'attachment',
      size: a.attachmentSize ?? 0,
      mime: 'application/octet-stream',
    })),
  };
}

export async function zohoAttachment(userId: number, id: string, attachmentId: string): Promise<Buffer> {
  const c = await ctx(userId);
  const { folderId, messageId } = split(id);
  const res = await fetch(
    `${c.apiBase}/api/accounts/${c.accountId}/folders/${encodeURIComponent(folderId)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    { headers: { authorization: `Zoho-oauthtoken ${c.token}` }, signal: AbortSignal.timeout(60_000) }
  );
  if (!res.ok) throw new Error(`zoho attachment ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ------------------------------------------------------------------- writes

/** Every bulk op rides PUT /updatemessage with a mode discriminator. */
function update(c: Ctx, body: Record<string, unknown>): Promise<unknown> {
  return api(c, `/accounts/${c.accountId}/updatemessage`, { method: 'PUT', body: JSON.stringify(body) });
}

export async function zohoModify(userId: number, id: string, op: MailOp): Promise<void> {
  const c = await ctx(userId);
  const messageId = [split(id).messageId];
  if (op === 'read' || op === 'unread') {
    await update(c, { mode: op === 'read' ? 'markAsRead' : 'markAsUnread', messageId });
  } else if (op === 'star' || op === 'unstar') {
    // Zoho has no star; 'important' is the flag its own UI shows as one.
    await update(c, { mode: 'setFlag', flagid: op === 'star' ? 'important' : 'flag_not_set', messageId });
  } else if (op === 'archive') {
    await update(c, { mode: 'archiveMails', messageId });
  } else {
    const trash = await folderOfType(c, 'Trash', /^(trash|deleted)/i);
    await update(c, { mode: 'moveMessage', destfolderId: trash.folderId, messageId });
  }
}

export async function zohoSend(
  userId: number,
  m: { to: string[]; cc: string[]; subject: string; body: string }
): Promise<void> {
  const c = await ctx(userId);
  await api(c, `/accounts/${c.accountId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      fromAddress: c.email,
      toAddress: m.to.join(','),
      ...(m.cc.length ? { ccAddress: m.cc.join(',') } : {}),
      subject: m.subject,
      content: m.body,
      mailFormat: 'plaintext',
    }),
  });
}

export async function zohoReply(
  userId: number,
  id: string,
  m: { to: string[]; cc: string[]; subject: string; body: string }
): Promise<void> {
  const c = await ctx(userId);
  await api(c, `/accounts/${c.accountId}/messages/${encodeURIComponent(split(id).messageId)}`, {
    method: 'POST',
    body: JSON.stringify({
      action: 'reply',
      fromAddress: c.email,
      toAddress: m.to.join(','),
      ...(m.cc.length ? { ccAddress: m.cc.join(',') } : {}),
      subject: m.subject,
      content: m.body,
      mailFormat: 'plaintext',
    }),
  });
}
