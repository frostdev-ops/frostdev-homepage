import type { APIRoute } from 'astro';
import { recentIncidents } from '../../../lib/status.ts';

export const prerender = false;

/** The last 24h of down→up spans, one scan per status tick (cached). */
export const GET: APIRoute = async () => Response.json({ hours: 24, spans: await recentIncidents() }, { headers: { 'cache-control': 'no-store' } });
