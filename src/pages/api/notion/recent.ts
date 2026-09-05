import type { APIRoute } from 'astro';
import { getLink, reconnectResponse } from '../../../lib/linked-accounts.ts';
import { notionRecent } from '../../../lib/notion.ts';

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  const userId = locals.user!.userId;
  if (!getLink(userId, 'notion')) return Response.json({ error: 'not-linked' }, { status: 404 });
  try {
    return Response.json({ pages: await notionRecent(userId) }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    const reconnect = reconnectResponse(err);
    if (reconnect) return reconnect;
    console.error('[notion recent]', err);
    return Response.json({ error: 'notion failed' }, { status: 502 });
  }
};
