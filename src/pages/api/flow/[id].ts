import type { APIRoute } from 'astro';
import { annotatePacket, completePacket, markPassed } from '../../../lib/flow.ts';
import { broadcast, enqueueFire } from '../../../lib/logic-engine.ts';

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
  const userId = locals.user!.userId;
  const id = Number(params.id);
  const body = (await request.json().catch(() => null)) as { op?: string; note?: string } | null;
  if (!Number.isInteger(id)) return Response.json({ error: 'bad id' }, { status: 400 });

  if (body?.op === 'annotate') {
    if (typeof body.note !== 'string' || !body.note.trim()) return Response.json({ error: 'note required' }, { status: 400 });
    const packet = annotatePacket(userId, id, body.note);
    if (!packet) return Response.json({ error: 'not found' }, { status: 404 });
    broadcast(userId, 'packets', { wards: [packet.ward] });
    return Response.json({ ok: true });
  }
  if (body?.op === 'pass') {
    const packet = markPassed(userId, id);
    if (!packet) return Response.json({ error: 'not found' }, { status: 404 });
    broadcast(userId, 'packets', { wards: [packet.ward] });
    enqueueFire(userId, { type: 'packet-passed', ward: packet.ward, channel: packet.channel, packet });
    return Response.json({ ok: true });
  }
  if (body?.op === 'complete') {
    const packet = completePacket(userId, id);
    if (!packet) return Response.json({ error: 'not found' }, { status: 404 });
    broadcast(userId, 'packets', { wards: [packet.ward] });
    enqueueFire(userId, { type: 'packet-completed', ward: packet.ward, channel: packet.channel, packet });
    return Response.json({ ok: true });
  }
  return Response.json({ error: 'bad op' }, { status: 400 });
};
