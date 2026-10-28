/**
 * Limits on failed sign-in and code attempts, kept in the database (auth_attempts) so every
 * Worker isolate sees the same counts. Each key ("login:account:<id>", "login:ip:<ip>", ...)
 * counts attempts in a fixed window; reaching the maximum locks the key for a while.
 * A database error never blocks a sign-in: the limiter logs it and lets the request through.
 */
import type { Context } from 'hono';
import type { WorkerStorage } from './storage';

export interface AttemptLimit {
  max: number;
  windowMs: number;
  lockMs: number;
}

const MINUTE = 60 * 1000;

export const LIMITS = {
  /** Wrong passwords for one account (high enough that a stranger can't easily lock someone out) */
  loginAccount: { max: 10, windowMs: 15 * MINUTE, lockMs: 15 * MINUTE },
  /** Wrong passwords from one IP address, whatever the account */
  loginIp: { max: 30, windowMs: 15 * MINUTE, lockMs: 15 * MINUTE },
  /** Wrong email verification codes for one account */
  verifyCode: { max: 5, windowMs: 15 * MINUTE, lockMs: 15 * MINUTE },
  /** "Forgot password" emails sent to one account */
  resetRequestAccount: { max: 3, windowMs: 60 * MINUTE, lockMs: 60 * MINUTE },
  /** "Forgot password" requests from one IP address */
  resetRequestIp: { max: 10, windowMs: 60 * MINUTE, lockMs: 60 * MINUTE },
  /** Sign-up codes emailed to one address (first one and resends) */
  signupEmail: { max: 4, windowMs: 60 * MINUTE, lockMs: 60 * MINUTE },
  /** Sign-up codes requested from one IP address, whatever the email */
  signupIp: { max: 10, windowMs: 60 * MINUTE, lockMs: 60 * MINUTE },
} satisfies Record<string, AttemptLimit>;

/** The caller's IP on Cloudflare; null elsewhere (local API), where IP limits are skipped. */
export function clientIp(c: Context<any>): string | null {
  return c.req.header('cf-connecting-ip') || null;
}

/** Seconds the key stays locked, or 0 when it may try again. */
export async function lockedForSeconds(storage: WorkerStorage, key: string, now = Date.now()): Promise<number> {
  try {
    const attempt = await storage.getAuthAttempt(key);
    if (!attempt?.lockedUntil || attempt.lockedUntil <= now) return 0;
    return Math.ceil((attempt.lockedUntil - now) / 1000);
  } catch (error) {
    console.error('[RATE LIMIT] Read failed:', error);
    return 0;
  }
}

/** Counts one attempt for the key and locks it when it reaches the limit. */
export async function recordAttempt(storage: WorkerStorage, key: string, limit: AttemptLimit, now = Date.now()): Promise<void> {
  try {
    const attempt = await storage.getAuthAttempt(key);
    const windowExpired = !attempt || now - attempt.windowStart >= limit.windowMs;
    const failures = windowExpired ? 1 : attempt.failures + 1;
    const windowStart = windowExpired ? now : attempt.windowStart;
    const lockedUntil = failures >= limit.max ? now + limit.lockMs : null;
    await storage.saveAuthAttempt(key, failures, windowStart, lockedUntil);
  } catch (error) {
    console.error('[RATE LIMIT] Write failed:', error);
  }
}

export async function clearAttempts(storage: WorkerStorage, key: string): Promise<void> {
  try {
    await storage.deleteAuthAttempt(key);
  } catch (error) {
    console.error('[RATE LIMIT] Clear failed:', error);
  }
}

/** 429 with Retry-After and a message the app shows as is. */
export function tooManyAttempts(c: Context<any>, seconds: number) {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  c.header('Retry-After', String(seconds));
  return c.json(
    { error: `Demasiados intentos. Vuelve a intentarlo dentro de ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}.` },
    429,
  );
}
