// Competition engine: starts and finishes the club competitions of each cycle, matchmaking for club
// duels, scoring, rewards, Elo/league points, the competition-map reset, rest-phase chests and
// challenges. Driven by the cron task "season-tick" (every 5 minutes, idempotent).
import {
  MODE_INFO,
  TARGET_AREA_PER_PARTICIPANT_M2,
  DUEL_PER_RUNNER_CAP_M2,
  ACTIVE_WINDOW_DAYS,
  MIN_ACTIVE_FOR_DUEL,
  ELO_K,
  LATE_JOIN_HOURS,
  CHALLENGES,
  CHALLENGES_PER_REST,
  ITEMS,
  RARITY_INFO,
  pickRewardItem,
  pickRarity,
  type CompetitionMode,
  type Rarity,
  type ChallengeType,
} from '../../shared/game';
import { cycleAt, cycleBounds, isRestLike, localDate, localHour, localMidnight, restWindow, inLateJoinWindow, type CycleInfo } from './cycles';
import { GameStorage, setRunsCountFrom, runsCountFromMs, type CompetitionRow, type ParticipantRow } from './gameStorage';
import { haversineMeters } from './antiCheat';
import type { WorkerStorage } from './storage';

// ─── Pure helpers ────────────────────────────────────────────────────────────

/** Deterministic pseudo-random generator (mulberry32) from a string seed. */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let state = h >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Splits participants into two balanced teams: snake draft by strength (recent global area),
 * strongest first: A B B A A B B A ... Ties broken by id so it is deterministic.
 */
export function assignTeams(players: Array<{ userId: string; strength: number }>): Map<string, 0 | 1> {
  const sorted = [...players].sort((a, b) => b.strength - a.strength || a.userId.localeCompare(b.userId));
  const teams = new Map<string, 0 | 1>();
  sorted.forEach((p, i) => {
    const round = Math.floor(i / 2);
    const first = i % 2 === 0;
    const team: 0 | 1 = round % 2 === 0 ? (first ? 0 : 1) : (first ? 1 : 0);
    teams.set(p.userId, team);
  });
  return teams;
}

/** The mode a club plays this cycle, given the cycle's mode and how many members can take part. */
export function modeForClub(cycleMode: CompetitionMode, participants: number, duelPaired: boolean): CompetitionMode {
  if (cycleMode === 'duel') return duelPaired ? 'duel' : 'target';
  if (cycleMode === 'teams' && participants < MODE_INFO.teams.minParticipants) {
    return participants >= MODE_INFO.ffa.minParticipants ? 'ffa' : 'target';
  }
  if (cycleMode === 'ffa' && participants < MODE_INFO.ffa.minParticipants) return 'target';
  return cycleMode;
}

export interface MatchCandidate {
  id: string;
  rating: number;
  /** Members who ran in the last ACTIVE_WINDOW_DAYS */
  active: number;
}

/** Matchmaking windows, from strict to loose: rating difference and size ratio. */
export const MATCH_WINDOWS = [
  { rating: 150, size: 0.3 },
  { rating: 300, size: 0.5 },
  { rating: 450, size: 0.7 },
];

/**
 * Pairs clubs for duels: similar rating (Elo) and similar number of active runners, avoiding the
 * last opponents when possible, choosing randomly among the best candidates. Clubs left without a
 * fair rival get a "bye" (they play "Objetivo común" instead).
 */
export function pairClubs(
  clubs: MatchCandidate[],
  recentOpponents: Map<string, string[]>,
  random: () => number,
): { pairs: Array<[string, string]>; byes: string[] } {
  const pool = clubs.filter((c) => c.active >= MIN_ACTIVE_FOR_DUEL).sort((a, b) => b.rating - a.rating || a.id.localeCompare(b.id));
  const byes = clubs.filter((c) => c.active < MIN_ACTIVE_FOR_DUEL).map((c) => c.id);
  const paired = new Set<string>();
  const pairs: Array<[string, string]> = [];

  const sizeOk = (a: MatchCandidate, b: MatchCandidate, tolerance: number) =>
    Math.min(a.active, b.active) / Math.max(a.active, b.active) >= 1 - tolerance;
  const cost = (a: MatchCandidate, b: MatchCandidate) =>
    Math.abs(a.rating - b.rating) / 150 + Math.abs(Math.log(a.active / b.active)) / Math.log(1.3);

  const loosest = MATCH_WINDOWS[MATCH_WINDOWS.length - 1];
  const freshOptions = (club: MatchCandidate) => {
    const recent = new Set(recentOpponents.get(club.id) ?? []);
    return pool.filter((other) => other.id !== club.id && !paired.has(other.id) && !recent.has(other.id)
      && Math.abs(other.rating - club.rating) <= loosest.rating && sizeOk(club, other, loosest.size)).length;
  };

  // Most constrained club first (fewest fair rivals it hasn't just played), so an easy-to-pair club
  // doesn't take the only fresh rival of another one
  const unpairable = new Set<string>();
  for (;;) {
    const remaining = pool.filter((c) => !paired.has(c.id) && !unpairable.has(c.id));
    if (remaining.length < 2) break;
    const club = remaining
      .map((c) => ({ c, options: freshOptions(c) }))
      .sort((a, b) => a.options - b.options || b.c.rating - a.c.rating || a.c.id.localeCompare(b.c.id))[0].c;
    const recent = new Set(recentOpponents.get(club.id) ?? []);
    let chosen: MatchCandidate | null = null;
    for (const allowRecent of [false, true]) {
      for (const window of MATCH_WINDOWS) {
        const candidates = pool.filter((other) =>
          other.id !== club.id && !paired.has(other.id)
          && (allowRecent || !recent.has(other.id))
          && Math.abs(other.rating - club.rating) <= window.rating
          && sizeOk(club, other, window.size),
        ).sort((a, b) => cost(club, a) - cost(club, b));
        if (candidates.length > 0) {
          const top = candidates.slice(0, 3);
          chosen = top[Math.floor(random() * top.length) % top.length];
          break;
        }
      }
      if (chosen) break;
    }
    if (chosen) {
      paired.add(club.id);
      paired.add(chosen.id);
      pairs.push([club.id, chosen.id]);
    } else {
      unpairable.add(club.id); // no fair rival at all: bye
    }
  }
  for (const club of pool) if (!paired.has(club.id)) byes.push(club.id);
  return { pairs, byes };
}

/** Elo rating change for club A (B gets the opposite). resultA: 1 win, 0.5 draw, 0 loss. */
export function eloDelta(ratingA: number, ratingB: number, resultA: 0 | 0.5 | 1, k = ELO_K): number {
  const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  return k * (resultA - expectedA);
}

/** Duel score of a club: the N best runners, each capped. */
export function duelScore(scores: number[], runnersCounted: number, cap = DUEL_PER_RUNNER_CAP_M2): number {
  return [...scores]
    .map((s) => Math.max(0, Math.min(cap, s)))
    .sort((a, b) => b - a)
    .slice(0, Math.max(0, runnersCounted))
    .reduce((sum, s) => sum + s, 0);
}

/** Target area of "Objetivo común" for a number of participants. */
export function targetArea(participants: number): number {
  return Math.max(1, participants) * TARGET_AREA_PER_PARTICIPANT_M2;
}

/** Score of a participant on the competition map (area plus bonuses/penalties). */
export function participantScore(p: Pick<ParticipantRow, 'area' | 'bonus'>): number {
  return Math.max(0, p.area + p.bonus);
}

/** Picks CHALLENGES_PER_REST distinct challenges for a user and cycle (deterministic). */
export function pickChallenges(userId: string, cycleNumber: number): ChallengeType[] {
  const random = seededRandom(`challenges:${userId}:${cycleNumber}`);
  const types = Object.keys(CHALLENGES) as ChallengeType[];
  const shuffled = [...types].sort((a, b) => a.localeCompare(b));
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, CHALLENGES_PER_REST);
}

// ─── Notifications ───────────────────────────────────────────────────────────

export async function notifyUsers(storage: WorkerStorage, env: any, userIds: string[], payload: { title: string; body: string; tag: string; data: Record<string, unknown> }): Promise<void> {
  if (!env || userIds.length === 0) return;
  try {
    const { sendPushToUser } = await import('./pushHelper');
    const wanted = new Set(userIds);
    // One query for everybody's subscriptions (instead of one per user)
    const byUser = new Map<string, Array<{ endpoint: string; p256dh: string; auth: string }>>();
    const all = wanted.size > 3 ? await storage.getAllPushSubscriptions() : [];
    for (const sub of all) {
      if (!wanted.has(sub.userId)) continue;
      const list = byUser.get(sub.userId) ?? [];
      list.push(sub);
      byUser.set(sub.userId, list);
    }
    for (const userId of [...wanted].slice(0, 500)) {
      try {
        const subs = wanted.size > 3 ? (byUser.get(userId) ?? []) : await storage.getPushSubscriptionsByUserId(userId);
        if (subs.length === 0) continue;
        await sendPushToUser(
          subs.map((s) => ({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } })),
          payload,
          env.VAPID_PUBLIC_KEY || '',
          env.VAPID_PRIVATE_KEY || '',
          env.VAPID_SUBJECT || 'mailto:notifications@runna.io',
        );
      } catch (_) { /* best effort */ }
    }
  } catch (error) {
    console.error('[SEASON] Notification error:', error);
  }
}

function km2(m2: number): string {
  return `${(m2 / 1e6).toFixed(2).replace('.', ',')} km²`;
}

// ─── One-time reset ──────────────────────────────────────────────────────────

export const SEASON_RESET_KEY = 'season_v2_reset';

/** Runs the "start from zero" reset once (the first time the new code runs). */
export async function ensureSeasonReset(game: GameStorage, now = Date.now()): Promise<boolean> {
  if (await game.getSetting(SEASON_RESET_KEY)) return false;
  const lockKey = `${SEASON_RESET_KEY}_lock`;
  if (!(await game.claimSetting(lockKey, String(now)))) return false;
  let result: { routes: number };
  try {
    result = await game.resetForNewSeason();
  } catch (error) {
    await game.deleteSetting(lockKey); // the next tick tries again
    throw error;
  }
  const at = new Date(now).toISOString();
  await game.setSetting('season_reset_at', at);
  await game.setSetting(SEASON_RESET_KEY, JSON.stringify({ at, deletedRoutes: result.routes }));
  setRunsCountFrom(now);
  console.log(`[SEASON] Reset for the new season done: ${result.routes} old runs removed`);
  return true;
}

// ─── Starting a competition ──────────────────────────────────────────────────

const ACTIVE_WINDOW_MS = ACTIVE_WINDOW_DAYS * 24 * 3600 * 1000;

interface ClubSnapshot {
  id: string;
  name: string;
  rating: number;
  members: string[];
  /** Ran in the last ACTIVE_WINDOW_DAYS: matchmaking of duels and their N */
  active: Set<string>;
  /** Take part in the competition: the active members (everyone while the season is young) */
  players: Set<string>;
}

/**
 * The season (the reset that started it) is younger than the activity window: nobody can have 14
 * days of runs yet, so inactivity doesn't apply and every member takes part.
 */
export function isYoungSeason(now: number): boolean {
  return runsCountFromMs() > now - ACTIVE_WINDOW_MS;
}

/** Who of `members` takes part in a competition starting at `now`. */
async function playersOf(game: GameStorage, members: string[], now: number): Promise<{ active: Set<string>; players: Set<string> }> {
  const active = await game.activeUserIds(members, new Date(now - ACTIVE_WINDOW_MS).toISOString());
  return { active, players: isYoungSeason(now) ? new Set(members) : active };
}

async function snapshotClubs(game: GameStorage, now: number): Promise<ClubSnapshot[]> {
  const clubs = await game.getAllClubs();
  const result: ClubSnapshot[] = [];
  for (const club of clubs) {
    const members = await game.getClubMemberIds(club.id);
    if (members.length === 0) continue;
    result.push({ id: club.id, name: club.name, rating: club.rating, members, ...(await playersOf(game, members, now)) });
  }
  return result;
}

/**
 * Creates the competition of one club (not a duel). Only ACTIVE members (who ran in the last
 * ACTIVE_WINDOW_DAYS) take part; the mode and the target are decided with them. The others are told
 * by notifyInactive and, in modes that allow it, enter with their first run (ensureParticipantOnRun).
 */
async function createInternalCompetition(game: GameStorage, info: CycleInfo, club: ClubSnapshot, cycleMode: CompetitionMode, now: number): Promise<CompetitionRow | null> {
  const players = club.members.filter((id) => club.players.has(id));
  const mode = modeForClub(cycleMode === 'duel' ? 'duel' : cycleMode, players.length, false);
  const config: Record<string, unknown> = { cycleMode };
  if (mode === 'target') config.target = targetArea(players.length);
  let teams: Map<string, 0 | 1> | null = null;
  if (mode === 'teams') {
    const strength = await game.globalGainByUsers(players, new Date(now - 28 * 24 * 3600 * 1000).toISOString(), new Date(now).toISOString());
    teams = assignTeams(players.map((userId) => ({ userId, strength: strength.get(userId) ?? 0 })));
    config.teamNames = ['Equipo Sol', 'Equipo Luna'];
  }
  const competition = await game.createCompetition({ cycleNumber: info.number, clubId: club.id, mode, config });
  if (!competition) return null;
  for (const userId of players) await game.addParticipant(competition.id, userId, teams ? teams.get(userId) ?? 0 : null);
  return competition;
}

/** Push to the members left out for inactivity: whether (and how) they can still enter. */
async function notifyInactive(storage: WorkerStorage, env: any, club: ClubSnapshot, mode: CompetitionMode, info: CycleInfo): Promise<number> {
  const inactive = club.members.filter((id) => !club.players.has(id));
  if (inactive.length === 0) return 0;
  const modeInfo = MODE_INFO[mode];
  const entry = modeInfo?.lateEntry ?? 'open';
  const body = entry === 'none'
    ? `Esta ronda es ${modeInfo.name} y los equipos ya están cerrados. Vuelve a correr y entrarás en la próxima competición.`
    : entry === 'until_first_cut'
      ? `Si corres en las primeras 48 horas, entras en la ${modeInfo.name}. Después ya no se puede entrar.`
      : 'Con tu primera carrera entras automáticamente.';
  await notifyUsers(storage, env, inactive, {
    title: `😴 No participas en la competición de ${club.name}`,
    body: `No has corrido en los últimos ${ACTIVE_WINDOW_DAYS} días. ${body}`,
    tag: `season-inactive-${info.number}`,
    data: { type: 'season_inactive', cycle: info.number, clubId: club.id },
  });
  return inactive.length;
}

/**
 * Starts cycle `info.number`: wipes the competition map, pairs clubs for duels (when the cycle's
 * mode is "duel") and creates one competition per club with all its members as participants.
 */
export async function startCycle(storage: WorkerStorage, game: GameStorage, env: any, info: CycleInfo, now = Date.now()): Promise<{ competitions: number; duels: number; inactive: number }> {
  // A retried start (after a failure) must not wipe what was conquered since the first attempt
  const cycleRow = await game.getCycle(info.number);
  if (!cycleRow || cycleRow.status !== 'competition') {
    await game.resetCompetitionMap();
    await game.upsertCycle(info.number, { status: 'competition', startedAt: new Date(now).toISOString() });
  }
  const existing = new Set((await game.getCompetitionsOfCycle(info.number)).map((c) => c.clubId));
  const clubs = (await snapshotClubs(game, now)).filter((c) => !existing.has(c.id));
  let duels = 0;
  let competitions = 0;
  const handled = new Set<string>();

  if (info.mode === 'duel') {
    const recent = await game.recentOpponents(3);
    const { pairs } = pairClubs(
      clubs.map((c) => ({ id: c.id, rating: c.rating, active: c.active.size })),
      recent,
      seededRandom(`duel:${info.number}`),
    );
    const byId = new Map(clubs.map((c) => [c.id, c]));
    for (const [aId, bId] of pairs) {
      const a = byId.get(aId)!;
      const b = byId.get(bId)!;
      const runnersCounted = Math.min(a.active.size, b.active.size);
      const matchId = await game.createMatch({ cycleNumber: info.number, clubA: a.id, clubB: b.id, runnersCounted });
      for (const [self, other] of [[a, b], [b, a]] as const) {
        const competition = await game.createCompetition({
          cycleNumber: info.number, clubId: self.id, mode: 'duel', opponentClubId: other.id, matchId,
          config: { cycleMode: 'duel', runnersCounted, perRunnerCap: DUEL_PER_RUNNER_CAP_M2 },
        });
        if (competition) {
          competitions++;
          for (const userId of self.members) if (self.players.has(userId)) await game.addParticipant(competition.id, userId, null);
        }
        handled.add(self.id);
      }
      duels++;
    }
  }

  for (const club of clubs) {
    if (handled.has(club.id)) continue;
    if (await createInternalCompetition(game, info, club, info.mode, now)) competitions++;
  }

  // Tell each club's members: the participants that it starts (with their club's actual mode), the
  // inactive ones that they don't take part and whether they can still enter
  let inactive = 0;
  for (const club of clubs) {
    const competition = await game.getClubCompetition(club.id, info.number);
    if (!competition) continue;
    const mode = competition.mode as CompetitionMode;
    const modeInfo = MODE_INFO[mode] ?? MODE_INFO[info.mode];
    const players = club.members.filter((id) => club.players.has(id));
    await notifyUsers(storage, env, players, {
      title: `${modeInfo.emoji} ¡Empieza la competición!`,
      body: `Modo de esta ronda: ${modeInfo.name}. El mapa de competición empieza de cero. Tienes 10 días.`,
      tag: `season-start-${info.number}`,
      data: { type: 'season_competition_started', cycle: info.number },
    });
    inactive += await notifyInactive(storage, env, club, mode, info);
  }
  console.log(`[SEASON] Cycle ${info.number} started: ${competitions} competitions, ${duels} duels, ${inactive} inactive members left out`);
  return { competitions, duels, inactive };
}

/**
 * Clubs created (or that grew) during the first hours of a competition get one too; members who
 * joined a club during that window are added to its competition. Called by the tick.
 */
export async function lateJoinCompetitions(game: GameStorage, info: CycleInfo, now = Date.now()): Promise<number> {
  if (!inLateJoinWindow(info, now)) return 0;
  const clubs = await snapshotClubs(game, now);
  let created = 0;
  for (const club of clubs) {
    const existing = await game.getClubCompetition(club.id, info.number);
    if (!existing) {
      if (await createInternalCompetition(game, info, club, lateClubCycleMode(info.mode), now)) created++;
    }
  }
  return created;
}

/** A club born during the first 48 h of a club-against-club cycle can't be paired any more: "Objetivo común". */
export function lateClubCycleMode(mode: CompetitionMode): CompetitionMode {
  return mode === 'duel' ? 'target' : mode;
}

/** What happened to a member's entry into their club's running competition. */
export type CompetitionEntry =
  | 'participant' // already taking part
  | 'joined' // entered now
  | 'on_first_run' // can enter, with their first run (inactive)
  | 'closed_entry' // the mode doesn't let anyone in any more (team against team, or after the first cut)
  | 'next_cycle' // joined the club after the first 48 h: competes from the next competition
  | 'none'; // no running competition for their club

/** Whether a competition still lets someone in at `time` (see MODE_INFO.lateEntry). */
export function lateEntryOpen(competition: CompetitionRow, info: CycleInfo, time: number): boolean {
  const entry = MODE_INFO[competition.mode as CompetitionMode]?.lateEntry ?? 'open';
  if (entry === 'none') return false;
  if (entry === 'until_first_cut') {
    const firstCut = Date.parse(info.competitionStartsAt) + LATE_JOIN_HOURS * 60 * 60 * 1000;
    return time < firstCut && !(Array.isArray(competition.config?.cuts) && competition.config.cuts.length > 0);
  }
  return true;
}

/** Adds a participant, keeping the mode's rules: team balance, target of "Objetivo común". */
async function addLateParticipant(game: GameStorage, competition: CompetitionRow, userId: string, joinedAt: string): Promise<void> {
  let team: number | null = null;
  if (competition.mode === 'teams') {
    const participants = await game.getParticipants(competition.id);
    const sizes = [0, 0];
    for (const p of participants) if (p.team === 0 || p.team === 1) sizes[p.team]++;
    team = sizes[0] <= sizes[1] ? 0 : 1;
  }
  await game.addParticipant(competition.id, userId, team, joinedAt);
  if (competition.mode === 'target') {
    const count = (await game.getParticipants(competition.id)).length;
    await game.updateCompetition(competition.id, { config: { ...competition.config, target: targetArea(count) } });
  }
}

/**
 * A member who just joined a club (or created one) during the first 48 h of a competition. Active
 * members enter at once when the mode allows it; inactive ones enter with their first run.
 */
export async function joinRunningCompetition(game: GameStorage, clubId: string, userId: string, now = Date.now()): Promise<CompetitionEntry> {
  const info = cycleAt(now);
  if (info.phase !== 'competition') return 'none';
  if (!inLateJoinWindow(info, now)) return 'next_cycle';
  const active = (await playersOf(game, [userId], now)).players.has(userId);
  let competition = await game.getClubCompetition(clubId, info.number);
  if (!competition) {
    const club = await game.getClub(clubId);
    if (!club) return 'none';
    const members = await game.getClubMemberIds(clubId);
    competition = await createInternalCompetition(game, info, { id: club.id, name: club.name, rating: club.rating, members, ...(await playersOf(game, members, now)) }, lateClubCycleMode(info.mode), now);
    if (!competition) return 'none';
    return active ? 'joined' : 'on_first_run';
  }
  if (competition.status !== 'active') return 'none';
  if ((await game.getParticipants(competition.id)).some((p) => p.userId === userId)) return 'participant';
  if (!lateEntryOpen(competition, info, now)) return 'closed_entry';
  if (!active) return 'on_first_run';
  await addLateParticipant(game, competition, userId, new Date(now).toISOString());
  return 'joined';
}

/**
 * Called for every run that started during a competition (before its close): an inactive member who
 * runs enters their club's competition with this run, when the mode allows it (individual and
 * cooperative modes; Eliminación only before its first cut; never in team-against-team modes).
 * The participation starts at the run's start, so this run counts.
 */
export async function ensureParticipantOnRun(game: GameStorage, userId: string, info: CycleInfo, runStartedAt: number): Promise<CompetitionEntry> {
  const membership = await game.getMembership(userId);
  if (!membership) return 'none';
  const competition = await game.getClubCompetition(membership.clubId, info.number);
  if (!competition || competition.status !== 'active') return 'none';
  if ((await game.getParticipants(competition.id)).some((p) => p.userId === userId)) return 'participant';
  // Joined the club after the first 48 h: from the next competition (no club hopping mid-competition)
  const lateJoinLimit = Date.parse(info.competitionStartsAt) + LATE_JOIN_HOURS * 60 * 60 * 1000;
  const joinedClub = Date.parse(membership.joinedAt);
  if (Number.isFinite(joinedClub) && joinedClub > lateJoinLimit) return 'next_cycle';
  if (!lateEntryOpen(competition, info, runStartedAt)) return 'closed_entry';
  const from = Math.max(runStartedAt, Number.isFinite(joinedClub) ? joinedClub : runStartedAt);
  await addLateParticipant(game, competition, userId, new Date(from).toISOString());
  return 'joined';
}

// ─── Finishing a competition ─────────────────────────────────────────────────

interface Standing {
  userId: string;
  name: string;
  score: number;
  team: number | null;
  runs: number;
  areaStolen: number;
  distance: number;
  rank: number;
}

/** Standings from the participants' stored scores (frozen by finishCycle before anything else). */
async function standingsOf(game: GameStorage, competition: CompetitionRow): Promise<Standing[]> {
  const participants = await game.getParticipants(competition.id);
  const users = await game.getUserLite(participants.map((p) => p.userId));
  const sorted = participants
    .map((p) => ({
      userId: p.userId,
      name: users.get(p.userId)?.name ?? 'Corredor',
      score: participantScore(p),
      team: p.team,
      runs: p.runs,
      areaStolen: p.areaStolen,
      distance: p.distance,
      rank: 0,
    }))
    .sort((a, b) => b.score - a.score || b.runs - a.runs || a.userId.localeCompare(b.userId));
  sorted.forEach((s, i) => { s.rank = i + 1; });
  return sorted;
}

async function grantReward(game: GameStorage, userId: string, rarity: Rarity, competitionId: string, random: () => number): Promise<string> {
  const owned = await game.ownedCosmetics(userId);
  const itemId = pickRewardItem(rarity, random, owned);
  await game.grantItem(userId, itemId, 'reward', competitionId);
  return itemId;
}

/**
 * Scores a finished competition, gives rewards and league points, and stores the result.
 * Duels are scored together (both clubs' competitions) by finishDuel.
 */
async function finishInternal(storage: WorkerStorage, game: GameStorage, env: any, competition: CompetitionRow): Promise<void> {
  const standings = await standingsOf(game, competition);
  const random = seededRandom(`reward:${competition.id}`);
  const rewards: Record<string, string[]> = {};
  const give = async (userId: string, rarity: Rarity) => {
    const item = await grantReward(game, userId, rarity, competition.id, random);
    (rewards[userId] ??= []).push(item);
  };
  const ran = standings.filter((s) => s.runs > 0);
  const total = standings.reduce((sum, s) => sum + s.score, 0);
  const result: Record<string, unknown> = { mode: competition.mode, standings, total };
  let leaguePoints = ran.length * 2 >= Math.max(1, standings.length) ? 1 : 0;

  if (competition.mode === 'ffa') {
    for (const s of ran) await give(s.userId, s.rank === 1 ? 'legendary' : s.rank === 2 ? 'epic' : s.rank === 3 ? 'rare' : 'common');
    result.winnerUserId = ran[0]?.userId ?? null;
  } else if (competition.mode === 'teams') {
    const teamScores = [0, 0];
    for (const s of standings) if (s.team === 0 || s.team === 1) teamScores[s.team] += s.score;
    const winner = teamScores[0] === teamScores[1] ? null : teamScores[0] > teamScores[1] ? 0 : 1;
    result.teamScores = teamScores;
    result.winnerTeam = winner;
    for (const s of ran) await give(s.userId, winner === null ? 'rare' : s.team === winner ? 'epic' : 'common');
  } else if (competition.mode === 'target') {
    const target = Number(competition.config?.target) || targetArea(standings.length);
    const achieved = total >= target;
    result.target = target;
    result.achieved = achieved;
    if (achieved) {
      leaguePoints += 2;
      for (const s of ran) await give(s.userId, total >= target * 1.5 ? 'epic' : 'rare');
    } else {
      for (const s of ran) if (s.score > 0) await give(s.userId, 'common');
    }
  }
  // MVP of the club: an extra rare reward
  const mvp = ran[0];
  if (mvp && mvp.score > 0 && competition.mode !== 'ffa') {
    await give(mvp.userId, 'rare');
  }
  result.mvpUserId = mvp && mvp.score > 0 ? mvp.userId : null;
  result.rewards = rewards;
  result.leaguePoints = leaguePoints;

  for (const s of standings) await game.updateParticipant(competition.id, s.userId, { finalRank: s.rank });
  await game.adjustClubStanding(competition.clubId, 0, leaguePoints);
  await game.updateCompetition(competition.id, { status: 'finished', score: total, result, finishedAt: new Date().toISOString() });

  const modeInfo = MODE_INFO[competition.mode as CompetitionMode];
  for (const s of standings) {
    let body = `Has quedado ${s.rank}º de ${standings.length} con ${km2(s.score)}.`;
    if (competition.mode === 'target') body = result.achieved ? `¡Objetivo conseguido! El club sumó ${km2(total)}.` : `El club sumó ${km2(total)} de ${km2(Number(result.target))}.`;
    if (competition.mode === 'teams') body = result.winnerTeam === null ? '¡Empate entre equipos!' : result.winnerTeam === s.team ? '¡Tu equipo ha ganado!' : 'Tu equipo ha perdido esta vez.';
    await notifyUsers(storage, env, [s.userId], {
      title: `${modeInfo?.emoji ?? '🏁'} Fin de la competición`,
      body: `${body}${rewards[s.userId]?.length ? ' Tienes recompensas en tu inventario.' : ''}`,
      tag: `season-end-${competition.cycleNumber}`,
      data: { type: 'season_competition_finished', competitionId: competition.id },
    });
  }
}

async function finishDuel(storage: WorkerStorage, game: GameStorage, env: any, matchId: string): Promise<void> {
  const match = await game.getMatch(matchId);
  if (!match || match.status === 'finished') return;
  const compA = await game.getClubCompetition(match.club_a, Number(match.cycle_number));
  const compB = await game.getClubCompetition(match.club_b, Number(match.cycle_number));
  if (!compA || !compB) return;
  const runnersCounted = Number(match.runners_counted);
  const standingsA = await standingsOf(game, compA);
  const standingsB = await standingsOf(game, compB);
  const scoreA = duelScore(standingsA.map((s) => s.score), runnersCounted);
  const scoreB = duelScore(standingsB.map((s) => s.score), runnersCounted);
  const resultA: 0 | 0.5 | 1 = Math.abs(scoreA - scoreB) < 1 ? 0.5 : scoreA > scoreB ? 1 : 0;
  const clubs = await game.getClubsByIds([match.club_a, match.club_b]);
  const ratingA = clubs.get(match.club_a)?.rating ?? 1000;
  const ratingB = clubs.get(match.club_b)?.rating ?? 1000;
  const delta = eloDelta(ratingA, ratingB, resultA);
  const winnerClubId = resultA === 0.5 ? null : resultA === 1 ? match.club_a : match.club_b;
  await game.finishMatch(matchId, { scoreA, scoreB, winnerClubId, ratingChange: delta });
  await game.adjustClubStanding(match.club_a, delta, resultA === 1 ? 3 : resultA === 0.5 ? 1 : 0);
  await game.adjustClubStanding(match.club_b, -delta, resultA === 0 ? 3 : resultA === 0.5 ? 1 : 0);

  for (const [competition, standings, own, rival, result] of [
    [compA, standingsA, scoreA, scoreB, resultA],
    [compB, standingsB, scoreB, scoreA, (1 - resultA) as 0 | 0.5 | 1],
  ] as const) {
    const random = seededRandom(`reward:${competition.id}`);
    const rewards: Record<string, string[]> = {};
    for (const s of standings.filter((x) => x.runs > 0)) {
      const item = await grantReward(game, s.userId, result === 1 ? 'epic' : result === 0.5 ? 'rare' : 'common', competition.id, random);
      (rewards[s.userId] ??= []).push(item);
    }
    const opponent = clubs.get(competition.opponentClubId ?? '');
    const outcome = result === 1 ? 'won' : result === 0.5 ? 'draw' : 'lost';
    for (const s of standings) await game.updateParticipant(competition.id, s.userId, { finalRank: s.rank });
    await game.updateCompetition(competition.id, {
      status: 'finished',
      score: own,
      finishedAt: new Date().toISOString(),
      result: {
        mode: 'duel', standings, total: own, runnersCounted, perRunnerCap: DUEL_PER_RUNNER_CAP_M2,
        opponent: opponent ? { clubId: opponent.id, name: opponent.name, crest: opponent.crest, score: rival } : null,
        outcome, ratingChange: competition.clubId === match.club_a ? delta : -delta,
        leaguePoints: result === 1 ? 3 : result === 0.5 ? 1 : 0,
        mvpUserId: standings[0]?.score > 0 ? standings[0].userId : null,
        rewards,
      },
    });
    await notifyUsers(storage, env, standings.map((s) => s.userId), {
      title: outcome === 'won' ? '🏆 ¡Duelo ganado!' : outcome === 'draw' ? '🤝 Duelo empatado' : '⚔️ Duelo perdido',
      body: `Tu club ${km2(own)} – ${opponent?.name ?? 'rival'} ${km2(rival)}.`,
      tag: `season-end-${competition.cycleNumber}`,
      data: { type: 'season_competition_finished', competitionId: competition.id },
    });
  }
}

/** Finishes every active competition of cycle `number`, then wipes the competition map. */
export async function finishCycle(storage: WorkerStorage, game: GameStorage, env: any, number: number, at = Date.now()): Promise<number> {
  const competitions = (await game.getCompetitionsOfCycle(number)).filter((c) => c.status === 'active');
  // 1. Freeze every participant's area while the map still exists. If this run stops half-way
  //    (errors, subrequest limits), the next tick scores the rest from these frozen values.
  if (!(await game.getSetting(`season_frozen_${number}`))) {
    for (const competition of competitions) await game.syncParticipantAreas(competition.id);
    await game.setSetting(`season_frozen_${number}`, new Date().toISOString());
  }
  const doneMatches = new Set<string>();
  for (const competition of competitions) {
    try {
      if (competition.mode === 'duel' && competition.matchId) {
        if (doneMatches.has(competition.matchId)) continue;
        doneMatches.add(competition.matchId);
        await finishDuel(storage, game, env, competition.matchId);
      } else {
        await finishInternal(storage, game, env, competition);
      }
    } catch (error) {
      console.error(`[SEASON] Could not finish competition ${competition.id}:`, error);
    }
  }
  // 2. Wipe the map only when every competition of the cycle is scored (otherwise the next tick retries)
  const pending = (await game.getCompetitionsOfCycle(number)).filter((c) => c.status === 'active');
  if (pending.length > 0) {
    throw new Error(`${pending.length} competition(s) of cycle ${number} still to finish`);
  }
  // The next cycle may already be running if the cron was down for days: then its map is kept
  const current = cycleAt(at);
  if (!(current.phase === 'competition' && current.number > number)) {
    await game.resetCompetitionMap();
    await game.expirePendingCompetitionEffects();
  }
  await game.upsertCycle(number, { status: 'rest', endedAt: new Date().toISOString(), restStartedAt: new Date().toISOString() });
  console.log(`[SEASON] Cycle ${number} finished: ${competitions.length} competitions`);
  return competitions.length;
}

// ─── Rest phase: chests ──────────────────────────────────────────────────────

/** Chests a city gets per rest day, by the number of club members living there. */
export function chestsPerDay(members: number): number {
  return Math.min(8, 2 + Math.floor(members / 5));
}

/** Random point at `minM`..`maxM` metres from a centre. */
export function randomPointAround(lat: number, lng: number, minM: number, maxM: number, random: () => number): { lat: number; lng: number } {
  const distance = minM + (maxM - minM) * Math.sqrt(random());
  const angle = 2 * Math.PI * random();
  const dLat = (distance * Math.cos(angle)) / 111_320;
  const dLng = (distance * Math.sin(angle)) / (111_320 * Math.cos((lat * Math.PI) / 180));
  return { lat: lat + dLat, lng: lng + dLng };
}

/**
 * Spawns rest-phase chests around each city with club members, spread over the day (07:00-21:00
 * Madrid): at each tick a city gets a chest if it is behind its daily schedule.
 */
export async function spawnRestChests(storage: WorkerStorage, game: GameStorage, env: any, info: CycleInfo, now = Date.now()): Promise<number> {
  if (!isRestLike(info.phase)) return 0;
  const hour = localHour(now);
  if (hour < 7 || hour >= 21) return 0;
  const dayStart = localMidnight(localDate(now));
  const dayFraction = Math.min(1, (now - (dayStart + 7 * 3600 * 1000)) / (14 * 3600 * 1000));
  const restEnd = restWindow(info).end;
  let spawned = 0;
  for (const city of await game.clubMemberCities()) {
    const perDay = chestsPerDay(city.members);
    const due = Math.ceil(perDay * dayFraction);
    const already = await game.countChestsSpawnedSince(city.cityKey, new Date(dayStart).toISOString());
    if (already >= due || already >= perDay) continue;
    // `already` in the seed: two chests of the same day (or a retried tick with the same time) never
    // land on the same spot with the same item
    const random = seededRandom(`chest:${city.cityKey}:${now}:${already}`);
    const rarity = pickRarity(random);
    const itemId = pickRewardItem(rarity, random);
    const spot = randomPointAround(city.lat, city.lng, 300, 3000, random);
    const item = ITEMS[itemId];
    const expiresAt = new Date(Math.min(restEnd, now + 24 * 3600 * 1000)).toISOString();
    const hidden = random() < 0.2;
    await game.createChest({
      competitionId: `cycle-${info.number}`,
      name: `Cofre ${RARITY_INFO[rarity].label.toLowerCase()}`,
      itemId, rarity, lat: spot.lat, lng: spot.lng, expiresAt, zone: city.city, hidden, cityKey: city.cityKey,
    });
    spawned++;
    if (!hidden && (rarity === 'epic' || rarity === 'legendary')) {
      await notifyUsers(storage, env, city.memberIds, {
        title: `🗝️ ¡Cofre ${RARITY_INFO[rarity].label.toLowerCase()} en ${city.city}!`,
        body: `Contiene ${item?.emoji ?? '🎁'} ${item?.name ?? 'una recompensa'}. Pasa corriendo a menos de 250 m para abrirlo.`,
        tag: `chest-${city.cityKey}-${now}`,
        data: { type: 'chest_spawned' },
      });
    }
  }
  return spawned;
}

/** Collects the chests a run passes within 250 m of (club members, rest phase only). */
export async function collectChestsAlongRun(storage: WorkerStorage, game: GameStorage, userId: string, coords: Array<[number, number]>, routeId: string, now = Date.now()): Promise<Array<{ treasureId: string; treasureName: string; powerType: string; rarity: string; zone: string | null }>> {
  const collected: Array<{ treasureId: string; treasureName: string; powerType: string; rarity: string; zone: string | null }> = [];
  if (coords.length === 0) return collected;
  const chests = await game.activeChests(now);
  if (chests.length === 0) return collected;
  const effects = await game.activeEffects([userId], now);
  const canSeeHidden = effects.some((e) => e.itemId === 'reveal');
  const sample = coords.filter((_, i) => i % 3 === 0 || i === coords.length - 1);
  for (const chest of chests) {
    if (Number(chest.hidden) === 1 && !canSeeHidden) continue;
    const near = sample.some((p) => haversineMeters(p, [Number(chest.lat), Number(chest.lng)]) <= 250);
    if (!near) continue;
    if (!(await game.claimChest(chest.id, userId))) continue;
    const grant = await game.grantItem(userId, chest.power_type, 'chest', chest.id, now);
    collected.push({ treasureId: chest.id, treasureName: chest.name, powerType: chest.power_type, rarity: chest.rarity, zone: chest.zone ?? null });
    try {
      await storage.createFeedEvent({
        userId,
        eventType: 'treasure_found',
        routeId,
        metadata: JSON.stringify({
          treasureId: chest.id, treasureName: ITEMS[chest.power_type]?.name ?? chest.name, powerType: chest.power_type,
          rarity: chest.rarity, zone: chest.zone ?? null, emoji: ITEMS[chest.power_type]?.emoji ?? '🎁',
          discarded: grant.discarded,
        }),
      });
    } catch (_) { /* feed is best effort */ }
  }
  return collected;
}

// ─── Rest phase: challenges ──────────────────────────────────────────────────

/** Creates the user's challenges of the current rest phase if they don't have them yet. */
export async function ensureChallenges(game: GameStorage, userId: string, info: CycleInfo): Promise<void> {
  if (!isRestLike(info.phase)) return;
  const existing = await game.getChallenges(userId, info.number);
  if (existing.length > 0) return;
  for (const type of pickChallenges(userId, info.number)) {
    const def = CHALLENGES[type];
    await game.createChallenge({ userId, cycleNumber: info.number, type, target: def.target, rewardRarity: def.reward });
  }
}

export interface RunFacts {
  startedAt: string;
  distance: number;
  /** seconds used for the pace */
  movingTime: number;
  globalGain: number;
  ranWithClubmate: boolean;
}

/** Progress a challenge gets from one run: returns the new progress and data. */
export function challengeProgress(type: ChallengeType, current: { progress: number; data: any }, run: RunFacts): { progress: number; data: any } {
  const data = { ...(current.data || {}) };
  const start = Date.parse(run.startedAt);
  switch (type) {
    case 'early_bird':
      return { progress: run.distance >= 5000 && localHour(start) < 9 ? 1 : current.progress, data };
    case 'long_run':
      return { progress: run.distance >= 10_000 ? 1 : current.progress, data };
    case 'club_run':
      return { progress: run.ranWithClubmate ? 1 : current.progress, data };
    case 'fast_5k': {
      const pace = run.distance > 0 ? run.movingTime / (run.distance / 1000) : Infinity;
      return { progress: run.distance >= 5000 && pace <= 330 ? 1 : current.progress, data };
    }
    case 'streak3': {
      const days = new Set<string>(Array.isArray(data.days) ? data.days : []);
      days.add(localDate(start));
      data.days = [...days].sort();
      return { progress: days.size, data };
    }
    case 'distance_total':
      return { progress: current.progress + Math.max(0, run.distance), data };
    case 'new_ground':
      return { progress: current.progress + Math.max(0, run.globalGain), data };
    default:
      return current;
  }
}

/** Applies a run to the user's challenges (rest phase only). Returns the challenges it completed. */
export async function applyRunToChallenges(game: GameStorage, userId: string, info: CycleInfo, run: RunFacts): Promise<Array<{ type: string; rewardItem: string }>> {
  if (!isRestLike(info.phase)) return [];
  const window = restWindow(info);
  const start = Date.parse(run.startedAt);
  if (!(start >= window.start && start < window.end)) return [];
  await ensureChallenges(game, userId, info);
  const completed: Array<{ type: string; rewardItem: string }> = [];
  for (const challenge of await game.getChallenges(userId, info.number)) {
    if (challenge.status !== 'active') continue;
    const type = challenge.type as ChallengeType;
    if (!CHALLENGES[type]) continue;
    const next = challengeProgress(type, challenge, run);
    if (next.progress >= challenge.target) {
      const owned = await game.ownedCosmetics(userId);
      const rewardItem = pickRewardItem(challenge.rewardRarity as Rarity, seededRandom(`challenge:${challenge.id}`), owned);
      if (await game.updateChallenge(challenge.id, { progress: next.progress, data: next.data, status: 'completed', rewardItem })) {
        await game.grantItem(userId, rewardItem, 'challenge', challenge.id);
        completed.push({ type, rewardItem });
      }
    } else if (next.progress !== challenge.progress || JSON.stringify(next.data) !== JSON.stringify(challenge.data)) {
      await game.updateChallenge(challenge.id, { progress: next.progress, data: next.data });
    }
  }
  return completed;
}

// ─── Tick ────────────────────────────────────────────────────────────────────

/**
 * Brings the season up to date: reset (once), finishes competitions of past cycles, starts the
 * current one, late joins, rest chests and item expiry. Safe to run any number of times.
 */
export async function seasonTick(storage: WorkerStorage, game: GameStorage, env: any, now = Date.now()): Promise<Record<string, unknown>> {
  const report: Record<string, unknown> = {};
  report.reset = await ensureSeasonReset(game, now);
  const info = cycleAt(now);
  report.cycle = info.number;
  report.phase = info.phase;

  // 1. Finish what is over: older cycles, or this one once its close is past (the end on Sunday
  //    23:59 plus COMPETITION_GRACE_HOURS, so runs that arrive late still count)
  const closed = info.phase === 'rest' && now >= cycleBounds(info.number).closeAt;
  const finishBefore = info.phase === 'competition' ? info.number : closed ? info.number + 1 : info.number;
  for (const number of await game.getUnfinishedCompetitionCycles(finishBefore)) {
    const lockKey = `season_finish_${number}`;
    if (!(await game.claimSetting(lockKey, String(now)))) continue;
    try {
      report[`finished_${number}`] = await finishCycle(storage, game, env, number, now);
    } catch (error) {
      console.error(`[SEASON] Finishing cycle ${number} failed, will retry:`, error);
      report[`finished_${number}`] = { error: String(error) };
    } finally {
      // Competitions already finished stay finished; the rest are retried on the next tick
      await game.deleteSetting(lockKey);
    }
  }
  // A cycle that ended with no competitions still needs its map wiped
  if (info.phase !== 'competition' && info.number >= 0 && closed) {
    const row = await game.getCycle(info.number);
    if (row && row.status === 'competition') {
      await game.resetCompetitionMap();
      await game.upsertCycle(info.number, { status: 'rest', endedAt: new Date(now).toISOString() });
    }
  }

  // 2. Start the current competition
  if (info.phase === 'competition') {
    const startKey = `season_start_${info.number}`;
    if (await game.claimSetting(startKey, String(now))) {
      try {
        report.started = await startCycle(storage, game, env, info, now);
      } catch (error) {
        // Release so the next tick starts it again (createCompetition skips clubs already done)
        console.error(`[SEASON] Starting cycle ${info.number} failed, will retry:`, error);
        await game.deleteSetting(startKey);
        report.started = { error: String(error) };
      }
    } else {
      report.lateJoins = await lateJoinCompetitions(game, info, now);
    }
  }

  // 3. Rest phase: chests
  if (isRestLike(info.phase)) {
    await game.expireChests(new Date(now).toISOString());
    report.chests = await spawnRestChests(storage, game, env, info, now);
  }

  await game.expireItems(null, now);
  return report;
}

/** Cycle bounds re-exported for the API */
export { cycleBounds };
