import type { APIRoute } from 'astro';
import { docIndex, listDocs, storeKind, STORES } from '../../../../lib/agent/store.ts';

export const prerender = false;

// A store's list (memory or skill): every document with its description, and
// how much of the generated index rides in Rime's prompt.
export const GET: APIRoute = ({ params, locals }) => {
  const kind = storeKind(params.kind);
  if (!kind) return Response.json({ error: 'no such store' }, { status: 404 });
  const userId = locals.user!.userId;
  return Response.json(
    { docs: listDocs(userId, kind), indexChars: docIndex(userId, kind).length, indexCap: STORES[kind].indexCap },
    { headers: { 'cache-control': 'no-store' } }
  );
};
