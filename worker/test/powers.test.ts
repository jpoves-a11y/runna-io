import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globalBoosts } from '../src/runPipeline';
import { unexploredSpots } from '../src/globalTerritory';
import { ITEMS, GLOBAL_BONUS_RUN_CAP_M2, TOURIST_BONUS_CAP_M2, EXPEDITION_BONUS_CAP_M2, DAWN_BONUS_CAP_M2, EXPLORER_BONUS_CAP_M2, itemUsableInMode } from '../../shared/game';
import { haversineMeters } from '../src/antiCheat';

test('every global boost has its own cap, and together they never pass the per-run cap', () => {
  const small = globalBoosts({ newArea: 100_000, explorer: true, tourist: true, dawn: true, expedition: true });
  assert.equal(Math.round(small.parts.explorer), 50_000);
  assert.equal(Math.round(small.parts.tourist), 100_000);
  assert.equal(Math.round(small.parts.dawn), 20_000);
  assert.equal(Math.round(small.parts.expedition), 25_000);
  assert.equal(Math.round(small.total), 195_000);
  const big = globalBoosts({ newArea: 5_000_000, explorer: true, tourist: true, dawn: true, expedition: true });
  assert.ok(big.parts.explorer <= EXPLORER_BONUS_CAP_M2 && big.parts.tourist <= TOURIST_BONUS_CAP_M2);
  assert.ok(big.parts.dawn <= DAWN_BONUS_CAP_M2 && big.parts.expedition <= EXPEDITION_BONUS_CAP_M2);
  assert.equal(Math.round(big.total), GLOBAL_BONUS_RUN_CAP_M2);
  assert.equal(Math.round(Object.values(big.parts).reduce((a, b) => a + b, 0)), GLOBAL_BONUS_RUN_CAP_M2);
  assert.deepEqual(globalBoosts({ newArea: 0, explorer: true, tourist: true, dawn: true, expedition: true }), { total: 0, parts: {} });
  assert.deepEqual(globalBoosts({ newArea: 300_000, explorer: false, tourist: false, dawn: false, expedition: false }), { total: 0, parts: {} });
});

test('Brújula: the nearest unexplored spots, outside the map and spread out', () => {
  const center: [number, number] = [41.65, -0.88];
  // Explored: a 1 km square around the centre
  const d = 0.009;
  const explored = { type: 'Polygon', coordinates: [[[center[1] - d, center[0] - d], [center[1] + d, center[0] - d], [center[1] + d, center[0] + d], [center[1] - d, center[0] + d], [center[1] - d, center[0] - d]]] };
  const spots = unexploredSpots(explored as any, center, 3);
  assert.equal(spots.length, 3);
  for (const s of spots) {
    assert.ok(Math.abs(s.lat - center[0]) > d || Math.abs(s.lng - center[1]) > d * 1.2, `${s.lat},${s.lng} is inside the explored square`);
    assert.ok(s.distanceMeters <= 3000);
  }
  for (let i = 0; i < spots.length; i++) for (let j = i + 1; j < spots.length; j++) {
    assert.ok(haversineMeters([spots[i].lat, spots[i].lng], [spots[j].lat, spots[j].lng]) >= 590);
  }
  // Nothing explored: the nearest ring
  assert.ok(unexploredSpots(null, center, 3).every((s) => s.distanceMeters <= 700));
});

test('the 15 new items are in the catalogue with their scope', () => {
  const expected: Record<string, string> = {
    compass: 'global', tourist: 'global', expedition: 'global', dawn: 'global', cartographer: 'global',
    revenge: 'competition', ambush: 'competition', bastion: 'competition', radar: 'competition',
    double_or_nothing: 'competition', plunder: 'competition', club_wall: 'competition',
    master_key: 'rest', double_loot: 'rest', treasure_map: 'rest',
  };
  for (const [id, scope] of Object.entries(expected)) assert.equal(ITEMS[id]?.scope, scope, id);
  // Muralla del Club only where there is a team or a club to protect
  assert.equal(itemUsableInMode(ITEMS.club_wall, 'teams'), true);
  assert.equal(itemUsableInMode(ITEMS.club_wall, 'derby'), true);
  assert.equal(itemUsableInMode(ITEMS.club_wall, 'ffa'), false);
  // Rest-day items last two weeks
  assert.equal(ITEMS.master_key.unusedTtlHours, 336);
});
