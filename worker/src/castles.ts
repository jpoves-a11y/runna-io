// Castles (fortifications): running again over your own territory builds a castle on the part you
// ran over. A zone holds up to MAX_FORTIFICATION_LAYERS castles and each one lasts
// FORTIFICATION_TTL_DAYS. Every castle stops one attack: a rival who runs over the zone destroys one
// castle and steals nothing there; with no castles left the zone can be stolen as usual.
import * as turf from '@turf/turf';
import { geometryBbox, bboxesOverlap } from './territory';

/** Overlap below this (m²) isn't the same zone / doesn't touch the zone (GPS noise along borders). */
const MIN_OVERLAP_M2 = 10;

export interface CastleRecord {
  id: string;
  /** Parsed GeoJSON Polygon / MultiPolygon. */
  geometry: any;
  createdAt: string;
}

export interface CastleZone {
  /** Records of the zone, oldest first. */
  records: CastleRecord[];
  /** Union of the records. */
  geometry: any;
}

function overlapArea(a: any, b: any): number {
  try {
    const inter = turf.intersect(turf.featureCollection([turf.feature(a) as any, turf.feature(b) as any]));
    return inter ? turf.area(inter) : 0;
  } catch {
    return 0;
  }
}

function unionAll(geometries: any[]): any | null {
  let result: any = null;
  for (const geometry of geometries) {
    if (!result) {
      result = geometry;
      continue;
    }
    try {
      const merged = turf.union(turf.featureCollection([turf.feature(result) as any, turf.feature(geometry) as any]));
      if (merged) result = merged.geometry;
    } catch { /* keep what we have */ }
  }
  return result;
}

const time = (value: string) => {
  const parsed = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Groups castle records that overlap each other into zones (each record is one castle). */
export function groupCastleZones(records: CastleRecord[]): CastleZone[] {
  const sorted = [...records].sort((a, b) => time(a.createdAt) - time(b.createdAt));
  const boxes = sorted.map((record) => geometryBbox(record.geometry));
  const parent = sorted.map((_, index) => index);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (find(i) === find(j) || !bboxesOverlap(boxes[i], boxes[j])) continue;
      if (overlapArea(sorted[i].geometry, sorted[j].geometry) > MIN_OVERLAP_M2) parent[find(j)] = find(i);
    }
  }
  const groups = new Map<number, CastleRecord[]>();
  sorted.forEach((record, index) => {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(record);
  });
  return [...groups.values()].map((zoneRecords) => ({
    records: zoneRecords,
    geometry: unionAll(zoneRecords.map((record) => record.geometry)),
  }));
}

export interface CastleDefense {
  /** Part of the attack protected by castles (not stolen), or null. */
  protectedGeometry: any | null;
  /** Castles destroyed by this attack. */
  destroyedIds: string[];
  /** Zones that stopped the attack. */
  zonesHit: number;
  /** Castles left in those zones after the attack. */
  remaining: number;
}

/**
 * What a defender's castles do against an attack: every zone the attack touches protects its area
 * and loses its oldest castle (all of them with the battering ram).
 */
export function castleDefense(attack: any, records: CastleRecord[], options: { breakAll?: boolean } = {}): CastleDefense {
  const attackBox = geometryBbox(attack);
  const touching = records.filter((record) =>
    bboxesOverlap(attackBox, geometryBbox(record.geometry)) && overlapArea(attack, record.geometry) > MIN_OVERLAP_M2);
  if (touching.length === 0) return { protectedGeometry: null, destroyedIds: [], zonesHit: 0, remaining: 0 };
  const zones = groupCastleZones(touching);
  const destroyedIds: string[] = [];
  for (const zone of zones) {
    if (options.breakAll) destroyedIds.push(...zone.records.map((record) => record.id));
    else destroyedIds.push(zone.records[0].id);
  }
  return {
    protectedGeometry: unionAll(zones.map((zone) => zone.geometry).filter(Boolean)),
    destroyedIds,
    zonesHit: zones.length,
    remaining: zones.reduce((sum, zone) => sum + zone.records.length, 0) - destroyedIds.length,
  };
}

/** The attack without the protected part (null when nothing is left to steal). */
export function attackWithoutProtected(attack: any, protectedGeometry: any | null): any | null {
  if (!protectedGeometry) return attack;
  try {
    const rest = turf.difference(turf.featureCollection([turf.feature(attack) as any, turf.feature(protectedGeometry) as any]));
    if (!rest || turf.area(rest) < MIN_OVERLAP_M2) return null;
    return rest.geometry;
  } catch {
    return attack;
  }
}

/** A point inside the zone where its castle marker is drawn ([lat, lng]). */
export function castleMarkerPoint(geometry: any): [number, number] | null {
  try {
    const point = turf.pointOnFeature(turf.feature(geometry) as any);
    const [lng, lat] = point.geometry.coordinates;
    return [lat, lng];
  } catch {
    return null;
  }
}
