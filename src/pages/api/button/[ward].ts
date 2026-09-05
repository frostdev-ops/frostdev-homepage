import type { APIRoute } from 'astro';
import { getDashboard } from '../../../lib/dashboard.ts';
import { pressButton } from '../../../lib/logic-engine.ts';

export const prerender = false;

/** One press = one button-pressed firing. No storage: logic_runs is the log,
 *  the runs stream the live feed. The ward is resolved from the STORED layout,
 *  so a freshly added ward answers 404 until the layout is saved (same as timers). */
export const POST: APIRoute = async ({ params, locals }) => {
  const userId = locals.user!.userId;
  const w = getDashboard(userId).find((x) => x.i === params.ward && x.type === 'button');
  if (!w) return Response.json({ error: 'not a button ward' }, { status: 404 });
  try {
    pressButton(userId, w.i);
  } catch {
    return Response.json({ error: 'too many presses' }, { status: 429 });
  }
  return Response.json({ ok: true });
};
