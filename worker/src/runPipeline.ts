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
import { analyzeRun, parseTrackMeta, timeOverlapShare, withReasons, REASON_MESSAGES, type RunAnalysis, type ValidationReason } from './antiCheat';
import { runAreaGeometry, mergeIntoGlobal, parseGeometry, geometryArea } from './globalTerritory';
import { cycleAt, cycleBounds, isRestLike, localDate, localMidnight, addDays, monthPeriod, competitionCycleForRun, arrivedAfterClose, type CycleInfo } from './cycles';
import { applyRunToChallenges, collectChestsAlongRun, ensureParticipantOnRun, type CompetitionEntry } from './season';
import { routeToEnclosedPolygon, activitiesOverlapInTime, geometriesOverlapByPercentage, type ConquestVictimInfo } from './territory';
import { ANTI_CHEAT, CHALLENGES, EXPLORER_BONUS_CAP_M2, EXPLORER_BONUS_RATIO, ITEMS } from '../../shared/game';

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
  };
  chests: Array<{ treasureId: string; treasureName: string; powerType: string; rarity: string; zone: string | null }>;
  challengesCompleted: Array<{ type: string; rewardItem: string }>;
  ranTogetherWith: string[];
  /** This run made an inactive member enter their club's running competition */
  joinedCompetition?: boolean;
  /**
   * Why a run of a club member didn't count for the competition: it arrived after the close
   * (Monday 06:00), the mode doesn't let anyone in any more, or they joined the club too late.
   */
  competitionNote?: 'after_close' | 'closed_entry' | 'next_cycle' | null;
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
  let enemyIds: string[] = [];
  if (participation.competition.mode === 'ffa') enemyIds = participants.filter((p) => p.userId !== userId).map((p) => p.userId);
  if (participation.competition.mode === 'teams') enemyIds = participants.filter((p) => p.userId !== userId && p.team !== me.team).map((p) => p.userId);

  let areaFactor = 1;
  const effects = await game.activeEffects(participants.map((p) => p.userId), now);
  if (effects.some((e) => e.itemId === 'rally')) areaFactor *= 1.5;
  const sabotages = await game.sabotagesAgainst(userId, now);
  if (sabotages.length > 0) areaFactor *= 0.8;
  return { competition: participation.competition, participant: me, participants, enemyIds, areaFactor, sabotageIds: sabotages.map((s) => s.id) };
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
  const explorer = ownEffects.find((e) => e.itemId === 'explorer');
  const wideTrail = ownEffects.find((e) => e.itemId === 'wide_trail');
  const runGeometry = runAreaGeometry(analysis.segments);
  const globalRunGeometry = wideTrail ? runAreaGeometry(analysis.segments, { wideTrail: true }) : runGeometry;
  const before = Number((await game.getUserGameRow(userId))?.global_area ?? 0);
  let globalNewArea = 0;
  let bonus = 0;
  if (globalRunGeometry) {
    const existing = await game.getGlobalTerritory(userId);
    const merge = mergeIntoGlobal(parseGeometry(existing?.geometry), globalRunGeometry as any);
    if (merge && merge.newArea > 0) {
      globalNewArea = merge.newArea;
      await game.saveGlobalTerritory(userId, JSON.stringify(merge.merged), merge.totalArea);
      if (explorer) bonus = Math.min(globalNewArea * EXPLORER_BONUS_RATIO, EXPLORER_BONUS_CAP_M2);
      await game.addGlobalAreaEvent({ userId, routeId, area: globalNewArea, bonus, period: monthPeriod(Date.parse(route.startedAt)), runAt: route.startedAt });
    }
  }
  const used = [explorer, wideTrail].filter((e): e is NonNullable<typeof e> => !!e).map((e) => e.id);
  if (used.length > 0 && runGeometry) await game.consumeItems(used, now);
  const globalAfter = await game.syncUserGlobalArea(userId);
  result.globalGain = globalNewArea + bonus;

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
    }
  }
  if (context) {
    let conquest: Awaited<ReturnType<typeof processTerritoryConquest>> | null = null;
    if (runGeometry) {
      conquest = await processTerritoryConquest(storage, userId, routeId, runGeometry, {
        competitionId: context.competition.id,
        enemyIds: context.enemyIds,
        areaFactor: context.areaFactor,
      }, route.startedAt, route.completedAt);
      if (context.sabotageIds.length > 0) await game.consumeItems(context.sabotageIds, now);
    }
    await game.updateParticipant(context.competition.id, userId, {
      addRuns: 1,
      addDistance: analysis.stats.distanceM,
      addAreaStolen: conquest?.areaStolen ?? 0,
      addBonus: conquest?.timeBombPenalty ? -conquest.timeBombPenalty : 0,
    });
    await game.syncParticipantAreas(context.competition.id);
    // Area other participants lost to this run, and the run itself (windows, awards, summaries)
    for (const victim of conquest?.victims ?? []) {
      if (victim.stolenArea > 0) await game.updateParticipant(context.competition.id, victim.userId, { addAreaLost: victim.stolenArea });
    }
    await game.recordCompetitionRun({
      competitionId: context.competition.id,
      userId,
      routeId,
      startedAt: route.startedAt,
      areaGained: conquest?.newAreaConquered ?? 0,
      areaStolen: conquest?.areaStolen ?? 0,
      distance: analysis.stats.distanceM,
    });
    if (conquest) {
      result.competition = {
        competitionId: context.competition.id,
        mode: context.competition.mode,
        newArea: conquest.newAreaConquered,
        areaStolen: conquest.areaStolen,
        totalArea: conquest.totalArea,
        victims: conquest.victims,
      };
      result.ranTogetherWith.push(...conquest.ranTogetherWith);
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
    globalArea: { gained: globalNewArea, bonus, total: globalAfter },
    competition: result.competition
      ? { competitionId: result.competition.competitionId, mode: result.competition.mode, newArea: result.competition.newArea, areaStolen: result.competition.areaStolen, totalArea: result.competition.totalArea }
      : null,
    streak: streak.days,
    streakSaverUsed: streak.saverUsed,
    challengesCompleted: result.challengesCompleted.map((c) => ({
      type: c.type, title: CHALLENGES[c.type as keyof typeof CHALLENGES]?.title ?? c.type,
      rewardItem: c.rewardItem, rewardName: ITEMS[c.rewardItem]?.name ?? c.rewardItem,
    })),
  });

  await sendRunNotifications(storage, env, userId, route.distance, result, before, globalAfter);
  console.log(`[PIPELINE] Route ${routeId}: ${analysis.status} global +${(result.globalGain / 1e6).toFixed(4)} km²${result.competition ? `, competition +${(result.competition.newArea / 1e6).toFixed(4)} km²` : ''}`);
  return result;
}

async function sendRunNotifications(storage: WorkerStorage, env: any, userId: string, distance: number, result: RunPipelineResult, globalBefore: number, globalAfter: number): Promise<void> {
  if (!env) return;
  try {
    const { notifyTerritoryLoss, notifyFriendNewActivity, notifyAreaOvertake } = await import('./notifications');
    for (const victim of (result.competition?.victims ?? []).slice(0, 3)) {
      try { await notifyTerritoryLoss(storage, victim.userId, userId, env, victim.stolenArea); } catch (_) {}
    }
    await notifyFriendNewActivity(storage, userId, (distance || 0) / 1000, result.globalGain / 1e6, env);
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

  await game.clearGlobalData(userId);
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
