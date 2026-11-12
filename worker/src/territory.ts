/**
 * Territory processing helpers — shared between routes.ts and queue-consumer.ts.
 * Extracted to avoid circular dependencies and allow reuse.
 */
import * as turf from '@turf/turf';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ConquestVictimInfo {
  userId: string;
  userName: string;
  userColor: string;
  stolenArea: number;
}

// ─── Geometry Helpers ────────────────────────────────────────────────────────

/**
 * Simplify coordinates to reduce CPU usage in turf.js operations.
 * Samples evenly distributed points.
 */
export function simplifyCoordinates(coords: Array<[number, number]>, maxPoints: number = 200): Array<[number, number]> {
  if (coords.length <= maxPoints) return coords;

  const step = Math.ceil(coords.length / maxPoints);
  const simplified: Array<[number, number]> = [];

  for (let i = 0; i < coords.length; i += step) {
    simplified.push(coords[i]);
  }

  // Always include the last point
  if (simplified[simplified.length - 1] !== coords[coords.length - 1]) {
    simplified.push(coords[coords.length - 1]);
  }

  return simplified;
}

/**
 * Convert a GPS route to a closed polygon representing the enclosed area.
 * Always closes the route by connecting last point → first point.
 * Returns the polygon geometry, or null if the route has too few points.
 */
export function routeToEnclosedPolygon(coords: Array<[number, number]>, maxSimplifyPoints: number = 150): ReturnType<typeof turf.polygon> | null {
  if (coords.length < 10) return null;

  const simplified = simplifyCoordinates(coords, maxSimplifyPoints);
  // Flip [lat, lng] → [lng, lat] for GeoJSON convention
  const ring = simplified.map((c: [number, number]) => [c[1], c[0]]);

  // Close the ring: always connect last point to first point
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    ring.push([first[0], first[1]]);
  }

  try {
    const poly = turf.polygon([ring]);
    const area = turf.area(poly);
    if (!area || area <= 0 || !isFinite(area)) return null;
    return poly;
  } catch (e) {
    // Fallback: convex hull
    try {
      const line = turf.lineString(ring.slice(0, -1));
      const hull = turf.convex(turf.explode(line));
      if (hull && turf.area(hull) > 0) return hull;
    } catch (_) {}
    return null;
  }
}

// ─── Anti-cheat ──────────────────────────────────────────────────────────────

/** Average speeds above this aren't running (2:51 min/km is world-class pace even over 10 km). */
export const MAX_RUN_SPEED_KMH = 21;
/** Shorter runs are left alone: GPS noise dominates and a fast sprint is still running. */
const MIN_CHECKED_DISTANCE_M = 1000;
/** Moving time can't exceed the time between start and end (slack for clock differences). */
const ELAPSED_SLACK_S = 300;

export type ImplausibleRunReason = 'too_fast' | 'invalid_duration';

export interface RunPlausibility {
  ok: boolean;
  reason?: ImplausibleRunReason;
  /** Average speed used for the check, in km/h */
  speedKmh: number;
  /** Error shown to the runner when the run doesn't count */
  message?: string;
}

/** Length in meters of a route given as [lat, lng] points. */
export function pathLengthMeters(coords: Array<[number, number]>): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const [lat1, lng1] = coords[i - 1];
    const [lat2, lng2] = coords[i];
    if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) continue;
    total += turf.distance([lng1, lat1], [lng2, lat2], { units: 'meters' });
  }
  return total;
}

/**
 * Tells whether a run could have been done on foot, so it may conquer territory and collect
 * treasures. The distance is the larger of the reported one and the length of the GPS track
 * (a faked low distance doesn't hide a long track), and the duration can't be longer than the
 * time between start and end (a faked long duration doesn't slow the pace down).
 */
export function checkRunPlausibility(run: {
  distance: number;
  duration: number;
  startedAt?: string | null;
  completedAt?: string | null;
  coordinates?: Array<[number, number]> | null;
}): RunPlausibility {
  const trackLength = run.coordinates && run.coordinates.length > 1 ? pathLengthMeters(run.coordinates) : 0;
  const distance = Math.max(Number(run.distance) || 0, trackLength);
  const duration = Number(run.duration) || 0;

  if (distance < MIN_CHECKED_DISTANCE_M) return { ok: true, speedKmh: 0 };

  if (duration <= 0) {
    return {
      ok: false, reason: 'invalid_duration', speedKmh: 0,
      message: 'La carrera no tiene una duración válida, así que no cuenta para el territorio.',
    };
  }

  const start = run.startedAt ? Date.parse(run.startedAt) : NaN;
  const end = run.completedAt ? Date.parse(run.completedAt) : NaN;
  if (Number.isFinite(start) && Number.isFinite(end) && duration > (end - start) / 1000 + ELAPSED_SLACK_S) {
    return {
      ok: false, reason: 'invalid_duration', speedKmh: 0,
      message: 'La duración de la carrera es mayor que el tiempo entre su inicio y su final, así que no cuenta para el territorio.',
    };
  }

  const speedKmh = (distance / 1000) / (duration / 3600);
  if (speedKmh > MAX_RUN_SPEED_KMH) {
    return {
      ok: false, reason: 'too_fast', speedKmh,
      message: `Ritmo medio de ${speedKmh.toFixed(1).replace('.', ',')} km/h: es demasiado rápido para correr, así que no cuenta para el territorio. ¿Ibas en bici o en coche?`,
    };
  }
  return { ok: true, speedKmh };
}

// ─── Ran together ────────────────────────────────────────────────────────────

/** A run as stored in the routes table (coordinates are [lat, lng]). */
export interface RunTrack {
  coordinates: Array<[number, number]> | string | null | undefined;
  startedAt: string | Date | null | undefined;
  completedAt: string | Date | null | undefined;
  /** Seconds since startedAt of each point (same length as coordinates), when the source records them. */
  pointTimes?: number[] | string | null;
}

/**
 * - together: they ran (almost) the whole run side by side: they never steal from each other.
 * - partial: they shared a stretch: only the area both runs enclose is protected.
 * - none: separate runs.
 */
export type RanTogetherLevel = 'together' | 'partial' | 'none';

export interface RanTogetherResult {
  level: RanTogetherLevel;
  /** Share of each run's distance covered side by side with the other (0..1). */
  shareA: number;
  shareB: number;
  /** Meters run side by side (the smaller of the two measurements). */
  sharedMeters: number;
  /** Both runs had per-point times (otherwise the time of each point is interpolated along the track). */
  timed: boolean;
}

export const RAN_TOGETHER = {
  /** The runs must have been recorded at the same time for at least this long. */
  minTimeOverlapMs: 5 * 60 * 1000,
  /** A point of one run is "with" the other if it is this close to the other's track. */
  matchDistanceM: 50,
  /** ...at the same moment, give or take this much (real GPS times). */
  timedToleranceMs: 3 * 60 * 1000,
  /** ...or this much when a run has no per-point times (Strava/Garmin/Polar polylines): pauses make interpolation drift. */
  interpolatedToleranceMs: 15 * 60 * 1000,
  /** Both runs must have at least this share run side by side to be "together". */
  togetherShare: 0.7,
  /** Below "together", at least this many meters side by side make it "partial". */
  partialMinMeters: 800,
  /** Tracks are downsampled to this many points (CPU budget of the Worker). */
  maxSamples: 300,
} as const;

const NONE_RESULT: RanTogetherResult = { level: 'none', shareA: 0, shareB: 0, sharedMeters: 0, timed: false };

/** Route coordinates as stored (JSON string or array), invalid points dropped. */
export function parseCoordinates(coords: RunTrack['coordinates']): Array<[number, number]> {
  return parseTrackCoords(coords);
}

/** routes.ran_together_with (JSON array of user ids, or null) as a list. */
export function parseUserIds(value: unknown): string[] {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { return []; }
  }
  return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
}

function toPolygonFeature(geometry: any): any {
  if (geometry.type === 'Feature') return geometry;
  return geometry.type === 'MultiPolygon' ? turf.multiPolygon(geometry.coordinates) : turf.polygon(geometry.coordinates);
}

/** Union of two (multi)polygon geometries, or null if turf fails. */
export function unionGeometries(a: any, b: any): any | null {
  try {
    const union = turf.union(turf.featureCollection([toPolygonFeature(a), toPolygonFeature(b)]));
    return union ? union.geometry : null;
  } catch (err) {
    console.error('[TERRITORY] Union failed:', err);
    return null;
  }
}

/** a minus b: null when nothing is left. Throws if turf fails (callers decide what to do). */
export function differenceGeometries(a: any, b: any): any | null {
  const difference = turf.difference(turf.featureCollection([toPolygonFeature(a), toPolygonFeature(b)]));
  if (!difference || turf.area(difference) <= 0) return null;
  return difference.geometry;
}

/** a ∩ b, or null when they don't touch (or turf fails). */
export function intersectGeometries(a: any, b: any): any | null {
  try {
    const intersection = turf.intersect(turf.featureCollection([toPolygonFeature(a), toPolygonFeature(b)]));
    if (!intersection || turf.area(intersection) <= 0) return null;
    return intersection.geometry;
  } catch (err) {
    console.error('[TERRITORY] Intersection failed:', err);
    return null;
  }
}

function parseTrackCoords(coords: RunTrack['coordinates']): Array<[number, number]> {
  let parsed: unknown = coords;
  if (typeof coords === 'string') {
    try { parsed = JSON.parse(coords); } catch { return []; }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((p): p is [number, number] =>
    Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]));
}

/**
 * Per-point times sent by the client, or null if they are missing or don't fit the coordinates
 * (wrong length, not numbers, going backwards).
 */
export function parsePointTimes(times: unknown, pointCount: number): number[] | null {
  let parsed: unknown = times;
  if (typeof times === 'string') {
    try { parsed = JSON.parse(times); } catch { return null; }
  }
  if (!Array.isArray(parsed) || parsed.length !== pointCount || pointCount < 2) return null;
  let previous = -Infinity;
  for (const t of parsed) {
    if (typeof t !== 'number' || !Number.isFinite(t) || t < -1) return null;
    if (t < previous - 1) return null; // 1 s slack for clock jitter
    previous = Math.max(previous, t);
  }
  return parsed as number[];
}

interface TimedPoint { x: number; y: number; t: number }

function toTimedPoints(track: RunTrack, lat0: number, lng0: number): { points: TimedPoint[]; timed: boolean } | null {
  const coords = parseTrackCoords(track.coordinates);
  const start = track.startedAt ? new Date(track.startedAt).getTime() : NaN;
  const end = track.completedAt ? new Date(track.completedAt).getTime() : NaN;
  if (coords.length < 2 || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;

  const kx = Math.cos((lat0 * Math.PI) / 180) * 111320;
  const ky = 110574;
  const xy = coords.map(([lat, lng]) => ({ x: (lng - lng0) * kx, y: (lat - lat0) * ky }));

  const realTimes = parsePointTimes(track.pointTimes, coords.length);
  let times: number[];
  if (realTimes) {
    times = realTimes.map((s) => start + s * 1000);
  } else {
    // Constant pace along the track between start and end
    const cumulative = [0];
    for (let i = 1; i < xy.length; i++) {
      cumulative.push(cumulative[i - 1] + Math.hypot(xy[i].x - xy[i - 1].x, xy[i].y - xy[i - 1].y));
    }
    const total = cumulative[cumulative.length - 1];
    if (total <= 0) return null;
    times = cumulative.map((d) => start + (d / total) * (end - start));
  }

  let points: TimedPoint[] = xy.map((p, i) => ({ x: p.x, y: p.y, t: times[i] }));
  if (points.length > RAN_TOGETHER.maxSamples) {
    const step = (points.length - 1) / (RAN_TOGETHER.maxSamples - 1);
    const sampled: TimedPoint[] = [];
    for (let i = 0; i < RAN_TOGETHER.maxSamples; i++) sampled.push(points[Math.round(i * step)]);
    points = sampled;
  }
  return { points, timed: !!realTimes };
}

function distanceToSegment(px: number, py: number, a: TimedPoint, b: TimedPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  let u = lengthSq > 0 ? ((px - a.x) * dx + (py - a.y) * dy) / lengthSq : 0;
  u = Math.max(0, Math.min(1, u));
  return Math.hypot(px - (a.x + u * dx), py - (a.y + u * dy));
}

/** Meters of `p` (and its total length) that were run near `q` at about the same time. */
function sharedAlong(p: TimedPoint[], q: TimedPoint[], toleranceMs: number): { shared: number; total: number } {
  let shared = 0;
  let total = 0;
  for (let i = 0; i + 1 < p.length; i++) {
    const a = p[i];
    const b = p[i + 1];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length === 0) continue;
    total += length;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const mt = (a.t + b.t) / 2;
    const from = mt - toleranceMs;
    const to = mt + toleranceMs;
    // First segment of q that ends after `from` (q's times only go forward)
    let lo = 0;
    let hi = q.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (q[mid + 1] && q[mid + 1].t < from) lo = mid + 1;
      else hi = mid;
    }
    for (let j = lo; j + 1 < q.length && q[j].t <= to; j++) {
      if (distanceToSegment(mx, my, q[j], q[j + 1]) <= RAN_TOGETHER.matchDistanceM) {
        shared += length;
        break;
      }
    }
  }
  return { shared, total };
}

/**
 * Tells whether two runs were run together, by comparing the tracks point by point at the same
 * moment, so it doesn't matter who started or stopped recording first, who kept recording on the
 * way home, or whether the route is a loop or an out-and-back. Symmetric: detectRanTogether(a, b)
 * and detectRanTogether(b, a) give the same level.
 */
export function detectRanTogether(a: RunTrack, b: RunTrack): RanTogetherResult {
  const startA = a.startedAt ? new Date(a.startedAt).getTime() : NaN;
  const endA = a.completedAt ? new Date(a.completedAt).getTime() : NaN;
  const startB = b.startedAt ? new Date(b.startedAt).getTime() : NaN;
  const endB = b.completedAt ? new Date(b.completedAt).getTime() : NaN;
  if (![startA, endA, startB, endB].every(Number.isFinite)) return NONE_RESULT;
  // Cheap check first: they must have been recording at the same time
  if (Math.min(endA, endB) - Math.max(startA, startB) < RAN_TOGETHER.minTimeOverlapMs) return NONE_RESULT;

  const coordsA = parseTrackCoords(a.coordinates);
  if (coordsA.length < 2) return NONE_RESULT;
  const [lat0, lng0] = coordsA[0];
  const trackA = toTimedPoints(a, lat0, lng0);
  const trackB = toTimedPoints(b, lat0, lng0);
  if (!trackA || !trackB) return NONE_RESULT;

  const timed = trackA.timed && trackB.timed;
  const tolerance = timed ? RAN_TOGETHER.timedToleranceMs : RAN_TOGETHER.interpolatedToleranceMs;
  const alongA = sharedAlong(trackA.points, trackB.points, tolerance);
  const alongB = sharedAlong(trackB.points, trackA.points, tolerance);
  if (alongA.total <= 0 || alongB.total <= 0) return NONE_RESULT;

  const shareA = alongA.shared / alongA.total;
  const shareB = alongB.shared / alongB.total;
  const sharedMeters = Math.min(alongA.shared, alongB.shared);
  let level: RanTogetherLevel = 'none';
  if (Math.min(shareA, shareB) >= RAN_TOGETHER.togetherShare) level = 'together';
  else if (sharedMeters >= RAN_TOGETHER.partialMinMeters) level = 'partial';
  return { level, shareA, shareB, sharedMeters, timed };
}

/**
 * Area protected between two runners who shared part of a run: what both runs enclose.
 * Null when the polygons don't intersect.
 */
export function sharedRunArea(geometryA: any, geometryB: any): any | null {
  return intersectGeometries(geometryA, geometryB);
}

/**
 * Check if competition is currently active.
 */
export function isCompetitionActive(comp: any): boolean {
  if (!comp) return false;
  if (comp.status === 'active') return true;
  const now = Date.now();
  const start = new Date(comp.startsAt).getTime();
  const end = new Date(comp.endsAt).getTime();
  return now >= start && now <= end;
}

export function isCompetitionUpcoming(comp: any): boolean {
  if (!comp) return false;
  const now = Date.now();
  const start = new Date(comp.startsAt).getTime();
  return now < start;
}

// ─── Polyline Encoding/Decoding ──────────────────────────────────────────────

export function encodePolyline(coordinates: Array<[number, number]>): string {
  let encoded = '';
  let prevLat = 0;
  let prevLng = 0;

  for (const [lat, lng] of coordinates) {
    const dlat = Math.round((lat - prevLat) * 1e5);
    const dlng = Math.round((lng - prevLng) * 1e5);
    encoded += encodeValue(dlat);
    encoded += encodeValue(dlng);
    prevLat = lat;
    prevLng = lng;
  }

  return encoded;
}

function encodeValue(val: number): string {
  val = val << 1;
  if (val < 0) val = ~val;
  let encoded = '';
  while (val >= 0x20) {
    encoded += String.fromCharCode((0x20 | (val & 0x1f)) + 63);
    val >>= 5;
  }
  encoded += String.fromCharCode(val + 63);
  return encoded;
}

export function decodePolyline(encoded: string): [number, number][] {
  const points: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte: number;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const deltaLat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += deltaLat;

    shift = 0;
    result = 0;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const deltaLng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += deltaLng;

    points.push([lat / 1e5, lng / 1e5]);
  }

  return points;
}

// ─── Notification Helper ──────────────────────────────────────────────────────

/** Format area for notifications — uses m² for small areas, km² for larger ones */
export function formatAreaNotification(sqMeters: number): string {
  const abs = Math.abs(sqMeters);
  const km2 = abs / 1_000_000;
  const sign = sqMeters < 0 ? '-' : '';
  if (km2 >= 0.01) return `${sign}${km2.toFixed(2)} km²`;
  return `${sign}${Math.round(abs)} m²`;
}

// Simple co-run heuristic still used by the run pipeline (Expedición, "En equipo", competition steals)
/**
 * Check if two activities started at roughly the same time.
 * Only checks START dates with a 15-minute tolerance.
 */
export function activitiesOverlapInTime(
  activity1Start: Date | string,
  activity1End: Date | string,
  activity2Start: Date | string,
  activity2End: Date | string,
  toleranceMs: number = 15 * 60 * 1000
): boolean {
  const a1Start = new Date(activity1Start).getTime();
  const a2Start = new Date(activity2Start).getTime();
  const startDiff = Math.abs(a1Start - a2Start);
  return startDiff <= toleranceMs;
}

/**
 * Check if two geometries overlap by at least a percentage.
 */
export function geometriesOverlapByPercentage(
  geometry1: any,
  geometry2: any,
  minOverlapPercent: number = 0.90
): boolean {
  try {
    const feature1 = geometry1.type === 'Feature' ? geometry1 : turf.feature(geometry1);
    const feature2 = geometry2.type === 'Feature' ? geometry2 : turf.feature(geometry2);

    const intersection = turf.intersect(turf.featureCollection([feature1, feature2]));
    if (!intersection) return false;

    const area1 = turf.area(feature1);
    const area2 = turf.area(feature2);
    const intersectionArea = turf.area(intersection);

    const smallerArea = Math.min(area1, area2);
    const overlapPercent = smallerArea > 0 ? intersectionArea / smallerArea : 0;

    return overlapPercent >= minOverlapPercent;
  } catch (err) {
    console.error('[TERRITORY] Error calculating geometry overlap:', err);
    return false;
  }
}
