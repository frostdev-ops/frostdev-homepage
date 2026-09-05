import type { APIRoute } from 'astro';
import { mintState } from '../../../lib/oauth.ts';
import { ssoAuthorizeUrl } from '../../../lib/google-sso.ts';
import { secret } from '../../../lib/secrets.ts';
import { SSO_STATE_COOKIE, ssoStateCookieOptions } from '../../../lib/auth.ts';

export const prerender = false;

export const GET: APIRoute = async ({ cookies, redirect }) => {
  if (!secret('GOOGLE_CLIENT_ID') || !secret('GOOGLE_CLIENT_SECRET'))
    return redirect('/login?err=sso-unconfigured', 303);
  const state = mintState('google-sso');
  // There is no session yet to bind the state to, so the state itself is
  // echoed into a cookie: the callback only accepts a login the browser in
  // front of it actually started (login CSRF into an attacker's account).
  cookies.set(SSO_STATE_COOKIE, state, ssoStateCookieOptions());
  return redirect(ssoAuthorizeUrl(state), 303);
};
