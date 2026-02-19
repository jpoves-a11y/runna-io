-- Territory loss notifications: track last message sent to avoid repeats
CREATE TABLE IF NOT EXISTS territory_loss_notifications (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_index INTEGER NOT NULL,
  sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Index for fast lookup by user
CREATE INDEX IF NOT EXISTS idx_territory_loss_notifications_user_id ON territory_loss_notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_territory_loss_notifications_sent_at ON territory_loss_notifications(sent_at);
