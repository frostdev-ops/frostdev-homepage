import { getDb } from '../db.ts';
import { sealToken, openToken } from '../crypto.ts';

// Per-user agent credentials. Deliberately NOT linked_accounts: that table's
// provider CHECK and Provider union feed the ward Connect-chip machinery,
// and codex refresh is custom anyway. Sealed at rest like everything long-lived.

export type AgentAccountProvider = 'codex' | 'openrouter' | 'brave' | 'exa';

export interface AgentAccount {
  user_id: number;
  provider: AgentAccountProvider;
  label: string;
  token_enc: string;
  access_token: string;
  meta_json: string;
}

export function getAgentAccount(userId: number, provider: AgentAccountProvider): AgentAccount | null {
  return (
    (getDb()
      .prepare('SELECT * FROM agent_accounts WHERE user_id = ? AND provider = ?')
      .get(userId, provider) as AgentAccount | undefined) ?? null
  );
}

export function storeAgentAccount(opts: {
  userId: number;
  provider: AgentAccountProvider;
  token: string;
  label?: string;
  accessToken?: string;
  meta?: Record<string, unknown>;
}): void {
  getDb()
    .prepare(
      `INSERT INTO agent_accounts (user_id, provider, label, token_enc, access_token, meta_json)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, provider) DO UPDATE SET
         label = excluded.label,
         token_enc = excluded.token_enc,
         access_token = excluded.access_token,
         meta_json = excluded.meta_json`
    )
    .run(
      opts.userId,
      opts.provider,
      opts.label ?? '',
      sealToken(opts.token),
      opts.accessToken ?? '',
      JSON.stringify(opts.meta ?? {})
    );
}

export function deleteAgentAccount(userId: number, provider: AgentAccountProvider): void {
  getDb().prepare('DELETE FROM agent_accounts WHERE user_id = ? AND provider = ?').run(userId, provider);
}

/** For key-style providers the sealed token IS the credential. */
export function agentKey(userId: number, provider: 'openrouter' | 'brave' | 'exa'): string | null {
  const row = getAgentAccount(userId, provider);
  if (!row) return null;
  try {
    return openToken(row.token_enc);
  } catch {
    return null;
  }
}

export function accountMeta(row: AgentAccount): Record<string, unknown> {
  try {
    return JSON.parse(row.meta_json);
  } catch {
    return {};
  }
}
