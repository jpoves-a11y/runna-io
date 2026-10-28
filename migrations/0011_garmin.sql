-- Garmin integration (Garmin Connect Developer Program, Activity API): connected accounts and imported activities.
-- The Worker also creates these tables at runtime (WorkerStorage.ensureGarminTables), so applying this by hand is optional.
CREATE TABLE IF NOT EXISTS garmin_accounts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  garmin_user_id TEXT NOT NULL UNIQUE,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at TEXT,
  permissions TEXT,
  connected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_sync_at TEXT,
  last_webhook_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS garmin_activities (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  summary_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route_id TEXT REFERENCES routes(id) ON DELETE SET NULL,
  garmin_activity_id TEXT,
  name TEXT NOT NULL,
  activity_type TEXT NOT NULL,
  device_name TEXT,
  distance REAL NOT NULL,
  duration INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  summary_polyline TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  processed INTEGER NOT NULL DEFAULT 0,
  processed_at TEXT,
  skip_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_garmin_activities_user_start ON garmin_activities(user_id, start_date);
CREATE INDEX IF NOT EXISTS idx_garmin_activities_route ON garmin_activities(route_id);
