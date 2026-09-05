import type http from 'node:http';
import type net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { Duplex } from 'node:stream';
import { createRequire } from 'node:module';
import { WebSocketServer, type WebSocket } from 'ws';
import { SESSION_COOKIE, getSession } from './auth.ts';

// The desktop app's tunnel: one websocket per user, from Rimeward on their
// machine to this server, over which THIS side opens TCP streams that the app
// dials at home. Two kinds of target ride it — `host:port` (a browser ward's
// egress leaves from the user's home IP instead of the VPS's ASN) and
// `cdp:<ward>` (the DevTools port of a Chromium the app runs for that ward).
// Nothing here vets targets: guard.ts vets before it dials, the app re-vets
// after it resolves. The app never accepts a stream it did not ask for.
//
// Frames are binary: [u32 BE stream id][u8 op][payload]. desktop/src/tunnel.rs
// mirrors this file byte for byte.

export const OP = { OPEN: 1, OPENED: 2, DATA: 3, CLOSE: 4, STATUS: 5, HELLO: 6 } as const;
export const TUNNEL_PATH = '/api/tunnel';
const MAX_STREAMS = 256;
const MAX_PAYLOAD = 1 << 20;
const OPEN_MS = 30_000;
const PING_MS = 30_000;
const OFFLINE = 'home route offline — open Rimeward on your computer';

/** What the app last reported about itself (op STATUS). */
export interface TunnelStatus {
  platform?: string;
  chromium?: { state: 'ready' | 'downloading' | 'missing' | 'error'; pct?: number; version?: string };
}

type Listener = (online: boolean, status: TunnelStatus) => void;

interface Tunnel {
  userId: number;
  ws: WebSocket;
  streams: Map<number, TunnelStream>;
  next: number;
  alive: boolean;
  /** ws.pause()d because a stream's reader fell behind. */
  paused: boolean;
  status: TunnelStatus;
}

interface State {
  tunnels: Map<number, Tunnel>;
  subs: Map<number, Set<Listener>>;
  heartbeat?: ReturnType<typeof setInterval>;
}

// On globalThis like the browser sessions: dev HMR re-evaluates this module
// while the app's socket lives on.
const g = globalThis as { __fdTunnels?: State; __fdUpgrade?: typeof handleUpgrade };
const state: State = (g.__fdTunnels ??= { tunnels: new Map(), subs: new Map() });
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

// ------------------------------------------------------------------ frames

export function frame(id: number, op: number, payload: Buffer | string = ''): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const out = Buffer.allocUnsafe(5 + body.length);
  out.writeUInt32BE(id >>> 0, 0);
  out[4] = op;
  body.copy(out, 5);
  return out;
}

export function parseFrame(buf: Buffer): { id: number; op: number; payload: Buffer } | null {
  if (buf.length < 5) return null;
  return { id: buf.readUInt32BE(0), op: buf[4]!, payload: buf.subarray(5) };
}

// ----------------------------------------------------------------- streams

/** One TCP connection the app holds at home, as a Duplex here. */
export class TunnelStream extends Duplex {
  /** OPENED's payload: empty for `host:port`, the browser websocket path for `cdp:`. */
  opened = '';
  private pending?: { resolve: () => void; reject: (e: Error) => void };
  private remoteClosed = false;

  private readonly t: Tunnel;
  readonly id: number;

  constructor(t: Tunnel, id: number) {
    super();
    this.t = t;
    this.id = id;
  }

  /** Settles when the app has connected the target (or refused it). */
  wait(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }

  onOpened(payload: string): void {
    this.opened = payload;
    this.pending?.resolve();
    this.pending = undefined;
  }

  onData(chunk: Buffer): void {
    // ponytail: whole-tunnel pause — one slow reader stalls every stream of
    // that user. A per-stream window if it ever shows.
    if (!this.push(chunk) && !this.t.paused) {
      this.t.paused = true;
      this.t.ws.pause();
    }
  }

  onClose(reason: string): void {
    this.remoteClosed = true;
    if (this.pending) {
      this.pending.reject(new Error(reason || 'refused by the desktop app'));
      this.pending = undefined;
      this.destroy();
      return;
    }
    this.push(null);
    this.end();
  }

  override _read(): void {
    if (this.t.paused) {
      this.t.paused = false;
      this.t.ws.resume();
    }
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.t.ws.send(frame(this.id, OP.DATA, chunk), (err) => cb(err ?? null));
  }

  override _final(cb: (err?: Error | null) => void): void {
    if (!this.remoteClosed) this.t.ws.send(frame(this.id, OP.CLOSE), () => {});
    cb();
  }

  override _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
    this.t.streams.delete(this.id);
    if (!this.remoteClosed) this.t.ws.send(frame(this.id, OP.CLOSE, err?.message ?? ''), () => {});
    this.pending?.reject(err ?? new Error('stream closed'));
    this.pending = undefined;
    cb(err);
  }
}

/** Open a stream to `target` through the user's tunnel; resolves once the app
 *  has it connected. Throws when there is no tunnel or the app refuses. */
export async function openStream(userId: number, target: string): Promise<TunnelStream> {
  const t = state.tunnels.get(userId);
  if (!t) throw new Error(OFFLINE);
  if (t.streams.size >= MAX_STREAMS) throw new Error('too many open streams through the desktop app');
  const id = t.next;
  t.next = t.next >= 0xffffffff ? 1 : t.next + 1;
  const s = new TunnelStream(t, id);
  // A stream torn down before its consumer attached must not throw uncaught;
  // the consumer's own 'error' listener still fires beside this one.
  s.on('error', () => {});
  t.streams.set(id, s);
  const timer = setTimeout(() => s.destroy(new Error('the desktop app did not answer')), OPEN_MS);
  const opened = s.wait();
  t.ws.send(frame(id, OP.OPEN, target), (err) => {
    if (err) s.destroy(err);
  });
  try {
    await opened;
  } finally {
    clearTimeout(timer);
  }
  return s;
}

export const tunnelOnline = (userId: number): boolean => state.tunnels.has(userId);
export const tunnelStatus = (userId: number): TunnelStatus => state.tunnels.get(userId)?.status ?? {};

/** Online/offline and status changes for one user; returns the unsubscribe. */
export function subscribeTunnel(userId: number, fn: Listener): () => void {
  let set = state.subs.get(userId);
  if (!set) state.subs.set(userId, (set = new Set()));
  set.add(fn);
  return () => {
    set!.delete(fn);
  };
}

function notify(userId: number): void {
  const t = state.tunnels.get(userId);
  for (const fn of state.subs.get(userId) ?? []) {
    try {
      fn(!!t, t?.status ?? {});
    } catch {}
  }
}

// ---------------------------------------------------------------- handshake

function reject(socket: net.Socket, code: number, text: string): void {
  socket.end(`HTTP/1.1 ${code} ${text}\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(text)}\r\nconnection: close\r\n\r\n${text}`);
}

/** The raw `upgrade` handler (server.mjs in prod, the dev integration in
 *  astro.config.mjs): the session cookie is the credential, exactly as on any
 *  request. A browser always sends Origin on a websocket and the app never
 *  does — so Origin present = not the app = refused, which is the CSRF check. */
export function handleUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
  socket.on('error', () => {});
  if (!(req.url ?? '').startsWith(TUNNEL_PATH)) return reject(socket, 404, 'not found');
  if (req.headers.origin) return reject(socket, 403, 'not for browsers');
  const cookie = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(req.headers.cookie ?? '')?.[1];
  const session = getSession(cookie);
  if (!session) return reject(socket, 401, 'sign in first');
  if (state.tunnels.has(session.userId)) return reject(socket, 409, 'Rimeward is already connected from another computer');
  wss.handleUpgrade(req, socket, head, (ws) => attach(session.userId, ws));
}

function attach(userId: number, ws: WebSocket): void {
  if (state.tunnels.has(userId)) {
    ws.close(4009, 'already connected');
    return;
  }
  const t: Tunnel = { userId, ws, streams: new Map(), next: 1, alive: true, paused: false, status: {} };
  state.tunnels.set(userId, t);
  ws.binaryType = 'nodebuffer';
  ws.on('pong', () => {
    t.alive = true;
  });
  ws.on('message', (data, isBinary) => {
    if (isBinary) onFrame(t, data as Buffer);
  });
  ws.on('error', () => {});
  ws.on('close', () => teardown(t));
  ws.send(frame(0, OP.HELLO, JSON.stringify({ chromium: chromiumSpec() })), () => {});
  notify(userId);
}

function onFrame(t: Tunnel, buf: Buffer): void {
  const f = parseFrame(buf);
  if (!f) return;
  if (f.op === OP.STATUS) {
    const st = parseStatus(f.payload);
    if (st) {
      t.status = st;
      notify(t.userId);
    }
    return;
  }
  const s = t.streams.get(f.id);
  if (!s) return;
  if (f.op === OP.OPENED) s.onOpened(f.payload.toString('utf8'));
  else if (f.op === OP.DATA) s.onData(f.payload);
  else if (f.op === OP.CLOSE) s.onClose(f.payload.toString('utf8').slice(0, 200));
}

function parseStatus(payload: Buffer): TunnelStatus | null {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object') return null;
  const out: TunnelStatus = {};
  if (typeof j.platform === 'string') out.platform = j.platform.slice(0, 16);
  const c = j.chromium as Record<string, unknown> | undefined;
  const st = c?.state;
  if (st === 'ready' || st === 'downloading' || st === 'missing' || st === 'error') {
    out.chromium = { state: st };
    if (typeof c!.pct === 'number' && Number.isFinite(c!.pct)) out.chromium.pct = Math.round(Math.max(0, Math.min(100, c!.pct)));
    if (typeof c!.version === 'string') out.chromium.version = c!.version.slice(0, 32);
  }
  return out;
}

function teardown(t: Tunnel): void {
  if (state.tunnels.get(t.userId) === t) state.tunnels.delete(t.userId);
  for (const s of [...t.streams.values()]) s.destroy(new Error(OFFLINE));
  notify(t.userId);
}

/** Server-side heartbeat: Cloudflare idles a websocket at 100s, and a dead
 *  first device must free the user's slot (a second one gets 409 meanwhile). */
function heartbeat(): void {
  for (const t of state.tunnels.values()) {
    if (!t.alive) {
      t.ws.terminate();
      continue;
    }
    t.alive = false;
    t.ws.ping();
  }
}

/** Which Chromium the app must run: the build this server's playwright-core
 *  pins, told to the app on every connect so a playwright bump here never
 *  needs an app release. */
export function chromiumSpec(): { version: string; base: string } | null {
  try {
    const require = createRequire(import.meta.url);
    const file = path.join(path.dirname(require.resolve('playwright-core/package.json')), 'browsers.json');
    const json = JSON.parse(fs.readFileSync(file, 'utf8')) as { browsers: { name: string; browserVersion?: string }[] };
    const version = json.browsers.find((b) => b.name === 'chromium')?.browserVersion;
    return version ? { version, base: `https://cdn.playwright.dev/builds/cft/${version}/` } : null;
  } catch {
    // A pruned install without browsers.json: the app keeps the build it has.
    return null;
  }
}

/** Boot once per process (middleware): publish the upgrade handler for the raw
 *  server to call, start the heartbeat. */
export function ensureTunnel(): void {
  g.__fdUpgrade = handleUpgrade;
  if (!state.heartbeat) state.heartbeat = setInterval(heartbeat, PING_MS).unref();
}
