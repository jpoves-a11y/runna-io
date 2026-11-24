// End-to-end test of "ran together" against the bundled Worker, on the competition map (only club
// mates in a running competition steal): whoever uploads first, two runners who ran together don't
// steal from each other; a partial run only protects the shared area; the
// same loop run 12 minutes apart (with per-point times) is not "together"; "te han robado" pushes
// are queued, dropped when the steal is undone, and held while the victim is recording a run.
//
//   npx esbuild worker/src/index.ts --bundle --format=esm --platform=node --target=node20 \
//     --outfile=scripts/e2e/.build/worker.mjs --alias:@libsql/client/web=@libsql/client --alias:cloudflare:sockets=./scripts/e2e/cloudflare-sockets-stub.mjs --external:@libsql/client
//   rm -f scripts/e2e/.build/ran-together.db
//   DATABASE_URL=file:scripts/e2e/.build/ran-together.db npx drizzle-kit push --force
//   node scripts/e2e/ran-together-test.mjs
import { createClient } from '@libsql/client';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pendingSignup } from './signup.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const databaseUrl = process.env.E2E_DATABASE_URL || `file:${path.join(here, '.build', 'ran-together.db')}`;

let failures = 0;
function check(name, condition, extra = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${condition ? '' : ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`}`);
  if (!condition) failures++;
}

// ---------- Network: only APNs, recorded ----------

const apns = [];
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.host === 'api.sandbox.push.apple.com' || url.host === 'api.push.apple.com') {
    apns.push(JSON.parse(String(init.body)));
    return new Response('', { status: 200 });
  }
  throw new Error(`unexpected network call in test: ${url}`);
};

// ---------- Worker ----------

const DAY = 86400_000;
/** YYYY-MM-DD of the last Friday at least `minDaysAgo` days ago. */
function friday(minDaysAgo) {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - minDaysAgo);
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

const worker = (await import('./.build/worker.mjs')).default;
const db = createClient({ url: databaseUrl });
const queued = [];
const pending = [];
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const env = {
  DATABASE_URL: databaseUrl,
  ENVIRONMENT: 'test',
  UPSTASH_CRON_SECRET: 'e2e-cron-secret',
  FRONTEND_URL: 'http://localhost:5000',
  WORKER_URL: 'http://127.0.0.1:8787',
  APNS_KEY_ID: 'TESTKEY123',
  APNS_TEAM_ID: 'TEAM123456',
  APNS_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  APNS_BUNDLE_ID: 'com.jpoves.runnaio.app',
  // "now" is inside the first competition (day 2-8 of 10)
  SEASON_ANCHOR_DATE: friday(2),
  SUBREQUEST_LIMIT: 100000,
  TERRITORY_QUEUE: { send: async (body) => { queued.push(body); } },
};
const ctx = { waitUntil: (p) => { pending.push(Promise.resolve(p)); }, passThroughOnException() {} };

async function flush() {
  while (pending.length) await Promise.allSettled(pending.splice(0));
  while (queued.length) {
    const body = queued.shift();
    await worker.queue({ messages: [{ body, ack() {}, retry() { console.error('queue retry', body.type); } }] }, env);
  }
}

async function call(method, route, { token, body, useEnv = env } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await worker.fetch(new Request(`http://127.0.0.1:8787${route}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }), useEnv, ctx);
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

const rows = async (sqlText, args = []) => (await db.execute({ sql: sqlText, args })).rows;
const one = async (sqlText, args = []) => (await rows(sqlText, args))[0];

const stamp = Date.now() % 100000;
async function register(name) {
  const r = await call('POST', '/api/auth/register/confirm', { body: await pendingSignup(db, { username: `${name}${stamp}` }) });
  return { id: r.data.id, token: r.data.token, name };
}

// ---------- Synthetic runs: a square loop of 4 × 1250 m, a point every 25 m ----------

const MADRID = [40.4153, -3.6845];
const metersToLatLng = ([lat0, lng0], x, y) => [lat0 + y / 110574, lng0 + x / (Math.cos((lat0 * Math.PI) / 180) * 111320)];
function loop(origin, { offset = 0, from = 0, to = 1, tail = 0 } = {}) {
  const side = 1250;
  const corners = [[0, 0], [side, 0], [side, side], [0, side], [0, 0]];
  const points = [];
  for (let c = 0; c < 4; c++) {
    const [x0, y0] = corners[c];
    const [x1, y1] = corners[c + 1];
    for (let d = 0; d < side; d += 25) {
      const f = d / side;
      points.push(metersToLatLng(origin, x0 + (x1 - x0) * f + offset + (Math.random() - 0.5) * 6, y0 + (y1 - y0) * f + (Math.random() - 0.5) * 6));
    }
  }
  points.push(points[0]);
  let part = points.slice(Math.floor(from * (points.length - 1)), Math.floor(to * (points.length - 1)) + 1);
  if (tail > 0) {
    const [lat, lng] = part[part.length - 1];
    for (let d = 25; d <= tail; d += 25) part.push([lat - d / 110574, lng]);
  }
  return part;
}
const lengthOf = (pts) => pts.slice(1).reduce((sum, p, i) => {
  const [la1, ln1] = pts[i];
  const dx = (p[1] - ln1) * Math.cos((la1 * Math.PI) / 180) * 111320;
  const dy = (p[0] - la1) * 110574;
  return sum + Math.hypot(dx, dy);
}, 0);

const NOW = Date.now();
const MIN = 60 * 1000;
/** Uploads a run like the iOS app (with per-point times unless timed is false). */
async function upload(user, coords, startMinAgo, minutes, { timed = true, pointTimes = null } = {}) {
  const startedAt = new Date(NOW - startMinAgo * MIN);
  const completedAt = new Date(startedAt.getTime() + minutes * MIN);
  const body = {
    userId: user.id,
    name: `Carrera ${user.name}`,
    coordinates: coords,
    distance: Math.round(lengthOf(coords)),
    duration: minutes * 60,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    clientRunId: crypto.randomUUID(),
  };
  if (pointTimes) body.pointTimes = pointTimes;
  else if (timed) body.pointTimes = coords.map((_, i) => Math.round((i * minutes * 60) / (coords.length - 1)));
  const res = await call('POST', '/api/routes', { token: user.token, body });
  if (res.status !== 200) console.error('upload failed', res.status, res.data);
  await flush();
  return res.data.route;
}
const metricsFromRoute = (routeId, defenderId) => rows('select * from conquest_metrics where route_id = ? and defender_id = ?', [routeId, defenderId]);
const pendingFor = (routeId, victimId) => rows('select * from pending_steal_notifications where route_id = ? and victim_id = ?', [routeId, victimId]);
const ranTogetherOf = async (routeId) => JSON.parse((await one('select ran_together_with from routes where id = ?', [routeId]))?.ran_together_with || '[]');
const areaOf = async (userId) => Number((await one('select coalesce(sum(area), 0) as a from territories where user_id = ?', [userId])).a);
const feedMeta = async (routeId) => JSON.parse((await one('select metadata from feed_events where route_id = ?', [routeId]))?.metadata || '{}');

// ---------- Everybody in one club, with a free-for-all competition running ----------
const people = {};
for (const name of ['ana', 'bea', 'carla', 'dani', 'eva', 'fran', 'gema', 'hugo', 'ines']) {
  people[name] = await register(name);
  const res = await call('PATCH', '/api/users/me/location', { token: people[name].token, body: { city: 'Madrid', countryCode: 'ES', countryName: 'España', lat: MADRID[0], lng: MADRID[1] } });
  if (res.status !== 200) throw new Error(`location: ${JSON.stringify(res.data)}`);
}
const crest = { shape: 'classic', pattern: 'stripes', primary: '#16A34A', secondary: '#FFFFFF', icon: 'flame.fill', initials: 'MC' };
const club = (await call('POST', '/api/clubs', { token: people.ana.token, body: { name: `Madrid Corre ${stamp}`, crest, visibility: 'public' } })).data.club;
if (!club) throw new Error('club not created');
for (const p of Object.values(people)) if (p !== people.ana) {
  const joined = await call('POST', `/api/clubs/${club.id}/join`, { token: p.token, body: {} });
  if (!joined.data.joined) throw new Error(`join: ${JSON.stringify(joined.data)}`);
}
const admin = (route, body = {}) => call('POST', route, { token: env.UPSTASH_CRON_SECRET, body });
const tick = await admin('/api/admin/season/tick');
const competition = await one('select mode from club_competitions where club_id = ?', [club.id]);
check('setup: the club competition is running, everyone against everyone', tick.data.phase === 'competition' && competition?.mode === 'ffa', { tick: tick.data, competition });
// The runs below are from the last two hours: count them, as if everybody had joined at the start
await admin('/api/admin/season/runs-from', { at: new Date(NOW - 4 * DAY).toISOString() });
const season = (await call('GET', '/api/season/current', { token: people.ana.token })).data;
await db.execute({ sql: 'UPDATE club_members SET joined_at = ?', args: [season.cycle.competitionStartsAt] });
await db.execute({ sql: 'UPDATE competition_participants SET joined_at = ?', args: [season.cycle.competitionStartsAt] });
const players = await one('select count(*) as n from competition_participants p join club_competitions c on c.id = p.competition_id where c.club_id = ?', [club.id]);
check('setup: the 9 club mates take part', Number(players?.n) === 9, players);

// ---------- 1. Together, the club mate who stole uploads first ----------
{
  const a = people.ana;
  const b = people.bea;
  const origin = MADRID;
  await upload(b, loop(origin), 115, 25); // Bea's own territory from an earlier run
  const bAreaBefore = await areaOf(b.id);

  const routeA = await upload(a, loop(origin), 80, 25);
  const stolen = await metricsFromRoute(routeA.id, b.id);
  check('1. before Bea uploads, Ana\'s run takes her territory', stolen.length === 1 && stolen[0].stolen_geometry != null, stolen);
  check('1. the "te han robado" push is queued, not sent', (await pendingFor(routeA.id, b.id)).length === 1);

  // Bea started a minute later and kept recording the walk home (1 km, 12 more minutes)
  const loopB = loop(origin, { offset: 8 });
  const walkB = loop(origin, { offset: 8, tail: 1000 });
  const timesB = walkB.map((_, i) => i < loopB.length
    ? Math.round((i * 24 * 60) / (loopB.length - 1)) // the loop with Ana (24 min, she started 1 min later)
    : 24 * 60 + Math.round(((i - loopB.length + 1) * 12 * 60) / (walkB.length - loopB.length))); // walking home
  const routeB = await upload(b, walkB, 79, 36, { pointTimes: timesB });
  check('1. Ana\'s steal from Bea is undone', (await metricsFromRoute(routeA.id, b.id)).length === 0);
  check('1. Bea steals nothing from Ana', (await metricsFromRoute(routeB.id, a.id)).length === 0);
  check('1. the queued push is dropped', (await pendingFor(routeA.id, b.id)).length === 0);
  check('1. both runs list each other', (await ranTogetherOf(routeA.id)).includes(b.id) && (await ranTogetherOf(routeB.id)).includes(a.id));
  const metaA = await feedMeta(routeA.id);
  check('1. Ana\'s feed: Bea no longer a victim, shown as co-runner',
    !(metaA.victims || []).some((v) => v.userId === b.id) && (metaA.ranTogetherWith || []).some((u) => u.id === b.id), metaA);
  check('1. Bea\'s feed shows Ana', ((await feedMeta(routeB.id)).ranTogetherWith || []).some((u) => u.id === a.id));
  check('1. Bea keeps her territory', (await areaOf(b.id)) >= bAreaBefore * 0.97, { before: bAreaBefore, after: await areaOf(b.id) });
  check('1. Ana has the loop too (shared)', (await areaOf(a.id)) >= bAreaBefore * 0.9);

  // ---------- 4. Pushes: held while the victim records a run, then sent ----------
  await db.execute({ sql: 'insert into push_subscriptions (user_id, endpoint, p256dh, auth) values (?, ?, ?, ?)', args: [a.id, `apns:sandbox:device${stamp}`, 'apns', 'apns'] });
  const c = people.carla;
  const routeC = await upload(c, loop(origin, { offset: 3 }), 40, 25); // Carla runs the same loop alone later
  check('4. Carla took Ana\'s loop', (await metricsFromRoute(routeC.id, a.id)).length === 1);
  const queuedForAna = await pendingFor(routeC.id, a.id);
  check('4. a push to Ana is queued', queuedForAna.length === 1);
  check('4. it waits 3 minutes', Date.parse(queuedForAna[0]?.due_at) - Date.parse(queuedForAna[0]?.created_at) === 3 * MIN, queuedForAna[0]);
  // Ana is recording a run that started before Carla's ended: she may have been with Carla
  const active = await call('POST', '/api/runs/active', { token: a.token, body: { startedAt: new Date(NOW - 41 * MIN).toISOString() } });
  check('4. active run accepted', active.status === 200, active);
  await db.execute({ sql: 'update pending_steal_notifications set due_at = ? where victim_id = ?', args: [new Date(NOW - MIN).toISOString(), a.id] });
  const cronEnv = { ...env, INTERNAL_CRON: true };
  let cron = await call('POST', '/api/tasks/steal-notifications', { useEnv: cronEnv });
  check('4. held while Ana is recording', cron.data.postponed === 1 && cron.data.sent === 0 && (await pendingFor(routeC.id, a.id)).length === 1, cron.data);
  const heldUntil = Date.parse((await pendingFor(routeC.id, a.id))[0]?.due_at) - Date.now();
  check('4. looked at again 2 minutes later', heldUntil > 1.5 * MIN && heldUntil <= 2 * MIN, heldUntil);
  await call('DELETE', '/api/runs/active', { token: a.token });
  await db.execute({ sql: 'update pending_steal_notifications set due_at = ? where victim_id = ?', args: [new Date(NOW - MIN).toISOString(), a.id] });
  cron = await call('POST', '/api/tasks/steal-notifications', { useEnv: cronEnv });
  await flush();
  check('4. sent once the run is gone', cron.data.sent === 1 && (await pendingFor(routeC.id, a.id)).length === 0, cron.data);
  check('4. APNs push "te han robado"', apns.some((p) => p?.data?.type === 'territory_loss' || p?.type === 'territory_loss'), apns);

  // ---------- 4b. The runner's own push isn't sent once the app has shown the result ----------
  await db.execute({ sql: 'insert into activity_ready_notifications (route_id, user_id, source, due_at, sent_at, created_at) values (?, ?, ?, ?, NULL, ?)',
    args: [routeC.id, c.id, 'garmin', new Date(NOW - MIN).toISOString(), new Date(NOW - 4 * MIN).toISOString()] });
  await db.execute({ sql: 'insert into push_subscriptions (user_id, endpoint, p256dh, auth) values (?, ?, ?, ?)', args: [c.id, `apns:sandbox:carla${stamp}`, 'apns', 'apns'] });
  const notHers = await call('POST', `/api/routes/${routeC.id}/result-seen`, { token: a.token });
  const stillOpen = (await db.execute({ sql: 'select sent_at from activity_ready_notifications where route_id = ?', args: [routeC.id] })).rows[0];
  check('4b. someone else can\'t close it', notHers.status === 200 && stillOpen?.sent_at === null, stillOpen);
  const seen = await call('POST', `/api/routes/${routeC.id}/result-seen`, { token: c.token });
  const apnsBefore = apns.length;
  cron = await call('POST', '/api/tasks/steal-notifications', { useEnv: cronEnv });
  check('4b. seen in the app: no "tu carrera está lista" push', seen.status === 200 && cron.data.activityReady?.sent === 0 && apns.length === apnsBefore, cron.data);
  check('4b. result-seen needs a session', (await call('POST', `/api/routes/${routeC.id}/result-seen`)).status === 401);

  // ---------- 5. Rebuilding the competition map gives the same result ----------
  queued.push({ type: 'rebuild_user_territory', userId: a.id });
  await flush();
  check('5. after reprocessing, still no steal between Ana and Bea',
    (await metricsFromRoute(routeA.id, b.id)).length === 0 && (await metricsFromRoute(routeB.id, a.id)).length === 0);
  check('5. after reprocessing, Carla still took Ana\'s loop', (await metricsFromRoute(routeC.id, a.id)).length === 1);
}

// ---------- 2. Together, the other order ----------
{
  const d = people.dani;
  const e = people.eva;
  const origin = [MADRID[0] + 0.05, MADRID[1]];
  await upload(e, loop(origin), 115, 25);
  const eAreaBefore = await areaOf(e.id);
  const routeE = await upload(e, loop(origin), 80, 25); // Eva uploads first
  const routeD = await upload(d, loop(origin, { offset: 8 }), 78, 24, { timed: false }); // Dani from a watch: no point times
  check('2. Dani steals nothing from Eva', (await metricsFromRoute(routeD.id, e.id)).length === 0);
  check('2. nothing queued for Eva', (await pendingFor(routeD.id, e.id)).length === 0);
  check('2. both runs list each other', (await ranTogetherOf(routeD.id)).includes(e.id) && (await ranTogetherOf(routeE.id)).includes(d.id));
  check('2. Eva keeps her territory', (await areaOf(e.id)) >= eAreaBefore * 0.97);
}

// ---------- 3. Partial: Fran joins Gema for the second half ----------
{
  const f = people.fran;
  const g = people.gema;
  const origin = [MADRID[0] + 0.10, MADRID[1]];
  await upload(f, loop(origin), 115, 25); // Fran's own territory
  const routeG = await upload(g, loop(origin), 80, 25); // Gema runs the whole loop and uploads first
  const before = await metricsFromRoute(routeG.id, f.id);
  check('3. before Fran uploads, Gema takes the whole loop from him', before.length === 1);
  const stolenBefore = Number(before[0]?.area_stolen || 0);
  const fAreaAfterSteal = await areaOf(f.id);
  const routeF = await upload(f, loop(origin, { offset: 8, from: 0.5 }), 67.5, 12.5);
  const after = await metricsFromRoute(routeG.id, f.id);
  const stolenAfter = Number(after[0]?.area_stolen || 0);
  check('3. only the shared area is given back (the steal shrinks, not removed)', after.length === 1 && stolenAfter < stolenBefore * 0.8 && stolenAfter > stolenBefore * 0.2, { stolenBefore, stolenAfter });
  check('3. Fran gets the shared part back', (await areaOf(f.id)) > fAreaAfterSteal + stolenBefore * 0.2, { fAreaAfterSteal, now: await areaOf(f.id) });
  check('3. both runs list each other', (await ranTogetherOf(routeG.id)).includes(f.id) && (await ranTogetherOf(routeF.id)).includes(g.id));
  const pendingG = await pendingFor(routeG.id, f.id);
  check('3. the queued push is reduced to what was really taken', pendingG.length === 1 && Math.abs(Number(pendingG[0].stolen_area) - stolenAfter) < 5, pendingG);
}

// ---------- 6. Same loop 12 minutes apart, with point times: not together ----------
{
  const h = people.hugo;
  const i = people.ines;
  const origin = [MADRID[0] + 0.15, MADRID[1]];
  const routeH = await upload(h, loop(origin), 80, 25);
  const routeI = await upload(i, loop(origin, { offset: 8 }), 68, 25);
  check('6. Inés takes Hugo\'s loop (they ran it separately)', (await metricsFromRoute(routeI.id, h.id)).length === 1);
  check('6. not listed as run together', !(await ranTogetherOf(routeI.id)).includes(h.id) && !(await ranTogetherOf(routeH.id)).includes(i.id));
}

console.log(failures === 0 ? '\nAll ran-together checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
