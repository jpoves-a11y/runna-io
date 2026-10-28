-- COROS integration (COROS Partner API): connected accounts and imported workouts.
-- The Worker also creates these tables at runtime (WorkerStorage.ensureCorosTables), so applying this by hand is optional.
-- Replaces migrations/coros_integration.sql: on a database that already has those tables, run only the ALTER statements.
CREATE TABLE IF NOT EXISTS coros_accounts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  coros_open_id TEXT NOT NULL UNIQUE,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at TEXT,
  last_sync_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  connected_at TEXT,
  last_webhook_at TEXT
);

CREATE TABLE IF NOT EXISTS coros_activities (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  coros_workout_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route_id TEXT REFERENCES routes(id) ON DELETE SET NULL,
  territory_id TEXT REFERENCES territories(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  activity_type TEXT NOT NULL,
  distance REAL NOT NULL,
  duration INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  summary_polyline TEXT,
  processed INTEGER NOT NULL DEFAULT 0,
  processed_at TEXT,
  skip_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'pending',
  coros_mode INTEGER,
  coros_sub_mode INTEGER,
  device_name TEXT,
  fit_url TEXT
);

-- Databases with the first version of the tables (migrations/coros_integration.sql):
-- ALTER TABLE coros_accounts ADD COLUMN connected_at TEXT;
-- ALTER TABLE coros_accounts ADD COLUMN last_webhook_at TEXT;
-- ALTER TABLE coros_activities ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
-- ALTER TABLE coros_activities ADD COLUMN coros_mode INTEGER;
-- ALTER TABLE coros_activities ADD COLUMN coros_sub_mode INTEGER;
-- ALTER TABLE coros_activities ADD COLUMN device_name TEXT;
-- ALTER TABLE coros_activities ADD COLUMN fit_url TEXT;

CREATE INDEX IF NOT EXISTS idx_coros_activities_user_start ON coros_activities(user_id, start_date);
CREATE INDEX IF NOT EXISTS idx_coros_activities_route ON coros_activities(route_id);
