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
  SEASON_ANCHOR_DATE: addDays(madridDay(Date.now()), 30),
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
}

console.log(failures === 0 ? '\nAll mode checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
