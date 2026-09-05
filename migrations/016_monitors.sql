-- The monitor registry (lib/monitors.ts): what the status engine probes. It
-- used to be a JSON file beside the code; now it is edited in the app.
CREATE TABLE IF NOT EXISTS monitor_groups (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS monitors (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  grp TEXT NOT NULL,
  kind TEXT NOT NULL,
  -- Per kind: {url, method?, expect?} · {host, port} · {name} · {container} · {unit}
  spec TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
