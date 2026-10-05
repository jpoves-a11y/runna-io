import type { Context, MiddlewareHandler } from 'hono';
import { createDb } from './db';
import { WorkerStorage } from './storage';
import type { Env } from './index';

// Hono environment shared by the app: authenticated routes put the caller's user ID in `authUserId`
export type AppEnv = {
  Bindings: Env;
  Variables: { authUserId: string };
};

type AppContext = Context<AppEnv>;

// Sessions last 180 days from their last use. To avoid a DB write on every request,
// the expiry is only pushed forward once less than SESSION_RENEW_BELOW_MS remains.
const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const SESSION_RENEW_BELOW_MS = 150 * 24 * 60 * 60 * 1000;

// Signed OAuth `state` values (Strava/Polar/COROS) are valid for 1 hour
const OAUTH_STATE_MAX_AGE_MS = 60 * 60 * 1000;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecodeToString(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Compares two strings without returning early on the first difference
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return toHex(digest);
}

function getStorage(env: Env): WorkerStorage {
  return new WorkerStorage(createDb(env.DATABASE_URL, env.TURSO_AUTH_TOKEN));
}

function getBearerToken(c: AppContext): string | null {
  const header = c.req.header('Authorization');
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/** Creates a new login session for the user and returns the token to send to the client. */
export async function createSession(storage: WorkerStorage, userId: string): Promise<string> {
  const token = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await storage.createAuthSession(userId, await hashSessionToken(token), expiresAt);
  return token;
}

/** Revokes the session whose token is in the request's Authorization header, if any. */
export async function revokeRequestSession(c: AppContext): Promise<void> {
  const token = getBearerToken(c);
  if (!token) return;
  await getStorage(c.env).deleteAuthSessionByTokenHash(await hashSessionToken(token));
}

/** Returns the user ID of a valid, unexpired session token, or null. */
async function resolveSessionUserId(c: AppContext): Promise<string | null> {
  const token = getBearerToken(c);
  if (!token) return null;

  const storage = getStorage(c.env);
  const session = await storage.getAuthSessionByTokenHash(await hashSessionToken(token));
  if (!session) return null;

  const now = Date.now();
  const expiresAt = new Date(session.expiresAt).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;

  if (expiresAt - now < SESSION_RENEW_BELOW_MS) {
    try {
      await storage.extendAuthSession(session.id, new Date(now + SESSION_TTL_MS).toISOString());
    } catch (e) {
      console.error('[AUTH] Failed to extend session:', e);
    }
  }

  return session.userId;
}

function unauthorized(c: AppContext) {
  return c.json({ error: 'Sesión no válida o caducada. Vuelve a iniciar sesión.' }, 401);
}

function forbidden(c: AppContext) {
  return c.json({ error: 'No autorizado' }, 403);
}

/** Requires a valid session; the caller's user ID is then available as c.get('authUserId'). */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const userId = await resolveSessionUserId(c);
  if (!userId) return unauthorized(c);
  c.set('authUserId', userId);
  await next();
};

/** Requires a valid session whose user matches the route parameter `param` (e.g. ':userId'). */
export function requireSelf(param: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const userId = await resolveSessionUserId(c);
    if (!userId) return unauthorized(c);
    if (c.req.param(param) !== userId) return forbidden(c);
    c.set('authUserId', userId);
    await next();
  };
}

/**
 * True when the request carries the admin/cron secret (Authorization: Bearer <UPSTASH_CRON_SECRET>).
 * Without a configured secret this only passes outside production (local development).
 */
export function isAdminRequest(c: AppContext, { allowWithoutSecret = true } = {}): boolean {
  const secret = c.env.UPSTASH_CRON_SECRET;
  if (!secret) return allowWithoutSecret && c.env.ENVIRONMENT !== 'production';
  const header = c.req.header('Authorization') || '';
  return timingSafeEqual(header, `Bearer ${secret}`);
}

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!isAdminRequest(c)) return c.json({ error: 'Unauthorized' }, 401);
  await next();
};

/** Like requireSelf, but also lets through internal calls that carry the admin secret. */
export function requireSelfOrAdmin(param: string): MiddlewareHandler<AppEnv> {
  const self = requireSelf(param);
  return async (c, next) => {
    if (isAdminRequest(c, { allowWithoutSecret: false })) {
      await next();
      return;
    }
    return self(c, next);
  };
}

/**
 * For handlers that still accept a user ID in the body or query (older clients send it):
 * returns a 403 response if that ID is present and is not the authenticated user, else null.
 */
export function rejectIfNotSelf(c: AppContext, claimedUserId: unknown): Response | null {
  if (claimedUserId === undefined || claimedUserId === null || claimedUserId === '') return null;
  return claimedUserId === c.get('authUserId') ? null : forbidden(c);
}

async function hmacSign(key: string, data: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
  return base64UrlEncode(new Uint8Array(signature));
}

/** What a verified OAuth `state` says about the connect flow. */
export interface OAuthStateInfo {
  userId: string;
  /** The flow was started from the iOS app, so the callback must send the browser back to it. */
  app: boolean;
}

/**
 * Builds the OAuth `state` for a connect flow, signed with a server-side secret so that the
 * callback can trust the user ID inside it.
 */
export async function createOAuthState(userId: string, signingKey: string, options: { app?: boolean } = {}): Promise<string> {
  const data = { userId, ts: Date.now(), ...(options.app ? { app: true } : {}) };
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(data)));
  return `${payload}.${await hmacSign(signingKey, payload)}`;
}

/** Returns the contents of a state built by createOAuthState, or null if it's forged or expired. */
export async function verifyOAuthState(state: string, signingKey: string): Promise<OAuthStateInfo | null> {
  const [payload, signature] = state.split('.');
  if (!payload || !signature) return null;
  if (!timingSafeEqual(signature, await hmacSign(signingKey, payload))) return null;
  try {
    const { userId, ts, app } = JSON.parse(base64UrlDecodeToString(payload));
    if (typeof userId !== 'string' || typeof ts !== 'number') return null;
    if (Date.now() - ts > OAUTH_STATE_MAX_AGE_MS) return null;
    return { userId, app: app === true };
  } catch {
    return null;
  }
}

/** URL scheme the iOS app registers to receive the end of OAuth flows. */
export const IOS_APP_URL_SCHEME = 'runnaio';

/**
 * Ends an OAuth callback: redirects to `webUrl`, or for flows started in the iOS app,
 * to runnaio://oauth/<provider> with the same query string (e.g. ?strava_connected=true).
 */
export function oauthFinish(c: AppContext, appFlow: boolean, provider: string, webUrl: string) {
  if (!appFlow) return c.redirect(webUrl);
  const query = new URL(webUrl).search;
  return c.redirect(`${IOS_APP_URL_SCHEME}://oauth/${provider}${query}`);
}

function base64UrlToBytes(value: string): Uint8Array {
  return Uint8Array.from(base64UrlDecodeToBinary(value), (ch) => ch.charCodeAt(0));
}

function base64UrlDecodeToBinary(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
}

function sameUrl(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.host === ub.host && ua.pathname.replace(/\/+$/, '') === ub.pathname.replace(/\/+$/, '') && ua.search === ub.search;
  } catch {
    return false;
  }
}

/**
 * Verifies an Upstash QStash `Upstash-Signature` header: an HS256 JWT signed with one of the
 * QStash signing keys, issued for this URL and carrying the SHA-256 of the request body.
 */
async function verifyQstashSignature(c: AppContext, signature: string): Promise<boolean> {
  const keys = [c.env.QSTASH_CURRENT_SIGNING_KEY, c.env.QSTASH_NEXT_SIGNING_KEY].filter((k): k is string => !!k);
  if (keys.length === 0) return false;

  const [headerPart, claimsPart, signaturePart] = signature.split('.');
  if (!headerPart || !claimsPart || !signaturePart) return false;

  let signedByKnownKey = false;
  for (const key of keys) {
    if (timingSafeEqual(await hmacSign(key, `${headerPart}.${claimsPart}`), signaturePart)) {
      signedByKnownKey = true;
      break;
    }
  }
  if (!signedByKnownKey) return false;

  try {
    const header = JSON.parse(base64UrlDecodeToString(headerPart));
    const claims = JSON.parse(base64UrlDecodeToString(claimsPart));
    if (header.alg !== 'HS256' || claims.iss !== 'Upstash') return false;
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp === 'number' && claims.exp < now - 60) return false;
    if (typeof claims.nbf === 'number' && claims.nbf > now + 60) return false;
    if (typeof claims.sub === 'string' && !sameUrl(claims.sub, c.req.url)) return false;

    const body = await c.req.raw.clone().arrayBuffer();
    const bodyHash = base64UrlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', body)));
    const claimedHash = typeof claims.body === 'string' ? claims.body.replace(/=+$/, '') : '';
    // QStash may send the hash in base64url or base64
    const normalizedClaim = base64UrlEncode(base64UrlToBytes(claimedHash));
    return timingSafeEqual(normalizedClaim, bodyHash);
  } catch {
    return false;
  }
}

/** Cron endpoints: the admin/cron secret as a Bearer token, or a valid QStash signature. */
export async function isCronRequest(c: AppContext): Promise<boolean> {
  if (isAdminRequest(c)) return true;
  const signature = c.req.header('Upstash-Signature');
  return signature ? verifyQstashSignature(c, signature) : false;
}
