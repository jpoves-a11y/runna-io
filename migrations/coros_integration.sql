-- COROS Integration Tables
-- Created: March 3, 2026
-- Purpose: Support COROS watch workout synchronization

-- COROS accounts table (links Runna user to COROS account)
CREATE TABLE IF NOT EXISTS coros_accounts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  coros_open_id TEXT NOT NULL UNIQUE,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at TEXT,
  last_sync_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- COROS activities table (stores synced workouts)
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
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_coros_accounts_user_id ON coros_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_coros_accounts_open_id ON coros_accounts(coros_open_id);
CREATE INDEX IF NOT EXISTS idx_coros_activities_user_id ON coros_activities(user_id);
CREATE INDEX IF NOT EXISTS idx_coros_activities_workout_id ON coros_activities(coros_workout_id);
CREATE INDEX IF NOT EXISTS idx_coros_activities_processed ON coros_activities(processed);
