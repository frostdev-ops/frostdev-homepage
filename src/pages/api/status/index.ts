import type { APIRoute } from 'astro';
import { buildInfo, getSnapshot } from '../../../lib/status.ts';

export const prerender = false;

export const GET: APIRoute = async () => {
  const snap = getSnapshot();
  if (!snap) return Response.json({ error: 'warming up' }, { status: 503, headers: { 'retry-after': '5' } });
  return Response.json({ ...snap, build: buildInfo() }, { headers: { 'cache-control': 'no-store' } });
};
