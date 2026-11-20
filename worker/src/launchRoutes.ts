// Endpoints of the launch features that sit outside the game:
//   POST /api/events            product analytics from the app (admin panel → Estadísticas)
//   GET  /api/widget/summary    small summary for the home-screen widget
//   GET  /api/onboarding/missions  welcome missions of the first two weeks (gift when all are done)
import type { Context, Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { createDb } from './db';
import { WorkerStorage } from './storage';
import { GameStorage } from './gameStorage';
import { requireAuth, isCronRequest, type AppEnv } from './auth';
import { cycleAt, monthPeriod } from './cycles';
import { competitionStandings, seededRandom } from './season';
import { pickRewardItem } from '../../shared/game';

type Ctx = Context<AppEnv>;

const MAX_EVENTS_PER_REQUEST = 50;
const EVENT_NAME = /^[a-z][a-z0-9_]{1,47}$/;
export const EVENT_RETENTION_DAYS = 180;
const WELCOME_DAYS = 14;

function stores(c: Ctx) {
  const db = createDb(c.env.DATABASE_URL, c.env.TURSO_AUTH_TOKEN);
  return { storage: new WorkerStorage(db), game: new GameStorage(db), db };
}

/** Props of an event: a flat object of short strings, numbers and booleans (anything else is dropped). */
export function cleanProps(value: unknown): Record<string, string | number | boolean> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const props: Record<string, string | number | boolean> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, 12)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(key)) continue;
    if (typeof raw === 'string') props[key] = raw.slice(0, 80);
    else if (typeof raw === 'number' && Number.isFinite(raw)) props[key] = raw;
    else if (typeof raw === 'boolean') props[key] = raw;
  }
  return Object.keys(props).length ? props : null;
}

/** Events of a request ready to insert (bad ones are skipped). */
export function parseEvents(body: any): Array<{ name: string; props: string | null; at: string }> {
  const list = Array.isArray(body?.events) ? body.events.slice(0, MAX_EVENTS_PER_REQUEST) : [];
  const now = Date.now();
  const events: Array<{ name: string; props: string | null; at: string }> = [];
  for (const item of list) {
    const name = typeof item?.name === 'string' ? item.name : '';
    if (!EVENT_NAME.test(name)) continue;
    // The app's clock: accepted within the last 3 days (buffered offline) and not in the future
    const at = Date.parse(String(item?.at ?? ''));
    const when = Number.isFinite(at) && at <= now + 5 * 60_000 && at >= now - 3 * 86_400_000 ? at : now;
    const props = cleanProps(item?.props);
    events.push({ name, props: props ? JSON.stringify(props) : null, at: new Date(when).toISOString() });
  }
  return events;
}

export function registerLaunchRoutes(app: Hono<AppEnv>): void {
  // Cron (04:15): analytics events are kept 180 days at most (privacy policy, 2.9)
  app.post('/api/tasks/events-purge', async (c) => {
    if (!(await isCronRequest(c))) return c.json({ error: 'Unauthorized' }, 401);
    const { db } = stores(c);
    const result = await db.run(sql`DELETE FROM app_events WHERE julianday(created_at) < julianday('now', ${`-${EVENT_RETENTION_DAYS} days`})`);
    return c.json({ deleted: result.rowsAffected ?? 0 });
  });

  // Batched: one insert for the whole request
  app.post('/api/events', requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const events = parseEvents(body);
    if (events.length === 0) return c.json({ stored: 0 });
    const installId = typeof body?.installId === 'string' ? body.installId.slice(0, 64) : null;
    const appVersion = typeof body?.appVersion === 'string' ? body.appVersion.slice(0, 32) : null;
    const userId = c.get('authUserId');
    const { db } = stores(c);
    const values = events.map((e) => sql`(${userId}, ${installId}, ${e.name}, ${e.props}, ${appVersion}, ${e.at})`);
    await db.run(sql`INSERT INTO app_events (user_id, install_id, name, props, app_version, created_at) VALUES ${sql.join(values, sql`, `)}`);
    return c.json({ stored: events.length });
  });

  app.get('/api/widget/summary', requireAuth, async (c) => {
    const { storage, game, db } = stores(c);
    const userId = c.get('authUserId');
    const user = await storage.getUser(userId);
    if (!user) return c.json({ error: 'Usuario no encontrado.' }, 404);
    const now = Date.now();
    const month = monthPeriod(now);
    const cityRank = user.city
      ? (await game.globalRankOf(userId, { period: 'all', month, countryCode: user.countryCode, city: user.city })).rank
      : null;
    // Last steal against me in the last 48 h (competition territory)
    const [steal] = await db.all<{ name: string; area_stolen: number | null; created_at: string }>(sql`
      SELECT u.name, f.area_stolen, f.created_at FROM feed_events f JOIN users u ON u.id = f.user_id
      WHERE f.victim_id = ${userId} AND f.event_type = 'territory_stolen'
        AND julianday(f.created_at) >= julianday('now', '-2 days')
      ORDER BY f.created_at DESC LIMIT 1`);
    const info = cycleAt(now);
    let competition: Record<string, unknown> | null = null;
    const participation = await game.getActiveParticipation(userId);
    if (participation) {
      const standings = await competitionStandings(game, participation.competition, now);
      const me = standings.find((s: any) => s.userId === userId);
      competition = { rank: me?.rank ?? null, participants: standings.length, endsAt: info.competitionEndsAt };
    }
    return c.json({
      name: user.name,
      color: user.color,
      area: Number(user.globalArea ?? 0) + Number(user.globalBonusArea ?? 0),
      city: user.city ?? null,
      cityRank,
      streakDays: Number(user.streakDays ?? 0),
      lastSteal: steal ? { by: steal.name, area: Number(steal.area_stolen ?? 0), at: steal.created_at } : null,
      phase: info.phase,
      nextChangeAt: info.phase === 'competition' ? info.competitionEndsAt : info.restEndsAt,
      competition,
      serverTime: new Date(now).toISOString(),
    });
  });

  // ?health=1 when the app imports from Apple Health (the server can't tell)
  app.get('/api/onboarding/missions', requireAuth, async (c) => {
    const { storage, game, db } = stores(c);
    const userId = c.get('authUserId');
    const user = await storage.getUser(userId);
    if (!user) return c.json({ error: 'Usuario no encontrado.' }, 404);
    const createdMs = Date.parse(user.createdAt.includes('T') ? user.createdAt : `${user.createdAt.replace(' ', 'T')}Z`);
    const ageDays = Number.isFinite(createdMs) ? (Date.now() - createdMs) / 86_400_000 : 0;

    const [counts] = await db.all<{ runs: number; friends: number; devices: number }>(sql`
      SELECT
        (SELECT count(*) FROM routes WHERE user_id = ${userId}) AS runs,
        (SELECT count(*) FROM friendships WHERE user_id = ${userId}) AS friends,
        (SELECT count(*) FROM garmin_accounts WHERE user_id = ${userId})
          + (SELECT count(*) FROM suunto_accounts WHERE user_id = ${userId})
          + (SELECT count(*) FROM polar_accounts WHERE user_id = ${userId})
          + (SELECT count(*) FROM strava_accounts WHERE user_id = ${userId}) AS devices`).catch(() => [{ runs: 0, friends: 0, devices: 0 }]);
    const membership = await game.getMembership(userId);
    const missions = [
      { id: 'first_run', title: 'Sal a correr', detail: 'Graba tu primera carrera o importa una de tu reloj.', done: Number(counts?.runs ?? 0) > 0 },
      { id: 'first_territory', title: 'Conquista tu primer territorio', detail: 'Cierra un recorrido para que su área sea tuya.', done: Number(user.globalArea ?? 0) > 0 },
      { id: 'first_friend', title: 'Añade un amigo', detail: 'Invita a alguien: así podéis robaros territorio.', done: Number(counts?.friends ?? 0) > 0 },
      { id: 'join_club', title: 'Únete a un club', detail: 'Compite con tu club cada dos semanas.', done: Boolean(membership) },
      { id: 'connect_device', title: 'Conecta tu reloj', detail: 'Garmin, Suunto, Polar o Apple Salud: tus carreras llegan solas.', done: Number(counts?.devices ?? 0) > 0 || c.req.query('health') === '1' },
    ];
    const completed = missions.filter((m) => m.done).length;
    let rewardItem: string | null = null;
    if (completed === missions.length && !user.welcomeRewardAt) {
      // One gift, once: the update only succeeds for the first request that gets here
      const claimed = await db.run(sql`UPDATE users SET welcome_reward_at = ${new Date().toISOString()} WHERE id = ${userId} AND welcome_reward_at IS NULL`);
      if ((claimed.rowsAffected ?? 0) > 0) {
        rewardItem = pickRewardItem('rare', seededRandom(`welcome:${userId}`), await game.ownedCosmetics(userId));
        await game.grantItem(userId, rewardItem, 'welcome', userId);
      }
    }
    const visible = rewardItem !== null || (ageDays <= WELCOME_DAYS && !(completed === missions.length && user.welcomeRewardAt));
    return c.json({
      visible,
      daysLeft: Math.max(0, Math.ceil(WELCOME_DAYS - ageDays)),
      completed,
      total: missions.length,
      missions,
      rewardItem,
    });
  });
}
