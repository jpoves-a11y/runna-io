// End-to-end test of the launch features against the bundled Worker and a SQLite database:
// privacy zone, Sign in with Apple (with test keys), suspension, admin panel (reports, stats),
// analytics events, widget summary, welcome missions, apple-app-site-association.
//
//   npx esbuild worker/src/index.ts --bundle --format=esm --platform=node --target=node20 \
//     --outfile=scripts/e2e/.build/worker.mjs --alias:@libsql/client/web=@libsql/client --alias:cloudflare:sockets=./scripts/e2e/cloudflare-sockets-stub.mjs --external:@libsql/client
//   rm -f scripts/e2e/.build/launch.db
//   DATABASE_URL=file:scripts/e2e/.build/launch.db npx drizzle-kit push --force
//   node scripts/e2e/launch-features-test.mjs
import { createClient } from '@libsql/client';
import { createHash, generateKeyPairSync, webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pendingSignup } from './signup.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const databaseUrl = process.env.E2E_DATABASE_URL || `file:${path.join(here, '.build', 'launch.db')}`;

let failures = 0;
function check(name, condition, extra = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${condition ? '' : ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`}`);
  if (!condition) failures++;
}

// No network: Apple's keys come from APPLE_JWKS_JSON; anything else is a bug
globalThis.fetch = async (input) => {
  throw new Error(`unexpected network call: ${String(input instanceof Request ? input.url : input)}`);
};

// ---------- Test Apple keys ----------
const appleKeys = await webcrypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify'],
);
const appleJwk = await webcrypto.subtle.exportKey('jwk', appleKeys.publicKey);
const b64url = (data) => Buffer.from(data).toString('base64url');
async function appleToken(claims) {
  const head = b64url(JSON.stringify({ alg: 'RS256', kid: 'e2e' }));
  const body = b64url(JSON.stringify({
    iss: 'https://appleid.apple.com', aud: 'com.jpoves.runnaio', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600, ...claims,
  }));
  const signature = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', appleKeys.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(signature))}`;
}
const nonceHash = (raw) => createHash('sha256').update(raw).digest('hex');

// ---------- Test Google keys ----------
const GOOGLE_CLIENT_ID = 'e2e-ios.apps.googleusercontent.com';
const googleKeys = await webcrypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify'],
);
const googleJwk = await webcrypto.subtle.exportKey('jwk', googleKeys.publicKey);
async function googleToken(claims) {
  const head = b64url(JSON.stringify({ alg: 'RS256', kid: 'g-e2e' }));
  const body = b64url(JSON.stringify({
    iss: 'https://accounts.google.com', aud: GOOGLE_CLIENT_ID, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600, ...claims,
  }));
  const signature = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', googleKeys.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(signature))}`;
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
  WORKER_URL: 'http://127.0.0.1:8787',
  APNS_KEY_ID: 'TESTKEY123',
  APNS_TEAM_ID: 'TEAM123456',
  APNS_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  APNS_BUNDLE_ID: 'com.jpoves.runnaio',
  APPLE_JWKS_JSON: JSON.stringify({ keys: [{ ...appleJwk, kid: 'e2e', alg: 'RS256', use: 'sig' }] }),
  GOOGLE_CLIENT_IDS: GOOGLE_CLIENT_ID,
  GOOGLE_JWKS_JSON: JSON.stringify({ keys: [{ ...googleJwk, kid: 'g-e2e', alg: 'RS256', use: 'sig' }] }),
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

async function raw(method, route, { token, body, headers = {}, form, useEnv = env } = {}) {
  const h = { 'cf-connecting-ip': '203.0.113.9', ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (form) {
    h['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(form).toString();
  } else if (body !== undefined) {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await worker.fetch(new Request(`http://127.0.0.1:8787${route}`, { method, headers: h, body: payload, redirect: 'manual' }), useEnv, ctx);
  await flush();
  return res;
}
async function call(method, route, options = {}) {
  const res = await raw(method, route, options);
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}
const rows = async (sqlText, args = []) => (await db.execute({ sql: sqlText, args })).rows;
const one = async (sqlText, args = []) => (await rows(sqlText, args))[0];

const stamp = Date.now() % 100000;
async function register(name) {
  const r = await call('POST', '/api/auth/register/confirm', { body: await pendingSignup(db, { username: `${name}${stamp}` }) });
  return { id: r.data.id, token: r.data.token, name, username: `${name}${stamp}` };
}
async function befriend(a, b) {
  for (const [x, y] of [[a, b], [b, a]]) await db.execute({ sql: 'insert into friendships (user_id, friend_id) values (?, ?)', args: [x.id, y.id] });
}

// A square loop of 4 × 600 m from (and back to) "home", a point every 20 m
const HOME = [41.6488, -0.8891];
const toLatLng = ([lat0, lng0], x, y) => [lat0 + y / 110574, lng0 + x / (Math.cos((lat0 * Math.PI) / 180) * 111320)];
function loopFromHome() {
  const side = 600;
  const corners = [[0, 0], [side, 0], [side, side], [0, side], [0, 0]];
  const points = [];
  for (let c = 0; c < 4; c++) {
    const [x0, y0] = corners[c];
    const [x1, y1] = corners[c + 1];
    for (let d = 0; d < side; d += 20) points.push(toLatLng(HOME, x0 + ((x1 - x0) * d) / side, y0 + ((y1 - y0) * d) / side));
  }
  points.push(HOME);
  return points;
}
const meters = (a, b) => Math.hypot((b[0] - a[0]) * 110574, (b[1] - a[1]) * Math.cos((a[0] * Math.PI) / 180) * 111320);

async function upload(user, coords, minutes = 14) {
  const startedAt = new Date(Date.now() - (minutes + 5) * 60_000);
  const body = {
    userId: user.id,
    name: `Carrera ${user.name}`,
    coordinates: coords,
    distance: 2400,
    duration: minutes * 60,
    startedAt: startedAt.toISOString(),
    completedAt: new Date(startedAt.getTime() + minutes * 60_000).toISOString(),
    clientRunId: crypto.randomUUID(),
    pointTimes: coords.map((_, i) => Math.round((i * minutes * 60) / (coords.length - 1))),
    altitudes: coords.map(() => 200),
  };
  const res = await call('POST', '/api/routes', { token: user.token, body });
  if (res.status !== 200) console.error('upload failed', res.status, res.data);
  return res.data.route ?? res.data;
}

// ---------- 1. Privacy zone ----------
const ana = await register('ana');
const bea = await register('bea');
await befriend(ana, bea);

let res = await call('PATCH', `/api/users/${ana.id}`, { token: ana.token, body: { privacyZone: true } });
check('privacy zone can be turned on', res.status === 200 && res.data.privacyZoneM === 200, res.data);
res = await call('PATCH', `/api/users/${ana.id}`, { token: ana.token, body: { privacyZone: 'yes' } });
check('privacy zone needs a boolean', res.status === 400);

const track = loopFromHome();
const route = await upload(ana, track);
const stored = await one('select coordinates, track_meta from routes where id = ?', [route.id]);
const storedPoints = JSON.parse(stored.coordinates);
check('stored run lost its ends', storedPoints.length < track.length && storedPoints.length > 0, { stored: storedPoints.length, full: track.length });
check('no stored point is within 190 m of home', storedPoints.every((p) => meters(HOME, p) >= 190), storedPoints.map((p) => Math.round(meters(HOME, p))).slice(0, 5));
const ends = await one('select head, tail from route_private_ends where route_id = ?', [route.id]);
check('hidden ends are kept apart', ends && JSON.parse(ends.head).length + JSON.parse(ends.tail).length + storedPoints.length === track.length);
const meta = JSON.parse(stored.track_meta ?? '{}');
check('anti-cheat times stay aligned with the kept points', Array.isArray(meta.t) && meta.t.length === storedPoints.length, meta.t?.length);
const streams = await one('select times, profile from route_streams where route_id = ?', [route.id]);
check('point times stored for the kept points only', streams && JSON.parse(streams.times).length === storedPoints.length);

res = await call('GET', `/api/routes/${ana.id}`, { token: ana.token });
const own = res.data.find((r) => r.id === route.id);
check('the runner sees the whole run', own && own.coordinates.length === track.length && own.privacyHidden?.head > 0, own?.coordinates?.length);
res = await call('GET', `/api/routes/${ana.id}`, { token: bea.token });
const theirs = res.data.find((r) => r.id === route.id);
check('a friend sees the cut run', theirs && theirs.coordinates.length === storedPoints.length && !theirs.privacyHidden);
res = await call('GET', `/api/feed/${bea.id}`, { token: bea.token });
const event = (Array.isArray(res.data) ? res.data : res.data.events ?? []).find((e) => e.routeId === route.id);
const feedPoints = event?.routeCoordinates ?? [];
check('the feed shows no point near home', feedPoints.length > 0 && feedPoints.every((p) => meters(HOME, p) >= 190), feedPoints.length);
const global = await one('select geometry from global_territories where user_id = ?', [ana.id]);
check('the run still makes territory', global && String(global.geometry).length > 20);

res = await call('GET', `/api/users/${ana.id}/stats`, { token: bea.token });
check('others do not see the privacy setting', res.status === 200 && res.data.privacyZoneM === undefined, res.status);

// A run shorter than 400 m is hidden whole
const shortRoute = await upload(ana, track.slice(0, 15), 3);
const shortStored = await one('select coordinates from routes where id = ?', [shortRoute.id]);
check('a run of 400 m or less is hidden whole', JSON.parse(shortStored.coordinates).length === 0);

// Deleting the run removes its hidden ends
res = await call('DELETE', `/api/routes/${ana.id}/${shortRoute.id}`, { token: ana.token });
check('deleted run takes its hidden ends', !(await one('select 1 as x from route_private_ends where route_id = ?', [shortRoute.id])), res.status);

res = await call('GET', '/api/territories/fortifications');
check('fortifications need a session', res.status === 401);
res = await call('GET', '/api/competition/participants');
check('participants need a session', res.status === 401);

// ---------- 2. Sign in with Apple ----------
const rawNonce = 'nonce-e2e-1';
const appleSub = `001.e2e.${stamp}`;
res = await call('POST', '/api/auth/apple', { body: { identityToken: await appleToken({ sub: appleSub, nonce: nonceHash(rawNonce), email: `carla${stamp}@privaterelay.appleid.com`, email_verified: 'true', is_private_email: 'true' }), nonce: rawNonce, name: 'Carla Gómez' } });
check('new Apple user is asked for a profile', res.status === 200 && res.data.needsProfile === true && res.data.suggestedUsername === 'carlagomez', res.data);
res = await call('POST', '/api/auth/apple', { body: { identityToken: await appleToken({ sub: appleSub, nonce: nonceHash(rawNonce), email: `carla${stamp}@privaterelay.appleid.com`, email_verified: 'true', is_private_email: 'true' }), nonce: rawNonce, name: 'Carla Gómez', username: `carla${stamp}` } });
check('terms must be accepted', res.status === 400);
res = await call('POST', '/api/auth/apple', { body: { identityToken: await appleToken({ sub: appleSub, nonce: nonceHash(rawNonce), email: `carla${stamp}@privaterelay.appleid.com`, email_verified: 'true', is_private_email: 'true' }), nonce: rawNonce, name: 'Carla Gómez', username: `carla${stamp}`, acceptedTerms: true } });
check('Apple account is created and signed in', res.status === 200 && typeof res.data.token === 'string' && res.data.created === true, res.data);
check('the Apple ID is not sent to the app', res.data.appleSub === undefined && res.data.appleRefreshToken === undefined);
const carla = { id: res.data.id, token: res.data.token };
res = await call('POST', '/api/auth/apple', { body: { identityToken: await appleToken({ sub: appleSub, nonce: nonceHash('n2') }), nonce: 'n2' } });
check('same Apple ID signs in again', res.status === 200 && res.data.id === carla.id && res.data.token);
res = await call('POST', '/api/auth/apple', { body: { identityToken: await appleToken({ sub: appleSub, nonce: nonceHash('n3') }), nonce: 'other' } });
check('wrong nonce is refused', res.status === 401);
// An existing email account verified by Apple is linked
const anaEmail = `${ana.username}@e2e.test`.toLowerCase();
res = await call('POST', '/api/auth/apple', { body: { identityToken: await appleToken({ sub: `002.e2e.${stamp}`, nonce: nonceHash('n4'), email: anaEmail, email_verified: true }), nonce: 'n4' } });
check('Apple-verified email links the existing account', res.status === 200 && res.data.id === ana.id);
check('the link is stored', (await one('select apple_sub from users where id = ?', [ana.id]))?.apple_sub === `002.e2e.${stamp}`);

// "Ya tengo cuenta": an Apple ID with a hidden email is linked to an existing account by its password
const dora = await register('dora');
const doraSub = `003.e2e.${stamp}`;
const relayToken = async (nonce) => appleToken({ sub: doraSub, nonce: nonceHash(nonce), email: `x${stamp}@privaterelay.appleid.com`, email_verified: true, is_private_email: true });
res = await call('POST', '/api/auth/apple', { body: { identityToken: await relayToken('l1'), nonce: 'l1' } });
check('hidden email asks for a profile', res.status === 200 && res.data.needsProfile === true, res.data);
res = await call('POST', '/api/auth/apple', { body: { identityToken: await relayToken('l2'), nonce: 'l2', linkIdentifier: dora.username, linkPassword: 'wrong-password' } });
check('linking with a wrong password is refused', res.status === 401, res.data);
res = await call('POST', '/api/auth/apple', { body: { identityToken: await relayToken('l3'), nonce: 'l3', linkIdentifier: dora.username, linkPassword: 'e2e-password' } });
check('linking with the password signs into the existing account', res.status === 200 && res.data.id === dora.id && res.data.linked === true && res.data.token, res.data);
res = await call('POST', '/api/auth/apple', { body: { identityToken: await relayToken('l4'), nonce: 'l4' } });
check('the linked Apple ID signs in directly afterwards', res.status === 200 && res.data.id === dora.id);

// ---------- 2b. Sign in with Google ----------
const googleSub = `10${stamp}77`;
const elenaEmail = `elena${stamp}@gmail.com`;
const google = async (nonce, claims = {}, extra = {}) => call('POST', '/api/auth/google', {
  body: { idToken: await googleToken({ sub: googleSub, nonce, email: elenaEmail, email_verified: true, name: 'Elena Ruiz', ...claims }), nonce, ...extra },
});
res = await google('g1');
check('new Google user is asked for a profile, with the name and email from Google', res.status === 200 && res.data.needsProfile === true
  && res.data.name === 'Elena Ruiz' && res.data.email === elenaEmail && res.data.suggestedUsername === 'elenaruiz', res.data);
res = await google('g2', {}, { username: `elena${stamp}` });
check('Google: terms must be accepted', res.status === 400, res.data);
res = await google('g3', {}, { username: `elena${stamp}`, acceptedTerms: true });
check('Google account is created and signed in', res.status === 200 && typeof res.data.token === 'string' && res.data.created === true && res.data.name === 'Elena Ruiz', res.data);
check('the Google id is not sent to the app', res.data.googleSub === undefined);
const elena = { id: res.data.id };
const elenaRow = await one('select google_sub, email, email_verified, password from users where id = ?', [elena.id]);
check('the account keeps the Google id and the verified email, no password', elenaRow?.google_sub === googleSub && elenaRow.email === elenaEmail && Number(elenaRow.email_verified) === 1 && elenaRow.password === '', elenaRow);
res = await google('g4');
check('same Google account signs in again', res.status === 200 && res.data.id === elena.id && res.data.token, res.data);
res = await call('POST', '/api/auth/google', { body: { idToken: await googleToken({ sub: googleSub, nonce: 'g5' }), nonce: 'another' } });
check('Google: wrong nonce is refused', res.status === 401, res.data);
res = await call('POST', '/api/auth/google', { body: { idToken: await googleToken({ sub: googleSub, nonce: 'g6', aud: 'someone-else.apps.googleusercontent.com' }), nonce: 'g6' } });
check('Google: a token for another app is refused', res.status === 401, res.data);
// An existing email account is linked when Google has verified the address
const bruno = await register('bruno');
const brunoEmail = `${bruno.username}@e2e.test`.toLowerCase();
res = await call('POST', '/api/auth/google', { body: { idToken: await googleToken({ sub: `20${stamp}`, nonce: 'g7', email: brunoEmail, email_verified: false }), nonce: 'g7' } });
check('an unverified Google email does not link the account', res.status === 200 && res.data.needsProfile === true, res.data);
res = await call('POST', '/api/auth/google', { body: { idToken: await googleToken({ sub: `20${stamp}`, nonce: 'g8', email: brunoEmail, email_verified: true }), nonce: 'g8' } });
check('a Google-verified email links the existing account', res.status === 200 && res.data.id === bruno.id && res.data.token, res.data);
check('the Google link is stored', (await one('select google_sub from users where id = ?', [bruno.id]))?.google_sub === `20${stamp}`);
// "Ya tengo cuenta" with another address: linked by the password
const clara = await register('clara');
const claraGoogle = async (nonce, extra = {}) => call('POST', '/api/auth/google', {
  body: { idToken: await googleToken({ sub: `30${stamp}`, nonce, email: `otra${stamp}@gmail.com`, email_verified: true }), nonce, ...extra },
});
res = await claraGoogle('c1', { linkIdentifier: clara.username, linkPassword: 'wrong-password' });
check('Google: linking with a wrong password is refused', res.status === 401, res.data);
res = await claraGoogle('c2', { linkIdentifier: clara.username, linkPassword: 'e2e-password' });
check('Google: linking with the password signs into the existing account', res.status === 200 && res.data.id === clara.id && res.data.linked === true, res.data);
res = await claraGoogle('c3');
check('the linked Google account signs in directly afterwards', res.status === 200 && res.data.id === clara.id, res.data);
// A suspended account can't sign in with Google either
await db.execute({ sql: "update users set banned_at = ? where id = ?", args: [new Date().toISOString(), clara.id] });
res = await claraGoogle('c4');
check('a suspended account is refused with Google', res.status === 403 && res.data.error === 'account_suspended', res.data);
await db.execute({ sql: 'update users set banned_at = null where id = ?', args: [clara.id] });
// Not configured: the endpoint says so
res = await call('POST', '/api/auth/google', { body: { idToken: 'x', nonce: 'y' }, useEnv: { ...env, GOOGLE_CLIENT_IDS: '' } });
check('Google sign-in without client IDs answers 503', res.status === 503, res);

// The tour is shown once per account
res = await call('GET', `/api/current-user/${dora.id}`, { token: dora.token });
check('a new account has not seen the tour', res.status === 200 && (res.data.tourDoneAt ?? null) === null, res.data);
res = await call('POST', '/api/users/me/tour-done', { token: dora.token });
res = await call('GET', `/api/current-user/${dora.id}`, { token: dora.token });
check('tour-done is remembered for the account', typeof res.data.tourDoneAt === 'string', res.data);

// ---------- 3. Analytics events ----------
res = await call('POST', '/api/events', { token: bea.token, body: {
  installId: 'install-bea', appVersion: '1.0 (1100)',
  events: [
    { name: 'app_open', at: new Date().toISOString() },
    { name: 'tab_view', props: { tab: 'rankings', nested: { no: 1 } } },
    { name: 'Bad Name!' },
    { name: 'run_started', props: { source: 'siri' } },
  ],
} });
check('valid events are stored, bad ones skipped', res.status === 200 && res.data.stored === 3, res.data);
const tabEvent = await one("select props, app_version from app_events where user_id = ? and name = 'tab_view'", [bea.id]);
check('props keep only flat values', tabEvent && JSON.parse(tabEvent.props).tab === 'rankings' && !('nested' in JSON.parse(tabEvent.props)) && tabEvent.app_version === '1.0 (1100)');
res = await call('POST', '/api/events', { body: { events: [{ name: 'app_open' }] } });
check('events need a session', res.status === 401);

// ---------- 4. Widget summary and welcome missions ----------
res = await call('GET', '/api/widget/summary', { token: ana.token });
check('widget summary', res.status === 200 && res.data.area > 0 && typeof res.data.phase === 'string' && 'lastSteal' in res.data, res.data);
res = await call('GET', '/api/onboarding/missions', { token: ana.token });
const missions = Object.fromEntries((res.data.missions ?? []).map((m) => [m.id, m.done]));
check('missions reflect what the user did', res.status === 200 && res.data.visible && missions.first_run && missions.first_territory && missions.first_friend && !missions.join_club && !missions.connect_device, res.data);
res = await call('GET', '/api/onboarding/missions?health=1', { token: ana.token });
check('Apple Health counts as a device', res.data.missions.find((m) => m.id === 'connect_device')?.done === true);
// Join a club by hand (all missions done) → one gift
const clubId = `club${stamp}`;
await db.execute({ sql: "insert into clubs (id, name, name_key, crest, color, owner_id, join_code) values (?, ?, ?, '{}', '#377EB8', ?, ?)", args: [clubId, `Club ${stamp}`, `club ${stamp}`, ana.id, `J${stamp}`] });
await db.execute({ sql: "insert into club_members (user_id, club_id, role) values (?, ?, 'owner')", args: [ana.id, clubId] });
res = await call('GET', '/api/onboarding/missions?health=1', { token: ana.token });
check('all missions done gives a gift once', res.data.completed === 5 && typeof res.data.rewardItem === 'string', res.data);
const inventory = await one("select count(*) as n from user_powers where user_id = ? and source = 'welcome'", [ana.id]).catch(() => null);
res = await call('GET', '/api/onboarding/missions?health=1', { token: ana.token });
check('the gift is not given twice', res.data.rewardItem === null && res.data.visible === false, res.data);
if (inventory) check('the gift is in the inventory', Number(inventory.n) === 1, inventory);

// ---------- 5. apple-app-site-association ----------
res = await call('GET', '/.well-known/apple-app-site-association');
check('AASA lists the app and the paths', res.status === 200 && res.data.applinks.details[0].appIDs[0] === 'TEAM123456.com.jpoves.runnaio'
  && res.data.applinks.details[0].components.some((c) => c['/'] === '/invite/*'), res.data);

// ---------- 6. Admin panel: reports, suspension, stats ----------
res = await call('POST', '/api/reports', { token: bea.token, body: { targetType: 'user', targetId: carla.id, reportedUserId: carla.id, reason: 'Insultos' } });
check('report created', res.status === 200 || res.status === 201, res.data);
const report = await one('select id, status from reports where reported_user_id = ?', [carla.id]);
check('new reports are open', report?.status === 'open', report);

let page = await raw('GET', '/admin');
check('panel asks to sign in', page.status === 303 && page.headers.get('location') === '/admin/login');
page = await raw('POST', '/admin/login', { form: { secret: 'wrong' } });
check('wrong admin secret is refused', page.status === 401);
page = await raw('POST', '/admin/login', { form: { secret: 'e2e-cron-secret' } });
const cookie = (page.headers.get('set-cookie') ?? '').split(';')[0];
check('admin login sets a secure cookie', page.status === 303 && cookie.startsWith('kaemedos_admin=') && /HttpOnly/.test(page.headers.get('set-cookie')) && /SameSite=Strict/.test(page.headers.get('set-cookie')));
page = await raw('GET', '/admin', { headers: { Cookie: cookie } });
const dashboard = await page.text();
check('dashboard warns about the open report', page.status === 200 && dashboard.includes('Resumen') && dashboard.includes('1 denuncia pendiente'), dashboard.slice(0, 400));
page = await raw('GET', '/admin/reports', { headers: { Cookie: cookie } });
const html = await page.text();
check('panel lists the open report', page.status === 200 && html.includes('Insultos') && html.includes('Pendientes (1)'), html.slice(0, 300));
check('panel is not cached', page.headers.get('cache-control') === 'no-store');
const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
page = await raw('POST', '/admin/reports/action', { headers: { Cookie: cookie }, form: { csrf: 'forged', report: report.id, action: 'ban' } });
check('forged CSRF token does nothing', page.status === 303 && !(await one('select banned_at from users where id = ?', [carla.id])).banned_at);
page = await raw('POST', '/admin/reports/action', { headers: { Cookie: cookie }, form: { csrf, report: report.id, action: 'ban' } });
check('suspend from the panel', page.status === 303 && (await one('select banned_at from users where id = ?', [carla.id])).banned_at);
check('report resolved', (await one('select status, action from reports where id = ?', [report.id])).action === 'user_banned');
res = await call('GET', '/api/users/' + carla.id + '/stats', { token: carla.token });
check('suspended user loses their session', res.status === 401, res.status);
res = await call('POST', '/api/auth/apple', { body: { identityToken: await appleToken({ sub: appleSub, nonce: nonceHash('n5') }), nonce: 'n5' } });
check('suspended user cannot sign in again', res.status === 403 && res.data.error === 'account_suspended', res.data);
page = await raw('POST', '/admin/users/unban', { headers: { Cookie: cookie }, form: { csrf, user: carla.id } });
check('reinstate from the panel', page.status === 303 && !(await one('select banned_at from users where id = ?', [carla.id])).banned_at);

// A comment report: delete the content
const feedEvent = await one('select id from feed_events where user_id = ? limit 1', [ana.id]);
res = await call('POST', `/api/feed/events/${feedEvent.id}/comments`, { token: bea.token, body: { userId: bea.id, content: 'comentario feo' } });
const comment = await one('select id from feed_comments where feed_event_id = ?', [feedEvent.id]);
if (comment) {
  await call('POST', '/api/reports', { token: ana.token, body: { targetType: 'comment', targetId: comment.id, reportedUserId: bea.id, reason: 'Ofensivo' } });
  const commentReport = await one("select id from reports where target_type = 'comment' and target_id = ?", [comment.id]);
  page = await raw('POST', '/admin/reports/action', { headers: { Cookie: cookie }, form: { csrf, report: commentReport.id, action: 'remove' } });
  check('delete reported comment', !(await one('select id from feed_comments where id = ?', [comment.id])));
} else {
  check('comment created for the report test', false, res.data);
}

page = await raw('GET', '/admin/stats', { headers: { Cookie: cookie } });
const stats = await page.text();
check('stats page renders', page.status === 200 && stats.includes('Embudo') && stats.includes('rankings'), stats.slice(0, 300));
page = await raw('GET', '/admin/emails', { headers: { Cookie: cookie } });
const emailsHtml = await page.text();
check('emails page previews every email', page.status === 200 && (emailsHtml.match(/<iframe/g) ?? []).length === 7 && emailsHtml.includes('Bienvenido a KM2, Lucía'), emailsHtml.slice(0, 300));

// Competitions: calendar and a club competition of the current cycle (inserted by hand)
page = await raw('GET', '/admin/competitions', { headers: { Cookie: cookie } });
const compsHtml = await page.text();
check('competitions page shows the calendar', page.status === 200 && compsHtml.includes('Calendario') && compsHtml.includes('Empieza') && (compsHtml.match(/<tr/g) ?? []).length >= 10, compsHtml.slice(0, 400));
const cycleMatch = compsHtml.match(/Este ciclo \((-?\d+)\)/);
const cycleNumber = cycleMatch ? Number(cycleMatch[1]) : 0;
const compId = `comp${stamp}`;
await db.execute({ sql: "insert into club_competitions (id, cycle_number, club_id, mode, status) values (?, ?, ?, 'ffa', 'active')", args: [compId, cycleNumber, clubId] });
await db.execute({ sql: 'insert into competition_participants (competition_id, user_id, area, runs, distance) values (?, ?, 250000, 3, 12000)', args: [compId, ana.id] });
page = await raw('GET', '/admin/competitions', { headers: { Cookie: cookie } });
const compsHtml2 = await page.text();
check('current cycle lists the club competition', compsHtml2.includes(`/admin/competitions/${compId}`) && compsHtml2.includes(`Club ${stamp}`), compsHtml2.slice(compsHtml2.indexOf('Este ciclo'), compsHtml2.indexOf('Este ciclo') + 600));
page = await raw('GET', `/admin/competitions/${compId}`, { headers: { Cookie: cookie } });
const compDetail = await page.text();
check('competition detail shows the standings', page.status === 200 && compDetail.includes('Clasificación (1)') && compDetail.includes('ana'), compDetail.slice(0, 400));
page = await raw('GET', '/admin/competitions/nope', { headers: { Cookie: cookie } });
check('unknown competition is a 404', page.status === 404);

// Users: search, detail, suspend and reinstate from the profile
page = await raw('GET', `/admin/users?q=${encodeURIComponent(bea.username)}`, { headers: { Cookie: cookie } });
const usersHtml = await page.text();
check('user search finds by username', page.status === 200 && usersHtml.includes(`/admin/users/${bea.id}`), usersHtml.slice(0, 400));
page = await raw('GET', `/admin/users/${bea.id}`, { headers: { Cookie: cookie } });
const userHtml = await page.text();
check('user detail renders', page.status === 200 && userHtml.includes('Últimas carreras') && userHtml.includes('Denuncias recibidas'), userHtml.slice(0, 400));
page = await raw('POST', '/admin/users/ban', { headers: { Cookie: cookie }, form: { csrf, user: bea.id, reason: 'Pruebas' } });
check('suspend from the user page', page.status === 303 && (await one('select ban_reason from users where id = ?', [bea.id]))?.ban_reason === 'Pruebas');
page = await raw('POST', '/admin/users/unban', { headers: { Cookie: cookie }, form: { csrf, user: bea.id, back: 'user' } });
check('reinstate goes back to the user page', page.status === 303 && page.headers.get('location').startsWith(`/admin/users/${bea.id}`) && !(await one('select banned_at from users where id = ?', [bea.id])).banned_at);
bea.token = (await call('POST', '/api/auth/login', { body: { username: bea.username, password: 'e2e-password' } })).data.token;

// Runs: a flagged run is approved from the panel
await db.execute({ sql: "update routes set validation_status = 'flagged', validation_reasons = '[\"gps_jumps\"]' where id = ?", args: [route.id] });
page = await raw('GET', '/admin/runs', { headers: { Cookie: cookie } });
const runsHtml = await page.text();
check('runs page lists the flagged run', page.status === 200 && runsHtml.includes('En revisión (1)') && runsHtml.includes('saltos de GPS'), runsHtml.slice(0, 400));
page = await raw('POST', '/admin/runs/review', { headers: { Cookie: cookie }, form: { csrf, route: route.id, action: 'approve' } });
check('approve a flagged run', page.status === 303 && decodeURIComponent(page.headers.get('location')).includes('aprobada') && (await one('select validation_status from routes where id = ?', [route.id])).validation_status === 'accepted', page.headers.get('location'));
page = await raw('GET', '/admin/runs', { headers: { Cookie: cookie } });
check('pages without a cookie go to the login', (await raw('GET', '/admin/users')).headers.get('location') === '/admin/login');

// ---------- 6b. Sign in with Apple server-to-server notifications ----------
res = await call('POST', '/api/auth/apple', { body: { identityToken: await appleToken({ sub: appleSub, nonce: nonceHash('n6') }), nonce: 'n6' } });
const carlaToken = res.data.token;
check('Apple user signs in again after reinstatement', res.status === 200 && carlaToken);
const notify = async (type, sub = appleSub) => call('POST', '/api/auth/apple/notifications', { body: { payload: await appleToken({ events: JSON.stringify({ type, sub, event_time: Date.now() }) }) } });
res = await call('POST', '/api/auth/apple/notifications', { body: { payload: 'not-a-jwt' } });
check('forged notification is refused', res.status === 400);
res = await notify('email-disabled');
check('email-disabled is accepted', res.status === 200);
res = await notify('consent-revoked');
check('consent-revoked is accepted', res.status === 200);
res = await call('GET', `/api/users/${carla.id}/stats`, { token: carlaToken });
check('consent-revoked ends the sessions', res.status === 401, res.status);
res = await notify('account-delete');
check('account-delete deletes an Apple-only account', res.status === 200 && !(await one('select id from users where id = ?', [carla.id])));
res = await notify('account-delete', `002.e2e.${stamp}`);
check('account-delete only unlinks an account with a password', res.status === 200 && (await one('select apple_sub from users where id = ?', [ana.id]))?.apple_sub === null);

// ---------- 6c. One-click unsubscribe from the emails ----------
{
  const { createHmac } = await import('node:crypto');
  const token = createHmac('sha256', 'e2e-cron-secret').update(`email-unsubscribe:${bea.id}`).digest('base64url');
  let page2 = await raw('GET', `/email/unsubscribe?u=${bea.id}&t=${token}`);
  check('unsubscribe page asks first', page2.status === 200 && (await page2.text()).includes('Darme de baja'));
  page2 = await raw('GET', `/email/unsubscribe?u=${bea.id}&t=forged`);
  check('forged unsubscribe link is refused', page2.status === 400);
  page2 = await raw('POST', `/email/unsubscribe?u=${bea.id}&t=${token}`, { form: { 'List-Unsubscribe': 'One-Click' } });
  const prefs = await one('select friend_request_notifications as fr, friend_accepted_notifications as fa from email_preferences where user_id = ?', [bea.id]);
  check('one-click unsubscribe turns the emails off', page2.status === 200 && Number(prefs?.fr) === 0 && Number(prefs?.fa) === 0, prefs);
  page2 = await raw('POST', `/email/unsubscribe?u=${bea.id}&t=${token}`, { form: { resubscribe: '1' } });
  const again = await one('select friend_request_notifications as fr from email_preferences where user_id = ?', [bea.id]);
  check('they can be turned on again', Number(again?.fr) === 1, again);
}

// ---------- 7. Account deletion clears the new tables ----------
res = await call('DELETE', `/api/users/${ana.id}`, { token: ana.token });
check('account deleted', res.status === 200, res.data);
check('hidden ends deleted with the account', !(await one('select 1 as x from route_private_ends where user_id = ?', [ana.id])));
res = await call('DELETE', `/api/users/${bea.id}`, { token: bea.token });
check('analytics deleted with the account', !(await one('select 1 as x from app_events where user_id = ?', [bea.id])));

// ---------- 8. Cron purge ----------
await db.execute({ sql: "insert into app_events (user_id, name, created_at) values (null, 'old_event', datetime('now', '-200 days'))" });
res = await call('POST', '/api/tasks/events-purge', { headers: { Authorization: 'Bearer e2e-cron-secret' } });
check('events older than 180 days are purged', res.status === 200 && res.data.deleted >= 1 && !(await one("select 1 as x from app_events where name = 'old_event'")), res.data);

console.log(failures ? `\n${failures} check(s) failed` : '\nAll launch-feature checks passed');
process.exit(failures ? 1 : 0);
