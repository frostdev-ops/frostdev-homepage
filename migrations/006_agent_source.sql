-- Where a turn came from, so the tile can render automation output as
-- automation output (a ⚡ turn must not read like something the user typed)
-- and so it still does after a reload. 'chat' keeps every existing row honest.
ALTER TABLE agent_messages ADD COLUMN source TEXT NOT NULL DEFAULT 'chat';
