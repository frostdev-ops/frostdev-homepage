import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, teamsClient, toMessage } from '../src/lib/comms/teams.ts';
import type { CommsEvent } from '../src/lib/comms/types.ts';

const ME = { id: 'u-me', displayName: 'Jame' };
const raw = (over: Record<string, unknown> = {}) => ({ id: '1', messageType: 'message', createdDateTime: '2026-09-03T14:00:00Z', from: { user: { id: 'u-ann', displayName: 'Ann' } }, body: { contentType: 'html', content: '<p>hello <at id="0">Jame</at>&nbsp;there</p>' }, mentions: [{ id: 0, mentioned: { user: { id: 'u-me' } } }], ...over });

test('htmlToText + toMessage: html flattened, mentions of me, own and app messages, system events dropped, attachments named', () => {
  assert.equal(htmlToText('<p>a<br>b</p><div>c &amp; d</div>'), 'a\nb\nc & d');
  const m = toMessage(raw(), 'chat1', 'u-me')!;
  assert.deepEqual([m.id, m.channel, m.from, m.text, m.mention, m.at], ['1', 'chat1', { id: 'u-ann', name: 'Ann' }, 'hello Jame there', true, Date.parse('2026-09-03T14:00:00Z')]);
  assert.equal(toMessage(raw({ mentions: [] }), 'chat1', 'u-me')!.mention, undefined);
  assert.equal(toMessage(raw({ from: { user: ME } }), 'chat1', 'u-me')!.mine, true);
  assert.equal(toMessage(raw({ from: { application: { id: 'app', displayName: 'Bot' } } }), 'chat1', 'u-me')!.bot, true);
  assert.equal(toMessage(raw({ messageType: 'systemEventMessage' }), 'chat1', 'u-me'), null);
  assert.deepEqual(toMessage(raw({ attachments: [{ name: 'deck.pptx', contentUrl: 'https://x.sharepoint.com/deck.pptx' }] }), 'chat1', 'u-me')!.attachments, [{ url: '', name: 'deck.pptx' }]);
});

test('client: chats listed with member names, a send, a channel reply, the 60s poll quiet first, 403 on a team explains consent', async () => {
  const calls: { url: string; init: any }[] = [];
  let polls = 0;
  const fake = (async (url: string, init: any) => {
    calls.push({ url, init });
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    const p = new URL(url).pathname;
    if (p.endsWith('/me')) return ok(ME);
    if (p.endsWith('/me/chats')) return ok({ value: [{ id: 'chat1', chatType: 'oneOnOne', members: [{ displayName: 'Jame' }, { displayName: 'Ann' }] }, { id: 'chat2', chatType: 'group', topic: 'Ops' }] });
    if (p.endsWith('/chats/chat1/messages') && init.method === 'POST') return ok(raw({ id: '9', from: { user: ME }, body: { contentType: 'text', content: JSON.parse(init.body).body.content }, mentions: [] }));
    if (p.includes('/teams/t1/channels/c1/messages/5/replies') && init.method === 'POST') return ok(raw({ id: '10', from: { user: ME }, body: { contentType: 'text', content: 'reply' }, mentions: [], replyToId: '5' }));
    if (p.includes('/teams/t1/channels/c1/messages')) return new Response(JSON.stringify({ error: { message: 'Forbidden' } }), { status: 403 });
    if (p.endsWith('/messages')) {
      polls++;
      return ok({ value: polls <= 2 ? [raw({ id: `m${polls}` })] : [] });
    }
    return ok({ value: [] });
  }) as unknown as typeof fetch;
  const tokens: string[] = [];
  const getToken = async () => {
    tokens.push('tok');
    return 'tok';
  };
  const c = teamsClient(getToken, { team: '', channel: 'chat1', watch: 'chat1' }, 'k', fake);
  assert.deepEqual(await c.whoami(), { id: 'u-me', name: 'Jame', extra: undefined });
  assert.equal(calls[0]!.init.headers.authorization, 'Bearer tok');
  assert.deepEqual((await c.channels()).map((x) => [x.id, x.name, x.kind]), [['chat1', 'Ann', 'dm'], ['chat2', 'Ops', 'group']]);
  const sent = await c.send('chat1', 'hi');
  assert.deepEqual([sent.id, sent.mine, sent.channelName], ['9', true, 'Ann']);
  assert.deepEqual(JSON.parse(calls.at(-1)!.init.body), { body: { contentType: 'text', content: 'hi' } });

  const events: CommsEvent[] = [];
  const stop = c.live((e) => events.push(e));
  await new Promise((r) => setTimeout(r, 30));
  const msgs = events.filter((e): e is Extract<CommsEvent, { type: 'message' }> => e.type === 'message');
  assert.deepEqual(msgs.map((e) => [e.message.id, e.quiet ?? false]), [['m1', true]]);
  assert.equal(events.some((e) => e.type === 'state' && e.status === 'ready'), true);
  stop();
  assert.equal(polls, 1);

  const t = teamsClient(getToken, { team: 't1', channel: 'c1', watch: 'all' }, 'k2', fake);
  const reply = await t.send('c1', 'reply', { replyTo: '5' });
  assert.equal(reply.replyTo, '5');
  await assert.rejects(() => t.history('c1', 10), /admin must consent/);
  await assert.rejects(() => t.manage('set_topic', { channel: 'c1', topic: 'x' }), /group chat/);
});
