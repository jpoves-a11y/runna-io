// Sign in with Apple.
//
// The app sends the identity token Apple gave it (a JWT signed by Apple, RS256). The Worker checks
// the signature against Apple's public keys and the claims (issuer, audience = the app's bundle id,
// expiry, nonce). The authorization code is exchanged for a refresh token so the account can be
// unlinked from Apple when it is deleted (App Review guideline 5.1.1(v)).
//
// Secrets: APPLE_SIGNIN_KEY_ID and APPLE_SIGNIN_PRIVATE_KEY (a key with "Sign in with Apple" from
// developer.apple.com → Keys); the team id is APNS_TEAM_ID (or APPLE_TEAM_ID). Without them, sign-in
// still works, but the token can't be revoked on account deletion.

import { signAppleEs256Jwt } from './pushHelper';

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_KEYS_URL = 'https://appleid.apple.com/auth/keys';
const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
const APPLE_REVOKE_URL = 'https://appleid.apple.com/auth/revoke';
const DEFAULT_BUNDLE_ID = 'com.jpoves.runnaio';

export interface AppleEnv {
  APPLE_BUNDLE_ID?: string;
  APNS_BUNDLE_ID?: string;
  APPLE_TEAM_ID?: string;
  APNS_TEAM_ID?: string;
  APPLE_SIGNIN_KEY_ID?: string;
  APPLE_SIGNIN_PRIVATE_KEY?: string;
  /** Tests only (ignored in production): Apple's key set as JSON, so no request goes to Apple */
  APPLE_JWKS_JSON?: string;
  ENVIRONMENT?: string;
}

export interface AppleIdentity {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  isPrivateEmail: boolean;
}

export class AppleTokenError extends Error {}

interface Jwk { kty: string; kid: string; use?: string; alg?: string; n: string; e: string }

let cachedKeys: { keys: Jwk[]; fetchedAt: number } | null = null;

export function appleBundleId(env: AppleEnv): string {
  return (env.APPLE_BUNDLE_ID || env.APNS_BUNDLE_ID || DEFAULT_BUNDLE_ID).trim();
}

function teamId(env: AppleEnv): string {
  return (env.APPLE_TEAM_ID || env.APNS_TEAM_ID || '').trim();
}

/** True when the Worker can talk to Apple as the app (exchange codes, revoke tokens). */
export function canUseAppleClientSecret(env: AppleEnv): boolean {
  return Boolean(env.APPLE_SIGNIN_KEY_ID?.trim() && env.APPLE_SIGNIN_PRIVATE_KEY?.trim() && teamId(env));
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
}

function decodeJson(part: string): any {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(part)));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function appleKeys(env: AppleEnv, refresh = false): Promise<Jwk[]> {
  if (env.APPLE_JWKS_JSON && env.ENVIRONMENT !== 'production') {
    return JSON.parse(env.APPLE_JWKS_JSON).keys ?? [];
  }
  if (!refresh && cachedKeys && Date.now() - cachedKeys.fetchedAt < 60 * 60 * 1000) return cachedKeys.keys;
  const response = await fetch(APPLE_KEYS_URL);
  if (!response.ok) throw new Error(`Apple keys: HTTP ${response.status}`);
  const body = await response.json() as { keys?: Jwk[] };
  cachedKeys = { keys: body.keys ?? [], fetchedAt: Date.now() };
  return cachedKeys.keys;
}

const truthy = (value: unknown) => value === true || value === 'true';

/** Checks the signature (Apple's keys), issuer and audience of a JWT from Apple; returns its claims. */
async function verifyAppleJwt(env: AppleEnv, token: string): Promise<any> {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) throw new AppleTokenError('Token de Apple no válido.');
  let header: any;
  let claims: any;
  try {
    header = decodeJson(parts[0]);
    claims = decodeJson(parts[1]);
  } catch {
    throw new AppleTokenError('Token de Apple no válido.');
  }
  if (header?.alg !== 'RS256' || typeof header?.kid !== 'string') throw new AppleTokenError('Token de Apple no válido.');

  let jwk = (await appleKeys(env)).find((key) => key.kid === header.kid);
  if (!jwk) jwk = (await appleKeys(env, true)).find((key) => key.kid === header.kid); // Apple rotated its keys
  if (!jwk) throw new AppleTokenError('Token de Apple no válido.');
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64UrlDecode(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) throw new AppleTokenError('Token de Apple no válido.');

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== APPLE_ISSUER) throw new AppleTokenError('Token de Apple no válido.');
  if (!audiences.includes(appleBundleId(env))) throw new AppleTokenError('Token de Apple para otra app.');
  return claims;
}

/**
 * Checks an identity token from the app. `rawNonce` is the nonce the app generated; the app sent its
 * SHA-256 (hex) to Apple, which puts it in the token. Throws AppleTokenError when the token is not valid.
 */
export async function verifyAppleIdentityToken(
  env: AppleEnv,
  identityToken: string,
  options: { rawNonce?: string | null; now?: number } = {},
): Promise<AppleIdentity> {
  const claims = await verifyAppleJwt(env, identityToken);
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  if (typeof claims.exp !== 'number' || claims.exp < now - 60) throw new AppleTokenError('El inicio de sesión con Apple ha caducado. Inténtalo de nuevo.');
  if (typeof claims.sub !== 'string' || !claims.sub) throw new AppleTokenError('Token de Apple no válido.');
  if (options.rawNonce) {
    if (claims.nonce !== await sha256Hex(options.rawNonce)) throw new AppleTokenError('Token de Apple no válido.');
  }

  const email = typeof claims.email === 'string' && claims.email.includes('@') ? claims.email.trim().toLowerCase() : null;
  return {
    sub: claims.sub,
    email,
    emailVerified: truthy(claims.email_verified),
    isPrivateEmail: truthy(claims.is_private_email) || Boolean(email?.endsWith('@privaterelay.appleid.com')),
  };
}

/** One server-to-server notification from Apple (the "events" claim of the payload). */
export interface AppleServerEvent {
  type: 'email-disabled' | 'email-enabled' | 'consent-revoked' | 'account-delete' | string;
  sub: string;
  email: string | null;
  eventTime: number | null;
}

/**
 * Checks a Sign in with Apple server-to-server notification (body {"payload": "<JWT>"}) and returns its
 * event. Apple sends one when a user stops using Sign in with Apple with the app, deletes their Apple
 * Account, or turns their relay email off or on.
 */
export async function verifyAppleServerNotification(env: AppleEnv, payload: string, now = Date.now()): Promise<AppleServerEvent> {
  const claims = await verifyAppleJwt(env, payload);
  // Notifications older than a week (or from the future) are refused: replays of an old payload
  if (typeof claims.iat === 'number') {
    const ageSeconds = Math.floor(now / 1000) - claims.iat;
    if (ageSeconds > 7 * 24 * 3600 || ageSeconds < -300) throw new AppleTokenError('Notificación de Apple caducada.');
  }
  let events: any = claims.events;
  if (typeof events === 'string') {
    try { events = JSON.parse(events); } catch { throw new AppleTokenError('Notificación de Apple no válida.'); }
  }
  if (!events || typeof events !== 'object' || typeof events.type !== 'string' || typeof events.sub !== 'string' || !events.sub) {
    throw new AppleTokenError('Notificación de Apple no válida.');
  }
  return {
    type: events.type,
    sub: events.sub,
    email: typeof events.email === 'string' ? events.email : null,
    eventTime: typeof events.event_time === 'number' ? events.event_time : null,
  };
}

async function clientSecret(env: AppleEnv): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signAppleEs256Jwt(env.APPLE_SIGNIN_PRIVATE_KEY!.trim(), env.APPLE_SIGNIN_KEY_ID!.trim(), {
    iss: teamId(env),
    iat: now,
    exp: now + 10 * 60,
    aud: APPLE_ISSUER,
    sub: appleBundleId(env),
  });
}

/** Exchanges the authorization code from the app for a refresh token (null when not configured or refused). */
export async function exchangeAppleAuthorizationCode(env: AppleEnv, code: string): Promise<string | null> {
  if (!code || !canUseAppleClientSecret(env)) return null;
  const response = await fetch(APPLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: appleBundleId(env),
      client_secret: await clientSecret(env),
      code,
      grant_type: 'authorization_code',
    }),
  });
  if (!response.ok) {
    console.warn(`[APPLE] Code exchange failed: ${response.status} ${await response.text().catch(() => '')}`);
    return null;
  }
  const body = await response.json() as { refresh_token?: string };
  return body.refresh_token ?? null;
}

/** Unlinks the app from the user's Apple ID (account deletion). True when Apple accepted it. */
export async function revokeAppleToken(env: AppleEnv, refreshToken: string): Promise<boolean> {
  if (!refreshToken || !canUseAppleClientSecret(env)) return false;
  const response = await fetch(APPLE_REVOKE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: appleBundleId(env),
      client_secret: await clientSecret(env),
      token: refreshToken,
      token_type_hint: 'refresh_token',
    }),
  });
  if (!response.ok) console.warn(`[APPLE] Revoke failed: ${response.status}`);
  return response.ok;
}

/** A free username from a name or email ("Ana López" → "analopez", "analopez2", ...). */
export function usernameCandidates(seed: string): string[] {
  const base = seed
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_.]/g, '')
    .slice(0, 20) || 'runner';
  const padded = base.length >= 3 ? base : `${base}runner`;
  return [padded, ...Array.from({ length: 8 }, (_, i) => `${padded}${i + 2}`), `${padded}${Math.floor(1000 + Math.random() * 9000)}`];
}
