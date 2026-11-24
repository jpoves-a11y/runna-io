// Admin panel, served by the Worker at /admin (plain HTML, no JavaScript):
//   /admin         reports (open first) with the reported content and actions:
//                  delete the content, suspend the user, dismiss; suspended users can be reinstated
//   /admin/stats   product analytics: sign-ups, active users, first-week funnel, runs, screens
//
// Access: the admin secret (UPSTASH_CRON_SECRET, the same one /api/admin/* uses) typed once in
// /admin/login gives a 12-hour cookie (HttpOnly, Secure, SameSite=Strict) signed with HMAC. Every
// form carries a CSRF token derived from that cookie.
import type { Context, Hono } from 'hono';
import { sql } from 'drizzle-orm';
import type { AppEnv } from './auth';
import { forgetUserSessions, timingSafeEqual } from './auth';
import { WorkerStorage } from './storage';
import { createDb } from './db';
import { adminPage, escapeHtml } from './pages';
import { clientIp, lockedForSeconds, recordAttempt, clearAttempts, LIMITS } from './rateLimit';
import { dashboardBody, competitionsBody, competitionDetailBody, usersBody, userDetailBody, runsBody } from './adminViews';
import { emailServiceFromEnv, SUPPORT_EMAIL } from './email';
import { sampleEmail, SAMPLE_KINDS, SAMPLE_NAMES, type SampleKind } from './emailTemplates';
import { publicBaseUrl } from './pages';

type AdminContext = Context<AppEnv>;

const COOKIE = 'kaemedos_admin';
const SESSION_SECONDS = 12 * 60 * 60;

function adminSecret(c: AdminContext): string | null {
  const secret = c.env.UPSTASH_CRON_SECRET?.trim();
  return secret ? secret : null;
}

function base64Url(bytes: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64Url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

/** Cookie value: "<expiry seconds>.<HMAC of it>". */
export async function makeAdminSession(secret: string, now = Date.now()): Promise<string> {
  const expires = Math.floor(now / 1000) + SESSION_SECONDS;
  return `${expires}.${await hmac(secret, `admin-session:${expires}`)}`;
}

export async function isValidAdminSession(secret: string, value: string | undefined, now = Date.now()): Promise<boolean> {
  if (!value) return false;
  const [expires, signature] = value.split('.');
  const expiry = Number(expires);
  if (!Number.isFinite(expiry) || expiry * 1000 <= now || !signature) return false;
  return timingSafeEqual(signature, await hmac(secret, `admin-session:${expiry}`));
}

/** CSRF token of a session: only someone who can read the page (has the cookie) knows it. */
export async function csrfToken(secret: string, session: string): Promise<string> {
  return hmac(secret, `admin-csrf:${session}`);
}

function readCookie(c: AdminContext, name: string): string | undefined {
  const header = c.req.header('Cookie') ?? '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

function noStore(c: AdminContext) {
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Frame-Options', 'DENY');
}

const NAV_ITEMS: Array<[string, string]> = [
  ['/admin', 'Resumen'],
  ['/admin/reports', 'Denuncias'],
  ['/admin/competitions', 'Competiciones'],
  ['/admin/users', 'Usuarios'],
  ['/admin/runs', 'Carreras'],
  ['/admin/stats', 'Estadísticas'],
  ['/admin/emails', 'Correos'],
];

/** Top navigation; `active` is the path of the current section. */
function nav(active: string): string {
  const links = NAV_ITEMS.map(([href, label]) => `<a href="${href}"${href === active ? ' class="active" aria-current="page"' : ''}>${label}</a>`).join('');
  return `<nav class="admin-nav">${links}<form method="post" action="/admin/logout"><button class="link">Salir</button></form></nav>`;
}
const NAV = nav('/admin/reports');

function loginPage(message = ''): string {
  return adminPage('Panel · KM2', `
<h1>Panel de KM2</h1>
${message ? `<p class="flash error">${escapeHtml(message)}</p>` : ''}
<form method="post" action="/admin/login" class="card">
<label>Secreto de administración<br><input type="password" name="secret" autocomplete="current-password" required autofocus></label>
<button type="submit">Entrar</button>
</form>
<p class="muted">Es el valor de <code>UPSTASH_CRON_SECRET</code> del Worker.</p>`);
}

/** Session cookie and CSRF token of the request, or null (then the caller answers with the login page). */
async function adminSession(c: AdminContext): Promise<{ csrf: string } | null> {
  const secret = adminSecret(c);
  if (!secret) return null;
  const session = readCookie(c, COOKIE);
  if (!session || !(await isValidAdminSession(secret, session))) return null;
  return { csrf: await csrfToken(secret, session) };
}

async function checkCsrf(c: AdminContext, form: Record<string, unknown>): Promise<boolean> {
  const session = await adminSession(c);
  return Boolean(session && typeof form.csrf === 'string' && timingSafeEqual(form.csrf, session.csrf));
}

const storageOf = async (c: AdminContext) => {
  const storage = new WorkerStorage(createDb(c.env.DATABASE_URL, c.env.TURSO_AUTH_TOKEN));
  await storage.ensureSchemaUpgrades();
  return storage;
};

// ─── Reports ──────────────────────────────────────────────────────────────────

interface ReportRow {
  id: string;
  reporter_id: string;
  target_type: string;
  target_id: string;
  reported_user_id: string | null;
  reason: string;
  created_at: string;
  status: string | null;
  resolved_at: string | null;
  action: string | null;
  reporter_name: string | null;
  reporter_username: string | null;
  reported_name: string | null;
  reported_username: string | null;
  reported_banned_at: string | null;
  reported_count: number;
}

const TARGET_NAMES: Record<string, string> = {
  user: 'Usuario',
  comment: 'Comentario',
  feed_event: 'Publicación',
  photo: 'Foto',
  club_message: 'Mensaje del club',
};

const ACTION_NAMES: Record<string, string> = {
  content_removed: 'Contenido borrado',
  user_banned: 'Usuario suspendido',
  dismissed: 'Descartada',
};

/** What was reported, as HTML (text escaped); "ya no existe" when it was deleted. */
async function reportedContent(storage: WorkerStorage, type: string, id: string): Promise<string> {
  const db = storage.database;
  const gone = '<p class="muted">El contenido ya no existe.</p>';
  try {
    if (type === 'comment') {
      const [row] = await db.all<{ content: string }>(sql`SELECT content FROM feed_comments WHERE id = ${id}`);
      return row ? `<blockquote>${escapeHtml(row.content)}</blockquote>` : gone;
    }
    if (type === 'club_message') {
      const [row] = await db.all<{ body: string; deleted_at: string | null }>(sql`SELECT body, deleted_at FROM club_messages WHERE id = ${id}`);
      if (!row) return gone;
      return row.deleted_at ? '<p class="muted">Mensaje ya eliminado.</p>' : `<blockquote>${escapeHtml(row.body)}</blockquote>`;
    }
    if (type === 'photo') {
      const [row] = await db.all<{ photo_data: string; message: string | null }>(sql`SELECT photo_data, message FROM ephemeral_photos WHERE id = ${id}`);
      if (!row) return gone;
      const data = row.photo_data.startsWith('data:') ? row.photo_data : `data:image/jpeg;base64,${row.photo_data}`;
      const safe = /^data:image\/(jpeg|png|heic|webp);base64,[A-Za-z0-9+/=]+$/.test(data) ? data : null;
      return `${safe ? `<img class="evidence" src="${safe}" alt="Foto denunciada">` : '<p class="muted">Foto en un formato que no se puede mostrar.</p>'}
${row.message ? `<blockquote>${escapeHtml(row.message)}</blockquote>` : ''}`;
    }
    if (type === 'feed_event') {
      const [row] = await db.all<{ event_type: string; metadata: string | null; route_name: string | null }>(
        sql`SELECT f.event_type, f.metadata, r.name AS route_name FROM feed_events f LEFT JOIN routes r ON r.id = f.route_id WHERE f.id = ${id}`,
      );
      if (!row) return gone;
      return `<p>Tipo: ${escapeHtml(row.event_type)}${row.route_name ? ` · Carrera «${escapeHtml(row.route_name)}»` : ''}</p>`;
    }
    if (type === 'user') {
      const [row] = await db.all<{ name: string; username: string; avatar: string | null }>(sql`SELECT name, username, avatar FROM users WHERE id = ${id}`);
      if (!row) return gone;
      return `<p>Perfil de ${escapeHtml(row.name)} (@${escapeHtml(row.username)})</p>`;
    }
  } catch (err) {
    console.error('[ADMIN] Could not load reported content:', err);
  }
  return '';
}

/** Deletes the reported content. True when something was removed. */
async function removeContent(storage: WorkerStorage, type: string, id: string): Promise<boolean> {
  const db = storage.database;
  if (type === 'comment') {
    await db.run(sql`DELETE FROM feed_reactions WHERE target_type = 'comment' AND target_id IN (SELECT id FROM feed_comments WHERE id = ${id} OR parent_id = ${id})`);
    await db.run(sql`DELETE FROM feed_comments WHERE id = ${id} OR parent_id = ${id}`);
    return true;
  }
  if (type === 'club_message') {
    await db.run(sql`UPDATE club_messages SET deleted_at = ${new Date().toISOString()}, deleted_by = 'admin' WHERE id = ${id}`);
    return true;
  }
  if (type === 'photo') {
    await db.run(sql`DELETE FROM ephemeral_photos WHERE id = ${id}`);
    return true;
  }
  if (type === 'feed_event') {
    await db.run(sql`DELETE FROM feed_reactions WHERE (target_type = 'event' AND target_id = ${id}) OR (target_type = 'comment' AND target_id IN (SELECT id FROM feed_comments WHERE feed_event_id = ${id}))`);
    await db.run(sql`DELETE FROM feed_comments WHERE feed_event_id = ${id}`);
    await db.run(sql`DELETE FROM feed_events WHERE id = ${id}`);
    return true;
  }
  return false;
}

export async function banUser(storage: WorkerStorage, userId: string, reason: string): Promise<void> {
  await storage.database.run(sql`UPDATE users SET banned_at = ${new Date().toISOString()}, ban_reason = ${reason.slice(0, 300)} WHERE id = ${userId}`);
  await storage.deleteAuthSessionsByUserId(userId);
  forgetUserSessions(userId);
}

async function unbanUser(storage: WorkerStorage, userId: string): Promise<void> {
  await storage.database.run(sql`UPDATE users SET banned_at = NULL, ban_reason = NULL WHERE id = ${userId}`);
}

async function resolveReport(storage: WorkerStorage, id: string, status: 'open' | 'resolved' | 'dismissed', action: string | null): Promise<void> {
  await storage.database.run(sql`UPDATE reports SET status = ${status}, action = ${action}, resolved_at = ${status === 'open' ? null : new Date().toISOString()} WHERE id = ${id}`);
}

function formatDate(value: string | null): string {
  if (!value) return '';
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return escapeHtml(value);
  return date.toLocaleString('es-ES', { timeZone: 'Europe/Madrid', dateStyle: 'short', timeStyle: 'short' });
}

function who(name: string | null, username: string | null, id: string | null): string {
  if (!name && !username) return id ? `<span class="muted">${escapeHtml(id)} (borrado)</span>` : '—';
  return `${escapeHtml(name ?? '')} <span class="muted">@${escapeHtml(username ?? '')}</span>`;
}

async function reportsPage(c: AdminContext, csrf: string, flash: string | null): Promise<string> {
  const storage = await storageOf(c);
  const db = storage.database;
  const rows = await db.all<ReportRow>(sql`
    SELECT r.id, r.reporter_id, r.target_type, r.target_id, r.reported_user_id, r.reason, r.created_at,
      r.status, r.resolved_at, r.action,
      ru.name AS reporter_name, ru.username AS reporter_username,
      tu.name AS reported_name, tu.username AS reported_username, tu.banned_at AS reported_banned_at,
      (SELECT count(*) FROM reports x WHERE x.reported_user_id = r.reported_user_id) AS reported_count
    FROM reports r
    LEFT JOIN users ru ON ru.id = r.reporter_id
    LEFT JOIN users tu ON tu.id = r.reported_user_id
    ORDER BY CASE WHEN coalesce(r.status, 'open') = 'open' THEN 0 ELSE 1 END, r.created_at DESC
    LIMIT 100`);
  const banned = await db.all<{ id: string; name: string; username: string; banned_at: string; ban_reason: string | null }>(
    sql`SELECT id, name, username, banned_at, ban_reason FROM users WHERE banned_at IS NOT NULL ORDER BY banned_at DESC LIMIT 100`,
  );
  const open = rows.filter((row) => (row.status ?? 'open') === 'open');
  const closed = rows.filter((row) => (row.status ?? 'open') !== 'open');

  const hidden = (fields: Record<string, string>) =>
    Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`).join('');

  const card = async (row: ReportRow) => {
    const isOpen = (row.status ?? 'open') === 'open';
    const content = await reportedContent(storage, row.target_type, row.target_id);
    const base = { csrf, report: row.id };
    const actions = isOpen ? `
<div class="actions">
${row.target_type !== 'user' ? `<form method="post" action="/admin/reports/action">${hidden({ ...base, action: 'remove' })}<button>Borrar contenido</button></form>` : ''}
${row.reported_user_id && !row.reported_banned_at ? `<form method="post" action="/admin/reports/action">${hidden({ ...base, action: 'ban' })}<button class="danger">Borrar y suspender usuario</button></form>` : ''}
<form method="post" action="/admin/reports/action">${hidden({ ...base, action: 'dismiss' })}<button class="secondary">Descartar</button></form>
</div>` : `
<div class="actions"><span class="tag">${escapeHtml(ACTION_NAMES[row.action ?? ''] ?? row.status ?? '')} · ${formatDate(row.resolved_at)}</span>
<form method="post" action="/admin/reports/action">${hidden({ ...base, action: 'reopen' })}<button class="link">Reabrir</button></form></div>`;
    return `<article class="card${isOpen ? '' : ' closed'}">
<header><strong>${escapeHtml(TARGET_NAMES[row.target_type] ?? row.target_type)}</strong> · ${formatDate(row.created_at)}</header>
<p><span class="muted">Denunciado:</span> ${who(row.reported_name, row.reported_username, row.reported_user_id)}
${row.reported_banned_at ? '<span class="tag danger">Suspendido</span>' : ''}
${row.reported_count > 1 ? `<span class="tag">${row.reported_count} denuncias</span>` : ''}</p>
<p><span class="muted">Denuncia:</span> ${who(row.reporter_name, row.reporter_username, row.reporter_id)}</p>
<p><span class="muted">Motivo:</span> ${escapeHtml(row.reason)}</p>
${content}
${actions}
</article>`;
  };

  const openCards = (await Promise.all(open.map(card))).join('\n');
  const closedCards = (await Promise.all(closed.slice(0, 30).map(card))).join('\n');
  const bannedRows = banned.map((user) => `<tr><td>${who(user.name, user.username, user.id)}</td><td>${formatDate(user.banned_at)}</td><td>${escapeHtml(user.ban_reason ?? '')}</td>
<td><form method="post" action="/admin/users/unban">${hidden({ csrf, user: user.id })}<button class="link">Reactivar</button></form></td></tr>`).join('');

  return adminPage('Denuncias · KM2', `${NAV}
<h1>Denuncias</h1>
${flash ? `<p class="flash">${escapeHtml(flash)}</p>` : ''}
<p class="muted">Apple exige revisar cada denuncia en 24 horas. «Suspender» borra también el contenido, cierra sus sesiones y le impide volver a entrar.</p>
<h2>Pendientes (${open.length})</h2>
${openCards || '<p class="muted">No hay denuncias pendientes. 🎉</p>'}
<h2>Usuarios suspendidos (${banned.length})</h2>
${banned.length ? `<table><thead><tr><th>Usuario</th><th>Desde</th><th>Motivo</th><th></th></tr></thead><tbody>${bannedRows}</tbody></table>` : '<p class="muted">Ninguno.</p>'}
<h2>Revisadas</h2>
${closedCards || '<p class="muted">Ninguna todavía.</p>'}`);
}

// ─── Stats ────────────────────────────────────────────────────────────────────

const SYSTEM_USER = '__system_runna__';

async function statsPage(c: AdminContext): Promise<string> {
  const db = (await storageOf(c)).database;
  const one = async <T extends Record<string, number>>(query: ReturnType<typeof sql>): Promise<T> => {
    const [row] = await db.all<T>(query);
    return (row ?? {}) as T;
  };
  const number = (value: unknown) => Number(value ?? 0).toLocaleString('es-ES');
  const percent = (part: number, total: number) => (total > 0 ? `${Math.round((part / total) * 100)} %` : '—');

  const users = await one<{ total: number; d7: number; d30: number }>(sql`
    SELECT count(*) AS total,
      sum(CASE WHEN julianday(created_at) >= julianday('now', '-7 days') THEN 1 ELSE 0 END) AS d7,
      sum(CASE WHEN julianday(created_at) >= julianday('now', '-30 days') THEN 1 ELSE 0 END) AS d30
    FROM users WHERE id != ${SYSTEM_USER}`);
  // Active = opened the app or ran (runs imported from a watch count too)
  const active = await one<{ dau: number; wau: number; mau: number }>(sql`
    WITH activity AS (
      SELECT user_id, created_at AS at FROM app_events WHERE user_id IS NOT NULL AND julianday(created_at) >= julianday('now', '-30 days')
      UNION ALL
      SELECT user_id, completed_at AS at FROM routes WHERE julianday(completed_at) >= julianday('now', '-30 days')
    )
    SELECT
      count(DISTINCT CASE WHEN julianday(at) >= julianday('now', '-1 day') THEN user_id END) AS dau,
      count(DISTINCT CASE WHEN julianday(at) >= julianday('now', '-7 days') THEN user_id END) AS wau,
      count(DISTINCT user_id) AS mau
    FROM activity`);
  // Sign-ups of the last 30 days (that are at least a week old for the later steps)
  const funnel = await one<{ signed_up: number; ran_week1: number; social: number; matured: number; back_week2: number }>(sql`
    SELECT count(*) AS signed_up,
      sum(CASE WHEN EXISTS (SELECT 1 FROM routes r WHERE r.user_id = u.id AND julianday(r.completed_at) - julianday(u.created_at) <= 7) THEN 1 ELSE 0 END) AS ran_week1,
      sum(CASE WHEN EXISTS (SELECT 1 FROM friendships f WHERE f.user_id = u.id) OR EXISTS (SELECT 1 FROM club_members m WHERE m.user_id = u.id) THEN 1 ELSE 0 END) AS social,
      sum(CASE WHEN julianday(u.created_at) <= julianday('now', '-14 days') THEN 1 ELSE 0 END) AS matured,
      sum(CASE WHEN julianday(u.created_at) <= julianday('now', '-14 days') AND (
        EXISTS (SELECT 1 FROM app_events e WHERE e.user_id = u.id AND julianday(e.created_at) - julianday(u.created_at) BETWEEN 7 AND 14)
        OR EXISTS (SELECT 1 FROM routes r WHERE r.user_id = u.id AND julianday(r.completed_at) - julianday(u.created_at) BETWEEN 7 AND 14)
      ) THEN 1 ELSE 0 END) AS back_week2
    FROM users u
    WHERE u.id != ${SYSTEM_USER} AND julianday(u.created_at) >= julianday('now', '-30 days')`);
  const runsByDay = await db.all<{ day: string; total: number; garmin: number; suunto: number; polar: number; strava: number }>(sql`
    SELECT date(r.completed_at) AS day, count(*) AS total,
      sum(CASE WHEN EXISTS (SELECT 1 FROM garmin_activities a WHERE a.route_id = r.id) THEN 1 ELSE 0 END) AS garmin,
      sum(CASE WHEN EXISTS (SELECT 1 FROM suunto_activities a WHERE a.route_id = r.id) THEN 1 ELSE 0 END) AS suunto,
      sum(CASE WHEN EXISTS (SELECT 1 FROM polar_activities a WHERE a.route_id = r.id) THEN 1 ELSE 0 END) AS polar,
      sum(CASE WHEN EXISTS (SELECT 1 FROM strava_activities a WHERE a.route_id = r.id) THEN 1 ELSE 0 END) AS strava
    FROM routes r
    WHERE julianday(r.completed_at) >= julianday('now', '-14 days')
    GROUP BY day ORDER BY day DESC`).catch(() => []);
  const tabs = await db.all<{ tab: string; views: number; people: number }>(sql`
    SELECT coalesce(json_extract(props, '$.tab'), '?') AS tab, count(*) AS views, count(DISTINCT coalesce(user_id, install_id)) AS people
    FROM app_events WHERE name = 'tab_view' AND julianday(created_at) >= julianday('now', '-7 days')
    GROUP BY tab ORDER BY views DESC`);
  const events = await db.all<{ name: string; count: number; people: number }>(sql`
    SELECT name, count(*) AS count, count(DISTINCT coalesce(user_id, install_id)) AS people
    FROM app_events WHERE julianday(created_at) >= julianday('now', '-7 days')
    GROUP BY name ORDER BY count DESC LIMIT 40`);

  const signedUp = Number(funnel.signed_up ?? 0);
  const matured = Number(funnel.matured ?? 0);
  const step = (label: string, value: number, total: number, note = '') =>
    `<tr><td>${label}</td><td class="num">${number(value)}</td><td class="num">${percent(value, total)}</td><td class="muted">${note}</td></tr>`;

  return adminPage('Estadísticas · KM2', `${nav('/admin/stats')}
<h1>Estadísticas</h1>
<div class="tiles">
<div class="tile"><span>Usuarios</span><strong>${number(users.total)}</strong><small>+${number(users.d7)} en 7 días · +${number(users.d30)} en 30</small></div>
<div class="tile"><span>Activos hoy</span><strong>${number(active.dau)}</strong><small>abren la app o corren</small></div>
<div class="tile"><span>Activos 7 días</span><strong>${number(active.wau)}</strong><small>${percent(Number(active.wau ?? 0), Number(users.total ?? 0))} del total</small></div>
<div class="tile"><span>Activos 30 días</span><strong>${number(active.mau)}</strong></div>
</div>
<h2>Embudo de los nuevos (altas de los últimos 30 días)</h2>
<table><thead><tr><th>Paso</th><th class="num">Usuarios</th><th class="num">%</th><th></th></tr></thead><tbody>
${step('Se registran', signedUp, signedUp)}
${step('Corren en su primera semana', Number(funnel.ran_week1 ?? 0), signedUp)}
${step('Tienen un amigo o un club', Number(funnel.social ?? 0), signedUp)}
${step('Vuelven la segunda semana', Number(funnel.back_week2 ?? 0), matured, `sobre los ${number(matured)} con más de 14 días`)}
</tbody></table>
<h2>Carreras (14 días)</h2>
<table><thead><tr><th>Día</th><th class="num">Total</th><th class="num">App / Salud</th><th class="num">Garmin</th><th class="num">Suunto</th><th class="num">Polar</th><th class="num">Strava</th></tr></thead><tbody>
${runsByDay.map((row) => `<tr><td>${escapeHtml(row.day)}</td><td class="num">${row.total}</td><td class="num">${row.total - row.garmin - row.suunto - row.polar - row.strava}</td><td class="num">${row.garmin}</td><td class="num">${row.suunto}</td><td class="num">${row.polar}</td><td class="num">${row.strava}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Sin carreras.</td></tr>'}
</tbody></table>
<h2>Pestañas más vistas (7 días)</h2>
<table><thead><tr><th>Pestaña</th><th class="num">Vistas</th><th class="num">Personas</th></tr></thead><tbody>
${tabs.map((row) => `<tr><td>${escapeHtml(String(row.tab))}</td><td class="num">${row.views}</td><td class="num">${row.people}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Sin datos todavía.</td></tr>'}
</tbody></table>
<h2>Eventos de la app (7 días)</h2>
<table><thead><tr><th>Evento</th><th class="num">Veces</th><th class="num">Personas</th></tr></thead><tbody>
${events.map((row) => `<tr><td><code>${escapeHtml(row.name)}</code></td><td class="num">${row.count}</td><td class="num">${row.people}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Sin datos todavía.</td></tr>'}
</tbody></table>`);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export function registerAdminPanel(app: Hono<AppEnv>): void {
  const html = (c: AdminContext, body: string, status: 200 | 401 | 403 | 404 | 429 = 200) => {
    noStore(c);
    return c.html(body, status);
  };

  app.get('/admin/login', (c) => {
    if (!adminSecret(c)) return html(c, loginPage('El Worker no tiene UPSTASH_CRON_SECRET: el panel está desactivado.'), 403);
    return html(c, loginPage());
  });

  app.post('/admin/login', async (c) => {
    const secret = adminSecret(c);
    if (!secret) return html(c, loginPage('El Worker no tiene UPSTASH_CRON_SECRET: el panel está desactivado.'), 403);
    const storage = await storageOf(c);
    const ip = clientIp(c);
    const key = `admin-login:${ip ?? 'unknown'}`;
    const wait = await lockedForSeconds(storage, key);
    if (wait > 0) return html(c, loginPage(`Demasiados intentos. Espera ${Math.ceil(wait / 60)} minutos.`), 429);
    const form = await c.req.parseBody();
    const typed = typeof form.secret === 'string' ? form.secret.trim() : '';
    if (!typed || !timingSafeEqual(typed, secret)) {
      await recordAttempt(storage, key, LIMITS.loginAccount);
      return html(c, loginPage('Secreto incorrecto.'), 401);
    }
    await clearAttempts(storage, key);
    const session = await makeAdminSession(secret);
    c.header('Set-Cookie', `${COOKIE}=${session}; Path=/admin; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`);
    noStore(c);
    return c.redirect('/admin', 303);
  });

  app.post('/admin/logout', (c) => {
    c.header('Set-Cookie', `${COOKIE}=; Path=/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
    noStore(c);
    return c.redirect('/admin/login', 303);
  });

  /** A panel page: signed in or back to the login; `?ok=` shows a confirmation on top. */
  const section = (path: string, title: string, render: (storage: WorkerStorage, csrf: string, c: AdminContext) => Promise<string | null>) =>
    async (c: AdminContext) => {
      const session = await adminSession(c);
      if (!session) return c.redirect('/admin/login', 303);
      const body = await render(await storageOf(c), session.csrf, c);
      if (body === null) return html(c, adminPage('No encontrado · KM2', `${nav(path)}<h1>No encontrado</h1>`), 404);
      const flash = c.req.query('ok');
      return html(c, adminPage(`${title} · KM2`, `${nav(path)}${flash ? `<p class="flash">${escapeHtml(flash)}</p>` : ''}${body}`));
    };

  app.get('/admin', section('/admin', 'Resumen', (storage) => dashboardBody(storage)));
  app.get('/admin/competitions', section('/admin/competitions', 'Competiciones', (storage) => competitionsBody(storage)));
  app.get('/admin/competitions/:id', section('/admin/competitions', 'Competición', (storage, _csrf, c) => competitionDetailBody(storage, c.req.param('id') ?? '')));
  app.get('/admin/users', section('/admin/users', 'Usuarios', (storage, _csrf, c) => usersBody(storage, c.req.query('q') ?? '')));
  app.get('/admin/users/:id', section('/admin/users', 'Usuario', (storage, csrf, c) => userDetailBody(storage, c.req.param('id') ?? '', csrf)));
  app.get('/admin/runs', section('/admin/runs', 'Carreras', (storage, csrf) => runsBody(storage, csrf)));

  // Every email as users receive it, with made-up data, and a button to get one in an inbox
  app.get('/admin/emails', section('/admin/emails', 'Correos', async (_storage, csrf, c) => {
    const ctx = { baseUrl: publicBaseUrl(c), supportEmail: SUPPORT_EMAIL };
    const options = SAMPLE_KINDS.map((kind) => `<option value="${kind}">${escapeHtml(SAMPLE_NAMES[kind])}</option>`).join('');
    const previews = SAMPLE_KINDS.map((kind) => {
      const email = sampleEmail(ctx, kind, `${ctx.baseUrl}/email/unsubscribe?u=ejemplo&t=ejemplo`);
      return `<h2>${escapeHtml(SAMPLE_NAMES[kind])}</h2>
<p class="muted">Asunto: <strong>${escapeHtml(email.subject)}</strong></p>
<iframe title="${escapeHtml(SAMPLE_NAMES[kind])}" srcdoc="${escapeHtml(email.html)}" style="width:100%;max-width:420px;height:640px;border:1px solid #8884;border-radius:14px;background:#fff;"></iframe>`;
    }).join('');
    return `<h1>Correos</h1>
<p class="muted">Así los reciben los usuarios. Cada uno se adapta solo al modo oscuro del móvil. Mándate uno de prueba para verlo en tu bandeja de entrada.</p>
<form method="post" action="/admin/emails/send" class="inline-form card">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<input type="text" name="to" placeholder="tu@email.com" required inputmode="email" autocomplete="email">
<select name="kind" style="font:inherit;padding:8px;border-radius:10px;">${options}</select>
<button>Enviarme una prueba</button>
</form>
${previews}`;
  }));

  app.post('/admin/emails/send', async (c) => {
    const form = await c.req.parseBody();
    if (!(await checkCsrf(c, form))) return c.redirect('/admin/login', 303);
    const to = String(form.to ?? '').trim();
    const kind = String(form.kind ?? 'welcome') as SampleKind;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || !SAMPLE_KINDS.includes(kind)) {
      return c.redirect('/admin/emails?ok=' + encodeURIComponent('Escribe un correo válido.'), 303);
    }
    try {
      await emailServiceFromEnv(c.env, publicBaseUrl(c)).sendSample(to, kind);
      return c.redirect('/admin/emails?ok=' + encodeURIComponent(`Enviado «${SAMPLE_NAMES[kind]}» a ${to}. Mira también en spam.`), 303);
    } catch (err: any) {
      return c.redirect('/admin/emails?ok=' + encodeURIComponent(`No se pudo enviar: ${String(err?.message ?? err).slice(0, 200)}`), 303);
    }
  });

  app.get('/admin/reports', async (c) => {
    const session = await adminSession(c);
    if (!session) return c.redirect('/admin/login', 303);
    const flash = c.req.query('ok') ?? null;
    return html(c, await reportsPage(c, session.csrf, flash));
  });

  app.get('/admin/stats', async (c) => {
    if (!(await adminSession(c))) return c.redirect('/admin/login', 303);
    return html(c, await statsPage(c));
  });

  app.post('/admin/reports/action', async (c) => {
    const form = await c.req.parseBody();
    if (!(await checkCsrf(c, form))) return c.redirect('/admin/login', 303);
    const storage = await storageOf(c);
    const reportId = String(form.report ?? '');
    const action = String(form.action ?? '');
    const [report] = await storage.database.all<{ id: string; target_type: string; target_id: string; reported_user_id: string | null; reason: string }>(
      sql`SELECT id, target_type, target_id, reported_user_id, reason FROM reports WHERE id = ${reportId}`,
    );
    if (!report) return c.redirect('/admin/reports?ok=' + encodeURIComponent('Esa denuncia ya no existe.'), 303);
    let message = '';
    if (action === 'remove') {
      await removeContent(storage, report.target_type, report.target_id);
      await resolveReport(storage, report.id, 'resolved', 'content_removed');
      message = 'Contenido borrado.';
    } else if (action === 'ban') {
      await removeContent(storage, report.target_type, report.target_id);
      if (report.reported_user_id) await banUser(storage, report.reported_user_id, report.reason);
      // Every open report about that user is settled by the suspension
      if (report.reported_user_id) {
        await storage.database.run(sql`UPDATE reports SET status = 'resolved', action = 'user_banned', resolved_at = ${new Date().toISOString()}
          WHERE reported_user_id = ${report.reported_user_id} AND coalesce(status, 'open') = 'open'`);
      }
      await resolveReport(storage, report.id, 'resolved', 'user_banned');
      message = 'Usuario suspendido y contenido borrado.';
    } else if (action === 'dismiss') {
      await resolveReport(storage, report.id, 'dismissed', 'dismissed');
      message = 'Denuncia descartada.';
    } else if (action === 'reopen') {
      await resolveReport(storage, report.id, 'open', null);
      message = 'Denuncia reabierta.';
    }
    return c.redirect('/admin/reports?ok=' + encodeURIComponent(message), 303);
  });

  app.post('/admin/users/unban', async (c) => {
    const form = await c.req.parseBody();
    if (!(await checkCsrf(c, form))) return c.redirect('/admin/login', 303);
    const storage = await storageOf(c);
    const userId = String(form.user ?? '');
    await unbanUser(storage, userId);
    const back = form.back === 'user' ? `/admin/users/${encodeURIComponent(userId)}` : '/admin/reports';
    return c.redirect(`${back}?ok=` + encodeURIComponent('Usuario reactivado.'), 303);
  });

  app.post('/admin/users/ban', async (c) => {
    const form = await c.req.parseBody();
    if (!(await checkCsrf(c, form))) return c.redirect('/admin/login', 303);
    const storage = await storageOf(c);
    const userId = String(form.user ?? '');
    const reason = String(form.reason ?? '').trim() || 'Suspendido desde el panel';
    await banUser(storage, userId, reason);
    return c.redirect(`/admin/users/${encodeURIComponent(userId)}?ok=` + encodeURIComponent('Usuario suspendido: sus sesiones se han cerrado.'), 303);
  });

  // Review of a run the anti-cheat flagged: the same endpoint the API offers (/api/admin/runs/:id/review)
  app.post('/admin/runs/review', async (c) => {
    const form = await c.req.parseBody();
    if (!(await checkCsrf(c, form))) return c.redirect('/admin/login', 303);
    const secret = adminSecret(c)!;
    const routeId = String(form.route ?? '');
    const action = form.action === 'revert' ? 'revert' : 'approve';
    const response = await app.fetch(new Request(`https://internal/api/admin/runs/${encodeURIComponent(routeId)}/review`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    }), c.env, (() => { try { return c.executionCtx; } catch { return undefined; } })());
    const message = response.ok
      ? (action === 'approve' ? 'Carrera aprobada: sigue contando.' : 'La carrera ya no cuenta; su territorio se ha recalculado.')
      : `No se pudo revisar (${response.status}).`;
    return c.redirect('/admin/runs?ok=' + encodeURIComponent(message), 303);
  });
}
