import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../src/lib/db.ts';
import { saveDashboard } from '../src/lib/dashboard.ts';
import { validateLayout } from '../src/lib/wards.ts';
import { scheduleWake, cancelWake, listWakes, runDueWakes, getWake } from '../src/lib/agent/wakes.ts';

function seedUser(email: string): number {
  getDb().prepare(`INSERT INTO users (email, password_hash, role) VALUES (?, 'x', 'admin')`).run(email);
  const id = (getDb().prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: number }).id;
  saveDashboard(id, validateLayout([{ i: 'ag1', type: 'agent', size: '2x2', config: {} }])!);
  return id;
}

test('scheduleWake validates and caps at 20 active', () => {
  const u = seedUser('wake-cap@x.dev');
  assert.throws(() => scheduleWake(u, 'ag1', '   ', 5), /say what/);
  assert.throws(() => scheduleWake(u, 'ag1', 'x', 0), /between 1 and/);
  assert.throws(() => scheduleWake(u, 'ag1', 'x', 999_999), /between 1 and/);
  for (let i = 0; i < 20; i++) scheduleWake(u, 'ag1', `job ${i}`, 60);
  assert.throws(() => scheduleWake(u, 'ag1', 'one too many', 60), /too many scheduled wakes/);
  assert.equal(listWakes(u).length, 20);
});

test('cancelWake only cancels own scheduled rows', () => {
  const u1 = seedUser('wake-own@x.dev');
  const u2 = seedUser('wake-other@x.dev');
  const w = scheduleWake(u1, 'ag1', 'later', 30);
  assert.equal(cancelWake(w.id, u2), false, 'not yours');
  assert.equal(cancelWake(w.id, u1), true);
  assert.equal(cancelWake(w.id, u1), false, 'already cancelled');
  assert.equal(getWake(w.id)!.status, 'cancelled');
});

test('runDueWakes claims atomically and the doomed run fails cleanly', async () => {
  const u = seedUser('wake-run@x.dev');
  const w = scheduleWake(u, 'ag1', 'check things', 1);
  // Force it due.
  getDb().prepare('UPDATE agent_tasks SET run_at = ? WHERE id = ?').run(Date.now() - 1000, w.id);
  const claimed = await runDueWakes();
  assert.equal(claimed, 1);
  // The headless run kicks off async and fails fast (no provider configured);
  // poll briefly for the settled status.
  for (let i = 0; i < 50 && getWake(w.id)!.status === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const done = getWake(w.id)!;
  assert.equal(done.status, 'failed');
  assert.match(done.result, /not configured/);
  // Already claimed — a second sweep finds nothing.
  assert.equal(await runDueWakes(), 0);
});
