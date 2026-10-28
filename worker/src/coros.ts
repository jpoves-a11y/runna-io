// COROS Partner API integration (apply at support.coros.com → "Submit an API Application", api@coros.com).
//
// Flow (mirrors Suunto's endpoints so the iOS app treats every provider alike):
//   GET  /api/coros/connect            -> { authUrl } (COROS OAuth2 authorize page; ?client=ios for the app flow)
//   GET  /api/coros/callback           <- COROS redirect: exchanges the code, stores tokens + COROS openId
//   POST /api/coros/webhook            <- COROS workout summary push ({ sportDataList: [...] }, ~5 min after a sync):
//                                         import (FIT file) + route + push notification
//   POST /api/coros/sync/:userId       -> pulls the last 30 days of workouts (FIT files) into coros_activities
//   POST /api/coros/process/:userId    -> turns one pending workout into a route (territory via the queue)
//   GET  /api/coros/status/:userId, GET /api/coros/activities/:userId, POST /api/coros/retry/:activityId,
//   DELETE /api/coros/activities/:userId/:activityId, POST /api/coros/disconnect
//   POST /api/tasks/coros-auto-sync    -> hourly fallback poll (cron), in case a push was missed
//
// COROS API Reference V2.1.1 (Sept. 2026): authorize / accesstoken / refresh-token / deauthorize under /oauth2
// (§3), workout list GET /v2/coros/sport/list?token&openId&startDate&endDate (yyyyMMdd, at most 30 days per
// call, 3 months back, §4.2), FIT link GET /v2/coros/sport/detail/fit (§5.4) when a workout has none, and the
// workout summary push (§5.3). Every answer carries result "0000" on success. Access tokens last 30 days;
// refresh-token extends the same token (§3.3). If the user denies access, COROS redirects with only `state`.
//   GET  /api/coros/webhook            -> 200: the "Service Status Check URL" COROS polls
//
// Secrets: COROS_CLIENT_ID, COROS_CLIENT_SECRET (application ID / key from COROS).
// Optional: COROS_PUSH_CLIENT / COROS_PUSH_SECRET (the client / secret COROS puts in the push headers, if it
// assigns different ones; default: the application ID / key), COROS_WEBHOOK_SECRET (the push URL registered
// with COROS must then carry ?key=<secret>), COROS_API_BASE (https://opentest.coros.com while testing).
import type { Context, Hono } from 'hono';
import {
  type AppEnv,
  requireAuth,
  requireSelf,
  requireSelfOrAdmin,
  rejectIfNotSelf,
  createOAuthState,
  verifyOAuthState,
  oauthFinish,
  isCronRequest,
} from './auth';
import { createDb } from './db';
import { WorkerStorage } from './storage';
import type { Env } from './index';
import type { CorosAccount, CorosActivity, Route } from '../../shared/schema';
import { parseFit, isFootSport, fitSportLabel, fitTrack, FIT_SPORT, FIT_SUB_SPORT, type FitActivity } from './fit';
import { encodePolyline, decodePolyline } from './territory';
import { generateFeedEvents, reprocessUserTerritories } from './routes';
import { sendPushToUser } from './pushHelper';

type AppContext = Context<AppEnv>;

const DEFAULT_COROS_API_BASE = 'https://open.coros.com';
const DEFAULT_WORKER_URL = 'https://runna-io-api.runna-io-api.workers.dev';
/** COROS answers result "0000" when a call worked. */
const COROS_OK = '0000';

/** Same competition start as the Polar / Strava / Suunto / Garmin imports. */
const COMPETITION_MIN_DATE = new Date('2026-03-02T00:00:00Z');
/** Days pulled by "Sincronizar ahora" (COROS allows at most 30 days per list call). */
const SYNC_DAYS = 30;
/** FIT downloads per /sync call (keeps a call well under the Worker subrequest limit). */
const FIT_FETCH_BUDGET = 5;
/** COROS access tokens last 30 days; refresh them a day before. */
const TOKEN_LIFETIME_S = 30 * 24 * 3600;
const TOKEN_REFRESH_MARGIN_MS = 24 * 3600 * 1000;
/** Minimum spacing between stored GPS points (watches record every second). */
const TRACK_MIN_SPACING_M = 5;
/** Routes created per push (the rest stay pending for the app's /process loop). */
const MAX_ROUTES_PER_NOTIFICATION = 3;

/** Skip reasons that a new sync must not re-evaluate (the app's "Reintentar" still can). */
const PERMANENT_SKIP_REASONS = new Set(['before_competition', 'excluded_type', 'distance_too_short', 'duration_too_short', 'deleted_by_user']);

/**
 * COROS sport modes on foot (§4.2 workout types: 8 run, 15 trail run, 16 hike, 20 track run, 31 walk): only
 * used when the FIT file doesn't say its sport. The FIT file's sport always decides otherwise.
 */
const FOOT_MODES = new Set([8, 15, 16, 20, 31]);
/**
 * Modes skipped without downloading anything: 9 bike, 10 swim, 13 triathlon / multisport (its FIT files are
 * per leg), 21 ski. Indoor run (8/2) is still downloaded: the FIT file says treadmill and it is skipped then.
 */
const NON_FOOT_MODES = new Set([9, 10, 13, 21]);

function getStorage(env: Env): WorkerStorage {
  return new WorkerStorage(createDb(env.DATABASE_URL, env.TURSO_AUTH_TOKEN));
}

export function isCorosConfigured(env: Env): boolean {
  return !!(env.COROS_CLIENT_ID && env.COROS_CLIENT_SECRET);
}

function apiBase(env: Env): string {
  return (env.COROS_API_BASE || DEFAULT_COROS_API_BASE).replace(/\/+$/, '');
}

function redirectUri(env: Env): string {
  return `${env.WORKER_URL || DEFAULT_WORKER_URL}/api/coros/callback`;
}

/** Runs `task` after the response when the runtime allows it (Workers), else awaits it. */
async function runInBackground(c: AppContext, task: Promise<unknown>): Promise<void> {
  const safe = task.catch((error) => console.error('[COROS] Background task failed:', error));
  let ctx: { waitUntil(promise: Promise<unknown>): void } | null = null;
  try {
    ctx = c.executionCtx;
  } catch {
    ctx = null;
  }
  if (ctx) ctx.waitUntil(safe);
  else await safe;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function toId(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function toEpochMs(value: unknown): number | null {
  const n = toNumber(value);
  if (n !== null) return n < 100_000_000_000 ? n * 1000 : n; // seconds or ms
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True when a COROS answer reports success (result "0000", or no result field at all). */
function isCorosOk(body: Record<string, unknown> | null): boolean {
  if (!body) return false;
  const result = toId(body.result);
  return result === null || result === COROS_OK;
}

async function postForm(url: string, params: Record<string, string>): Promise<{ ok: boolean; status: number; body: Record<string, unknown> | null; text: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: new URLSearchParams(params).toString(),
  });
  const text = await response.text();
  let body: Record<string, unknown> | null = null;
  try {
    body = asObject(JSON.parse(text));
  } catch {
    body = null;
  }
  return { ok: response.ok, status: response.status, body, text };
}

// ==================== Tokens ====================

export interface CorosToken {
  accessToken: string;
  refreshToken: string | null;
  openId: string | null;
  expiresAt: string;
}

/** Token fields from an /oauth2/accesstoken (or refresh) answer, flat or under "data". */
export function parseCorosToken(body: Record<string, unknown> | null): CorosToken | null {
  if (!body) return null;
  const source = asObject(body.data) ?? body;
  const accessToken = toId(source.access_token) ?? toId(source.accessToken);
  if (!accessToken) return null;
  const expiresIn = toNumber(source.expires_in) ?? toNumber(source.expiresIn);
  return {
    accessToken,
    refreshToken: toId(source.refresh_token) ?? toId(source.refreshToken),
    openId: toId(source.openId) ?? toId(source.openid) ?? toId(source.open_id),
    expiresAt: new Date(Date.now() + (expiresIn && expiresIn > 0 ? expiresIn : TOKEN_LIFETIME_S) * 1000).toISOString(),
  };
}

/** A usable access token for the account, refreshed (and saved) when it is about to expire. Null if COROS refused. */
export async function getValidCorosToken(account: CorosAccount, storage: WorkerStorage, env: Env): Promise<string | null> {
  const expiresAt = account.expiresAt ? new Date(account.expiresAt).getTime() : NaN;
  if (Number.isFinite(expiresAt) && expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) return account.accessToken;
  if (!account.refreshToken) return Number.isFinite(expiresAt) && expiresAt < Date.now() ? null : account.accessToken;
  try {
    const result = await postForm(`${apiBase(env)}/oauth2/refresh-token`, {
      client_id: env.COROS_CLIENT_ID || '',
      client_secret: env.COROS_CLIENT_SECRET || '',
      grant_type: 'refresh_token',
      refresh_token: account.refreshToken,
    });
    if (!result.ok || !isCorosOk(result.body)) {
      console.error(`[COROS] Token refresh failed for user ${account.userId}: ${result.status} ${result.text.slice(0, 200)}`);
      // Still valid for a while: keep using it
      return Number.isFinite(expiresAt) && expiresAt > Date.now() ? account.accessToken : null;
    }
    // COROS extends the current access token (30 days more); newer API versions may return a new one
    const token = parseCorosToken(result.body);
    const updated = {
      accessToken: token?.accessToken ?? account.accessToken,
      refreshToken: token?.refreshToken ?? account.refreshToken,
      expiresAt: token?.expiresAt ?? new Date(Date.now() + TOKEN_LIFETIME_S * 1000).toISOString(),
    };
    await storage.updateCorosAccount(account.userId, updated);
    account.accessToken = updated.accessToken;
    account.refreshToken = updated.refreshToken;
    account.expiresAt = updated.expiresAt;
    return updated.accessToken;
  } catch (error) {
    console.error('[COROS] Token refresh error:', error);
    return null;
  }
}

/** Revokes Runna.io's access on COROS (disconnect / account deletion). Best effort. */
export async function deauthorizeCoros(env: Env, account: CorosAccount): Promise<boolean> {
  try {
    // §3.4: the example passes the token in the URL, the table in a header; both are sent
    const response = await fetch(`${apiBase(env)}/oauth2/deauthorize?token=${encodeURIComponent(account.accessToken)}`, {
      method: 'POST',
      headers: { token: account.accessToken },
    });
    if (!response.ok) {
      console.error(`[COROS] Deauthorize failed for user ${account.userId}: ${response.status}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error('[COROS] Deauthorize error:', error);
    return false;
  }
}

// ==================== Workout list ====================

export interface CorosWorkoutSummary {
  /** COROS workout ID ("labelId") */
  labelId: string;
  /** COROS openId of the owner (push items; list items may omit it) */
  openId: string | null;
  mode: number | null;
  subMode: number | null;
  /** ms since the Unix epoch */
  startTime: number | null;
  /** ms since the Unix epoch */
  endTime: number | null;
  /** metres */
  distance: number | null;
  /** seconds */
  totalTime: number | null;
  deviceName: string | null;
  fitUrl: string | null;
}

/** One workout item (list answer or push body). Null without a labelId. */
export function parseCorosWorkout(raw: unknown): CorosWorkoutSummary | null {
  const item = asObject(raw);
  if (!item) return null;
  const labelId = toId(item.labelId) ?? toId(item.labelID) ?? toId(item.workoutId);
  if (!labelId) return null;
  const fitUrl = typeof item.fitUrl === 'string' && item.fitUrl.trim() ? item.fitUrl.trim() : null;
  return {
    labelId,
    openId: toId(item.openId) ?? toId(item.openid),
    mode: toNumber(item.mode),
    subMode: toNumber(item.subMode),
    startTime: toEpochMs(item.startTime),
    endTime: toEpochMs(item.endTime),
    distance: toNumber(item.distance),
    totalTime: toNumber(item.totalTime) ?? toNumber(item.duration),
    deviceName: typeof item.deviceName === 'string' && item.deviceName.trim() ? item.deviceName.trim() : null,
    fitUrl,
  };
}

/** yyyyMMdd (UTC) of a time in ms, as the list endpoint expects. */
export function corosDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

type ListResult = { ok: true; workouts: CorosWorkoutSummary[] } | { ok: false; status: number; error: string };

/** Workouts between `sinceMs` and today (the range is clamped to COROS's 30-day maximum), oldest first. */
async function listWorkouts(env: Env, account: CorosAccount, accessToken: string, sinceMs: number): Promise<ListResult> {
  const end = Date.now() + 24 * 3600 * 1000; // tomorrow (UTC), so late-evening runs in UTC+ zones are included
  const start = Math.max(sinceMs, end - (SYNC_DAYS - 1) * 24 * 3600 * 1000);
  const params = new URLSearchParams({
    token: accessToken,
    openId: account.corosOpenId,
    startDate: corosDate(start),
    endDate: corosDate(end),
  });
  const response = await fetch(`${apiBase(env)}/v2/coros/sport/list?${params.toString()}`, { headers: { 'Accept': 'application/json' } });
  const text = await response.text();
  if (!response.ok) {
    console.error(`[COROS] Workout list failed: ${response.status} ${text.slice(0, 300)}`);
    return { ok: false, status: response.status, error: `COROS ${response.status}` };
  }
  let body: Record<string, unknown> | null = null;
  try {
    body = asObject(JSON.parse(text));
  } catch {
    body = null;
  }
  if (!body || !isCorosOk(body)) {
    console.error(`[COROS] Workout list error: ${text.slice(0, 300)}`);
    return { ok: false, status: 502, error: toId(body?.result) ?? 'invalid_response' };
  }
  const data = Array.isArray(body.data) ? body.data : Array.isArray(asObject(body.data)?.list) ? (asObject(body.data)!.list as unknown[]) : [];
  const workouts = data.map(parseCorosWorkout).filter((w): w is CorosWorkoutSummary => w !== null);
  // Oldest first, so territory is conquered in the order it was run
  workouts.sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0));
  return { ok: true, workouts };
}

/** The FIT link of one workout (§5.4), for list / push items that come without one. */
async function fetchFitUrl(env: Env, account: CorosAccount, accessToken: string, summary: CorosWorkoutSummary): Promise<string | null> {
  if (summary.mode === null || summary.subMode === null) return null;
  try {
    const params = new URLSearchParams({
      mode: String(summary.mode),
      subMode: String(summary.subMode),
      labelId: summary.labelId,
      openId: account.corosOpenId,
      token: accessToken,
    });
    const response = await fetch(`${apiBase(env)}/v2/coros/sport/detail/fit?${params.toString()}`, { headers: { 'Accept': 'application/json' } });
    const body = asObject(await response.json().catch(() => null));
    if (!response.ok || !isCorosOk(body)) {
      console.error(`[COROS] FIT link request failed for ${summary.labelId}: ${response.status} ${JSON.stringify(body)?.slice(0, 200)}`);
      return null;
    }
    const fitUrl = asObject(body?.data)?.fitUrl;
    return typeof fitUrl === 'string' && fitUrl.trim() ? fitUrl.trim() : null;
  } catch (error) {
    console.error(`[COROS] FIT link request error for ${summary.labelId}:`, error);
    return null;
  }
}

// ==================== Import (FIT -> coros_activities) ====================

export type ImportOutcome =
  | { kind: 'imported'; activity: CorosActivity }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'exists' };

function activityTypeName(sport: number | null, subSport: number | null): string {
  if (sport === FIT_SPORT.running) {
    if (subSport === FIT_SUB_SPORT.trail) return 'trail_running';
    if (subSport === FIT_SUB_SPORT.track) return 'track_running';
    return 'running';
  }
  if (sport === FIT_SPORT.walking) return 'walking';
  if (sport === FIT_SPORT.hiking) return 'hiking';
  if (sport === FIT_SPORT.cycling) return 'cycling';
  if (sport === FIT_SPORT.swimming) return 'swimming';
  return sport === null ? 'unknown' : `sport_${sport}`;
}

/** Only https URLs are downloaded (fitUrl comes from COROS: the list answer or an authenticated push). */
export function isAllowedFitUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Downloads one workout's FIT file and stores it as a pending coros_activities row (or as skipped /
 * failed with the reason). Returns 'exists' when it was already handled.
 */
export async function importCorosWorkout(
  env: Env,
  storage: WorkerStorage,
  account: CorosAccount,
  accessToken: string | null,
  summary: CorosWorkoutSummary,
  options: { reevaluatePermanent?: boolean } = {},
): Promise<ImportOutcome> {
  const userId = account.userId;
  const existing = await storage.getCorosActivityByWorkoutId(summary.labelId);
  if (existing) {
    if (existing.userId !== userId || existing.routeId) return { kind: 'exists' };
    if (!existing.skipReason && existing.status !== 'failed') return { kind: 'exists' };
    if (existing.skipReason && PERMANENT_SKIP_REASONS.has(existing.skipReason) && !options.reevaluatePermanent) return { kind: 'exists' };
    await storage.deleteCorosActivityById(existing.id);
  }

  const base: { corosWorkoutId: string; userId: string; routeId: null; corosMode: number | null; corosSubMode: number | null; deviceName: string | null; fitUrl: string | null } = {
    corosWorkoutId: summary.labelId,
    userId,
    routeId: null,
    corosMode: summary.mode,
    corosSubMode: summary.subMode,
    deviceName: summary.deviceName,
    fitUrl: summary.fitUrl,
  };
  const save = async (fields: {
    status: 'skipped' | 'failed';
    reason: string;
    name?: string;
    activityType?: string;
    distance?: number;
    duration?: number;
    startMs?: number | null;
  }) => {
    const start = fields.startMs ?? summary.startTime;
    await storage.createCorosActivity({
      ...base,
      name: fields.name ?? 'Actividad COROS',
      activityType: fields.activityType ?? (summary.mode !== null ? `mode_${summary.mode}` : 'unknown'),
      distance: fields.distance ?? summary.distance ?? 0,
      duration: Math.round(fields.duration ?? summary.totalTime ?? 0),
      startDate: new Date(start ?? Date.now()).toISOString(),
      summaryPolyline: null,
      status: fields.status,
      processed: true,
      processedAt: new Date().toISOString(),
      skipReason: fields.reason,
    });
  };

  // Cheap checks from the summary, before downloading anything
  if (summary.startTime !== null && summary.startTime < COMPETITION_MIN_DATE.getTime()) {
    await save({ status: 'skipped', reason: 'before_competition' });
    return { kind: 'skipped', reason: 'before_competition' };
  }
  if (summary.mode !== null && NON_FOOT_MODES.has(summary.mode)) {
    await save({ status: 'skipped', reason: 'excluded_type' });
    return { kind: 'skipped', reason: 'excluded_type' };
  }
  if (!summary.fitUrl && accessToken) {
    summary = { ...summary, fitUrl: await fetchFitUrl(env, account, accessToken, summary) };
    base.fitUrl = summary.fitUrl;
  }
  if (!summary.fitUrl || !isAllowedFitUrl(summary.fitUrl)) {
    await save({ status: 'failed', reason: 'fit_unavailable' });
    return { kind: 'failed', reason: 'fit_unavailable' };
  }

  let fitBytes: ArrayBuffer;
  try {
    const response = await fetch(summary.fitUrl);
    if (!response.ok) {
      console.error(`[COROS] FIT download failed for ${summary.labelId}: ${response.status}`);
      await save({ status: 'failed', reason: 'fit_unavailable' });
      return { kind: 'failed', reason: 'fit_unavailable' };
    }
    fitBytes = await response.arrayBuffer();
  } catch (error) {
    console.error(`[COROS] FIT download error for ${summary.labelId}:`, error);
    await save({ status: 'failed', reason: 'fit_unavailable' });
    return { kind: 'failed', reason: 'fit_unavailable' };
  }

  let fit: FitActivity;
  try {
    fit = parseFit(fitBytes);
  } catch (error) {
    console.error(`[COROS] FIT parse error for ${summary.labelId}:`, error);
    await save({ status: 'failed', reason: 'fit_error' });
    return { kind: 'failed', reason: 'fit_error' };
  }

  const fitSportKnown = fit.sport !== null && fit.sport !== FIT_SPORT.generic;
  const onFoot = fitSportKnown ? isFootSport(fit.sport, fit.subSport) : summary.mode !== null && FOOT_MODES.has(summary.mode);
  const startMs = fit.startTime ?? summary.startTime;
  const lastPoint = fit.points.length > 0 ? fit.points[fit.points.length - 1] : null;
  const distance = fit.totalDistance ?? summary.distance ?? lastPoint?.distance ?? 0;
  const endMs = fit.sessions.length > 0 ? fit.sessions[fit.sessions.length - 1].endTime : summary.endTime ?? lastPoint?.time ?? null;
  const duration = Math.round(
    fit.totalTimerTime ?? summary.totalTime ?? (startMs !== null && endMs !== null ? (endMs - startMs) / 1000 : 0),
  );
  const label = fitSportKnown ? fitSportLabel(fit.sport, fit.subSport) : summary.mode === 31 ? 'Caminata' : summary.mode === 16 ? 'Senderismo' : 'Carrera';
  const name = `${label} COROS (${(distance / 1000).toFixed(2)}km)`;
  const activityType = fitSportKnown ? activityTypeName(fit.sport, fit.subSport) : 'running';
  const details = { name, activityType, distance, duration, startMs };

  console.log(`[COROS] Workout ${summary.labelId}: sport ${fit.sport}/${fit.subSport} mode ${summary.mode}/${summary.subMode} ${distance}m ${duration}s ${fit.points.length} GPS points`);

  if (!onFoot) {
    await save({ status: 'skipped', reason: 'excluded_type', ...details });
    return { kind: 'skipped', reason: 'excluded_type' };
  }
  if (startMs === null || !Number.isFinite(startMs)) {
    await save({ status: 'skipped', reason: 'bad_date', ...details });
    return { kind: 'skipped', reason: 'bad_date' };
  }
  if (startMs < COMPETITION_MIN_DATE.getTime()) {
    await save({ status: 'skipped', reason: 'before_competition', ...details });
    return { kind: 'skipped', reason: 'before_competition' };
  }
  if (distance < 100) {
    await save({ status: 'skipped', reason: 'distance_too_short', ...details });
    return { kind: 'skipped', reason: 'distance_too_short' };
  }
  if (duration < 60) {
    await save({ status: 'skipped', reason: 'duration_too_short', ...details });
    return { kind: 'skipped', reason: 'duration_too_short' };
  }
  const track = fitTrack(fit.points, TRACK_MIN_SPACING_M);
  if (track.length < 2) {
    await save({ status: 'skipped', reason: 'no_gps', ...details });
    return { kind: 'skipped', reason: 'no_gps' };
  }

  const activity = await storage.createCorosActivity({
    ...base,
    name,
    activityType,
    distance,
    duration,
    startDate: new Date(startMs).toISOString(),
    summaryPolyline: encodePolyline(track),
    status: 'pending',
    processed: false,
    processedAt: null,
    skipReason: null,
  });
  return { kind: 'imported', activity };
}

// ==================== Process (coros_activities -> route) ====================

export interface ProcessOutcome {
  routeId: string | null;
  queued: boolean;
  /** The run already existed (e.g. imported from Strava or Apple Health): linked, no new route. */
  reused: boolean;
  skipReason: string | null;
}

/** Creates the route (feed event + territory queue) for a pending activity, like the Suunto import. */
export async function processCorosActivity(env: Env, storage: WorkerStorage, activity: CorosActivity): Promise<ProcessOutcome> {
  const userId = activity.userId;
  const skip = async (reason: string): Promise<ProcessOutcome> => {
    await storage.updateCorosActivity(activity.id, { status: 'skipped', processed: true, processedAt: new Date().toISOString(), skipReason: reason });
    return { routeId: null, queued: false, reused: false, skipReason: reason };
  };

  if (!activity.summaryPolyline) return skip('no_gps');
  const startDate = new Date(activity.startDate);
  if (Number.isNaN(startDate.getTime())) return skip('bad_date');
  if (startDate < COMPETITION_MIN_DATE) return skip('before_competition');

  const coordinates: Array<[number, number]> = decodePolyline(activity.summaryPolyline).map((coord: [number, number]) => [coord[0], coord[1]]);
  if (coordinates.length < 2) return skip('no_gps');

  const startedAt = startDate.toISOString();
  const completedAt = new Date(startDate.getTime() + activity.duration * 1000).toISOString();

  // Same run already on Runna.io (Strava / Polar / Suunto / Garmin / Apple Health): link it, don't duplicate
  let route: Route | null = activity.routeId ? await storage.getRouteById(activity.routeId) : null;
  if (!route) {
    const similar = await storage.findSimilarRoute(userId, startedAt, activity.distance);
    if (similar) {
      await storage.updateCorosActivity(activity.id, { routeId: similar.id, status: 'imported', processed: true, processedAt: new Date().toISOString() });
      console.log(`[COROS] Activity ${activity.id} matches existing route ${similar.id}: linked, not duplicated`);
      return { routeId: similar.id, queued: false, reused: true, skipReason: null };
    }
    route = await storage.createRoute({
      userId,
      name: activity.name,
      coordinates: JSON.stringify(coordinates),
      distance: activity.distance,
      duration: activity.duration,
      startedAt,
      completedAt,
    });
  }
  await storage.updateCorosActivity(activity.id, { routeId: route.id });

  if (coordinates.length < 10) {
    // Too short for territory: route + feed event only
    try {
      await generateFeedEvents(storage, userId, route.id, activity.distance, activity.duration, { newAreaConquered: 0, victims: [], ranTogetherWith: [] });
    } catch (error) {
      console.warn('[COROS] Short route feed event failed:', error);
    }
    await storage.updateCorosActivity(activity.id, { status: 'imported', processed: true, processedAt: new Date().toISOString() });
    return { routeId: route.id, queued: false, reused: false, skipReason: null };
  }

  // Early feed event so it exists even if territory processing fails; the queue fills in the conquest data
  let earlyFeedEventId: string | undefined;
  try {
    const existingFeed = await storage.getFeedEventByRouteId(route.id);
    if (existingFeed) {
      earlyFeedEventId = existingFeed.id;
    } else {
      const feedEvent = await storage.createFeedEvent({
        userId,
        eventType: 'activity',
        routeId: route.id,
        distance: activity.distance,
        duration: activity.duration,
        newArea: 0,
        metadata: null,
      });
      earlyFeedEventId = feedEvent.id;
    }
  } catch (error) {
    console.error('[COROS] Early feed event failed:', error);
  }

  let queued = false;
  try {
    await env.TERRITORY_QUEUE.send({
      type: 'process_route_territory',
      userId,
      routeId: route.id,
      startedAt,
      completedAt,
      distance: activity.distance,
      duration: activity.duration,
      earlyFeedEventId,
    });
    queued = true;
  } catch (error) {
    console.error('[COROS] Territory queue send failed:', error);
  }

  await storage.updateCorosActivity(activity.id, { status: 'imported', processed: true, processedAt: new Date().toISOString() });
  console.log(`[COROS] Activity ${activity.id} -> route ${route.id} (queued: ${queued})`);
  return { routeId: route.id, queued, reused: false, skipReason: null };
}

async function notifyImported(env: Env, storage: WorkerStorage, activity: CorosActivity, routeId: string): Promise<void> {
  try {
    const subscriptions = await storage.getPushSubscriptionsByUserId(activity.userId);
    if (subscriptions.length === 0) return;
    const distKm = (activity.distance / 1000).toFixed(1);
    await sendPushToUser(
      subscriptions.map((sub) => ({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } })),
      {
        title: '🏃 ¡Carrera registrada!',
        body: `${activity.name} · ${distKm} km — Entra para ver tu conquista`,
        tag: `coros-auto-${activity.id}`,
        data: { type: 'coros_auto_import', routeId, url: '/?showPendingAnimation=true' },
      },
      env.VAPID_PUBLIC_KEY || '',
      env.VAPID_PRIVATE_KEY || '',
      env.VAPID_SUBJECT || 'mailto:notifications@runna.io',
    );
  } catch (error) {
    console.warn(`[COROS] Push notification failed for ${activity.userId}:`, error);
  }
}

/** Imports + processes workouts and notifies the user of each new route (push and cron path). */
async function importAndProcess(
  env: Env,
  storage: WorkerStorage,
  account: CorosAccount,
  accessToken: string | null,
  workouts: CorosWorkoutSummary[],
  maxFitDownloads: number,
): Promise<{ imported: number; routes: string[] }> {
  let downloads = 0;
  let imported = 0;
  for (const workout of workouts) {
    if (downloads >= maxFitDownloads) break;
    const existing = await storage.getCorosActivityByWorkoutId(workout.labelId);
    if (existing && (existing.routeId || existing.userId !== account.userId || (existing.skipReason ? PERMANENT_SKIP_REASONS.has(existing.skipReason) : existing.status !== 'failed'))) continue;
    // Workouts from before the competition or of other sports are skipped without downloading anything
    const tooOld = workout.startTime !== null && workout.startTime < COMPETITION_MIN_DATE.getTime();
    if (!tooOld && !(workout.mode !== null && NON_FOOT_MODES.has(workout.mode))) downloads++;
    const outcome = await importCorosWorkout(env, storage, account, accessToken, workout);
    if (outcome.kind === 'imported') imported++;
  }
  const routes: string[] = [];
  const pending = await storage.getUnprocessedCorosActivities(account.userId);
  for (const activity of pending.slice(0, MAX_ROUTES_PER_NOTIFICATION)) {
    try {
      const result = await processCorosActivity(env, storage, activity);
      if (result.routeId && !result.reused) {
        routes.push(result.routeId);
        await notifyImported(env, storage, activity, result.routeId);
      }
    } catch (error) {
      console.error(`[COROS] Processing activity ${activity.id} failed:`, error);
    }
  }
  return { imported, routes };
}

// ==================== Push (webhook) ====================

/** Workouts of a push body: { sportDataList: [...] } (also accepts a bare array or "data"). */
export function parseCorosPush(body: unknown): CorosWorkoutSummary[] {
  const obj = asObject(body);
  const list = Array.isArray(body)
    ? body
    : Array.isArray(obj?.sportDataList)
      ? (obj!.sportDataList as unknown[])
      : Array.isArray(obj?.data)
        ? (obj!.data as unknown[])
        : obj && toId(obj.labelId)
          ? [obj]
          : [];
  return list.map(parseCorosWorkout).filter((w): w is CorosWorkoutSummary => w !== null);
}

/**
 * COROS sends a client and secret in the push headers (§5.3): the ones it assigned for the push service
 * (COROS_PUSH_CLIENT / COROS_PUSH_SECRET), or else the application ID and key.
 * Returns true when they match, false when they don't, null when the request has none.
 */
export function corosPushAuthenticated(env: Env, client: string | undefined, secret: string | undefined): boolean | null {
  if (!client && !secret) return null;
  const expectedClient = env.COROS_PUSH_CLIENT || env.COROS_CLIENT_ID || '';
  const expectedSecret = env.COROS_PUSH_SECRET || env.COROS_CLIENT_SECRET || '';
  return !!expectedClient && constantTimeEqual(client || '', expectedClient) && constantTimeEqual(secret || '', expectedSecret);
}

async function handlePush(env: Env, workouts: CorosWorkoutSummary[], trustedFitUrls: boolean): Promise<void> {
  const storage = getStorage(env);
  const byOpenId = new Map<string, CorosWorkoutSummary[]>();
  for (const workout of workouts) {
    if (!workout.openId) continue;
    const list = byOpenId.get(workout.openId) ?? [];
    list.push(workout);
    byOpenId.set(workout.openId, list);
  }

  for (const [openId, pushed] of byOpenId) {
    const account = await storage.getCorosAccountByOpenId(openId);
    if (!account) {
      console.log(`[COROS WEBHOOK] Unknown openId "${openId}": ignored`);
      continue;
    }
    await storage.updateCorosAccount(account.userId, { lastWebhookAt: new Date().toISOString() });
    const accessToken = await getValidCorosToken(account, storage, env);

    // The FIT link is read from COROS's API (the push body is only trusted when it carried our credentials)
    let workoutsToImport: CorosWorkoutSummary[] = [];
    if (accessToken) {
      const earliest = Math.min(...pushed.map((w) => w.startTime ?? Date.now()));
      const list = await listWorkouts(env, account, accessToken, earliest - 24 * 3600 * 1000);
      if (list.ok) {
        const wanted = new Set(pushed.map((w) => w.labelId));
        workoutsToImport = list.workouts.filter((w) => wanted.has(w.labelId));
      }
    } else {
      console.error(`[COROS WEBHOOK] No valid token for user ${account.userId}`);
    }
    if (trustedFitUrls) {
      const found = new Set(workoutsToImport.map((w) => w.labelId));
      workoutsToImport.push(...pushed.filter((w) => !found.has(w.labelId) && w.fitUrl));
    }
    workoutsToImport.sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0));

    const result = await importAndProcess(env, storage, account, accessToken, workoutsToImport, MAX_ROUTES_PER_NOTIFICATION);
    console.log(`[COROS WEBHOOK] User ${account.userId}: ${result.imported} imported, routes ${result.routes.join(', ') || 'none'}`);
  }
}

// ==================== Routes ====================

export function registerCorosRoutes(app: Hono<AppEnv>): void {
  app.get('/api/coros/status/:userId', requireSelf('userId'), async (c) => {
    try {
      const userId = c.req.param('userId');
      const configured = isCorosConfigured(c.env);
      const storage = getStorage(c.env);
      const account = await storage.getCorosAccountByUserId(userId);
      if (!account) return c.json({ configured, connected: false });
      const stats = await storage.getCorosActivityStats(userId);
      return c.json({
        configured,
        connected: true,
        connectedAt: account.connectedAt ?? account.createdAt,
        lastSyncAt: account.lastSyncAt,
        lastWebhookAt: account.lastWebhookAt,
        totalActivities: stats.total,
        pendingActivities: stats.pending,
        failedActivities: stats.failed,
      });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.get('/api/coros/connect', requireAuth, async (c) => {
    try {
      const notSelf = rejectIfNotSelf(c, c.req.query('userId'));
      if (notSelf) return notSelf;
      const userId = c.get('authUserId');
      if (!isCorosConfigured(c.env) || !c.env.COROS_CLIENT_SECRET) {
        return c.json({ error: 'COROS not configured' }, 400);
      }
      const state = await createOAuthState(userId, c.env.COROS_CLIENT_SECRET, { app: c.req.query('client') === 'ios' });
      const params = new URLSearchParams({
        client_id: c.env.COROS_CLIENT_ID || '',
        redirect_uri: redirectUri(c.env),
        response_type: 'code',
        state,
      });
      const authUrl = `${apiBase(c.env)}/oauth2/authorize?${params.toString()}`;
      return c.json({ authUrl, url: authUrl });
    } catch (error: any) {
      console.error('[COROS] Connect error:', error);
      return c.json({ error: error.message }, 500);
    }
  });

  app.get('/api/coros/callback', async (c) => {
    const state = c.req.query('state');
    const secret = c.env.COROS_CLIENT_SECRET;
    const verified = state && secret ? await verifyOAuthState(state, secret) : null;
    const frontend = c.env.FRONTEND_URL || 'https://runna-io.pages.dev';
    const finish = (query: string) => oauthFinish(c, verified?.app === true, 'coros', `${frontend}/profile?${query}`);
    try {
      const code = c.req.query('code');
      // §3.1: when the user refuses, COROS redirects back with `state` only
      if (c.req.query('error') || (!code && verified)) return finish('coros_error=denied');
      if (!code || !state || !secret || !isCorosConfigured(c.env)) return finish('coros_error=invalid');
      if (!verified) return finish('coros_error=invalid_state');
      const userId = verified.userId;

      const result = await postForm(`${apiBase(c.env)}/oauth2/accesstoken`, {
        client_id: c.env.COROS_CLIENT_ID || '',
        client_secret: secret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri(c.env),
      });
      const token = result.ok && isCorosOk(result.body) ? parseCorosToken(result.body) : null;
      if (!token) {
        console.error(`[COROS] Token exchange failed: ${result.status} ${result.text.slice(0, 300)}`);
        return finish('coros_error=token_exchange');
      }
      if (!token.openId) {
        console.error('[COROS] Token answer without openId');
        return finish('coros_error=invalid_user');
      }

      const storage = getStorage(c.env);
      const linked = await storage.getCorosAccountByOpenId(token.openId);
      if (linked && linked.userId !== userId) return finish('coros_error=already_linked');

      const data = {
        userId,
        corosOpenId: token.openId,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: token.expiresAt,
        connectedAt: new Date().toISOString(),
      };
      const existing = await storage.getCorosAccountByUserId(userId);
      if (existing) {
        await storage.updateCorosAccount(userId, data);
      } else {
        await storage.createCorosAccount(data);
      }
      console.log(`[COROS] User ${userId} connected COROS account ${token.openId}`);
      return finish('coros_connected=true');
    } catch (error) {
      console.error('[COROS] Callback error:', error);
      return finish('coros_error=server');
    }
  });

  app.post('/api/coros/disconnect', requireAuth, async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const notSelf = rejectIfNotSelf(c, (body as Record<string, unknown>).userId);
      if (notSelf) return notSelf;
      const userId = c.get('authUserId');
      const storage = getStorage(c.env);
      const account = await storage.getCorosAccountByUserId(userId);
      if (!account) return c.json({ error: 'COROS account not connected' }, 404);
      await deauthorizeCoros(c.env, account);
      await storage.deleteCorosAccount(userId);
      return c.json({ success: true });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // "Service Status Check URL" (§5.2): COROS checks that the push endpoint is up with a GET (200 = working)
  app.get('/api/coros/webhook', (c) => c.json({ status: 'ok', configured: isCorosConfigured(c.env) }));

  // COROS checks the answer: { result: "0000" } means received (anything else makes it retry)
  app.post('/api/coros/webhook', async (c) => {
    const received = () => c.json({ result: COROS_OK, message: 'ok' });
    try {
      const key = c.env.COROS_WEBHOOK_SECRET;
      if (key && !constantTimeEqual(c.req.query('key') || '', key)) {
        console.warn('[COROS WEBHOOK] Missing or wrong ?key: rejected');
        return c.json({ result: '4001', message: 'unauthorized' }, 401);
      }
      const authenticated = corosPushAuthenticated(c.env, c.req.header('client'), c.req.header('secret'));
      if (authenticated === false) {
        console.warn('[COROS WEBHOOK] Wrong client / secret headers: rejected');
        return c.json({ result: '4001', message: 'unauthorized' }, 401);
      }
      let body: unknown = null;
      try {
        body = await c.req.json();
      } catch {
        body = null;
      }
      const workouts = parseCorosPush(body);
      console.log(`[COROS WEBHOOK] workouts=${workouts.length} authenticated=${authenticated === true}`);
      if (!isCorosConfigured(c.env) || workouts.length === 0) return received();
      // Answer at once; the import runs after the response
      await runInBackground(c, handlePush(c.env, workouts, authenticated === true));
      return received();
    } catch (error) {
      console.error('[COROS WEBHOOK] Error:', error);
      return received();
    }
  });

  app.get('/api/coros/activities/:userId', requireSelf('userId'), async (c) => {
    try {
      const storage = getStorage(c.env);
      return c.json(await storage.getCorosActivitiesByUserId(c.req.param('userId')));
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.post('/api/coros/sync/:userId', requireSelfOrAdmin('userId'), async (c) => {
    const userId = c.req.param('userId');
    try {
      if (!isCorosConfigured(c.env)) return c.json({ error: 'COROS not configured' }, 400);
      const storage = getStorage(c.env);
      const account = await storage.getCorosAccountByUserId(userId);
      if (!account) return c.json({ error: 'COROS account not connected' }, 404);
      const accessToken = await getValidCorosToken(account, storage, c.env);
      if (!accessToken) {
        return c.json({ error: 'La conexión con COROS ha caducado. Desconecta y vuelve a conectar COROS.' }, 400);
      }

      const list = await listWorkouts(c.env, account, accessToken, Date.now() - SYNC_DAYS * 24 * 3600 * 1000);
      if (!list.ok) {
        return c.json({ error: `No se han podido leer tus entrenamientos de COROS (${list.error}).` }, 502);
      }

      let imported = 0;
      let skipped = 0;
      let failed = 0;
      let downloads = 0;
      let hasMore = false;
      for (const workout of list.workouts) {
        const existing = await storage.getCorosActivityByWorkoutId(workout.labelId);
        if (existing && (existing.routeId || existing.userId !== userId || (existing.skipReason ? PERMANENT_SKIP_REASONS.has(existing.skipReason) : existing.status !== 'failed'))) {
          continue;
        }
        const cheapSkip = (workout.startTime !== null && workout.startTime < COMPETITION_MIN_DATE.getTime())
          || (workout.mode !== null && NON_FOOT_MODES.has(workout.mode));
        if (!cheapSkip) {
          if (downloads >= FIT_FETCH_BUDGET) {
            hasMore = true;
            break;
          }
          downloads++;
        }
        const outcome = await importCorosWorkout(c.env, storage, account, accessToken, workout);
        if (outcome.kind === 'imported') imported++;
        else if (outcome.kind === 'skipped') skipped++;
        else if (outcome.kind === 'failed') failed++;
      }
      await storage.updateCorosAccount(userId, { lastSyncAt: new Date().toISOString() });
      const message = imported > 0
        ? `${imported} ${imported === 1 ? 'actividad nueva' : 'actividades nuevas'} de COROS`
        : 'No hay actividades nuevas en COROS.';
      return c.json({ imported, skipped, failed, total: list.workouts.length, hasMore, message });
    } catch (error: any) {
      console.error('[COROS] Sync error:', error);
      return c.json({ error: error.message }, 500);
    }
  });

  app.post('/api/coros/process/:userId', requireSelf('userId'), async (c) => {
    try {
      const userId = c.req.param('userId');
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const requestedId = typeof body.activityId === 'string' ? body.activityId : null;
      const storage = getStorage(c.env);
      const pending = await storage.getUnprocessedCorosActivities(userId);
      if (pending.length === 0) return c.json({ processed: 0, results: [], remaining: 0, message: 'No activities to process' });

      const activity = requestedId ? pending.find((a) => a.id === requestedId) : pending[0];
      if (!activity) return c.json({ processed: 0, results: [], remaining: pending.length, message: 'Activity already processed or not found' });

      const outcome = await processCorosActivity(c.env, storage, activity);
      const remaining = pending.length - 1;
      const created = outcome.routeId !== null && !outcome.reused;
      return c.json({
        processed: created ? 1 : 0,
        results: created ? [{ activityId: activity.id, routeId: outcome.routeId, queued: outcome.queued }] : [],
        remaining,
        skipReason: outcome.skipReason,
        message: remaining > 0 ? `Quedan ${remaining} pendientes` : 'Procesadas correctamente',
      });
    } catch (error: any) {
      console.error('[COROS] Process error:', error);
      return c.json({ error: error.message, processed: 0 }, 500);
    }
  });

  // Retry a skipped / failed workout: downloads it again (the app then calls /process)
  app.post('/api/coros/retry/:activityId', requireAuth, async (c) => {
    try {
      const userId = c.get('authUserId');
      const storage = getStorage(c.env);
      const activity = await storage.getCorosActivityById(c.req.param('activityId'));
      if (!activity || activity.userId !== userId) return c.json({ error: 'Actividad no encontrada' }, 404);
      if (activity.routeId) return c.json({ success: true, status: 'imported' });

      if (activity.summaryPolyline) {
        await storage.updateCorosActivity(activity.id, { status: 'pending', processed: false, processedAt: null, skipReason: null });
        return c.json({ success: true, status: 'pending' });
      }
      const account = await storage.getCorosAccountByUserId(userId);
      if (!account || !isCorosConfigured(c.env)) return c.json({ error: 'COROS account not connected' }, 404);

      // The stored FIT link may have expired: look the workout up again around its date
      let summary: CorosWorkoutSummary | null = null;
      const accessToken = await getValidCorosToken(account, storage, c.env);
      if (accessToken) {
        const start = new Date(activity.startDate).getTime();
        const list = await listWorkouts(c.env, account, accessToken, (Number.isFinite(start) ? start : Date.now()) - 24 * 3600 * 1000);
        if (list.ok) summary = list.workouts.find((w) => w.labelId === activity.corosWorkoutId) ?? null;
      }
      summary ??= {
        labelId: activity.corosWorkoutId,
        openId: account.corosOpenId,
        mode: activity.corosMode,
        subMode: activity.corosSubMode,
        startTime: null,
        endTime: null,
        distance: null,
        totalTime: null,
        deviceName: activity.deviceName,
        fitUrl: activity.fitUrl,
      };
      const outcome = await importCorosWorkout(c.env, storage, account, accessToken, summary, { reevaluatePermanent: true });
      return c.json({ success: true, status: outcome.kind, reason: outcome.kind === 'skipped' || outcome.kind === 'failed' ? outcome.reason : null });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // Delete an imported workout's route (territory is recalculated); the workout stays as skipped
  app.delete('/api/coros/activities/:userId/:activityId', requireSelf('userId'), async (c) => {
    try {
      const userId = c.req.param('userId');
      const storage = getStorage(c.env);
      const activity = await storage.getCorosActivityById(c.req.param('activityId'));
      if (!activity) return c.json({ error: 'Actividad no encontrada' }, 404);
      if (activity.userId !== userId) return c.json({ error: 'No autorizado' }, 403);

      const routeId = activity.routeId;
      if (routeId) {
        await storage.markCorosActivityDeletedByRouteId(routeId);
        await storage.markSuuntoActivityDeletedByRouteId(routeId);
        await storage.markGarminActivityDeletedByRouteId(routeId);
        await storage.detachTerritoriesFromRoute(routeId);
        await storage.deleteFeedEventsByRouteId(routeId);
        await storage.deleteConquestMetricsByRouteId(routeId);
        await storage.deletePolarActivityByRouteId(routeId);
        await storage.deleteStravaActivityByRouteId(routeId);
        await storage.deleteRouteById(routeId);
        try {
          await reprocessUserTerritories(storage, userId);
        } catch (error) {
          console.error('[COROS] Territory rebuild after delete failed:', error);
        }
      } else {
        await storage.deleteCorosActivityById(activity.id);
      }
      return c.json({ success: true });
    } catch (error: any) {
      console.error('[COROS] Delete error:', error);
      return c.json({ error: error.message }, 500);
    }
  });

  // Cron (hourly): fallback poll for accounts whose push may have been missed
  app.post('/api/tasks/coros-auto-sync', async (c) => {
    try {
      if (!(await isCronRequest(c))) return c.json({ error: 'Unauthorized' }, 401);
      if (!isCorosConfigured(c.env)) return c.json({ success: true, message: 'COROS not configured', synced: 0 });
      const started = Date.now();
      const storage = getStorage(c.env);
      const staleBefore = new Date(Date.now() - 55 * 60 * 1000).toISOString();
      const accounts = await storage.getCorosAccountsToPoll(staleBefore, 5);
      let synced = 0;
      let imported = 0;
      let routes = 0;
      for (const account of accounts) {
        if (Date.now() - started > 20000) break;
        try {
          const accessToken = await getValidCorosToken(account, storage, c.env);
          await storage.updateCorosAccount(account.userId, { lastSyncAt: new Date().toISOString() });
          if (!accessToken) continue;
          const lastSync = account.lastSyncAt ? new Date(account.lastSyncAt).getTime() : NaN;
          const since = Number.isFinite(lastSync) ? lastSync - 2 * 24 * 3600 * 1000 : Date.now() - 3 * 24 * 3600 * 1000;
          const list = await listWorkouts(c.env, account, accessToken, since);
          if (!list.ok) continue;
          const result = await importAndProcess(c.env, storage, account, accessToken, list.workouts, 3);
          synced++;
          imported += result.imported;
          routes += result.routes.length;
        } catch (error) {
          console.error(`[COROS AUTO-SYNC] User ${account.userId} failed:`, error);
        }
      }
      return c.json({ success: true, accounts: accounts.length, synced, imported, routes, elapsed: Date.now() - started });
    } catch (error: any) {
      console.error('[COROS AUTO-SYNC] Error:', error);
      return c.json({ error: error.message }, 500);
    }
  });
}
