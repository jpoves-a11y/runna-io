-- Global mode, clubs and seasons (shared/game.ts, worker/src/gameStorage.ts).
-- The Worker applies all of this at runtime (applyGameSchema, once per isolate), so running it by hand
-- is optional. ALTER TABLE fails if a column already exists: run the statements one by one.
--
-- NOTE: the first time the new Worker's cron runs it does a ONE-TIME reset of the old game
-- (worker/src/season.ts ensureSeasonReset): every run, territory, feed event, power and chest is
-- deleted; users, friends, clubs and connected integrations are kept. Runs that started before the
-- reset are never imported again.

-- users: global mode, home city, title, streak
ALTER TABLE users ADD COLUMN global_area REAL NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN global_bonus_area REAL NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN country_code TEXT;
ALTER TABLE users ADD COLUMN country_name TEXT;
ALTER TABLE users ADD COLUMN city TEXT;
ALTER TABLE users ADD COLUMN home_lat REAL;
ALTER TABLE users ADD COLUMN home_lng REAL;
ALTER TABLE users ADD COLUMN location_updated_at TEXT;
ALTER TABLE users ADD COLUMN title TEXT;
ALTER TABLE users ADD COLUMN streak_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN streak_last_date TEXT;

-- routes: anti-cheat input and result
ALTER TABLE routes ADD COLUMN track_meta TEXT;
ALTER TABLE routes ADD COLUMN validation_status TEXT;
ALTER TABLE routes ADD COLUMN validation_reasons TEXT;
ALTER TABLE routes ADD COLUMN global_area_gained REAL;

-- chests and inventory (existing competition tables)
ALTER TABLE treasures ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
ALTER TABLE treasures ADD COLUMN city_key TEXT;
ALTER TABLE user_powers ADD COLUMN scope TEXT;
ALTER TABLE user_powers ADD COLUMN source TEXT;
ALTER TABLE user_powers ADD COLUMN unused_expires_at TEXT;

CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS global_territories (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  geometry TEXT NOT NULL,
  area REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS global_area_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route_id TEXT,
  area REAL NOT NULL DEFAULT 0,
  bonus REAL NOT NULL DEFAULT 0,
  period TEXT NOT NULL,
  run_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_global_events_user ON global_area_events(user_id, run_at);
CREATE INDEX IF NOT EXISTS idx_global_events_period ON global_area_events(period, user_id);
CREATE INDEX IF NOT EXISTS idx_global_events_route ON global_area_events(route_id);

CREATE TABLE IF NOT EXISTS clubs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  slogan TEXT,
  crest TEXT NOT NULL,
  color TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'public',
  join_code TEXT NOT NULL UNIQUE,
  city TEXT,
  country_code TEXT,
  country_name TEXT,
  center_lat REAL,
  center_lng REAL,
  owner_id TEXT NOT NULL,
  rating REAL NOT NULL DEFAULT 1000,
  league_points INTEGER NOT NULL DEFAULT 0,
  member_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_clubs_city ON clubs(country_code, city);

CREATE TABLE IF NOT EXISTS club_members (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_club_members_club ON club_members(club_id);

CREATE TABLE IF NOT EXISTS club_requests (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  invited_by TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_club_requests_club ON club_requests(club_id, status);
CREATE INDEX IF NOT EXISTS idx_club_requests_user ON club_requests(user_id, status);

CREATE TABLE IF NOT EXISTS club_invite_links (
  token TEXT PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS season_cycles (
  number INTEGER PRIMARY KEY,
  status TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  rest_started_at TEXT
);

CREATE TABLE IF NOT EXISTS club_competitions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  cycle_number INTEGER NOT NULL,
  club_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  config TEXT,
  opponent_club_id TEXT,
  match_id TEXT,
  score REAL NOT NULL DEFAULT 0,
  result TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_club_competitions_cycle_club ON club_competitions(cycle_number, club_id);

CREATE TABLE IF NOT EXISTS competition_participants (
  competition_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team INTEGER,
  area REAL NOT NULL DEFAULT 0,
  bonus REAL NOT NULL DEFAULT 0,
  area_stolen REAL NOT NULL DEFAULT 0,
  runs INTEGER NOT NULL DEFAULT 0,
  distance REAL NOT NULL DEFAULT 0,
  final_rank INTEGER,
  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (competition_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_competition_participants_user ON competition_participants(user_id);

CREATE TABLE IF NOT EXISTS club_matches (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  cycle_number INTEGER NOT NULL,
  club_a TEXT NOT NULL,
  club_b TEXT NOT NULL,
  runners_counted INTEGER NOT NULL,
  score_a REAL NOT NULL DEFAULT 0,
  score_b REAL NOT NULL DEFAULT 0,
  winner_club_id TEXT,
  rating_change REAL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_club_matches_clubs ON club_matches(club_a, club_b);

CREATE TABLE IF NOT EXISTS user_challenges (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cycle_number INTEGER NOT NULL,
  type TEXT NOT NULL,
  target REAL NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  reward_rarity TEXT NOT NULL,
  reward_item TEXT,
  data TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_challenges_unique ON user_challenges(user_id, cycle_number, type);

CREATE INDEX IF NOT EXISTS idx_users_global_area ON users(global_area);
CREATE INDEX IF NOT EXISTS idx_users_city ON users(country_code, city);
CREATE INDEX IF NOT EXISTS idx_routes_validation ON routes(validation_status);
