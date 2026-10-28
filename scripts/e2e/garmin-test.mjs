// End-to-end test of the Garmin integration against the bundled Worker, with Garmin's servers mocked
// (fetch to connectapi.garmin.com / apis.garmin.com / APNs is answered in-process).
//
//   npx esbuild worker/src/index.ts --bundle --format=esm --platform=node --target=node20 \
//     --outfile=scripts/e2e/.build/worker.mjs --alias:@libsql/client/web=@libsql/client --external:@libsql/client
//   rm -f scripts/e2e/.build/garmin.db
//   DATABASE_URL=file:scripts/e2e/.build/garmin.db npx drizzle-kit push --force
//   node scripts/e2e/garmin-test.mjs
//
// The activities are synthetic Activity API "activityDetails" items: a loop around a few blocks in Madrid.
import { createClient } from '@libsql/client';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const databaseUrl = process.env.E2E_DATABASE_URL || `file:${path.join(here, '.build', 'garmin.db')}`;

let failures = 0;
function check(name, condition, extra = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${condition ? '' : ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`}`);
  if (!condition) failures++;
}

// ---------- Synthetic activities ----------

const DAY = 24 * 3600 * 1000;
const GARMIN_USER = 'd3315b1072421d0dd7c8f6b8e1de4df8';

/** A square loop (~600 m sides) sampled every second at ~3.3 m/s, starting `daysAgo` days ago. */
function activityDetail({ summaryId, activityType = 'RUNNING', daysAgo = 2, samples = true, userId = GARMIN_USER, originLat = 40.4168, originLng = -3.7038 }) {
  const start = Math.floor((Date.now() - daysAgo * DAY) / 1000);
  const side = 600;
  const seconds = Math.round((4 * side) / 3.3);
  const mLat = 1 / 111320;
  const mLng = 1 / (111320 * Math.cos((originLat * Math.PI) / 180));
  const list = [];
  for (let t = 0; t <= seconds; t++) {
    const d = (t * 3.3) % (4 * side);
    const leg = Math.floor(d / side);
    const along = d - leg * side;
    const [x, y] = leg === 0 ? [along, 0] : leg === 1 ? [side, along] : leg === 2 ? [side - along, side] : [0, side - along];
    list.push({
      startTimeInSeconds: start + t,
      latitudeInDegree: originLat + y * mLat,
      longitudeInDegree: originLng + x * mLng,
      elevationInMeters: 650,
      heartRate: 140,
      speedMetersPerSecond: 3.3,
      totalDistanceInMeters: t * 3.3,
      timerDurationInSeconds: t,
      clockDurationInSeconds: t,
      movingDurationInSeconds: t,
    });
  }
  return {
    userId,
    summaryId,
    activityId: Number(summaryId.replace(/\D/g, '')) || 1,
    summary: {
      durationInSeconds: seconds,
      startTimeInSeconds: start,
      startTimeOffsetInSeconds: 3600,
      activityType,
      distanceInMeters: seconds * 3.3,
      deviceName: 'forerunner265',
      activityName: 'Madrid Running',
      manual: false,
    },
    ...(samples ? { samples: list } : {}),
  };
}

const runDetail = activityDetail({ summaryId: '1001-detail' });
const bikeDetail = activityDetail({ summaryId: '1002-detail', activityType: 'ROAD_BIKING', daysAgo: 3 });
const noGpsDetail = activityDetail({ summaryId: '1003-detail', activityType: 'TREADMILL_RUNNING', daysAgo: 1, samples: false });
const oldDetail = activityDetail({ summaryId: '1004-detail', daysAgo: 400 });
const pingDetail = activityDetail({ summaryId: '1005-detail', daysAgo: 1, originLat: 40.43, originLng: -3.69 });

// ---------- Mocked Garmin / APNs ----------

const CLIENT_ID = 'test-garmin-client';
const CLIENT_SECRET = 'test-garmin-secret';
const WEBHOOK_SECRET = 'test-garmin-webhook';

let tokenCounter = 0;
const calls = { token: [], api: [], apns: [], other: [] };
const issuedTokens = new Set();
let lastChallenge = null;
let permissions = ['ACTIVITY_EXPORT', 'HEALTH_EXPORT'];

const b64url = (buffer) => Buffer.from(buffer).toString('base64url');

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const headers = new Headers(init.headers || {});
  const method = (init.method || 'GET').toUpperCase();
  if (url.host === 'connectapi.garmin.com' && url.pathname === '/di-oauth2-service/oauth/token') {
    const params = new URLSearchParams(String(init.body || ''));
    calls.token.push(Object.fromEntries(params));
    if (params.get('client_id') !== CLIENT_ID || params.get('client_secret') !== CLIENT_SECRET) {
      return new Response('{"error":"invalid_client"}', { status: 401 });
    }
    const grant = params.get('grant_type');
    const verifierOk = grant !== 'authorization_code'
      || (lastChallenge !== null && b64url(createHash('sha256').update(params.get('code_verifier') || '').digest()) === lastChallenge);
    if (((grant === 'authorization_code' && params.get('code') === 'good-code' && params.get('redirect_uri')?.endsWith('/api/garmin/callback'))
      || (grant === 'refresh_token' && params.get('refresh_token')?.startsWith('refresh-'))) && verifierOk) {
      tokenCounter++;
      const accessToken = `access-${tokenCounter}`;
      issuedTokens.add(accessToken);
      return Response.json({ access_token: accessToken, expires_in: 86400, token_type: 'bearer', refresh_token: `refresh-${tokenCounter}`, scope: 'PARTNER_READ', jti: 'x', refresh_token_expires_in: 7775998 });
    }
    return new Response('{"error":"invalid_grant"}', { status: 400 });
  }
  if (url.host === 'apis.garmin.com') {
    const token = (headers.get('authorization') || '').replace(/^Bearer /, '');
    calls.api.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), token });
    if (!issuedTokens.has(token)) return new Response('{"error":"unauthorized"}', { status: 401 });
    if (method === 'GET' && url.pathname === '/wellness-api/rest/user/id') return Response.json({ userId: GARMIN_USER });
    if (method === 'GET' && url.pathname === '/wellness-api/rest/user/permissions') return Response.json(permissions);
    if (method === 'DELETE' && url.pathname === '/wellness-api/rest/user/registration') return new Response(null, { status: 204 });
    if (method === 'GET' && url.pathname === '/wellness-api/rest/activityDetails' && url.searchParams.get('token') === 'ping-token') {
      return Response.json([pingDetail]);
    }
    return new Response('not found', { status: 404 });
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
const env = { ...baseEnv, GARMIN_CLIENT_ID: CLIENT_ID, GARMIN_CLIENT_SECRET: CLIENT_SECRET, GARMIN_WEBHOOK_SECRET: WEBHOOK_SECRET };
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

async function register(username) {
  const r = await call('POST', '/api/users', { body: { username, name: username, email: `${username}@e2e.test`, password: 'e2e-password', color: '#377EB8', avatar: null } });
  const { verification_code: code } = await one('select verification_code from users where id = ?', [r.data.id]);
  await call('POST', '/api/auth/verify-email', { token: r.data.token, body: { code } });
  return { id: r.data.id, token: r.data.token };
}

async function connect(who) {
  const res = await call('GET', '/api/garmin/connect?client=ios', { token: who.token });
  const authUrl = new URL(res.data.authUrl);
  lastChallenge = authUrl.searchParams.get('code_challenge');
  return { res, authUrl, state: authUrl.searchParams.get('state') };
}

const webhook = (body, key = WEBHOOK_SECRET) => call('POST', `/api/garmin/webhook${key ? `?key=${key}` : ''}`, { body });

const stamp = Date.now() % 100000;
const user = await register(`gar${stamp}`);
const other = await register(`oth${stamp}`);
check('users registered', !!user.token && !!other.token);
await db.execute({ sql: 'insert into push_subscriptions (user_id, endpoint, p256dh, auth) values (?, ?, ?, ?)', args: [user.id, `apns:sandbox:device${stamp}`, 'apns', 'apns'] });

// Not configured
const unconfigured = await call('GET', `/api/garmin/status/${user.id}`, { token: user.token, useEnv: baseEnv });
check('status without secrets: configured false', unconfigured.status === 200 && unconfigured.data.configured === false && unconfigured.data.connected === false, unconfigured.data);
check('connect without secrets: 400', (await call('GET', '/api/garmin/connect', { token: user.token, useEnv: baseEnv })).status === 400);

// Connect (OAuth2 PKCE)
const status0 = await call('GET', `/api/garmin/status/${user.id}`, { token: user.token });
check('status configured, not connected', status0.data.configured === true && status0.data.connected === false, status0.data);
check('status of another user: 403', (await call('GET', `/api/garmin/status/${other.id}`, { token: user.token })).status === 403);
check('connect without session: 401', (await call('GET', '/api/garmin/connect')).status === 401);
const { res: connectRes, authUrl, state } = await connect(user);
check('connect returns Garmin consent URL with PKCE', authUrl.origin + authUrl.pathname === 'https://connect.garmin.com/oauth2Confirm'
  && authUrl.searchParams.get('response_type') === 'code'
  && authUrl.searchParams.get('client_id') === CLIENT_ID
  && authUrl.searchParams.get('code_challenge_method') === 'S256'
  && /^[A-Za-z0-9_-]{43}$/.test(authUrl.searchParams.get('code_challenge') || '')
  && authUrl.searchParams.get('redirect_uri') === 'http://127.0.0.1:8787/api/garmin/callback'
  && !!state && connectRes.data.url === connectRes.data.authUrl, connectRes.data);

const forged = await call('GET', `/api/garmin/callback?code=good-code&state=${encodeURIComponent(state.slice(0, -2) + 'xx')}`);
check('callback with forged state: invalid_state', forged.status === 302 && forged.location.includes('garmin_error=invalid_state'), forged.location);
const denied = await call('GET', `/api/garmin/callback?error=access_denied&state=${encodeURIComponent(state)}`);
check('callback denied (app flow): runnaio://oauth/garmin?garmin_error=denied', denied.location === 'runnaio://oauth/garmin?garmin_error=denied', denied.location);
const badCode = await call('GET', `/api/garmin/callback?code=bad-code&state=${encodeURIComponent(state)}`);
check('callback with rejected code: token_exchange', badCode.location?.includes('garmin_error=token_exchange'), badCode.location);
const callback = await call('GET', `/api/garmin/callback?code=good-code&state=${encodeURIComponent(state)}`);
check('callback success redirects to the app', callback.status === 302 && callback.location === 'runnaio://oauth/garmin?garmin_connected=true', callback);
const tokenCall = calls.token.at(-1);
check('token exchange sent code_verifier matching the challenge', tokenCall.grant_type === 'authorization_code' && /^[A-Za-z0-9_-]{43}$/.test(tokenCall.code_verifier)
  && !JSON.stringify(connectRes.data).includes(tokenCall.code_verifier), tokenCall);
const account = await one('select * from garmin_accounts where user_id = ?', [user.id]);
check('account stored with the Garmin user ID', account?.garmin_user_id === GARMIN_USER && account.access_token === 'access-1' && account.refresh_token === 'refresh-1'
  && Date.parse(account.expires_at) > Date.now() + 23 * 3600 * 1000 && JSON.parse(account.permissions).includes('ACTIVITY_EXPORT'), account);

// Same Garmin account from another Runna.io user
const { state: otherState } = await connect(other);
const linked = await call('GET', `/api/garmin/callback?code=good-code&state=${encodeURIComponent(otherState)}`);
check('second user with the same Garmin account: already_linked', linked.location === 'runnaio://oauth/garmin?garmin_error=already_linked', linked.location);

const status1 = await call('GET', `/api/garmin/status/${user.id}`, { token: user.token });
check('status connected', status1.data.connected === true && status1.data.activityExport === true && status1.data.totalActivities === 0, status1.data);

// Webhook
const noKey = await webhook({ activityDetails: [runDetail] }, null);
const wrongKey = await webhook({ activityDetails: [runDetail] }, 'nope');
await flush();
check('webhook without / with wrong key: 401, nothing stored', noKey.status === 401 && wrongKey.status === 401
  && Number((await one('select count(*) n from garmin_activities')).n) === 0, { noKey, wrongKey });
const unknownUser = await webhook({ activityDetails: [activityDetail({ summaryId: '9999-detail', userId: 'someone-else' })] });
await flush();
check('webhook for unknown Garmin user: 200, ignored', unknownUser.status === 200 && Number((await one('select count(*) n from garmin_activities')).n) === 0, unknownUser);

const hook = await webhook({ activityDetails: [runDetail, bikeDetail, noGpsDetail, oldDetail] });
check('webhook answers 200 at once', hook.status === 200 && hook.data.received === true, hook);
await flush();
const runActivity = await one('select * from garmin_activities where summary_id = ?', ['1001-detail']);
check('run imported with a route', runActivity?.status === 'imported' && !!runActivity.route_id && runActivity.skip_reason === null && runActivity.device_name === 'forerunner265', runActivity);
const runRoute = runActivity?.route_id ? await one('select * from routes where id = ?', [runActivity.route_id]) : null;
const runCoords = runRoute ? JSON.parse(runRoute.coordinates) : [];
check('route has the GPS track', runCoords.length > 100 && Math.abs(runCoords[0][0] - 40.4168) < 0.001 && Math.abs(runCoords[0][1] + 3.7038) < 0.001, { n: runCoords.length, first: runCoords[0] });
check('route distance/duration/start from the summary', runRoute && Math.abs(runRoute.distance - runDetail.summary.distanceInMeters) < 1
  && runRoute.duration === runDetail.summary.durationInSeconds && Date.parse(runRoute.started_at) === runDetail.summary.startTimeInSeconds * 1000, runRoute);
check('route name', runRoute?.name === `Carrera Garmin (${(runDetail.summary.distanceInMeters / 1000).toFixed(2)}km)`, runRoute?.name);
check('feed event created', !!(runRoute && await one('select * from feed_events where route_id = ?', [runRoute.id])));
check('territory processed by the queue', Number((await one('select count(*) n from territories where user_id = ?', [user.id])).n) > 0);
const push = calls.apns.find((p) => p.body?.type === 'garmin_auto_import');
check('APNs push garmin_auto_import with routeId', !!push && push.body.data.routeId === runRoute?.id, calls.apns);
const skipped = async (id) => (await one('select skip_reason from garmin_activities where summary_id = ?', [id]))?.skip_reason;
check('bike skipped as excluded_type', await skipped('1002-detail') === 'excluded_type');
check('treadmill skipped as excluded_type', await skipped('1003-detail') === 'excluded_type');
check('old run skipped as before_competition', await skipped('1004-detail') === 'before_competition');

const again = await webhook({ activityDetails: [runDetail] });
await flush();
check('repeated push does not duplicate', again.status === 200 && Number((await one('select count(*) n from routes where user_id = ?', [user.id])).n) === 1);

// Ping (callbackURL): pulled with the user's token, only from apis.garmin.com
const evil = await webhook({ activityDetails: [{ userId: GARMIN_USER, callbackURL: 'https://evil.example/steal?token=ping-token' }] });
await flush();
check('ping to another host is not followed', evil.status === 200 && calls.other.length === 0, calls.other);
await webhook({ activityDetails: [{ userId: GARMIN_USER, callbackURL: 'https://apis.garmin.com/wellness-api/rest/activityDetails?uploadStartTimeInSeconds=1&uploadEndTimeInSeconds=2&token=ping-token' }] });
await flush();
const pulled = await one('select * from garmin_activities where summary_id = ?', ['1005-detail']);
check('ping pulled and imported', pulled?.status === 'imported' && !!pulled.route_id && calls.api.some((c) => c.path === '/wellness-api/rest/activityDetails' && c.token === 'access-1'), pulled);

// Activities list / retry / delete
const list = await call('GET', `/api/garmin/activities/${user.id}`, { token: user.token });
check('activities list', list.status === 200 && list.data.length === 5 && list.data.every((a) => typeof a.summaryId === 'string'), list.data.length);
const bikeRow = list.data.find((a) => a.summaryId === '1002-detail');
const retryBike = await call('POST', `/api/garmin/retry/${bikeRow.id}`, { token: user.token, body: {} });
check('retry keeps a bike ride skipped', retryBike.status === 200 && retryBike.data.status === 'skipped' && await skipped('1002-detail') === 'excluded_type', retryBike.data);
check('retry of another user activity: 404', (await call('POST', `/api/garmin/retry/${bikeRow.id}`, { token: other.token, body: {} })).status === 404);
const sync = await call('POST', `/api/garmin/sync/${user.id}`, { token: user.token, body: {} });
check('sync answers without pulling', sync.status === 200 && sync.data.hasMore === false && typeof sync.data.message === 'string', sync.data);

const del = await call('DELETE', `/api/garmin/activities/${user.id}/${runActivity.id}`, { token: user.token });
check('delete imported activity removes the route, keeps it as deleted_by_user', del.status === 200 && !(await one('select id from routes where id = ?', [runRoute.id]))
  && await skipped('1001-detail') === 'deleted_by_user', del);
await webhook({ activityDetails: [runDetail] });
await flush();
check('a deleted activity is not imported again by a new push', await skipped('1001-detail') === 'deleted_by_user');
const runRetry = await call('POST', `/api/garmin/retry/${runActivity.id}`, { token: user.token, body: {} });
const processed = await call('POST', `/api/garmin/process/${user.id}`, { token: user.token, body: {} });
await flush();
check('"Reintentar" brings a deleted run back', runRetry.data.status === 'pending' && processed.data.processed === 1, { runRetry: runRetry.data, processed: processed.data });

// Permissions change + deregistration
await webhook({ userPermissionsChange: [{ userId: GARMIN_USER, summaryId: 'x', permissions: ['HEALTH_EXPORT'], changeTimeInSeconds: 1 }] });
await flush();
check('permission change stored (activityExport false)', (await call('GET', `/api/garmin/status/${user.id}`, { token: user.token })).data.activityExport === false);
await webhook({ deregistrations: [{ userId: GARMIN_USER }] });
await flush();
check('deregistration removes the account', !(await one('select id from garmin_accounts where user_id = ?', [user.id])));

// Disconnect calls DELETE user/registration
const { state: state2 } = await connect(user);
await call('GET', `/api/garmin/callback?code=good-code&state=${encodeURIComponent(state2)}`);
check('disconnect another user without account: 404', (await call('POST', '/api/garmin/disconnect', { token: other.token, body: {} })).status === 404);
const deletesBefore = calls.api.filter((c) => c.method === 'DELETE').length;
const disconnect = await call('POST', '/api/garmin/disconnect', { token: user.token, body: {} });
check('disconnect deletes the Garmin registration and our rows', disconnect.status === 200 && calls.api.filter((c) => c.method === 'DELETE').length === deletesBefore + 1
  && !(await one('select id from garmin_accounts where user_id = ?', [user.id])), disconnect.data);
check('routes stay after disconnect', Number((await one('select count(*) n from routes where user_id = ?', [user.id])).n) >= 1);

// Connecting without the Activities permission
permissions = ['HEALTH_EXPORT'];
const { state: state3 } = await connect(user);
const noPerm = await call('GET', `/api/garmin/callback?code=good-code&state=${encodeURIComponent(state3)}`);
check('consent without Activities: no_activity_permission', noPerm.location === 'runnaio://oauth/garmin?garmin_error=no_activity_permission', noPerm.location);
permissions = ['ACTIVITY_EXPORT'];

// Account deletion deletes the Garmin registration too
const deletesBeforeUser = calls.api.filter((c) => c.method === 'DELETE').length;
const delUser = await call('DELETE', `/api/users/${user.id}`, { token: user.token });
const leftAfterDelete = await one('select (select count(*) from garmin_accounts where user_id = ?) a, (select count(*) from garmin_activities where user_id = ?) b', [user.id, user.id]);
check('account deletion removes Garmin rows and the registration', delUser.status === 200 && Number(leftAfterDelete.a) === 0 && Number(leftAfterDelete.b) === 0
  && calls.api.filter((c) => c.method === 'DELETE').length === deletesBeforeUser + 1, { delUser: delUser.data, leftAfterDelete });

check('no unexpected network calls', calls.other.length === 0, calls.other);
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
