import type { APIRoute } from 'astro';
import { getLink, reconnectResponse } from '../../../lib/linked-accounts.ts';
import { notionCapture } from '../../../lib/notion.ts';
import { notionIdFrom } from '../../../lib/wards.ts';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const userId = locals.user!.userId;
  if (!getLink(userId, 'notion')) return Response.json({ error: 'not-linked' }, { status: 404 });
  const body = (await request.json().catch(() => null)) as { text?: string; pageId?: string } | null;
  const text = (body?.text ?? '').trim();
  if (!text) return Response.json({ error: 'empty' }, { status: 400 });
  // A page ward captures to ITS page; a bare capture line goes to the account's capture page.
  const pageId = body?.pageId ? notionIdFrom(body.pageId) : undefined;
  if (body?.pageId && !pageId) return Response.json({ error: 'bad page id' }, { status: 400 });
  try {
    await notionCapture(userId, text, pageId ?? undefined);
    return Response.json({ ok: true });
  } catch (err) {
    const reconnect = reconnectResponse(err);
    if (reconnect) return reconnect;
    console.error('[notion capture]', err);
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
};
