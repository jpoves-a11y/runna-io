-- Indexes for the per-user lookups behind the app's main tabs (map, ranking, activity, friends, profile).
-- The Worker also creates them at runtime (WorkerStorage.ensureReadPathIndexes), so applying this by hand is optional.
CREATE INDEX IF NOT EXISTS idx_routes_user_completed ON routes(user_id, completed_at);
CREATE INDEX IF NOT EXISTS idx_territories_user ON territories(user_id);
CREATE INDEX IF NOT EXISTS idx_territories_route ON territories(route_id);
CREATE INDEX IF NOT EXISTS idx_friendships_user ON friendships(user_id);
CREATE INDEX IF NOT EXISTS idx_friendships_friend ON friendships(friend_id);
CREATE INDEX IF NOT EXISTS idx_friend_requests_recipient ON friend_requests(recipient_id, status);
CREATE INDEX IF NOT EXISTS idx_friend_requests_sender ON friend_requests(sender_id, status);
CREATE INDEX IF NOT EXISTS idx_feed_events_user_created ON feed_events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_feed_comments_event ON feed_comments(feed_event_id);
CREATE INDEX IF NOT EXISTS idx_feed_reactions_target ON feed_reactions(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_user_nicknames_target ON user_nicknames(target_user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_user_powers_user_competition ON user_powers(user_id, competition_id);
CREATE INDEX IF NOT EXISTS idx_treasures_competition_active ON treasures(competition_id, active);
