// Fills the local e2e API with a small friend group, runs that create and steal territory,
// comments and reactions. Prints {"token","userId"} for the main test user (alice).
import { createClient } from '@libsql/client';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const api = process.env.E2E_API || 'http://127.0.0.1:8787';
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
  const user = await call('POST', '/api/users', {
    body: { username, name, email: `${username}@e2e.test`, password: 'e2e-password', color, avatar: null },
  });
  const code = (await db.execute({ sql: 'select verification_code from users where id = ?', args: [user.id] })).rows[0].verification_code;
  await call('POST', '/api/auth/verify-email', { token: user.token, body: { code } });
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

// Runs around Zaragoza: bob runs over part of alice's territory afterwards (steals it)
const centre = [41.6488, -0.8891];
await run(alice, 'Vuelta al Pilar', loop(centre[0], centre[1], 450), 30);
await run(alice, 'Ribera del Ebro', loop(centre[0] + 0.006, centre[1] - 0.012, 350), 26);
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

const territories = await call('GET', `/api/territories/friends/${alice.id}`, { token: alice.token });
console.error(`[e2e seed] ${feed.length} feed events, ${territories.length} territories visible to alice`);
if (territories.length === 0) throw new Error('no territories were created');

console.log(JSON.stringify({ token: alice.token, userId: alice.id }));
