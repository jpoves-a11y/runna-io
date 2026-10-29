// Garmin Connect Developer Program integration (Activity API, https://developerportal.garmin.com).
//
// Flow (mirrors Suunto's endpoints so the iOS app treats every provider alike):
//   GET  /api/garmin/connect            -> { authUrl } (Garmin OAuth2 PKCE consent page; ?client=ios for the app flow)
//   GET  /api/garmin/callback           <- Garmin redirect: exchanges the code, stores tokens + Garmin API user ID
//   POST /api/garmin/webhook            <- Activity API notifications: "activityDetails" push (summary + GPS samples)
//                                          or ping (callbackURL to pull them), "deregistrations", "userPermissionsChange"
//   POST /api/garmin/sync/:userId       -> nothing to pull (Starter access is push only, without history): reports status
//   POST /api/garmin/process/:userId    -> turns one pending activity into a route (territory via the queue)
//   GET  /api/garmin/status/:userId, GET /api/garmin/activities/:userId, POST /api/garmin/retry/:activityId,
//   DELETE /api/garmin/activities/:userId/:activityId, POST /api/garmin/disconnect
//
// Secrets: GARMIN_CLIENT_ID, GARMIN_CLIENT_SECRET (consumer key / secret of the app in the developer portal),
// optional GARMIN_WEBHOOK_SECRET: Garmin doesn't sign notifications, so when set the endpoint URL configured in
// the portal must carry it as ?key=<secret> (anything else is rejected).
import type { Context, Hono } from 'hono';
import {
  type AppEnv,
  requireAuth,
  requireSelf,
  rejectIfNotSelf,
  createOAuthState,
  verifyOAuthState,
  oauthFinish,
} from './auth';
import { createDb } from './db';
import { WorkerStorage } from './storage';
import type { Env } from './index';
import type { GarminAccount, GarminActivity, Route } from '../../shared/schema';
import { fitTrack, type FitPoint } from './fit';
import { BEFORE_CONNECTION, startedBeforeConnection } from './importCutoff';
import { encodePolyline, decodePolyline } from './territory';
import { generateFeedEvents, reprocessUserTerritories } from './routes';

type AppContext = Context<AppEnv>;

const GARMIN_AUTHORIZE_URL = 'https://connect.garmin.com/oauth2Confirm';
const GARMIN_TOKEN_URL = 'https://connectapi.garmin.com/di-oauth2-service/oauth/token';
const GARMIN_API_BASE = 'https://apis.garmin.com/wellness-api/rest';
/** Ping notifications are only followed to this host (the URL comes from the request body). */
const GARMIN_API_HOST = 'apis.garmin.com';
const DEFAULT_WORKER_URL = 'https://runna-io-api.runna-io-api.workers.dev';

/** Same competition start as the Polar / Strava / Suunto imports. */
const COMPETITION_MIN_DATE = new Date('2026-03-02T00:00:00Z');
/** Garmin recommends refreshing at least 600 s before the access token expires. */
const TOKEN_REFRESH_MARGIN_MS = 10 * 60 * 1000;
/** Minimum spacing between stored GPS points (Garmin samples every second). */
const TRACK_MIN_SPACING_M = 5;
/** Routes created per notification (the rest stay pending for the app's /process loop). */
const MAX_ROUTES_PER_NOTIFICATION = 3;

/** Skip reasons a repeated notification must not re-evaluate (the app's "Reintentar" still can). */
const PERMANENT_SKIP_REASONS = new Set(['before_competition', BEFORE_CONNECTION, 'excluded_type', 'distance_too_short', 'duration_too_short', 'deleted_by_user']);

/** Skip reasons from the competition rules, which "Reintentar" re-applies. */
const RULE_SKIP_REASONS = new Set(['before_competition', BEFORE_CONNECTION, 'excluded_type', 'distance_too_short', 'duration_too_short']);

function getStorage(env: Env): WorkerStorage {
  return new WorkerStorage(createDb(env.DATABASE_URL, env.TURSO_AUTH_TOKEN));
}

// Secrets pasted in the Cloudflare dashboard often carry a trailing space or newline: Garmin then
// doesn't recognise the client ("We could not give this application the permissions you requested").
function clientId(env: Env): string {
  return (env.GARMIN_CLIENT_ID || '').trim();
}

function clientSecret(env: Env): string {
  return (env.GARMIN_CLIENT_SECRET || '').trim();
}

function webhookSecret(env: Env): string {
  return (env.GARMIN_WEBHOOK_SECRET || '').trim();
}

/** Garmin client IDs are UUIDs (e.g. 600a2456-ab5f-4b1f-8eb3-8cc8dc86264d). */
export function isGarminClientIdFormatOk(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function isGarminConfigured(env: Env): boolean {
  return !!(clientId(env) && clientSecret(env));
}

function redirectUri(env: Env): string {
  return `${env.WORKER_URL || DEFAULT_WORKER_URL}/api/garmin/callback`;
}

/** Runs `task` after the response when the runtime allows it (Workers), else awaits it. */
async function runInBackground(c: AppContext, task: Promise<unknown>): Promise<void> {
  const safe = task.catch((error) => console.error('[GARMIN] Background task failed:', error));
  let ctx: { waitUntil(promise: Promise<unknown>): void } | null = null;
  try {
    ctx = c.executionCtx;
  } catch {
    ctx = null;
  }
  if (ctx) ctx.waitUntil(safe);
  else await safe;
}

// ==================== PKCE ====================

function base64Url(bytes: ArrayBuffer): string {
  let binary = '';
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * PKCE code_verifier for an OAuth state: an HMAC of the (signed, single-use) state with the client secret,
 * so the callback can rebuild it without storing anything and it never travels in a URL. 43 characters.
 */
export async function pkceVerifier(secret: string, state: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64Url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`garmin-pkce:${state}`)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return base64Url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
}

// ==================== Tokens ====================

interface GarminTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  scope?: string;
}

async function requestToken(env: Env, params: Record<string, string>): Promise<{ ok: boolean; status: number; token: GarminTokenResponse | null; text: string }> {
  const response = await fetch(GARMIN_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: new URLSearchParams({
      ...params,
      client_id: clientId(env),
      client_secret: clientSecret(env),
    }).toString(),
  });
  const text = await response.text();
  let token: GarminTokenResponse | null = null;
  try {
    token = JSON.parse(text) as GarminTokenResponse;
  } catch {
    token = null;
  }
  return { ok: response.ok, status: response.status, token, text };
}

function expiryFromToken(token: GarminTokenResponse): string {
  const seconds = typeof token.expires_in === 'number' && token.expires_in > 0 ? token.expires_in : 86400;
  return new Date(Date.now() + seconds * 1000).toISOString();
}

/** A usable access token for the account, refreshed (and saved) when it is about to expire. Null if Garmin refused. */
export async function getValidGarminToken(account: GarminAccount, storage: WorkerStorage, env: Env): Promise<string | null> {
  const expiresAt = account.expiresAt ? new Date(account.expiresAt).getTime() : NaN;
  if (Number.isFinite(expiresAt) && expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) return account.accessToken;
  if (!account.refreshToken) return Number.isFinite(expiresAt) ? null : account.accessToken;
  try {
    const result = await requestToken(env, { grant_type: 'refresh_token', refresh_token: account.refreshToken });
    if (!result.ok || !result.token?.access_token) {
      console.error(`[GARMIN] Token refresh failed for user ${account.userId}: ${result.status} ${result.text.slice(0, 200)}`);
      return null;
    }
    // Garmin returns a new refresh token every time
    const updated = {
      accessToken: result.token.access_token,
      refreshToken: result.token.refresh_token || account.refreshToken,
      expiresAt: expiryFromToken(result.token),
    };
    await storage.updateGarminAccount(account.userId, updated);
    account.accessToken = updated.accessToken;
    account.refreshToken = updated.refreshToken;
    account.expiresAt = updated.expiresAt;
    return updated.accessToken;
  } catch (error) {
    console.error('[GARMIN] Token refresh error:', error);
    return null;
  }
}

async function apiGet(accessToken: string, url: string): Promise<{ ok: boolean; status: number; body: unknown; text: string }> {
  const response = await fetch(url, { headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' } });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { ok: response.ok, status: response.status, body, text };
}

/** Permissions the user granted (e.g. ["ACTIVITY_EXPORT"]), or null if Garmin didn't answer. */
async function fetchPermissions(accessToken: string): Promise<string[] | null> {
  try {
    const result = await apiGet(accessToken, `${GARMIN_API_BASE}/user/permissions`);
    if (!result.ok) return null;
    const list = Array.isArray(result.body)
      ? result.body
      : result.body && typeof result.body === 'object' && Array.isArray((result.body as Record<string, unknown>).permissions)
        ? (result.body as Record<string, unknown>).permissions as unknown[]
        : null;
    return list ? list.filter((p): p is string => typeof p === 'string') : null;
  } catch {
    return null;
  }
}

/**
 * Garmin requires this call whenever the user disconnects or deletes their account on our side
 * (outside Garmin Connect's own consent screen). Best effort: our copy of the data is deleted anyway.
 */
export async function deleteGarminRegistration(env: Env, storage: WorkerStorage, account: GarminAccount): Promise<boolean> {
  try {
    const accessToken = await getValidGarminToken(account, storage, env);
    if (!accessToken) return false;
    const response = await fetch(`${GARMIN_API_BASE}/user/registration`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    if (!response.ok && response.status !== 404) {
      console.error(`[GARMIN] Delete registration failed for user ${account.userId}: ${response.status}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error('[GARMIN] Delete registration error:', error);
    return false;
  }
}

// ==================== Activity Details ====================

export interface GarminActivityDetail {
  garminUserId: string;
  summaryId: string;
  activityId: string | null;
  /** Garmin activityType, e.g. "RUNNING", "TRAIL_RUNNING", "WALKING" */
  activityType: string;
  deviceName: string | null;
  manual: boolean;
  /** ms since the Unix epoch */
  startTime: number | null;
  /** seconds */
  duration: number | null;
  /** metres */
  distance: number | null;
  points: FitPoint[];
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

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** One "activityDetails" item (push body or pull response). Null when it has no user or summary ID. */
export function parseActivityDetail(raw: unknown): GarminActivityDetail | null {
  const item = asObject(raw);
  if (!item) return null;
  // The summary fields come nested under "summary"; activity summaries (no samples) have them at the top level
  const summary = asObject(item.summary) ?? item;
  const garminUserId = toId(item.userId);
  const summaryId = toId(item.summaryId) ?? toId(summary.summaryId);
  if (!garminUserId || !summaryId) return null;

  const points: FitPoint[] = [];
  if (Array.isArray(item.samples)) {
    for (const rawSample of item.samples) {
      const sample = asObject(rawSample);
      if (!sample) continue;
      const lat = toNumber(sample.latitudeInDegree);
      const lng = toNumber(sample.longitudeInDegree);
      if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) continue;
      const seconds = toNumber(sample.startTimeInSeconds);
      points.push({ lat, lng, time: seconds !== null ? seconds * 1000 : null, distance: toNumber(sample.totalDistanceInMeters) });
    }
  }

  const startSeconds = toNumber(summary.startTimeInSeconds);
  return {
    garminUserId,
    summaryId,
    activityId: toId(item.activityId) ?? toId(summary.activityId),
    activityType: (typeof summary.activityType === 'string' ? summary.activityType : 'UNKNOWN').toUpperCase(),
    deviceName: typeof summary.deviceName === 'string' && summary.deviceName.trim() ? summary.deviceName.trim() : null,
    manual: summary.manual === true || item.manual === true,
    startTime: startSeconds !== null ? startSeconds * 1000 : points[0]?.time ?? null,
    duration: toNumber(summary.durationInSeconds),
    distance: toNumber(summary.distanceInMeters),
    points,
  };
}

/** Running, walking and hiking outdoors (Runna.io's import filter). */
export function isGarminFootActivity(activityType: string): boolean {
  if (/TREADMILL|INDOOR|VIRTUAL/.test(activityType)) return false;
  return /RUN|WALK|HIK/.test(activityType);
}

function activityLabel(activityType: string): string {
  if (activityType.includes('TRAIL')) return 'Trail';
  if (activityType.includes('TRACK')) return 'Carrera en pista';
  if (activityType.includes('RUN')) return 'Carrera';
  if (activityType.includes('WALK')) return 'Caminata';
  if (activityType.includes('HIK')) return 'Senderismo';
  return 'Actividad';
}

// ==================== Import (activity details -> garmin_activities) ====================

export type ImportOutcome =
  | { kind: 'imported'; activity: GarminActivity }
  | { kind: 'skipped'; reason: string }
  | { kind: 'exists' };

/** Stores one activity as a pending garmin_activities row (or as skipped with the reason). */
export async function importGarminActivity(storage: WorkerStorage, account: GarminAccount, detail: GarminActivityDetail): Promise<ImportOutcome> {
  const userId = account.userId;
  const existing = await storage.getGarminActivityBySummaryId(detail.summaryId);
  if (existing) {
    if (existing.userId !== userId || existing.routeId) return { kind: 'exists' };
    if (!existing.skipReason) return { kind: 'exists' };
    if (PERMANENT_SKIP_REASONS.has(existing.skipReason)) return { kind: 'exists' };
    // e.g. no_gps: Garmin sends the activity again once it has the full details
    await storage.deleteGarminActivityById(existing.id);
  }

  const lastPoint = detail.points.length > 0 ? detail.points[detail.points.length - 1] : null;
  const startMs = detail.startTime;
  const distance = detail.distance ?? lastPoint?.distance ?? 0;
  const duration = Math.round(
    detail.duration ?? (startMs !== null && lastPoint?.time != null ? (lastPoint.time - startMs) / 1000 : 0),
  );
  const name = `${activityLabel(detail.activityType)} Garmin (${(distance / 1000).toFixed(2)}km)`;
  const track = fitTrack(detail.points, TRACK_MIN_SPACING_M);
  const base = {
    summaryId: detail.summaryId,
    userId,
    routeId: null,
    garminActivityId: detail.activityId,
    name,
    activityType: detail.activityType,
    deviceName: detail.deviceName,
    distance,
    duration,
    startDate: new Date(startMs ?? Date.now()).toISOString(),
    // Kept on skipped rows too, so "Reintentar" can still create the route
    summaryPolyline: track.length >= 2 ? encodePolyline(track) : null,
  };
  const skip = async (reason: string): Promise<ImportOutcome> => {
    await storage.createGarminActivity({ ...base, status: 'skipped', processed: true, processedAt: new Date().toISOString(), skipReason: reason });
    return { kind: 'skipped', reason };
  };

  console.log(`[GARMIN] Activity ${detail.summaryId}: ${detail.activityType} ${distance}m ${duration}s ${detail.points.length} GPS points (${detail.deviceName ?? 'unknown device'})`);

  if (!isGarminFootActivity(detail.activityType)) return skip('excluded_type');
  if (startMs === null || !Number.isFinite(startMs)) return skip('bad_date');
  if (startMs < COMPETITION_MIN_DATE.getTime()) return skip('before_competition');
  if (startedBeforeConnection(startMs, account.connectedAt)) return skip(BEFORE_CONNECTION);
  if (distance < 100) return skip('distance_too_short');
  if (duration < 60) return skip('duration_too_short');
  if (track.length < 2) return skip('no_gps');

  const activity = await storage.createGarminActivity({ ...base, status: 'pending', processed: false, processedAt: null, skipReason: null });
  return { kind: 'imported', activity };
}

// ==================== Process (garmin_activities -> route) ====================

export interface ProcessOutcome {
  routeId: string | null;
  queued: boolean;
  /** The run already existed (e.g. imported from Strava or Apple Health): linked, no new route. */
  reused: boolean;
  skipReason: string | null;
}

/** Creates the route (feed event + territory queue) for a pending activity, like the Suunto import. */
export async function processGarminActivity(env: Env, storage: WorkerStorage, activity: GarminActivity): Promise<ProcessOutcome> {
  const userId = activity.userId;
  const skip = async (reason: string): Promise<ProcessOutcome> => {
    await storage.updateGarminActivity(activity.id, { status: 'skipped', processed: true, processedAt: new Date().toISOString(), skipReason: reason });
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

  // Same run already on Runna.io (Strava / Polar / Suunto / Apple Health): link it, don't duplicate
  let route: Route | null = activity.routeId ? await storage.getRouteById(activity.routeId) : null;
  if (!route) {
    const similar = await storage.findSimilarRoute(userId, startedAt, activity.distance);
    if (similar) {
      await storage.updateGarminActivity(activity.id, { routeId: similar.id, status: 'imported', processed: true, processedAt: new Date().toISOString() });
      console.log(`[GARMIN] Activity ${activity.id} matches existing route ${similar.id}: linked, not duplicated`);
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
  await storage.updateGarminActivity(activity.id, { routeId: route.id });

  if (coordinates.length < 10) {
    // Too short for territory: route + feed event only
    try {
      await generateFeedEvents(storage, userId, route.id, activity.distance, activity.duration, { newAreaConquered: 0, victims: [], ranTogetherWith: [] });
    } catch (error) {
      console.warn('[GARMIN] Short route feed event failed:', error);
    }
    await storage.updateGarminActivity(activity.id, { status: 'imported', processed: true, processedAt: new Date().toISOString() });
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
    console.error('[GARMIN] Early feed event failed:', error);
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
      // The owner is told what the run conquered once the territory is processed
      importSource: 'garmin',
    });
    queued = true;
  } catch (error) {
    console.error('[GARMIN] Territory queue send failed:', error);
  }

  await storage.updateGarminActivity(activity.id, { status: 'imported', processed: true, processedAt: new Date().toISOString() });
  console.log(`[GARMIN] Activity ${activity.id} -> route ${route.id} (queued: ${queued})`);
  return { routeId: route.id, queued, reused: false, skipReason: null };
}

/** Only when the territory couldn't be queued: otherwise the queue says what the run conquered. */
async function notifyImported(env: Env, storage: WorkerStorage, activity: GarminActivity, routeId: string): Promise<void> {
  const { notifyImportedRunPending } = await import('./notifications');
  await notifyImportedRunPending(storage, env, { userId: activity.userId, routeId, source: 'garmin', distance: activity.distance });
}

// ==================== Webhook ====================

export interface GarminNotification {
  /** Push items (with the data) */
  details: GarminActivityDetail[];
  /** Ping items: the data is pulled from callbackURL with the user's token */
  pings: Array<{ garminUserId: string; callbackURL: string }>;
  deregistrations: string[];
  permissionChanges: Array<{ garminUserId: string; permissions: string[] }>;
}

/** Everything Runna.io uses from a notification body; other summary types are ignored. */
export function parseGarminNotification(body: unknown): GarminNotification {
  const result: GarminNotification = { details: [], pings: [], deregistrations: [], permissionChanges: [] };
  const obj = asObject(body);
  if (!obj) return result;
  const list = (key: string): unknown[] => (Array.isArray(obj[key]) ? (obj[key] as unknown[]) : []);

  for (const raw of list('activityDetails')) {
    const item = asObject(raw);
    const garminUserId = toId(item?.userId);
    if (!item || !garminUserId) continue;
    if (typeof item.callbackURL === 'string') {
      result.pings.push({ garminUserId, callbackURL: item.callbackURL });
      continue;
    }
    const detail = parseActivityDetail(item);
    if (detail) result.details.push(detail);
  }
  for (const raw of list('deregistrations')) {
    const garminUserId = toId(asObject(raw)?.userId);
    if (garminUserId) result.deregistrations.push(garminUserId);
  }
  for (const raw of list('userPermissionsChange')) {
    const item = asObject(raw);
    const garminUserId = toId(item?.userId);
    if (!item || !garminUserId) continue;
    const permissions = Array.isArray(item.permissions) ? item.permissions.filter((p): p is string => typeof p === 'string') : [];
    result.permissionChanges.push({ garminUserId, permissions });
  }
  return result;
}

/** Only https://apis.garmin.com/... callback URLs are followed (they carry the user's bearer token). */
export function isGarminCallbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.host === GARMIN_API_HOST;
  } catch {
    return false;
  }
}

async function pullPing(env: Env, storage: WorkerStorage, account: GarminAccount, callbackURL: string): Promise<GarminActivityDetail[]> {
  if (!isGarminCallbackUrl(callbackURL)) {
    console.warn(`[GARMIN WEBHOOK] Ignored callback URL outside ${GARMIN_API_HOST}`);
    return [];
  }
  const accessToken = await getValidGarminToken(account, storage, env);
  if (!accessToken) {
    console.error(`[GARMIN WEBHOOK] No valid token for user ${account.userId}`);
    return [];
  }
  const result = await apiGet(accessToken, callbackURL);
  if (!result.ok || !Array.isArray(result.body)) {
    console.error(`[GARMIN WEBHOOK] Pull failed: ${result.status} ${result.text.slice(0, 200)}`);
    return [];
  }
  return result.body.map(parseActivityDetail).filter((d): d is GarminActivityDetail => d !== null);
}

async function handleNotification(env: Env, notification: GarminNotification): Promise<void> {
  const storage = getStorage(env);

  for (const garminUserId of notification.deregistrations) {
    // The user removed Runna.io in Garmin Connect: forget the tokens (routes and territory stay)
    const account = await storage.getGarminAccountByGarminUserId(garminUserId);
    if (!account) continue;
    await storage.deleteGarminAccount(account.userId);
    console.log(`[GARMIN WEBHOOK] User ${account.userId} deregistered in Garmin Connect`);
  }
  for (const change of notification.permissionChanges) {
    const account = await storage.getGarminAccountByGarminUserId(change.garminUserId);
    if (!account) continue;
    await storage.updateGarminAccount(account.userId, { permissions: JSON.stringify(change.permissions) });
    console.log(`[GARMIN WEBHOOK] User ${account.userId} permissions: ${change.permissions.join(', ') || 'none'}`);
  }

  // Group the activities by user (one notification can carry several users)
  const byUser = new Map<string, { account: GarminAccount; details: GarminActivityDetail[] }>();
  const accountFor = async (garminUserId: string) => {
    const known = byUser.get(garminUserId);
    if (known) return known;
    const account = await storage.getGarminAccountByGarminUserId(garminUserId);
    if (!account) {
      console.log(`[GARMIN WEBHOOK] Unknown Garmin user "${garminUserId}": ignored`);
      return null;
    }
    const entry = { account, details: [] as GarminActivityDetail[] };
    byUser.set(garminUserId, entry);
    return entry;
  };
  for (const detail of notification.details) {
    (await accountFor(detail.garminUserId))?.details.push(detail);
  }
  for (const ping of notification.pings) {
    const entry = await accountFor(ping.garminUserId);
    if (!entry) continue;
    // A pulled item must belong to the user the ping was for
    const pulled = await pullPing(env, storage, entry.account, ping.callbackURL);
    entry.details.push(...pulled.filter((d) => d.garminUserId === ping.garminUserId));
  }

  for (const { account, details } of byUser.values()) {
    await storage.updateGarminAccount(account.userId, { lastWebhookAt: new Date().toISOString() });
    // Oldest first, so territory is conquered in the order it was run
    details.sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0));
    let imported = 0;
    for (const detail of details) {
      const outcome = await importGarminActivity(storage, account, detail);
      if (outcome.kind === 'imported') imported++;
    }
    const routes: string[] = [];
    const pending = await storage.getUnprocessedGarminActivities(account.userId);
    for (const activity of pending.slice(0, MAX_ROUTES_PER_NOTIFICATION)) {
      try {
        const result = await processGarminActivity(env, storage, activity);
        if (result.routeId && !result.reused) {
          routes.push(result.routeId);
          if (!result.queued) await notifyImported(env, storage, activity, result.routeId);
        }
      } catch (error) {
        console.error(`[GARMIN] Processing activity ${activity.id} failed:`, error);
      }
    }
    console.log(`[GARMIN WEBHOOK] User ${account.userId}: ${imported} imported, routes ${routes.join(', ') || 'none'}`);
  }
}

// ==================== Routes ====================

export function registerGarminRoutes(app: Hono<AppEnv>): void {
  app.get('/api/garmin/status/:userId', requireSelf('userId'), async (c) => {
    try {
      const userId = c.req.param('userId');
      const configured = isGarminConfigured(c.env);
      const storage = getStorage(c.env);
      const account = await storage.getGarminAccountByUserId(userId);
      // Lets the app / support see a malformed GARMIN_CLIENT_ID without revealing it
      const clientIdFormatOk = isGarminClientIdFormatOk(clientId(c.env));
      if (!account) return c.json({ configured, clientIdFormatOk, connected: false });
      const stats = await storage.getGarminActivityStats(userId);
      let permissions: string[] | null = null;
      try {
        permissions = account.permissions ? (JSON.parse(account.permissions) as string[]) : null;
      } catch {
        permissions = null;
      }
      return c.json({
        configured,
        clientIdFormatOk,
        connected: true,
        connectedAt: account.connectedAt,
        lastSyncAt: account.lastSyncAt,
        lastWebhookAt: account.lastWebhookAt,
        // False when the user unticked "Activities" on Garmin's consent screen: nothing will arrive
        activityExport: permissions === null || permissions.includes('ACTIVITY_EXPORT'),
        totalActivities: stats.total,
        pendingActivities: stats.pending,
        failedActivities: stats.failed,
      });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.get('/api/garmin/connect', requireAuth, async (c) => {
    try {
      const notSelf = rejectIfNotSelf(c, c.req.query('userId'));
      if (notSelf) return notSelf;
      const userId = c.get('authUserId');
      if (!isGarminConfigured(c.env)) {
        return c.json({ error: 'Garmin not configured' }, 400);
      }
      const secret = clientSecret(c.env);
      if (!isGarminClientIdFormatOk(clientId(c.env))) {
        console.warn(`[GARMIN] GARMIN_CLIENT_ID is not a UUID (${clientId(c.env).length} chars): check the secret in Cloudflare`);
      }
      const state = await createOAuthState(userId, secret, { app: c.req.query('client') === 'ios' });
      const challenge = await pkceChallenge(await pkceVerifier(secret, state));
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId(c.env),
        code_challenge: challenge,
        code_challenge_method: 'S256',
        redirect_uri: redirectUri(c.env),
        state,
      });
      const authUrl = `${GARMIN_AUTHORIZE_URL}?${params.toString()}`;
      return c.json({ authUrl, url: authUrl });
    } catch (error: any) {
      console.error('[GARMIN] Connect error:', error);
      return c.json({ error: error.message }, 500);
    }
  });

  app.get('/api/garmin/callback', async (c) => {
    const state = c.req.query('state');
    const secret = clientSecret(c.env);
    const verified = state && secret ? await verifyOAuthState(state, secret) : null;
    const frontend = c.env.FRONTEND_URL || 'https://runna-io.pages.dev';
    const finish = (query: string) => oauthFinish(c, verified?.app === true, 'garmin', `${frontend}/profile?${query}`);
    try {
      const code = c.req.query('code');
      if (c.req.query('error')) return finish('garmin_error=denied');
      if (!code || !state || !secret || !isGarminConfigured(c.env)) return finish('garmin_error=invalid');
      if (!verified) return finish('garmin_error=invalid_state');
      const userId = verified.userId;

      const result = await requestToken(c.env, {
        grant_type: 'authorization_code',
        code,
        code_verifier: await pkceVerifier(secret, state),
        redirect_uri: redirectUri(c.env),
      });
      if (!result.ok || !result.token?.access_token) {
        console.error(`[GARMIN] Token exchange failed: ${result.status} ${result.text.slice(0, 300)}`);
        return finish('garmin_error=token_exchange');
      }
      const accessToken = result.token.access_token;

      const idResult = await apiGet(accessToken, `${GARMIN_API_BASE}/user/id`);
      const garminUserId = toId(asObject(idResult.body)?.userId);
      if (!idResult.ok || !garminUserId) {
        console.error(`[GARMIN] User ID request failed: ${idResult.status} ${idResult.text.slice(0, 200)}`);
        return finish('garmin_error=invalid_user');
      }

      const storage = getStorage(c.env);
      const linked = await storage.getGarminAccountByGarminUserId(garminUserId);
      if (linked && linked.userId !== userId) return finish('garmin_error=already_linked');

      const permissions = await fetchPermissions(accessToken);
      const data = {
        userId,
        garminUserId,
        accessToken,
        refreshToken: result.token.refresh_token ?? null,
        expiresAt: expiryFromToken(result.token),
        permissions: permissions ? JSON.stringify(permissions) : null,
      };
      const existing = await storage.getGarminAccountByUserId(userId);
      if (existing) {
        await storage.updateGarminAccount(userId, data);
      } else {
        await storage.createGarminAccount(data);
      }
      console.log(`[GARMIN] User ${userId} connected Garmin user ${garminUserId} (permissions: ${permissions?.join(', ') ?? 'unknown'})`);
      if (permissions && !permissions.includes('ACTIVITY_EXPORT')) return finish('garmin_error=no_activity_permission');
      return finish('garmin_connected=true');
    } catch (error) {
      console.error('[GARMIN] Callback error:', error);
      return finish('garmin_error=server');
    }
  });

  app.post('/api/garmin/disconnect', requireAuth, async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const notSelf = rejectIfNotSelf(c, (body as Record<string, unknown>).userId);
      if (notSelf) return notSelf;
      const userId = c.get('authUserId');
      const storage = getStorage(c.env);
      const account = await storage.getGarminAccountByUserId(userId);
      if (!account) return c.json({ error: 'Garmin account not connected' }, 404);
      await deleteGarminRegistration(c.env, storage, account);
      await storage.deleteGarminAccount(userId);
      return c.json({ success: true });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.post('/api/garmin/webhook', async (c) => {
    try {
      const secret = webhookSecret(c.env);
      if (secret && c.req.query('key') !== secret) {
        console.warn('[GARMIN WEBHOOK] Missing or wrong ?key: rejected');
        return c.json({ error: 'unauthorized' }, 401);
      }
      let body: unknown = null;
      try {
        body = await c.req.json();
      } catch {
        body = null;
      }
      const notification = parseGarminNotification(body);
      const keys = body && typeof body === 'object' ? Object.keys(body as object).join(',') : '-';
      console.log(`[GARMIN WEBHOOK] keys=${keys} details=${notification.details.length} pings=${notification.pings.length} deregistrations=${notification.deregistrations.length}`);
      if (!isGarminConfigured(c.env)) return c.json({ received: true });
      // Garmin expects a quick 200 (it retries otherwise): the work runs after the response
      await runInBackground(c, handleNotification(c.env, notification));
      return c.json({ received: true });
    } catch (error) {
      console.error('[GARMIN WEBHOOK] Error:', error);
      return c.json({ received: true });
    }
  });

  app.get('/api/garmin/activities/:userId', requireSelf('userId'), async (c) => {
    try {
      const storage = getStorage(c.env);
      return c.json(await storage.getGarminActivitiesByUserId(c.req.param('userId')));
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // Garmin sends every activity by itself after the watch syncs with Garmin Connect, and Starter access
  // has no history to pull: "Sincronizar ahora" only processes what is already waiting.
  app.post('/api/garmin/sync/:userId', requireSelf('userId'), async (c) => {
    try {
      const userId = c.req.param('userId');
      if (!isGarminConfigured(c.env)) return c.json({ error: 'Garmin not configured' }, 400);
      const storage = getStorage(c.env);
      const account = await storage.getGarminAccountByUserId(userId);
      if (!account) return c.json({ error: 'Garmin account not connected' }, 404);
      await storage.updateGarminAccount(userId, { lastSyncAt: new Date().toISOString() });
      const pending = (await storage.getUnprocessedGarminActivities(userId)).length;
      const message = pending > 0
        ? `${pending} ${pending === 1 ? 'actividad pendiente' : 'actividades pendientes'} de Garmin`
        : 'Tus carreras nuevas llegan solas unos minutos después de sincronizar el reloj con Garmin Connect.';
      return c.json({ imported: 0, skipped: 0, failed: 0, total: pending, hasMore: false, message });
    } catch (error: any) {
      console.error('[GARMIN] Sync error:', error);
      return c.json({ error: error.message }, 500);
    }
  });

  app.post('/api/garmin/process/:userId', requireSelf('userId'), async (c) => {
    try {
      const userId = c.req.param('userId');
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const requestedId = typeof body.activityId === 'string' ? body.activityId : null;
      const storage = getStorage(c.env);
      const pending = await storage.getUnprocessedGarminActivities(userId);
      if (pending.length === 0) return c.json({ processed: 0, results: [], remaining: 0, message: 'No activities to process' });

      const activity = requestedId ? pending.find((a) => a.id === requestedId) : pending[0];
      if (!activity) return c.json({ processed: 0, results: [], remaining: pending.length, message: 'Activity already processed or not found' });

      const outcome = await processGarminActivity(c.env, storage, activity);
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
      console.error('[GARMIN] Process error:', error);
      return c.json({ error: error.message, processed: 0 }, 500);
    }
  });

  // Retry a skipped activity with a GPS track (the app then calls /process)
  app.post('/api/garmin/retry/:activityId', requireAuth, async (c) => {
    try {
      const userId = c.get('authUserId');
      const storage = getStorage(c.env);
      const activity = await storage.getGarminActivityById(c.req.param('activityId'));
      if (!activity || activity.userId !== userId) return c.json({ error: 'Actividad no encontrada' }, 404);
      if (activity.routeId) return c.json({ success: true, status: 'imported' });
      // Rules of the competition stay: retrying doesn't turn a bike ride or a 50 m walk into territory
      if (activity.skipReason && RULE_SKIP_REASONS.has(activity.skipReason)) {
        return c.json({ success: true, status: 'skipped', reason: activity.skipReason });
      }
      if (!activity.summaryPolyline) {
        return c.json({ error: 'Garmin no ha enviado el recorrido GPS de esta actividad.' }, 400);
      }
      await storage.updateGarminActivity(activity.id, { status: 'pending', processed: false, processedAt: null, skipReason: null });
      return c.json({ success: true, status: 'pending' });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // Delete an imported activity's route (territory is recalculated); the activity stays as skipped
  app.delete('/api/garmin/activities/:userId/:activityId', requireSelf('userId'), async (c) => {
    try {
      const userId = c.req.param('userId');
      const storage = getStorage(c.env);
      const activity = await storage.getGarminActivityById(c.req.param('activityId'));
      if (!activity) return c.json({ error: 'Actividad no encontrada' }, 404);
      if (activity.userId !== userId) return c.json({ error: 'No autorizado' }, 403);

      const routeId = activity.routeId;
      if (routeId) {
        await storage.markGarminActivityDeletedByRouteId(routeId);
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
          console.error('[GARMIN] Territory rebuild after delete failed:', error);
        }
      } else {
        await storage.deleteGarminActivityById(activity.id);
      }
      return c.json({ success: true });
    } catch (error: any) {
      console.error('[GARMIN] Delete error:', error);
      return c.json({ error: error.message }, 500);
    }
  });
}
