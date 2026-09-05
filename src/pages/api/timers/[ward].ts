import type { APIRoute } from 'astro';
import { timerOp } from '../../../lib/logic-engine.ts';
import { getTimers } from '../../../lib/timers.ts';

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
  const state = getTimers(locals.user!.userId).find((t) => t.ward === params.ward);
  if (!state) return Response.json({ error: 'not a timer ward' }, { status: 404 });
  return Response.json(state, { headers: { 'cache-control': 'no-store' } });
};

export const POST: APIRoute = async ({ params, request, locals }) => {
  const body = (await request.json().catch(() => null)) as { op?: string } | null;
  const op = body?.op;
  if (op !== 'start' && op !== 'pause' && op !== 'reset' && op !== 'skip') return Response.json({ error: 'bad op' }, { status: 400 });
  const res = timerOp(locals.user!.userId, params.ward ?? '', op);
  if ('error' in res) {
    return Response.json({ error: res.error }, { status: res.error === 'not-a-timer' ? 404 : 409 });
  }
  return Response.json(res.ok);
};
