import type { APIRoute } from 'astro';
import { reconnectResponse } from '../../../lib/linked-accounts.ts';
import { actOnMail, asAccount } from '../../../lib/mail.ts';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const body = (await request.json().catch(() => null)) as { account?: string; id?: string; op?: string } | null;
  if (!body?.id || !body.op) return Response.json({ error: 'bad body' }, { status: 400 });

  try {
    const result = await actOnMail(
      locals.user!.userId,
      asAccount(body.account),
      String(body.id),
      String(body.op)
    );
    if ('error' in result) return Response.json({ error: result.error }, { status: result.status });
    return Response.json(result);
  } catch (err) {
    const reconnect = reconnectResponse(err);
    if (reconnect) return reconnect;
    console.error('[mail act]', err);
    return Response.json({ error: 'action failed' }, { status: 502 });
  }
};
