import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db.ts';
import { normalizeTheme, parseTheme } from '../../../lib/theme.ts';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const form = await request.formData();
  const userId = locals.user!.userId;
  const db = getDb();

  if (form.get('reset')) {
    db.prepare('UPDATE users SET theme = NULL WHERE id = ?').run(userId);
    return redirect('/account?ok=theme', 303);
  }

  // Header toggle sends only `mode`: merge it into the stored theme (or the
  // defaults when none is saved yet).
  const modeOnly = form.has('mode') && !form.has('preset');
  const base = modeOnly ? (parseTheme(locals.user!.theme) ?? {}) : {};
  const cfg = normalizeTheme({ ...base, ...Object.fromEntries(form) });
  db.prepare('UPDATE users SET theme = ? WHERE id = ?').run(JSON.stringify(cfg), userId);
  return redirect('/account?ok=theme', 303);
};
