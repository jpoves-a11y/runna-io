// End-to-end test of the new game against the bundled Worker, in-process (queue messages are
// processed right away): global map, clubs, a club competition (steals, powers, rules), the
// anti-cheat, the end of a cycle (scores, rewards, league, map reset), club duels (matchmaking,
// Elo) and the rest phase (chests, challenges), reviews and rebuilds.
//
//   npx esbuild worker/src/index.ts --bundle --format=esm --platform=node --target=node20 \
//     --outfile=scripts/e2e/.build/worker.mjs --alias:@libsql/client/web=@libsql/client --alias:cloudflare:sockets=./scripts/e2e/cloudflare-sockets-stub.mjs --external:@libsql/client
//   rm -f scripts/e2e/.build/season.db
//   DATABASE_URL=file:scripts/e2e/.build/season.db npx drizzle-kit push --force
//   node scripts/e2e/season-test.mjs
import { createClient } from '@libsql/client';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pendingSignup } from './signup.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const databaseUrl = process.env.E2E_DATABASE_URL || `file:${path.join(here, '.build', 'season.db')}`;

let failures = 0;
function check(name, condition, extra = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${condition ? '' : ` ${typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 600)}`}`);
  if (!condition) failures++;
}

globalThis.fetch = async (input) => {
  throw new Error(`external network disabled in e2e: ${String(input instanceof Request ? input.url : input)}`);
};

const DAY = 86400_000;
/** YYYY-MM-DD of the last Friday at least `minDaysAgo` days ago (negative: a future Friday). */
function friday(minDaysAgo) {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - minDaysAgo);
  if (minDaysAgo >= 0) while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() - 1);
  else while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const worker = (await import('./.build/worker.mjs')).default;
const db = createClient({ url: databaseUrl });
const pending = [];
const ctx = { waitUntil: (p) => { pending.push(Promise.resolve(p)); }, passThroughOnException() {} };
const env = {
  DATABASE_URL: databaseUrl,
  ENVIRONMENT: 'test',
  UPSTASH_CRON_SECRET: 'e2e-cron-secret',
  WORKER_URL: 'https://api.example.test',
  // "now" is inside the first competition (day 3-9)
  SEASON_ANCHOR_DATE: friday(2),
  TERRITORY_QUEUE: {
    send: async (body) => {
      await worker.queue({ messages: [{ body, ack() {}, retry() { throw new Error(`queue retry for ${body.type}`); } }] }, env);
    },
  },
};

async function call(method, route, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await worker.fetch(new Request(`http://127.0.0.1:8787${route}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx);
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  while (pending.length) await Promise.allSettled(pending.splice(0));
  return { status: res.status, data };
}
const admin = (route, body = {}) => call('POST', route, { token: 'e2e-cron-secret', body });
const one = async (sqlText, args = []) => (await db.execute({ sql: sqlText, args })).rows[0];
const all = async (sqlText, args = []) => (await db.execute({ sql: sqlText, args })).rows;

async function register(username, name, color) {
  const res = await call('POST', '/api/auth/register/confirm', { body: await pendingSignup(db, { username, name, color }) });
  if (res.status !== 200) throw new Error(`register ${username}: ${JSON.stringify(res.data)}`);
  return { id: res.data.id, token: res.data.token, name };
}

function loop(lat, lng, radius, points = 160) {
  const coords = [];
  for (let i = 0; i <= points; i++) {
    const angle = (2 * Math.PI * i) / points;
    coords.push([lat + (radius / 111320) * Math.sin(angle), lng + (radius / (111320 * Math.cos((lat * Math.PI) / 180))) * Math.cos(angle)]);
  }
  return coords;
}
function length(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const [a, b] = [coords[i - 1], coords[i]];
    const dLat = ((b[0] - a[0]) * Math.PI) / 180;
    const dLng = ((b[1] - a[1]) * Math.PI) / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos((a[0] * Math.PI) / 180) * Math.cos((b[0] * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    total += 2 * 6371008.8 * Math.asin(Math.sqrt(h));
  }
  return total;
}

/** Posts a run that started `startedAt` (ms), at `speedKmh`, with per-point timestamps. */
async function run(user, name, coords, startedAt, { speedKmh = 11, timed = true, extra = {} } = {}) {
  const distance = length(coords);
  const duration = Math.round(distance / (speedKmh / 3.6));
  const pointTimes = [0];
  for (let i = 1; i < coords.length; i++) pointTimes.push(pointTimes[i - 1] + length([coords[i - 1], coords[i]]) / (speedKmh / 3.6));
  const res = await call('POST', '/api/routes', {
    token: user.token,
    body: {
      name, coordinates: coords, distance, duration,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date(startedAt + duration * 1000).toISOString(),
      ...(timed ? { pointTimes } : {}),
      ...extra,
    },
  });
  if (res.status !== 200) return { status: res.status, data: res.data };
  const result = await call('GET', `/api/conquest-result/${res.data.route.id}`, { token: user.token });
  return { status: 200, route: res.data.route, preview: res.data.validation, result: result.data };
}

const C = [41.6488, -0.8891]; // Zaragoza
const users = {};
for (const [key, name, color] of [
  ['ana', 'Ana', '#377EB8'], ['ben', 'Ben', '#E41A1C'], ['cris', 'Cris', '#4DAF4A'],
  ['dani', 'Dani', '#984EA3'], ['eva', 'Eva', '#FF7F00'], ['fede', 'Fede', '#A65628'],
  ['gala', 'Gala', '#F781BF'], ['hugo', 'Hugo', '#999999'],
]) users[key] = await register(key, name, color);
const { ana, ben, cris, dani, eva, fede, gala, hugo } = users;

// ───────────── Locations and clubs ─────────────

for (const u of Object.values(users)) {
  const res = await call('PATCH', '/api/users/me/location', { token: u.token, body: { city: 'Zaragoza', countryCode: 'ES', countryName: 'España', lat: C[0] + 0.01234, lng: C[1] } });
  if (res.status !== 200) throw new Error(`location: ${JSON.stringify(res.data)}`);
}
const relocation = await call('PATCH', '/api/users/me/location', { token: ana.token, body: { city: 'Huesca', countryCode: 'ES', countryName: 'España' } });
check('the home city can only change every 30 days', relocation.status === 409 && !!relocation.data.canChangeAt, relocation);
const homeRow = await one('select home_lat from users where id = ?', [ana.id]);
check('home coordinates are rounded to ~1 km', Math.abs(Number(homeRow.home_lat) - 41.66) < 1e-9, homeRow);
const found = await call('GET', '/api/users/search?query=ana', { token: ben.token });
const publicAna = Array.isArray(found.data) ? found.data.find((u) => u.id === ana.id) : null;
check('home coordinates are never public', !!publicAna && !('homeLat' in publicAna) && !('homeLng' in publicAna) && !('locationUpdatedAt' in publicAna), publicAna);

const crest = { shape: 'classic', pattern: 'stripes', primary: '#16A34A', secondary: '#FFFFFF', icon: 'flame.fill', initials: 'ZR' };
const lockedCrest = await call('POST', '/api/clubs', { token: ana.token, body: { name: 'Zaragoza Runners', crest: { ...crest, icon: 'crown.fill' } } });
check('locked crest pieces are refused', lockedCrest.status === 400, lockedCrest);
const badName = await call('POST', '/api/clubs', { token: ana.token, body: { name: 'ab', crest } });
check('club names need 3+ characters', badName.status === 400, badName);
const club1 = (await call('POST', '/api/clubs', { token: ana.token, body: { name: 'Zaragoza Runners', slogan: 'A por todas', crest, visibility: 'public' } })).data.club;
check('club created with its owner', !!club1?.id && club1.memberCount === 1 && /^[A-Z0-9]{6}$/.test(club1.joinCode), club1);
const dupName = await call('POST', '/api/clubs', { token: dani.token, body: { name: 'zaragoza runners', crest } });
check('club names are unique (any letter case)', dupName.status === 409, dupName);
check('public join', (await call('POST', `/api/clubs/${club1.id}/join`, { token: ben.token, body: {} })).data.joined === true);
check('join with the code', (await call('POST', '/api/clubs/join-code', { token: cris.token, body: { code: club1.joinCode.toLowerCase() } })).data.joined === true);
const twice = await call('POST', '/api/clubs/join-code', { token: cris.token, body: { code: club1.joinCode } });
check('one club at a time', twice.status === 409, twice);

const club2 = (await call('POST', '/api/clubs', { token: dani.token, body: { name: 'Ebro Night Crew', crest: { ...crest, pattern: 'chevron' }, visibility: 'private' } })).data.club;
const evaRequest = await call('POST', `/api/clubs/${club2.id}/join`, { token: eva.token, body: {} });
check('private clubs: joining sends a request', evaRequest.data.requested === true, evaRequest);
const daniView = await call('GET', '/api/clubs/mine', { token: dani.token });
check('the admin sees the request', daniView.data.pendingRequests?.length === 1, daniView.data);
const notAdmin = await call('POST', `/api/clubs/${club2.id}/requests/${evaRequest.data.requestId}/accept`, { token: eva.token, body: {} });
check('only admins accept requests', notAdmin.status === 403, notAdmin);
const accepted = await call('POST', `/api/clubs/${club2.id}/requests/${evaRequest.data.requestId}/accept`, { token: dani.token, body: {} });
check('request accepted', accepted.status === 200, accepted);
const invite = await call('POST', `/api/clubs/${club2.id}/invites`, { token: eva.token, body: { userId: fede.id } });
check('members can invite', invite.data.invited === true, invite);
const fedeView = await call('GET', '/api/clubs/mine', { token: fede.token });
check('the invite reaches the user', fedeView.data.invites?.length === 1, fedeView.data);
check('invite accepted', (await call('POST', `/api/clubs/invites/${fedeView.data.invites[0].id}/accept`, { token: fede.token, body: {} })).status === 200);
const link = await call('POST', `/api/clubs/${club2.id}/invites`, { token: dani.token, body: {} });
check('invite link', /\/club-invite\/[A-Za-z0-9_-]+$/.test(link.data.url), link.data);
const club3 = (await call('POST', '/api/clubs', { token: gala.token, body: { name: 'Solo Gala', crest } })).data.club;
const privateDetail = await call('GET', `/api/clubs/${club2.id}`, { token: hugo.token });
check('private club members are hidden from outsiders', privateDetail.data.members.length === 0 && !privateDetail.data.club.joinCode, privateDetail.data);
const search = await call('GET', '/api/clubs/search?q=zarag', { token: hugo.token });
check('search by name or city finds public clubs only', search.data.clubs.some((c) => c.id === club1.id) && search.data.clubs.every((c) => c.visibility === 'public' && c.id !== club2.id), search.data.clubs.map((c) => c.name));

// ───────────── The competition starts ─────────────

const tick = await admin('/api/admin/season/tick');
check('first tick: one-time reset and start of cycle 0', tick.data.reset === true && tick.data.cycle === 0 && tick.data.phase === 'competition' && tick.data.started?.competitions === 3, tick.data);
const tickAgain = await admin('/api/admin/season/tick');
check('the tick is idempotent', tickAgain.data.reset === false && !tickAgain.data.started, tickAgain.data);
const competitions = await all('select club_id, mode from club_competitions where cycle_number = 0');
const modeOf = Object.fromEntries(competitions.map((r) => [r.club_id, r.mode]));
check('modes: ffa for 3-member clubs, "target" for a club of one', modeOf[club1.id] === 'ffa' && modeOf[club2.id] === 'ffa' && modeOf[club3.id] === 'target', modeOf);

// Runs from the last days count: move the cutoff back and backdate the participants
await admin('/api/admin/season/runs-from', { at: new Date(Date.now() - 4 * DAY).toISOString() });
const season0 = (await call('GET', '/api/season/current', { token: ana.token })).data;
await db.execute({ sql: 'UPDATE competition_participants SET joined_at = ?', args: [season0.cycle.competitionStartsAt] });
const t0 = Math.max(Date.parse(season0.cycle.competitionStartsAt) + 3600_000, Date.now() - 30 * 3600_000);

const old = await run(ana, 'Antes de la temporada', loop(C[0], C[1], 300), Date.now() - 6 * DAY);
check('runs from before the season are refused', old.status === 409 && old.data.error === 'before_season', old);

const a1 = await run(ana, 'Vuelta al Pilar', loop(C[0], C[1], 500), t0);
check('a run conquers global and competition area', a1.result.validation?.status === 'accepted' && a1.result.globalArea?.gained > 700_000 && a1.result.competition?.newArea > 700_000, a1.result);
const anaGlobal1 = Number((await one('select global_area from users where id = ?', [ana.id])).global_area);
const repeat = await run(ana, 'Otra vuelta al Pilar', loop(C[0], C[1], 500), t0 + 3 * 3600_000);
check('repeating a loop adds no global area', repeat.result.globalArea?.gained === 0, repeat.result.globalArea);
const b1 = await run(ben, 'Asalto', loop(C[0] + 0.003, C[1] + 0.003, 450), t0 + 5 * 3600_000);
check('ffa: a club mate steals competition territory', b1.result.competition?.areaStolen > 50_000 && b1.result.victims?.[0]?.userId === ana.id, b1.result);
const anaGlobal2 = Number((await one('select global_area from users where id = ?', [ana.id])).global_area);
check('global area is never stolen', Math.abs(anaGlobal2 - anaGlobal1) < 1, { anaGlobal1, anaGlobal2 });
const d1 = await run(dani, 'Otra ciudad del club 2', loop(C[0] + 0.004, C[1] + 0.004, 450), t0 + 6 * 3600_000);
check('no steals between different clubs', (d1.result.competition?.areaStolen ?? 0) === 0 && d1.result.victims.length === 0, d1.result);
await run(eva, 'Eva por la ribera', loop(C[0] + 0.03, C[1] - 0.01, 300), t0 + 6.5 * 3600_000);
await run(fede, 'Fede en el Actur', loop(C[0] + 0.04, C[1] + 0.01, 300), t0 + 6.7 * 3600_000);

// Anti-cheat
const car = await run(cris, 'En coche', loop(C[0] - 0.02, C[1], 900), t0 + 7 * 3600_000, { speedKmh: 45 });
check('car speed: saved but rejected', car.status === 200 && car.preview.status === 'rejected' && car.result.validation.reasons.includes('too_fast') && car.result.globalArea === null, car.result);
const walk = await run(cris, 'Paseo', loop(C[0] - 0.02, C[1], 300), t0 + 9 * 3600_000, { speedKmh: 4 });
check('walking pace: rejected', walk.result.validation?.status === 'rejected' && walk.result.validation.reasons.includes('too_slow'), walk.result.validation);
const c1 = await run(cris, 'Parque Grande', loop(C[0] - 0.012, C[1], 400), t0 + 11 * 3600_000);
const dup = await run(cris, 'Parque Grande (Strava)', loop(C[0] - 0.012, C[1], 400), t0 + 11 * 3600_000 + 20_000, { timed: false, extra: { name: 'Parque Grande (Strava)' } });
check('the same run imported twice counts once', c1.result.validation.status === 'accepted' && dup.result.validation?.status === 'rejected' && dup.result.validation.reasons.includes('duplicate'), dup.result.validation);
const carRoutes = await call('GET', `/api/routes/${cris.id}`, { token: cris.token });
const listedCar = Array.isArray(carRoutes.data) ? carRoutes.data.find((r) => r.name === 'En coche') : null;
check('rejected runs stay in the history with their reason, timestamps not exposed', listedCar?.validationStatus === 'rejected' && listedCar.validationReasons.includes('too_fast') && !('trackMeta' in listedCar), listedCar && { status: listedCar.validationStatus, reasons: listedCar.validationReasons });

// Powers
async function grant(user, itemId, status = 'available') {
  const id = `it-${itemId}-${user.id.slice(0, 6)}-${Math.random().toString(36).slice(2, 7)}`;
  const scope = itemId.startsWith('title_') || itemId.startsWith('crest_') ? 'cosmetic' : ['explorer', 'wide_trail', 'streak_saver'].includes(itemId) ? 'global' : 'competition';
  await db.execute({
    sql: `insert into user_powers (id, user_id, competition_id, power_type, treasure_id, status, scope, source, unused_expires_at, created_at)
          values (?, ?, 'season', ?, 'test', ?, ?, 'test', ?, ?)`,
    args: [id, user.id, itemId, status, scope, scope === 'cosmetic' ? null : new Date(Date.now() + 3 * DAY).toISOString(), new Date().toISOString()],
  });
  return id;
}
const shield = await grant(ana, 'shield');
const act = await call('POST', `/api/inventory/${shield}/activate`, { token: ana.token, body: {} });
check('shield activated for 24 h', act.status === 200 && !!act.data.activeUntil, act.data);
const again = await call('POST', `/api/inventory/${shield}/activate`, { token: ana.token, body: {} });
check('an item can only be used once', again.status === 409, again);
const b2 = await run(ben, 'Asalto 2', loop(C[0] - 0.002, C[1] - 0.002, 450), t0 + 13 * 3600_000);
check('the shield stops steals', b2.result.competition?.areaStolen === 0, b2.result.competition);
const headStart = await grant(cris, 'head_start');
await call('POST', `/api/inventory/${headStart}/activate`, { token: cris.token, body: {} });
const crisPart = await one('select bonus from competition_participants where user_id = ?', [cris.id]);
check('Ventaja Inicial adds 0.1 km² to the score', Number(crisPart.bonus) === 100_000, crisPart);
const nick = await grant(ana, 'nickname');
const wrongTarget = await call('POST', `/api/inventory/${nick}/activate`, { token: ana.token, body: { targetUserId: dani.id, nickname: 'Lento' } });
check('target powers only aim at rivals of your competition', wrongTarget.status === 400, wrongTarget);
const rightTarget = await call('POST', `/api/inventory/${nick}/activate`, { token: ana.token, body: { targetUserId: ben.id, nickname: 'Ladrón' } });
check('nickname on a rival', rightTarget.status === 200, rightTarget);
const passive = await grant(ana, 'streak_saver');
check('passive items are not activated', (await call('POST', `/api/inventory/${passive}/activate`, { token: ana.token, body: {} })).status === 400);
for (let i = 0; i < 3; i++) await grant(gala, 'magnet');
const capRes = await call('GET', '/api/inventory', { token: gala.token });
check('inventory listing', capRes.data.items.filter((i) => i.status === 'available').length === 3 && capRes.data.cap === 3, capRes.data.items.length);

// Club rules during the competition
const leave = await call('POST', `/api/clubs/${club1.id}/leave`, { token: ben.token, body: {} });
check('nobody leaves a club while competing', leave.status === 409, leave);
const kick = await call('DELETE', `/api/clubs/${club1.id}/members/${ben.id}`, { token: ana.token });
check('nobody is kicked while competing', kick.status === 409, kick);
const late = await call('POST', `/api/clubs/${club1.id}/join`, { token: hugo.token, body: {} });
check('joining after the first 48 h: member now, competes next cycle', late.data.joined === true && late.data.joinedCompetition === false, late.data);
const crestNow = await call('PATCH', `/api/clubs/${club1.id}`, { token: ana.token, body: { crest: { ...crest, icon: 'crown.fill' } } });
check('crest piece still locked', crestNow.status === 400, crestNow);
await grant(hugo, 'crest_icon_crown', 'owned');
const crestUnlocked = await call('PATCH', `/api/clubs/${club1.id}`, { token: ana.token, body: { crest: { ...crest, icon: 'crown.fill' }, slogan: 'Reyes del Ebro' } });
check('a piece unlocked by any member can be used', crestUnlocked.status === 200 && crestUnlocked.data.club.crest.icon === 'crown.fill', crestUnlocked.data);

// Rankings and maps
const world = (await call('GET', '/api/rankings/global?scope=world', { token: ana.token })).data;
check('world ranking: only area, sorted', world.entries.length >= 4 && world.entries.every((e, i, list) => i === 0 || list[i - 1].area >= e.area) && world.entries.every((e) => !('geometry' in e)), world.entries.map((e) => [e.user.name, Math.round(e.area)]));
const cityMonth = (await call('GET', '/api/rankings/global?scope=city&period=month', { token: ana.token })).data;
check('city ranking of the month', cityMonth.label === 'Zaragoza' && cityMonth.entries.length >= 4, cityMonth.label);
const clubRank = (await call('GET', '/api/rankings/global?scope=club', { token: ana.token })).data;
check('club ranking only has club mates', clubRank.entries.every((e) => [ana.id, ben.id, cris.id, hugo.id].includes(e.user.id)), clubRank.entries.map((e) => e.user.name));
const overlays = (await call('GET', '/api/global/territories', { token: ana.token })).data;
check('global overlays only of friends and club mates', overlays.overlays.every((o) => [ben.id, cris.id, hugo.id].includes(o.user.id)) && overlays.overlays.length >= 2, overlays.overlays.map((o) => o.user.name));
const compMap = (await call('GET', '/api/season/map', { token: ana.token })).data;
check('competition map: only my competition', compMap.territories.length >= 2 && compMap.territories.every((t) => [ana.id, ben.id, cris.id].includes(t.userId)), compMap.territories.map((t) => t.userId));
const current = (await call('GET', '/api/season/current', { token: cris.token })).data;
check('standings include bonus and stolen area', current.competition.standings.length === 3 && current.competition.standings.some((s) => s.bonus === 100_000), current.competition.standings.map((s) => [s.user?.name, Math.round(s.score)]));

// ───────────── End of the competition ─────────────

const endTime = Date.parse(season0.cycle.competitionEndsAt) + 10 * 60_000;
const finish = await admin('/api/admin/season/tick', { time: new Date(endTime).toISOString() });
check('end tick finishes cycle 0', finish.data.finished_0 === 3 && finish.data.phase === 'rest', finish.data);
const results = await all('select club_id, mode, status, result from club_competitions where cycle_number = 0');
const r1 = JSON.parse(results.find((r) => r.club_id === club1.id).result);
check('ffa result: ranking, winner, rewards', r1.standings.length === 3 && !!r1.winnerUserId && Object.keys(r1.rewards).length >= 2, { winner: r1.winnerUserId, rewards: r1.rewards });
const r3 = JSON.parse(results.find((r) => r.club_id === club3.id).result);
check('target result: not achieved without runs', r3.achieved === false && r3.target === 1_500_000, r3);
const winnerItems = await all("select power_type from user_powers where user_id = ? and source = 'reward'", [r1.winnerUserId]);
check('the winner got a legendary-tier reward', winnerItems.length >= 1, winnerItems);
const clubAfter = await one('select league_points from clubs where id = ?', [club1.id]);
check('league point for a club where most members ran', Number(clubAfter.league_points) >= 1, clubAfter);
const territoriesLeft = await one('select count(*) as n, (select max(total_area) from users) as m from territories');
check('the competition map is wiped', Number(territoriesLeft.n) === 0 && Number(territoriesLeft.m) === 0, territoriesLeft);
const anaGlobal3 = Number((await one('select global_area from users where id = ?', [ana.id])).global_area);
check('the global map is kept', Math.abs(anaGlobal3 - anaGlobal2) < 1);
const history = (await call('GET', `/api/clubs/${club1.id}/history`, { token: ana.token })).data;
check('club history and trophies', history.history.length === 1 && history.trophies.competitions === 1, history.trophies);
const leaveNow = await call('POST', `/api/clubs/${club1.id}/leave`, { token: hugo.token, body: {} });
check('leaving is allowed in the rest days', leaveNow.status === 200, leaveNow);

// ───────────── Cycle 1: club duels ─────────────

// gala's club gets 2 more members with recent runs (needs 3 active runners for a duel)
await call('POST', `/api/clubs/${club3.id}/join`, { token: hugo.token, body: {} });
const c1Start = Date.parse(season0.cycle.restEndsAt) + 10 * 60_000;
const duelTick = await admin('/api/admin/season/tick', { time: new Date(c1Start).toISOString() });
const duels = await all('select * from club_matches where cycle_number = 1');
check('cycle 1 is a duel cycle: two similar clubs are paired', duelTick.data.started?.duels === 1 && duels.length === 1 && [duels[0].club_a, duels[0].club_b].sort().join() === [club1.id, club2.id].sort().join(), { tick: duelTick.data, duels });
const bye = await one('select mode from club_competitions where cycle_number = 1 and club_id = ?', [club3.id]);
check('a club without a fair rival plays "target"', bye.mode === 'target', bye);
// Scores: club1 runners 1.0 + 0.8 + 0.3 km², club2 runners 4 (capped at 3) + 0.1 + 0 km² (N = 3)
const comp1 = await one('select id from club_competitions where cycle_number = 1 and club_id = ?', [club1.id]);
const comp2 = await one('select id from club_competitions where cycle_number = 1 and club_id = ?', [club2.id]);
for (const [uid, area] of [[ana.id, 1_000_000], [ben.id, 800_000], [cris.id, 300_000]]) await db.execute({ sql: 'update competition_participants set area = ?, runs = 1 where competition_id = ? and user_id = ?', args: [area, comp1.id, uid] });
for (const [uid, area] of [[dani.id, 4_000_000], [eva.id, 100_000], [fede.id, 0]]) await db.execute({ sql: 'update competition_participants set area = ?, runs = 1 where competition_id = ? and user_id = ?', args: [area, comp2.id, uid] });
// Make the stored map areas match (finishing syncs participants from users.total_area)
for (const [uid, area] of [[ana.id, 1_000_000], [ben.id, 800_000], [cris.id, 300_000], [dani.id, 4_000_000], [eva.id, 100_000], [fede.id, 0]]) await db.execute({ sql: 'update users set total_area = ? where id = ?', args: [area, uid] });
const c1End = Date.parse(season0.cycle.restEndsAt) + 10 * DAY + 10 * 60_000;
await admin('/api/admin/season/tick', { time: new Date(c1End).toISOString() });
const match = await one('select * from club_matches where cycle_number = 1');
check('duel scored with N best runners and a cap per runner', Math.round(Number(match.score_a) + Number(match.score_b)) === 2_100_000 + 3_100_000, match);
const winner = match.winner_club_id;
check('the duel winner is club 2 (capped 3 + 0.1 > 2.1)', winner === club2.id, match);
const ratings = Object.fromEntries((await all('select id, rating, league_points from clubs')).map((r) => [r.id, [Number(r.rating), Number(r.league_points)]]));
check('Elo: +16 / -16 between equal ratings, 3 league points to the winner', Math.round(ratings[club2.id][0]) === 1016 && Math.round(ratings[club1.id][0]) === 984 && ratings[club2.id][1] >= 3, ratings);
const duelView = (await call('GET', '/api/season/history', { token: ana.token })).data.history[0];
check('duel result visible in the history', duelView.mode === 'duel' && duelView.result.outcome === 'lost' && duelView.result.opponent?.name === 'Ebro Night Crew', duelView.result);

// ───────────── Rest phase: chests and challenges ─────────────

// A season anchor in the future puts "now" in the preseason (rest features on)
env.SEASON_ANCHOR_DATE = friday(-1);
const madrid = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' });
const today = madrid.format(new Date());
const eveningMadrid = Date.parse(`${today}T19:30:00Z`); // 20:30 or 21:30 Madrid... keep before 21:00 local
const spawnAt = eveningMadrid - 2 * 3600_000;
let chests = 0;
for (let i = 0; i < 10; i++) chests += Number((await admin('/api/admin/season/tick', { time: new Date(spawnAt).toISOString() })).data.chests ?? 0);
check('rest days: chests spawn around the club city, capped per day', chests >= 2 && chests <= 8, chests);
const visible = (await call('GET', '/api/season/map', { token: ana.token })).data.chests;
check('club members see the chests (not the hidden ones)', visible.length >= 1 && visible.every((c) => !c.hidden), visible.length);
const nonMember = (await call('GET', '/api/season/map', { token: (await register('ivan', 'Iván', '#E78AC3')).token })).data.chests;
check('people without a club see no chests', nonMember.length === 0);
const challenges = (await call('GET', '/api/challenges', { token: ana.token })).data.challenges;
check('3 challenges per rest phase', challenges.length === 3, challenges.map((c) => c.type));
// A 10.5 km run at 5:20/km yesterday at 07:30 Madrid, passing by a chest
const chest = visible[0];
const yesterday = madrid.format(new Date(Date.now() - DAY));
const morning = Date.parse(`${yesterday}T06:30:00Z`);
const big = loop(chest.lat, chest.lng + 0.022, 1670, 400); // radius 1.67 km: passes ~0 m from the chest
const before = (await call('GET', '/api/inventory', { token: ana.token })).data.items.length;
const restRun = await run(ana, 'Tirada larga del descanso', big, morning, { speedKmh: 11.25 });
check('a run through a chest collects it', restRun.result.treasuresCollected?.some((t) => t.treasureId === chest.id), restRun.result.treasuresCollected);
const progressed = (await call('GET', '/api/challenges', { token: ana.token })).data.challenges;
// This run (10.5 km at 5:20/km from 07:30, new area) completes these; the others only progress
const completable = ['early_bird', 'long_run', 'fast_5k', 'new_ground'];
check('challenges progress with the run', progressed.filter((c) => c.type !== 'club_run').every((c) => c.progress > 0), progressed.map((c) => [c.type, c.progress, c.status]));
check('challenges this run satisfies are completed', progressed.filter((c) => completable.includes(c.type)).every((c) => c.status === 'completed' && !!c.rewardItem), progressed.map((c) => [c.type, c.status]));
const after = (await call('GET', '/api/inventory', { token: ana.token })).data.items.length;
check('chest and challenge rewards land in the inventory', after > before, { before, after });

// Global boosts
const explorer = await grant(ben, 'explorer');
check('global boosts can be used in the rest days', (await call('POST', `/api/inventory/${explorer}/activate`, { token: ben.token, body: {} })).status === 200);
const benRun = await run(ben, 'Barrio nuevo', loop(C[0] + 0.05, C[1] + 0.05, 350), morning + 3 * 3600_000);
const benRow = await one('select global_bonus_area from users where id = ?', [ben.id]);
const g = benRun.result.globalArea;
check('Explorador adds 50% of the new global area', g.gained > 0 && Math.abs(g.bonus - g.gained * 0.5) < 1 && Math.abs(Number(benRow.global_bonus_area) - g.bonus) < 1, { bonus: benRow.global_bonus_area, result: g });
const usedExplorer = await one('select status from user_powers where id = ?', [explorer]);
check('the boost is used up by the run', usedExplorer.status === 'used', usedExplorer);

// ───────────── Reviews and rebuilds ─────────────

const huge = await run(eva, 'Vuelta enorme', loop(C[0] + 0.1, C[1] - 0.1, 1900), morning + 2 * 3600_000, { speedKmh: 12 });
check('a huge area goes to review but counts', huge.result.validation?.status === 'flagged' && huge.result.validation.reasons.includes('large_area') && huge.result.globalArea.gained > 10_000_000, huge.result.validation);
const flagged = await call('GET', '/api/admin/runs/flagged', { token: 'e2e-cron-secret' });
check('admins list flagged runs', flagged.data.runs.some((r) => r.id === huge.route.id), flagged.data.runs?.length);
const revert = await admin(`/api/admin/runs/${huge.route.id}/review`, { action: 'revert' });
check('reverting removes its area from the global map', revert.data.status === 'rejected' && revert.data.globalArea < 1_000_000, revert.data);
const anaBefore = Number((await one('select global_area from users where id = ?', [ana.id])).global_area);
const del = await call('DELETE', `/api/routes/${ana.id}/${restRun.route.id}`, { token: ana.token });
const anaAfter = Number((await one('select global_area from users where id = ?', [ana.id])).global_area);
check('deleting a run rebuilds the global map without it', del.status === 200 && anaAfter < anaBefore - 1_000_000 && anaAfter > 0, { anaBefore, anaAfter });

// ───────────── Account deletion of a club owner ─────────────

const delAccount = await call('DELETE', `/api/users/${dani.id}`, { token: dani.token });
const club2After = await one('select owner_id, member_count from clubs where id = ?', [club2.id]);
check('deleting the owner hands the club over', delAccount.status === 200 && [eva.id, fede.id].includes(club2After.owner_id) && Number(club2After.member_count) === 2, { status: delAccount.status, club2After });

console.log(failures === 0 ? '\nAll season checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
