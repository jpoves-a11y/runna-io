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

/** Parses a stored geometry (JSON text or already an object); null when it can't be read. */
export function parseGeometry(geometry: unknown): any | null {
  if (!geometry) return null;
  if (typeof geometry === 'string') {
    try { return JSON.parse(geometry); } catch { return null; }
  }
  return geometry;
}

export type Bbox = [number, number, number, number];

/** [minLng, minLat, maxLng, maxLat] of a GeoJSON geometry, or null when it has no coordinates. */
export function geometryBbox(geometry: any): Bbox | null {
  try {
    const box = turf.bbox(geometry);
    return box.every(Number.isFinite) ? [box[0], box[1], box[2], box[3]] : null;
  } catch {
    return null;
  }
}

/** Whether two bounding boxes touch. A cheap test that rules out most polygon intersections. */
export function bboxesIntersect(a: Bbox, b: Bbox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/** Area in m² shared by two polygons (0 when they don't overlap or can't be intersected). */
export function intersectionArea(geometryA: any, geometryB: any): number {
  try {
    const a = geometryA.type === 'Feature' ? geometryA : turf.feature(geometryA);
    const b = geometryB.type === 'Feature' ? geometryB : turf.feature(geometryB);
    const overlap = turf.intersect(turf.featureCollection([a, b]));
    return overlap ? turf.area(overlap) : 0;
  } catch {
    return 0;
  }
}

/**
 * Geometry ready to be stored: coordinates rounded to 6 decimals (~10 cm) and repeated points
 * removed. Unions and differences return 15-decimal coordinates and duplicate vertices, which
 * make every territory row (and the map download) several times bigger and every later turf
 * operation slower. Returns the input unchanged if cleaning fails.
 */
export function compactGeometry<T>(geometry: T): T {
  try {
    const rounded = turf.truncate(geometry as any, { precision: 6, coordinates: 2, mutate: false });
    return turf.cleanCoords(rounded as any) as T;
  } catch {
    return geometry;
  }
}

// ─── Treasures ───────────────────────────────────────────────────────────────

/** A run collects a treasure when it passes within this many meters of it. */
export const TREASURE_REACH_M = 250;

/**
 * The treasures a route passes within `reachM` meters of. Every 5th point is checked (plus the
 * last one), with a plain haversine distance instead of building turf points for every pair.
 */
export function treasuresAlongRoute<T extends { lat: number; lng: number }>(
  treasures: T[],
  routeCoordinates: Array<[number, number]>,
  reachM: number = TREASURE_REACH_M
): T[] {
  if (treasures.length === 0 || routeCoordinates.length === 0) return [];
  const last = routeCoordinates.length - 1;
  const sampled = routeCoordinates.filter((c, i) => (i % 5 === 0 || i === last) && Number.isFinite(c[0]) && Number.isFinite(c[1]));
  const toRad = Math.PI / 180;
  const EARTH_RADIUS_M = 6371008.8;
  const reachDeg = reachM / 111_000; // a little over the size of a degree of latitude
  return treasures.filter((treasure) => sampled.some(([lat, lng]) => {
    if (Math.abs(lat - treasure.lat) > reachDeg) return false;
    const dLat = (treasure.lat - lat) * toRad;
    const dLng = (treasure.lng - lng) * toRad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat * toRad) * Math.cos(treasure.lat * toRad) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h))) <= reachM;
  }));
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
