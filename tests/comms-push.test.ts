import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pushClient, splitTitle } from '../src/lib/comms/push.ts';
import { validateLayout } from '../src/lib/wards.ts';

test('splitTitle: a short first line is the title, one line is all body', () => {
  assert.deepEqual(splitTitle('Deploy landed\nv0.12 is live'), { title: 'Deploy landed', body: 'v0.12 is live' });
  assert.deepEqual(splitTitle('just one line'), { title: '', body: 'just one line' });
  assert.deepEqual(splitTitle(`${'x'.repeat(120)}\nbody`), { title: '', body: `${'x'.repeat(120)}\nbody` });
});

test('ntfy: POST to server/topic with a title header, bearer when a token is set; Pushover: the form with app token + user key', async () => {
  const calls: { url: string; init: any }[] = [];
  const fake = (async (url: string, init: any) => {
    calls.push({ url, init });
    if (url.includes('pushover')) return new Response(JSON.stringify({ status: 1, devices: ['phone'] }), { status: 200 });
    return new Response('{"id":"x"}', { status: 200 });
  }) as unknown as typeof fetch;
  const n = pushClient('', { service: 'ntfy', server: 'https://ntfy.example.com/', channel: 'alerts' }, 'k', fake);
  assert.deepEqual(await n.whoami(), { id: 'https://ntfy.example.com', name: 'ntfy · ntfy.example.com' });
  const sent = await n.send('alerts', 'Disk 91%\nthe box is filling up');
  assert.equal(calls[0]!.url, 'https://ntfy.example.com/alerts');
  assert.equal(calls[0]!.init.headers.title, 'Disk 91%');
  assert.equal(calls[0]!.init.headers.authorization, undefined);
  assert.equal(calls[0]!.init.body, 'the box is filling up');
  assert.equal(sent.mine, true);
  assert.equal(sent.channelName, '#alerts');
  const tok = pushClient('tk_secret', { service: 'ntfy', server: '', channel: 'a' }, 'k', fake);
  await tok.send('a', 'Ünïcode title\nbody');
  assert.equal(calls[1]!.url, 'https://ntfy.sh/a');
  assert.equal(calls[1]!.init.headers.authorization, 'Bearer tk_secret');
  assert.match(calls[1]!.init.headers.title, /^=\?UTF-8\?B\?/);
  await assert.rejects(() => n.react('a', 'b', 'c'), /not supported on push/);

  const p = pushClient('app-token', { service: 'pushover', server: '', channel: 'u'.repeat(30) }, 'k2', fake);
  assert.deepEqual(await p.whoami(), { id: 'u'.repeat(30), name: 'Pushover · phone' });
  await p.send('u'.repeat(30), 'Ping\nfrom the dashboard');
  const form = new URLSearchParams(calls.at(-1)!.init.body);
  assert.deepEqual([form.get('token'), form.get('user'), form.get('title'), form.get('message')], ['app-token', 'u'.repeat(30), 'Ping', 'from the dashboard']);
  await assert.rejects(() => pushClient('', { service: 'pushover', server: '', channel: 'u'.repeat(30) }, 'k3', fake).send('x', 'y'), /application token/);
  const states: string[] = [];
  p.live((e) => e.type === 'state' && states.push(e.status))();
  assert.deepEqual(states, ['ready']);
});

test('validateConfig push: the service and its destination shape, the server defaults to ntfy.sh', () => {
  const l = validateLayout([
    { i: 'a', type: 'push', size: '1x1', config: { service: 'ntfy', server: 'ntfy.example.com', channel: 'my topic!' } },
    { i: 'b', type: 'push', size: '1x1', config: { service: 'pushover', channel: 'u'.repeat(30) } },
    { i: 'c', type: 'push', size: '1x1', config: {} },
  ])!;
  assert.deepEqual(l[0]!.config, { service: 'ntfy', server: 'https://ntfy.example.com', channel: '' });
  assert.deepEqual(l[1]!.config, { service: 'pushover', server: '', channel: 'u'.repeat(30) });
  assert.deepEqual(l[2]!.config, { service: 'ntfy', server: 'https://ntfy.sh', channel: '' });
});
