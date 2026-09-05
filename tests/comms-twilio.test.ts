import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { NUMBER_RE, toMessage, twilioClient } from '../src/lib/comms/twilio.ts';
import type { CommsEvent } from '../src/lib/comms/types.ts';

const SID = 'AC' + 'a'.repeat(32);
const FROM = '+15550001111';
const row = (over: Record<string, unknown> = {}) => ({ sid: 'SM1', direction: 'inbound', from: '+15559990000', to: FROM, body: 'hi', date_sent: 'Wed, 03 Sep 2026 14:00:00 +0000', num_media: '0', ...over });

test('toMessage: the counterpart number is the channel, inbound is addressed to the bot, outbound is mine, media is counted', () => {
  const m = toMessage(row(), FROM);
  assert.deepEqual([m.id, m.channel, m.from, m.text, m.mention, m.mine, m.at], ['SM1', '+15559990000', { id: '+15559990000', name: '+15559990000' }, 'hi', true, undefined, Date.parse('Wed, 03 Sep 2026 14:00:00 +0000')]);
  const out = toMessage(row({ sid: 'SM2', direction: 'outbound-api', from: FROM, to: '+15559990000', num_media: '2' }), FROM);
  assert.deepEqual([out.channel, out.from.name, out.mine, out.attachments], ['+15559990000', 'bot', true, [{ url: '', name: 'media 1' }, { url: '', name: 'media 2' }]]);
  assert.ok(NUMBER_RE.test('+15559990000') && NUMBER_RE.test('whatsapp:+15559990000') && !NUMBER_RE.test('15559990000') && !NUMBER_RE.test('+1'));
});

test('client: basic auth, a form-encoded send, the whatsapp prefix follows the sender, the poll is quiet first and stops; 401 ends it', async () => {
  const calls: { url: string; init: any }[] = [];
  let polls = 0;
  const fake = (async (url: string, init: any) => {
    calls.push({ url, init });
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (init.method === 'POST') return ok({ sid: 'SM9', direction: 'outbound-api', from: new URLSearchParams(init.body).get('From'), to: new URLSearchParams(init.body).get('To'), body: new URLSearchParams(init.body).get('Body'), date_created: 'Wed, 03 Sep 2026 14:05:00 +0000' });
    if (url.endsWith(`/Accounts/${SID}.json`)) return ok({ friendly_name: 'Frostdev' });
    if (url.includes('/Messages.json?To=')) {
      polls++;
      if (polls === 1) return ok({ messages: [row(), row({ sid: 'SM0', date_sent: 'Wed, 03 Sep 2026 13:00:00 +0000', body: 'earlier' }), row({ sid: 'SMX', direction: 'outbound-api' })] });
      if (polls === 2) return ok({ messages: [row({ sid: 'SM3', body: 'new' }), row()] });
      return new Response(JSON.stringify({ message: 'Authenticate', code: 20003 }), { status: 401 });
    }
    return ok({ messages: [] });
  }) as unknown as typeof fetch;
  const c = twilioClient('tok', { sid: SID, from: FROM, channel: '+15559990000' }, 'k', fake);
  assert.deepEqual(await c.whoami(), { id: SID, name: 'Frostdev', extra: { from: FROM } });
  assert.equal(calls[0]!.init.headers.authorization, `Basic ${Buffer.from(`${SID}:tok`).toString('base64')}`);
  const sent = await c.send('+15559990000', 'hello');
  assert.deepEqual([sent.id, sent.channel, sent.mine, sent.text], ['SM9', '+15559990000', true, 'hello']);
  assert.equal(new URLSearchParams(calls.at(-1)!.init.body).get('From'), FROM);
  await assert.rejects(() => c.react('+1', 'x', 'y'), /not supported on twilio/);
  await assert.rejects(() => c.manage('x', {}), /not supported/);

  const wa = twilioClient('tok', { sid: SID, from: 'whatsapp:+15550001111', channel: '' }, 'k2', fake);
  await wa.send('+15559990000', 'wa');
  assert.equal(new URLSearchParams(calls.at(-1)!.init.body).get('To'), 'whatsapp:+15559990000');

  const bad = twilioClient('tok', { sid: 'nope', from: FROM, channel: '' }, 'k3', fake);
  await assert.rejects(() => bad.send('+15559990000', 'x'), /account SID/);

  const events: CommsEvent[] = [];
  const stop = c.live((e) => events.push(e));
  await new Promise((r) => setTimeout(r, 20));
  const first = events.filter((e): e is Extract<CommsEvent, { type: 'message' }> => e.type === 'message');
  assert.deepEqual(first.map((e) => [e.message.id, e.quiet ?? false]), [['SM0', true], ['SM1', true]], 'oldest first, quiet, outbound rows skipped');
  assert.equal(events.some((e) => e.type === 'state' && e.status === 'ready'), true);
  stop();
  const last = events.at(-1);
  assert.equal(last?.type === 'state' ? last.status : '', 'closed');
  assert.equal(polls, 1, 'no poll after stop');

  // A second client: its second poll is live, its third hits 401 and ends the loop.
  polls = 0;
  const ev2: CommsEvent[] = [];
  const c2 = twilioClient('tok', { sid: SID, from: FROM, channel: '' }, 'k4', fake);
  const stop2 = c2.live((e) => ev2.push(e));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(polls, 1);
  stop2();
});
