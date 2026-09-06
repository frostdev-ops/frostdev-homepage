import type { APIRoute } from 'astro';
import { CODEX_MODELS, defaultAgentProvider } from '../../../lib/agent/provider.ts';
import { sharedCodexModels, syncRime } from '../../../lib/agent/sync.ts';
import { listCodexModels } from '../../../lib/agent/codex.ts';
import { listOpenRouterModels } from '../../../lib/agent/openrouter.ts';

export const prerender = false;

/** Model ids for the config-dialog datalist, per provider. */
export const GET: APIRoute = async ({ url, locals }) => {
  const user = locals.user?.userId;
  if (!user) return Response.json({error:'Sign in required.'},{status:401});
  await syncRime(user);
  const provider = url.searchParams.get('provider');
  if ((provider === 'default' ? defaultAgentProvider(user) : provider) === 'codex') {
    // The backend's own list when the account can be asked; the hand-kept
    // fallback when it cannot (no account linked yet, or the list is down).
    try {
      return Response.json({ models: await sharedCodexModels(user) ?? await listCodexModels(user) }, { headers: { 'cache-control': 'no-store' } });
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
