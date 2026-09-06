-- Short-lived sign-in grants and device-owned server sessions; never workspace content.
CREATE TABLE device_authorizations (
  device_hash TEXT PRIMARY KEY, user_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL, platform TEXT NOT NULL, protocol INTEGER NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending', expires_at INTEGER NOT NULL,
  last_poll INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE device_sessions (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE
);
