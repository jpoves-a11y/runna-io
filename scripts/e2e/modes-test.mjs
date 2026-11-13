// End-to-end test of the competition modes of season phase 2 (Banderas, Derbi, Eliminación,
// Exploradores) against the bundled Worker, in-process. Runs can't be dated in the future, so for
// each mode the season anchor is moved until "now" is day 3 of a cycle of that mode; ticks with an
// explicit time then play the cuts and the close.
//
//   npx esbuild worker/src/index.ts --bundle --format=esm --platform=node --target=node20 \
//     --outfile=scripts/e2e/.build/worker.mjs --alias:@libsql/client/web=@libsql/client --alias:cloudflare:sockets=./scripts/e2e/cloudflare-sockets-stub.mjs --external:@libsql/client
//   rm -f scripts/e2e/.build/modes.db
//   DATABASE_URL=file:scripts/e2e/.build/modes.db npx drizzle-kit push --force
//   node scripts/e2e/modes-test.mjs
import { createClient } from '@libsql/client';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pendingSignup } from './signup.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const databaseUrl = process.env.E2E_DATABASE_URL || `file:${path.join(here, '.build', 'modes.db')}`;

let failures = 0;
function check(name, condition, extra = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${condition ? '' : ` ${typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 700)}`}`);
  if (!condition) failures++;
}

globalThis.fetch = async (input) => {
  throw new Error(`external network disabled in e2e: ${String(input instanceof Request ? input.url : input)}`);
};

const DAY = 86400_000;
const HOUR = 3600_000;
const madridDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
function addDays(ymd, days) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
/** Anchor that makes cycle `index` start 3 days ago (local midnight): "now" is its day 3. */
const anchorFor = (index) => addDays(madridDay(Date.now()), -(3 + 14 * index));

const worker = (await import('./.build/worker.mjs')).default;
const db = createClient({ url: databaseUrl });
const pending = [];
const ctx = { waitUntil: (p) => { pending.push(Promise.resolve(p)); }, passThroughOnException() {} };
const env = {
  DATABASE_URL: databaseUrl,
  ENVIRONMENT: 'test',
  UPSTASH_CRON_SECRET: 'e2e-cron-secret',
  WORKER_URL: 'https://api.example.test',
  // Preseason first (the reset happens on the first tick)
  // These tests check whole ticks at once; budget-test.mjs checks the real 50-subrequest limit
  SUBREQUEST_LIMIT: 100000,
  SEASON_ANCHOR_DATE: addDays(madridDay(Date.now()), 30),
  TERRITORY_QUEUE: {
    send: async (body) => {
      const before = globalThis.__runnaDbStats?.statements ?? 0;
      if (process.env.E2E_SQL_TRACE) globalThis.__runnaDbTrace = [];
      await worker.queue({ messages: [{ body, ack() {}, retry() { throw new Error(`queue retry for ${body.type}`); } }] }, env);
      const used = (globalThis.__runnaDbStats?.statements ?? 0) - before;
      queueUsed += used;
      if (process.env.E2E_SUBREQUEST_LOG) console.log(`[subrequests] ${used} QUEUE ${body.type}`);
      if (process.env.E2E_SQL_TRACE && used >= 55) for (const line of globalThis.__runnaDbTrace) console.log(`[sql] ${line}`);
      globalThis.__runnaDbTrace = null;
    },
  },
};

let queueUsed = 0;
async function call(method, route, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const before = globalThis.__runnaDbStats?.statements ?? 0;
  const queuedBefore = queueUsed;
  const res = await worker.fetch(new Request(`http://127.0.0.1:8787${route}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx);
  if (process.env.E2E_SUBREQUEST_LOG) {
    const used = (globalThis.__runnaDbStats?.statements ?? 0) - before - (queueUsed - queuedBefore);
    console.log(`[subrequests] ${used} ${method} ${route.split('?')[0]}`);
  }
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  while (pending.length) await Promise.allSettled(pending.splice(0));
  return { status: res.status, data };
}
const admin = (route, body = {}) => call('POST', route, { token: 'e2e-cron-secret', body });
const tick = (time) => admin('/api/admin/season/tick', time ? { time: new Date(time).toISOString() } : {});
const one = async (sqlText, args = []) => (await db.execute({ sql: sqlText, args })).rows[0];
const all = async (sqlText, args = []) => (await db.execute({ sql: sqlText, args })).rows;

async function register(username, name, color) {
  const res = await call('POST', '/api/auth/register/confirm', { body: await pendingSignup(db, { username, name, color }) });
  if (res.status !== 200) throw new Error(`register ${username}: ${JSON.stringify(res.data)}`);
  return { id: res.data.id, token: res.data.token, name };
}

function loop(lat, lng, radius, points = 120) {
  const coords = [];
  for (let i = 0; i <= points; i++) {
    const angle = (2 * Math.PI * i) / points;
    coords.push([lat + (radius / 111320) * Math.sin(angle), lng + (radius / (111320 * Math.cos((lat * Math.PI) / 180))) * Math.cos(angle)]);
  }
  return coords;
}
/** A loop whose west end passes exactly through (lat, lng). */
const loopThrough = (lat, lng, radius) => loop(lat, lng + radius / (111320 * Math.cos((lat * Math.PI) / 180)), radius);
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

async function run(user, name, coords, startedAt, { speedKmh = 11 } = {}) {
  const distance = length(coords);
  const duration = Math.round(distance / (speedKmh / 3.6));
  const pointTimes = [0];
  for (let i = 1; i < coords.length; i++) pointTimes.push(pointTimes[i - 1] + length([coords[i - 1], coords[i]]) / (speedKmh / 3.6));
  const res = await call('POST', '/api/routes', {
    token: user.token,
    body: {
      name, coordinates: coords, distance, duration, pointTimes,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date(startedAt + duration * 1000).toISOString(),
    },
  });
  if (res.status !== 200) return { status: res.status, data: res.data, result: {} };
  const result = await call('GET', `/api/conquest-result/${res.data.route.id}`, { token: user.token });
  return { status: 200, route: res.data.route, result: result.data };
}

async function grant(user, itemId) {
  const id = `it-${itemId}-${user.id.slice(0, 6)}-${Math.random().toString(36).slice(2, 7)}`;
  await db.execute({
    sql: `insert into user_powers (id, user_id, competition_id, power_type, treasure_id, status, scope, source, unused_expires_at, created_at)
          values (?, ?, 'season', ?, 'test', 'available', 'competition', 'test', ?, ?)`,
    args: [id, user.id, itemId, new Date(Date.now() + 3 * DAY).toISOString(), new Date().toISOString()],
  });
  return id;
}

const Z = [41.6488, -0.8891]; // Zaragoza
const H = [42.1401, -0.4089]; // Huesca

// ───────────── Setup: reset, users, clubs, a run each (activity) ─────────────

check('first tick: one-time reset (preseason)', (await tick()).data.reset === true);
await admin('/api/admin/season/runs-from', { at: new Date(Date.now() - 40 * DAY).toISOString() });

const users = {};
for (const [key, name, city] of [
  ['ana', 'Ana', 'Z'], ['ben', 'Ben', 'Z'], ['cris', 'Cris', 'Z'], ['dani', 'Dani', 'Z'], ['eva', 'Eva', 'Z'], ['fede', 'Fede', 'Z'],
  ['gala', 'Gala', 'Z'], ['hugo', 'Hugo', 'Z'], ['iris', 'Iris', 'Z'],
  ['jon', 'Jon', 'H'], ['kai', 'Kai', 'H'], ['lia', 'Lía', 'H'],
]) {
  users[key] = await register(key, name, '#377EB8');
  const [lat, lng] = city === 'Z' ? Z : H;
  const res = await call('PATCH', '/api/users/me/location', { token: users[key].token, body: { city: city === 'Z' ? 'Zaragoza' : 'Huesca', countryCode: 'ES', countryName: 'España', lat, lng } });
  if (res.status !== 200) throw new Error(`location ${key}: ${JSON.stringify(res.data)}`);
}
const { ana, ben, cris, dani, eva, fede, gala, hugo, iris, jon, kai, lia } = users;
const crest = { shape: 'classic', pattern: 'stripes', primary: '#16A34A', secondary: '#FFFFFF', icon: 'flame.fill', initials: 'ZR' };
const clubA = (await call('POST', '/api/clubs', { token: ana.token, body: { name: 'Corredores del Ebro', crest } })).data.club;
for (const u of [ben, cris, dani, eva, fede]) await call('POST', `/api/clubs/${clubA.id}/join`, { token: u.token, body: {} });
const clubB = (await call('POST', '/api/clubs', { token: gala.token, body: { name: 'Ebro Night Crew', crest } })).data.club;
for (const u of [hugo, iris]) await call('POST', `/api/clubs/${clubB.id}/join`, { token: u.token, body: {} });
const clubC = (await call('POST', '/api/clubs', { token: jon.token, body: { name: 'Huesca Trail', crest } })).data.club;
for (const u of [kai, lia]) await call('POST', `/api/clubs/${clubC.id}/join`, { token: u.token, body: {} });
check('three clubs: two in Zaragoza, one in Huesca', clubA?.city === 'Zaragoza' && clubB?.city === 'Zaragoza' && clubC?.city === 'Huesca', [clubA?.city, clubB?.city, clubC?.city]);
// Everybody runs (5 days ago): active for every competition below
let k = 0;
for (const u of Object.values(users)) {
  const home = [jon, kai, lia].includes(u) ? H : Z;
  const res = await run(u, 'Rodaje', loop(home[0] - 0.05 - 0.01 * k, home[1] - 0.05, 300), Date.now() - 5 * DAY + k * HOUR);
  k++;
  if (res.status !== 200) throw new Error(`activity run: ${JSON.stringify(res.data)}`);
}
// Members joined long ago
await db.execute({ sql: 'UPDATE club_members SET joined_at = ?', args: [new Date(Date.now() - 30 * DAY).toISOString()] });

/** Moves the calendar so "now" is day 3 of cycle `index`, starts it and backdates the participants. */
async function startCycleOfMode(index, mode) {
  env.SEASON_ANCHOR_DATE = anchorFor(index);
  const started = await tick();
  const season = (await call('GET', '/api/season/current', { token: ana.token })).data;
  await db.execute({ sql: 'UPDATE competition_participants SET joined_at = ? WHERE competition_id IN (SELECT id FROM club_competitions WHERE cycle_number = ?)', args: [season.cycle.competitionStartsAt, index] });
  check(`cycle ${index} is ${mode}`, started.data.cycle === index && started.data.phase === 'competition' && season.cycle.mode === mode, { tick: started.data, cycle: season.cycle });
  return { start: Date.parse(season.cycle.competitionStartsAt), close: Date.parse(season.cycle.competitionClosesAt), started: started.data };
}
const modeOf = async (index, club) => (await one('select mode from club_competitions where cycle_number = ? and club_id = ?', [index, club.id]))?.mode;
const competitionOf = async (index, club) => one('select * from club_competitions where cycle_number = ? and club_id = ?', [index, club.id]);

// ───────────── Banderas ─────────────

{
  const { start, close } = await startCycleOfMode(2, 'flags');
  check('Banderas for every club with 2+ runners', (await modeOf(2, clubA)) === 'flags' && (await modeOf(2, clubB)) === 'flags' && (await modeOf(2, clubC)) === 'flags');
  const compA = await competitionOf(2, clubA);
  const flags = await all('select * from competition_flags where competition_id = ? order by idx', [compA.id]);
  check('6 runners: 5 flags, around the club, 300 m apart', flags.length === 5, flags.length);
  const hFlags = await all('select f.lat from competition_flags f join club_competitions c on c.id = f.competition_id where c.cycle_number = 2 and c.club_id = ?', [clubC.id]);
  check("3 runners: 4 flags; Huesca's are around Huesca", hFlags.length === 4 && hFlags.every((f) => Math.abs(Number(f.lat) - H[0]) < 0.05), hFlags);
  const [fa] = flags;
  const small = (u, label, at) => run(u, label, loopThrough(Number(fa.lat), Number(fa.lng), 60), at, { speedKmh: 9 });
  const a1 = await small(ana, 'Bandera de Ana', start + 2 * HOUR);
  check('passing within 120 m captures the flag', a1.result.competition?.flags?.some((f) => f.flagId === fa.id), a1.result.competition);
  const b1 = await small(ben, 'Ben roba la bandera', start + 10 * HOUR);
  check('another runner takes it, and knows from whom', b1.result.competition?.flags?.some((f) => f.flagId === fa.id && f.from === ana.id), b1.result.competition);
  // A late import of an earlier run: Cris passed by it before Ana
  const c1 = await small(cris, 'Cris (importada tarde)', start + 1 * HOUR);
  check('a late import lands in its place in the timeline', c1.result.competition?.flags?.some((f) => f.flagId === fa.id), c1.result.competition);
  const view = (await call('GET', '/api/season/current', { token: ana.token })).data.competition;
  const score = (u) => view.standings.find((s) => s.userId === u.id)?.score ?? 0;
  check('scores are hours with the flag: Cris 1 h, Ana 8 h', score(cris) === 1 && score(ana) === 8, view.standings.map((s) => [s.user?.name, s.score]));
  check('Ben holds it now and leads', view.flags.find((f) => f.id === fa.id)?.holderId === ben.id && view.standings[0].userId === ben.id, view.flags);
  // Escudo protects the flags of its holder
  const shield = await grant(ben, 'shield');
  check('Escudo can be used in Banderas', (await call('POST', `/api/inventory/${shield}/activate`, { token: ben.token, body: {} })).status === 200);
  const d1 = await small(dani, 'Dani contra el escudo', start + 30 * HOUR);
  check('a flag held behind an Escudo cannot be taken', !(d1.result.competition?.flags ?? []).some((f) => f.flagId === fa.id), d1.result.competition);
  const doubleArea = await grant(ana, 'double_area');
  check('map powers are refused in Banderas', (await call('POST', `/api/inventory/${doubleArea}/activate`, { token: ana.token, body: {} })).status === 409);
  const map = (await call('GET', '/api/season/map', { token: dani.token })).data;
  check('the map shows the flags and who holds them, no territories', map.mode === 'flags' && map.flags.length === 5 && map.territories.length === 0 && map.flags.some((f) => f.holderId === ben.id), { flags: map.flags?.length, territories: map.territories?.length });
  const closeTick = await tick(close + 10 * 60_000);
  check('Banderas closes', closeTick.data.finished_2 === 3, closeTick.data);
  const result = JSON.parse((await competitionOf(2, clubA)).result);
  check('the most hours wins (Ben)', result.winnerUserId === ben.id && result.standings[0].userId === ben.id, result.standings?.map((s) => [s.name, s.score]));
  check('Banderas: Ben is the Abanderado; no area awards in a mode without map', result.awards?.[ben.id]?.includes('flagbearer')
    && !Object.values(result.awards ?? {}).flat().some((a) => ['conqueror', 'thief', 'wall'].includes(a)), result.awards);
}

// ───────────── Derbi ─────────────

{
  const { start, close, started } = await startCycleOfMode(4, 'derby');
  check('the two Zaragoza clubs play a Derbi; Huesca, without a rival, "Objetivo común"',
    (await modeOf(4, clubA)) === 'derby' && (await modeOf(4, clubB)) === 'derby' && (await modeOf(4, clubC)) === 'target' && started.started?.duels === 1,
    { a: await modeOf(4, clubA), b: await modeOf(4, clubB), c: await modeOf(4, clubC), started: started.started });
  const centre = [Z[0] + 0.02, Z[1] + 0.02];
  const a1 = await run(ana, 'Derbi: Ana', loop(centre[0], centre[1], 450), start + 4 * HOUR);
  check('the Derbi conquers on the shared map', a1.result.competition?.newArea > 400_000, a1.result.competition);
  const g1 = await run(gala, 'Derbi: Gala', loop(centre[0] + 0.002, centre[1], 450), start + 6 * HOUR);
  check('a rival club steals', g1.result.competition?.areaStolen > 0 && g1.result.victims?.some((v) => v.userId === ana.id), g1.result);
  const lost = await one('select p.area_lost from competition_participants p join club_competitions c on c.id = p.competition_id where c.cycle_number = 4 and c.club_id = ? and p.user_id = ?', [clubA.id, ana.id]);
  check("the victim's loss is kept in her own club's competition", Number(lost?.area_lost) > 0, lost);
  const b1 = await run(ben, 'Derbi: Ben', loop(centre[0] - 0.001, centre[1], 450), start + 8 * HOUR);
  check('nobody steals from a clubmate in the Derbi', !(b1.result.victims ?? []).some((v) => v.userId === ana.id), b1.result.victims);
  const map = (await call('GET', '/api/season/map', { token: ana.token })).data;
  check("the map shows the rival club's zones, marked", map.territories.some((t) => t.userId === gala.id && t.rival === true) && map.territories.some((t) => t.userId === ana.id && !t.rival), map.territories.map((t) => [t.userId, t.rival]));
  const view = (await call('GET', '/api/season/current', { token: ana.token })).data.competition;
  check('the Derbi shows both clubs\' scores', view.mode === 'derby' && view.duel?.opponent?.id === clubB.id && view.duel.myClubScore > 0 && view.duel.opponentScore > 0, view.duel);
  // ── Competition powers ──
  const activate = async (u, itemId, extra = {}) => call('POST', `/api/inventory/${await grant(u, itemId)}/activate`, { token: u.token, body: extra });
  check('Emboscada and Venganza ready', (await activate(ana, 'ambush')).status === 200 && (await activate(ben, 'revenge')).status === 200);
  const h1 = await run(hugo, 'Derbi: Hugo', loop(centre[0] - 0.004, centre[1], 450), start + 9 * HOUR);
  check('Hugo steals from Ana and Ben', ['ana', 'ben'].every((k) => h1.result.victims?.some((v) => v.userId === users[k].id && v.stolenArea > 0)), h1.result.victims);
  const trap = await one("select metadata, status from user_powers where user_id = ? and power_type = 'sabotage' and source = 'ambush'", [ana.id]);
  check("Emboscada: the thief is sabotaged at once", trap?.status === 'active' && JSON.parse(trap.metadata).targetUserId === hugo.id, trap);
  const ambushUsed = await one("select status from user_powers where user_id = ? and power_type = 'ambush' and activated_at is not null", [ana.id]);
  check('Emboscada works once', ambushUsed.status === 'used', ambushUsed);
  const revengeRow = await one("select metadata from user_powers where user_id = ? and power_type = 'revenge' and status = 'active'", [ben.id]);
  check('Venganza remembers who stole', JSON.parse(revengeRow?.metadata || '{}').targets?.includes(hugo.id), revengeRow);
  const benBefore = Number((await one('select p.bonus from competition_participants p join club_competitions c on c.id = p.competition_id where c.cycle_number = 4 and p.user_id = ?', [ben.id])).bonus);
  const b2 = await run(ben, 'Derbi: Ben se venga', loop(centre[0] - 0.006, centre[1], 450), start + 11 * HOUR);
  const benAfter = Number((await one('select p.bonus from competition_participants p join club_competitions c on c.id = p.competition_id where c.cycle_number = 4 and p.user_id = ?', [ben.id])).bonus);
  check('Venganza: stealing back counts double (the extra goes to the score)', b2.result.victims?.some((v) => v.userId === hugo.id) && benAfter - benBefore > 1000, { victims: b2.result.victims, benBefore, benAfter });
  check('Saqueo ready', (await activate(gala, 'plunder')).status === 200);
  const g2 = await run(gala, 'Derbi: saqueo', loop(centre[0], centre[1] + 0.003, 700), start + 12 * HOUR);
  const plundered = await one("select power_type from user_powers where user_id = ? and source = 'plunder'", [gala.id]);
  check('Saqueo: a big steal wins an item', g2.result.competition?.areaStolen >= 100_000 && !!plundered, { stolen: g2.result.competition?.areaStolen, plundered });
  const fortsBefore = Number((await one('select count(*) as n from territory_fortifications where user_id = ?', [gala.id])).n);
  const bastion = await activate(gala, 'bastion');
  check('Bastión applied', bastion.status === 200, bastion);
  const fortsAfter = Number((await one('select count(*) as n from territory_fortifications where user_id = ?', [gala.id])).n);
  check('Bastión: 3 layers on the largest zone', fortsAfter - fortsBefore === 3, { fortsBefore, fortsAfter });
  await run(hugo, 'Derbi: Hugo saboteado', loop(centre[0] + 0.03, centre[1] + 0.03, 300), start + 13 * HOUR);
  const trapAfter = await one("select status from user_powers where user_id = ? and power_type = 'sabotage' and source = 'ambush'", [ana.id]);
  check("the ambush's sabotage is used by the thief's next run", trapAfter.status === 'used', trapAfter);
  check('Radar on', (await activate(ana, 'radar')).status === 200);
  const radar = (await call('GET', '/api/season/radar', { token: ana.token })).data;
  check("Radar: the last run of every rival of the other club", radar.active === true && radar.rivals.length === 3 && radar.rivals.some((r) => r.user?.id === gala.id && r.route?.name === 'Derbi: saqueo'), radar.rivals?.map((r) => [r.user?.name, r.route?.name]));
  check('Muralla del Club is only for Por equipos and Derbi (here: yes)', (await activate(iris, 'club_wall')).status === 200);
  const d1 = await run(dani, 'Derbi: contra la muralla', loop(centre[0], centre[1] + 0.003, 700), start + 15 * HOUR);
  check('Muralla del Club: nobody steals from the rival club', (d1.result.victims ?? []).every((v) => ![gala, hugo, iris].some((u) => u.id === v.userId)), d1.result.victims);
  check('Doble o Nada ready', (await activate(cris, 'double_or_nothing')).status === 200);
  const short = await run(cris, 'Derbi: corta', loop(centre[0] + 0.06, centre[1] - 0.06, 300), start + 17 * HOUR);
  check('Doble o Nada: a short run conquers half', short.result.competition?.newArea > 0 && short.result.competition.newArea < 0.6 * Math.PI * 300 * 300, short.result.competition);

  const closeTick = await tick(close + 10 * 60_000);
  check('the Derbi closes (and Huesca\'s objective)', closeTick.data.finished_4 === 3, closeTick.data);
  const match = await one('select * from club_matches where cycle_number = 4');
  const resultA = JSON.parse((await competitionOf(4, clubA)).result);
  check('the Derbi is scored like a duel, with Elo and league points', match.status === 'finished' && resultA.mode === 'derby' && ['won', 'lost', 'draw'].includes(resultA.outcome), { match, outcome: resultA.outcome });
}

// ───────────── Eliminación ─────────────

{
  const { start, close } = await startCycleOfMode(5, 'elimination');
  check('6 runners play Eliminación; clubs of 3, "Todos contra todos"', (await modeOf(5, clubA)) === 'elimination' && (await modeOf(5, clubB)) === 'ffa' && (await modeOf(5, clubC)) === 'ffa');
  const compId = (await competitionOf(5, clubA)).id;
  const at = (h) => start + h * HOUR;
  // Window 1 (days 1-2): everyone but Fede runs, different sizes
  const window1 = [[ana, 520, 12], [ben, 470, 14], [cris, 420, 16], [dani, 370, 18], [eva, 320, 20]];
  let i = 0;
  for (const [u, r, h] of window1) await run(u, 'Tramo 1', loop(Z[0] + 0.03 + 0.012 * i++, Z[1] - 0.03, r), at(h));
  // "Now" is day 3: the first cut (day 2) is due
  await tick();
  const fallen1 = await all('select user_id, eliminated_cut from competition_participants where competition_id = ? and eliminated_cut is not null', [compId]);
  check('cut 1 (6 left, 5 cuts): 1 falls, the one who did not run', fallen1.length === 1 && fallen1[0].user_id === fede.id && Number(fallen1[0].eliminated_cut) === 1, fallen1);
  const fedeRun = await run(fede, 'Fede tras caer', loop(Z[0] - 0.03, Z[1] + 0.03, 300), at(60));
  check('a fallen runner only adds to the global map', fedeRun.result.competition === null && fedeRun.result.competitionNote === 'eliminated' && fedeRun.result.globalArea?.gained > 0, fedeRun.result);
  // Window 2 (days 3-4): Eva doesn't run
  i = 0;
  for (const [u, r, h] of [[ana, 300, 50], [ben, 280, 52], [cris, 260, 54], [dani, 240, 56]]) await run(u, 'Tramo 2', loop(Z[0] - 0.02 - 0.012 * i++, Z[1] + 0.05, r), at(h));
  const status = (await call('GET', '/api/season/current', { token: eva.token })).data.competition.elimination;
  check('the app sees the next cut, how many fall and the danger zone', status.next?.index === 2 && status.next.falls === 1 && status.window.find((w) => w.userId === eva.id)?.danger === true, status);
  const evaTerritory = await one('select count(*) as n from territories where user_id = ?', [eva.id]);
  const cut2 = await tick(at(98)); // cut 2 at 96 h, processed 2 h later
  const evaRow = await one('select eliminated_cut from competition_participants where competition_id = ? and user_id = ?', [compId, eva.id]);
  const evaAfter = await one('select count(*) as n, (select total_area from users where id = ?) as area from territories where user_id = ?', [eva.id, eva.id]);
  check('cut 2 (5 left, 4 cuts): Eva falls and her zones are freed', Number(evaRow.eliminated_cut) === 2 && Number(evaTerritory.n) > 0 && Number(evaAfter.n) === 0 && Number(evaAfter.area) === 0, { cut2: cut2.data, evaRow, evaTerritory, evaAfter });
  // Warning 6 hours before cut 3, once
  await tick(at(141));
  const warned = JSON.parse((await one('select config from club_competitions where id = ?', [compId])).config).warned ?? [];
  check('the danger zone is warned before the cut', warned.includes(3), warned);
  await tick(at(146)); // cut 3 (144 h)
  await tick(at(194)); // cut 4 (192 h)
  const left = await all('select user_id from competition_participants where competition_id = ? and eliminated_cut is null', [compId]);
  check('cuts 3 and 4: one each, two left for the final', left.length === 2, left);
  const closeTick = await tick(close + 10 * 60_000);
  check('Eliminación closes', closeTick.data.finished_5 === 3, closeTick.data);
  const result = JSON.parse((await competitionOf(5, clubA)).result);
  const cuts = result.cuts.map((c) => c.eliminated.length);
  check('5 cuts: 1·1·1·1·1, exactly one left standing', JSON.stringify(cuts) === '[1,1,1,1,1]' && !!result.winnerUserId, cuts);
  check('the last one standing wins; the order follows the cuts', result.standings[0].userId === result.winnerUserId && result.standings.at(-1).userId === fede.id && result.standings.at(-2).userId === eva.id, result.standings.map((s) => [s.name, s.eliminatedCut]));
  check('the winner and the finalist get rewards', (result.rewards[result.winnerUserId] ?? []).length >= 1 && (result.rewards[result.standings[1].userId] ?? []).length >= 1, result.rewards);
  check('Eliminación: the last one standing is the Superviviente', result.awards?.[result.winnerUserId]?.includes('survivor')
    && Object.entries(result.awards ?? {}).every(([id, list]) => id === result.winnerUserId || !list.includes('survivor')), result.awards);
}

// ───────────── Exploradores ─────────────

{
  const { start, close } = await startCycleOfMode(6, 'explorers');
  check('Exploradores for every club', (await modeOf(6, clubA)) === 'explorers' && (await modeOf(6, clubB)) === 'explorers');
  // In this test every cycle shares the same real days: count only the runs from here on
  await db.execute({ sql: 'UPDATE competition_participants SET joined_at = ? WHERE competition_id IN (SELECT id FROM club_competitions WHERE cycle_number = 6)', args: [new Date(start + 63 * HOUR).toISOString()] });
  const far = await run(ana, 'Tierra nueva', loop(Z[0] + 0.15, Z[1] + 0.15, 500), start + 64 * HOUR);
  check('the new global area of the run is its score', far.result.competition?.mode === 'explorers' && far.result.competition.explored > 700_000 && far.result.competition.newArea === 0, far.result.competition);
  // Ben repeats his first loop of the Eliminación: nothing new on his global map
  const repeat = await run(ben, 'Lo de siempre', loop(Z[0] + 0.03 + 0.012, Z[1] - 0.03, 470), start + 66 * HOUR);
  check('repeating known ground scores nothing', repeat.result.competition?.explored === 0, repeat.result.competition);
  const doubleArea = await grant(ana, 'double_area');
  check('competition powers are refused in Exploradores', (await call('POST', `/api/inventory/${doubleArea}/activate`, { token: ana.token, body: {} })).status === 409);
  const view = (await call('GET', '/api/season/current', { token: ana.token })).data.competition;
  check('standings by new global area', view.standings[0].userId === ana.id && view.standings[0].score > 700_000 && (view.standings.find((s) => s.userId === ben.id)?.score ?? -1) === 0, view.standings.map((s) => [s.user?.name, Math.round(s.score)]));
  const map = (await call('GET', '/api/season/map', { token: ana.token })).data;
  check('no competition map in Exploradores', map.mode === 'explorers' && map.territories.length === 0, map.territories?.length);
  const closeTick = await tick(close + 10 * 60_000);
  const result = JSON.parse((await competitionOf(6, clubA)).result);
  check('Exploradores closes: the explorer wins', closeTick.data.finished_6 === 3 && result.winnerUserId === ana.id, { tick: closeTick.data, winner: result.winnerUserId });
  check('Exploradores: Ana is the Exploradora', result.awards?.[ana.id]?.includes('explorer'), result.awards);
}

// ───────────── Global powers ─────────────

{
  // On a day 8 days ago: far from every other run of the test
  const day = addDays(madridDay(Date.now()), -8);
  const at = (hhmm) => Date.parse(`${day}T${hhmm}:00Z`);
  const activate = async (u, itemId) => call('POST', `/api/inventory/${await grant(u, itemId)}/activate`, { token: u.token, body: {} });
  // Turista: only far from home (Madrid, 270 km), and it waits for such a run
  check('Turista ready (twice)', (await activate(ana, 'tourist')).status === 200 && (await activate(ben, 'tourist')).status === 200);
  const madrid = await run(ana, 'Madrid', loop(40.4168, -3.7038, 400), at('10:00'));
  check('Turista: far from home, the new area counts double', Math.abs((madrid.result.globalArea?.boosts?.tourist ?? 0) - madrid.result.globalArea.gained) < 1, madrid.result.globalArea);
  const nearHome = await run(ben, 'Cerca de casa', loop(Z[0] + 0.07, Z[1] + 0.07, 400), at('11:00'));
  const benTourist = await one("select status from user_powers where user_id = ? and power_type = 'tourist' and activated_at is not null", [ben.id]);
  check('Turista: near home it does nothing and keeps waiting', !nearHome.result.globalArea?.boosts?.tourist && benTourist.status === 'active', { boosts: nearHome.result.globalArea?.boosts, benTourist });
  // Alba: before 8:00
  check('Alba ready', (await activate(cris, 'dawn')).status === 200);
  const early = await run(cris, 'Madrugón', loop(Z[0] + 0.08, Z[1] - 0.08, 400), at('05:00'));
  check('Alba: an early run gets 20% more', Math.abs((early.result.globalArea?.boosts?.dawn ?? 0) - 0.2 * early.result.globalArea.gained) < 1, early.result.globalArea);
  // Expedición: Dani runs with Eva (club mates): both get the extra
  const evaBonusBefore = Number((await one('select global_bonus_area from users where id = ?', [eva.id])).global_bonus_area);
  check('Expedición ready', (await activate(dani, 'expedition')).status === 200);
  const together = loop(Z[0] - 0.09, Z[1] + 0.09, 400);
  await run(eva, 'Con Dani', together, at('12:00'));
  const exp = await run(dani, 'Con Eva', together, at('12:01'));
  const evaBonusAfter = Number((await one('select global_bonus_area from users where id = ?', [eva.id])).global_bonus_area);
  check('Expedición: the runner and the companion get 25% more', exp.result.globalArea?.boosts?.expedition > 0 && Math.abs((evaBonusAfter - evaBonusBefore) - exp.result.globalArea.boosts.expedition) < 1, { boosts: exp.result.globalArea?.boosts, evaBonusBefore, evaBonusAfter });
  // The gift survives a rebuild of Eva's map (e.g. after deleting one of her runs)
  const evaRun = await one("select id from routes where user_id = ? and name = 'Rodaje'", [eva.id]);
  await call('DELETE', `/api/routes/${eva.id}/${evaRun.id}`, { token: eva.token });
  const evaBonusRebuilt = Number((await one('select global_bonus_area from users where id = ?', [eva.id])).global_bonus_area);
  check("Expedición: the companion's extra is kept when their map is rebuilt", Math.abs(evaBonusRebuilt - evaBonusAfter) < 1, { evaBonusAfter, evaBonusRebuilt });
  // Cartógrafo: an out-and-back also counts a 25 m strip
  const line = (lat, lng) => {
    const pts = [];
    for (let i = 0; i <= 60; i++) pts.push([lat + i * 0.0003, lng]);
    for (let i = 60; i >= 0; i--) pts.push([lat + i * 0.0003, lng + 0.00001]);
    return pts;
  };
  const plain = await run(fede, 'Ida y vuelta', line(Z[0] - 0.12, Z[1] - 0.12), at('13:00'));
  check('Cartógrafo ready', (await activate(fede, 'cartographer')).status === 200);
  const wide = await run(fede, 'Ida y vuelta (Cartógrafo)', line(Z[0] - 0.12, Z[1] - 0.10), at('14:00'));
  check('Cartógrafo: the strip along the route counts', wide.result.globalArea?.gained > (plain.result.globalArea?.gained ?? 0) + 50_000, { plain: plain.result.globalArea?.gained, wide: wide.result.globalArea?.gained });
  // Brújula
  const compassOff = (await call('GET', '/api/global/compass', { token: kai.token })).data;
  check('Brújula ready', compassOff.active === false && (await activate(kai, 'compass')).status === 200);
  const compass = (await call('GET', '/api/global/compass', { token: kai.token })).data;
  check('Brújula: 3 spots not explored yet', compass.active === true && compass.spots.length === 3, compass);
}

// ───────────── Rest-day powers ─────────────

{
  // "Now" is a rest day (day 11 of cycle 7)
  env.SEASON_ANCHOR_DATE = addDays(madridDay(Date.now()), -(11 + 14 * 7));
  const today = madridDay(Date.now());
  // In the evening a city is due most of its daily chests (one per tick)
  let spawned;
  for (let n = 0; n < 3; n++) spawned = await tick(Date.parse(`${today}T19:00:00Z`));
  const chests = await all("select * from treasures where active = 1 and city_key = 'ES:zaragoza' order by spawned_at");
  check('rest days: chests around Zaragoza', spawned.data.phase === 'rest' && chests.length >= 2, { tick: spawned.data, chests: chests.length });
  // The test ticked in the evening: make them all public now (one is made new again below)
  await db.execute({ sql: 'update treasures set hidden = 0, public_at = ?', args: [new Date(Date.now() - 60_000).toISOString()] });
  const [first, second] = chests;
  const activate = async (u, itemId) => call('POST', `/api/inventory/${await grant(u, itemId)}/activate`, { token: u.token, body: {} });
  // Mapa del Tesoro: a chest that is not public yet is only seen with it
  await db.execute({ sql: 'update treasures set public_at = ? where id = ?', args: [new Date(Date.now() + HOUR).toISOString(), second.id] });
  const before = (await call('GET', '/api/season/map', { token: ana.token })).data.chests.map((c) => c.id);
  check('a new chest is hidden from everybody for its first hour', !before.includes(second.id) && before.includes(first.id), before);
  check('Mapa del Tesoro ready', (await activate(ana, 'treasure_map')).status === 200);
  const after = (await call('GET', '/api/season/map', { token: ana.token })).data.chests.map((c) => c.id);
  check('Mapa del Tesoro: seen before everybody else', after.includes(second.id), after);
  // Llave Maestra + Botín Doble: a run passing 500 m from the chest opens it, and it gives two items
  check('Llave Maestra and Botín Doble ready', (await activate(ana, 'master_key')).status === 200 && (await activate(ana, 'double_loot')).status === 200);
  const lat = Number(first.lat);
  const lng = Number(first.lng);
  const passBy = loop(lat + 500 / 111320 + 300 / 111320, lng, 300); // its nearest point is 500 m away
  const restRun = await run(ana, 'Cofre lejano', passBy, Date.now() - 2 * HOUR);
  const got = restRun.result.treasuresCollected ?? [];
  check('Llave Maestra: the chest opens from 500 m', got.some((t) => t.treasureId === first.id), got);
  check('Botín Doble: two items from one chest', got.filter((t) => t.treasureId.startsWith(first.id)).length === 2, got);
  const keyLess = await run(ben, 'Sin llave', loop(Number(second.lat) + 800 / 111320, Number(second.lng), 300), Date.now() - 3 * HOUR);
  check('without the key a chest 500 m away stays closed', !(keyLess.result.treasuresCollected ?? []).some((t) => t.treasureId === second.id), keyLess.result.treasuresCollected);
}

console.log(failures === 0 ? '\nAll mode checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
