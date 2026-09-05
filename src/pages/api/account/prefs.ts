import type { APIRoute } from 'astro';
import { setSetting } from '../../../lib/settings.ts';

export const prerender = false;

/** Dashboard preferences. One key so far: how loud the alert banner is. */
export const ALERT_MODES = ['visible', 'all', 'off'] as const;

export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const form = await request.formData().catch(() => null);
  const mode = String(form?.get('alerts') ?? '');
  if (!(ALERT_MODES as readonly string[]).includes(mode)) {
    return redirect('/account?err=unknown+alert+setting#dashboard', 303);
  }
  setSetting(`alerts:${locals.user!.userId}`, mode);
  return redirect('/account?ok=prefs#dashboard', 303);
};
