import type { APIRoute } from 'astro';
import { takeConnectState } from '../../../../lib/oauth.ts';
import { exchangeNotionCode } from '../../../../lib/connect.ts';
import { storeLink } from '../../../../lib/linked-accounts.ts';

export const prerender = false;

export const GET: APIRoute = async ({ url, cookies, redirect }) => {
  const pending = takeConnectState(url.searchParams.get('state') ?? '', cookies);
  const code = url.searchParams.get('code');
  if (!pending || pending.provider !== 'notion' || !pending.userId || !code)
    return redirect('/account?err=notion-connect', 303);

  try {
    const tokens = await exchangeNotionCode(code);
    // Notion tokens don't expire and don't refresh: the sealed "refresh" slot
    // holds the access token itself (access_expires_at stays 0).
    storeLink({
      userId: pending.userId,
      provider: 'notion',
      label: tokens.workspace_name ?? 'notion',
      refreshToken: tokens.access_token,
      meta: { workspace_id: tokens.workspace_id, bot_id: tokens.bot_id },
    });
    return redirect('/dash?connected=Notion', 303);
  } catch (err) {
    console.error('[connect notion]', err);
    return redirect('/account?err=notion-connect', 303);
  }
};
