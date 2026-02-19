-- Inactivity Reminders: tracks push notifications sent to users inactive for 2+ days
CREATE TABLE IF NOT EXISTS inactivity_reminders (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_index INTEGER NOT NULL,
  sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Index for fast lookups by user (get last reminder sent to a user)
CREATE INDEX IF NOT EXISTS idx_inactivity_reminders_user_id ON inactivity_reminders(user_id);
CREATE INDEX IF NOT EXISTS idx_inactivity_reminders_sent_at ON inactivity_reminders(sent_at);
