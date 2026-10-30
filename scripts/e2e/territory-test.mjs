// End-to-end test of territory processing (conquest, theft, merge, delete, competition scoring,
// fortifications, powers) against the bundled Worker, with the territory queue run in-process.
//
//   npx esbuild worker/src/index.ts --bundle --format=esm --platform=node --target=node20 \
//     --outfile=scripts/e2e/.build/worker.mjs --alias:@libsql/client/web=@libsql/client --alias:cloudflare:sockets=./scripts/e2e/cloudflare-sockets-stub.mjs --external:@libsql/client
//   rm -f scripts/e2e/.build/territory.db
//   DATABASE_URL=file:scripts/e2e/.build/territory.db npx drizzle-kit push --force
//   node scripts/e2e/territory-test.mjs
//
// Runs are synthetic GPS tracks in Zaragoza: squares and a figure eight, a point every ~10 m at 3 m/s.
import { createClient } from '@libsql/client';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pendingSignup } from './signup.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const databaseUrl = process.env.E2E_DATABASE_URL || `file:${path.join(here, '.build', 'territory.db')}`;

let failures = 0;
function check(name, condition, extra = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${condition ? '' : ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`}`);
  if (!condition) failures++;
}
const near = (value, expected, tolerance) => Math.abs(value - expected) <= expected * tolerance;

// ---------- Synthetic runs ----------

const LAT0 = 41.65;
const M_LAT = 1 / 111_000;
const M_LNG = 1 / (111_000 * Math.cos((LAT0 * Math.PI) / 180));

/** Square of `side` metres with its south-west corner `east`/`north` metres from the origin. */
function square(east, north, side, step = 10) {
  const corners = [[0, 0], [side, 0], [side, side], [0, side], [0, 0]];
  const points = [];
  for (let c = 0; c < 4; c++) {
    const [x1, y1] = corners[c];
    const [x2, y2] = corners[c + 1];
    const n = Math.round(side / step);
    for (let i = 0; i < n; i++) {
      const x = x1 + ((x2 - x1) * i) / n;
      const y = y1 + ((y2 - y1) * i) / n;
      points.push([LAT0 + (north + y) * M_LAT, -0.89 + (east + x) * M_LNG]);
    }
  }
  points.push(points[0]);
  return points;
}

/** Figure eight: two squares of `side` sharing a corner, run as one self-crossing loop. */
function figureEight(east, north, side) {
  const p = (x, y) => [LAT0 + (north + y) * M_LAT, -0.89 + (east + x) * M_LNG];
  const path = [[0, 0], [side, 0], [side, side], [2 * side, side], [2 * side, 2 * side], [side, 2 * side], [side, side], [0, side], [0, 0]];
  const points = [];
  for (let i = 0; i < path.length - 1; i++) {
    const [x1, y1] = path[i];
    const [x2, y2] = path[i + 1];
    const n = Math.max(1, Math.round(Math.hypot(x2 - x1, y2 - y1) / 10));
    for (let k = 0; k < n; k++) points.push(p(x1 + ((x2 - x1) * k) / n, y1 + ((y2 - y1) * k) / n));
  }
  points.push(points[0]);
  return points;
}

/** Bow tie: a loop whose path crosses itself in the middle (two triangles of side² / 2 each). */
function bowTie(east, north, side) {
  const p = (x, y) => [LAT0 + (north + y) * M_LAT, -0.89 + (east + x) * M_LNG];
  const path = [[0, 0], [2 * side, side], [2 * side, 0], [0, side], [0, 0]];
  const points = [];
  for (let i = 0; i < path.length - 1; i++) {
    const [x1, y1] = path[i];
    const [x2, y2] = path[i + 1];
    const n = Math.max(1, Math.round(Math.hypot(x2 - x1, y2 - y1) / 10));
    for (let k = 0; k < n; k++) points.push(p(x1 + ((x2 - x1) * k) / n, y1 + ((y2 - y1) * k) / n));
  }
  points.push(points[0]);
  return points;
}

function lengthMeters(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const dy = (points[i][0] - points[i - 1][0]) / M_LAT;
    const dx = (points[i][1] - points[i - 1][1]) / M_LNG;
    total += Math.hypot(dx, dy);
  }
  return total;
}

// ---------- Worker harness ----------

const worker = (await import('./.build/worker.mjs')).default;
const db = createClient({ url: databaseUrl });
const queued = [];
const pending = [];
const env = {
  DATABASE_URL: databaseUrl,
  ENVIRONMENT: 'test',
  UPSTASH_CRON_SECRET: 'e2e-cron-secret',
  FRONTEND_URL: 'http://localhost:5000',
  WORKER_URL: 'https://api.example.test',
  TERRITORY_QUEUE: { send: async (body) => { queued.push(body); } },
};
const ctx = { waitUntil: (p) => { pending.push(Promise.resolve(p)); }, passThroughOnException() {} };
const sentMessages = [];

async function deliver(body) {
  let retried = false;
  await worker.queue({ messages: [{ body, ack() {}, retry() { retried = true; } }] }, env);
  while (pending.length) await Promise.allSettled(pending.splice(0));
  return retried;
}

async function flush() {
  while (pending.length) await Promise.allSettled(pending.splice(0));
  while (queued.length) {
    const body = queued.shift();
    sentMessages.push(body);
    if (await deliver(body)) console.error('queue retry', body.type, body.routeId);
  }
}

async function call(method, route, { token, body, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await worker.fetch(new Request(`http://127.0.0.1:8787${route}`, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx);
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

const one = async (sqlText, args = []) => (await db.execute({ sql: sqlText, args })).rows[0];
const all = async (sqlText, args = []) => (await db.execute({ sql: sqlText, args })).rows;

async function register(username) {
  const r = await call('POST', '/api/auth/register/confirm', { body: await pendingSignup(db, { username }) });
  await flush();
  return { id: r.data.id, token: r.data.token, username };
}

let minutes = 0;
/** Uploads a run (as the iOS app does) and processes its territory. Returns the route id. */
async function run(user, points, name = 'Carrera') {
  const distance = lengthMeters(points);
  const duration = Math.round(distance / 3);
  // Each run a bit later than the previous one, all in the last hour
  const start = new Date(Date.now() - 60 * 60 * 1000 + minutes++ * 60 * 1000);
  const res = await call('POST', '/api/routes', {
    token: user.token,
    body: {
      name, coordinates: points, distance, duration,
      startedAt: start.toISOString(), completedAt: new Date(start.getTime() + duration * 1000).toISOString(),
      clientRunId: `run-${user.username}-${minutes}`,
    },
  });
  if (res.status !== 200 && res.status !== 201) console.error('run upload failed', res);
  await flush();
  return res.data?.route?.id ?? res.data?.id;
}

const territoryArea = async (userId) => Number((await one('select coalesce(sum(area), 0) a from territories where user_id = ?', [userId])).a);
const userArea = async (userId) => Number((await one('select total_area a from users where id = ?', [userId])).a);
const metricsCount = async (attackerId) => Number((await one('select count(*) n from conquest_metrics where attacker_id = ?', [attackerId])).n);

async function befriend(a, b) {
  await db.execute({ sql: 'insert into friendships (user_id, friend_id) values (?, ?), (?, ?)', args: [a.id, b.id, b.id, a.id] });
}

// ---------- Scenario ----------

const stamp = Date.now() % 100000;
const alice = await register(`ali${stamp}`);
const bob = await register(`bob${stamp}`);
const carol = await register(`car${stamp}`);
await befriend(alice, bob);
await befriend(alice, carol);
await befriend(bob, carol);
check('users registered', !!alice.token && !!bob.token && !!carol.token);

// 1. A 400 m square: ~160.000 m² of territory
const aliceRoute1 = await run(alice, square(0, 0, 400));
const a1 = await territoryArea(alice.id);
check('square run conquers its area', near(a1, 160_000, 0.05), a1);
check('total area matches the territory', near(await userArea(alice.id), a1, 0.001), { user: await userArea(alice.id), a1 });

// 2. Bob runs a square over the east half: steals ~80.000 m²
const bobRoute1 = await run(bob, square(200, 0, 400));
const a2 = await territoryArea(alice.id);
check('theft: Alice keeps the west half', near(a2, 80_000, 0.08), a2);
check('theft recorded once', await metricsCount(bob.id) === 1, await metricsCount(bob.id));
check('victim total area updated', near(await userArea(alice.id), a2, 0.001));

// 3. The same queue message again (at-least-once delivery): nothing changes
const bobMessage = sentMessages.find((m) => m.routeId === bobRoute1);
const bobAreaBefore = await territoryArea(bob.id);
await deliver(bobMessage);
check('duplicate message: no second theft', await metricsCount(bob.id) === 1, await metricsCount(bob.id));
check('duplicate message: areas unchanged', near(await territoryArea(alice.id), a2, 0.001) && near(await territoryArea(bob.id), bobAreaBefore, 0.001));

// 4. A run that touches Bob's border (GPS drift of a couple of metres) isn't a theft
const carolTouch = await run(carol, square(600, -2, 300));
check('touching a border is not a theft', await metricsCount(carol.id) === 0, await metricsCount(carol.id));

// 5. Loops that touch or cross themselves are valid polygons with the right area
const carolBeforeEight = await territoryArea(carol.id);
await run(carol, figureEight(1500, 1500, 200));
const carolAfterEight = await territoryArea(carol.id);
check('figure eight (touching lobes) conquers both lobes', near(carolAfterEight - carolBeforeEight, 80_000, 0.1), carolAfterEight - carolBeforeEight);
await run(carol, bowTie(2500, 1500, 300));
const bowTieGain = (await territoryArea(carol.id)) - carolAfterEight;
check('crossing loop (bow tie) conquers both halves', near(bowTieGain, 90_000, 0.1), bowTieGain);

// 6. Alice runs far away, then deletes that run: her robbed square is not given back
const aliceFar = await run(alice, square(3000, 3000, 300));
const aliceWithFar = await territoryArea(alice.id);
check('far run adds its area', near(aliceWithFar - a2, 90_000, 0.08), aliceWithFar);
const del = await call('DELETE', `/api/routes/${alice.id}/${aliceFar}`, { token: alice.token });
await flush();
const aliceAfterDelete = await territoryArea(alice.id);
check('deleting a run removes only its area', del.status === 200 && near(aliceAfterDelete, a2, 0.08), { del: del.status, aliceAfterDelete, a2 });
check('deleting a run does not give back stolen area', aliceAfterDelete < 100_000, aliceAfterDelete);
check('after delete, Alice and Bob do not overlap', await overlapArea(alice.id, bob.id) < 100, await overlapArea(alice.id, bob.id));

async function overlapArea(userA, userB) {
  const r = await call('GET', `/api/territories/friends/${alice.id}`, { token: alice.token });
  const turf = await import('../../node_modules/@turf/turf/dist/esm/index.js');
  const geomOf = (id) => r.data.filter((t) => t.userId === id).map((t) => (typeof t.geometry === 'string' ? JSON.parse(t.geometry) : t.geometry));
  let total = 0;
  for (const g1 of geomOf(userA)) for (const g2 of geomOf(userB)) {
    const inter = turf.intersect(turf.featureCollection([turf.feature(g1), turf.feature(g2)]));
    if (inter) total += turf.area(inter);
  }
  return total;
}

// 7. Competition: new territory is worth 1.5x and the bonus survives later updates
const comp = await call('POST', '/api/admin/competition', {
  headers: { Authorization: 'Bearer e2e-cron-secret' },
  body: { name: 'Test', slug: `test-${stamp}`, startsAt: new Date(Date.now() - DAY()).toISOString(), endsAt: new Date(Date.now() + 7 * DAY()).toISOString() },
});
check('competition created', comp.status === 200 && !!comp.data.id, comp);
await db.execute({ sql: "update competitions set status = 'active' where id = ?", args: [comp.data.id] });
function DAY() { return 24 * 3600 * 1000; }

const bobCompRoute = await run(bob, square(0, 2000, 300));
// Delivered twice (at-least-once queue): counted once
const statsOnce = await one('select activities_count n from competition_stats where user_id = ? and competition_id = ?', [bob.id, comp.data.id]);
await deliver(sentMessages.find((m) => m.routeId === bobCompRoute));
const statsTwice = await one('select activities_count n from competition_stats where user_id = ? and competition_id = ?', [bob.id, comp.data.id]);
check('duplicate message: competition stats counted once', Number(statsOnce?.n) === 1 && Number(statsTwice?.n) === 1, { statsOnce, statsTwice });
const bobReal = await territoryArea(bob.id);
const bobStats = await one('select total_area from competition_stats where user_id = ? and competition_id = ?', [bob.id, comp.data.id]);
check('competition: users.total_area is the real area', near(await userArea(bob.id), bobReal, 0.001), { user: await userArea(bob.id), bobReal });
check('competition: score = real area + 50% of the new area', near(Number(bobStats?.total_area), bobReal + 0.5 * 90_000, 0.05), { stats: bobStats, bobReal });
// Carol steals part of it: Bob's score drops by what he lost, keeps the bonus
await run(carol, square(150, 2000, 300));
const bobRealAfter = await territoryArea(bob.id);
const bobStatsAfter = await one('select total_area from competition_stats where user_id = ? and competition_id = ?', [bob.id, comp.data.id]);
check('competition: victim score updated, bonus kept', near(Number(bobStatsAfter?.total_area), bobRealAfter + 0.5 * 90_000, 0.05), { stats: bobStatsAfter, bobRealAfter });

// 8. Fortifications: Alice runs the same square 5 more times: at most 3 layers in that zone
for (let i = 0; i < 5; i++) await run(alice, square(0, 0, 200));
const forts = await all('select id, created_at from territory_fortifications where user_id = ?', [alice.id]);
check('fortification capped at 3 layers', forts.length <= 3 && forts.length >= 1, forts.length);
const fortList = await call('GET', '/api/territories/fortifications', { token: alice.token });
const aliceForts = fortList.data.fortifications?.find((f) => f.userId === alice.id);
check('fortifications listed', !!aliceForts && aliceForts.records.length === forts.length, fortList.data);
await db.execute({ sql: 'update territory_fortifications set created_at = ? where user_id = ?', args: [new Date(Date.now() - 15 * DAY()).toISOString(), alice.id] });
const fortListOld = await call('GET', '/api/territories/fortifications', { token: alice.token });
check('fortifications expire after 14 days', !fortListOld.data.fortifications?.some((f) => f.userId === alice.id), fortListOld.data);

// 9. Double area power: exactly about twice the area, whatever the shape (a long thin rectangle)
await db.execute({
  sql: "insert into user_powers (user_id, competition_id, power_type, treasure_id, status, activated_at) values (?, ?, 'double_area', 'test', 'active', ?)",
  args: [carol.id, comp.data.id, new Date().toISOString()],
});
const carolBefore = await territoryArea(carol.id);
const thin = [];
{
  // 1.000 x 100 m rectangle far from everyone
  const corners = [[0, 0], [1000, 0], [1000, 100], [0, 100], [0, 0]];
  for (let c = 0; c < 4; c++) {
    const [x1, y1] = corners[c]; const [x2, y2] = corners[c + 1];
    const n = Math.round(Math.hypot(x2 - x1, y2 - y1) / 10);
    for (let i = 0; i < n; i++) thin.push([LAT0 + (5000 + y1 + ((y2 - y1) * i) / n) * M_LAT, -0.89 + (5000 + x1 + ((x2 - x1) * i) / n) * M_LNG]);
  }
  thin.push(thin[0]);
}
await run(carol, thin);
const gained = (await territoryArea(carol.id)) - carolBefore;
check('double area: about 2x for a thin shape', near(gained, 200_000, 0.1), gained);

// 10. First run of a new user is a crossing loop: the stored area is right (no union to fix it)
const dave = await register(`dav${stamp}`);
await run(dave, bowTie(8000, 8000, 300));
const daveArea = await territoryArea(dave.id);
check('first run, crossing loop: right area', near(daveArea, 90_000, 0.1) && near(await userArea(dave.id), daveArea, 0.001), daveArea);

// 11. Vertices don't pile up: many overlapping runs keep the territory small
for (let i = 0; i < 6; i++) await run(dave, square(8000 + i * 37, 8400 + (i % 2) * 23, 250));
const daveGeometry = JSON.parse((await one('select geometry from territories where user_id = ?', [dave.id])).geometry);
const vertexCount = JSON.stringify(daveGeometry.coordinates).split('],[').length;
check('territory geometry stays simplified', vertexCount < 400, vertexCount);

// 12. A territory stored before bounding boxes existed is still found (and gets its box)
await befriend(dave, carol);
await db.execute({ sql: 'update territories set bbox_min_lng = null, bbox_min_lat = null, bbox_max_lng = null, bbox_max_lat = null where user_id = ?', args: [dave.id] });
const carolMetricsBefore = await metricsCount(carol.id);
await run(carol, square(8000, 8000, 150));
check('old territory without bbox can still be stolen from', await metricsCount(carol.id) === carolMetricsBefore + 1, await metricsCount(carol.id));
const daveBox = await one('select bbox_min_lng from territories where user_id = ?', [dave.id]);
check('its bounding box is filled in', daveBox && daveBox.bbox_min_lng !== null, daveBox);

// 13. Privacy: your runs in full; a friend's without the stretch near home; a stranger's not at all
const distanceM = (a, b) => Math.hypot((a[0] - b[0]) / M_LAT, (a[1] - b[1]) / M_LNG);
const own = await call('GET', `/api/routes/${alice.id}`, { token: alice.token });
const ownRun = own.data.find((r) => r.id === aliceRoute1);
const fullStart = ownRun.coordinates[0];
check('own runs: full track', own.status === 200 && ownRun.coordinates.length > 100, own.status);
const asFriend = await call('GET', `/api/routes/${alice.id}`, { token: bob.token });
const friendView = asFriend.data.find((r) => r.id === aliceRoute1);
check("friend's runs: start and end hidden (200 m)", asFriend.status === 200 && friendView.coordinates.length > 10
  && distanceM(friendView.coordinates[0], fullStart) >= 195 && distanceM(friendView.coordinates.at(-1), fullStart) >= 195,
  { status: asFriend.status, first: friendView && distanceM(friendView.coordinates[0], fullStart) });
const asStranger = await call('GET', `/api/routes/${alice.id}`, { token: dave.token });
check("stranger can't download someone's runs", asStranger.status === 403, asStranger.status);
const feed = await call('GET', `/api/feed/${bob.id}`, { token: bob.token });
const aliceCard = (Array.isArray(feed.data) ? feed.data : feed.data.events ?? []).find((e) => e.routeId === aliceRoute1);
check("feed: friend's run without the stretch near home", !!aliceCard && aliceCard.routeCoordinates.length > 0
  && distanceM(aliceCard.routeCoordinates[0], fullStart) >= 195, aliceCard && { n: aliceCard.routeCoordinates.length });
check('lists of everyone need a session', (await call('GET', '/api/leaderboard')).status === 401
  && (await call('GET', '/api/territories')).status === 401 && (await call('GET', '/api/territories/fortifications')).status === 401);

// 14. Time and altitude of each point: stored, trimmed with the track for friends, checked for bike stretches
{
  const points = square(10000, 0, 400);
  const times = points.map((_, i) => i * 3.3); // ~3 m/s
  const altitudes = points.map((_, i) => 200 + Math.sin(i / 10) * 5);
  const start = new Date(Date.now() - 30 * 60 * 1000);
  const distance = lengthMeters(points);
  const up = await call('POST', '/api/routes', {
    token: alice.token,
    body: {
      name: 'Con tiempos', coordinates: points, distance, duration: Math.round(times.at(-1)),
      startedAt: start.toISOString(), completedAt: new Date(start.getTime() + times.at(-1) * 1000).toISOString(),
      clientRunId: `times-${stamp}`, pointTimes: times, altitudes,
    },
  });
  await flush();
  const mine = (await call('GET', `/api/routes/${alice.id}`, { token: alice.token })).data.find((r) => r.id === up.data.route.id);
  check('point times and altitudes stored', mine && mine.pointTimes?.length === points.length && mine.altitudes?.length === points.length
    && Math.abs(mine.pointTimes[10] - times[10]) < 0.11, mine && { t: mine.pointTimes?.length, a: mine.altitudes?.length });
  const friendsView = (await call('GET', `/api/routes/${alice.id}`, { token: bob.token })).data.find((r) => r.id === up.data.route.id);
  check("friend's view: times trimmed with the track", friendsView && friendsView.pointTimes.length === friendsView.coordinates.length
    && friendsView.coordinates.length < points.length, friendsView && { c: friendsView.coordinates.length, t: friendsView.pointTimes.length });

  // 4 km running at 3 m/s with 1 km by bike at 11 m/s (40 km/h): plausible average, impossible stretch
  const track = [];
  const trackTimes = [];
  let t = 0;
  for (let i = 0; i <= 500; i++) {
    track.push([LAT0 + (6000 + i * 10) * M_LAT, -0.89 + 6000 * M_LNG]);
    trackTimes.push(t);
    t += i >= 200 && i < 300 ? 10 / 11 : 10 / 3;
  }
  const bikeStart = new Date(Date.now() - 40 * 60 * 1000);
  const bike = await call('POST', '/api/routes', {
    token: alice.token,
    body: {
      name: 'Con bici', coordinates: track, distance: 5000, duration: Math.round(t),
      startedAt: bikeStart.toISOString(), completedAt: new Date(bikeStart.getTime() + t * 1000).toISOString(),
      clientRunId: `bike-${stamp}`, pointTimes: trackTimes,
    },
  });
  check('a bike stretch inside a run is refused', bike.status === 422 && bike.data.reason === 'too_fast_segment', bike);
  const noTimes = await call('POST', '/api/routes', {
    token: alice.token,
    body: {
      name: 'Sin tiempos', coordinates: track, distance: 5000, duration: Math.round(t),
      startedAt: bikeStart.toISOString(), completedAt: new Date(bikeStart.getTime() + t * 1000).toISOString(),
      clientRunId: `notimes-${stamp}`,
    },
  });
  check('same run without times: only the average is checked', noTimes.status === 200 || noTimes.status === 201, noTimes.status);
}

// 15. Weekly ranking among friends: this week's conquered area, km and runs; strangers not included
{
  const weekly = await call('GET', `/api/leaderboard/friends/${alice.id}/weekly`, { token: alice.token });
  const entries = weekly.data?.entries ?? [];
  const me = entries.find((e) => e.id === alice.id);
  check('weekly ranking: me and my friends only', weekly.status === 200 && !!me && !entries.some((e) => e.id === dave.id)
    && entries.length === 3, weekly.data);
  check('weekly ranking: area, km and runs of this week', me && me.weekRuns >= 1 && me.weekDistance > 0 && me.weekArea > 0, me);
  check('weekly ranking: sorted by area', entries.every((e, i) => i === 0 || entries[i - 1].weekArea >= e.weekArea)
    && entries.every((e, i) => e.rank === i + 1), entries.map((e) => [e.username, e.weekArea]));
  const other = await call('GET', `/api/leaderboard/friends/${bob.id}/weekly`, { token: alice.token });
  check("weekly ranking: not someone else's", other.status === 403, other.status);
}

// Overlap (m²) between two users' territories, straight from the database
async function overlapDb(userA, userB) {
  const turf = await import('../../node_modules/@turf/turf/dist/esm/index.js');
  const geoms = async (id) => (await all('select geometry from territories where user_id = ?', [id])).map((r) => JSON.parse(r.geometry));
  let total = 0;
  for (const g1 of await geoms(userA)) for (const g2 of await geoms(userB)) {
    const inter = turf.intersect(turf.featureCollection([turf.feature(g1), turf.feature(g2)]));
    if (inter) total += turf.area(inter);
  }
  return total;
}

// 16. Castles (no competition needed): each castle stops one attack on its zone, then it falls
await db.execute({ sql: "update competitions set status = 'finished', ends_at = ? where id = ?", args: [new Date(Date.now() - DAY()).toISOString(), comp.data.id] });
{
  const eve = await register(`eve${stamp}`);
  const fred = await register(`fre${stamp}`);
  await befriend(eve, fred);
  await run(eve, square(12000, 0, 300));
  await run(eve, square(12000, 0, 300));
  await run(eve, square(12000, 0, 300));
  const castlesOf = async (user) => ((await call('GET', '/api/territories/fortifications', { token: fred.token })).data.castles || []).filter((z) => z.userId === user.id);
  const zones = await castlesOf(eve);
  check('castles: running your zone again builds castles (one zone, 2 castles), friends see them',
    zones.length === 1 && zones[0].layers === 2 && Number.isFinite(zones[0].lat) && !!zones[0].expiresAt && !!zones[0].nextExpiryAt, zones);
  const eveArea = await territoryArea(eve.id);
  const fredMetrics = await metricsCount(fred.id);
  await run(fred, square(12150, 0, 300));
  check('castle stops the attack: nothing stolen', near(await territoryArea(eve.id), eveArea, 0.01) && await metricsCount(fred.id) === fredMetrics,
    { eve: await territoryArea(eve.id), eveArea });
  check('the attacker does not get the protected zone', await overlapDb(eve.id, fred.id) < 100, await overlapDb(eve.id, fred.id));
  check('the attacker keeps the part outside the castles', near(await territoryArea(fred.id), 45_000, 0.12), await territoryArea(fred.id));
  check('one castle fell', (await castlesOf(eve))[0]?.layers === 1, await castlesOf(eve));
  await run(fred, square(12150, 0, 300));
  check('second attack: the last castle falls, the zone holds', near(await territoryArea(eve.id), eveArea, 0.01) && (await castlesOf(eve)).length === 0);
  await run(fred, square(12150, 0, 300));
  check('without castles the zone is stolen', near(eveArea - await territoryArea(eve.id), 45_000, 0.12), eveArea - await territoryArea(eve.id));
}

// 17. Decay: zones not run over for 14 days wear away from the border, ~3 % a day
{
  const gus = await register(`gus${stamp}`);
  const routeA = await run(gus, square(15000, 0, 400));
  const routeB = await run(gus, square(16000, 0, 400));
  const decayPass = async () => {
    const r = await call('POST', '/api/tasks/territory-decay', { headers: { Authorization: 'Bearer e2e-cron-secret' } });
    await flush();
    return r;
  };
  const daysAgo = (days) => new Date(Date.now() - days * DAY()).toISOString();
  const weakOf = async () => (await call('GET', '/api/territories/weak', { token: gus.token })).data;
  const first = await decayPass();
  const before = await territoryArea(gus.id);
  const state = await one('select * from territory_decay where user_id = ?', [gus.id]);
  check('decay: the first pass only starts the clock', first.status === 200 && !!state && near(before, 320_000, 0.05), { first, before });

  // A was run 20 days ago, B 5 days ago, the clock started 30 days ago
  await db.execute({ sql: 'update routes set started_at = ? where id = ?', args: [daysAgo(20), routeA] });
  await db.execute({ sql: 'update routes set started_at = ? where id = ?', args: [daysAgo(5), routeB] });
  await db.execute({ sql: 'update territory_decay set tracking_since = ?, last_day = null where user_id = ?', args: [daysAgo(30), gus.id] });
  await decayPass();
  const after = await territoryArea(gus.id);
  const lost = before - after;
  check('decay: the undefended zone loses about 3 % a day', lost > 1_500 && lost < 9_000, lost);
  check('decay: total area updated', near(await userArea(gus.id), after, 0.001));
  const weak = await weakOf();
  const turf = await import('../../node_modules/@turf/turf/dist/esm/index.js');
  const gusWeak = weak.zones?.find((z) => z.userId === gus.id);
  check('decay: the worn zone is listed as weak (only A)', !!gusWeak?.weak && near(turf.area(gusWeak.weak), 160_000 - lost, 0.1), gusWeak && turf.area(gusWeak.weak));
  await decayPass();
  check('decay: one pass a day (a repeated message changes nothing)', near(await territoryArea(gus.id), after, 0.0001));

  // B was last run 12,5 days ago: it starts wearing away in two days
  await db.execute({ sql: 'update routes set started_at = ? where id = ?', args: [daysAgo(12.5), routeB] });
  await db.execute({ sql: 'update territory_decay set last_day = null where user_id = ?', args: [gus.id] });
  await decayPass();
  const atRisk = (await weakOf()).zones?.find((z) => z.userId === gus.id)?.atRisk;
  check('decay: zone at risk in two days', !!atRisk && near(turf.area(atRisk), 160_000, 0.1), atRisk && turf.area(atRisk));

  // Running through A defends it at once
  await run(gus, square(15000, 0, 400));
  const afterRun = (await weakOf()).zones?.find((z) => z.userId === gus.id);
  check('decay: running a weak zone defends it right away', !afterRun?.weak || turf.area(afterRun.weak) < 1_000, afterRun && afterRun.weak && turf.area(afterRun.weak));

  // Rest mode: the clock stops
  const rest = await call('POST', '/api/user/rest', { token: gus.token, body: { days: 3 } });
  check('rest mode starts', rest.status === 200 && rest.data.active && rest.data.daysLeft === 11, rest);
  check('rest mode: not twice at once', (await call('POST', '/api/user/rest', { token: gus.token, body: { days: 2 } })).status === 409);
  await db.execute({ sql: 'update routes set started_at = ? where user_id = ?', args: [daysAgo(20), gus.id] });
  await db.execute({ sql: 'update territory_decay set last_day = null where user_id = ?', args: [gus.id] });
  const restingArea = await territoryArea(gus.id);
  await decayPass();
  check('rest mode: nothing wears away', near(await territoryArea(gus.id), restingArea, 0.0001));
  const ended = await call('DELETE', '/api/user/rest', { token: gus.token });
  check('rest mode ended early gives back the unused days', ended.status === 200 && !ended.data.active && ended.data.daysLeft === 13, ended);
  check('rest mode: at most the days left', (await call('POST', '/api/user/rest', { token: gus.token, body: { days: 20 } })).status === 400);
}

// 18. A total left negative by an older version is fixed from the territories
{
  await db.execute({ sql: 'update users set total_area = ? where id = ?', args: [-13_342, alice.id] });
  await call('POST', '/api/tasks/territory-decay', { headers: { Authorization: 'Bearer e2e-cron-secret' } });
  await flush();
  check('negative total area recomputed from the territories', near(await userArea(alice.id), await territoryArea(alice.id), 0.001) && await userArea(alice.id) > 0,
    { user: await userArea(alice.id), territory: await territoryArea(alice.id) });
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
