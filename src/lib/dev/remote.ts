import http from "node:http";
import WebSocket from "ws";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { getSetting, setSetting } from "../settings.ts";
import { repoDir } from "../db.ts";
import { DevError, requireDesktop, isDesktop } from "./runtime.ts";
import { localOwner } from "./native.ts";
import {
  PROTOCOL,
  allowedRelayPath,
  forwardHeaders,
  relaySocket,
} from "./devices.ts";
interface Pair {
  server: string;
  id: string;
  token: string;
  name: string;
}
type NativeGlobal = typeof globalThis & {
  __nativeVault?: (op: string, value?: string) => Promise<string>;
  __nativeDesktop?: (op: string, value?: unknown) => Promise<unknown>;
};
export async function nativeDesktop(op: string, value?: unknown) {
  requireDesktop();
  const fn = (globalThis as NativeGlobal).__nativeDesktop;
  if (!fn)
    throw new DevError(
      "Open this page in the desktop app to use the folder picker or browser sign-in.",
      409,
    );
  return fn(op, value);
}
let pairs: Pair[] = [];
let loaded = false;
const controls = new Map<string, WebSocket>();
const retries = new Map<string, ReturnType<typeof setTimeout>>();
const channels = new Map<string, Set<WebSocket>>();
async function vault(op: string, value?: string) {
  const fn = (globalThis as NativeGlobal).__nativeVault;
  if (!fn) throw new DevError("Desktop credential store is unavailable.", 503);
  return fn(op, value);
}
function serverOrigin(value: string) {
  const u = new URL(value);
  if (u.protocol !== "https:" || u.username || u.password)
    throw new DevError("Use an HTTPS Rimeward server.");
  return u.origin;
}
export async function remotePairs(user: number) {
  requireDesktop();
  if (user !== localOwner())
    throw new DevError("Only the local owner can pair this desktop.", 403);
  if (!loaded) {
    pairs = JSON.parse(await vault("get"));
    loaded = true;
    pairs.forEach(connect);
  }
  return pairs.map(({ server, id, name }) => ({
    server,
    id,
    name,
    online: controls.get(id)?.readyState === WebSocket.OPEN,
  }));
}
async function enrollmentRequest(
  server: string,
  action: string,
  body: unknown,
) {
  const res = await fetch(serverOrigin(server) + "/api/devices/" + action, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok)
    throw new DevError(
      res.status === 404
        ? "This server needs the desktop connection update. Update the server, then try again."
        : "Could not connect to this Rimeward server. Check the address and try again.",
      res.status,
    );
  try {
    return await res.json();
  } catch {
    throw new DevError(
      "This address did not return a Rimeward connection. Check the server address.",
      502,
    );
  }
}
interface SignIn {
  server: string;
  code: string;
  verificationUrl: string;
  name: string;
  user: number;
  expires: number;
  lastPoll: number;
  busy?: boolean;
  result?: { id: string; email: string; server: string };
}
const signIns = new Map<string, SignIn>();
export async function beginSignIn(user: number, server: string) {
  await remotePairs(user);
  for (const [id, s] of signIns)
    if (s.user === user || s.expires < Date.now()) signIns.delete(id);
  const origin = serverOrigin(server),
    name = os.hostname().replace(/\.local$/, "") || "My desktop";
  const grant = await enrollmentRequest(origin, "authorize", {
    name,
    platform: process.platform,
    protocol: PROTOCOL,
  });
  if (
    typeof grant.device_code !== "string" ||
    !/^[A-F0-9]{4}-[A-F0-9]{4}$/.test(grant.user_code)
  )
    throw new DevError("Invalid server connection response.", 502);
  const id = crypto.randomUUID(),
    verificationUrl = origin + "/desktop/connect?code=" + grant.user_code;
  signIns.set(id, {
    server: origin,
    code: grant.device_code,
    verificationUrl,
    name,
    user,
    expires: Date.now() + 600000,
    lastPoll: 0,
  });
  let browserOpened = true;
  try {
    await nativeDesktop("open-url", { url: verificationUrl });
  } catch {
    browserOpened = false;
  }
  return {
    id,
    verificationUrl,
    userCode: grant.user_code,
    interval: 3,
    browserOpened,
  };
}
function signInOf(user: number, id: string) {
  const s = signIns.get(id);
  if (!s || s.user !== user || s.expires <= Date.now())
    throw new DevError("Connection request expired. Start again.", 410);
  return s;
}
export async function openSignIn(user: number, id: string) {
  const s = signInOf(user, id);
  await nativeDesktop("open-url", { url: s.verificationUrl });
  return { ok: true };
}
export function cancelSignIn(user: number, id: string) {
  signInOf(user, id);
  signIns.delete(id);
  return { ok: true };
}
export async function pollSignIn(user: number, id: string) {
  const s = signInOf(user, id);
  if (s.result) return { status: "connected", ...s.result };
  if (s.busy || Date.now() - s.lastPoll < 3000) return { status: "pending" };
  s.busy = true;
  s.lastPoll = Date.now();
  try {
    const result = await enrollmentRequest(s.server, "token", {
      device_code: s.code,
    });
    if (
      result.error === "authorization_pending" ||
      result.error === "slow_down"
    )
      return { status: "pending" };
    if (result.error)
      throw new DevError(
        result.error === "access_denied"
          ? "Connection declined. You can start again."
          : "Connection request expired. Start again.",
        409,
      );
    if (signIns.get(id) !== s)
      throw new DevError(
        "Connection cancelled. Any approved device can be revoked on the server.",
        409,
      );
    if (typeof result.id !== "string" || typeof result.token !== "string")
      throw new DevError("Invalid connection response.", 502);
    const p = {
      id: result.id,
      token: result.token,
      server: s.server,
      name: s.name,
    };
    const next = [...pairs, p];
    await vault("set", JSON.stringify(next));
    pairs = next;
    connect(p);
    s.result = {
      id: p.id,
      email: String(result.email ?? ""),
      server: p.server,
    };
    return { status: "connected", ...s.result };
  } finally {
    s.busy = false;
  }
}
export async function onboarding(user: number) {
  return {
    complete: getSetting(`desktop:onboarded:${user}`) === "1",
    home: getSetting(`desktop:home:${user}`) ?? "local",
    pairs: await remotePairs(user),
  };
}
export async function completeOnboarding(user: number, home: string) {
  const list = await remotePairs(user);
  if (home !== "local" && !list.some((p) => p.id === home))
    throw new DevError("Select a connected server.");
  setSetting(`desktop:home:${user}`, home);
  setSetting(`desktop:onboarded:${user}`, "1");
  return { ok: true };
}
export async function openServer(user: number, id: string) {
  await remotePairs(user);
  const p = pairs.find((p) => p.id === id);
  if (!p) throw new DevError("Connect this server first.", 404);
  const response = await fetch(p.server + "/api/devices/session", {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: "Bearer " + p.token,
      "content-type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new DevError(
      response.status === 401
        ? "This connection was revoked. Connect again."
        : "Server unavailable. You can continue on this desktop.",
      response.status,
    );
  const session = await response.json();
  await nativeDesktop("server", {
    url: p.server + "/dash",
    session: session.id,
  });
  return { ok: true };
}
export async function previewPair(user: number, server: string, code: string) {
  await remotePairs(user);
  return enrollmentRequest(server, "preview", { code });
}
export async function pairDesktop(
  user: number,
  server: string,
  code: string,
  name: string,
) {
  await remotePairs(user);
  const origin = serverOrigin(server);
  const result = await enrollmentRequest(origin, "claim", {
    code,
    name,
    platform: process.platform,
    protocol: PROTOCOL,
  });
  const p = {
    server: origin,
    id: result.id,
    token: result.token,
    name: String(name).slice(0, 80) || "Desktop",
  };
  const next = [...pairs, p];
  await vault("set", JSON.stringify(next));
  pairs = next;
  connect(p);
  return { id: p.id };
}
export async function unpairDesktop(user: number, id: string) {
  await remotePairs(user);
  const next = pairs.filter((p) => p.id !== id);
  await vault("set", JSON.stringify(next));
  pairs = next;
  clearTimeout(retries.get(id));
  controls.get(id)?.close();
  controls.delete(id);
  for (const ws of channels.get(id) ?? []) ws.terminate();
  channels.delete(id);
  return { ok: true };
}
function connect(pair: Pair) {
  if (controls.has(pair.id)) return;
  const ws = new WebSocket(
    pair.server.replace(/^https:/, "wss:") + "/api/devices/connect",
    {
      headers: { authorization: "Bearer " + pair.token },
      maxPayload: 16_384,
      perMessageDeflate: false,
    },
  );
  controls.set(pair.id, ws);
  channels.set(pair.id, new Set());
  let alive = true;
  const heartbeat = setInterval(() => {
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 25_000);
  heartbeat.unref();
  ws.on("pong", () => {
    alive = true;
  });
  ws.on("error", () => {});
  ws.on("message", (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (
        m.type === "request" &&
        /^[\w-]{36}$/.test(m.id) &&
        m.base === "/runtime/" + pair.id
      )
        openChannel(pair, m.id, m.base);
    } catch {}
  });
  ws.on("close", (code) => {
    clearInterval(heartbeat);
    if (controls.get(pair.id) === ws) controls.delete(pair.id);
    for (const channel of channels.get(pair.id) ?? []) channel.terminate();
    channels.delete(pair.id);
    if (code !== 4001 && pairs.some((p) => p.id === pair.id)) {
      const timer = setTimeout(() => connect(pair), 5000);
      timer.unref();
      retries.set(pair.id, timer);
    }
  });
}
function openChannel(pair: Pair, id: string, base: string) {
  const set = channels.get(pair.id);
  if (!set || set.size >= 64) return;
  const ws = new WebSocket(
    pair.server.replace(/^https:/, "wss:") + "/api/devices/connect",
    {
      headers: {
        authorization: "Bearer " + pair.token,
        "x-rimeward-request": id,
      },
      maxPayload: 16 * 1024 * 1024,
      perMessageDeflate: false,
    },
  );
  set.add(ws);
  ws.on("error", () => {});
  ws.on("close", () => set.delete(ws));
  ws.on("open", () => {
    const local = http.createServer((req, res) => {
      if (!req.url || !allowedRelayPath(req.url)) {
        res.writeHead(403);
        res.end();
        return;
      }
      const headers: Record<string, string> = {
        "x-rimeward-native-token": process.env.RIMEWARD_NATIVE_TOKEN!,
      };
      for (const key of forwardHeaders) {
        const value = req.headers[key];
        if (typeof value === "string") headers[key] = value;
      }
      const target = new URL(req.url, process.env.PUBLIC_BASE_URL);
      const upstream = http.request(
        target,
        { method: req.method, headers },
        (response) => {
          const headers = { ...response.headers };
          delete headers["set-cookie"];
          delete headers["content-length"];
          headers["cache-control"] = "no-store";
          headers["x-accel-buffering"] = "no";
          res.writeHead(response.statusCode ?? 502, headers);
          if (headers["content-type"]?.includes("text/html")) {
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on("data", (chunk) => {
              bytes += chunk.length;
              if (bytes > 8 * 1024 * 1024) {
                upstream.destroy();
                res.destroy();
              } else chunks.push(chunk);
            });
            response.on("end", () =>
              res.end(relayHtml(Buffer.concat(chunks).toString(), base)),
            );
          } else response.pipe(res);
        },
      );
      upstream.on("error", () => res.destroy());
      res.on("close", () => upstream.destroy());
      req.on("error", () => upstream.destroy());
      req.pipe(upstream);
    });
    const stream = relaySocket(ws);
    stream.on("error", () => {});
    local.emit("connection", stream);
  });
}
export function relayHtml(html: string, base: string) {
  if (!/^\/runtime\/[\w-]{36}$/.test(base))
    throw new DevError("Invalid runtime.", 403);
  const bridge = fs.readFileSync(repoDir("public/runtime-bridge.js"), "utf8");
  return html
    .replace(
      /srcset=(["'])(.*?)\1/g,
      (_, quote, value) =>
        "srcset=" +
        quote +
        value.replace(/(^|[,\s])\/(?!\/)/g, `$1${base}/`) +
        quote,
    )
    .replace(
      /((?:src|href|action|poster|data-default)=["'])\/(?!\/)/g,
      `$1${base}/`,
    )
    .replace(/url\(["']?\/(?!\/)/g, (match) => match + base.slice(1) + "/")
    .replace(
      "<head>",
      `<head><meta name="rimeward-runtime-base" content="${base}"><script>${bridge}</script>`,
    );
}
export function ensureRemote() {
  if (isDesktop() && (globalThis as NativeGlobal).__nativeVault)
    void remotePairs(localOwner()).catch(() => {});
}
