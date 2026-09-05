import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ROOM_RE, matrixClient, parseSync, toMessage } from '../src/lib/comms/matrix.ts';
import type { CommsEvent } from '../src/lib/comms/types.ts';

const self = { id: '@rime:frostdev.io', name: 'Rime' };
const ROOM = '!abc:frostdev.io';
const msg = (over: Record<string, unknown> = {}) => ({ type: 'm.room.message', event_id: '$e1', sender: '@ann:frostdev.io', origin_server_ts: 1_700_000_000_000, content: { msgtype: 'm.text', body: 'hello' }, ...over });

test('parseSync: names and members from state, quiet initial batch, mentions by m.mentions / matrix.to / display name, files unnamed, reactions, joins, encrypted counted, invites listed', () => {
  const body = {
    next_batch: 's2',
    rooms: {
      invite: { '!inv:frostdev.io': {} },
      join: {
        [ROOM]: {
          state: { events: [{ type: 'm.room.name', content: { name: 'Ops' } }, { type: 'm.room.member', state_key: '@ann:frostdev.io', content: { membership: 'join', displayname: 'Ann' } }] },
          timeline: {
            events: [
              msg(),
              msg({ event_id: '$e2', content: { msgtype: 'm.text', body: 'hey', 'm.mentions': { user_ids: [self.id] } } }),
              msg({ event_id: '$e3', content: { msgtype: 'm.text', body: 'x', formatted_body: '<a href="https://matrix.to/#/@rime:frostdev.io">Rime</a> x' } }),
              msg({ event_id: '$e4', content: { msgtype: 'm.text', body: 'rime, ping', 'm.relates_to': { rel_type: 'm.thread', event_id: '$e1', 'm.in_reply_to': { event_id: '$e1' } } } }),
              msg({ event_id: '$e5', content: { msgtype: 'm.image', body: 'cat.png', url: 'mxc://frostdev.io/abc' } }),
              msg({ event_id: '$e6', sender: self.id }),
              { type: 'm.room.encrypted', event_id: '$e7', sender: '@ann:frostdev.io', content: {} },
              { type: 'm.reaction', event_id: '$e8', sender: '@ann:frostdev.io', content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$e1', key: '👍' } } },
              { type: 'm.room.member', event_id: '$e9', sender: '@bob:frostdev.io', state_key: '@bob:frostdev.io', content: { membership: 'join', displayname: 'Bob' }, unsigned: { prev_content: { membership: 'invite' } } },
              { type: 'm.room.member', event_id: '$e10', sender: '@ann:frostdev.io', state_key: '@ann:frostdev.io', content: { membership: 'join', displayname: 'Ann L' }, unsigned: { prev_content: { membership: 'join' } } },
            ],
          },
        },
      },
    },
  };
  const p = parseSync(body, self, true);
  assert.equal(p.next, 's2');
  assert.deepEqual(p.invites, ['!inv:frostdev.io']);
  assert.equal(p.encrypted, 1);
  assert.equal(p.names.get(ROOM), 'Ops');
  assert.equal(p.members.get('@ann:frostdev.io'), 'Ann L');
  const msgs = p.events.filter((e): e is Extract<CommsEvent, { type: 'message' }> => e.type === 'message');
  assert.deepEqual(msgs.map((e) => [e.message.id, e.message.mention ?? false, e.quiet ?? false]), [['$e1', false, true], ['$e2', true, true], ['$e3', true, true], ['$e4', true, true], ['$e5', false, true]]);
  assert.equal(msgs[0]!.message.from.name, 'Ann L'); // the latest member state in the sync names the sender
  assert.deepEqual([msgs[3]!.message.threadId, msgs[3]!.message.replyTo], ['$e1', '$e1']);
  assert.deepEqual([msgs[4]!.message.text, msgs[4]!.message.attachments], ['', [{ url: '', name: 'cat.png' }]]);
  assert.deepEqual(p.events.filter((e) => e.type === 'reaction'), [{ type: 'reaction', channel: ROOM, messageId: '$e1', emoji: '👍', from: { id: '@ann:frostdev.io', name: 'Ann L' } }]);
  assert.deepEqual(p.events.filter((e) => e.type === 'member-joined'), [{ type: 'member-joined', member: { id: '@bob:frostdev.io', name: 'Bob' }, channel: ROOM }]);
  assert.equal(toMessage({ type: 'm.room.topic' }, ROOM, self, new Map()), null);
  assert.equal(parseSync(body, self, false).events[0]!.type === 'message' && (parseSync(body, self, false).events[0] as { quiet?: boolean }).quiet, undefined);
  assert.ok(ROOM_RE.test(ROOM) && ROOM_RE.test('#ops:frostdev.io') && !ROOM_RE.test('ops'));
});

test('client: whoami, a reply send with a txn id, reactions, alias resolution, the sync loop (quiet first, since advances, invites joined, 401 ends it)', async () => {
  const calls: { url: string; init: any }[] = [];
  let syncs = 0;
  const fake = (async (url: string, init: any) => {
    calls.push({ url, init });
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    const u = new URL(url);
    if (u.pathname.endsWith('/account/whoami')) return ok({ user_id: self.id });
    if (u.pathname.includes('/profile/')) return ok({ displayname: 'Rime' });
    if (u.pathname.includes('/directory/room/')) return ok({ room_id: ROOM });
    if (u.pathname.includes('/send/m.room.message/')) return ok({ event_id: '$sent1' });
    if (u.pathname.includes('/send/m.reaction/')) return ok({ event_id: '$r1' });
    if (u.pathname.includes('/join/')) return ok({ room_id: '!inv:frostdev.io' });
    if (u.pathname.endsWith('/sync')) {
      syncs++;
      if (syncs === 1) return ok({ next_batch: 's1', rooms: { invite: { '!inv:frostdev.io': {} }, join: { [ROOM]: { state: { events: [{ type: 'm.room.name', content: { name: 'Ops' } }] }, timeline: { events: [msg()] } } } } });
      if (syncs === 2) return ok({ next_batch: 's2', rooms: { join: { [ROOM]: { timeline: { events: [msg({ event_id: '$e2', content: { msgtype: 'm.text', body: 'live' } })] } } } } });
      return new Response(JSON.stringify({ errcode: 'M_UNKNOWN_TOKEN', error: 'Invalid access token' }), { status: 401 });
    }
    return ok({});
  }) as unknown as typeof fetch;
  const c = matrixClient('tok', { homeserver: 'https://matrix.frostdev.io/', channel: ROOM, watch: 'all' }, 'k', fake);
  assert.deepEqual(await c.whoami(), { id: self.id, name: 'Rime', extra: { homeserver: 'https://matrix.frostdev.io' } });
  assert.equal(calls[0]!.init.headers.authorization, 'Bearer tok');
  const sent = await c.send('#ops:frostdev.io', 'hi', { replyTo: '$e1' });
  assert.deepEqual([sent.id, sent.channel, sent.mine], ['$sent1', ROOM, true]);
  const put = calls.find((x) => x.url.includes('/send/m.room.message/'))!;
  assert.match(put.url, new RegExp(`/rooms/${encodeURIComponent(ROOM)}/send/m\\.room\\.message/rw\\d+-1$`));
  assert.deepEqual(JSON.parse(put.init.body), { msgtype: 'm.text', body: 'hi', 'm.relates_to': { 'm.in_reply_to': { event_id: '$e1' } } });
  await c.react(ROOM, '$e1', '🔥');
  assert.deepEqual(JSON.parse(calls.at(-1)!.init.body), { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$e1', key: '🔥' } });
  assert.equal(calls.filter((x) => x.url.includes('/directory/room/')).length, 1, 'the alias resolved once');

  const events: CommsEvent[] = [];
  c.live((e) => events.push(e));
  await new Promise((r) => setTimeout(r, 40));
  const msgs = events.filter((e): e is Extract<CommsEvent, { type: 'message' }> => e.type === 'message');
  assert.deepEqual(msgs.map((e) => [e.message.text, e.quiet ?? false, e.message.channelName]), [['hello', true, 'Ops'], ['live', false, 'Ops']]);
  const syncUrls = calls.filter((x) => x.url.includes('/sync')).map((x) => new URL(x.url).searchParams.get('since'));
  assert.deepEqual(syncUrls, [null, 's1', 's2']);
  assert.ok(calls.some((x) => x.url.endsWith('/join/' + encodeURIComponent('!inv:frostdev.io'))), 'the invite was accepted');
  const last = events.at(-1);
  assert.equal(last?.type === 'state' ? last.status : '', 'error');
  assert.match(last?.type === 'state' ? last.error ?? '' : '', /access token/);
  assert.equal(syncs, 3);
});
