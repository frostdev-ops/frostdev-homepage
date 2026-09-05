import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEvent, rawTs, slackClient, type WebSocketLike } from '../src/lib/comms/slack.ts';
import type { CommsEvent } from '../src/lib/comms/types.ts';

const SELF = 'U777';
const msg = (over: Record<string, unknown> = {}) => ({ type: 'message', channel: 'C1', user: 'U1', text: 'hello', ts: '1700000000.000100', ...over });

test('parseEvent: mentions and DMs are addressed to the bot; own, bot and subtype messages drop; threads, files, reactions, joins', () => {
  const plain = parseEvent(msg(), SELF);
  assert.equal(plain?.type, 'message');
  if (plain?.type !== 'message') throw new Error('unreachable');
  assert.deepEqual([plain.message.id, plain.message.channel, plain.message.from.id, plain.message.at, plain.message.mention], ['C1:1700000000.000100', 'C1', 'U1', 1700000000000, undefined]);
  const at = parseEvent(msg({ text: 'hey <@U777> look' }), SELF);
  assert.equal(at?.type === 'message' && at.message.mention, true);
  const dm = parseEvent(msg({ channel: 'D9', channel_type: 'im' }), SELF);
  assert.equal(dm?.type === 'message' && dm.message.direct && dm.message.mention, true);
  assert.equal(parseEvent(msg({ user: SELF }), SELF), null);
  assert.equal(parseEvent(msg({ bot_id: 'B1' }), SELF), null);
  assert.equal(parseEvent(msg({ subtype: 'channel_join' }), SELF), null);
  const reply = parseEvent(msg({ ts: '1700000001.000200', thread_ts: '1700000000.000100' }), SELF);
  assert.equal(reply?.type === 'message' && reply.message.threadId, '1700000000.000100');
  assert.equal(reply?.type === 'message' && reply.message.replyTo, 'C1:1700000000.000100');
  const file = parseEvent(msg({ subtype: 'file_share', files: [{ name: 'a.pdf', permalink: 'https://files.slack.com/x/a.pdf', size: 3 }] }), SELF);
  assert.deepEqual(file?.type === 'message' && file.message.attachments, [{ url: 'https://files.slack.com/x/a.pdf', name: 'a.pdf', size: 3 }]);
  assert.deepEqual(parseEvent({ type: 'reaction_added', user: 'U1', reaction: 'thumbsup', item: { type: 'message', channel: 'C1', ts: '1.2' } }, SELF), { type: 'reaction', channel: 'C1', messageId: 'C1:1.2', emoji: 'thumbsup', from: { id: 'U1', name: 'U1' } });
  assert.equal(parseEvent({ type: 'reaction_added', user: SELF, reaction: 'x', item: { type: 'message', channel: 'C1', ts: '1' } }, SELF), null);
  assert.deepEqual(parseEvent({ type: 'member_joined_channel', user: 'U2', channel: 'C1' }, SELF), { type: 'member-joined', member: { id: 'U2', name: 'U2' }, channel: 'C1' });
  assert.equal(parseEvent({ type: 'app_mention', user: 'U1', text: '<@U777>' }, SELF), null);
  assert.equal(rawTs('C1:1.5'), '1.5');
});

class FakeSocket implements WebSocketLike {
  sent: any[] = [];
  closed: number[] = [];
  private ls = new Map<string, ((ev: any) => void)[]>();
  url: string;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(t: string, fn: (ev: any) => void): void {
    this.ls.set(t, [...(this.ls.get(t) ?? []), fn]);
  }
  serve(obj: unknown): void {
    for (const fn of this.ls.get('message') ?? []) fn({ data: JSON.stringify(obj) });
  }
  send(d: string): void {
    this.sent.push(JSON.parse(d));
  }
  close(code = 1000): void {
    this.closed.push(code);
    for (const fn of this.ls.get('close') ?? []) fn({ code });
  }
}

test('client: form-encoded web calls with the bot token, one 429 retry, thread replies, names filled; socket mode acks every envelope and reopens on disconnect', async () => {
  const calls: { method: string; auth: string; params: URLSearchParams }[] = [];
  let posts = 0;
  const fake = (async (url: string, init: any) => {
    const method = url.slice(url.lastIndexOf('/') + 1);
    calls.push({ method, auth: init.headers.authorization, params: new URLSearchParams(init.body) });
    const ok = (extra: Record<string, unknown>) => new Response(JSON.stringify({ ok: true, ...extra }), { status: 200 });
    switch (method) {
      case 'auth.test':
        return ok({ user_id: SELF, user: 'rime', team: 'Frost', url: 'https://frost.slack.com/' });
      case 'chat.postMessage':
        posts++;
        if (posts === 1) return new Response('', { status: 429, headers: { 'retry-after': '0' } });
        return ok({ ts: '1700000009.000900', channel: 'C1' });
      case 'users.info':
        return ok({ user: { id: 'U1', real_name: 'Ann Lee', profile: { display_name: 'ann' } } });
      case 'conversations.list':
        return ok({ channels: [{ id: 'C1', name: 'general' }, { id: 'G2', name: 'ops', is_private: true }, { id: 'D3', is_im: true, user: 'U1' }], response_metadata: { next_cursor: '' } });
      case 'conversations.info':
        return new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }), { status: 200 });
      case 'apps.connections.open':
        return ok({ url: `wss://wss.slack.com/link/${calls.filter((c) => c.method === 'apps.connections.open').length}` });
      default:
        return ok({});
    }
  }) as unknown as typeof fetch;
  const sockets: FakeSocket[] = [];
  const c = slackClient('xoxb-1', 'xapp-1', { channel: 'C1', watch: 'all' }, 'k', fake, (url) => {
    const s = new FakeSocket(url);
    sockets.push(s);
    return s;
  });
  const me = await c.whoami();
  assert.deepEqual(me, { id: SELF, name: 'rime', extra: { team: 'Frost', url: 'https://frost.slack.com/' } });
  assert.equal(calls[0]!.auth, 'Bearer xoxb-1');
  const sent = await c.send('C1', 'hi', { replyTo: 'C1:1700000000.000100', thread: true });
  assert.equal(posts, 2, 'retried after 429');
  assert.deepEqual([sent.id, sent.mine, sent.threadId], ['C1:1700000009.000900', true, '1700000000.000100']);
  const post = calls.filter((x) => x.method === 'chat.postMessage').at(-1)!;
  assert.deepEqual([post.params.get('channel'), post.params.get('text'), post.params.get('thread_ts')], ['C1', 'hi', '1700000000.000100']);
  await c.react('C1', 'C1:1.5', ':tada:');
  const react = calls.find((x) => x.method === 'reactions.add')!;
  assert.deepEqual([react.params.get('timestamp'), react.params.get('name')], ['1.5', 'tada']);
  assert.deepEqual((await c.channels()).map((ch) => [ch.id, ch.name, ch.kind]), [['C1', 'general', 'text'], ['G2', 'ops', 'private'], ['D3', 'dm:ann', 'dm']]);
  assert.equal(c.nameOf('G2'), 'ops');
  await assert.rejects(() => c.read('channel', { channel: 'C9' }), /Slack conversations\.info: channel_not_found/);

  const events: CommsEvent[] = [];
  const stop = c.live((e) => events.push(e));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sockets.length, 1);
  assert.equal(calls.filter((x) => x.method === 'apps.connections.open')[0]!.auth, 'Bearer xapp-1', 'socket mode uses the app token');
  sockets[0]!.serve({ type: 'hello' });
  assert.equal(events.at(-1)?.type === 'state' && events.at(-1)?.type === 'state' ? (events.at(-1) as { status: string }).status : '', 'ready');
  sockets[0]!.serve({ envelope_id: 'env1', type: 'events_api', payload: { type: 'event_callback', event: msg({ text: 'ping <@U777>' }) } });
  assert.deepEqual(sockets[0]!.sent, [{ envelope_id: 'env1' }], 'acked at once');
  await new Promise((r) => setTimeout(r, 20));
  const m = events.find((e) => e.type === 'message');
  assert.ok(m && m.type === 'message');
  assert.deepEqual([m.message.from.name, m.message.channelName, m.message.mention], ['ann', 'general', true]);
  sockets[0]!.serve({ type: 'disconnect', reason: 'refresh_requested' });
  assert.deepEqual(sockets[0]!.closed, [1000]);
  await new Promise((r) => setTimeout(r, 1400));
  assert.equal(sockets.length, 2, 'reopened through a fresh apps.connections.open');
  assert.equal(calls.filter((x) => x.method === 'apps.connections.open').length, 2);
  stop();
  assert.deepEqual(sockets[1]!.closed, [1000]);
  const last = events.at(-1);
  assert.equal(last?.type === 'state' ? last.status : '', 'closed');

  // Without an app token the client still reads and sends, and says so.
  const quiet: CommsEvent[] = [];
  const plain = slackClient('xoxb-1', null, { channel: 'C1', watch: 'all' }, 'k2', fake);
  plain.live((e) => quiet.push(e));
  await new Promise((r) => setTimeout(r, 20));
  const st = quiet.at(-1);
  assert.equal(st?.type === 'state' ? st.status : '', 'ready');
  assert.match(st?.type === 'state' ? st.note ?? '' : '', /app-level token/);
});
