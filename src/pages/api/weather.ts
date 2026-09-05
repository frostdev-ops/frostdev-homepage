import type { APIRoute } from 'astro';
import { coords, getForecast } from '../../lib/weather.ts';

export const prerender = false;

export const GET: APIRoute = async () => {
  if (!coords()) return Response.json({ error: 'no-location' }, { status: 503 });
  const forecast = await getForecast();
  if (!forecast) return Response.json({ error: 'unavailable' }, { status: 503 });
  return Response.json(forecast, { headers: { 'cache-control': 'no-store' } });
};
