import type { APIRoute } from 'astro';
import { channelsFor, commsStatus, commsWard, messagesFor, sendChat, setCommsToken } from '../../../lib/comms/index.ts';

export const prerender = false;

// The chat wards' one route. GET ?view=status (default) | channels |
// messages&channel=&limit=; POST {channel?, text, replyTo?, thread?} sends;
// PUT {token?, appToken?} seals the credentials; DELETE clears them. The ward
// id must name one of this user's chat wards in the STORED layout.

const notChat = () => Response.json({ error: 'not a chat ward' }, { status: 400 });
const failed = (err: unknown) => Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });

export const GET: APIRoute = async ({ params, url, locals }) => {
  const userId = locals.user!.userId;
  const w = commsWard(userId, params.ward);
  if (!w) return notChat();
  const view = url.searchParams.get('view') ?? 'status';
  const headers = { 'cache-control': 'no-store' };
  try {
    if (view === 'channels') return Response.json({ channels: await channelsFor(userId, w.i) }, { headers });
    if (view === 'messages') {
      const channel = url.searchParams.get('channel') || null;
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 30, 1), 200);
      return Response.json({ messages: await messagesFor(userId, w.i, channel, limit) }, { headers });
    }
    return Response.json(commsStatus(userId, w), { headers });
  } catch (err) {
    return failed(err);
  }
};

export const POST: APIRoute = async ({ params, request, locals }) => {
  const userId = locals.user!.userId;
  const w = commsWard(userId, params.ward);
  if (!w) return notChat();
  const body = (await request.json().catch(() => null)) as { channel?: unknown; text?: unknown; replyTo?: unknown; thread?: unknown } | null;
  const text = typeof body?.text === 'string' ? body.text : '';
  if (!text.trim()) return Response.json({ error: 'nothing to send' }, { status: 400 });
  try {
    const message = await sendChat(userId, w.i, typeof body?.channel === 'string' ? body.channel : undefined, text, {
      replyTo: typeof body?.replyTo === 'string' && body.replyTo ? body.replyTo : undefined,
      thread: body?.thread === true,
    });
    return Response.json({ ok: true, message });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: /rate limit|not a .* channel id|no channel|nothing to send|no token/.test(msg) ? 400 : 502 });
  }
};

export const PUT: APIRoute = async ({ params, request, locals }) => {
  const userId = locals.user!.userId;
  const w = commsWard(userId, params.ward);
  if (!w) return notChat();
  const body = (await request.json().catch(() => null)) as { token?: unknown; appToken?: unknown } | null;
  const token = typeof body?.token === 'string' ? body.token.trim() : '';
  const appToken = typeof body?.appToken === 'string' ? body.appToken.trim() : '';
  if ((!token && !appToken) || token.length > 4096 || appToken.length > 4096) return Response.json({ error: 'bad token' }, { status: 400 });
  setCommsToken(userId, w.i, { token: token || undefined, appToken: appToken || undefined });
  return Response.json({ ok: true });
};

export const DELETE: APIRoute = ({ params, locals }) => {
  const userId = locals.user!.userId;
  const w = commsWard(userId, params.ward);
  if (!w) return notChat();
  setCommsToken(userId, w.i, null);
  return Response.json({ ok: true });
};
