-- Shared Rime data only. Project roots, buffers, PTYs, credentials, and pending
-- actions are deliberately not part of this journal.
CREATE TABLE agent_sync_records (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE TABLE agent_sync_baselines (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile TEXT NOT NULL,
  key TEXT NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (user_id, profile, key)
);
CREATE TABLE agent_sync_conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  payload TEXT NOT NULL,
  saved_at TEXT NOT NULL DEFAULT (datetime('now'))
);
