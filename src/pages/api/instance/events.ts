import type { APIRoute } from 'astro';
import { instanceRequest } from '../../../lib/dev/remote.ts';
export const GET: APIRoute = async ({ locals, request }) => {
  try { return await instanceRequest(locals.user!.userId, '/api/logic/stream', request); }
  catch { return new Response(null, { status: 503, headers: { 'cache-control': 'no-store' } }); }
};
