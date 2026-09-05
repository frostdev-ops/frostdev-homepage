import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../src/lib/db.ts';
import {
  annotatePacket,
  completePacket,
  createPacket,
  deleteOrphanPackets,
  getPacket,
  listPackets,
  listWaiting,
  markPassed,
  movePacket,
} from '../src/lib/flow.ts';

function seedUser(email: string): number {
  getDb().prepare(`INSERT INTO users (email, password_hash, role) VALUES (?, 'x', 'admin')`).run(email);
  return (getDb().prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: number }).id;
}

test('packet lifecycle leaves a full trail', () => {
  const u = seedUser('f1@t.dev');
  const p = createPacket(u, 'a', 'inbox', '  hello world  ');
  assert.equal(p.text, 'hello world');
  assert.equal(p.status, 'waiting');
  assert.deepEqual(p.history.map((h) => h.event), ['created']);

  assert.deepEqual(annotatePacket(u, p.id, 'checked the thing')!.history.at(-1)!.note, 'checked the thing');
  assert.equal(markPassed(u, p.id)!.history.at(-1)!.event, 'passed');

  const moved = movePacket(u, p.id, 'b', 'triage')!;
  assert.equal(moved.ward, 'b');
  assert.equal(moved.channel, 'triage');
  assert.equal(moved.history.at(-1)!.note, 'from a');

  const done = completePacket(u, p.id)!;
  assert.equal(done.status, 'done');
  assert.deepEqual(getPacket(u, p.id)!.history.map((h) => h.event), ['created', 'annotated', 'passed', 'moved', 'completed']);

  // done packets can't move, complete twice is a no-op
  assert.equal(movePacket(u, p.id, 'a', 'inbox'), null);
  assert.equal(completePacket(u, p.id), null);
});

test('listPackets: waiting first; listWaiting filters; user isolation', () => {
  const u = seedUser('f2@t.dev');
  const other = seedUser('f2b@t.dev');
  const p1 = createPacket(u, 'a', 'inbox', 'one');
  createPacket(u, 'a', 'inbox', 'two');
  createPacket(other, 'a', 'inbox', 'not yours');
  completePacket(u, p1.id);

  const list = listPackets(u, 'a');
  assert.deepEqual(list.map((p) => [p.text, p.status]), [['two', 'waiting'], ['one', 'done']]);
  assert.deepEqual(listWaiting(u, 'a').map((p) => p.text), ['two']);
  assert.equal(getPacket(u, listPackets(other, 'a')[0]!.id), null);
});

test('history trimmed to 50 entries, note capped at 200 chars', () => {
  const u = seedUser('f3@t.dev');
  const p = createPacket(u, 'a', 'inbox', 'busy');
  for (let i = 0; i < 60; i++) annotatePacket(u, p.id, `note ${i} ${'x'.repeat(250)}`);
  const history = getPacket(u, p.id)!.history;
  assert.equal(history.length, 50);
  assert.ok(history.at(-1)!.note!.startsWith('note 59'));
  assert.ok(history.at(-1)!.note!.length <= 200);
});

test('prune-on-write: 7-day done TTL and the 200 cap (done evicted first)', () => {
  const u = seedUser('f4@t.dev');
  const old = createPacket(u, 'a', 'inbox', 'ancient');
  completePacket(u, old.id);
  getDb().prepare(`UPDATE packets SET updated_at = datetime('now', '-8 days') WHERE user_id = ? AND id = ?`).run(u, old.id);
  createPacket(u, 'a', 'inbox', 'fresh');
  assert.equal(getPacket(u, old.id), null); // TTL pruned

  const doomed = createPacket(u, 'a', 'inbox', 'done-and-doomed');
  completePacket(u, doomed.id);
  for (let i = 0; i < 205; i++) createPacket(u, 'a', 'inbox', `p${i}`);
  const count = (getDb().prepare('SELECT COUNT(*) AS n FROM packets WHERE user_id = ?').get(u) as { n: number }).n;
  assert.ok(count <= 200, `count ${count}`);
  assert.equal(getPacket(u, doomed.id), null); // done went before waiting
});

test('deleteOrphanPackets removes rows for wards gone from the layout', () => {
  const u = seedUser('f5@t.dev');
  createPacket(u, 'live', 'inbox', 'keep');
  createPacket(u, 'dead', 'inbox', 'drop');
  assert.deepEqual(deleteOrphanPackets(u, new Set(['live'])), ['dead']);
  assert.equal(listPackets(u, 'dead').length, 0);
  assert.equal(listPackets(u, 'live').length, 1);
});
