-- Season phase 2 (shared/game.ts, worker/src/gameStorage.ts): close on Monday 06:00, inactive members,
-- per-run competition records, new modes, powers, awards, club entry types and club chat.
-- The Worker applies all of this at runtime (applyGameSchema, once per isolate), so running it by hand
-- is optional. ALTER TABLE fails if a column already exists: run the statements one by one.

-- Participants: area other participants stole from them, and when they saw the end-of-competition summary
ALTER TABLE competition_participants ADD COLUMN area_lost REAL NOT NULL DEFAULT 0;
ALTER TABLE competition_participants ADD COLUMN result_seen_at TEXT;

-- Runs that counted in a competition (windows of Eliminación, awards, summaries)
CREATE TABLE IF NOT EXISTS competition_runs (
  competition_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  area_gained REAL NOT NULL DEFAULT 0,
  area_stolen REAL NOT NULL DEFAULT 0,
  distance REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (competition_id, route_id)
);
CREATE INDEX IF NOT EXISTS idx_competition_runs_user ON competition_runs(competition_id, user_id, started_at);

-- Clubs: entry type (open | approval | invite_only), who can invite (all | officers), description.
-- Older private clubs become invite-only; "visibility" keeps following the entry type for older apps.
ALTER TABLE clubs ADD COLUMN entry_mode TEXT NOT NULL DEFAULT 'open';
UPDATE clubs SET entry_mode = 'invite_only' WHERE visibility = 'private';
ALTER TABLE clubs ADD COLUMN invite_permission TEXT NOT NULL DEFAULT 'all';
ALTER TABLE clubs ADD COLUMN description TEXT;
