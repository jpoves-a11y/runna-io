// Data access for Global mode, clubs, seasons, inventory and challenges.
// Raw SQL through drizzle's `sql` template (values are always bound parameters).
import { sql } from 'drizzle-orm';
import type { Database } from './db';
import {
  ITEMS,
  INVENTORY_CAP,
  type Crest,
  type ClubRole,
  type ItemScope,
} from '../../shared/game';
import { cycleAt } from './cycles';
import { parseEntryMode, entryModeFromVisibility, visibilityOf, type EntryMode, type InvitePermission } from './clubRules';

type Row = Record<string, any>;

/** Key of the city a user belongs to for chests: "ES:zaragoza", or a ~10 km grid cell without a city. */
export function cityKeyOf(countryCode: string | null | undefined, city: string | null | undefined, lat: number, lng: number): string {
  const name = (city ?? '').trim().toLowerCase();
  if (name) return `${(countryCode ?? '').toUpperCase()}:${name}`;
  return `geo:${lat.toFixed(1)},${lng.toFixed(1)}`;
}

function newId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

function nowIso(): string {
  return new Date().toISOString();
}

// ─── Schema ──────────────────────────────────────────────────────────────────

/** Runs a schema statement that may already be applied. True when it ran (e.g. the column is new). */
async function tryRun(db: Database, statement: ReturnType<typeof sql>): Promise<boolean> {
  try {
    await db.run(statement);
    return true;
  } catch {
    /* column/table already exists, or table not created yet */
    return false;
  }
}

/**
 * Creates the tables/columns of the new game (mirrors shared/schema.ts and
 * migrations/0014_global_clubs_seasons.sql). Called from WorkerStorage.applySchemaUpgrades,
 * which runs once per isolate before any request.
 */
/** Runs that started before this instant belong to the old game and are never imported/counted. */
export const DEFAULT_RUNS_COUNT_FROM = Date.parse('2026-11-11T00:00:00Z');
let runsCountFrom = DEFAULT_RUNS_COUNT_FROM;
export function runsCountFromMs(): number {
  return runsCountFrom;
}
export function setRunsCountFrom(ms: number): void {
  if (Number.isFinite(ms)) runsCountFrom = ms;
}

let runsCountFromCheckedAt = 0;
/**
 * Re-reads the cutoff (app_settings.season_reset_at) at most once a minute, so isolates that were
 * already running when the reset happened pick it up instead of keeping the old value.
 */
export async function refreshRunsCountFrom(db: Database, maxAgeMs = 60_000, now = Date.now()): Promise<void> {
  if (now - runsCountFromCheckedAt < maxAgeMs) return;
  runsCountFromCheckedAt = now;
  try {
    const rows = await db.all<Row>(sql`SELECT value FROM app_settings WHERE key = 'season_reset_at'`);
    if (rows[0]?.value) setRunsCountFrom(Date.parse(rows[0].value));
  } catch {
    /* table not created yet: keep the current value */
  }
}
/** True for a run (start date) that belongs to the old game. */
export function isBeforeSeason(startedAt: string | number | Date | null | undefined): boolean {
  if (startedAt === null || startedAt === undefined) return false;
  const ms = startedAt instanceof Date ? startedAt.getTime() : typeof startedAt === 'number' ? startedAt : Date.parse(startedAt);
  return Number.isFinite(ms) && ms < runsCountFrom;
}

export async function applyGameSchema(db: Database): Promise<void> {
  // users
  await tryRun(db, sql`ALTER TABLE users ADD COLUMN global_area REAL NOT NULL DEFAULT 0`);
  await tryRun(db, sql`ALTER TABLE users ADD COLUMN global_bonus_area REAL NOT NULL DEFAULT 0`);
  await tryRun(db, sql`ALTER TABLE users ADD COLUMN country_code TEXT`);
  await tryRun(db, sql`ALTER TABLE users ADD COLUMN country_name TEXT`);
  await tryRun(db, sql`ALTER TABLE users ADD COLUMN city TEXT`);
  await tryRun(db, sql`ALTER TABLE users ADD COLUMN home_lat REAL`);
  await tryRun(db, sql`ALTER TABLE users ADD COLUMN home_lng REAL`);
  await tryRun(db, sql`ALTER TABLE users ADD COLUMN location_updated_at TEXT`);
  await tryRun(db, sql`ALTER TABLE users ADD COLUMN title TEXT`);
  await tryRun(db, sql`ALTER TABLE users ADD COLUMN streak_days INTEGER NOT NULL DEFAULT 0`);
  await tryRun(db, sql`ALTER TABLE users ADD COLUMN streak_last_date TEXT`);
  // routes
  await tryRun(db, sql`ALTER TABLE routes ADD COLUMN track_meta TEXT`);
  await tryRun(db, sql`ALTER TABLE routes ADD COLUMN validation_status TEXT`);
  await tryRun(db, sql`ALTER TABLE routes ADD COLUMN validation_reasons TEXT`);
  await tryRun(db, sql`ALTER TABLE routes ADD COLUMN global_area_gained REAL`);
  // competition tables (created lazily by WorkerStorage.ensureCompetitionTables)
  await applyCompetitionColumns(db);

  await db.run(sql`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await db.run(sql`CREATE TABLE IF NOT EXISTS global_territories (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    geometry TEXT NOT NULL,
    area REAL NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await db.run(sql`CREATE TABLE IF NOT EXISTS global_area_events (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    route_id TEXT,
    area REAL NOT NULL DEFAULT 0,
    bonus REAL NOT NULL DEFAULT 0,
    period TEXT NOT NULL,
    run_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS idx_global_events_user ON global_area_events(user_id, run_at)`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS idx_global_events_period ON global_area_events(period, user_id)`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS idx_global_events_route ON global_area_events(route_id)`);
  await db.run(sql`CREATE TABLE IF NOT EXISTS clubs (
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
  )`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS idx_clubs_city ON clubs(country_code, city)`);
  // Entry type, invite permission and description (clubRules.ts). Older clubs: private = invite only.
  if (await tryRun(db, sql`ALTER TABLE clubs ADD COLUMN entry_mode TEXT NOT NULL DEFAULT 'open'`)) {
    await tryRun(db, sql`UPDATE clubs SET entry_mode = 'invite_only' WHERE visibility = 'private'`);
  }
  await tryRun(db, sql`ALTER TABLE clubs ADD COLUMN invite_permission TEXT NOT NULL DEFAULT 'all'`);
  await tryRun(db, sql`ALTER TABLE clubs ADD COLUMN description TEXT`);
  await db.run(sql`CREATE TABLE IF NOT EXISTS club_members (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS idx_club_members_club ON club_members(club_id)`);
  await db.run(sql`CREATE TABLE IF NOT EXISTS club_requests (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    invited_by TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS idx_club_requests_club ON club_requests(club_id, status)`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS idx_club_requests_user ON club_requests(user_id, status)`);
  await db.run(sql`CREATE TABLE IF NOT EXISTS club_invite_links (
    token TEXT PRIMARY KEY,
    club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
    created_by TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await db.run(sql`CREATE TABLE IF NOT EXISTS season_cycles (
    number INTEGER PRIMARY KEY,
    status TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    rest_started_at TEXT
  )`);
  await db.run(sql`CREATE TABLE IF NOT EXISTS club_competitions (
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
  )`);
  await db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_club_competitions_cycle_club ON club_competitions(cycle_number, club_id)`);
  await db.run(sql`CREATE TABLE IF NOT EXISTS competition_participants (
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
  )`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS idx_competition_participants_user ON competition_participants(user_id)`);
  await tryRun(db, sql`ALTER TABLE competition_participants ADD COLUMN area_lost REAL NOT NULL DEFAULT 0`);
  await tryRun(db, sql`ALTER TABLE competition_participants ADD COLUMN result_seen_at TEXT`);
  // Eliminación: the cut a participant fell in (null while still in)
  await tryRun(db, sql`ALTER TABLE competition_participants ADD COLUMN eliminated_cut INTEGER`);
  await tryRun(db, sql`ALTER TABLE competition_participants ADD COLUMN eliminated_at TEXT`);
  // Banderas: the flags of a competition and every capture (holdings are rebuilt from them)
  await db.run(sql`CREATE TABLE IF NOT EXISTS competition_flags (
    id TEXT PRIMARY KEY,
    competition_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    name TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL
  )`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS idx_competition_flags_competition ON competition_flags(competition_id)`);
  await db.run(sql`CREATE TABLE IF NOT EXISTS flag_captures (
    id TEXT PRIMARY KEY,
    flag_id TEXT NOT NULL,
    competition_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    route_id TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_flag_captures_route ON flag_captures(flag_id, route_id)`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS idx_flag_captures_competition ON flag_captures(competition_id, captured_at)`);
  // One row per run that counted in a competition: windows of Eliminación, awards, summaries
  await db.run(sql`CREATE TABLE IF NOT EXISTS competition_runs (
    competition_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    route_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    area_gained REAL NOT NULL DEFAULT 0,
    area_stolen REAL NOT NULL DEFAULT 0,
    distance REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (competition_id, route_id)
  )`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS idx_competition_runs_user ON competition_runs(competition_id, user_id, started_at)`);
  await db.run(sql`CREATE TABLE IF NOT EXISTS club_matches (
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
  )`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS idx_club_matches_clubs ON club_matches(club_a, club_b)`);
  await db.run(sql`CREATE TABLE IF NOT EXISTS user_challenges (
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
  )`);
  await db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_challenges_unique ON user_challenges(user_id, cycle_number, type)`);
  await tryRun(db, sql`CREATE INDEX IF NOT EXISTS idx_users_global_area ON users(global_area)`);
  await tryRun(db, sql`CREATE INDEX IF NOT EXISTS idx_users_city ON users(country_code, city)`);
  await tryRun(db, sql`CREATE INDEX IF NOT EXISTS idx_routes_validation ON routes(validation_status)`);
  try {
    const rows = await db.all<Row>(sql`SELECT value FROM app_settings WHERE key = 'season_reset_at'`);
    if (rows[0]?.value) setRunsCountFrom(Date.parse(rows[0].value));
  } catch {
    /* keep the default */
  }
}

/** New columns of the competition tables (they may be created after applyGameSchema runs). */
export async function applyCompetitionColumns(db: Database): Promise<void> {
  await tryRun(db, sql`ALTER TABLE treasures ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0`);
  await tryRun(db, sql`ALTER TABLE treasures ADD COLUMN city_key TEXT`);
  await tryRun(db, sql`ALTER TABLE treasures ADD COLUMN zone TEXT`);
  await tryRun(db, sql`ALTER TABLE user_powers ADD COLUMN scope TEXT`);
  await tryRun(db, sql`ALTER TABLE user_powers ADD COLUMN source TEXT`);
  await tryRun(db, sql`ALTER TABLE user_powers ADD COLUMN unused_expires_at TEXT`);
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ClubRow {
  id: string;
  name: string;
  slogan: string | null;
  description: string | null;
  crest: Crest;
  color: string;
  visibility: 'public' | 'private';
  entryMode: EntryMode;
  invitePermission: InvitePermission;
  joinCode: string;
  city: string | null;
  countryCode: string | null;
  countryName: string | null;
  centerLat: number | null;
  centerLng: number | null;
  ownerId: string;
  rating: number;
  leaguePoints: number;
  memberCount: number;
  createdAt: string;
}

export interface ClubMemberRow {
  userId: string;
  clubId: string;
  role: ClubRole;
  joinedAt: string;
}

export interface CompetitionRow {
  id: string;
  cycleNumber: number;
  clubId: string;
  mode: string;
  status: 'active' | 'finished';
  config: any;
  opponentClubId: string | null;
  matchId: string | null;
  score: number;
  result: any;
  createdAt: string;
  finishedAt: string | null;
}

export interface ParticipantRow {
  competitionId: string;
  userId: string;
  team: number | null;
  area: number;
  bonus: number;
  areaStolen: number;
  runs: number;
  distance: number;
  finalRank: number | null;
  joinedAt: string;
  /** Competition area other participants stole from this one */
  areaLost: number;
  /** When the participant saw the end-of-competition summary */
  resultSeenAt: string | null;
  /** Eliminación: the cut they fell in (null while still in) */
  eliminatedCut: number | null;
  eliminatedAt: string | null;
}

export interface InventoryRow {
  id: string;
  userId: string;
  itemId: string;
  scope: ItemScope;
  status: 'available' | 'active' | 'used' | 'expired' | 'owned';
  source: string | null;
  sourceId: string;
  activatedAt: string | null;
  usedAt: string | null;
  activeUntil: string | null;
  unusedExpiresAt: string | null;
  metadata: any;
  createdAt: string;
}

export interface ChallengeRow {
  id: string;
  userId: string;
  cycleNumber: number;
  type: string;
  target: number;
  progress: number;
  status: 'active' | 'completed';
  rewardRarity: string;
  rewardItem: string | null;
  data: any;
  completedAt: string | null;
}

function parseJson(value: unknown, fallback: any = null): any {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function toClub(row: Row): ClubRow {
  return {
    id: row.id,
    name: row.name,
    slogan: row.slogan ?? null,
    description: row.description ?? null,
    crest: parseJson(row.crest, {}),
    color: row.color,
    visibility: row.visibility === 'private' ? 'private' : 'public',
    entryMode: parseEntryMode(row.entry_mode) ?? entryModeFromVisibility(row.visibility),
    invitePermission: row.invite_permission === 'officers' ? 'officers' : 'all',
    joinCode: row.join_code,
    city: row.city ?? null,
    countryCode: row.country_code ?? null,
    countryName: row.country_name ?? null,
    centerLat: row.center_lat ?? null,
    centerLng: row.center_lng ?? null,
    ownerId: row.owner_id,
    rating: Number(row.rating ?? 1000),
    leaguePoints: Number(row.league_points ?? 0),
    memberCount: Number(row.member_count ?? 0),
    createdAt: row.created_at,
  };
}

function toCompetition(row: Row): CompetitionRow {
  return {
    id: row.id,
    cycleNumber: Number(row.cycle_number),
    clubId: row.club_id,
    mode: row.mode,
    status: row.status,
    config: parseJson(row.config, {}),
    opponentClubId: row.opponent_club_id ?? null,
    matchId: row.match_id ?? null,
    score: Number(row.score ?? 0),
    result: parseJson(row.result, null),
    createdAt: row.created_at,
    finishedAt: row.finished_at ?? null,
  };
}

function toParticipant(row: Row): ParticipantRow {
  return {
    competitionId: row.competition_id,
    userId: row.user_id,
    team: row.team === null || row.team === undefined ? null : Number(row.team),
    area: Number(row.area ?? 0),
    bonus: Number(row.bonus ?? 0),
    areaStolen: Number(row.area_stolen ?? 0),
    runs: Number(row.runs ?? 0),
    distance: Number(row.distance ?? 0),
    finalRank: row.final_rank === null || row.final_rank === undefined ? null : Number(row.final_rank),
    joinedAt: row.joined_at,
    areaLost: Number(row.area_lost ?? 0),
    resultSeenAt: row.result_seen_at ?? null,
    eliminatedCut: row.eliminated_cut === null || row.eliminated_cut === undefined ? null : Number(row.eliminated_cut),
    eliminatedAt: row.eliminated_at ?? null,
  };
}

function toInventory(row: Row): InventoryRow {
  return {
    id: row.id,
    userId: row.user_id,
    itemId: row.power_type,
    scope: (row.scope || ITEMS[row.power_type]?.scope || 'competition') as ItemScope,
    status: row.status,
    source: row.source ?? null,
    sourceId: row.treasure_id,
    activatedAt: row.activated_at ?? null,
    usedAt: row.used_at ?? null,
    activeUntil: row.expires_at ?? null,
    unusedExpiresAt: row.unused_expires_at ?? null,
    metadata: parseJson(row.metadata, null),
    createdAt: row.created_at,
  };
}

function toChallenge(row: Row): ChallengeRow {
  return {
    id: row.id,
    userId: row.user_id,
    cycleNumber: Number(row.cycle_number),
    type: row.type,
    target: Number(row.target),
    progress: Number(row.progress ?? 0),
    status: row.status,
    rewardRarity: row.reward_rarity,
    rewardItem: row.reward_item ?? null,
    data: parseJson(row.data, {}),
    completedAt: row.completed_at ?? null,
  };
}

/** Public fields of a user (never email/password/home coordinates). */
export interface PublicUserLite {
  id: string;
  username: string;
  name: string;
  avatar: string | null;
  color: string;
  title: string | null;
}

function toUserLite(row: Row): PublicUserLite {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    avatar: row.avatar ?? null,
    color: row.color,
    title: row.title ?? null,
  };
}

/** Competition item ids stored in user_powers.competition_id for the new inventory. */
export const SEASON_INVENTORY = 'season';

export class GameStorage {
  constructor(private db: Database) {}

  get database(): Database {
    return this.db;
  }

  // ─── Settings ─────────────────────────────────────────────────────────────

  async getSetting(key: string): Promise<string | null> {
    const rows = await this.db.all<Row>(sql`SELECT value FROM app_settings WHERE key = ${key}`);
    return rows[0]?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.db.run(sql`INSERT INTO app_settings (key, value, updated_at) VALUES (${key}, ${value}, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`);
  }

  /** Sets the key only if it doesn't exist. Returns true when this call set it (a cheap lock). */
  async claimSetting(key: string, value: string): Promise<boolean> {
    await this.db.run(sql`INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (${key}, ${value}, CURRENT_TIMESTAMP)`);
    return (await this.getSetting(key)) === value;
  }

  async deleteSetting(key: string): Promise<void> {
    await this.db.run(sql`DELETE FROM app_settings WHERE key = ${key}`);
  }

  // ─── Users ────────────────────────────────────────────────────────────────

  async getUserLite(ids: string[]): Promise<Map<string, PublicUserLite>> {
    const map = new Map<string, PublicUserLite>();
    const unique = [...new Set(ids)].filter(Boolean);
    for (let i = 0; i < unique.length; i += 200) {
      const chunk = unique.slice(i, i + 200);
      const result = await this.db.all<Row>(sql.join([
        sql`SELECT id, username, name, avatar, color, title FROM users WHERE id IN (`,
        sql.join(chunk.map((id) => sql`${id}`), sql`, `),
        sql`)`,
      ], sql``));
      for (const row of result) map.set(row.id, toUserLite(row));
    }
    return map;
  }

  /** users.global_area of many users in one query. */
  async getGlobalAreas(userIds: string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (userIds.length === 0) return map;
    const rows = await this.db.all<Row>(sql.join([
      sql`SELECT id, global_area FROM users WHERE id IN (`,
      sql.join([...new Set(userIds)].map((id) => sql`${id}`), sql`, `),
      sql`)`,
    ], sql``));
    for (const r of rows) map.set(r.id, Number(r.global_area ?? 0));
    return map;
  }

  async getUserGameRow(userId: string): Promise<Row | null> {
    const rows = await this.db.all<Row>(sql`SELECT id, username, name, avatar, color, title, global_area, global_bonus_area,
      country_code, country_name, city, home_lat, home_lng, location_updated_at, streak_days, streak_last_date, total_area
      FROM users WHERE id = ${userId}`);
    return rows[0] ?? null;
  }

  async setUserLocation(userId: string, loc: { city: string; countryCode: string; countryName: string; lat: number | null; lng: number | null }): Promise<void> {
    await this.db.run(sql`UPDATE users SET city = ${loc.city}, country_code = ${loc.countryCode}, country_name = ${loc.countryName},
      home_lat = ${loc.lat}, home_lng = ${loc.lng}, location_updated_at = ${nowIso()} WHERE id = ${userId}`);
  }

  /** Remembers where the first runs start, for users who haven't set a city yet. */
  async setHomeIfMissing(userId: string, lat: number, lng: number): Promise<void> {
    // Rounded to ~1 km: it only places the city (chests), never the exact home
    const roundedLat = Math.round(lat * 100) / 100;
    const roundedLng = Math.round(lng * 100) / 100;
    await this.db.run(sql`UPDATE users SET home_lat = ${roundedLat}, home_lng = ${roundedLng} WHERE id = ${userId} AND home_lat IS NULL`);
  }

  async setUserTitle(userId: string, title: string | null): Promise<void> {
    await this.db.run(sql`UPDATE users SET title = ${title} WHERE id = ${userId}`);
  }

  async setStreak(userId: string, days: number, lastDate: string): Promise<void> {
    await this.db.run(sql`UPDATE users SET streak_days = ${days}, streak_last_date = ${lastDate} WHERE id = ${userId}`);
  }

  // ─── Global territory ─────────────────────────────────────────────────────

  async getGlobalTerritory(userId: string): Promise<{ geometry: string; area: number } | null> {
    const rows = await this.db.all<Row>(sql`SELECT geometry, area FROM global_territories WHERE user_id = ${userId}`);
    return rows[0] ? { geometry: rows[0].geometry, area: Number(rows[0].area) } : null;
  }

  async getGlobalTerritories(userIds: string[]): Promise<Array<{ userId: string; geometry: string; area: number }>> {
    if (userIds.length === 0) return [];
    const rows = await this.db.all<Row>(sql.join([
      sql`SELECT user_id, geometry, area FROM global_territories WHERE user_id IN (`,
      sql.join(userIds.map((id) => sql`${id}`), sql`, `),
      sql`)`,
    ], sql``));
    return rows.map((r) => ({ userId: r.user_id, geometry: r.geometry, area: Number(r.area) }));
  }

  async saveGlobalTerritory(userId: string, geometry: string, area: number): Promise<void> {
    await this.db.run(sql`INSERT INTO global_territories (user_id, geometry, area, updated_at) VALUES (${userId}, ${geometry}, ${area}, ${nowIso()})
      ON CONFLICT(user_id) DO UPDATE SET geometry = excluded.geometry, area = excluded.area, updated_at = excluded.updated_at`);
  }

  async addGlobalAreaEvent(event: { userId: string; routeId: string | null; area: number; bonus: number; period: string; runAt: string }): Promise<void> {
    await this.db.run(sql`INSERT INTO global_area_events (id, user_id, route_id, area, bonus, period, run_at)
      VALUES (${newId()}, ${event.userId}, ${event.routeId}, ${event.area}, ${event.bonus}, ${event.period}, ${event.runAt})`);
  }

  /** users.global_area = territory area + boost area; global_bonus_area = sum of event bonuses. */
  async syncUserGlobalArea(userId: string): Promise<number> {
    await this.db.run(sql`UPDATE users SET
      global_bonus_area = COALESCE((SELECT SUM(bonus) FROM global_area_events WHERE user_id = ${userId}), 0),
      global_area = COALESCE((SELECT area FROM global_territories WHERE user_id = ${userId}), 0)
        + COALESCE((SELECT SUM(bonus) FROM global_area_events WHERE user_id = ${userId}), 0)
      WHERE id = ${userId}`);
    const rows = await this.db.all<Row>(sql`SELECT global_area FROM users WHERE id = ${userId}`);
    return Number(rows[0]?.global_area ?? 0);
  }

  async clearGlobalData(userId: string): Promise<void> {
    await this.db.batch([
      this.db.run(sql`DELETE FROM global_area_events WHERE user_id = ${userId}`),
      this.db.run(sql`DELETE FROM global_territories WHERE user_id = ${userId}`),
      this.db.run(sql`UPDATE users SET global_area = 0, global_bonus_area = 0 WHERE id = ${userId}`),
    ] as any);
  }

  /** New global area (with boosts) of a user's runs that started in [from, to). */
  async globalGainBetween(userId: string, fromIso: string, toIso: string): Promise<number> {
    const rows = await this.db.all<Row>(sql`SELECT COALESCE(SUM(area + bonus), 0) AS total FROM global_area_events
      WHERE user_id = ${userId} AND run_at >= ${fromIso} AND run_at < ${toIso}`);
    return Number(rows[0]?.total ?? 0);
  }

  /** Global gain per user in [from, to), for many users (duel scores, team balancing). */
  async globalGainByUsers(userIds: string[], fromIso: string, toIso: string): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (userIds.length === 0) return map;
    const rows = await this.db.all<Row>(sql.join([
      sql`SELECT user_id, COALESCE(SUM(area + bonus), 0) AS total FROM global_area_events WHERE run_at >= ${fromIso} AND run_at < ${toIso} AND user_id IN (`,
      sql.join(userIds.map((id) => sql`${id}`), sql`, `),
      sql`) GROUP BY user_id`,
    ], sql``));
    for (const row of rows) map.set(row.user_id, Number(row.total));
    return map;
  }

  // ─── Routes (validation) ──────────────────────────────────────────────────

  async setRouteValidation(routeId: string, status: string, reasons: string[], globalAreaGained: number | null): Promise<void> {
    await this.db.run(sql`UPDATE routes SET validation_status = ${status}, validation_reasons = ${JSON.stringify(reasons)},
      global_area_gained = ${globalAreaGained} WHERE id = ${routeId}`);
  }

  async getRouteValidation(routeId: string): Promise<{ status: string | null; reasons: string[]; globalAreaGained: number | null } | null> {
    const rows = await this.db.all<Row>(sql`SELECT validation_status, validation_reasons, global_area_gained FROM routes WHERE id = ${routeId}`);
    if (!rows[0]) return null;
    return {
      status: rows[0].validation_status ?? null,
      reasons: parseJson(rows[0].validation_reasons, []),
      globalAreaGained: rows[0].global_area_gained ?? null,
    };
  }

  /** Other runs of the user whose time interval touches [start, end] and that counted. */
  async getOverlappingRuns(userId: string, startIso: string, endIso: string, excludeRouteId: string): Promise<Array<{ id: string; startedAt: string; completedAt: string; status: string | null }>> {
    const rows = await this.db.all<Row>(sql`SELECT id, started_at, completed_at, validation_status FROM routes
      WHERE user_id = ${userId} AND id != ${excludeRouteId} AND started_at < ${endIso} AND completed_at > ${startIso}
        AND (validation_status IS NULL OR validation_status != 'rejected')`);
    return rows.map((r) => ({ id: r.id, startedAt: r.started_at, completedAt: r.completed_at, status: r.validation_status ?? null }));
  }

  async getCountedRunsChronological(userId: string, fromIso?: string, toIso?: string): Promise<Row[]> {
    if (fromIso && toIso) {
      return this.db.all<Row>(sql`SELECT * FROM routes WHERE user_id = ${userId} AND (validation_status IS NULL OR validation_status != 'rejected')
        AND completed_at >= ${fromIso} AND started_at < ${toIso} ORDER BY completed_at ASC`);
    }
    return this.db.all<Row>(sql`SELECT * FROM routes WHERE user_id = ${userId} AND (validation_status IS NULL OR validation_status != 'rejected')
      ORDER BY completed_at ASC`);
  }

  async getFlaggedRuns(limit = 100): Promise<Row[]> {
    return this.db.all<Row>(sql`SELECT r.id, r.user_id, r.name, r.distance, r.duration, r.started_at, r.completed_at,
      r.validation_status, r.validation_reasons, r.global_area_gained, u.username, u.name AS user_name
      FROM routes r JOIN users u ON u.id = r.user_id WHERE r.validation_status = 'flagged' ORDER BY r.completed_at DESC LIMIT ${limit}`);
  }

  async lastRunStartedAt(userId: string, beforeIso: string): Promise<string | null> {
    const rows = await this.db.all<Row>(sql`SELECT MAX(started_at) AS last FROM routes WHERE user_id = ${userId} AND started_at < ${beforeIso}
      AND (validation_status IS NULL OR validation_status != 'rejected')`);
    return rows[0]?.last ?? null;
  }

  // ─── Rankings ─────────────────────────────────────────────────────────────

  /**
   * Global ranking. scope filters the users: all, a country, a city, a set of ids (friends, club).
   * period 'all' ranks by users.global_area; 'month' by the area won this month.
   */
  async globalRanking(options: {
    period: 'all' | 'month';
    month: string;
    countryCode?: string | null;
    city?: string | null;
    userIds?: string[] | null;
    limit: number;
  }): Promise<Array<Row & { score: number }>> {
    const filters: ReturnType<typeof sql>[] = [sql`u.id != '__system_runna__'`];
    if (options.countryCode) filters.push(sql`u.country_code = ${options.countryCode}`);
    if (options.city) filters.push(sql`lower(u.city) = ${options.city.toLowerCase()}`);
    if (options.userIds) {
      if (options.userIds.length === 0) return [];
      filters.push(sql.join([sql`u.id IN (`, sql.join(options.userIds.map((id) => sql`${id}`), sql`, `), sql`)`], sql``));
    }
    const where = sql.join(filters, sql` AND `);
    if (options.period === 'month') {
      const rows = await this.db.all<Row>(sql`SELECT u.id, u.username, u.name, u.avatar, u.color, u.title, u.city, u.country_code,
          COALESCE(SUM(e.area + e.bonus), 0) AS score
        FROM global_area_events e JOIN users u ON u.id = e.user_id
        WHERE e.period = ${options.month} AND ${where}
        GROUP BY u.id HAVING score > 0 ORDER BY score DESC, u.id ASC LIMIT ${options.limit}`);
      return rows.map((r) => ({ ...r, score: Number(r.score) }));
    }
    const rows = await this.db.all<Row>(sql`SELECT u.id, u.username, u.name, u.avatar, u.color, u.title, u.city, u.country_code,
        u.global_area AS score
      FROM users u WHERE u.global_area > 0 AND ${where}
      ORDER BY u.global_area DESC, u.id ASC LIMIT ${options.limit}`);
    return rows.map((r) => ({ ...r, score: Number(r.score) }));
  }

  /** Rank (1-based) of a score in the same scope, and the user's score. */
  async globalRankOf(userId: string, options: { period: 'all' | 'month'; month: string; countryCode?: string | null; city?: string | null; userIds?: string[] | null }): Promise<{ rank: number | null; score: number }> {
    let score = 0;
    if (options.period === 'month') {
      const rows = await this.db.all<Row>(sql`SELECT COALESCE(SUM(area + bonus), 0) AS score FROM global_area_events WHERE user_id = ${userId} AND period = ${options.month}`);
      score = Number(rows[0]?.score ?? 0);
    } else {
      const rows = await this.db.all<Row>(sql`SELECT global_area FROM users WHERE id = ${userId}`);
      score = Number(rows[0]?.global_area ?? 0);
    }
    if (score <= 0) return { rank: null, score };
    const filters: ReturnType<typeof sql>[] = [sql`u.id != '__system_runna__'`];
    if (options.countryCode) filters.push(sql`u.country_code = ${options.countryCode}`);
    if (options.city) filters.push(sql`lower(u.city) = ${options.city.toLowerCase()}`);
    if (options.userIds) {
      if (options.userIds.length === 0) return { rank: null, score };
      filters.push(sql.join([sql`u.id IN (`, sql.join(options.userIds.map((id) => sql`${id}`), sql`, `), sql`)`], sql``));
    }
    const where = sql.join(filters, sql` AND `);
    if (options.period === 'month') {
      const rows = await this.db.all<Row>(sql`SELECT COUNT(*) AS ahead FROM (
          SELECT e.user_id, SUM(e.area + e.bonus) AS s FROM global_area_events e JOIN users u ON u.id = e.user_id
          WHERE e.period = ${options.month} AND ${where} GROUP BY e.user_id
        ) WHERE s > ${score}`);
      return { rank: Number(rows[0]?.ahead ?? 0) + 1, score };
    }
    const rows = await this.db.all<Row>(sql`SELECT COUNT(*) AS ahead FROM users u WHERE u.global_area > ${score} AND ${where}`);
    return { rank: Number(rows[0]?.ahead ?? 0) + 1, score };
  }

  /** Club ranking: league points (then rating) or total global area of members. */
  async clubRanking(options: { sort: 'league' | 'area'; countryCode?: string | null; city?: string | null; limit: number }): Promise<Array<ClubRow & { score: number }>> {
    const filters: ReturnType<typeof sql>[] = [sql`1 = 1`];
    if (options.countryCode) filters.push(sql`c.country_code = ${options.countryCode}`);
    if (options.city) filters.push(sql`lower(c.city) = ${options.city.toLowerCase()}`);
    const where = sql.join(filters, sql` AND `);
    if (options.sort === 'area') {
      const rows = await this.db.all<Row>(sql`SELECT c.*, COALESCE(SUM(u.global_area), 0) AS score FROM clubs c
        LEFT JOIN club_members m ON m.club_id = c.id LEFT JOIN users u ON u.id = m.user_id
        WHERE ${where} GROUP BY c.id ORDER BY score DESC, c.id ASC LIMIT ${options.limit}`);
      return rows.map((r) => ({ ...toClub(r), score: Number(r.score) }));
    }
    const rows = await this.db.all<Row>(sql`SELECT c.*, c.league_points AS score FROM clubs c WHERE ${where}
      ORDER BY c.league_points DESC, c.rating DESC, c.id ASC LIMIT ${options.limit}`);
    return rows.map((r) => ({ ...toClub(r), score: Number(r.score) }));
  }

  // ─── Clubs ────────────────────────────────────────────────────────────────

  async createClub(data: { name: string; slogan: string | null; description: string | null; crest: Crest; color: string; entryMode: EntryMode; invitePermission: InvitePermission; joinCode: string; city: string | null; countryCode: string | null; countryName: string | null; centerLat: number | null; centerLng: number | null; ownerId: string }): Promise<ClubRow> {
    const id = newId();
    const now = nowIso();
    await this.db.batch([
      this.db.run(sql`INSERT INTO clubs (id, name, name_key, slogan, description, crest, color, visibility, entry_mode, invite_permission, join_code, city, country_code, country_name,
          center_lat, center_lng, owner_id, member_count, created_at, updated_at)
        VALUES (${id}, ${data.name}, ${data.name.toLowerCase()}, ${data.slogan}, ${data.description}, ${JSON.stringify(data.crest)}, ${data.color}, ${visibilityOf(data.entryMode)},
          ${data.entryMode}, ${data.invitePermission}, ${data.joinCode}, ${data.city}, ${data.countryCode}, ${data.countryName}, ${data.centerLat}, ${data.centerLng}, ${data.ownerId}, 1, ${now}, ${now})`),
      this.db.run(sql`INSERT INTO club_members (user_id, club_id, role, joined_at) VALUES (${data.ownerId}, ${id}, 'owner', ${now})`),
    ] as any);
    return (await this.getClub(id))!;
  }

  async getClub(clubId: string): Promise<ClubRow | null> {
    const rows = await this.db.all<Row>(sql`SELECT * FROM clubs WHERE id = ${clubId}`);
    return rows[0] ? toClub(rows[0]) : null;
  }

  async getClubsByIds(ids: string[]): Promise<Map<string, ClubRow>> {
    const map = new Map<string, ClubRow>();
    if (ids.length === 0) return map;
    const rows = await this.db.all<Row>(sql.join([sql`SELECT * FROM clubs WHERE id IN (`, sql.join([...new Set(ids)].map((id) => sql`${id}`), sql`, `), sql`)`], sql``));
    for (const row of rows) map.set(row.id, toClub(row));
    return map;
  }

  async getAllClubs(): Promise<ClubRow[]> {
    const rows = await this.db.all<Row>(sql`SELECT * FROM clubs ORDER BY created_at ASC`);
    return rows.map(toClub);
  }

  async getClubByCode(code: string): Promise<ClubRow | null> {
    const rows = await this.db.all<Row>(sql`SELECT * FROM clubs WHERE join_code = ${code.toUpperCase()}`);
    return rows[0] ? toClub(rows[0]) : null;
  }

  async isClubNameTaken(name: string, exceptClubId?: string): Promise<boolean> {
    const rows = await this.db.all<Row>(sql`SELECT id FROM clubs WHERE name_key = ${name.toLowerCase()}`);
    return rows.some((r) => r.id !== exceptClubId);
  }

  async updateClub(clubId: string, data: Partial<{ name: string; slogan: string | null; description: string | null; crest: Crest; color: string; entryMode: EntryMode; invitePermission: InvitePermission; city: string | null; countryCode: string | null; countryName: string | null; centerLat: number | null; centerLng: number | null; joinCode: string; ownerId: string }>): Promise<void> {
    const sets: ReturnType<typeof sql>[] = [sql`updated_at = ${nowIso()}`];
    if (data.description !== undefined) sets.push(sql`description = ${data.description}`);
    // The visibility of older app versions follows the entry type
    if (data.entryMode !== undefined) { sets.push(sql`entry_mode = ${data.entryMode}`); sets.push(sql`visibility = ${visibilityOf(data.entryMode)}`); }
    if (data.invitePermission !== undefined) sets.push(sql`invite_permission = ${data.invitePermission}`);
    if (data.name !== undefined) { sets.push(sql`name = ${data.name}`); sets.push(sql`name_key = ${data.name.toLowerCase()}`); }
    if (data.slogan !== undefined) sets.push(sql`slogan = ${data.slogan}`);
    if (data.crest !== undefined) sets.push(sql`crest = ${JSON.stringify(data.crest)}`);
    if (data.color !== undefined) sets.push(sql`color = ${data.color}`);
    if (data.city !== undefined) sets.push(sql`city = ${data.city}`);
    if (data.countryCode !== undefined) sets.push(sql`country_code = ${data.countryCode}`);
    if (data.countryName !== undefined) sets.push(sql`country_name = ${data.countryName}`);
    if (data.centerLat !== undefined) sets.push(sql`center_lat = ${data.centerLat}`);
    if (data.centerLng !== undefined) sets.push(sql`center_lng = ${data.centerLng}`);
    if (data.joinCode !== undefined) sets.push(sql`join_code = ${data.joinCode}`);
    if (data.ownerId !== undefined) sets.push(sql`owner_id = ${data.ownerId}`);
    await this.db.run(sql`UPDATE clubs SET ${sql.join(sets, sql`, `)} WHERE id = ${clubId}`);
  }

  async deleteClub(clubId: string): Promise<void> {
    await this.db.batch([
      this.db.run(sql`DELETE FROM club_members WHERE club_id = ${clubId}`),
      this.db.run(sql`DELETE FROM club_requests WHERE club_id = ${clubId}`),
      this.db.run(sql`DELETE FROM club_invite_links WHERE club_id = ${clubId}`),
      this.db.run(sql`DELETE FROM clubs WHERE id = ${clubId}`),
    ] as any);
  }

  async searchClubs(options: { query: string; countryCode?: string | null; city?: string | null; limit: number }): Promise<ClubRow[]> {
    const q = `%${options.query.toLowerCase().replace(/[%_]/g, '')}%`;
    // Listed: open and approval clubs (invite-only ones are never shown)
    const rows = await this.db.all<Row>(sql`SELECT * FROM clubs WHERE COALESCE(entry_mode, CASE WHEN visibility = 'private' THEN 'invite_only' ELSE 'open' END) != 'invite_only'
      AND (name_key LIKE ${q} OR lower(COALESCE(city, '')) LIKE ${q} OR lower(COALESCE(slogan, '')) LIKE ${q} OR lower(COALESCE(description, '')) LIKE ${q})
      ORDER BY member_count DESC, league_points DESC LIMIT 200`);
    return rows.map(toClub);
  }

  async getMembership(userId: string): Promise<ClubMemberRow | null> {
    const rows = await this.db.all<Row>(sql`SELECT * FROM club_members WHERE user_id = ${userId}`);
    return rows[0] ? { userId: rows[0].user_id, clubId: rows[0].club_id, role: rows[0].role, joinedAt: rows[0].joined_at } : null;
  }

  async getMemberships(userIds: string[]): Promise<Map<string, ClubMemberRow>> {
    const map = new Map<string, ClubMemberRow>();
    if (userIds.length === 0) return map;
    const rows = await this.db.all<Row>(sql.join([sql`SELECT * FROM club_members WHERE user_id IN (`, sql.join([...new Set(userIds)].map((id) => sql`${id}`), sql`, `), sql`)`], sql``));
    for (const r of rows) map.set(r.user_id, { userId: r.user_id, clubId: r.club_id, role: r.role, joinedAt: r.joined_at });
    return map;
  }

  async getClubMembers(clubId: string): Promise<Array<ClubMemberRow & { user: PublicUserLite; globalArea: number; city: string | null }>> {
    const rows = await this.db.all<Row>(sql`SELECT m.user_id, m.club_id, m.role, m.joined_at, u.id, u.username, u.name, u.avatar, u.color, u.title,
        u.global_area, u.city
      FROM club_members m JOIN users u ON u.id = m.user_id WHERE m.club_id = ${clubId}
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.global_area DESC`);
    return rows.map((r) => ({
      userId: r.user_id, clubId: r.club_id, role: r.role, joinedAt: r.joined_at,
      user: toUserLite(r), globalArea: Number(r.global_area ?? 0), city: r.city ?? null,
    }));
  }

  async getClubMemberIds(clubId: string): Promise<string[]> {
    const rows = await this.db.all<Row>(sql`SELECT user_id FROM club_members WHERE club_id = ${clubId}`);
    return rows.map((r) => r.user_id);
  }

  /** Whether both users are members of the same club. */
  async sameClub(a: string, b: string): Promise<boolean> {
    const rows = await this.db.all<Row>(sql`SELECT 1 AS ok FROM club_members x JOIN club_members y ON y.club_id = x.club_id
      WHERE x.user_id = ${a} AND y.user_id = ${b} LIMIT 1`);
    return rows.length > 0;
  }

  async addMember(clubId: string, userId: string, role: ClubRole = 'member'): Promise<boolean> {
    try {
      await this.db.run(sql`INSERT INTO club_members (user_id, club_id, role, joined_at) VALUES (${userId}, ${clubId}, ${role}, ${nowIso()})`);
    } catch {
      return false; // already in a club (primary key)
    }
    await this.refreshMemberCount(clubId);
    await this.db.run(sql`UPDATE club_requests SET status = 'cancelled' WHERE user_id = ${userId} AND status = 'pending' AND club_id != ${clubId}`);
    await this.db.run(sql`UPDATE club_requests SET status = 'accepted' WHERE user_id = ${userId} AND status = 'pending' AND club_id = ${clubId}`);
    return true;
  }

  async removeMember(clubId: string, userId: string): Promise<void> {
    await this.db.run(sql`DELETE FROM club_members WHERE club_id = ${clubId} AND user_id = ${userId}`);
    await this.refreshMemberCount(clubId);
  }

  async setMemberRole(clubId: string, userId: string, role: ClubRole): Promise<void> {
    await this.db.run(sql`UPDATE club_members SET role = ${role} WHERE club_id = ${clubId} AND user_id = ${userId}`);
  }

  async refreshMemberCount(clubId: string): Promise<number> {
    await this.db.run(sql`UPDATE clubs SET member_count = (SELECT COUNT(*) FROM club_members WHERE club_id = ${clubId}) WHERE id = ${clubId}`);
    const rows = await this.db.all<Row>(sql`SELECT member_count FROM clubs WHERE id = ${clubId}`);
    return Number(rows[0]?.member_count ?? 0);
  }

  async createClubRequest(clubId: string, userId: string, kind: 'request' | 'invite', invitedBy: string | null): Promise<string> {
    const existing = await this.db.all<Row>(sql`SELECT id FROM club_requests WHERE club_id = ${clubId} AND user_id = ${userId} AND kind = ${kind} AND status = 'pending'`);
    if (existing[0]) return existing[0].id;
    const id = newId();
    await this.db.run(sql`INSERT INTO club_requests (id, club_id, user_id, kind, invited_by, status, created_at)
      VALUES (${id}, ${clubId}, ${userId}, ${kind}, ${invitedBy}, 'pending', ${nowIso()})`);
    return id;
  }

  async getClubRequest(id: string): Promise<Row | null> {
    const rows = await this.db.all<Row>(sql`SELECT * FROM club_requests WHERE id = ${id}`);
    return rows[0] ?? null;
  }

  async setClubRequestStatus(id: string, status: string): Promise<void> {
    await this.db.run(sql`UPDATE club_requests SET status = ${status} WHERE id = ${id}`);
  }

  async getPendingRequestsForClub(clubId: string): Promise<Array<{ id: string; createdAt: string; user: PublicUserLite; globalArea: number }>> {
    const rows = await this.db.all<Row>(sql`SELECT r.id AS request_id, r.created_at AS requested_at, u.id, u.username, u.name, u.avatar, u.color, u.title, u.global_area
      FROM club_requests r JOIN users u ON u.id = r.user_id
      WHERE r.club_id = ${clubId} AND r.kind = 'request' AND r.status = 'pending' ORDER BY r.created_at ASC`);
    return rows.map((r) => ({ id: r.request_id, createdAt: r.requested_at, user: toUserLite(r), globalArea: Number(r.global_area ?? 0) }));
  }

  async getPendingInvitesForUser(userId: string): Promise<Array<{ id: string; createdAt: string; clubId: string; invitedBy: string | null }>> {
    const rows = await this.db.all<Row>(sql`SELECT id, created_at, club_id, invited_by FROM club_requests
      WHERE user_id = ${userId} AND kind = 'invite' AND status = 'pending' ORDER BY created_at DESC`);
    return rows.map((r) => ({ id: r.id, createdAt: r.created_at, clubId: r.club_id, invitedBy: r.invited_by ?? null }));
  }

  async getPendingRequestOfUser(userId: string): Promise<Array<{ id: string; clubId: string }>> {
    const rows = await this.db.all<Row>(sql`SELECT id, club_id FROM club_requests WHERE user_id = ${userId} AND kind = 'request' AND status = 'pending'`);
    return rows.map((r) => ({ id: r.id, clubId: r.club_id }));
  }

  async createInviteLink(clubId: string, createdBy: string, token: string, expiresAt: string): Promise<void> {
    await this.db.run(sql`INSERT INTO club_invite_links (token, club_id, created_by, expires_at, created_at) VALUES (${token}, ${clubId}, ${createdBy}, ${expiresAt}, ${nowIso()})`);
  }

  async getInviteLink(token: string): Promise<{ token: string; clubId: string; createdBy: string; expiresAt: string } | null> {
    const rows = await this.db.all<Row>(sql`SELECT * FROM club_invite_links WHERE token = ${token}`);
    return rows[0] ? { token: rows[0].token, clubId: rows[0].club_id, createdBy: rows[0].created_by, expiresAt: rows[0].expires_at } : null;
  }

  /** Cosmetic items owned by any member of the club (unlock crest pieces). */
  async clubUnlockedCosmetics(clubId: string): Promise<Set<string>> {
    const rows = await this.db.all<Row>(sql`SELECT DISTINCT p.power_type FROM user_powers p JOIN club_members m ON m.user_id = p.user_id
      WHERE m.club_id = ${clubId} AND p.status = 'owned'`);
    return new Set(rows.map((r) => r.power_type));
  }

  /** Users whose last counted run started on or after `sinceIso` (active members). */
  async activeUserIds(userIds: string[], sinceIso: string): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const rows = await this.db.all<Row>(sql.join([
      sql`SELECT DISTINCT user_id FROM routes WHERE started_at >= ${sinceIso} AND (validation_status IS NULL OR validation_status != 'rejected') AND user_id IN (`,
      sql.join(userIds.map((id) => sql`${id}`), sql`, `),
      sql`)`,
    ], sql``));
    return new Set(rows.map((r) => r.user_id));
  }

  // ─── Seasons ──────────────────────────────────────────────────────────────

  async getCycle(number: number): Promise<Row | null> {
    const rows = await this.db.all<Row>(sql`SELECT * FROM season_cycles WHERE number = ${number}`);
    return rows[0] ?? null;
  }

  async upsertCycle(number: number, data: { status: string; startedAt?: string | null; endedAt?: string | null; restStartedAt?: string | null }): Promise<void> {
    await this.db.run(sql`INSERT INTO season_cycles (number, status, started_at, ended_at, rest_started_at)
      VALUES (${number}, ${data.status}, ${data.startedAt ?? null}, ${data.endedAt ?? null}, ${data.restStartedAt ?? null})
      ON CONFLICT(number) DO UPDATE SET status = excluded.status,
        started_at = COALESCE(excluded.started_at, season_cycles.started_at),
        ended_at = COALESCE(excluded.ended_at, season_cycles.ended_at),
        rest_started_at = COALESCE(excluded.rest_started_at, season_cycles.rest_started_at)`);
  }

  async getUnfinishedCompetitionCycles(beforeNumber: number): Promise<number[]> {
    const rows = await this.db.all<Row>(sql`SELECT DISTINCT cycle_number FROM club_competitions WHERE status = 'active' AND cycle_number < ${beforeNumber} ORDER BY cycle_number ASC`);
    return rows.map((r) => Number(r.cycle_number));
  }

  async createCompetition(data: { cycleNumber: number; clubId: string; mode: string; config: any; opponentClubId?: string | null; matchId?: string | null }): Promise<CompetitionRow | null> {
    const id = newId();
    try {
      await this.db.run(sql`INSERT INTO club_competitions (id, cycle_number, club_id, mode, status, config, opponent_club_id, match_id, created_at)
        VALUES (${id}, ${data.cycleNumber}, ${data.clubId}, ${data.mode}, 'active', ${JSON.stringify(data.config ?? {})}, ${data.opponentClubId ?? null}, ${data.matchId ?? null}, ${nowIso()})`);
    } catch {
      return null; // already exists for this cycle
    }
    return this.getCompetition(id);
  }

  async getCompetition(id: string): Promise<CompetitionRow | null> {
    const rows = await this.db.all<Row>(sql`SELECT * FROM club_competitions WHERE id = ${id}`);
    return rows[0] ? toCompetition(rows[0]) : null;
  }

  async getClubCompetition(clubId: string, cycleNumber: number): Promise<CompetitionRow | null> {
    const rows = await this.db.all<Row>(sql`SELECT * FROM club_competitions WHERE club_id = ${clubId} AND cycle_number = ${cycleNumber}`);
    return rows[0] ? toCompetition(rows[0]) : null;
  }

  async getCompetitionsOfCycle(cycleNumber: number): Promise<CompetitionRow[]> {
    const rows = await this.db.all<Row>(sql`SELECT * FROM club_competitions WHERE cycle_number = ${cycleNumber}`);
    return rows.map(toCompetition);
  }

  async getClubCompetitionHistory(clubId: string, limit = 20): Promise<CompetitionRow[]> {
    const rows = await this.db.all<Row>(sql`SELECT * FROM club_competitions WHERE club_id = ${clubId} AND status = 'finished' ORDER BY cycle_number DESC LIMIT ${limit}`);
    return rows.map(toCompetition);
  }

  async updateCompetition(id: string, data: Partial<{ status: string; config: any; score: number; result: any; finishedAt: string; opponentClubId: string | null; matchId: string | null; mode: string }>): Promise<void> {
    const sets: ReturnType<typeof sql>[] = [];
    if (data.status !== undefined) sets.push(sql`status = ${data.status}`);
    if (data.config !== undefined) sets.push(sql`config = ${JSON.stringify(data.config)}`);
    if (data.score !== undefined) sets.push(sql`score = ${data.score}`);
    if (data.result !== undefined) sets.push(sql`result = ${JSON.stringify(data.result)}`);
    if (data.finishedAt !== undefined) sets.push(sql`finished_at = ${data.finishedAt}`);
    if (data.opponentClubId !== undefined) sets.push(sql`opponent_club_id = ${data.opponentClubId}`);
    if (data.matchId !== undefined) sets.push(sql`match_id = ${data.matchId}`);
    if (data.mode !== undefined) sets.push(sql`mode = ${data.mode}`);
    if (sets.length === 0) return;
    await this.db.run(sql`UPDATE club_competitions SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`);
  }

  async addParticipant(competitionId: string, userId: string, team: number | null = null, joinedAt: string = nowIso()): Promise<void> {
    await this.db.run(sql`INSERT OR IGNORE INTO competition_participants (competition_id, user_id, team, joined_at)
      VALUES (${competitionId}, ${userId}, ${team}, ${joinedAt})`);
  }

  /** Records a run that counted in a competition (idempotent per route). */
  async recordCompetitionRun(data: { competitionId: string; userId: string; routeId: string; startedAt: string; areaGained: number; areaStolen: number; distance: number }): Promise<void> {
    await this.db.run(sql`INSERT INTO competition_runs (competition_id, user_id, route_id, started_at, area_gained, area_stolen, distance)
      VALUES (${data.competitionId}, ${data.userId}, ${data.routeId}, ${data.startedAt}, ${data.areaGained}, ${data.areaStolen}, ${data.distance})
      ON CONFLICT(competition_id, route_id) DO UPDATE SET area_gained = excluded.area_gained, area_stolen = excluded.area_stolen,
        distance = excluded.distance, started_at = excluded.started_at`);
  }

  /** Runs that counted in a competition, optionally only those that started in [fromIso, toIso). */
  async getCompetitionRuns(competitionId: string, fromIso?: string, toIso?: string): Promise<Array<{ userId: string; routeId: string; startedAt: string; areaGained: number; areaStolen: number; distance: number }>> {
    const rows = fromIso && toIso
      ? await this.db.all<Row>(sql`SELECT * FROM competition_runs WHERE competition_id = ${competitionId} AND started_at >= ${fromIso} AND started_at < ${toIso}`)
      : await this.db.all<Row>(sql`SELECT * FROM competition_runs WHERE competition_id = ${competitionId}`);
    return rows.map((r) => ({
      userId: r.user_id, routeId: r.route_id, startedAt: r.started_at,
      areaGained: Number(r.area_gained ?? 0), areaStolen: Number(r.area_stolen ?? 0), distance: Number(r.distance ?? 0),
    }));
  }

  async removeCompetitionRunsOfRoute(routeId: string): Promise<void> {
    await this.db.run(sql`DELETE FROM competition_runs WHERE route_id = ${routeId}`);
    await this.db.run(sql`DELETE FROM flag_captures WHERE route_id = ${routeId}`);
  }

  // ─── Banderas ───

  async createFlags(competitionId: string, flags: Array<{ idx: number; name: string; lat: number; lng: number }>): Promise<void> {
    for (const flag of flags) {
      await this.db.run(sql`INSERT INTO competition_flags (id, competition_id, idx, name, lat, lng)
        VALUES (${newId()}, ${competitionId}, ${flag.idx}, ${flag.name}, ${flag.lat}, ${flag.lng})`);
    }
  }

  async getFlags(competitionId: string): Promise<Array<{ id: string; idx: number; name: string; lat: number; lng: number }>> {
    const rows = await this.db.all<Row>(sql`SELECT * FROM competition_flags WHERE competition_id = ${competitionId} ORDER BY idx ASC`);
    return rows.map((r) => ({ id: r.id, idx: Number(r.idx), name: r.name, lat: Number(r.lat), lng: Number(r.lng) }));
  }

  /** One capture per flag and run (idempotent when a run is processed again). */
  async addFlagCapture(data: { flagId: string; competitionId: string; userId: string; routeId: string; capturedAt: string }): Promise<boolean> {
    const before = await this.db.all<Row>(sql`SELECT id FROM flag_captures WHERE flag_id = ${data.flagId} AND route_id = ${data.routeId}`);
    if (before.length > 0) return false;
    await this.db.run(sql`INSERT INTO flag_captures (id, flag_id, competition_id, user_id, route_id, captured_at, created_at)
      VALUES (${newId()}, ${data.flagId}, ${data.competitionId}, ${data.userId}, ${data.routeId}, ${data.capturedAt}, ${nowIso()})`);
    return true;
  }

  async getFlagCaptures(competitionId: string): Promise<Array<{ flagId: string; userId: string; routeId: string; capturedAt: string }>> {
    const rows = await this.db.all<Row>(sql`SELECT * FROM flag_captures WHERE competition_id = ${competitionId} ORDER BY captured_at ASC, created_at ASC`);
    return rows.map((r) => ({ flagId: r.flag_id, userId: r.user_id, routeId: r.route_id, capturedAt: r.captured_at }));
  }

  /**
   * Exploradores: new global area of each user (without power bonuses) from runs that started in
   * [from, to), with a different start per user (when they entered the competition).
   */
  async globalBaseAreaByUsers(starts: Map<string, string>, toIso: string): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    for (const [userId, fromIso] of starts) {
      const rows = await this.db.all<Row>(sql`SELECT COALESCE(SUM(area), 0) AS total FROM global_area_events
        WHERE user_id = ${userId} AND run_at >= ${fromIso} AND run_at < ${toIso}`);
      map.set(userId, Number(rows[0]?.total ?? 0));
    }
    return map;
  }

  /** Centre of a club: its stored centre, else the mean of its members' home cities. */
  async getClubCenter(clubId: string): Promise<{ lat: number; lng: number } | null> {
    const club = await this.getClub(clubId);
    if (club && club.centerLat !== null && club.centerLng !== null) return { lat: Number(club.centerLat), lng: Number(club.centerLng) };
    const rows = await this.db.all<Row>(sql`SELECT AVG(u.home_lat) AS lat, AVG(u.home_lng) AS lng FROM club_members m JOIN users u ON u.id = m.user_id
      WHERE m.club_id = ${clubId} AND u.home_lat IS NOT NULL AND u.home_lng IS NOT NULL`);
    const lat = Number(rows[0]?.lat);
    const lng = Number(rows[0]?.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) && rows[0]?.lat !== null ? { lat, lng } : null;
  }

  async removeParticipant(competitionId: string, userId: string): Promise<void> {
    await this.db.run(sql`DELETE FROM competition_participants WHERE competition_id = ${competitionId} AND user_id = ${userId}`);
  }

  async getParticipants(competitionId: string): Promise<ParticipantRow[]> {
    const rows = await this.db.all<Row>(sql`SELECT * FROM competition_participants WHERE competition_id = ${competitionId}`);
    return rows.map(toParticipant);
  }

  /** The user's participation in a still-active competition, if any. */
  async getActiveParticipation(userId: string): Promise<{ participant: ParticipantRow; competition: CompetitionRow } | null> {
    const rows = await this.db.all<Row>(sql`SELECT p.*, c.id AS c_id, c.cycle_number, c.club_id, c.mode, c.status, c.config, c.opponent_club_id, c.match_id,
        c.score, c.result, c.created_at, c.finished_at
      FROM competition_participants p JOIN club_competitions c ON c.id = p.competition_id
      WHERE p.user_id = ${userId} AND c.status = 'active' ORDER BY c.cycle_number DESC LIMIT 1`);
    const row = rows[0];
    if (!row) return null;
    return {
      participant: toParticipant(row),
      competition: toCompetition({ ...row, id: row.c_id }),
    };
  }

  async getParticipationHistory(userId: string, limit = 20): Promise<Array<{ participant: ParticipantRow; competition: CompetitionRow }>> {
    const rows = await this.db.all<Row>(sql`SELECT p.*, c.id AS c_id, c.cycle_number, c.club_id, c.mode, c.status, c.config, c.opponent_club_id, c.match_id,
        c.score, c.result, c.created_at, c.finished_at
      FROM competition_participants p JOIN club_competitions c ON c.id = p.competition_id
      WHERE p.user_id = ${userId} AND c.status = 'finished' ORDER BY c.cycle_number DESC LIMIT ${limit}`);
    return rows.map((row) => ({ participant: toParticipant(row), competition: toCompetition({ ...row, id: row.c_id }) }));
  }

  async updateParticipant(competitionId: string, userId: string, data: Partial<{ team: number | null; area: number; addBonus: number; addAreaStolen: number; addAreaLost: number; addRuns: number; addDistance: number; finalRank: number; resultSeenAt: string; eliminatedCut: number; eliminatedAt: string }>): Promise<void> {
    const sets: ReturnType<typeof sql>[] = [];
    if (data.eliminatedCut !== undefined) sets.push(sql`eliminated_cut = ${data.eliminatedCut}`);
    if (data.eliminatedAt !== undefined) sets.push(sql`eliminated_at = ${data.eliminatedAt}`);
    if (data.addAreaLost) sets.push(sql`area_lost = area_lost + ${data.addAreaLost}`);
    if (data.resultSeenAt !== undefined) sets.push(sql`result_seen_at = ${data.resultSeenAt}`);
    if (data.team !== undefined) sets.push(sql`team = ${data.team}`);
    if (data.area !== undefined) sets.push(sql`area = ${data.area}`);
    if (data.addBonus) sets.push(sql`bonus = bonus + ${data.addBonus}`);
    if (data.addAreaStolen) sets.push(sql`area_stolen = area_stolen + ${data.addAreaStolen}`);
    if (data.addRuns) sets.push(sql`runs = runs + ${data.addRuns}`);
    if (data.addDistance) sets.push(sql`distance = distance + ${data.addDistance}`);
    if (data.finalRank !== undefined) sets.push(sql`final_rank = ${data.finalRank}`);
    if (sets.length === 0) return;
    await this.db.run(sql`UPDATE competition_participants SET ${sql.join(sets, sql`, `)} WHERE competition_id = ${competitionId} AND user_id = ${userId}`);
  }

  /** Copies users.total_area (competition map) into the participants of a competition. */
  async syncParticipantAreas(competitionId: string): Promise<void> {
    await this.db.run(sql`UPDATE competition_participants SET area = COALESCE((SELECT total_area FROM users WHERE users.id = competition_participants.user_id), 0)
      WHERE competition_id = ${competitionId}`);
  }

  async createMatch(data: { cycleNumber: number; clubA: string; clubB: string; runnersCounted: number }): Promise<string> {
    const id = newId();
    await this.db.run(sql`INSERT INTO club_matches (id, cycle_number, club_a, club_b, runners_counted, status, created_at)
      VALUES (${id}, ${data.cycleNumber}, ${data.clubA}, ${data.clubB}, ${data.runnersCounted}, 'active', ${nowIso()})`);
    return id;
  }

  async getMatch(id: string): Promise<Row | null> {
    const rows = await this.db.all<Row>(sql`SELECT * FROM club_matches WHERE id = ${id}`);
    return rows[0] ?? null;
  }

  async finishMatch(id: string, data: { scoreA: number; scoreB: number; winnerClubId: string | null; ratingChange: number }): Promise<void> {
    await this.db.run(sql`UPDATE club_matches SET score_a = ${data.scoreA}, score_b = ${data.scoreB}, winner_club_id = ${data.winnerClubId},
      rating_change = ${data.ratingChange}, status = 'finished', finished_at = ${nowIso()} WHERE id = ${id}`);
  }

  /** Last opponents of each club (most recent first), for matchmaking. */
  async recentOpponents(limitPerClub = 3): Promise<Map<string, string[]>> {
    const rows = await this.db.all<Row>(sql`SELECT club_a, club_b FROM club_matches ORDER BY cycle_number DESC, created_at DESC LIMIT 2000`);
    const map = new Map<string, string[]>();
    for (const row of rows) {
      for (const [self, other] of [[row.club_a, row.club_b], [row.club_b, row.club_a]] as const) {
        const list = map.get(self) ?? [];
        if (list.length < limitPerClub) list.push(other);
        map.set(self, list);
      }
    }
    return map;
  }

  async adjustClubStanding(clubId: string, ratingDelta: number, leaguePoints: number): Promise<void> {
    await this.db.run(sql`UPDATE clubs SET rating = rating + ${ratingDelta}, league_points = league_points + ${leaguePoints} WHERE id = ${clubId}`);
  }

  /** Wipes the competition map (territories, fortifications) and everybody's competition area. */
  async resetCompetitionMap(): Promise<void> {
    await this.db.batch([
      this.db.run(sql`DELETE FROM territories`),
      this.db.run(sql`UPDATE users SET total_area = 0 WHERE total_area != 0`),
    ] as any);
    try { await this.db.run(sql`DELETE FROM territory_fortifications`); } catch { /* table not created yet */ }
    try { await this.db.run(sql`DELETE FROM user_nicknames`); } catch { /* table not created yet */ }
  }

  // ─── Inventory (user_powers) ──────────────────────────────────────────────

  /**
   * Gives a user an item. Powers: if they already hold INVENTORY_CAP unused items of the same scope,
   * the oldest one is discarded. Cosmetics: owned forever (granting one twice does nothing).
   * Returns the id of the inventory row (null for an already-owned cosmetic) and what was discarded.
   */
  async grantItem(userId: string, itemId: string, source: string, sourceId: string, now = Date.now()): Promise<{ id: string | null; discarded: string | null }> {
    const def = ITEMS[itemId];
    if (!def) throw new Error(`Unknown item ${itemId}`);
    if (def.scope === 'cosmetic') {
      const owned = await this.db.all<Row>(sql`SELECT id FROM user_powers WHERE user_id = ${userId} AND power_type = ${itemId} AND status = 'owned'`);
      if (owned[0]) return { id: null, discarded: null };
      const id = newId();
      await this.db.run(sql`INSERT INTO user_powers (id, user_id, competition_id, power_type, treasure_id, status, scope, source, created_at)
        VALUES (${id}, ${userId}, ${SEASON_INVENTORY}, ${itemId}, ${sourceId}, 'owned', 'cosmetic', ${source}, ${new Date(now).toISOString()})`);
      return { id, discarded: null };
    }
    await this.expireItems(userId, now);
    let discarded: string | null = null;
    const held = await this.db.all<Row>(sql`SELECT id, power_type FROM user_powers WHERE user_id = ${userId} AND status = 'available'
      AND COALESCE(scope, 'competition') = ${def.scope} ORDER BY created_at ASC`);
    if (held.length >= INVENTORY_CAP) {
      const oldest = held[0];
      await this.db.run(sql`UPDATE user_powers SET status = 'expired', used_at = ${new Date(now).toISOString()} WHERE id = ${oldest.id}`);
      discarded = oldest.power_type;
    }
    let ttlStart = now;
    if (def.usablePhase === 'competition') {
      // Items obtained outside a competition start their clock when the next one starts
      const info = cycleAt(now);
      if (info.phase !== 'competition') {
        const nextStart = info.phase === 'preseason' ? Date.parse(info.restEndsAt) : Date.parse(info.restEndsAt);
        ttlStart = Math.max(now, nextStart);
      }
    }
    const unusedExpiresAt = def.unusedTtlHours === null ? null : new Date(ttlStart + def.unusedTtlHours * 3600 * 1000).toISOString();
    const id = newId();
    await this.db.run(sql`INSERT INTO user_powers (id, user_id, competition_id, power_type, treasure_id, status, scope, source, unused_expires_at, created_at)
      VALUES (${id}, ${userId}, ${SEASON_INVENTORY}, ${itemId}, ${sourceId}, 'available', ${def.scope}, ${source}, ${unusedExpiresAt}, ${new Date(now).toISOString()})`);
    return { id, discarded };
  }

  /** End of a competition: competition effects waiting for a run don't carry over to the next one. */
  async expirePendingCompetitionEffects(): Promise<void> {
    await this.db.run(sql`UPDATE user_powers SET status = 'expired' WHERE status = 'active' AND expires_at IS NULL
      AND COALESCE(scope, 'competition') = 'competition'`);
  }

  /** Marks unused items past their deadline (and finished timed effects) as expired. */
  async expireItems(userId: string | null, now = Date.now()): Promise<void> {
    const iso = new Date(now).toISOString();
    if (userId) {
      await this.db.run(sql`UPDATE user_powers SET status = 'expired' WHERE user_id = ${userId} AND status = 'available'
        AND unused_expires_at IS NOT NULL AND unused_expires_at <= ${iso}`);
      await this.db.run(sql`UPDATE user_powers SET status = 'used' WHERE user_id = ${userId} AND status = 'active'
        AND expires_at IS NOT NULL AND expires_at <= ${iso}`);
    } else {
      await this.db.run(sql`UPDATE user_powers SET status = 'expired' WHERE status = 'available'
        AND unused_expires_at IS NOT NULL AND unused_expires_at <= ${iso}`);
      await this.db.run(sql`UPDATE user_powers SET status = 'used' WHERE status = 'active'
        AND expires_at IS NOT NULL AND expires_at <= ${iso}`);
    }
  }

  async listInventory(userId: string, now = Date.now()): Promise<InventoryRow[]> {
    await this.expireItems(userId, now);
    const since = new Date(now - 14 * 24 * 3600 * 1000).toISOString();
    const rows = await this.db.all<Row>(sql`SELECT * FROM user_powers WHERE user_id = ${userId}
      AND (status IN ('available', 'active', 'owned') OR created_at >= ${since})
      ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'available' THEN 1 WHEN 'owned' THEN 2 ELSE 3 END, created_at DESC LIMIT 100`);
    return rows.map(toInventory);
  }

  async getInventoryItem(id: string): Promise<InventoryRow | null> {
    const rows = await this.db.all<Row>(sql`SELECT * FROM user_powers WHERE id = ${id}`);
    return rows[0] ? toInventory(rows[0]) : null;
  }

  /** available -> active (with an end time for timed effects). Returns false if it wasn't available. */
  async activateItem(id: string, activeUntil: string | null, metadata: any = null, now = Date.now()): Promise<boolean> {
    const iso = new Date(now).toISOString();
    await this.db.run(sql`UPDATE user_powers SET status = 'active', activated_at = ${iso}, expires_at = ${activeUntil},
      metadata = ${metadata === null ? null : JSON.stringify(metadata)} WHERE id = ${id} AND status = 'available'`);
    const rows = await this.db.all<Row>(sql`SELECT status, activated_at FROM user_powers WHERE id = ${id}`);
    return rows[0]?.status === 'active' && rows[0]?.activated_at === iso;
  }

  /** available/active -> used. */
  async consumeItems(ids: string[], now = Date.now()): Promise<void> {
    if (ids.length === 0) return;
    const iso = new Date(now).toISOString();
    await this.db.run(sql.join([
      sql`UPDATE user_powers SET status = 'used', used_at = ${iso} WHERE status IN ('available', 'active') AND id IN (`,
      sql.join(ids.map((id) => sql`${id}`), sql`, `),
      sql`)`,
    ], sql``));
  }

  /** Active effects of users (timed effects still running, next-run items waiting). */
  async activeEffects(userIds: string[], now = Date.now()): Promise<Array<{ id: string; userId: string; itemId: string; metadata: any; activatedAt: string | null }>> {
    if (userIds.length === 0) return [];
    const iso = new Date(now).toISOString();
    const rows = await this.db.all<Row>(sql.join([
      sql`SELECT id, user_id, power_type, metadata, activated_at FROM user_powers WHERE status = 'active' AND (expires_at IS NULL OR expires_at > ${iso}) AND user_id IN (`,
      sql.join([...new Set(userIds)].map((id) => sql`${id}`), sql`, `),
      sql`)`,
    ], sql``));
    return rows.map((r) => ({ id: r.id, userId: r.user_id, itemId: r.power_type, metadata: parseJson(r.metadata, null), activatedAt: r.activated_at ?? null }));
  }

  /** Active sabotages aimed at a user (metadata.targetUserId), still running. */
  async sabotagesAgainst(userId: string, now = Date.now()): Promise<Array<{ id: string; userId: string }>> {
    const iso = new Date(now).toISOString();
    const rows = await this.db.all<Row>(sql`SELECT id, user_id FROM user_powers WHERE power_type = 'sabotage' AND status = 'active'
      AND (expires_at IS NULL OR expires_at > ${iso}) AND json_extract(metadata, '$.targetUserId') = ${userId}`);
    return rows.map((r) => ({ id: r.id, userId: r.user_id }));
  }

  async availableItemOfType(userId: string, itemId: string, now = Date.now()): Promise<InventoryRow | null> {
    await this.expireItems(userId, now);
    const rows = await this.db.all<Row>(sql`SELECT * FROM user_powers WHERE user_id = ${userId} AND power_type = ${itemId} AND status = 'available'
      ORDER BY created_at ASC LIMIT 1`);
    return rows[0] ? toInventory(rows[0]) : null;
  }

  async ownedCosmetics(userId: string): Promise<Set<string>> {
    const rows = await this.db.all<Row>(sql`SELECT power_type FROM user_powers WHERE user_id = ${userId} AND status = 'owned'`);
    return new Set(rows.map((r) => r.power_type));
  }

  // ─── Challenges ───────────────────────────────────────────────────────────

  async getChallenges(userId: string, cycleNumber: number): Promise<ChallengeRow[]> {
    const rows = await this.db.all<Row>(sql`SELECT * FROM user_challenges WHERE user_id = ${userId} AND cycle_number = ${cycleNumber} ORDER BY created_at ASC, type ASC`);
    return rows.map(toChallenge);
  }

  async createChallenge(data: { userId: string; cycleNumber: number; type: string; target: number; rewardRarity: string }): Promise<void> {
    await this.db.run(sql`INSERT OR IGNORE INTO user_challenges (id, user_id, cycle_number, type, target, progress, status, reward_rarity, data, created_at)
      VALUES (${newId()}, ${data.userId}, ${data.cycleNumber}, ${data.type}, ${data.target}, 0, 'active', ${data.rewardRarity}, '{}', ${nowIso()})`);
  }

  async updateChallenge(id: string, data: { progress: number; data: any; status?: 'completed'; rewardItem?: string | null }): Promise<boolean> {
    if (data.status === 'completed') {
      // Only one caller completes it: the WHERE makes it atomic, the token tells who won
      const token = `${nowIso()}#${newId()}`;
      await this.db.run(sql`UPDATE user_challenges SET progress = ${data.progress}, data = ${JSON.stringify(data.data)}, status = 'completed',
        completed_at = ${token}, reward_item = ${data.rewardItem ?? null} WHERE id = ${id} AND status = 'active'`);
      const rows = await this.db.all<Row>(sql`SELECT completed_at FROM user_challenges WHERE id = ${id}`);
      const won = rows[0]?.completed_at === token;
      if (won) await this.db.run(sql`UPDATE user_challenges SET completed_at = ${token.split('#')[0]} WHERE id = ${id}`);
      return won;
    }
    await this.db.run(sql`UPDATE user_challenges SET progress = ${data.progress}, data = ${JSON.stringify(data.data)} WHERE id = ${id} AND status = 'active'`);
    return true;
  }

  async setChallengeReward(id: string, rewardItem: string): Promise<void> {
    await this.db.run(sql`UPDATE user_challenges SET reward_item = ${rewardItem} WHERE id = ${id}`);
  }

  // ─── Chests ───────────────────────────────────────────────────────────────

  async countChestsSpawnedSince(cityKey: string, sinceIso: string): Promise<number> {
    const rows = await this.db.all<Row>(sql`SELECT COUNT(*) AS n FROM treasures WHERE city_key = ${cityKey} AND spawned_at >= ${sinceIso}`);
    return Number(rows[0]?.n ?? 0);
  }

  async createChest(data: { competitionId: string; name: string; itemId: string; rarity: string; lat: number; lng: number; expiresAt: string; zone: string; hidden: boolean; cityKey: string }): Promise<string> {
    const id = newId();
    await this.db.run(sql`INSERT INTO treasures (id, competition_id, name, power_type, rarity, lat, lng, spawned_at, expires_at, active, zone, hidden, city_key)
      VALUES (${id}, ${data.competitionId}, ${data.name}, ${data.itemId}, ${data.rarity}, ${data.lat}, ${data.lng}, ${nowIso()}, ${data.expiresAt}, 1,
        ${data.zone}, ${data.hidden ? 1 : 0}, ${data.cityKey})`);
    return id;
  }

  async activeChests(now = Date.now()): Promise<Row[]> {
    const iso = new Date(now).toISOString();
    return this.db.all<Row>(sql`SELECT * FROM treasures WHERE active = 1 AND collected_by IS NULL AND expires_at > ${iso} AND city_key IS NOT NULL`);
  }

  /** Atomically claims a chest; true if this user got it. */
  async claimChest(chestId: string, userId: string): Promise<boolean> {
    await this.db.run(sql`UPDATE treasures SET collected_by = ${userId}, collected_at = ${nowIso()}, active = 0
      WHERE id = ${chestId} AND collected_by IS NULL AND active = 1`);
    const rows = await this.db.all<Row>(sql`SELECT collected_by FROM treasures WHERE id = ${chestId}`);
    return rows[0]?.collected_by === userId;
  }

  async expireChests(beforeIso: string): Promise<void> {
    await this.db.run(sql`UPDATE treasures SET active = 0 WHERE active = 1 AND collected_by IS NULL AND expires_at <= ${beforeIso}`);
  }

  /**
   * Club cities: club members with a home location grouped by city (centre = mean of their homes,
   * so no single home is exposed). Members without a city are grouped by ~10 km grid cell.
   */
  async clubMemberCities(): Promise<Array<{ cityKey: string; city: string; lat: number; lng: number; members: number; memberIds: string[] }>> {
    const rows = await this.db.all<Row>(sql`SELECT u.id, u.country_code, u.city, u.home_lat, u.home_lng
      FROM club_members m JOIN users u ON u.id = m.user_id
      WHERE u.home_lat IS NOT NULL AND u.home_lng IS NOT NULL`);
    type CityGroup = { city: string; lats: number[]; lngs: number[]; memberIds: string[] };
    const groups = new Map<string, CityGroup>();
    for (const r of rows) {
      const lat = Number(r.home_lat);
      const lng = Number(r.home_lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const key = cityKeyOf(r.country_code, r.city, lat, lng);
      const group: CityGroup = groups.get(key) ?? { city: r.city || 'Tu zona', lats: [], lngs: [], memberIds: [] };
      group.lats.push(lat);
      group.lngs.push(lng);
      group.memberIds.push(r.id);
      groups.set(key, group);
    }
    return [...groups.entries()].map(([cityKey, g]) => ({
      cityKey,
      city: g.city,
      lat: g.lats.reduce((a, b) => a + b, 0) / g.lats.length,
      lng: g.lngs.reduce((a, b) => a + b, 0) / g.lngs.length,
      members: g.memberIds.length,
      memberIds: g.memberIds,
    }));
  }

  // ─── Account deletion ─────────────────────────────────────────────────────

  /**
   * Removes a user's game data before their account is deleted. A club they own passes to an admin
   * (or the oldest member); an empty club is deleted.
   */
  async removeUserGameData(userId: string): Promise<void> {
    const membership = await this.getMembership(userId);
    if (membership) {
      if (membership.role === 'owner') {
        const others = (await this.getClubMembers(membership.clubId)).filter((m) => m.userId !== userId);
        if (others.length === 0) {
          await this.deleteClub(membership.clubId);
        } else {
          const heir = others.find((m) => m.role === 'admin')
            ?? [...others].sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))[0];
          await this.setMemberRole(membership.clubId, heir.userId, 'owner');
          await this.updateClub(membership.clubId, { ownerId: heir.userId });
          await this.removeMember(membership.clubId, userId);
        }
      } else {
        await this.removeMember(membership.clubId, userId);
      }
    }
    for (const statement of [
      sql`DELETE FROM club_requests WHERE user_id = ${userId}`,
      sql`DELETE FROM competition_participants WHERE user_id = ${userId}`,
      sql`DELETE FROM user_challenges WHERE user_id = ${userId}`,
      sql`DELETE FROM global_area_events WHERE user_id = ${userId}`,
      sql`DELETE FROM global_territories WHERE user_id = ${userId}`,
      sql`DELETE FROM user_powers WHERE user_id = ${userId}`,
      sql`UPDATE treasures SET collected_by = NULL WHERE collected_by = ${userId}`,
      sql`DELETE FROM user_nicknames WHERE target_user_id = ${userId} OR set_by_user_id = ${userId}`,
      sql`DELETE FROM territory_fortifications WHERE user_id = ${userId}`,
      sql`DELETE FROM competition_stats WHERE user_id = ${userId}`,
    ]) {
      try {
        await this.db.run(statement);
      } catch {
        /* table not created yet */
      }
    }
  }

  // ─── Reset of the old game (one time) ─────────────────────────────────────

  /**
   * Starts the new game from zero: removes every run and everything derived from it (territories,
   * feed, metrics, powers, chests, global map) and marks imported activities as "before season"
   * so they are never imported again. Users, friends, clubs and integrations are kept.
   */
  async resetForNewSeason(): Promise<{ routes: number }> {
    const count = await this.db.all<Row>(sql`SELECT COUNT(*) AS n FROM routes`);
    const optional = [
      sql`DELETE FROM feed_reactions`,
      sql`DELETE FROM feed_comments`,
      sql`DELETE FROM feed_events`,
      sql`DELETE FROM conquest_metrics`,
      sql`DELETE FROM ephemeral_photos`,
      sql`DELETE FROM territory_loss_notifications`,
      sql`DELETE FROM user_nicknames`,
      sql`DELETE FROM user_powers`,
      sql`DELETE FROM treasures`,
      sql`DELETE FROM competition_stats`,
      sql`DELETE FROM weekly_summaries`,
      sql`DELETE FROM territory_fortifications`,
      sql`UPDATE competitions SET status = 'finished'`,
      sql`DELETE FROM territories`,
      sql`DELETE FROM global_area_events`,
      sql`DELETE FROM global_territories`,
      sql`DELETE FROM user_challenges`,
      sql`UPDATE polar_activities SET processed = 1, route_id = NULL, territory_id = NULL, skip_reason = 'before_season'`,
      sql`UPDATE strava_activities SET processed = 1, route_id = NULL, territory_id = NULL`,
      sql`UPDATE coros_activities SET processed = 1, route_id = NULL, territory_id = NULL, skip_reason = 'before_season'`,
      sql`UPDATE suunto_activities SET status = 'skipped', processed = 1, route_id = NULL, skip_reason = 'before_season'`,
      sql`UPDATE garmin_activities SET status = 'skipped', processed = 1, route_id = NULL, skip_reason = 'before_season'`,
      sql`DELETE FROM routes`,
      sql`UPDATE users SET total_area = 0, global_area = 0, global_bonus_area = 0, streak_days = 0, streak_last_date = NULL`,
    ];
    for (const statement of optional) {
      try {
        await this.db.run(statement);
      } catch (error) {
        console.warn('[SEASON RESET] Statement skipped:', String(error).slice(0, 200));
      }
    }
    return { routes: Number(count[0]?.n ?? 0) };
  }
}
