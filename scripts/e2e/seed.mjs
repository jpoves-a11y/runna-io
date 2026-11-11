// Fills the local e2e API with the new game: friends, two clubs (public and private, with a pending
// request and invite), a running club competition (scripts/e2e/server.mjs puts "now" inside one),
// runs that conquer the global map and steal on the competition map, a run rejected by the
// anti-cheat, inventory items, a chest, comments and reactions.
// Prints {"token","userId"} for the main test user (alice).
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

async function run(user, name, coords, hoursAgo, { speedKmh = 10.9 } = {}) {
  const end = new Date(Date.now() - hoursAgo * 3600_000);
  const distance = coords.slice(1).reduce((sum, p, i) => {
    const q = coords[i];
    const dLat = ((p[0] - q[0]) * Math.PI) / 180;
    const dLng = ((p[1] - q[1]) * Math.PI) / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos((q[0] * Math.PI) / 180) * Math.cos((p[0] * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    return sum + 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }, 0);
  const duration = Math.round(distance / (speedKmh / 3.6)); // default ~5:30 /km
  const { route, validation } = await call('POST', '/api/routes', {
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
    if (result.ready) return { ...route, preview: validation, result };
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`territory for ${name} was not processed`);
}

const alice = await register('alice', 'Alicia', '#377EB8');
const bob = await register('bob', 'Bruno', '#E41A1C');
const carol = await register('carol', 'Carla', '#4DAF4A');
const dave = await register('dave', 'David', '#FF7F00');
const erin = await register('erin', 'Elena', '#984EA3');

// Friends: alice-bob (request), alice-carol (invite link). dave sends alice a pending request.
await call('POST', '/api/friends', { token: alice.token, body: { friendId: bob.id } });
const [request] = await call('GET', `/api/friends/requests/${bob.id}`, { token: bob.token });
await call('POST', `/api/friends/requests/${request.id}/accept`, { token: bob.token, body: {} });
const invite = await call('POST', '/api/friends/invite', { token: alice.token, body: {} });
await call('POST', `/api/friends/accept/${invite.token}`, { token: carol.token, body: {} });
await call('POST', '/api/friends', { token: dave.token, body: { friendId: alice.id } });

// Everybody lives in Zaragoza (city ranking, chests)
const centre = [41.6488, -0.8891];
for (const user of [alice, bob, carol, dave, erin]) {
  await call('PATCH', '/api/users/me/location', {
    token: user.token,
    body: { city: 'Zaragoza', countryCode: 'ES', countryName: 'España', lat: centre[0], lng: centre[1] },
  });
}

// Clubs: alice's public club (bob joins directly, carol with the code); dave's private club, where
// erin asks to join; alice also invites erin
const { club } = await call('POST', '/api/clubs', {
  token: alice.token,
  body: {
    name: 'Corredores del Ebro',
    slogan: 'Cada calle cuenta',
    visibility: 'public',
    crest: { shape: 'classic', pattern: 'stripes', primary: '#16A34A', secondary: '#FFFFFF', icon: 'flame.fill', initials: 'CE' },
  },
});
await call('POST', `/api/clubs/${club.id}/join`, { token: bob.token, body: {} });
await call('POST', '/api/clubs/join-code', { token: carol.token, body: { code: club.joinCode } });
const { club: privateClub } = await call('POST', '/api/clubs', {
  token: dave.token,
  body: { name: 'Los Madrugadores', slogan: 'Antes de las 7', visibility: 'private', crest: { shape: 'round', pattern: 'chevron', primary: '#1D4ED8', secondary: '#FDE68A', icon: 'sun.max.fill', initials: 'LM' } },
});
const joinPrivate = await call('POST', `/api/clubs/${privateClub.id}/join`, { token: erin.token, body: {} });
if (!joinPrivate.requested) throw new Error('joining a private club must create a request');
await call('POST', `/api/clubs/${club.id}/invites`, { token: alice.token, body: { userId: erin.id } });

// Season: the first tick does the one-time reset and starts the running competition with the clubs
// as they are now. Then the season cutoff goes back 4 days and the participants are backdated to
// the start of the competition, so the runs below (last 30 h) count.
const tick = await call('POST', '/api/admin/season/tick', { token: cronSecret, body: {} });
if (tick.phase !== 'competition') throw new Error(`expected a running competition, got ${JSON.stringify(tick)}`);
await call('POST', '/api/admin/season/runs-from', { token: cronSecret, body: { at: new Date(Date.now() - 4 * 86400_000).toISOString() } });
const season = await call('GET', '/api/season/current', { token: alice.token });
await db.execute({ sql: 'UPDATE competition_participants SET joined_at = ?', args: [season.cycle.competitionStartsAt] });

// Runs around Zaragoza: bob runs over part of alice's territory afterwards (steals it: same club,
// "todos contra todos")
const vuelta = await run(alice, 'Vuelta al Pilar', loop(centre[0], centre[1], 450), 30);
await run(alice, 'Ribera del Ebro', loop(centre[0] + 0.006, centre[1] - 0.012, 350), 26);
// Running the same loop again fortifies it on the competition map; twice puts a castle on the map.
await run(alice, 'Ribera del Ebro otra vez', loop(centre[0] + 0.006, centre[1] - 0.012, 350), 25);
await run(alice, 'Ribera, tercera vuelta', loop(centre[0] + 0.006, centre[1] - 0.012, 350), 24);
await run(carol, 'Parque Grande', loop(centre[0] - 0.012, centre[1] - 0.004, 400), 20);
await run(dave, 'Amanecer en el Actur', loop(centre[0] + 0.02, centre[1] + 0.01, 420), 10);
const bobRoute = await run(bob, 'Asalto al centro', loop(centre[0] + 0.002, centre[1] + 0.003, 380), 2);
// A "run" at car speed: saved, but rejected by the anti-cheat
const car = await run(alice, 'Vuelta en coche', loop(centre[0] - 0.02, centre[1] + 0.02, 900), 3, { speedKmh: 45 });

if (!(vuelta.result.globalArea?.gained > 0)) throw new Error(`alice's first run added no global area: ${JSON.stringify(vuelta.result)}`);
if (car.preview?.status !== 'rejected' || car.result.validation?.status !== 'rejected') throw new Error(`the car run was not rejected: ${JSON.stringify(car.result.validation)}`);
if (!(bobRoute.result.competition?.areaStolen > 0)) throw new Error(`bob stole nothing from alice: ${JSON.stringify(bobRoute.result.competition)}`);

// Social activity on bob's run
const feed = await call('GET', `/api/feed/${alice.id}?limit=20&offset=0`, { token: alice.token });
const bobEvent = feed.find((event) => event.routeId === bobRoute.id) || feed[0];
if (bobEvent) {
  await call('POST', `/api/feed/events/${bobEvent.id}/comments`, { token: alice.token, body: { content: '¡Me has robado medio centro! 😤' } });
  await call('POST', `/api/feed/events/${bobEvent.id}/comments`, { token: carol.token, body: { content: 'Buen ritmo, Bruno 👏' } });
  await call('POST', '/api/feed/reactions', { token: carol.token, body: { targetType: 'event', targetId: bobEvent.id, reactionType: 'like' } });
}

// Inventory for alice (as if won in chests and challenges) and a nickname for carol
const day = 86400_000;
const items = [
  { type: 'shield', scope: 'competition', status: 'available', ttl: 3 * day },
  { type: 'nickname', scope: 'competition', status: 'available', ttl: 6 * day },
  { type: 'double_area', scope: 'competition', status: 'available', ttl: 5 * day },
  { type: 'explorer', scope: 'global', status: 'available', ttl: 6 * day },
  { type: 'invisibility', scope: 'competition', status: 'active', activatedAt: new Date(Date.now() - 4 * 3600_000), expiresAt: new Date(Date.now() + 20 * 3600_000) },
  { type: 'title_pionero', scope: 'cosmetic', status: 'owned' },
  { type: 'crest_icon_crown', scope: 'cosmetic', status: 'owned' },
];
for (const [index, item] of items.entries()) {
  await db.execute({
    sql: `insert into user_powers (id, user_id, competition_id, power_type, treasure_id, status, activated_at, expires_at, scope, source, unused_expires_at, created_at)
          values (?, ?, 'season', ?, ?, ?, ?, ?, ?, 'chest', ?, ?)`,
    args: [
      `e2e-item-${index + 1}`, alice.id, item.type, `e2e-chest-${index + 1}`, item.status,
      item.activatedAt?.toISOString() ?? null, item.expiresAt?.toISOString() ?? null, item.scope,
      item.ttl ? new Date(Date.now() + item.ttl).toISOString() : null,
      new Date(Date.now() - (index + 1) * 3600_000).toISOString(),
    ],
  });
}
await call('POST', '/api/cosmetics/title', { token: alice.token, body: { itemId: 'title_pionero' } });
await db.execute({
  sql: 'insert into user_nicknames (id, target_user_id, set_by_user_id, nickname, expires_at) values (?, ?, ?, ?, ?)',
  args: ['e2e-nickname-1', carol.id, bob.id, 'La Tortuga', new Date(Date.now() + 40 * 3600_000).toISOString()],
});
// A chest near the centre (normally they spawn in the rest days)
await db.execute({
  sql: `insert into treasures (id, competition_id, name, power_type, rarity, lat, lng, spawned_at, expires_at, active, zone, hidden, city_key)
        values ('e2e-chest', 'cycle-e2e', 'Cofre épico', 'magnet', 'epic', ?, ?, ?, ?, 1, 'Zaragoza', 0, 'ES:zaragoza')`,
  args: [centre[0] + 0.004, centre[1] + 0.006, new Date().toISOString(), new Date(Date.now() + 20 * 3600_000).toISOString()],
});

// Checks of what the app shows
const current = await call('GET', '/api/season/current', { token: alice.token });
const map = await call('GET', '/api/season/map', { token: alice.token });
const world = await call('GET', '/api/rankings/global?scope=world', { token: alice.token });
const city = await call('GET', '/api/rankings/global?scope=city&period=month', { token: alice.token });
const clubs = await call('GET', '/api/rankings/clubs?scope=world', { token: alice.token });
const globalMap = await call('GET', '/api/global/territories', { token: alice.token });
const daveClub = await call('GET', '/api/clubs/mine', { token: dave.token });
const erinClub = await call('GET', '/api/clubs/mine', { token: erin.token });
const inventory = await call('GET', '/api/inventory', { token: alice.token });
console.error(
  `[e2e seed] season cycle ${current.cycle.number} (${current.cycle.phase}, ${current.competition?.mode}): ` +
  `${current.competition?.standings.length} in alice's competition, ${map.territories.length} territories and ${map.chests.length} chest(s) on the competition map, ` +
  `${world.entries.length} in the world ranking, ${city.entries.length} in Zaragoza this month, ${clubs.entries.length} clubs, ` +
  `${globalMap.overlays.length} global overlays, ${inventory.items.length} items`,
);
if (current.competition?.mode !== 'ffa' || current.competition.standings.length !== 3) throw new Error(`unexpected competition: ${JSON.stringify(current.competition)}`);
if (map.territories.length === 0 || map.chests.length !== 1) throw new Error('competition map is empty');
if (world.entries.length < 4 || world.me.rank === null) throw new Error(`world ranking: ${JSON.stringify(world)}`);
if (city.entries.length < 4) throw new Error('city ranking is empty');
if (globalMap.overlays.length < 2) throw new Error('no global overlays of friends/club mates');
if (daveClub.pendingRequests?.length !== 1) throw new Error('dave should see erin\'s request');
if (erinClub.invites?.length !== 1 || erinClub.myRequests?.length !== 1) throw new Error('erin should have an invite and a request');
if (inventory.items.length !== items.length) throw new Error('alice items were not stored');

console.log(JSON.stringify({ token: alice.token, userId: alice.id }));
