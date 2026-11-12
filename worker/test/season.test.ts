import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assignTeams,
  pairClubs,
  eloDelta,
  duelScore,
  modeForClub,
  targetArea,
  pickChallenges,
  challengeProgress,
  chestsPerDay,
  seededRandom,
  randomPointAround,
  lateEntryOpen,
} from '../src/season';
import { cycleAt } from '../src/cycles';
import { ITEMS, CHALLENGES, CHALLENGES_PER_REST, DUEL_PER_RUNNER_CAP_M2, TARGET_AREA_PER_PARTICIPANT_M2, MODE_INFO, pickRewardItem, pickRarity } from '../../shared/game';
import { haversineMeters } from '../src/antiCheat';

test('teams are balanced by strength (snake draft) and have equal sizes', () => {
  const players = [100, 90, 80, 70, 60, 50, 40, 30].map((strength, i) => ({ userId: `u${i}`, strength }));
  const teams = assignTeams(players);
  const sums = [0, 0];
  const sizes = [0, 0];
  for (const p of players) {
    const team = teams.get(p.userId)!;
    sums[team] += p.strength;
    sizes[team]++;
  }
  assert.deepEqual(sizes, [4, 4]);
  assert.equal(sums[0], sums[1]);
});

test('odd number of players: sizes differ by one at most', () => {
  const teams = assignTeams([5, 4, 3, 2, 1].map((strength, i) => ({ userId: `u${i}`, strength })));
  const sizes = [0, 0];
  for (const team of teams.values()) sizes[team]++;
  assert.ok(Math.abs(sizes[0] - sizes[1]) <= 1);
});

test('modes fall back when a club can not play them', () => {
  assert.equal(modeForClub('duel', 10, true), 'duel');
  assert.equal(modeForClub('duel', 10, false), 'target');
  assert.equal(modeForClub('teams', 3, false), 'ffa');
  assert.equal(modeForClub('teams', 1, false), 'target');
  assert.equal(modeForClub('ffa', 1, false), 'target');
  assert.equal(modeForClub('target', 1, false), 'target');
});

test('duels pair clubs of similar rating and size', () => {
  const clubs = [
    { id: 'a', rating: 1200, active: 10 },
    { id: 'b', rating: 1180, active: 11 },
    { id: 'c', rating: 900, active: 4 },
    { id: 'd', rating: 920, active: 5 },
    { id: 'e', rating: 1000, active: 2 }, // too few active runners
  ];
  const { pairs, byes } = pairClubs(clubs, new Map(), seededRandom('t'));
  const key = (p: [string, string]) => [...p].sort().join('-');
  assert.deepEqual(pairs.map(key).sort(), ['a-b', 'c-d']);
  assert.deepEqual(byes, ['e']);
});

test('duels avoid recent opponents when there is another fair rival', () => {
  const clubs = [
    { id: 'a', rating: 1000, active: 6 },
    { id: 'b', rating: 1010, active: 6 },
    { id: 'c', rating: 990, active: 6 },
    { id: 'd', rating: 1005, active: 6 },
  ];
  const recent = new Map([['a', ['b', 'd']], ['b', ['a']], ['d', ['a']]]);
  for (let seed = 0; seed < 20; seed++) {
    const { pairs } = pairClubs(clubs, recent, seededRandom(`s${seed}`));
    const withA = pairs.find((p) => p.includes('a'))!;
    assert.ok(withA.includes('c'), `seed ${seed}: a paired with ${withA}`);
  }
});

test('a club with no fair rival gets a bye', () => {
  const { pairs, byes } = pairClubs([
    { id: 'big', rating: 1500, active: 40 },
    { id: 'small', rating: 800, active: 3 },
  ], new Map(), seededRandom('x'));
  assert.equal(pairs.length, 0);
  assert.deepEqual(byes.sort(), ['big', 'small']);
});

test('Elo: equal ratings move 16 points, upsets move more', () => {
  assert.equal(eloDelta(1000, 1000, 1), 16);
  assert.equal(eloDelta(1000, 1000, 0.5), 0);
  assert.ok(eloDelta(900, 1100, 1) > 16);
  assert.ok(eloDelta(1100, 900, 1) < 16);
  assert.ok(Math.abs(eloDelta(1000, 1200, 1) + eloDelta(1200, 1000, 0)) < 1e-9);
});

test('duel score counts the N best runners, each capped', () => {
  const cap = DUEL_PER_RUNNER_CAP_M2;
  assert.equal(duelScore([cap * 3, 100, 50, 10], 2), cap + 100);
  assert.equal(duelScore([1, 2, 3], 5), 6);
  assert.equal(duelScore([5, -3], 2), 5);
});

test('the common target scales with participants', () => {
  assert.equal(targetArea(4), 4 * TARGET_AREA_PER_PARTICIPANT_M2);
  assert.equal(targetArea(0), TARGET_AREA_PER_PARTICIPANT_M2);
});

test('challenges: distinct, deterministic per user and cycle', () => {
  const a = pickChallenges('user-1', 3);
  assert.equal(a.length, CHALLENGES_PER_REST);
  assert.equal(new Set(a).size, a.length);
  assert.deepEqual(pickChallenges('user-1', 3), a);
  for (const type of a) assert.ok(CHALLENGES[type]);
});

test('challenge progress', () => {
  const run = { startedAt: '2026-11-24T06:30:00.000Z', distance: 5200, movingTime: 5200 * 0.32, globalGain: 40_000, ranWithClubmate: false };
  // 07:30 Madrid, 5.2 km
  assert.equal(challengeProgress('early_bird', { progress: 0, data: {} }, run).progress, 1);
  assert.equal(challengeProgress('early_bird', { progress: 0, data: {} }, { ...run, startedAt: '2026-11-24T09:30:00.000Z' }).progress, 0);
  assert.equal(challengeProgress('fast_5k', { progress: 0, data: {} }, run).progress, 1); // 5:20 min/km
  assert.equal(challengeProgress('long_run', { progress: 0, data: {} }, run).progress, 0);
  assert.equal(challengeProgress('distance_total', { progress: 15_000, data: {} }, run).progress, 20_200);
  assert.equal(challengeProgress('new_ground', { progress: 70_000, data: {} }, run).progress, 110_000);
  const day1 = challengeProgress('streak3', { progress: 0, data: {} }, run);
  const sameDay = challengeProgress('streak3', day1, { ...run, startedAt: '2026-11-24T18:00:00.000Z' });
  assert.equal(sameDay.progress, 1);
  const day2 = challengeProgress('streak3', sameDay, { ...run, startedAt: '2026-11-25T18:00:00.000Z' });
  assert.equal(day2.progress, 2);
  assert.equal(challengeProgress('club_run', { progress: 0, data: {} }, { ...run, ranWithClubmate: true }).progress, 1);
});

test('reward items exist, and cosmetics already owned are not given again', () => {
  const random = seededRandom('rewards');
  for (let i = 0; i < 300; i++) {
    const rarity = pickRarity(random);
    const owned = new Set(Object.keys(ITEMS).filter((id) => ITEMS[id].scope === 'cosmetic'));
    const item = pickRewardItem(rarity, random, owned);
    assert.ok(ITEMS[item], item);
    assert.notEqual(ITEMS[item].scope, 'cosmetic', 'all cosmetics owned: must give a power');
  }
});

test('every item has a coherent definition', () => {
  for (const item of Object.values(ITEMS)) {
    if (item.activation === 'timed') assert.ok(item.activeHours && item.activeHours > 0, item.id);
    if (item.scope === 'cosmetic') assert.equal(item.unusedTtlHours, null, item.id);
    if (item.category === 'defense') assert.equal(item.unusedTtlHours, 72, item.id);
    if (item.category === 'attack') assert.equal(item.unusedTtlHours, 168, item.id);
  }
});

test('chests per day grow with members and are capped', () => {
  assert.equal(chestsPerDay(1), 2);
  assert.equal(chestsPerDay(10), 4);
  assert.equal(chestsPerDay(200), 8);
});

test('chest spots stay between the min and max distance from the city centre', () => {
  const random = seededRandom('spots');
  for (let i = 0; i < 200; i++) {
    const p = randomPointAround(41.65, -0.88, 300, 3000, random);
    const d = haversineMeters([41.65, -0.88], [p.lat, p.lng]);
    assert.ok(d >= 290 && d <= 3010, `${d}`);
  }
});

test('late entry: team against team never, individual and cooperative modes always', () => {
  const competition = (mode: string, config: any = {}) => ({
    id: 'c', cycleNumber: 0, clubId: 'k', mode, status: 'active' as const, config, opponentClubId: null, matchId: null,
    score: 0, result: null, createdAt: '', finishedAt: null,
  });
  const info = cycleAt(Date.parse('2026-11-14T10:00:00Z'));
  const day1 = Date.parse('2026-11-13T10:00:00Z');
  const day9 = Date.parse('2026-11-21T10:00:00Z');
  for (const mode of ['teams', 'duel']) {
    assert.equal(MODE_INFO[mode as keyof typeof MODE_INFO].lateEntry, 'none');
    assert.equal(lateEntryOpen(competition(mode), info, day1), false, mode);
  }
  for (const mode of ['ffa', 'target']) {
    assert.equal(lateEntryOpen(competition(mode), info, day1), true, mode);
    assert.equal(lateEntryOpen(competition(mode), info, day9), true, mode);
  }
});
