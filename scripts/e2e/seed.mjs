// Fills the local e2e API with a small friend group, an active competition (treasure, powers,
// fortification, nickname, weekly summary), runs that create and steal territory, comments and
// reactions. Prints {"token","userId"} for the main test user (alice).
import { createClient } from '@libsql/client';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pendingSignup } from './signup.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const api = process.env.E2E_API || 'http://127.0.0.1:8787';
// Admin / cron endpoints accept the cron secret of the e2e server (scripts/e2e/server.mjs)
const cronSecret = process.env.E2E_CRON_SECRET || 'e2e-cron-secret';
const db = createClient({ url: process.env.E2E_DATABASE_URL || `file:${path.join(here, '.build', 'e2e.db')}` });

async function call(method, route, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(api + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${text}`);
  return data;
}

async function register(username, name, color) {
  const user = await call('POST', '/api/auth/register/confirm', { body: await pendingSignup(db, { username, name, color }) });
  return { id: user.id, token: user.token, name };
}

// A closed loop of `points` GPS points around a centre (radius in metres)
function loop(lat, lng, radius, points = 48) {
  const coords = [];
  for (let i = 0; i <= points; i++) {
    const angle = (2 * Math.PI * i) / points;
    coords.push([lat + (radius / 111320) * Math.sin(angle), lng + (radius / (111320 * Math.cos((lat * Math.PI) / 180))) * Math.cos(angle)]);
  }
  return coords;
}

async function run(user, name, coords, hoursAgo) {
  const end = new Date(Date.now() - hoursAgo * 3600_000);
  const distance = coords.slice(1).reduce((sum, p, i) => {
    const q = coords[i];
    const dLat = ((p[0] - q[0]) * Math.PI) / 180;
    const dLng = ((p[1] - q[1]) * Math.PI) / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos((q[0] * Math.PI) / 180) * Math.cos((p[0] * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    return sum + 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }, 0);
  const duration = Math.round(distance / 3); // ~5:30 /km
  const { route } = await call('POST', '/api/routes', {
    token: user.token,
    body: {
      name,
      coordinates: coords,
      distance,
      duration,
      startedAt: new Date(end.getTime() - duration * 1000).toISOString(),
      completedAt: end.toISOString(),
    },
  });
  for (let i = 0; i < 60; i++) {
    const result = await call('GET', `/api/conquest-result/${route.id}`, { token: user.token });
    if (result.ready) return route;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`territory for ${name} was not processed`);
}

const alice = await register('alice', 'Alicia', '#377EB8');
const bob = await register('bob', 'Bruno', '#E41A1C');
const carol = await register('carol', 'Carla', '#4DAF4A');
const dave = await register('dave', 'David', '#FF7F00');

// Friends: alice-bob (request), alice-carol (invite link). dave sends alice a pending request.
await call('POST', '/api/friends', { token: alice.token, body: { friendId: bob.id } });
const [request] = await call('GET', `/api/friends/requests/${bob.id}`, { token: bob.token });
await call('POST', `/api/friends/requests/${request.id}/accept`, { token: bob.token, body: {} });
const invite = await call('POST', '/api/friends/invite', { token: alice.token, body: {} });
await call('POST', `/api/friends/accept/${invite.token}`, { token: carol.token, body: {} });
await call('POST', '/api/friends', { token: dave.token, body: { friendId: alice.id } });

// Active competition: started 10 days ago (week 2), ends in 18 days. Created before the runs so
// they count for it (competition stats, fortifications).
const day = 86400_000;
const competition = await call('POST', '/api/admin/competition', {
  token: cronSecret,
  body: {
    name: 'La Conquista del Ebro',
    slug: 'e2e-conquista-del-ebro',
    startsAt: new Date(Date.now() - 10 * day).toISOString(),
    endsAt: new Date(Date.now() + 18 * day).toISOString(),
  },
});
const competitionState = await call('GET', '/api/competition/active'); // marks it active
if (competitionState.status !== 'active') throw new Error(`competition is ${competitionState.status}, expected active`);

// Runs around Zaragoza: bob runs over part of alice's territory afterwards (steals it)
const centre = [41.6488, -0.8891];
await run(alice, 'Vuelta al Pilar', loop(centre[0], centre[1], 450), 30);
await run(alice, 'Ribera del Ebro', loop(centre[0] + 0.006, centre[1] - 0.012, 350), 26);
// Running the same loop again fortifies it (competition only); twice puts a castle on the map.
// Bob's run below doesn't reach this one (attacks break fortifications).
await run(alice, 'Ribera del Ebro otra vez', loop(centre[0] + 0.006, centre[1] - 0.012, 350), 25);
await run(alice, 'Ribera, tercera vuelta', loop(centre[0] + 0.006, centre[1] - 0.012, 350), 24);
await run(carol, 'Parque Grande', loop(centre[0] - 0.012, centre[1] - 0.004, 400), 20);
const bobRoute = await run(bob, 'Asalto al centro', loop(centre[0] + 0.002, centre[1] + 0.003, 380), 2);

// Social activity on bob's run
const feed = await call('GET', `/api/feed/${alice.id}?limit=20&offset=0`, { token: alice.token });
const bobEvent = feed.find((event) => event.routeId === bobRoute.id) || feed[0];
if (bobEvent) {
  await call('POST', `/api/feed/events/${bobEvent.id}/comments`, { token: alice.token, body: { content: '¡Me has robado medio centro! 😤' } });
  await call('POST', `/api/feed/events/${bobEvent.id}/comments`, { token: carol.token, body: { content: 'Buen ritmo, Bruno 👏' } });
  await call('POST', '/api/feed/reactions', { token: carol.token, body: { targetType: 'event', targetId: bobEvent.id, reactionType: 'like' } });
}

// Competition extras: a treasure near the centre, powers for alice, a nickname for carol
const { treasure } = await call('POST', '/api/admin/spawn-treasure', {
  token: cronSecret,
  body: { powerType: 'magnet', lat: centre[0] + 0.004, lng: centre[1] + 0.006, zone: 'Plaza del Pilar', durationHours: 20 },
});
const powers = [
  { type: 'shield', status: 'available' },
  { type: 'nickname', status: 'available' },
  { type: 'double_area', status: 'available' },
  { type: 'invisibility', status: 'active', activatedAt: new Date(Date.now() - 4 * 3600_000), expiresAt: new Date(Date.now() + 20 * 3600_000) },
  { type: 'steal_boost', status: 'used', activatedAt: new Date(Date.now() - 3 * day), usedAt: new Date(Date.now() - 3 * day) },
];
for (const [index, power] of powers.entries()) {
  await db.execute({
    sql: `insert into user_powers (id, user_id, competition_id, power_type, treasure_id, status, activated_at, used_at, expires_at, created_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      `e2e-power-${index + 1}`, alice.id, competition.id, power.type, treasure.id, power.status,
      power.activatedAt?.toISOString() ?? null, power.usedAt?.toISOString() ?? null, power.expiresAt?.toISOString() ?? null,
      new Date(Date.now() - (index + 1) * 3600_000).toISOString(),
    ],
  });
}
await db.execute({
  sql: 'insert into user_nicknames (id, target_user_id, set_by_user_id, nickname, expires_at) values (?, ?, ?, ?, ?)',
  args: ['e2e-nickname-1', carol.id, bob.id, 'La Tortuga', new Date(Date.now() + 40 * 3600_000).toISOString()],
});

// Weekly summary of the current week (the Sunday cron task, run by hand)
const weekly = await call('POST', '/api/tasks/weekly-summary', { token: cronSecret, body: {} });
if (!weekly.success) throw new Error(`weekly summary was not generated: ${JSON.stringify(weekly)}`);

const fortifications = (await call('GET', '/api/territories/fortifications', { token: alice.token })).fortifications;
const leaderboard = (await call('GET', '/api/competition/leaderboard', { token: alice.token })).leaderboard;
const alicePowers = (await call('GET', `/api/users/${alice.id}/powers`, { token: alice.token })).powers;
const treasures = (await call('GET', '/api/treasures/active')).treasures;
console.error(
  `[e2e seed] competition ${competition.id}: ${leaderboard.length} on the leaderboard, ${treasures.length} treasure(s), ` +
  `${alicePowers.length} powers for alice, ${fortifications.length} fortified player(s), weekly summary week ${weekly.weekNumber}`,
);
if (alicePowers.length !== powers.length) throw new Error('alice powers were not stored');
if (treasures.length === 0) throw new Error('no active treasure');

const territories = await call('GET', `/api/territories/friends/${alice.id}`, { token: alice.token });
console.error(`[e2e seed] ${feed.length} feed events, ${territories.length} territories visible to alice`);
if (territories.length === 0) throw new Error('no territories were created');

console.log(JSON.stringify({ token: alice.token, userId: alice.id }));
