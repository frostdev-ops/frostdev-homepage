import type { APIRoute } from 'astro';
import { getPages, saveDashboard } from '../../lib/dashboard.ts';
import { broadcast, pruneUserLogic } from '../../lib/logic-engine.ts';
import { validateLayout, validatePages } from '../../lib/wards.ts';
import { isCommsType } from '../../lib/comms/types.ts';

export const prerender = false;

export const PUT: APIRoute = async ({ request, locals }) => {
  const body = await request.json().catch(() => null);
  // The page list rides beside the layout when the tab strip changed; absent,
  // the stored one stays and the layout is healed against it.
  const pages = body?.pages === undefined ? undefined : validatePages(body.pages);
  if (pages === null) return Response.json({ error: 'invalid_pages' }, { status: 400 });
  const layout = validateLayout(body?.layout, pages ?? getPages(locals.user!.userId));
  if (!layout) return Response.json({ error: 'invalid_layout' }, { status: 400 });
  saveDashboard(locals.user!.userId, layout, pages);
  // Removed wards must not leave live schedules, packets, or graph edges.
  pruneUserLogic(locals.user!.userId);
  // A chat ward's credentials arrive beside the layout (edit.ts), for wards
  // that are now stored; sealed into settings rows, never into layout_json.
  const tokens = body?.tokens;
  if (tokens && typeof tokens === 'object') {
    const { setCommsToken } = await import('../../lib/comms/index.ts');
    for (const [ward, t] of Object.entries(tokens as Record<string, { token?: unknown; appToken?: unknown }>)) {
      if (!layout.some((w) => w.i === ward && isCommsType(w.type))) continue;
      const token = typeof t?.token === 'string' ? t.token.trim().slice(0, 4096) : '';
      const appToken = typeof t?.appToken === 'string' ? t.appToken.trim().slice(0, 4096) : '';
      if (token || appToken) setCommsToken(locals.user!.userId, ward, { token: token || undefined, appToken: appToken || undefined });
    }
  }
  // The user's OTHER tabs follow this edit. `from` is the saving tab's own id,
  // echoed so it can ignore its own change rather than animate it back.
  broadcast(locals.user!.userId, 'layout', { layout, pages: pages ?? getPages(locals.user!.userId), from: typeof body?.from === 'string' ? body.from : '' });
  return Response.json({ ok: true });
};
