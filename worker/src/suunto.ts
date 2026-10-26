// Suunto Cloud API integration (https://apizone.suunto.com).
//
// Flow (mirrors Polar's endpoints so the iOS app treats both alike):
//   GET  /api/suunto/connect            -> { authUrl } (Suunto OAuth2 authorize page; ?client=ios for the app flow)
//   GET  /api/suunto/callback           <- Suunto redirect: exchanges the code, stores tokens + Suunto username (JWT "user" claim)
//   POST /api/suunto/webhook            <- Suunto "new workout" notification (username + workoutid): import + route + push
//   POST /api/suunto/sync/:userId       -> pulls the last 30 days of workouts (FIT files) into suunto_activities
//   POST /api/suunto/process/:userId    -> turns one pending workout into a route (territory via the queue)
//   GET  /api/suunto/status/:userId, GET /api/suunto/activities/:userId, POST /api/suunto/retry/:activityId,
//   DELETE /api/suunto/activities/:userId/:activityId, POST /api/suunto/disconnect
//   POST /api/tasks/suunto-auto-sync    -> hourly fallback poll (cron), in case a webhook was missed
//
// Secrets: SUUNTO_CLIENT_ID, SUUNTO_CLIENT_SECRET, SUUNTO_SUBSCRIPTION_KEY (Ocp-Apim-Subscription-Key),
// optional SUUNTO_WEBHOOK_SECRET (verifies the notification's HMAC signature when Suunto sends one).
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
import type { SuuntoAccount, SuuntoActivity, Route } from '../../shared/schema';
import { parseFit, isFootSport, fitSportLabel, fitTrack, FIT_SPORT, FIT_SUB_SPORT, type FitActivity } from './fit';
import { encodePolyline, decodePolyline } from './territory';
import { generateFeedEvents, reprocessUserTerritories } from './routes';
import { sendPushToUser } from './pushHelper';

type AppContext = Context<AppEnv>;

const SUUNTO_OAUTH_BASE = 'https://cloudapi-oauth.suunto.com/oauth';
const SUUNTO_API_BASE = 'https://cloudapi.suunto.com';
const DEFAULT_WORKER_URL = 'https://runna-io-api.runna-io-api.workers.dev';

/** Same competition start as the Polar / Strava imports. */
const COMPETITION_MIN_DATE = new Date('2026-03-02T00:00:00Z');
const SYNC_DAYS = 30;
/** FIT downloads per /sync call (keeps a call well under the Worker subrequest limit). */
const FIT_FETCH_BUDGET = 5;
/** Refresh the access token when it expires within this window. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** Minimum spacing between stored GPS points (watches record every second). */
const TRACK_MIN_SPACING_M = 5;

/** Skip reasons that a new sync must not re-evaluate (the app's "Reintentar" still can). */
const PERMANENT_SKIP_REASONS = new Set(['before_competition', 'excluded_type', 'distance_too_short', 'duration_too_short', 'deleted_by_user']);

/**
 * Suunto App activity IDs (workout list `activityId`) that are clearly not on foot: skipped without
 * downloading the FIT file. Everything else is decided by the FIT file's sport.
 * 2 cycling, 10 mountain biking, 21 swimming.
 */
const NON_FOOT_ACTIVITY_IDS = new Set([2, 10, 21]);
/** Suunto App activity IDs on foot (0 walking, 1 running, 11 hiking, 22 trail running, 24 nordic walking). */
const FOOT_ACTIVITY_IDS = new Set([0, 1, 11, 22, 24]);

function getStorage(env: Env): WorkerStorage {
  return new WorkerStorage(createDb(env.DATABASE_URL, env.TURSO_AUTH_TOKEN));
}

export function isSuuntoConfigured(env: Env): boolean {
  return !!(env.SUUNTO_CLIENT_ID && env.SUUNTO_CLIENT_SECRET && env.SUUNTO_SUBSCRIPTION_KEY);
}

function redirectUri(env: Env): string {
  return `${env.WORKER_URL || DEFAULT_WORKER_URL}/api/suunto/callback`;
}

/** Runs `task` after the response when the runtime allows it (Workers), else awaits it. */
async function runInBackground(c: AppContext, task: Promise<unknown>): Promise<void> {
  const safe = task.catch((error) => console.error('[SUUNTO] Background task failed:', error));
  let ctx: { waitUntil(promise: Promise<unknown>): void } | null = null;
  try {
    ctx = c.executionCtx;
  } catch {
    ctx = null;
  }
  if (ctx) ctx.waitUntil(safe);
  else await safe;
}

// ==================== Tokens ====================

interface SuuntoTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  user?: string;
}

/** Payload of a JWT (no signature check: the token came straight from Suunto's token endpoint over TLS). */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Suunto username: the JWT's custom "user" claim (fallback: a `user` field in the token response). */
export function suuntoUsernameFromToken(token: SuuntoTokenResponse): string | null {
  const claims = token.access_token ? decodeJwtPayload(token.access_token) : null;
  const fromJwt = claims && typeof claims.user === 'string' ? claims.user : null;
  const username = fromJwt || (typeof token.user === 'string' ? token.user : null);
  return username && username.trim() ? username.trim() : null;
}

async function requestToken(env: Env, params: Record<string, string>): Promise<{ ok: boolean; status: number; token: SuuntoTokenResponse | null; text: string }> {
  const response = await fetch(`${SUUNTO_OAUTH_BASE}/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${btoa(`${env.SUUNTO_CLIENT_ID}:${env.SUUNTO_CLIENT_SECRET}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: new URLSearchParams(params).toString(),
  });
  const text = await response.text();
  let token: SuuntoTokenResponse | null = null;
  try {
    token = JSON.parse(text) as SuuntoTokenResponse;
  } catch {
    token = null;
  }
  return { ok: response.ok, status: response.status, token, text };
}

function expiryFromToken(token: SuuntoTokenResponse): string {
  const seconds = typeof token.expires_in === 'number' && token.expires_in > 0 ? token.expires_in : 86400;
  return new Date(Date.now() + seconds * 1000).toISOString();
}

/** A usable access token for the account, refreshed (and saved) when it is about to expire. Null if Suunto refused. */
export async function getValidSuuntoToken(account: SuuntoAccount, storage: WorkerStorage, env: Env): Promise<string | null> {
  const expiresAt = account.expiresAt ? new Date(account.expiresAt).getTime() : NaN;
  if (Number.isFinite(expiresAt) && expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) return account.accessToken;
  if (!account.refreshToken) {
    // No expiry known and nothing to refresh with: try the token we have
    return Number.isFinite(expiresAt) ? null : account.accessToken;
  }
  try {
    const result = await requestToken(env, { grant_type: 'refresh_token', refresh_token: account.refreshToken });
    if (!result.ok || !result.token?.access_token) {
      console.error(`[SUUNTO] Token refresh failed for user ${account.userId}: ${result.status} ${result.text.slice(0, 200)}`);
      return null;
    }
    const updated = {
      accessToken: result.token.access_token,
      refreshToken: result.token.refresh_token || account.refreshToken,
      expiresAt: expiryFromToken(result.token),
      scope: result.token.scope ?? account.scope,
    };
    await storage.updateSuuntoAccount(account.userId, updated);
    account.accessToken = updated.accessToken;
    account.refreshToken = updated.refreshToken;
    account.expiresAt = updated.expiresAt;
    return updated.accessToken;
  } catch (error) {
    console.error('[SUUNTO] Token refresh error:', error);
    return null;
  }
}

function apiHeaders(env: Env, accessToken: string, accept: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${accessToken}`,
    'Ocp-Apim-Subscription-Key': env.SUUNTO_SUBSCRIPTION_KEY || '',
    'Accept': accept,
  };
}

// ==================== Workout list ====================

export interface SuuntoWorkoutSummary {
  workoutKey: string;
  activityId: number | null;
  /** ms since the Unix epoch */
  startTime: number | null;
  /** metres */
  totalDistance: number | null;
  /** seconds */
  totalTime: number | null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
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

function workoutKeyOf(item: Record<string, unknown>): string | null {
  for (const key of ['workoutKey', 'workoutkey', 'workoutId', 'workoutid', 'key', 'id']) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

/** Workouts from a GET /v2/workouts response, whatever envelope it comes in. */
export function extractWorkoutList(body: unknown): SuuntoWorkoutSummary[] | null {
  let items: unknown = null;
  if (Array.isArray(body)) {
    items = body;
  } else if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    for (const key of ['payload', 'workouts', 'data', 'items', 'results']) {
      const value = obj[key];
      if (Array.isArray(value)) {
        items = value;
        break;
      }
      if (value && typeof value === 'object') {
        const inner = value as Record<string, unknown>;
        for (const innerKey of ['workouts', 'items', 'payload', 'data']) {
          if (Array.isArray(inner[innerKey])) {
            items = inner[innerKey];
            break;
          }
        }
        if (items) break;
      }
    }
  }
  if (!Array.isArray(items)) return null;
  const workouts: SuuntoWorkoutSummary[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const workoutKey = workoutKeyOf(item);
    if (!workoutKey) continue;
    workouts.push({
      workoutKey,
      activityId: toNumber(item.activityId ?? item.activityID ?? item.activity_id),
      startTime: toEpochMs(item.startTime ?? item.start_time),
      totalDistance: toNumber(item.totalDistance ?? item.distance),
      totalTime: toNumber(item.totalTime ?? item.duration),
    });
  }
  return workouts;
}

type ListResult = { ok: true; workouts: SuuntoWorkoutSummary[] } | { ok: false; status: number; error: string };

async function listWorkouts(env: Env, accessToken: string, sinceMs: number, limit = 100): Promise<ListResult> {
  const url = `${SUUNTO_API_BASE}/v2/workouts?since=${Math.floor(sinceMs)}&limit=${limit}`;
  const response = await fetch(url, { headers: apiHeaders(env, accessToken, 'application/json') });
  const text = await response.text();
  if (!response.ok) {
    console.error(`[SUUNTO] Workout list failed: ${response.status} ${text.slice(0, 300)}`);
    return { ok: false, status: response.status, error: `Suunto ${response.status}` };
  }
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    console.error(`[SUUNTO] Workout list is not JSON: ${text.slice(0, 300)}`);
    return { ok: false, status: 502, error: 'invalid_response' };
  }
  const workouts = extractWorkoutList(body);
  if (!workouts) {
    const obj = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
    // {"error": null, "payload": null, ...}: no workouts in the range
    if (obj && 'payload' in obj && (obj.payload === null || obj.payload === undefined)) return { ok: true, workouts: [] };
    console.warn(`[SUUNTO] Unknown workout list shape: ${text.slice(0, 500)}`);
    return { ok: true, workouts: [] };
  }
  // Oldest first, so territory is conquered in the order it was run
  workouts.sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0));
  return { ok: true, workouts };
}

// ==================== Import (FIT -> suunto_activities) ====================

export type ImportOutcome =
  | { kind: 'imported'; activity: SuuntoActivity }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'exists' };

function activityTypeName(sport: number | null, subSport: number | null): string {
  if (sport === FIT_SPORT.running) return subSport === FIT_SUB_SPORT.trail ? 'trail_running' : 'running';
  if (sport === FIT_SPORT.walking) return 'walking';
  if (sport === FIT_SPORT.hiking) return 'hiking';
  if (sport === FIT_SPORT.cycling) return 'cycling';
  if (sport === FIT_SPORT.swimming) return 'swimming';
  return sport === null ? 'unknown' : `sport_${sport}`;
}

/**
 * Downloads one workout's FIT file and stores it as a pending suunto_activities row (or as skipped /
 * failed with the reason). Returns 'exists' when it was already handled.
 */
export async function importSuuntoWorkout(
  env: Env,
  storage: WorkerStorage,
  account: SuuntoAccount,
  accessToken: string,
  summary: SuuntoWorkoutSummary,
  options: { reevaluatePermanent?: boolean } = {},
): Promise<ImportOutcome> {
  const userId = account.userId;
  const existing = await storage.getSuuntoActivityByWorkoutKey(summary.workoutKey);
  if (existing) {
    if (existing.userId !== userId) return { kind: 'exists' };
    if (!existing.skipReason && existing.status !== 'failed') return { kind: 'exists' };
    if (existing.skipReason && PERMANENT_SKIP_REASONS.has(existing.skipReason) && !options.reevaluatePermanent) return { kind: 'exists' };
    if (existing.routeId) return { kind: 'exists' };
    await storage.deleteSuuntoActivityById(existing.id);
  }

  const baseName = 'Actividad Suunto';
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
    await storage.createSuuntoActivity({
      workoutKey: summary.workoutKey,
      userId,
      routeId: null,
      name: fields.name ?? baseName,
      activityType: fields.activityType ?? 'unknown',
      suuntoActivityId: summary.activityId,
      distance: fields.distance ?? summary.totalDistance ?? 0,
      duration: Math.round(fields.duration ?? summary.totalTime ?? 0),
      startDate: new Date(start ?? Date.now()).toISOString(),
      summaryPolyline: null,
      status: fields.status,
      processed: true,
      processedAt: new Date().toISOString(),
      skipReason: fields.reason,
    });
  };

  // Cheap checks from the list entry, before downloading anything
  if (summary.startTime !== null && summary.startTime < COMPETITION_MIN_DATE.getTime()) {
    await save({ status: 'skipped', reason: 'before_competition' });
    return { kind: 'skipped', reason: 'before_competition' };
  }
  if (summary.activityId !== null && NON_FOOT_ACTIVITY_IDS.has(summary.activityId)) {
    await save({ status: 'skipped', reason: 'excluded_type' });
    return { kind: 'skipped', reason: 'excluded_type' };
  }

  let fitBytes: ArrayBuffer;
  try {
    const response = await fetch(`${SUUNTO_API_BASE}/v2/workout/exportFit/${encodeURIComponent(summary.workoutKey)}`, {
      headers: apiHeaders(env, accessToken, 'application/octet-stream'),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error(`[SUUNTO] FIT download failed for ${summary.workoutKey}: ${response.status} ${text.slice(0, 200)}`);
      await save({ status: 'failed', reason: 'fit_unavailable' });
      return { kind: 'failed', reason: 'fit_unavailable' };
    }
    fitBytes = await response.arrayBuffer();
  } catch (error) {
    console.error(`[SUUNTO] FIT download error for ${summary.workoutKey}:`, error);
    await save({ status: 'failed', reason: 'fit_unavailable' });
    return { kind: 'failed', reason: 'fit_unavailable' };
  }

  let fit: FitActivity;
  try {
    fit = parseFit(fitBytes);
  } catch (error) {
    console.error(`[SUUNTO] FIT parse error for ${summary.workoutKey}:`, error);
    await save({ status: 'failed', reason: 'fit_error' });
    return { kind: 'failed', reason: 'fit_error' };
  }

  const fitSportKnown = fit.sport !== null && fit.sport !== FIT_SPORT.generic;
  const onFoot = fitSportKnown
    ? isFootSport(fit.sport, fit.subSport)
    : summary.activityId !== null && FOOT_ACTIVITY_IDS.has(summary.activityId);
  const startMs = fit.startTime ?? summary.startTime;
  const lastPoint = fit.points.length > 0 ? fit.points[fit.points.length - 1] : null;
  const distance = fit.totalDistance ?? summary.totalDistance ?? lastPoint?.distance ?? 0;
  const endMs = fit.sessions.length > 0 ? fit.sessions[fit.sessions.length - 1].endTime : lastPoint?.time ?? null;
  const duration = Math.round(
    fit.totalTimerTime ?? summary.totalTime ?? (startMs !== null && endMs !== null ? (endMs - startMs) / 1000 : 0),
  );
  const label = fitSportKnown ? fitSportLabel(fit.sport, fit.subSport) : summary.activityId === 0 ? 'Caminata' : 'Carrera';
  const name = `${label} Suunto (${(distance / 1000).toFixed(2)}km)`;
  const activityType = fitSportKnown ? activityTypeName(fit.sport, fit.subSport) : 'running';
  const details = { name, activityType, distance, duration, startMs };

  console.log(`[SUUNTO] Workout ${summary.workoutKey}: sport ${fit.sport}/${fit.subSport} activityId ${summary.activityId} ${distance}m ${duration}s ${fit.points.length} GPS points`);

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

  const activity = await storage.createSuuntoActivity({
    workoutKey: summary.workoutKey,
    userId,
    routeId: null,
    name,
    activityType,
    suuntoActivityId: summary.activityId,
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

// ==================== Process (suunto_activities -> route) ====================

export interface ProcessOutcome {
  routeId: string | null;
  queued: boolean;
  /** The run already existed (e.g. imported from Strava or Apple Health): linked, no new route. */
  reused: boolean;
  skipReason: string | null;
}

/** Creates the route (feed event + territory queue) for a pending activity, like POST /api/polar/process. */
export async function processSuuntoActivity(env: Env, storage: WorkerStorage, activity: SuuntoActivity): Promise<ProcessOutcome> {
  const userId = activity.userId;
  const skip = async (reason: string): Promise<ProcessOutcome> => {
    await storage.updateSuuntoActivity(activity.id, { status: 'skipped', processed: true, processedAt: new Date().toISOString(), skipReason: reason });
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

  // Same run already on Runna.io (Strava / Polar / Apple Health / an earlier import): link it, don't duplicate
  let route: Route | null = activity.routeId ? await storage.getRouteById(activity.routeId) : null;
  const ownRoute = !!route;
  if (!route) {
    const similar = await storage.findSimilarRoute(userId, startedAt, activity.distance);
    if (similar) {
      await storage.updateSuuntoActivity(activity.id, { routeId: similar.id, status: 'imported', processed: true, processedAt: new Date().toISOString() });
      console.log(`[SUUNTO] Activity ${activity.id} matches existing route ${similar.id}: linked, not duplicated`);
      return { routeId: similar.id, queued: false, reused: true, skipReason: null };
    }
  }

  if (!route) {
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
  await storage.updateSuuntoActivity(activity.id, { routeId: route.id });

  if (coordinates.length < 10) {
    // Too short for territory: route + feed event only (like Polar)
    try {
      await generateFeedEvents(storage, userId, route.id, activity.distance, activity.duration, { newAreaConquered: 0, victims: [], ranTogetherWith: [] });
    } catch (error) {
      console.warn('[SUUNTO] Short route feed event failed:', error);
    }
    await storage.updateSuuntoActivity(activity.id, { routeId: route.id, status: 'imported', processed: true, processedAt: new Date().toISOString() });
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
    console.error('[SUUNTO] Early feed event failed:', error);
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
    console.error('[SUUNTO] Territory queue send failed:', error);
  }

  await storage.updateSuuntoActivity(activity.id, { routeId: route.id, status: 'imported', processed: true, processedAt: new Date().toISOString() });
  console.log(`[SUUNTO] Activity ${activity.id} -> route ${route.id}${ownRoute ? ' (existing)' : ''} (queued: ${queued})`);
  return { routeId: route.id, queued, reused: false, skipReason: null };
}

async function notifyImported(env: Env, storage: WorkerStorage, activity: SuuntoActivity, routeId: string): Promise<void> {
  try {
    const subscriptions = await storage.getPushSubscriptionsByUserId(activity.userId);
    if (subscriptions.length === 0) return;
    const distKm = (activity.distance / 1000).toFixed(1);
    await sendPushToUser(
      subscriptions.map((sub) => ({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } })),
      {
        title: '🏃 ¡Carrera registrada!',
        body: `${activity.name} · ${distKm} km — Entra para ver tu conquista`,
        tag: `suunto-auto-${activity.id}`,
        data: { type: 'suunto_auto_import', routeId, url: '/?showPendingAnimation=true' },
      },
      env.VAPID_PUBLIC_KEY || '',
      env.VAPID_PRIVATE_KEY || '',
      env.VAPID_SUBJECT || 'mailto:notifications@runna.io',
    );
  } catch (error) {
    console.warn(`[SUUNTO] Push notification failed for ${activity.userId}:`, error);
  }
}

/** Imports + processes workouts and notifies the user of each new route (webhook and cron path). */
async function importAndProcess(
  env: Env,
  storage: WorkerStorage,
  account: SuuntoAccount,
  accessToken: string,
  workouts: SuuntoWorkoutSummary[],
  maxFitDownloads: number,
): Promise<{ imported: number; routes: string[] }> {
  let downloads = 0;
  let imported = 0;
  for (const workout of workouts) {
    if (downloads >= maxFitDownloads) break;
    const existing = await storage.getSuuntoActivityByWorkoutKey(workout.workoutKey);
    if (existing && (!existing.skipReason || PERMANENT_SKIP_REASONS.has(existing.skipReason) || existing.userId !== account.userId)) continue;
    downloads++;
    const outcome = await importSuuntoWorkout(env, storage, account, accessToken, workout);
    if (outcome.kind === 'imported') imported++;
  }
  const routes: string[] = [];
  const pending = await storage.getUnprocessedSuuntoActivities(account.userId);
  for (const activity of pending.slice(0, 3)) {
    try {
      const result = await processSuuntoActivity(env, storage, activity);
      if (result.routeId && !result.reused) {
        routes.push(result.routeId);
        await notifyImported(env, storage, activity, result.routeId);
      }
    } catch (error) {
      console.error(`[SUUNTO] Processing activity ${activity.id} failed:`, error);
    }
  }
  return { imported, routes };
}

// ==================== Webhook ====================

function hexOf(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function base64Of(buffer: ArrayBuffer): string {
  let binary = '';
  for (const b of new Uint8Array(buffer)) binary += String.fromCharCode(b);
  return btoa(binary);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Checks an HMAC-SHA256 of the raw body (hex or base64, optional "sha256=" prefix). */
export async function verifySuuntoSignature(secret: string, rawBody: string, header: string): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const given = header.trim().replace(/^sha256=/i, '');
  return constantTimeEqual(given.toLowerCase(), hexOf(mac)) || constantTimeEqual(given, base64Of(mac));
}

const SIGNATURE_HEADERS = ['X-HMAC-SHA256-Signature', 'X-Hmac-Signature', 'X-Suunto-Signature', 'X-Signature'];

function stringField(source: Record<string, unknown> | null | undefined, names: string[]): string | null {
  if (!source) return null;
  for (const name of names) {
    const value = source[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

/** Username + workout key from any notification shape (JSON, nested workout, form body or query string). */
export function parseSuuntoNotification(rawBody: string, contentType: string, query: Record<string, string>): { username: string | null; workoutKey: string | null; type: string | null } {
  let body: Record<string, unknown> | null = null;
  const trimmed = rawBody.trim();
  if (trimmed.startsWith('{') || contentType.includes('json')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      body = null;
    }
  }
  if (!body && trimmed) {
    const form = new URLSearchParams(trimmed);
    const entries: Record<string, unknown> = {};
    form.forEach((value, key) => { entries[key] = value; });
    body = entries;
  }
  const nested = (name: string): Record<string, unknown> | null => {
    const value = body?.[name];
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  };
  const workout = nested('workout') ?? nested('payload') ?? nested('data');
  const userNames = ['username', 'userName', 'user', 'suuntoUsername'];
  const workoutNames = ['workoutid', 'workoutId', 'workoutKey', 'workoutkey', 'workout_id'];
  const username = stringField(body, userNames) ?? stringField(workout, userNames) ?? stringField(query, userNames);
  const workoutKey = stringField(body, workoutNames)
    ?? stringField(workout, [...workoutNames, 'key', 'id'])
    ?? stringField(query, workoutNames);
  const type = stringField(body, ['type', 'event', 'eventType']);
  return { username, workoutKey, type };
}

async function handleNotification(env: Env, username: string, workoutKey: string | null): Promise<void> {
  const storage = getStorage(env);
  const account = await storage.getSuuntoAccountByUsername(username);
  if (!account) {
    console.log(`[SUUNTO WEBHOOK] Unknown username "${username}": ignored`);
    return;
  }
  await storage.updateSuuntoAccount(account.userId, { lastWebhookAt: new Date().toISOString() });
  const accessToken = await getValidSuuntoToken(account, storage, env);
  if (!accessToken) {
    console.error(`[SUUNTO WEBHOOK] No valid token for user ${account.userId}`);
    return;
  }

  let workouts: SuuntoWorkoutSummary[];
  if (workoutKey) {
    workouts = [{ workoutKey, activityId: null, startTime: null, totalDistance: null, totalTime: null }];
  } else {
    // No workout in the notification: look at the last two days
    const list = await listWorkouts(env, accessToken, Date.now() - 2 * 24 * 3600 * 1000, 20);
    if (!list.ok) return;
    workouts = list.workouts;
  }
  const result = await importAndProcess(env, storage, account, accessToken, workouts, 3);
  console.log(`[SUUNTO WEBHOOK] User ${account.userId}: ${result.imported} imported, routes ${result.routes.join(', ') || 'none'}`);
}

// ==================== Routes ====================

export function registerSuuntoRoutes(app: Hono<AppEnv>): void {
  app.get('/api/suunto/status/:userId', requireSelf('userId'), async (c) => {
    try {
      const userId = c.req.param('userId');
      const configured = isSuuntoConfigured(c.env);
      const storage = getStorage(c.env);
      const account = await storage.getSuuntoAccountByUserId(userId);
      if (!account) return c.json({ configured, connected: false });
      const stats = await storage.getSuuntoActivityStats(userId);
      return c.json({
        configured,
        connected: true,
        suuntoUsername: account.suuntoUsername,
        connectedAt: account.connectedAt,
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

  app.get('/api/suunto/connect', requireAuth, async (c) => {
    try {
      const notSelf = rejectIfNotSelf(c, c.req.query('userId'));
      if (notSelf) return notSelf;
      const userId = c.get('authUserId');
      if (!isSuuntoConfigured(c.env) || !c.env.SUUNTO_CLIENT_SECRET) {
        return c.json({ error: 'Suunto not configured' }, 400);
      }
      const state = await createOAuthState(userId, c.env.SUUNTO_CLIENT_SECRET, { app: c.req.query('client') === 'ios' });
      const authUrl = `${SUUNTO_OAUTH_BASE}/authorize?response_type=code&client_id=${encodeURIComponent(c.env.SUUNTO_CLIENT_ID || '')}&redirect_uri=${encodeURIComponent(redirectUri(c.env))}&state=${encodeURIComponent(state)}`;
      return c.json({ authUrl, url: authUrl });
    } catch (error: any) {
      console.error('[SUUNTO] Connect error:', error);
      return c.json({ error: error.message }, 500);
    }
  });

  app.get('/api/suunto/callback', async (c) => {
    const state = c.req.query('state');
    const secret = c.env.SUUNTO_CLIENT_SECRET;
    const verified = state && secret ? await verifyOAuthState(state, secret) : null;
    const frontend = c.env.FRONTEND_URL || 'https://runna-io.pages.dev';
    const finish = (query: string) => oauthFinish(c, verified?.app === true, 'suunto', `${frontend}/profile?${query}`);
    try {
      const code = c.req.query('code');
      const authError = c.req.query('error');
      if (authError) return finish('suunto_error=denied');
      if (!code || !state || !isSuuntoConfigured(c.env)) return finish('suunto_error=invalid');
      if (!verified) return finish('suunto_error=invalid_state');
      const userId = verified.userId;

      const result = await requestToken(c.env, { grant_type: 'authorization_code', redirect_uri: redirectUri(c.env), code });
      if (!result.ok || !result.token?.access_token) {
        console.error(`[SUUNTO] Token exchange failed: ${result.status} ${result.text.slice(0, 300)}`);
        return finish('suunto_error=token_exchange');
      }
      const username = suuntoUsernameFromToken(result.token);
      if (!username) {
        console.error('[SUUNTO] Token without "user" claim');
        return finish('suunto_error=invalid_user');
      }

      const storage = getStorage(c.env);
      const linked = await storage.getSuuntoAccountByUsername(username);
      if (linked && linked.userId !== userId) return finish('suunto_error=already_linked');

      const data = {
        userId,
        suuntoUsername: username,
        accessToken: result.token.access_token,
        refreshToken: result.token.refresh_token ?? null,
        expiresAt: expiryFromToken(result.token),
        scope: result.token.scope ?? null,
      };
      const existing = await storage.getSuuntoAccountByUserId(userId);
      if (existing) {
        await storage.updateSuuntoAccount(userId, data);
      } else {
        await storage.createSuuntoAccount(data);
      }
      console.log(`[SUUNTO] User ${userId} connected Suunto account ${username}`);
      return finish('suunto_connected=true');
    } catch (error) {
      console.error('[SUUNTO] Callback error:', error);
      return finish('suunto_error=server');
    }
  });

  app.post('/api/suunto/disconnect', requireAuth, async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const notSelf = rejectIfNotSelf(c, (body as Record<string, unknown>).userId);
      if (notSelf) return notSelf;
      const userId = c.get('authUserId');
      const storage = getStorage(c.env);
      const account = await storage.getSuuntoAccountByUserId(userId);
      if (!account) return c.json({ error: 'Suunto account not connected' }, 404);
      // Suunto has no token revocation endpoint: forgetting the tokens ends our access
      await storage.deleteSuuntoAccount(userId);
      return c.json({ success: true });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.post('/api/suunto/webhook', async (c) => {
    try {
      const rawBody = await c.req.text();
      const secret = c.env.SUUNTO_WEBHOOK_SECRET;
      if (secret) {
        const signature = SIGNATURE_HEADERS.map((name) => c.req.header(name)).find((value): value is string => !!value);
        if (signature && !(await verifySuuntoSignature(secret, rawBody, signature))) {
          console.warn('[SUUNTO WEBHOOK] Invalid signature: rejected');
          return c.json({ error: 'invalid signature' }, 401);
        }
      }
      const { username, workoutKey, type } = parseSuuntoNotification(rawBody, c.req.header('Content-Type') || '', c.req.query());
      console.log(`[SUUNTO WEBHOOK] type=${type ?? '-'} username=${username ?? '-'} workout=${workoutKey ?? '-'}`);
      if (!username || !isSuuntoConfigured(c.env)) return c.json({ received: true });
      // Answer at once; the data is always fetched from the API (the payload is never trusted)
      await runInBackground(c, handleNotification(c.env, username, workoutKey));
      return c.json({ received: true });
    } catch (error) {
      console.error('[SUUNTO WEBHOOK] Error:', error);
      return c.json({ received: true });
    }
  });

  app.get('/api/suunto/activities/:userId', requireSelf('userId'), async (c) => {
    try {
      const storage = getStorage(c.env);
      return c.json(await storage.getSuuntoActivitiesByUserId(c.req.param('userId')));
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.post('/api/suunto/sync/:userId', requireSelfOrAdmin('userId'), async (c) => {
    const userId = c.req.param('userId');
    try {
      if (!isSuuntoConfigured(c.env)) return c.json({ error: 'Suunto not configured' }, 400);
      const storage = getStorage(c.env);
      const account = await storage.getSuuntoAccountByUserId(userId);
      if (!account) return c.json({ error: 'Suunto account not connected' }, 404);
      const accessToken = await getValidSuuntoToken(account, storage, c.env);
      if (!accessToken) {
        return c.json({ error: 'La conexión con Suunto ha caducado. Desconecta y vuelve a conectar Suunto.' }, 400);
      }

      const list = await listWorkouts(c.env, accessToken, Date.now() - SYNC_DAYS * 24 * 3600 * 1000);
      if (!list.ok) {
        return c.json({ error: `No se han podido leer tus entrenamientos de Suunto (${list.error}).` }, 502);
      }

      let imported = 0;
      let skipped = 0;
      let failed = 0;
      let downloads = 0;
      let hasMore = false;
      for (const workout of list.workouts) {
        const existing = await storage.getSuuntoActivityByWorkoutKey(workout.workoutKey);
        if (existing && (!existing.skipReason || PERMANENT_SKIP_REASONS.has(existing.skipReason) || existing.userId !== userId || existing.routeId)) {
          continue;
        }
        if (downloads >= FIT_FETCH_BUDGET) {
          hasMore = true;
          break;
        }
        downloads++;
        const outcome = await importSuuntoWorkout(c.env, storage, account, accessToken, workout);
        if (outcome.kind === 'imported') imported++;
        else if (outcome.kind === 'skipped') skipped++;
        else if (outcome.kind === 'failed') failed++;
      }
      await storage.updateSuuntoAccount(userId, { lastSyncAt: new Date().toISOString() });
      const message = imported > 0
        ? `${imported} ${imported === 1 ? 'actividad nueva' : 'actividades nuevas'} de Suunto`
        : 'No hay actividades nuevas en Suunto.';
      return c.json({ imported, skipped, failed, total: list.workouts.length, hasMore, message });
    } catch (error: any) {
      console.error('[SUUNTO] Sync error:', error);
      return c.json({ error: error.message }, 500);
    }
  });

  app.post('/api/suunto/process/:userId', requireSelf('userId'), async (c) => {
    try {
      const userId = c.req.param('userId');
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const requestedId = typeof body.activityId === 'string' ? body.activityId : null;
      const storage = getStorage(c.env);
      const pending = await storage.getUnprocessedSuuntoActivities(userId);
      if (pending.length === 0) return c.json({ processed: 0, results: [], remaining: 0, message: 'No activities to process' });

      const activity = requestedId ? pending.find((a) => a.id === requestedId) : pending[0];
      if (!activity) return c.json({ processed: 0, results: [], remaining: pending.length, message: 'Activity already processed or not found' });

      const outcome = await processSuuntoActivity(c.env, storage, activity);
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
      console.error('[SUUNTO] Process error:', error);
      return c.json({ error: error.message, processed: 0 }, 500);
    }
  });

  // Retry a skipped / failed workout: downloads it again (the app then calls /process)
  app.post('/api/suunto/retry/:activityId', requireAuth, async (c) => {
    try {
      const userId = c.get('authUserId');
      const storage = getStorage(c.env);
      const activity = await storage.getSuuntoActivityById(c.req.param('activityId'));
      if (!activity || activity.userId !== userId) return c.json({ error: 'Actividad no encontrada' }, 404);
      if (activity.routeId) return c.json({ success: true, status: 'imported' });

      if (activity.summaryPolyline) {
        await storage.updateSuuntoActivity(activity.id, { status: 'pending', processed: false, processedAt: null, skipReason: null });
        return c.json({ success: true, status: 'pending' });
      }
      const account = await storage.getSuuntoAccountByUserId(userId);
      if (!account || !isSuuntoConfigured(c.env)) return c.json({ error: 'Suunto account not connected' }, 404);
      const accessToken = await getValidSuuntoToken(account, storage, c.env);
      if (!accessToken) return c.json({ error: 'La conexión con Suunto ha caducado. Vuelve a conectar Suunto.' }, 400);
      const outcome = await importSuuntoWorkout(c.env, storage, account, accessToken, {
        workoutKey: activity.workoutKey,
        activityId: null,
        startTime: null,
        totalDistance: null,
        totalTime: null,
      }, { reevaluatePermanent: true });
      return c.json({ success: true, status: outcome.kind, reason: outcome.kind === 'skipped' || outcome.kind === 'failed' ? outcome.reason : null });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // Delete an imported workout's route (territory is recalculated); the workout stays as skipped
  app.delete('/api/suunto/activities/:userId/:activityId', requireSelf('userId'), async (c) => {
    try {
      const userId = c.req.param('userId');
      const storage = getStorage(c.env);
      const activity = await storage.getSuuntoActivityById(c.req.param('activityId'));
      if (!activity) return c.json({ error: 'Actividad no encontrada' }, 404);
      if (activity.userId !== userId) return c.json({ error: 'No autorizado' }, 403);

      const routeId = activity.routeId;
      if (routeId) {
        await storage.markSuuntoActivityDeletedByRouteId(routeId);
        await storage.detachTerritoriesFromRoute(routeId);
        await storage.deleteFeedEventsByRouteId(routeId);
        await storage.deleteConquestMetricsByRouteId(routeId);
        await storage.deletePolarActivityByRouteId(routeId);
        await storage.deleteStravaActivityByRouteId(routeId);
        await storage.deleteRouteById(routeId);
        try {
          await reprocessUserTerritories(storage, userId);
        } catch (error) {
          console.error('[SUUNTO] Territory rebuild after delete failed:', error);
        }
      } else {
        await storage.deleteSuuntoActivityById(activity.id);
      }
      return c.json({ success: true });
    } catch (error: any) {
      console.error('[SUUNTO] Delete error:', error);
      return c.json({ error: error.message }, 500);
    }
  });

  // Cron (hourly): fallback poll for accounts whose webhook may have been missed
  app.post('/api/tasks/suunto-auto-sync', async (c) => {
    try {
      if (!(await isCronRequest(c))) return c.json({ error: 'Unauthorized' }, 401);
      if (!isSuuntoConfigured(c.env)) return c.json({ success: true, message: 'Suunto not configured', synced: 0 });
      const started = Date.now();
      const storage = getStorage(c.env);
      const staleBefore = new Date(Date.now() - 55 * 60 * 1000).toISOString();
      const accounts = await storage.getSuuntoAccountsToPoll(staleBefore, 5);
      let synced = 0;
      let imported = 0;
      let routes = 0;
      for (const account of accounts) {
        if (Date.now() - started > 20000) break;
        try {
          const accessToken = await getValidSuuntoToken(account, storage, c.env);
          await storage.updateSuuntoAccount(account.userId, { lastSyncAt: new Date().toISOString() });
          if (!accessToken) continue;
          const lastSync = account.lastSyncAt ? new Date(account.lastSyncAt).getTime() : NaN;
          const since = Number.isFinite(lastSync)
            ? Math.max(lastSync - 2 * 24 * 3600 * 1000, Date.now() - SYNC_DAYS * 24 * 3600 * 1000)
            : Date.now() - 3 * 24 * 3600 * 1000;
          const list = await listWorkouts(c.env, accessToken, since, 20);
          if (!list.ok) continue;
          const result = await importAndProcess(c.env, storage, account, accessToken, list.workouts, 3);
          synced++;
          imported += result.imported;
          routes += result.routes.length;
        } catch (error) {
          console.error(`[SUUNTO AUTO-SYNC] User ${account.userId} failed:`, error);
        }
      }
      return c.json({ success: true, accounts: accounts.length, synced, imported, routes, elapsed: Date.now() - started });
    } catch (error: any) {
      console.error('[SUUNTO AUTO-SYNC] Error:', error);
      return c.json({ error: error.message }, 500);
    }
  });
}
