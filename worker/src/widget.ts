// Everything the iOS home / lock screen widgets show, in one request (they refresh on their own every
// ~30 minutes): this week's league among friends, your week day by day, your streak, the zones you
// need to defend and a light version of your territory for the map widget.
import * as turf from '@turf/turf';
import type { WorkerStorage } from './storage';
import { madridTime, madridWeekStart } from './cron';
import { personImage } from './notifications';
import { insidePoint } from './decay';
import { castleZonesOfUsers } from './derived';

const DAY_MS = 24 * 3600 * 1000;
/** Most points of the territory sent to the map widget. */
const MAX_MAP_POINTS = 400;
/** Players of the league in the widget (you are always added). */
const LEAGUE_SIZE = 6;

const parseTime = (value: string) => {
  const parsed = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** A geometry with at most `maxPoints` vertices (coarser tolerance until it fits). */
export function lightGeometry(geometry: any, maxPoints = MAX_MAP_POINTS): any | null {
  if (!geometry) return null;
  const count = (g: any): number => {
    let points = 0;
    const walk = (value: any) => {
      if (Array.isArray(value) && typeof value[0] === 'number') points++;
      else if (Array.isArray(value)) value.forEach(walk);
    };
    walk(g.coordinates);
    return points;
  };
  let current = geometry;
  let tolerance = 0.00003;
  for (let attempt = 0; attempt < 10 && count(current) > maxPoints; attempt++) {
    try {
      current = turf.simplify(turf.feature(geometry) as any, { tolerance, highQuality: false }).geometry;
    } catch {
      break;
    }
    tolerance *= 1.8;
  }
  // Fewer decimals: ~1 m is plenty for a widget
  const round = (value: any): any => (Array.isArray(value) ? value.map(round) : Math.round(value * 1e5) / 1e5);
  return { type: current.type, coordinates: round(current.coordinates) };
}

function union(geometries: any[]): any | null {
  let result: any = null;
  for (const geometry of geometries) {
    if (!geometry) continue;
    if (!result) { result = geometry; continue; }
    try {
      result = turf.union(turf.featureCollection([turf.feature(result) as any, turf.feature(geometry) as any]))?.geometry ?? result;
    } catch { /* keep what we have */ }
  }
  return result;
}

/** Consecutive weeks (ending this one, or last one if you haven't run yet this week) with a run. */
export function weekStreak(runTimes: number[], now: number): number {
  const weeks = new Set(runTimes.map((t) => madridWeekStart(t).getTime()));
  let week = madridWeekStart(now).getTime();
  if (!weeks.has(week)) week = madridWeekStart(week - DAY_MS).getTime();
  let streak = 0;
  while (weeks.has(week)) {
    streak++;
    week = madridWeekStart(week - DAY_MS).getTime();
  }
  return streak;
}

export async function widgetSummary(storage: WorkerStorage, env: any, userId: string, now = Date.now()) {
  const me = await storage.getUser(userId);
  if (!me) return null;

  // --- This week's league (and yesterday's positions for the ▲▼ arrows)
  const weekStart = madridWeekStart(now);
  const weekEnd = new Date(madridWeekStart(weekStart.getTime() + 8 * DAY_MS).getTime());
  const dayIndex = (madridTime(now).weekday + 6) % 7; // 0 = Monday
  const todayStart = new Date(weekStart.getTime() + dayIndex * DAY_MS);
  const ranking = await storage.getWeeklyFriendsRanking(userId, weekStart.toISOString());
  const yesterday = dayIndex > 0
    ? await storage.getWeeklyFriendsRanking(userId, weekStart.toISOString(), todayStart.toISOString())
    : [];
  const yesterdayRank = new Map(yesterday.filter((e) => e.weekArea > 0).map((e) => [e.id, e.rank]));
  const shown = ranking.slice(0, LEAGUE_SIZE);
  const mine = ranking.find((e) => e.id === userId);
  if (mine && !shown.some((e) => e.id === userId)) shown[shown.length - 1] = mine;
  const entries = shown.map((entry) => ({
    id: entry.id,
    name: entry.id === userId ? 'Tú' : (entry.name || entry.username || ''),
    color: entry.color,
    avatarUrl: personImage(env, entry)?.url ?? null,
    area: entry.weekArea,
    distance: entry.weekDistance,
    runs: entry.weekRuns,
    rank: entry.rank,
    rankYesterday: yesterdayRank.get(entry.id) ?? null,
    isMe: entry.id === userId,
  }));

  // --- Your week day by day, last run and streak
  const runs = await storage.getRunsWithAreaSince(userId, new Date(now - 30 * 7 * DAY_MS).toISOString());
  const days = [0, 0, 0, 0, 0, 0, 0];
  const dayDistance = [0, 0, 0, 0, 0, 0, 0];
  for (const run of runs) {
    const t = parseTime(run.startedAt);
    if (t < weekStart.getTime() || t >= weekEnd.getTime()) continue;
    const index = Math.min(6, Math.max(0, Math.floor((t - weekStart.getTime()) / DAY_MS)));
    days[index] += run.area;
    dayDistance[index] += run.distance;
  }
  const runTimes = runs.map((run) => parseTime(run.startedAt)).filter((t) => t > 0);
  const lastRunAt = runTimes.length ? new Date(Math.max(...runTimes)).toISOString() : null;

  // --- Your territory, castles and wear (heavy geometry: cached while they don't change)
  const rest = await storage.getRestMode(userId);
  const resting = !!rest && now >= parseTime(rest.startedAt) && now < parseTime(rest.until);
  const { defense, map } = await widgetMap(storage, userId, resting);

  return {
    generatedAt: new Date(now).toISOString(),
    me: {
      id: me.id,
      name: me.name,
      color: me.color,
      avatarUrl: personImage(env, me)?.url ?? null,
      totalArea: Number(me.totalArea) || 0,
      lastRunAt,
    },
    week: {
      start: weekStart.toISOString(),
      end: weekEnd.toISOString(),
      players: ranking.length,
      myRank: mine?.rank ?? null,
      myArea: mine?.weekArea ?? 0,
      myDistance: mine?.weekDistance ?? 0,
      myRuns: mine?.weekRuns ?? 0,
      leaderArea: ranking[0]?.weekArea ?? 0,
      entries,
      days,
      dayDistance,
    },
    streakWeeks: weekStreak(runTimes, now),
    defense: { ...defense, resting },
    map,
  };
}

const WIDGET_MAP_KIND = 'widget-map-v1';

/**
 * The widgets' map (territory simplified, castles, wear) and defence figures. Uniting and
 * simplifying the territory and grouping castles is the heavy part of the summary, so the result is
 * kept in derived_cache until the territory, castles or wear change.
 */
async function widgetMap(storage: WorkerStorage, userId: string, resting: boolean) {
  const signature = `${await storage.getWidgetMapSignature(userId)}|${resting ? 'rest' : ''}`;
  const cached = (await storage.getDerived(WIDGET_MAP_KIND, new Map([[userId, signature]]))).get(userId);
  if (cached) return cached as { defense: any; map: any };

  const territories = await storage.getTerritoriesByUserId(userId);
  const territory = union(territories.map((t) => {
    try { return typeof t.geometry === 'string' ? JSON.parse(t.geometry) : t.geometry; } catch { return null; }
  }));
  const zones = (await castleZonesOfUsers(storage, [userId])).get(userId) ?? [];
  const castles = zones
    .filter((zone) => zone.lat !== null && zone.lng !== null)
    .map((zone) => ({ lat: zone.lat, lng: zone.lng, layers: zone.layers }));
  const decay = resting ? null : await storage.getDecayState(userId);
  const area = (g: any) => { try { return g ? turf.area(g) : 0; } catch { return 0; } };
  let box: number[] | null = null;
  try { box = territory ? turf.bbox(territory) : null; } catch { box = null; }

  const result = {
    defense: {
      castles: castles.length,
      castleLayers: castles.reduce((sum, castle) => sum + castle.layers, 0),
      atRiskArea: area(decay?.atRisk),
      atRisk: insidePoint(decay?.atRisk ?? null),
      weakArea: area(decay?.weak),
      lostToday: decay?.lostToday ?? 0,
    },
    map: {
      territory: lightGeometry(territory),
      weak: lightGeometry(decay?.weak ?? null, 150),
      atRisk: lightGeometry(decay?.atRisk ?? null, 150),
      castles,
      bbox: box,
    },
  };
  try {
    await storage.saveDerived(WIDGET_MAP_KIND, [{ key: userId, signature, payload: result }]);
  } catch (error) {
    console.error('[WIDGET] Could not cache the map:', error);
  }
  return result;
}
