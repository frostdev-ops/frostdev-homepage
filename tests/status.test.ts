import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { TARGETS, GROUPS } from '../src/lib/targets.ts';
import { buildInfo, getHistory, queryIncidents, summarizePm2 } from '../src/lib/status.ts';
import { getDb } from '../src/lib/db.ts';

test('target ids are unique', () => {
  const ids = TARGETS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('every target group is in GROUPS', () => {
  const groups: readonly string[] = GROUPS;
  for (const t of TARGETS) assert.ok(groups.includes(t.group), `${t.id} has unknown group ${t.group}`);
});

test('getHistory: shape, ascending order, hours filtering', () => {
  const ins = getDb().prepare(
    `INSERT INTO status_history (service, ok, latency_ms, detail, checked_at)
     VALUES (?, ?, ?, ?, datetime('now', ?))`
  );
  ins.run('test-svc', 1, 42, 'HTTP 200', '-2 hours');
  ins.run('test-svc', 0, null, 'timeout', '-1 hours');
  ins.run('test-svc', null, null, 'probe failed', '-30 hours'); // outside 24h
  ins.run('other-svc', 1, 5, 'HTTP 200', '-1 hours'); // other service

  const rows = getHistory('test-svc', 24);
  assert.equal(rows.length, 2);
  assert.deepEqual(Object.keys(rows[0]!).sort(), ['ms', 'ok', 't']);
  assert.ok(rows[0]!.t < rows[1]!.t, 'ascending by checked_at');
  assert.equal(rows[0]!.ok, 1);
  assert.equal(rows[0]!.ms, 42);
  assert.equal(rows[1]!.ok, 0);
  assert.equal(rows[1]!.ms, null);
});

test('getHistory clamps hours to at most 7 days (larger window still works)', () => {
  const rows = getHistory('test-svc', 99999);
  assert.equal(rows.length, 3); // includes the -30h row, ok NULL comes back as null
  assert.equal(rows[0]!.ok, null);
});

test('getHistory clamps hours up to at least 1', () => {
  // hours=0 behaves as 1 hour: only rows strictly newer than -1h qualify; none are.
  assert.deepEqual(getHistory('test-svc', 0), []);
});

test('summarizePm2: cluster instances merge — any online wins, cpu/mem/restarts summed, limit from pm2_env', () => {
  const m = summarizePm2([
    { name: 'api', pm2_env: { status: 'online', restart_time: 3, max_memory_restart: 536870912 }, monit: { cpu: 2, memory: 100 * 2 ** 20 } },
    { name: 'api', pm2_env: { status: 'stopped', restart_time: 4, max_memory_restart: 536870912 }, monit: { cpu: 1, memory: 200 * 2 ** 20 } },
    { name: 'worker', pm2_env: { status: 'online', restart_time: 0 }, monit: { cpu: 0, memory: 50 * 2 ** 20 } },
    { name: 'legacy', pm2_env: { status: 'online', restart_time: 1, max_memory_restart: '512M' } },
  ]);
  assert.deepEqual(m.get('api'), { status: 'online', restarts: 7, cpu: 3, memMb: 300, limitMb: 512 });
  assert.equal(m.get('worker')!.limitMb, undefined);
  assert.equal(m.get('legacy')!.limitMb, undefined); // a string limit is not a byte count
  assert.equal(m.get('legacy')!.memMb, 0);
});

test('buildInfo: dev stamp under plain node, live rss, stable boot time', () => {
  const b = buildInfo();
  assert.equal(b.stamp, process.env.PUBLIC_APP_BUILD ?? 'dev');
  assert.ok(b.rssMb > 0);
  assert.equal(buildInfo().bootedAt, b.bootedAt);
});

test('queryIncidents: down→up spans from history, open spans first, host rows and null probes ignored', () => {
  const ins = getDb().prepare(
    `INSERT INTO status_history (service, ok, latency_ms, detail, checked_at) VALUES (?, ?, ?, ?, datetime('now', ?))`
  );
  // a: up up down null down up → one closed span from -4h to -1h
  for (const [ok, at] of [[1, '-6 hours'], [1, '-5 hours'], [0, '-4 hours'], [null, '-3 hours'], [0, '-2 hours'], [1, '-1 hours']] as const) ins.run('inc-a', ok, null, '', at);
  // b: down at -3h and -1h → open span from -3h
  for (const [ok, at] of [[0, '-3 hours'], [0, '-1 hours']] as const) ins.run('inc-b', ok, null, '', at);
  // c: up -2h, down -40m → open span from -40m (the newest open span sorts first)
  for (const [ok, at] of [[1, '-2 hours'], [0, '-40 minutes']] as const) ins.run('inc-c', ok, null, '', at);
  // host rows never count; d recovered before the window → no span
  ins.run('host:cpu', 0, 50, '', '-1 hours');
  for (const [ok, at] of [[0, '-30 hours'], [1, '-1 hours']] as const) ins.run('inc-d', ok, null, '', at);

  const spans = queryIncidents().filter((s) => s.service.startsWith('inc-'));
  assert.deepEqual(spans.map((s) => [s.service, s.up === null]), [['inc-c', true], ['inc-b', true], ['inc-a', false]]);
  for (const s of spans) assert.ok(Number.isFinite(Date.parse(s.down)), s.down);
  assert.ok(Number.isFinite(Date.parse(spans[2]!.up!)));
  assert.ok(Date.parse(spans[2]!.up!) - Date.parse(spans[2]!.down) > 2.9 * 3600_000);
});
