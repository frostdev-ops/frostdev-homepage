import { getDb } from './db.ts';

// OAuth client credentials can be set in the admin UI (settings table, same
// 0600 SQLite file as everything else) — the matching env vars still work, but
// a value entered in the app wins.

export type SecretKey =
  | 'GOOGLE_CLIENT_ID'
  | 'GOOGLE_CLIENT_SECRET'
  | 'MS_CLIENT_ID'
  | 'MS_CLIENT_SECRET'
  | 'NOTION_CLIENT_ID'
  | 'NOTION_CLIENT_SECRET'
  | 'ZOHO_CLIENT_ID'
  | 'ZOHO_CLIENT_SECRET';

const row = (key: SecretKey): string =>
  (
    (getDb().prepare('SELECT value FROM settings WHERE key = ?').get(`secret:${key}`) as { value: string } | undefined)
      ?.value ?? ''
  ).trim();

export function secret(key: SecretKey): string {
  return row(key) || (process.env[key] ?? '').trim();
}

export function setSecret(key: SecretKey, value: string): void {
  const v = value.trim();
  const db = getDb();
  if (!v) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(`secret:${key}`);
    return;
  }
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(`secret:${key}`, v);
}

/** Where the value in force came from — drives the "set in .env" hint in the UI. */
export function secretSource(key: SecretKey): 'app' | 'env' | null {
  if (row(key)) return 'app';
  return (process.env[key] ?? '').trim() ? 'env' : null;
}

/** Never render a stored secret back into a page: show enough to recognise it. */
export function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}
