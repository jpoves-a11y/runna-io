// What the home-screen widgets draw: the outline of a world map, light enough for a widget (a few
// hundred points), and the shape of the competition's podium.

type Ring = number[][];
/** A polygon: outer ring first, then holes; points are [lng, lat]. */
type Polygon = Ring[];
type Geometry = { type: 'Polygon'; coordinates: number[][][] } | { type: 'MultiPolygon'; coordinates: number[][][][] };

export type Bounds = { minLng: number; minLat: number; maxLng: number; maxLat: number };

export function polygonsOf(geometry: Geometry | null): Polygon[] {
  if (!geometry) return [];
  const list = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  return list.filter((polygon) => Array.isArray(polygon) && Array.isArray(polygon[0]) && polygon[0].length >= 4);
}

/** Distance from a point to a segment, in degrees (fine for simplifying at a city's scale). */
function segmentDistance(p: number[], a: number[], b: number[]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length));
  const x = a[0] + t * dx - p[0];
  const y = a[1] + t * dy - p[1];
  return Math.sqrt(x * x + y * y);
}

/** Douglas-Peucker on a closed ring; keeps it closed and at least a triangle. */
export function simplifyRing(ring: Ring, tolerance: number): Ring {
  if (ring.length <= 4) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = 1;
  keep[ring.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, ring.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop()!;
    let worst = -1;
    let index = -1;
    for (let i = start + 1; i < end; i++) {
      const d = segmentDistance(ring[i], ring[start], ring[end]);
      if (d > worst) {
        worst = d;
        index = i;
      }
    }
    if (index !== -1 && worst > tolerance) {
      keep[index] = 1;
      stack.push([start, index], [index, end]);
    }
  }
  const result = ring.filter((_, i) => keep[i]);
  // A closed ring whose start and end coincide: keep the farthest point so it isn't flat
  if (result.length < 4) {
    let far = 1;
    let best = -1;
    for (let i = 1; i < ring.length - 1; i++) {
      const d = segmentDistance(ring[i], ring[0], ring[0]);
      if (d > best) {
        best = d;
        far = i;
      }
    }
    const mid = Math.max(1, Math.min(ring.length - 2, far));
    const other = mid > ring.length / 2 ? Math.floor(mid / 2) : Math.floor((mid + ring.length - 1) / 2);
    return [ring[0], ring[Math.min(mid, other)], ring[Math.max(mid, other)], ring[ring.length - 1]];
  }
  return result;
}

function pointCount(polygons: Polygon[]): number {
  return polygons.reduce((sum, polygon) => sum + polygon.reduce((s, ring) => s + ring.length, 0), 0);
}

export function boundsOf(polygons: Polygon[]): Bounds | null {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const polygon of polygons) {
    for (const [lng, lat] of polygon[0] ?? []) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return Number.isFinite(minLng) ? { minLng, minLat, maxLng, maxLat } : null;
}

export function intersects(a: Bounds, b: Bounds): boolean {
  return a.minLng <= b.maxLng && b.minLng <= a.maxLng && a.minLat <= b.maxLat && b.minLat <= a.maxLat;
}

/** Bounds grown by a fraction of their size on each side (and at least `minDegrees` across). */
export function padBounds(bounds: Bounds, fraction: number, minDegrees = 0.004): Bounds {
  const width = Math.max(bounds.maxLng - bounds.minLng, minDegrees);
  const height = Math.max(bounds.maxLat - bounds.minLat, minDegrees);
  const cx = (bounds.minLng + bounds.maxLng) / 2;
  const cy = (bounds.minLat + bounds.maxLat) / 2;
  return {
    minLng: cx - (width / 2) * (1 + 2 * fraction),
    maxLng: cx + (width / 2) * (1 + 2 * fraction),
    minLat: cy - (height / 2) * (1 + 2 * fraction),
    maxLat: cy + (height / 2) * (1 + 2 * fraction),
  };
}

/**
 * The polygons simplified until they fit in `maxPoints` (the tolerance grows from ~1 m), with
 * specks that wouldn't show at the widget's scale dropped and coordinates rounded to ~1 m.
 */
export function simplifyForWidget(polygons: Polygon[], maxPoints: number): Polygon[] {
  const bounds = boundsOf(polygons);
  if (!bounds) return [];
  const span = Math.max(bounds.maxLng - bounds.minLng, bounds.maxLat - bounds.minLat, 1e-6);
  // Anything smaller than ~0.6 % of the drawing is a speck
  const speck = span * 0.006;
  const visible = polygons
    .map((polygon) => polygon.filter((ring, i) => {
      const b = boundsOf([[ring]]);
      return b && (i === 0 || Math.max(b.maxLng - b.minLng, b.maxLat - b.minLat) > speck);
    }))
    .filter((polygon) => {
      const b = boundsOf([polygon]);
      return b && Math.max(b.maxLng - b.minLng, b.maxLat - b.minLat) > speck;
    });
  let tolerance = 0.00001;
  let result = visible;
  for (let step = 0; step < 24; step++) {
    result = visible.map((polygon) => polygon.map((ring) => simplifyRing(ring, tolerance)));
    if (pointCount(result) <= maxPoints) break;
    tolerance *= 1.6;
  }
  const round = (v: number) => Math.round(v * 1e5) / 1e5;
  return result.map((polygon) => polygon.map((ring) => ring.map(([lng, lat]) => [round(lng), round(lat)])));
}

export interface StandingLike {
  userId: string;
  name: string;
  score: number;
  rank: number;
}

/** The top three, and where I stand with the gap to whoever is just ahead. */
export function podiumOf(standings: StandingLike[], userId: string, colors: Map<string, string | null>) {
  const top = standings.slice(0, 3).map((s) => ({
    name: s.name,
    color: colors.get(s.userId) ?? null,
    score: s.score,
    rank: s.rank,
    me: s.userId === userId,
  }));
  const index = standings.findIndex((s) => s.userId === userId);
  const mine = index >= 0 ? standings[index] : null;
  const ahead = index > 0 ? standings[index - 1] : null;
  return {
    top,
    me: mine
      ? {
          rank: mine.rank,
          score: mine.score,
          color: colors.get(userId) ?? null,
          ahead: ahead ? { name: ahead.name, gap: Math.max(0, ahead.score - mine.score) } : null,
        }
      : null,
  };
}
