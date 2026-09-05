import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../src/lib/db.ts';
import { getDashboard, saveDashboard } from '../src/lib/dashboard.ts';
import { validateLayout } from '../src/lib/wards.ts';
import type { LogicEdge } from '../src/lib/logic.ts';
import { createPacket, listPackets } from '../src/lib/flow.ts';
import { writeTimerOp } from '../src/lib/timers.ts';
import {
  ACTION_EXECS,
  CONDITION_EXECS,
  WATCHERS,
  classifyWeather,
  crossings,
  dailyClock,
  dueDate,
  dueProbe,
  eventsSoonProbe,
  fireAndWait,
  getGraph,
  getRuns,
  itemsProbe,
  mailProbe,
  pageProbe,
  restartProbe,
  soleService,
  takeSlot,
  pressButton,
  pruneUserLogic,
  saveGraph,
  subscribeLogic,
  watchTick,
  type FireCtx,
} from '../src/lib/logic-engine.ts';
import type { MailMessage } from '../src/lib/google.ts';
import { BOOT_ID, type ServiceStatus } from '../src/lib/status.ts';
import { getSetting, setSetting } from '../src/lib/settings.ts';
import type { CalEvent } from '../src/lib/calendar.ts';
import { sqliteMs } from '../src/lib/flow.ts';
import type { ChecklistItem } from '../src/lib/notion.ts';

const PAGE_ID = 'deadbeef-dead-beef-dead-beefdeadbeef';

function seedUser(email: string): number {
  getDb().prepare(`INSERT INTO users (email, password_hash, role) VALUES (?, 'x', 'admin')`).run(email);
  const id = (getDb().prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: number }).id;
  saveDashboard(
    id,
    validateLayout([
      { i: 't1', type: 'timer', size: '1x1', config: { duration: 60 } },
      { i: 't2', type: 'timer', size: '1x1', config: { duration: 60 } },
      { i: 'f1', type: 'flow', size: '2x2' },
      { i: 'f2', type: 'flow', size: '2x2' },
      { i: 'sv1', type: 'service-group', size: '1x1', config: { services: ['frostdev-io'] } },
      { i: 'sg2', type: 'service-group', size: '2x1', config: { services: ['frostdev-io', 'rewind'] } },
      { i: 'h1', type: 'service-group', size: '2x1', config: { services: ['host:cpu', 'host:mem', 'host:disk'] } },
      { i: 'b1', type: 'button', size: '1x1' },
    ])!
  );
  return id;
}

function mkEdge(id: string, over: Partial<LogicEdge>): LogicEdge {
  return {
    id,
    source: { ward: 't1', trigger: 'timer-finished', params: {} },
    conditions: [],
    action: { type: 'notion.capture-append', params: { text: 'x' } },
    enabled: true,
    ...over,
  };
}

test('errors are recorded per edge and never stop sibling edges', async () => {
  const u = seedUser('e1@t.dev');
  saveGraph(u, {
    edges: [
      mkEdge('boom', {}),
      mkEdge('fine', { action: { type: 'notion.check-task', params: { pageId: PAGE_ID } } }),
    ],
  });
  const origAppend = ACTION_EXECS['notion.capture-append']!;
  const origCheck = ACTION_EXECS['notion.check-task']!;
  ACTION_EXECS['notion.capture-append'] = async () => {
    throw new Error('kaboom');
  };
  ACTION_EXECS['notion.check-task'] = async () => 'patched-ok';
  try {
    await fireAndWait(u, { type: 'timer-finished', ward: 't1' });
  } finally {
    ACTION_EXECS['notion.capture-append'] = origAppend;
    ACTION_EXECS['notion.check-task'] = origCheck;
  }
  const runs = getRuns(u);
  assert.equal(runs.boom!.result, 'error');
  assert.equal(runs.boom!.detail, 'kaboom');
  assert.deepEqual(runs.fine, { ...runs.fine!, result: 'ok', detail: 'patched-ok' });
});

test('a notion/checklist action tells open tabs to refresh; others do not', async () => {
  const u = seedUser('refresh@t.dev');
  const seen: { event: string; data: unknown }[] = [];
  const unsub = subscribeLogic(u, (event, data) => seen.push({ event, data }));
  const origCheck = ACTION_EXECS['notion.check-task']!;
  const origReset = ACTION_EXECS['timer.reset']!;
  ACTION_EXECS['notion.check-task'] = async () => 'ok';
  ACTION_EXECS['timer.reset'] = async () => 'ok';
  try {
    saveGraph(u, { edges: [mkEdge('n', { action: { type: 'notion.check-task', params: { pageId: PAGE_ID } } })] });
    await fireAndWait(u, { type: 'timer-finished', ward: 't1' });
    assert.deepEqual(
      seen.filter((s) => s.event === 'refresh').map((s) => s.data),
      [{ link: 'notion' }]
    );

    seen.length = 0;
    saveGraph(u, { edges: [mkEdge('t', { action: { type: 'timer.reset', ward: 't2', params: {} } })] });
    await fireAndWait(u, { type: 'timer-finished', ward: 't1' });
    assert.equal(seen.filter((s) => s.event === 'refresh').length, 0);
  } finally {
    ACTION_EXECS['notion.check-task'] = origCheck;
    ACTION_EXECS['timer.reset'] = origReset;
    unsub();
  }
});

test('conditions AND; failing condition records skipped; matching runs', async () => {
  const u = seedUser('e2@t.dev');
  saveGraph(u, {
    edges: [
      mkEdge('picky', {
        source: { ward: 'f1', trigger: 'packet-arrived', params: {} },
        conditions: [{ type: 'packet-text-matches', params: { pattern: 'urgent' } }],
        action: { type: 'notion.check-task', params: { pageId: PAGE_ID } },
      }),
    ],
  });
  const orig = ACTION_EXECS['notion.check-task']!;
  ACTION_EXECS['notion.check-task'] = async () => 'ran';
  try {
    const calm = createPacket(u, 'f1', 'inbox', 'nothing special');
    await fireAndWait(u, { type: 'packet-arrived', ward: 'f1', channel: 'inbox', packet: calm });
    assert.equal(getRuns(u).picky!.result, 'skipped');

    const hot = createPacket(u, 'f1', 'inbox', 'this is URGENT stuff'); // case-insensitive
    await fireAndWait(u, { type: 'packet-arrived', ward: 'f1', channel: 'inbox', packet: hot });
    assert.equal(getRuns(u).picky!.result, 'ok');
  } finally {
    ACTION_EXECS['notion.check-task'] = orig;
  }
});

test('channel filter: non-matching events record nothing', async () => {
  const u = seedUser('e3@t.dev');
  saveGraph(u, {
    edges: [
      mkEdge('filtered', {
        source: { ward: 'f1', trigger: 'packet-arrived', params: { channel: 'only-this' } },
        action: { type: 'notion.check-task', params: { pageId: PAGE_ID } },
      }),
    ],
  });
  const p = createPacket(u, 'f1', 'other', 'hi');
  await fireAndWait(u, { type: 'packet-arrived', ward: 'f1', channel: 'other', packet: p });
  assert.equal(getRuns(u).filtered, undefined);
});

test('self-cascading emit hits the hop budget and stops with an error run', async () => {
  const u = seedUser('e4@t.dev');
  saveGraph(u, {
    edges: [
      mkEdge('looper', {
        source: { ward: 'f1', trigger: 'packet-arrived', params: { channel: 'loop' } },
        action: { type: 'flow.emit', ward: 'f1', params: { channel: 'loop', text: 'again: {{packet.text}}' } },
      }),
    ],
  });
  const seed = createPacket(u, 'f1', 'loop', 'go');
  await fireAndWait(u, { type: 'packet-arrived', ward: 'f1', channel: 'loop', packet: seed });
  const runs = getRuns(u);
  assert.equal(runs.looper!.result, 'error');
  assert.equal(runs.looper!.detail, 'cascade budget exhausted');
  // the cascade really ran: templated packets piled up before the budget hit
  assert.ok(listPackets(u, 'f1').some((p) => p.text.startsWith('again: again:')));
});

test('pass-waiting fan-out is bounded by the TOTAL cascade budget', async () => {
  const u = seedUser('e4b@t.dev');
  saveGraph(u, {
    edges: [
      mkEdge('fan', {
        source: { ward: 'f1', trigger: 'packet-passed', params: {} },
        action: { type: 'flow.pass-waiting', ward: 'f1', params: {} },
      }),
    ],
  });
  for (let i = 0; i < 6; i++) createPacket(u, 'f1', 'inbox', `p${i}`);
  const seed = createPacket(u, 'f1', 'inbox', 'seed');
  const t0 = Date.now();
  await fireAndWait(u, { type: 'packet-passed', ward: 'f1', channel: 'inbox', packet: seed });
  // a depth-only budget would explode ~N^depth here; the total budget keeps
  // it to at most MAX_FIRES fire() invocations
  assert.ok(Date.now() - t0 < 3000, `cascade took ${Date.now() - t0}ms`);
  assert.equal(getRuns(u).fan!.result, 'error');
  assert.equal(getRuns(u).fan!.detail, 'cascade budget exhausted');
});

test('mail.send rate cap trips after 10 attempts per hour', async () => {
  const u = seedUser('e5@t.dev');
  saveGraph(u, {
    edges: [
      mkEdge('mailer', {
        source: { ward: 't2', trigger: 'timer-finished', params: {} },
        action: { type: 'mail.send', params: { account: 'google', to: ['a@b.co'], body: 'hi' } },
      }),
    ],
  });
  // No linked account → every attempt errors 'not-linked', but each still
  // consumes a rate slot; the 11th must trip the cap instead.
  for (let i = 0; i < 10; i++) {
    await fireAndWait(u, { type: 'timer-finished', ward: 't2' });
    assert.equal(getRuns(u).mailer!.detail, 'not-linked');
  }
  await fireAndWait(u, { type: 'timer-finished', ward: 't2' });
  assert.equal(getRuns(u).mailer!.detail, 'mail rate limit');
});

test('per-user queue serializes concurrent firings', async () => {
  const u = seedUser('e6@t.dev');
  saveGraph(u, {
    edges: [
      mkEdge('slow', {
        source: { ward: 't1', trigger: 'timer-finished', params: {} },
        action: { type: 'webhook.post', params: { url: 'https://example.com/hook' } },
      }),
    ],
  });
  const orig = ACTION_EXECS['webhook.post']!;
  const spans: [number, number][] = [];
  ACTION_EXECS['webhook.post'] = async () => {
    const start = Date.now();
    await new Promise((r) => setTimeout(r, 25));
    spans.push([start, Date.now()]);
    return 'ok';
  };
  try {
    await Promise.all([
      fireAndWait(u, { type: 'timer-finished', ward: 't1' }),
      fireAndWait(u, { type: 'timer-finished', ward: 't1' }),
      fireAndWait(u, { type: 'timer-finished', ward: 't1' }),
    ]);
  } finally {
    ACTION_EXECS['webhook.post'] = orig;
  }
  assert.equal(spans.length, 3);
  for (let i = 1; i < spans.length; i++) assert.ok(spans[i]![0] >= spans[i - 1]![1], 'firings overlapped');
});

test('watchTick: baseline, transition fire, filter match, probe error surfacing', async () => {
  const u = seedUser('w1@t.dev');
  saveGraph(u, {
    edges: [
      mkEdge('on-down', {
        source: { ward: 'sv1', trigger: 'service-status', params: { to: 'down' } },
        action: { type: 'notion.check-task', params: { pageId: PAGE_ID } },
      }),
      mkEdge('on-up', {
        source: { ward: 'sv1', trigger: 'service-status', params: { to: 'up' } },
        action: { type: 'notion.check-task', params: { pageId: PAGE_ID } },
      }),
    ],
  });
  const fired: string[] = [];
  const origAct = ACTION_EXECS['notion.check-task']!;
  ACTION_EXECS['notion.check-task'] = async (ctx) => {
    fired.push(`${ctx.vars['service.state']}:${ctx.vars['service.label']}`);
    return 'noted';
  };
  const origWatch = WATCHERS['service-status']!;
  let state = 'up';
  WATCHERS['service-status'] = {
    intervalMs: 0,
    probe: async (_ctx, prev) => {
      const fires =
        prev !== undefined && prev !== state
          ? [{ match: { to: state }, extra: { 'service.label': 'frostdev.io', 'service.state': state } }]
          : [];
      return { state, fires };
    },
  };
  try {
    await watchTick(1_000); // baseline — no fires
    await fireAndWait(u, { type: 'timer-finished', ward: 't1' }); // drain queue
    assert.deepEqual(fired, []);

    state = 'down';
    await watchTick(2_000);
    await fireAndWait(u, { type: 'timer-finished', ward: 't1' });
    assert.deepEqual(fired, ['down:frostdev.io']); // only the to:'down' edge matched
    assert.equal(getRuns(u)['on-down']!.result, 'ok');
    assert.equal(getRuns(u)['on-up'], undefined);

    // probe failure lands as an error run on every edge in the group
    WATCHERS['service-status'] = {
      intervalMs: 0,
      probe: async () => {
        throw new Error('probe exploded');
      },
    };
    await watchTick(3_000);
    assert.equal(getRuns(u)['on-up']!.detail, 'watch: probe exploded');
    assert.equal(getRuns(u)['on-down']!.detail, 'watch: probe exploded');
  } finally {
    ACTION_EXECS['notion.check-task'] = origAct;
    WATCHERS['service-status'] = origWatch;
  }
});

test('every watcher: per-edge clocks, baseline, period elapse, onlyEdge', async () => {
  const u = seedUser('w2@t.dev');
  const edges = [
    mkEdge('fast', { source: { ward: 't1', trigger: 'every', params: { minutes: 1 } } }),
    mkEdge('slow', { source: { ward: 't1', trigger: 'every', params: { minutes: 10 } } }),
  ];
  const probe = WATCHERS.every!.probe;
  const ctx = (now: number) => ({ userId: u, ward: 't1', config: {}, edges, now });

  const t0 = 1_000_000;
  const base = await probe(ctx(t0), undefined);
  assert.deepEqual(base.fires, []); // baseline: clocks start now

  const early = await probe(ctx(t0 + 30_000), base.state);
  assert.deepEqual(early.fires, []);

  const oneMin = await probe(ctx(t0 + 61_000), early.state);
  assert.deepEqual(oneMin.fires, [{ onlyEdge: 'fast' }]); // slow's 10min not up yet

  const tenMin = await probe(ctx(t0 + 10 * 60_000 + 1_000), oneMin.state);
  assert.deepEqual(
    tenMin.fires.map((f) => f.onlyEdge).sort(),
    ['fast', 'slow']
  );
});

const msg = (id: string, subject = id): MailMessage =>
  ({ id, from: { name: '', address: `${id}@x.co` }, subject, threadId: '', snippet: '', at: '', unread: true, starred: false, hasAttachments: false });

test('mailProbe: baseline, dedupe, cap 3 oldest-first, archive does not refire', async () => {
  const inbox = (...ids: string[]) => async () => ids.map((id) => msg(id));

  const base = await mailProbe(undefined, inbox('m5', 'm4', 'm3', 'm2', 'm1'));
  assert.deepEqual(base.fires, []); // first sight = baseline

  // one new mail fires once, with sender/subject vars
  const one = await mailProbe(base.state, inbox('m6', 'm5', 'm4', 'm3', 'm2'));
  assert.deepEqual(one.fires.map((f) => f.extra!['mail.from']), ['m6@x.co']);

  // burst of 5 new: cap 3, oldest of the capped three first
  const burst = await mailProbe(one.state, inbox('m11', 'm10', 'm9', 'm8', 'm7'));
  assert.deepEqual(burst.fires.map((f) => f.extra!['mail.subject']), ['m9', 'm10', 'm11']);

  // user archives the new mail → old m1-m5 slide back into the top-5 window;
  // they were seen long ago and must NOT refire
  const archived = await mailProbe(burst.state, inbox('m5', 'm4', 'm3', 'm2', 'm1'));
  assert.deepEqual(archived.fires, []);

  // merged rows carry their account: the firing matches on it and exposes the var
  const tagged = await mailProbe(archived.state, async () => [{ ...msg('z1'), account: 'zoho' as const }, msg('m5')]);
  assert.deepEqual(tagged.fires.map((f) => f.match), [{ account: 'zoho' }]);
  assert.equal(tagged.fires[0]!.extra!['mail.account'], 'zoho');
  // an untagged row (a legacy single-account probe) fires with no match, so any edge takes it
  const plain = await mailProbe(tagged.state, async () => [msg('p1')]);
  assert.equal(plain.fires[0]!.match, undefined);
  assert.equal(plain.fires[0]!.extra!['mail.account'], '');
});

test('button-pressed fires the graph; presses are capped per user per hour', async () => {
  const u = seedUser('btn@t.dev');
  saveGraph(u, {
    edges: [mkEdge('press', { source: { ward: 'b1', trigger: 'button-pressed', params: {} }, action: { type: 'notion.check-task', params: { pageId: PAGE_ID } } })],
  });
  const origAct = ACTION_EXECS['notion.check-task']!;
  const titles: string[] = [];
  ACTION_EXECS['notion.check-task'] = async (ctx) => {
    titles.push(ctx.vars['trigger.wardTitle']!);
    return 'noted';
  };
  try {
    pressButton(u, 'b1');
    await fireAndWait(u, { type: 'timer-finished', ward: 't1' }); // drain the queue
    assert.deepEqual(titles, ['Button']);
    assert.equal(getRuns(u).press!.result, 'ok');
  } finally {
    ACTION_EXECS['notion.check-task'] = origAct;
  }
  const win = new Map<number, number[]>();
  for (let i = 0; i < 30; i++) takeSlot(win, u, 30, 'press');
  assert.throws(() => takeSlot(win, u, 30, 'press'), /press rate limit/);
});

test('restartProbe: baseline, delta fires once, drop re-baselines, holds on unknown, pm2 only', () => {
  const svc = (restarts?: number, kind = 'pm2'): ServiceStatus =>
    ({ id: 'api', label: 'api', group: 'processes', kind: kind as ServiceStatus['kind'], ok: true, latencyMs: null, detail: 'online', since: null, ...(restarts === undefined ? {} : { restarts }) });
  assert.deepEqual(restartProbe(undefined, svc(5)), { state: 5, fires: [] });
  const up = restartProbe(5, svc(7));
  assert.equal(up.state, 7);
  assert.equal(up.fires.length, 1);
  assert.equal(up.fires[0]!.extra!['service.restartsDelta'], '2');
  assert.equal(up.fires[0]!.extra!['service.restarts'], '7');
  assert.deepEqual(restartProbe(7, svc(7)).fires, []);
  assert.deepEqual(restartProbe(7, svc(0)), { state: 0, fires: [] }); // pm2 delete/resurrect: re-baseline
  assert.equal(restartProbe(0, svc(1)).fires.length, 1);
  assert.deepEqual(restartProbe(5, undefined), { state: 5, fires: [] }); // snapshot warming up
  assert.deepEqual(restartProbe(5, svc(undefined)), { state: 5, fires: [] }); // pm2 unreachable
  assert.throws(() => restartProbe(5, svc(3, 'http')), /only pm2/);
});

test('a service trigger on a two-member group lands as an error run, not a fire', async () => {
  const u = seedUser('sg@t.dev');
  saveGraph(u, {
    edges: [
      mkEdge('two', {
        source: { ward: 'sg2', trigger: 'service-status', params: {} },
        action: { type: 'notion.check-task', params: { pageId: PAGE_ID } },
      }),
    ],
  });
  await watchTick(40_000);
  assert.equal(getRuns(u).two!.detail, 'watch: needs a single-service ward');
});

test('soleService: a one-member group, nothing else', () => {
  assert.equal(soleService({ services: ['frostdev-io'] }), 'frostdev-io');
  assert.throws(() => soleService({ services: ['a', 'b'] }), /single-service/);
  assert.throws(() => soleService({ group: 'frostdev' }), /single-service/);
});

test('deploy-landed: first sight is the baseline row, a new boot id fires once per user', async () => {
  const u = seedUser('deploy@t.dev');
  saveGraph(u, {
    edges: [
      mkEdge('on-deploy', {
        source: { ward: 'h1', trigger: 'deploy-landed', params: {} },
        action: { type: 'notion.check-task', params: { pageId: PAGE_ID } },
      }),
    ],
  });
  const stamps: unknown[] = [];
  const origAct = ACTION_EXECS['notion.check-task']!;
  ACTION_EXECS['notion.check-task'] = async (ctx) => {
    stamps.push(ctx.vars['build.stamp']);
    return 'noted';
  };
  try {
    // Ticks 40 s apart: the watcher's interval is 30 s (a tick at 1 s is throttled).
    await watchTick(40_000); // baseline: the row is written, nothing fires
    await fireAndWait(u, { type: 'timer-finished', ward: 't1' });
    assert.deepEqual(stamps, []);
    assert.equal(getSetting(`deploy_seen:${u}`), BOOT_ID);
    await watchTick(80_000);
    await fireAndWait(u, { type: 'timer-finished', ward: 't1' });
    assert.deepEqual(stamps, []);
    setSetting(`deploy_seen:${u}`, 'previous-boot'); // the server restarted since the row was written
    await watchTick(120_000);
    await fireAndWait(u, { type: 'timer-finished', ward: 't1' });
    assert.equal(stamps.length, 1);
    assert.equal(typeof stamps[0], 'string');
    await watchTick(160_000);
    await fireAndWait(u, { type: 'timer-finished', ward: 't1' });
    assert.equal(stamps.length, 1);
  } finally {
    ACTION_EXECS['notion.check-task'] = origAct;
  }
});

test('watcher state sweeps when a group disappears — recreation re-baselines', async () => {
  const u = seedUser('w3@t.dev');
  const watchedEdge = mkEdge('watch-me', {
    source: { ward: 'sv1', trigger: 'service-status', params: {} },
    action: { type: 'notion.check-task', params: { pageId: PAGE_ID } },
  });
  const prevs: unknown[] = [];
  const origWatch = WATCHERS['service-status']!;
  WATCHERS['service-status'] = {
    intervalMs: 0,
    probe: async (ctx, prev) => {
      if (ctx.userId === u) prevs.push(prev);
      return { state: 'observed', fires: [] };
    },
  };
  try {
    saveGraph(u, { edges: [watchedEdge] });
    await watchTick(1_000);
    await watchTick(2_000);
    assert.deepEqual(prevs, [undefined, 'observed']); // baseline, then carried state

    saveGraph(u, { edges: [] }); // rule deleted → group vanishes → state swept
    await watchTick(3_000);
    saveGraph(u, { edges: [watchedEdge] }); // rule recreated a "week" later
    await watchTick(4_000);
    assert.equal(prevs[2], undefined); // fresh BASELINE — no phantom replay of unwatched transitions
  } finally {
    WATCHERS['service-status'] = origWatch;
  }
});

test('sqliteMs parses datetime(now) text as UTC, never local', () => {
  assert.equal(sqliteMs('2026-08-30 14:02:11'), Date.parse('2026-08-30T14:02:11Z'));
});

test('dueDate: literal, today, +Nd; garbage throws', () => {
  const now = Date.parse('2026-08-30T12:00:00Z');
  assert.equal(dueDate('2026-09-15', now), '2026-09-15');
  assert.equal(dueDate('today', now), '2026-08-30'); // TZ pinned UTC in _setup
  assert.equal(dueDate('+3d', now), '2026-09-02');
  assert.throws(() => dueDate('next tuesday', now));
});

const clockCtx = (now: number, edges: ReturnType<typeof mkEdge>[]) => ({ userId: 1, ward: 't1', config: {}, edges, now });

test('dailyClock: baseline claims a past target, fires at target once, drops >1h-late fires', async () => {
  const edges = [mkEdge('seven', { source: { ward: 't1', trigger: 'at-time-of-day', params: { at: '07:00' } } })];
  const day1_0730 = Date.parse('2026-08-30T07:30:00Z');
  const base = await dailyClock(clockCtx(day1_0730, edges), undefined);
  assert.deepEqual(base.fires, []); // 07:00 already past → claimed, no back-fire

  const day2_0659 = Date.parse('2026-08-31T06:59:00Z');
  assert.deepEqual((await dailyClock(clockCtx(day2_0659, edges), base.state)).fires, []);
  const day2_0701 = Date.parse('2026-08-31T07:01:00Z');
  const fired = await dailyClock(clockCtx(day2_0701, edges), base.state);
  assert.deepEqual(fired.fires, [{ onlyEdge: 'seven' }]);
  // not again the same day
  assert.deepEqual((await dailyClock(clockCtx(day2_0701 + 60_000, edges), fired.state)).fires, []);
  // a suspended VM waking at 15:00 must not deliver 07:00
  const day3_1500 = Date.parse('2026-09-01T15:00:00Z');
  const late = await dailyClock(clockCtx(day3_1500, edges), fired.state);
  assert.deepEqual(late.fires, []);
});

test('crossings: baseline, threshold, hysteresis dead band', () => {
  const edges = [mkEdge('hot', { source: { ward: 't1', trigger: 'host-crossed', params: { metric: 'mem', pct: 90 } } })];
  let value = 85;
  const opts = { band: () => 5, read: () => value, threshold: () => 90, extra: () => ({}) };
  const base = crossings(clockCtx(0, edges), undefined, opts);
  assert.deepEqual(base.fires, []);
  value = 90; // exactly the threshold → above
  const up = crossings(clockCtx(0, edges), base.state, opts);
  assert.equal(up.fires[0]?.match?.to, 'above');
  value = 87; // inside the dead band (90-5=85) → still above, no fire
  const held = crossings(clockCtx(0, edges), up.state, opts);
  assert.deepEqual(held.fires, []);
  value = 84; // below the band → fires below
  const down = crossings(clockCtx(0, edges), held.state, opts);
  assert.equal(down.fires[0]?.match?.to, 'below');
});

test('packet-idle: baseline claims aged packets silently; watched crossing fires once with the packet', async () => {
  const u = seedUser('pi@t.dev');
  const aged = createPacket(u, 'f1', 'slowlane', 'ancient of days');
  getDb().prepare(`UPDATE packets SET created_at = datetime('now', '-45 minutes') WHERE id = ?`).run(aged.id);
  const edges = [mkEdge('idle30', { source: { ward: 'f1', trigger: 'packet-idle', params: { minutes: 30 } } })];
  const ctx = (now: number) => ({ userId: u, ward: 'f1', config: {}, edges, now });
  const probe = WATCHERS['packet-idle']!.probe;

  const base = await probe(ctx(Date.now()), undefined);
  assert.deepEqual(base.fires, []); // 45-min-old packet at baseline: claimed, not replayed

  const young = createPacket(u, 'f1', 'slowlane', 'fresh');
  const early = await probe(ctx(Date.now()), base.state);
  assert.deepEqual(early.fires, []); // not yet 30 min
  getDb().prepare(`UPDATE packets SET created_at = datetime('now', '-31 minutes') WHERE id = ?`).run(young.id);
  const fired = await probe(ctx(Date.now()), early.state);
  assert.equal(fired.fires.length, 1);
  assert.equal(fired.fires[0]!.channel, 'slowlane');
  assert.equal(fired.fires[0]!.packet?.id, young.id);
  assert.equal(fired.fires[0]!.onlyEdge, 'idle30');
  // and never again
  assert.deepEqual((await probe(ctx(Date.now()), fired.state)).fires, []);
});

const item = (id: string, over: Partial<ChecklistItem> = {}): ChecklistItem => ({
  id,
  title: id,
  done: false,
  due: null,
  url: `https://notion.so/${id}`,
  created: '2026-08-30T10:00:00.000Z',
  edited: '2026-08-30T10:00:00.000Z',
  fields: {},
  ...over,
});
const loadItems = (items: ChecklistItem[]) => async () => ({ db: 'db1', items });

test('itemsProbe: added vs slid-in, done/unchecked/renamed/changed, gated removal', async () => {
  const now = Date.parse('2026-08-30T12:00:00Z');
  const a = item('a');
  const base = await itemsProbe(undefined, loadItems([a]), now);
  assert.deepEqual(base.fires, []);

  // OLD row sliding into the window is NOT "added"; a post-baseline creation is
  const oldRow = item('old', { created: '2026-08-30T09:00:00.000Z' });
  const newRow = item('new', { created: '2026-08-30T12:05:00.000Z' });
  const s1 = await itemsProbe(base.state, loadItems([a, oldRow, newRow]), now + 6 * 60_000);
  assert.deepEqual(s1.fires.map((f) => [f.match?.what, f.extra?.['item.title']]), [['added', 'new']]);

  // done outranks edit; rename carries titleWas; edit alone is "changed"
  const s2 = await itemsProbe(
    s1.state,
    loadItems([
      { ...a, done: true, edited: '2026-08-30T12:10:00.000Z' },
      { ...oldRow, title: 'renamed!', edited: '2026-08-30T12:11:00.000Z' },
      { ...newRow, edited: '2026-08-30T12:12:00.000Z' },
    ]),
    now + 15 * 60_000
  );
  assert.deepEqual(
    s2.fires.map((f) => f.match?.what).sort(),
    ['changed', 'checked', 'renamed']
  );
  assert.equal(s2.fires.find((f) => f.match?.what === 'renamed')?.extra?.['item.titleWas'], 'old');

  // removal fires only when both reads saw the WHOLE db
  const s3 = await itemsProbe(s2.state, loadItems([{ ...a, done: true, edited: '2026-08-30T12:10:00.000Z' }]), now + 20 * 60_000);
  assert.deepEqual(s3.fires.map((f) => [f.match?.what, f.extra?.['item.title']]).sort(), [
    ['removed', 'new'],
    ['removed', 'renamed!'],
  ]);

  // a full page (>= CHECKLIST_PAGE_SIZE rows) suppresses removal verdicts
  const fifty = Array.from({ length: 50 }, (_, i) => item(`x${i}`));
  const f1 = await itemsProbe(undefined, loadItems(fifty), now);
  const f2 = await itemsProbe(f1.state, loadItems(fifty.slice(1)), now + 6 * 60_000);
  assert.ok(!f2.fires.some((f) => f.match?.what === 'removed')); // prev read was a full window — silent
});

test('dueProbe: baseline pre-marks, one fire per item per day, day rollover re-arms', async () => {
  const d30noon = Date.parse('2026-08-30T12:00:00Z');
  const dueToday = item('t', { due: '2026-08-30' });
  const dueTomorrow = item('m', { due: '2026-08-31' });
  const base = await dueProbe(undefined, loadItems([dueToday, dueTomorrow]), d30noon);
  assert.deepEqual(base.fires, []); // both already due-ish → pre-marked, no blast

  const becameDue = item('n', { due: '2026-08-30' });
  const s1 = await dueProbe(base.state, loadItems([dueToday, dueTomorrow, becameDue]), d30noon + 120_000);
  assert.deepEqual(s1.fires.map((f) => [f.match?.when, f.extra?.['item.title']]), [['today', 'n']]);
  assert.deepEqual((await dueProbe(s1.state, loadItems([dueToday, dueTomorrow, becameDue]), d30noon + 240_000)).fires, []);

  // next day: everything re-arms once — today's items fire again, once
  const d31noon = Date.parse('2026-08-31T12:00:00Z');
  const s2 = await dueProbe(s1.state, loadItems([dueToday, dueTomorrow, becameDue]), d31noon);
  assert.deepEqual(
    s2.fires.map((f) => [f.match?.when, f.extra?.['item.title']]).sort(),
    [
      ['overdue', 'n'],
      ['overdue', 't'],
      ['today', 'm'],
    ]
  );
  assert.deepEqual((await dueProbe(s2.state, loadItems([dueToday, dueTomorrow, becameDue]), d31noon + 60_000)).fires, []);
});

const condCtx = (vars: Record<string, string>): FireCtx => ({ userId: 0, firing: { left: 1, poisoned: new Set() }, vars });

test('var-contains: contains / not-contains over trigger vars', async () => {
  const exec = CONDITION_EXECS['var-contains']!;
  const ctx = condCtx({ 'mail.fromAddress': 'boss@corp.example', 'mail.subject': 'Weekly Newsletter' });
  assert.equal(await exec(ctx, { key: 'mail.fromAddress', mode: 'contains', text: 'BOSS@' }), true); // case-insensitive
  assert.equal(await exec(ctx, { key: 'mail.subject', mode: 'not-contains', text: 'newsletter' }), false);
  assert.equal(await exec(ctx, { key: 'event.title', mode: 'contains', text: 'x' }), false); // absent var → ''
  assert.equal(await exec(ctx, { key: 'event.title', mode: 'not-contains', text: 'x' }), true);
});

test('time-between: plain and past-midnight wrap windows', async () => {
  const exec = CONDITION_EXECS['time-between']!;
  const now = new Date();
  const shift = (h: number) => `${String((now.getHours() + h + 24) % 24).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const ctx = condCtx({});
  assert.equal(await exec(ctx, { from: shift(-2), to: shift(2) }), true); // inside a plain window
  assert.equal(await exec(ctx, { from: shift(1), to: shift(2) }), false); // outside
  assert.equal(await exec(ctx, { from: shift(2), to: shift(1) }), true); // wrap: covers everything except [+1h,+2h)
});

test('eventsSoonProbe: fires on future in-window events at first sight, claims started ones silently', () => {
  const now = Date.parse('2026-08-30T12:00:00Z');
  const ev = (id: string, startOffsetMin: number, over: Partial<CalEvent> = {}): CalEvent => ({
    id,
    source: 'google',
    calendar: 'primary',
    title: id,
    start: new Date(now + startOffsetMin * 60_000).toISOString(),
    end: new Date(now + (startOffsetMin + 30) * 60_000).toISOString(),
    allDay: false,
    location: '',
    ...over,
  });
  const edges = [mkEdge('soon', { source: { ward: 'cal', trigger: 'event-starting-soon', params: { withinMinutes: 15 } } })];

  const events = [ev('inwin', 10), ev('started', -5), ev('far', 60), ev('allday', 5, { allDay: true })];
  const first = eventsSoonProbe(undefined, events, edges, now);
  // The deliberate deviation: in-window FUTURE event fires even on first sight
  // (a deploy 10 min before a meeting must not eat the alert)…
  assert.deepEqual(first.fires.map((f) => f.extra?.['event.title']), ['inwin']);
  assert.equal(first.fires[0]!.extra?.['event.in'], '10');
  // …while an already-started event is claimed silently, and far/allday are untouched.

  // no refire; 'far' fires when it enters the window; a reschedule is a fresh heads-up
  const second = eventsSoonProbe(first.state, events, edges, now + 60_000);
  assert.deepEqual(second.fires, []);
  const later = eventsSoonProbe(second.state, events, edges, now + 50 * 60_000);
  assert.deepEqual(later.fires.map((f) => f.extra?.['event.title']), ['far']);
  const moved = [{ ...events[0]!, start: new Date(now + 55 * 60_000).toISOString() }];
  const resched = eventsSoonProbe(later.state, moved, edges, now + 45 * 60_000);
  assert.deepEqual(resched.fires.map((f) => f.extra?.['event.title']), ['inwin']); // new start = new key
});

test('classifyWeather buckets WMO codes', () => {
  assert.equal(classifyWeather(0), 'clear');
  assert.equal(classifyWeather(3), 'clouds');
  assert.equal(classifyWeather(45), 'fog');
  assert.equal(classifyWeather(61), 'rain');
  assert.equal(classifyWeather(75), 'snow');
  assert.equal(classifyWeather(85), 'snow');
  assert.equal(classifyWeather(96), 'storm');
  assert.equal(classifyWeather(80), 'rain');
});

test('pruneUserLogic: removing ONE ward keeps every healthy edge (no graph collapse)', async () => {
  const u = seedUser('e7@t.dev');
  writeTimerOp(u, 't1', 'start');
  createPacket(u, 'f1', 'inbox', 'stranded');
  saveGraph(u, {
    edges: [
      mkEdge('doomed', {}), // t1 → f1, both about to vanish
      mkEdge('healthy', { source: { ward: 't2', trigger: 'timer-finished', params: {} }, action: { type: 'notion.capture-append', params: { text: 'still here' } } }),
    ],
  });
  await fireAndWait(u, { type: 'timer-finished', ward: 't1' }); // leaves run rows for both? at least 'doomed'

  const fullLayout = getDashboard(u);
  saveDashboard(u, validateLayout([{ i: 't2', type: 'timer', size: '1x1', config: { duration: 60 } }])!);
  pruneUserLogic(u);

  assert.equal((getDb().prepare(`SELECT COUNT(*) AS n FROM timers WHERE user_id = ? AND ward = 't1'`).get(u) as { n: number }).n, 0);
  assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM packets WHERE user_id = ?').get(u) as { n: number }).n, 0);
  assert.deepEqual(getGraph(u).edges.map((e) => e.id), ['healthy']); // NOT []
  // the stale edge stays DORMANT in storage (not deleted): restoring the ward
  // (the remove-ward Undo toast) revives its automations with it
  const raw = JSON.parse((getDb().prepare('SELECT graph_json FROM logic_graphs WHERE user_id = ?').get(u) as { graph_json: string }).graph_json);
  assert.deepEqual(raw.edges.map((e: { id: string }) => e.id).sort(), ['doomed', 'healthy']);
  saveDashboard(u, fullLayout);
  assert.deepEqual(getGraph(u).edges.map((e) => e.id).sort(), ['doomed', 'healthy']); // revived
});

// ------------------------------------------------------------- page probe

const pageLoad = (over: {
  page?: string;
  edited?: string;
  props?: Record<string, string>;
  comments?: { id: string; text: string; author: string }[];
}) =>
  async () => ({
    page: over.page ?? 'pg1',
    meta: { title: 'Plan', url: 'https://notion.so/pg1', edited: over.edited ?? '2026-08-30T10:00:00.000Z' },
    props: Object.fromEntries(Object.entries(over.props ?? { Status: 'To-do' }).map(([k, v]) => [k, { text: v }])),
    comments: over.comments ?? [],
  });

test('pageProbe: first sight baselines and fires nothing', async () => {
  const first = await pageProbe(undefined, pageLoad({}));
  assert.deepEqual(first.fires, []);
  assert.deepEqual((first.state as { props: Record<string, string> }).props, { Status: 'To-do' });
});

test('pageProbe: a property change fires with both values, not a bare "edited"', async () => {
  const base = await pageProbe(undefined, pageLoad({}));
  const next = await pageProbe(base.state, pageLoad({ props: { Status: 'Done' }, edited: '2026-08-30T11:00:00.000Z' }));
  assert.equal(next.fires.length, 1);
  assert.deepEqual(next.fires[0]!.match, { what: 'property', prop: 'Status' });
  assert.equal(next.fires[0]!.extra?.['prop.was'], 'To-do');
  assert.equal(next.fires[0]!.extra?.['prop.value'], 'Done');
  assert.equal(next.fires[0]!.extra?.['page.id'], 'pg1');
});

test('pageProbe: a new comment fires once, and never again', async () => {
  const base = await pageProbe(undefined, pageLoad({}));
  const withComment = pageLoad({ comments: [{ id: 'c1', text: 'hi', author: 'Sam' }], edited: '2026-08-30T11:00:00.000Z' });
  const first = await pageProbe(base.state, withComment);
  assert.equal(first.fires.length, 1);
  assert.deepEqual(first.fires[0]!.match, { what: 'comment' });
  assert.equal(first.fires[0]!.extra?.['comment.author'], 'Sam');
  assert.deepEqual((await pageProbe(first.state, withComment)).fires, []);
});

test('pageProbe: "edited" is the fallback only — a specific change never double-fires', async () => {
  const base = await pageProbe(undefined, pageLoad({}));
  // body edited, properties untouched → the catch-all
  const bodyOnly = await pageProbe(base.state, pageLoad({ edited: '2026-08-30T12:00:00.000Z' }));
  assert.deepEqual(bodyOnly.fires.map((f) => f.match?.what), ['edited']);
  // property AND stamp move together → one fire, the specific one
  const propToo = await pageProbe(bodyOnly.state, pageLoad({ props: { Status: 'Done' }, edited: '2026-08-30T13:00:00.000Z' }));
  assert.deepEqual(propToo.fires.map((f) => f.match?.what), ['property']);
});

test('pageProbe: a re-pointed ward re-baselines instead of firing the whole diff', async () => {
  const base = await pageProbe(undefined, pageLoad({}));
  const moved = await pageProbe(base.state, pageLoad({ page: 'pg2', props: { Status: 'Done', Owner: 'Sam' } }));
  assert.deepEqual(moved.fires, []);
  assert.equal((moved.state as { page: string }).page, 'pg2');
});
