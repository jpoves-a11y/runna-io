// End-to-end test of the activity screen data (GET /api/routes/:routeId/profile) against the bundled
// Worker: a run uploaded by the iOS app with point times and altitudes, a Strava activity (streams
// fetched when the activity is opened) and a Polar one (GPX), plus the running-only import filter.
//
//   npx esbuild worker/src/index.ts --bundle --format=esm --platform=node --target=node20 \
//     --outfile=scripts/e2e/.build/worker.mjs --alias:@libsql/client/web=@libsql/client --alias:cloudflare:sockets=./scripts/e2e/cloudflare-sockets-stub.mjs --external:@libsql/client
//   rm -f scripts/e2e/.build/profile.db
//   DATABASE_URL=file:scripts/e2e/.build/profile.db npx drizzle-kit push --force
//   node scripts/e2e/activity-profile-test.mjs
import { createClient } from '@libsql/client';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pendingSignup } from './signup.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const databaseUrl = process.env.E2E_DATABASE_URL || `file:${path.join(here, '.build', 'profile.db')}`;

let failures = 0;
function check(name, condition, extra = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${condition ? '' : ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`}`);
  if (!condition) failures++;
}

// ---------- A 6 km run: 2 km flat, 1.5 km up (+90 m), 2.5 km down/flat; a point every 10 m ----------

const START = Date.now() - 60 * 60 * 1000;
const run = [];
{
  let t = 0;
  let ele = 600;
  for (let m = 0; m <= 6000; m += 10) {
    let pace = 300; // 5:00/km
    if (m > 2000 && m <= 3500) { pace = 400; ele += 0.6; }
    else if (m > 3500 && m <= 5000) { pace = 270; ele -= 0.6; }
    run.push({ lat: 40.42 + m / 110574, lng: -3.70, t, ele: ele + (Math.random() - 0.5) * 1.5 });
    t += pace / 100;
  }
}
const runSeconds = Math.round(run[run.length - 1].t);

// ---------- Network: Strava streams and Polar GPX, recorded ----------

const calls = { strava: 0, polar: 0, other: [] };
globalThis.fetch = async (input) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.host === 'www.strava.com' && /\/activities\/\d+\/streams/.test(url.pathname)) {
    calls.strava++;
    return Response.json({
      latlng: { data: run.map((p) => [p.lat, p.lng + 0.1]) },
      time: { data: run.map((p) => Math.round(p.t)) },
      altitude: { data: run.map((p) => p.ele) },
      distance: { data: run.map((_, i) => i * 10) },
    });
  }
  if (url.host === 'www.polaraccesslink.com' && url.pathname.endsWith('/gpx')) {
    calls.polar++;
    const points = run.map((p) => `<trkpt lat="${p.lat}" lon="${p.lng + 0.2}"><ele>${p.ele.toFixed(1)}</ele><time>${new Date(START + p.t * 1000).toISOString()}</time></trkpt>`);
    return new Response(`<?xml version="1.0"?><gpx><trk><trkseg>${points.join('')}</trkseg></trk></gpx>`, { headers: { 'Content-Type': 'application/gpx+xml' } });
  }
  calls.other.push(String(url));
  throw new Error(`unexpected network call in test: ${url}`);
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
async function flush() {
  while (pending.length) await Promise.allSettled(pending.splice(0));
  while (queued.length) {
    const body = queued.shift();
    await worker.queue({ messages: [{ body, ack() {}, retry() {} }] }, env);
  }
}
async function call(method, route, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await worker.fetch(new Request(`http://127.0.0.1:8787${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const stamp = Date.now() % 100000;
async function register(name) {
  const r = await call('POST', '/api/auth/register/confirm', { body: await pendingSignup(db, { username: `${name}${stamp}` }) });
  return { id: r.data.id, token: r.data.token };
}
const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

const user = await register('perf');
const friend = await register('amig');
// Runs are private outside friends and club mates: make them friends
await call('POST', '/api/friends', { token: user.token, body: { friendId: friend.id } });
const [friendRequest] = (await call('GET', `/api/friends/requests/${friend.id}`, { token: friend.token })).data;
await call('POST', `/api/friends/requests/${friendRequest.id}/accept`, { token: friend.token, body: {} });
const stranger = await register('desc');

// ---------- 1. Run recorded in the app ----------
{
  const res = await call('POST', '/api/routes', {
    token: user.token,
    body: {
      userId: user.id,
      name: 'Carrera con cuesta',
      coordinates: run.map((p) => [p.lat, p.lng]),
      distance: 6000,
      duration: runSeconds,
      startedAt: new Date(START).toISOString(),
      completedAt: new Date(START + runSeconds * 1000).toISOString(),
      pointTimes: run.map((p) => Math.round(p.t)),
      altitudes: run.map((p, i) => (i % 50 === 7 ? null : Math.round(p.ele * 10) / 10)),
      clientRunId: crypto.randomUUID(),
    },
  });
  await flush();
  const routeId = res.data.route.id;
  const profile = await call('GET', `/api/routes/${routeId}/profile`, { token: friend.token });
  const p = profile.data;
  check('1. profile available to a friend', profile.status === 200 && p.available === true, profile);
  check('1. not available to a stranger', (await call('GET', `/api/routes/${routeId}/profile`, { token: stranger.token })).status === 403);
  check('1. has pace and elevation', p.hasPace && p.hasElevation, p);
  check('1. 6 km splits', p.splits?.length === 6, p.splits);
  check('1. the climb km is the slowest, the descent the fastest', p.stats?.slowestSplit === 3 && [4, 5].includes(p.stats?.fastestSplit), p.stats);
  check('1. ~+90 m', Math.abs(p.stats?.elevationGain - 90) <= 12, p.stats);
  check('1. one climb of ~90 m', p.climbs?.length === 1 && Math.abs(p.climbs[0].gain - 90) <= 12 && p.climbs[0].startKm >= 1.9 && p.climbs[0].startKm <= 2.2, p.climbs);
  check('1. series for the charts', p.series?.length > 100 && p.series.every((s) => typeof s.d === 'number'));
  check('1. best km faster than average', p.stats?.bestKmPace < p.stats?.avgPace, p.stats);
  console.log(`   avg ${fmt(p.stats.avgPace)}/km, best km ${fmt(p.stats.bestKmPace)} at km ${p.stats.bestKmStartKm}, +${p.stats.elevationGain}/-${p.stats.elevationLoss} m, max grade ${p.stats.maxGrade}%`);
  console.log(`   splits ${p.splits.map((s) => `${s.index}:${fmt(s.pace)} +${s.elevationGain}`).join('  ')}`);
}

// ---------- 2. Strava activity: streams fetched once, when opened ----------
{
  await db.execute({ sql: `insert into strava_accounts (user_id, strava_athlete_id, access_token, refresh_token, expires_at, scope) values (?, ?, ?, ?, ?, ?)`,
    args: [user.id, 900000 + stamp, 'strava-token', 'strava-refresh', new Date(Date.now() + 3600e3).toISOString(), 'activity:read_all'] });
  const route = await db.execute({ sql: `insert into routes (user_id, name, coordinates, distance, duration, started_at, completed_at) values (?, ?, ?, ?, ?, ?, ?) returning id`,
    args: [user.id, 'Strava', JSON.stringify(run.map((p) => [p.lat, p.lng + 0.1])), 6000, runSeconds, new Date(START - 86400e3).toISOString(), new Date(START - 86400e3 + runSeconds * 1000).toISOString()] });
  const routeId = route.rows[0].id;
  await db.execute({ sql: `insert into strava_activities (strava_activity_id, user_id, route_id, name, activity_type, distance, duration, start_date, processed) values (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    args: [12345678, user.id, routeId, 'Strava', 'Run', 6000, runSeconds, new Date(START - 86400e3).toISOString()] });
  const first = await call('GET', `/api/routes/${routeId}/profile`, { token: user.token });
  check('2. Strava: profile from the streams', first.data.available && first.data.hasPace && first.data.hasElevation && first.data.splits.length === 6, first.data);
  const second = await call('GET', `/api/routes/${routeId}/profile`, { token: user.token });
  check('2. Strava: asked once, then cached', second.data.available && calls.strava === 1, calls);
}

// ---------- 3. Polar activity: GPX ----------
{
  await db.execute({ sql: `insert into polar_accounts (user_id, polar_user_id, access_token) values (?, ?, ?)`, args: [user.id, 700000 + stamp, 'polar-token'] });
  const route = await db.execute({ sql: `insert into routes (user_id, name, coordinates, distance, duration, started_at, completed_at) values (?, ?, ?, ?, ?, ?, ?) returning id`,
    args: [user.id, 'Polar', JSON.stringify(run.map((p) => [p.lat, p.lng + 0.2])), 6000, runSeconds, new Date(START).toISOString(), new Date(START + runSeconds * 1000).toISOString()] });
  const routeId = route.rows[0].id;
  await db.execute({ sql: `insert into polar_activities (polar_exercise_id, user_id, route_id, name, activity_type, distance, duration, start_date, processed) values (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    args: [`ex${stamp}`, user.id, routeId, 'Polar', 'RUNNING', 6000, runSeconds, new Date(START).toISOString()] });
  const profile = await call('GET', `/api/routes/${routeId}/profile`, { token: user.token });
  check('3. Polar: profile from the GPX', profile.data.available && profile.data.hasPace && profile.data.hasElevation && calls.polar === 1, profile.data);
}

// ---------- 4. No source and no times: nothing to draw ----------
{
  const route = await db.execute({ sql: `insert into routes (user_id, name, coordinates, distance, duration, started_at, completed_at) values (?, ?, ?, ?, ?, ?, ?) returning id`,
    args: [user.id, 'Vieja', JSON.stringify(run.map((p) => [p.lat, p.lng + 0.3])), 6000, runSeconds, new Date(START).toISOString(), new Date(START + runSeconds * 1000).toISOString()] });
  const profile = await call('GET', `/api/routes/${route.rows[0].id}/profile`, { token: user.token });
  check('4. old route without data: available false', profile.status === 200 && profile.data.available === false, profile.data);
  check('4. unknown route: 404', (await call('GET', '/api/routes/nope/profile', { token: user.token })).status === 404);
}

// ---------- 5. Only runs are imported: older pending walks are closed ----------
{
  for (const [id, type] of [[111, 'Walk'], [112, 'Hike'], [113, 'TrailRun'], [114, 'Ride']]) {
    await db.execute({ sql: `insert into strava_activities (strava_activity_id, user_id, name, activity_type, distance, duration, start_date, processed) values (?, ?, ?, ?, ?, ?, ?, 0)`,
      args: [id * 1000 + stamp, friend.id, type, type, 5000, 1800, new Date().toISOString()] });
  }
  const res = await call('POST', `/api/strava/process/${friend.id}`, { token: friend.token, body: {} });
  const left = (await db.execute({ sql: 'select activity_type, processed from strava_activities where user_id = ? order by activity_type', args: [friend.id] })).rows;
  const byType = Object.fromEntries(left.map((r) => [r.activity_type, Number(r.processed)]));
  check('5. walk, hike and ride are closed without a route', byType.Walk === 1 && byType.Hike === 1 && byType.Ride === 1, { status: res.status, byType });
}

check('no unexpected network calls', calls.other.length === 0, calls.other);
console.log(failures === 0 ? '\nAll activity profile checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
