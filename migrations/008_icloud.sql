-- 'icloud': iCloud Calendar over CalDAV. Apple has no OAuth that grants
-- calendar data, so — like 'mailbox' — the row carries an app-specific
-- password sealed in refresh_token_enc and the discovered calendar home in
-- meta_json. The provider list is a CHECK constraint, so widening it means
-- rebuilding the table (same dance as 007).
CREATE TABLE linked_accounts_new (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google','microsoft','notion','zoho','mailbox','icloud')),
  account_label TEXT NOT NULL DEFAULT '',
  refresh_token_enc TEXT NOT NULL,
  access_token TEXT NOT NULL DEFAULT '',
  access_expires_at INTEGER NOT NULL DEFAULT 0,
  scopes TEXT NOT NULL DEFAULT '',
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, provider)
);

INSERT INTO linked_accounts_new
  (user_id, provider, account_label, refresh_token_enc, access_token, access_expires_at, scopes, meta_json, created_at)
SELECT user_id, provider, account_label, refresh_token_enc, access_token, access_expires_at, scopes, meta_json, created_at
FROM linked_accounts;

DROP TABLE linked_accounts;
ALTER TABLE linked_accounts_new RENAME TO linked_accounts;
