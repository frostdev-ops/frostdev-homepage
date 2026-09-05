import type { APIRoute } from 'astro';
import { getDashboard } from '../../../lib/dashboard.ts';
import { validateGraph } from '../../../lib/logic.ts';
import { getGraph, getRuns, saveGraph } from '../../../lib/logic-engine.ts';

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  const userId = locals.user!.userId;
  return Response.json({ graph: getGraph(userId), runs: getRuns(userId) }, { headers: { 'cache-control': 'no-store' } });
};

export const PUT: APIRoute = async ({ request, locals }) => {
  const userId = locals.user!.userId;
  const body = await request.json().catch(() => null);
  const graph = validateGraph(body?.graph, getDashboard(userId), { isAdmin: locals.user!.role === 'admin' });
  if (!graph) return Response.json({ error: 'invalid_graph' }, { status: 400 });
  saveGraph(userId, graph);
  return Response.json({ ok: true });
};
