import { secret } from './secrets.ts';
import { baseUrl } from './oauth.ts';

/** SSO auto-provisions only for this Workspace domain; anyone else needs an
 *  admin-created row (the invite). Enforced server-side — the `hd` URL param
 *  is advisory UX only. */
export const WORKSPACE_DOMAIN = 'frostdev.io';

export function ssoRedirectUri(): string {
  return `${baseUrl()}/api/auth/google/callback`;
}

export function ssoAuthorizeUrl(state: string): string {
  const p = new URLSearchParams({
    client_id: secret('GOOGLE_CLIENT_ID'),
    redirect_uri: ssoRedirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    hd: WORKSPACE_DOMAIN,
    prompt: 'select_account',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export async function exchangeGoogleCode(
  code: string,
  redirectUri: string
): Promise<{ id_token?: string; access_token?: string; refresh_token?: string; expires_in?: number }> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: secret('GOOGLE_CLIENT_ID'),
      client_secret: secret('GOOGLE_CLIENT_SECRET'),
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`google token exchange failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export interface IdClaims {
  email?: string;
  email_verified?: boolean;
  hd?: string;
  name?: string;
}

/** Decode without signature verification — acceptable only because the token
 *  arrived directly from Google's token endpoint over TLS in our own
 *  server-to-server exchange, never from the browser. */
export function decodeIdToken(idToken: string): IdClaims {
  const payload = idToken.split('.')[1];
  if (!payload) throw new Error('malformed id_token');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

export type SsoDecision =
  | { action: 'login' }
  | { action: 'create'; role: 'admin' | 'member' }
  | { action: 'reject'; reason: string };

/** Pure decision function (unit-tested):
 *  - an existing row logs in whatever the domain (that's how invites SSO in)
 *  - first frostdev.io user ever bootstraps as admin
 *  - other frostdev.io users auto-provision as member
 *  - everyone else is rejected */
export function decideSsoLogin(claims: IdClaims, hasExistingUser: boolean, totalUsers: number): SsoDecision {
  if (!claims.email || !claims.email_verified) return { action: 'reject', reason: 'unverified email' };
  if (hasExistingUser) return { action: 'login' };
  if (claims.hd === WORKSPACE_DOMAIN) return { action: 'create', role: totalUsers === 0 ? 'admin' : 'member' };
  return { action: 'reject', reason: 'not invited' };
}
