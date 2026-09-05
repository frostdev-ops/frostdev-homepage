import type { APIRoute } from 'astro';
import { asAccount, createDraft } from '../../../lib/mail.ts';
import { reconnectResponse } from '../../../lib/linked-accounts.ts';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const body = (await request.json().catch(() => null)) as {
    account?: string;
    to?: string[];
    cc?: string[];
    subject?: string;
    body?: string;
    inReplyTo?: string;
  } | null;
  if (!body || !Array.isArray(body.to)) return Response.json({ error: 'bad body' }, { status: 400 });

  try {
    const result = await createDraft({
      userId: locals.user!.userId,
      account: asAccount(body.account),
      to: body.to.map(String),
      cc: body.cc?.map(String),
      subject: String(body.subject ?? ''),
      body: String(body.body ?? ''),
      inReplyTo: body.inReplyTo ? String(body.inReplyTo) : undefined,
    });
    if ('error' in result) return Response.json({ error: result.error }, { status: result.status });
    return Response.json(result);
  } catch (err) {
    const reconnect = reconnectResponse(err);
    if (reconnect) return reconnect;
    console.error('[mail draft]', err);
    return Response.json({ error: 'draft failed' }, { status: 502 });
  }
};
