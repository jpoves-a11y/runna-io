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
