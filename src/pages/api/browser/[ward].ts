import type { APIRoute } from 'astro';
import { browserWard } from '../../../lib/dashboard.ts';
import { open, runCmds } from '../../../lib/browser/session.ts';

export const prerender = false;

/** The human's input: one batch of commands (pointer, keys, text, navigation,
 *  tabs, resize) for the ward's active page. State comes back over the
 *  stream, not here — this only says whether the batch ran. */
export const POST: APIRoute = async ({ params, request, locals }) => {
  const userId = locals.user!.userId;
  const ward = String(params.ward);
  const cfg = browserWard(userId, ward);
  if (!cfg) return Response.json({ error: 'not a browser ward' }, { status: 400 });
  const body = (await request.json().catch(() => null)) as { cmds?: unknown } | null;
  if (!body || !Array.isArray(body.cmds)) return Response.json({ error: 'bad body' }, { status: 400 });
  try {
    const s = await open(userId, ward, cfg);
    await runCmds(s, body.cmds);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message.split('\n')[0] : 'failed' }, { status: 400 });
  }
};
