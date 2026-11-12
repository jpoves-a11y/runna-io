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

-- Eliminación: the cut a participant fell in
ALTER TABLE competition_participants ADD COLUMN eliminated_cut INTEGER;
ALTER TABLE competition_participants ADD COLUMN eliminated_at TEXT;

-- Banderas: flags of a competition and their captures (holdings are rebuilt from them)
CREATE TABLE IF NOT EXISTS competition_flags (
  id TEXT PRIMARY KEY,
  competition_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  name TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_competition_flags_competition ON competition_flags(competition_id);
CREATE TABLE IF NOT EXISTS flag_captures (
  id TEXT PRIMARY KEY,
  flag_id TEXT NOT NULL,
  competition_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_flag_captures_route ON flag_captures(flag_id, route_id);
CREATE INDEX IF NOT EXISTS idx_flag_captures_competition ON flag_captures(competition_id, captured_at);

-- Mapa del Tesoro: everybody sees a chest from this time; its holders, from when it appears
ALTER TABLE treasures ADD COLUMN public_at TEXT;

-- Awards won when a competition closes (shown on the profile)
CREATE TABLE IF NOT EXISTS user_awards (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  competition_id TEXT NOT NULL,
  award TEXT NOT NULL,
  cycle_number INTEGER NOT NULL,
  mode TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, competition_id, award)
);
CREATE INDEX IF NOT EXISTS idx_user_awards_user ON user_awards(user_id, created_at);

-- Members who didn't take part see their club's result once: the last cycle they saw
ALTER TABLE club_members ADD COLUMN result_seen_cycle INTEGER;

-- Club chat: messages (system ones have no user), reactions, mutes and the last read time
CREATE TABLE IF NOT EXISTS club_messages (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL,
  user_id TEXT,
  kind TEXT NOT NULL DEFAULT 'user',
  body TEXT NOT NULL,
  reply_to TEXT,
  mentions TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_club_messages_club ON club_messages(club_id, created_at);
CREATE TABLE IF NOT EXISTS club_message_reactions (
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE TABLE IF NOT EXISTS club_mutes (
  club_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  until TEXT NOT NULL,
  muted_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (club_id, user_id)
);
ALTER TABLE club_members ADD COLUMN last_read_at TEXT;
