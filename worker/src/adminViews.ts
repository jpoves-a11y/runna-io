// Pages of the admin panel besides reports and stats (worker/src/admin.ts registers the routes):
//   Resumen        what needs attention today and the key numbers
//   Competiciones  season calendar (past, current and next cycles with dates and modes), the club
//                  competitions of the cycle, chests, awards; detail of one competition
//   Usuarios       search and newest sign-ups; detail of one user (activity, club, reports, suspension)
//   Carreras       runs the anti-cheat sent to review (approve / revert) and the latest runs
//
// Every page keeps to a few database round trips (Cloudflare's free plan allows 50 per request).
import { sql } from 'drizzle-orm';
import { escapeHtml } from './pages';
import { cycleAt, cycleInfo, type CycleInfo } from './cycles';
import { competitionStandings } from './season';
import { GameStorage } from './gameStorage';
import type { WorkerStorage } from './storage';
import { MODE_INFO, AWARDS, type CompetitionMode } from '../../shared/game';

type Row = Record<string, any>;
const SYSTEM_USER = '__system_runna__';

// ─── Formatting ───────────────────────────────────────────────────────────────

export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function madrid(value: string | number | Date | null | undefined, style: 'datetime' | 'date' | 'weekday' = 'datetime'): string {
  const date = value instanceof Date ? value : typeof value === 'number' ? new Date(value) : parseDate(value ?? null);
  if (!date) return '';
  if (style === 'date') return date.toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid', day: 'numeric', month: 'short', year: 'numeric' });
  if (style === 'weekday') return date.toLocaleString('es-ES', { timeZone: 'Europe/Madrid', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return date.toLocaleString('es-ES', { timeZone: 'Europe/Madrid', dateStyle: 'short', timeStyle: 'short' });
}

/** "en 3 d 4 h", "hace 2 h". */
export function relative(target: number, now = Date.now()): string {
  const diff = target - now;
  const abs = Math.abs(diff);
  const d = Math.floor(abs / 86_400_000);
  const h = Math.floor((abs % 86_400_000) / 3_600_000);
  const m = Math.floor((abs % 3_600_000) / 60_000);
  const text = d > 0 ? `${d} d ${h} h` : h > 0 ? `${h} h ${m} min` : `${m} min`;
  return diff >= 0 ? `en ${text}` : `hace ${text}`;
}

export const km2 = (m2: number | null | undefined) => `${(Number(m2 ?? 0) / 1_000_000).toLocaleString('es-ES', { maximumFractionDigits: 3 })} km²`;
export const km = (m: number | null | undefined) => `${(Number(m ?? 0) / 1000).toLocaleString('es-ES', { maximumFractionDigits: 1 })} km`;
const n = (value: unknown) => Number(value ?? 0).toLocaleString('es-ES');
const e = (value: unknown) => escapeHtml(String(value ?? ''));

function modeLabel(mode: string): string {
  const info = MODE_INFO[mode as CompetitionMode];
  return info ? `${info.emoji} ${escapeHtml(info.name)}` : e(mode);
}

const PHASE_NAMES: Record<string, string> = { competition: 'Competición', rest: 'Descanso', preseason: 'Pretemporada' };

function userLink(id: string | null | undefined, name: string | null | undefined, username?: string | null): string {
  if (!id) return '—';
  const label = name ? `${e(name)}${username ? ` <span class="muted">@${e(username)}</span>` : ''}` : `<span class="muted">${e(id)}</span>`;
  return `<a href="/admin/users/${encodeURIComponent(id)}">${label}</a>`;
}

function table(headers: string[], rows: string[], empty = 'Nada por aquí.'): string {
  if (rows.length === 0) return `<p class="muted">${empty}</p>`;
  const head = headers.map((h) => (h.startsWith('#') ? `<th class="num">${h.slice(1)}</th>` : `<th>${h}</th>`)).join('');
  return `<div class="table-scroll"><table><thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

const td = (value: string, numeric = false) => `<td${numeric ? ' class="num"' : ''}>${value}</td>`;

// ─── Resumen ─────────────────────────────────────────────────────────────────

export async function dashboardBody(storage: WorkerStorage): Promise<string> {
  const db = storage.database;
  const now = Date.now();
  const info = cycleAt(now);
  const one = async (query: ReturnType<typeof sql>): Promise<Row> => ((await db.all<Row>(query))[0] ?? {});

  const users = await one(sql`SELECT count(*) AS total,
      sum(CASE WHEN julianday(created_at) >= julianday('now', '-1 day') THEN 1 ELSE 0 END) AS d1,
      sum(CASE WHEN julianday(created_at) >= julianday('now', '-7 days') THEN 1 ELSE 0 END) AS d7,
      sum(CASE WHEN banned_at IS NOT NULL THEN 1 ELSE 0 END) AS banned
    FROM users WHERE id != ${SYSTEM_USER}`);
  const runs = await one(sql`SELECT
      sum(CASE WHEN julianday(completed_at) >= julianday('now', '-1 day') THEN 1 ELSE 0 END) AS d1,
      sum(CASE WHEN julianday(completed_at) >= julianday('now', '-7 days') THEN 1 ELSE 0 END) AS d7,
      count(DISTINCT CASE WHEN julianday(completed_at) >= julianday('now', '-1 day') THEN user_id END) AS runners1,
      sum(CASE WHEN validation_status = 'flagged' THEN 1 ELSE 0 END) AS flagged
    FROM routes`);
  const active = await one(sql`SELECT count(DISTINCT user_id) AS d1 FROM app_events
    WHERE user_id IS NOT NULL AND julianday(created_at) >= julianday('now', '-1 day')`);
  const reports = await one(sql`SELECT count(*) AS open, min(created_at) AS oldest FROM reports WHERE coalesce(status, 'open') = 'open'`);
  const comps = await one(sql`SELECT count(*) AS total,
      (SELECT count(*) FROM competition_participants p JOIN club_competitions c2 ON c2.id = p.competition_id WHERE c2.cycle_number = ${info.number}) AS participants
    FROM club_competitions WHERE cycle_number = ${info.number}`).catch(() => ({} as Row));
  const clubs = await one(sql`SELECT count(*) AS total, coalesce(sum(member_count), 0) AS members FROM clubs`).catch(() => ({} as Row));

  // What needs attention
  const alerts: string[] = [];
  const openReports = Number(reports.open ?? 0);
  if (openReports > 0) {
    const oldest = parseDate(reports.oldest);
    const late = oldest && now - oldest.getTime() > 20 * 3_600_000;
    alerts.push(`<li class="${late ? 'bad' : 'warn'}"><a href="/admin/reports">${openReports} ${openReports === 1 ? 'denuncia pendiente' : 'denuncias pendientes'}</a>${oldest ? ` · la más antigua ${relative(oldest.getTime(), now)}` : ''}${late ? ' · Apple pide revisarlas en 24 h' : ''}</li>`);
  }
  const flagged = Number(runs.flagged ?? 0);
  if (flagged > 0) alerts.push(`<li class="warn"><a href="/admin/runs">${flagged} ${flagged === 1 ? 'carrera' : 'carreras'} en revisión</a> por el antitrampas</li>`);
  const nextChange = info.phase === 'competition' ? Date.parse(info.competitionEndsAt) : Date.parse(info.restEndsAt);
  if (nextChange - now < 2 * 86_400_000) {
    alerts.push(`<li class="info">${info.phase === 'competition' ? 'La competición termina' : 'La próxima competición empieza'} ${relative(nextChange, now)} (${madrid(nextChange, 'weekday')})</li>`);
  }

  const next = cycleInfo(info.number + 1, 'competition');
  const current = `<div class="card">
<h3>Temporada · ciclo ${info.number}</h3>
<p><strong>${PHASE_NAMES[info.phase] ?? e(info.phase)}</strong>${info.phase === 'competition' ? ` · ${modeLabel(info.mode)}` : ''}</p>
<p>${info.phase === 'competition'
    ? `Termina ${madrid(info.competitionEndsAt, 'weekday')} (${relative(Date.parse(info.competitionEndsAt), now)}). Las carreras llegadas tarde cuentan hasta ${madrid(info.competitionClosesAt, 'weekday')}.`
    : `Descanso hasta ${madrid(info.restEndsAt, 'weekday')} (${relative(Date.parse(info.restEndsAt), now)}).`}</p>
<p class="muted">Siguiente: ${modeLabel(next.mode)}, del ${madrid(next.competitionStartsAt, 'weekday')} al ${madrid(next.competitionEndsAt, 'weekday')}.</p>
<p><a href="/admin/competitions">Ver calendario y competiciones →</a></p>
</div>`;

  return `<h1>Resumen</h1>
${alerts.length ? `<ul class="alerts">${alerts.join('')}</ul>` : '<p class="flash">Todo en orden: sin denuncias pendientes ni carreras en revisión. 🎉</p>'}
<div class="tiles">
<a class="tile" href="/admin/users"><span>Usuarios</span><strong>${n(users.total)}</strong><small>+${n(users.d1)} hoy · +${n(users.d7)} en 7 días</small></a>
<a class="tile" href="/admin/stats"><span>Abren la app hoy</span><strong>${n(active.d1)}</strong><small>${n(runs.runners1)} han corrido</small></a>
<a class="tile" href="/admin/runs"><span>Carreras</span><strong>${n(runs.d1)}</strong><small>hoy · ${n(runs.d7)} en 7 días</small></a>
<a class="tile" href="/admin/competitions"><span>Competiciones del ciclo</span><strong>${n(comps.total)}</strong><small>${n(comps.participants)} participantes</small></a>
<a class="tile" href="/admin/competitions"><span>Clubs</span><strong>${n(clubs.total)}</strong><small>${n(clubs.members)} miembros</small></a>
<a class="tile" href="/admin/reports"><span>Denuncias pendientes</span><strong>${n(openReports)}</strong><small>${n(users.banned)} suspendidos</small></a>
</div>
${current}`;
}

// ─── Competiciones ───────────────────────────────────────────────────────────

export async function competitionsBody(storage: WorkerStorage): Promise<string> {
  const db = storage.database;
  const now = Date.now();
  const info = cycleAt(now);

  // Calendar: two cycles back, the current one and the next eight (pure date maths)
  const calendarRows: string[] = [];
  for (let cycle = Math.max(info.number - 2, 0); cycle <= info.number + 8; cycle++) {
    const c: CycleInfo = cycleInfo(cycle, 'competition');
    const start = Date.parse(c.competitionStartsAt);
    const end = Date.parse(c.competitionEndsAt);
    const rest = Date.parse(c.restEndsAt);
    const state = now < start ? `<span class="tag">${relative(start, now)}</span>`
      : now < end ? '<span class="tag ok">En juego</span>'
        : now < rest ? '<span class="tag">Descanso</span>'
          : '<span class="muted">Terminada</span>';
    const isCurrent = cycle === info.number;
    calendarRows.push(`<tr${isCurrent ? ' class="current"' : ''}>${td(String(cycle), true)}${td(modeLabel(c.mode))}${td(madrid(start, 'weekday'))}${td(madrid(end, 'weekday'))}${td(madrid(rest, 'date'))}${td(state)}</tr>`);
  }

  // Club competitions of this cycle (and of the previous one, to see how it ended)
  const competitions = await db.all<Row>(sql`
    SELECT cc.id, cc.cycle_number, cc.mode, cc.status, cc.score, cc.finished_at, cc.opponent_club_id,
      c.name AS club_name, c.city, c.member_count, oc.name AS opponent_name,
      (SELECT count(*) FROM competition_participants p WHERE p.competition_id = cc.id) AS participants,
      (SELECT coalesce(sum(p.area + p.bonus), 0) FROM competition_participants p WHERE p.competition_id = cc.id) AS total_area,
      (SELECT coalesce(sum(p.runs), 0) FROM competition_participants p WHERE p.competition_id = cc.id) AS runs,
      (SELECT u.name FROM competition_participants p JOIN users u ON u.id = p.user_id WHERE p.competition_id = cc.id
        ORDER BY p.area + p.bonus DESC LIMIT 1) AS leader
    FROM club_competitions cc
    LEFT JOIN clubs c ON c.id = cc.club_id
    LEFT JOIN clubs oc ON oc.id = cc.opponent_club_id
    WHERE cc.cycle_number IN (${info.number}, ${info.number - 1})
    ORDER BY cc.cycle_number DESC, total_area DESC`).catch(() => [] as Row[]);
  const compRow = (r: Row) => `<tr>${td(`<a href="/admin/competitions/${encodeURIComponent(r.id)}">${e(r.club_name ?? 'Club borrado')}</a>${r.city ? ` <span class="muted">${e(r.city)}</span>` : ''}`)}${td(modeLabel(r.mode))}${td(r.opponent_name ? e(r.opponent_name) : '—')}${td(`${n(r.participants)}/${n(r.member_count)}`, true)}${td(n(r.runs), true)}${td(km2(r.total_area), true)}${td(e(r.leader ?? '—'))}${td(r.status === 'finished' ? `<span class="muted">Terminada ${madrid(r.finished_at, 'date')}</span>` : '<span class="tag ok">Activa</span>')}</tr>`;
  const currentComps = competitions.filter((r) => Number(r.cycle_number) === info.number);
  const previousComps = competitions.filter((r) => Number(r.cycle_number) === info.number - 1);

  // Clubs that could play (and those too small)
  const clubs = await db.all<Row>(sql`SELECT c.id, c.name, c.city, c.member_count, c.rating, c.league_points,
      (SELECT count(*) FROM club_competitions cc WHERE cc.club_id = c.id) AS played
    FROM clubs c ORDER BY c.member_count DESC LIMIT 100`).catch(() => [] as Row[]);
  const minForMode = (mode: CompetitionMode) => MODE_INFO[mode]?.minParticipants ?? 2;
  const nextInfo = cycleInfo(info.number + 1, 'competition');
  const clubRows = clubs.map((c) => {
    const enough = Number(c.member_count) >= minForMode(nextInfo.mode);
    return `<tr>${td(e(c.name))}${td(e(c.city ?? '—'))}${td(n(c.member_count), true)}${td(n(Math.round(Number(c.rating ?? 0))), true)}${td(n(c.league_points), true)}${td(n(c.played), true)}${td(enough ? '<span class="tag ok">Sí</span>' : `<span class="tag">Faltan ${minForMode(nextInfo.mode) - Number(c.member_count)}</span>`)}</tr>`;
  });

  // Chests
  const chests = await db.all<Row>(sql`SELECT rarity,
      sum(CASE WHEN active = 1 AND collected_by IS NULL AND julianday(expires_at) > julianday('now') THEN 1 ELSE 0 END) AS live,
      sum(CASE WHEN collected_by IS NOT NULL AND julianday(collected_at) >= julianday('now', '-14 days') THEN 1 ELSE 0 END) AS collected
    FROM treasures GROUP BY rarity`).catch(() => [] as Row[]);
  const rarityName: Record<string, string> = { common: 'Común', rare: 'Raro', epic: 'Épico', legendary: 'Legendario' };

  // Awards of the last finished cycle
  const awards = await db.all<Row>(sql`SELECT a.award, a.mode, a.user_id, u.name, u.username, c.name AS club_name
    FROM user_awards a LEFT JOIN users u ON u.id = a.user_id
    LEFT JOIN club_competitions cc ON cc.id = a.competition_id LEFT JOIN clubs c ON c.id = cc.club_id
    WHERE a.cycle_number = ${info.number - (info.phase === 'competition' ? 1 : 0)} ORDER BY c.name, a.award LIMIT 100`).catch(() => [] as Row[]);

  const phaseLine = info.phase === 'competition'
    ? `<strong>Competición en juego</strong> · ${modeLabel(info.mode)} · termina ${madrid(info.competitionEndsAt, 'weekday')} (${relative(Date.parse(info.competitionEndsAt), now)}); se puntúa ${madrid(info.competitionClosesAt, 'weekday')}`
    : `<strong>${PHASE_NAMES[info.phase] ?? e(info.phase)}</strong> · la siguiente competición (${modeLabel(nextInfo.mode)}) empieza ${madrid(nextInfo.competitionStartsAt, 'weekday')} (${relative(Date.parse(nextInfo.competitionStartsAt), now)})`;
  const modeDescription = MODE_INFO[(info.phase === 'competition' ? info.mode : nextInfo.mode) as CompetitionMode];

  return `<h1>Competiciones</h1>
<div class="card"><p>${phaseLine}</p>
${modeDescription ? `<p class="muted">${e(modeDescription.description)} Mínimo ${modeDescription.minParticipants} participantes por club.</p>` : ''}</div>

<h2>Calendario</h2>
<p class="muted">Ciclos de 14 días (hora de Madrid): competición y después descanso. El modo rota cada ciclo.</p>
${table(['#Ciclo', 'Modo', 'Empieza', 'Termina', 'Descanso hasta', 'Estado'], calendarRows)}

<h2>Este ciclo (${info.number}) · ${currentComps.length} ${currentComps.length === 1 ? 'competición' : 'competiciones'}</h2>
${table(['Club', 'Modo', 'Rival', '#Participan', '#Carreras', '#Área', 'Líder (km²)', 'Estado'], currentComps.map(compRow), info.phase === 'competition' ? 'Ningún club compite en este ciclo.' : 'En descanso no hay competiciones; empiezan con el siguiente ciclo.')}

${previousComps.length ? `<h2>Ciclo anterior (${info.number - 1})</h2>${table(['Club', 'Modo', 'Rival', '#Participan', '#Carreras', '#Área', 'Líder (km²)', 'Estado'], previousComps.map(compRow))}` : ''}

<h2>Premios del último ciclo terminado</h2>
${table(['Premio', 'Corredor', 'Club', 'Modo'], awards.map((a) => {
    const award = AWARDS[a.award as keyof typeof AWARDS];
    return `<tr>${td(award ? `${award.emoji} ${e(award.name)}` : e(a.award))}${td(userLink(a.user_id, a.name, a.username))}${td(e(a.club_name ?? '—'))}${td(modeLabel(a.mode))}</tr>`;
  }), 'Todavía no hay premios.')}

<h2>Cofres</h2>
${table(['Rareza', '#En el mapa ahora', '#Recogidos (14 días)'], chests.map((c) => `<tr>${td(e(rarityName[c.rarity] ?? c.rarity))}${td(n(c.live), true)}${td(n(c.collected), true)}</tr>`), 'No hay cofres.')}

<h2>Clubs (${clubs.length})</h2>
${table(['Club', 'Ciudad', '#Miembros', '#Nivel', '#Puntos de liga', '#Competiciones', `Pueden jugar el próximo modo`], clubRows, 'Todavía no hay clubs.')}`;
}

export async function competitionDetailBody(storage: WorkerStorage, id: string): Promise<string | null> {
  const game = new GameStorage(storage.database);
  const competition = await game.getCompetition(id);
  if (!competition) return null;
  const db = storage.database;
  const club = await game.getClub(competition.clubId);
  const opponent = competition.opponentClubId ? await game.getClub(competition.opponentClubId) : null;
  const bounds = cycleInfo(competition.cycleNumber, 'competition');
  const standings = await competitionStandings(game, competition);
  const lost = new Map((await db.all<Row>(sql`SELECT user_id, area_lost, bonus FROM competition_participants WHERE competition_id = ${id}`)).map((r) => [r.user_id, r]));
  const byDay = await db.all<Row>(sql`SELECT date(started_at) AS day, count(*) AS runs, sum(area_gained) AS gained, sum(distance) AS distance
    FROM competition_runs WHERE competition_id = ${id} GROUP BY day ORDER BY day`).catch(() => [] as Row[]);
  const flags = competition.mode === 'flags'
    ? await db.all<Row>(sql`SELECT f.name, (SELECT u.name FROM flag_captures fc JOIN users u ON u.id = fc.user_id WHERE fc.flag_id = f.id ORDER BY fc.captured_at DESC LIMIT 1) AS holder,
        (SELECT count(*) FROM flag_captures fc WHERE fc.flag_id = f.id) AS captures FROM competition_flags f WHERE f.competition_id = ${id} ORDER BY f.idx`).catch(() => [] as Row[])
    : [];
  const teamName = (team: number | null) => team === null || team === undefined ? '' : (competition.config?.teamNames?.[team] ?? `Equipo ${team + 1}`);
  const rows = standings.map((s: any) => {
    const extra = lost.get(s.userId);
    return `<tr>${td(String(s.rank), true)}${td(userLink(s.userId, s.name))}${competition.mode === 'teams' ? td(e(teamName(s.team))) : ''}${td(n(Math.round(s.score)), true)}${td(km2(extra?.bonus), true)}${td(km2(s.areaStolen), true)}${td(km2(extra?.area_lost), true)}${td(n(s.runs), true)}${td(km(s.distance), true)}${competition.mode === 'elimination' ? td(s.eliminatedCut !== null && s.eliminatedCut !== undefined ? `Corte ${s.eliminatedCut + 1}` : '<span class="tag ok">Sigue</span>') : ''}</tr>`;
  });
  const headers = ['#Puesto', 'Corredor', ...(competition.mode === 'teams' ? ['Equipo'] : []), '#Puntos', '#Bonus', '#Robado', '#Perdido', '#Carreras', '#Distancia', ...(competition.mode === 'elimination' ? ['Eliminación'] : [])];

  return `<p><a href="/admin/competitions">← Competiciones</a></p>
<h1>${e(club?.name ?? 'Club borrado')} · ciclo ${competition.cycleNumber}</h1>
<div class="card">
<p>${modeLabel(competition.mode)}${opponent ? ` contra <strong>${e(opponent.name)}</strong>` : ''} · ${competition.status === 'finished' ? `terminada ${madrid(competition.finishedAt)}` : '<span class="tag ok">Activa</span>'}</p>
<p>Del ${madrid(bounds.competitionStartsAt, 'weekday')} al ${madrid(bounds.competitionEndsAt, 'weekday')} · se puntúa ${madrid(bounds.competitionClosesAt, 'weekday')}</p>
${competition.mode === 'target' && competition.config?.target ? `<p>Objetivo del club: ${km2(competition.config.target)}</p>` : ''}
${club ? `<p class="muted">${e(club.city ?? '')} · ${n(club.memberCount)} miembros · nivel ${n(Math.round(club.rating))}</p>` : ''}
</div>
<h2>Clasificación (${standings.length})</h2>
${table(headers, rows, 'Sin participantes.')}
${flags.length ? `<h2>Banderas</h2>${table(['Bandera', 'La tiene', '#Capturas'], flags.map((f) => `<tr>${td(e(f.name))}${td(e(f.holder ?? '—'))}${td(n(f.captures), true)}</tr>`))}` : ''}
<h2>Carreras por día</h2>
${table(['Día', '#Carreras', '#Área ganada', '#Distancia'], byDay.map((d) => `<tr>${td(e(d.day))}${td(n(d.runs), true)}${td(km2(d.gained), true)}${td(km(d.distance), true)}</tr>`), 'Todavía no hay carreras.')}
${competition.result ? `<h2>Resultado guardado</h2><pre class="json">${e(JSON.stringify(competition.result, null, 2)).slice(0, 6000)}</pre>` : ''}`;
}

// ─── Usuarios ────────────────────────────────────────────────────────────────

export async function usersBody(storage: WorkerStorage, query: string): Promise<string> {
  const db = storage.database;
  const q = query.trim().slice(0, 60);
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const rows = await db.all<Row>(q
    ? sql`SELECT u.id, u.name, u.username, u.email, u.city, u.created_at, u.global_area, u.banned_at, u.apple_sub,
        (SELECT count(*) FROM routes r WHERE r.user_id = u.id) AS runs,
        (SELECT max(completed_at) FROM routes r WHERE r.user_id = u.id) AS last_run
      FROM users u WHERE u.id != ${SYSTEM_USER} AND (u.name LIKE ${like} OR u.username LIKE ${like} OR u.email LIKE ${like} OR u.id = ${q})
      ORDER BY u.created_at DESC LIMIT 100`
    : sql`SELECT u.id, u.name, u.username, u.email, u.city, u.created_at, u.global_area, u.banned_at, u.apple_sub,
        (SELECT count(*) FROM routes r WHERE r.user_id = u.id) AS runs,
        (SELECT max(completed_at) FROM routes r WHERE r.user_id = u.id) AS last_run
      FROM users u WHERE u.id != ${SYSTEM_USER} ORDER BY u.created_at DESC LIMIT 50`);
  const list = rows.map((u) => `<tr>${td(`${userLink(u.id, u.name, u.username)}${u.banned_at ? ' <span class="tag danger">Suspendido</span>' : ''}`)}${td(e(u.email))}${td(e(u.city ?? '—'))}${td(n(u.runs), true)}${td(km2(u.global_area), true)}${td(u.last_run ? madrid(u.last_run, 'date') : '—')}${td(madrid(u.created_at, 'date'))}${td(u.apple_sub ? 'Apple' : 'Email')}</tr>`);
  return `<h1>Usuarios</h1>
<form method="get" action="/admin/users" class="search"><input type="search" name="q" value="${e(q)}" placeholder="Nombre, usuario o email" autofocus><button>Buscar</button></form>
<h2>${q ? `Resultados para «${e(q)}» (${rows.length})` : 'Últimas altas'}</h2>
${table(['Usuario', 'Email', 'Ciudad', '#Carreras', '#Área global', 'Última carrera', 'Alta', 'Entra con'], list, 'Nadie coincide.')}`;
}

export async function userDetailBody(storage: WorkerStorage, id: string, csrf: string): Promise<string | null> {
  const db = storage.database;
  const [u] = await db.all<Row>(sql`SELECT * FROM users WHERE id = ${id}`);
  if (!u) return null;
  const [stats] = await db.all<Row>(sql`SELECT
      (SELECT count(*) FROM routes WHERE user_id = ${id}) AS runs,
      (SELECT coalesce(sum(distance), 0) FROM routes WHERE user_id = ${id}) AS distance,
      (SELECT count(*) FROM routes WHERE user_id = ${id} AND validation_status = 'rejected') AS rejected,
      (SELECT count(*) FROM routes WHERE user_id = ${id} AND validation_status = 'flagged') AS flagged,
      (SELECT count(*) FROM friendships WHERE user_id = ${id}) AS friends,
      (SELECT count(*) FROM reports WHERE reported_user_id = ${id}) AS reported,
      (SELECT count(*) FROM reports WHERE reporter_id = ${id}) AS reporter,
      (SELECT count(*) FROM user_blocks WHERE blocked_id = ${id}) AS blocked_by,
      (SELECT count(*) FROM app_events WHERE user_id = ${id} AND julianday(created_at) >= julianday('now', '-7 days')) AS events7,
      (SELECT max(created_at) FROM app_events WHERE user_id = ${id}) AS last_seen,
      (SELECT count(*) FROM garmin_accounts WHERE user_id = ${id}) AS garmin,
      (SELECT count(*) FROM suunto_accounts WHERE user_id = ${id}) AS suunto,
      (SELECT count(*) FROM polar_accounts WHERE user_id = ${id}) AS polar,
      (SELECT count(*) FROM strava_accounts WHERE user_id = ${id}) AS strava,
      (SELECT count(*) FROM push_subscriptions WHERE user_id = ${id}) AS devices`).catch(() => [{} as Row]);
  const [membership] = await db.all<Row>(sql`SELECT m.role, m.joined_at, c.name, c.city FROM club_members m JOIN clubs c ON c.id = m.club_id WHERE m.user_id = ${id}`).catch(() => [] as Row[]);
  const routes = await db.all<Row>(sql`SELECT id, name, distance, duration, completed_at, validation_status, global_area_gained FROM routes WHERE user_id = ${id} ORDER BY completed_at DESC LIMIT 15`);
  const history = await db.all<Row>(sql`SELECT cc.id, cc.cycle_number, cc.mode, p.area, p.runs, p.final_rank, c.name AS club_name
    FROM competition_participants p JOIN club_competitions cc ON cc.id = p.competition_id LEFT JOIN clubs c ON c.id = cc.club_id
    WHERE p.user_id = ${id} ORDER BY cc.cycle_number DESC LIMIT 12`).catch(() => [] as Row[]);
  const reports = await db.all<Row>(sql`SELECT r.target_type, r.reason, r.created_at, r.status, ru.name AS reporter
    FROM reports r LEFT JOIN users ru ON ru.id = r.reporter_id WHERE r.reported_user_id = ${id} ORDER BY r.created_at DESC LIMIT 20`);
  const s = stats ?? {};
  const devices = [s.garmin && 'Garmin', s.suunto && 'Suunto', s.polar && 'Polar', s.strava && 'Strava'].filter(Boolean).join(', ') || 'ninguno';
  const status = (v: string | null) => v === 'rejected' ? '<span class="tag danger">No cuenta</span>' : v === 'flagged' ? '<span class="tag">En revisión</span>' : '';

  const action = u.banned_at
    ? `<form method="post" action="/admin/users/unban"><input type="hidden" name="csrf" value="${e(csrf)}"><input type="hidden" name="user" value="${e(id)}"><input type="hidden" name="back" value="user"><button>Reactivar cuenta</button></form>`
    : `<form method="post" action="/admin/users/ban" class="inline-form"><input type="hidden" name="csrf" value="${e(csrf)}"><input type="hidden" name="user" value="${e(id)}">
<input type="text" name="reason" placeholder="Motivo (lo verás aquí)" required maxlength="300"><button class="danger">Suspender</button></form>`;

  return `<p><a href="/admin/users">← Usuarios</a></p>
<h1>${e(u.name)} <span class="muted">@${e(u.username)}</span></h1>
${u.banned_at ? `<p class="flash error">Suspendido desde ${madrid(u.banned_at)}${u.ban_reason ? ` · ${e(u.ban_reason)}` : ''}</p>` : ''}
<div class="tiles">
<div class="tile"><span>Área global</span><strong>${km2(Number(u.global_area ?? 0) + Number(u.global_bonus_area ?? 0))}</strong><small>competición: ${km2(u.total_area)}</small></div>
<div class="tile"><span>Carreras</span><strong>${n(s.runs)}</strong><small>${km(s.distance)} · ${n(s.flagged)} en revisión · ${n(s.rejected)} no cuentan</small></div>
<div class="tile"><span>Amigos</span><strong>${n(s.friends)}</strong><small>racha ${n(u.streak_days)} días</small></div>
<div class="tile"><span>Denuncias</span><strong>${n(s.reported)}</strong><small>recibidas · ${n(s.reporter)} hechas · bloqueado por ${n(s.blocked_by)}</small></div>
</div>
<div class="card">
<p><span class="muted">Email:</span> ${e(u.email)} ${u.email_verified ? '' : '<span class="tag">sin verificar</span>'} · <span class="muted">Entra con:</span> ${u.apple_sub ? 'Apple' : 'email y contraseña'}</p>
<p><span class="muted">Alta:</span> ${madrid(u.created_at)} · <span class="muted">Última vez en la app:</span> ${s.last_seen ? madrid(s.last_seen) : '—'} (${n(s.events7)} eventos en 7 días)</p>
<p><span class="muted">Ciudad:</span> ${e(u.city ?? '—')} ${u.country_name ? `(${e(u.country_name)})` : ''} · <span class="muted">Club:</span> ${membership ? `${e(membership.name)} (${e(membership.role)})` : 'ninguno'}</p>
<p><span class="muted">Relojes:</span> ${devices} · <span class="muted">Dispositivos con push:</span> ${n(s.devices)} · <span class="muted">Zona privada:</span> ${Number(u.privacy_zone_m ?? 0) > 0 ? 'sí' : 'no'}</p>
<p class="muted">ID: <code>${e(id)}</code></p>
${action}
</div>
<h2>Últimas carreras</h2>
${table(['Fecha', 'Nombre', '#Distancia', '#Tiempo', '#Área nueva', ''], routes.map((r) => `<tr>${td(madrid(r.completed_at))}${td(e(r.name))}${td(km(r.distance), true)}${td(`${Math.round(Number(r.duration ?? 0) / 60)} min`, true)}${td(km2(r.global_area_gained), true)}${td(status(r.validation_status))}</tr>`), 'Sin carreras.')}
<h2>Competiciones</h2>
${table(['#Ciclo', 'Club', 'Modo', '#Área', '#Carreras', '#Puesto final'], history.map((h) => `<tr>${td(`<a href="/admin/competitions/${encodeURIComponent(h.id)}">${n(h.cycle_number)}</a>`, true)}${td(e(h.club_name ?? '—'))}${td(modeLabel(h.mode))}${td(km2(h.area), true)}${td(n(h.runs), true)}${td(h.final_rank ? n(h.final_rank) : '—', true)}</tr>`), 'No ha jugado ninguna.')}
<h2>Denuncias recibidas</h2>
${table(['Fecha', 'Qué', 'Motivo', 'Quién', 'Estado'], reports.map((r) => `<tr>${td(madrid(r.created_at))}${td(e(r.target_type))}${td(e(r.reason))}${td(e(r.reporter ?? '—'))}${td(e(r.status ?? 'open'))}</tr>`), 'Ninguna.')}`;
}

// ─── Carreras ────────────────────────────────────────────────────────────────

const REASON_NAMES: Record<string, string> = {
  invalid_duration: 'duración no válida', too_fast: 'demasiado rápida', too_slow: 'demasiado lenta',
  vehicle: 'tramos en vehículo', vehicle_stretch_removed: 'tramo en vehículo quitado', gps_jumps: 'saltos de GPS',
  too_steady: 'ritmo demasiado constante', heart_rate: 'pulso incoherente', duplicate: 'duplicada',
  large_area: 'muchísima área de una vez', daily_area: 'muchísima área en el día', reviewed_reverted: 'revisada: no cuenta',
  before_season: 'anterior a la temporada',
};

export async function runsBody(storage: WorkerStorage, csrf: string): Promise<string> {
  const game = new GameStorage(storage.database);
  const flagged = await game.getFlaggedRuns(100);
  const latest = await storage.database.all<Row>(sql`SELECT r.id, r.user_id, r.name, r.distance, r.duration, r.completed_at, r.validation_status, r.global_area_gained,
      u.name AS user_name, u.username,
      CASE WHEN EXISTS (SELECT 1 FROM garmin_activities a WHERE a.route_id = r.id) THEN 'Garmin'
        WHEN EXISTS (SELECT 1 FROM suunto_activities a WHERE a.route_id = r.id) THEN 'Suunto'
        WHEN EXISTS (SELECT 1 FROM polar_activities a WHERE a.route_id = r.id) THEN 'Polar'
        WHEN EXISTS (SELECT 1 FROM strava_activities a WHERE a.route_id = r.id) THEN 'Strava'
        ELSE 'App / Salud' END AS source
    FROM routes r JOIN users u ON u.id = r.user_id ORDER BY r.completed_at DESC LIMIT 40`).catch(() => [] as Row[]);
  const pace = (distance: number, duration: number) => distance > 0 ? (() => { const s = duration / (distance / 1000); return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}/km`; })() : '—';
  const reasons = (raw: unknown) => {
    const list: string[] = Array.isArray(raw) ? raw : (() => { try { return JSON.parse(String(raw ?? '[]')); } catch { return []; } })();
    return list.map((r) => e(REASON_NAMES[r] ?? r)).join(', ');
  };
  const form = (routeId: string, action: 'approve' | 'revert', label: string, cls = '') =>
    `<form method="post" action="/admin/runs/review"><input type="hidden" name="csrf" value="${e(csrf)}"><input type="hidden" name="route" value="${e(routeId)}"><input type="hidden" name="action" value="${action}"><button class="${cls}">${label}</button></form>`;
  return `<h1>Carreras</h1>
<h2>En revisión (${flagged.length})</h2>
<p class="muted">El antitrampas las deja contar mientras tanto. «Aprobar» las deja como están; «No cuenta» quita su territorio y lo recalcula.</p>
${table(['Fecha', 'Corredor', 'Carrera', '#Distancia', '#Ritmo', 'Motivos', ''], flagged.map((r: Row) => `<tr>${td(madrid(r.completed_at))}${td(userLink(r.user_id, r.user_name, r.username))}${td(e(r.name))}${td(km(r.distance), true)}${td(pace(Number(r.distance), Number(r.duration)), true)}${td(reasons(r.validation_reasons))}${td(`<div class="actions">${form(r.id, 'approve', 'Aprobar', 'secondary')}${form(r.id, 'revert', 'No cuenta', 'danger')}</div>`)}</tr>`), 'Ninguna en revisión. 🎉')}
<h2>Últimas carreras</h2>
${table(['Fecha', 'Corredor', 'Carrera', 'Origen', '#Distancia', '#Ritmo', '#Área nueva', ''], latest.map((r) => `<tr>${td(madrid(r.completed_at))}${td(userLink(r.user_id, r.user_name, r.username))}${td(e(r.name))}${td(e(r.source))}${td(km(r.distance), true)}${td(pace(Number(r.distance), Number(r.duration)), true)}${td(km2(r.global_area_gained), true)}${td(r.validation_status === 'rejected' ? '<span class="tag danger">No cuenta</span>' : r.validation_status === 'flagged' ? '<span class="tag">En revisión</span>' : '')}</tr>`), 'Sin carreras.')}`;
}
