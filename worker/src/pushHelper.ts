// Web Push helper for Cloudflare Workers
// Implements RFC 8291 (Message Encryption) and RFC 8292 (VAPID)
// Uses Web Crypto API (available in CF Workers)

import { createDb } from './db';
import { WorkerStorage } from './storage';

interface PushSubscriptionData {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

interface PushNotificationPayload {
  title: string;
  body: string;
  tag?: string;
  data?: any;
}

// ===== Base64 URL helpers =====

function base64UrlToUint8Array(base64Url: string): Uint8Array {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function uint8ArrayToBase64Url(arr: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concatBuffers(...buffers: ArrayBuffer[]): ArrayBuffer {
  const total = buffers.reduce((sum, b) => sum + b.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const buf of buffers) {
    result.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }
  return result.buffer;
}

// ===== HKDF (RFC 5869) =====

async function hkdfExtract(salt: ArrayBuffer, ikm: ArrayBuffer): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, ikm);
}

async function hkdfExpand(prk: ArrayBuffer, info: ArrayBuffer, length: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  let t = new ArrayBuffer(0);
  let okm = new Uint8Array(0);
  for (let i = 0; okm.length < length; i++) {
    const input = concatBuffers(t, info, new Uint8Array([i + 1]).buffer);
    t = await crypto.subtle.sign('HMAC', key, input);
    const newOkm = new Uint8Array(okm.length + t.byteLength);
    newOkm.set(okm);
    newOkm.set(new Uint8Array(t), okm.length);
    okm = newOkm;
  }
  return okm.slice(0, length).buffer;
}

async function hkdf(salt: ArrayBuffer, ikm: ArrayBuffer, info: ArrayBuffer, length: number): Promise<ArrayBuffer> {
  const prk = await hkdfExtract(salt, ikm);
  return hkdfExpand(prk, info, length);
}

// ===== Info string builders for RFC 8291 =====

function createInfo(type: string, clientPublicKey: Uint8Array, serverPublicKey: Uint8Array): ArrayBuffer {
  const encoder = new TextEncoder();
  const typeBytes = encoder.encode(type);
  const ceStr = encoder.encode('Content-Encoding: ');
  const p256 = encoder.encode('P-256');

  const result = new Uint8Array(
    ceStr.length + typeBytes.length + 1 + p256.length + 1 + 2 + clientPublicKey.length + 2 + serverPublicKey.length
  );
  let offset = 0;

  result.set(ceStr, offset); offset += ceStr.length;
  result.set(typeBytes, offset); offset += typeBytes.length;
  result[offset++] = 0;
  result.set(p256, offset); offset += p256.length;
  result[offset++] = 0;
  result[offset++] = 0;
  result[offset++] = clientPublicKey.length;
  result.set(clientPublicKey, offset); offset += clientPublicKey.length;
  result[offset++] = 0;
  result[offset++] = serverPublicKey.length;
  result.set(serverPublicKey, offset);

  return result.buffer;
}

// ===== Payload encryption (RFC 8291 - aesgcm) =====

async function encryptPayload(
  payload: string,
  clientPublicKeyB64: string,
  clientAuthB64: string
): Promise<{ body: ArrayBuffer; serverPublicKey: Uint8Array; salt: Uint8Array }> {
  const encoder = new TextEncoder();
  const payloadBytes = encoder.encode(payload);

  const clientPublicKeyBytes = base64UrlToUint8Array(clientPublicKeyB64);
  const clientAuth = base64UrlToUint8Array(clientAuthB64);

  const salt = crypto.getRandomValues(new Uint8Array(16));

  // Generate server ECDH key pair
  const serverKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
  const serverPublicKeyRaw = new Uint8Array(
    await crypto.subtle.exportKey('raw', serverKeyPair.publicKey)
  );

  // Import client public key
  const clientPublicKey = await crypto.subtle.importKey(
    'raw',
    clientPublicKeyBytes,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );

  // ECDH shared secret
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: clientPublicKey },
    serverKeyPair.privateKey,
    256
  );

  // IKM = HKDF(auth, shared_secret, "Content-Encoding: auth\0", 32)
  const authInfo = encoder.encode('Content-Encoding: auth\0');
  const ikm = await hkdf(clientAuth.buffer, sharedSecret, authInfo.buffer, 32);

  // Derive content encryption key
  const cekInfo = createInfo('aesgcm', clientPublicKeyBytes, serverPublicKeyRaw);
  const contentEncryptionKey = await hkdf(salt.buffer, ikm, cekInfo, 16);

  // Derive nonce
  const nonceInfo = createInfo('nonce', clientPublicKeyBytes, serverPublicKeyRaw);
  const nonce = await hkdf(salt.buffer, ikm, nonceInfo, 12);

  // Pad the payload (2 bytes padding length + padding + payload)
  const padded = new Uint8Array(2 + payloadBytes.length);
  padded[0] = 0;
  padded[1] = 0;
  padded.set(payloadBytes, 2);

  // AES-128-GCM encrypt
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    contentEncryptionKey,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 },
    cryptoKey,
    padded
  );

  return { body: encrypted, serverPublicKey: serverPublicKeyRaw, salt };
}

// ===== VAPID JWT (RFC 8292) with ES256 =====

async function importVapidPrivateKey(base64UrlKey: string): Promise<CryptoKey> {
  const rawKey = base64UrlToUint8Array(base64UrlKey);

  // Build PKCS8 DER wrapper for EC P-256 private key (32 bytes)
  const pkcs8Header = new Uint8Array([
    0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06,
    0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03,
    0x01, 0x07, 0x04, 0x27, 0x30, 0x25, 0x02, 0x01,
    0x01, 0x04, 0x20
  ]);

  const pkcs8 = concatBuffers(pkcs8Header.buffer, rawKey.buffer);

  return crypto.subtle.importKey(
    'pkcs8',
    pkcs8,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
}

// Convert DER-encoded ECDSA signature to raw 64-byte r||s format
function derToRaw(der: Uint8Array): Uint8Array {
  if (der.length === 64) return der;

  const raw = new Uint8Array(64);
  let offset = 2; // skip 0x30 and total length

  // Read r
  offset++; // skip 0x02
  const rLen = der[offset++];
  const rBytes = der.slice(offset, offset + rLen);
  offset += rLen;

  // Read s
  offset++; // skip 0x02
  const sLen = der[offset++];
  const sBytes = der.slice(offset, offset + sLen);

  // Right-align r in 32 bytes
  if (rLen <= 32) {
    raw.set(rBytes, 32 - rLen);
  } else {
    raw.set(rBytes.slice(rLen - 32), 0);
  }

  // Right-align s in 32 bytes
  if (sLen <= 32) {
    raw.set(sBytes, 64 - sLen);
  } else {
    raw.set(sBytes.slice(sLen - 32), 32);
  }

  return raw;
}

async function createVapidJwt(
  audience: string,
  subject: string,
  privateKeyB64: string
): Promise<string> {
  const header = { typ: 'JWT', alg: 'ES256' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { aud: audience, exp: now + 12 * 60 * 60, sub: subject };

  const headerB64 = uint8ArrayToBase64Url(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = uint8ArrayToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const unsignedToken = `${headerB64}.${payloadB64}`;

  const privateKey = await importVapidPrivateKey(privateKeyB64);
  const signatureBuffer = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(unsignedToken)
  );

  const signatureRaw = derToRaw(new Uint8Array(signatureBuffer));
  const signatureB64 = uint8ArrayToBase64Url(signatureRaw);

  return `${unsignedToken}.${signatureB64}`;
}

// ===== Apple Push Notification service (native iOS app) =====
// iOS devices are stored as push subscriptions whose endpoint is "apns:<environment>:<device token>",
// so every place that notifies a user's subscriptions also reaches their iPhone.

export const APNS_ENDPOINT_PREFIX = 'apns:';
export type ApnsEnvironment = 'sandbox' | 'production';

interface ApnsConfig {
  keyId: string;
  teamId: string;
  privateKey: string; // contents of the .p8 key file
  bundleId: string;
}

interface PushEnv {
  DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_PRIVATE_KEY?: string;
  APNS_BUNDLE_ID?: string;
}

let apnsConfig: ApnsConfig | null = null;
let pushDatabase: { url: string; authToken?: string } | null = null;
let apnsJwtCache: { token: string; issuedAt: number; keyId: string } | null = null;

/** Reads the APNs credentials from the Worker environment. Called at the start of each request. */
export function configurePush(env: PushEnv): void {
  pushDatabase = env.DATABASE_URL ? { url: env.DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN } : null;
  if (env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_PRIVATE_KEY && env.APNS_BUNDLE_ID) {
    apnsConfig = {
      keyId: env.APNS_KEY_ID,
      teamId: env.APNS_TEAM_ID,
      privateKey: env.APNS_PRIVATE_KEY,
      bundleId: env.APNS_BUNDLE_ID,
    };
  } else {
    apnsConfig = null;
  }
}

export function apnsEndpoint(environment: ApnsEnvironment, deviceToken: string): string {
  return `${APNS_ENDPOINT_PREFIX}${environment}:${deviceToken}`;
}

async function importApnsKey(pem: string): Promise<CryptoKey> {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\\n/g, '')
    .replace(/\s+/g, '');
  const der = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

// APNs provider tokens are valid for an hour and must not be refreshed more than every 20 minutes
async function getApnsJwt(config: ApnsConfig): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (apnsJwtCache && apnsJwtCache.keyId === config.keyId && now - apnsJwtCache.issuedAt < 50 * 60) {
    return apnsJwtCache.token;
  }
  const header = { alg: 'ES256', kid: config.keyId };
  const claims = { iss: config.teamId, iat: now };
  const unsignedToken = `${uint8ArrayToBase64Url(new TextEncoder().encode(JSON.stringify(header)))}.${uint8ArrayToBase64Url(new TextEncoder().encode(JSON.stringify(claims)))}`;
  const key = await importApnsKey(config.privateKey);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsignedToken));
  const token = `${unsignedToken}.${uint8ArrayToBase64Url(derToRaw(new Uint8Array(signature)))}`;
  apnsJwtCache = { token, issuedAt: now, keyId: config.keyId };
  return token;
}

/** True when the Worker has the four APNS_* secrets (without them no iPhone gets notifications). */
export function isApnsConfigured(): boolean {
  return apnsConfig !== null;
}

/** The apns-topic the Worker sends (APNS_BUNDLE_ID); it must equal the app's bundle identifier. */
export function apnsTopic(): string | null {
  return apnsConfig?.bundleId ?? null;
}

/** Outcome of one delivery attempt (reason: APNs "reason" such as BadDeviceToken, or our own code). */
export interface PushSendResult {
  ok: boolean;
  status?: number;
  reason?: string;
  /** The device was removed because Apple says its token will never work again. */
  removed?: boolean;
  /** APNs environment the notification finally went to (it may differ from the registered one). */
  environment?: ApnsEnvironment;
}

function apnsReason(responseText: string): string {
  try {
    const reason = JSON.parse(responseText)?.reason;
    if (typeof reason === 'string' && reason) return reason;
  } catch {
    /* not JSON */
  }
  return responseText.slice(0, 120) || 'Unknown';
}

/**
 * APNs answers 410 (Unregistered) when the app was uninstalled or the token rotated, and 400
 * BadDeviceToken for tokens that are not valid in that environment: those device tokens will
 * never work again. (DeviceTokenNotForTopic usually means APNS_BUNDLE_ID is wrong on the server,
 * so the device is kept and the error is reported instead.)
 */
export function isDeadApnsToken(status: number, responseText: string): boolean {
  if (status === 410) return true;
  if (status !== 400) return false;
  return apnsReason(responseText).includes('BadDeviceToken');
}

function storageForPush(): WorkerStorage | null {
  if (!pushDatabase) return null;
  try {
    return new WorkerStorage(createDb(pushDatabase.url, pushDatabase.authToken));
  } catch (error) {
    console.error('[APNS] Could not open the database:', error);
    return null;
  }
}

async function deleteDeadSubscription(endpoint: string): Promise<void> {
  const storage = storageForPush();
  if (!storage) return;
  try {
    await storage.deletePushSubscriptionByEndpoint(endpoint);
    console.log(`[APNS] Removed dead device token ${endpoint.slice(0, 24)}...`);
  } catch (error) {
    console.error('[APNS] Could not remove dead device token:', error);
  }
}

/** Keeps the last APNs error of a device for GET /api/push/status (best effort). */
async function recordDeliveryError(endpoint: string, status: number | null, reason: string): Promise<void> {
  const storage = storageForPush();
  if (!storage) return;
  try {
    await storage.recordPushError(endpoint, status, reason);
  } catch (error) {
    console.error('[APNS] Could not record the delivery error:', error);
  }
}

async function postToApns(
  config: ApnsConfig,
  environment: ApnsEnvironment,
  deviceToken: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; text: string }> {
  const host = environment === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
  const response = await fetch(`https://${host}/3/device/${deviceToken}`, { method: 'POST', headers, body });
  if (response.status === 200) return { status: 200, text: '' };
  return { status: response.status, text: await response.text() };
}

async function sendApnsDetailed(endpoint: string, payload: PushNotificationPayload): Promise<PushSendResult> {
  if (!apnsConfig) {
    console.warn('[APNS] Not configured (APNS_KEY_ID / APNS_TEAM_ID / APNS_PRIVATE_KEY / APNS_BUNDLE_ID); skipping');
    return { ok: false, reason: 'ApnsNotConfigured' };
  }
  const config = apnsConfig;
  const [rawEnvironment, deviceToken] = endpoint.slice(APNS_ENDPOINT_PREFIX.length).split(':');
  if (!deviceToken) return { ok: false, reason: 'InvalidEndpoint' };
  const environment: ApnsEnvironment = rawEnvironment === 'sandbox' ? 'sandbox' : 'production';

  try {
    const jwt = await getApnsJwt(config);
    const body = JSON.stringify({
      aps: {
        alert: { title: payload.title, body: payload.body },
        sound: 'default',
        ...(payload.tag ? { 'thread-id': payload.tag } : {}),
      },
      type: payload.data?.type ?? null,
      data: payload.data ?? null,
    });
    const headers: Record<string, string> = {
      authorization: `bearer ${jwt}`,
      'apns-topic': config.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor(Date.now() / 1000) + 24 * 60 * 60),
      'content-type': 'application/json',
    };
    if (payload.tag && new TextEncoder().encode(payload.tag).length <= 64) {
      headers['apns-collapse-id'] = payload.tag;
    }

    const first = await postToApns(config, environment, deviceToken, headers, body);
    if (first.status === 200) return { ok: true, status: 200, environment };
    const reason = apnsReason(first.text);
    console.error(`[APNS] ❌ ${first.status} ${first.text} (${environment})`);

    // A token registered with the wrong environment (e.g. a TestFlight build that reported
    // "sandbox"): Apple rejects it as BadDeviceToken. Try the other environment once and, if it
    // works, move the device there so the next notifications go straight to it.
    if (first.status === 400 && reason === 'BadDeviceToken') {
      const other: ApnsEnvironment = environment === 'sandbox' ? 'production' : 'sandbox';
      const second = await postToApns(config, other, deviceToken, headers, body);
      if (second.status === 200) {
        console.log(`[APNS] Device token works on ${other}: moving it from ${environment}`);
        const storage = storageForPush();
        if (storage) {
          try {
            await storage.movePushSubscriptionEndpoint(endpoint, apnsEndpoint(other, deviceToken));
          } catch (error) {
            console.error('[APNS] Could not move the device to the other environment:', error);
          }
        }
        return { ok: true, status: 200, environment: other };
      }
      console.error(`[APNS] ❌ ${second.status} ${second.text} (${other})`);
    }

    await recordDeliveryError(endpoint, first.status, reason);
    if (isDeadApnsToken(first.status, first.text)) {
      await deleteDeadSubscription(endpoint);
      return { ok: false, status: first.status, reason, removed: true, environment };
    }
    return { ok: false, status: first.status, reason, environment };
  } catch (error) {
    console.error('[APNS] Error sending notification:', error);
    const reason = `Network: ${String((error as Error)?.message ?? error).slice(0, 100)}`;
    await recordDeliveryError(endpoint, null, reason);
    return { ok: false, reason, environment };
  }
}

// ===== Main send function =====

/** Sends one notification and says why it failed, if it did (used by POST /api/push/test). */
export async function sendPushNotificationDetailed(
  subscription: PushSubscriptionData,
  payload: PushNotificationPayload,
  vapidPublicKey: string,
  vapidPrivateKey: string,
  vapidSubject: string
): Promise<PushSendResult> {
  if (subscription.endpoint.startsWith(APNS_ENDPOINT_PREFIX)) {
    return sendApnsDetailed(subscription.endpoint, payload);
  }
  if (!vapidPublicKey || !vapidPrivateKey) {
    return { ok: false, reason: 'VapidNotConfigured' };
  }
  try {
    console.log(`[PUSH] Sending to endpoint: ${subscription.endpoint.substring(0, 80)}...`);

    const payloadString = JSON.stringify(payload);

    const { body: encryptedBody, serverPublicKey, salt } = await encryptPayload(
      payloadString,
      subscription.keys.p256dh,
      subscription.keys.auth
    );

    const url = new URL(subscription.endpoint);
    const audience = `${url.protocol}//${url.host}`;
    const jwt = await createVapidJwt(audience, vapidSubject, vapidPrivateKey);

    const response = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aesgcm',
        'Encryption': `salt=${uint8ArrayToBase64Url(salt)}`,
        'Crypto-Key': `dh=${uint8ArrayToBase64Url(serverPublicKey)};p256ecdsa=${vapidPublicKey}`,
        'Authorization': `WebPush ${jwt}`,
        'TTL': '86400',
        'Urgency': 'high',
      },
      body: encryptedBody,
    });

    if (response.status === 201 || response.status === 200) {
      console.log(`[PUSH] ✅ Success (${response.status})`);
      return { ok: true, status: response.status };
    }

    const responseText = await response.text();
    console.error(`[PUSH] ❌ Failed: ${response.status} - ${responseText}`);
    return { ok: false, status: response.status, reason: responseText.slice(0, 120) || `HTTP ${response.status}` };
  } catch (error) {
    console.error('[PUSH] Error sending notification:', error);
    return { ok: false, reason: `Network: ${String((error as Error)?.message ?? error).slice(0, 100)}` };
  }
}

export async function sendPushNotification(
  subscription: PushSubscriptionData,
  payload: PushNotificationPayload,
  vapidPublicKey: string,
  vapidPrivateKey: string,
  vapidSubject: string
): Promise<boolean> {
  const result = await sendPushNotificationDetailed(subscription, payload, vapidPublicKey, vapidPrivateKey, vapidSubject);
  return result.ok;
}

// Helper to send to multiple subscriptions
export async function sendPushToUser(
  subscriptions: PushSubscriptionData[],
  payload: PushNotificationPayload,
  vapidPublicKey: string,
  vapidPrivateKey: string,
  vapidSubject: string
): Promise<void> {
  const results = await Promise.allSettled(
    subscriptions.map((sub) =>
      sendPushNotification(sub, payload, vapidPublicKey, vapidPrivateKey, vapidSubject)
    )
  );
  const successes = results.filter((r) => r.status === 'fulfilled' && r.value).length;
  console.log(`[PUSH] Sent ${successes}/${subscriptions.length} notifications`);
}
