-- Tiles are wards now (the rename that gave Rimeward its name back). The five
-- tables keyed by a ward instance id follow the code; the stored JSON keys
-- (logic edges, packet history) are rewritten at boot by migrate-wards.ts.
ALTER TABLE timers RENAME COLUMN tile TO ward;
ALTER TABLE packets RENAME COLUMN tile TO ward;
ALTER TABLE agent_conversations RENAME COLUMN tile TO ward;
ALTER TABLE agent_tasks RENAME COLUMN tile TO ward;
ALTER TABLE notes RENAME COLUMN tile TO ward;
