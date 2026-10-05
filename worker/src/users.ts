// Shapes of user objects sent to clients.
// Database rows include the password hash, email and email verification code, which must never
// reach other users. The account owner can see their own email.

const PRIVATE_FIELDS = ['password', 'email', 'emailVerified', 'verificationCode', 'verificationCodeExpiresAt'] as const;
const SELF_HIDDEN_FIELDS = ['password', 'verificationCode', 'verificationCodeExpiresAt'] as const;

function omit<T extends object>(user: T, fields: readonly string[]): Partial<T> {
  const copy: Record<string, unknown> = { ...(user as Record<string, unknown>) };
  for (const field of fields) delete copy[field];
  return copy as Partial<T>;
}

/** A user as seen by other users. */
export function toPublicUser<T extends object>(user: T): Partial<T> {
  return omit(user, PRIVATE_FIELDS);
}

/** A user as seen by themselves (keeps email and verification status). */
export function toSelfUser<T extends object>(user: T): Partial<T> {
  return omit(user, SELF_HIDDEN_FIELDS);
}
