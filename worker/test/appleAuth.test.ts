import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyAppleIdentityToken, usernameCandidates, AppleTokenError } from '../src/appleAuth';

const b64url = (data: Uint8Array | string) => Buffer.from(data).toString('base64url');

async function setup() {
  const keys = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey) as JsonWebKey;
  const env = { APPLE_JWKS_JSON: JSON.stringify({ keys: [{ ...jwk, kid: 'test-kid', alg: 'RS256', use: 'sig' }] }), APNS_BUNDLE_ID: 'com.jpoves.runnaio' };
  async function sign(claims: Record<string, unknown>, kid = 'test-kid') {
    const head = b64url(JSON.stringify({ alg: 'RS256', kid }));
    const body = b64url(JSON.stringify(claims));
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${b64url(new Uint8Array(signature))}`;
  }
  return { env, sign };
}

const now = Math.floor(Date.now() / 1000);
const nonce = 'raw-nonce-123';
const hashedNonce = createHash('sha256').update(nonce).digest('hex');
const base = { iss: 'https://appleid.apple.com', aud: 'com.jpoves.runnaio', exp: now + 600, iat: now, sub: '001234.abcd', nonce: hashedNonce };

test('accepts a valid token and reads the email claims', async () => {
  const { env, sign } = await setup();
  const token = await sign({ ...base, email: 'Ana@Example.com', email_verified: 'true', is_private_email: 'false' });
  const identity = await verifyAppleIdentityToken(env, token, { rawNonce: nonce });
  assert.deepEqual(identity, { sub: '001234.abcd', email: 'ana@example.com', emailVerified: true, isPrivateEmail: false });
});

test('relay addresses count as private', async () => {
  const { env, sign } = await setup();
  const token = await sign({ ...base, email: 'x1@privaterelay.appleid.com', email_verified: true });
  const identity = await verifyAppleIdentityToken(env, token, { rawNonce: nonce });
  assert.equal(identity.isPrivateEmail, true);
});

test('rejects wrong audience, issuer, expiry, nonce, key and signature', async () => {
  const { env, sign } = await setup();
  const other = await setup();
  const cases = [
    await sign({ ...base, aud: 'com.other.app' }),
    await sign({ ...base, iss: 'https://evil.example' }),
    await sign({ ...base, exp: now - 3600 }),
    await sign({ ...base, nonce: 'not-the-hash' }),
    await sign(base, 'unknown-kid'),
    await other.sign(base), // signed with another key under the same kid
    'not-a-jwt',
  ];
  for (const token of cases) {
    await assert.rejects(verifyAppleIdentityToken(env, token, { rawNonce: nonce }), AppleTokenError);
  }
});

test('test keys are ignored in production', async () => {
  const { env, sign } = await setup();
  const token = await sign(base);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ keys: [] }), { status: 200 })) as typeof fetch;
  try {
    await assert.rejects(verifyAppleIdentityToken({ ...env, ENVIRONMENT: 'production' }, token, { rawNonce: nonce }), AppleTokenError);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('username candidates are clean and long enough', () => {
  const [first, second] = usernameCandidates('Ana López');
  assert.equal(first, 'analopez');
  assert.equal(second, 'analopez2');
  assert.equal(usernameCandidates('Jo')[0], 'jorunner');
  assert.equal(usernameCandidates('')[0], 'runner');
});
