-- "Forgot password" codes (POST /api/auth/forgot-password and /api/auth/reset-password).
-- The Worker also creates this table on demand (WorkerStorage.ensureSchemaUpgrades).
CREATE TABLE IF NOT EXISTS password_resets (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
