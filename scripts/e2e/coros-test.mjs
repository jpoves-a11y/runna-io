// End-to-end test of the COROS integration against the bundled Worker, with COROS's servers mocked
// (fetch to open.coros.com / the FIT file host / APNs is answered in-process).
//
//   npx esbuild worker/src/index.ts --bundle --format=esm --platform=node --target=node20 \
//     --outfile=scripts/e2e/.build/worker.mjs --alias:@libsql/client/web=@libsql/client --alias:cloudflare:sockets=./scripts/e2e/cloudflare-sockets-stub.mjs --external:@libsql/client
//   rm -f scripts/e2e/.build/coros.db
//   DATABASE_URL=file:scripts/e2e/.build/coros.db npx drizzle-kit push --force
//   node scripts/e2e/coros-test.mjs
//
// The workouts are synthetic FIT files built here: a loop around a few blocks in Madrid.
import { createClient } from '@libsql/client';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pendingSignup } from './signup.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const databaseUrl = process.env.E2E_DATABASE_URL || `file:${path.join(here, '.build', 'coros.db')}`;

let failures = 0;
function check(name, condition, extra = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${condition ? '' : ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`}`);
  if (!condition) failures++;
}

// ---------- Synthetic FIT files ----------

const DAY = 24 * 3600 * 1000;
const FIT_EPOCH_S = 631065600;
const COROS_OPEN_ID = 'f5c1a7d0e2b34c4f9a1e7b6c5d4e3f21';
const FIT_HOST = 'https://oss.coros.com';

class Writer {
  bytes = [];
  u8(v) { this.bytes.push(v & 0xff); }
  u16(v) { this.bytes.push(v & 0xff, (v >> 8) & 0xff); }
  u32(v) { this.bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff); }
  i32(v) { this.u32(v >>> 0); }
}

const toSemicircles = (deg) => Math.round((deg * 2 ** 31) / 180);

/**
 * A FIT activity: a square loop (~600 m sides) at ~3.3 m/s, one record every 5 s, starting `daysAgo` days ago.
 * sport/subSport go in the session (FIT enums: 1/2 street run, 1/1 treadmill, 2 cycling, 0 generic).
 */
function workout({ labelId, daysAgo = 2, sport = 1, subSport = 2, gps = true, mode = 8, subMode = 1, originLat = 40.4168, originLng = -3.7038 }) {
  const startMs = Math.floor((Date.now() - daysAgo * DAY) / 1000) * 1000;
  const start = startMs / 1000 - FIT_EPOCH_S;
  const side = 600;
  const seconds = Math.round((4 * side) / 3.3);
  const mLat = 1 / 111320;
  const mLng = 1 / (111320 * Math.cos((originLat * Math.PI) / 180));
  const body = new Writer();
  // Definition local 0: record (20): timestamp, position_lat, position_long, distance
  body.u8(0x40); body.u8(0); body.u8(0); body.u16(20); body.u8(4);
  body.u8(253); body.u8(4); body.u8(0x86);
  body.u8(0); body.u8(4); body.u8(0x85);
  body.u8(1); body.u8(4); body.u8(0x85);
  body.u8(5); body.u8(4); body.u8(0x86);
  for (let t = 0; t <= seconds; t += 5) {
    const d = (t * 3.3) % (4 * side);
    const leg = Math.floor(d / side);
    const along = d - leg * side;
    const [x, y] = leg === 0 ? [along, 0] : leg === 1 ? [side, along] : leg === 2 ? [side - along, side] : [0, side - along];
    body.u8(0);
    body.u32(start + t);
    body.i32(gps ? toSemicircles(originLat + y * mLat) : 0x7fffffff);
    body.i32(gps ? toSemicircles(originLng + x * mLng) : 0x7fffffff);
    body.u32(Math.round(t * 3.3 * 100));
  }
  // Definition local 1: session (18): timestamp, start_time, sport, sub_sport, elapsed, timer, distance
  body.u8(0x41); body.u8(0); body.u8(0); body.u16(18); body.u8(7);
  body.u8(253); body.u8(4); body.u8(0x86);
  body.u8(2); body.u8(4); body.u8(0x86);
  body.u8(5); body.u8(1); body.u8(0x00);
  body.u8(6); body.u8(1); body.u8(0x00);
  body.u8(7); body.u8(4); body.u8(0x86);
  body.u8(8); body.u8(4); body.u8(0x86);
  body.u8(9); body.u8(4); body.u8(0x86);
  body.u8(1); body.u32(start + seconds); body.u32(start); body.u8(sport); body.u8(subSport);
  body.u32(seconds * 1000); body.u32(seconds * 1000); body.u32(Math.round(seconds * 3.3 * 100));

  const header = new Writer();
  header.u8(14); header.u8(0x20); header.u16(2132); header.u32(body.bytes.length);
  for (const ch of '.FIT') header.u8(ch.charCodeAt(0));
  header.u16(0);
  const fit = new Uint8Array([...header.bytes, ...body.bytes, 0, 0]);

  // What COROS's list / push gives for it
  const summary = {
    openId: COROS_OPEN_ID,
    labelId,
    mode,
    subMode,
    startTime: startMs / 1000,
    endTime: startMs / 1000 + seconds,
    startTimezone: 8,
    endTimezone: 8,
    distance: Math.round(seconds * 3.3 * 100) / 100,
    totalTime: seconds,
    deviceName: 'COROS PACE 3',
    fitUrl: `${FIT_HOST}/fit/${labelId}.fit`,
  };
  return { labelId, startMs, seconds, fit, summary, originLat, originLng };
}

const run = workout({ labelId: '466217331458703360' });
const bike = workout({ labelId: '466217331458703361', sport: 2, subSport: 0, mode: 9, daysAgo: 3 });
const treadmill = workout({ labelId: '466217331458703362', subSport: 1, gps: false, mode: 8, subMode: 2, daysAgo: 1 });
const old = workout({ labelId: '466217331458703363', daysAgo: 400 });
// FIT without a sport: decided by the COROS mode (31 walk)
const walk = workout({ labelId: '466217331458703364', sport: 0, subSport: 0, mode: 31, daysAgo: 5, originLat: 40.43, originLng: -3.69 });
const all = [run, bike, treadmill, old, walk];
/** Workouts COROS lists for the account (the walk only shows up in the list, never in a push). */
const listed = [run, bike, treadmill, walk];

// ---------- Mocked COROS / APNs ----------

const CLIENT_ID = 'test-coros-client';
const CLIENT_SECRET = 'test-coros-secret';
const WEBHOOK_SECRET = 'test-coros-webhook';

let tokenCounter = 0;
const calls = { token: [], refresh: [], deauthorize: [], list: [], fit: [], apns: [], other: [] };
const issuedTokens = new Set();

const yyyymmdd = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = (init.method || 'GET').toUpperCase();
  if (url.host === 'open.coros.com') {
    if (method === 'POST' && url.pathname === '/oauth2/accesstoken') {
      const params = new URLSearchParams(String(init.body || ''));
      calls.token.push(Object.fromEntries(params));
      if (params.get('client_id') !== CLIENT_ID || params.get('client_secret') !== CLIENT_SECRET) {
        return Response.json({ result: '5002', message: 'client invalid' });
      }
      if (params.get('grant_type') === 'authorization_code' && params.get('code') === 'good-code' && params.get('redirect_uri')?.endsWith('/api/coros/callback')) {
        tokenCounter++;
        const accessToken = `access-${tokenCounter}`;
        issuedTokens.add(accessToken);
        return Response.json({ expires_in: 2592000, refresh_token: `refresh-${tokenCounter}`, access_token: accessToken, openId: COROS_OPEN_ID });
      }
      return Response.json({ result: '5003', message: 'code invalid' });
    }
    if (method === 'POST' && url.pathname === '/oauth2/refresh-token') {
      const params = new URLSearchParams(String(init.body || ''));
      calls.refresh.push(Object.fromEntries(params));
      const ok = params.get('client_secret') === CLIENT_SECRET && params.get('refresh_token')?.startsWith('refresh-');
      return Response.json(ok ? { result: '0000', message: 'OK' } : { result: '5004', message: 'refresh invalid' });
    }
    if (method === 'POST' && url.pathname === '/oauth2/deauthorize') {
      calls.deauthorize.push(url.searchParams.get('token'));
      return Response.json({ result: '0000', message: 'OK' });
    }
    if (method === 'GET' && url.pathname === '/v2/coros/sport/list') {
      const q = Object.fromEntries(url.searchParams);
      calls.list.push(q);
      if (!issuedTokens.has(q.token) || q.openId !== COROS_OPEN_ID) return Response.json({ result: '5001', message: 'token invalid' });
      const days = (Date.parse(`${q.endDate.slice(0, 4)}-${q.endDate.slice(4, 6)}-${q.endDate.slice(6)}`) - Date.parse(`${q.startDate.slice(0, 4)}-${q.startDate.slice(4, 6)}-${q.startDate.slice(6)}`)) / DAY + 1;
      if (days > 30) return Response.json({ result: '1019', message: 'date range over 30 days' });
      const data = listed
        .filter((w) => yyyymmdd(w.startMs) >= q.startDate && yyyymmdd(w.startMs) <= q.endDate)
        .map(({ summary }) => { const { openId, ...item } = summary; return item; });
      return Response.json({ result: '0000', message: 'OK', data });
    }
    calls.other.push(String(url));
    return new Response('not found', { status: 404 });
  }
  if (url.origin === FIT_HOST && url.pathname.startsWith('/fit/')) {
    const labelId = url.pathname.slice('/fit/'.length).replace(/\.fit$/, '');
    calls.fit.push(labelId);
    const w = all.find((x) => x.labelId === labelId);
    return w ? new Response(w.fit, { status: 200 }) : new Response('not found', { status: 404 });
  }
  if (url.host === 'api.sandbox.push.apple.com' || url.host === 'api.push.apple.com') {
    calls.apns.push({ path: url.pathname, body: JSON.parse(String(init.body)) });
    return new Response('', { status: 200 });
  }
  calls.other.push(String(url));
  throw new Error(`unexpected network call in test: ${url}`);
};

// ---------- Worker ----------

const worker = (await import('./.build/worker.mjs')).default;
const db = createClient({ url: databaseUrl });
const queued = [];
const pending = [];
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const baseEnv = {
  DATABASE_URL: databaseUrl,
  ENVIRONMENT: 'test',
  UPSTASH_CRON_SECRET: 'e2e-cron-secret',
  FRONTEND_URL: 'http://localhost:5000',
  WORKER_URL: 'http://127.0.0.1:8787',
  APNS_KEY_ID: 'TESTKEY123',
  APNS_TEAM_ID: 'TEAM123456',
  APNS_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  APNS_BUNDLE_ID: 'io.runna.app',
  TERRITORY_QUEUE: { send: async (body) => { queued.push(body); } },
};
const env = { ...baseEnv, COROS_CLIENT_ID: CLIENT_ID, COROS_CLIENT_SECRET: CLIENT_SECRET, COROS_WEBHOOK_SECRET: WEBHOOK_SECRET };
const ctx = { waitUntil: (p) => { pending.push(Promise.resolve(p)); }, passThroughOnException() {} };

/** Waits for background work, then runs queued territory messages like the queue consumer. */
async function flush() {
  while (pending.length) await Promise.allSettled(pending.splice(0));
  while (queued.length) {
    const body = queued.shift();
    await worker.queue({ messages: [{ body, ack() {}, retry() { console.error('queue retry', body.type); } }] }, env);
  }
}

async function call(method, route, { token, body, headers = {}, useEnv = env } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await worker.fetch(new Request(`http://127.0.0.1:8787${route}`, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual',
  }), useEnv, ctx);
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, location: res.headers.get('location') };
}

const one = async (sqlText, args = []) => (await db.execute({ sql: sqlText, args })).rows[0];
const count = async (sqlText, args = []) => Number((await one(sqlText, args)).n);

async function register(username) {
  const r = await call('POST', '/api/auth/register/confirm', { body: await pendingSignup(db, { username }) });
  return { id: r.data.id, token: r.data.token };
}

async function connectState(who) {
  const res = await call('GET', '/api/coros/connect?client=ios', { token: who.token });
  const authUrl = new URL(res.data.authUrl);
  return { res, authUrl, state: authUrl.searchParams.get('state') };
}

const corosHeaders = { client: CLIENT_ID, secret: CLIENT_SECRET };
const push = (workouts, { key = WEBHOOK_SECRET, headers = corosHeaders } = {}) =>
  call('POST', `/api/coros/webhook${key ? `?key=${key}` : ''}`, { body: { sportDataList: workouts.map((w) => w.summary ?? w) }, headers });

const stamp = Date.now() % 100000;
const user = await register(`cor${stamp}`);
const other = await register(`oth${stamp}`);
check('users registered', !!user.token && !!other.token);
await db.execute({ sql: 'insert into push_subscriptions (user_id, endpoint, p256dh, auth) values (?, ?, ?, ?)', args: [user.id, `apns:sandbox:device${stamp}`, 'apns', 'apns'] });

// Not configured
const unconfigured = await call('GET', `/api/coros/status/${user.id}`, { token: user.token, useEnv: baseEnv });
check('status without secrets: configured false', unconfigured.status === 200 && unconfigured.data.configured === false && unconfigured.data.connected === false, unconfigured.data);
check('connect without secrets: 400', (await call('GET', '/api/coros/connect', { token: user.token, useEnv: baseEnv })).status === 400);

// Connect (OAuth2)
const status0 = await call('GET', `/api/coros/status/${user.id}`, { token: user.token });
check('status configured, not connected', status0.data.configured === true && status0.data.connected === false, status0.data);
check('status of another user: 403', (await call('GET', `/api/coros/status/${other.id}`, { token: user.token })).status === 403);
check('connect without session: 401', (await call('GET', '/api/coros/connect')).status === 401);
const { res: connectRes, authUrl, state } = await connectState(user);
check('connect returns the COROS authorize URL', authUrl.origin + authUrl.pathname === 'https://open.coros.com/oauth2/authorize'
  && authUrl.searchParams.get('response_type') === 'code'
  && authUrl.searchParams.get('client_id') === CLIENT_ID
  && authUrl.searchParams.get('redirect_uri') === 'http://127.0.0.1:8787/api/coros/callback'
  && !!state && connectRes.data.url === connectRes.data.authUrl, connectRes.data);
const testHost = await call('GET', '/api/coros/connect', { token: user.token, useEnv: { ...env, COROS_API_BASE: 'https://opentest.coros.com/' } });
check('COROS_API_BASE switches the host', testHost.data.authUrl?.startsWith('https://opentest.coros.com/oauth2/authorize?'), testHost.data);

const forged = await call('GET', `/api/coros/callback?code=good-code&state=${encodeURIComponent(state.slice(0, -2) + 'xx')}`);
check('callback with forged state: invalid_state', forged.status === 302 && forged.location.includes('coros_error=invalid_state'), forged.location);
const denied = await call('GET', `/api/coros/callback?error=access_denied&state=${encodeURIComponent(state)}`);
check('callback denied (app flow): runnaio://oauth/coros?coros_error=denied', denied.location === 'runnaio://oauth/coros?coros_error=denied', denied.location);
const badCode = await call('GET', `/api/coros/callback?code=bad-code&state=${encodeURIComponent(state)}`);
check('callback with rejected code (result != 0000): token_exchange', badCode.location?.includes('coros_error=token_exchange'), badCode.location);
const callback = await call('GET', `/api/coros/callback?code=good-code&state=${encodeURIComponent(state)}`);
check('callback success redirects to the app', callback.status === 302 && callback.location === 'runnaio://oauth/coros?coros_connected=true', callback);
const account = await one('select * from coros_accounts where user_id = ?', [user.id]);
check('account stored with the COROS openId', account?.coros_open_id === COROS_OPEN_ID && account.access_token === 'access-1' && account.refresh_token === 'refresh-1'
  && Date.parse(account.expires_at) > Date.now() + 29 * DAY && !!account.connected_at, account);

// Same COROS account from another Runna.io user
const { state: otherState } = await connectState(other);
const linked = await call('GET', `/api/coros/callback?code=good-code&state=${encodeURIComponent(otherState)}`);
check('second user with the same COROS account: already_linked', linked.location === 'runnaio://oauth/coros?coros_error=already_linked', linked.location);

const status1 = await call('GET', `/api/coros/status/${user.id}`, { token: user.token });
check('status connected', status1.data.connected === true && status1.data.totalActivities === 0, status1.data);

// Push
const noKey = await push([run], { key: null });
const wrongHeaders = await push([run], { headers: { client: CLIENT_ID, secret: 'nope' } });
await flush();
check('push without key / with wrong secret header: 401, nothing stored', noKey.status === 401 && wrongHeaders.status === 401
  && await count('select count(*) n from coros_activities') === 0, { noKey, wrongHeaders });
const unknown = await push([{ ...run.summary, openId: 'someone-else', labelId: '1' }]);
await flush();
check('push for unknown openId: 0000, ignored', unknown.status === 200 && unknown.data.result === '0000' && await count('select count(*) n from coros_activities') === 0, unknown);

const hook = await push([run, bike, treadmill, old]);
check('push answers {result:"0000"} at once', hook.status === 200 && hook.data.result === '0000', hook);
await flush();
const runActivity = await one('select * from coros_activities where coros_workout_id = ?', [run.labelId]);
check('run imported with a route', runActivity?.status === 'imported' && !!runActivity.route_id && runActivity.skip_reason === null
  && runActivity.device_name === 'COROS PACE 3' && runActivity.coros_mode === 8 && runActivity.activity_type === 'running', runActivity);
const runRoute = runActivity?.route_id ? await one('select * from routes where id = ?', [runActivity.route_id]) : null;
const runCoords = runRoute ? JSON.parse(runRoute.coordinates) : [];
check('route has the GPS track from the FIT file', runCoords.length > 50 && Math.abs(runCoords[0][0] - 40.4168) < 0.001 && Math.abs(runCoords[0][1] + 3.7038) < 0.001, { n: runCoords.length, first: runCoords[0] });
check('route distance/duration/start from the FIT session', runRoute && Math.abs(runRoute.distance - run.seconds * 3.3) < 1
  && runRoute.duration === run.seconds && Date.parse(runRoute.started_at) === run.startMs, runRoute);
check('route name', runRoute?.name === `Carrera COROS (${(run.seconds * 3.3 / 1000).toFixed(2)}km)`, runRoute?.name);
check('feed event created', !!(runRoute && await one('select * from feed_events where route_id = ?', [runRoute.id])));
check('territory processed by the queue', await count('select count(*) n from territories where user_id = ?', [user.id]) > 0);
const apns = calls.apns.find((p) => p.body?.type === 'coros_auto_import');
check('APNs push coros_auto_import with routeId', !!apns && apns.body.data.routeId === runRoute?.id, calls.apns);
const skipped = async (id) => (await one('select skip_reason from coros_activities where coros_workout_id = ?', [id]))?.skip_reason;
check('bike skipped as excluded_type (FIT sport)', await skipped(bike.labelId) === 'excluded_type');
check('treadmill skipped as excluded_type', await skipped(treadmill.labelId) === 'excluded_type');
check('old run skipped as before_competition without downloading', await skipped(old.labelId) === 'before_competition' && !calls.fit.includes(old.labelId));
check('push looked the workouts up in the list API', calls.list.some((q) => q.token === 'access-1' && q.openId === COROS_OPEN_ID));

const fitsBefore = calls.fit.length;
const again = await push([run]);
await flush();
check('repeated push does not duplicate nor download again', again.status === 200 && await count('select count(*) n from routes where user_id = ?', [user.id]) === 1 && calls.fit.length === fitsBefore);

// A push without COROS's headers (key only) never makes us download a URL it carries
const evil = await push([{ ...run.summary, labelId: '999', fitUrl: 'https://evil.example/x.fit' }], { headers: {} });
await flush();
check('unauthenticated push: FIT link not followed', evil.status === 200 && calls.other.length === 0 && !(await one('select id from coros_activities where coros_workout_id = ?', ['999'])), calls.other);

// Sync ("Sincronizar ahora"): pulls the list, the walk only exists there
const sync = await call('POST', `/api/coros/sync/${user.id}`, { token: user.token, body: {} });
check('sync imports the listed walk', sync.status === 200 && sync.data.imported === 1 && sync.data.hasMore === false, sync.data);
check('list range is at most 30 days', calls.list.every((q) => (Date.parse(`${q.endDate.slice(0, 4)}-${q.endDate.slice(4, 6)}-${q.endDate.slice(6)}`) - Date.parse(`${q.startDate.slice(0, 4)}-${q.startDate.slice(4, 6)}-${q.startDate.slice(6)}`)) / DAY + 1 <= 30), calls.list);
const walkRow = await one('select * from coros_activities where coros_workout_id = ?', [walk.labelId]);
check('FIT without sport decided by the COROS mode (31 walk)', walkRow?.status === 'pending' && walkRow.name.startsWith('Caminata COROS'), walkRow);
const processed = await call('POST', `/api/coros/process/${user.id}`, { token: user.token, body: {} });
await flush();
check('process turns it into a route', processed.status === 200 && processed.data.processed === 1 && processed.data.remaining === 0, processed.data);
const resync = await call('POST', `/api/coros/sync/${user.id}`, { token: user.token, body: {} });
check('second sync finds nothing new', resync.data.imported === 0, resync.data);

// Activities list / retry / delete
const list = await call('GET', `/api/coros/activities/${user.id}`, { token: user.token });
check('activities list', list.status === 200 && list.data.length === 5 && list.data.every((a) => typeof a.corosWorkoutId === 'string' && typeof a.processed === 'boolean'), list.data);
const bikeRow = list.data.find((a) => a.corosWorkoutId === bike.labelId);
const retryBike = await call('POST', `/api/coros/retry/${bikeRow.id}`, { token: user.token, body: {} });
check('retry keeps a bike ride skipped', retryBike.status === 200 && retryBike.data.status === 'skipped' && await skipped(bike.labelId) === 'excluded_type', retryBike.data);
check('retry of another user activity: 404', (await call('POST', `/api/coros/retry/${bikeRow.id}`, { token: other.token, body: {} })).status === 404);

const del = await call('DELETE', `/api/coros/activities/${user.id}/${runActivity.id}`, { token: user.token });
check('delete imported workout removes the route, keeps it as deleted_by_user', del.status === 200 && !(await one('select id from routes where id = ?', [runRoute.id]))
  && await skipped(run.labelId) === 'deleted_by_user', del);
await push([run]);
await flush();
check('a deleted workout is not imported again by a new push', await skipped(run.labelId) === 'deleted_by_user');
const runRetry = await call('POST', `/api/coros/retry/${runActivity.id}`, { token: user.token, body: {} });
const reprocessed = await call('POST', `/api/coros/process/${user.id}`, { token: user.token, body: {} });
await flush();
check('"Reintentar" brings a deleted run back', runRetry.data.status === 'pending' && reprocessed.data.processed === 1, { runRetry: runRetry.data, reprocessed: reprocessed.data });

// Token refresh: COROS extends the same token
await db.execute({ sql: 'update coros_accounts set expires_at = ? where user_id = ?', args: [new Date(Date.now() + 3600 * 1000).toISOString(), user.id] });
await call('POST', `/api/coros/sync/${user.id}`, { token: user.token, body: {} });
const refreshed = await one('select * from coros_accounts where user_id = ?', [user.id]);
check('token refreshed before expiry (same token, 30 more days)', calls.refresh.length === 1 && calls.refresh[0].grant_type === 'refresh_token' && calls.refresh[0].refresh_token === 'refresh-1'
  && refreshed.access_token === 'access-1' && Date.parse(refreshed.expires_at) > Date.now() + 29 * DAY, { refresh: calls.refresh, refreshed });

// Cron fallback poll
await db.execute({ sql: 'update coros_accounts set last_sync_at = ? where user_id = ?', args: [new Date(Date.now() - 2 * 3600 * 1000).toISOString(), user.id] });
const cronUnauthorized = await call('POST', '/api/tasks/coros-auto-sync', { useEnv: { ...env, ENVIRONMENT: 'production' } });
const cron = await call('POST', '/api/tasks/coros-auto-sync', { headers: { Authorization: 'Bearer e2e-cron-secret' } });
check('cron poll: needs the cron secret, then polls the account', cronUnauthorized.status === 401 && cron.status === 200 && cron.data.synced === 1, { cronUnauthorized, cron: cron.data });

// Disconnect revokes access on COROS
check('disconnect another user without account: 404', (await call('POST', '/api/coros/disconnect', { token: other.token, body: {} })).status === 404);
const disconnect = await call('POST', '/api/coros/disconnect', { token: user.token, body: {} });
check('disconnect deauthorizes on COROS and removes our rows', disconnect.status === 200 && calls.deauthorize.at(-1) === 'access-1'
  && !(await one('select id from coros_accounts where user_id = ?', [user.id])) && await count('select count(*) n from coros_activities where user_id = ?', [user.id]) === 0, disconnect.data);
check('routes stay after disconnect', await count('select count(*) n from routes where user_id = ?', [user.id]) >= 2);

// Account deletion revokes access too
const { state: state2 } = await connectState(user);
await call('GET', `/api/coros/callback?code=good-code&state=${encodeURIComponent(state2)}`);
const deauthBefore = calls.deauthorize.length;
const delUser = await call('DELETE', `/api/users/${user.id}`, { token: user.token });
check('account deletion removes COROS rows and deauthorizes', delUser.status === 200 && calls.deauthorize.length === deauthBefore + 1
  && !(await one('select id from coros_accounts where user_id = ?', [user.id])), delUser.data);

check('no unexpected network calls', calls.other.length === 0, calls.other);
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
