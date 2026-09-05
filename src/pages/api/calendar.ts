import type { APIRoute } from 'astro';
import { reconnectResponse } from '../../lib/linked-accounts.ts';
import { agenda, calendarSources } from '../../lib/calendar.ts';

export const prerender = false;

// Merged agenda: Google, Outlook, iCloud and a Notion calendar database,
// sorted server-side. One dead or missing source never blanks the others.
export const GET: APIRoute = async ({ url, locals }) => {
  const userId = locals.user!.userId;
  const days = Math.min(Math.max(Number(url.searchParams.get('days') ?? 5) || 5, 1), 31);

  if (calendarSources(userId).length === 0) return Response.json({ error: 'not-linked' }, { status: 404 });

  try {
    const events = await agenda(userId, days);
    return Response.json({ events }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    // agenda throws only when EVERY linked provider failed (partial results
    // tolerate one dead provider) — so reconnect surfaces exactly when it should.
    const reconnect = reconnectResponse(err);
    if (reconnect) return reconnect;
    console.error('[calendar]', err);
    return Response.json({ error: 'calendar failed' }, { status: 502 });
  }
};
