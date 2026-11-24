import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  distanceM, insideRing, radiusFor, modeFor, normalizeName, placeQuery, pickPlace, spotsQuery, parseSpots, pickSpot,
  prepareArea, CHEST_MIN_SPACING_M, type ChestSpot,
} from '../src/chestSpots';

const ZGZ = { lat: 41.6563, lng: -0.8773 }; // Plaza del Pilar
/** A point `north` / `east` metres from a centre. */
const offset = (c: { lat: number; lng: number }, north: number, east: number) => ({
  lat: c.lat + north / 111_320,
  lng: c.lng + east / (111_320 * Math.cos((c.lat * Math.PI) / 180)),
});

test('geometry: distances and point in polygon', () => {
  assert.ok(Math.abs(distanceM(ZGZ, offset(ZGZ, 1000, 0)) - 1000) < 2);
  const square = [offset(ZGZ, -100, -100), offset(ZGZ, -100, 100), offset(ZGZ, 100, 100), offset(ZGZ, 100, -100), offset(ZGZ, -100, -100)];
  assert.equal(insideRing(ZGZ, square), true);
  assert.equal(insideRing(offset(ZGZ, 300, 0), square), false);
});

test('size: big cities get a wider urban core and their places of interest; villages, their streets', () => {
  assert.equal(radiusFor('city', 680_000), 4000);
  assert.equal(radiusFor('city', 180_000), 3000);
  assert.equal(radiusFor('town', 45_000), 2000);
  assert.equal(radiusFor('town', 12_000), 1300);
  assert.equal(radiusFor('village', 900), 800);
  assert.equal(radiusFor('town', null), 1300);
  assert.equal(modeFor('city', 680_000), 'poi');
  assert.equal(modeFor('town', 25_000), 'poi');
  assert.equal(modeFor('town', 12_000), 'streets');
  assert.equal(modeFor('village', null), 'streets');
  assert.equal(modeFor('city', null), 'poi');
});

test('the place lookup only sends the members\' centre rounded to 0.1°', () => {
  const query = placeQuery(41.64873, -0.88916);
  assert.match(query, /around:20000,41\.6,-0\.9\)/);
  assert.doesNotMatch(query, /41\.648|0\.889/);
});

test('names compare without accents, case or punctuation', () => {
  assert.equal(normalizeName('Alcalá de Henares'), 'alcala de henares');
  assert.equal(normalizeName('A Coruña'), 'a coruna');
  assert.equal(normalizeName("L'Hospitalet de Llobregat"), 'l hospitalet de llobregat');
});

const node = (id: number, lat: number, lon: number, tags: Record<string, string>) => ({ type: 'node' as const, id, lat, lon, tags });

test('the city is its own place node: by name (any official or bilingual name), the biggest one', () => {
  const answer = {
    elements: [
      node(1, 41.63, -0.95, { place: 'village', name: 'Casetas' }),
      node(2, 41.6563, -0.8773, { place: 'city', name: 'Zaragoza', population: '682513' }),
      node(3, 41.70, -0.80, { place: 'village', name: 'Zaragoza la Vieja' }),
    ],
  };
  const place = pickPlace(answer, 'Zaragoza', 41.64, -0.89);
  assert.deepEqual(place, { name: 'Zaragoza', lat: 41.6563, lng: -0.8773, placeType: 'city', population: 682513 });
  const donostia = { elements: [node(9, 43.3183, -1.9812, { place: 'city', name: 'Donostia / San Sebastián', 'name:es': 'San Sebastián', population: '188102' })] };
  assert.equal(pickPlace(donostia, 'San Sebastián', 43.31, -1.98)?.name, 'San Sebastián');
  assert.equal(pickPlace(donostia, 'Donostia', 43.31, -1.98)?.population, 188102);
  const accents = { elements: [node(4, 40.4818, -3.3643, { place: 'city', name: 'Alcalá de Henares', population: '196888' })] };
  assert.equal(pickPlace(accents, 'alcala de henares', 40.48, -3.37)?.placeType, 'city');
});

test('without a name match: the biggest place within 6 km of the members; nothing if there is none', () => {
  const answer = {
    elements: [
      node(1, 40.000, -3.000, { place: 'village', name: 'Pueblo A' }),
      node(2, 40.010, -3.010, { place: 'town', name: 'Villa B', population: '8000' }),
      node(3, 40.200, -3.000, { place: 'city', name: 'Lejana', population: '90000' }),
    ],
  };
  assert.equal(pickPlace(answer, 'Nombre que no está', 40.005, -3.005)?.name, 'Villa B');
  assert.equal(pickPlace({ elements: [] }, 'Zaragoza', 41.6, -0.9), null);
});

test('the places query covers parks, squares, landmarks... in cities and streets in villages, with the areas to avoid', () => {
  const poi = spotsQuery(ZGZ.lat, ZGZ.lng, 4000, 'poi');
  for (const piece of ['leisure"~"^(park|garden)$', 'place"="square', 'highway"="pedestrian', 'historic', 'tourism', 'amenity"="fountain', 'landuse"~"^(industrial|retail', 'aeroway"="aerodrome', 'around:4000,']) {
    assert.ok(poi.includes(piece), piece);
  }
  const streets = spotsQuery(ZGZ.lat, ZGZ.lng, 800, 'streets');
  assert.ok(streets.includes('highway"~"^(pedestrian|living_street|residential|footway)$') && streets.includes('access"!~"^(private|no)$'));
  assert.ok(!streets.includes('historic'));
});

test('places: inside the radius, out of industrial estates, none within 120 m of a more interesting one, with their kind', () => {
  const estate = [offset(ZGZ, 1500, 1500), offset(ZGZ, 1500, 2100), offset(ZGZ, 2100, 2100), offset(ZGZ, 2100, 1500), offset(ZGZ, 1500, 1500)];
  const answer = {
    elements: [
      node(1, ZGZ.lat, ZGZ.lng, { place: 'square', name: 'Plaza del Pilar' }),
      node(2, offset(ZGZ, 30, 30).lat, offset(ZGZ, 30, 30).lng, { amenity: 'fountain' }), // same cell: the square wins
      { type: 'way', id: 3, center: { lat: offset(ZGZ, -800, 300).lat, lon: offset(ZGZ, -800, 300).lng }, tags: { leisure: 'park', name: 'Parque Grande' } },
      node(4, offset(ZGZ, 400, -200).lat, offset(ZGZ, 400, -200).lng, { historic: 'monument', name: 'Puente de Piedra' }),
      { type: 'way', id: 5, center: { lat: offset(ZGZ, 1800, 1800).lat, lon: offset(ZGZ, 1800, 1800).lng }, tags: { leisure: 'park' } }, // inside the estate
      node(6, offset(ZGZ, 6000, 0).lat, offset(ZGZ, 6000, 0).lng, { tourism: 'viewpoint' }), // beyond the radius
      { type: 'way', id: 7, center: { lat: offset(ZGZ, 200, 900).lat, lon: offset(ZGZ, 200, 900).lng }, tags: { leisure: 'park', access: 'private' } },
      { type: 'way', id: 8, geometry: estate.map((p) => ({ lat: p.lat, lon: p.lng })), tags: { landuse: 'industrial' } },
    ],
  };
  const spots = parseSpots(answer, ZGZ, 4000);
  const names = spots.map((s) => s.name).sort();
  assert.deepEqual(names, ['Parque Grande', 'Plaza del Pilar', 'Puente de Piedra']);
  assert.equal(spots.find((s) => s.name === 'Plaza del Pilar')?.kind, 'square');
  assert.equal(spots.find((s) => s.name === 'Puente de Piedra')?.kind, 'landmark');
  assert.equal(spots.find((s) => s.name === 'Parque Grande')?.kind, 'park');
});

function grid(): ChestSpot[] {
  const spots: ChestSpot[] = [];
  for (let i = 0; i < 10; i++) {
    for (let j = 0; j < 10; j++) {
      const p = offset(ZGZ, i * 300, j * 300);
      const kind = (i + j) % 5 === 0 ? 'landmark' : 'park';
      spots.push({ ...p, kind, name: null, weight: kind === 'landmark' ? 3 : 2 });
    }
  }
  return spots;
}

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

test('a new chest keeps its distance from the active and recent ones', () => {
  const spots = grid();
  const random = seeded(7);
  const taken: Array<{ lat: number; lng: number }> = [];
  for (let n = 0; n < 12; n++) {
    const spot = pickSpot(spots, 'common', taken, random);
    assert.ok(spot);
    assert.ok(taken.every((p) => distanceM(p, spot) >= CHEST_MIN_SPACING_M), `chest ${n} too close`);
    taken.push(spot);
  }
});

test('rare chests go to landmarks and squares more often; everything still returns a spot', () => {
  const spots = grid();
  const random = seeded(11);
  let landmarksRare = 0;
  let landmarksCommon = 0;
  for (let n = 0; n < 400; n++) {
    if (pickSpot(spots, 'legendary', [], random)?.kind === 'landmark') landmarksRare++;
    if (pickSpot(spots, 'common', [], random)?.kind === 'landmark') landmarksCommon++;
  }
  assert.ok(landmarksRare > landmarksCommon * 2, `${landmarksRare} vs ${landmarksCommon}`);
  assert.equal(pickSpot([], 'common', [], random), null);
  // When everything is close to other chests, it still finds a place
  assert.ok(pickSpot(spots.slice(0, 1), 'common', [spots[0]], random));
});

test('preparing a city: place, then its places; a city with too few places of interest adds its streets', async () => {
  const requests: string[] = [];
  const answers = [
    { elements: [node(1, 41.6563, -0.8773, { place: 'town', name: 'Villa', population: '25000' })] },
    { elements: [node(2, 41.657, -0.877, { place: 'square', name: 'Plaza Mayor' })] },
    { elements: [{ type: 'way', id: 3, center: { lat: 41.660, lon: -0.880 }, tags: { highway: 'residential', name: 'Calle Real' } }] },
  ];
  let calls = 0;
  const fetchFn = async (_url: string, init?: RequestInit) => {
    requests.push(decodeURIComponent(String(init?.body ?? '').replace(/^data=/, '')));
    return new Response(JSON.stringify(answers[calls++]), { status: 200 });
  };
  let counted = 0;
  const area = await prepareArea({ name: 'Villa', lat: 41.6487, lng: -0.8892 }, fetchFn, () => counted++);
  assert.equal(area.place.name, 'Villa');
  assert.equal(area.mode, 'poi');
  assert.equal(area.radiusM, 1300);
  assert.deepEqual(area.spots.map((s) => s.name).sort(), ['Calle Real', 'Plaza Mayor']);
  assert.equal(counted, 3);
  assert.equal(requests.length, 3);
  assert.match(requests[0], /around:20000,41\.6,-0\.9\)/);
  assert.match(requests[1], /around:1300,41\.656300,-0\.877300\)/);
});

test('preparing fails clearly when OpenStreetMap is down or the city is not found', async () => {
  await assert.rejects(prepareArea({ name: 'X', lat: 40, lng: -3 }, async () => new Response('busy', { status: 429 })), /HTTP 429/);
  await assert.rejects(prepareArea({ name: 'X', lat: 40, lng: -3 }, async () => new Response('{"elements":[]}', { status: 200 })), /not found/);
});
