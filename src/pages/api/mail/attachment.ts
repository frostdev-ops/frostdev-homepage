import type { APIRoute } from 'astro';
import { reconnectResponse } from '../../../lib/linked-accounts.ts';
import { asAccount, mailAttachment } from '../../../lib/mail.ts';

export const prerender = false;

/** The download name rides the URL for convenience; it is re-sanitized here so
 *  nothing a sender chose can inject header syntax or a path. */
const safeName = (raw: string): string =>
  (raw.replace(/[\\/]/g, '_').replace(/[^\x20-\x7e]/g, '').replace(/["\r\n]/g, '').trim() || 'attachment').slice(0, 120);

export const GET: APIRoute = async ({ url, locals }) => {
  const account = asAccount(url.searchParams.get('account'));
  const id = url.searchParams.get('id') ?? '';
  const attachmentId = url.searchParams.get('a') ?? '';
  if (!id || !attachmentId) return Response.json({ error: 'missing id' }, { status: 400 });

  try {
    const bytes = await mailAttachment(locals.user!.userId, account, id, attachmentId);
    if (!Buffer.isBuffer(bytes)) return Response.json({ error: bytes.error }, { status: bytes.status });
    return new Response(new Uint8Array(bytes), {
      headers: {
        // Always an attachment, never inline: an HTML or SVG file rendered on
        // this origin would run with the session cookie.
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${safeName(url.searchParams.get('name') ?? '')}"`,
        'cache-control': 'private, no-store',
      },
    });
  } catch (err) {
    const reconnect = reconnectResponse(err);
    if (reconnect) return reconnect;
    console.error('[mail attachment]', err);
    return Response.json({ error: 'attachment unavailable' }, { status: 502 });
  }
};
