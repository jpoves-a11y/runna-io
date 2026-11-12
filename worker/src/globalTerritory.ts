// Global mode geometry: a runner's world territory is the union of everything their accepted runs
// enclosed. A run only adds the part that wasn't already theirs, and nobody can take it away.
import * as turf from '@turf/turf';
import { routeToEnclosedPolygon } from './territory';
import { WIDE_TRAIL_METERS } from '../../shared/game';

type AreaGeometry = { type: 'Polygon'; coordinates: number[][][] } | { type: 'MultiPolygon'; coordinates: number[][][][] };

function toFeature(geometry: AreaGeometry): any {
  return geometry.type === 'MultiPolygon' ? turf.multiPolygon(geometry.coordinates) : turf.polygon(geometry.coordinates);
}

export function parseGeometry(value: unknown): AreaGeometry | null {
  if (!value) return null;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (parsed && (parsed.type === 'Polygon' || parsed.type === 'MultiPolygon') && Array.isArray(parsed.coordinates)) return parsed;
    if (parsed?.type === 'Feature') return parseGeometry(parsed.geometry);
  } catch {
    /* invalid */
  }
  return null;
}

export function geometryArea(geometry: AreaGeometry | null): number {
  if (!geometry) return 0;
  try {
    const area = turf.area(toFeature(geometry));
    return Number.isFinite(area) ? area : 0;
  } catch {
    return 0;
  }
}

export function unionGeometries(a: AreaGeometry | null, b: AreaGeometry | null): AreaGeometry | null {
  if (!a) return b;
  if (!b) return a;
  try {
    const result = turf.union(turf.featureCollection([toFeature(a), toFeature(b)]));
    return result ? (result.geometry as AreaGeometry) : null;
  } catch (error) {
    console.error('[GLOBAL] union failed:', error);
    return null;
  }
}

/** Part of `a` that is not in `b` (null when nothing is left). */
export function differenceGeometry(a: AreaGeometry, b: AreaGeometry | null): AreaGeometry | null {
  if (!b) return a;
  try {
    const result = turf.difference(turf.featureCollection([toFeature(a), toFeature(b)]));
    return result ? (result.geometry as AreaGeometry) : null;
  } catch (error) {
    console.error('[GLOBAL] difference failed:', error);
    throw error;
  }
}

/** Keeps stored geometries small: ~1 m tolerance, 6 decimals (~10 cm). */
export function compactGeometry(geometry: AreaGeometry): AreaGeometry {
  try {
    const simplified = turf.simplify(toFeature(geometry), { tolerance: 0.00001, highQuality: false, mutate: false });
    const truncated = turf.truncate(simplified, { precision: 6, coordinates: 2, mutate: true });
    const result = truncated.geometry as AreaGeometry;
    // Simplification must not change the area noticeably
    const before = geometryArea(geometry);
    const after = geometryArea(result);
    if (before > 0 && Math.abs(after - before) / before > 0.01) return geometry;
    return result;
  } catch {
    return geometry;
  }
}

/**
 * Area geometry of one run built from the valid stretches of its track (see antiCheat.ts): the
 * enclosed polygon of each stretch long enough, plus a strip along the track with "Estela ancha".
 */
export function runAreaGeometry(segments: Array<Array<[number, number]>>, options: { wideTrail?: boolean } = {}): AreaGeometry | null {
  let result: AreaGeometry | null = null;
  for (const segment of segments) {
    if (segment.length >= 10) {
      const poly = routeToEnclosedPolygon(segment, 150);
      if (poly) result = unionGeometries(result, poly.geometry as AreaGeometry) ?? result;
    }
    if (options.wideTrail && segment.length >= 2) {
      try {
        const line = turf.lineString(segment.map(([lat, lng]) => [lng, lat]));
        const strip = turf.buffer(line, WIDE_TRAIL_METERS, { units: 'meters' });
        if (strip) result = unionGeometries(result, strip.geometry as AreaGeometry) ?? result;
      } catch (error) {
        console.error('[GLOBAL] wide trail buffer failed:', error);
      }
    }
  }
  return result;
}

export interface GlobalMergeResult {
  /** New union to store */
  merged: AreaGeometry;
  /** Area of the run that wasn't in the territory before (m²) */
  newArea: number;
  /** Area of the stored union (m²) */
  totalArea: number;
}

/**
 * Adds a run's area to a global territory. Never loses area: if the union looks wrong (smaller
 * than before, or failed) the previous territory is kept and the run adds nothing.
 */
export function mergeIntoGlobal(existing: AreaGeometry | null, run: AreaGeometry | null): GlobalMergeResult | null {
  const existingArea = geometryArea(existing);
  if (!run) return existing ? { merged: existing, newArea: 0, totalArea: existingArea } : null;

  let fresh: AreaGeometry | null;
  try {
    fresh = differenceGeometry(run, existing);
  } catch {
    return existing ? { merged: existing, newArea: 0, totalArea: existingArea } : null;
  }
  const newArea = geometryArea(fresh);
  if (newArea < 1) {
    return existing ? { merged: existing, newArea: 0, totalArea: existingArea } : null;
  }
  const union = unionGeometries(existing, run);
  if (!union) return existing ? { merged: existing, newArea: 0, totalArea: existingArea } : null;
  const merged = compactGeometry(union);
  const totalArea = geometryArea(merged);
  if (totalArea + 1 < existingArea) {
    console.error(`[GLOBAL] union smaller than the territory (${totalArea} < ${existingArea}), keeping the old one`);
    return existing ? { merged: existing, newArea: 0, totalArea: existingArea } : null;
  }
  // The new area is what the total grew by (consistent with the stored geometry)
  return { merged, newArea: Math.max(0, totalArea - existingArea), totalArea };
}

/**
 * Brújula: the nearest spots not explored yet, around `center` ([lat, lng]). A grid of cells of
 * `cellMeters` within `radiusMeters`; a cell counts as explored when its centre is inside the
 * global map. Picks are kept at least 2 cells apart, nearest first.
 */
export function unexploredSpots(
  geometry: AreaGeometry | null,
  center: [number, number],
  count = 3,
  cellMeters = 300,
  radiusMeters = 3000,
): Array<{ lat: number; lng: number; distanceMeters: number }> {
  const [lat0, lng0] = center;
  const dLat = cellMeters / 111_320;
  const dLng = cellMeters / (111_320 * Math.cos((lat0 * Math.PI) / 180));
  const steps = Math.ceil(radiusMeters / cellMeters);
  const feature = geometry ? turf.feature(geometry as any) : null;
  const candidates: Array<{ lat: number; lng: number; distanceMeters: number }> = [];
  for (let i = -steps; i <= steps; i++) {
    for (let j = -steps; j <= steps; j++) {
      const lat = lat0 + i * dLat;
      const lng = lng0 + j * dLng;
      const distanceMeters = turf.distance([lng0, lat0], [lng, lat], { units: 'meters' });
      if (distanceMeters > radiusMeters || distanceMeters < cellMeters) continue;
      if (feature && turf.booleanPointInPolygon(turf.point([lng, lat]), feature as any)) continue;
      candidates.push({ lat, lng, distanceMeters });
    }
  }
  candidates.sort((a, b) => a.distanceMeters - b.distanceMeters);
  const picks: typeof candidates = [];
  for (const c of candidates) {
    if (picks.some((p) => turf.distance([p.lng, p.lat], [c.lng, c.lat], { units: 'meters' }) < cellMeters * 2)) continue;
    picks.push({ ...c, distanceMeters: Math.round(c.distanceMeters) });
    if (picks.length >= count) break;
  }
  return picks;
}
