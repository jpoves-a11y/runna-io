// End-to-end test of territory conquest (merging, steals between friends, ran-together, duplicate
// imports, route deletion) against the bundled Worker, with queue messages run in-process.
//
//   npx esbuild worker/src/index.ts --bundle --format=esm --platform=node --target=node20 \
//     --outfile=scripts/e2e/.build/worker.mjs --alias:@libsql/client/web=@libsql/client --alias:cloudflare:sockets=./scripts/e2e/cloudflare-sockets-stub.mjs --external:@libsql/client
//   rm -f scripts/e2e/.build/territory.db
//   DATABASE_URL=file:scripts/e2e/.build/territory.db npx drizzle-kit push --force
//   node scripts/e2e/territory-test.mjs
import { createClient } from '@libsql/client';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as turf from '@turf/turf';
import { pendingSignup } from './signup.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const databaseUrl = process.env.E2E_DATABASE_URL || `file:${path.join(here, '.build', 'territory.db')}`;

let failures = 0;
function check(name, condition, extra = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${condition ? '' : ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`}`);
  if (!condition) failures++;
}

globalThis.fetch = async (input) => {
  throw new Error(`unexpected network call in test: ${input instanceof Request ? input.url : input}`);
};

// ---------- Worker ----------

const worker = (await import('./.build/worker.mjs')).default;
const db = createClient({ url: databaseUrl });
const queued = [];
const pending = [];
const env = {
  DATABASE_URL: databaseUrl,
  ENVIRONMENT: 'test',
  UPSTASH_CRON_SECRET: 'e2e-cron-secret',
  FRONTEND_URL: 'http://localhost:5000',
  WORKER_URL: 'http://127.0.0.1:8787',
  TERRITORY_QUEUE: { send: async (body) => { queued.push(body); } },
};
const ctx = { waitUntil: (p) => { pending.push(Promise.resolve(p)); }, passThroughOnException() {} };

/** Waits for background work, then runs queued territory messages one at a time, like the queue consumer. */
async function flush() {
  while (pending.length) await Promise.allSettled(pending.splice(0));
  while (queued.length) {
    const body = queued.shift();
    await worker.queue({ messages: [{ body, ack() {}, retry() { console.error('queue retry', body.type); } }] }, env);
    while (pending.length) await Promise.allSettled(pending.splice(0));
  }
}

async function call(method, route, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await worker.fetch(new Request(`http://127.0.0.1:8787${route}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx);
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

const one = async (sqlText, args = []) => (await db.execute({ sql: sqlText, args })).rows[0];
const all = async (sqlText, args = []) => (await db.execute({ sql: sqlText, args })).rows;

const stamp = Date.now() % 100000;
async function register(name) {
  const r = await call('POST', '/api/auth/register/confirm', { body: await pendingSignup(db, { username: `${name}${stamp}` }) });
  return { id: r.data.id, token: r.data.token, name };
}
async function befriend(a, b) {
  await db.execute({ sql: 'insert into friendships (user_id, friend_id) values (?, ?), (?, ?)', args: [a.id, b.id, b.id, a.id] });
}

// ---------- Runs ----------

const ORIGIN = [41.6488, -0.8891]; // Zaragoza
const M_LAT = 1 / 111320;
const M_LNG = 1 / (111320 * Math.cos((ORIGIN[0] * Math.PI) / 180));
const HOUR = 3600 * 1000;

/** A square loop of `side` meters, `east`/`north` meters from the origin, sampled every ~10 m at 3 m/s. */
function squareRun({ east = 0, north = 0, side = 600, hoursAgo }) {
  const coordinates = [];
  for (let d = 0; d <= 4 * side; d += 10) {
    const leg = Math.min(3, Math.floor(d / side));
    const along = d - leg * side;
    const [x, y] = leg === 0 ? [along, 0] : leg === 1 ? [side, along] : leg === 2 ? [side - along, side] : [0, side - along];
    coordinates.push([ORIGIN[0] + (north + y) * M_LAT, ORIGIN[1] + (east + x) * M_LNG]);
  }
  const distance = 4 * side;
  const duration = Math.round(distance / 3);
  const startedAt = new Date(Date.now() - hoursAgo * HOUR);
  return {
    name: 'Test run',
    coordinates,
    distance,
    duration,
    startedAt: startedAt.toISOString(),
    completedAt: new Date(startedAt.getTime() + duration * 1000).toISOString(),
  };
}

async function upload(user, run) {
  const res = await call('POST', '/api/routes', { token: user.token, body: { userId: user.id, ...run } });
  await flush();
  return { status: res.status, id: res.data?.route?.id, data: res.data };
}

const territoryGeometry = async (user) => {
  const rows = await all('select geometry from territories where user_id = ?', [user.id]);
  return rows.map((r) => JSON.parse(r.geometry));
};
const territoryArea = async (user) => Number((await one('select coalesce(sum(area), 0) a from territories where user_id = ?', [user.id])).a);
const userArea = async (user) => Number((await one('select total_area a from users where id = ?', [user.id])).a);
function overlapArea(geometriesA, geometriesB) {
  let total = 0;
  for (const a of geometriesA) for (const b of geometriesB) {
    const i = turf.intersect(turf.featureCollection([turf.feature(a), turf.feature(b)]));
    if (i) total += turf.area(i);
  }
  return total;
}
const near = (value, expected, tolerance) => Math.abs(value - expected) <= tolerance;

// ---------- Scenario ----------

const ana = await register('ana');
const ben = await register('ben');
const eva = await register('eva');
const far = await register('far');
const stranger = await register('str');
check('users registered', [ana, ben, eva, far, stranger].every((u) => !!u.token));
await befriend(ana, ben);
await befriend(ana, eva);
await befriend(ben, eva);
await befriend(ben, far);

// 1. First conquest
const anaRun = squareRun({ hoursAgo: 48 });
const anaPost = await upload(ana, anaRun);
check('ana run accepted', anaPost.status === 200 && !!anaPost.id, anaPost.status);
const anaRouteId = anaPost.id;
const squareArea = 600 * 600;
check('ana conquers the square', near(await territoryArea(ana), squareArea, squareArea * 0.03), await territoryArea(ana));
check('ana total area matches her territory', near(await userArea(ana), await territoryArea(ana), 1));
const anaFeed = await one('select * from feed_events where route_id = ?', [anaRouteId]);
check('feed event filled with the conquest', !!anaFeed?.metadata && near(Number(anaFeed.new_area), squareArea, squareArea * 0.03), anaFeed);
const result = await call('GET', `/api/conquest-result/${anaRouteId}`, { token: ana.token });
check('conquest-result ready', result.data.ready === true && result.data.newAreaConquered > 0, result.data);
const stored = (await one('select geometry from territories where user_id = ?', [ana.id])).geometry;
check('stored geometry is compact (≤ 6 decimals)', !/\d\.\d{7,}/.test(stored), stored.slice(0, 200));

// 2. The same route enqueued again (second import source, duplicate delivery): nothing changes
const fortsBefore = Number((await one('select count(*) n from territory_fortifications')).n ?? 0);
queued.push({ type: 'process_route_territory', userId: ana.id, routeId: anaRouteId, startedAt: anaRun.startedAt, completedAt: anaRun.completedAt, distance: anaRun.distance, duration: anaRun.duration });
await flush();
const anaFeedAgain = await one('select * from feed_events where route_id = ?', [anaRouteId]);
check('duplicate message: feed area not overwritten with 0', Number(anaFeedAgain.new_area) === Number(anaFeed.new_area), { before: anaFeed.new_area, after: anaFeedAgain.new_area });
check('duplicate message: no fortification of her own run', Number((await one('select count(*) n from territory_fortifications')).n ?? 0) === fortsBefore);

// 3. Many newer territories of a friend far away: they must not hide ana's territory from ben
for (let i = 0; i < 30; i++) {
  const lng = ORIGIN[1] + 0.2 + i * 0.01;
  const poly = turf.polygon([[[lng, ORIGIN[0] + 0.1], [lng + 0.001, ORIGIN[0] + 0.1], [lng + 0.001, ORIGIN[0] + 0.101], [lng, ORIGIN[0] + 0.1]]]);
  await db.execute({ sql: 'insert into territories (user_id, geometry, area, conquered_at) values (?, ?, ?, ?)', args: [far.id, JSON.stringify(poly.geometry), turf.area(poly), new Date().toISOString()] });
}

// 4. Ben runs over the east half of ana's square: steals it
const benPost = await upload(ben, squareRun({ east: 300, hoursAgo: 24 }));
const anaAfterSteal = await territoryArea(ana);
check('ben steals the east half from ana (despite 30 newer far-away territories)', near(anaAfterSteal, squareArea / 2, squareArea * 0.05), anaAfterSteal);
check('ana total area follows the steal', near(await userArea(ana), anaAfterSteal, 1));
check('ana and ben territories do not overlap', overlapArea(await territoryGeometry(ana), await territoryGeometry(ben)) < 50);
const metric = await one('select * from conquest_metrics where attacker_id = ? and defender_id = ?', [ben.id, ana.id]);
check('conquest metric recorded', !!metric && near(Number(metric.area_stolen), squareArea / 2, squareArea * 0.05), metric);
const benFeed = await one('select * from feed_events where route_id = ?', [benPost.id]);
check('ben feed lists ana as victim', JSON.parse(benFeed.metadata || '{}').victims?.[0]?.userId === ana.id, benFeed?.metadata);

// 5. A stranger (not a friend) runs over everything: steals nothing outside a competition
await upload(stranger, squareRun({ east: 150, hoursAgo: 20 }));
check('stranger steals nothing from ana', near(await territoryArea(ana), anaAfterSteal, 5));

// 6. Eva runs together with ana (same start, same loop): no steal between them
const together = squareRun({ north: 900, hoursAgo: 10 });
const anaTogether = await upload(ana, together);
const evaTogether = await upload(eva, { ...together, startedAt: new Date(Date.parse(together.startedAt) + 60_000).toISOString(), completedAt: new Date(Date.parse(together.completedAt) + 60_000).toISOString() });
const evaRoute = await one('select ran_together_with from routes where id = ?', [evaTogether.id]);
check('ran together recorded', JSON.parse(evaRoute.ran_together_with || '[]').includes(ana.id), evaRoute);
check('no steal between runners who ran together', overlapArea(await territoryGeometry(ana), await territoryGeometry(eva)) > squareArea * 0.9);

// 7. Ana deletes a run: her rebuilt territory must not take back what ben stole, but keeps what she shares with eva
const extra = await upload(ana, squareRun({ east: -3000, hoursAgo: 5 }));
const del = await call('DELETE', `/api/routes/${ana.id}/${extra.id}`, { token: ana.token });
check('route deleted', del.status === 200, del);
const anaGeom = await territoryGeometry(ana);
check('after delete: ana does not get ben\'s land back', overlapArea(anaGeom, await territoryGeometry(ben)) < 50, overlapArea(anaGeom, await territoryGeometry(ben)));
check('after delete: ana keeps the land shared with eva', overlapArea(anaGeom, await territoryGeometry(eva)) > squareArea * 0.9);
check('after delete: ana area = west half + shared square', near(await territoryArea(ana), squareArea / 2 + squareArea, squareArea * 0.06), await territoryArea(ana));
check('after delete: total area matches territory', near(await userArea(ana), await territoryArea(ana), 1));
check('after delete: ana has a single territory row', (await all('select id from territories where user_id = ?', [ana.id])).length === 1);

// 8. Friend group rebuild (on a new friendship) keeps ben's steal and the territories disjoint
queued.push({ type: 'reprocess_friend_group', userId: ana.id });
await flush();
check('friend rebuild: ana keeps west half + shared square', near(await territoryArea(ana), squareArea / 2 + squareArea, squareArea * 0.06), await territoryArea(ana));
check('friend rebuild: ana and ben do not overlap', overlapArea(await territoryGeometry(ana), await territoryGeometry(ben)) < 50);
check('friend rebuild: steal metric rebuilt', !!(await one('select * from conquest_metrics where attacker_id = ? and defender_id = ?', [ben.id, ana.id])));

// 9. Competition (all vs all): the stranger can steal now; a defender's time bomb keeps her land
await db.execute({ sql: "insert into competitions (name, slug, starts_at, ends_at, status) values ('Test', ?, ?, ?, 'active')", args: [`test-${stamp}`, new Date(Date.now() - 72 * HOUR).toISOString(), new Date(Date.now() + 72 * HOUR).toISOString()] });
const competitionId = (await one('select id from competitions where slug = ?', [`test-${stamp}`])).id;
await db.execute({ sql: "insert into user_powers (user_id, competition_id, power_type, treasure_id, status) values (?, ?, 'time_bomb', 't', 'active')", args: [eva.id, competitionId] });
const evaBefore = await territoryArea(eva);
const benBefore = await territoryArea(ben);
await upload(stranger, squareRun({ east: 150, north: 450, hoursAgo: 2 }));
check('competition: stranger steals from ben (no friendship needed)', await territoryArea(ben) < benBefore - 1000, { before: benBefore, after: await territoryArea(ben) });
check('competition: eva\'s time bomb keeps her territory intact', near(await territoryArea(eva), evaBefore, 5), { before: evaBefore, after: await territoryArea(eva) });
queued.push({ type: 'reprocess_friend_group', userId: ben.id });
const benStolen = await territoryArea(ben);
await flush();
check('competition: friend rebuild skipped (stranger\'s steal not undone)', near(await territoryArea(ben), benStolen, 5), { before: benStolen, after: await territoryArea(ben) });

console.log(failures === 0 ? '\nAll territory checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
