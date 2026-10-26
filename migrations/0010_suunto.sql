-- Suunto integration (Suunto Cloud API): connected accounts and imported workouts.
-- The Worker also creates these tables at runtime (WorkerStorage.ensureSuuntoTables), so applying this by hand is optional.
CREATE TABLE IF NOT EXISTS suunto_accounts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  suunto_username TEXT NOT NULL UNIQUE,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at TEXT,
  scope TEXT,
  connected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_sync_at TEXT,
  last_webhook_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS suunto_activities (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workout_key TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route_id TEXT REFERENCES routes(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  activity_type TEXT NOT NULL,
  suunto_activity_id INTEGER,
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

CREATE INDEX IF NOT EXISTS idx_suunto_activities_user_start ON suunto_activities(user_id, start_date);
CREATE INDEX IF NOT EXISTS idx_suunto_activities_route ON suunto_activities(route_id);
