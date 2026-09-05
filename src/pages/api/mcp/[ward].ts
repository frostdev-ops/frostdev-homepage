import type { APIRoute } from 'astro';
import { mcpStatus, mcpWard, setMcpToken } from '../../../lib/agent/mcp.ts';

export const prerender = false;

// The MCP ward: GET connects (or reuses the session) and lists the server's
// tools — ?fresh=1 reconnects; PUT {token} seals the credential, DELETE
// clears it. The ward id must name one of this user's mcp wards.

export const GET: APIRoute = async ({ params, url, locals }) => {
  const userId = locals.user!.userId;
  const w = mcpWard(userId, params.ward);
  if (!w) return Response.json({ error: 'not an mcp ward' }, { status: 400 });
  return Response.json(await mcpStatus(userId, w.i, url.searchParams.get('fresh') === '1'), { headers: { 'cache-control': 'no-store' } });
};

export const PUT: APIRoute = async ({ params, request, locals }) => {
  const userId = locals.user!.userId;
  const w = mcpWard(userId, params.ward);
  if (!w) return Response.json({ error: 'not an mcp ward' }, { status: 400 });
  const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
  const token = typeof body?.token === 'string' ? body.token.trim() : '';
  if (!token || token.length > 4096) return Response.json({ error: 'bad token' }, { status: 400 });
  setMcpToken(userId, w.i, token);
  return Response.json({ ok: true });
};

export const DELETE: APIRoute = ({ params, locals }) => {
  const userId = locals.user!.userId;
  const w = mcpWard(userId, params.ward);
  if (!w) return Response.json({ error: 'not an mcp ward' }, { status: 400 });
  setMcpToken(userId, w.i, null);
  return Response.json({ ok: true });
};
