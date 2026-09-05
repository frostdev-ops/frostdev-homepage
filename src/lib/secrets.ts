import { getDb } from './db.ts';

// OAuth client credentials come from the environment (.env.example lists the
// pairs). A `secret:<KEY>` settings row still wins when one exists — nothing
// writes those any more; the admin UI that once did was never built.

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
