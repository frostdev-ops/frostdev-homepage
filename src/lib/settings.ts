import { getDb } from './db.ts';

export function getSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    )
    .run(key, value);
}

export function deleteSetting(key: string): void {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(key);
}

/** Expire a family of short-lived rows (oauth states, mail drafts) by their own
 *  updated_at. Anything with a TTL needs this: a flow that is abandoned rather
 *  than finished never comes back to clean up after itself. */
export function sweepSettings(prefix: string, ttlMs: number): void {
  getDb()
    .prepare(`DELETE FROM settings WHERE key LIKE ? AND updated_at <= datetime('now', ?)`)
    .run(`${prefix}%`, `-${Math.round(ttlMs / 1000)} seconds`);
}

/** Delete-and-return in one statement: the delete IS the one-shot check. */
export function takeSetting(key: string): string | null {
  const row = getDb().prepare('DELETE FROM settings WHERE key = ? RETURNING value').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}
