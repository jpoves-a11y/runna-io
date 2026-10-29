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

/** Pieces and holes smaller than this are GPS noise, not territory (also the minimum theft). */
export const MIN_TERRITORY_PIECE_M2 = 100;

/**
 * Reduces a GPS track to at most `maxPoints` points keeping its shape (Douglas-Peucker, starting at
 * ~3 m of tolerance), instead of keeping one point in N, which cut corners on long runs.
 * Points are [lat, lng].
 */
export function simplifyTrack(coords: Array<[number, number]>, maxPoints: number = 150): Array<[number, number]> {
  if (coords.length <= maxPoints) return coords;
  const line = turf.lineString(coords.map((c) => [c[1], c[0]]));
  let tolerance = 0.00003;
  for (let attempt = 0; attempt < 12; attempt++) {
    const simplified = turf.simplify(line, { tolerance, highQuality: false }).geometry.coordinates;
    if (simplified.length <= maxPoints && simplified.length >= 4) {
      return simplified.map((c) => [c[1], c[0]] as [number, number]);
    }
    if (simplified.length < 4) break;
    tolerance *= 1.6;
  }
  return simplifyCoordinates(coords, maxPoints);
}

type AreaFeature = ReturnType<typeof turf.polygon> | ReturnType<typeof turf.multiPolygon>;

/**
 * A valid polygon from a ring that may cross itself (a figure eight, an out-and-back on another
 * street): the ring is split where it crosses and the pieces are joined. Without this the area of a
 * crossing loop cancels out and intersections/differences go wrong.
 */
export function validPolygon(ring: number[][]): AreaFeature | null {
  const polygon = turf.polygon([ring]);
  let pieces: AreaFeature[] = [];
  try {
    pieces = turf.unkinkPolygon(polygon).features as AreaFeature[];
  } catch {
    pieces = [polygon];
  }
  pieces = pieces.filter((piece) => turf.area(piece) >= MIN_TERRITORY_PIECE_M2);
  if (pieces.length === 0) return null;
  if (pieces.length === 1) return pieces[0];
  try {
    const joined = turf.union(turf.featureCollection(pieces as any));
    return joined ? (joined as AreaFeature) : pieces[0];
  } catch {
    return pieces[0];
  }
}

/**
 * Territory geometry tidied after every union/difference: ~2 m simplification (vertices otherwise
 * pile up run after run) and no pieces or holes under MIN_TERRITORY_PIECE_M2 (slivers left along
 * borders). Returns null when nothing meaningful is left, the original if tidying fails.
 */
export function cleanGeometry(geometry: any): any | null {
  if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) return geometry;
  try {
    const polygons: number[][][][] = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    const kept: number[][][][] = [];
    for (const rings of polygons) {
      if (!rings.length || turf.area(turf.polygon([rings[0]])) < MIN_TERRITORY_PIECE_M2) continue;
      const holes = rings.slice(1).filter((hole) => hole.length >= 4 && turf.area(turf.polygon([hole])) >= MIN_TERRITORY_PIECE_M2);
      const simplified = turf.simplify(turf.polygon([rings[0], ...holes]), { tolerance: 0.00002, highQuality: false });
      kept.push(simplified.geometry.coordinates);
    }
    if (kept.length === 0) return null;
    const cleaned = kept.length === 1 ? { type: 'Polygon', coordinates: kept[0] } : { type: 'MultiPolygon', coordinates: kept };
    const before = turf.area(geometry);
    const after = turf.area(cleaned as any);
    // Simplifying must not change the territory: keep the original if the area moved more than 2 %
    if (!isFinite(after) || after <= 0 || Math.abs(after - before) > before * 0.02 + MIN_TERRITORY_PIECE_M2 * kept.length) {
      return geometry;
    }
    return cleaned;
  } catch {
    return geometry;
  }
}

/**
 * Convert a GPS route to a closed polygon representing the enclosed area.
 * Always closes the route by connecting last point → first point; a route that crosses itself
 * becomes the union of its loops. Returns null if the route has too few points or encloses nothing.
 */
export function routeToEnclosedPolygon(coords: Array<[number, number]>, maxSimplifyPoints: number = 150): AreaFeature | null {
  if (coords.length < 10) return null;

  const simplified = simplifyTrack(coords, maxSimplifyPoints);
  // Flip [lat, lng] → [lng, lat] for GeoJSON convention
  const ring = simplified
    .filter((c) => Number.isFinite(c[0]) && Number.isFinite(c[1]))
    .map((c: [number, number]) => [c[1], c[0]]);
  // Consecutive duplicates make degenerate edges
  const deduped = ring.filter((p, i) => i === 0 || p[0] !== ring[i - 1][0] || p[1] !== ring[i - 1][1]);
  if (deduped.length < 3) return null;

  // Close the ring: always connect last point to first point
  const first = deduped[0];
  const last = deduped[deduped.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    deduped.push([first[0], first[1]]);
  }
  if (deduped.length < 4) return null;

  try {
    const poly = validPolygon(deduped);
    if (!poly) return null;
    const area = turf.area(poly);
    if (!area || area <= 0 || !isFinite(area)) return null;
    return poly;
  } catch (e) {
    // Fallback: convex hull
    try {
      const line = turf.lineString(deduped.slice(0, -1));
      const hull = turf.convex(turf.explode(line));
      if (hull && turf.area(hull) > 0) return hull;
    } catch (_) {}
    return null;
  }
}

/** [minLng, minLat, maxLng, maxLat] of a geometry, or null. */
export function geometryBbox(geometry: any): [number, number, number, number] | null {
  try {
    const box = turf.bbox(geometry);
    return box.every(Number.isFinite) ? [box[0], box[1], box[2], box[3]] : null;
  } catch {
    return null;
  }
}

export function bboxesOverlap(a: number[] | null, b: number[] | null): boolean {
  if (!a || !b) return true;
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

// ─── Privacy ─────────────────────────────────────────────────────────────────

/** Other people don't see the part of a run this close to its start or its end (usually home). */
export const PRIVATE_ZONE_RADIUS_M = 200;

function metersBetween(a: [number, number], b: [number, number]): number {
  const dLat = (b[0] - a[0]) * 111_320;
  const dLng = (b[1] - a[1]) * 111_320 * Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

/**
 * The run as shown to other people: without the stretch near its start and near its end
 * (PRIVATE_ZONE_RADIUS_M), like Strava's privacy zones. Points are [lat, lng]. Empty when the whole
 * run stays near home.
 */
export function hidePrivateEnds(coords: Array<[number, number]>, radius: number = PRIVATE_ZONE_RADIUS_M): Array<[number, number]> {
  if (coords.length < 2) return [];
  const start = coords[0];
  const end = coords[coords.length - 1];
  let first = 0;
  while (first < coords.length && metersBetween(coords[first], start) < radius) first++;
  let last = coords.length - 1;
  while (last >= first && metersBetween(coords[last], end) < radius) last--;
  return last - first >= 1 ? coords.slice(first, last + 1) : [];
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
