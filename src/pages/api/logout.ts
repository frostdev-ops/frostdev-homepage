import type { APIRoute } from 'astro';
import { SESSION_COOKIE, destroySession } from '../../lib/auth.ts';

export const prerender = false;

export const POST: APIRoute = async ({ cookies, redirect }) => {
  const id = cookies.get(SESSION_COOKIE)?.value;
  if (id) destroySession(id);
  cookies.delete(SESSION_COOKIE, { path: '/' });
  return redirect('/login', 303);
};
