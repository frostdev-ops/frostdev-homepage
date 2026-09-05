import type { APIRoute } from 'astro';
import { sendDraft } from '../../../lib/mail.ts';
import { reconnectResponse } from '../../../lib/linked-accounts.ts';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const body = (await request.json().catch(() => null)) as { draftId?: string } | null;
  if (!body?.draftId) return Response.json({ error: 'bad body' }, { status: 400 });

  try {
    const result = await sendDraft(locals.user!.userId, String(body.draftId));
    if ('error' in result) return Response.json({ error: result.error }, { status: result.status });
    return Response.json({ ok: true });
  } catch (err) {
    const reconnect = reconnectResponse(err);
    if (reconnect) return reconnect;
    console.error('[mail send]', err);
    return Response.json({ error: 'send failed' }, { status: 502 });
  }
};
