/**
 * Awards of a finished competition. Pure: the season code gathers the numbers (standings,
 * competition_runs, participants) and stores what this returns in the result and in user_awards.
 */
import {
  AWARDS, AWARD_CONSISTENT_MIN_DAYS, AWARD_DISTANCE_MIN_M, AWARD_THIEF_MIN_M2, AWARD_WALL_MIN_AREA_M2,
  type AwardId, type CompetitionMode,
} from '../../shared/game';
import { localDate } from './cycles';

export interface AwardCandidate {
  userId: string;
  /** Mode score (area in most modes, hours in Banderas, new global area in Exploradores) */
  score: number;
  /** Competition area held at the close */
  area: number;
  areaStolen: number;
  areaLost: number;
  distance: number;
  runs: number;
  /** Different days (Madrid) with a run that counted */
  days: number;
  team: number | null;
  eliminatedCut?: number | null;
}

export interface AwardContext {
  mode: CompetitionMode;
  winnerUserId?: string | null;
  mvpUserId?: string | null;
  winnerTeam?: number | null;
  /** Objetivo común reached */
  achieved?: boolean;
  /** Duelo / Derbi, from this club's side */
  outcome?: 'won' | 'draw' | 'lost';
}

/** Modes with a competition map where rivals steal from each other */
const STEALING_MODES: CompetitionMode[] = ['ffa', 'teams', 'duel', 'derby', 'elimination'];
/** Modes whose score is conquered area */
const AREA_MODES: CompetitionMode[] = ['ffa', 'teams', 'target', 'duel', 'derby', 'elimination'];
/** Modes where the club plays together: the best of the club is its MVP */
const MVP_MODES: CompetitionMode[] = ['teams', 'target', 'duel', 'derby'];

const AWARD_ORDER = Object.keys(AWARDS) as AwardId[];

/** The candidate with the highest value (ties: the first one in the given order). */
function best(list: AwardCandidate[], value: (c: AwardCandidate) => number, min: number): AwardCandidate | null {
  let top: AwardCandidate | null = null;
  for (const c of list) {
    const v = value(c);
    if (v < min || v <= 0) continue;
    if (!top || v > value(top)) top = c;
  }
  return top;
}

/**
 * Awards per user. Only those who ran get any. Candidates are expected in standings order
 * (that order breaks ties). Constante goes to everyone tied at the top.
 */
export function computeAwards(candidates: AwardCandidate[], ctx: AwardContext): Record<string, AwardId[]> {
  const ran = candidates.filter((c) => c.runs > 0);
  const awards = new Map<string, Set<AwardId>>();
  const give = (userId: string | null | undefined, award: AwardId) => {
    if (!userId || !ran.some((c) => c.userId === userId)) return;
    if (!awards.has(userId)) awards.set(userId, new Set());
    awards.get(userId)!.add(award);
  };

  if (AREA_MODES.includes(ctx.mode)) give(best(ran, (c) => c.score, 1)?.userId, 'conqueror');
  if (STEALING_MODES.includes(ctx.mode)) {
    give(best(ran, (c) => c.areaStolen, AWARD_THIEF_MIN_M2)?.userId, 'thief');
    // Muro: the least lost among those still in who held a large zone (with someone to steal from them)
    const holders = ran.filter((c) => c.area >= AWARD_WALL_MIN_AREA_M2 && (c.eliminatedCut === null || c.eliminatedCut === undefined));
    if (holders.length > 0 && ran.length >= 2) {
      const wall = holders.reduce((a, b) => (b.areaLost < a.areaLost || (b.areaLost === a.areaLost && b.area > a.area) ? b : a));
      give(wall.userId, 'wall');
    }
  }
  give(best(ran, (c) => c.distance, AWARD_DISTANCE_MIN_M)?.userId, 'distance');
  const maxDays = Math.max(0, ...ran.map((c) => c.days));
  if (maxDays >= AWARD_CONSISTENT_MIN_DAYS) for (const c of ran) if (c.days === maxDays) give(c.userId, 'consistent');

  if (MVP_MODES.includes(ctx.mode)) give(ctx.mvpUserId, 'mvp');
  if (ctx.mode === 'elimination') give(ctx.winnerUserId, 'survivor');
  if (ctx.mode === 'flags') give(best(ran, (c) => c.score, 0)?.userId, 'flagbearer');
  if (ctx.mode === 'explorers') give(best(ran, (c) => c.score, 1)?.userId, 'explorer');
  if (ctx.mode === 'target' && ctx.achieved) for (const c of ran) give(c.userId, 'target');
  if (ctx.mode === 'teams' && ctx.winnerTeam !== null && ctx.winnerTeam !== undefined) {
    for (const c of ran) if (c.team === ctx.winnerTeam) give(c.userId, 'victory');
  }
  if ((ctx.mode === 'duel' || ctx.mode === 'derby') && ctx.outcome === 'won') for (const c of ran) give(c.userId, 'victory');

  const out: Record<string, AwardId[]> = {};
  for (const [userId, set] of awards) out[userId] = AWARD_ORDER.filter((a) => set.has(a));
  return out;
}

/** Different days (Madrid) with a run, per user. */
export function runDaysByUser(runs: Array<{ userId: string; startedAt: string }>): Map<string, number> {
  const days = new Map<string, Set<string>>();
  for (const run of runs) {
    const time = Date.parse(run.startedAt);
    if (!Number.isFinite(time)) continue;
    if (!days.has(run.userId)) days.set(run.userId, new Set());
    days.get(run.userId)!.add(localDate(time));
  }
  return new Map([...days].map(([userId, set]) => [userId, set.size]));
}
