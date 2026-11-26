// Bastión: the zone of your competition territory around a point you choose.
//
// The zone is the part of your territory inside a circle around the point, with the circle grown
// until it holds BASTION_AREA_M2 of territory (or reaches BASTION_MAX_RADIUS_M):
//   - a point inside your territory: the circle is centred there;
//   - a point outside (or on the very edge): it moves to the nearest point of your territory, and
//     the app says so (`snapped`);
//   - not that much territory around (a small zone, or thin strips): the zone is all the territory
//     within the largest circle (`complete` is false, `area` says how much it is).
// Only territory you already hold is ever reinforced: the zone is always a piece of it.
import * as turf from '@turf/turf';
import { BASTION_AREA_M2, BASTION_MAX_RADIUS_M } from '../../shared/game';

type Polygon = { type: 'Polygon'; coordinates: number[][][] };

export interface BastionZone {
  /** Where the circle is centred: the chosen point, or the nearest point of the territory */
  center: { lat: number; lng: number };
  /** The chosen point was outside the territory (the centre moved to it) */
  snapped: boolean;
  /** Metres the centre moved */
  snappedMeters: number;
  /** The zone (GeoJSON Polygon or MultiPolygon, [lng, lat]) */
  geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: any };
  area: number;
  radiusM: number;
  /** It reached BASTION_AREA_M2 (else there wasn't that much territory around) */
  complete: boolean;
}

/** The polygons of a list of territory geometries (Polygon / MultiPolygon, as stored). */
export function territoryPolygons(geometries: any[]): Polygon[] {
  const polygons: Polygon[] = [];
  for (const raw of geometries) {
    const geometry = typeof raw === 'string' ? safeParse(raw) : raw;
    if (geometry?.type === 'Polygon') polygons.push(geometry);
    else if (geometry?.type === 'MultiPolygon') for (const coordinates of geometry.coordinates) polygons.push({ type: 'Polygon', coordinates });
  }
  return polygons.filter((p) => Array.isArray(p.coordinates?.[0]) && p.coordinates[0].length >= 4 && turf.area(p as any) >= 1);
}

function safeParse(value: string): any {
  try { return JSON.parse(value); } catch { return null; }
}

/** Part of the polygons inside a circle, and its area. */
function insideCircle(polygons: Polygon[], center: [number, number], radiusM: number): { pieces: Polygon[]; area: number } {
  const circle = turf.circle(center, radiusM / 1000, { steps: 48, units: 'kilometers' });
  const box = turf.bbox(circle);
  const pieces: Polygon[] = [];
  let area = 0;
  for (const polygon of polygons) {
    const b = turf.bbox(polygon as any);
    if (b[0] > box[2] || b[2] < box[0] || b[1] > box[3] || b[3] < box[1]) continue;
    let cut: any = null;
    try { cut = turf.intersect(turf.featureCollection([turf.feature(polygon as any) as any, circle as any])); } catch { cut = null; }
    if (!cut) continue;
    for (const piece of territoryPolygons([cut.geometry])) {
      pieces.push(piece);
      area += turf.area(piece as any);
    }
  }
  return { pieces, area };
}

/** The Bastión zone around `point` ([lat, lng]); null when there's no territory. */
export function bastionZone(geometries: any[], point: { lat: number; lng: number }, target = BASTION_AREA_M2, maxRadius = BASTION_MAX_RADIUS_M): BastionZone | null {
  const polygons = territoryPolygons(geometries);
  if (polygons.length === 0) return null;
  const chosen = turf.point([point.lng, point.lat]);
  let center: [number, number] = [point.lng, point.lat];
  let snapped = false;
  let snappedMeters = 0;
  if (!polygons.some((p) => turf.booleanPointInPolygon(chosen, p as any))) {
    let best: { coords: [number, number]; meters: number } | null = null;
    for (const polygon of polygons) {
      const outline = turf.polygonToLine(polygon as any) as any;
      const near = turf.nearestPointOnLine(outline.geometry.type === 'LineString' || outline.geometry.type === 'MultiLineString' ? outline : outline.features[0], chosen, { units: 'meters' });
      const meters = Number(near.properties.dist ?? Infinity);
      if (!best || meters < best.meters) best = { coords: near.geometry.coordinates as [number, number], meters };
    }
    if (!best) return null;
    center = best.coords;
    snapped = true;
    snappedMeters = Math.round(best.meters);
  }
  // The smallest circle that holds `target` of territory (binary search on the radius)
  const widest = insideCircle(polygons, center, maxRadius);
  if (widest.area <= 0) return null;
  let radius = maxRadius;
  let zone = widest;
  if (widest.area > target) {
    let low = Math.sqrt(target / Math.PI); // a circle all inside the territory
    let high = maxRadius;
    for (let i = 0; i < 12 && high - low > 10; i++) {
      const mid = (low + high) / 2;
      const inside = insideCircle(polygons, center, mid);
      if (inside.area >= target) {
        high = mid;
        zone = inside;
      } else {
        low = mid;
      }
    }
    radius = high;
    if (zone === widest) zone = insideCircle(polygons, center, high);
  }
  const geometry = zone.pieces.length === 1
    ? { type: 'Polygon' as const, coordinates: zone.pieces[0].coordinates }
    : { type: 'MultiPolygon' as const, coordinates: zone.pieces.map((p) => p.coordinates) };
  return {
    center: { lat: center[1], lng: center[0] },
    snapped,
    snappedMeters,
    geometry,
    area: zone.area,
    radiusM: Math.round(radius),
    complete: zone.area >= target * 0.98,
  };
}
