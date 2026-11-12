// Processing of one run, for both game modes. Called by the territory queue consumer for every
// new run (recorded in the app or imported) and by the inline fallbacks.
//
//   1. Season cutoff: runs from before the new season never count.
//   2. Anti-cheat (antiCheat.ts) + duplicate runs at the same time (several sources).
//   3. Global mode: adds the new area to the runner's world map (Explorador / Estela ancha).
//   4. Competition mode: only for participants of the running club competition, inside its window.
//   5. Streak, rest-phase chests and challenges (club members).
//   6. Validation result on the route, feed event, notifications.
import * as turf from '@turf/turf';
import type { WorkerStorage } from './storage';
import {
  GameStorage,
  isBeforeSeason,
  runsCountFromMs,
  SEASON_INVENTORY,
  type CompetitionRow,
  type ParticipantRow,
} from './gameStorage';
import { analyzeRun, parseTrackMeta, timeOverlapShare, withReasons, haversineMeters, REASON_MESSAGES, type RunAnalysis, type ValidationReason } from './antiCheat';
import { runAreaGeometry, mergeIntoGlobal, parseGeometry, geometryArea } from './globalTerritory';
import { cycleAt, cycleBounds, isRestLike, localDate, localHour, localMidnight, addDays, monthPeriod, competitionCycleForRun, arrivedAfterClose, type CycleInfo } from './cycles';
import { applyRunToChallenges, collectChestsAlongRun, ensureParticipantOnRun, flagHolders, notifyUsers, MAPLESS_MODES, type CompetitionEntry } from './season';
import { routeToEnclosedPolygon, activitiesOverlapInTime, geometriesOverlapByPercentage, type ConquestVictimInfo } from './territory';
import {
  ANTI_CHEAT, CHALLENGES, EXPLORER_BONUS_CAP_M2, EXPLORER_BONUS_RATIO, FLAG_CAPTURE_RADIUS_M, ITEMS,
  TOURIST_MIN_DISTANCE_M, TOURIST_BONUS_CAP_M2, DAWN_HOUR, DAWN_BONUS_RATIO, DAWN_BONUS_CAP_M2,
  EXPEDITION_BONUS_RATIO, EXPEDITION_BONUS_CAP_M2, GLOBAL_BONUS_RUN_CAP_M2,
  DOUBLE_OR_NOTHING_DISTANCE_M, PLUNDER_MIN_STOLEN_M2, pickRewardItem,
} from '../../shared/game';

export interface RunPipelineInput {
  userId: string;
  routeId: string;
  earlyFeedEventId?: string;
}

export interface RunPipelineResult {
  status: 'accepted' | 'flagged' | 'rejected' | 'missing';
  reasons: ValidationReason[];
  message: string | null;
  globalGain: number;
  competition: null | {
    competitionId: string;
    mode: string;
    newArea: number;
    areaStolen: number;
    totalArea: number;
    victims: ConquestVictimInfo[];
    /** Banderas: flags captured by this run */
    flags?: Array<{ flagId: string; name: string; from: string | null }>;
    /** Exploradores: new global area of this run (its score) */
    explored?: number;
  };
  chests: Array<{ treasureId: string; treasureName: string; powerType: string; rarity: string; zone: string | null }>;
  challengesCompleted: Array<{ type: string; rewardItem: string }>;
  ranTogetherWith: string[];
  /** This run made an inactive member enter their club's running competition */
  joinedCompetition?: boolean;
  /** Extra global area of each power that applied (explorer, tourist, dawn, expedition) */
  globalBoosts?: Record<string, number>;
  /** Saqueo: the item won by a big steal */
  plunderItem?: string;
  /** Venganza: extra competition score from stealing back */
  revengeBonus?: number;
  /**
   * Why a run of a club member didn't count for the competition: it arrived after the close
   * (Monday 06:00), the mode doesn't let anyone in any more, or they joined the club too late.
   */
  competitionNote?: 'after_close' | 'closed_entry' | 'next_cycle' | 'eliminated' | null;
}

function parseCoordinates(value: unknown): Array<[number, number]> {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Analysis of a stored route (same inputs the pipeline uses). */
export function analyzeStoredRoute(route: { coordinates: unknown; trackMeta?: unknown; track_meta?: unknown; distance: number; duration: number; startedAt?: string | null; completedAt?: string | null; started_at?: string; completed_at?: string }): RunAnalysis {
  const coords = parseCoordinates(route.coordinates);
  const meta = parseTrackMeta(route.trackMeta ?? route.track_meta);
  return analyzeRun({
    coordinates: coords,
    pointTimes: meta.t ?? null,
    distance: Number(route.distance) || 0,
    duration: Number(route.duration) || 0,
    startedAt: route.startedAt ?? route.started_at ?? null,
    completedAt: route.completedAt ?? route.completed_at ?? null,
    avgHeartRate: meta.hr ?? null,
  });
}

/**
 * Whether this run duplicates another run of the same user (same activity imported from two
 * sources, or recorded twice). Exactly one of a group of duplicates counts: one already validated
 * wins; between two not yet validated, the smaller id wins.
 */
async function isDuplicateRun(game: GameStorage, userId: string, route: { id: string; startedAt: string; completedAt: string }): Promise<boolean> {
  const start = Date.parse(route.startedAt);
  const end = Date.parse(route.completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;
  for (const other of await game.getOverlappingRuns(userId, route.startedAt, route.completedAt, route.id)) {
    const oStart = Date.parse(other.startedAt);
    const oEnd = Date.parse(other.completedAt);
    if (!Number.isFinite(oStart) || !Number.isFinite(oEnd) || oEnd <= oStart) continue;
    // Share of the shorter of the two runs covered by the other
    const share = (end - start) <= (oEnd - oStart)
      ? timeOverlapShare(start, end, oStart, oEnd)
      : timeOverlapShare(oStart, oEnd, start, end);
    if (share < ANTI_CHEAT.duplicateOverlap) continue;
    if (other.status !== null) return true; // validated earlier and counted
    if (other.id < route.id) return true;
  }
  return false;
}

/** Updates the streak of consecutive running days (Salvarrachas covers one missed day). */
async function updateStreak(game: GameStorage, userId: string, startedAt: string): Promise<{ days: number; saverUsed: boolean }> {
  const user = await game.getUserGameRow(userId);
  if (!user) return { days: 0, saverUsed: false };
  const today = localDate(Date.parse(startedAt));
  const last: string | null = user.streak_last_date ?? null;
  const current = Number(user.streak_days ?? 0);
  if (last && today <= last) return { days: current, saverUsed: false }; // same day or an older import
  let days = 1;
  let saverUsed = false;
  if (last && addDays(last, 1) === today) {
    days = current + 1;
  } else if (last && addDays(last, 2) === today && current > 0) {
    const saver = await game.availableItemOfType(userId, 'streak_saver');
    if (saver) {
      await game.consumeItems([saver.id]);
      days = current + 1;
      saverUsed = true;
    }
  }
  await game.setStreak(userId, days, today);
  return { days, saverUsed };
}

/** Club mates who ran the same loop at the same time (for the "En equipo" challenge). */
async function ranWithClubmates(storage: WorkerStorage, clubmateIds: string[], startedAt: string, completedAt: string, runGeometry: any): Promise<string[]> {
  if (clubmateIds.length === 0 || !runGeometry) return [];
  const together: string[] = [];
  try {
    for (const other of await storage.getRoutesInTimeWindow(clubmateIds, startedAt)) {
      if (!other.startedAt || !other.completedAt) continue;
      if (!activitiesOverlapInTime(startedAt, completedAt, other.startedAt, other.completedAt)) continue;
      const coords = parseCoordinates(other.coordinates);
      if (coords.length < 10) continue;
      const poly = routeToEnclosedPolygon(coords, 150);
      if (poly && geometriesOverlapByPercentage(runGeometry, poly.geometry, 0.9) && !together.includes(other.userId)) together.push(other.userId);
    }
  } catch (error) {
    console.error('[PIPELINE] ran-together with club mates failed:', error);
  }
  return together;
}

interface CompetitionContext {
  competition: CompetitionRow;
  participant: ParticipantRow;
  participants: ParticipantRow[];
  enemyIds: string[];
  /** Derbi: the rival club's competition (its participants are the enemies) */
  rivalCompetitionId: string | null;
  areaFactor: number;
  sabotageIds: string[];
}

/** The competition this run counts for, or null (not a participant, rest phase, run outside it). */
export async function competitionContextFor(game: GameStorage, userId: string, runStartedAt: string, info: CycleInfo, now = Date.now()): Promise<CompetitionContext | null> {
  if (info.phase !== 'competition') return null;
  const participation = await game.getActiveParticipation(userId);
  if (!participation || participation.competition.cycleNumber !== info.number) return null;
  const bounds = cycleBounds(info.number);
  const start = Date.parse(runStartedAt);
  const joined = Date.parse(participation.participant.joinedAt);
  const from = Math.max(bounds.competitionStart, Number.isFinite(joined) ? joined - 5 * 60 * 1000 : bounds.competitionStart);
  if (!(start >= from && start < bounds.competitionEnd)) return null;

  const participants = await game.getParticipants(participation.competition.id);
  const me = participants.find((p) => p.userId === userId) ?? participation.participant;
  // Eliminación: whoever has fallen only adds to their global map
  if (me.eliminatedCut !== null) return null;
  const mode = participation.competition.mode;
  let enemyIds: string[] = [];
  let rivalCompetitionId: string | null = null;
  if (mode === 'ffa') enemyIds = participants.filter((p) => p.userId !== userId).map((p) => p.userId);
  if (mode === 'elimination') enemyIds = participants.filter((p) => p.userId !== userId && p.eliminatedCut === null).map((p) => p.userId);
  if (mode === 'teams') enemyIds = participants.filter((p) => p.userId !== userId && p.team !== me.team).map((p) => p.userId);
  if (mode === 'derby' && participation.competition.opponentClubId) {
    // Derbi: one shared map; only the rival club's runners can be stolen from
    const rival = await game.getClubCompetition(participation.competition.opponentClubId, participation.competition.cycleNumber);
    if (rival) {
      rivalCompetitionId = rival.id;
      enemyIds = (await game.getParticipants(rival.id)).map((p) => p.userId);
    }
  }

  let areaFactor = 1;
  const effects = await game.activeEffects(participants.map((p) => p.userId), now);
  if (effects.some((e) => e.itemId === 'rally')) areaFactor *= 1.5;
  // Muralla del Club: nobody can steal from the team (Por equipos) or the club (Derbi) of its holder
  if (mode === 'teams' || mode === 'derby') {
    const enemyEffects = await game.activeEffects(enemyIds, now);
    const walls = enemyEffects.filter((e) => e.itemId === 'club_wall').map((e) => e.userId);
    if (walls.length > 0) {
      if (mode === 'derby') {
        enemyIds = []; // the whole rival club is behind the wall
      } else {
        const wallTeams = new Set(participants.filter((p) => walls.includes(p.userId)).map((p) => p.team));
        enemyIds = enemyIds.filter((id) => !wallTeams.has(participants.find((p) => p.userId === id)?.team ?? null));
      }
    }
  }
  const sabotages = await game.sabotagesAgainst(userId, now);
  if (sabotages.length > 0) areaFactor *= 0.8;
  return { competition: participation.competition, participant: me, participants, enemyIds, rivalCompetitionId, areaFactor, sabotageIds: sabotages.map((s) => s.id) };
}

/**
 * Extra global area of one run from the active global powers, each with its own cap and all of them
 * together never above GLOBAL_BONUS_RUN_CAP_M2 (so powers can't buy the ranking).
 */
export function globalBoosts(input: { newArea: number; explorer: boolean; tourist: boolean; dawn: boolean; expedition: boolean }): { total: number; parts: Record<string, number> } {
  const parts: Record<string, number> = {};
  const area = Math.max(0, input.newArea);
  if (area <= 0) return { total: 0, parts };
  if (input.explorer) parts.explorer = Math.min(area * EXPLORER_BONUS_RATIO, EXPLORER_BONUS_CAP_M2);
  if (input.tourist) parts.tourist = Math.min(area, TOURIST_BONUS_CAP_M2);
  if (input.dawn) parts.dawn = Math.min(area * DAWN_BONUS_RATIO, DAWN_BONUS_CAP_M2);
  if (input.expedition) parts.expedition = Math.min(area * EXPEDITION_BONUS_RATIO, EXPEDITION_BONUS_CAP_M2);
  let total = Object.values(parts).reduce((sum, v) => sum + v, 0);
  if (total > GLOBAL_BONUS_RUN_CAP_M2) {
    // Scale every part down so they add up to the cap
    const factor = GLOBAL_BONUS_RUN_CAP_M2 / total;
    for (const key of Object.keys(parts)) parts[key] = parts[key] * factor;
    total = GLOBAL_BONUS_RUN_CAP_M2;
  }
  return { total, parts };
}

/** Deterministic random for a seed (rewards decided by a run). */
function seededRandomFor(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Someone stole from these victims: a victim with Venganza remembers who (their next steal back
 * counts double); a victim with Emboscada sabotages the thief (once) and is told.
 */
async function reactToSteal(storage: WorkerStorage, game: GameStorage, env: any, thiefId: string, victims: ConquestVictimInfo[], now: number): Promise<void> {
  const hit = victims.filter((v) => v.stolenArea > 0).map((v) => v.userId);
  if (hit.length === 0) return;
  const effects = await game.activeEffects(hit, now);
  const thief = (await game.getUserLite([thiefId])).get(thiefId);
  for (const e of effects) {
    if (e.itemId === 'revenge') {
      const targets: string[] = Array.isArray(e.metadata?.targets) ? e.metadata.targets : [];
      if (!targets.includes(thiefId)) await game.setEffectMetadata(e.id, { ...(e.metadata ?? {}), targets: [...targets, thiefId] });
    }
    if (e.itemId === 'ambush') {
      const until = new Date(now + (ITEMS.sabotage.activeHours ?? 24) * 3600 * 1000).toISOString();
      await game.createActiveEffect(e.userId, 'sabotage', until, { targetUserId: thiefId, fromAmbush: true }, 'ambush', now);
      await game.consumeItems([e.id], now);
      await notifyUsers(storage, env, [e.userId], {
        title: '🪤 ¡Ha caído en tu Emboscada!',
        body: `${thief?.name ?? 'Un rival'} te ha robado y queda saboteado: su siguiente carrera conquistará un 20% menos.`,
        tag: `ambush-${e.id}`,
        data: { type: 'ambush' },
      });
    }
  }
}

/** The user fell in the Eliminación of this cycle. */
async function isEliminated(game: GameStorage, userId: string, cycleNumber: number): Promise<boolean> {
  const participation = await game.getActiveParticipation(userId);
  return !!participation && participation.competition.cycleNumber === cycleNumber && participation.participant.eliminatedCut !== null;
}

/**
 * Banderas: captures the flags the run passed within FLAG_CAPTURE_RADIUS_M of (only its valid
 * stretches: not the ones cut by the anti-cheat). The capture time is when it passed closest (from
 * the per-point times, else interpolated). Flags held by someone with an active Escudo or Capa
 * can't be taken; the previous holder is told.
 */
async function captureFlags(storage: WorkerStorage, game: GameStorage, env: any, context: CompetitionContext, route: any, analysis: RunAnalysis, now: number): Promise<Array<{ flagId: string; name: string; from: string | null }>> {
  const flags = await game.getFlags(context.competition.id);
  if (flags.length === 0) return [];
  const raw = parseCoordinates(route.coordinates);
  const times = parseTrackMeta(route.trackMeta ?? route.track_meta).t;
  const start = Date.parse(route.startedAt);
  const end = Date.parse(route.completedAt);
  const valid = analysis.segments.flat();
  const timeOf = (point: [number, number]): number => {
    const index = raw.findIndex((p) => p[0] === point[0] && p[1] === point[1]);
    if (index >= 0 && times && times.length === raw.length && Number.isFinite(times[index])) return start + times[index] * 1000;
    const fraction = index >= 0 && raw.length > 1 ? index / (raw.length - 1) : 0.5;
    return Number.isFinite(end) && end > start ? start + (end - start) * fraction : start;
  };
  const captures = await game.getFlagCaptures(context.competition.id);
  const protectedHolders = new Set((await game.activeEffects(context.participants.map((p) => p.userId), now))
    .filter((e) => e.itemId === 'shield' || e.itemId === 'invisibility').map((e) => e.userId));
  const taken: Array<{ flagId: string; name: string; from: string | null }> = [];
  for (const flag of flags) {
    let best: { point: [number, number]; meters: number } | null = null;
    for (const point of valid) {
      const meters = haversineMeters([flag.lat, flag.lng], point);
      if (meters <= FLAG_CAPTURE_RADIUS_M && (!best || meters < best.meters)) best = { point, meters };
    }
    if (!best) continue;
    const at = timeOf(best.point);
    const holder = flagHolders([flag.id], captures, at).get(flag.id) ?? null;
    if (holder?.userId === context.participant.userId) continue; // already mine
    if (holder && protectedHolders.has(holder.userId)) continue; // Escudo / Capa protect their flags
    if (!(await game.addFlagCapture({ flagId: flag.id, competitionId: context.competition.id, userId: context.participant.userId, routeId: route.id, capturedAt: new Date(at).toISOString() }))) continue;
    taken.push({ flagId: flag.id, name: flag.name, from: holder?.userId ?? null });
  }
  // Tell the ones who lost a flag
  const me = (await game.getUserLite([context.participant.userId])).get(context.participant.userId);
  for (const t of taken) {
    if (!t.from) continue;
    await notifyUsers(storage, env, [t.from], {
      title: `🚩 Te han quitado la ${t.name}`,
      body: `${me?.name ?? 'Alguien'} ha pasado corriendo por ella. Recupérala antes de que sume más horas.`,
      tag: `flag-${t.flagId}`,
      data: { type: 'season_flag_lost', competitionId: context.competition.id },
    });
  }
  return taken;
}

/** Day of the run (Madrid) as [from, to) ISO strings. */
function runDayBounds(startedAt: string): [string, string] {
  const day = localDate(Date.parse(startedAt));
  return [new Date(localMidnight(day)).toISOString(), new Date(localMidnight(addDays(day, 1))).toISOString()];
}

export async function processRun(storage: WorkerStorage, env: any, input: RunPipelineInput, now = Date.now()): Promise<RunPipelineResult> {
  const game = new GameStorage(storage.database);
  const { userId, routeId, earlyFeedEventId } = input;
  const result: RunPipelineResult = {
    status: 'missing', reasons: [], message: null, globalGain: 0, competition: null, chests: [], challengesCompleted: [], ranTogetherWith: [],
  };
  const route = await storage.getRouteById(routeId);
  if (!route) {
    console.error(`[PIPELINE] Route ${routeId} not found`);
    return result;
  }
  const { generateFeedEvents, processTerritoryConquest } = await import('./routes');
  const coords = parseCoordinates(route.coordinates);

  // ── 1-2. Season cutoff, anti-cheat, duplicates ──
  let analysis: RunAnalysis;
  if (isBeforeSeason(route.startedAt)) {
    analysis = withReasons(analyzeRun({ coordinates: [], distance: 0, duration: 0 }), ['before_season']);
  } else {
    analysis = analyzeStoredRoute(route);
    if (analysis.status !== 'rejected' && await isDuplicateRun(game, userId, route)) {
      analysis = withReasons(analysis, ['duplicate']);
    }
  }

  const finish = async (extra: Record<string, unknown>) => {
    result.status = analysis.status;
    result.reasons = analysis.reasons;
    result.message = analysis.message;
    await game.setRouteValidation(routeId, analysis.status, analysis.reasons, analysis.status === 'rejected' ? 0 : result.globalGain);
    await generateFeedEvents(storage, userId, routeId, route.distance, route.duration, {
      newAreaConquered: result.globalGain,
      victims: result.competition?.victims ?? [],
      ranTogetherWith: result.ranTogetherWith,
      treasuresCollected: result.chests,
      extraMetadata: {
        validation: { status: analysis.status, reasons: analysis.reasons, message: analysis.message },
        ...extra,
      },
    }, analysis.status === 'rejected', earlyFeedEventId); // a run that doesn't count sets no records
  };

  if (analysis.status === 'rejected') {
    console.warn(`[PIPELINE] Route ${routeId} rejected: ${analysis.reasons.join(', ')}`);
    await finish({});
    return result;
  }

  if (coords.length > 0) {
    const [lat, lng] = coords[0];
    if (Number.isFinite(lat) && Number.isFinite(lng)) await game.setHomeIfMissing(userId, lat, lng);
  }

  // ── 3. Global mode ──
  const ownEffects = await game.activeEffects([userId], now);
  const effect = (itemId: string) => ownEffects.find((e) => e.itemId === itemId);
  const explorer = effect('explorer');
  const wideTrail = effect('wide_trail');
  const cartographer = effect('cartographer');
  const tourist = effect('tourist');
  const expedition = effect('expedition');
  const dawn = effect('dawn');
  const runGeometry = runAreaGeometry(analysis.segments);
  const globalRunGeometry = wideTrail || cartographer ? runAreaGeometry(analysis.segments, { wideTrail: true }) : runGeometry;
  const me = await game.getUserGameRow(userId);
  const before = Number(me?.global_area ?? 0);
  let globalNewArea = 0;
  let bonus = 0;
  let boostParts: Record<string, number> = {};
  // Expedición: who ran with me (friends or club mates), only looked up when it matters
  let companions: string[] = [];
  if (expedition && runGeometry) {
    const membership = await game.getMembership(userId);
    const clubmates = membership ? await game.getClubMemberIds(membership.clubId) : [];
    const friends = await storage.getFriendIds(userId);
    companions = await ranWithClubmates(storage, [...new Set([...friends, ...clubmates])].filter((id) => id !== userId), route.startedAt, route.completedAt, runGeometry);
  }
  const startPoint = coords[0];
  const homeLat = Number(me?.home_lat);
  const homeLng = Number(me?.home_lng);
  const farFromHome = !!startPoint && me?.home_lat !== null && me?.home_lat !== undefined && Number.isFinite(homeLat) && Number.isFinite(homeLng)
    && haversineMeters([homeLat, homeLng], startPoint) > TOURIST_MIN_DISTANCE_M;
  if (globalRunGeometry) {
    const existing = await game.getGlobalTerritory(userId);
    const merge = mergeIntoGlobal(parseGeometry(existing?.geometry), globalRunGeometry as any);
    if (merge && merge.newArea > 0) {
      globalNewArea = merge.newArea;
      await game.saveGlobalTerritory(userId, JSON.stringify(merge.merged), merge.totalArea);
      const boosts = globalBoosts({
        newArea: globalNewArea,
        explorer: !!explorer,
        tourist: !!tourist && farFromHome,
        dawn: !!dawn && localHour(Date.parse(route.startedAt)) < DAWN_HOUR,
        expedition: !!expedition && companions.length > 0,
      });
      bonus = boosts.total;
      boostParts = boosts.parts;
      await game.addGlobalAreaEvent({ userId, routeId, area: globalNewArea, bonus, period: monthPeriod(Date.parse(route.startedAt)), runAt: route.startedAt });
      // Expedición: the companions get the same share (their own event, kept by their rebuilds)
      if (boostParts.expedition) {
        const giver = (await game.getUserLite([userId])).get(userId);
        for (const companion of companions) {
          await game.addGlobalAreaEvent({ userId: companion, routeId: `expedition:${routeId}`, area: 0, bonus: boostParts.expedition, period: monthPeriod(Date.parse(route.startedAt)), runAt: route.startedAt });
          await game.syncUserGlobalArea(companion);
        }
        await notifyUsers(storage, env, companions, {
          title: '👥 ¡Expedición!',
          body: `Has corrido con ${giver?.name ?? 'un compañero'} y su Expedición te suma ${(boostParts.expedition / 1e6).toLocaleString('es-ES', { maximumFractionDigits: 2 })} km² en tu mapa global.`,
          tag: `expedition-${routeId}`,
          data: { type: 'expedition' },
        });
      }
    }
  }
  // Next-run boosts are used up by this run (Turista and Expedición only when they applied)
  const used = [explorer, wideTrail, boostParts.tourist ? tourist : null, boostParts.expedition ? expedition : null]
    .filter((e): e is NonNullable<typeof e> => !!e).map((e) => e.id);
  if (used.length > 0 && runGeometry) await game.consumeItems(used, now);
  const globalAfter = await game.syncUserGlobalArea(userId);
  result.globalGain = globalNewArea + bonus;
  result.globalBoosts = boostParts;

  // Huge areas go to review (they still count)
  const review: ValidationReason[] = [];
  if (result.globalGain > ANTI_CHEAT.reviewRunAreaM2) review.push('large_area');
  const [dayFrom, dayTo] = runDayBounds(route.startedAt);
  if (await game.globalGainBetween(userId, dayFrom, dayTo) > ANTI_CHEAT.reviewDayAreaM2) review.push('daily_area');
  if (review.length > 0) analysis = withReasons(analysis, review);

  // ── 4. Competition mode ──
  // A run counts for the competition it STARTED in, until that competition closes (Monday 06:00:
  // the end plus COMPETITION_GRACE_HOURS, so watches that sync late still count)
  const info = cycleAt(now);
  const runCycle = competitionCycleForRun(route.startedAt, now);
  let entry: CompetitionEntry = 'none';
  if (runCycle) entry = await ensureParticipantOnRun(game, userId, runCycle, Date.parse(route.startedAt));
  const context = runCycle ? await competitionContextFor(game, userId, route.startedAt, runCycle, now) : null;
  if (context && entry === 'joined') result.joinedCompetition = true;
  if (!context) {
    if (arrivedAfterClose(route.startedAt, now)) {
      if (await game.getMembership(userId)) result.competitionNote = 'after_close';
    } else if (entry === 'closed_entry' || entry === 'next_cycle') {
      result.competitionNote = entry;
    } else if (entry === 'participant' && runCycle && await isEliminated(game, userId, runCycle.number)) {
      result.competitionNote = 'eliminated';
    }
  }
  if (context) {
    const mode = context.competition.mode;
    let conquest: Awaited<ReturnType<typeof processTerritoryConquest>> | null = null;
    // Banderas and Exploradores have no competition map: no territory, no steals
    const myEffects = await game.activeEffects([userId], now);
    const doubleOrNothing = myEffects.find((e) => e.itemId === 'double_or_nothing');
    const plunder = myEffects.find((e) => e.itemId === 'plunder');
    const revenge = myEffects.find((e) => e.itemId === 'revenge');
    let extraBonus = 0;
    if (runGeometry && !MAPLESS_MODES.includes(mode as any)) {
      // Doble o Nada: a long run doubles, a short one halves
      const factor = doubleOrNothing ? (analysis.stats.distanceM >= DOUBLE_OR_NOTHING_DISTANCE_M ? 2 : 0.5) : 1;
      conquest = await processTerritoryConquest(storage, userId, routeId, runGeometry, {
        competitionId: context.competition.id,
        enemyIds: context.enemyIds,
        areaFactor: context.areaFactor * factor,
      }, route.startedAt, route.completedAt);
      if (context.sabotageIds.length > 0) await game.consumeItems(context.sabotageIds, now);
      const usedNow = [doubleOrNothing, plunder].filter((e): e is NonNullable<typeof e> => !!e).map((e) => e.id);
      if (usedNow.length > 0) await game.consumeItems(usedNow, now);
      // Saqueo: a big steal wins an item
      if (plunder && conquest.areaStolen >= PLUNDER_MIN_STOLEN_M2) {
        const loot = pickRewardItem('common', seededRandomFor(`plunder:${routeId}`));
        await game.grantItem(userId, loot, 'plunder', routeId, now);
        result.plunderItem = loot;
      }
      // Venganza: what this run steals from whoever stole from me counts double (once)
      const targets: string[] = Array.isArray(revenge?.metadata?.targets) ? revenge!.metadata.targets : [];
      if (revenge && targets.length > 0) {
        const fromTargets = conquest.victims.filter((v) => targets.includes(v.userId)).reduce((sum, v) => sum + v.stolenArea, 0);
        if (fromTargets > 0) {
          extraBonus += fromTargets;
          result.revengeBonus = fromTargets;
          await game.consumeItems([revenge.id], now);
        }
      }
      // Venganza and Emboscada of the victims
      await reactToSteal(storage, game, env, userId, conquest.victims, now);
    }
    await game.updateParticipant(context.competition.id, userId, {
      addRuns: 1,
      addDistance: analysis.stats.distanceM,
      addAreaStolen: conquest?.areaStolen ?? 0,
      addBonus: (conquest?.timeBombPenalty ? -conquest.timeBombPenalty : 0) + extraBonus,
    });
    await game.syncParticipantAreas(context.competition.id);
    // Area other participants lost to this run (in the Derbi, the rival club's competition), and the
    // run itself (windows, awards, summaries)
    for (const victim of conquest?.victims ?? []) {
      if (victim.stolenArea > 0) await game.updateParticipant(context.rivalCompetitionId ?? context.competition.id, victim.userId, { addAreaLost: victim.stolenArea });
    }
    if (context.rivalCompetitionId && (conquest?.victims.length ?? 0) > 0) await game.syncParticipantAreas(context.rivalCompetitionId);
    // Banderas: the flags this run passed by
    const flags = mode === 'flags' ? await captureFlags(storage, game, env, context, route, analysis, now) : [];
    await game.recordCompetitionRun({
      competitionId: context.competition.id,
      userId,
      routeId,
      startedAt: route.startedAt,
      areaGained: conquest?.newAreaConquered ?? 0,
      areaStolen: conquest?.areaStolen ?? 0,
      distance: analysis.stats.distanceM,
    });
    if (conquest || MAPLESS_MODES.includes(mode as any)) {
      result.competition = {
        competitionId: context.competition.id,
        mode,
        newArea: conquest?.newAreaConquered ?? 0,
        areaStolen: conquest?.areaStolen ?? 0,
        totalArea: conquest?.totalArea ?? 0,
        victims: conquest?.victims ?? [],
        flags,
        // Exploradores scores the new global area of the run
        explored: mode === 'explorers' ? globalNewArea : 0,
      };
      if (conquest) result.ranTogetherWith.push(...conquest.ranTogetherWith);
    }
  }

  // ── 5. Streak, chests, challenges (club members in the rest phase) ──
  const streak = await updateStreak(game, userId, route.startedAt);
  const membership = await game.getMembership(userId);
  if (membership && isRestLike(info.phase)) {
    const flat = analysis.segments.flat();
    result.chests = await collectChestsAlongRun(storage, game, userId, flat, routeId, now);
    const clubmates = (await game.getClubMemberIds(membership.clubId)).filter((id) => id !== userId);
    const withMates = await ranWithClubmates(storage, clubmates, route.startedAt, route.completedAt, runGeometry);
    for (const id of withMates) if (!result.ranTogetherWith.includes(id)) result.ranTogetherWith.push(id);
    result.challengesCompleted = await applyRunToChallenges(game, userId, info, {
      startedAt: route.startedAt,
      distance: analysis.stats.distanceM,
      movingTime: analysis.stats.movingTimeS,
      globalGain: result.globalGain,
      ranWithClubmate: withMates.length > 0,
    });
  }
  if (result.ranTogetherWith.length > 0) await storage.updateRouteRanTogether(routeId, result.ranTogetherWith);

  // ── 6. Result, feed, notifications ──
  await finish({
    joinedCompetition: result.joinedCompetition ?? false,
    competitionNote: result.competitionNote ?? null,
    globalArea: { gained: globalNewArea, bonus, total: globalAfter, boosts: boostParts },
    competition: result.competition
      ? {
        competitionId: result.competition.competitionId, mode: result.competition.mode, newArea: result.competition.newArea,
        areaStolen: result.competition.areaStolen, totalArea: result.competition.totalArea,
        flags: result.competition.flags ?? [], explored: result.competition.explored ?? 0,
      }
      : null,
    streak: streak.days,
    streakSaverUsed: streak.saverUsed,
    challengesCompleted: result.challengesCompleted.map((c) => ({
      type: c.type, title: CHALLENGES[c.type as keyof typeof CHALLENGES]?.title ?? c.type,
      rewardItem: c.rewardItem, rewardName: ITEMS[c.rewardItem]?.name ?? c.rewardItem,
    })),
  });

  await sendRunNotifications(storage, env, userId, routeId, route.completedAt, route.distance, result, before, globalAfter);
  console.log(`[PIPELINE] Route ${routeId}: ${analysis.status} global +${(result.globalGain / 1e6).toFixed(4)} km²${result.competition ? `, competition +${(result.competition.newArea / 1e6).toFixed(4)} km²` : ''}`);
  return result;
}

/** The "X ha salido a correr" push only for runs that ended this recently (not for old imports). */
const FRIEND_ACTIVITY_MAX_AGE_MS = 12 * 60 * 60 * 1000;

async function sendRunNotifications(storage: WorkerStorage, env: any, userId: string, routeId: string, completedAt: string | null | undefined, distance: number, result: RunPipelineResult, globalBefore: number, globalAfter: number): Promise<void> {
  if (!env) return;
  try {
    const { notifyTerritoryLoss, notifyFriendNewActivity, notifyAreaOvertake } = await import('./notifications');
    for (const victim of (result.competition?.victims ?? []).slice(0, 3)) {
      try { await notifyTerritoryLoss(storage, victim.userId, userId, env, victim.stolenArea); } catch (_) {}
    }
    // Once per run, however often it's processed (another import of it, a retry, a rebuild)
    const ended = completedAt ? Date.parse(completedAt) : NaN;
    if (Number.isFinite(ended) && Date.now() - ended <= FRIEND_ACTIVITY_MAX_AGE_MS && await storage.claimFriendActivityNotification(routeId)) {
      await notifyFriendNewActivity(storage, userId, (distance || 0) / 1000, result.globalGain / 1e6, env);
    }
    // Overtakes in the global ranking among friends
    const friendIds = await storage.getFriendIds(userId);
    if (friendIds.length > 0 && globalAfter > globalBefore) {
      const areas = await new GameStorage(storage.database).getGlobalAreas(friendIds);
      const overtaken = friendIds.filter((id) => {
        const area = areas.get(id) ?? 0;
        return area > 0 && globalBefore < area && globalAfter >= area;
      });
      for (const friendId of overtaken.slice(0, 5)) {
        await notifyAreaOvertake(storage, userId, friendId, globalAfter / 1e6, env);
      }
    }
    if (result.challengesCompleted.length > 0) {
      const subs = await storage.getPushSubscriptionsByUserId(userId);
      if (subs.length > 0) {
        const { sendPushToUser } = await import('./pushHelper');
        const names = result.challengesCompleted.map((c) => CHALLENGES[c.type as keyof typeof CHALLENGES]?.title ?? c.type).join(', ');
        await sendPushToUser(
          subs.map((s) => ({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } })),
          { title: '🏅 ¡Reto completado!', body: `${names}. La recompensa ya está en tu inventario.`, tag: 'challenge-completed', data: { type: 'challenge_completed' } },
          env.VAPID_PUBLIC_KEY || '', env.VAPID_PRIVATE_KEY || '', env.VAPID_SUBJECT || 'mailto:notifications@runna.io',
        );
      }
    }
  } catch (error) {
    console.error('[PIPELINE] Notifications failed (non-critical):', error);
  }
}

// ─── Rebuilds ────────────────────────────────────────────────────────────────

/**
 * Rebuilds a user's global map from their counted runs, oldest first (after deleting a run or
 * reverting a reviewed one). Explorer bonuses of runs that still exist are kept.
 */
export async function rebuildGlobalForUser(storage: WorkerStorage, userId: string): Promise<{ area: number; runs: number }> {
  const game = new GameStorage(storage.database);
  const bonusByRoute = new Map<string, number>();
  const oldEvents = await game.database.all<{ route_id: string | null; bonus: number }>(
    (await import('drizzle-orm')).sql`SELECT route_id, bonus FROM global_area_events WHERE user_id = ${userId} AND bonus > 0`,
  );
  for (const e of oldEvents) if (e.route_id) bonusByRoute.set(e.route_id, (bonusByRoute.get(e.route_id) ?? 0) + Number(e.bonus));
  // Bonuses given by other runners' Expedición are kept as they are
  const gifts = await game.database.all<{ route_id: string; bonus: number; period: string; run_at: string }>(
    (await import('drizzle-orm')).sql`SELECT route_id, bonus, period, run_at FROM global_area_events WHERE user_id = ${userId} AND route_id LIKE 'expedition:%'`,
  );

  await game.clearGlobalData(userId);
  for (const gift of gifts) {
    await game.addGlobalAreaEvent({ userId, routeId: gift.route_id, area: 0, bonus: Number(gift.bonus), period: gift.period, runAt: gift.run_at });
  }
  let geometry: any = null;
  let runs = 0;
  const from = new Date(runsCountFromMs()).toISOString();
  for (const route of await game.getCountedRunsChronological(userId)) {
    if (route.started_at < from) continue;
    const analysis = analyzeStoredRoute(route as any);
    if (analysis.status === 'rejected') continue;
    const runGeometry = runAreaGeometry(analysis.segments);
    if (!runGeometry) continue;
    const merge = mergeIntoGlobal(geometry, runGeometry as any);
    if (!merge) continue;
    geometry = merge.merged;
    const bonus = bonusByRoute.get(route.id) ?? 0;
    if (merge.newArea > 0 || bonus > 0) {
      await game.addGlobalAreaEvent({ userId, routeId: route.id, area: merge.newArea, bonus, period: monthPeriod(Date.parse(route.started_at)), runAt: route.started_at });
    }
    await game.setRouteValidation(route.id, route.validation_status ?? analysis.status, JSON.parse(route.validation_reasons || '[]'), merge.newArea + bonus);
    runs++;
  }
  if (geometry) await game.saveGlobalTerritory(userId, JSON.stringify(geometry), geometryArea(geometry));
  const area = await game.syncUserGlobalArea(userId);
  return { area, runs };
}

/**
 * Rebuilds a user's competition territory from their counted runs inside their running
 * competition (after deleting or reverting a run). Outside a competition it is cleared.
 */
export async function rebuildCompetitionForUser(storage: WorkerStorage, userId: string, now = Date.now()): Promise<number> {
  const game = new GameStorage(storage.database);
  // Rebuilt while the competition is not scored yet: during its 10 days and until its close (Monday
  // 06:00), or later if the cron is late. A run deleted on Monday at 03:00 must not wipe the area
  // that is about to be scored.
  const participation = await game.getActiveParticipation(userId);
  await storage.deleteTerritoriesByUserId(userId);
  if (!participation) {
    await storage.updateUserTotalArea(userId, 0);
    return 0;
  }
  const bounds = cycleBounds(participation.competition.cycleNumber);
  const from = new Date(Math.max(bounds.competitionStart, Date.parse(participation.participant.joinedAt) - 5 * 60 * 1000)).toISOString();
  const to = new Date(bounds.competitionEnd).toISOString();
  let geometry: any = null;
  for (const route of await game.getCountedRunsChronological(userId, from, to)) {
    if (route.started_at < from) continue;
    const analysis = analyzeStoredRoute(route as any);
    if (analysis.status === 'rejected') continue;
    const runGeometry = runAreaGeometry(analysis.segments);
    if (!runGeometry) continue;
    if (!geometry) {
      geometry = runGeometry;
    } else {
      try {
        const union = turf.union(turf.featureCollection([turf.feature(geometry) as any, turf.feature(runGeometry as any) as any]));
        if (union) geometry = union.geometry;
      } catch (error) {
        console.error('[PIPELINE] competition rebuild union failed:', error);
      }
    }
  }
  const area = geometry ? geometryArea(geometry) : 0;
  if (geometry && area > 0) await storage.updateTerritoryGeometry(userId, null, geometry, area);
  await storage.updateUserTotalArea(userId, area);
  await game.syncParticipantAreas(participation.competition.id);
  return area;
}

/** Message for a validation result (for API responses). */
export function validationMessage(reasons: ValidationReason[]): string | null {
  for (const r of reasons) if (REASON_MESSAGES[r]) return REASON_MESSAGES[r];
  return null;
}

export { SEASON_INVENTORY };
