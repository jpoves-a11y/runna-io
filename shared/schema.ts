import { sql, relations } from "drizzle-orm";
import { sqliteTable, text, real, integer, primaryKey } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = sqliteTable("users", {
  id: text("id").primaryKey().default(sql`(lower(hex(randomblob(16))))`),
  username: text("username").notNull().unique(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  password: text("password").notNull().default(''), // Hashed password (empty for legacy users)
  color: text("color").notNull(), // Hex color for territory visualization
  avatar: text("avatar"), // Avatar URL or placeholder
  totalArea: real("total_area").notNull().default(0), // Total m² conquered
  emailVerified: integer("email_verified", { mode: 'boolean' }).notNull().default(false),
  verificationCode: text("verification_code"), // 6-digit code
  verificationCodeExpiresAt: text("verification_code_expires_at"), // ISO timestamp
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const routes = sqliteTable("routes", {
  id: text("id").primaryKey().default(sql`(lower(hex(randomblob(16))))`),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text("name").notNull(),
  coordinates: text("coordinates").notNull(), // JSON string of Array<[number, number]>
  distance: real("distance").notNull(), // meters
  duration: integer("duration").notNull(), // seconds
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at").notNull(),
  ranTogetherWith: text("ran_together_with"), // JSON array of user IDs who ran together
});

export const territories = sqliteTable("territories", {
  id: text("id").primaryKey().default(sql`(lower(hex(randomblob(16))))`),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  routeId: text("route_id").references(() => routes.id, { onDelete: 'set null' }),
  geometry: text("geometry").notNull(), // JSON string of GeoJSON polygon
  area: real("area").notNull(), // square meters
  conqueredAt: text("conquered_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const conquestMetrics = sqliteTable("conquest_metrics", {
  id: text("id").primaryKey().default(sql`(lower(hex(randomblob(16))))`),
  attackerId: text("attacker_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  defenderId: text("defender_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  areaStolen: real("area_stolen").notNull(), // square meters
  routeId: text("route_id").references(() => routes.id, { onDelete: 'set null' }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const friendships = sqliteTable("friendships", {
  id: text("id").primaryKey().default(sql`(lower(hex(randomblob(16))))`),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  friendId: text("friend_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const friendInvites = sqliteTable("friend_invites", {
  id: text("id").primaryKey().default(sql`(lower(hex(randomblob(16))))`),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  token: text("token").notNull().unique(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  expiresAt: text("expires_at").notNull(),
});

export const friendRequests = sqliteTable("friend_requests", {
  id: text("id").primaryKey().default(sql`(lower(hex(randomblob(16))))`),
  senderId: text("sender_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  recipientId: text("recipient_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: text("status").notNull().default('pending'), // pending, accepted, rejected
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const pushSubscriptions = sqliteTable("push_subscriptions", {
  id: text("id").primaryKey().default(sql`(lower(hex(randomblob(16))))`),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Polar Integration Tables
export const polarAccounts = sqliteTable("polar_accounts", {
  id: text("id").primaryKey().default(sql`(lower(hex(randomblob(16))))`),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }).unique(),
  polarUserId: integer("polar_user_id").notNull().unique(),
  accessToken: text("access_token").notNull(),
  memberId: text("member_id"),
  registeredAt: text("registered_at").default(sql`CURRENT_TIMESTAMP`),
  lastSyncAt: text("last_sync_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const polarActivities = sqliteTable("polar_activities", {
  id: text("id").primaryKey().default(sql`(lower(hex(randomblob(16))))`),
  polarExerciseId: text("polar_exercise_id").notNull().unique(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  routeId: text("route_id").references(() => routes.id, { onDelete: 'set null' }),
  territoryId: text("territory_id").references(() => territories.id, { onDelete: 'set null' }),
  name: text("name").notNull(),
  activityType: text("activity_type").notNull(),
  distance: real("distance").notNull(),
  duration: integer("duration").notNull(),
  startDate: text("start_date").notNull(),
  summaryPolyline: text("summary_polyline"),
  processed: integer("processed").notNull().default(0),
  processedAt: text("processed_at"),
  skipReason: text("skip_reason"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Strava Integration Tables
export const stravaAccounts = sqliteTable("strava_accounts", {
  id: text("id").primaryKey().default(sql`(lower(hex(randomblob(16))))`),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }).unique(),
  stravaAthleteId: integer("strava_athlete_id").notNull().unique(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  expiresAt: text("expires_at").notNull(),
  scope: text("scope").notNull(),
  athleteData: text("athlete_data"), // JSON string of athlete profile
  lastSyncAt: text("last_sync_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const stravaActivities = sqliteTable("strava_activities", {
  id: text("id").primaryKey().default(sql`(lower(hex(randomblob(16))))`),
  stravaActivityId: integer("strava_activity_id").notNull().unique(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  routeId: text("route_id").references(() => routes.id, { onDelete: 'set null' }),
  territoryId: text("territory_id").references(() => territories.id, { onDelete: 'set null' }),
  name: text("name").notNull(),
  activityType: text("activity_type").notNull(), // Run, Walk, etc.
  distance: real("distance").notNull(), // meters
  duration: integer("duration").notNull(), // seconds (moving_time)
  startDate: text("start_date").notNull(),
  summaryPolyline: text("summary_polyline"), // Encoded polyline from Strava
  processed: integer("processed").notNull().default(0),
  processedAt: text("processed_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// COROS Integration Tables
export const corosAccounts = sqliteTable("coros_accounts", {
  id: text("id").primaryKey().default(sql`(lower(hex(randomblob(16))))`),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }).unique(),
  corosOpenId: text("coros_open_id").notNull().unique(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token"),
  expiresAt: text("expires_at"),
  lastSyncAt: text("last_sync_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const corosActivities = sqliteTable("coros_activities", {
  id: text("id").primaryKey().default(sql`(lower(hex(randomblob(16))))`),
  corosWorkoutId: text("coros_workout_id").notNull().unique(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  routeId: text("route_id").references(() => routes.id, { onDelete: 'set null' }),
  territoryId: text("territory_id").references(() => territories.id, { onDelete: 'set null' }),
  name: text("name").notNull(),
  activityType: text("activity_type").notNull(), // Run, Trail Run, etc.
  distance: real("distance").notNull(), // meters
  duration: integer("duration").notNull(), // seconds
  startDate: text("start_date").notNull(),
  summaryPolyline: text("summary_polyline"), // GPS track
  processed: integer("processed").notNull().default(0),
  processedAt: text("processed_at"),
  skipReason: text("skip_reason"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Ephemeral photos (one-time viewable taunt photos)
export const ephemeralPhotos = sqliteTable("ephemeral_photos", {
  id: text("id").primaryKey().default(sql`(lower(hex(randomblob(16))))`),
  senderId: text("sender_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  recipientId: text("recipient_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  photoData: text("photo_data").notNull(), // base64 compressed JPEG
  message: text("message"), // optional short message
  areaStolen: real("area_stolen"), // context: how much was stolen
  viewed: integer("viewed", { mode: 'boolean' }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  expiresAt: text("expires_at").notNull(), // auto-delete after 24h
});

// Email notifications tables
export const emailNotifications = sqliteTable("email_notifications", {
  id: text("id").primaryKey().default(sql`(lower(hex(randomblob(16))))`),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  notificationType: text("notification_type").notNull(), // 'friend_request', 'friend_accepted', 'territory_conquered'
  relatedUserId: text("related_user_id").references(() => users.id, { onDelete: 'set null' }),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  areaStolen: real("area_stolen"), // for territory_conquered type
  emailSentAt: text("email_sent_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  openedAt: text("opened_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const emailPreferences = sqliteTable("email_preferences", {
  id: text("id").primaryKey().default(sql`(lower(hex(randomblob(16))))`),
  userId: text("user_id").notNull().unique().references(() => users.id, { onDelete: 'cascade' }),
  friendRequestNotifications: integer("friend_request_notifications").notNull().default(1),
  friendAcceptedNotifications: integer("friend_accepted_notifications").notNull().default(1),
  territoryConqueredNotifications: integer("territory_conquered_notifications").notNull().default(1),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Inactivity Reminders Table (tracks sent push reminders for users inactive 2+ days)
export const inactivityReminders = sqliteTable("inactivity_reminders", {
  id: text("id").primaryKey().default(sql`(lower(hex(randomblob(16))))`),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  messageIndex: integer("message_index").notNull(), // Index in the INACTIVITY_REMINDER_MESSAGES array
  sentAt: text("sent_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Territory loss notification tracking (avoid repeating the same message back-to-back)
export const territoryLossNotifications = sqliteTable("territory_loss_notifications", {
  id: text("id").primaryKey().default(sql`(lower(hex(randomblob(16))))`),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  messageIndex: integer("message_index").notNull(), // Index in the TERRITORY_LOSS_MESSAGES array
  sentAt: text("sent_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Social Feed Tables
export const feedEvents = sqliteTable("feed_events", {
  id: text("id").primaryKey().default(sql`(lower(hex(randomblob(16))))`),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  eventType: text("event_type").notNull(), // 'activity' | 'territory_stolen' | 'personal_record' | 'ran_together' | 'treasure_found'
  routeId: text("route_id").references(() => routes.id, { onDelete: 'set null' }),
  victimId: text("victim_id").references(() => users.id, { onDelete: 'set null' }),
  areaStolen: real("area_stolen"), // m² stolen from victim
  distance: real("distance"), // meters
  duration: integer("duration"), // seconds
  newArea: real("new_area"), // m² of new territory
  ranTogetherWith: text("ran_together_with"), // JSON array of { id, name }
  recordType: text("record_type"), // 'longest_run' | 'fastest_pace' | 'biggest_conquest'
  recordValue: real("record_value"),
  metadata: text("metadata"), // JSON string for extra event-specific data (e.g. treasure info)
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const feedComments = sqliteTable("feed_comments", {
  id: text("id").primaryKey().default(sql`(lower(hex(randomblob(16))))`),
  feedEventId: text("feed_event_id").notNull().references(() => feedEvents.id, { onDelete: 'cascade' }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  parentId: text("parent_id"), // NULL for top-level, comment id for replies (1 level)
  content: text("content").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Feed reactions (likes/dislikes for events and comments)
export const feedReactions = sqliteTable("feed_reactions", {
  id: text("id").primaryKey().default(sql`(lower(hex(randomblob(16))))`),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  targetType: text("target_type").notNull(), // 'event' | 'comment'
  targetId: text("target_id").notNull(), // feed_event.id or feed_comment.id
  reactionType: text("reaction_type").notNull(), // 'like' | 'dislike'
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ============ COMPETITION SYSTEM ============

export const competitions = sqliteTable("competitions", {
  id: text("id").primaryKey().default(sql`(lower(hex(randomblob(16))))`),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  startsAt: text("starts_at").notNull(), // ISO timestamp
  endsAt: text("ends_at").notNull(), // ISO timestamp
  status: text("status").notNull().default('upcoming'), // 'upcoming' | 'active' | 'finished'
  config: text("config"), // JSON config (treasure spawn settings, etc.)
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const treasures = sqliteTable("treasures", {
  id: text("id").primaryKey().default(sql`(lower(hex(randomblob(16))))`),
  competitionId: text("competition_id").notNull(),
  name: text("name").notNull(),
  powerType: text("power_type").notNull(), // 'shield' | 'double_area' | 'nickname' | 'steal_boost' | 'invisibility' | 'time_bomb' | 'magnet' | 'reveal'
  rarity: text("rarity").notNull(), // 'common' | 'rare' | 'epic' | 'legendary'
  lat: real("lat").notNull(),
  lng: real("lng").notNull(),
  collectedBy: text("collected_by").references(() => users.id, { onDelete: 'set null' }),
  collectedAt: text("collected_at"),
  spawnedAt: text("spawned_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  expiresAt: text("expires_at").notNull(), // Treasure disappears after this
  active: integer("active", { mode: 'boolean' }).notNull().default(true),
});

export const userPowers = sqliteTable("user_powers", {
  id: text("id").primaryKey().default(sql`(lower(hex(randomblob(16))))`),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  competitionId: text("competition_id").notNull(),
  powerType: text("power_type").notNull(),
  treasureId: text("treasure_id").notNull(),
  status: text("status").notNull().default('available'), // 'available' | 'active' | 'used' | 'expired'
  activatedAt: text("activated_at"),
  usedAt: text("used_at"),
  expiresAt: text("expires_at"), // For time-limited powers once activated
  metadata: text("metadata"), // JSON — e.g. { targetUserId, nickname } for 'nickname' power
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const competitionStats = sqliteTable("competition_stats", {
  id: text("id").primaryKey().default(sql`(lower(hex(randomblob(16))))`),
  competitionId: text("competition_id").notNull(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  totalArea: real("total_area").notNull().default(0),
  totalDistance: real("total_distance").notNull().default(0),
  totalDuration: integer("total_duration").notNull().default(0),
  activitiesCount: integer("activities_count").notNull().default(0),
  treasuresCollected: integer("treasures_collected").notNull().default(0),
  areaStolen: real("area_stolen").notNull().default(0),
  uniqueVictims: integer("unique_victims").notNull().default(0),
  ranTogetherCount: integer("ran_together_count").notNull().default(0),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const weeklySummaries = sqliteTable("weekly_summaries", {
  id: text("id").primaryKey().default(sql`(lower(hex(randomblob(16))))`),
  competitionId: text("competition_id").notNull(),
  weekNumber: integer("week_number").notNull(),
  data: text("data").notNull(), // JSON with rankings per category
  generatedAt: text("generated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const userNicknames = sqliteTable("user_nicknames", {
  id: text("id").primaryKey().default(sql`(lower(hex(randomblob(16))))`),
  targetUserId: text("target_user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  setByUserId: text("set_by_user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  nickname: text("nickname").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const territoryFortifications = sqliteTable("territory_fortifications", {
  id: text("id").primaryKey().default(sql`(lower(hex(randomblob(16))))`),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  routeId: text("route_id").references(() => routes.id, { onDelete: 'cascade' }),
  geometry: text("geometry").notNull(), // GeoJSON of the overlap zone
  area: real("area").notNull().default(0),
  bboxMinLng: real("bbox_min_lng"),
  bboxMinLat: real("bbox_min_lat"),
  bboxMaxLng: real("bbox_max_lng"),
  bboxMaxLat: real("bbox_max_lat"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Relations
export const usersRelations = relations(users, ({ many, one }) => ({
  routes: many(routes),
  territories: many(territories),
  friendships: many(friendships),
  friendInvites: many(friendInvites),
  polarAccount: one(polarAccounts),
  polarActivities: many(polarActivities),
  stravaAccount: one(stravaAccounts),
  stravaActivities: many(stravaActivities),
  feedEvents: many(feedEvents),
  feedComments: many(feedComments),
  inactivityReminders: many(inactivityReminders),
  territoryLossNotifications: many(territoryLossNotifications),
}));

export const polarAccountsRelations = relations(polarAccounts, ({ one }) => ({
  user: one(users, {
    fields: [polarAccounts.userId],
    references: [users.id],
  }),
}));

export const polarActivitiesRelations = relations(polarActivities, ({ one }) => ({
  user: one(users, {
    fields: [polarActivities.userId],
    references: [users.id],
  }),
  route: one(routes, {
    fields: [polarActivities.routeId],
    references: [routes.id],
  }),
  territory: one(territories, {
    fields: [polarActivities.territoryId],
    references: [territories.id],
  }),
}));

export const routesRelations = relations(routes, ({ one, many }) => ({
  user: one(users, {
    fields: [routes.userId],
    references: [users.id],
  }),
  territories: many(territories),
}));

export const territoriesRelations = relations(territories, ({ one }) => ({
  user: one(users, {
    fields: [territories.userId],
    references: [users.id],
  }),
  route: one(routes, {
    fields: [territories.routeId],
    references: [routes.id],
  }),
}));

export const conquestMetricsRelations = relations(conquestMetrics, ({ one }) => ({
  attacker: one(users, {
    fields: [conquestMetrics.attackerId],
    references: [users.id],
  }),
  defender: one(users, {
    fields: [conquestMetrics.defenderId],
    references: [users.id],
  }),
  route: one(routes, {
    fields: [conquestMetrics.routeId],
    references: [routes.id],
  }),
}));

export const friendshipsRelations = relations(friendships, ({ one }) => ({
  user: one(users, {
    fields: [friendships.userId],
    references: [users.id],
  }),
  friend: one(users, {
    fields: [friendships.friendId],
    references: [users.id],
  }),
}));

export const friendInvitesRelations = relations(friendInvites, ({ one }) => ({
  user: one(users, {
    fields: [friendInvites.userId],
    references: [users.id],
  }),
}));

export const stravaAccountsRelations = relations(stravaAccounts, ({ one }) => ({
  user: one(users, {
    fields: [stravaAccounts.userId],
    references: [users.id],
  }),
}));

export const stravaActivitiesRelations = relations(stravaActivities, ({ one }) => ({
  user: one(users, {
    fields: [stravaActivities.userId],
    references: [users.id],
  }),
  route: one(routes, {
    fields: [stravaActivities.routeId],
    references: [routes.id],
  }),
  territory: one(territories, {
    fields: [stravaActivities.territoryId],
    references: [territories.id],
  }),
}));

export const inactivityRemindersRelations = relations(inactivityReminders, ({ one }) => ({
  user: one(users, {
    fields: [inactivityReminders.userId],
    references: [users.id],
  }),
}));

export const territoryLossNotificationsRelations = relations(territoryLossNotifications, ({ one }) => ({
  user: one(users, {
    fields: [territoryLossNotifications.userId],
    references: [users.id],
  }),
}));

export const feedEventsRelations = relations(feedEvents, ({ one, many }) => ({
  user: one(users, {
    fields: [feedEvents.userId],
    references: [users.id],
  }),
  route: one(routes, {
    fields: [feedEvents.routeId],
    references: [routes.id],
  }),
  victim: one(users, {
    fields: [feedEvents.victimId],
    references: [users.id],
  }),
  comments: many(feedComments),
}));

export const feedCommentsRelations = relations(feedComments, ({ one }) => ({
  feedEvent: one(feedEvents, {
    fields: [feedComments.feedEventId],
    references: [feedEvents.id],
  }),
  user: one(users, {
    fields: [feedComments.userId],
    references: [users.id],
  }),
}));

// Insert Schemas
export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  totalArea: true,
  createdAt: true,
});

export const insertRouteSchema = createInsertSchema(routes).omit({
  id: true,
});

export const insertTerritorySchema = createInsertSchema(territories).omit({
  id: true,
  conqueredAt: true,
});

export const insertFriendshipSchema = createInsertSchema(friendships).omit({
  id: true,
  createdAt: true,
});

export const insertFriendInviteSchema = createInsertSchema(friendInvites).omit({
  id: true,
  createdAt: true,
});

export const insertFriendRequestSchema = createInsertSchema(friendRequests).omit({
  id: true,
  createdAt: true,
  status: true,
});

export const insertPolarAccountSchema = createInsertSchema(polarAccounts).omit({
  id: true,
  createdAt: true,
});

export const insertPolarActivitySchema = createInsertSchema(polarActivities).omit({
  id: true,
  createdAt: true,
});

export const insertStravaAccountSchema = createInsertSchema(stravaAccounts).omit({
  id: true,
  createdAt: true,
});

export const insertStravaActivitySchema = createInsertSchema(stravaActivities).omit({
  id: true,
  createdAt: true,
});

export const insertCorosAccountSchema = createInsertSchema(corosAccounts).omit({
  id: true,
  createdAt: true,
});

export const insertCorosActivitySchema = createInsertSchema(corosActivities).omit({
  id: true,
  createdAt: true,
});

export const insertPushSubscriptionSchema = createInsertSchema(pushSubscriptions).omit({
  id: true,
  createdAt: true,
});

export const insertFeedEventSchema = createInsertSchema(feedEvents).omit({
  id: true,
  createdAt: true,
});

export const insertFeedCommentSchema = createInsertSchema(feedComments).omit({
  id: true,
  createdAt: true,
});

export const insertFeedReactionSchema = createInsertSchema(feedReactions).omit({
  id: true,
  createdAt: true,
});

export const insertConquestMetricSchema = createInsertSchema(conquestMetrics).omit({
  id: true,
  createdAt: true,
});

export const insertEphemeralPhotoSchema = createInsertSchema(ephemeralPhotos).omit({
  id: true,
  createdAt: true,
  viewed: true,
});

export const insertInactivityReminderSchema = createInsertSchema(inactivityReminders).omit({
  id: true,
  sentAt: true,
});

export const insertTerritoryLossNotificationSchema = createInsertSchema(territoryLossNotifications).omit({
  id: true,
  sentAt: true,
});

// Competition insert schemas
export const insertCompetitionSchema = createInsertSchema(competitions).omit({
  id: true,
  createdAt: true,
  status: true,
});

export const insertTreasureSchema = createInsertSchema(treasures).omit({
  id: true,
  collectedBy: true,
  collectedAt: true,
  active: true,
});

export const insertUserPowerSchema = createInsertSchema(userPowers).omit({
  id: true,
  createdAt: true,
  status: true,
  activatedAt: true,
  usedAt: true,
});

export const insertCompetitionStatsSchema = createInsertSchema(competitionStats).omit({
  id: true,
  updatedAt: true,
});

export const insertWeeklySummarySchema = createInsertSchema(weeklySummaries).omit({
  id: true,
  generatedAt: true,
});

export const insertUserNicknameSchema = createInsertSchema(userNicknames).omit({
  id: true,
  createdAt: true,
});

export const insertTerritoryFortificationSchema = createInsertSchema(territoryFortifications).omit({
  id: true,
  createdAt: true,
});

// Types
export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;

export type Route = typeof routes.$inferSelect;
export type InsertRoute = z.infer<typeof insertRouteSchema>;

export type Territory = typeof territories.$inferSelect;
export type InsertTerritory = z.infer<typeof insertTerritorySchema>;

export type Friendship = typeof friendships.$inferSelect;
export type InsertFriendship = z.infer<typeof insertFriendshipSchema>;

export type FriendInvite = typeof friendInvites.$inferSelect;
export type InsertFriendInvite = z.infer<typeof insertFriendInviteSchema>;

export type FriendRequest = typeof friendRequests.$inferSelect;
export type InsertFriendRequest = z.infer<typeof insertFriendRequestSchema>;

export type PolarAccount = typeof polarAccounts.$inferSelect;
export type InsertPolarAccount = z.infer<typeof insertPolarAccountSchema>;

export type PolarActivity = typeof polarActivities.$inferSelect;
export type InsertPolarActivity = z.infer<typeof insertPolarActivitySchema>;

export type StravaAccount = typeof stravaAccounts.$inferSelect;
export type InsertStravaAccount = z.infer<typeof insertStravaAccountSchema>;

export type StravaActivity = typeof stravaActivities.$inferSelect;
export type InsertStravaActivity = z.infer<typeof insertStravaActivitySchema>;

export type CorosAccount = typeof corosAccounts.$inferSelect;
export type InsertCorosAccount = z.infer<typeof insertCorosAccountSchema>;

export type CorosActivity = typeof corosActivities.$inferSelect;
export type InsertCorosActivity = z.infer<typeof insertCorosActivitySchema>;

export type PushSubscription = typeof pushSubscriptions.$inferSelect;
export type InsertPushSubscription = z.infer<typeof insertPushSubscriptionSchema>;

export type ConquestMetric = typeof conquestMetrics.$inferSelect;
export type InsertConquestMetric = z.infer<typeof insertConquestMetricSchema>;

export type EphemeralPhoto = typeof ephemeralPhotos.$inferSelect;
export type InsertEphemeralPhoto = z.infer<typeof insertEphemeralPhotoSchema>;

export type InactivityReminder = typeof inactivityReminders.$inferSelect;
export type InsertInactivityReminder = z.infer<typeof insertInactivityReminderSchema>;

export type TerritoryLossNotification = typeof territoryLossNotifications.$inferSelect;
export type InsertTerritoryLossNotification = z.infer<typeof insertTerritoryLossNotificationSchema>;

export type FeedEvent = typeof feedEvents.$inferSelect;
export type InsertFeedEvent = z.infer<typeof insertFeedEventSchema>;

export type FeedComment = typeof feedComments.$inferSelect;
export type InsertFeedComment = z.infer<typeof insertFeedCommentSchema>;

export type FeedReaction = typeof feedReactions.$inferSelect;
export type InsertFeedReaction = z.infer<typeof insertFeedReactionSchema>;

export type Competition = typeof competitions.$inferSelect;
export type InsertCompetition = z.infer<typeof insertCompetitionSchema>;

export type Treasure = typeof treasures.$inferSelect;
export type InsertTreasure = z.infer<typeof insertTreasureSchema>;

export type UserPower = typeof userPowers.$inferSelect;
export type InsertUserPower = z.infer<typeof insertUserPowerSchema>;

export type CompetitionStat = typeof competitionStats.$inferSelect;
export type InsertCompetitionStat = z.infer<typeof insertCompetitionStatsSchema>;

export type WeeklySummary = typeof weeklySummaries.$inferSelect;
export type InsertWeeklySummary = z.infer<typeof insertWeeklySummarySchema>;

export type UserNickname = typeof userNicknames.$inferSelect;
export type InsertUserNickname = z.infer<typeof insertUserNicknameSchema>;

export type TerritoryFortification = typeof territoryFortifications.$inferSelect;
export type InsertTerritoryFortification = z.infer<typeof insertTerritoryFortificationSchema>;

export type EmailNotification = typeof emailNotifications.$inferSelect;
export const insertEmailNotificationSchema = createInsertSchema(emailNotifications);
export type InsertEmailNotification = z.infer<typeof insertEmailNotificationSchema>;

export type EmailPreferences = typeof emailPreferences.$inferSelect;
export const insertEmailPreferencesSchema = createInsertSchema(emailPreferences);
export type InsertEmailPreferences = z.infer<typeof insertEmailPreferencesSchema>;

// Extended types for frontend
export type UserWithStats = User & {
  rank?: number;
  friendCount?: number;
};

export type TerritoryWithUser = Territory & {
  user: Pick<User, 'id' | 'username' | 'name' | 'color'>;
  ranTogetherWithColors?: Array<{ id: string; color: string }>;
};

export type RouteWithTerritory = Route & {
  territory?: Territory;
  ranTogetherWithUsers?: Array<{ id: string; name: string }>;
};

export type FeedEventWithDetails = FeedEvent & {
  user: Pick<User, 'id' | 'username' | 'name' | 'color' | 'avatar'>;
  victim?: Pick<User, 'id' | 'username' | 'name' | 'color' | 'avatar'> | null;
  routeName?: string | null;
  activityDate?: string | null;
  routeCoordinates?: [number, number][] | null;
  commentCount: number;
  likeCount: number;
  dislikeCount: number;
  userReaction: 'like' | 'dislike' | null;
};

export type FeedCommentWithUser = FeedComment & {
  user: Pick<User, 'id' | 'username' | 'name' | 'color' | 'avatar'>;
  replies?: FeedCommentWithUser[];
  likeCount: number;
  dislikeCount: number;
  userReaction: 'like' | 'dislike' | null;
};

// Competition extended types
export type TreasureRarity = 'common' | 'rare' | 'epic' | 'legendary';
export type TreasurePowerType = 'shield' | 'double_area' | 'nickname' | 'steal_boost' | 'invisibility' | 'time_bomb' | 'magnet' | 'reveal' | 'bulldozer' | 'battering_ram' | 'wall' | 'sentinel';
export type CompetitionStatus = 'upcoming' | 'active' | 'finished';
export type PowerStatus = 'available' | 'active' | 'used' | 'expired';

export interface TreasureDefinition {
  powerType: TreasurePowerType;
  name: string;
  description: string;
  rarity: TreasureRarity;
  emoji: string;
  color: string; // hex
  duration?: number; // hours the power lasts once activated, if applicable
}

export const TREASURE_DEFINITIONS: Record<TreasurePowerType, TreasureDefinition> = {
  shield: {
    powerType: 'shield',
    name: 'Escudo de Acero',
    description: 'Tu siguiente territorio es inmune a robos durante 24h',
    rarity: 'rare',
    emoji: '🛡️',
    color: '#7C8CA1',
    duration: 24,
  },
  double_area: {
    powerType: 'double_area',
    name: 'Doble Conquista',
    description: 'Los km² de tu siguiente ruta cuentan x2',
    rarity: 'epic',
    emoji: '⚡',
    color: '#F59E0B',
  },
  nickname: {
    powerType: 'nickname',
    name: 'Pluma del Troll',
    description: 'Pon un apodo público a otro usuario durante 48h',
    rarity: 'common',
    emoji: '✏️',
    color: '#CD7F32',
    duration: 48,
  },
  steal_boost: {
    powerType: 'steal_boost',
    name: 'Espada Voraz',
    description: 'Robas un 50% más de lo normal en tu siguiente ruta',
    rarity: 'epic',
    emoji: '⚔️',
    color: '#F59E0B',
  },
  invisibility: {
    powerType: 'invisibility',
    name: 'Capa de Sombras',
    description: 'Tu territorio es invisible en el mapa para otros durante 24h',
    rarity: 'legendary',
    emoji: '👻',
    color: '#8B5CF6',
    duration: 24,
  },
  time_bomb: {
    powerType: 'time_bomb',
    name: 'Bomba Temporal',
    description: 'El usuario que te robe en las próximas 24h pierde el doble',
    rarity: 'rare',
    emoji: '💣',
    color: '#7C8CA1',
    duration: 24,
  },
  magnet: {
    powerType: 'magnet',
    name: 'Imán de Tierras',
    description: 'Tu siguiente ruta absorbe un 25% extra de territorios en su radio',
    rarity: 'legendary',
    emoji: '🧲',
    color: '#8B5CF6',
  },
  reveal: {
    powerType: 'reveal',
    name: 'Ojo del Halcón',
    description: 'Revela la ubicación del siguiente tesoro 1h antes que los demás',
    rarity: 'common',
    emoji: '🦅',
    color: '#CD7F32',
  },
  bulldozer: {
    powerType: 'bulldozer',
    name: 'El Arrasador',
    description: 'Tu siguiente ruta ignora TODAS las fortalezas enemigas',
    rarity: 'epic',
    emoji: '🚜',
    color: '#F59E0B',
  },
  battering_ram: {
    powerType: 'battering_ram',
    name: 'Ariete de Guerra',
    description: 'Tu siguiente ruta tiene fuerza ×3: cada pasada rompe 3 capas de fortaleza',
    rarity: 'legendary',
    emoji: '🪓',
    color: '#8B5CF6',
  },
  wall: {
    powerType: 'wall',
    name: 'Muralla Imparable',
    description: 'Durante 24h, cada carrera fortalece el doble (+1.0 en vez de +0.5)',
    rarity: 'rare',
    emoji: '🧱',
    color: '#7C8CA1',
    duration: 24,
  },
  sentinel: {
    powerType: 'sentinel',
    name: 'Centinela',
    description: 'Durante 24h, recibes notificación instantánea cuando alguien intenta robar tu territorio',
    rarity: 'epic',
    emoji: '🔔',
    color: '#F59E0B',
    duration: 24,
  },
};

export const RARITY_CONFIG: Record<TreasureRarity, { label: string; color: string; bgGradient: string; probability: number }> = {
  common: { label: 'Común', color: '#CD7F32', bgGradient: 'from-amber-700 to-yellow-600', probability: 0.40 },
  rare: { label: 'Raro', color: '#7C8CA1', bgGradient: 'from-slate-400 to-blue-300', probability: 0.30 },
  epic: { label: 'Épico', color: '#F59E0B', bgGradient: 'from-amber-400 to-orange-500', probability: 0.20 },
  legendary: { label: 'Legendario', color: '#8B5CF6', bgGradient: 'from-violet-500 to-purple-600', probability: 0.10 },
};

// Zaragoza bounding box for treasure spawning (roads/land within city)
export const ZARAGOZA_BOUNDS = {
  north: 41.6800,
  south: 41.6100,
  east: -0.8300,
  west: -0.9400,
  center: { lat: 41.6488, lng: -0.8891 },
};

// Competition dates
export const COMPETITION_START = '2026-03-02T09:00:00+01:00';
export const COMPETITION_END = '2026-03-30T23:59:59+02:00';
export const COMPETITION_NAME = 'La Primera Conquista del Ebro';
export const COMPETITION_SLUG = 'la-primera-conquista-del-ebro';
