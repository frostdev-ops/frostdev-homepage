import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../src/lib/db.ts';
import { getDashboard, saveDashboard } from '../src/lib/dashboard.ts';
import { validateLayout } from '../src/lib/wards.ts';
import { validateGraph, type LogicEdge } from '../src/lib/logic.ts';
import { fireAndWait, getRuns, saveGraph } from '../src/lib/logic-engine.ts';
import { channelsSeen, ingest, listMessages, searchMessages } from '../src/lib/comms/store.ts';
import {
  commsConfig,
  commsStatus,
  handleEvent,
  hasCommsToken,
  messageEvent,
  reactionEvent,
  resetCommsForTests,
  sendChat,
  setClientBuilderForTests,
  setCommsToken,
  watched,
  type Conn,
} from '../src/lib/comms/index.ts';
import type { ChatMessage, CommsClient } from '../src/lib/comms/types.ts';
import { agentWardConfig, takeHeadlessSlot } from '../src/lib/agent/core.ts';
import { TOOLS } from '../src/lib/agent/tools.ts';

const G = '100000000000000001';
const C = '200000000000000002';
const OTHER = '300000000000000003';

function seedUser(email: string, withComms = true): number {
  getDb().prepare(`INSERT INTO users (email, password_hash, role) VALUES (?, 'x', 'admin')`).run(email);
  const id = (getDb().prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: number }).id;
  saveDashboard(
    id,
    validateLayout([
      ...(withComms ? [{ i: 'dc', type: 'discord', size: '2x2', config: { guild: G, channel: C, watch: 'all' } }] : []),
      { i: 'ag1', type: 'agent', size: '2x2', config: { headlessCap: 20 } },
      { i: 'f1', type: 'flow', size: '2x2' },
      { i: 'n1', type: 'note', size: '2x2' },
    ])!
  );
  return id;
}

interface Sent {
  channel: string;
  text: string;
  opts: unknown;
}
function fakeClient(sent: Sent[]): CommsClient {
  return {
    type: 'discord',
    destRe: /^\d{5,25}$/,
    maxText: 2000,
    ops: { read: [], manage: [], moderate: [] },
    whoami: async () => ({ id: 'bot', name: 'Bot' }),
    channels: async () => [{ id: C, name: 'general', kind: 'text' }],
    nameOf: (id) => (id === C ? 'general' : undefined),
    history: async () => [],
    send: async (channel, text, opts) => {
      sent.push({ channel, text, opts });
      return { id: `m${sent.length}`, channel, from: { id: 'bot', name: 'Bot' }, text, at: Date.now() };
    },
    react: async () => {},
    read: async (what) => (what === 'message' ? null : { what }),
    manage: async () => null,
    moderate: async () => null,
    live: () => () => {},
  };
}

const msg = (id: string, over: Partial<ChatMessage> = {}): ChatMessage => ({ id, channel: C, from: { id: 'u1', name: 'Ann' }, text: `text ${id}`, at: 1_700_000_000_000 + Number(id) * 1000, guild: G, ...over });
const flush = (u: number) => fireAndWait(u, { type: 'noop', ward: 'none' });

test('validateConfig: discord ids are snowflakes or empty, watch is all or a csv of ids; agent headlessCap 1–60 (6 = default, dropped)', () => {
  const u = seedUser('cfg@c.dev', false);
  saveDashboard(
    u,
    validateLayout([
      { i: 'a', type: 'discord', size: '2x2', config: { guild: ` ${G} `, channel: 'nope', watch: `a, ${C} ,b` } },
      { i: 'b', type: 'discord', size: '2x2', config: {} },
      { i: 'ag', type: 'agent', size: '2x2', config: { headlessCap: 6 } },
      { i: 'ag2', type: 'agent', size: '2x2', config: { headlessCap: 5000, rounds: '' } },
      { i: 'ag3', type: 'agent', size: '2x2', config: { headlessCap: 0, rounds: 0 } },
      { i: 'ag4', type: 'agent', size: '2x2', config: { headlessCap: '40', rounds: '12' } },
    ])!
  );
  const l = getDashboard(u);
  assert.deepEqual(l[0]!.config, { guild: G, channel: '', watch: C });
  assert.deepEqual(l[1]!.config, { guild: '', channel: '', watch: 'all' });
  assert.equal(l[2]!.config!.headlessCap, undefined);
  assert.equal(l[3]!.config!.headlessCap, undefined, 'out of range is dropped');
  assert.equal(l[3]!.config!.rounds, undefined, 'an empty field is absent, never 0');
  assert.deepEqual([l[4]!.config!.headlessCap, l[4]!.config!.rounds], [0, 0]);
  assert.deepEqual([l[5]!.config!.headlessCap, l[5]!.config!.rounds], [40, 12]);
  assert.equal(agentWardConfig(u, 'ag')!.headlessCap, 6);
  assert.equal(agentWardConfig(u, 'ag')!.rounds, undefined);
  assert.deepEqual([agentWardConfig(u, 'ag3')!.headlessCap, agentWardConfig(u, 'ag3')!.rounds], [0, 0]);
  // 0 = no hourly cap: the slot never refuses.
  for (let i = 0; i < 30; i++) takeHeadlessSlot(u, 'ag3');
  takeHeadlessSlot(u, 'ag'); // the default 6 still counts
  assert.deepEqual(commsConfig(l[0]!), { type: 'discord', channel: '', watch: [C], guild: G });
  assert.deepEqual(commsConfig(l[1]!).watch, 'all');
});

test('store: the primary key dedupes, the batch reports only what inserted, search and channels, trim to 500', () => {
  const u = seedUser('store@c.dev');
  assert.deepEqual(ingest(u, 'dc', [msg('1'), msg('2')]).map((m) => m.id), ['1', '2']);
  assert.deepEqual(ingest(u, 'dc', [msg('2'), msg('3', { channelName: 'general', attachments: [{ url: 'https://cdn.discordapp.com/a.png', name: 'a.png' }] })]).map((m) => m.id), ['3']);
  assert.deepEqual(listMessages(u, 'dc', C, 10).map((m) => m.id), ['3', '2', '1']);
  assert.deepEqual(listMessages(u, 'dc', C, 10)[0]!.attachments, [{ url: 'https://cdn.discordapp.com/a.png', name: 'a.png' }]);
  assert.deepEqual(searchMessages(u, 'dc', 'text 2').map((m) => m.id), ['2']);
  assert.deepEqual(searchMessages(u, 'dc', '%').map((m) => m.id), []); // LIKE wildcards are escaped
  assert.deepEqual(channelsSeen(u, 'dc'), [{ id: C, name: 'general' }]);
  ingest(u, 'dc', Array.from({ length: 600 }, (_, i) => msg(String(100 + i))));
  assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM comms_messages WHERE user_id = ? AND ward = ?').get(u, 'dc') as { n: number }).n, 500);
  assert.equal(listMessages(u, 'dc', null, 1)[0]!.id, '699', 'the newest survive the trim');
});

test('watched: the guild must match, DMs always count, a watch list narrows', () => {
  const all = { type: 'discord' as const, channel: C, watch: 'all' as const, guild: G };
  assert.equal(watched(all, msg('1')), true);
  assert.equal(watched(all, msg('1', { guild: OTHER })), false);
  assert.equal(watched(all, msg('1', { guild: undefined, direct: true })), true);
  const some = { ...all, watch: [OTHER] };
  assert.equal(watched(some, msg('1')), false);
  assert.equal(watched(some, msg('1', { channel: OTHER })), true);
  assert.equal(watched(some, msg('1', { threadId: OTHER })), true);
  assert.equal(watched(some, msg('1', { guild: undefined, direct: true })), true);
  assert.equal(watched(some, msg('1', { guild: undefined })), false);
});

test('graph: message-arrived/reaction-added anchor on the chat ward, chat.send needs one, agent.ask may deliver to one and not to a note', () => {
  const u = seedUser('graph@c.dev');
  const layout = getDashboard(u);
  const edge = (id: string, trigger: string, action: LogicEdge['action'], params: Record<string, unknown> = {}): LogicEdge => ({ id, source: { ward: 'dc', trigger, params }, conditions: [], action, enabled: true });
  const ok = validateGraph(
    {
      edges: [
        edge('e1', 'message-arrived', { type: 'chat.send', ward: 'dc', params: { text: 'hi {{msg.from}}' } }, { mention: 'yes' }),
        edge('e2', 'reaction-added', { type: 'chat.send', ward: 'dc', params: { channel: C, text: '{{reaction.emoji}} from {{reaction.from}}' } }),
        edge('e3', 'message-arrived', { type: 'agent.ask', ward: 'ag1', params: { prompt: '{{msg.text}}', deliverTo: 'dc' } }),
        edge('e4', 'member-joined', { type: 'chat.react', ward: 'dc', params: { emoji: '👋' } }),
      ],
    },
    layout,
    { isAdmin: true }
  );
  assert.ok(ok);
  assert.equal(ok.edges.length, 4);
  assert.equal(validateGraph({ edges: [edge('x', 'message-arrived', { type: 'agent.ask', ward: 'ag1', params: { prompt: 'p', deliverTo: 'n1' } })] }, layout, { isAdmin: true }), null);
  assert.equal(validateGraph({ edges: [edge('x', 'message-arrived', { type: 'chat.send', params: { text: 'p' } })] }, layout, { isAdmin: true }), null);
  assert.equal(validateGraph({ edges: [{ ...edge('x', 'message-arrived', { type: 'chat.send', ward: 'dc', params: { text: 'p' } }), source: { ward: 'n1', trigger: 'message-arrived', params: {} } }] }, layout, { isAdmin: true }), null);
});

test('events: a stored message fires message-arrived with filters and vars, chat.send answers where it came from, a replay is silent, reactions carry the message', async () => {
  const sent: Sent[] = [];
  setClientBuilderForTests(() => fakeClient(sent));
  try {
    const u = seedUser('events@c.dev');
    saveGraph(
      u,
      validateGraph(
        {
          edges: [
            { id: 'e1', source: { ward: 'dc', trigger: 'message-arrived', params: { mention: 'yes' } }, conditions: [], action: { type: 'chat.send', ward: 'dc', params: { text: 'hi {{msg.from}} in #{{msg.channelName}}' } }, enabled: true },
            { id: 'e2', source: { ward: 'dc', trigger: 'reaction-added', params: {} }, conditions: [], action: { type: 'chat.send', ward: 'dc', params: { channel: OTHER, text: '{{reaction.from}} reacted {{reaction.emoji}} to "{{msg.text}}"' } }, enabled: true },
            { id: 'e3', source: { ward: 'dc', trigger: 'member-joined', params: {} }, conditions: [], action: { type: 'chat.send', ward: 'dc', params: { text: 'welcome {{member.name}}' } }, enabled: true },
          ],
        },
        getDashboard(u),
        { isAdmin: true }
      )!
    );
    setCommsToken(u, 'dc', { token: 'sekrit' });
    assert.equal(hasCommsToken(u, 'dc'), true);
    const st = commsStatus(u, getDashboard(u)[0]!);
    assert.equal(st.hasToken, true);
    assert.equal(st.status, 'connecting');
    // The connection the sync opened is the fake; hand it events.
    const conn: Conn = { key: 'k', userId: u, type: 'discord', wards: new Set(['dc']), client: fakeClient(sent), status: 'ready', stop: () => {} };

    await handleEvent(conn, { type: 'message', message: msg('1') }); // no mention → e1 skipped
    await flush(u);
    assert.equal(sent.length, 0);
    assert.equal(listMessages(u, 'dc', C, 5).length, 1);

    await handleEvent(conn, { type: 'message', message: msg('2', { mention: true }) });
    await flush(u);
    assert.equal(sent.length, 1);
    assert.deepEqual([sent[0]!.channel, sent[0]!.text], [C, 'hi Ann in #general']);
    assert.equal(getRuns(u)['e1']!.result, 'ok');
    assert.equal(listMessages(u, 'dc', C, 5).filter((m) => m.mine).length, 1, 'the outbound reply is stored as mine');

    await handleEvent(conn, { type: 'message', message: msg('2', { mention: true }) }); // replayed: already stored
    await flush(u);
    assert.equal(sent.length, 1, 'a replay never fires');

    await handleEvent(conn, { type: 'message', message: msg('3', { mention: true, guild: OTHER }) }); // another server
    await flush(u);
    assert.equal(sent.length, 1);

    await handleEvent(conn, { type: 'reaction', channel: C, messageId: '1', emoji: '👍', from: { id: 'u2', name: 'Bob' }, guild: G });
    await flush(u);
    assert.equal(sent.length, 2);
    assert.deepEqual([sent[1]!.channel, sent[1]!.text], [OTHER, 'Bob reacted 👍 to "text 1"']);

    await handleEvent(conn, { type: 'member-joined', member: { id: 'u9', name: 'Zed' }, guild: G });
    await flush(u);
    assert.equal(sent[2]!.text, 'welcome Zed');

    const ev = messageEvent('dc', msg('4', { mention: true }));
    assert.deepEqual(ev.match, { from: 'u1', mention: 'yes' });
    assert.equal(ev.channel, C);
    assert.equal(reactionEvent('dc', { type: 'reaction', channel: C, messageId: '9', emoji: 'x', from: { id: 'u', name: 'U' } }, null).extra!['msg.id'], '9');

    // Destinations: never a template, always the client's id shape.
    await assert.rejects(() => sendChat(u, 'dc', 'general', 'x'), /not a discord channel id/);
    await assert.rejects(() => sendChat(u, 'dc', undefined, '   '), /nothing to send/);
    await assert.rejects(() => sendChat(u, 'n1', undefined, 'x'), /no chat ward/);

    // The tools resolve the only chat ward on their own.
    const read = (await TOOLS.chat_read!.run({ what: 'channels' }, { userId: u, ward: 'ag1', conv: 0 })) as { ward: string; result: unknown };
    assert.equal(read.ward, 'dc');
    // The provider's list first, then every chat the store has seen (the reply went to OTHER).
    assert.deepEqual(read.result, [{ id: C, name: 'general', kind: 'text' }, { id: OTHER, name: OTHER }]);
    assert.equal(TOOLS.chat_send!.kind, 'confirm');
    assert.equal(TOOLS.chat_manage!.kind, 'confirm');
    assert.equal(TOOLS.chat_read!.kind, 'read');

    // Removing the ward drops its token and its rows (the save hook is async).
    saveDashboard(u, getDashboard(u).filter((w) => w.i !== 'dc'));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(hasCommsToken(u, 'dc'), false);
    assert.equal(listMessages(u, 'dc', null, 5).length, 0);
  } finally {
    setClientBuilderForTests(null);
    resetCommsForTests();
  }
});

test('the per-user chat cap: 60 sends an hour, the 61st is refused', async () => {
  const sent: Sent[] = [];
  setClientBuilderForTests(() => fakeClient(sent));
  try {
    const u = seedUser('cap@c.dev');
    setCommsToken(u, 'dc', { token: 'sekrit2' });
    for (let i = 0; i < 60; i++) await sendChat(u, 'dc', undefined, `m${i}`);
    await assert.rejects(() => sendChat(u, 'dc', undefined, 'one more'), /chat rate limit/);
    assert.equal(sent.length, 60);
  } finally {
    setClientBuilderForTests(null);
    resetCommsForTests();
  }
});
