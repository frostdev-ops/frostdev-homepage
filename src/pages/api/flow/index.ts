import type { APIRoute } from 'astro';
import { getDashboard } from '../../../lib/dashboard.ts';
import { CHANNEL_RE } from '../../../lib/logic.ts';
import { createPacket, listPackets } from '../../../lib/flow.ts';
import { broadcast, enqueueFire } from '../../../lib/logic-engine.ts';

export const prerender = false;

function flowWard(userId: number, ward: unknown): string | null {
  return typeof ward === 'string' && getDashboard(userId).some((w) => w.i === ward && w.type === 'flow') ? ward : null;
}

export const GET: APIRoute = async ({ url, locals }) => {
  const userId = locals.user!.userId;
  const ward = flowWard(userId, url.searchParams.get('ward'));
  if (!ward) return Response.json({ error: 'not a flow ward' }, { status: 404 });
  return Response.json({ packets: listPackets(userId, ward) }, { headers: { 'cache-control': 'no-store' } });
};

/** Create a packet by hand on a flow ward (the ward's input box). */
export const POST: APIRoute = async ({ request, locals }) => {
  const userId = locals.user!.userId;
  const body = (await request.json().catch(() => null)) as { ward?: string; channel?: string; text?: string } | null;
  const ward = flowWard(userId, body?.ward);
  // Absent channel defaults to 'inbox'; a PRESENT-but-invalid one is an error,
  // not a silent reroute past every channel-filtered edge.
  const channel = body?.channel === undefined ? 'inbox' : typeof body.channel === 'string' && CHANNEL_RE.test(body.channel) ? body.channel : null;
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!ward || !channel || !text) return Response.json({ error: 'bad packet' }, { status: 400 });
  const packet = createPacket(userId, ward, channel, text);
  broadcast(userId, 'packets', { wards: [ward] });
  enqueueFire(userId, { type: 'packet-arrived', ward, channel, packet });
  return Response.json({ packet });
};
