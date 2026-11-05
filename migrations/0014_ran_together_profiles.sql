-- "Ran together" independent of upload order, delayed territory-loss pushes and activity profiles.
-- The Worker also applies these on demand (WorkerStorage.ensureSchemaUpgrades).

-- Shape of each steal, so it can be undone if the victim turns out to have run with the attacker
ALTER TABLE conquest_metrics ADD COLUMN stolen_geometry TEXT;
CREATE INDEX IF NOT EXISTS idx_conquest_metrics_route_defender ON conquest_metrics(route_id, defender_id);

-- Per route: seconds since started_at of each GPS point (iOS app, for "ran together") and the
-- activity profile (distance, time and altitude of each point: charts of the activity screen)
CREATE TABLE IF NOT EXISTS route_streams (
  route_id TEXT PRIMARY KEY REFERENCES routes(id) ON DELETE CASCADE,
  times TEXT,
  profile TEXT,
  profile_checked_at TEXT
);

-- Profile captured when an activity is imported, before its route exists (Garmin, Suunto)
CREATE TABLE IF NOT EXISTS source_profiles (
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  profile TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source, source_id)
);

-- "Te han robado" pushes waiting to be sent by the cron (dropped if the steal is undone)
CREATE TABLE IF NOT EXISTS pending_steal_notifications (
  id TEXT PRIMARY KEY,
  victim_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attacker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route_id TEXT REFERENCES routes(id) ON DELETE CASCADE,
  stolen_area REAL NOT NULL,
  route_completed_at TEXT,
  due_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_steal_due ON pending_steal_notifications(due_at);
CREATE INDEX IF NOT EXISTS idx_pending_steal_route_victim ON pending_steal_notifications(route_id, victim_id);

-- Runs being recorded in the app (pushes to their runner wait until the run is uploaded)
CREATE TABLE IF NOT EXISTS active_runs (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
