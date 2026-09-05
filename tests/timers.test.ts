import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../src/lib/db.ts';
import { saveDashboard } from '../src/lib/dashboard.ts';
import { validateLayout } from '../src/lib/wards.ts';
import { expireTimer, getTimers, runningTimers, writeTimerOp } from '../src/lib/timers.ts';
import { catchUpTimers, type FireEvent } from '../src/lib/logic-engine.ts';

function seedUser(email: string): number {
  getDb().prepare(`INSERT INTO users (email, password_hash, role) VALUES (?, 'x', 'admin')`).run(email);
  const id = (getDb().prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: number }).id;
  saveDashboard(
    id,
    validateLayout([
      { i: 't1', type: 'timer', size: '1x1', config: { duration: 60 } },
      { i: 't2', type: 'timer', size: '1x1', config: { duration: 120 } },
      { i: 't3', type: 'timer', size: '1x1', config: { duration: 60, rounds: 2, work: 1, rest: 1, long: 0 } },
      { i: 'f1', type: 'flow', size: '2x2' },
    ])!
  );
  return id;
}

test('writeTimerOp: state machine transitions', () => {
  const u = seedUser('t1@t.dev');
  const now = Date.now();

  assert.deepEqual(writeTimerOp(u, 'f1', 'start'), { error: 'not-a-timer' });
  assert.deepEqual(writeTimerOp(u, 'gone', 'start'), { error: 'not-a-timer' });
  assert.deepEqual(writeTimerOp(u, 't1', 'pause'), { error: 'bad-transition' }); // idle → pause

  const started = writeTimerOp(u, 't1', 'start');
  assert.ok('ok' in started);
  assert.equal(started.ok.state, 'running');
  assert.equal(started.ok.durationMs, 60_000);
  assert.ok(started.ok.endsAt! >= now + 59_000 && started.ok.endsAt! <= now + 61_000);

  assert.deepEqual(writeTimerOp(u, 't1', 'start'), { error: 'bad-transition' }); // running → start

  const paused = writeTimerOp(u, 't1', 'pause');
  assert.ok('ok' in paused);
  assert.equal(paused.ok.state, 'paused');
  assert.ok(paused.ok.remainingMs! > 55_000 && paused.ok.remainingMs! <= 60_000);

  // resume keeps the remaining time, not the full duration
  const resumed = writeTimerOp(u, 't1', 'start');
  assert.ok('ok' in resumed);
  assert.ok(resumed.ok.endsAt! <= Date.now() + paused.ok.remainingMs! + 1000);

  const reset = writeTimerOp(u, 't1', 'reset');
  assert.ok('ok' in reset && reset.ok.state === 'idle' && reset.ok.endsAt === null);

  // duration override (engine's timer.start action)
  const short = writeTimerOp(u, 't2', 'start', 5000);
  assert.ok('ok' in short);
  assert.ok(short.ok.endsAt! <= Date.now() + 5100);
});

test('getTimers: idle defaults for rowless wards, config duration', () => {
  const u = seedUser('t2@t.dev');
  const states = getTimers(u);
  assert.equal(states.length, 3); // t1, t2, t3 — f1 is not a timer
  assert.deepEqual(states.find((t) => t.ward === 't2'), { ward: 't2', state: 'idle', durationMs: 120_000, endsAt: null, remainingMs: null, step: 0 });
});

test('expireTimer: exactly-once, race-safe on ends_at mismatch', () => {
  const u = seedUser('t3@t.dev');
  const started = writeTimerOp(u, 't1', 'start');
  assert.ok('ok' in started);
  const endsAt = started.ok.endsAt!;

  assert.equal(expireTimer(u, 't1', endsAt - 999), null); // stale expiry from a raced restart
  const expired = expireTimer(u, 't1', endsAt);
  assert.ok(expired && expired.state === 'idle');
  assert.equal(expireTimer(u, 't1', endsAt), null); // second fire is a no-op
});

test('catchUpTimers: ≤1h-stale fires once, older goes idle silently, future re-arms', () => {
  const u = seedUser('t4@t.dev');
  writeTimerOp(u, 't1', 'start');
  writeTimerOp(u, 't2', 'start');
  const db = getDb();
  db.prepare('UPDATE timers SET ends_at = ? WHERE user_id = ? AND ward = ?').run(Date.now() - 5 * 60_000, u, 't1'); // 5 min late
  db.prepare('UPDATE timers SET ends_at = ? WHERE user_id = ? AND ward = ?').run(Date.now() - 2 * 3600_000, u, 't2'); // 2h late

  const fired: { userId: number; ev: FireEvent }[] = [];
  catchUpTimers((userId, ev) => fired.push({ userId, ev }));

  assert.deepEqual(fired, [{ userId: u, ev: { type: 'timer-finished', ward: 't1' } }]);
  assert.equal(runningTimers().filter((t) => t.userId === u).length, 0); // both idled
  // running it again fires nothing — expiry already consumed the rows
  fired.length = 0;
  catchUpTimers((userId, ev) => fired.push({ userId, ev }));
  assert.deepEqual(fired, []);
});

test('routine: each expiry advances the step and re-arms, the last fires routine-finished; skip and reset', () => {
  const u = seedUser('t5@t.dev');
  const db = getDb();
  const fired: FireEvent[] = [];
  const collect = (_userId: number, ev: FireEvent) => fired.push(ev);
  const t3 = () => getTimers(u).find((t) => t.ward === 't3')!;
  // steps: Focus 1m · Break 1m · Focus 1m (long break of 0 is omitted)
  assert.deepEqual(t3(), { ward: 't3', state: 'idle', durationMs: 60_000, endsAt: null, remainingMs: null, step: 0 });

  const backdate = () => db.prepare('UPDATE timers SET ends_at = ? WHERE user_id = ? AND ward = ?').run(Date.now() - 5000, u, 't3');
  assert.ok('ok' in writeTimerOp(u, 't3', 'start'));
  backdate();
  catchUpTimers(collect);
  assert.equal(fired.length, 1);
  assert.deepEqual(fired[0]!.match, { step: 'Focus' });
  assert.equal(fired[0]!.extra!['routine.done'], 'Focus');
  assert.equal(fired[0]!.extra!['routine.step'], 'Break');
  assert.equal(fired[0]!.extra!['routine.index'], '2');
  // re-armed on the next step
  assert.equal(t3().state, 'running');
  assert.equal(t3().step, 1);
  assert.equal(t3().durationMs, 60_000);

  fired.length = 0;
  backdate();
  catchUpTimers(collect);
  assert.deepEqual(fired[0]!.match, { step: 'Break' });
  assert.equal(t3().step, 2);
  fired.length = 0;
  backdate();
  catchUpTimers(collect);
  assert.deepEqual(fired.map((f) => f.type), ['timer-finished', 'routine-finished']);
  assert.equal(fired[1]!.extra!['routine.done'], 'Focus');
  assert.equal(t3().state, 'idle');
  assert.equal(t3().step, 3);

  // a start after the routine finished wraps to step 0
  assert.ok('ok' in writeTimerOp(u, 't3', 'start'));
  assert.equal(t3().step, 0);
  assert.deepEqual(writeTimerOp(u, 't1', 'skip'), { error: 'bad-transition' }); // a plain timer has no steps
  const skipped = writeTimerOp(u, 't3', 'skip');
  assert.ok('ok' in skipped && skipped.ok.state === 'idle' && skipped.ok.step === 1);
  assert.deepEqual(writeTimerOp(u, 't3', 'skip'), { error: 'bad-transition' }); // idle
  assert.ok('ok' in writeTimerOp(u, 't3', 'start'));
  assert.equal(t3().step, 1);
  const reset = writeTimerOp(u, 't3', 'reset');
  assert.ok('ok' in reset && reset.ok.step === 0 && reset.ok.durationMs === 60_000);

  // a 2h-stale routine idles on the SAME step: no fire, no advance, no re-arm
  fired.length = 0;
  assert.ok('ok' in writeTimerOp(u, 't3', 'start'));
  db.prepare('UPDATE timers SET ends_at = ? WHERE user_id = ? AND ward = ?').run(Date.now() - 2 * 3600_000, u, 't3');
  catchUpTimers(collect);
  assert.deepEqual(fired, []);
  assert.equal(t3().state, 'idle');
  assert.equal(t3().step, 0);
});
