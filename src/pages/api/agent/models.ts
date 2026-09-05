import type { APIRoute } from 'astro';
import { CODEX_MODELS } from '../../../lib/agent/provider.ts';
import { listOpenRouterModels } from '../../../lib/agent/openrouter.ts';

export const prerender = false;

/** Model ids for the config-dialog datalist, per provider. */
export const GET: APIRoute = async ({ url }) => {
  if (url.searchParams.get('provider') === 'codex') {
    return Response.json({ models: CODEX_MODELS.map((id) => ({ id, name: id })) });
  }
  try {
    return Response.json({ models: await listOpenRouterModels() }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    console.error('[agent models]', err);
    return Response.json({ error: 'models unavailable' }, { status: 502 });
  }
};
