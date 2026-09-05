import crypto from 'node:crypto';
import { setSetting, sweepSettings, takeSetting } from './settings.ts';
import { getLink, type LinkedAccount } from './linked-accounts.ts';
import { invalidate } from './cache.ts';
import { MAIL_ACCOUNTS, type MailAccount } from './wards.ts';
import {
  gmailAttachment,
  gmailInbox,
  gmailMessage,
  gmailModify,
  gmailReplyContext,
  gmailSendRaw,
  gmailUnreadCount,
} from './google.ts';
import type { MailAttachment, MailBody, MailMessage, MailOp } from './google.ts';
import {
  outlookAttachment,
  outlookInbox,
  outlookMessage,
  outlookModify,
  outlookSend,
  outlookReply,
  outlookUnreadCount,
} from './microsoft.ts';
import { zohoAttachment, zohoInbox, zohoMessage, zohoModify, zohoReply, zohoSend, zohoUnreadCount } from './zoho.ts';
import {
  mailboxAttachment,
  mailboxConfig,
  mailboxInbox,
  mailboxMessage,
  mailboxModify,
  mailboxReplyContext,
  mailboxSend,
  mailboxUnreadCount,
} from './mailbox.ts';

// Confirm-before-send is enforced server-side as two phases: /api/mail/draft
// stores the fully-resolved draft (10-min TTL) and returns the preview the
// confirm modal shows; /api/mail/send consumes it exactly once — the KV delete
// is the check, so a double-click or replay cannot double-send.

const DRAFT_TTL_MS = 10 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type Account = MailAccount;

/** Query/body strings are hostile: anything not a known account reads as Gmail. */
export const asAccount = (v: unknown): Account =>
  (MAIL_ACCOUNTS as readonly string[]).includes(String(v)) ? (String(v) as Account) : 'google';

export interface Draft {
  userId: number;
  account: Account;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  reply?: { messageId: string; threadId?: string; messageIdHeader?: string };
  at: number;
}

export interface DraftPreview {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  isReply: boolean;
  account: string;
}

// ------------------------------------------------------------- the accounts
// Every mail account behind one shape. Adding a provider is one entry here
// plus one MAIL_ACCOUNTS entry (wards.ts) — the routes, the logic engine and
// the agent tools all dispatch through this and never name a provider.

interface Transport {
  inbox(userId: number, limit: number): Promise<MailMessage[]>;
  unread(userId: number): Promise<number>;
  message(userId: number, id: string): Promise<MailBody>;
  attachment(userId: number, id: string, attachmentId: string): Promise<Buffer>;
  modify(userId: number, id: string, op: MailOp): Promise<void>;
  /** One method for new mail AND replies: whether `draft.reply` is set is the
   *  provider's business (Graph and Zoho thread it themselves, SMTP needs the
   *  Message-ID header, Gmail needs the thread id). */
  send(userId: number, draft: Draft): Promise<void>;
  /** Threading facts resolved at DRAFT time, so what is previewed is what sends. */
  replyContext?(userId: number, messageId: string): Promise<{ threadId?: string; messageIdHeader?: string; subject?: string }>;
  /** Why this account cannot send right now, or null. */
  sendBlocked(link: LinkedAccount): string | null;
  /** Read/flag/file actions available — an account linked read-only keeps
   *  working, the UI just hides the buttons. */
  canModify(link: LinkedAccount): boolean;
  /** Cache prefixes dropped after a successful modify, or the list snaps back. */
  caches(userId: number): string[];
}

const TRANSPORTS: Record<Account, Transport> = {
  google: {
    inbox: gmailInbox,
    unread: gmailUnreadCount,
    message: gmailMessage,
    attachment: gmailAttachment,
    modify: gmailModify,
    send: async (userId, d) => {
      await gmailSendRaw(userId, Buffer.from(buildRfc822(d), 'utf8').toString('base64url'), d.reply?.threadId);
    },
    replyContext: gmailReplyContext,
    sendBlocked: () => null,
    canModify: (link) => /gmail\.modify/i.test(link.scopes),
    caches: (u) => [`gmail:inbox:${u}:`, `gmail:unread:${u}`],
  },
  microsoft: {
    inbox: outlookInbox,
    unread: outlookUnreadCount,
    message: outlookMessage,
    attachment: outlookAttachment,
    modify: outlookModify,
    send: (userId, d) =>
      d.reply
        ? outlookReply(userId, d.reply.messageId, d.body, d.to, d.cc)
        : outlookSend(userId, { to: d.to, cc: d.cc, subject: d.subject, body: d.body }),
    sendBlocked: (link) => (/\bMail\.Send\b/i.test(link.scopes) ? null : 'send not granted for this account'),
    canModify: (link) => /\bMail\.ReadWrite\b/i.test(link.scopes),
    caches: (u) => [`outlook:inbox:${u}:`, `outlook:unread:${u}`],
  },
  zoho: {
    inbox: zohoInbox,
    unread: zohoUnreadCount,
    message: zohoMessage,
    attachment: zohoAttachment,
    modify: zohoModify,
    send: (userId, d) => {
      const m = { to: d.to, cc: d.cc, subject: d.subject, body: d.body };
      return d.reply ? zohoReply(userId, d.reply.messageId, m) : zohoSend(userId, m);
    },
    sendBlocked: () => null,
    canModify: () => true,
    caches: (u) => [`zoho:inbox:${u}:`, `zoho:unread:${u}`, `zoho:folders:${u}`],
  },
  mailbox: {
    inbox: mailboxInbox,
    unread: mailboxUnreadCount,
    message: mailboxMessage,
    attachment: mailboxAttachment,
    modify: mailboxModify,
    send: mailboxSend,
    replyContext: mailboxReplyContext,
    sendBlocked: (link) => (mailboxConfig(link.user_id)?.smtpHost ? null : 'no SMTP server is configured for this mailbox'),
    // POP3 can only list and download: no flags, no folders, no moves.
    canModify: (link) => link.scopes !== 'pop3',
    caches: (u) => [`mailbox:inbox:${u}:`, `mailbox:unread:${u}`],
  },
};

export const mailInbox = (userId: number, account: Account, limit: number): Promise<MailMessage[]> =>
  TRANSPORTS[account].inbox(userId, limit);

export const mailUnreadCount = (userId: number, account: Account): Promise<number> =>
  TRANSPORTS[account].unread(userId);

/** The mailboxes this user has linked, in MAIL_ACCOUNTS order. */
export const linkedMailAccounts = (userId: number): Account[] => MAIL_ACCOUNTS.filter((a) => getLink(userId, a));

/** Every account's inbox as one date-sorted list, rows tagged `account`. The
 *  agenda() rule (calendar.ts): one dead account is tolerated, all dead throws
 *  — an empty list must never mean "everything failed". Rides the per-provider
 *  60s caches; nothing new is cached.
 *  ponytail: seen-set ids downstream (mailProbe) are unprefixed — a cross-provider
 *  id collision is theoretical (hex vs base64 vs folder:id); prefix with the account if it ever bites. */
export async function mailInboxMerged(userId: number, accounts: Account[], limit: number, fetch = mailInbox): Promise<MailMessage[]> {
  const res = await Promise.allSettled(accounts.map((a) => fetch(userId, a, limit)));
  const ok = res.flatMap((r, i) => (r.status === 'fulfilled' ? r.value.map((m) => ({ ...m, account: accounts[i]! })) : []));
  if (!ok.length && accounts.length && res.every((r) => r.status === 'rejected')) throw (res[0] as PromiseRejectedResult).reason;
  return ok.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

/** Shared by the interactive draft path and the engine's direct send. */
function checkSendable(
  userId: number,
  account: Account,
  to: string[],
  cc: string[],
  body: string
): { from: string } | { error: string; status: number } {
  const link = getLink(userId, account);
  if (!link) return { error: 'not-linked', status: 404 };
  const blocked = TRANSPORTS[account].sendBlocked(link);
  if (blocked) return { error: blocked, status: 403 };
  if (to.length === 0 || [...to, ...cc].some((a) => !EMAIL_RE.test(a)))
    return { error: 'invalid recipient', status: 400 };
  if (!body.trim()) return { error: 'empty body', status: 400 };
  return { from: link.account_label };
}

export async function createDraft(opts: {
  userId: number;
  account: Account;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
}): Promise<{ draftId: string; preview: DraftPreview } | { error: string; status: number }> {
  const to = opts.to.map((a) => a.trim()).filter(Boolean);
  const cc = (opts.cc ?? []).map((a) => a.trim()).filter(Boolean);
  const check = checkSendable(opts.userId, opts.account, to, cc, opts.body);
  if ('error' in check) return check;

  const draft: Draft = {
    userId: opts.userId,
    account: opts.account,
    from: check.from,
    to,
    cc,
    subject: opts.subject.slice(0, 500),
    body: opts.body.slice(0, 100_000),
    at: Date.now(),
  };

  if (opts.inReplyTo) {
    // Resolve the threading facts NOW so what is previewed is what sends.
    const ctx = (await TRANSPORTS[opts.account].replyContext?.(opts.userId, opts.inReplyTo)) ?? {};
    draft.reply = { messageId: opts.inReplyTo, threadId: ctx.threadId, messageIdHeader: ctx.messageIdHeader };
    if (!draft.subject && ctx.subject)
      draft.subject = /^re:/i.test(ctx.subject) ? ctx.subject : `Re: ${ctx.subject}`;
  }

  const draftId = crypto.randomBytes(24).toString('base64url');
  // A draft is only consumed by sending it; every reviewed-then-abandoned one
  // would otherwise keep a full message body in the table forever.
  sweepSettings('mail_draft:', DRAFT_TTL_MS);
  setSetting(`mail_draft:${draftId}`, JSON.stringify(draft));
  return {
    draftId,
    preview: { from: draft.from, to, cc, subject: draft.subject, isReply: !!draft.reply, account: opts.account },
  };
}

/** RFC 2047 B-encoding for any header value that leaves ASCII. */
function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

export function buildRfc822(draft: Draft): string {
  const lines = [
    `To: ${draft.to.join(', ')}`,
    ...(draft.cc.length ? [`Cc: ${draft.cc.join(', ')}`] : []),
    `Subject: ${encodeHeader(draft.subject)}`,
    ...(draft.reply?.messageIdHeader
      ? [`In-Reply-To: ${draft.reply.messageIdHeader}`, `References: ${draft.reply.messageIdHeader}`]
      : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(draft.body, 'utf8').toString('base64'),
  ];
  return lines.join('\r\n');
}

export async function sendDraft(
  userId: number,
  draftId: string
): Promise<{ ok: true } | { error: string; status: number }> {
  if (!/^[A-Za-z0-9_-]{20,50}$/.test(draftId)) return { error: 'bad draft id', status: 400 };
  const raw = takeSetting(`mail_draft:${draftId}`); // consumed-once: the delete is the check
  if (!raw) return { error: 'draft expired or already sent', status: 410 };

  let draft: Draft;
  try {
    draft = JSON.parse(raw);
  } catch {
    return { error: 'corrupt draft', status: 410 };
  }
  if (draft.userId !== userId) return { error: 'not your draft', status: 403 };
  if (Date.now() - draft.at > DRAFT_TTL_MS) return { error: 'draft expired or already sent', status: 410 };

  await TRANSPORTS[draft.account].send(userId, draft);
  return { ok: true };
}

/** Direct send for the logic engine — same validation as the interactive
 *  path, no confirm phase: pre-authorization happened when the user saved
 *  the rule (recipients are fixed there), and the engine's per-user rate cap
 *  is the abuse brake. */
export async function sendNow(
  userId: number,
  account: Account,
  opts: { to: string[]; subject: string; body: string }
): Promise<{ ok: true } | { error: string; status: number }> {
  const to = opts.to.map((a) => a.trim()).filter(Boolean);
  const check = checkSendable(userId, account, to, [], opts.body);
  if ('error' in check) return check;
  await TRANSPORTS[account].send(userId, {
    userId,
    account,
    from: check.from,
    to,
    cc: [],
    subject: opts.subject.slice(0, 500),
    body: opts.body.slice(0, 100_000),
    at: Date.now(),
  });
  return { ok: true };
}

// ------------------------------------------------------------ reading mail
// Ported from PMA Office's email viewer: the body renders in a sandboxed
// iframe WITHOUT allow-scripts (that is what actually guarantees nothing
// runs); this sanitizer is the second layer, and it is also what strips
// remote images so opening a message can't phone home to the sender.

/**
 * Scripts, inline handlers and javascript: URLs out. With `images` false,
 * every remote `src` is parked on a data attribute and CSS url() backgrounds
 * are dropped, so the frame renders zero outbound requests.
 */
export function sanitizeMailHtml(raw: string, images: boolean): string {
  let out = raw
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<script[^>]*\/?>/gi, '')
    .replace(/<(iframe|object|embed|form)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(iframe|object|embed|form)[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/(href|src)\s*=\s*(["']?)\s*javascript:[^"'\s>]*\2/gi, '$1="#"')
    .replace(/<meta[^>]*http-equiv[^>]*>/gi, '');
  if (!images) {
    out = out.replace(/(<img\b[^>]*?)\ssrc\s*=/gi, '$1 data-blocked-src=');
    out = out.replace(/background(-image)?\s*:\s*url\([^)]*\)/gi, '');
  }
  return out;
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The document's own CSP, and the real stop on outbound requests: the regex
 *  sanitizer only knows about `<img src>` and CSS backgrounds, while a message
 *  can also phone home through srcset, @import, `<link rel=stylesheet>`, a
 *  @font-face, a video poster or an SVG `<image>`. `default-src 'none'` covers
 *  every one of them at once. Inline styles stay (mail is nothing but inline
 *  styles); images widen to http(s) only once the reader asks for them.
 *  sanitizeMailHtml strips the message's own <meta http-equiv>, so this is the
 *  only policy in the document. */
const csp = (images: boolean): string =>
  `default-src 'none'; style-src 'unsafe-inline'; img-src data:${images ? ' https: http:' : ''}; form-action 'none'`;

/** The complete srcdoc for the reader's iframe. Light-on-white on purpose:
 *  real mail ships hard-coded dark text and assumes a white page. */
export function mailBodyDoc(msg: { html: string; text: string }, images: boolean): string {
  const inner = msg.html
    ? sanitizeMailHtml(msg.html, images)
    : `<p style="white-space:pre-wrap">${escapeHtml(msg.text)}</p>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp(images)}"><base target="_blank"><style>
  body{margin:14px;font:15px/1.6 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;word-break:break-word}
  img{max-width:100%;height:auto}a{color:#1d4ed8}table{max-width:100%!important}
  blockquote{margin:0 0 0 .5rem;padding-left:.75rem;border-left:2px solid #d1d5db;color:#6b7280}
</style></head><body>${inner}</body></html>`;
}

export const hasRemoteImages = (html: string): boolean => /<img\b[^>]*\ssrc\s*=\s*["']?https?:/i.test(html);

export interface MailView {
  id: string;
  subject: string;
  from: { name: string; address: string };
  to: { name: string; address: string }[];
  cc: { name: string; address: string }[];
  at: string;
  unread: boolean;
  starred: boolean;
  /** Sandboxed, sanitized srcdoc — never the provider's raw HTML. */
  doc: string;
  /** Plain text, for quoting into a reply or forward. */
  text: string;
  blockedImages: boolean;
  attachments: MailAttachment[];
  /** false → the account was linked before mail actions were in scope. */
  canModify: boolean;
}

/** One message, ready to render. `images` opts into loading remote images. */
export async function mailMessage(
  userId: number,
  account: Account,
  id: string,
  images: boolean
): Promise<MailView | { error: string; status: number }> {
  const link = getLink(userId, account);
  if (!link) return { error: 'not-linked', status: 404 };
  const msg = await TRANSPORTS[account].message(userId, id);
  const { html, text, ...rest } = msg;
  return {
    ...rest,
    doc: mailBodyDoc(msg, images),
    // Gmail hands back HTML-only mail with no text/plain alternative; strip
    // tags so Reply always has something to quote.
    text: text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    blockedImages: !images && hasRemoteImages(html),
    canModify: canModifyMail(link),
  };
}

/** Mail actions need a write scope (or, for a mailbox, a protocol that has
 *  them). An account without one keeps working read-only — the UI hides the
 *  buttons rather than 403-ing. */
export function canModifyMail(link: LinkedAccount): boolean {
  return TRANSPORTS[link.provider as Account]?.canModify(link) ?? false;
}

const MAIL_OPS = new Set<MailOp>(['read', 'unread', 'star', 'unstar', 'archive', 'trash']);

export async function actOnMail(
  userId: number,
  account: Account,
  id: string,
  op: string
): Promise<{ ok: true } | { error: string; status: number }> {
  if (!MAIL_OPS.has(op as MailOp)) return { error: 'unknown action', status: 400 };
  const link = getLink(userId, account);
  if (!link) return { error: 'not-linked', status: 404 };
  const t = TRANSPORTS[account];
  if (!t.canModify(link)) return { error: 'reconnect this account to file and flag mail', status: 403 };
  await t.modify(userId, id, op as MailOp);
  // The list is served from a 60s cache; without this the row snaps back.
  for (const prefix of t.caches(userId)) invalidate(prefix);
  return { ok: true };
}

/** Attachment bytes. The name is echoed by the route, never trusted from it. */
export async function mailAttachment(
  userId: number,
  account: Account,
  messageId: string,
  attachmentId: string
): Promise<Buffer | { error: string; status: number }> {
  if (!getLink(userId, account)) return { error: 'not-linked', status: 404 };
  return TRANSPORTS[account].attachment(userId, messageId, attachmentId);
}
