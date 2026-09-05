-- The notepad tile's document: rich text (an HTML allowlist, lib/note.ts) and
-- the ink layer (stroke JSON) per (user, tile). The layout only carries the
-- tile's knobs. A tile leaving the layout keeps its row on purpose — Remove +
-- Undo must not lose a document, and an orphan row is a few kilobytes.
CREATE TABLE notes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tile TEXT NOT NULL,
  html TEXT NOT NULL DEFAULT '',
  ink TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, tile)
);
