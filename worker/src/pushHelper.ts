// Web Push helper for Cloudflare Workers
// Implements RFC 8291 (Message Encryption) and RFC 8292 (VAPID)
// Uses Web Crypto API (available in CF Workers)

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

// ===== Main send function =====

export async function sendPushNotification(
  subscription: PushSubscriptionData,
  payload: PushNotificationPayload,
  vapidPublicKey: string,
  vapidPrivateKey: string,
  vapidSubject: string
): Promise<boolean> {
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
      return true;
    }

    const responseText = await response.text();
    console.error(`[PUSH] ❌ Failed: ${response.status} - ${responseText}`);
    return false;
  } catch (error) {
    console.error('[PUSH] Error sending notification:', error);
    return false;
  }
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
