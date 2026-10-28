-- Sign-ups waiting for the 6-digit code emailed to the address (POST /api/auth/register/*).
-- The account is only created once the code is confirmed.
-- The Worker also applies this on demand (WorkerStorage.ensureSchemaUpgrades).
CREATE TABLE IF NOT EXISTS pending_signups (
  email TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  color TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
