import type { APIRoute } from 'astro';
import { mintState, takeConnectState } from '../../../../lib/oauth.ts';
import { decodeIdToken } from '../../../../lib/google-sso.ts';
import { exchangeMicrosoftCode, microsoftConnectUrl } from '../../../../lib/connect.ts';
import { storeLink } from '../../../../lib/linked-accounts.ts';

export const prerender = false;

export const GET: APIRoute = async ({ url, cookies, redirect }) => {
  const pending = takeConnectState(url.searchParams.get('state') ?? '', cookies);
  if (!pending || pending.provider !== 'microsoft' || !pending.userId)
    return redirect('/account?err=ms-connect', 303);

  // Locked-down tenants commonly deny Mail.Send: retry once automatically with
  // the read-only scope set. The compose UI hides send when 'Mail.Send' is
  // absent from the stored scopes.
  const error = url.searchParams.get('error');
  if (error) {
    if (!pending.readonly && (error === 'access_denied' || error === 'consent_required'))
      return redirect(microsoftConnectUrl(mintState('microsoft', pending.userId, { readonly: true }), true), 303);
    return redirect('/account?err=ms-denied', 303);
  }

  const code = url.searchParams.get('code');
  if (!code) return redirect('/account?err=ms-connect', 303);

  try {
    const tokens = await exchangeMicrosoftCode(code);
    if (!tokens.refresh_token) throw new Error('missing refresh_token');
    // Same base64url JWT shape as Google's; only the email-ish claim differs.
    const claims = tokens.id_token
      ? (decodeIdToken(tokens.id_token) as { email?: string; preferred_username?: string })
      : {};
    storeLink({
      userId: pending.userId,
      provider: 'microsoft',
      label: claims.email ?? claims.preferred_username ?? 'outlook',
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token,
      expiresInSec: tokens.expires_in,
      scopes: tokens.scope ?? '',
    });
    return redirect('/dash?connected=Microsoft', 303);
  } catch (err) {
    console.error('[connect microsoft]', err);
    return redirect('/account?err=ms-connect', 303);
  }
};
