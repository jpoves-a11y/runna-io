// Territory decay: the parts of your territory you haven't run over for DECAY_GRACE_DAYS wear away
// from the border inwards, DECAY_RATE_PER_DAY of that undefended area a day. Running inside a zone or
// along its edge (DEFENSE_CORRIDOR_M) defends it again. DECAY_WARNING_DAYS after the last run there
// the owner is warned that it starts wearing away in two days. Rest mode (up to REST_DAYS_PER_YEAR
// a year) freezes the clock.
import * as turf from '@turf/turf';
import { routeToEnclosedPolygon, simplifyTrack, cleanGeometry, MIN_TERRITORY_PIECE_M2 } from './territory';

export const DECAY_GRACE_DAYS = 14;
export const DECAY_WARNING_DAYS = 12;
export const DECAY_RATE_PER_DAY = 0.03;
/** Running this close to a zone (inside or along its edge) defends it. */
export const DEFENSE_CORRIDOR_M = 50;
export const REST_DAYS_PER_YEAR = 14;
/** How far the border moves in at most / at least in a day (metres). */
const MAX_STEP_M = 25;
const MIN_STEP_M = 2;

export const DAY_MS = 24 * 3600 * 1000;

/** Everything defended (the clock started less than the grace period ago). */
export const ALL = 'all' as const;
export type Defended = any | null | typeof ALL;

function feature(geometry: any): any {
  return geometry?.type === 'Feature' ? geometry : turf.feature(geometry);
}

function area(geometry: any | null): number {
  if (!geometry) return 0;
  try { return turf.area(feature(geometry)); } catch { return 0; }
}

function union(a: any | null, b: any | null): any | null {
  if (!a) return b;
  if (!b) return a;
  try {
    return turf.union(turf.featureCollection([feature(a), feature(b)]))?.geometry ?? a;
  } catch {
    return area(a) >= area(b) ? a : b;
  }
}

function difference(a: any | null, b: any | null): any | null {
  if (!a) return null;
  if (!b) return a;
  try {
    const rest = turf.difference(turf.featureCollection([feature(a), feature(b)]));
    return rest && turf.area(rest) >= 1 ? rest.geometry : null;
  } catch {
    return a;
  }
}

function intersection(a: any | null, b: any | null): any | null {
  if (!a || !b) return null;
  try {
    const inter = turf.intersect(turf.featureCollection([feature(a), feature(b)]));
    return inter && turf.area(inter) >= 1 ? inter.geometry : null;
  } catch {
    return null;
  }
}

/** Below MIN_TERRITORY_PIECE_M2 a zone is noise. */
function meaningful(geometry: any | null): any | null {
  return geometry && area(geometry) >= MIN_TERRITORY_PIECE_M2 ? geometry : null;
}

/** What a set of runs defends: the area each one encloses plus a corridor along the track. */
export function defendedFootprint(tracks: Array<Array<[number, number]>>): any | null {
  let result: any | null = null;
  for (const coords of tracks) {
    if (!coords || coords.length < 2) continue;
    const simplified = simplifyTrack(coords, 150);
    try {
      const line = turf.lineString(simplified.map(([lat, lng]) => [lng, lat]));
      const corridor = turf.buffer(line, DEFENSE_CORRIDOR_M, { units: 'meters' });
      if (corridor) result = union(result, corridor.geometry);
    } catch { /* degenerate track */ }
    if (coords.length >= 10) {
      const enclosed = routeToEnclosedPolygon(coords);
      if (enclosed) result = union(result, enclosed.geometry);
    }
  }
  return result;
}

export interface DecayResult {
  /** The territory after today's wear (null when nothing is left). */
  geometry: any | null;
  /** m² worn away today. */
  lost: number;
  /** Undefended part still wearing away (drawn dashed on the map). */
  weak: any | null;
  /** Defended part that starts wearing away within two days. */
  atRisk: any | null;
}

/**
 * One day of wear for a territory. `defended` is what the runs of the grace period defend and
 * `defendedRecently` what the runs of the warning period defend (ALL = everything).
 */
export function decayTerritory(territory: any, defended: Defended, defendedRecently: Defended, rate = DECAY_RATE_PER_DAY): DecayResult {
  const before = area(territory);
  const stale = defended === ALL ? null : meaningful(difference(territory, defended));
  let geometry: any | null = territory;
  let weak: any | null = null;
  let lost = 0;
  if (stale) {
    // Move the border in by d where it's undefended: about `rate` of the undefended area
    let perimeter = 0;
    try { perimeter = turf.length(turf.polygonToLine(feature(stale)) as any, { units: 'meters' }); } catch { perimeter = 0; }
    const staleArea = area(stale);
    const step = Math.min(MAX_STEP_M, Math.max(MIN_STEP_M, perimeter > 0 ? (rate * staleArea) / perimeter : MIN_STEP_M));
    let inner: any | null = null;
    try { inner = turf.buffer(feature(territory), -step, { units: 'meters' })?.geometry ?? null; } catch { inner = null; }
    if (inner && area(inner) < 1) inner = null;
    const strip = inner ? difference(stale, inner) : stale;
    if (strip) {
      const rest = difference(territory, strip);
      geometry = rest ? (cleanGeometry(rest) ?? rest) : null;
      if (geometry && area(geometry) < MIN_TERRITORY_PIECE_M2) geometry = null;
      lost = Math.max(0, before - area(geometry));
    }
    weak = geometry ? meaningful(intersection(geometry, stale)) : null;
  }
  let atRisk: any | null = null;
  if (defendedRecently !== ALL && geometry) {
    const stillDefended = defended === ALL ? geometry : intersection(geometry, defended);
    atRisk = meaningful(difference(stillDefended, defendedRecently));
  }
  return { geometry, lost, weak, atRisk };
}

/** A point inside a geometry ([lat, lng]) to open the map there. */
export function insidePoint(geometry: any | null): { lat: number; lng: number } | null {
  if (!geometry) return null;
  try {
    const [lng, lat] = turf.pointOnFeature(feature(geometry)).geometry.coordinates;
    return { lat, lng };
  } catch {
    return null;
  }
}

/** Union of several geometries (null entries ignored). */
export function unionAll(geometries: Array<any | null>): any | null {
  return geometries.reduce((acc, geometry) => union(acc, geometry), null);
}

/** The geometry without a defended footprint (a run just went through). */
export function withoutDefended(geometry: any | null, footprint: any | null): any | null {
  return meaningful(difference(geometry, footprint));
}
