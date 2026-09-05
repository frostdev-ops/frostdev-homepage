import type { APIRoute } from 'astro';
import { CODEX_MODELS } from '../../../lib/agent/provider.ts';
import { listCodexModels } from '../../../lib/agent/codex.ts';
import { listOpenRouterModels } from '../../../lib/agent/openrouter.ts';

export const prerender = false;

/** Model ids for the config-dialog datalist, per provider. */
export const GET: APIRoute = async ({ url, locals }) => {
  if (url.searchParams.get('provider') === 'codex') {
    // The backend's own list when the account can be asked; the hand-kept
    // fallback when it cannot (no account linked yet, or the list is down).
    try {
      return Response.json({ models: await listCodexModels(locals.user!.userId) }, { headers: { 'cache-control': 'no-store' } });
    } catch {
      return Response.json({ models: CODEX_MODELS.map((id) => ({ id, name: id })), fallback: true });
    }
  }
  try {
    return Response.json({ models: await listOpenRouterModels() }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    console.error('[agent models]', err);
    return Response.json({ error: 'models unavailable' }, { status: 502 });
  }
};
