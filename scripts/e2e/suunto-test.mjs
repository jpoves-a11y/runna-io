// End-to-end test of the Suunto integration against the bundled Worker, with Suunto's servers mocked
// (fetch to cloudapi-oauth.suunto.com / cloudapi.suunto.com / APNs is answered in-process).
//
//   npx esbuild worker/src/index.ts --bundle --format=esm --platform=node --target=node20 \
//     --outfile=scripts/e2e/.build/worker.mjs --alias:@libsql/client/web=@libsql/client --external:@libsql/client
//   rm -f scripts/e2e/.build/suunto.db
//   DATABASE_URL=file:scripts/e2e/.build/suunto.db npx drizzle-kit push --force
//   node scripts/e2e/suunto-test.mjs <dir>/5bd6eb3252ce7b074fc4fa82.fit <dir>/5bd6eaff52ce7b074fc4fa28.fit <dir>/5bd6eb1952ce7b074fc4fa56.fit
//
// FIT files: Suunto's examples (FITexamples.zip from apizone.suunto.com): two runs in Finland and a pool
// swim; some checks expect exactly those files (distance, start point). Their timestamps are moved to the
// last few days so they pass the competition-date filter.
import { createClient } from '@libsql/client';
import { generateKeyPairSync, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const databaseUrl = process.env.E2E_DATABASE_URL || `file:${path.join(here, '.build', 'suunto.db')}`;
const [runFitPath, run2FitPath, swimFitPath] = process.argv.slice(2);
if (!runFitPath || !run2FitPath || !swimFitPath) {
  console.error('usage: node scripts/e2e/suunto-test.mjs <run.fit> <second-run.fit> <swim.fit> (see the header)');
  process.exit(2);
}

let failures = 0;
function check(name, condition, extra = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${condition ? '' : ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`}`);
  if (!condition) failures++;
}

// ---------- FIT time shifting ----------

/** Copy of a FIT file with every timestamp (field 253) and session/lap start_time moved by `offsetS` (multiple of 32). */
function shiftFitTimes(input, offsetS) {
  const bytes = new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerSize = bytes[0];
  const dataSize = view.getUint32(4, true);
  const end = headerSize + dataSize;
  const defs = new Map();
  let pos = headerSize;
  while (pos < end) {
    const header = bytes[pos++];
    if (header & 0x80) {
      const def = defs.get((header >> 5) & 3);
      if (!def) break;
      pos += def.size;
      continue;
    }
    if (header & 0x40) {
      const little = bytes[pos + 1] === 0;
      const globalNum = view.getUint16(pos + 2, little);
      const n = bytes[pos + 4];
      pos += 5;
      const fields = [];
      for (let i = 0; i < n; i++) { fields.push({ num: bytes[pos], size: bytes[pos + 1] }); pos += 3; }
      let devSize = 0;
      if (header & 0x20) { const nd = bytes[pos++]; for (let i = 0; i < nd; i++) { devSize += bytes[pos + 1]; pos += 3; } }
      defs.set(header & 0x0f, { little, globalNum, fields, size: fields.reduce((s, f) => s + f.size, 0) + devSize });
      continue;
    }
    const def = defs.get(header & 0x0f);
    if (!def) break;
    let p = pos;
    for (const field of def.fields) {
      const isTime = field.num === 253 || ((def.globalNum === 18 || def.globalNum === 19) && field.num === 2);
      if (isTime && field.size === 4) {
        const v = view.getUint32(p, def.little);
        if (v !== 0xffffffff) view.setUint32(p, v + offsetS, def.little);
      }
      p += field.size;
    }
    pos += def.size;
  }
  return bytes;
}

const FIT_EPOCH_S = 631065600;
/** Offset (multiple of 32 s) that moves a FIT file's first timestamp to `targetMs`. */
function offsetTo(fit, targetMs) {
  const view = new DataView(fit.buffer, fit.byteOffset, fit.byteLength);
  // file_id.time_created is not reliable; use the first record timestamp found by a quick scan of the parse
  const first = firstTimestamp(fit, view);
  const offset = Math.round((targetMs / 1000 - FIT_EPOCH_S - first) / 32) * 32;
  return offset;
}
function firstTimestamp(bytes, view) {
  const headerSize = bytes[0];
  const end = headerSize + view.getUint32(4, true);
  const defs = new Map();
  let pos = headerSize;
  while (pos < end) {
    const header = bytes[pos++];
    if (header & 0x80) { pos += defs.get((header >> 5) & 3).size; continue; }
    if (header & 0x40) {
      const little = bytes[pos + 1] === 0;
      const globalNum = view.getUint16(pos + 2, little);
      const n = bytes[pos + 4]; pos += 5;
      const fields = [];
      for (let i = 0; i < n; i++) { fields.push({ num: bytes[pos], size: bytes[pos + 1] }); pos += 3; }
      let devSize = 0;
      if (header & 0x20) { const nd = bytes[pos++]; for (let i = 0; i < nd; i++) { devSize += bytes[pos + 1]; pos += 3; } }
      defs.set(header & 0x0f, { little, globalNum, fields, size: fields.reduce((s, f) => s + f.size, 0) + devSize });
      continue;
    }
    const def = defs.get(header & 0x0f);
    let p = pos;
    for (const field of def.fields) {
      if (def.globalNum === 20 && field.num === 253 && field.size === 4) return view.getUint32(p, def.little);
      p += field.size;
    }
    pos += def.size;
  }
  throw new Error('no record timestamp');
}

const DAY = 24 * 3600 * 1000;
const runStart = Date.now() - 2 * DAY;
const run2Start = Date.now() - 4 * DAY;
const swimStart = Date.now() - 3 * DAY;
const rawRun = new Uint8Array(readFileSync(runFitPath));
const runFit = shiftFitTimes(rawRun, offsetTo(rawRun, runStart));
const rawRun2 = run2FitPath ? new Uint8Array(readFileSync(run2FitPath)) : rawRun;
const run2Fit = shiftFitTimes(rawRun2, offsetTo(rawRun2, run2Start));
const swimFit = swimFitPath ? (() => { const raw = new Uint8Array(readFileSync(swimFitPath)); return shiftFitTimes(raw, offsetTo(raw, swimStart)); })() : null;

// ---------- Mocked Suunto / APNs ----------

const CLIENT_ID = 'test-client-id';
const CLIENT_SECRET = 'test-client-secret';
const SUBSCRIPTION_KEY = 'test-subscription-key';
const WEBHOOK_SECRET = 'test-webhook-secret';
const SUUNTO_USER = 'suuntotester';

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const jwtFor = (n) => `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({ user: SUUNTO_USER, exp: Math.floor(Date.now() / 1000) + 86400, n })}.sig${n}`;
let tokenCounter = 0;
const calls = { token: [], list: [], fit: [], apns: [], other: [] };
let currentAccessToken = null;
const issuedTokens = new Set();

const workoutList = () => ({
  error: null,
  payload: [
    { workoutKey: 'wk-run', activityId: 1, startTime: runStart, stopTime: runStart + 2726000, timeOffsetInMinutes: 120, totalDistance: 8706, totalTime: 2726.95 },
    { workoutKey: 'wk-run2', activityId: 1, startTime: run2Start, totalDistance: 28587, totalTime: 8331.77 },
    { workoutKey: 'wk-bike', activityId: 2, startTime: Date.now() - 5 * DAY, totalDistance: 40000, totalTime: 5000 },
    ...(swimFit ? [{ workoutKey: 'wk-swim', activityId: 99, startTime: swimStart, totalDistance: 3275, totalTime: 3830 }] : []),
  ],
  metadata: {},
});

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const headers = new Headers(init.headers || {});
  if (url.host === 'cloudapi-oauth.suunto.com' && url.pathname === '/oauth/token') {
    const params = new URLSearchParams(String(init.body || ''));
    calls.token.push(Object.fromEntries(params));
    if (headers.get('authorization') !== `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`) {
      return new Response('{"error":"invalid_client"}', { status: 401 });
    }
    const grant = params.get('grant_type');
    if ((grant === 'authorization_code' && params.get('code') === 'good-code' && params.get('redirect_uri')?.endsWith('/api/suunto/callback'))
      || (grant === 'refresh_token' && params.get('refresh_token')?.startsWith('refresh-'))) {
      tokenCounter++;
      currentAccessToken = jwtFor(tokenCounter);
      issuedTokens.add(currentAccessToken);
      return Response.json({ access_token: currentAccessToken, token_type: 'bearer', refresh_token: `refresh-${tokenCounter}`, expires_in: 86400, scope: 'workout', user: SUUNTO_USER, jti: 'x' });
    }
    return new Response('{"error":"invalid_grant"}', { status: 400 });
  }
  if (url.host === 'cloudapi.suunto.com') {
    const authOk = issuedTokens.has((headers.get('authorization') || '').replace(/^Bearer /, '')) && headers.get('ocp-apim-subscription-key') === SUBSCRIPTION_KEY;
    if (!authOk) return new Response('{"error":"unauthorized"}', { status: 401 });
    if (url.pathname === '/v2/workouts') {
      calls.list.push(Object.fromEntries(url.searchParams));
      const since = Number(url.searchParams.get('since') || 0);
      const list = workoutList();
      list.payload = list.payload.filter((w) => w.startTime >= since);
      return Response.json(list);
    }
    const fitMatch = url.pathname.match(/^\/v2\/workout\/exportFit\/(.+)$/);
    if (fitMatch) {
      const key = decodeURIComponent(fitMatch[1]);
      calls.fit.push(key);
      // wk-oldfit: the example file with its original (2018) dates; wk-bike: any non-running FIT
      const body = key === 'wk-run' ? runFit : key === 'wk-run2' ? run2Fit : key === 'wk-swim' || key === 'wk-bike' ? swimFit : key === 'wk-oldfit' ? rawRun : null;
      if (!body) return new Response('not found', { status: 404 });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
    }
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
const env = { ...baseEnv, SUUNTO_CLIENT_ID: CLIENT_ID, SUUNTO_CLIENT_SECRET: CLIENT_SECRET, SUUNTO_SUBSCRIPTION_KEY: SUBSCRIPTION_KEY, SUUNTO_WEBHOOK_SECRET: WEBHOOK_SECRET };
const ctx = { waitUntil: (p) => { pending.push(Promise.resolve(p)); }, passThroughOnException() {} };

/** Waits for background work, then runs queued territory messages like the queue consumer. */
async function flush() {
  while (pending.length) await Promise.allSettled(pending.splice(0));
  while (queued.length) {
    const body = queued.shift();
    await worker.queue({ messages: [{ body, ack() {}, retry() { console.error('queue retry', body.type); } }] }, env);
  }
}

async function call(method, route, { token, body, raw, headers = {}, useEnv = env } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined && raw === undefined) h['Content-Type'] = 'application/json';
  const res = await worker.fetch(new Request(`http://127.0.0.1:8787${route}`, {
    method, headers: h, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body), redirect: 'manual',
  }), useEnv, ctx);
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, location: res.headers.get('location') };
}

const one = async (sqlText, args = []) => (await db.execute({ sql: sqlText, args })).rows[0];
const all = async (sqlText, args = []) => (await db.execute({ sql: sqlText, args })).rows;

async function register(username) {
  const r = await call('POST', '/api/users', { body: { username, name: username, email: `${username}@e2e.test`, password: 'e2e-password', color: '#377EB8', avatar: null } });
  const { verification_code: code } = await one('select verification_code from users where id = ?', [r.data.id]);
  await call('POST', '/api/auth/verify-email', { token: r.data.token, body: { code } });
  return { id: r.data.id, token: r.data.token };
}

const stamp = Date.now() % 100000;
const user = await register(`suu${stamp}`);
const other = await register(`oth${stamp}`);
check('users registered', !!user.token && !!other.token);
await db.execute({ sql: 'insert into push_subscriptions (user_id, endpoint, p256dh, auth) values (?, ?, ?, ?)', args: [user.id, `apns:sandbox:device${stamp}`, 'apns', 'apns'] });

// Not configured
const unconfigured = await call('GET', `/api/suunto/status/${user.id}`, { token: user.token, useEnv: baseEnv });
check('status without secrets: configured false', unconfigured.status === 200 && unconfigured.data.configured === false && unconfigured.data.connected === false, unconfigured.data);
const connectUnconfigured = await call('GET', '/api/suunto/connect', { token: user.token, useEnv: baseEnv });
check('connect without secrets: 400', connectUnconfigured.status === 400, connectUnconfigured);

// Status / connect
const status0 = await call('GET', `/api/suunto/status/${user.id}`, { token: user.token });
check('status configured, not connected', status0.data.configured === true && status0.data.connected === false, status0.data);
check('status of another user: 403', (await call('GET', `/api/suunto/status/${other.id}`, { token: user.token })).status === 403);
check('connect without session: 401', (await call('GET', '/api/suunto/connect')).status === 401);
const connect = await call('GET', '/api/suunto/connect?client=ios', { token: user.token });
const authUrl = new URL(connect.data.authUrl);
check('connect returns Suunto authorize URL', authUrl.origin + authUrl.pathname === 'https://cloudapi-oauth.suunto.com/oauth/authorize'
  && authUrl.searchParams.get('response_type') === 'code'
  && authUrl.searchParams.get('client_id') === CLIENT_ID
  && authUrl.searchParams.get('redirect_uri') === 'http://127.0.0.1:8787/api/suunto/callback'
  && !!authUrl.searchParams.get('state') && connect.data.url === connect.data.authUrl, connect.data);
const state = authUrl.searchParams.get('state');

// Callback
const forged = await call('GET', `/api/suunto/callback?code=good-code&state=${encodeURIComponent(state.slice(0, -2) + 'xx')}`);
check('callback with forged state: invalid_state', forged.status === 302 && forged.location.includes('suunto_error=invalid_state'), forged.location);
const denied = await call('GET', `/api/suunto/callback?error=access_denied&state=${encodeURIComponent(state)}`);
check('callback denied (app flow): runnaio://oauth/suunto?suunto_error=denied', denied.location === 'runnaio://oauth/suunto?suunto_error=denied', denied.location);
const badCode = await call('GET', `/api/suunto/callback?code=bad-code&state=${encodeURIComponent(state)}`);
check('callback with rejected code: token_exchange', badCode.location?.includes('suunto_error=token_exchange'), badCode.location);
const callback = await call('GET', `/api/suunto/callback?code=good-code&state=${encodeURIComponent(state)}`);
check('callback success redirects to the app', callback.status === 302 && callback.location === 'runnaio://oauth/suunto?suunto_connected=true', callback);
const account = await one('select * from suunto_accounts where user_id = ?', [user.id]);
check('account stored with Suunto username from the JWT', account?.suunto_username === SUUNTO_USER && account.access_token === currentAccessToken && account.refresh_token === 'refresh-1' && Date.parse(account.expires_at) > Date.now() + 23 * 3600 * 1000, account);
const tokenCall = calls.token.at(-1);
check('token exchange used authorization_code + redirect_uri', tokenCall.grant_type === 'authorization_code' && tokenCall.code === 'good-code' && tokenCall.redirect_uri === 'http://127.0.0.1:8787/api/suunto/callback', tokenCall);

// Same Suunto account from another Runna.io user
const otherConnect = await call('GET', '/api/suunto/connect', { token: other.token });
const otherState = new URL(otherConnect.data.authUrl).searchParams.get('state');
const linked = await call('GET', `/api/suunto/callback?code=good-code&state=${encodeURIComponent(otherState)}`);
check('second user with same Suunto account: already_linked (web flow)', linked.location === 'http://localhost:5000/profile?suunto_error=already_linked', linked.location);

const status1 = await call('GET', `/api/suunto/status/${user.id}`, { token: user.token });
check('status connected', status1.data.connected === true && status1.data.suuntoUsername === SUUNTO_USER && status1.data.totalActivities === 0, status1.data);

// Webhook
const sign = (raw) => createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
const hookBody = JSON.stringify({ username: SUUNTO_USER, workoutid: 'wk-run' });
const badSig = await call('POST', '/api/suunto/webhook', { raw: hookBody, headers: { 'Content-Type': 'application/json', 'X-HMAC-SHA256-Signature': 'deadbeef' } });
check('webhook with bad signature: 401', badSig.status === 401, badSig);
check('bad-signature webhook fetched nothing', calls.fit.length === 0, calls.fit);
const unknown = await call('POST', '/api/suunto/webhook', { raw: JSON.stringify({ username: 'nobody', workoutid: 'wk-run' }), headers: { 'Content-Type': 'application/json' } });
await flush();
check('webhook for unknown username: 200, ignored', unknown.status === 200 && calls.fit.length === 0, unknown);
const hook = await call('POST', '/api/suunto/webhook', { raw: hookBody, headers: { 'Content-Type': 'application/json', 'X-HMAC-SHA256-Signature': sign(hookBody) } });
check('webhook answers 200 at once', hook.status === 200 && hook.data.received === true, hook);
await flush();
check('webhook downloaded the FIT file', calls.fit.includes('wk-run'), calls.fit);
const runActivity = await one('select * from suunto_activities where workout_key = ?', ['wk-run']);
check('workout imported with a route', runActivity?.status === 'imported' && !!runActivity.route_id && runActivity.processed === 1 && runActivity.skip_reason === null, runActivity);
const runRoute = runActivity?.route_id ? await one('select * from routes where id = ?', [runActivity.route_id]) : null;
const runCoords = runRoute ? JSON.parse(runRoute.coordinates) : [];
check('route has the GPS track', runCoords.length > 500 && Math.abs(runCoords[0][0] - 60.27) < 0.2 && Math.abs(runCoords[0][1] - 24.95) < 0.3, { n: runCoords.length, first: runCoords[0] });
check('route distance/duration/start from the FIT session', runRoute && Math.abs(runRoute.distance - 8706) < 1 && Math.abs(runRoute.duration - 2727) <= 1 && Math.abs(Date.parse(runRoute.started_at) - runStart) < 60000, runRoute && { d: runRoute.distance, t: runRoute.duration, s: runRoute.started_at });
check('route name', runRoute?.name === 'Carrera Suunto (8.71km)', runRoute?.name);
const feed = runRoute ? await one('select * from feed_events where route_id = ?', [runRoute.id]) : null;
check('feed event created', !!feed && feed.user_id === user.id, feed);
const territory = await one('select count(*) n from territories where user_id = ?', [user.id]);
check('territory processed by the queue', Number(territory.n) > 0, territory);
const push = calls.apns.find((p) => p.body?.type === 'suunto_auto_import');
check('APNs push suunto_auto_import with routeId', !!push && push.body.data.routeId === runRoute?.id && push.path === `/3/device/device${stamp}`, calls.apns);

// Duplicate notification (form-encoded) does nothing new
const formBody = `username=${SUUNTO_USER}&workoutid=wk-run`;
const hook2 = await call('POST', '/api/suunto/webhook', { raw: formBody, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-HMAC-SHA256-Signature': sign(formBody) } });
await flush();
const routesAfterDup = await one('select count(*) n from routes where user_id = ?', [user.id]);
check('duplicate (form) webhook: no new route, no new FIT download', hook2.status === 200 && Number(routesAfterDup.n) === 1 && calls.fit.filter((k) => k === 'wk-run').length === 1, { routes: routesAfterDup.n, fit: calls.fit });

// Webhook for a workout from before the competition (decided from the FIT file's own dates)
const oldBody = JSON.stringify({ type: 'WORKOUT_CREATED', username: SUUNTO_USER, workout: { workoutKey: 'wk-oldfit' } });
await call('POST', '/api/suunto/webhook', { raw: oldBody, headers: { 'Content-Type': 'application/json', 'X-HMAC-SHA256-Signature': sign(oldBody) } });
await flush();
const oldActivity = await one('select * from suunto_activities where workout_key = ?', ['wk-oldfit']);
check('nested-payload webhook: old workout skipped as before_competition', calls.fit.includes('wk-oldfit') && oldActivity?.skip_reason === 'before_competition' && oldActivity.route_id === null, oldActivity);

// Sync + process (what the app does)
const apnsBeforeSync = calls.apns.length;
const sync = await call('POST', `/api/suunto/sync/${user.id}`, { token: user.token, body: {} });
check('sync: 200 with imported/skipped/hasMore', sync.status === 200 && sync.data.imported === 1 && sync.data.hasMore === false && sync.data.skipped >= 2, sync.data);
const listCall = calls.list.at(-1);
check('sync listed the last 30 days', Math.abs(Number(listCall.since) - (Date.now() - 30 * DAY)) < 60000, listCall);
check('cycling skipped without FIT download', !calls.fit.includes('wk-bike') && (await one('select skip_reason from suunto_activities where workout_key = ?', ['wk-bike']))?.skip_reason === 'excluded_type');
if (swimFit) {
  const swim = await one('select * from suunto_activities where workout_key = ?', ['wk-swim']);
  check('pool swim (unknown activityId) skipped from the FIT sport', calls.fit.includes('wk-swim') && swim?.skip_reason === 'excluded_type' && swim.status === 'skipped', swim);
}
const process1 = await call('POST', `/api/suunto/process/${user.id}`, { token: user.token, body: {} });
check('process: one route created', process1.status === 200 && process1.data.processed === 1 && process1.data.results[0]?.routeId && process1.data.remaining === 0, process1.data);
await flush();
check('sync/process path sends no push (the app shows it itself)', calls.apns.length === apnsBeforeSync, calls.apns.length);
const process2 = await call('POST', `/api/suunto/process/${user.id}`, { token: user.token, body: {} });
check('process with nothing pending', process2.data.processed === 0 && process2.data.remaining === 0, process2.data);
const sync2 = await call('POST', `/api/suunto/sync/${user.id}`, { token: user.token, body: {} });
check('second sync imports nothing', sync2.data.imported === 0 && sync2.data.hasMore === false, sync2.data);

const activities = await call('GET', `/api/suunto/activities/${user.id}`, { token: user.token });
check('activities list', activities.status === 200 && Array.isArray(activities.data) && activities.data.length === (swimFit ? 5 : 4) && activities.data.every((a) => a.workoutKey && a.status), activities.data.map?.((a) => [a.workoutKey, a.status, a.skipReason]));
const status2 = await call('GET', `/api/suunto/status/${user.id}`, { token: user.token });
check('status counts', status2.data.totalActivities === (swimFit ? 5 : 4) && status2.data.pendingActivities === 0 && status2.data.failedActivities === (swimFit ? 3 : 2) && !!status2.data.lastSyncAt, status2.data);

// Token refresh
await db.execute({ sql: 'update suunto_accounts set expires_at = ? where user_id = ?', args: [new Date(Date.now() - 1000).toISOString(), user.id] });
const tokenCallsBefore = calls.token.length;
const sync3 = await call('POST', `/api/suunto/sync/${user.id}`, { token: user.token, body: {} });
const refreshed = await one('select * from suunto_accounts where user_id = ?', [user.id]);
check('expired token is refreshed before the API call', sync3.status === 200 && calls.token.length === tokenCallsBefore + 1 && calls.token.at(-1).grant_type === 'refresh_token' && calls.token.at(-1).refresh_token === 'refresh-1' && refreshed.access_token === currentAccessToken && refreshed.refresh_token === `refresh-${tokenCounter}`, { sync3: sync3.data, token: calls.token.at(-1) });

// Retry a skipped workout (downloads again, still skipped)
const bike = activities.data.find((a) => a.workoutKey === 'wk-bike');
const retry = await call('POST', `/api/suunto/retry/${bike.id}`, { token: user.token, body: {} });
check('retry of an excluded workout: re-evaluated, skipped again', retry.status === 200 && (swimFit ? retry.data.status === 'skipped' : retry.data.status === 'failed'), retry.data);
check('retry of another user\'s activity: 404', (await call('POST', `/api/suunto/retry/${bike.id}`, { token: other.token, body: {} })).status === 404);

// Delete an imported workout: route removed, not re-imported by sync / webhook
const run2 = await one('select * from suunto_activities where workout_key = ?', ['wk-run2']);
const del = await call('DELETE', `/api/suunto/activities/${user.id}/${run2.id}`, { token: user.token });
const run2After = await one('select * from suunto_activities where workout_key = ?', ['wk-run2']);
const run2Route = await one('select count(*) n from routes where id = ?', [run2.route_id]);
check('delete: route gone, workout kept as deleted_by_user', del.status === 200 && Number(run2Route.n) === 0 && run2After.status === 'skipped' && run2After.skip_reason === 'deleted_by_user' && run2After.route_id === null, { del: del.data, run2After });
const sync4 = await call('POST', `/api/suunto/sync/${user.id}`, { token: user.token, body: {} });
check('deleted workout is not re-imported by sync', sync4.data.imported === 0 && (await one('select status from suunto_activities where workout_key = ?', ['wk-run2'])).status === 'skipped', sync4.data);
const retryDeleted = await call('POST', `/api/suunto/retry/${run2.id}`, { token: user.token, body: {} });
const process3 = await call('POST', `/api/suunto/process/${user.id}`, { token: user.token, body: {} });
check('retry brings a deleted workout back', retryDeleted.data.status === 'pending' && process3.data.processed === 1, { retryDeleted: retryDeleted.data, process3: process3.data });
await flush();

// Deleting the route from the activity list (DELETE /api/routes/:id) also marks it deleted
const runRouteId = runActivity.route_id;
const delRoute = await call('DELETE', `/api/routes/${user.id}/${runRouteId}`, { token: user.token });
const runAfterRouteDelete = await one('select * from suunto_activities where workout_key = ?', ['wk-run']);
check('DELETE /api/routes marks the Suunto workout deleted_by_user', delRoute.status === 200 && runAfterRouteDelete.skip_reason === 'deleted_by_user', { delRoute: delRoute.data, runAfterRouteDelete });

// Cron fallback poll
await db.execute({ sql: 'update suunto_accounts set last_sync_at = ? where user_id = ?', args: [new Date(Date.now() - 2 * 3600 * 1000).toISOString(), user.id] });
const cronUnauthorized = await call('POST', '/api/tasks/suunto-auto-sync', { useEnv: { ...env, ENVIRONMENT: 'production' } });
check('cron endpoint closed to the outside', cronUnauthorized.status === 401, cronUnauthorized);
const cron = await call('POST', '/api/tasks/suunto-auto-sync', { headers: { Authorization: 'Bearer e2e-cron-secret' } });
check('cron poll runs', cron.status === 200 && cron.data.success === true && cron.data.synced === 1, cron.data);

// Disconnect
check('disconnect another user without account: 404', (await call('POST', '/api/suunto/disconnect', { token: other.token, body: {} })).status === 404);
const disconnect = await call('POST', '/api/suunto/disconnect', { token: user.token, body: {} });
const left = await one('select (select count(*) from suunto_accounts where user_id = ?) a, (select count(*) from suunto_activities where user_id = ?) b', [user.id, user.id]);
check('disconnect removes account + import records', disconnect.status === 200 && Number(left.a) === 0 && Number(left.b) === 0, { disconnect: disconnect.data, left });
const routesKept = await one('select count(*) n from routes where user_id = ?', [user.id]);
check('routes stay after disconnect', Number(routesKept.n) >= 1, routesKept);
check('status after disconnect', (await call('GET', `/api/suunto/status/${user.id}`, { token: user.token })).data.connected === false);

// Account deletion removes Suunto data
const reconnect = await call('GET', '/api/suunto/connect', { token: user.token });
await call('GET', `/api/suunto/callback?code=good-code&state=${encodeURIComponent(new URL(reconnect.data.authUrl).searchParams.get('state'))}`);
const sync5 = await call('POST', `/api/suunto/sync/${user.id}`, { token: user.token, body: {} });
check('reconnected and synced', sync5.status === 200 && sync5.data.imported >= 1, sync5.data);
const delUser = await call('DELETE', `/api/users/${user.id}`, { token: user.token });
const leftAfterDelete = await one('select (select count(*) from suunto_accounts where user_id = ?) a, (select count(*) from suunto_activities where user_id = ?) b', [user.id, user.id]);
check('account deletion removes Suunto rows', delUser.status === 200 && Number(leftAfterDelete.a) === 0 && Number(leftAfterDelete.b) === 0, { delUser: delUser.data, leftAfterDelete });

check('no unexpected network calls', calls.other.length === 0, calls.other);
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
