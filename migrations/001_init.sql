CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,                -- stored lowercased
  password_hash TEXT,                        -- NULL = SSO-only user
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  display_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                       -- 32-byte base64url
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE settings (                      -- KV: secret:*, oauth_pending:*, mail_draft:*, config
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE linked_accounts (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google','microsoft','notion')),
  account_label TEXT NOT NULL DEFAULT '',    -- mailbox address / workspace name shown in UI
  refresh_token_enc TEXT NOT NULL,           -- AES-256-GCM sealed; Notion's non-expiring token lives here
  access_token TEXT NOT NULL DEFAULT '',     -- short-lived, refreshed lazily
  access_expires_at INTEGER NOT NULL DEFAULT 0,  -- unix ms; 0 = never (notion)
  scopes TEXT NOT NULL DEFAULT '',           -- what was actually granted
  meta_json TEXT NOT NULL DEFAULT '{}',      -- notion: {tasks_db_id, capture_page_id, workspace_id}; ms: {home_account_id}
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, provider)
);

CREATE TABLE status_history (
  service TEXT NOT NULL,
  ok INTEGER,                                -- 1 up / 0 down / NULL probe failed
  latency_ms INTEGER,
  detail TEXT NOT NULL DEFAULT '',
  checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_status_history ON status_history(service, checked_at);
