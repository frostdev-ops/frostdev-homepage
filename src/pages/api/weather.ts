import type { APIRoute } from 'astro';
import { getForecast, wardLocation } from '../../lib/weather.ts';

export const prerender = false;

/** `?ward=<id>` = that weather ward's place; without it, the board's first
 *  weather ward that has one (charts, the agent), else the instance fallback. */
export const GET: APIRoute = async ({ url, locals }) => {
  const ward = url.searchParams.get('ward') ?? undefined;
  if (ward !== undefined && !/^[a-z0-9-]{1,32}$/.test(ward)) return Response.json({ error: 'bad ward' }, { status: 400 });
  const at = wardLocation(locals.user!.userId, ward);
  if (!at) return Response.json({ error: 'no-location' }, { status: 503 });
  const forecast = await getForecast(at);
  if (!forecast) return Response.json({ error: 'unavailable' }, { status: 503 });
  return Response.json({ ...forecast, place: at.name ?? null }, { headers: { 'cache-control': 'no-store' } });
};
