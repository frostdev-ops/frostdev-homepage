-- Logic system: per-user automation graph (LogicGraph, src/lib/logic.ts —
-- validated on write AND read, bad row falls back to an empty graph),
-- server-authoritative timer state, traveling flow packets, and the last
-- run per edge for editor surfacing.

CREATE TABLE logic_graphs (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  graph_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per timer widget instance. ends_at (unix ms) set iff running;
-- remaining_ms set iff paused.
CREATE TABLE timers (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tile TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'idle' CHECK (state IN ('idle', 'running', 'paused')),
  ends_at INTEGER,
  remaining_ms INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, tile)
);

-- history_json: [{at, tile, event, note?}], capped at 50 entries in code.
CREATE TABLE packets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tile TEXT NOT NULL,
  channel TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'done')),
  history_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_packets_user_tile ON packets(user_id, tile, status);

CREATE TABLE logic_runs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  edge_id TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('ok', 'skipped', 'error')),
  detail TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, edge_id)
);
