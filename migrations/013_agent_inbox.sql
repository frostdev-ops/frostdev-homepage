-- The agent-to-agent message queue (src/lib/agent/inbox.ts). One row per
-- message; its status IS the delivery receipt: queued → delivered (a turn on
-- the target ward took it, or a running turn absorbed it as a steer) → done
-- (result = the reply) | failed. The sender polls it with check_message; a
-- waiting sender is resolved in memory and re-reads the row after a restart.
CREATE TABLE agent_inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ward TEXT NOT NULL,                        -- addressed to this agent ward
  sender TEXT NOT NULL,                      -- the agent ward it is from
  mode TEXT NOT NULL DEFAULT 'queue' CHECK (mode IN ('queue', 'steer', 'interrupt')),
  text TEXT NOT NULL,
  reply_to INTEGER REFERENCES agent_inbox(id), -- set on the answer to an unwaited ask
  wait INTEGER NOT NULL DEFAULT 0,           -- the sender is blocking on the reply
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'delivered', 'done', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  result TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT,
  finished_at TEXT
);
CREATE INDEX idx_agent_inbox_queued ON agent_inbox(user_id, ward, id) WHERE status = 'queued';
CREATE INDEX idx_agent_inbox_ward ON agent_inbox(user_id, ward, id);
