// API of the new game: Global mode (map, rankings, location), clubs, the season (competition,
// inventory, challenges) and its admin/cron endpoints. Rules live in shared/game.ts.
import type { Context, Hono } from 'hono';
import { createDb } from './db';
import { WorkerStorage } from './storage';
import { requireAuth, requireAdmin, isCronRequest, type AppEnv } from './auth';
import { publicBaseUrl } from './pages';
import {
  GameStorage,
  setRunsCountFrom,
  cityKeyOf,
  type ClubRow,
  type CompetitionRow,
  type InventoryRow,
  type PublicUserLite,
} from './gameStorage';
import { cycleAt, cycleBounds, isRestLike, isClosing, monthPeriod, type CycleInfo } from './cycles';
import {
  seasonTick,
  joinRunningCompetition,
  lateEntryOpen,
  competitionStandings,
  eliminationStatus,
  flagHolders,
  MAPLESS_MODES,
  ensureChallenges,
  duelScore,
  participantScore,
  targetArea,
  notifyUsers,
  SEASON_RESET_KEY,
  type CompetitionEntry,
} from './season';
import { competitionContextFor, rebuildGlobalForUser, rebuildCompetitionForUser } from './runPipeline';
import { parseGeometry } from './globalTerritory';
import { canInvite, isOfficer, joinDecision, parseEntryMode, entryModeFromVisibility, CLUB_DESCRIPTION_MAX, type JoinVia } from './clubRules';
import { withReasons, haversineMeters } from './antiCheat';
import {
  ITEMS,
  MODE_INFO,
  itemUsableInMode,
  CHALLENGES,
  INVENTORY_CAP,
  HEAD_START_BONUS_M2,
  LATE_JOIN_HOURS,
  ELIMINATION_CUTS,
  CLUB_MAX_MEMBERS,
  CLUB_NAME_MIN,
  CLUB_NAME_MAX,
  CLUB_SLOGAN_MAX,
  CREST_SHAPES,
  CREST_PATTERNS,
  CREST_ICONS,
  DEFAULT_CREST,
  DUEL_PER_RUNNER_CAP_M2,
  RARITY_INFO,
  type CompetitionMode,
  type Crest,
  type ClubRole,
  type ChallengeType,
} from '../../shared/game';

type Ctx = Context<AppEnv>;

function stores(c: Ctx): { storage: WorkerStorage; game: GameStorage } {
  const db = createDb(c.env.DATABASE_URL, c.env.TURSO_AUTH_TOKEN);
  return { storage: new WorkerStorage(db), game: new GameStorage(db) };
}

async function body(c: Ctx): Promise<Record<string, any>> {
  try {
    const value = await c.req.json();
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function fail(c: Ctx, status: 400 | 403 | 404 | 409 | 422 | 500, error: string, extra: Record<string, unknown> = {}) {
  return c.json({ error, ...extra }, status);
}

/** Runs a handler and turns unexpected errors into a 500 with a message. */
function handler(fn: (c: Ctx) => Promise<Response>) {
  return async (c: Ctx) => {
    try {
      return await fn(c);
    } catch (error: any) {
      console.error(`[GAME API] ${c.req.method} ${c.req.path} failed:`, error);
      return c.json({ error: error?.message || 'Error interno' }, 500);
    }
  };
}

// ─── Serialization ───────────────────────────────────────────────────────────

function cycleJson(info: CycleInfo, now = Date.now()) {
  const next = cycleBounds(info.number + 1);
  return {
    number: info.number,
    phase: info.phase,
    competitionStartsAt: info.competitionStartsAt,
    competitionEndsAt: info.competitionEndsAt,
    // Scored at this time (Monday 06:00): runs that started before the end still count until then
    competitionClosesAt: info.competitionClosesAt,
    closing: isClosing(info, now),
    restEndsAt: info.restEndsAt,
    mode: info.mode,
    modeInfo: MODE_INFO[info.mode],
    nextCompetitionStartsAt: info.phase === 'competition' ? new Date(next.competitionStart).toISOString() : info.restEndsAt,
    nextMode: MODE_INFO[cycleAt(Date.parse(info.restEndsAt) + 60_000).mode],
  };
}

/** A club as the app sees it. The join code only for members who can invite (`role`). */
function clubJson(club: ClubRow, options: { role?: ClubRole | null } = {}) {
  const withCode = canInvite(options.role ?? null, club.invitePermission);
  return {
    id: club.id,
    name: club.name,
    slogan: club.slogan,
    description: club.description,
    crest: { ...DEFAULT_CREST, ...club.crest },
    color: club.color,
    visibility: club.visibility,
    entryMode: club.entryMode,
    invitePermission: club.invitePermission,
    city: club.city,
    countryCode: club.countryCode,
    countryName: club.countryName,
    rating: Math.round(club.rating),
    leaguePoints: club.leaguePoints,
    memberCount: club.memberCount,
    maxMembers: CLUB_MAX_MEMBERS,
    createdAt: club.createdAt,
    ...(withCode ? { joinCode: club.joinCode } : {}),
  };
}

function itemJson(row: InventoryRow) {
  return {
    id: row.id,
    itemId: row.itemId,
    scope: row.scope,
    status: row.status,
    source: row.source,
    activatedAt: row.activatedAt,
    activeUntil: row.activeUntil,
    unusedExpiresAt: row.unusedExpiresAt,
    metadata: row.metadata,
    createdAt: row.createdAt,
    definition: ITEMS[row.itemId] ?? null,
  };
}

function rarityJson(rarity: string) {
  const info = RARITY_INFO[rarity as keyof typeof RARITY_INFO];
  return info ? { id: rarity, label: info.label, color: info.color } : { id: rarity, label: rarity, color: '#999999' };
}

// ─── Validation ──────────────────────────────────────────────────────────────

const HEX = /^#[0-9A-Fa-f]{6}$/;

/** Club description: trimmed, line breaks kept (at most two in a row), control characters removed. */
function cleanDescription(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return text.length > 0 ? text : null;
}

function cleanName(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/** Checks a crest; locked pieces need the cosmetic owned by someone in the club (or the creator). */
export function validateCrest(input: any, unlocked: Set<string>): { crest: Crest } | { error: string } {
  const crest: Crest = { ...DEFAULT_CREST, ...(input && typeof input === 'object' ? input : {}) };
  if (!(crest.shape in CREST_SHAPES)) return { error: 'Forma de escudo no válida.' };
  if (!(crest.pattern in CREST_PATTERNS)) return { error: 'Fondo de escudo no válido.' };
  if (!(crest.icon in CREST_ICONS)) return { error: 'Icono de escudo no válido.' };
  if (!HEX.test(crest.primary) || !HEX.test(crest.secondary)) return { error: 'Colores de escudo no válidos.' };
  crest.initials = String(crest.initials ?? '').trim().toUpperCase();
  if ([...crest.initials].length > 3 || !/^[\p{L}\p{N}]*$/u.test(crest.initials)) return { error: 'Las iniciales del escudo son de 0 a 3 letras o números.' };
  for (const unlock of [CREST_SHAPES[crest.shape].unlock, CREST_PATTERNS[crest.pattern].unlock, CREST_ICONS[crest.icon].unlock]) {
    if (unlock && !unlocked.has(unlock)) {
      return { error: `Esa pieza del escudo está bloqueada: consigue «${ITEMS[unlock]?.name ?? unlock}» en un cofre o reto.` };
    }
  }
  return { crest: { shape: crest.shape, pattern: crest.pattern, primary: crest.primary.toUpperCase(), secondary: crest.secondary.toUpperCase(), icon: crest.icon, initials: crest.initials } };
}

function validateClubName(name: string): string | null {
  if ([...name].length < CLUB_NAME_MIN) return `El nombre del club debe tener al menos ${CLUB_NAME_MIN} caracteres.`;
  if ([...name].length > CLUB_NAME_MAX) return `El nombre del club no puede tener más de ${CLUB_NAME_MAX} caracteres.`;
  if (!/^[\p{L}\p{N} .,'&!¡¿?\-_]+$/u.test(name)) return 'El nombre del club solo puede tener letras, números, espacios y signos básicos.';
  return null;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomCode(length = 6): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ─── Club helpers ────────────────────────────────────────────────────────────

/**
 * Whether `userId` takes part in a competition that is not scored yet (leaving/kicking is blocked
 * then): during its 10 days and until its close on Monday 06:00.
 */
async function inRunningCompetition(game: GameStorage, userId: string): Promise<boolean> {
  return !!(await game.getActiveParticipation(userId));
}

async function joinClub(storage: WorkerStorage, game: GameStorage, env: any, club: ClubRow, userId: string): Promise<{ ok: true; joinedCompetition: boolean; competitionEntry: CompetitionEntry } | { ok: false; status: 409; error: string }> {
  if (await game.getMembership(userId)) return { ok: false, status: 409, error: 'Ya estás en un club. Sal de él antes de unirte a otro.' };
  if (club.memberCount >= CLUB_MAX_MEMBERS) return { ok: false, status: 409, error: `El club está completo (${CLUB_MAX_MEMBERS} miembros).` };
  if (!(await game.addMember(club.id, userId, 'member'))) return { ok: false, status: 409, error: 'Ya estás en un club.' };
  const competitionEntry = await joinRunningCompetition(game, club.id, userId);
  const joinedCompetition = competitionEntry === 'joined' || competitionEntry === 'participant';
  const admins = (await game.getClubMembers(club.id)).filter((m) => m.role !== 'member' && m.userId !== userId).map((m) => m.userId);
  const user = (await game.getUserLite([userId])).get(userId);
  await notifyUsers(storage, env, admins, {
    title: `🛡️ Nuevo miembro en ${club.name}`,
    body: `${user?.name ?? 'Alguien'} se ha unido al club.`,
    tag: `club-join-${club.id}`,
    data: { type: 'club_member_joined', clubId: club.id },
  });
  return { ok: true, joinedCompetition, competitionEntry };
}

/** Sends a join request to the club's leader and officers. */
async function requestToJoin(storage: WorkerStorage, game: GameStorage, env: any, club: ClubRow, userId: string): Promise<string> {
  const requestId = await game.createClubRequest(club.id, userId, 'request', null);
  const officers = (await game.getClubMembers(club.id)).filter((m) => isOfficer(m.role)).map((m) => m.userId);
  const user = (await game.getUserLite([userId])).get(userId);
  await notifyUsers(storage, env, officers, {
    title: `🛡️ Solicitud para ${club.name}`,
    body: `${user?.name ?? 'Alguien'} quiere unirse al club.`,
    tag: `club-request-${club.id}`,
    data: { type: 'club_request', clubId: club.id },
  });
  return requestId;
}

/**
 * Someone tries to enter `club` (from its search card, with its code or with an invite): joins at
 * once, sends a request for approval, or is refused, following clubRules.joinDecision.
 */
async function enterClub(c: Ctx, storage: WorkerStorage, game: GameStorage, club: ClubRow, userId: string, via: JoinVia, inviterId: string | null = null) {
  if (await game.getMembership(userId)) return fail(c, 409, 'Ya estás en un club. Sal de él antes de unirte a otro.');
  let inviterRole: ClubRole | null = null;
  if (inviterId) {
    const inviter = await game.getMembership(inviterId);
    inviterRole = inviter && inviter.clubId === club.id ? inviter.role : null;
  }
  const decision = joinDecision(club.entryMode, via, club.invitePermission, inviterRole);
  if (decision === 'forbidden') {
    return fail(c, 403, via === 'search' ? 'Este club es solo por invitación.' : 'Esta invitación ya no es válida: pide otra a un oficial del club.');
  }
  if (decision === 'request') {
    const requestId = await requestToJoin(storage, game, c.env, club, userId);
    return c.json({ joined: false, requested: true, requestId, club: clubJson(club) });
  }
  const joined = await joinClub(storage, game, c.env, club, userId);
  if (!joined.ok) return fail(c, joined.status, joined.error);
  return c.json({ joined: true, joinedCompetition: joined.joinedCompetition, competitionEntry: joined.competitionEntry, club: clubJson((await game.getClub(club.id))!, { role: 'member' }) });
}

async function clubHistory(game: GameStorage, clubId: string, limit = 20) {
  const history = await game.getClubCompetitionHistory(clubId, limit);
  const users = await game.getUserLite(history.flatMap((h) => (h.result?.mvpUserId ? [h.result.mvpUserId] : [])));
  return history.map((h) => ({
    competitionId: h.id,
    cycleNumber: h.cycleNumber,
    mode: h.mode,
    modeInfo: MODE_INFO[h.mode as CompetitionMode] ?? null,
    finishedAt: h.finishedAt,
    score: h.score,
    outcome: h.result?.outcome ?? null,
    achieved: h.result?.achieved ?? null,
    target: h.result?.target ?? null,
    opponent: h.result?.opponent ?? null,
    winnerTeam: h.result?.winnerTeam ?? null,
    teamScores: h.result?.teamScores ?? null,
    leaguePoints: h.result?.leaguePoints ?? 0,
    mvp: h.result?.mvpUserId ? users.get(h.result.mvpUserId) ?? null : null,
    podium: (h.result?.standings ?? []).slice(0, 3).map((s: any) => ({ userId: s.userId, name: s.name, score: s.score, rank: s.rank })),
  }));
}

function trophiesOf(history: Awaited<ReturnType<typeof clubHistory>>) {
  return {
    competitions: history.length,
    duelsWon: history.filter((h) => h.outcome === 'won').length,
    duelsDrawn: history.filter((h) => h.outcome === 'draw').length,
    duelsLost: history.filter((h) => h.outcome === 'lost').length,
    targetsAchieved: history.filter((h) => h.achieved === true).length,
  };
}

// ─── Competition view ────────────────────────────────────────────────────────

async function competitionView(game: GameStorage, competition: CompetitionRow, userId: string) {
  if (competition.status === 'active') await game.syncParticipantAreas(competition.id);
  const participants = await game.getParticipants(competition.id);
  const byUser = new Map(participants.map((p) => [p.userId, p]));
  const users = await game.getUserLite(participants.map((p) => p.userId));
  // Scores and order by mode (flag hours, new global area, elimination order...)
  const ranked = await competitionStandings(game, competition);
  const standings = ranked.map((s) => {
    const p = byUser.get(s.userId)!;
    return {
      user: users.get(s.userId) ?? null, userId: s.userId, score: s.score, area: p.area, bonus: p.bonus, team: p.team,
      runs: p.runs, areaStolen: p.areaStolen, distance: p.distance, finalRank: p.finalRank, rank: s.rank,
      eliminatedCut: p.eliminatedCut,
    };
  });
  const me = standings.find((s) => s.userId === userId) ?? null;
  const total = standings.reduce((sum, s) => sum + s.score, 0);
  const view: Record<string, unknown> = {
    id: competition.id,
    cycleNumber: competition.cycleNumber,
    mode: competition.mode,
    modeInfo: MODE_INFO[competition.mode as CompetitionMode] ?? null,
    status: competition.status,
    participants: standings.length,
    myRank: me?.rank ?? null,
    myScore: me?.score ?? 0,
    myTeam: me?.team ?? null,
    total,
    standings: standings.slice(0, 50),
    result: competition.status === 'finished' ? competition.result : null,
  };
  if (competition.mode === 'teams') {
    const names: string[] = competition.config?.teamNames ?? ['Equipo Sol', 'Equipo Luna'];
    view.teams = [0, 1].map((team) => ({
      index: team,
      name: names[team] ?? `Equipo ${team + 1}`,
      score: standings.filter((s) => s.team === team).reduce((sum, s) => sum + s.score, 0),
      members: standings.filter((s) => s.team === team).length,
    }));
  }
  if (competition.mode === 'target') {
    const target = Number(competition.config?.target) || targetArea(standings.length);
    view.target = { target, total, achieved: total >= target, progress: Math.min(1, total / target) };
  }
  if (competition.mode === 'flags') {
    const flags = await game.getFlags(competition.id);
    const captures = await game.getFlagCaptures(competition.id);
    const end = cycleBounds(competition.cycleNumber).competitionEnd;
    const holders = flagHolders(flags.map((f) => f.id), captures, Math.min(Date.now(), end));
    const holderUsers = await game.getUserLite([...holders.values()].map((h) => h.userId));
    view.flags = flags.map((f) => {
      const holder = holders.get(f.id) ?? null;
      return { id: f.id, name: f.name, lat: f.lat, lng: f.lng, holderId: holder?.userId ?? null, holder: holder ? holderUsers.get(holder.userId) ?? null : null, since: holder?.since ?? null };
    });
    view.myFlags = flags.filter((f) => holders.get(f.id)?.userId === userId).length;
  }
  if (competition.mode === 'elimination') {
    const status = await eliminationStatus(game, competition);
    const fallenUsers = await game.getUserLite(status.cuts.flatMap((c) => c.eliminated));
    view.elimination = {
      cuts: status.cuts.map((c) => ({ index: c.index, at: c.at, remaining: c.remaining, eliminated: c.eliminated.map((id) => fallenUsers.get(id) ?? null).filter(Boolean) })),
      next: status.next,
      alive: status.alive,
      totalCuts: ELIMINATION_CUTS,
      window: status.window.map((w) => ({ ...w, user: users.get(w.userId) ?? null })),
      myCut: byUser.get(userId)?.eliminatedCut ?? null,
    };
  }
  if (competition.mode === 'duel' || competition.mode === 'derby') {
    const runnersCounted = Number(competition.config?.runnersCounted) || 0;
    const opponentClub = competition.opponentClubId ? await game.getClub(competition.opponentClubId) : null;
    let opponentScore = 0;
    let opponentStandings: Array<{ userId: string; user: PublicUserLite | null; score: number }> = [];
    if (competition.opponentClubId) {
      const opponentComp = await game.getClubCompetition(competition.opponentClubId, competition.cycleNumber);
      if (opponentComp) {
        if (opponentComp.status === 'active') await game.syncParticipantAreas(opponentComp.id);
        const opponents = await game.getParticipants(opponentComp.id);
        opponentScore = duelScore(opponents.map(participantScore), runnersCounted);
        const opponentUsers = await game.getUserLite(opponents.map((p) => p.userId));
        opponentStandings = opponents
          .map((p) => ({ userId: p.userId, user: opponentUsers.get(p.userId) ?? null, score: participantScore(p) }))
          .sort((a, b) => b.score - a.score);
      }
    }
    view.duel = {
      opponent: opponentClub ? clubJson(opponentClub) : null,
      runnersCounted,
      perRunnerCap: Number(competition.config?.perRunnerCap) || DUEL_PER_RUNNER_CAP_M2,
      myClubScore: duelScore(standings.map((s) => s.score), runnersCounted),
      opponentScore,
      // Rival runners (targets of Espía / Sabotaje / Pluma del Troll)
      opponentStandings: opponentStandings.slice(0, 50),
    };
  }
  return view;
}

async function challengesJson(game: GameStorage, userId: string, info: CycleInfo) {
  if (!isRestLike(info.phase)) return [];
  await ensureChallenges(game, userId, info);
  return (await game.getChallenges(userId, info.number)).map((ch) => {
    const def = CHALLENGES[ch.type as ChallengeType];
    return {
      id: ch.id,
      type: ch.type,
      title: def?.title ?? ch.type,
      description: def?.description ?? '',
      emoji: def?.emoji ?? '🎯',
      unit: def?.unit ?? 'runs',
      target: ch.target,
      progress: Math.min(ch.progress, ch.target),
      status: ch.status,
      reward: rarityJson(ch.rewardRarity),
      rewardItem: ch.rewardItem ? ITEMS[ch.rewardItem] ?? null : null,
      completedAt: ch.completedAt,
    };
  });
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export function registerGameRoutes(app: Hono<AppEnv>): void {
  // ── Season ──

  app.get('/api/season/current', requireAuth, handler(async (c) => {
    const { game } = stores(c);
    const userId = c.get('authUserId');
    const now = Date.now();
    const info = cycleAt(now);
    const membership = await game.getMembership(userId);
    const club = membership ? await game.getClub(membership.clubId) : null;
    let competition: Record<string, unknown> | null = null;
    const participation = await game.getActiveParticipation(userId);
    if (participation) competition = await competitionView(game, participation.competition, userId);
    // A member who doesn't take part (inactive, or joined too late): their club's competition, to
    // follow it, and whether/how they can still enter
    let clubCompetition: Record<string, unknown> | null = null;
    let competitionEntry: string | null = participation ? 'participant' : null;
    if (!participation && membership) {
      const running = (await game.getCompetitionsOfCycle(info.number)).find((comp) => comp.clubId === membership.clubId && comp.status === 'active')
        ?? null;
      if (running && info.phase === 'competition') {
        clubCompetition = await competitionView(game, running, userId);
        const lateJoinLimit = Date.parse(info.competitionStartsAt) + LATE_JOIN_HOURS * 60 * 60 * 1000;
        competitionEntry = Date.parse(membership.joinedAt) > lateJoinLimit
          ? 'next_cycle'
          : lateEntryOpen(running, info, now) ? 'on_first_run' : 'closed_entry';
      }
    }
    const last = (await game.getParticipationHistory(userId, 1))[0];
    const inventory = await game.listInventory(userId, now);
    return c.json({
      serverTime: new Date(now).toISOString(),
      cycle: cycleJson(info, now),
      club: club ? clubJson(club, { role: membership?.role }) : null,
      myRole: membership?.role ?? null,
      competition,
      clubCompetition,
      competitionEntry,
      lastResult: last ? await competitionView(game, last.competition, userId) : null,
      challenges: membership ? await challengesJson(game, userId, info) : [],
      inventory: {
        available: inventory.filter((i) => i.status === 'available').length,
        active: inventory.filter((i) => i.status === 'active').length,
        cap: INVENTORY_CAP,
      },
    });
  }));

  app.get('/api/season/history', requireAuth, handler(async (c) => {
    const { game } = stores(c);
    const userId = c.get('authUserId');
    const history = await game.getParticipationHistory(userId, 20);
    const items = [];
    for (const h of history) items.push(await competitionView(game, h.competition, userId));
    return c.json({ history: items });
  }));

  /** Competition map: territories of my running competition + chests I can see. */
  app.get('/api/season/map', requireAuth, handler(async (c) => {
    const { storage, game } = stores(c);
    const userId = c.get('authUserId');
    const now = Date.now();
    const info = cycleAt(now);
    const participation = await game.getActiveParticipation(userId);
    let territories: any[] = [];
    let fortifications: any[] = [];
    let flags: any[] = [];
    let competitionId: string | null = null;
    let mode: string | null = null;
    // The map of my competition while it is not scored (its 10 days and the close on Monday 06:00);
    // a member who doesn't take part follows their club's
    let shown: CompetitionRow | null = participation && participation.competition.cycleNumber === info.number ? participation.competition : null;
    if (!shown && info.phase === 'competition') {
      const membership = await game.getMembership(userId);
      if (membership) {
        const running = await game.getClubCompetition(membership.clubId, info.number);
        if (running && running.status === 'active') shown = running;
      }
    }
    if (shown && (info.phase === 'competition' || isClosing(info, now))) {
      competitionId = shown.id;
      mode = shown.mode;
      const participants = await game.getParticipants(competitionId);
      const teamOf = new Map(participants.map((p) => [p.userId, p.team]));
      let ids = participants.filter((p) => p.eliminatedCut === null).map((p) => p.userId);
      // Derbi: one map for both clubs; the rival club's zones are marked
      const rivalIds = new Set<string>();
      if (shown.mode === 'derby' && shown.opponentClubId) {
        const rival = await game.getClubCompetition(shown.opponentClubId, shown.cycleNumber);
        if (rival) for (const p of await game.getParticipants(rival.id)) rivalIds.add(p.userId);
        ids = [...ids, ...rivalIds];
      }
      const invisible = new Set((await game.activeEffects(ids, now)).filter((e) => e.itemId === 'invisibility' && e.userId !== userId).map((e) => e.userId));
      territories = MAPLESS_MODES.includes(shown.mode as CompetitionMode) ? [] : (await storage.getTerritoriesForUsers(ids))
        .filter((t: any) => !invisible.has(t.userId))
        .map((t: any) => ({
          id: t.id, userId: t.userId, user: t.user, area: t.area, team: teamOf.get(t.userId) ?? null,
          rival: rivalIds.has(t.userId),
          geometry: typeof t.geometry === 'string' ? JSON.parse(t.geometry) : t.geometry,
        }));
      if (shown.mode === 'flags') {
        const list = await game.getFlags(shown.id);
        const holders = flagHolders(list.map((f) => f.id), await game.getFlagCaptures(shown.id), Math.min(now, cycleBounds(shown.cycleNumber).competitionEnd));
        const holderUsers = await game.getUserLite([...holders.values()].map((h) => h.userId));
        flags = list.map((f) => {
          const holder = holders.get(f.id) ?? null;
          return { id: f.id, name: f.name, lat: f.lat, lng: f.lng, holderId: holder?.userId ?? null, holder: holder ? holderUsers.get(holder.userId) ?? null : null, since: holder?.since ?? null };
        });
      }
      try {
        const own = participation ? await storage.getFortificationsByUserId(userId) : [];
        fortifications = own.map((f) => ({ id: f.id, geometry: JSON.parse(f.geometry), area: f.area }));
      } catch (_) { /* no fortifications table yet */ }
    }
    let chests: any[] = [];
    if (await game.getMembership(userId)) {
      const canSeeHidden = (await game.activeEffects([userId], now)).some((e) => e.itemId === 'reveal');
      // Only the chests of my city (or near my home): others are noise, and a small city's chests
      // would hint where its few runners live
      const me = await game.getUserGameRow(userId);
      const homeLat = Number(me?.home_lat);
      const homeLng = Number(me?.home_lng);
      const hasHome = me?.home_lat !== null && me?.home_lat !== undefined && Number.isFinite(homeLat) && Number.isFinite(homeLng);
      const myCity = hasHome ? cityKeyOf(me?.country_code, me?.city, homeLat, homeLng) : null;
      const near = (t: any) => hasHome && haversineMeters([homeLat, homeLng], [Number(t.lat), Number(t.lng)]) <= 30_000;
      chests = (await game.activeChests(now))
        .filter((t) => t.city_key === myCity || near(t))
        .filter((t) => Number(t.hidden) !== 1 || canSeeHidden)
        .map((t) => ({
          id: t.id, name: t.name, itemId: t.power_type, item: ITEMS[t.power_type] ?? null, rarity: rarityJson(t.rarity),
          lat: Number(t.lat), lng: Number(t.lng), zone: t.zone ?? null, hidden: Number(t.hidden) === 1, expiresAt: t.expires_at,
        }));
    }
    return c.json({ cycle: cycleJson(info, now), competitionId, mode, territories, fortifications, flags, chests, participating: !!participation });
  }));

  // ── Inventory ──

  app.get('/api/inventory', requireAuth, handler(async (c) => {
    const { game } = stores(c);
    const userId = c.get('authUserId');
    const items = await game.listInventory(userId);
    const user = await game.getUserGameRow(userId);
    return c.json({ items: items.map(itemJson), cap: INVENTORY_CAP, equippedTitle: user?.title ?? null, catalog: ITEMS });
  }));

  app.post('/api/inventory/:id/activate', requireAuth, handler(async (c) => {
    const { storage, game } = stores(c);
    const userId = c.get('authUserId');
    const now = Date.now();
    const item = await game.getInventoryItem(c.req.param('id'));
    if (!item || item.userId !== userId) return fail(c, 404, 'No tienes ese objeto.');
    await game.expireItems(userId, now);
    const fresh = await game.getInventoryItem(item.id);
    if (!fresh || fresh.status !== 'available') return fail(c, 409, 'Ese objeto ya se ha usado o ha caducado.');
    const def = ITEMS[fresh.itemId];
    if (!def) return fail(c, 400, 'Objeto desconocido.');
    if (def.activation === 'owned') return fail(c, 400, 'Los cosméticos no se activan: equípalos desde tu perfil.');
    if (def.activation === 'passive') return fail(c, 400, `${def.name} se usa solo cuando hace falta.`);

    const info = cycleAt(now);
    const input = await body(c);
    const context = def.usablePhase === 'competition'
      ? await competitionContextFor(game, userId, new Date(now).toISOString(), info, now)
      : null;
    if (def.usablePhase === 'competition' && !context) {
      return fail(c, 409, 'Este poder solo se puede usar mientras participas en una competición de tu club.');
    }
    // Some powers make no sense in some modes (no map in Banderas / Exploradores...)
    if (context && def.scope === 'competition' && !itemUsableInMode(def, context.competition.mode as CompetitionMode)) {
      return fail(c, 409, `${def.name} no sirve en el modo ${MODE_INFO[context.competition.mode as CompetitionMode]?.name ?? context.competition.mode}.`);
    }

    // One active effect of each type at a time
    const effects = await game.activeEffects([userId], now);
    if (def.activation !== 'target' && def.activation !== 'instant' && effects.some((e) => e.itemId === def.id)) {
      return fail(c, 409, `Ya tienes ${def.name} activo.`);
    }

    if (def.activation === 'next_run') {
      if (!(await game.activateItem(fresh.id, null, null, now))) return fail(c, 409, 'No se pudo activar.');
      return c.json({ success: true, message: `${def.name}: se aplicará en tu siguiente carrera.`, item: itemJson((await game.getInventoryItem(fresh.id))!) });
    }
    if (def.activation === 'timed') {
      const until = new Date(now + (def.activeHours ?? 24) * 3600 * 1000).toISOString();
      if (!(await game.activateItem(fresh.id, until, null, now))) return fail(c, 409, 'No se pudo activar.');
      if (def.id === 'rally' && context) {
        const mates = context.participants.map((p) => p.userId).filter((id) => id !== userId && !context.enemyIds.includes(id));
        const me = (await game.getUserLite([userId])).get(userId);
        await notifyUsers(storage, c.env, mates, {
          title: '📣 ¡Llamada al club!',
          body: `${me?.name ?? 'Un compañero'} ha activado la Llamada al Club: durante 2 h conquistáis un 50% más. ¡A correr!`,
          tag: `rally-${fresh.id}`,
          data: { type: 'rally' },
        });
      }
      return c.json({ success: true, message: `${def.name} activo hasta ${until}.`, activeUntil: until, item: itemJson((await game.getInventoryItem(fresh.id))!) });
    }
    if (def.activation === 'instant') {
      if (def.id === 'head_start' && context) {
        await game.updateParticipant(context.competition.id, userId, { addBonus: HEAD_START_BONUS_M2 });
      }
      await game.consumeItems([fresh.id], now);
      return c.json({ success: true, message: `${def.name} aplicado.` });
    }

    // Target items: a rival of my competition
    const targetUserId = typeof input.targetUserId === 'string' ? input.targetUserId : '';
    if (!context) return fail(c, 409, 'Necesitas estar en una competición.');
    let rivals = new Set(context.enemyIds);
    if ((context.competition.mode === 'duel' || context.competition.mode === 'derby') && context.competition.opponentClubId) {
      const opponent = await game.getClubCompetition(context.competition.opponentClubId, context.competition.cycleNumber);
      if (opponent) rivals = new Set((await game.getParticipants(opponent.id)).map((p) => p.userId));
    }
    if (rivals.size === 0) return fail(c, 409, 'En este modo no tienes rivales a los que apuntar.');
    if (!targetUserId || !rivals.has(targetUserId)) return fail(c, 400, 'Elige a un rival de tu competición.', { rivals: [...rivals] });

    if (def.id === 'spy') {
      const bounds = cycleBounds(info.number);
      const runs = await game.getCountedRunsChronological(targetUserId, new Date(bounds.competitionStart).toISOString(), new Date(bounds.competitionEnd).toISOString());
      const last = runs[runs.length - 1];
      await game.consumeItems([fresh.id], now);
      return c.json({
        success: true,
        message: last ? 'Esta es su última carrera de la competición.' : 'Todavía no ha corrido en esta competición.',
        route: last ? { id: last.id, name: last.name, distance: last.distance, duration: last.duration, startedAt: last.started_at, coordinates: JSON.parse(last.coordinates) } : null,
      });
    }
    if (def.id === 'nickname') {
      const nickname = typeof input.nickname === 'string' ? input.nickname.trim() : '';
      if (!nickname || [...nickname].length > 20) return fail(c, 400, 'Escribe un apodo de 1 a 20 caracteres.');
      const expiresAt = new Date(now + (def.activeHours ?? 48) * 3600 * 1000).toISOString();
      await storage.createNickname({ targetUserId, setByUserId: userId, nickname, expiresAt });
      await game.consumeItems([fresh.id], now);
      const names = await game.getUserLite([userId, targetUserId]);
      try {
        await storage.createFeedEvent({
          userId, eventType: 'nickname_changed', victimId: targetUserId,
          metadata: JSON.stringify({ nickname, targetName: names.get(targetUserId)?.name, attackerName: names.get(userId)?.name, expiresAt }),
        });
      } catch (_) {}
      await notifyUsers(storage, c.env, [targetUserId], {
        title: '✏️ Tienes un apodo nuevo',
        body: `${names.get(userId)?.name ?? 'Un rival'} te ha puesto el apodo «${nickname}» durante 48 h.`,
        tag: `nickname-${targetUserId}`,
        data: { type: 'nickname_changed' },
      });
      return c.json({ success: true, message: `Apodo «${nickname}» puesto durante 48 h.` });
    }
    if (def.id === 'sabotage') {
      const until = new Date(now + (def.activeHours ?? 24) * 3600 * 1000).toISOString();
      if (!(await game.activateItem(fresh.id, until, { targetUserId }, now))) return fail(c, 409, 'No se pudo activar.');
      return c.json({ success: true, message: 'Sabotaje preparado: su siguiente carrera en 24 h conquistará un 20% menos.', activeUntil: until });
    }
    return fail(c, 400, 'Este objeto no se puede activar.');
  }));

  app.post('/api/cosmetics/title', requireAuth, handler(async (c) => {
    const { game } = stores(c);
    const userId = c.get('authUserId');
    const input = await body(c);
    const itemId = input.itemId === null ? null : String(input.itemId ?? '');
    if (itemId === null || itemId === '') {
      await game.setUserTitle(userId, null);
      return c.json({ success: true, title: null });
    }
    if (!itemId.startsWith('title_') || !ITEMS[itemId]) return fail(c, 400, 'Título no válido.');
    if (!(await game.ownedCosmetics(userId)).has(itemId)) return fail(c, 403, 'Todavía no tienes ese título.');
    await game.setUserTitle(userId, itemId);
    return c.json({ success: true, title: itemId });
  }));

  app.get('/api/challenges', requireAuth, handler(async (c) => {
    const { game } = stores(c);
    const userId = c.get('authUserId');
    const info = cycleAt(Date.now());
    if (!(await game.getMembership(userId))) return c.json({ challenges: [], reason: 'no_club' });
    return c.json({ challenges: await challengesJson(game, userId, info), phase: info.phase });
  }));

  // ── Global mode ──

  app.get('/api/global/me', requireAuth, handler(async (c) => {
    const { game } = stores(c);
    const userId = c.get('authUserId');
    const user = await game.getUserGameRow(userId);
    if (!user) return fail(c, 404, 'Usuario no encontrado.');
    const month = monthPeriod(Date.now());
    const [world, monthRank] = await Promise.all([
      game.globalRankOf(userId, { period: 'all', month }),
      game.globalRankOf(userId, { period: 'month', month }),
    ]);
    const country = user.country_code ? await game.globalRankOf(userId, { period: 'all', month, countryCode: user.country_code }) : null;
    const city = user.city ? await game.globalRankOf(userId, { period: 'all', month, countryCode: user.country_code, city: user.city }) : null;
    const nextChange = user.location_updated_at ? Date.parse(user.location_updated_at) + 30 * 24 * 3600 * 1000 : null;
    return c.json({
      area: Number(user.global_area ?? 0),
      bonusArea: Number(user.global_bonus_area ?? 0),
      monthArea: monthRank.score,
      ranks: { world: world.rank, country: country?.rank ?? null, city: city?.rank ?? null, month: monthRank.rank },
      location: { city: user.city ?? null, countryCode: user.country_code ?? null, countryName: user.country_name ?? null, canChangeAt: nextChange && nextChange > Date.now() ? new Date(nextChange).toISOString() : null },
      streak: { days: Number(user.streak_days ?? 0), lastDate: user.streak_last_date ?? null },
      title: user.title ?? null,
    });
  }));

  /** My global map plus informative overlays of friends and club mates (nobody else). */
  app.get('/api/global/territories', requireAuth, handler(async (c) => {
    const { storage, game } = stores(c);
    const userId = c.get('authUserId');
    const include = new Set((c.req.query('include') ?? 'friends,club').split(','));
    const friendIds = include.has('friends') ? await storage.getFriendIds(userId) : [];
    const membership = await game.getMembership(userId);
    const clubIds = include.has('club') && membership ? (await game.getClubMemberIds(membership.clubId)).filter((id) => id !== userId) : [];
    let allowed = [...new Set([...friendIds, ...clubIds])];
    const only = c.req.query('userIds');
    if (only) {
      const wanted = new Set(only.split(','));
      allowed = allowed.filter((id) => wanted.has(id));
    }
    const rows = await game.getGlobalTerritories([userId, ...allowed]);
    const users = await game.getUserLite([userId, ...allowed]);
    const friendSet = new Set(friendIds);
    const mine = rows.find((r) => r.userId === userId);
    return c.json({
      me: mine ? { user: users.get(userId) ?? null, geometry: parseGeometry(mine.geometry), area: mine.area } : null,
      overlays: rows.filter((r) => r.userId !== userId).map((r) => ({
        user: users.get(r.userId) ?? null,
        relation: friendSet.has(r.userId) ? 'friend' : 'club',
        geometry: parseGeometry(r.geometry),
        area: r.area,
      })),
      available: allowed.map((id) => ({ user: users.get(id) ?? null, relation: friendSet.has(id) ? 'friend' : 'club' })),
    });
  }));

  app.patch('/api/users/me/location', requireAuth, handler(async (c) => {
    const { game } = stores(c);
    const userId = c.get('authUserId');
    const input = await body(c);
    const city = cleanName(input.city);
    const countryCode = cleanName(input.countryCode).toUpperCase();
    const countryName = cleanName(input.countryName);
    if (!city || [...city].length > 60) return fail(c, 400, 'Ciudad no válida.');
    if (!/^[A-Z]{2}$/.test(countryCode)) return fail(c, 400, 'País no válido.');
    if (!countryName || [...countryName].length > 60) return fail(c, 400, 'País no válido.');
    const lat = Number(input.lat);
    const lng = Number(input.lng);
    const hasPoint = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    const user = await game.getUserGameRow(userId);
    if (!user) return fail(c, 404, 'Usuario no encontrado.');
    const same = (user.city ?? '').toLowerCase() === city.toLowerCase() && user.country_code === countryCode;
    if (user.city && user.location_updated_at && !same) {
      const next = Date.parse(user.location_updated_at) + 30 * 24 * 3600 * 1000;
      if (next > Date.now()) {
        return fail(c, 409, 'Solo puedes cambiar tu ciudad una vez cada 30 días.', { canChangeAt: new Date(next).toISOString() });
      }
    }
    // Coordinates are rounded to ~1 km: they only place the city (chests), never the exact home
    const round = (v: number) => Math.round(v * 100) / 100;
    await game.setUserLocation(userId, {
      city, countryCode, countryName,
      lat: hasPoint ? round(lat) : (user.home_lat ?? null),
      lng: hasPoint ? round(lng) : (user.home_lng ?? null),
    });
    return c.json({ success: true, city, countryCode, countryName });
  }));

  // ── Rankings ──

  app.get('/api/rankings/global', requireAuth, handler(async (c) => {
    const { storage, game } = stores(c);
    const userId = c.get('authUserId');
    const scope = (c.req.query('scope') ?? 'world') as 'world' | 'country' | 'city' | 'friends' | 'club';
    const period = c.req.query('period') === 'month' ? 'month' : 'all';
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit')) || 100));
    const month = monthPeriod(Date.now());
    const me = await game.getUserGameRow(userId);
    const options: { period: 'all' | 'month'; month: string; countryCode?: string | null; city?: string | null; userIds?: string[] | null } = { period, month };
    let label = 'Mundo';
    if (scope === 'country' || scope === 'city') {
      if (!me?.country_code || (scope === 'city' && !me?.city)) {
        return fail(c, 409, 'Elige tu ciudad en el perfil para ver este ranking.', { needsLocation: true });
      }
      options.countryCode = me.country_code;
      label = me.country_name ?? me.country_code;
      if (scope === 'city') {
        options.city = me.city;
        label = me.city;
      }
    } else if (scope === 'friends') {
      options.userIds = [userId, ...(await storage.getFriendIds(userId))];
      label = 'Amigos';
    } else if (scope === 'club') {
      const membership = await game.getMembership(userId);
      if (!membership) return fail(c, 409, 'Únete a un club para ver este ranking.', { needsClub: true });
      options.userIds = await game.getClubMemberIds(membership.clubId);
      label = (await game.getClub(membership.clubId))?.name ?? 'Club';
    }
    const rows = await game.globalRanking({ ...options, limit });
    const memberships = await game.getMemberships(rows.map((r) => r.id));
    const clubs = await game.getClubsByIds([...memberships.values()].map((m) => m.clubId));
    const entries = rows.map((r, i) => {
      const club = clubs.get(memberships.get(r.id)?.clubId ?? '');
      return {
        rank: i + 1,
        user: { id: r.id, username: r.username, name: r.name, avatar: r.avatar ?? null, color: r.color, title: r.title ?? null } as PublicUserLite,
        area: r.score,
        club: club ? { id: club.id, name: club.name, crest: { ...DEFAULT_CREST, ...club.crest }, color: club.color } : null,
      };
    });
    // Ties share the rank
    for (let i = 1; i < entries.length; i++) if (entries[i].area === entries[i - 1].area) entries[i].rank = entries[i - 1].rank;
    const mine = await game.globalRankOf(userId, options);
    return c.json({ scope, period, label, month, entries, me: { rank: mine.rank, area: mine.score } });
  }));

  app.get('/api/rankings/clubs', requireAuth, handler(async (c) => {
    const { game } = stores(c);
    const userId = c.get('authUserId');
    const scope = c.req.query('scope') ?? 'world';
    const sort = c.req.query('sort') === 'area' ? 'area' : 'league';
    const me = await game.getUserGameRow(userId);
    let countryCode: string | null = null;
    let city: string | null = null;
    if (scope === 'country' || scope === 'city') {
      if (!me?.country_code) return fail(c, 409, 'Elige tu ciudad en el perfil para ver este ranking.', { needsLocation: true });
      countryCode = me.country_code;
      if (scope === 'city') city = me.city ?? null;
    }
    const rows = await game.clubRanking({ sort, countryCode, city, limit: 100 });
    const membership = await game.getMembership(userId);
    return c.json({
      scope, sort,
      entries: rows.map((r, i) => ({ rank: i + 1, club: clubJson(r), score: r.score })),
      myClubId: membership?.clubId ?? null,
      myClubRank: membership ? (rows.findIndex((r) => r.id === membership.clubId) + 1 || null) : null,
    });
  }));

  // ── Clubs ──

  app.get('/api/clubs/search', requireAuth, handler(async (c) => {
    const { game } = stores(c);
    const userId = c.get('authUserId');
    const q = (c.req.query('q') ?? '').trim().slice(0, 40);
    const me = await game.getUserGameRow(userId);
    let clubs = await game.searchClubs({ query: q, limit: 200 });
    const homeLat = Number(me?.home_lat);
    const homeLng = Number(me?.home_lng);
    const distance = (club: ClubRow) => {
      if (!Number.isFinite(homeLat) || club.centerLat === null || club.centerLng === null) return null;
      const dLat = ((club.centerLat - homeLat) * Math.PI) / 180;
      const dLng = ((club.centerLng - homeLng) * Math.PI) / 180;
      const a = Math.sin(dLat / 2) ** 2 + Math.cos((homeLat * Math.PI) / 180) * Math.cos((club.centerLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
      return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
    };
    const sameCity = (club: ClubRow) => !!me?.city && (club.city ?? '').toLowerCase() === String(me.city).toLowerCase();
    clubs = clubs
      .map((club) => ({ club, km: distance(club) }))
      .sort((a, b) => Number(sameCity(b.club)) - Number(sameCity(a.club))
        || (a.km ?? 1e9) - (b.km ?? 1e9)
        || b.club.memberCount - a.club.memberCount)
      .map((x) => x.club);
    const pending = new Set((await game.getPendingRequestOfUser(userId)).map((r) => r.clubId));
    return c.json({
      clubs: clubs.slice(0, 50).map((club) => ({ ...clubJson(club), distanceKm: distance(club), requestPending: pending.has(club.id), full: club.memberCount >= CLUB_MAX_MEMBERS })),
    });
  }));

  app.post('/api/clubs', requireAuth, handler(async (c) => {
    const { game } = stores(c);
    const userId = c.get('authUserId');
    if (await game.getMembership(userId)) return fail(c, 409, 'Ya estás en un club. Sal de él para crear otro.');
    const input = await body(c);
    const name = cleanName(input.name);
    const nameError = validateClubName(name);
    if (nameError) return fail(c, 400, nameError);
    if (await game.isClubNameTaken(name)) return fail(c, 409, 'Ya hay un club con ese nombre.');
    const slogan = cleanName(input.slogan) || null;
    if (slogan && [...slogan].length > CLUB_SLOGAN_MAX) return fail(c, 400, `El eslogan no puede tener más de ${CLUB_SLOGAN_MAX} caracteres.`);
    const crestResult = validateCrest(input.crest, await game.ownedCosmetics(userId));
    if ('error' in crestResult) return fail(c, 400, crestResult.error);
    const color = HEX.test(String(input.color ?? '')) ? String(input.color).toUpperCase() : crestResult.crest.primary;
    const entryMode = parseEntryMode(input.entryMode) ?? entryModeFromVisibility(input.visibility);
    const invitePermission = input.invitePermission === 'officers' ? 'officers' : 'all';
    const description = cleanDescription(input.description);
    if (description && [...description].length > CLUB_DESCRIPTION_MAX) return fail(c, 400, `La descripción no puede tener más de ${CLUB_DESCRIPTION_MAX} caracteres.`);
    const me = await game.getUserGameRow(userId);
    const round = (v: unknown) => (Number.isFinite(Number(v)) && v !== null ? Math.round(Number(v) * 100) / 100 : null);
    let joinCode = randomCode();
    for (let i = 0; i < 5 && await game.getClubByCode(joinCode); i++) joinCode = randomCode();
    const club = await game.createClub({
      name, slogan, description, crest: crestResult.crest, color, entryMode, invitePermission, joinCode,
      city: me?.city ?? null, countryCode: me?.country_code ?? null, countryName: me?.country_name ?? null,
      centerLat: round(me?.home_lat), centerLng: round(me?.home_lng), ownerId: userId,
    });
    const competitionEntry = await joinRunningCompetition(game, club.id, userId);
    const joinedCompetition = competitionEntry === 'joined' || competitionEntry === 'participant';
    return c.json({ club: clubJson(club, { role: 'owner' }), role: 'owner', joinedCompetition, competitionEntry }, 201);
  }));

  app.get('/api/clubs/mine', requireAuth, handler(async (c) => {
    const { game } = stores(c);
    const userId = c.get('authUserId');
    const membership = await game.getMembership(userId);
    const invites = await game.getPendingInvitesForUser(userId);
    const inviteClubs = await game.getClubsByIds(invites.map((i) => i.clubId));
    const inviters = await game.getUserLite(invites.flatMap((i) => (i.invitedBy ? [i.invitedBy] : [])));
    const pendingRequests = await game.getPendingRequestOfUser(userId);
    const requestClubs = await game.getClubsByIds(pendingRequests.map((r) => r.clubId));
    const base = {
      invites: invites.flatMap((i) => {
        const club = inviteClubs.get(i.clubId);
        return club ? [{ id: i.id, club: clubJson(club), invitedBy: i.invitedBy ? inviters.get(i.invitedBy) ?? null : null, createdAt: i.createdAt }] : [];
      }),
      myRequests: pendingRequests.flatMap((r) => {
        const club = requestClubs.get(r.clubId);
        return club ? [{ id: r.id, club: clubJson(club) }] : [];
      }),
    };
    if (!membership) return c.json({ club: null, role: null, ...base });
    return c.json({ ...(await clubDetail(game, membership.clubId, userId)), ...base });
  }));

  async function clubDetail(game: GameStorage, clubId: string, userId: string) {
    const club = await game.getClub(clubId);
    if (!club) return null;
    const membership = await game.getMembership(userId);
    const isMember = membership?.clubId === clubId;
    const role = isMember ? membership!.role : null;
    const history = await clubHistory(game, clubId, 20);
    const info = cycleAt(Date.now());
    const competition = isMember ? await game.getClubCompetition(clubId, info.number) : null;
    const pendingRequests = isOfficer(role) ? await game.getPendingRequestsForClub(clubId) : [];
    const unlocked = isMember ? [...await game.clubUnlockedCosmetics(clubId)] : [];
    return {
      club: clubJson(club, { role }),
      role,
      isMember,
      // Whether I can invite (personal invites, links, code) and approve requests
      canInvite: canInvite(role, club.invitePermission),
      members: isMember || club.entryMode !== 'invite_only'
        ? (await game.getClubMembers(clubId)).map((m) => ({ user: m.user, role: m.role, joinedAt: m.joinedAt, globalArea: m.globalArea }))
        : [],
      competition: competition && competition.status === 'active' ? { id: competition.id, mode: competition.mode, modeInfo: MODE_INFO[competition.mode as CompetitionMode] ?? null } : null,
      pendingRequests: pendingRequests.map((r) => ({ id: r.id, user: r.user, globalArea: r.globalArea, createdAt: r.createdAt })),
      history: history.slice(0, 10),
      trophies: trophiesOf(history),
      unlockedCrestPieces: unlocked.filter((id) => id.startsWith('crest_')),
      requestPending: !isMember && (await game.getPendingRequestOfUser(userId)).some((r) => r.clubId === clubId),
    };
  }

  app.get('/api/clubs/:id', requireAuth, handler(async (c) => {
    const { game } = stores(c);
    const detail = await clubDetail(game, c.req.param('id'), c.get('authUserId'));
    if (!detail) return fail(c, 404, 'Club no encontrado.');
    return c.json(detail);
  }));

  app.get('/api/clubs/:id/history', requireAuth, handler(async (c) => {
    const { game } = stores(c);
    const club = await game.getClub(c.req.param('id'));
    if (!club) return fail(c, 404, 'Club no encontrado.');
    const history = await clubHistory(game, club.id, 50);
    return c.json({ history, trophies: trophiesOf(history) });
  }));

  async function requireClubRole(game: GameStorage, clubId: string, userId: string, roles: ClubRole[]): Promise<ClubRole | null> {
    const membership = await game.getMembership(userId);
    if (!membership || membership.clubId !== clubId || !roles.includes(membership.role)) return null;
    return membership.role;
  }

  app.patch('/api/clubs/:id', requireAuth, handler(async (c) => {
    const { game } = stores(c);
    const userId = c.get('authUserId');
    const clubId = c.req.param('id');
    const role = await requireClubRole(game, clubId, userId, ['owner', 'admin']);
    if (!role) return fail(c, 403, 'Solo el líder y los oficiales pueden editar el club.');
    const input = await body(c);
    const update: Record<string, any> = {};
    if (input.name !== undefined) {
      const name = cleanName(input.name);
      const nameError = validateClubName(name);
      if (nameError) return fail(c, 400, nameError);
      if (await game.isClubNameTaken(name, clubId)) return fail(c, 409, 'Ya hay un club con ese nombre.');
      update.name = name;
    }
    if (input.slogan !== undefined) {
      const slogan = cleanName(input.slogan) || null;
      if (slogan && [...slogan].length > CLUB_SLOGAN_MAX) return fail(c, 400, `El eslogan no puede tener más de ${CLUB_SLOGAN_MAX} caracteres.`);
      update.slogan = slogan;
    }
    if (input.crest !== undefined) {
      const crestResult = validateCrest(input.crest, await game.clubUnlockedCosmetics(clubId));
      if ('error' in crestResult) return fail(c, 400, crestResult.error);
      update.crest = crestResult.crest;
    }
    if (input.color !== undefined) {
      if (!HEX.test(String(input.color))) return fail(c, 400, 'Color no válido.');
      update.color = String(input.color).toUpperCase();
    }
    if (input.description !== undefined) {
      const description = cleanDescription(input.description);
      if (description && [...description].length > CLUB_DESCRIPTION_MAX) return fail(c, 400, `La descripción no puede tener más de ${CLUB_DESCRIPTION_MAX} caracteres.`);
      update.description = description;
    }
    if (input.entryMode !== undefined) {
      const entryMode = parseEntryMode(input.entryMode);
      if (!entryMode) return fail(c, 400, 'Tipo de entrada no válido.');
      update.entryMode = entryMode;
    } else if (input.visibility !== undefined) {
      update.entryMode = entryModeFromVisibility(input.visibility); // older app versions
    }
    if (input.invitePermission !== undefined) {
      // Only the leader decides who can invite
      if (role !== 'owner') return fail(c, 403, 'Solo el líder puede decidir quién invita.');
      update.invitePermission = input.invitePermission === 'officers' ? 'officers' : 'all';
    }
    await game.updateClub(clubId, update);
    return c.json({ club: clubJson((await game.getClub(clubId))!, { role }) });
  }));

  app.post('/api/clubs/:id/code', requireAuth, handler(async (c) => {
    const { game } = stores(c);
    const clubId = c.req.param('id');
    if (!(await requireClubRole(game, clubId, c.get('authUserId'), ['owner', 'admin']))) return fail(c, 403, 'Solo el líder y los oficiales pueden cambiar el código.');
    let joinCode = randomCode();
    for (let i = 0; i < 5 && await game.getClubByCode(joinCode); i++) joinCode = randomCode();
    await game.updateClub(clubId, { joinCode });
    return c.json({ joinCode });
  }));

  /** Join from the club's card (search, detail): open clubs at once, "approval" clubs by request. */
  app.post('/api/clubs/:id/join', requireAuth, handler(async (c) => {
    const { storage, game } = stores(c);
    const club = await game.getClub(c.req.param('id'));
    if (!club) return fail(c, 404, 'Club no encontrado.');
    return enterClub(c, storage, game, club, c.get('authUserId'), 'search');
  }));

  app.post('/api/clubs/join-code', requireAuth, handler(async (c) => {
    const { storage, game } = stores(c);
    const input = await body(c);
    const code = String(input.code ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4,10}$/.test(code)) return fail(c, 400, 'Código no válido.');
    const club = await game.getClubByCode(code);
    if (!club) return fail(c, 404, 'No hay ningún club con ese código.');
    return enterClub(c, storage, game, club, c.get('authUserId'), 'code');
  }));

  app.post('/api/clubs/:id/requests/:requestId/:action', requireAuth, handler(async (c) => {
    const { storage, game } = stores(c);
    const clubId = c.req.param('id');
    const action = c.req.param('action');
    if (action !== 'accept' && action !== 'reject') return fail(c, 404, 'Acción no válida.');
    if (!(await requireClubRole(game, clubId, c.get('authUserId'), ['owner', 'admin']))) return fail(c, 403, 'Solo el líder y los oficiales pueden gestionar solicitudes.');
    const request = await game.getClubRequest(c.req.param('requestId'));
    if (!request || request.club_id !== clubId || request.kind !== 'request' || request.status !== 'pending') return fail(c, 404, 'Solicitud no encontrada.');
    if (action === 'reject') {
      await game.setClubRequestStatus(request.id, 'rejected');
      return c.json({ success: true });
    }
    const club = (await game.getClub(clubId))!;
    const joined = await joinClub(storage, game, c.env, club, request.user_id);
    if (!joined.ok) {
      await game.setClubRequestStatus(request.id, 'cancelled');
      return fail(c, joined.status, joined.error);
    }
    await game.setClubRequestStatus(request.id, 'accepted');
    await notifyUsers(storage, c.env, [request.user_id], {
      title: `🛡️ ¡Bienvenido a ${club.name}!`,
      body: 'Han aceptado tu solicitud. Ya compites con tu club.',
      tag: `club-accepted-${club.id}`,
      data: { type: 'club_request_accepted', clubId: club.id },
    });
    return c.json({ success: true, joinedCompetition: joined.joinedCompetition, competitionEntry: joined.competitionEntry });
  }));

  /** Invite a user (body.userId) or create an invite link (no userId). Any member can invite. */
  app.post('/api/clubs/:id/invites', requireAuth, handler(async (c) => {
    const { storage, game } = stores(c);
    const userId = c.get('authUserId');
    const clubId = c.req.param('id');
    const role = await requireClubRole(game, clubId, userId, ['owner', 'admin', 'member']);
    if (!role) return fail(c, 403, 'Solo los miembros pueden invitar.');
    const club = (await game.getClub(clubId))!;
    if (!canInvite(role, club.invitePermission)) return fail(c, 403, 'En este club solo el líder y los oficiales pueden invitar.');
    const input = await body(c);
    if (typeof input.userId === 'string' && input.userId) {
      const target = (await game.getUserLite([input.userId])).get(input.userId);
      if (!target) return fail(c, 404, 'Usuario no encontrado.');
      if (await storage.isBlockedEitherWay(userId, input.userId)) return fail(c, 403, 'No puedes invitar a este usuario.');
      if (await game.getMembership(input.userId)) return fail(c, 409, `${target.name} ya está en un club.`);
      const inviteId = await game.createClubRequest(clubId, input.userId, 'invite', userId);
      const me = (await game.getUserLite([userId])).get(userId);
      await notifyUsers(storage, c.env, [input.userId], {
        title: `🛡️ Invitación a ${club.name}`,
        body: `${me?.name ?? 'Alguien'} te invita a unirte a su club.`,
        tag: `club-invite-${clubId}`,
        data: { type: 'club_invite', clubId },
      });
      return c.json({ invited: true, inviteId });
    }
    const token = randomToken();
    await game.createInviteLink(clubId, userId, token, new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString());
    return c.json({ token, url: `${publicBaseUrl(c)}/club-invite/${token}`, joinCode: club.joinCode });
  }));

  app.post('/api/clubs/invites/:inviteId/:action', requireAuth, handler(async (c) => {
    const { storage, game } = stores(c);
    const userId = c.get('authUserId');
    const action = c.req.param('action');
    if (action !== 'accept' && action !== 'decline') return fail(c, 404, 'Acción no válida.');
    const invite = await game.getClubRequest(c.req.param('inviteId'));
    if (!invite || invite.user_id !== userId || invite.kind !== 'invite' || invite.status !== 'pending') return fail(c, 404, 'Invitación no encontrada.');
    if (action === 'decline') {
      await game.setClubRequestStatus(invite.id, 'rejected');
      return c.json({ success: true });
    }
    const club = await game.getClub(invite.club_id);
    if (!club) return fail(c, 404, 'El club ya no existe.');
    const response = await enterClub(c, storage, game, club, userId, 'invite', invite.invited_by ?? null);
    if (response.status < 300) await game.setClubRequestStatus(invite.id, 'accepted');
    return response;
  }));

  app.get('/api/clubs/invite-links/:token', requireAuth, handler(async (c) => {
    const { game } = stores(c);
    const link = await game.getInviteLink(c.req.param('token'));
    if (!link || Date.parse(link.expiresAt) < Date.now()) return fail(c, 404, 'La invitación ha caducado o no existe.');
    const club = await game.getClub(link.clubId);
    if (!club) return fail(c, 404, 'El club ya no existe.');
    const inviter = await game.getMembership(link.createdBy);
    const decision = joinDecision(club.entryMode, 'invite', club.invitePermission, inviter && inviter.clubId === club.id ? inviter.role : null);
    return c.json({ club: clubJson(club), requiresApproval: decision === 'request', valid: decision !== 'forbidden' });
  }));

  app.post('/api/clubs/invite-links/:token/accept', requireAuth, handler(async (c) => {
    const { storage, game } = stores(c);
    const link = await game.getInviteLink(c.req.param('token'));
    if (!link || Date.parse(link.expiresAt) < Date.now()) return fail(c, 404, 'La invitación ha caducado o no existe.');
    const club = await game.getClub(link.clubId);
    if (!club) return fail(c, 404, 'El club ya no existe.');
    return enterClub(c, storage, game, club, c.get('authUserId'), 'invite', link.createdBy);
  }));

  app.post('/api/clubs/:id/leave', requireAuth, handler(async (c) => {
    const { game } = stores(c);
    const userId = c.get('authUserId');
    const clubId = c.req.param('id');
    const membership = await game.getMembership(userId);
    if (!membership || membership.clubId !== clubId) return fail(c, 404, 'No estás en este club.');
    if (await inRunningCompetition(game, userId)) {
      return fail(c, 409, 'No puedes salir del club mientras compites con él. Podrás salir cuando acabe la competición.');
    }
    const members = await game.getClubMembers(clubId);
    if (membership.role === 'owner') {
      if (members.length > 1) return fail(c, 409, 'Eres el líder: pasa el liderazgo a otro miembro antes de salir, o borra el club.');
      await game.deleteClub(clubId);
      return c.json({ left: true, clubDeleted: true });
    }
    await game.removeMember(clubId, userId);
    return c.json({ left: true });
  }));

  app.delete('/api/clubs/:id/members/:userId', requireAuth, handler(async (c) => {
    const { game } = stores(c);
    const userId = c.get('authUserId');
    const clubId = c.req.param('id');
    const targetId = c.req.param('userId');
    const role = await requireClubRole(game, clubId, userId, ['owner', 'admin']);
    if (!role) return fail(c, 403, 'Solo el líder y los oficiales pueden expulsar.');
    const target = await game.getMembership(targetId);
    if (!target || target.clubId !== clubId) return fail(c, 404, 'Ese usuario no está en el club.');
    if (target.role === 'owner') return fail(c, 403, 'No se puede expulsar al líder del club.');
    if (target.role === 'admin' && role !== 'owner') return fail(c, 403, 'Solo el líder puede expulsar a un oficial.');
    if (await inRunningCompetition(game, targetId)) return fail(c, 409, 'No se puede expulsar a alguien mientras compite. Podrás hacerlo cuando acabe la competición.');
    await game.removeMember(clubId, targetId);
    return c.json({ removed: true });
  }));

  app.post('/api/clubs/:id/members/:userId/role', requireAuth, handler(async (c) => {
    const { game } = stores(c);
    const clubId = c.req.param('id');
    const targetId = c.req.param('userId');
    if (!(await requireClubRole(game, clubId, c.get('authUserId'), ['owner']))) return fail(c, 403, 'Solo el líder puede nombrar oficiales.');
    const input = await body(c);
    const role = input.role === 'admin' ? 'admin' : input.role === 'member' ? 'member' : null;
    if (!role) return fail(c, 400, 'Rol no válido.');
    const target = await game.getMembership(targetId);
    if (!target || target.clubId !== clubId || target.role === 'owner') return fail(c, 404, 'Miembro no encontrado.');
    await game.setMemberRole(clubId, targetId, role);
    return c.json({ success: true, role });
  }));

  app.post('/api/clubs/:id/transfer', requireAuth, handler(async (c) => {
    const { game } = stores(c);
    const userId = c.get('authUserId');
    const clubId = c.req.param('id');
    if (!(await requireClubRole(game, clubId, userId, ['owner']))) return fail(c, 403, 'Solo el líder puede pasar el liderazgo.');
    const input = await body(c);
    const targetId = String(input.userId ?? '');
    const target = await game.getMembership(targetId);
    if (!target || target.clubId !== clubId || targetId === userId) return fail(c, 404, 'Elige a otro miembro del club.');
    await game.setMemberRole(clubId, targetId, 'owner');
    await game.setMemberRole(clubId, userId, 'admin');
    await game.updateClub(clubId, { ownerId: targetId });
    return c.json({ success: true });
  }));

  app.delete('/api/clubs/:id', requireAuth, handler(async (c) => {
    const { game } = stores(c);
    const userId = c.get('authUserId');
    const clubId = c.req.param('id');
    if (!(await requireClubRole(game, clubId, userId, ['owner']))) return fail(c, 403, 'Solo el líder puede borrar el club.');
    const info = cycleAt(Date.now());
    const competition = await game.getClubCompetition(clubId, info.number);
    if (info.phase === 'competition' && competition && competition.status === 'active') {
      return fail(c, 409, 'No se puede borrar el club mientras compite. Podrás hacerlo cuando acabe la competición.');
    }
    await game.deleteClub(clubId);
    return c.json({ deleted: true });
  }));

  // ── Cron and admin ──

  app.post('/api/tasks/season-tick', handler(async (c) => {
    if (!(await isCronRequest(c))) return c.json({ error: 'Unauthorized' }, 401);
    const { storage, game } = stores(c);
    // The in-process cron passes its scheduled time (lets the e2e server simulate any date)
    const at = c.env.INTERNAL_CRON === true ? Number(c.req.query('at')) : NaN;
    return c.json(await seasonTick(storage, game, c.env, Number.isFinite(at) ? at : Date.now()));
  }));

  /** Runs the season tick at a given time (testing). */
  app.post('/api/admin/season/tick', requireAdmin, handler(async (c) => {
    const { storage, game } = stores(c);
    const input = await body(c);
    const time = input.time ? Date.parse(String(input.time)) : Date.now();
    if (!Number.isFinite(time)) return fail(c, 400, 'time no válido');
    return c.json(await seasonTick(storage, game, c.env, time));
  }));

  /** Forces the "start from zero" reset again (needs {"confirm":"RESET"}). */
  app.post('/api/admin/season/reset', requireAdmin, handler(async (c) => {
    const { game } = stores(c);
    const input = await body(c);
    if (input.confirm !== 'RESET') return fail(c, 400, 'Envía {"confirm":"RESET"} para borrar todas las carreras.');
    await game.deleteSetting(SEASON_RESET_KEY);
    await game.deleteSetting(`${SEASON_RESET_KEY}_lock`);
    const { ensureSeasonReset } = await import('./season');
    return c.json({ reset: await ensureSeasonReset(game, Date.now()) });
  }));

  /** Moves the season cutoff: runs that started before `at` never count (and aren't imported). */
  app.post('/api/admin/season/runs-from', requireAdmin, handler(async (c) => {
    const { game } = stores(c);
    const input = await body(c);
    const at = Date.parse(String(input.at ?? ''));
    if (!Number.isFinite(at)) return fail(c, 400, 'at no válido (fecha ISO).');
    const iso = new Date(at).toISOString();
    await game.setSetting('season_reset_at', iso);
    setRunsCountFrom(at);
    return c.json({ runsCountFrom: iso });
  }));

  app.get('/api/admin/runs/flagged', requireAdmin, handler(async (c) => {
    const { game } = stores(c);
    const rows = await game.getFlaggedRuns(200);
    return c.json({ runs: rows.map((r) => ({ ...r, validation_reasons: JSON.parse(r.validation_reasons || '[]') })) });
  }));

  /** Review of a flagged run: approve (keeps counting) or revert (stops counting, territory rebuilt). */
  app.post('/api/admin/runs/:routeId/review', requireAdmin, handler(async (c) => {
    const { storage, game } = stores(c);
    const routeId = c.req.param('routeId');
    const input = await body(c);
    const route = await storage.getRouteById(routeId);
    if (!route) return fail(c, 404, 'Carrera no encontrada.');
    const validation = await game.getRouteValidation(routeId);
    const reasons = (validation?.reasons ?? []) as any[];
    if (input.action === 'approve') {
      await game.setRouteValidation(routeId, 'accepted', reasons.filter((r) => r === 'vehicle_stretch_removed'), validation?.globalAreaGained ?? null);
      return c.json({ success: true, status: 'accepted' });
    }
    if (input.action === 'revert') {
      const analysis = withReasons({ status: 'accepted', reasons, message: null, segments: [], stats: {} as any }, ['reviewed_reverted']);
      await game.setRouteValidation(routeId, 'rejected', analysis.reasons, 0);
      await game.removeCompetitionRunsOfRoute(routeId);
      const global = await rebuildGlobalForUser(storage, route.userId);
      const competition = await rebuildCompetitionForUser(storage, route.userId);
      return c.json({ success: true, status: 'rejected', globalArea: global.area, competitionArea: competition });
    }
    return fail(c, 400, 'action debe ser "approve" o "revert".');
  }));
}
