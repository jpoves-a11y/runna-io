// Everything the iOS home / lock screen widgets show, in one request (they refresh on their own every
// ~30 minutes): this week's league among friends, your week day by day, your streak, the zones you
// need to defend and a light version of your territory for the map widget.
import * as turf from '@turf/turf';
import type { WorkerStorage } from './storage';
import { madridTime, madridWeekStart } from './cron';
import { personImage } from './notifications';
import { insidePoint } from './decay';
import { castleZonesOfUsers, requestDerivedRefresh } from './derived';

const DAY_MS = 24 * 3600 * 1000;
/** Most points of the territory sent to the map widget. */
const MAX_MAP_POINTS = 400;
/** Zones within this distance of a place's biggest zone belong to that place (a city and its outskirts). */
const PLACE_RADIUS_M = 25_000;
/** Runs of this period count in full to pick your main place; older ones a quarter. */
const RECENT_RUNS_MS = 90 * DAY_MS;
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

function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface TerritoryPiece {
  /** Rings of the polygon ([lng, lat]), outer ring first. */
  polygon: number[][][];
  area: number;
  lat: number;
  lng: number;
}

export interface Place {
  pieces: TerritoryPiece[];
  area: number;
  /** Centre of the place's biggest zone. */
  lat: number;
  lng: number;
  /** Km run there (recent runs in full, older ones a quarter). */
  score: number;
}

/** The separate zones of a territory (the polygons of a MultiPolygon), each with its area and centre. */
export function territoryPieces(territory: any): TerritoryPiece[] {
  if (!territory) return [];
  const polygons: number[][][][] = territory.type === 'Polygon' ? [territory.coordinates]
    : territory.type === 'MultiPolygon' ? territory.coordinates : [];
  const pieces: TerritoryPiece[] = [];
  for (const polygon of polygons) {
    try {
      const shape = turf.polygon(polygon);
      const area = turf.area(shape);
      if (!(area > 0)) continue;
      const [lng, lat] = turf.centroid(shape).geometry.coordinates;
      pieces.push({ polygon, area, lat, lng });
    } catch { /* unreadable polygon */ }
  }
  return pieces;
}

/**
 * Groups the zones into places (zones within PLACE_RADIUS_M of a place's biggest zone) and picks your
 * main place: where you ran the most km lately (by where runs started), else the one with the most
 * territory. With territory in several cities or countries, the map widget shows only the main one.
 */
export function mainPlace(
  pieces: TerritoryPiece[],
  runs: Array<{ lat: number; lng: number; distance: number; startedAt: string }>,
  now: number,
): { main: Place; others: Place[] } | null {
  const places: Place[] = [];
  for (const piece of [...pieces].sort((a, b) => b.area - a.area)) {
    const place = places.find((p) => distanceMeters(p.lat, p.lng, piece.lat, piece.lng) <= PLACE_RADIUS_M);
    if (place) {
      place.pieces.push(piece);
      place.area += piece.area;
    } else {
      places.push({ pieces: [piece], area: piece.area, lat: piece.lat, lng: piece.lng, score: 0 });
    }
  }
  if (places.length === 0) return null;
  for (const run of runs) {
    let nearest: Place | null = null;
    let nearestDistance = PLACE_RADIUS_M;
    for (const place of places) {
      const d = distanceMeters(place.lat, place.lng, run.lat, run.lng);
      if (d <= nearestDistance) { nearest = place; nearestDistance = d; }
    }
    if (!nearest) continue;
    const recent = now - parseTime(run.startedAt) <= RECENT_RUNS_MS;
    nearest.score += (run.distance / 1000) * (recent ? 1 : 0.25);
  }
  const ranked = [...places].sort((a, b) => b.score - a.score || b.area - a.area);
  return { main: ranked[0], others: ranked.slice(1) };
}

/** The part of a geometry inside a [minLng, minLat, maxLng, maxLat] box (null when nothing is left). */
function clipToBox(geometry: any | null, box: number[]): any | null {
  if (!geometry || box.length !== 4) return geometry ?? null;
  try {
    const clipped = turf.bboxClip(turf.feature(geometry) as any, box as [number, number, number, number]).geometry as any;
    const polygons: number[][][][] = clipped.type === 'Polygon' ? [clipped.coordinates] : clipped.coordinates;
    const kept = polygons
      .map((rings) => rings.filter((ring) => ring.length >= 4))
      .filter((rings) => rings.length > 0 && turf.area(turf.polygon(rings)) >= 1);
    if (kept.length === 0) return null;
    return kept.length === 1 ? { type: 'Polygon', coordinates: kept[0] } : { type: 'MultiPolygon', coordinates: kept };
  } catch {
    return geometry;
  }
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
  // --- This week's league (and yesterday's positions for the ▲▼ arrows), without reading pictures
  const weekStart = madridWeekStart(now);
  const weekEnd = new Date(madridWeekStart(weekStart.getTime() + 8 * DAY_MS).getTime());
  const dayIndex = (madridTime(now).weekday + 6) % 7; // 0 = Monday
  const todayStart = new Date(weekStart.getTime() + dayIndex * DAY_MS);
  const league = await storage.getWidgetLeague(userId, weekStart.toISOString(), todayStart.toISOString());
  const me = league.me;
  if (!me) return null;
  const ranking = league.week;
  const yesterdayRank = league.yesterdayRank;
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
  const widget = await widgetMap(storage, userId, resting, false);
  // Out of date: the map shown is the previous one (or empty) and the queue works out the new one
  if (widget.stale) await requestDerivedRefresh(env, [userId], [userId]);
  const { defense, map } = widget.value;

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
    /** The map is being worked out: the widgets ask again in a few minutes instead of keeping this. */
    mapPending: widget.stale,
  };
}

// v2: the map shows your main place only (bbox, territory, wear) and says what's elsewhere
const WIDGET_MAP_KIND = 'widget-map-v2';
/** Previous format, shown while the queue works out the new one (better than an empty map). */
const PREVIOUS_WIDGET_MAP_KIND = 'widget-map-v1';

const EMPTY_WIDGET_MAP = {
  defense: { castles: 0, castleLayers: 0, atRiskArea: 0, atRisk: null, weakArea: 0, lostToday: 0 },
  map: { territory: null, weak: null, atRisk: null, castles: [], bbox: null, place: null, elsewhere: null },
};

/** Queue: works out the widgets' map of a user if it's out of date. */
export async function refreshWidgetMap(storage: WorkerStorage, userId: string, now = Date.now()): Promise<void> {
  const rest = await storage.getRestMode(userId);
  const resting = !!rest && now >= parseTime(rest.startedAt) && now < parseTime(rest.until);
  await widgetMap(storage, userId, resting, true);
}

/**
 * The widgets' map (territory simplified, castles, wear) and defence figures. Uniting and simplifying
 * the territory and grouping castles is too heavy for a request on the Workers free plan (503), so it
 * is worked out in the queue (`compute`) and kept in derived_cache until the territory, castles or wear
 * change; requests read it, possibly out of date (`stale`).
 */
async function widgetMap(storage: WorkerStorage, userId: string, resting: boolean, compute: boolean) {
  const signature = `${await storage.getWidgetMapSignature(userId)}|${resting ? 'rest' : ''}`;
  const keys = new Map([[userId, signature]]);
  const cached = (await storage.getDerived(WIDGET_MAP_KIND, keys)).get(userId);
  if (cached?.fresh) return { value: cached.payload as typeof EMPTY_WIDGET_MAP, stale: false };
  if (!compute) {
    const previous = cached ?? (await storage.getDerived(PREVIOUS_WIDGET_MAP_KIND, keys)).get(userId);
    return { value: (previous?.payload ?? EMPTY_WIDGET_MAP) as typeof EMPTY_WIDGET_MAP, stale: true };
  }

  const territories = await storage.getTerritoriesByUserId(userId);
  const territory = union(territories.map((t) => {
    try { return typeof t.geometry === 'string' ? JSON.parse(t.geometry) : t.geometry; } catch { return null; }
  }));
  const zones = (await castleZonesOfUsers(storage, [userId], true)).zones.get(userId) ?? [];
  const castles = zones
    .filter((zone) => zone.lat !== null && zone.lng !== null)
    .map((zone) => ({ lat: zone.lat, lng: zone.lng, layers: zone.layers }));
  const decay = resting ? null : await storage.getDecayState(userId);
  const area = (g: any) => { try { return g ? turf.area(g) : 0; } catch { return 0; } };

  // Territory in several cities or countries: the map shows the main place, where you run the most
  const places = mainPlace(territoryPieces(territory), await storage.getRunStartPoints(userId), Date.now());
  const shown = places
    ? (places.main.pieces.length === 1
      ? { type: 'Polygon', coordinates: places.main.pieces[0].polygon }
      : { type: 'MultiPolygon', coordinates: places.main.pieces.map((piece) => piece.polygon) })
    : territory;
  let box: number[] | null = null;
  try { box = shown ? turf.bbox(shown) : null; } catch { box = null; }
  // What can appear around the place on the map (wear is drawn there only)
  const view = box ? [box[0] - (box[2] - box[0]) * 0.6, box[1] - (box[3] - box[1]) * 0.6, box[2] + (box[2] - box[0]) * 0.6, box[3] + (box[3] - box[1]) * 0.6] : null;
  const weakShown = view ? clipToBox(decay?.weak ?? null, view) : decay?.weak ?? null;
  const atRiskShown = view ? clipToBox(decay?.atRisk ?? null, view) : decay?.atRisk ?? null;

  const result = {
    defense: {
      castles: castles.length,
      castleLayers: castles.reduce((sum, castle) => sum + castle.layers, 0),
      atRiskArea: area(decay?.atRisk),
      // The zone to defend in your main place first (one abroad can wait)
      atRisk: insidePoint(atRiskShown) ?? insidePoint(decay?.atRisk ?? null),
      weakArea: area(decay?.weak),
      lostToday: decay?.lostToday ?? 0,
    },
    map: {
      territory: lightGeometry(shown),
      weak: lightGeometry(weakShown, 150),
      atRisk: lightGeometry(atRiskShown, 150),
      castles,
      bbox: box,
      place: places ? { area: places.main.area, zones: places.main.pieces.length, lat: places.main.lat, lng: places.main.lng } : null,
      elsewhere: places && places.others.length > 0
        ? { places: places.others.length, area: places.others.reduce((sum, place) => sum + place.area, 0) }
        : null,
    },
  };
  await storage.saveDerived(WIDGET_MAP_KIND, [{ key: userId, signature, payload: result }]);
  return { value: result as any, stale: false };
}
