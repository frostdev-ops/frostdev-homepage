-- The communication wards' message store (lib/comms/store.ts): every inbound
-- message a Discord/Slack/Telegram/… ward saw and every message it sent, one
-- row per (user, ward, provider message id). The PRIMARY KEY is the replay
-- guard — a gateway resume, a poll overlap or a redelivered update inserts
-- nothing twice, and only rows that DID insert fire logic. Kept to the last
-- 500 per ward by the writer; the credential never lives here (settings,
-- sealed, comms_token:<uid>:<ward>).
CREATE TABLE comms_messages (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ward TEXT NOT NULL,
  id TEXT NOT NULL,
  channel TEXT NOT NULL,
  channel_name TEXT NOT NULL DEFAULT '',
  from_id TEXT NOT NULL DEFAULT '',
  from_name TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL,
  attachments TEXT NOT NULL DEFAULT '[]',
  thread_id TEXT,
  reply_to TEXT,
  mine INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, ward, id)
);
CREATE INDEX comms_messages_channel ON comms_messages (user_id, ward, channel, at);
CREATE INDEX comms_messages_at ON comms_messages (user_id, ward, at);
