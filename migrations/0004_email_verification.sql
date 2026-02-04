-- Add email verification fields to users table
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN verification_code TEXT;
ALTER TABLE users ADD COLUMN verification_code_expires_at TEXT;
