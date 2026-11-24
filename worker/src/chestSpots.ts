// Where rest-day chests appear: real places of each city, from OpenStreetMap.
//
// For every city with club members the Worker asks OpenStreetMap (Overpass API) once a month:
// 1. where the city really is (its place node: centre, city / town / village, population);
// 2. the places a runner can reach inside its urban area:
//    - cities ("poi" mode): parks and gardens, squares and pedestrian streets, monuments, viewpoints,
//      attractions, fountains, running tracks;
//    - towns and villages ("streets" mode): pedestrian, residential and living streets, footpaths,
//      parks and squares near the centre;
//    and the areas no chest should be in (industrial estates, retail parks, railways, farmland,
//    quarries, military land, airports...).
// The result is cached in chest_areas (one row per city) and chests are drawn from it. Until a city
// has its places (or if OpenStreetMap can't be reached), chests fall back to a point near the club
// members of that city, within a small radius.
//
// Privacy: the first query only carries the members' centre rounded to 0.1° (about 10 km), never a
// home; the second one uses the public centre of the city. Data © OpenStreetMap contributors (ODbL).

/** Public Overpass servers, tried in order: they are often busy (502, 504, 429). */
export const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
/** How long the places of a city are kept before asking OpenStreetMap again. */
export const CHEST_AREA_REFRESH_MS = 30 * 24 * 3600 * 1000;
/** After a failed attempt, the next one waits this long. */
export const CHEST_AREA_RETRY_MS = 6 * 3600 * 1000;
/** A new chest stays at least this far from the active ones and the last days' ones of the city. */
export const CHEST_MIN_SPACING_M = 400;
const MAX_SPOTS = 400;
/** Two places closer than this are the same place for chests. */
const MIN_SPOT_GAP_M = 120;

export type ChestSpotKind = 'landmark' | 'square' | 'pedestrian' | 'park' | 'track' | 'fountain' | 'street';

export interface ChestSpot {
  lat: number;
  lng: number;
  kind: ChestSpotKind;
  name: string | null;
  weight: number;
}

export interface CityPlace {
  name: string;
  lat: number;
  lng: number;
  placeType: string;
  population: number | null;
}

export type ChestAreaMode = 'poi' | 'streets';

interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  geometry?: Array<{ lat: number; lon: number }>;
  tags?: Record<string, string>;
}

// ─── Geometry ───────────────────────────────────────────────────────────────

export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Ray casting: is the point inside the closed ring? */
export function insideRing(point: { lat: number; lng: number }, ring: Array<{ lat: number; lng: number }>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if ((a.lat > point.lat) !== (b.lat > point.lat)
      && point.lng < ((b.lng - a.lng) * (point.lat - a.lat)) / (b.lat - a.lat) + a.lng) {
      inside = !inside;
    }
  }
  return inside;
}

// ─── Size of the city ───────────────────────────────────────────────────────

/** How far from the centre chests can appear: the urban core, by population (or place type). */
export function radiusFor(placeType: string, population: number | null): number {
  if (population && population > 0) {
    if (population >= 500_000) return 4000;
    if (population >= 100_000) return 3000;
    if (population >= 30_000) return 2000;
    if (population >= 10_000) return 1300;
    return 800;
  }
  if (placeType === 'city') return 2500;
  if (placeType === 'town') return 1300;
  return 800;
}

/** Cities get their places of interest; towns and villages, their accessible streets. */
export function modeFor(placeType: string, population: number | null): ChestAreaMode {
  if (population && population > 0) return population >= 20_000 ? 'poi' : 'streets';
  return placeType === 'city' ? 'poi' : 'streets';
}

// ─── 1. Where the city is ───────────────────────────────────────────────────

const PLACE_RANK: Record<string, number> = { city: 3, town: 2, village: 1 };

/** Lower case, no accents, single spaces. */
export function normalizeName(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Overpass query: cities, towns and villages around the members' centre, rounded to 0.1°. */
export function placeQuery(lat: number, lng: number): string {
  const rLat = Math.round(lat * 10) / 10;
  const rLng = Math.round(lng * 10) / 10;
  // "out body": nodes with their coordinates ("out tags" would leave them out)
  return `[out:json][timeout:25];node["place"~"^(city|town|village)$"](around:20000,${rLat},${rLng});out body qt 400;`;
}

/**
 * The place node of the city: the one whose name (or Spanish, official or alternative name) is the
 * members' city name, the biggest if several; otherwise the biggest place within 6 km of the members.
 */
export function pickPlace(json: unknown, cityName: string, memberLat: number, memberLng: number): CityPlace | null {
  const elements = (json as { elements?: OsmElement[] })?.elements ?? [];
  const wanted = normalizeName(cityName);
  const members = { lat: memberLat, lng: memberLng };
  type Candidate = CityPlace & { rank: number; distance: number; matches: boolean };
  const candidates: Candidate[] = [];
  for (const element of elements) {
    if (element.type !== 'node' || typeof element.lat !== 'number' || typeof element.lon !== 'number') continue;
    const tags = element.tags ?? {};
    const placeType = tags.place;
    if (!placeType || !(placeType in PLACE_RANK) || !tags.name) continue;
    const names = [tags.name, tags['name:es'], tags.official_name, tags.alt_name, tags.short_name]
      .filter((n): n is string => typeof n === 'string' && n.length > 0)
      .flatMap((n) => n.split(/[\/;]| - /))
      .map(normalizeName)
      .filter(Boolean);
    const population = Number(String(tags.population ?? '').replace(/[^0-9]/g, ''));
    const point = { lat: element.lat, lng: element.lon };
    candidates.push({
      name: tags['name:es'] || tags.name,
      lat: element.lat,
      lng: element.lon,
      placeType,
      population: Number.isFinite(population) && population > 0 ? population : null,
      rank: PLACE_RANK[placeType],
      distance: distanceM(point, members),
      matches: wanted.length > 0 && names.includes(wanted),
    });
  }
  const byImportance = (a: Candidate, b: Candidate) =>
    b.rank - a.rank || (b.population ?? 0) - (a.population ?? 0) || a.distance - b.distance;
  const named = candidates.filter((c) => c.matches && c.distance <= 25_000).sort(byImportance);
  const chosen = named[0] ?? candidates.filter((c) => c.distance <= 6000).sort(byImportance)[0];
  if (!chosen) return null;
  return { name: chosen.name, lat: chosen.lat, lng: chosen.lng, placeType: chosen.placeType, population: chosen.population };
}

// ─── 2. The places of the city ──────────────────────────────────────────────

const EXCLUDED_LANDUSE = 'industrial|retail|railway|military|quarry|landfill|farmland|farmyard|construction|brownfield|greenhouse_horticulture|depot';

/** Overpass query: the candidate places within `radius` m of the centre, and the areas to avoid. */
export function spotsQuery(lat: number, lng: number, radius: number, mode: ChestAreaMode): string {
  const around = `(around:${Math.round(radius)},${lat.toFixed(6)},${lng.toFixed(6)})`;
  const aroundBad = `(around:${Math.round(radius + 300)},${lat.toFixed(6)},${lng.toFixed(6)})`;
  // Big cities: only named parks and pedestrian streets (the unnamed ones are the least interesting
  // and make the query too heavy for the public servers)
  const named = radius >= 3000 ? '["name"]' : '';
  const places = mode === 'poi'
    ? [
      `nwr["leisure"~"^(park|garden)$"]${named}${around};`,
      `nwr["place"="square"]${around};`,
      `way["highway"="pedestrian"]${named}${around};`,
      `nwr["tourism"~"^(attraction|viewpoint|artwork|museum)$"]${around};`,
      `nwr["historic"~"^(monument|memorial|castle|city_gate|fort|ruins|archaeological_site)$"]${around};`,
      `node["amenity"="fountain"]${around};`,
      `nwr["leisure"="track"]["sport"~"running|athletics"]${around};`,
    ]
    : [
      `way["highway"~"^(pedestrian|living_street|residential|footway)$"]["access"!~"^(private|no)$"]${around};`,
      `nwr["leisure"~"^(park|garden)$"]${around};`,
      `nwr["place"="square"]${around};`,
    ];
  // Nodes with their coordinates; ways and relations with their centre and tags (no member lists);
  // the areas to avoid with their outline
  return `[out:json][timeout:90];(${places.join('')})->.spots;`
    + `node.spots;out body qt 1500;way.spots;out tags center qt 1500;rel.spots;out tags center qt 300;`
    + `(way["landuse"~"^(${EXCLUDED_LANDUSE})$"]${aroundBad};way["aeroway"="aerodrome"]${aroundBad};)->.avoid;.avoid out geom qt 600;`;
}

function kindOf(tags: Record<string, string>): { kind: ChestSpotKind; weight: number } | null {
  if (tags.tourism === 'attraction' || tags.tourism === 'viewpoint' || tags.tourism === 'museum' || tags.historic) {
    return { kind: 'landmark', weight: 3 };
  }
  if (tags.place === 'square') return { kind: 'square', weight: 3 };
  if (tags.highway === 'pedestrian') return { kind: tags.area === 'yes' ? 'square' : 'pedestrian', weight: tags.area === 'yes' ? 3 : 2 };
  if (tags.leisure === 'park' || tags.leisure === 'garden') return { kind: 'park', weight: tags.name ? 2.5 : 1.5 };
  if (tags.leisure === 'track') return { kind: 'track', weight: 2 };
  if (tags.amenity === 'fountain' || tags.tourism === 'artwork') return { kind: 'fountain', weight: 1.5 };
  if (tags.highway) return { kind: 'street', weight: tags.highway === 'residential' ? 1 : 1.2 };
  return null;
}

/**
 * The places from an Overpass answer: inside the radius, out of the areas to avoid, none closer than
 * 120 m to a more interesting one, at most MAX_SPOTS.
 */
export function parseSpots(json: unknown, centre: { lat: number; lng: number }, radius: number): ChestSpot[] {
  const elements = (json as { elements?: OsmElement[] })?.elements ?? [];
  const avoid: Array<Array<{ lat: number; lng: number }>> = [];
  const raw: ChestSpot[] = [];
  for (const element of elements) {
    const tags = element.tags ?? {};
    if (element.geometry && element.geometry.length >= 4) {
      avoid.push(element.geometry.map((p) => ({ lat: p.lat, lng: p.lon })));
      continue;
    }
    const lat = element.lat ?? element.center?.lat;
    const lng = element.lon ?? element.center?.lon;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    if (tags.access === 'private' || tags.access === 'no') continue;
    const kind = kindOf(tags);
    if (!kind) continue;
    const point = { lat, lng };
    if (distanceM(point, centre) > radius) continue;
    raw.push({ lat, lng, kind: kind.kind, name: tags['name:es'] || tags.name || null, weight: kind.weight });
  }
  // Bounding boxes first: most places are nowhere near most of the areas to avoid
  const boxes = avoid.map((ring) => ({
    ring,
    minLat: Math.min(...ring.map((p) => p.lat)), maxLat: Math.max(...ring.map((p) => p.lat)),
    minLng: Math.min(...ring.map((p) => p.lng)), maxLng: Math.max(...ring.map((p) => p.lng)),
  }));
  const allowed = raw.filter((spot) => !boxes.some((b) =>
    spot.lat >= b.minLat && spot.lat <= b.maxLat && spot.lng >= b.minLng && spot.lng <= b.maxLng && insideRing(spot, b.ring)));
  // The most interesting first; a place closer than 120 m to one already kept is dropped
  allowed.sort((a, b) => b.weight - a.weight || a.lat - b.lat || a.lng - b.lng);
  const kept: ChestSpot[] = [];
  for (const spot of allowed) {
    if (kept.length >= MAX_SPOTS) break;
    if (kept.every((other) => distanceM(spot, other) >= MIN_SPOT_GAP_M)) kept.push(spot);
  }
  return kept;
}

// ─── Choosing where the next chest goes ─────────────────────────────────────

/**
 * A spot for a chest of this rarity: away from the given points (active chests and the last days'
 * ones of the city), rare chests at landmarks and squares, common ones in parks and streets.
 * Null when there is no spot at all.
 */
export function pickSpot(
  spots: ChestSpot[],
  rarity: string,
  avoid: Array<{ lat: number; lng: number }>,
  random: () => number,
): ChestSpot | null {
  if (spots.length === 0) return null;
  const farFrom = (minM: number) => spots.filter((s) => avoid.every((p) => distanceM(s, p) >= minM));
  let pool = farFrom(CHEST_MIN_SPACING_M);
  if (pool.length === 0) pool = farFrom(150);
  if (pool.length === 0) pool = spots;
  const rare = rarity === 'epic' || rarity === 'legendary';
  const weightOf = (s: ChestSpot) => {
    const showcase = s.kind === 'landmark' || s.kind === 'square';
    const everyday = s.kind === 'park' || s.kind === 'street' || s.kind === 'pedestrian' || s.kind === 'track';
    return s.weight * (rare ? (showcase ? 3 : 1) : (everyday ? 1.5 : 1));
  };
  const total = pool.reduce((sum, s) => sum + weightOf(s), 0);
  let target = random() * total;
  for (const spot of pool) {
    target -= weightOf(spot);
    if (target <= 0) return spot;
  }
  return pool[pool.length - 1];
}

// ─── Talking to OpenStreetMap ───────────────────────────────────────────────

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Runs a query on the first Overpass server that answers it. A server that is busy or fails (HTTP
 * error, network error, or a "runtime error" remark with an incomplete answer) passes it to the next.
 * `onRequest` is called before each request (the Worker counts them as subrequests).
 */
export async function overpass(query: string, fetchFn: FetchLike, onRequest: () => void = () => {}, urls = OVERPASS_URLS, timeoutMs = 45_000): Promise<unknown> {
  const problems: string[] = [];
  for (const url of urls) {
    const host = new URL(url).host;
    try {
      onRequest();
      const response = await fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          // Overpass asks automated clients to say who they are
          'User-Agent': 'KM2-chests/1.0 (running game; chest places, cached monthly)',
        },
        body: `data=${encodeURIComponent(query)}`,
        // A hung server must not hold the task: the next one is tried
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        problems.push(`${host}: HTTP ${response.status}`);
        continue;
      }
      const json = await response.json() as { remark?: unknown };
      // A timeout or lack of memory comes back as 200 with a remark and part of the answer (or none)
      if (typeof json?.remark === 'string' && /error|timed out|out of memory/i.test(json.remark)) {
        problems.push(`${host}: ${json.remark.slice(0, 120)}`);
        continue;
      }
      return json;
    } catch (error) {
      problems.push(`${host}: ${String(error).slice(0, 120)}`);
    }
  }
  throw new Error(`Overpass unavailable (${problems.join('; ')})`);
}

export interface PreparedArea {
  place: CityPlace;
  mode: ChestAreaMode;
  radiusM: number;
  spots: ChestSpot[];
}

/**
 * Finds the city and its places. Towns whose "poi" list comes out too short also get their streets.
 * Throws when OpenStreetMap can't be reached or the city isn't found.
 */
export async function prepareArea(
  city: { name: string; lat: number; lng: number },
  fetchFn: FetchLike,
  onRequest: () => void = () => {},
): Promise<PreparedArea> {
  const place = pickPlace(await overpass(placeQuery(city.lat, city.lng), fetchFn, onRequest), city.name, city.lat, city.lng);
  if (!place) throw new Error(`city not found in OpenStreetMap: ${city.name}`);
  const radiusM = radiusFor(place.placeType, place.population);
  const mode = modeFor(place.placeType, place.population);
  // The places query is heavier: the servers get up to 90 s (the query's own limit)
  let spots = parseSpots(await overpass(spotsQuery(place.lat, place.lng, radiusM, mode), fetchFn, onRequest, OVERPASS_URLS, 95_000), place, radiusM);
  if (mode === 'poi' && spots.length < 12) {
    const streets = parseSpots(await overpass(spotsQuery(place.lat, place.lng, radiusM, 'streets'), fetchFn, onRequest, OVERPASS_URLS, 95_000), place, radiusM);
    spots = [...spots, ...streets.filter((s) => s.kind === 'street')];
  }
  return { place, mode, radiusM, spots };
}
