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

const club2 = (await call('POST', '/api/clubs', { token: dani.token, body: {
  name: 'Ebro Night Crew', crest: { ...crest, pattern: 'chevron' }, entryMode: 'approval',
  description: 'Corremos de noche por la ribera.\nQuedadas los martes.',
} })).data.club;
check('a club with approval: entry type and description are stored, listed in the search', club2?.entryMode === 'approval' && club2.description.includes('martes') && club2.visibility === 'public', club2);
const evaRequest = await call('POST', `/api/clubs/${club2.id}/join`, { token: eva.token, body: {} });
check('approval clubs: joining sends a request', evaRequest.data.requested === true && evaRequest.data.joined === false, evaRequest);
const daniView = await call('GET', '/api/clubs/mine', { token: dani.token });
check('the leader sees the request', daniView.data.pendingRequests?.length === 1 && daniView.data.canInvite === true, daniView.data);
const notAdmin = await call('POST', `/api/clubs/${club2.id}/requests/${evaRequest.data.requestId}/accept`, { token: eva.token, body: {} });
check('only the leader and officers accept requests', notAdmin.status === 403, notAdmin);
const accepted = await call('POST', `/api/clubs/${club2.id}/requests/${evaRequest.data.requestId}/accept`, { token: dani.token, body: {} });
check('request accepted', accepted.status === 200, accepted);
// The code of an approval club asks for approval too
const codeRequest = await call('POST', '/api/clubs/join-code', { token: hugo.token, body: { code: daniView.data.club.joinCode } });
check('approval clubs: the code sends a request too', codeRequest.data.requested === true, codeRequest);
check('request rejected', (await call('POST', `/api/clubs/${club2.id}/requests/${codeRequest.data.requestId}/reject`, { token: dani.token, body: {} })).status === 200);
// An ordinary member's invite in an approval club becomes a request; the leader approves it
const invite = await call('POST', `/api/clubs/${club2.id}/invites`, { token: eva.token, body: { userId: fede.id } });
check('members can invite (the leader allows it)', invite.data.invited === true, invite);
const fedeView = await call('GET', '/api/clubs/mine', { token: fede.token });
check('the invite reaches the user', fedeView.data.invites?.length === 1, fedeView.data);
const fedeAccept = await call('POST', `/api/clubs/invites/${fedeView.data.invites[0].id}/accept`, { token: fede.token, body: {} });
check("a member's invite to an approval club needs approval", fedeAccept.status === 200 && fedeAccept.data.requested === true && fedeAccept.data.joined === false, fedeAccept.data);
const fedeRequest = (await call('GET', '/api/clubs/mine', { token: dani.token })).data.pendingRequests.find((r) => r.user.id === fede.id);
check("the leader approves the member's invite", (await call('POST', `/api/clubs/${club2.id}/requests/${fedeRequest?.id}/accept`, { token: dani.token, body: {} })).status === 200
  && (await one('select club_id from club_members where user_id = ?', [fede.id]))?.club_id === club2.id);
// Only the leader decides who invites; then ordinary members can't invite nor see the code
check('only the leader changes the invite permission', (await call('PATCH', `/api/clubs/${club2.id}`, { token: eva.token, body: { invitePermission: 'officers' } })).status === 403);
check('the leader limits invites to officers', (await call('PATCH', `/api/clubs/${club2.id}`, { token: dani.token, body: { invitePermission: 'officers' } })).data.club?.invitePermission === 'officers');
check('then a member cannot invite', (await call('POST', `/api/clubs/${club2.id}/invites`, { token: eva.token, body: {} })).status === 403);
const evaClubView = await call('GET', '/api/clubs/mine', { token: eva.token });
check('nor see the code', evaClubView.data.canInvite === false && !evaClubView.data.club.joinCode, evaClubView.data.club);
const link = await call('POST', `/api/clubs/${club2.id}/invites`, { token: dani.token, body: {} });
check('invite link from the leader', /\/club-invite\/[A-Za-z0-9_-]+$/.test(link.data.url), link.data);
const linkPreview = await call('GET', `/api/clubs/invite-links/${link.data.token}`, { token: hugo.token });
check("the leader's link lets you in without approval", linkPreview.data.valid === true && linkPreview.data.requiresApproval === false, linkPreview.data);
const club3 = (await call('POST', '/api/clubs', { token: gala.token, body: { name: 'Solo Gala', crest } })).data.club;
// Invite only: hidden from the search and from outsiders
check('the leader makes the club invite-only', (await call('PATCH', `/api/clubs/${club2.id}`, { token: dani.token, body: { entryMode: 'invite_only' } })).data.club?.visibility === 'private');
const privateDetail = await call('GET', `/api/clubs/${club2.id}`, { token: hugo.token });
check('invite-only club members are hidden from outsiders', privateDetail.data.members.length === 0 && !privateDetail.data.club.joinCode, privateDetail.data);
check('an invite-only club cannot be joined from its card', (await call('POST', `/api/clubs/${club2.id}/join`, { token: hugo.token, body: {} })).status === 403);
const search = await call('GET', '/api/clubs/search?q=zarag', { token: hugo.token });
check('search by name or city finds listed clubs only', search.data.clubs.some((c) => c.id === club1.id) && search.data.clubs.every((c) => c.entryMode !== 'invite_only' && c.id !== club2.id), search.data.clubs.map((c) => c.name));
const searchByText = await call('GET', '/api/clubs/search?q=solo%20gala', { token: hugo.token });
check('search finds open clubs', searchByText.data.clubs.some((c) => c.id === club3.id), searchByText.data.clubs.map((c) => c.name));

// ───────────── Club chat ─────────────

const chat = async (user, clubId = club1.id, query = '') => (await call('GET', `/api/clubs/${clubId}/messages${query}`, { token: user.token })).data;
const say = (user, body, extra = {}, clubId = club1.id) => call('POST', `/api/clubs/${clubId}/messages`, { token: user.token, body: { body, ...extra } });
const anaMine = (await call('GET', '/api/clubs/mine', { token: ana.token })).data;
check('chat: unread messages are counted for the club tab', anaMine.unreadCount >= 2, anaMine.unreadCount);
const firstPage = await chat(ana);
check('chat: system messages when members join', firstPage.messages.some((m) => m.kind === 'system' && m.body === 'Ben se ha unido al club.') && firstPage.me.canModerate === true, firstPage.messages.map((m) => m.body));
check('chat: only members read it', (await call('GET', `/api/clubs/${club1.id}/messages`, { token: dani.token })).status === 404);
const hello = await say(ben, 'Hola @ana, ¿salimos el jueves?');
check('chat: a message with a mention', hello.status === 200 && hello.data.message.mentions.includes(ana.id) && hello.data.message.user.id === ben.id, hello.data);
check('chat: empty messages are refused', (await say(ben, '   ')).status === 400);
check('chat: over 1000 characters is refused', (await say(ben, 'x'.repeat(1001))).status === 400);
const reply = await say(cris, 'Yo me apunto', { replyTo: hello.data.message.id });
check('chat: replies show what they answer', reply.data.message.replyTo?.id === hello.data.message.id && reply.data.message.replyTo.userName === 'Ben', reply.data.message.replyTo);
const react = (user, id, emoji) => call('POST', `/api/clubs/${club1.id}/messages/${id}/reactions`, { token: user.token, body: { emoji } });
const liked = await react(ana, hello.data.message.id, '👍');
check('chat: reacting', liked.data.added === true && liked.data.reactions[0]?.count === 1 && liked.data.reactions[0].mine === true, liked.data);
check('chat: reacting again takes it back', (await react(ana, hello.data.message.id, '👍')).data.added === false);
check('chat: only the six reactions', (await react(ana, hello.data.message.id, '💩')).status === 400);
check("chat: a member can't delete someone else's message", (await call('DELETE', `/api/clubs/${club1.id}/messages/${hello.data.message.id}`, { token: cris.token })).status === 403);
const own = await say(ben, 'Me equivoqué de chat');
check('chat: authors delete their messages', (await call('DELETE', `/api/clubs/${club1.id}/messages/${own.data.message.id}`, { token: ben.token })).data.deleted === true);
check('chat: the leader deletes any message', (await call('DELETE', `/api/clubs/${club1.id}/messages/${reply.data.message.id}`, { token: ana.token })).data.deleted === true);
const afterDeletes = (await chat(cris)).messages;
const ownDeleted = afterDeletes.find((m) => m.id === own.data.message.id);
const modDeleted = afterDeletes.find((m) => m.id === reply.data.message.id);
check('chat: deleted messages keep their place without text, and say who deleted them', ownDeleted?.deleted && ownDeleted.body === null && !ownDeleted.deletedByModerator
  && modDeleted?.deleted && modDeleted.deletedByModerator === true, { ownDeleted, modDeleted });
check('chat: members cannot mute', (await call('POST', `/api/clubs/${club1.id}/members/${cris.id}/mute`, { token: ben.token, body: { hours: 24 } })).status === 403);
check('chat: nobody mutes the leader', (await call('POST', `/api/clubs/${club1.id}/members/${ana.id}/mute`, { token: ben.token, body: { hours: 1 } })).status === 403);
const muted = await call('POST', `/api/clubs/${club1.id}/members/${cris.id}/mute`, { token: ana.token, body: { hours: 24 } });
check('chat: the leader mutes a member for 24 h', !!muted.data.mutedUntil && Date.parse(muted.data.mutedUntil) > Date.now() + 23 * 3600_000, muted.data);
const mutedPost = await say(cris, '¿Por qué?');
check('chat: a muted member cannot write, and knows until when', mutedPost.status === 403 && mutedPost.data.code === 'muted' && (await chat(cris)).me.mutedUntil === muted.data.mutedUntil, mutedPost.data);
check('chat: the leader sees who is muted', (await chat(ana)).mutes.some((m) => m.userId === cris.id) && (await chat(ben)).mutes.length === 0);
await call('POST', `/api/clubs/${club1.id}/members/${cris.id}/mute`, { token: ana.token, body: { hours: 0 } });
check('chat: lifting the mute', (await say(cris, 'Gracias')).status === 200);
await call('POST', `/api/blocks/${ben.id}`, { token: cris.token, body: {} });
await say(ben, 'Mensaje que Cris no verá');
check("chat: messages of blocked users are hidden", !(await chat(cris)).messages.some((m) => m.user?.id === ben.id) && (await chat(ana)).messages.some((m) => m.body === 'Mensaje que Cris no verá'));
await call('DELETE', `/api/blocks/${ben.id}`, { token: cris.token });
const report = await call('POST', '/api/reports', { token: cris.token, body: { targetType: 'club_message', targetId: hello.data.message.id, reportedUserId: ben.id, reason: 'Prueba' } });
check('chat: messages can be reported', report.status === 200, report.data);
const read = await call('POST', `/api/clubs/${club1.id}/messages/read`, { token: ana.token, body: {} });
check('chat: reading clears the unread count', read.data.unreadCount === 0 && (await call('GET', '/api/clubs/mine', { token: ana.token })).data.unreadCount === 0, read.data);
let limited = null;
for (let i = 0; i < 16 && !limited; i++) {
  const res = await say(eva, `Mensaje ${i}`, {}, club2.id);
  if (res.status === 429) limited = { at: i, res };
}
check('chat: writing too fast waits a minute', limited?.at === 15 && limited.res.data.code === 'rate_limited', limited);
const older = (await chat(eva, club2.id)).hasMore;
const page2 = await chat(eva, club2.id, `?before=${(await chat(eva, club2.id)).messages[0].id}`);
check('chat: older messages page by page', older === false || page2.messages.length > 0, { older, page2: page2.messages?.length });

// ───────────── The competition starts ─────────────

const tick = await admin('/api/admin/season/tick');
check('first tick: one-time reset and start of cycle 0', tick.data.reset === true && tick.data.cycle === 0 && tick.data.phase === 'competition' && tick.data.started?.competitions === 3, tick.data);
check('chat: the start of the competition is announced in the club chat', (await chat(ana)).messages.some((m) => m.kind === 'system' && m.body.startsWith('Empieza la competición: Todos contra todos.')));
const tickAgain = await admin('/api/admin/season/tick');
check('the tick is idempotent', tickAgain.data.reset === false && !tickAgain.data.started, tickAgain.data);
const competitions = await all('select club_id, mode from club_competitions where cycle_number = 0');
const modeOf = Object.fromEntries(competitions.map((r) => [r.club_id, r.mode]));
check('modes: ffa for 3-member clubs, "target" for a club of one', modeOf[club1.id] === 'ffa' && modeOf[club2.id] === 'ffa' && modeOf[club3.id] === 'target', modeOf);

// Runs from the last days count: move the cutoff back and backdate the participants
await admin('/api/admin/season/runs-from', { at: new Date(Date.now() - 4 * DAY).toISOString() });
const season0 = (await call('GET', '/api/season/current', { token: ana.token })).data;
await db.execute({ sql: 'UPDATE competition_participants SET joined_at = ?', args: [season0.cycle.competitionStartsAt] });
await db.execute({ sql: 'UPDATE club_members SET joined_at = ?', args: [season0.cycle.competitionStartsAt] });
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
check('the run list says why a run does not count', typeof listedCar?.validationMessage === 'string' && listedCar.validationMessage.length > 0, listedCar?.validationMessage);
const crisFeed = (await call('GET', `/api/feed/${cris.id}`, { token: cris.token })).data;
const feedRouteIds = new Set((Array.isArray(crisFeed) ? crisFeed : []).map((e) => e.routeId));
check('rejected runs are not in the feed; accepted ones are', ![car, walk, dup].some((r) => feedRouteIds.has(r.route.id)) && feedRouteIds.has(c1.route.id), [...feedRouteIds]);
// A second car ride, after a valid run: 1:20 /km would "beat" Parque Grande, but it doesn't count
const car2 = await run(cris, 'Otra vez en coche', loop(C[0] - 0.02, C[1], 900), t0 + 12 * 3600_000, { speedKmh: 45 });
const car2Meta = JSON.parse((await one('select metadata from feed_events where route_id = ?', [car2.route.id]))?.metadata || '{}');
check('a run that does not count sets no records', car2.result.validation?.status === 'rejected' && !car2Meta.records, car2Meta.records);

// Entering the competition by running
check('runs dated in the future are refused', (await call('POST', '/api/routes', { token: gala.token, body: {
  name: 'Mañana', coordinates: loop(C[0], C[1], 300), distance: 1900, duration: 620,
  startedAt: new Date(Date.now() + 2 * DAY).toISOString(), completedAt: new Date(Date.now() + 2 * DAY + 620_000).toISOString(),
} })).status === 400);
// The season is younger than 14 days (just reset): every member took part from the start
const club3Comp = await one('select id, mode from club_competitions where cycle_number = 0 and club_id = ?', [club3.id]);
check('a young season: members without runs take part too', !!(await one('select 1 as ok from competition_participants where competition_id = ? and user_id = ?', [club3Comp.id, gala.id])));
// Gala as an inactive member left out at the start: in a team-against-team mode she can't enter...
await db.execute({ sql: 'delete from competition_participants where competition_id = ? and user_id = ?', args: [club3Comp.id, gala.id] });
await db.execute({ sql: "update club_competitions set mode = 'teams' where id = ?", args: [club3Comp.id] });
const closedEntry = await run(gala, 'Gala vuelve', loop(C[0] + 0.05, C[1], 300), t0 + 8 * 3600_000);
check('team against team: a returning member does not enter', closedEntry.result.competition === null && closedEntry.result.competitionNote === 'closed_entry'
  && !(await one('select 1 as ok from competition_participants where competition_id = ? and user_id = ?', [club3Comp.id, gala.id])), closedEntry.result);
// ... in an individual or cooperative mode, her first run brings her in, and it counts
await db.execute({ sql: 'update club_competitions set mode = ? where id = ?', args: [club3Comp.mode, club3Comp.id] });
const entered = await run(gala, 'Gala entra', loop(C[0] + 0.06, C[1], 300), t0 + 8.5 * 3600_000);
const galaPart = await one('select joined_at, runs from competition_participants where competition_id = ? and user_id = ?', [club3Comp.id, gala.id]);
check('individual or cooperative: the first run brings an inactive member in, and counts', entered.result.joinedCompetition === true && entered.result.competition?.newArea > 0 && Number(galaPart?.runs) === 1, { result: entered.result, galaPart });
const galaRuns = await all('select route_id from competition_runs where competition_id = ? and user_id = ?', [club3Comp.id, gala.id]);
check('runs that count are recorded per competition', galaRuns.length === 1 && galaRuns[0].route_id === entered.route.id, galaRuns);

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
// Privacy: GPS tracks only for friends and club mates; the global ranking shows the area only
const strangerRuns = await call('GET', `/api/routes/${dani.id}`, { token: ana.token });
check('runs of someone outside your friends and club are private', strangerRuns.status === 403, strangerRuns);
const mateRuns = await call('GET', `/api/routes/${ben.id}`, { token: ana.token });
check('runs of a club mate are visible', mateRuns.status === 200 && Array.isArray(mateRuns.data) && mateRuns.data.length >= 1, mateRuns.status);
const strangerStats = await call('GET', `/api/users/${dani.id}/stats`, { token: ana.token });
check('public profile: global area, no routes', strangerStats.status === 200 && strangerStats.data.globalArea > 0 && !('routes' in strangerStats.data), strangerStats.data);
check('legacy territory list needs a session', (await call('GET', '/api/territories')).status === 401);
const legacyTerritories = await call('GET', '/api/territories', { token: dani.token });
check('legacy territory list: only your own club', legacyTerritories.status === 200 && legacyTerritories.data.every((t) => ![ana.id, ben.id, cris.id].includes(t.userId)), legacyTerritories.data.map?.((t) => t.userId));
check('legacy treasures: nothing spawned or listed', (await call('GET', '/api/treasures/active', { token: ana.token })).data.treasures.length === 0);
const compMap = (await call('GET', '/api/season/map', { token: ana.token })).data;
check('competition map: only my competition', compMap.territories.length >= 2 && compMap.territories.every((t) => [ana.id, ben.id, cris.id].includes(t.userId)), compMap.territories.map((t) => t.userId));
const current = (await call('GET', '/api/season/current', { token: cris.token })).data;
check('standings include bonus and stolen area', current.competition.standings.length === 3 && current.competition.standings.some((s) => s.bonus === 100_000), current.competition.standings.map((s) => [s.user?.name, Math.round(s.score)]));

// ───────────── End of the competition ─────────────

// A "next run" power activated at the end of the competition must not carry over
const lastMinute = await grant(cris, 'magnet');
await call('POST', `/api/inventory/${lastMinute}/activate`, { token: cris.token, body: {} });
check('the close is 6 hours after the end (Monday 06:00)', Date.parse(season0.cycle.competitionClosesAt) - Date.parse(season0.cycle.competitionEndsAt) === 6 * 3600_000, season0.cycle);
// Monday 00:10: the competition is over but not scored yet (late runs still arriving)
// A message from long ago: the daily clean-up removes it (90 days)
await db.execute({ sql: "insert into club_messages (id, club_id, user_id, kind, body, created_at) values ('old-message', ?, ?, 'user', 'Hace mucho', '2025-01-01T00:00:00.000Z')", args: [club1.id, ben.id] });
const endTime = Date.parse(season0.cycle.competitionEndsAt) + 10 * 60_000;
const closingTick = await admin('/api/admin/season/tick', { time: new Date(endTime).toISOString() });
check('at the end it is not scored yet: the close waits until 06:00', closingTick.data.finished_0 === undefined && closingTick.data.phase === 'rest', closingTick.data);
check('nobody leaves while the last runs arrive', (await call('POST', `/api/clubs/${club1.id}/leave`, { token: ben.token, body: {} })).status === 409);
const closeTime = Date.parse(season0.cycle.competitionClosesAt) + 10 * 60_000;
const finish = await admin('/api/admin/season/tick', { time: new Date(closeTime).toISOString() });
check('the close tick finishes cycle 0', finish.data.finished_0 === 3 && finish.data.phase === 'rest', finish.data);
check('chat: the result is announced in the club chat', (await chat(ana)).messages.some((m) => m.kind === 'system' && m.body.startsWith('Fin de la competición. Gana ')));
check('chat: messages older than 90 days are cleaned up', !(await one("select id from club_messages where id = 'old-message'")));
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
const carried = await one('select status from user_powers where id = ?', [lastMinute]);
check('pending competition effects expire with the competition', carried.status === 'expired', carried);
const anaGlobal3 = Number((await one('select global_area from users where id = ?', [ana.id])).global_area);
check('the global map is kept', Math.abs(anaGlobal3 - anaGlobal2) < 1);
const history = (await call('GET', `/api/clubs/${club1.id}/history`, { token: ana.token })).data;
check('club history and trophies', history.history.length === 1 && history.trophies.competitions === 1, history.trophies);

// Awards and the end-of-competition summary
const winnerUser = [ana, ben, cris].find((u) => u.id === r1.winnerUserId);
check('awards: the ffa winner is the Conquistador', r1.awards?.[r1.winnerUserId]?.includes('conqueror'), r1.awards);
const storedAwards = await all('select user_id, award from user_awards where competition_id = (select id from club_competitions where cycle_number = 0 and club_id = ?)', [club1.id]);
check('awards are stored for the profile', storedAwards.some((a) => a.user_id === r1.winnerUserId && a.award === 'conqueror'), storedAwards);
const winnerStats = (await call('GET', `/api/users/${r1.winnerUserId}/stats`, { token: ana.token })).data;
check('the profile shows the awards with how many times', winnerStats.awards?.some((a) => a.id === 'conqueror' && a.count === 1 && a.name === 'Conquistador'), winnerStats.awards);
const pendingNow = (await call('GET', '/api/season/results/pending', { token: winnerUser.token })).data.results;
const summary = pendingNow?.[0];
check('the summary pops up for a participant: club result, own numbers, awards, rewards, next', pendingNow?.length === 1 && summary.participated === true
  && summary.me?.rank === 1 && summary.me.of === 3 && summary.me.runs >= 1 && summary.me.days >= 1
  && summary.clubResult.winner?.id === r1.winnerUserId && summary.clubResult.podium.length === 3
  && summary.awards.some((a) => a.id === 'conqueror') && summary.rewards.length >= 1 && !!summary.rewards[0].definition
  && summary.next.cycleNumber === 1 && summary.next.mode === 'duel', summary);
const hugoPending = (await call('GET', '/api/season/results/pending', { token: hugo.token })).data.results;
check('a member who did not take part sees the club result only', hugoPending.length === 1 && hugoPending[0].participated === false && hugoPending[0].me === null
  && hugoPending[0].awards.length === 0 && hugoPending[0].rewards.length === 0, hugoPending);
check('outsiders cannot open the summary', (await call('GET', `/api/season/results/${summary.competitionId}`, { token: dani.token })).status === 404);
check('the summary can be opened again from the club history', (await call('GET', `/api/season/results/${summary.competitionId}`, { token: winnerUser.token })).data.result?.competitionId === summary.competitionId);
check('marked as seen', (await call('POST', `/api/season/results/${summary.competitionId}/seen`, { token: winnerUser.token, body: {} })).data.ok === true);
check('once seen it does not pop up again', (await call('GET', '/api/season/results/pending', { token: winnerUser.token })).data.results.length === 0);
await call('POST', `/api/season/results/${hugoPending[0].competitionId}/seen`, { token: hugo.token, body: {} });
check('nor for the member who did not take part', (await call('GET', '/api/season/results/pending', { token: hugo.token })).data.results.length === 0);
const leaveNow = await call('POST', `/api/clubs/${club1.id}/leave`, { token: hugo.token, body: {} });
check('leaving is allowed in the rest days', leaveNow.status === 200, leaveNow);

// ───────────── Cycle 1: club duels ─────────────

// gala's club gets another member, without runs (a duel needs 3 active runners)
await call('POST', `/api/clubs/${club3.id}/join`, { token: hugo.token, body: {} });
// From now on the season is older than 14 days: inactivity applies. Iris joins club 1 without runs.
await admin('/api/admin/season/runs-from', { at: new Date(Date.now() - 40 * DAY).toISOString() });
const iris = await register('iris', 'Iris', '#66C2A5');
check('a new member joins in the rest days', (await call('POST', `/api/clubs/${club1.id}/join`, { token: iris.token, body: {} })).data.joined === true);
const c1Start = Date.parse(season0.cycle.restEndsAt) + 10 * 60_000;
const duelTick = await admin('/api/admin/season/tick', { time: new Date(c1Start).toISOString() });
const playersOfCycle1 = async (clubId) => (await all(`select p.user_id from competition_participants p join club_competitions c on c.id = p.competition_id
  where c.cycle_number = 1 and c.club_id = ?`, [clubId])).map((r) => r.user_id);
const duelLineup = await playersOfCycle1(club1.id);
check('inactive members are left out: the duel line-up has the 3 who ran, not Iris', duelLineup.length === 3 && !duelLineup.includes(iris.id), duelLineup);
const club3Players = await playersOfCycle1(club3.id);
check('inactive members are left out of "Objetivo común" too (Hugo); Gala ran', club3Players.includes(gala.id) && !club3Players.includes(hugo.id), club3Players);
check('the start reports the members left out', duelTick.data.started?.inactive === 2, duelTick.data.started);
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
const c1End = Date.parse(season0.cycle.restEndsAt) + 10 * DAY + 6 * 3600_000 + 10 * 60_000; // close of cycle 1
await admin('/api/admin/season/tick', { time: new Date(c1End).toISOString() });
const match = await one('select * from club_matches where cycle_number = 1');
check('duel scored with N best runners and a cap per runner', Math.round(Number(match.score_a) + Number(match.score_b)) === 2_100_000 + 3_100_000, match);
const winner = match.winner_club_id;
check('the duel winner is club 2 (capped 3 + 0.1 > 2.1)', winner === club2.id, match);
const ratings = Object.fromEntries((await all('select id, rating, league_points from clubs')).map((r) => [r.id, [Number(r.rating), Number(r.league_points)]]));
check('Elo: +16 / -16 between equal ratings, 3 league points to the winner', Math.round(ratings[club2.id][0]) === 1016 && Math.round(ratings[club1.id][0]) === 984 && ratings[club2.id][1] >= 3, ratings);
const duelResults = Object.fromEntries((await all('select club_id, result from club_competitions where cycle_number = 1')).map((r) => [r.club_id, JSON.parse(r.result)]));
check('duel awards: Victoria for every runner of the winning club, none for the losers', [dani.id, eva.id, fede.id].every((id) => duelResults[club2.id].awards?.[id]?.includes('victory'))
  && !Object.values(duelResults[club1.id].awards ?? {}).flat().includes('victory') && duelResults[club1.id].awards?.[ana.id]?.includes('mvp'), { club1: duelResults[club1.id].awards, club2: duelResults[club2.id].awards });
check('chat: the duel result is announced', (await chat(eva, club2.id)).messages.some((m) => m.kind === 'system' && m.body.startsWith('Fin de la competición. Duelo ganado contra Zaragoza Runners')));
const duelSummary = (await call('GET', '/api/season/results/pending', { token: eva.token })).data.results[0];
check('duel summary: rival, score, Elo and league points', duelSummary?.clubResult.outcome === 'won' && duelSummary.clubResult.opponent?.name && duelSummary.clubResult.ratingChange === 16 && duelSummary.clubResult.leaguePoints === 3, duelSummary?.clubResult);
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
const freshChests = (await call('GET', '/api/season/map', { token: ana.token })).data.chests;
check('a chest is hidden from everybody during its first hour (Mapa del Tesoro)', freshChests.length === 0 || Date.now() >= spawnAt + 3600_000, freshChests.length);
// The tick was in the evening: an hour later they are public
await db.execute({ sql: 'update treasures set public_at = ?', args: [new Date(Date.now() - 60_000).toISOString()] });
const visible = (await call('GET', '/api/season/map', { token: ana.token })).data.chests;
check('club members see the chests (not the hidden ones)', visible.length >= 1 && visible.every((c) => !c.hidden), visible.length);
const nonMember = (await call('GET', '/api/season/map', { token: (await register('ivan', 'Iván', '#E78AC3')).token })).data.chests;
check('people without a club see no chests', nonMember.length === 0);
const challenges = (await call('GET', '/api/challenges', { token: ana.token })).data.challenges;
check('3 challenges per rest phase', challenges.length === 3, challenges.map((c) => c.type));
// A 10.5 km run at 5:20/km yesterday at 07:30 Madrid, passing by a chest
const chest = visible[0];
// 3 days ago, so it never overlaps the competition runs of the last 30 hours (that would make it a duplicate)
const yesterday = madrid.format(new Date(Date.now() - 3 * DAY));
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

// 3 h after Eva's other run (at a fixed clock time it could overlap it and count as a duplicate)
const huge = await run(eva, 'Vuelta enorme', loop(C[0] + 0.1, C[1] - 0.1, 1900), t0 + 9.5 * 3600_000, { speedKmh: 12 });
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
