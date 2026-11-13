// Fills the local e2e API with the new game: friends, two clubs (open, and with approval and a pending
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
      // Time and altitude of each point (a 40 m hill): charts of the activity screen
      pointTimes: coords.map((_, i) => Math.round((i * duration) / (coords.length - 1))),
      altitudes: coords.map((_, i) => Math.round((200 + 40 * Math.sin((Math.PI * i) / (coords.length - 1))) * 10) / 10),
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

// Clubs: alice's open club (bob joins directly, carol with the code); dave's club with approval, where
// erin asks to join; alice also invites erin
const { club } = await call('POST', '/api/clubs', {
  token: alice.token,
  body: {
    name: 'Corredores del Ebro',
    slogan: 'Cada calle cuenta',
    description: 'Quedadas los martes y jueves por la ribera del Ebro. Todos los ritmos son bienvenidos.',
    visibility: 'public',
    crest: { shape: 'classic', pattern: 'stripes', primary: '#16A34A', secondary: '#FFFFFF', icon: 'flame.fill', initials: 'CE' },
  },
});
await call('POST', `/api/clubs/${club.id}/join`, { token: bob.token, body: {} });
await call('POST', '/api/clubs/join-code', { token: carol.token, body: { code: club.joinCode } });
const { club: privateClub } = await call('POST', '/api/clubs', {
  token: dave.token,
  body: { name: 'Los Madrugadores', slogan: 'Antes de las 7', entryMode: 'approval', description: 'Salimos a correr antes del trabajo, de lunes a viernes. Ritmo tranquilo.', crest: { shape: 'round', pattern: 'chevron', primary: '#1D4ED8', secondary: '#FDE68A', icon: 'sun.max.fill', initials: 'LM' } },
});
const joinPrivate = await call('POST', `/api/clubs/${privateClub.id}/join`, { token: erin.token, body: {} });
if (!joinPrivate.requested) throw new Error('joining a club with approval must create a request');
await call('POST', `/api/clubs/${club.id}/invites`, { token: alice.token, body: { userId: erin.id } });

// Season: the first tick does the one-time reset and starts the running competition with the clubs
// as they are now. Then the season cutoff goes back 4 days and the participants are backdated to
// the start of the competition, so the runs below (last 30 h) count.
// With 50 subrequests per run (Cloudflare free plan) the reset and the start take a few ticks
let tick = null;
for (let i = 0; i < 10; i++) {
  tick = await call('POST', '/api/admin/season/tick', { token: cronSecret, body: {} });
  if (!tick.paused && tick.phase && !tick.reset && tick.started === undefined) break;
}
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

// Club chat: a conversation with a reply, a mention and reactions; bob's last message is unread for alice
const say = async (user, body, replyTo) => (await call('POST', `/api/clubs/${club.id}/messages`, { token: user.token, body: { body, ...(replyTo ? { replyTo } : {}) } })).message;
const plan = await say(bob, '¿Quién se apunta mañana a las 7:00 por la ribera? Ritmo suave, unos 10 km.');
await say(carol, 'Yo voy. @alice ¿te vienes?', plan.id);
const yes = await say(alice, 'Hecho, nos vemos en el puente de Piedra.');
for (const user of [bob, carol]) {
  await call('POST', `/api/clubs/${club.id}/messages/${yes.id}/reactions`, { token: user.token, body: { emoji: '👍' } });
}
await call('POST', `/api/clubs/${club.id}/messages/${plan.id}/reactions`, { token: alice.token, body: { emoji: '🔥' } });
await say(bob, 'Por cierto, hoy os he quitado un buen trozo del Actur.');
const aliceClub = await call('GET', '/api/clubs/mine', { token: alice.token });
if (aliceClub.unreadCount !== 1) throw new Error(`alice should have 1 unread chat message, got ${aliceClub.unreadCount}`);

// The previous competition, finished two days ago and not seen by alice yet: the end-of-competition
// summary pops up (club result, her numbers, awards and two chests to open)
const prevId = 'seed-previous-competition';
const finishedAt = new Date(Date.now() - 2 * day).toISOString();
const prevStandings = [
  { userId: alice.id, name: 'Alicia', score: 1_840_000, team: null, runs: 6, areaStolen: 210_000, distance: 52_300, rank: 1 },
  { userId: bob.id, name: 'Bruno', score: 1_220_000, team: null, runs: 5, areaStolen: 95_000, distance: 61_800, rank: 2 },
  { userId: carol.id, name: 'Carla', score: 640_000, team: null, runs: 3, areaStolen: 0, distance: 24_100, rank: 3 },
];
const prevAwards = { [alice.id]: ['conqueror', 'thief', 'consistent'], [bob.id]: ['distance'] };
const prevRewards = [
  { id: 'seed-reward-tourist', type: 'tourist', scope: 'global' },
  { id: 'seed-reward-master-key', type: 'master_key', scope: 'rest' },
];
await db.execute({
  sql: `insert into club_competitions (id, cycle_number, club_id, mode, status, config, score, result, created_at, finished_at)
        values (?, ?, ?, 'ffa', 'finished', '{}', ?, ?, ?, ?)`,
  args: [prevId, current.cycle.number - 1, club.id, 3_700_000, JSON.stringify({
    mode: 'ffa', standings: prevStandings, total: 3_700_000, winnerUserId: alice.id, mvpUserId: alice.id,
    rewards: { [alice.id]: prevRewards.map((r) => r.type) }, leaguePoints: 1, awards: prevAwards,
  }), new Date(Date.now() - 16 * day).toISOString(), finishedAt],
});
for (const [s, lost, seen] of [[prevStandings[0], 90_000, null], [prevStandings[1], 210_000, finishedAt], [prevStandings[2], 95_000, finishedAt]]) {
  await db.execute({
    sql: `insert into competition_participants (competition_id, user_id, area, bonus, area_stolen, runs, distance, final_rank, joined_at, area_lost, result_seen_at)
          values (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
    args: [prevId, s.userId, s.score, s.areaStolen, s.runs, s.distance, s.rank, new Date(Date.now() - 16 * day).toISOString(), lost, seen],
  });
}
// Alicia ran on 5 different days
for (const [i, daysAgo] of [12, 11, 9, 9, 7, 4].entries()) {
  await db.execute({
    sql: `insert into competition_runs (competition_id, user_id, route_id, started_at, area_gained, area_stolen, distance) values (?, ?, ?, ?, ?, ?, ?)`,
    args: [prevId, alice.id, `seed-previous-run-${i}`, new Date(Date.now() - daysAgo * day).toISOString(), 300_000, 35_000, 8_700],
  });
}
for (const [userId, list] of Object.entries(prevAwards)) {
  for (const award of list) {
    await db.execute({
      sql: `insert into user_awards (user_id, competition_id, award, cycle_number, mode, created_at) values (?, ?, ?, ?, 'ffa', ?)`,
      args: [userId, prevId, award, current.cycle.number - 1, finishedAt],
    });
  }
}
for (const reward of prevRewards) {
  await db.execute({
    sql: `insert into user_powers (id, user_id, competition_id, power_type, treasure_id, status, scope, source, unused_expires_at, created_at)
          values (?, ?, 'season', ?, ?, 'available', ?, 'reward', ?, ?)`,
    args: [reward.id, alice.id, reward.type, prevId, reward.scope, new Date(Date.now() + 12 * day).toISOString(), finishedAt],
  });
}
const pendingResults = await call('GET', '/api/season/results/pending', { token: alice.token });
const summary = pendingResults.results?.[0];
if (pendingResults.results?.length !== 1 || summary.awards.length !== 3 || summary.rewards.length !== 2 || summary.me?.days !== 5 || summary.next?.running !== true) {
  throw new Error(`alice's pending summary: ${JSON.stringify(pendingResults)}`);
}
console.error(`[e2e seed] pending summary for alice: ${summary.awards.map((a) => a.name).join(', ')}; next ${summary.next.modeInfo?.name} (running)`);

console.log(JSON.stringify({ token: alice.token, userId: alice.id }));
