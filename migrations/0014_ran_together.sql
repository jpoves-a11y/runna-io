-- "Ran together" independent of upload order, and delayed territory-loss pushes.
-- The Worker also applies these on demand (WorkerStorage.ensureSchemaUpgrades).

-- Shape of each steal, so it can be undone if the victim turns out to have run with the attacker
ALTER TABLE conquest_metrics ADD COLUMN stolen_geometry TEXT;
CREATE INDEX IF NOT EXISTS idx_conquest_metrics_route_defender ON conquest_metrics(route_id, defender_id);

-- Seconds since started_at of each GPS point (runs recorded in the iOS app)
CREATE TABLE IF NOT EXISTS route_point_times (
  route_id TEXT PRIMARY KEY REFERENCES routes(id) ON DELETE CASCADE,
  times TEXT NOT NULL
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
