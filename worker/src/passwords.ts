// Password hashing for user accounts.
//
// New hashes use PBKDF2-SHA256 with a random per-user salt:
//   pbkdf2$<iterations>$<salt base64>$<hash base64>
// Older accounts have an unsalted SHA-256 hex digest (password + fixed suffix).
// Those still verify, and `needsRehash` tells the caller to upgrade them after a successful login.

// Cloudflare Workers caps PBKDF2 at 100k iterations
const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const LEGACY_SUFFIX = 'runna_salt_2024';

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0));
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

async function legacyHash(password: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password + LEGACY_SUFFIX));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!stored) return false;

  if (stored.startsWith('pbkdf2$')) {
    const [, iterationsText, saltText, hashText] = stored.split('$');
    const iterations = Number(iterationsText);
    if (!Number.isInteger(iterations) || iterations <= 0 || !saltText || !hashText) return false;
    const expected = fromBase64(hashText);
    const actual = await pbkdf2(password, fromBase64(saltText), iterations);
    return constantTimeEqual(actual, expected);
  }

  const encoder = new TextEncoder();
  return constantTimeEqual(encoder.encode(await legacyHash(password)), encoder.encode(stored));
}

/** True for hashes in the old format, which should be replaced after the next successful login. */
export function needsRehash(stored: string): boolean {
  return !stored.startsWith(`pbkdf2$${PBKDF2_ITERATIONS}$`);
}
