import { getDb } from './db.ts';
import { sealToken, openToken } from './crypto.ts';
import { secret, type SecretKey } from './secrets.ts';

export type Provider = 'google' | 'microsoft' | 'notion' | 'zoho' | 'mailbox' | 'icloud';

export interface LinkedAccount {
  user_id: number;
  provider: Provider;
  account_label: string;
  refresh_token_enc: string;
  access_token: string;
  access_expires_at: number;
  scopes: string;
  meta_json: string;
}

/** The stored grant is dead (revoked/expired) — the ward shows a Reconnect chip. */
export class ReconnectError extends Error {
  provider: Provider;
  constructor(provider: Provider) {
    super(`reconnect ${provider}`);
    this.provider = provider;
  }
}

export function getLink(userId: number, provider: Provider): LinkedAccount | null {
  return (
    (getDb()
      .prepare('SELECT * FROM linked_accounts WHERE user_id = ? AND provider = ?')
      .get(userId, provider) as LinkedAccount | undefined) ?? null
  );
}

export function storeLink(opts: {
  userId: number;
  provider: Provider;
  label: string;
  refreshToken: string;
  accessToken?: string;
  expiresInSec?: number;
  scopes?: string;
  meta?: Record<string, unknown>;
}): void {
  getDb()
    .prepare(
      `INSERT INTO linked_accounts (user_id, provider, account_label, refresh_token_enc, access_token, access_expires_at, scopes, meta_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, provider) DO UPDATE SET
         account_label = excluded.account_label,
         refresh_token_enc = excluded.refresh_token_enc,
         access_token = excluded.access_token,
         access_expires_at = excluded.access_expires_at,
         scopes = excluded.scopes,
         meta_json = excluded.meta_json`
    )
    .run(
      opts.userId,
      opts.provider,
      opts.label,
      sealToken(opts.refreshToken),
      opts.accessToken ?? '',
      opts.expiresInSec ? Date.now() + opts.expiresInSec * 1000 : 0,
      opts.scopes ?? '',
      JSON.stringify(opts.meta ?? {})
    );
}

export function deleteLink(userId: number, provider: Provider): void {
  getDb().prepare('DELETE FROM linked_accounts WHERE user_id = ? AND provider = ?').run(userId, provider);
}

export function getMeta(link: LinkedAccount): Record<string, unknown> {
  try {
    return JSON.parse(link.meta_json);
  } catch {
    return {};
  }
}

export function patchMeta(userId: number, provider: Provider, patch: Record<string, unknown>): void {
  const link = getLink(userId, provider);
  if (!link) return;
  getDb()
    .prepare('UPDATE linked_accounts SET meta_json = ? WHERE user_id = ? AND provider = ?')
    .run(JSON.stringify({ ...getMeta(link), ...patch }), userId, provider);
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

// Zoho's token host follows the data centre the user signed in at, so its URL
// is read off the link's meta rather than being a constant like the others.
const TOKEN_ENDPOINTS: Record<
  'google' | 'microsoft' | 'zoho',
  { url: (link: LinkedAccount) => string; id: SecretKey; secret: SecretKey }
> = {
  google: {
    url: () => 'https://oauth2.googleapis.com/token',
    id: 'GOOGLE_CLIENT_ID',
    secret: 'GOOGLE_CLIENT_SECRET',
  },
  microsoft: {
    url: () => 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    id: 'MS_CLIENT_ID',
    secret: 'MS_CLIENT_SECRET',
  },
  zoho: {
    url: (link) => `${String(getMeta(link).accounts_base ?? 'https://accounts.zoho.com')}/oauth/v2/token`,
    id: 'ZOHO_CLIENT_ID',
    secret: 'ZOHO_CLIENT_SECRET',
  },
};

/**
 * A live access token for API calls, refreshed lazily. Notion tokens never
 * expire — the sealed token IS the access token. Microsoft rotates refresh
 * tokens: when the response carries a new one it MUST be stored or the link
 * dies in ~90 days. A 'mailbox' or 'icloud' link has no token at all
 * (mailbox.ts / icloud.ts open the sealed password themselves).
 */
export async function liveToken(userId: number, provider: Provider): Promise<string> {
  const link = getLink(userId, provider);
  if (!link) throw new ReconnectError(provider);

  if (provider === 'notion') return openToken(link.refresh_token_enc);
  if (provider === 'mailbox' || provider === 'icloud') throw new Error(`a ${provider} link carries a password, not a token`);
  if (link.access_token && Date.now() < link.access_expires_at - REFRESH_MARGIN_MS) return link.access_token;

  const ep = TOKEN_ENDPOINTS[provider];
  let refreshToken: string;
  try {
    refreshToken = openToken(link.refresh_token_enc);
  } catch {
    throw new ReconnectError(provider);
  }

  const res = await fetch(ep.url(link), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: secret(ep.id),
      client_secret: secret(ep.secret),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 400 || res.status === 401) {
      console.error(`[oauth] ${provider} refresh rejected for user ${userId}: ${text.slice(0, 200)}`);
      throw new ReconnectError(provider);
    }
    throw new Error(`${provider} token refresh failed: ${res.status}`);
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number; refresh_token?: string; error?: string };
  // Zoho answers a dead refresh token with HTTP 200 and {error}. Without this
  // the row would be updated with `undefined` and every later call 401s.
  if (!data.access_token) {
    console.error(`[oauth] ${provider} refresh returned no token for user ${userId}: ${data.error ?? 'unknown'}`);
    throw new ReconnectError(provider);
  }

  getDb()
    .prepare(
      'UPDATE linked_accounts SET access_token = ?, access_expires_at = ?, refresh_token_enc = ? WHERE user_id = ? AND provider = ?'
    )
    .run(
      data.access_token,
      Date.now() + (data.expires_in ?? 3600) * 1000,
      data.refresh_token ? sealToken(data.refresh_token) : link.refresh_token_enc,
      userId,
      provider
    );
  return data.access_token;
}

/** Wrap a ward-route handler body: ReconnectError → 409, not linked → 404. */
export function reconnectResponse(err: unknown): Response | null {
  if (err instanceof ReconnectError)
    return Response.json({ error: 'reconnect', provider: err.provider }, { status: 409 });
  return null;
}
