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
  flagHoldings,
  flagHolders,
  placeFlags,
  pickEliminated,
  eliminationCutTime,
} from '../src/season';
import { cycleAt, cycleInfo, wallClock } from '../src/cycles';
import { ITEMS, CHALLENGES, CHALLENGES_PER_REST, DUEL_PER_RUNNER_CAP_M2, TARGET_AREA_PER_PARTICIPANT_M2, MODE_INFO, MODE_ROTATION, ELIMINATION_CUTS, FLAG_MIN_SPACING_M, flagCount, eliminationsAt, itemUsableInMode, pickRewardItem, pickRarity } from '../../shared/game';
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

test('the rotation keeps the first two modes (a running season is not changed) and has all eight', () => {
  assert.deepEqual(MODE_ROTATION.slice(0, 2), ['ffa', 'duel']);
  assert.equal(new Set(MODE_ROTATION).size, 8);
  for (const mode of ['flags', 'derby', 'elimination', 'explorers']) assert.ok(MODE_ROTATION.includes(mode as any), mode);
});

test('fallbacks of the new modes', () => {
  assert.equal(modeForClub('derby', 10, true), 'derby');
  assert.equal(modeForClub('derby', 10, false), 'target');
  assert.equal(modeForClub('elimination', 5, false), 'elimination');
  assert.equal(modeForClub('elimination', 4, false), 'ffa');
  assert.equal(modeForClub('elimination', 1, false), 'target');
  assert.equal(modeForClub('flags', 2, false), 'flags');
  assert.equal(modeForClub('flags', 1, false), 'target');
  assert.equal(modeForClub('explorers', 3, false), 'explorers');
  assert.equal(modeForClub('target', 30, false), 'target');
});

test('elimination: every club size ends with exactly one, nobody is left alone before the end', () => {
  for (let players = 2; players <= 50; players++) {
    let remaining = players;
    const plan: number[] = [];
    for (let k = 1; k <= ELIMINATION_CUTS; k++) {
      const fall = eliminationsAt(remaining, ELIMINATION_CUTS - k + 1);
      plan.push(fall);
      remaining -= fall;
      if (k < ELIMINATION_CUTS) assert.ok(remaining >= 2, `${players} players: ${remaining} left after cut ${k} (${plan})`);
    }
    assert.equal(remaining, 1, `${players} players end with ${remaining} (${plan})`);
    // Even cuts: no cut drops more than one more than another non-empty cut
    const nonEmpty = plan.filter((n) => n > 0);
    assert.ok(Math.max(...nonEmpty) - Math.min(...nonEmpty.slice(0, -1).length ? nonEmpty.slice(0, -1) : nonEmpty) <= 2, `${players}: ${plan}`);
  }
  assert.deepEqual([5, 6, 8, 12, 20, 50].map((p) => {
    let r = p;
    return Array.from({ length: ELIMINATION_CUTS }, (_, i) => { const f = eliminationsAt(r, ELIMINATION_CUTS - i); r -= f; return f; }).join('·');
  }), ['0·1·1·1·1', '1·1·1·1·1', '2·2·1·1·1', '3·2·2·2·2', '4·4·4·4·3', '10·10·10·10·9']);
});

test('elimination: the lowest window scores fall; ties by km, then total area; late entries are protected', () => {
  const cutTime = Date.parse('2026-11-15T00:00:00Z');
  const alive = ['a', 'b', 'c', 'd', 'e', 'f'].map((userId) => ({ userId, joinedAt: '2026-11-13T00:00:00Z', total: 0 }));
  const score = new Map([['a', 500], ['b', 0], ['c', 0], ['d', 900], ['e', 300], ['f', 100]]);
  const km = new Map([['b', 2000], ['c', 1000]]);
  // 6 players, 5 cuts left: 1 falls; b and c tie on area, c ran less
  assert.deepEqual(pickEliminated(alive, score, km, 1, cutTime), ['c']);
  // c entered 10 h before the cut: protected; b falls instead
  const late = alive.map((p) => p.userId === 'c' ? { ...p, joinedAt: '2026-11-14T14:00:00Z' } : p);
  assert.deepEqual(pickEliminated(late, score, km, 1, cutTime), ['b']);
  // The last cut leaves only the best one, protection or not
  assert.deepEqual(pickEliminated(late, score, km, ELIMINATION_CUTS, cutTime).sort(), ['a', 'b', 'c', 'e', 'f']);
});

test('elimination cuts at local midnight every 2 days; the last one is the end', () => {
  for (const n of [0, 5, 10, 11, 12]) {
    const info = cycleInfo(n, 'competition');
    for (let k = 1; k <= ELIMINATION_CUTS; k++) {
      const clock = wallClock(eliminationCutTime(info, k));
      assert.equal(clock.hour, 0, `cycle ${n} cut ${k}`);
    }
    assert.equal(new Date(eliminationCutTime(info, ELIMINATION_CUTS)).toISOString(), info.competitionEndsAt);
  }
});

test('flags: hours held, rebuilt from captures in any order', () => {
  const t = (h: number) => new Date(Date.parse('2026-11-13T00:00:00Z') + h * 3_600_000).toISOString();
  const from = Date.parse(t(0));
  const to = Date.parse(t(10));
  const captures = [
    { flagId: 'A', userId: 'ana', capturedAt: t(2) },
    { flagId: 'A', userId: 'ben', capturedAt: t(7) },
    // A late import of an earlier run: ben captured A at hour 1 (before ana)
    { flagId: 'A', userId: 'ben', capturedAt: t(1) },
    { flagId: 'B', userId: 'ana', capturedAt: t(8) },
    { flagId: 'B', userId: 'ana', capturedAt: t(-3) }, // before the competition: counts from its start
  ];
  const hours = flagHoldings(['A', 'B'], captures, from, to);
  // A: ben 1-2, ana 2-7, ben 7-10 -> ben 4 h, ana 5 h; B: ana 0-10 -> 10 h
  assert.equal(Math.round((hours.get('ben') ?? 0) * 100) / 100, 4);
  assert.equal(Math.round((hours.get('ana') ?? 0) * 100) / 100, 15);
  const holders = flagHolders(['A', 'B', 'C'], captures, Date.parse(t(5)));
  assert.equal(holders.get('A')?.userId, 'ana');
  assert.equal(holders.get('B')?.userId, 'ana');
  assert.equal(holders.has('C'), false);
});

test('flags: as many as the club needs, spread around its centre', () => {
  assert.equal(flagCount(2), 3);
  assert.equal(flagCount(9), 6);
  assert.equal(flagCount(50), 10);
  const flags = placeFlags({ lat: 41.65, lng: -0.88 }, 10, seededRandom('flags'));
  assert.equal(flags.length, 10);
  for (const f of flags) {
    const d = haversineMeters([41.65, -0.88], [f.lat, f.lng]);
    assert.ok(d >= 390 && d <= 3010, `${f.name} at ${d} m`);
  }
  let close = 0;
  for (let i = 0; i < flags.length; i++) for (let j = i + 1; j < flags.length; j++) {
    if (haversineMeters([flags[i].lat, flags[i].lng], [flags[j].lat, flags[j].lng]) < FLAG_MIN_SPACING_M) close++;
  }
  assert.equal(close, 0);
});

test('powers by mode: no map powers in Banderas, none in Exploradores', () => {
  assert.equal(itemUsableInMode(ITEMS.double_area, 'flags'), false);
  assert.equal(itemUsableInMode(ITEMS.shield, 'flags'), true);
  assert.equal(itemUsableInMode(ITEMS.shield, 'explorers'), false);
  assert.equal(itemUsableInMode(ITEMS.reveal, 'explorers'), true);
  assert.equal(itemUsableInMode(ITEMS.double_area, 'elimination'), true);
  assert.equal(itemUsableInMode(ITEMS.explorer, 'flags'), true); // global items are not competition items
});
