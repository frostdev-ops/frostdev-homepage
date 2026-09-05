import type { APIRoute } from 'astro';
import { broadcast } from '../../../../lib/logic-engine.ts';
import { deleteDoc, importSkill, readDoc, storeKind, writeDoc, STORES } from '../../../../lib/agent/store.ts';
import { vettedFetch } from '../../../../lib/agent/shell.ts';

export const prerender = false;

// One document (a memory, a skill): read, rewrite, delete. The same store the
// agent's tools write, so the ward and Rime never disagree. The 'refresh'
// broadcast repaints the ward in every other open tab.

export const GET: APIRoute = ({ params, locals }) => {
  const kind = storeKind(params.kind);
  const d = kind && readDoc(locals.user!.userId, kind, String(params.name));
  return d ? Response.json(d, { headers: { 'cache-control': 'no-store' } }) : Response.json({ error: 'no such document' }, { status: 404 });
};

export const PUT: APIRoute = async ({ params, request, locals }) => {
  const kind = storeKind(params.kind);
  if (!kind) return Response.json({ error: 'no such store' }, { status: 404 });
  const userId = locals.user!.userId;
  if (Number(request.headers.get('content-length') ?? 0) > STORES[kind].bodyMax * 4) return Response.json({ error: 'too large' }, { status: 413 });
  const body = (await request.json().catch(() => null)) as { description?: unknown; body?: unknown } | null;
  if (!body || typeof body.description !== 'string' || typeof body.body !== 'string') return Response.json({ error: 'bad body' }, { status: 400 });
  try {
    const saved = writeDoc(userId, kind, String(params.name), body.description, body.body);
    broadcast(userId, 'refresh', { type: kind });
    return Response.json(saved);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    if (status === 500) console.error('[store]', err);
    return Response.json({ error: err instanceof Error ? err.message : 'save failed' }, { status });
  }
};

export const DELETE: APIRoute = ({ params, locals }) => {
  const kind = storeKind(params.kind);
  const userId = locals.user!.userId;
  if (!kind || !deleteDoc(userId, kind, String(params.name))) return Response.json({ error: 'no such document' }, { status: 404 });
  broadcast(userId, 'refresh', { type: kind });
  return Response.json({ ok: true });
};

/** Import a ward folder from a URL (skills only): {url}. */
export const POST: APIRoute = async ({ params, request, locals }) => {
  if (storeKind(params.kind) !== 'skill') return Response.json({ error: 'only skills import' }, { status: 400 });
  const userId = locals.user!.userId;
  const body = (await request.json().catch(() => null)) as { url?: unknown } | null;
  if (!body || typeof body.url !== 'string') return Response.json({ error: 'bad body' }, { status: 400 });
  try {
    const out = await importSkill(userId, String(params.name), body.url.trim(), vettedFetch);
    broadcast(userId, 'refresh', { type: 'skill' });
    return Response.json(out);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    if (status === 500) console.error('[store] import', err);
    return Response.json({ error: err instanceof Error ? err.message : 'import failed' }, { status });
  }
};
