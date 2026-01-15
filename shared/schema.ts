import { sql, relations } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, real, jsonb, integer, boolean, bigint } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  name: text("name").notNull(),
  password: text("password").notNull().default(''), // Hashed password (empty for legacy users)
  color: text("color").notNull(), // Hex color for territory visualization
  avatar: text("avatar"), // Avatar URL or placeholder
  totalArea: real("total_area").notNull().default(0), // Total m² conquered
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const routes = pgTable("routes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text("name").notNull(),
  coordinates: jsonb("coordinates").notNull().$type<Array<[number, number]>>(), // Array of [lat, lng]
  distance: real("distance").notNull(), // meters
  duration: integer("duration").notNull(), // seconds
  startedAt: timestamp("started_at").notNull(),
  completedAt: timestamp("completed_at").notNull(),
});

export const territories = pgTable("territories", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  routeId: varchar("route_id").references(() => routes.id, { onDelete: 'cascade' }),
  geometry: jsonb("geometry").notNull().$type<any>(), // GeoJSON polygon
  area: real("area").notNull(), // square meters
  conqueredAt: timestamp("conquered_at").notNull().defaultNow(),
});

export const friendships = pgTable("friendships", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  friendId: varchar("friend_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const friendInvites = pgTable("friend_invites", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  token: varchar("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
});

export const friendRequests = pgTable("friend_requests", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  senderId: varchar("sender_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  recipientId: varchar("recipient_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: varchar("status").notNull().default('pending'), // pending, accepted, rejected
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const pushSubscriptions = pgTable("push_subscriptions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Polar Integration Tables
export const polarAccounts = pgTable("polar_accounts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }).unique(),
  polarUserId: bigint("polar_user_id", { mode: "number" }).notNull().unique(),
  accessToken: text("access_token").notNull(),
  memberId: text("member_id"),
  registeredAt: timestamp("registered_at").defaultNow(),
  lastSyncAt: timestamp("last_sync_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const polarActivities = pgTable("polar_activities", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  polarExerciseId: varchar("polar_exercise_id").notNull().unique(),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  routeId: varchar("route_id").references(() => routes.id, { onDelete: 'set null' }),
  territoryId: varchar("territory_id").references(() => territories.id, { onDelete: 'set null' }),
  name: text("name").notNull(),
  activityType: text("activity_type").notNull(),
  distance: real("distance").notNull(),
  duration: integer("duration").notNull(),
  startDate: timestamp("start_date").notNull(),
  summaryPolyline: text("summary_polyline"),
  processed: boolean("processed").notNull().default(false),
  processedAt: timestamp("processed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Strava Integration Tables
export const stravaAccounts = pgTable("strava_accounts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }).unique(),
  stravaAthleteId: bigint("strava_athlete_id", { mode: "number" }).notNull().unique(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  scope: text("scope").notNull(),
  athleteData: jsonb("athlete_data").$type<any>(), // Strava athlete profile
  lastSyncAt: timestamp("last_sync_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const stravaActivities = pgTable("strava_activities", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  stravaActivityId: bigint("strava_activity_id", { mode: "number" }).notNull().unique(),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  routeId: varchar("route_id").references(() => routes.id, { onDelete: 'set null' }),
  territoryId: varchar("territory_id").references(() => territories.id, { onDelete: 'set null' }),
  name: text("name").notNull(),
  activityType: text("activity_type").notNull(), // Run, Walk, etc.
  distance: real("distance").notNull(), // meters
  duration: integer("duration").notNull(), // seconds (moving_time)
  startDate: timestamp("start_date").notNull(),
  summaryPolyline: text("summary_polyline"), // Encoded polyline from Strava
  processed: boolean("processed").notNull().default(false),
  processedAt: timestamp("processed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
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

export const insertPushSubscriptionSchema = createInsertSchema(pushSubscriptions).omit({
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

export type PushSubscription = typeof pushSubscriptions.$inferSelect;
export type InsertPushSubscription = z.infer<typeof insertPushSubscriptionSchema>;

// Extended types for frontend
export type UserWithStats = User & {
  rank?: number;
  friendCount?: number;
};

export type TerritoryWithUser = Territory & {
  user: Pick<User, 'id' | 'username' | 'name' | 'color'>;
};

export type RouteWithTerritory = Route & {
  territory?: Territory;
};
