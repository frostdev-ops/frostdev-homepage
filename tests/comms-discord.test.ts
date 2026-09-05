import './_setup.ts';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_INTENTS, DiscordGateway, PRIVILEGED, discordClient, parseDispatch, toMessage, type WebSocketLike } from '../src/lib/comms/discord.ts';

// The gateway state machine and the payload parser, driven without a network:
// a fake socket the test serves frames into, mocked timers for the heartbeat.

class FakeSocket implements WebSocketLike {
  sent: any[] = [];
  closed: { code: number; reason: string }[] = [];
  private ls = new Map<string, ((ev: any) => void)[]>();
  url: string;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(t: string, fn: (ev: any) => void): void {
    this.ls.set(t, [...(this.ls.get(t) ?? []), fn]);
  }
  emit(t: string, ev: any): void {
    for (const fn of this.ls.get(t) ?? []) fn(ev);
  }
  serve(obj: unknown): void {
    this.emit('message', { data: JSON.stringify(obj) });
  }
  send(d: string): void {
    this.sent.push(JSON.parse(d));
  }
  close(code = 1000, reason = ''): void {
    this.closed.push({ code, reason });
    this.emit('close', { code, reason });
  }
  ops(): number[] {
    return this.sent.map((p) => p.op);
  }
  find(op: number): any {
    return this.sent.find((p) => p.op === op);
  }
}

function harness(token: string, intents = ALL_INTENTS) {
  const sockets: FakeSocket[] = [];
  const states: { status: string; error?: string; note?: string }[] = [];
  const dispatches: [string, any][] = [];
  const gw = new DiscordGateway({
    token,
    intents,
    ws: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    onState: (s) => states.push(s),
    onDispatch: (t, d) => dispatches.push([t, d]),
  });
  return { gw, sockets, states, dispatches };
}

const HELLO = { op: 10, d: { heartbeat_interval: 1000 } };
const READY = { op: 0, t: 'READY', s: 1, d: { session_id: 's1', resume_gateway_url: 'wss://resume.example', user: { id: 'bot1' } } };

test('gateway: hello → identify → ready; heartbeats; a missed ack closes 4000 and resumes on the resume url', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  try {
    const h = harness('token-aaaaaaaaaaaa');
    h.gw.start();
    assert.equal(h.sockets.length, 1);
    assert.match(h.sockets[0]!.url, /^wss:\/\/gateway\.discord\.gg\//);
    h.sockets[0]!.serve(HELLO);
    const identify = h.sockets[0]!.find(2);
    assert.ok(identify, 'identify sent');
    assert.equal(identify.d.token, 'token-aaaaaaaaaaaa');
    assert.equal(identify.d.intents, ALL_INTENTS);
    h.sockets[0]!.serve(READY);
    assert.equal(h.gw.selfId, 'bot1');
    assert.equal(h.states.at(-1)!.status, 'ready');
    assert.deepEqual(h.dispatches.at(-1)![0], 'READY');

    mock.timers.tick(1000); // first beat lands within one jittered interval
    assert.ok(h.sockets[0]!.ops().includes(1), 'heartbeat sent');
    assert.equal(h.sockets[0]!.find(1).d, 1, 'heartbeat carries the last seq');
    h.sockets[0]!.serve({ op: 11 });
    mock.timers.tick(1000); // second beat — never acked
    mock.timers.tick(1000); // third beat due: zombie
    assert.equal(h.sockets[0]!.closed.at(-1)?.code, 4000);

    mock.timers.tick(2000); // backoff ≤ 1.2s
    assert.equal(h.sockets.length, 2, 'reconnected');
    assert.match(h.sockets[1]!.url, /^wss:\/\/resume\.example\/\?v=10/);
    h.sockets[1]!.serve(HELLO);
    const resume = h.sockets[1]!.find(6);
    assert.ok(resume, 'resume sent, not identify');
    assert.equal(h.sockets[1]!.find(2), undefined);
    assert.deepEqual(resume.d, { token: 'token-aaaaaaaaaaaa', session_id: 's1', seq: 1 });
    h.sockets[1]!.serve({ op: 0, t: 'RESUMED', s: 2, d: {} });
    assert.equal(h.states.at(-1)!.status, 'ready');
    h.gw.stop();
    assert.equal(h.sockets[1]!.closed.at(-1)?.code, 1000);
    mock.timers.tick(120_000);
    assert.equal(h.sockets.length, 2, 'nothing reconnects after stop');
  } finally {
    mock.timers.reset();
  }
});

test('gateway: op 7 resumes, op 9 false re-identifies on a fresh session', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  try {
    const h = harness('token-bbbbbbbbbbbb');
    h.gw.start();
    h.sockets[0]!.serve(HELLO);
    h.sockets[0]!.serve(READY);
    h.sockets[0]!.serve({ op: 7 });
    assert.equal(h.sockets[0]!.closed.at(-1)?.code, 4000);
    mock.timers.tick(2000);
    h.sockets[1]!.serve(HELLO);
    assert.ok(h.sockets[1]!.find(6), 'resumed after op 7');
    // The server rejects the resume: identify again after a short wait.
    h.sockets[1]!.serve({ op: 9, d: false });
    assert.equal(h.sockets[1]!.find(2), undefined);
    mock.timers.tick(6_000); // the 1–5s wait…
    mock.timers.tick(6_000); // …then the 5s identify gate behind the first identify (a timer set inside a tick lands after it)
    assert.ok(h.sockets[1]!.find(2), 'identified after op 9');
    // …and a later drop goes to the main gateway url, since the session is gone.
    h.sockets[1]!.emit('close', { code: 1006, reason: '' });
    mock.timers.tick(3000);
    assert.match(h.sockets[2]!.url, /gateway\.discord\.gg/);
    h.gw.stop();
  } finally {
    mock.timers.reset();
  }
});

test('gateway: 4004 is fatal, 4014 retries once without the privileged intents', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  try {
    const a = harness('token-cccccccccccc');
    a.gw.start();
    a.sockets[0]!.serve(HELLO);
    a.sockets[0]!.emit('close', { code: 4004, reason: 'Authentication failed.' });
    assert.equal(a.states.at(-1)!.status, 'error');
    assert.match(a.states.at(-1)!.error!, /token/);
    mock.timers.tick(120_000);
    assert.equal(a.sockets.length, 1, 'no reconnect after a fatal close');

    const b = harness('token-dddddddddddd');
    b.gw.start();
    b.sockets[0]!.serve(HELLO);
    b.sockets[0]!.emit('close', { code: 4014, reason: 'Disallowed intent(s).' });
    assert.equal(b.sockets.length, 2, 'reconnects at once');
    b.sockets[1]!.serve(HELLO);
    assert.equal(b.sockets[1]!.find(2), undefined, 'the identify gate holds the second identify for 5s');
    mock.timers.tick(6_000);
    assert.equal(b.sockets[1]!.find(2).d.intents, ALL_INTENTS & ~PRIVILEGED);
    assert.match(b.gw.note, /developer portal/);
    b.sockets[1]!.emit('close', { code: 4014, reason: 'Disallowed intent(s).' });
    assert.equal(b.states.at(-1)!.status, 'error');
    b.gw.stop();
  } finally {
    mock.timers.reset();
  }
});

test('parseDispatch: own and bot messages drop; mentions, DMs and replies to the bot are mention=yes; reactions, joins, channel lists', () => {
  const base = { id: '9', channel_id: '22', guild_id: '1', content: 'hey', timestamp: '2026-09-03T10:00:00.000Z', author: { id: 'u1', username: 'ann', global_name: 'Ann' }, mentions: [] as any[] };
  assert.equal(parseDispatch('MESSAGE_CREATE', { ...base, author: { id: 'bot1', username: 'bot' } }, 'bot1'), null);
  assert.equal(parseDispatch('MESSAGE_CREATE', { ...base, author: { id: 'u2', username: 'other', bot: true } }, 'bot1'), null);
  const plain = parseDispatch('MESSAGE_CREATE', base, 'bot1');
  assert.equal(plain?.type, 'message');
  if (plain?.type !== 'message') throw new Error('unreachable');
  assert.equal(plain.message.mention, undefined);
  assert.equal(plain.message.from.name, 'Ann');
  assert.equal(plain.message.guild, '1');
  assert.equal(plain.message.at, Date.parse('2026-09-03T10:00:00.000Z'));
  const mentioned = parseDispatch('MESSAGE_CREATE', { ...base, mentions: [{ id: 'bot1' }] }, 'bot1');
  assert.equal(mentioned?.type === 'message' && mentioned.message.mention, true);
  const dm = parseDispatch('MESSAGE_CREATE', { ...base, guild_id: undefined }, 'bot1');
  assert.equal(dm?.type === 'message' && dm.message.mention, true);
  const reply = parseDispatch('MESSAGE_CREATE', { ...base, referenced_message: { id: '8', author: { id: 'bot1' } } }, 'bot1');
  assert.equal(reply?.type === 'message' && reply.message.mention, true);
  assert.equal(reply?.type === 'message' && reply.message.replyTo, '8');
  const withFile = toMessage({ ...base, attachments: [{ url: 'https://cdn.discordapp.com/x.png', filename: 'x.png', size: 12 }] }, 'bot1');
  assert.deepEqual(withFile.attachments, [{ url: 'https://cdn.discordapp.com/x.png', name: 'x.png', size: 12 }]);

  assert.equal(parseDispatch('MESSAGE_REACTION_ADD', { user_id: 'bot1', channel_id: '22', message_id: '9', emoji: { name: '👍' } }, 'bot1'), null);
  assert.deepEqual(parseDispatch('MESSAGE_REACTION_ADD', { user_id: 'u1', channel_id: '22', message_id: '9', guild_id: '1', emoji: { name: 'party', id: '555' }, member: { user: { username: 'ann' } } }, 'bot1'), {
    type: 'reaction',
    channel: '22',
    messageId: '9',
    emoji: 'party:555',
    from: { id: 'u1', name: 'ann' },
    guild: '1',
  });
  assert.deepEqual(parseDispatch('GUILD_MEMBER_ADD', { guild_id: '1', user: { id: 'u3', username: 'new' } }, 'bot1'), { type: 'member-joined', member: { id: 'u3', name: 'new' }, guild: '1' });
  assert.equal(parseDispatch('GUILD_MEMBER_ADD', { guild_id: '1', user: { id: 'u4', username: 'b', bot: true } }, 'bot1'), null);
  const gc = parseDispatch('GUILD_CREATE', { id: '1', name: 'Server', members: [{}, {}], channels: [{ id: '22', name: 'general', type: 0 }, { id: '23', name: 'cat', type: 4 }], threads: [{ id: '24', name: 't', type: 11, parent_id: '22' }] }, 'bot1');
  assert.deepEqual(gc, { type: 'channels', guild: '1', channels: [{ id: '22', name: 'general', kind: 'text' }, { id: '23', name: 'cat', kind: 'category' }, { id: '24', name: 't', kind: 'thread', parent: '22' }] });
  assert.equal(parseDispatch('PRESENCE_UPDATE', {}, 'bot1'), null);
});

test('rest: bot auth header, one 429 retry, a reply reference, history oldest-first', async () => {
  const calls: { url: string; init: any }[] = [];
  let first = true;
  const fake = (async (url: string, init: any) => {
    calls.push({ url, init });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (init.method === 'POST' && first) {
      first = false;
      return json(429, { retry_after: 0.001, message: 'You are being rate limited.' });
    }
    if (init.method === 'POST') return json(200, { id: '77', channel_id: '200000000000000002', content: JSON.parse(init.body).content, timestamp: '2026-09-03T10:00:00.000Z', author: { id: 'bot1', username: 'bot' } });
    if (url.endsWith('/users/@me')) return json(200, { id: 'bot1', username: 'rime' });
    if (url.endsWith('/oauth2/applications/@me')) return json(200, { id: 'app1' });
    if (url.includes('/messages?limit=')) return json(200, [{ id: '2', channel_id: '200000000000000002', content: 'newer', timestamp: '2026-09-03T10:01:00.000Z', author: { id: 'u1', username: 'a' } }, { id: '1', channel_id: '200000000000000002', content: 'older', timestamp: '2026-09-03T10:00:00.000Z', author: { id: 'u1', username: 'a' } }]);
    return json(404, { message: 'Unknown' });
  }) as unknown as typeof fetch;
  const c = discordClient('tok', { guild: '100000000000000001', channel: '200000000000000002', watch: 'all' }, 'test', fake);
  const me = await c.whoami();
  assert.equal(me.name, 'rime');
  assert.match(me.extra!.invite!, /client_id=app1&scope=bot/);
  assert.equal(calls[0]!.init.headers.authorization, 'Bot tok');
  const sent = await c.send('200000000000000002', 'hi there', { replyTo: '5' });
  assert.equal(sent.id, '77');
  assert.equal(sent.mine, true);
  const posts = calls.filter((x) => x.init.method === 'POST');
  assert.equal(posts.length, 2, 'retried once after 429');
  assert.deepEqual(JSON.parse(posts[1]!.init.body).message_reference, { message_id: '5', fail_if_not_exists: false });
  const h = await c.history('200000000000000002', 10);
  assert.deepEqual(h.map((m) => m.text), ['older', 'newer']);
  await assert.rejects(() => c.read('roles', {}), /Discord 404/);
  await assert.rejects(() => c.manage('nope', {}), /unknown op/);
  const noGuild = discordClient('tok', { guild: '', channel: '', watch: 'all' }, 'test2', fake);
  await assert.rejects(() => noGuild.read('roles', {}), /server id/);
});
