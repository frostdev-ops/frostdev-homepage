import type { APIRoute } from 'astro';
import { takeConnectState } from '../../../../lib/oauth.ts';
import { exchangeZohoCode } from '../../../../lib/connect.ts';
import { storeLink } from '../../../../lib/linked-accounts.ts';
import { ZOHO_API_BASES, zohoPrimaryAccount } from '../../../../lib/zoho.ts';

export const prerender = false;

// Zoho names the user's data centre on the way back: `accounts-server` is the
// OAuth host every later refresh must use, and `location` picks the Mail API
// host. Both are stored on the link — guessing either later gets an INVALID_
// OAUTHTOKEN from the wrong region.
export const GET: APIRoute = async ({ url, cookies, redirect }) => {
  const pending = takeConnectState(url.searchParams.get('state') ?? '', cookies);
  if (!pending || pending.provider !== 'zoho' || !pending.userId) return redirect('/account?err=zoho-connect', 303);

  const denied = url.searchParams.get('error');
  if (denied) return redirect(`/account?err=${encodeURIComponent(`Zoho said: ${denied}`)}`, 303);
  const code = url.searchParams.get('code');
  if (!code) return redirect('/account?err=zoho-connect', 303);

  const accountsBase = (url.searchParams.get('accounts-server') || 'https://accounts.zoho.com').replace(/\/+$/, '');
  const apiBase = ZOHO_API_BASES[(url.searchParams.get('location') ?? 'us').toLowerCase()] ?? ZOHO_API_BASES.us!;

  try {
    const tokens = await exchangeZohoCode(code, accountsBase);
    const account = await zohoPrimaryAccount(apiBase, tokens.access_token);
    storeLink({
      userId: pending.userId,
      provider: 'zoho',
      label: account.email,
      refreshToken: tokens.refresh_token!,
      accessToken: tokens.access_token,
      expiresInSec: tokens.expires_in,
      scopes: tokens.scope ?? '',
      meta: { account_id: account.accountId, api_base: apiBase, accounts_base: accountsBase },
    });
    return redirect('/dash?connected=Zoho', 303);
  } catch (err) {
    console.error('[connect zoho]', err);
    return redirect('/account?err=zoho-connect', 303);
  }
};
