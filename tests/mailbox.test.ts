import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../src/lib/db.ts';
import { getLink } from '../src/lib/linked-accounts.ts';
import { mailView, mailboxConfig, normalizeMailboxConfig, storeMailbox } from '../src/lib/mailbox.ts';
import { simpleParser } from 'mailparser';
import { openToken } from '../src/lib/crypto.ts';
import { isPrivateAddress, publicAddress } from '../src/lib/net-guard.ts';
import { asAccount } from '../src/lib/mail.ts';

function user(email: string): number {
  const db = getDb();
  db.prepare(`INSERT INTO users (email, password_hash, role) VALUES (?, 'x', 'admin')`).run(email);
  return (db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: number }).id;
}

test('normalizeMailboxConfig: ports follow protocol + encryption, hosts are bare names', () => {
  const imap = normalizeMailboxConfig({ host: 'imaps://mail.example.com:993/x', smtpHost: 'smtp.example.com' });
  assert.equal(imap.proto, 'imap');
  assert.equal(imap.host, 'mail.example.com'); // scheme, port and path stripped
  assert.equal(imap.port, 993);
  assert.equal(imap.smtpPort, 587); // STARTTLS is the default for submission

  const pop = normalizeMailboxConfig({ proto: 'pop3', host: 'pop.example.com', secure: 'false' });
  assert.equal(pop.port, 110);

  const explicit = normalizeMailboxConfig({ host: 'a.example.com', port: '1143', smtpSecure: 'true' });
  assert.equal(explicit.port, 1143);
  assert.equal(explicit.smtpPort, 465);

  assert.throws(() => normalizeMailboxConfig({}), /host is required/);
});

test('storeMailbox: an empty password keeps the stored one, a first save demands one', () => {
  const id = user('mailbox@frostdev.io');
  const cfg = normalizeMailboxConfig({ host: 'imap.example.com', smtpHost: 'smtp.example.com', user: 'me' });

  assert.throws(() => storeMailbox(id, 'me@example.com', '', cfg), /password is required/);

  storeMailbox(id, 'me@example.com', 'hunter2', cfg);
  const sealed = getLink(id, 'mailbox')!.refresh_token_enc;
  assert.doesNotMatch(sealed, /hunter2/); // never at rest in the clear
  assert.equal(openToken(sealed), 'hunter2');

  // Editing a port must not make the user retype the password. The seal is
  // nonce'd, so what must match is the plaintext, not the ciphertext.
  storeMailbox(id, 'me@example.com', '', { ...cfg, port: 1143 });
  assert.equal(openToken(getLink(id, 'mailbox')!.refresh_token_enc), 'hunter2');
  assert.equal(mailboxConfig(id)!.port, 1143);
  // The protocol rides `scopes` — that is what tells the ward IMAP from POP3.
  assert.equal(getLink(id, 'mailbox')!.scopes, 'imap');
});

test('a user-supplied mail host may never resolve into the private ranges', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.9.9', '169.254.1.1', '::1', '::ffff:127.0.0.1'])
    assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);

  await assert.rejects(() => publicAddress('127.0.0.1'), /private address/);
  await assert.rejects(() => publicAddress('localhost'), /private address/);
});

test('asAccount: an unknown account name never reaches a transport lookup', () => {
  assert.equal(asAccount('zoho'), 'zoho');
  assert.equal(asAccount('mailbox'), 'mailbox');
  assert.equal(asAccount('microsoft'), 'microsoft');
  assert.equal(asAccount('__proto__'), 'google');
  assert.equal(asAccount(undefined), 'google');
});

// The socket handling is imapflow's problem; the mapping from parsed MIME to
// what a ward renders is ours, and it is where a silent wrong answer lives.
test('mailView: a real multipart message maps to what the ward renders', async () => {
  const raw = [
    'From: "Jane Doe" <jane@example.com>',
    'To: me@example.com, "Bob" <bob@example.com>',
    'Cc: carol@example.com',
    'Subject: Quarterly numbers',
    'Date: Tue, 12 Aug 2025 09:30:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>See attached.</p>',
    '--b1',
    'Content-Type: text/csv; name="q3.csv"',
    'Content-Disposition: attachment; filename="q3.csv"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('a,b\n1,2\n').toString('base64'),
    '--b1--',
    '',
  ].join('\r\n');

  const parsed = await simpleParser(raw);
  const v = mailView('42', Object.assign(parsed, { flags: new Set(['\\Flagged']) }));

  assert.equal(v.id, '42');
  assert.equal(v.subject, 'Quarterly numbers');
  assert.deepEqual(v.from, { name: 'Jane Doe', address: 'jane@example.com' });
  assert.deepEqual(v.to.map((a) => a.address), ['me@example.com', 'bob@example.com']);
  assert.deepEqual(v.cc.map((a) => a.address), ['carol@example.com']);
  assert.equal(v.at, '2025-08-12T09:30:00.000Z');
  assert.match(v.html, /See attached/);
  // Flags decide unread/starred: no \Seen means unread, \Flagged means starred.
  assert.equal(v.unread, true);
  assert.equal(v.starred, true);
  assert.deepEqual(v.attachments, [{ id: '0', name: 'q3.csv', size: 8, mime: 'text/csv' }]);

  // POP3 carries no flags at all — the ward must read as read, never as a lie.
  assert.equal(mailView('42', await simpleParser(raw)).unread, false);
});
