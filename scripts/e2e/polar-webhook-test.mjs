// End-to-end test of the Polar webhook (instant import), the push diagnostics (GET /api/push/status,
// POST /api/push/test) and the fast mutation endpoints (reactions, rename), against the bundled
// Worker with Polar AccessLink and APNs mocked in-process (no network).
//
//   npx esbuild worker/src/index.ts --bundle --format=esm --platform=node --target=node20 \
//     --outfile=scripts/e2e/.build/worker.mjs --alias:@libsql/client/web=@libsql/client --alias:cloudflare:sockets=./scripts/e2e/cloudflare-sockets-stub.mjs --external:@libsql/client
//   rm -f scripts/e2e/.build/polar.db
//   DATABASE_URL=file:scripts/e2e/.build/polar.db npx drizzle-kit push --force
//   node scripts/e2e/polar-webhook-test.mjs
import { createClient } from '@libsql/client';
import { generateKeyPairSync, createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pendingSignup } from './signup.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const databaseUrl = process.env.E2E_DATABASE_URL || `file:${path.join(here, '.build', 'polar.db')}`;

let failures = 0;
function check(name, condition, extra = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${condition ? '' : ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`}`);
  if (!condition) failures++;
}

// ---------- Mocked Polar AccessLink / APNs ----------

const CLIENT_ID = 'polar-client';
const CLIENT_SECRET = 'polar-secret';
const WEBHOOK_SECRET = 'polar-webhook-key';
const POLAR_USER_ID = 4242;
const ACCESS_TOKEN = 'polar-access-token';
const DAY = 24 * 3600 * 1000;

// A ~2.5 km loop (enough points for territory processing)
const loop = [];
for (let i = 0; i <= 60; i++) {
  const a = (2 * Math.PI * i) / 60;
  loop.push({ latitude: 41.65 + 0.004 * Math.sin(a), longitude: -0.88 + 0.005 * Math.cos(a) });
}
let exercises = [];
const exercise = (id, startMs) => ({
  id,
  start_time: new Date(startMs).toISOString().replace('Z', ''),
  distance: 2600,
  duration: 'PT15M30S',
  sport: 'RUNNING',
  detailed_sport_info: 'RUNNING',
  route: loop,
});

const calls = { list: [], gpx: [], apns: [], webhooks: [], other: [] };
/** host -> { status, reason } answered by the mocked APNs (default 200). */
let apnsAnswer = {};
let polarHooks = [{ id: 'old-hook', events: ['EXERCISE'], url: 'https://old.example/api/polar/webhook' }];

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const headers = new Headers(init.headers || {});
  const method = (init.method || 'GET').toUpperCase();
  if (url.host === 'www.polaraccesslink.com') {
    if (url.pathname.startsWith('/v3/webhooks')) {
      calls.webhooks.push({ method, path: url.pathname, auth: headers.get('authorization'), body: init.body ? JSON.parse(String(init.body)) : null });
      if (headers.get('authorization') !== `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`) {
        return new Response('{"error":"unauthorized"}', { status: 401 });
      }
      if (method === 'GET') return polarHooks.length ? Response.json({ data: polarHooks }) : new Response(null, { status: 204 });
      if (method === 'DELETE') {
        const id = decodeURIComponent(url.pathname.split('/').pop());
        polarHooks = polarHooks.filter((h) => h.id !== id);
        return new Response(null, { status: 204 });
      }
      if (method === 'POST') {
        const body = JSON.parse(String(init.body));
        const hook = { id: 'new-hook', events: body.events, url: body.url, signature_secret_key: 'fresh-signature-key' };
        polarHooks = [{ id: hook.id, events: hook.events, url: hook.url }];
        return Response.json({ data: hook }, { status: 201 });
      }
    }
    if (headers.get('authorization') !== `Bearer ${ACCESS_TOKEN}`) return new Response('{"error":"unauthorized"}', { status: 401 });
    if (url.pathname === '/v3/exercises') {
      calls.list.push(Object.fromEntries(url.searchParams));
      return Response.json(exercises);
    }
    if (/^\/v3\/exercises\/[^/]+\/gpx$/.test(url.pathname)) {
      calls.gpx.push(url.pathname);
      return new Response('not found', { status: 404 });
    }
  }
  if (url.host === 'api.sandbox.push.apple.com' || url.host === 'api.push.apple.com') {
    calls.apns.push({ host: url.host, path: url.pathname, topic: headers.get('apns-topic'), body: JSON.parse(String(init.body)) });
    const answer = apnsAnswer[url.host];
    if (answer && answer.status !== 200) return new Response(JSON.stringify({ reason: answer.reason }), { status: answer.status });
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
const apnsEnv = {
  APNS_KEY_ID: 'TESTKEY123',
  APNS_TEAM_ID: 'TEAM123456',
  APNS_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  APNS_BUNDLE_ID: 'com.jpoves.runnaio',
};
const baseEnv = {
  DATABASE_URL: databaseUrl,
  ENVIRONMENT: 'test',
  UPSTASH_CRON_SECRET: 'e2e-cron-secret',
  FRONTEND_URL: 'http://localhost:5000',
  WORKER_URL: 'https://api.example.test',
  POLAR_CLIENT_ID: CLIENT_ID,
  POLAR_CLIENT_SECRET: CLIENT_SECRET,
  TERRITORY_QUEUE: { send: async (body) => { queued.push(body); } },
};
const env = { ...baseEnv, ...apnsEnv, POLAR_WEBHOOK_SECRET: WEBHOOK_SECRET };
const ctx = { waitUntil: (p) => { pending.push(Promise.resolve(p)); }, passThroughOnException() {} };

async function flush(useEnv = env) {
  while (pending.length) await Promise.allSettled(pending.splice(0));
  while (queued.length) {
    const body = queued.shift();
    await worker.queue({ messages: [{ body, ack() {}, retry() { console.error('queue retry', body.type); } }] }, useEnv);
    while (pending.length) await Promise.allSettled(pending.splice(0));
  }
}

async function call(method, route, { token, body, raw, headers = {}, useEnv = env } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined && raw === undefined) h['Content-Type'] = 'application/json';
  const res = await worker.fetch(new Request(`http://127.0.0.1:8787${route}`, {
    method, headers: h, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
  }), useEnv, ctx);
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

const one = async (sqlText, args = []) => (await db.execute({ sql: sqlText, args })).rows[0];

async function register(username) {
  const r = await call('POST', '/api/auth/register/confirm', { body: await pendingSignup(db, { username }) });
  await flush();
  return { id: r.data.id, token: r.data.token };
}

const sign = (raw, key = WEBHOOK_SECRET) => createHmac('sha256', key).update(raw).digest('hex');
const hook = (payload, { signature, useEnv } = {}) => {
  const raw = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json' };
  if (signature !== null) headers['Polar-Webhook-Signature'] = signature ?? sign(raw);
  return call('POST', '/api/polar/webhook', { raw, headers, useEnv });
};

const stamp = Date.now() % 100000;
const user = await register(`pol${stamp}`);
const friend = await register(`fri${stamp}`);
check('users registered', !!user.token && !!friend.token);
await db.execute({ sql: 'insert into polar_accounts (user_id, polar_user_id, access_token, member_id) values (?, ?, ?, ?)', args: [user.id, POLAR_USER_ID, ACCESS_TOKEN, String(POLAR_USER_ID)] });
const deviceToken = `abcdef${String(stamp).padStart(6, '0')}`.padEnd(64, '0');
const register1 = await call('POST', '/api/push/apns/register', { token: user.token, body: { deviceToken, environment: 'sandbox' } });
check('device registered (sandbox)', register1.status === 200, register1);

// ---------- Polar webhook ----------

const ping = await hook({ event: 'PING', timestamp: new Date().toISOString() }, { signature: 'not-the-key' });
check('PING answered 200 even with an unknown signature', ping.status === 200 && ping.data.received === true, ping);
check('PING fetched nothing from Polar', calls.list.length === 0);

exercises = [exercise('ex-1', Date.now() - 2 * 3600 * 1000)];
const payload = { event: 'EXERCISE', user_id: POLAR_USER_ID, entity_id: 'ex-1', timestamp: new Date().toISOString(), url: 'https://www.polaraccesslink.com/v3/exercises/ex-1' };
const badSig = await hook(payload, { signature: 'deadbeef' });
await flush();
check('EXERCISE with a bad signature: 401', badSig.status === 401, badSig);
const noSig = await hook(payload, { signature: null });
await flush();
check('EXERCISE without signature (secret set): 401', noSig.status === 401, noSig);
check('rejected webhooks fetched nothing', calls.list.length === 0, calls.list);

const unknown = await hook({ ...payload, user_id: 999999 });
await flush();
check('EXERCISE for an unknown Polar user: 200, ignored', unknown.status === 200 && calls.list.length === 0, unknown);

const apnsBefore = calls.apns.length;
const good = await hook(payload);
check('valid EXERCISE answered 200 before importing', good.status === 200 && good.data.received === true && pending.length > 0, { good, pending: pending.length });
const routesBeforeFlush = await one('select count(*) n from routes where user_id = ?', [user.id]);
check('nothing imported before the background task runs', Number(routesBeforeFlush.n) === 0);
await flush();
check('webhook listed the user\'s exercises', calls.list.length === 1, calls.list);
const activity = await one('select * from polar_activities where polar_exercise_id = ?', ['ex-1']);
check('exercise imported and processed with a route', !!activity && activity.processed === 1 && !!activity.route_id && !activity.skip_reason, activity);
const route = activity?.route_id ? await one('select * from routes where id = ?', [activity.route_id]) : null;
check('route created for the user', route?.user_id === user.id && Math.abs(route.distance - 2600) < 1 && route.duration === 930, route);
const feed = route ? await one('select * from feed_events where route_id = ?', [route.id]) : null;
check('feed event created', feed?.user_id === user.id, feed);
const territory = await one('select count(*) n from territories where user_id = ?', [user.id]);
check('territory processed by the queue', Number(territory.n) > 0, territory);
const push = calls.apns.slice(apnsBefore).find((p) => p.body?.type === 'polar_auto_import');
check('APNs push polar_auto_import with routeId', !!push && push.body.data.routeId === route?.id && push.path === `/3/device/${deviceToken}` && push.topic === 'com.jpoves.runnaio', calls.apns.slice(apnsBefore));

const routesAfterFirst = await one('select count(*) n from routes where user_id = ?', [user.id]);
const dup = await hook(payload);
await flush();
const routesAfterDup = await one('select count(*) n from routes where user_id = ?', [user.id]);
check('duplicate EXERCISE: no new route', dup.status === 200 && Number(routesAfterDup.n) === Number(routesAfterFirst.n), { before: routesAfterFirst.n, after: routesAfterDup.n });

// Without POLAR_WEBHOOK_SECRET the webhook still works (unsigned), data always read from Polar
exercises = [...exercises, exercise('ex-2', Date.now() - 26 * 3600 * 1000)];
const unsigned = await hook({ ...payload, entity_id: 'ex-2' }, { signature: null, useEnv: { ...baseEnv, ...apnsEnv } });
await flush();
const activity2 = await one('select * from polar_activities where polar_exercise_id = ?', ['ex-2']);
check('without secret: unsigned EXERCISE imported', unsigned.status === 200 && !!activity2?.route_id, { unsigned, activity2 });

// Cron fallback still works and finds nothing new
await db.execute({ sql: 'update polar_accounts set last_sync_at = ? where user_id = ?', args: [new Date(Date.now() - 3600 * 1000).toISOString(), user.id] });
const cron = await call('POST', '/api/tasks/polar-auto-sync', { headers: { Authorization: 'Bearer e2e-cron-secret' } });
await flush();
check('cron poll still runs (nothing new)', cron.status === 200 && cron.data.syncedUsers === 1 && cron.data.activitiesProcessed === 0, cron.data);

// ---------- Admin: register the webhook with Polar ----------

const regUnauthorized = await call('POST', '/api/admin/polar/webhook/register', { body: {}, useEnv: { ...env, ENVIRONMENT: 'production' } });
check('register without admin secret: 401', regUnauthorized.status === 401, regUnauthorized);
const reg = await call('POST', '/api/admin/polar/webhook/register', { body: {}, headers: { Authorization: 'Bearer e2e-cron-secret' } });
check('register returns the signature key', reg.status === 200 && reg.data.signatureSecretKey === 'fresh-signature-key' && reg.data.webhook.url === 'https://api.example.test/api/polar/webhook' && reg.data.removed.length > 0, reg.data);
const create = calls.webhooks.find((w) => w.method === 'POST');
check('webhook created with EXERCISE event and Basic auth', create?.body?.events?.length === 1 && create.body.events[0] === 'EXERCISE' && create.auth === `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`, create);

// ---------- Reactions / rename (response shapes) ----------

const like = await call('POST', '/api/feed/reactions', { token: friend.token, body: { targetType: 'event', targetId: feed.id, reactionType: 'like' } });
check('like: counts + userReaction', like.status === 200 && like.data.likeCount === 1 && like.data.dislikeCount === 0 && like.data.userReaction === 'like', like.data);
const dislike = await call('POST', '/api/feed/reactions', { token: friend.token, body: { targetType: 'event', targetId: feed.id, reactionType: 'dislike' } });
check('switch to dislike', dislike.data.likeCount === 0 && dislike.data.dislikeCount === 1 && dislike.data.userReaction === 'dislike', dislike.data);
const undo = await call('POST', '/api/feed/reactions', { token: friend.token, body: { targetType: 'event', targetId: feed.id, reactionType: 'dislike' } });
check('toggle off', undo.data.likeCount === 0 && undo.data.dislikeCount === 0 && undo.data.userReaction === null, undo.data);
const like2 = await call('POST', '/api/feed/reactions', { token: friend.token, body: { targetType: 'event', targetId: feed.id, reactionType: 'like' } });
await flush();
check('like again', like2.data.likeCount === 1 && like2.data.userReaction === 'like', like2.data);

const rename = await call('PATCH', `/api/routes/${route.id}/name`, { token: user.token, body: { name: '  Vuelta al parque ' } });
check('rename own route', rename.status === 200 && rename.data.success === true && (await one('select name from routes where id = ?', [route.id])).name === 'Vuelta al parque', rename);
check('rename someone else\'s route: 403', (await call('PATCH', `/api/routes/${route.id}/name`, { token: friend.token, body: { name: 'x' } })).status === 403);
check('rename missing route: 404', (await call('PATCH', '/api/routes/nope/name', { token: user.token, body: { name: 'x' } })).status === 404);

// ---------- Push diagnostics ----------

const status1 = await call('GET', '/api/push/status', { token: user.token });
check('status: configured, one sandbox device', status1.status === 200 && status1.data.apnsConfigured === true && status1.data.devices.length === 1 && status1.data.devices[0].environment === 'sandbox' && !!status1.data.devices[0].registeredAt && status1.data.apnsTopic === 'com.jpoves.runnaio', status1.data);
check('status has no secrets', !JSON.stringify(status1.data).includes('BEGIN PRIVATE KEY') && !JSON.stringify(status1.data).includes(deviceToken), status1.data);
check('status without session: 401', (await call('GET', '/api/push/status')).status === 401);

const statusUnconfigured = await call('GET', '/api/push/status', { token: user.token, useEnv: baseEnv });
check('status without APNs secrets: apnsConfigured false', statusUnconfigured.data.apnsConfigured === false, statusUnconfigured.data);
const testUnconfigured = await call('POST', '/api/push/test', { token: user.token, body: {}, useEnv: baseEnv });
check('test without APNs secrets: 503 ApnsNotConfigured, Spanish reason', testUnconfigured.status === 503 && testUnconfigured.data.reason === 'ApnsNotConfigured' && /no están configuradas en el servidor/.test(testUnconfigured.data.error), testUnconfigured);

const testOk = await call('POST', '/api/push/test', { token: user.token, body: {} });
check('test push delivered', testOk.status === 200 && testOk.data.success === true && testOk.data.delivered === 1, testOk.data);

// Token registered as sandbox but valid in production (e.g. TestFlight build): moved
apnsAnswer = { 'api.sandbox.push.apple.com': { status: 400, reason: 'BadDeviceToken' } };
const testMoved = await call('POST', '/api/push/test', { token: user.token, body: {} });
const status2 = await call('GET', '/api/push/status', { token: user.token });
check('BadDeviceToken on sandbox, OK on production: delivered and moved', testMoved.status === 200 && testMoved.data.results[0].environment === 'production' && status2.data.devices.length === 1 && status2.data.devices[0].environment === 'production', { test: testMoved.data, status: status2.data });

// Server config problem: device kept, error explained and recorded
apnsAnswer = { 'api.push.apple.com': { status: 400, reason: 'TopicDisallowed' } };
const testTopic = await call('POST', '/api/push/test', { token: user.token, body: {} });
check('TopicDisallowed: 502 with reason and APNS_BUNDLE_ID hint', testTopic.status === 502 && testTopic.data.reason === 'TopicDisallowed' && /APNS_BUNDLE_ID/.test(testTopic.data.error), testTopic.data);
const status3 = await call('GET', '/api/push/status', { token: user.token });
check('status shows the last APNs error, device kept', status3.data.lastError === 'TopicDisallowed' && status3.data.devices.length === 1 && status3.data.devices[0].lastError === 'TopicDisallowed', status3.data);
apnsAnswer = { 'api.push.apple.com': { status: 403, reason: 'InvalidProviderToken' } };
const testProvider = await call('POST', '/api/push/test', { token: user.token, body: {} });
check('InvalidProviderToken: explains the APNs key', testProvider.status === 502 && testProvider.data.reason === 'InvalidProviderToken' && /APNS_KEY_ID/.test(testProvider.data.error), testProvider.data);

// Dead token in both environments: removed, explained
apnsAnswer = { 'api.push.apple.com': { status: 400, reason: 'BadDeviceToken' }, 'api.sandbox.push.apple.com': { status: 400, reason: 'BadDeviceToken' } };
const testDead = await call('POST', '/api/push/test', { token: user.token, body: {} });
const status4 = await call('GET', '/api/push/status', { token: user.token });
check('BadDeviceToken everywhere: removed, Spanish reason', testDead.status === 502 && testDead.data.reason === 'BadDeviceToken' && testDead.data.results[0].removed === true && status4.data.devices.length === 0 && status4.data.lastError === 'BadDeviceToken', { test: testDead.data, status: status4.data });
const testNoDevice = await call('POST', '/api/push/test', { token: user.token, body: {} });
check('no device: 404 NoDevice', testNoDevice.status === 404 && testNoDevice.data.reason === 'NoDevice' && /no está registrado/.test(testNoDevice.data.error), testNoDevice.data);

// Re-registering and a successful test clear the error
apnsAnswer = {};
await call('POST', '/api/push/apns/register', { token: user.token, body: { deviceToken, environment: 'production' } });
const testAgain = await call('POST', '/api/push/test', { token: user.token, body: {} });
const status5 = await call('GET', '/api/push/status', { token: user.token });
check('re-registered device works, its error is cleared', testAgain.status === 200 && status5.data.devices.length === 1 && !status5.data.devices[0].lastError, status5.data);

// Logout invalidates the session at once (session cache)
const logout = await call('POST', '/api/auth/logout', { token: friend.token, body: {} });
check('logout then the old token is rejected', logout.status === 200 && (await call('GET', '/api/push/status', { token: friend.token })).status === 401);

check('no unexpected network calls', calls.other.length === 0, calls.other);
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
