-- Zoho Mail (OAuth, like Google/Microsoft) and 'mailbox' (a generic IMAP/POP3
-- server with SMTP send: the sealed password lives in refresh_token_enc, the
-- hosts in meta_json, and scopes holds 'imap' or 'pop3'). The provider list is
-- a CHECK constraint, so widening it means rebuilding the table.
CREATE TABLE linked_accounts_new (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google','microsoft','notion','zoho','mailbox')),
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
