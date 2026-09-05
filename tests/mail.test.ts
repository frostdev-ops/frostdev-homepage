import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { MailMessage } from '../src/lib/google.ts';
import {
  actOnMail,
  mailInboxMerged,
  buildRfc822,
  canModifyMail,
  hasRemoteImages,
  mailBodyDoc,
  mailMessage,
  sanitizeMailHtml,
  sendDraft,
  sendNow,
  type Draft,
} from '../src/lib/mail.ts';
import { setSetting } from '../src/lib/settings.ts';
import { getDb } from '../src/lib/db.ts';

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    userId: 1,
    account: 'google',
    from: 'me@frostdev.io',
    to: ['to@example.com'],
    cc: [],
    subject: 'Hello',
    body: 'plain body',
    at: Date.now(),
    ...overrides,
  };
}

function storeDraft(d: Draft): string {
  const id = crypto.randomBytes(24).toString('base64url');
  setSetting(`mail_draft:${id}`, JSON.stringify(d));
  return id;
}

// ------------------------------------------------------------- buildRfc822

test('buildRfc822: To/Subject headers, base64 body decodes back', () => {
  const msg = buildRfc822(draft({ to: ['a@example.com', 'b@example.com'], body: 'line one\nline two' }));
  const lines = msg.split('\r\n');
  assert.equal(lines[0], 'To: a@example.com, b@example.com');
  assert.ok(lines.includes('Subject: Hello'));
  assert.ok(lines.includes('MIME-Version: 1.0'));
  assert.ok(lines.includes('Content-Transfer-Encoding: base64'));
  assert.ok(!msg.includes('Cc:'), 'no Cc header when cc is empty');
  const body = lines[lines.length - 1]!;
  assert.equal(Buffer.from(body, 'base64').toString('utf8'), 'line one\nline two');
});

test('buildRfc822: Cc header when cc present', () => {
  const msg = buildRfc822(draft({ cc: ['cc1@example.com', 'cc2@example.com'] }));
  assert.ok(msg.split('\r\n').includes('Cc: cc1@example.com, cc2@example.com'));
});

test('buildRfc822: non-ASCII subject is RFC 2047 B-encoded', () => {
  const msg = buildRfc822(draft({ subject: 'Héllo ☃' }));
  const subjectLine = msg.split('\r\n').find((l) => l.startsWith('Subject: '))!;
  const m = subjectLine.match(/^Subject: =\?UTF-8\?B\?(.+)\?=$/);
  assert.ok(m, `expected B-encoded subject, got: ${subjectLine}`);
  assert.equal(Buffer.from(m![1]!, 'base64').toString('utf8'), 'Héllo ☃');
});

test('buildRfc822: In-Reply-To/References when reply.messageIdHeader present', () => {
  const withReply = buildRfc822(
    draft({ reply: { messageId: 'gm1', threadId: 'th1', messageIdHeader: '<abc@mail.example>' } })
  );
  const lines = withReply.split('\r\n');
  assert.ok(lines.includes('In-Reply-To: <abc@mail.example>'));
  assert.ok(lines.includes('References: <abc@mail.example>'));

  // Reply without a resolved header (Microsoft path) adds neither.
  const without = buildRfc822(draft({ reply: { messageId: 'gm1' } }));
  assert.ok(!without.includes('In-Reply-To:'));
  assert.ok(!without.includes('References:'));
});

// ---------------------------------------------------- sendDraft guard paths
// Only paths that return BEFORE provider dispatch — a valid own draft would
// call the Gmail API.

test('sendDraft: bad draft id format is 400', async () => {
  assert.deepEqual(await sendDraft(1, 'nope'), { error: 'bad draft id', status: 400 });
  assert.deepEqual(await sendDraft(1, 'bad!chars#but$long%enough^to&pass'), { error: 'bad draft id', status: 400 });
});

test('sendDraft: cross-user draft is 403, and is consumed (second call 410)', async () => {
  const id = storeDraft(draft({ userId: 111 }));
  const first = await sendDraft(222, id);
  assert.deepEqual(first, { error: 'not your draft', status: 403 });
  const second = await sendDraft(222, id);
  assert.deepEqual(second, { error: 'draft expired or already sent', status: 410 });
});

test('sendDraft: expired draft is 410', async () => {
  const id = storeDraft(draft({ at: Date.now() - 11 * 60 * 1000 }));
  assert.deepEqual(await sendDraft(1, id), { error: 'draft expired or already sent', status: 410 });
});

test('sendDraft: unknown draft id is 410', async () => {
  assert.deepEqual(await sendDraft(1, 'a'.repeat(32)), { error: 'draft expired or already sent', status: 410 });
});

test('sendDraft: corrupt draft JSON is 410', async () => {
  const id = crypto.randomBytes(24).toString('base64url');
  setSetting(`mail_draft:${id}`, 'not json {{');
  assert.deepEqual(await sendDraft(1, id), { error: 'corrupt draft', status: 410 });
});

// ------------------------------------------------------ sendNow guard paths
// Same rule as above: only paths that return BEFORE provider dispatch.

test('sendNow: not linked is 404', async () => {
  assert.deepEqual(await sendNow(999, 'google', { to: ['a@b.co'], subject: 's', body: 'b' }), {
    error: 'not-linked',
    status: 404,
  });
});

test('sendNow: recipient/body/scope validation before dispatch', async () => {
  getDb().prepare(`INSERT INTO users (email, password_hash, role) VALUES ('m@t.dev', 'x', 'admin')`).run();
  const u = (getDb().prepare(`SELECT id FROM users WHERE email = 'm@t.dev'`).get() as { id: number }).id;
  getDb()
    .prepare(
      `INSERT INTO linked_accounts (user_id, provider, account_label, refresh_token_enc, scopes)
       VALUES (?, 'microsoft', 'me@school.edu', 'sealed', 'Mail.Read')`
    )
    .run(u);
  // Mail.Send scope missing → 403 (validation, no network)
  assert.deepEqual(await sendNow(u, 'microsoft', { to: ['a@b.co'], subject: 's', body: 'b' }), {
    error: 'send not granted for this account',
    status: 403,
  });
  getDb().prepare(`UPDATE linked_accounts SET scopes = 'Mail.Send' WHERE user_id = ?`).run(u);
  assert.deepEqual(await sendNow(u, 'microsoft', { to: ['not-an-email'], subject: 's', body: 'b' }), {
    error: 'invalid recipient',
    status: 400,
  });
  assert.deepEqual(await sendNow(u, 'microsoft', { to: [], subject: 's', body: 'b' }), {
    error: 'invalid recipient',
    status: 400,
  });
  assert.deepEqual(await sendNow(u, 'microsoft', { to: ['a@b.co'], subject: 's', body: '   ' }), {
    error: 'empty body',
    status: 400,
  });
});

// --- the reader's trust boundary: a message body is a stranger's HTML -------

test('sanitizeMailHtml: scripts, handlers and javascript: URLs are stripped', () => {
  const raw = `<p onclick="steal()">hi</p><script>evil()</script><script src=x.js></script>
    <a href="javascript:evil()">go</a><iframe src="//x"></iframe><form action="/x"><input></form>
    <meta http-equiv="refresh" content="0;url=//x">`;
  const out = sanitizeMailHtml(raw, true);
  assert.doesNotMatch(out, /<script/i);
  assert.doesNotMatch(out, /onclick/i);
  assert.doesNotMatch(out, /javascript:/i);
  assert.doesNotMatch(out, /<iframe|<form|http-equiv/i);
  assert.match(out, /hi/); // the actual message survives
});

test('sanitizeMailHtml: images only load when asked for', () => {
  const raw = `<img src="https://tracker.example/pixel.gif"><div style="background:url(https://t/x.png)">x</div>`;
  const blocked = sanitizeMailHtml(raw, false);
  assert.doesNotMatch(blocked, /\ssrc=/);
  assert.match(blocked, /data-blocked-src=/);
  assert.doesNotMatch(blocked, /url\(/);
  assert.match(sanitizeMailHtml(raw, true), /src="https:\/\/tracker/);
});

test('hasRemoteImages: only remote ones count', () => {
  assert.equal(hasRemoteImages('<img src="https://a/b.png">'), true);
  assert.equal(hasRemoteImages('<img src="cid:inline">'), false);
  assert.equal(hasRemoteImages('<p>no images</p>'), false);
});

test('mailBodyDoc: plain-text mail is escaped, never injected as markup', () => {
  const doc = mailBodyDoc({ html: '', text: '<script>evil()</script> & <b>x</b>' }, false);
  assert.doesNotMatch(doc.split('<body>')[1]!, /<script|<b>/);
  assert.match(doc, /&lt;script&gt;/);
});

// The regex sanitizer only knows <img src> and CSS backgrounds; these four are
// the tracking channels it leaves open, and the document CSP is what shuts them.
test('mailBodyDoc: the document CSP blocks what the sanitizer misses', () => {
  const html =
    `<link rel="stylesheet" href="https://t/x.css">` +
    `<style>@import url(https://t/y.css); @font-face{src:url(https://t/f.woff2)}</style>` +
    `<img srcset="https://t/pixel.gif 1x">` +
    `<svg><image href="https://t/z.png"/></svg>`;
  const blocked = mailBodyDoc({ html, text: '' }, false);
  const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(blocked)?.[1];
  assert.ok(policy, 'the doc carries its own policy');
  assert.match(policy, /^default-src 'none'/);
  assert.doesNotMatch(policy, /https:/, 'no remote fetch of any kind while images are blocked');
  assert.match(policy, /style-src 'unsafe-inline'/, 'mail is nothing but inline styles');
  // Those URLs still survive the sanitizer — the CSP is the only thing stopping them.
  assert.match(blocked, /srcset="https:\/\/t/);

  // "Load images" widens img-src, and nothing else.
  assert.match(mailBodyDoc({ html, text: '' }, true), /img-src data: https: http:/);
});

test('canModifyMail: read-only links keep working, they just cannot file mail', () => {
  const link = (provider: string, scopes: string) => ({ provider, scopes }) as never;
  const g = 'openid email https://www.googleapis.com/auth/gmail.modify';
  assert.equal(canModifyMail(link('google', g)), true);
  assert.equal(canModifyMail(link('google', 'https://www.googleapis.com/auth/gmail.readonly')), false);
  assert.equal(canModifyMail(link('microsoft', 'Mail.ReadWrite Mail.Send')), true);
  assert.equal(canModifyMail(link('microsoft', 'Mail.Read Mail.Send')), false);
  // Zoho's grant is all-or-nothing; a POP3 mailbox can only download.
  assert.equal(canModifyMail(link('zoho', '')), true);
  assert.equal(canModifyMail(link('mailbox', 'imap')), true);
  assert.equal(canModifyMail(link('mailbox', 'pop3')), false);
});

// --- the whole read path, with the provider stubbed at fetch --------------

function linkGoogle(email: string, scopes: string): number {
  const db = getDb();
  db.prepare(`INSERT INTO users (email, password_hash, role) VALUES (?, 'x', 'admin')`).run(email);
  const u = (db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: number }).id;
  db.prepare(
    `INSERT INTO linked_accounts (user_id, provider, account_label, refresh_token_enc, access_token, access_expires_at, scopes)
     VALUES (?, 'google', ?, 'sealed', 'live-token', ?, ?)`
  ).run(u, email, Date.now() + 3_600_000, scopes);
  return u;
}

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

/** One Gmail format=full payload: nested alternative + a real attachment. */
const GMAIL_FULL = {
  id: 'm1',
  threadId: 't1',
  labelIds: ['INBOX', 'UNREAD'],
  payload: {
    mimeType: 'multipart/mixed',
    headers: [
      { name: 'From', value: 'Ada Lovelace <ada@example.com>' },
      { name: 'To', value: '"Doe, John" <me@frostdev.io>, other@example.com' },
      { name: 'Cc', value: 'cc@example.com' },
      { name: 'Subject', value: 'Analytical Engine' },
      { name: 'Date', value: 'Tue, 05 Aug 2025 10:00:00 +0000' },
    ],
    parts: [
      {
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', body: { data: b64url('plain version') } },
          {
            mimeType: 'text/html',
            body: { data: b64url('<p onclick="x()">rich <img src="https://t/p.gif"></p><script>evil()</script>') },
          },
        ],
      },
      { mimeType: 'application/pdf', filename: 'notes.pdf', body: { attachmentId: 'att1', size: 4096 } },
    ],
  },
};

test('mailMessage: parses a nested Gmail body, sanitizes it, blocks images by default', async () => {
  const u = linkGoogle('reader@t.dev', 'https://www.googleapis.com/auth/gmail.modify');
  const seen: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    seen.push(String(url));
    return new Response(JSON.stringify(GMAIL_FULL), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const view = await mailMessage(u, 'google', 'm1', false);
    assert.ok(!('error' in view));
    assert.match(seen[0]!, /messages\/m1\?format=full/);
    assert.equal(view.subject, 'Analytical Engine');
    assert.deepEqual(view.from, { name: 'Ada Lovelace', address: 'ada@example.com' });
    // The To header splits on the comma between addresses, not the one inside
    // the quoted display name.
    assert.deepEqual(
      view.to.map((a) => a.address),
      ['me@frostdev.io', 'other@example.com']
    );
    assert.deepEqual(view.cc, [{ name: '', address: 'cc@example.com' }]);
    assert.equal(view.unread, true);
    assert.equal(view.starred, false);
    assert.equal(view.canModify, true);
    assert.deepEqual(view.attachments, [
      { id: 'att1', name: 'notes.pdf', size: 4096, mime: 'application/pdf' },
    ]);
    // HTML is preferred over text/plain, and arrives declawed.
    assert.match(view.doc, /rich/);
    assert.doesNotMatch(view.doc, /<script|onclick/i);
    assert.equal(view.blockedImages, true);
    assert.match(view.doc, /data-blocked-src/);
    // text/plain is what a reply quotes.
    assert.equal(view.text, 'plain version');

    const loaded = await mailMessage(u, 'google', 'm1', true);
    assert.ok(!('error' in loaded));
    assert.equal(loaded.blockedImages, false);
    assert.match(loaded.doc, /src="https:\/\/t\/p\.gif"/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('actOnMail: unknown op, missing link, and a read-only account are all refused', async () => {
  const readonly = linkGoogle('ro@t.dev', 'https://www.googleapis.com/auth/gmail.readonly');
  assert.deepEqual(await actOnMail(readonly, 'google', 'm1', 'explode'), { error: 'unknown action', status: 400 });
  assert.deepEqual(await actOnMail(9999, 'google', 'm1', 'archive'), { error: 'not-linked', status: 404 });
  assert.deepEqual(await actOnMail(readonly, 'google', 'm1', 'archive'), {
    error: 'reconnect this account to file and flag mail',
    status: 403,
  });
});

test('mailInboxMerged: rows tagged and date-sorted, one dead account tolerated, all dead throws', async () => {
  const row = (id: string, at: string): MailMessage => ({ id, from: { name: '', address: 'a@b.c' }, subject: id, snippet: '', at, unread: true, starred: false, hasAttachments: false });
  const fetch = async (_u: number, account: string): Promise<MailMessage[]> => {
    if (account === 'zoho') throw new Error('zoho down');
    return account === 'google' ? [row('g1', '2026-09-02T10:00:00Z'), row('g2', '2026-09-02T08:00:00Z')] : [row('o1', '2026-09-02T09:00:00Z')];
  };
  const merged = await mailInboxMerged(1, ['google', 'microsoft', 'zoho'], 2, fetch as never);
  assert.deepEqual(merged.map((m) => [m.id, m.account]), [['g1', 'google'], ['o1', 'microsoft']]);
  await assert.rejects(() => mailInboxMerged(1, ['zoho'], 5, fetch as never), /zoho down/);
  assert.deepEqual(await mailInboxMerged(1, [], 5, fetch as never), []);
});
