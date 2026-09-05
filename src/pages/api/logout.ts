import type { APIRoute } from 'astro';
import { SESSION_COOKIES, destroySession, sessionId } from '../../lib/auth.ts';

export const prerender = false;

export const POST: APIRoute = async ({ cookies, redirect }) => {
  const id = sessionId(cookies);
  if (id) destroySession(id);
  for (const name of SESSION_COOKIES) cookies.delete(name, { path: '/' });
  return redirect('/login', 303);
};
