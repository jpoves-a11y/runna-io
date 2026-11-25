import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as turf from '@turf/turf';
import { chestTimes, chestsForDay, chestsPerDay, openChestsPerDay, seededRandom, COMPETITION_DAY_CHESTS } from '../src/season';
import { appliesToRun, timeZoneAt } from '../src/runPipeline';
import { bastionZone } from '../src/bastion';
import { localHour, localMidnight } from '../src/cycles';
import { ITEMS, RETIRED_ITEMS, itemUsableInMode, BASTION_AREA_M2 } from '../../shared/game';

test('chests come out spread over 07:00-21:00 (Madrid), one in each part of the day', () => {
  for (const count of [1, 2, 3, 5, 8]) {
    const times = chestTimes('2026-12-03', count, seededRandom(`t${count}`));
    assert.equal(times.length, count);
    const span = (14 * 3600 * 1000) / count;
    const first = localMidnight('2026-12-03') + 7 * 3600 * 1000;
    times.forEach((t, k) => {
      assert.ok(localHour(t) >= 7 && localHour(t) < 21, `${count}: ${new Date(t).toISOString()}`);
      // Inside its own part, never at its edges
      assert.ok(t > first + span * k && t < first + span * (k + 1), `${count}/${k}`);
    });
    assert.deepEqual([...times].sort((a, b) => a - b), times);
  }
});

test('chests every day: club cities more on rest days, open ones by their runners', () => {
  assert.equal(chestsForDay('club', 12, true), chestsPerDay(12));
  assert.equal(chestsForDay('club', 12, false), COMPETITION_DAY_CHESTS);
  assert.ok(COMPETITION_DAY_CHESTS >= 1);
  assert.equal(chestsForDay('open', 25, false), openChestsPerDay(25));
  assert.equal(chestsForDay('open', 25, true), openChestsPerDay(25));
});

test('Alba: the Canary Islands are an hour behind the peninsula', () => {
  assert.equal(timeZoneAt(28.1235, -15.4363), 'Atlantic/Canary'); // Las Palmas
  assert.equal(timeZoneAt(28.4636, -16.2518), 'Atlantic/Canary'); // Santa Cruz de Tenerife
  assert.equal(timeZoneAt(41.6488, -0.8891), 'Europe/Madrid'); // Zaragoza
  assert.equal(timeZoneAt(39.5696, 2.6502), 'Europe/Madrid'); // Palma
  const sevenThirtyInCanarias = Date.parse('2026-12-03T07:30:00Z'); // 07:30 there, 08:30 in Madrid
  assert.equal(localHour(sevenThirtyInCanarias, timeZoneAt(28.1235, -15.4363)), 7);
  assert.equal(localHour(sevenThirtyInCanarias), 8);
});

test('"next run" powers count for runs started after they were activated (2 min of slack)', () => {
  const run = '2026-12-03T10:00:00.000Z';
  assert.equal(appliesToRun({ itemId: 'double_area', activatedAt: '2026-12-03T09:00:00.000Z' }, run), true);
  assert.equal(appliesToRun({ itemId: 'double_area', activatedAt: '2026-12-03T10:01:00.000Z' }, run), true);
  assert.equal(appliesToRun({ itemId: 'double_area', activatedAt: '2026-12-03T10:05:00.000Z' }, run), false);
  // Timed ones are not about the start of the run
  assert.equal(appliesToRun({ itemId: 'shield', activatedAt: '2026-12-03T11:00:00.000Z' }, run), true);
});

/** A square of `side` metres around a point, as a stored territory geometry. */
function square(lat: number, lng: number, side: number) {
  const dLat = side / 2 / 111_320;
  const dLng = side / 2 / (111_320 * Math.cos((lat * Math.PI) / 180));
  return { type: 'Polygon', coordinates: [[[lng - dLng, lat - dLat], [lng + dLng, lat - dLat], [lng + dLng, lat + dLat], [lng - dLng, lat + dLat], [lng - dLng, lat - dLat]]] };
}

test('Bastión: 2.5 km² of territory around a point inside it', () => {
  const territory = square(41.65, -0.88, 4000); // 16 km²
  const zone = bastionZone([territory], { lat: 41.65, lng: -0.88 })!;
  assert.ok(zone, 'a zone');
  assert.equal(zone.snapped, false);
  assert.ok(Math.abs(zone.area - BASTION_AREA_M2) / BASTION_AREA_M2 < 0.03, `${zone.area}`);
  assert.equal(zone.complete, true);
  // All of it is territory
  const outside = turf.difference(turf.featureCollection([turf.feature(zone.geometry as any) as any, turf.feature(territory as any) as any]));
  assert.ok(!outside || turf.area(outside) < 1000, `${outside ? turf.area(outside) : 0}`);
});

test('Bastión: near an edge the circle grows, never past the territory', () => {
  const territory = square(41.65, -0.88, 4000);
  const edge = { lat: 41.65, lng: -0.88 + 1990 / (111_320 * Math.cos((41.65 * Math.PI) / 180)) }; // 10 m inside the east edge
  const zone = bastionZone([territory], edge)!;
  assert.equal(zone.snapped, false);
  assert.ok(Math.abs(zone.area - BASTION_AREA_M2) / BASTION_AREA_M2 < 0.03, `${zone.area}`);
  assert.ok(zone.radiusM > 1000, `${zone.radiusM}`);
});

test('Bastión: a point outside moves to the nearest part of the territory', () => {
  const territory = square(41.65, -0.88, 4000);
  const zone = bastionZone([territory], { lat: 41.65 + 3000 / 111_320, lng: -0.88 })!; // 1 km north of it
  assert.equal(zone.snapped, true);
  assert.ok(Math.abs(zone.snappedMeters - 1000) < 30, `${zone.snappedMeters}`);
  assert.ok(Math.abs(zone.center.lat - (41.65 + 2000 / 111_320)) < 0.0005);
  assert.ok(zone.area > 0.9 * BASTION_AREA_M2);
});

test('Bastión: a small territory is reinforced whole', () => {
  const territory = square(41.65, -0.88, 1000); // 1 km²
  const zone = bastionZone([territory], { lat: 41.65, lng: -0.88 })!;
  assert.equal(zone.complete, false);
  assert.ok(Math.abs(zone.area - 1_000_000) < 10_000, `${zone.area}`);
});

test('Bastión: with no territory there is no zone', () => {
  assert.equal(bastionZone([], { lat: 41.65, lng: -0.88 }), null);
});

test('retired powers are gone from the catalog, chest powers can be used any day', () => {
  for (const id of RETIRED_ITEMS) assert.equal(ITEMS[id], undefined, id);
  for (const id of ['reveal', 'master_key', 'double_loot', 'treasure_map']) {
    assert.equal(ITEMS[id].scope, 'rest', id);
    assert.equal(ITEMS[id].usablePhase, 'any', id);
  }
  assert.equal(ITEMS.wall.name, 'Refuerzo');
  assert.equal(ITEMS.steal_boost.name, 'Daga');
  assert.equal(ITEMS.cartographer.name, 'Gran Trazo');
  assert.equal(ITEMS.bastion.activation, 'zone');
  assert.equal(ITEMS.revenge.activation, 'target');
  // Banderas: only the powers that protect flags and the utility ones
  assert.equal(itemUsableInMode(ITEMS.shield, 'flags'), true);
  assert.equal(itemUsableInMode(ITEMS.double_area, 'flags'), false);
  assert.equal(itemUsableInMode(ITEMS.spy, 'explorers'), false);
});
