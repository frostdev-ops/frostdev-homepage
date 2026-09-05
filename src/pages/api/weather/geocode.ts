import type { APIRoute } from 'astro';
import { geocode } from '../../../lib/weather.ts';

export const prerender = false;

/** The weather ward's Configure dialog: `?q=<place>` → up to six matches. */
export const GET: APIRoute = async ({ url }) => {
  const places = await geocode(url.searchParams.get('q') ?? '');
  if (!places) return Response.json({ error: 'unavailable' }, { status: 503 });
  return Response.json({ places });
};
