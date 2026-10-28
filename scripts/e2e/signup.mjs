// Creates e2e accounts through the real sign-up confirmation (POST /api/auth/register/confirm).
// The e2e server can't send email, so step 1 (/api/auth/register/start) is done here: the pending
// sign-up is written to the database with a code the test knows, hashed like worker/src/routes.ts.
import { createHash, pbkdf2Sync, randomBytes } from 'node:crypto';

export const E2E_PASSWORD = 'e2e-password';
const CODE = '123456';

/** Writes the pending sign-up and returns the body for POST /api/auth/register/confirm. */
export async function pendingSignup(db, { username, name = username, color = '#377EB8' }) {
  const email = `${username}@e2e.test`.toLowerCase();
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(E2E_PASSWORD, salt, 100_000, 32, 'sha256');
  const passwordHash = `pbkdf2$100000$${salt.toString('base64')}$${hash.toString('base64')}`;
  const codeHash = createHash('sha256').update(`signup:${email}:${CODE}`).digest('hex');
  await db.execute({
    sql: `INSERT OR REPLACE INTO pending_signups (email, username, name, password_hash, color, code_hash, expires_at, attempts)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    args: [email, username, name, passwordHash, color, codeHash, Date.now() + 15 * 60 * 1000],
  });
  return { email, code: CODE };
}
