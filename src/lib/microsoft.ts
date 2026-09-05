import { liveToken } from './linked-accounts.ts';
import { cached } from './cache.ts';
import type { MailMessage, CalEvent, MailBody, MailAttachment, MailOp } from './google.ts';

const GRAPH = 'https://graph.microsoft.com/v1.0';

async function api<T>(token: string, path: string, init?: RequestInit): Promise<T | null> {
  const res = await fetch(`${GRAPH}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 202 || res.status === 204) return null; // sendMail/reply return no body
  if (!res.ok) throw new Error(`graph api ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

interface GraphMessage {
  id: string;
  subject?: string;
  bodyPreview?: string;
  receivedDateTime?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  flag?: { flagStatus?: string };
  from?: { emailAddress?: { name?: string; address?: string } };
}

export function outlookInbox(userId: number, limit: number): Promise<MailMessage[]> {
  return cached(`outlook:inbox:${userId}:${limit}`, 60_000, async () => {
    const token = await liveToken(userId, 'microsoft');
    const data = await api<{ value: GraphMessage[] }>(
      token,
      `/me/mailFolders/inbox/messages?$top=${limit}&$select=id,from,subject,bodyPreview,receivedDateTime,isRead,hasAttachments,flag&$orderby=receivedDateTime desc`
    );
    return (data?.value ?? []).map((m) => ({
      id: m.id,
      from: { name: m.from?.emailAddress?.name ?? '', address: m.from?.emailAddress?.address ?? '' },
      subject: m.subject ?? '',
      snippet: m.bodyPreview ?? '',
      at: m.receivedDateTime ?? new Date().toISOString(),
      unread: !(m.isRead ?? true),
      starred: (m.flag?.flagStatus ?? 'notFlagged') === 'flagged',
      hasAttachments: m.hasAttachments ?? false,
    }));
  });
}

export function outlookUnreadCount(userId: number): Promise<number> {
  return cached(`outlook:unread:${userId}`, 60_000, async () => {
    const token = await liveToken(userId, 'microsoft');
    const data = await api<{ unreadItemCount?: number }>(token, '/me/mailFolders/inbox?$select=unreadItemCount');
    return data?.unreadItemCount ?? 0;
  });
}

export function outlookCalendar(userId: number, days: number): Promise<CalEvent[]> {
  return cached(`mscal:${userId}:${days}`, 5 * 60_000, async () => {
    const token = await liveToken(userId, 'microsoft');
    const now = new Date();
    const max = new Date(now.getTime() + days * 86_400_000);
    const data = await api<{
      value: {
        id: string;
        subject?: string;
        isAllDay?: boolean;
        location?: { displayName?: string };
        start?: { dateTime?: string; timeZone?: string };
        end?: { dateTime?: string; timeZone?: string };
        onlineMeeting?: { joinUrl?: string } | null;
        onlineMeetingUrl?: string | null;
      }[];
    }>(
      token,
      `/me/calendarView?startDateTime=${encodeURIComponent(now.toISOString())}&endDateTime=${encodeURIComponent(max.toISOString())}&$select=subject,start,end,isAllDay,location,onlineMeeting,onlineMeetingUrl&$orderby=start/dateTime&$top=50`
    );
    // Graph returns naive datetimes in UTC by default.
    const iso = (dt?: { dateTime?: string }) => (dt?.dateTime ? `${dt.dateTime.replace(/\.\d+$/, '')}Z` : '');
    return (data?.value ?? []).map((ev) => ({
      id: ev.id,
      source: 'microsoft' as const,
      calendar: 'outlook',
      title: ev.subject ?? '',
      start: iso(ev.start),
      end: iso(ev.end),
      allDay: ev.isAllDay ?? false,
      location: ev.location?.displayName ?? '',
      ...(ev.onlineMeeting?.joinUrl || ev.onlineMeetingUrl ? { joinUrl: ev.onlineMeeting?.joinUrl ?? ev.onlineMeetingUrl! } : {}),
    }));
  });
}

export async function outlookSend(
  userId: number,
  opts: { to: string[]; cc: string[]; subject: string; body: string }
): Promise<void> {
  const token = await liveToken(userId, 'microsoft');
  await api(token, '/me/sendMail', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: opts.subject,
        body: { contentType: 'Text', content: opts.body },
        toRecipients: opts.to.map((address) => ({ emailAddress: { address } })),
        ccRecipients: opts.cc.map((address) => ({ emailAddress: { address } })),
      },
      saveToSentItems: true,
    }),
  });
}

/** Graph handles threading itself; the comment is the reply body. Passing
 *  recipients overrides who it goes to, which is what makes reply-all work —
 *  bare /reply always answers the sender alone. */
export async function outlookReply(
  userId: number,
  messageId: string,
  comment: string,
  to: string[] = [],
  cc: string[] = []
): Promise<void> {
  const token = await liveToken(userId, 'microsoft');
  const recipients = (list: string[]) => list.map((address) => ({ emailAddress: { address } }));
  await api(token, `/me/messages/${encodeURIComponent(messageId)}/reply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      comment,
      ...(to.length ? { message: { toRecipients: recipients(to), ccRecipients: recipients(cc) } } : {}),
    }),
  });
}

// ------------------------------------------------------- reading one message

interface GraphAddr {
  emailAddress?: { name?: string; address?: string };
}
const addr = (a?: GraphAddr) => ({ name: a?.emailAddress?.name ?? '', address: a?.emailAddress?.address ?? '' });

export async function outlookMessage(userId: number, id: string): Promise<MailBody> {
  const token = await liveToken(userId, 'microsoft');
  const path = `/me/messages/${encodeURIComponent(id)}`;
  const m = await api<{
    id: string;
    subject?: string;
    receivedDateTime?: string;
    isRead?: boolean;
    hasAttachments?: boolean;
    flag?: { flagStatus?: string };
    from?: GraphAddr;
    toRecipients?: GraphAddr[];
    ccRecipients?: GraphAddr[];
    body?: { contentType?: string; content?: string };
  }>(token, `${path}?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,hasAttachments,flag,body`);
  // Graph hands back only fileAttachments here; item/reference ones have no
  // bytes to download, so they simply don't appear.
  const att = m?.hasAttachments
    ? await api<{ value: { id: string; name?: string; size?: number; contentType?: string; '@odata.type'?: string }[] }>(
        token,
        `${path}/attachments?$select=id,name,size,contentType`
      )
    : null;
  const isHtml = (m?.body?.contentType ?? '').toLowerCase() === 'html';
  return {
    id: m?.id ?? id,
    subject: m?.subject ?? '',
    from: addr(m?.from),
    to: (m?.toRecipients ?? []).map(addr),
    cc: (m?.ccRecipients ?? []).map(addr),
    at: m?.receivedDateTime ?? new Date().toISOString(),
    unread: !(m?.isRead ?? true),
    starred: (m?.flag?.flagStatus ?? 'notFlagged') === 'flagged',
    html: isHtml ? (m?.body?.content ?? '') : '',
    text: isHtml ? '' : (m?.body?.content ?? ''),
    attachments: (att?.value ?? [])
      .filter((a) => a['@odata.type'] !== '#microsoft.graph.referenceAttachment')
      .map<MailAttachment>((a) => ({
        id: a.id,
        name: a.name ?? 'attachment',
        size: a.size ?? 0,
        mime: a.contentType ?? 'application/octet-stream',
      })),
  };
}

export async function outlookAttachment(userId: number, messageId: string, attachmentId: string): Promise<Buffer> {
  const token = await liveToken(userId, 'microsoft');
  const a = await api<{ contentBytes?: string }>(
    token,
    `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
  );
  return Buffer.from(a?.contentBytes ?? '', 'base64');
}

export async function outlookModify(userId: number, id: string, op: MailOp): Promise<void> {
  const token = await liveToken(userId, 'microsoft');
  const path = `/me/messages/${encodeURIComponent(id)}`;
  const json = (body: unknown, method: 'PATCH' | 'POST', suffix = '') =>
    api(token, path + suffix, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (op === 'read' || op === 'unread') return void (await json({ isRead: op === 'read' }, 'PATCH'));
  if (op === 'star' || op === 'unstar')
    return void (await json({ flag: { flagStatus: op === 'star' ? 'flagged' : 'notFlagged' } }, 'PATCH'));
  // Well-known folder names are valid destinationIds.
  await json({ destinationId: op === 'archive' ? 'archive' : 'deleteditems' }, 'POST', '/move');
}
