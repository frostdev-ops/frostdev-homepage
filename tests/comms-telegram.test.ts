import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUpdate, rawId, telegramClient, toMessage } from '../src/lib/comms/telegram.ts';
import type { CommsEvent } from '../src/lib/comms/types.ts';

const self = { id: '777', username: 'rimebot' };
const chat = { id: -1001, type: 'supergroup', title: 'Team' };
const ann = { id: 1, first_name: 'Ann', last_name: 'Lee', username: 'ann' };
const text = (over: Record<string, unknown> = {}) => ({ message_id: 5, date: 1_700_000_000, chat, from: ann, text: 'hello', ...over });

test('parseUpdate: private chats and mentions are addressed to the bot, own and bot messages drop, joins and reactions, files carry no url', () => {
  const plain = parseUpdate({ update_id: 1, message: text() }, self);
  assert.equal(plain.length, 1);
  const m = plain[0]!.type === 'message' ? plain[0].message : null;
  assert.ok(m);
  assert.deepEqual([m.id, m.channel, m.channelName, m.from, m.text, m.at, m.mention, m.direct], ['-1001:5', '-1001', 'Team', { id: '1', name: 'Ann Lee' }, 'hello', 1_700_000_000_000, undefined, undefined]);
  const dm = parseUpdate({ message: text({ chat: { id: 1, type: 'private', first_name: 'Ann' } }) }, self)[0]!;
  assert.equal(dm.type === 'message' && dm.message.direct && dm.message.mention, true);
  assert.equal(dm.type === 'message' && dm.message.channelName, 'Ann');
  const at = parseUpdate({ message: text({ text: 'hey @RimeBot look', entities: [{ type: 'mention', offset: 4, length: 8 }] }) }, self)[0]!;
  assert.equal(at.type === 'message' && at.message.mention, true);
  const other = parseUpdate({ message: text({ text: 'hey @someone look', entities: [{ type: 'mention', offset: 4, length: 8 }] }) }, self)[0]!;
  assert.equal(other.type === 'message' && other.message.mention, undefined);
  const reply = parseUpdate({ message: text({ reply_to_message: { message_id: 4, from: { id: 777 } } }) }, self)[0]!;
  assert.equal(reply.type === 'message' && reply.message.mention, true);
  assert.equal(reply.type === 'message' && reply.message.replyTo, '-1001:4');
  assert.deepEqual(parseUpdate({ message: text({ from: { id: 777, first_name: 'Rime', is_bot: true } }) }, self), []);
  assert.deepEqual(parseUpdate({ message: text({ from: { id: 9, first_name: 'Other', is_bot: true } }) }, self), []);
  const photo = toMessage(text({ text: undefined, caption: 'look', photo: [{ file_id: 'a' }, { file_id: 'b' }], document: { file_name: 'notes.pdf' } }), self);
  assert.equal(photo.text, 'look');
  assert.deepEqual(photo.attachments, [{ url: '', name: 'photo' }, { url: '', name: 'notes.pdf' }]);
  const joins = parseUpdate({ message: { message_id: 6, date: 1, chat, from: ann, new_chat_members: [{ id: 2, first_name: 'Bob' }, { id: 3, first_name: 'B', is_bot: true }] } }, self);
  assert.deepEqual(joins, [{ type: 'member-joined', member: { id: '2', name: 'Bob' }, channel: '-1001' }]);
  const cm = parseUpdate({ chat_member: { chat, old_chat_member: { status: 'left', user: ann }, new_chat_member: { status: 'member', user: ann } } }, self);
  assert.deepEqual(cm, [{ type: 'member-joined', member: { id: '1', name: 'Ann Lee' }, channel: '-1001' }]);
  const re = parseUpdate({ message_reaction: { chat, message_id: 5, user: ann, new_reaction: [{ type: 'emoji', emoji: '🔥' }] } }, self);
  assert.deepEqual(re, [{ type: 'reaction', channel: '-1001', messageId: '-1001:5', emoji: '🔥', from: { id: '1', name: 'Ann Lee' } }]);
  assert.deepEqual(parseUpdate({ message_reaction: { chat, message_id: 5, user: ann, new_reaction: [] } }, self), []);
  assert.deepEqual(parseUpdate({ update_id: 2 }, self), []);
  assert.equal(rawId('-1001:45'), 45);
  assert.equal(rawId('45'), 45);
});

test('client: sendMessage with a reply, errors never echo the token, the poll loop is quiet on its first batch and stops on abort', async () => {
  const calls: { url: string; body: any }[] = [];
  let polls = 0;
  const fake = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    if (url.endsWith('/getMe')) return ok({ id: 777, username: 'rimebot', first_name: 'Rime' });
    if (url.endsWith('/sendMessage')) return ok({ message_id: 9, date: 1_700_000_100, chat, from: { id: 777, is_bot: true, first_name: 'Rime' }, text: body.text });
    if (url.endsWith('/setChatTitle')) return new Response(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }), { status: 400 });
    if (url.endsWith('/getUpdates')) {
      polls++;
      if (polls === 1) return ok([{ update_id: 10, message: text() }, { update_id: 11, message: text({ message_id: 6, text: 'second' }) }]);
      if (polls === 2) return ok([{ update_id: 12, message: text({ message_id: 7, text: 'live' }) }]);
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
    }
    return new Response(JSON.stringify({ ok: false, description: 'nope' }), { status: 404 });
  }) as unknown as typeof fetch;
  const c = telegramClient('tok123', { channel: '-1001', watch: 'all' }, 'k', fake);
  const me = await c.whoami();
  assert.deepEqual(me, { id: '777', name: '@rimebot', extra: { link: 'https://t.me/rimebot' } });
  const sent = await c.send('-1001', 'hi', { replyTo: '-1001:5' });
  assert.equal(sent.mine, true);
  assert.equal(sent.id, '-1001:9');
  const post = calls.find((x) => x.url.endsWith('/sendMessage'))!;
  assert.match(post.url, /\/bottok123\/sendMessage$/);
  assert.deepEqual(post.body, { chat_id: -1001, text: 'hi', reply_parameters: { message_id: 5, allow_sending_without_reply: true } });
  await assert.rejects(() => c.manage('set_title', { channel: '@team', title: 'x' }), (err: Error) => /Telegram 400: Bad Request/.test(err.message) && !/tok123/.test(err.message));
  await assert.rejects(() => c.history('-1001', 5), /not supported on telegram/);

  const events: CommsEvent[] = [];
  const stop = c.live((e) => events.push(e));
  await new Promise((r) => setTimeout(r, 30));
  const msgs = events.filter((e): e is Extract<CommsEvent, { type: 'message' }> => e.type === 'message');
  assert.deepEqual(msgs.map((e) => [e.message.text, e.quiet ?? false]), [['hello', true], ['second', true], ['live', false]]);
  assert.equal(events.find((e) => e.type === 'state' && e.status === 'ready') !== undefined, true);
  const pollBodies = calls.filter((x) => x.url.endsWith('/getUpdates')).map((x) => x.body.offset);
  assert.deepEqual(pollBodies.slice(0, 3), [undefined, 12, 13]);
  stop();
  await new Promise((r) => setTimeout(r, 10));
  const last = events.at(-1);
  assert.equal(last?.type === 'state' ? last.status : last?.type, 'closed');
  assert.equal(polls, 3, 'no poll after stop');
});
