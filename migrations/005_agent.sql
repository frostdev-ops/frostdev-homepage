-- The agent widget (src/lib/agent/*): per-user AI provider credentials,
-- per-tile conversations pinned to a provider (raw wire items replay verbatim
-- — codex reasoning items must ride along), chat transcript for the UI,
-- attachments, and scheduled wakes.

-- Per-user provider credentials. token_enc is AES-256-GCM sealed (crypto.ts):
-- codex = refresh token; openrouter/brave/exa = the API key itself.
CREATE TABLE agent_accounts (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('codex', 'openrouter', 'brave', 'exa')),
  label TEXT NOT NULL DEFAULT '',            -- account email / masked key, shown in UI
  token_enc TEXT NOT NULL,
  access_token TEXT NOT NULL DEFAULT '',     -- codex only: short-lived, refreshed lazily
  meta_json TEXT NOT NULL DEFAULT '{}',      -- codex: {account_id, id_token}
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, provider)
);

-- One active conversation per (user, tile); "Clear" retires (active = 0), never
-- deletes. provider is pinned at creation — a tile whose config later names a
-- different provider retires the thread and starts fresh (agent/conversations.ts).
CREATE TABLE agent_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tile TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('codex', 'openrouter')),
  active INTEGER NOT NULL DEFAULT 1,
  pending_confirm_id TEXT,                   -- id of the agent_confirm:* settings row
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_agent_conv_active ON agent_conversations(user_id, tile) WHERE active = 1;

-- What the tile renders (steps_json = AssistantStep[] for step cards on reload).
CREATE TABLE agent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  text TEXT NOT NULL DEFAULT '',
  steps_json TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_agent_msg_conv ON agent_messages(conversation_id, id);

-- The raw provider conversation, replayed verbatim (chars = json length, for
-- the context budget walk in loadItems).
CREATE TABLE agent_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  json TEXT NOT NULL,
  chars INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_agent_items_conv ON agent_items(conversation_id, id);

-- Content-addressed attachments (bytes at data/attachments/<sha256>); text is
-- the page-delimited extraction ('--- page N ---').
CREATE TABLE agent_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER REFERENCES agent_conversations(id) ON DELETE SET NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  pages INTEGER,
  text TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_agent_files_conv ON agent_files(conversation_id, id);
CREATE INDEX idx_agent_files_sha ON agent_files(sha256);

-- Scheduled wakes ("in 20 minutes, check X"). run_at is unix ms; the logic
-- engine's minute tick claims due rows atomically (agent/wakes.ts).
CREATE TABLE agent_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tile TEXT NOT NULL,
  conversation_id INTEGER REFERENCES agent_conversations(id),
  instructions TEXT NOT NULL,
  run_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'running', 'done', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  result TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX idx_agent_tasks_due ON agent_tasks(run_at) WHERE status = 'scheduled';
