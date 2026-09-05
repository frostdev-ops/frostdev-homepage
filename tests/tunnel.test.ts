import './_setup.ts';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import WebSocket from 'ws';
import { getDb } from '../src/lib/db.ts';
import { SESSION_COOKIE, createSession } from '../src/lib/auth.ts';
import { OP, chromiumSpec, frame, handleUpgrade, openStream, parseFrame, subscribeTunnel, tunnelOnline, tunnelStatus } from '../src/lib/tunnel.ts';

// The desktop app's side of the protocol, faked: every `host:port` target
// lands on a local echo server (no vetting here — that is the app's job),
// `cdp:` answers with a browser path, `refuse:` says no.
class FakeApp {
  hello?: { chromium: { version: string; base: string } };
  closes: number[] = [];
  private tcp = new Map<number, net.Socket>();
  readonly ws: WebSocket;
  private readonly echoPort: number;
  constructor(ws: WebSocket, echoPort: number) {
    this.ws = ws;
    this.echoPort = echoPort;
    ws.on('message', (d) => this.on(parseFrame(d as Buffer)!));
    // The real app drops every stream with the tunnel; so does this one.
    ws.on('close', () => {
      for (const s of this.tcp.values()) s.destroy();
      this.tcp.clear();
    });
  }
  send(id: number, op: number, payload?: Buffer | string): void {
    this.ws.send(frame(id, op, payload));
  }
  private on(f: { id: number; op: number; payload: Buffer }): void {
    switch (f.op) {
      case OP.HELLO:
        this.hello = JSON.parse(f.payload.toString());
        break;
      case OP.OPEN: {
        const target = f.payload.toString();
        if (target.startsWith('cdp:')) return this.send(f.id, OP.OPENED, '/devtools/browser/abc');
        if (target.startsWith('refuse:')) return this.send(f.id, OP.CLOSE, 'downloading 42%');
        const sock = net.connect(this.echoPort, '127.0.0.1');
        this.tcp.set(f.id, sock);
        sock.on('connect', () => this.send(f.id, OP.OPENED));
        sock.on('data', (c) => this.send(f.id, OP.DATA, c));
        sock.on('close', () => {
          if (this.tcp.delete(f.id)) this.send(f.id, OP.CLOSE);
        });
        sock.on('error', () => {});
        break;
      }
      case OP.DATA:
        this.tcp.get(f.id)?.write(f.payload);
        break;
      case OP.CLOSE: {
        this.closes.push(f.id);
        const s = this.tcp.get(f.id);
        this.tcp.delete(f.id);
        s?.destroy();
        break;
      }
    }
  }
}

const dial = (port: number, headers: Record<string, string>) =>
  new Promise<WebSocket | number>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/tunnel`, { headers });
    ws.on('unexpected-response', (req, res) => {
      resolve(res.statusCode!);
      res.resume();
      req.destroy();
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });

const once = <T>(s: NodeJS.EventEmitter, ev: string) => new Promise<T>((r) => s.once(ev, r as (...a: unknown[]) => void));
const until = async (f: () => boolean) => {
  for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(f(), 'condition never held');
};
// The app must listen BEFORE the handshake lands: HELLO rides the same read as the 101.
const connectApp = async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/tunnel`, { headers: { cookie } });
  const app = new FakeApp(ws, echoPort);
  await once(ws, 'open');
  return app;
};

let port = 0;
let echoPort = 0;
let userId = 0;
let cookie = '';
const servers: { close(): void }[] = [];

before(async () => {
  getDb().prepare(`INSERT INTO users (email, password_hash, role) VALUES ('t@x.io', 'x', 'admin')`).run();
  userId = (getDb().prepare(`SELECT id FROM users WHERE email = 't@x.io'`).get() as { id: number }).id;
  cookie = `${SESSION_COOKIE}=${createSession(userId).id}`;
  const srv = http.createServer((_req, res) => res.end()).on('upgrade', handleUpgrade);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  port = (srv.address() as net.AddressInfo).port;
  // Echo, and "bye" hangs up from the far end.
  const echo = net.createServer((s) => {
    s.on('data', (c) => (c.toString() === 'bye' ? s.destroy() : s.write(c)));
  });
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
  echoPort = (echo.address() as net.AddressInfo).port;
  servers.push(srv, echo);
});
after(() => servers.forEach((s) => s.close()));

test('handshake: browsers, strangers and dead sessions are refused', async () => {
  assert.equal(await dial(port, {}), 401);
  assert.equal(await dial(port, { cookie: `${SESSION_COOKIE}=nope` }), 401);
  assert.equal(await dial(port, { cookie, origin: 'https://frostdev.io' }), 403);
  assert.equal(tunnelOnline(userId), false);
});

test('one tunnel per user: HELLO on connect, 409 for a second device, streams echo through it', async () => {
  const seen: boolean[] = [];
  const unsub = subscribeTunnel(userId, (online) => seen.push(online));
  const app = await connectApp();
  const ws = app.ws;
  await until(() => !!app.hello);
  assert.equal(app.hello?.chromium.version, chromiumSpec()?.version);
  assert.match(app.hello!.chromium.base, /cdn\.playwright\.dev\/builds\/cft\//);
  assert.equal(tunnelOnline(userId), true);
  assert.deepEqual(seen, [true]);
  assert.equal(await dial(port, { cookie }), 409);

  // A stream round-trips bytes, and closing it tells the app.
  const s = await openStream(userId, 'example.com:443');
  assert.equal(s.opened, '');
  s.write('ping');
  assert.equal((await once<Buffer>(s, 'data')).toString(), 'ping');
  s.destroy();
  await until(() => app.closes.length > 0);
  assert.deepEqual(app.closes, [s.id]);

  // The far end hanging up ends the stream here.
  const s2 = await openStream(userId, 'example.com:443');
  s2.resume(); // consume, or EOF never lands and 'close' never fires (the guard pipes, so it consumes)
  s2.write('bye');
  await once(s2, 'close');

  // cdp: carries the browser path; a refusal surfaces its reason.
  const cdp = await openStream(userId, 'cdp:bw1');
  assert.equal(cdp.opened, '/devtools/browser/abc');
  cdp.destroy();
  await assert.rejects(() => openStream(userId, 'refuse:x'), /downloading 42%/);

  // STATUS updates what the wards can show.
  app.send(0, OP.STATUS, JSON.stringify({ platform: 'darwin', chromium: { state: 'downloading', pct: 42.4, junk: 1 } }));
  await until(() => tunnelStatus(userId).platform === 'darwin');
  assert.deepEqual(tunnelStatus(userId), { platform: 'darwin', chromium: { state: 'downloading', pct: 42 } });

  // Going away destroys every open stream and frees the slot.
  const s3 = await openStream(userId, 'example.com:443');
  ws.close();
  await once(s3, 'close');
  assert.equal(tunnelOnline(userId), false);
  assert.equal(seen.at(-1), false);
  await assert.rejects(() => openStream(userId, 'example.com:443'), /offline/);
  unsub();
});

test('frames: 5-byte header, big-endian id, payload verbatim', () => {
  const f = parseFrame(frame(0xdeadbeef, OP.DATA, Buffer.from([1, 2, 3])))!;
  assert.equal(f.id, 0xdeadbeef);
  assert.equal(f.op, OP.DATA);
  assert.deepEqual([...f.payload], [1, 2, 3]);
  assert.equal(parseFrame(Buffer.from([1, 2, 3, 4])), null);
});
