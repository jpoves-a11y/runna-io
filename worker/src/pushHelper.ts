// Web Push helper for Cloudflare Workers
// Based on web-push protocol (RFC 8291, RFC 8292)

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

export async function sendPushNotification(
  subscription: PushSubscriptionData,
  payload: PushNotificationPayload,
  vapidPublicKey: string,
  vapidPrivateKey: string,
  vapidSubject: string
): Promise<boolean> {
  try {
    const payloadString = JSON.stringify(payload);
    
    // Encrypt the payload
    const { encryptedPayload, salt, serverPublicKey } = await encryptPayload(
      payloadString,
      subscription.keys.p256dh,
      subscription.keys.auth
    );

    // Generate VAPID headers
    const vapidHeaders = await generateVAPIDHeaders(
      subscription.endpoint,
      vapidPublicKey,
      vapidPrivateKey,
      vapidSubject
    );

    // Send the push notification
    const response = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'Content-Length': encryptedPayload.byteLength.toString(),
        ...vapidHeaders,
      },
      body: encryptedPayload,
    });

    if (!response.ok) {
      console.error('Push notification failed:', response.status, await response.text());
      return false;
    }

    return true;
  } catch (error) {
    console.error('Error sending push notification:', error);
    return false;
  }
}

async function encryptPayload(
  payload: string,
  userPublicKey: string,
  userAuth: string
): Promise<{ encryptedPayload: ArrayBuffer; salt: Uint8Array; serverPublicKey: Uint8Array }> {
  // This is a simplified version - for production, use a proper web-push library
  // or implement full RFC 8291 encryption
  
  // Generate server key pair
  const serverKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );

  const salt = crypto.getRandomValues(new Uint8Array(16));
  
  // For now, return unencrypted (you'd need full ECDH + AES-GCM implementation)
  const encoder = new TextEncoder();
  const payloadBuffer = encoder.encode(payload);
  
  const serverPublicKeyExported = await crypto.subtle.exportKey('raw', serverKeyPair.publicKey);
  
  return {
    encryptedPayload: payloadBuffer,
    salt,
    serverPublicKey: new Uint8Array(serverPublicKeyExported),
  };
}

async function generateVAPIDHeaders(
  endpoint: string,
  publicKey: string,
  privateKey: string,
  subject: string
): Promise<Record<string, string>> {
  // Parse endpoint to get audience
  const url = new URL(endpoint);
  const audience = `${url.protocol}//${url.host}`;

  // Create JWT
  const header = {
    typ: 'JWT',
    alg: 'ES256',
  };

  const now = Math.floor(Date.now() / 1000);
  const claims = {
    aud: audience,
    exp: now + 12 * 60 * 60, // 12 hours
    sub: subject,
  };

  // For production, implement proper JWT signing with ES256
  // This is a placeholder - use a JWT library or implement ES256 signing
  const token = 'placeholder-jwt-token';

  return {
    'Authorization': `vapid t=${token}, k=${publicKey}`,
  };
}

// Helper to send to multiple subscriptions
export async function sendPushToUser(
  subscriptions: PushSubscriptionData[],
  payload: PushNotificationPayload,
  vapidPublicKey: string,
  vapidPrivateKey: string,
  vapidSubject: string
): Promise<void> {
  const promises = subscriptions.map((sub) =>
    sendPushNotification(sub, payload, vapidPublicKey, vapidPrivateKey, vapidSubject)
  );
  await Promise.all(promises);
}
