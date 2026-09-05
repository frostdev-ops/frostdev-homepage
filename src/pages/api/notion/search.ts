import type { APIRoute } from 'astro';
import { getLink, reconnectResponse } from '../../../lib/linked-accounts.ts';
import { notionSearch } from '../../../lib/notion.ts';

export const prerender = false;

export const GET: APIRoute = async ({ url, locals }) => {
  const userId = locals.user!.userId;
  if (!getLink(userId, 'notion')) return Response.json({ error: 'not-linked' }, { status: 404 });
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 200);
  if (q.length < 2) return Response.json({ results: [] });
  try {
    return Response.json({ results: await notionSearch(userId, q) }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    const reconnect = reconnectResponse(err);
    if (reconnect) return reconnect;
    console.error('[notion search]', err);
    return Response.json({ error: 'notion failed' }, { status: 502 });
  }
};
