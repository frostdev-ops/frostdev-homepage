import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../src/lib/db.ts';
import { saveDashboard } from '../src/lib/dashboard.ts';
import { validateLayout } from '../src/lib/wards.ts';
import { sendMessage, getMessage, listInbox, waitFor, sweepInbox, pump } from '../src/lib/agent/inbox.ts';
import { TOOLS } from '../src/lib/agent/tools.ts';

function seedUser(email: string): number {
  getDb().prepare(`INSERT INTO users (email, password_hash, role) VALUES (?, 'x', 'admin')`).run(email);
  const id = (getDb().prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: number }).id;
  saveDashboard(
    id,
    validateLayout([
      { i: 'ag1', type: 'agent', size: '2x2', config: {} },
      { i: 'ag2', type: 'agent', size: '2x2', title: 'Ops', config: {} },
    ])!
  );
  return id;
}

/** No provider is linked in tests, so sendMessage refuses at the credential
 *  gate. Rows are inserted directly to exercise the queue itself. */
function insert(userId: number, to: string, from: string, extra: Partial<{ mode: string; wait: number; reply_to: number; status: string; attempts: number }> = {}): number {
  return getDb()
    .prepare('INSERT INTO agent_inbox (user_id, ward, sender, mode, text, reply_to, wait, status, attempts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(userId, to, from, extra.mode ?? 'queue', 'hello', extra.reply_to ?? null, extra.wait ?? 0, extra.status ?? 'queued', extra.attempts ?? 0).lastInsertRowid as number;
}

const settle = async (userId: number, id: number) => {
  for (let i = 0; i < 100 && ['queued', 'delivered'].includes(getMessage(userId, id)!.status); i++) await new Promise((r) => setTimeout(r, 10));
  return getMessage(userId, id)!;
};

test('sendMessage validates before it writes a row', async () => {
  const u = seedUser('inbox-validate@x.dev');
  await assert.rejects(sendMessage(u, { to: 'ag2', from: 'ag1', text: '  ' }), /say something/);
  await assert.rejects(sendMessage(u, { to: 'ag2', from: 'ag1', text: 'x'.repeat(8001) }), /too long/);
  await assert.rejects(sendMessage(u, { to: 'ag1', from: 'ag1', text: 'hi' }), /that is you/);
  await assert.rejects(sendMessage(u, { to: 'nope', from: 'ag1', text: 'hi' }), /no agent ward/);
  await assert.rejects(sendMessage(u, { to: 'ag2', from: 'ag1', text: 'hi' }), /not configured/);
  assert.equal(listInbox(u, 'ag1').length, 0);
});

test('a delivery is a receipt: queued → delivered → failed with why, and a waiter hears it', async () => {
  const u = seedUser('inbox-receipt@x.dev');
  const id = insert(u, 'ag2', 'ag1', { wait: 1 });
  const waiting = waitFor(id);
  await pump(u, 'ag2');
  const row = await settle(u, id);
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, 1);
  assert.match(row.result, /not configured/);
  await assert.rejects(waiting, /not configured/);
  // The receipt tools read the same row; a waiter on a finished row answers at once.
  const r = (await TOOLS.check_message!.run({ id }, { userId: u, ward: 'ag1', conv: 0 })) as { status: string; result: string };
  assert.equal(r.status, 'failed');
  await assert.rejects(waitFor(id), /not configured/);
  const both = (await TOOLS.inbox!.run({}, { userId: u, ward: 'ag2', conv: 0 })) as { messages: { id: number }[] };
  assert.deepEqual(both.messages.map((m) => m.id), [id]);
  // Another user's message is not readable.
  const other = seedUser('inbox-other@x.dev');
  assert.equal(getMessage(other, id), null);
  // No reply-back hop for a failure.
  assert.equal(listInbox(u, 'ag1').length, 1);
});

test('pump delivers in order, one at a time, and a second pump is a no-op', async () => {
  const u = seedUser('inbox-order@x.dev');
  const a = insert(u, 'ag2', 'ag1');
  const b = insert(u, 'ag2', 'ag1');
  await Promise.all([pump(u, 'ag2'), pump(u, 'ag2')]);
  const ra = await settle(u, a);
  const rb = await settle(u, b);
  assert.equal(ra.status, 'failed');
  assert.equal(rb.status, 'failed');
  assert.equal(ra.attempts, 1);
  assert.equal(rb.attempts, 1);
});

test('sweep: boot re-arms every stranded delivery once, the tick only stale ones; a second strand fails it', async () => {
  const u = seedUser('inbox-sweep@x.dev');
  const fresh = insert(u, 'ag2', 'ag1', { status: 'delivered', attempts: 1 });
  const stale = insert(u, 'ag2', 'ag1', { status: 'delivered', attempts: 1 });
  const twice = insert(u, 'ag2', 'ag1', { status: 'delivered', attempts: 2 });
  getDb().prepare(`UPDATE agent_inbox SET delivered_at = datetime('now', '-2 hours') WHERE id IN (?, ?)`).run(stale, twice);
  await sweepInbox(false);
  assert.equal(getMessage(u, fresh)!.status, 'delivered', 'a fresh delivery may still be running');
  assert.match(getMessage(u, twice)!.result, /interrupted twice/);
  assert.equal((await settle(u, stale)).attempts, 2, 'the stale one ran again');
  await sweepInbox(true);
  assert.equal((await settle(u, fresh)).attempts, 2, 'at boot nothing can be in flight');
});

test('a message to a ward that left the layout fails cleanly', async () => {
  const u = seedUser('inbox-gone@x.dev');
  const id = insert(u, 'ag2', 'ag1');
  saveDashboard(u, validateLayout([{ i: 'ag1', type: 'agent', size: '2x2', config: {} }])!);
  await pump(u, 'ag2');
  assert.match((await settle(u, id)).result, /gone from the layout/);
});
