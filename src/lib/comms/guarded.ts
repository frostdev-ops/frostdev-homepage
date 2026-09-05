import { vettedFetch } from '../agent/shell.ts';

// fetch() over the SSRF guard, for the chat providers whose host the USER
// names (an ntfy server, a Matrix homeserver): every hop resolves through
// vetHost and a private or loopback address is refused, exactly like the
// sandbox's curl and the MCP client. Fixed vendor hosts (Discord, Slack,
// Telegram, Twilio, Pushover) keep plain fetch, like google.ts.

const NO_BODY = new Set([101, 204, 205, 304]);

export const guardedFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const headers: Record<string, string> = {};
  const h = init?.headers;
  if (h instanceof Headers) h.forEach((v, k) => (headers[k] = v));
  else if (Array.isArray(h)) for (const [k, v] of h) headers[k] = v;
  else if (h) Object.assign(headers, h as Record<string, string>);
  if (init?.body !== undefined && init.body !== null && typeof init.body !== 'string') throw new Error('guardedFetch: string bodies only');
  const r = await vettedFetch(url, { method: init?.method ?? 'GET', headers, body: init?.body ?? undefined, timeoutMs: 30_000 });
  return new Response(NO_BODY.has(r.status) ? null : (r.body as BodyInit), { status: r.status, statusText: r.statusText, headers: r.headers });
};
