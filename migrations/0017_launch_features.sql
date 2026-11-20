-- Launch features: privacy zone, Sign in with Apple, moderation (admin panel) and product analytics.
-- The Worker applies all of this at runtime (WorkerStorage.applySchemaUpgrades); this file documents it.

ALTER TABLE users ADD COLUMN privacy_zone_m INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN apple_sub TEXT;
ALTER TABLE users ADD COLUMN apple_refresh_token TEXT;
ALTER TABLE users ADD COLUMN banned_at TEXT;
ALTER TABLE users ADD COLUMN ban_reason TEXT;
ALTER TABLE users ADD COLUMN welcome_reward_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_apple_sub ON users(apple_sub);

ALTER TABLE reports ADD COLUMN status TEXT NOT NULL DEFAULT 'open';
ALTER TABLE reports ADD COLUMN resolved_at TEXT;
ALTER TABLE reports ADD COLUMN action TEXT;
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at);

CREATE TABLE IF NOT EXISTS route_private_ends (
  route_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  head TEXT NOT NULL,
  tail TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_route_private_ends_user ON route_private_ends(user_id);

CREATE TABLE IF NOT EXISTS app_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  install_id TEXT,
  name TEXT NOT NULL,
  props TEXT,
  app_version TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_app_events_name_created ON app_events(name, created_at);
CREATE INDEX IF NOT EXISTS idx_app_events_user ON app_events(user_id);
