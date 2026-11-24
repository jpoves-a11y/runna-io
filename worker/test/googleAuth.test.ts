import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyGoogleIdToken, googleClientIds, GoogleTokenError } from '../src/googleAuth';

const b64url = (data: Uint8Array | string) => Buffer.from(data).toString('base64url');
const CLIENT_ID = '123-abc.apps.googleusercontent.com';

async function setup() {
  const keys = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey) as JsonWebKey;
  const env = { GOOGLE_JWKS_JSON: JSON.stringify({ keys: [{ ...jwk, kid: 'g-kid', alg: 'RS256', use: 'sig' }] }), GOOGLE_CLIENT_IDS: ` ${CLIENT_ID} , other.apps.googleusercontent.com` };
  async function sign(claims: Record<string, unknown>, kid = 'g-kid', privateKey = keys.privateKey) {
    const head = b64url(JSON.stringify({ alg: 'RS256', kid }));
    const body = b64url(JSON.stringify(claims));
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${b64url(new Uint8Array(signature))}`;
  }
  return { env, sign };
}

const now = Math.floor(Date.now() / 1000);
const nonce = 'nonce-xyz';
const base = { iss: 'https://accounts.google.com', aud: CLIENT_ID, exp: now + 600, iat: now, sub: '1092837465', nonce, email: 'Lucia@Gmail.com', email_verified: true, name: 'Lucía Pérez' };

test('client IDs: comma-separated, trimmed', () => {
  assert.deepEqual(googleClientIds({ GOOGLE_CLIENT_IDS: ` ${CLIENT_ID} , other.apps.googleusercontent.com,` }), [CLIENT_ID, 'other.apps.googleusercontent.com']);
  assert.deepEqual(googleClientIds({}), []);
});

test('accepts a valid token and reads email, verification and name', async () => {
  const { env, sign } = await setup();
  const identity = await verifyGoogleIdToken(env, await sign(base), { nonce });
  assert.deepEqual(identity, { sub: '1092837465', email: 'lucia@gmail.com', emailVerified: true, name: 'Lucía Pérez' });
  // The short issuer form is also Google's
  const short = await verifyGoogleIdToken(env, await sign({ ...base, iss: 'accounts.google.com', email_verified: 'false' }), { nonce });
  assert.equal(short.emailVerified, false);
});

test('refuses tokens that are not for this app or not from this sign-in', async () => {
  const { env, sign } = await setup();
  const refused = async (token: string, options: { nonce?: string | null }) => {
    await assert.rejects(verifyGoogleIdToken(env, token, options), GoogleTokenError);
  };
  await refused(await sign({ ...base, aud: 'someone-else.apps.googleusercontent.com' }), { nonce });
  await refused(await sign({ ...base, iss: 'https://evil.example' }), { nonce });
  await refused(await sign({ ...base, exp: now - 3600 }), { nonce });
  await refused(await sign(base), { nonce: 'another-nonce' });
  await refused(await sign(base), { nonce: null });
  await refused(await sign({ ...base, sub: '' }), { nonce });
  await refused(await sign(base, 'unknown-kid'), { nonce });
  await refused('not.a.jwt', { nonce });
  // Signed with another key
  const other = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  await refused(await sign(base, 'g-kid', other.privateKey), { nonce });
});

test('the test key set is ignored in production', async () => {
  const { env, sign } = await setup();
  const token = await sign(base);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ keys: [] }), { status: 200 })) as typeof fetch;
  try {
    await assert.rejects(verifyGoogleIdToken({ ...env, ENVIRONMENT: 'production' }, token, { nonce }), GoogleTokenError);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
