import { defineMiddleware } from 'astro:middleware';
import { SESSION_COOKIE, getSession } from './lib/auth.ts';
import { ensureStatusEngine } from './lib/status.ts';
import { ensureLogicEngine } from './lib/logic-engine.ts';
import { ensureBrowser } from './lib/browser/session.ts';
import { ensureComms } from './lib/comms/index.ts';
import { ensureTunnel } from './lib/tunnel.ts';

// The status + logic engines live in-process; middleware load is the one place
// that runs exactly once per server boot (guarded against dev-HMR double-starts).
ensureStatusEngine();
ensureLogicEngine();
ensureBrowser(); // orphan sweep + graceful close for the browser wards
ensureComms(); // every chat ward with a token reconnects; sockets close on the way down
ensureTunnel(); // publishes the desktop app's upgrade handler for server.mjs / the dev hook

// Public: the splash (exact match — everything else under / is gated), login,
// the SSO endpoints, the OAuth connect callbacks (public so the provider can
// land on them; each one re-checks the session itself), and static assets.
const PUBLIC_PREFIXES = [
  '/login',
  '/api/login',
  '/api/logout', // must work with a DEAD session too, or the cookie can never be cleared
  '/api/auth/google', // covers /callback too
  '/api/connect/google/callback',
  '/api/connect/microsoft/callback',
  '/api/connect/notion/callback',
  '/api/connect/zoho/callback',
  '/_astro/',
  '/_image', // Astro's image optimizer — the splash wordmark/emblem live here
  '/favicon',
  '/apple-touch-icon',
  '/bb-frost/', // the Blackboard theme's installer + zip (public/bb-frost), curl'd unauthenticated
  '/icon-',
];

const ADMIN_PREFIXES = ['/admin', '/api/users'];

export const onRequest = defineMiddleware((context, next) => {
  const { pathname } = context.url;
  if (pathname === '/') return next();
  if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return next();

  const cookie = context.cookies.get(SESSION_COOKIE)?.value;
  const session = getSession(cookie);
  if (!session) {
    // A cookie that no longer names a session is dead weight: an HttpOnly
    // cookie the browser keeps sending, that no script can replace, and that
    // this branch would otherwise bounce on forever.
    if (cookie) context.cookies.delete(SESSION_COOKIE, { path: '/' });
    if (pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    return context.redirect('/login', 303);
  }

  if (session.role !== 'admin' && ADMIN_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    if (pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    }
    return context.redirect('/dash', 303);
  }

  context.locals.user = session;
  return next();
});
