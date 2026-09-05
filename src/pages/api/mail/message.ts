import type { APIRoute } from 'astro';
import { reconnectResponse } from '../../../lib/linked-accounts.ts';
import { asAccount, mailMessage } from '../../../lib/mail.ts';

export const prerender = false;

export const GET: APIRoute = async ({ url, locals }) => {
  const account = asAccount(url.searchParams.get('account'));
  const id = url.searchParams.get('id') ?? '';
  if (!id) return Response.json({ error: 'missing id' }, { status: 400 });

  try {
    const view = await mailMessage(locals.user!.userId, account, id, url.searchParams.get('images') === '1');
    if ('error' in view) return Response.json({ error: view.error }, { status: view.status });
    return Response.json(view, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    const reconnect = reconnectResponse(err);
    if (reconnect) return reconnect;
    console.error('[mail message]', err);
    return Response.json({ error: 'message unavailable' }, { status: 502 });
  }
};
