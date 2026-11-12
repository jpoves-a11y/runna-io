import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAwards, runDaysByUser, type AwardCandidate } from '../src/awards';

function candidate(userId: string, data: Partial<AwardCandidate> = {}): AwardCandidate {
  return { userId, score: 0, area: 0, areaStolen: 0, areaLost: 0, distance: 0, runs: 1, days: 1, team: null, ...data };
}

test('everyone-against-everyone: conqueror, thief, long-distance, consistent and wall', () => {
  const awards = computeAwards([
    candidate('ana', { score: 900_000, area: 800_000, areaStolen: 30_000, areaLost: 200_000, distance: 40_000, days: 4 }),
    candidate('ben', { score: 500_000, area: 450_000, areaStolen: 120_000, areaLost: 10_000, distance: 52_000, days: 4 }),
    candidate('eva', { score: 100_000, area: 50_000, areaStolen: 0, areaLost: 0, distance: 8_000, days: 2 }),
  ], { mode: 'ffa', winnerUserId: 'ana' });
  assert.deepEqual(awards.ana, ['conqueror', 'consistent']);
  // Eva lost nothing but held too little for Muro
  assert.deepEqual(awards.ben, ['thief', 'distance', 'consistent', 'wall']);
  assert.equal(awards.eva, undefined);
});

test('minimums: little stolen, few km, fewer than 3 days give nothing', () => {
  const awards = computeAwards([
    candidate('ana', { score: 10_000, areaStolen: 49_000, distance: 4_000, days: 2 }),
    candidate('ben', { score: 5_000, areaStolen: 1_000, distance: 3_000, days: 2 }),
  ], { mode: 'ffa' });
  assert.deepEqual(awards, { ana: ['conqueror'] });
});

test('only those who ran get awards', () => {
  const awards = computeAwards([
    candidate('ana', { runs: 0, score: 0, area: 500_000, days: 0 }),
    candidate('ben', { score: 20_000, distance: 6_000, days: 3 }),
  ], { mode: 'target', achieved: true, mvpUserId: 'ben' });
  assert.equal(awards.ana, undefined);
  assert.deepEqual(awards.ben, ['conqueror', 'distance', 'consistent', 'mvp', 'target']);
});

test('Objetivo común: nobody steals there, so no thief or wall', () => {
  const awards = computeAwards([
    candidate('ana', { score: 300_000, area: 300_000, areaStolen: 200_000 }),
    candidate('ben', { score: 200_000, area: 200_000 }),
  ], { mode: 'target', achieved: false, mvpUserId: 'ana' });
  assert.deepEqual(awards.ana, ['conqueror', 'mvp']);
  assert.equal(awards.ben, undefined);
});

test('teams: the winning team gets Victoria', () => {
  const awards = computeAwards([
    candidate('ana', { team: 0, score: 100_000 }),
    candidate('ben', { team: 1, score: 90_000 }),
    candidate('eva', { team: 0, score: 10_000 }),
    candidate('hugo', { team: 1, runs: 0 }),
  ], { mode: 'teams', winnerTeam: 0, mvpUserId: 'ana' });
  assert.ok(awards.ana.includes('victory') && awards.ana.includes('mvp'));
  assert.deepEqual(awards.eva, ['victory']);
  assert.equal(awards.ben, undefined);
  assert.equal(awards.hugo, undefined);
});

test('teams draw: no Victoria', () => {
  const awards = computeAwards([candidate('ana', { team: 0, score: 1 }), candidate('ben', { team: 1, score: 1 })], { mode: 'teams', winnerTeam: null });
  assert.ok(!Object.values(awards).flat().includes('victory'));
});

test('duel and derby: Victoria only when the club won', () => {
  const list = [candidate('ana', { score: 1_000_000 }), candidate('ben', { score: 10_000 })];
  for (const mode of ['duel', 'derby'] as const) {
    assert.ok(computeAwards(list, { mode, outcome: 'won', mvpUserId: 'ana' }).ben.includes('victory'), mode);
    assert.equal(computeAwards(list, { mode, outcome: 'draw', mvpUserId: 'ana' }).ben, undefined, mode);
    assert.equal(computeAwards(list, { mode, outcome: 'lost', mvpUserId: 'ana' }).ben, undefined, mode);
  }
});

test('Eliminación: the survivor; the fallen cannot be the wall', () => {
  const awards = computeAwards([
    candidate('ana', { score: 400_000, area: 300_000, areaLost: 50_000 }),
    candidate('ben', { score: 900_000, area: 500_000, areaLost: 0, eliminatedCut: 5 }),
  ], { mode: 'elimination', winnerUserId: 'ana' });
  // In catalogue order
  assert.deepEqual(awards.ana, ['wall', 'survivor']);
  assert.deepEqual(awards.ben, ['conqueror']);
});

test('Banderas and Exploradores: their own award, no area awards', () => {
  const flags = computeAwards([
    candidate('ana', { score: 30.5, areaStolen: 900_000, area: 900_000 }),
    candidate('ben', { score: 12 }),
  ], { mode: 'flags' });
  assert.deepEqual(flags.ana, ['flagbearer']);
  const explorers = computeAwards([
    candidate('ana', { score: 10 }),
    candidate('ben', { score: 250_000 }),
  ], { mode: 'explorers' });
  assert.deepEqual(explorers.ben, ['explorer']);
  assert.equal(explorers.ana, undefined);
});

test('Constante: everyone tied at the top', () => {
  const awards = computeAwards([candidate('ana', { days: 5 }), candidate('ben', { days: 5 }), candidate('eva', { days: 4 })], { mode: 'explorers' });
  assert.deepEqual(awards.ana, ['consistent']);
  assert.deepEqual(awards.ben, ['consistent']);
  assert.equal(awards.eva, undefined);
});

test('Muro needs someone else in the competition', () => {
  const alone = computeAwards([candidate('ana', { score: 500_000, area: 500_000 })], { mode: 'ffa' });
  assert.deepEqual(alone.ana, ['conqueror']);
});

test('days with a run are counted in Madrid time', () => {
  const days = runDaysByUser([
    { userId: 'ana', startedAt: '2026-11-13T22:30:00.000Z' }, // 23:30 Madrid, Friday
    { userId: 'ana', startedAt: '2026-11-13T23:30:00.000Z' }, // 00:30 Madrid, Saturday
    { userId: 'ana', startedAt: '2026-11-14T08:00:00.000Z' }, // Saturday again
    { userId: 'ben', startedAt: 'not a date' },
  ]);
  assert.equal(days.get('ana'), 2);
  assert.equal(days.get('ben'), undefined);
});
