import { ImapFlow } from 'imapflow';
import type { FetchMessageObject, MessageStructureObject } from 'imapflow';
import { simpleParser, type ParsedMail, type AddressObject } from 'mailparser';
import nodemailer from 'nodemailer';
import Pop3Command from 'node-pop3';
import { getLink, getMeta, storeLink, ReconnectError } from './linked-accounts.ts';
import { openToken } from './crypto.ts';
import { cached } from './cache.ts';
import { publicAddress } from './net-guard.ts';
import type { MailMessage, MailBody, MailAttachment, MailOp } from './google.ts';
import type { Draft } from './mail.ts';

// The generic mailbox: any IMAP or POP3 server for reading, any SMTP server for
// sending. Nothing is discovered — the user types the hosts on /account, and
// the row lands in linked_accounts like an OAuth link does: the password sealed
// into refresh_token_enc (crypto.ts, the same seal refresh tokens get), the
// hosts in meta_json, and `scopes` holding the read protocol so canModifyMail
// can tell IMAP (flags, moves) from POP3 (download only).
//
// Every call opens and closes its own connection. Mail wards poll every few
// minutes behind a 60s cache, so a pool would buy little and leak sockets on
// every config change.
// ponytail: connection per call; add a pool if a ward ever polls faster than a
// connection takes to set up.

export interface MailboxConfig {
  proto: 'imap' | 'pop3';
  host: string;
  port: number;
  /** Implicit TLS (993/995). false = plain connect, upgraded by STARTTLS on IMAP. */
  secure: boolean;
  user: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
}

const port = (v: unknown, fallback: number): number => {
  const n = Math.round(Number(v));
  return n >= 1 && n <= 65535 ? n : fallback;
};

const host = (v: unknown): string =>
  String(v ?? '')
    .trim()
    .replace(/^\w+:\/\//, '')
    .replace(/[/:\s].*$/, '')
    .slice(0, 253);

/** The trust boundary for the connect form. Throws on anything unusable. */
export function normalizeMailboxConfig(raw: Record<string, unknown>): MailboxConfig {
  const proto = raw.proto === 'pop3' ? 'pop3' : 'imap';
  const readHost = host(raw.host);
  if (!readHost) throw new Error('a mail server host is required');
  const secure = raw.secure !== 'false' && raw.secure !== false;
  const smtpSecure = raw.smtpSecure === 'true' || raw.smtpSecure === true;
  return {
    proto,
    host: readHost,
    port: port(raw.port, secure ? (proto === 'imap' ? 993 : 995) : proto === 'imap' ? 143 : 110),
    secure,
    user: String(raw.user ?? '').trim().slice(0, 320),
    smtpHost: host(raw.smtpHost),
    smtpPort: port(raw.smtpPort, smtpSecure ? 465 : 587),
    smtpSecure,
  };
}

export function mailboxConfig(userId: number): MailboxConfig | null {
  const link = getLink(userId, 'mailbox');
  if (!link) return null;
  const meta = getMeta(link);
  return meta.host ? (meta as unknown as MailboxConfig) : null;
}

/** Store (or replace) the mailbox. The password is sealed, never echoed back —
 *  an empty one keeps whatever is already stored, so editing a port doesn't
 *  make the user retype it. */
export function storeMailbox(userId: number, address: string, password: string, cfg: MailboxConfig): void {
  const existing = getLink(userId, 'mailbox');
  const pass = password || (existing ? openToken(existing.refresh_token_enc) : '');
  if (!pass) throw new Error('a password is required');
  storeLink({
    userId,
    provider: 'mailbox',
    label: address,
    refreshToken: pass,
    scopes: cfg.proto,
    meta: cfg as unknown as Record<string, unknown>,
  });
}

async function open(userId: number): Promise<{ cfg: MailboxConfig; pass: string; address: string }> {
  const link = getLink(userId, 'mailbox');
  const cfg = mailboxConfig(userId);
  if (!link || !cfg) throw new ReconnectError('mailbox');
  try {
    return { cfg, pass: openToken(link.refresh_token_enc), address: link.account_label };
  } catch {
    throw new ReconnectError('mailbox');
  }
}

/** Connect to the address the private-range check approved, and let TLS still
 *  validate against the name the user typed. Resolving again at connect time
 *  would reopen the DNS-rebinding hole the check just closed. */
async function pinned(name: string): Promise<{ host: string; servername?: string }> {
  const address = await publicAddress(name);
  return address === name ? { host: address } : { host: address, servername: name };
}

// --------------------------------------------------------------------- IMAP

async function imap(cfg: MailboxConfig, pass: string): Promise<ImapFlow> {
  const client = new ImapFlow({
    ...(await pinned(cfg.host)),
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass },
    logger: false,
    emitLogs: false,
  });
  try {
    await client.connect();
  } catch (err) {
    // Bad credentials are a reconnect, not an outage: the ward shows the chip.
    if (/auth/i.test(err instanceof Error ? err.message : '')) throw new ReconnectError('mailbox');
    throw err;
  }
  return client;
}

/** Open a client, run the body, always log out. */
async function withImap<T>(userId: number, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const { cfg, pass } = await open(userId);
  const client = await imap(cfg, pass);
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

function hasAttachment(node: MessageStructureObject | undefined): boolean {
  if (!node) return false;
  if (node.disposition === 'attachment') return true;
  return (node.childNodes ?? []).some(hasAttachment);
}

function imapRow(m: FetchMessageObject): MailMessage {
  const from = m.envelope?.from?.[0];
  return {
    id: String(m.uid),
    from: { name: from?.name ?? '', address: from?.address ?? '' },
    subject: m.envelope?.subject ?? '',
    snippet: '', // a preview would cost one BODY fetch per row
    at: new Date(m.envelope?.date ?? m.internalDate ?? Date.now()).toISOString(),
    unread: !m.flags?.has('\\Seen'),
    starred: !!m.flags?.has('\\Flagged'),
    hasAttachments: hasAttachment(m.bodyStructure),
  };
}

function imapInbox(userId: number, limit: number): Promise<MailMessage[]> {
  return withImap(userId, async (client) => {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const total = typeof client.mailbox === 'object' ? client.mailbox.exists : 0;
      if (!total) return [];
      const rows: MailMessage[] = [];
      for await (const m of client.fetch(`${Math.max(1, total - limit + 1)}:*`, {
        uid: true,
        envelope: true,
        flags: true,
        internalDate: true,
        bodyStructure: true,
      })) {
        rows.push(imapRow(m));
      }
      return rows.reverse();
    } finally {
      lock.release();
    }
  });
}

async function imapSource(client: ImapFlow, uid: string): Promise<ParsedMail & { flags?: Set<string> }> {
  const lock = await client.getMailboxLock('INBOX');
  try {
    const msg = await client.fetchOne(uid, { source: true, flags: true, uid: true }, { uid: true });
    if (!msg || !msg.source) throw new Error('message not found');
    return Object.assign(await simpleParser(msg.source), { flags: msg.flags });
  } finally {
    lock.release();
  }
}

/** The special-use mailbox an op files into, by its IMAP attribute. */
async function specialUse(client: ImapFlow, use: string, name: RegExp): Promise<string> {
  const list = await client.list();
  const hit = list.find((m) => m.specialUse === use) ?? list.find((m) => name.test(m.path));
  if (!hit) throw new Error(`this mailbox has no ${use.replace('\\', '')} folder`);
  return hit.path;
}

async function imapModify(userId: number, uid: string, op: MailOp): Promise<void> {
  await withImap(userId, async (client) => {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const opts = { uid: true };
      if (op === 'read') await client.messageFlagsAdd(uid, ['\\Seen'], opts);
      else if (op === 'unread') await client.messageFlagsRemove(uid, ['\\Seen'], opts);
      else if (op === 'star') await client.messageFlagsAdd(uid, ['\\Flagged'], opts);
      else if (op === 'unstar') await client.messageFlagsRemove(uid, ['\\Flagged'], opts);
      else if (op === 'archive') await client.messageMove(uid, await specialUse(client, '\\Archive', /^archive$/i), opts);
      else await client.messageMove(uid, await specialUse(client, '\\Trash', /^(trash|deleted)/i), opts);
    } finally {
      lock.release();
    }
  });
}

// --------------------------------------------------------------------- POP3
// POP3 has no server-side state: no flags, no folders, no moves. It lists and
// downloads, which is exactly what the ward falls back to (canModifyMail reads
// the stored protocol and hides the action buttons).

async function pop3<T>(userId: number, fn: (p: Pop3Command) => Promise<T>): Promise<T> {
  const { cfg, pass } = await open(userId);
  const client = new Pop3Command({
    ...(await pinned(cfg.host)),
    port: cfg.port,
    tls: cfg.secure,
    user: cfg.user,
    password: pass,
    timeout: 20_000,
  });
  try {
    return await fn(client);
  } finally {
    await client.QUIT().catch(() => {});
  }
}

/** POP3 addresses messages by a per-session number, so the stable id is the
 *  UIDL and every call re-reads the list to map one to the other. */
async function pop3Numbers(client: Pop3Command): Promise<Map<string, string>> {
  const list = (await client.UIDL()) as unknown as [string, string][];
  return new Map(list.map(([num, uid]) => [uid, num]));
}

async function pop3Inbox(userId: number, limit: number): Promise<MailMessage[]> {
  return pop3(userId, async (client) => {
    const list = (await client.UIDL()) as unknown as [string, string][];
    const rows: MailMessage[] = [];
    for (const [num, uid] of list.slice(-limit).reverse()) {
      // TOP n 0 = headers only. A full RETR per row would download the inbox.
      const head = await client.TOP(Number(num), 0);
      const m = await simpleParser(String(head));
      const from = (m.from as AddressObject | undefined)?.value?.[0];
      rows.push({
        id: uid,
        from: { name: from?.name ?? '', address: from?.address ?? '' },
        subject: m.subject ?? '',
        snippet: '',
        at: (m.date ?? new Date()).toISOString(),
        unread: false, // POP3 keeps no read state
        starred: false,
        hasAttachments: /multipart\/mixed/i.test(String(m.headers.get('content-type') ?? '')),
      });
    }
    return rows;
  });
}

function pop3Message(userId: number, uid: string): Promise<ParsedMail> {
  return pop3(userId, async (client) => {
    const num = (await pop3Numbers(client)).get(uid);
    if (!num) throw new Error('message no longer on the server');
    return simpleParser(String(await client.RETR(Number(num))));
  });
}

// -------------------------------------------------------------- shared reads

const addrs = (a: AddressObject | AddressObject[] | undefined) =>
  (Array.isArray(a) ? a.flatMap((x) => x.value) : (a?.value ?? [])).map((v) => ({
    name: v.name ?? '',
    address: v.address ?? '',
  }));

/** Parsed MIME → the shape every mail ward renders. Exported because this, not
 *  the socket handling, is where the mapping can be wrong.
 *  Attachment ids are the index into the parsed message: mail is immutable, so
 *  the order the parser produces is stable for as long as the message exists. */
export function mailView(id: string, m: ParsedMail & { flags?: Set<string> }): MailBody {
  return {
    id,
    subject: m.subject ?? '',
    from: addrs(m.from)[0] ?? { name: '', address: '' },
    to: addrs(m.to),
    cc: addrs(m.cc),
    at: (m.date ?? new Date()).toISOString(),
    unread: m.flags ? !m.flags.has('\\Seen') : false,
    starred: !!m.flags?.has('\\Flagged'),
    html: typeof m.html === 'string' ? m.html : '',
    text: m.text ?? '',
    attachments: m.attachments.map<MailAttachment>((a, i) => ({
      id: String(i),
      name: a.filename ?? `attachment-${i + 1}`,
      size: a.size ?? 0,
      mime: a.contentType ?? 'application/octet-stream',
    })),
  };
}

function parsed(userId: number, id: string): Promise<ParsedMail & { flags?: Set<string> }> {
  const cfg = mailboxConfig(userId);
  return cfg?.proto === 'pop3' ? pop3Message(userId, id) : withImap(userId, (c) => imapSource(c, id));
}

// --------------------------------------------------------------------- SMTP

async function smtp(userId: number): Promise<{ from: string; transport: nodemailer.Transporter }> {
  const { cfg, pass, address } = await open(userId);
  if (!cfg.smtpHost) throw new Error('no SMTP server is configured for this mailbox');
  return {
    from: address,
    transport: nodemailer.createTransport({
      ...(await pinned(cfg.smtpHost)),
      port: cfg.smtpPort,
      secure: cfg.smtpSecure,
      // On 587 the connection starts plain; without this a server that offers
      // STARTTLS but doesn't require it would happily take the password in clear.
      requireTLS: !cfg.smtpSecure,
      auth: { user: cfg.user, pass },
    }),
  };
}

async function smtpSend(userId: number, draft: Draft): Promise<void> {
  const { from, transport } = await smtp(userId);
  try {
    await transport.sendMail({
      from,
      to: draft.to,
      cc: draft.cc.length ? draft.cc : undefined,
      subject: draft.subject,
      text: draft.body,
      ...(draft.reply?.messageIdHeader
        ? { inReplyTo: draft.reply.messageIdHeader, references: draft.reply.messageIdHeader }
        : {}),
    });
  } finally {
    transport.close();
  }
}

// ----------------------------------------------------------------- the ward

export function mailboxInbox(userId: number, limit: number): Promise<MailMessage[]> {
  return cached(`mailbox:inbox:${userId}:${limit}`, 60_000, () =>
    mailboxConfig(userId)?.proto === 'pop3' ? pop3Inbox(userId, limit) : imapInbox(userId, limit)
  );
}

export function mailboxUnreadCount(userId: number): Promise<number> {
  return cached(`mailbox:unread:${userId}`, 60_000, async () => {
    if (mailboxConfig(userId)?.proto === 'pop3') return 0; // POP3 has no read state
    return withImap(userId, async (c) => (await c.status('INBOX', { unseen: true })).unseen ?? 0);
  });
}

export async function mailboxMessage(userId: number, id: string): Promise<MailBody> {
  return mailView(id, await parsed(userId, id));
}

export async function mailboxAttachment(userId: number, id: string, attachmentId: string): Promise<Buffer> {
  const m = await parsed(userId, id);
  const att = m.attachments[Number(attachmentId)];
  if (!att) throw new Error('attachment not found');
  return Buffer.from(att.content);
}

export async function mailboxModify(userId: number, id: string, op: MailOp): Promise<void> {
  if (mailboxConfig(userId)?.proto === 'pop3') throw new Error('POP3 mailboxes are read-only');
  await imapModify(userId, id, op);
}

export const mailboxSend = smtpSend;

/** The Message-ID a reply must thread onto. IMAP hands it over in the envelope,
 *  which is one round trip; POP3 threads by subject alone. */
export async function mailboxReplyContext(userId: number, id: string): Promise<{ messageIdHeader?: string; subject?: string }> {
  if (mailboxConfig(userId)?.proto === 'pop3') return {};
  return withImap(userId, async (client) => {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const msg = await client.fetchOne(id, { envelope: true, uid: true }, { uid: true });
      return { messageIdHeader: msg ? msg.envelope?.messageId : undefined, subject: msg ? msg.envelope?.subject : undefined };
    } finally {
      lock.release();
    }
  });
}
