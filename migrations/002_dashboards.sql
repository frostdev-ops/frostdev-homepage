-- Per-user dashboard layout: one JSON blob per user (array of WidgetInstance,
-- see src/lib/widgets.ts). Validated on read AND write; a bad row falls back
-- to DEFAULT_LAYOUT rather than breaking the page.
CREATE TABLE dashboards (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  layout_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
