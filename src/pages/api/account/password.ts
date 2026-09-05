import type { APIRoute } from 'astro';
import { SESSION_COOKIE } from '../../../lib/auth.ts';
import { hasPassword, setUserPassword, verifyUserPassword } from '../../../lib/users.ts';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals, cookies, redirect }) => {
  const user = locals.user!;
  const form = await request.formData();
  const current = String(form.get('current') ?? '');
  const next = String(form.get('next') ?? '');

  if (next.length < 10) return redirect('/account?err=short', 303);
  // SSO-only users set their first password without a current one.
  if (hasPassword(user.userId) && !verifyUserPassword(user.userId, current))
    return redirect('/account?err=wrong', 303);

  setUserPassword(user.userId, next, cookies.get(SESSION_COOKIE)?.value);
  return redirect('/account?ok=password', 303);
};
