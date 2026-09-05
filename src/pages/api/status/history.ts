import type { APIRoute } from 'astro';
import { getHistory } from '../../../lib/status.ts';
import { TARGETS } from '../../../lib/targets.ts';
import { HOST_SERVICE_IDS } from '../../../lib/wards.ts';

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const service = url.searchParams.get('service') ?? '';
  const known = TARGETS.some((t) => t.id === service) || (HOST_SERVICE_IDS as readonly string[]).includes(service);
  if (!known) return Response.json({ error: 'unknown service' }, { status: 404 });
  const hours = Number(url.searchParams.get('hours') ?? '24') || 24;
  return Response.json(getHistory(service, hours), { headers: { 'cache-control': 'no-store' } });
};
