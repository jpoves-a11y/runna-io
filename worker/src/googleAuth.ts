// Sign in with Google.
//
// The app signs in with Google in the system's web sheet (OAuth 2.0 with PKCE, the iOS client of the
// Google Cloud project) and sends the ID token Google gave it: a JWT signed by Google (RS256). The
// Worker checks the signature against Google's public keys and the claims: issuer, audience (one of
// GOOGLE_CLIENT_IDS), expiry and the nonce the app put in the request.
//
// Config: GOOGLE_CLIENT_IDS in [vars] of wrangler.worker.toml, the OAuth client ID(s) of the app,
// comma-separated. Client IDs are not secret. Without it, /api/auth/google answers 503.

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const GOOGLE_KEYS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

export interface GoogleEnv {
  GOOGLE_CLIENT_IDS?: string;
  /** Tests only (ignored in production): Google's key set as JSON, so no request goes to Google */
  GOOGLE_JWKS_JSON?: string;
  ENVIRONMENT?: string;
}

export interface GoogleIdentity {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

export class GoogleTokenError extends Error {}

interface Jwk { kty: string; kid: string; use?: string; alg?: string; n: string; e: string }

let cachedKeys: { keys: Jwk[]; fetchedAt: number } | null = null;

/** The app's OAuth client IDs (the token's audience must be one of them). */
export function googleClientIds(env: GoogleEnv): string[] {
  return (env.GOOGLE_CLIENT_IDS || '').split(',').map((id) => id.trim()).filter(Boolean);
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
}

function decodeJson(part: string): any {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(part)));
}

async function googleKeys(env: GoogleEnv, refresh = false): Promise<Jwk[]> {
  if (env.GOOGLE_JWKS_JSON && env.ENVIRONMENT !== 'production') {
    return JSON.parse(env.GOOGLE_JWKS_JSON).keys ?? [];
  }
  if (!refresh && cachedKeys && Date.now() - cachedKeys.fetchedAt < 60 * 60 * 1000) return cachedKeys.keys;
  const response = await fetch(GOOGLE_KEYS_URL);
  if (!response.ok) throw new Error(`Google keys: HTTP ${response.status}`);
  const body = await response.json() as { keys?: Jwk[] };
  cachedKeys = { keys: body.keys ?? [], fetchedAt: Date.now() };
  return cachedKeys.keys;
}

const invalid = () => new GoogleTokenError('Token de Google no válido.');

/**
 * Checks an ID token from the app. `nonce` is the one the app put in the sign-in request; Google
 * copies it into the token. Throws GoogleTokenError when the token is not valid.
 */
export async function verifyGoogleIdToken(
  env: GoogleEnv,
  idToken: string,
  options: { nonce?: string | null; now?: number } = {},
): Promise<GoogleIdentity> {
  const parts = typeof idToken === 'string' ? idToken.split('.') : [];
  if (parts.length !== 3) throw invalid();
  let header: any;
  let claims: any;
  try {
    header = decodeJson(parts[0]);
    claims = decodeJson(parts[1]);
  } catch {
    throw invalid();
  }
  if (header?.alg !== 'RS256' || typeof header?.kid !== 'string') throw invalid();

  let jwk = (await googleKeys(env)).find((key) => key.kid === header.kid);
  if (!jwk) jwk = (await googleKeys(env, true)).find((key) => key.kid === header.kid); // Google rotated its keys
  if (!jwk) throw invalid();
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
  if (!valid) throw invalid();

  if (!GOOGLE_ISSUERS.includes(claims.iss)) throw invalid();
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const clientIds = googleClientIds(env);
  if (!audiences.some((aud: unknown) => typeof aud === 'string' && clientIds.includes(aud))) {
    throw new GoogleTokenError('Token de Google para otra app.');
  }
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  if (typeof claims.exp !== 'number' || claims.exp < now - 60) {
    throw new GoogleTokenError('El inicio de sesión con Google ha caducado. Inténtalo de nuevo.');
  }
  if (typeof claims.sub !== 'string' || !claims.sub) throw invalid();
  // The app always sends a nonce; the token must carry the same one (a token from another sign-in is refused)
  if (!options.nonce || claims.nonce !== options.nonce) throw invalid();

  const email = typeof claims.email === 'string' && claims.email.includes('@') ? claims.email.trim().toLowerCase() : null;
  const name = typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim().slice(0, 60) : null;
  return {
    sub: claims.sub,
    email,
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    name,
  };
}
