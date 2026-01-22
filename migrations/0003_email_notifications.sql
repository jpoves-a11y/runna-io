-- Add email column to users table
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS email VARCHAR UNIQUE NOT NULL DEFAULT '';

-- Create email_notifications table
CREATE TABLE IF NOT EXISTS email_notifications (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR NOT NULL REFERENCES "users"(id) ON DELETE CASCADE,
  notification_type VARCHAR NOT NULL,
  related_user_id VARCHAR REFERENCES "users"(id) ON DELETE SET NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  area_stolen REAL,
  email_sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  opened_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create email_preferences table
CREATE TABLE IF NOT EXISTS email_preferences (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR NOT NULL UNIQUE REFERENCES "users"(id) ON DELETE CASCADE,
  friend_request_notifications BOOLEAN NOT NULL DEFAULT true,
  friend_accepted_notifications BOOLEAN NOT NULL DEFAULT true,
  territory_conquered_notifications BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes
CREATE INDEX IF NOT EXISTS email_notifications_user_idx ON email_notifications(user_id);
CREATE INDEX IF NOT EXISTS email_notifications_type_idx ON email_notifications(notification_type);
CREATE INDEX IF NOT EXISTS email_notifications_sent_at_idx ON email_notifications(email_sent_at);
CREATE INDEX IF NOT EXISTS email_preferences_user_idx ON email_preferences(user_id);
