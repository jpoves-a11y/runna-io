import * as turf from '@turf/turf';
import {
  users,
  routes,
  territories,
  friendships,
  friendInvites,
  friendRequests,
  pushSubscriptions,
  stravaAccounts,
  stravaActivities,
  polarAccounts,
  polarActivities,
  conquestMetrics,
  emailNotifications,
  emailPreferences,
  ephemeralPhotos,
  feedEvents,
  feedComments,
  inactivityReminders,
  territoryLossNotifications,
  type User,
  type InsertUser,
  type Route,
  type InsertRoute,
  type Territory,
  type InsertTerritory,
  type Friendship,
  type InsertFriendship,
  type FriendInvite,
  type InsertFriendInvite,
  type FriendRequest,
  type InsertFriendRequest,
  type PushSubscription,
  type InsertPushSubscription,
  type StravaAccount,
  type InsertStravaAccount,
  type StravaActivity,
  type InsertStravaActivity,
  type PolarAccount,
  type InsertPolarAccount,
  type PolarActivity,
  type InsertPolarActivity,
  type ConquestMetric,
  type InsertConquestMetric,
  type EmailNotification,
  type InsertEmailNotification,
  type EmailPreferences,
  type InsertEmailPreferences,
  type EphemeralPhoto,
  type InsertEphemeralPhoto,
  type InactivityReminder,
  type TerritoryLossNotification,
  type UserWithStats,
  type TerritoryWithUser,
  type RouteWithTerritory,
  type FeedEvent,
  type InsertFeedEvent,
  type FeedComment,
  type InsertFeedComment,
  type FeedEventWithDetails,
  type FeedCommentWithUser,
} from '../../shared/schema';
import { eq, desc, sql, and, inArray } from 'drizzle-orm';
import { type Database } from './db';

// Helper function to create a turf feature from either Polygon or MultiPolygon geometry
function geometryToFeature(geometry: any): turf.Feature<turf.Polygon | turf.MultiPolygon> {
  if (geometry.type === 'MultiPolygon') {
    return turf.multiPolygon(geometry.coordinates);
  }
  return turf.polygon(geometry.coordinates);
}

export class WorkerStorage {
  constructor(private db: Database) {}

  async getUser(id: string): Promise<User | undefined> {
    const [user] = await this.db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await this.db.select().from(users).where(eq(users.username, username));
    return user || undefined;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await this.db.select().from(users).where(eq(users.email, email));
    return user || undefined;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await this.db
      .insert(users)
      .values(insertUser)
      .returning();
    return user;
  }

  async deleteUser(userId: string): Promise<void> {
    // Delete from all child tables first to avoid FK constraint issues
    await this.db.delete(feedComments).where(eq(feedComments.userId, userId));
    await this.db.delete(feedEvents).where(eq(feedEvents.userId, userId));
    await this.db.delete(ephemeralPhotos).where(eq(ephemeralPhotos.senderId, userId));
    await this.db.delete(inactivityReminders).where(eq(inactivityReminders.userId, userId));
    await this.db.delete(territoryLossNotifications).where(eq(territoryLossNotifications.userId, userId));
    await this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
    await this.db.delete(emailPreferences).where(eq(emailPreferences.userId, userId));
    await this.db.delete(emailNotifications).where(eq(emailNotifications.userId, userId));
    await this.db.delete(conquestMetrics).where(eq(conquestMetrics.attackerId, userId));
    await this.db.delete(conquestMetrics).where(eq(conquestMetrics.defenderId, userId));
    await this.db.delete(polarActivities).where(eq(polarActivities.userId, userId));
    await this.db.delete(polarAccounts).where(eq(polarAccounts.userId, userId));
    await this.db.delete(stravaActivities).where(eq(stravaActivities.userId, userId));
    await this.db.delete(stravaAccounts).where(eq(stravaAccounts.userId, userId));
    await this.db.delete(friendRequests).where(eq(friendRequests.senderId, userId));
    await this.db.delete(friendRequests).where(eq(friendRequests.recipientId, userId));
    await this.db.delete(friendInvites).where(eq(friendInvites.userId, userId));
    await this.db.delete(friendships).where(eq(friendships.userId, userId));
    await this.db.delete(friendships).where(eq(friendships.friendId, userId));
    await this.db.delete(territories).where(eq(territories.userId, userId));
    await this.db.delete(routes).where(eq(routes.userId, userId));
    await this.db.delete(users).where(eq(users.id, userId));
  }

  async getAllUsersWithStats(): Promise<UserWithStats[]> {
    const allUsers = await this.db
      .select({
        id: users.id,
        username: users.username,
        name: users.name,
        color: users.color,
        avatar: users.avatar,
        totalArea: users.totalArea,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(desc(users.totalArea));

    const usersWithStats: UserWithStats[] = await Promise.all(
      allUsers.map(async (user, index) => {
        const friendCount = await this.db
          .select({ count: sql<number>`count(*)` })
          .from(friendships)
          .where(eq(friendships.userId, user.id));

        return {
          ...user,
          rank: index + 1,
          friendCount: Number(friendCount[0]?.count || 0),
        };
      })
    );

    return usersWithStats;
  }

  async updateUser(userId: string, data: Partial<Pick<User, 'name' | 'color' | 'avatar'>>): Promise<User> {
    const [updatedUser] = await this.db
      .update(users)
      .set(data)
      .where(eq(users.id, userId))
      .returning();
    return updatedUser;
  }

  async updateUserTotalArea(userId: string, area: number): Promise<void> {
    await this.db
      .update(users)
      .set({ totalArea: area })
      .where(eq(users.id, userId));
  }

  async createRoute(insertRoute: InsertRoute): Promise<Route> {
    const routeValues = {
      ...insertRoute,
      coordinates: JSON.stringify(insertRoute.coordinates), // Convert array to JSON string for SQLite
    };
    const [route] = await this.db
      .insert(routes)
      .values(routeValues)
      .returning();
    return route;
  }

  // Get all routes from all users, sorted oldest first (for chronological reprocessing)
  async getAllRoutesChronological(): Promise<Route[]> {
    return await this.db
      .select()
      .from(routes)
      .orderBy(routes.completedAt); // oldest first (ASC)
  }

  // Get routes for a single user, sorted oldest first (chronological order for territory rebuilding)
  async getRoutesByUserIdChronological(userId: string): Promise<Route[]> {
    return await this.db
      .select()
      .from(routes)
      .where(eq(routes.userId, userId))
      .orderBy(routes.completedAt); // oldest first (ASC)
  }

  // Get routes for a set of users, sorted oldest first
  async getRoutesForUsersChronological(userIds: string[]): Promise<Route[]> {
    if (userIds.length === 0) return [];
    const placeholders = userIds.map(id => `'${id.replace(/'/g, "''")}'`).join(',');
    return await this.db
      .select()
      .from(routes)
      .where(sql`${routes.userId} IN (${sql.raw(placeholders)})`)
      .orderBy(routes.completedAt);
  }

  async getRoutesByUserId(userId: string): Promise<RouteWithTerritory[]> {
    const userRoutes = await this.db
      .select()
      .from(routes)
      .where(eq(routes.userId, userId))
      .orderBy(desc(routes.completedAt));

    const routesWithTerritories: RouteWithTerritory[] = await Promise.all(
      userRoutes.map(async (route) => {
        const [territory] = await this.db
          .select()
          .from(territories)
          .where(eq(territories.routeId, route.id));

        // Parse coordinates safely (SQLite stores as text)
        let parsedCoordinates: Array<[number, number]> = [];
        if (Array.isArray(route.coordinates)) {
          parsedCoordinates = route.coordinates as Array<[number, number]>;
        } else if (typeof route.coordinates === 'string') {
          try {
            const parsed = JSON.parse(route.coordinates) as Array<[number, number]>;
            parsedCoordinates = Array.isArray(parsed) ? parsed : [];
          } catch (e) {
            console.error('Error parsing route coordinates:', e);
            parsedCoordinates = [];
          }
        }

        // Parse ranTogetherWith from JSON and get user names
        let ranTogetherWithUsers: Array<{ id: string; name: string }> = [];
        if (route.ranTogetherWith) {
          try {
            const userIds = typeof route.ranTogetherWith === 'string'
              ? JSON.parse(route.ranTogetherWith)
              : route.ranTogetherWith;
            
            if (Array.isArray(userIds) && userIds.length > 0) {
              // Get user info for each user ID
              for (const userId of userIds) {
                const [user] = await this.db
                  .select({ id: users.id, name: users.name })
                  .from(users)
                  .where(eq(users.id, userId));
                if (user) {
                  ranTogetherWithUsers.push(user);
                }
              }
            }
          } catch (e) {
            console.error('Error parsing ranTogetherWith:', e);
          }
        }

        return {
          ...route,
          coordinates: parsedCoordinates,
          territory: territory || undefined,
          ranTogetherWithUsers,
        };
      })
    );

    return routesWithTerritories;
  }

  async getRoute(id: string): Promise<Route | undefined> {
    const [route] = await this.db.select().from(routes).where(eq(routes.id, id));
    if (!route) return undefined;
    
    // Parse coordinates from JSON string (SQLite stores as text)
    const parsedCoordinates = typeof route.coordinates === 'string'
      ? JSON.parse(route.coordinates)
      : route.coordinates;
    
    return {
      ...route,
      coordinates: parsedCoordinates,
    };
  }

  // Batch-load routes by IDs (only startedAt/completedAt needed for ran-together check)
  async getRouteTimesById(ids: string[]): Promise<Map<string, { startedAt: string | null; completedAt: string | null }>> {
    const result = new Map<string, { startedAt: string | null; completedAt: string | null }>();
    if (ids.length === 0) return result;
    const rows = await this.db
      .select({ id: routes.id, startedAt: routes.startedAt, completedAt: routes.completedAt })
      .from(routes)
      .where(inArray(routes.id, ids));
    for (const row of rows) {
      result.set(row.id, { startedAt: row.startedAt, completedAt: row.completedAt });
    }
    return result;
  }

  async updateRouteRanTogether(routeId: string, ranTogetherWith: string[]): Promise<void> {
    await this.db
      .update(routes)
      .set({ ranTogetherWith: JSON.stringify(ranTogetherWith) })
      .where(eq(routes.id, routeId));
  }

  async createTerritory(insertTerritory: InsertTerritory): Promise<Territory> {
    const [territory] = await this.db
      .insert(territories)
      .values(insertTerritory)
      .returning();
    return territory;
  }

  async getAllTerritories(): Promise<TerritoryWithUser[]> {
    const allTerritories = await this.db
      .select({
        id: territories.id,
        userId: territories.userId,
        routeId: territories.routeId,
        geometry: territories.geometry,
        area: territories.area,
        conqueredAt: territories.conqueredAt,
        userName: users.name,
        userUsername: users.username,
        userColor: users.color,
      })
      .from(territories)
      .leftJoin(users, eq(territories.userId, users.id))
      .orderBy(desc(territories.conqueredAt));

    return allTerritories.map((t) => ({
      id: t.id,
      userId: t.userId,
      routeId: t.routeId,
      geometry: t.geometry,
      area: t.area,
      conqueredAt: t.conqueredAt,
      user: {
        id: t.userId,
        username: t.userUsername || '',
        name: t.userName || '',
        color: t.userColor || '#000000',
      },
    }));
  }

  async getTerritoriesByUserId(userId: string): Promise<Territory[]> {
    return await this.db
      .select()
      .from(territories)
      .where(eq(territories.userId, userId))
      .orderBy(desc(territories.conqueredAt));
  }

  // Get total area for a user directly from DB (no geometry transfer)
  async getUserTotalAreaFromTerritories(userId: string): Promise<number> {
    const result = await this.db
      .select({ total: sql<number>`COALESCE(SUM(${territories.area}), 0)` })
      .from(territories)
      .where(eq(territories.userId, userId));
    return result[0]?.total || 0;
  }

  // Get territories only for specific users (much faster than getAllTerritories)
  async getTerritoriesForUsers(userIds: string[]): Promise<TerritoryWithUser[]> {
    if (userIds.length === 0) return [];
    const results = await this.db
      .select({
        id: territories.id,
        userId: territories.userId,
        routeId: territories.routeId,
        geometry: territories.geometry,
        area: territories.area,
        conqueredAt: territories.conqueredAt,
        userName: users.name,
        userUsername: users.username,
        userColor: users.color,
      })
      .from(territories)
      .leftJoin(users, eq(territories.userId, users.id))
      .where(inArray(territories.userId, userIds))
      .orderBy(desc(territories.conqueredAt));

    return results.map((t) => ({
      id: t.id,
      userId: t.userId,
      routeId: t.routeId,
      geometry: t.geometry,
      area: t.area,
      conqueredAt: t.conqueredAt,
      user: {
        id: t.userId,
        username: t.userUsername || '',
        name: t.userName || '',
        color: t.userColor || '#000000',
      },
    }));
  }

  async deleteTerritoryById(id: string): Promise<void> {
    await this.db.delete(territories).where(eq(territories.id, id));
  }

  async detachTerritoriesFromRoute(routeId: string): Promise<void> {
    await this.db
      .update(territories)
      .set({ routeId: null })
      .where(eq(territories.routeId, routeId));
  }

  async cleanStaleRouteIds(): Promise<void> {
    // Set routeId to null for territories whose route no longer exists
    await this.db.run(sql`UPDATE territories SET route_id = NULL WHERE route_id IS NOT NULL AND route_id NOT IN (SELECT id FROM routes)`);
  }

  async subtractFromTerritory(
    territoryId: string,
    subtractionGeometry: any
  ): Promise<{ updatedTerritory: Territory | null; stolenArea: number }> {
    const [territory] = await this.db
      .select()
      .from(territories)
      .where(eq(territories.id, territoryId));
    
    if (!territory) {
      throw new Error('Territory not found');
    }

    return this.subtractFromTerritoryDirect(territory, subtractionGeometry);
  }

  // Like subtractFromTerritory but accepts a pre-loaded territory (avoids redundant DB read)
  async subtractFromTerritoryDirect(
    territory: Territory,
    subtractionGeometry: any
  ): Promise<{ updatedTerritory: Territory | null; stolenArea: number }> {
    // Parse geometry from JSON string (SQLite stores as text)
    const parsedGeometry = typeof territory.geometry === 'string' 
      ? JSON.parse(territory.geometry) 
      : territory.geometry;

    // Use helper to handle both Polygon and MultiPolygon
    const originalFeature = geometryToFeature(parsedGeometry);
    const subtractionFeature = geometryToFeature(subtractionGeometry);
    
    // Calculate the intersection (what's being stolen)
    const intersection = turf.intersect(
      turf.featureCollection([originalFeature, subtractionFeature])
    );
    
    if (!intersection) {
      // No overlap, return unchanged territory
      return { updatedTerritory: territory, stolenArea: 0 };
    }
    
    const stolenArea = turf.area(intersection);
    
    // Calculate the difference (what remains)
    const difference = turf.difference(
      turf.featureCollection([originalFeature, subtractionFeature])
    );
    
    if (!difference) {
      // Entire territory was conquered, delete it
      await this.db.delete(territories).where(eq(territories.id, territory.id));
      return { updatedTerritory: null, stolenArea };
    }
    
    // Update the territory with the remaining geometry as JSON string
    const newArea = turf.area(difference);
    const [updatedTerritory] = await this.db
      .update(territories)
      .set({
        geometry: JSON.stringify(difference.geometry),
        area: newArea,
      })
      .where(eq(territories.id, territory.id))
      .returning();
    
    return { updatedTerritory, stolenArea };
  }

  async addOrMergeTerritory(
    userId: string,
    routeId: string,
    newGeometry: any,
    userTerritories: Territory[]
  ): Promise<{
    territory: Territory;
    totalArea: number;
    newArea: number;
    existingArea: number;
  }> {
    // Use helper to handle both Polygon and MultiPolygon
    const newFeature = geometryToFeature(newGeometry);
    let newArea = turf.area(newGeometry);
    let existingAreaInBuffer = 0;

    // Calculate how much of the buffer overlaps with existing user territories
    for (const userTerritory of userTerritories) {
      try {
        // Parse geometry from JSON string (SQLite stores as text)
        const parsedGeometry = typeof userTerritory.geometry === 'string' 
          ? JSON.parse(userTerritory.geometry) 
          : userTerritory.geometry;
        
        const userFeature = geometryToFeature(parsedGeometry);
        const overlap = turf.intersect(
          turf.featureCollection([newFeature, userFeature])
        );
        
        if (overlap) {
          existingAreaInBuffer += turf.area(overlap);
        }
      } catch (err) {
        console.error('[TERRITORY] Error calculating overlap with existing territory:', err);
      }
    }

    // True new area = buffer area - overlap with own territories
    const actualNewArea = newArea - existingAreaInBuffer;

    // Merge all territories into one unified geometry
    let finalGeometry = newGeometry;
    for (const userTerritory of userTerritories) {
      try {
        // Parse geometry from JSON string (SQLite stores as text)
        const parsedGeometry = typeof userTerritory.geometry === 'string' 
          ? JSON.parse(userTerritory.geometry) 
          : userTerritory.geometry;
        
        const userFeature = geometryToFeature(parsedGeometry);
        const currentFeature = geometryToFeature(finalGeometry);
        const union = turf.union(
          turf.featureCollection([currentFeature, userFeature])
        );
        if (union) {
          finalGeometry = union.geometry;
        }
      } catch (err) {
        console.error('[TERRITORY] Error merging territories:', err);
      }
    }

    // Delete all old territories
    await this.db
      .delete(territories)
      .where(eq(territories.userId, userId));

    // Create new unified territory with geometry as JSON string
    const [territory] = await this.db
      .insert(territories)
      .values({
        userId,
        routeId,
        geometry: JSON.stringify(finalGeometry),
        area: turf.area(finalGeometry),
        conqueredAt: new Date(),
      })
      .returning();

    return {
      territory,
      totalArea: turf.area(finalGeometry),
      newArea: actualNewArea,
      existingArea: existingAreaInBuffer,
    };
  }

  async updateTerritoryGeometry(
    userId: string,
    routeId: string | null,
    geometry: any,
    area: number
  ): Promise<Territory> {
    // Delete all existing territories for the user
    await this.db.delete(territories).where(eq(territories.userId, userId));

    // Create a single new territory with the unified geometry as JSON string
    const [territory] = await this.db
      .insert(territories)
      .values({
        userId,
        routeId,
        geometry: JSON.stringify(geometry),
        area,
        conqueredAt: new Date(),
      })
      .returning();

    return territory;
  }

  async createFriendship(insertFriendship: InsertFriendship): Promise<Friendship> {
    const [friendship] = await this.db
      .insert(friendships)
      .values(insertFriendship)
      .returning();
    return friendship;
  }

  async getFriendsByUserId(userId: string): Promise<UserWithStats[]> {
    const userFriendships = await this.db
      .select({
        friendId: friendships.friendId,
      })
      .from(friendships)
      .where(eq(friendships.userId, userId));

    if (userFriendships.length === 0) {
      return [];
    }

    const friendIds = userFriendships.map((f) => f.friendId);
    
    // Rank friends among the friend group (including the user) instead of globally
    const friendsLeaderboard = await this.getLeaderboardFriends(userId);
    return friendsLeaderboard.filter((user) => friendIds.includes(user.id));
  }

  async checkFriendship(userId: string, friendId: string): Promise<boolean> {
    const [friendship] = await this.db
      .select()
      .from(friendships)
      .where(
        sql`${friendships.userId} = ${userId} AND ${friendships.friendId} = ${friendId}`
      );
    return !!friendship;
  }

  // ==================== FRIEND REQUESTS ====================

  async createFriendRequest(data: InsertFriendRequest): Promise<FriendRequest> {
    // Check if request already exists
    const [existing] = await this.db
      .select()
      .from(friendRequests)
      .where(
        sql`${friendRequests.senderId} = ${data.senderId} AND ${friendRequests.recipientId} = ${data.recipientId} AND ${friendRequests.status} = 'pending'`
      );
    
    if (existing) {
      return existing;
    }

    const [request] = await this.db
      .insert(friendRequests)
      .values(data)
      .returning();
    return request;
  }

  async getFriendRequestsByRecipient(recipientId: string): Promise<FriendRequest[]> {
    return await this.db
      .select()
      .from(friendRequests)
      .where(
        sql`${friendRequests.recipientId} = ${recipientId} AND ${friendRequests.status} = 'pending'`
      );
  }

  async getFriendRequestsBySender(senderId: string): Promise<FriendRequest[]> {
    return await this.db
      .select()
      .from(friendRequests)
      .where(
        sql`${friendRequests.senderId} = ${senderId} AND ${friendRequests.status} = 'pending'`
      );
  }

  async getFriendRequestById(id: string): Promise<FriendRequest | undefined> {
    const [request] = await this.db
      .select()
      .from(friendRequests)
      .where(eq(friendRequests.id, id));
    return request || undefined;
  }

  async updateFriendRequestStatus(id: string, status: string): Promise<void> {
    await this.db
      .update(friendRequests)
      .set({ status })
      .where(eq(friendRequests.id, id));
  }

  async deleteFriendRequest(id: string): Promise<void> {
    await this.db.delete(friendRequests).where(eq(friendRequests.id, id));
  }

  // ==================== PUSH SUBSCRIPTIONS ====================

  async createPushSubscription(data: InsertPushSubscription): Promise<PushSubscription> {
    // First, try to delete existing subscription with same endpoint
    try {
      await this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, data.endpoint));
    } catch (e) {
      // Ignore if doesn't exist
    }

    const [subscription] = await this.db
      .insert(pushSubscriptions)
      .values(data)
      .returning();
    return subscription;
  }

  async getPushSubscriptionsByUserId(userId: string): Promise<PushSubscription[]> {
    return await this.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId));
  }

  async deletePushSubscriptionsByUserId(userId: string): Promise<void> {
    await this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
  }

  // ==================== STRAVA ====================

  async getStravaAccountByUserId(userId: string): Promise<StravaAccount | undefined> {
    const [account] = await this.db.select().from(stravaAccounts).where(eq(stravaAccounts.userId, userId));
    return account || undefined;
  }

  async getStravaAccountByAthleteId(athleteId: number): Promise<StravaAccount | undefined> {
    const [account] = await this.db.select().from(stravaAccounts).where(eq(stravaAccounts.stravaAthleteId, athleteId));
    return account || undefined;
  }

  async createStravaAccount(data: InsertStravaAccount): Promise<StravaAccount> {
    const [account] = await this.db.insert(stravaAccounts).values(data).returning();
    return account;
  }

  async updateStravaAccount(userId: string, data: Partial<InsertStravaAccount>): Promise<StravaAccount> {
    const [account] = await this.db
      .update(stravaAccounts)
      .set(data)
      .where(eq(stravaAccounts.userId, userId))
      .returning();
    return account;
  }

  async deleteStravaAccount(userId: string): Promise<void> {
    await this.db.delete(stravaAccounts).where(eq(stravaAccounts.userId, userId));
  }

  async getStravaActivityByStravaId(stravaActivityId: number): Promise<StravaActivity | undefined> {
    const [activity] = await this.db.select().from(stravaActivities).where(eq(stravaActivities.stravaActivityId, stravaActivityId));
    return activity || undefined;
  }

  async createStravaActivity(data: InsertStravaActivity): Promise<StravaActivity> {
    const [activity] = await this.db.insert(stravaActivities).values(data).returning();
    return activity;
  }

  async updateStravaActivity(id: string, data: Partial<InsertStravaActivity>): Promise<StravaActivity> {
    const [activity] = await this.db
      .update(stravaActivities)
      .set(data)
      .where(eq(stravaActivities.id, id))
      .returning();
    return activity;
  }

  async getUnprocessedStravaActivities(userId: string): Promise<StravaActivity[]> {
    return await this.db
      .select()
      .from(stravaActivities)
      .where(sql`${stravaActivities.userId} = ${userId} AND ${stravaActivities.processed} = 0`);
  }

  // Get activities that failed processing (route_id is NULL, regardless of processed flag)
  async getFailedStravaActivities(userId: string): Promise<StravaActivity[]> {
    return await this.db
      .select()
      .from(stravaActivities)
      .where(sql`${stravaActivities.userId} = ${userId} AND ${stravaActivities.routeId} IS NULL`)
      .orderBy(desc(stravaActivities.startDate));
  }

  // Mark activity for retry by resetting processed flag
  async resetStravaActivityForRetry(id: string): Promise<StravaActivity> {
    const [activity] = await this.db
      .update(stravaActivities)
      .set({
        processed: false,
        processedAt: null,
        routeId: null,
        territoryId: null,
      })
      .where(eq(stravaActivities.id, id))
      .returning();
    return activity;
  }

  async getStravaActivitiesByUserId(userId: string): Promise<StravaActivity[]> {
    return await this.db
      .select()
      .from(stravaActivities)
      .where(eq(stravaActivities.userId, userId))
      .orderBy(desc(stravaActivities.startDate));
  }

  async deleteStravaActivityByRouteId(routeId: string): Promise<void> {
    await this.db.delete(stravaActivities).where(eq(stravaActivities.routeId, routeId));
  }

  // ==================== POLAR ====================

  async getPolarAccountByUserId(userId: string): Promise<PolarAccount | undefined> {
    const [account] = await this.db.select().from(polarAccounts).where(eq(polarAccounts.userId, userId));
    return account || undefined;
  }

  async getPolarAccountByPolarUserId(polarUserId: number): Promise<PolarAccount | undefined> {
    const [account] = await this.db.select().from(polarAccounts).where(eq(polarAccounts.polarUserId, polarUserId));
    return account || undefined;
  }

  async createPolarAccount(data: InsertPolarAccount): Promise<PolarAccount> {
    const [account] = await this.db.insert(polarAccounts).values(data).returning();
    return account;
  }

  async updatePolarAccount(userId: string, data: Partial<InsertPolarAccount>): Promise<PolarAccount> {
    const [account] = await this.db
      .update(polarAccounts)
      .set(data)
      .where(eq(polarAccounts.userId, userId))
      .returning();
    return account;
  }

  async deletePolarAccount(userId: string): Promise<void> {
    await this.db.delete(polarAccounts).where(eq(polarAccounts.userId, userId));
  }

  async getPolarActivityByPolarId(polarExerciseId: string): Promise<PolarActivity | undefined> {
    const [activity] = await this.db.select().from(polarActivities).where(eq(polarActivities.polarExerciseId, polarExerciseId));
    return activity || undefined;
  }

  async createPolarActivity(data: InsertPolarActivity): Promise<PolarActivity> {
    const [activity] = await this.db.insert(polarActivities).values(data).returning();
    return activity;
  }

  async updatePolarActivity(id: string, data: Partial<InsertPolarActivity>): Promise<PolarActivity> {
    const [activity] = await this.db
      .update(polarActivities)
      .set(data)
      .where(eq(polarActivities.id, id))
      .returning();
    return activity;
  }

  async deletePolarActivityByRouteId(routeId: string): Promise<void> {
    await this.db.delete(polarActivities).where(eq(polarActivities.routeId, routeId));
  }

  async getUnprocessedPolarActivities(userId: string): Promise<PolarActivity[]> {
    return await this.db
      .select()
      .from(polarActivities)
      .where(sql`${polarActivities.userId} = ${userId} AND ${polarActivities.processed} = 0`)
      .orderBy(desc(polarActivities.startDate));
  }

  // Get activities that failed processing (route_id is NULL, regardless of processed flag)
  async getFailedPolarActivities(userId: string): Promise<PolarActivity[]> {
    return await this.db
      .select()
      .from(polarActivities)
      .where(sql`${polarActivities.userId} = ${userId} AND ${polarActivities.routeId} IS NULL`)
      .orderBy(desc(polarActivities.startDate));
  }

  // Get ALL failed activities across ALL users (route_id IS NULL)
  async getAllFailedPolarActivities(): Promise<PolarActivity[]> {
    return await this.db
      .select()
      .from(polarActivities)
      .where(sql`${polarActivities.routeId} IS NULL`)
      .orderBy(desc(polarActivities.startDate));
  }

  // Mark activity for retry by resetting processed flag
  async resetPolarActivityForRetry(id: string): Promise<PolarActivity> {
    const [activity] = await this.db
      .update(polarActivities)
      .set({
        processed: false,
        processedAt: null,
        routeId: null,
        territoryId: null,
      })
      .where(eq(polarActivities.id, id))
      .returning();
    return activity;
  }

  async getPolarActivitiesByUserId(userId: string): Promise<PolarActivity[]> {
    return await this.db
      .select()
      .from(polarActivities)
      .where(eq(polarActivities.userId, userId))
      .orderBy(desc(polarActivities.startDate));
  }

  async findPolarActivityByAttributes(userId: string, distance: number, startDate: string): Promise<PolarActivity | undefined> {
    // Find a polar activity with matching userId and startDate (exact) and approximate distance
    const activities = await this.db
      .select()
      .from(polarActivities)
      .where(and(eq(polarActivities.userId, userId), eq(polarActivities.startDate, startDate)));
    
    for (const act of activities) {
      const distDiff = Math.abs(act.distance - distance);
      const threshold = Math.max(distance * 0.02, 10); // 2% tolerance or 10m
      if (distDiff <= threshold) {
        return act;
      }
    }
    return undefined;
  }

  async getPolarActivityById(id: string): Promise<PolarActivity | undefined> {
    const [activity] = await this.db.select().from(polarActivities).where(eq(polarActivities.id, id));
    return activity || undefined;
  }

  async deletePolarActivityById(id: string): Promise<void> {
    await this.db.delete(polarActivities).where(eq(polarActivities.id, id));
  }

  async deleteConquestMetricsByRouteId(routeId: string): Promise<void> {
    await this.db.delete(conquestMetrics).where(eq(conquestMetrics.routeId, routeId));
  }

  async deleteAllConquestMetrics(): Promise<void> {
    await this.db.delete(conquestMetrics);
  }

  async deleteConquestMetricsByUserId(userId: string): Promise<void> {
    await this.db.delete(conquestMetrics).where(
      sql`${conquestMetrics.attackerId} = ${userId} OR ${conquestMetrics.defenderId} = ${userId}`
    );
  }

  // Check if a user has any conquest interactions (as attacker or defender)
  async hasConquestInteractions(userId: string): Promise<boolean> {
    const result = await this.db
      .select({ count: sql<number>`COUNT(*)` })
      .from(conquestMetrics)
      .where(sql`${conquestMetrics.attackerId} = ${userId} OR ${conquestMetrics.defenderId} = ${userId}`);
    return (result[0]?.count || 0) > 0;
  }

  async deleteRouteById(id: string): Promise<void> {
    await this.db.delete(routes).where(eq(routes.id, id));
  }

  async updateRouteName(id: string, name: string): Promise<void> {
    await this.db.update(routes).set({ name }).where(eq(routes.id, id));
  }

  async getRouteById(id: string): Promise<Route | null> {
    const result = await this.db.select().from(routes).where(eq(routes.id, id)).limit(1);
    return result[0] || null;
  }

  async recalculateUserArea(userId: string): Promise<void> {
    // Sum all territory areas for this user
    const result = await this.db
      .select({ total: sql<number>`COALESCE(SUM(${territories.area}), 0)` })
      .from(territories)
      .where(eq(territories.userId, userId));
    const totalArea = result[0]?.total || 0;
    await this.db.update(users).set({ totalArea }).where(eq(users.id, userId));
  }

  async findRouteByAttributes(userId: string, name: string, distance: number): Promise<Route | null> {
    // Find a route matching by userId, name, and approximate distance (within 1%)
    const userRoutes = await this.db
      .select()
      .from(routes)
      .where(and(eq(routes.userId, userId), eq(routes.name, name)));
    
    // Find the closest match by distance
    for (const route of userRoutes) {
      const distDiff = Math.abs(route.distance - distance);
      const threshold = Math.max(distance * 0.01, 1); // 1% tolerance or 1m minimum
      if (distDiff <= threshold) {
        return route;
      }
    }
    return null;
  }

  async deleteTerritoriesByUserId(userId: string): Promise<void> {
    await this.db.delete(territories).where(eq(territories.userId, userId));
  }

  // Batch delete territories for multiple users (single query)
  async deleteTerritoriesForUsers(userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    await this.db.delete(territories).where(inArray(territories.userId, userIds));
  }

  // Batch reset total area for multiple users (single query)
  async resetTotalAreaForUsers(userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    await this.db.update(users).set({ totalArea: 0 }).where(inArray(users.id, userIds));
  }

  // Batch delete conquest metrics for multiple users (single query)
  async deleteConquestMetricsForUsers(userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    await this.db.delete(conquestMetrics).where(
      sql`${conquestMetrics.attackerId} IN (${sql.join(userIds.map(id => sql`${id}`), sql`, `)}) OR ${conquestMetrics.defenderId} IN (${sql.join(userIds.map(id => sql`${id}`), sql`, `)})`
    );
  }

  async deleteTerritoriesByRouteId(routeId: string): Promise<void> {
    await this.db.delete(territories).where(eq(territories.routeId, routeId));
  }

  async deleteAllPolarActivitiesByUserId(userId: string): Promise<void> {
    await this.db.delete(polarActivities).where(eq(polarActivities.userId, userId));
  }

  async deleteAllRoutesByUserId(userId: string): Promise<void> {
    await this.db.delete(routes).where(eq(routes.userId, userId));
  }

  async deleteAllStravaActivitiesByUserId(userId: string): Promise<void> {
    await this.db.delete(stravaActivities).where(eq(stravaActivities.userId, userId));
  }

  // Reset all Polar activities for all users (force reimport)
  async resetAllPolarActivitiesForReprocessing(): Promise<number> {
    const result = await this.db
      .update(polarActivities)
      .set({
        processed: false,
        processedAt: null,
        routeId: null,
        territoryId: null,
      })
      .returning();
    return result.length;
  }

  // Get all distinct user IDs that have Polar activities
  async getUsersWithPolarActivities(): Promise<string[]> {
    const results = await this.db
      .selectDistinct({ userId: polarActivities.userId })
      .from(polarActivities);
    return results.map(r => r.userId);
  }

  // Get all Polar activities (for admin purposes)
  async getAllPolarActivities(): Promise<PolarActivity[]> {
    return await this.db
      .select()
      .from(polarActivities)
      .orderBy(desc(polarActivities.startDate));
  }

  // Get count of routes by userId
  async getRouteCountByUserId(userId: string): Promise<number> {
    const [result] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(routes)
      .where(eq(routes.userId, userId));
    return Number(result?.count || 0);
  }

  // Get count of territories by userId
  async getTerritoryCountByUserId(userId: string): Promise<number> {
    const [result] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(territories)
      .where(eq(territories.userId, userId));
    return Number(result?.count || 0);
  }

  // Find duplicate routes: same user, same startedAt (prefix match), same distance (~2% tolerance)
  async findDuplicateRoutes(userId: string): Promise<{ keepId: string; deleteIds: string[] }[]> {
    const userRoutes = await this.db
      .select()
      .from(routes)
      .where(eq(routes.userId, userId))
      .orderBy(routes.startedAt);

    const groups = new Map<string, typeof userRoutes>();
    for (const route of userRoutes) {
      // Group by date prefix (YYYY-MM-DDTHH:MM)
      const dateKey = (route.startedAt || '').substring(0, 16);
      if (!groups.has(dateKey)) groups.set(dateKey, []);
      groups.get(dateKey)!.push(route);
    }

    const duplicates: { keepId: string; deleteIds: string[] }[] = [];
    for (const [, group] of groups) {
      if (group.length <= 1) continue;
      // Within same date prefix, group by approximate distance
      const distGroups: typeof userRoutes[] = [];
      for (const route of group) {
        let found = false;
        for (const dg of distGroups) {
          const ref = dg[0];
          const distDiff = Math.abs(route.distance - ref.distance);
          const threshold = Math.max(ref.distance * 0.02, 10);
          if (distDiff <= threshold) {
            dg.push(route);
            found = true;
            break;
          }
        }
        if (!found) distGroups.push([route]);
      }
      for (const dg of distGroups) {
        if (dg.length <= 1) continue;
        // Keep the one that has a polar activity linked, otherwise keep the oldest
        const withPolar = dg.filter(r => {
          // We'll determine this outside, for now keep first
          return false;
        });
        const keepId = dg[0].id; // oldest (sorted by startedAt)
        const deleteIds = dg.slice(1).map(r => r.id);
        duplicates.push({ keepId, deleteIds });
      }
    }
    return duplicates;
  }

  // Delete a specific route by ID (no cascade - handled manually)
  async deleteRouteByIdDirect(routeId: string): Promise<void> {
    await this.db.delete(routes).where(eq(routes.id, routeId));
  }

  // Get routes that have no linked polar activity (orphaned from reimport)
  async getOrphanedRoutes(userId: string): Promise<Route[]> {
    // Get all routes for user
    const userRoutes = await this.db
      .select()
      .from(routes)
      .where(eq(routes.userId, userId));
    
    // Get all polar activities with routeId for this user
    const polarActs = await this.db
      .select({ routeId: polarActivities.routeId })
      .from(polarActivities)
      .where(and(eq(polarActivities.userId, userId), sql`${polarActivities.routeId} IS NOT NULL`));
    
    // Get all strava activities with routeId for this user
    const stravaActs = await this.db
      .select({ routeId: stravaActivities.routeId })
      .from(stravaActivities)
      .where(and(eq(stravaActivities.userId, userId), sql`${stravaActivities.routeId} IS NOT NULL`));
    
    const linkedRouteIds = new Set([
      ...polarActs.map(a => a.routeId).filter(Boolean),
      ...stravaActs.map(a => a.routeId).filter(Boolean),
    ]);
    
    // Routes not linked to any activity are orphans
    return userRoutes.filter(r => !linkedRouteIds.has(r.id));
  }

  async findRouteByDateAndDistance(userId: string, startDate: string, distance: number): Promise<Route | null> {
    // Busca una ruta por userId, fecha de inicio y distancia aproximada (1% tolerancia)
    // Compare by date prefix (YYYY-MM-DDTHH:MM) to avoid format mismatches (milliseconds, timezone)
    const datePrefix = startDate.substring(0, 16); // "2026-01-15T10:30"
    const userRoutes = await this.db
      .select()
      .from(routes)
      .where(
        and(
          eq(routes.userId, userId),
          sql`${routes.startedAt} LIKE ${datePrefix + '%'}`
        )
      );
    for (const route of userRoutes) {
      const distDiff = Math.abs(route.distance - distance);
      const threshold = Math.max(distance * 0.01, 1);
      if (distDiff <= threshold) {
        return route;
      }
    }
    return null;
  }

  async getPolarActivityStats(userId: string): Promise<{ total: number; unprocessed: number; lastStartDate: Date | null; }> {
    const [aggregate] = await this.db
      .select({
        total: sql<number>`count(*)`,
        unprocessed: sql<number>`sum(case when ${polarActivities.processed} = false then 1 else 0 end)` as any,
        lastStartDate: sql<Date | null>`max(${polarActivities.startDate})`,
      })
      .from(polarActivities)
      .where(eq(polarActivities.userId, userId));

    return {
      total: Number(aggregate?.total || 0),
      unprocessed: Number(aggregate?.unprocessed || 0),
      lastStartDate: aggregate?.lastStartDate || null,
    };
  }

  // New friendship methods for friend-only competition
  async getLeaderboardFriends(userId: string): Promise<UserWithStats[]> {
    // Get friend IDs
    const userFriendships = await this.db
      .select({ friendId: friendships.friendId })
      .from(friendships)
      .where(eq(friendships.userId, userId));

    const friendIds = userFriendships.map((f) => f.friendId);
    
    // Include the user themselves in the list
    const allIds = [userId, ...friendIds];
    
    // Get all friends + user with stats, ordered by totalArea
    const friends = await this.db
      .select()
      .from(users)
      .where(sql`${users.id} IN (${sql.join(allIds.map(id => sql`${id}`), sql`, `)})`)
      .orderBy(desc(users.totalArea));

    // Calculate rank and friendCount
    const friendsWithStats: UserWithStats[] = [];
    for (let i = 0; i < friends.length; i++) {
      const friend = friends[i];
      const [{ count }] = await this.db
        .select({ count: sql<number>`count(*)` })
        .from(friendships)
        .where(eq(friendships.userId, friend.id));
      
      friendsWithStats.push({
        ...friend,
        rank: i + 1,
        friendCount: Number(count) || 0,
      });
    }

    return friendsWithStats;
  }

  async getTerritoriesWithUsersByFriends(userId: string): Promise<TerritoryWithUser[]> {
    // Get friend IDs
    const userFriendships = await this.db
      .select({ friendId: friendships.friendId })
      .from(friendships)
      .where(eq(friendships.userId, userId));

    const friendIds = userFriendships.map((f) => f.friendId);
    
    // Include the user themselves in the list
    const allIds = [userId, ...friendIds];

    // Get territories belonging to friends + user
    const territoryData = await this.db
      .select({
        id: territories.id,
        userId: territories.userId,
        routeId: territories.routeId,
        geometry: territories.geometry,
        area: territories.area,
        conqueredAt: territories.conqueredAt,
        userName: users.name,
        userUsername: users.username,
        userColor: users.color,
      })
      .from(territories)
      .leftJoin(users, eq(territories.userId, users.id))
      .where(sql`${territories.userId} IN (${sql.join(allIds.map(id => sql`${id}`), sql`, `)})`);

    return territoryData.map((t) => ({
      id: t.id,
      userId: t.userId,
      routeId: t.routeId,
      geometry: t.geometry,
      area: t.area,
      conqueredAt: t.conqueredAt,
      user: {
        id: t.userId,
        username: t.userUsername || '',
        name: t.userName || '',
        color: t.userColor || '#000000',
      },
    }));
  }

  async searchUsers(query: string, currentUserId: string, limit: number = 20): Promise<User[]> {
    const lowerQuery = query.toLowerCase();
    return await this.db
      .select()
      .from(users)
      .where(
        sql`(LOWER(${users.username}) LIKE ${`%${lowerQuery}%`} OR LOWER(${users.name}) LIKE ${`%${lowerQuery}%`}) AND ${users.id} != ${currentUserId}`
      )
      .limit(limit);
  }

  async createBidirectionalFriendship(userId: string, friendId: string): Promise<void> {
    // Check if friendship already exists
    const existing = await this.db
      .select()
      .from(friendships)
      .where(
        sql`(${friendships.userId} = ${userId} AND ${friendships.friendId} = ${friendId}) OR (${friendships.userId} = ${friendId} AND ${friendships.friendId} = ${userId})`
      );

    if (existing.length > 0) {
      return; // Already friends
    }

    // Create both directions
    await this.db.insert(friendships).values([
      { userId, friendId },
      { userId: friendId, friendId: userId },
    ]);
  }

  async deleteBidirectionalFriendship(userId: string, friendId: string): Promise<void> {
    await this.db
      .delete(friendships)
      .where(
        sql`(${friendships.userId} = ${userId} AND ${friendships.friendId} = ${friendId}) OR (${friendships.userId} = ${friendId} AND ${friendships.friendId} = ${userId})`
      );
  }

  async createFriendInvite(userId: string): Promise<FriendInvite> {
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
    
    const [invite] = await this.db
      .insert(friendInvites)
      .values({ userId, token, expiresAt })
      .returning();
    
    return invite;
  }

  async getFriendInviteByToken(token: string): Promise<FriendInvite | undefined> {
    const [invite] = await this.db
      .select()
      .from(friendInvites)
      .where(eq(friendInvites.token, token));
    
    return invite || undefined;
  }

  async deleteFriendInvite(id: string): Promise<void> {
    await this.db.delete(friendInvites).where(eq(friendInvites.id, id));
  }

  async getFriendIds(userId: string): Promise<string[]> {
    const userFriendships = await this.db
      .select({ friendId: friendships.friendId })
      .from(friendships)
      .where(eq(friendships.userId, userId));
    
    return userFriendships.map(f => f.friendId);
  }

  // Get all friendship pairs for a set of users (single query)
  async getFriendshipMap(userIds: string[]): Promise<Map<string, Set<string>>> {
    if (userIds.length === 0) return new Map();
    const result = await this.db
      .select({ userId: friendships.userId, friendId: friendships.friendId })
      .from(friendships)
      .where(inArray(friendships.userId, userIds));
    
    const map = new Map<string, Set<string>>();
    for (const uid of userIds) {
      map.set(uid, new Set());
    }
    for (const row of result) {
      const set = map.get(row.userId);
      if (set) set.add(row.friendId);
    }
    return map;
  }

  async recordConquestMetric(
    attackerId: string,
    defenderId: string,
    areaStolen: number,
    routeId?: string
  ): Promise<ConquestMetric> {
    const [metric] = await this.db
      .insert(conquestMetrics)
      .values({
        attackerId,
        defenderId,
        areaStolen,
        routeId,
      })
      .returning();
    
    return metric;
  }

  async getConquestMetricsBetweenUsers(userId1: string, userId2: string): Promise<{
    totalFromFirstToSecond: number;
    totalFromSecondToFirst: number;
  }> {
    // Get area stolen from user2 to user1
    const fromUser1ToUser2 = await this.db
      .select({ total: sql<number>`SUM(${conquestMetrics.areaStolen})` })
      .from(conquestMetrics)
      .where(
        sql`${conquestMetrics.attackerId} = ${userId1} AND ${conquestMetrics.defenderId} = ${userId2}`
      );

    // Get area stolen from user1 to user2
    const fromUser2ToUser1 = await this.db
      .select({ total: sql<number>`SUM(${conquestMetrics.areaStolen})` })
      .from(conquestMetrics)
      .where(
        sql`${conquestMetrics.attackerId} = ${userId2} AND ${conquestMetrics.defenderId} = ${userId1}`
      );

    return {
      totalFromFirstToSecond: fromUser1ToUser2[0]?.total || 0,
      totalFromSecondToFirst: fromUser2ToUser1[0]?.total || 0,
    };
  }

  async getUserConquestStats(userId: string): Promise<{
    totalStolen: number;
    totalLost: number;
    stolenByUser: Array<{ userId: string; userName: string; userColor: string; amount: number }>;
    lostToUser: Array<{ userId: string; userName: string; userColor: string; amount: number }>;
  }> {
    // Total area stolen by this user
    const stolenResult = await this.db
      .select({ total: sql<number>`COALESCE(SUM(${conquestMetrics.areaStolen}), 0)` })
      .from(conquestMetrics)
      .where(eq(conquestMetrics.attackerId, userId));

    // Total area lost by this user
    const lostResult = await this.db
      .select({ total: sql<number>`COALESCE(SUM(${conquestMetrics.areaStolen}), 0)` })
      .from(conquestMetrics)
      .where(eq(conquestMetrics.defenderId, userId));

    // Stolen grouped by victim
    const stolenByUserResult = await this.db
      .select({
        defenderId: conquestMetrics.defenderId,
        total: sql<number>`SUM(${conquestMetrics.areaStolen})`,
      })
      .from(conquestMetrics)
      .where(eq(conquestMetrics.attackerId, userId))
      .groupBy(conquestMetrics.defenderId);

    // Lost grouped by attacker  
    const lostToUserResult = await this.db
      .select({
        attackerId: conquestMetrics.attackerId,
        total: sql<number>`SUM(${conquestMetrics.areaStolen})`,
      })
      .from(conquestMetrics)
      .where(eq(conquestMetrics.defenderId, userId))
      .groupBy(conquestMetrics.attackerId);

    // Get user details for stolen
    const stolenByUser = await Promise.all(
      stolenByUserResult.map(async (row) => {
        const [user] = await this.db
          .select({ id: users.id, name: users.name, color: users.color })
          .from(users)
          .where(eq(users.id, row.defenderId));
        return {
          userId: row.defenderId,
          userName: user?.name || 'Usuario desconocido',
          userColor: user?.color || '#888888',
          amount: row.total || 0,
        };
      })
    );

    // Get user details for lost
    const lostToUser = await Promise.all(
      lostToUserResult.map(async (row) => {
        const [user] = await this.db
          .select({ id: users.id, name: users.name, color: users.color })
          .from(users)
          .where(eq(users.id, row.attackerId));
        return {
          userId: row.attackerId,
          userName: user?.name || 'Usuario desconocido',
          userColor: user?.color || '#888888',
          amount: row.total || 0,
        };
      })
    );

    return {
      totalStolen: stolenResult[0]?.total || 0,
      totalLost: lostResult[0]?.total || 0,
      stolenByUser: stolenByUser.sort((a, b) => b.amount - a.amount),
      lostToUser: lostToUser.sort((a, b) => b.amount - a.amount),
    };
  }

  // Email Notifications
  async recordEmailNotification(data: InsertEmailNotification): Promise<EmailNotification> {
    const [notification] = await this.db
      .insert(emailNotifications)
      .values(data)
      .returning();
    
    return notification;
  }

  async getEmailPreferences(userId: string): Promise<EmailPreferences | undefined> {
    const [prefs] = await this.db
      .select()
      .from(emailPreferences)
      .where(eq(emailPreferences.userId, userId));
    
    return prefs || undefined;
  }

  async createEmailPreferences(userId: string): Promise<EmailPreferences> {
    const [prefs] = await this.db
      .insert(emailPreferences)
      .values({ userId })
      .returning();
    
    return prefs;
  }

  async updateEmailPreferences(
    userId: string,
    data: Partial<InsertEmailPreferences>
  ): Promise<EmailPreferences> {
    const [updated] = await this.db
      .update(emailPreferences)
      .set(data)
      .where(eq(emailPreferences.userId, userId))
      .returning();
    
    return updated;
  }

  // --- Ephemeral Photos ---

  async ensureEphemeralPhotosTable(): Promise<void> {
    try {
      await this.db.run(sql`CREATE TABLE IF NOT EXISTS ephemeral_photos (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        photo_data TEXT NOT NULL,
        message TEXT,
        area_stolen REAL,
        viewed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TEXT NOT NULL
      )`);
    } catch (_) {}
  }

  async createEphemeralPhoto(data: InsertEphemeralPhoto): Promise<EphemeralPhoto> {
    await this.ensureEphemeralPhotosTable();
    const [photo] = await this.db
      .insert(ephemeralPhotos)
      .values(data)
      .returning();
    return photo;
  }

  async getPendingPhotosForUser(userId: string): Promise<Array<EphemeralPhoto & { senderName: string; senderUsername: string; senderAvatar: string | null }>> {
    await this.ensureEphemeralPhotosTable();
    const results = await this.db
      .select({
        id: ephemeralPhotos.id,
        senderId: ephemeralPhotos.senderId,
        recipientId: ephemeralPhotos.recipientId,
        photoData: ephemeralPhotos.photoData,
        message: ephemeralPhotos.message,
        areaStolen: ephemeralPhotos.areaStolen,
        viewed: ephemeralPhotos.viewed,
        createdAt: ephemeralPhotos.createdAt,
        expiresAt: ephemeralPhotos.expiresAt,
        senderName: users.name,
        senderUsername: users.username,
        senderAvatar: users.avatar,
      })
      .from(ephemeralPhotos)
      .innerJoin(users, eq(ephemeralPhotos.senderId, users.id))
      .where(
        and(
          eq(ephemeralPhotos.recipientId, userId),
          eq(ephemeralPhotos.viewed, false)
        )
      );
    return results as any;
  }

  async viewAndDeleteEphemeralPhoto(photoId: string, userId: string): Promise<EphemeralPhoto | null> {
    await this.ensureEphemeralPhotosTable();
    const [photo] = await this.db
      .select()
      .from(ephemeralPhotos)
      .where(
        and(
          eq(ephemeralPhotos.id, photoId),
          eq(ephemeralPhotos.recipientId, userId)
        )
      );
    if (!photo) return null;
    
    // Delete immediately after retrieval
    await this.db.delete(ephemeralPhotos).where(eq(ephemeralPhotos.id, photoId));
    return photo;
  }

  async cleanupExpiredPhotos(): Promise<number> {
    await this.ensureEphemeralPhotosTable();
    const now = new Date().toISOString();
    const result = await this.db
      .delete(ephemeralPhotos)
      .where(sql`${ephemeralPhotos.expiresAt} < ${now}`);
    return result.rowsAffected || 0;
  }

  // --- Social Feed ---

  async ensureFeedTables(): Promise<void> {
    try {
      await this.db.run(sql`CREATE TABLE IF NOT EXISTS feed_events (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        route_id TEXT REFERENCES routes(id) ON DELETE SET NULL,
        victim_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        area_stolen REAL,
        distance REAL,
        duration INTEGER,
        new_area REAL,
        ran_together_with TEXT,
        record_type TEXT,
        record_value REAL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      await this.db.run(sql`CREATE TABLE IF NOT EXISTS feed_comments (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        feed_event_id TEXT NOT NULL REFERENCES feed_events(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        parent_id TEXT,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
    } catch (_) {}
  }

  async createFeedEvent(data: InsertFeedEvent): Promise<FeedEvent> {
    await this.ensureFeedTables();
    const [event] = await this.db
      .insert(feedEvents)
      .values(data)
      .returning();
    return event;
  }

  async deleteFeedEventsByRouteId(routeId: string): Promise<void> {
    await this.ensureFeedTables();
    // Delete comments first, then events (raw SQL to avoid ON DELETE SET NULL race)
    await this.db.run(sql`DELETE FROM feed_comments WHERE feed_event_id IN (SELECT id FROM feed_events WHERE route_id = ${routeId})`);
    await this.db.run(sql`DELETE FROM feed_events WHERE route_id = ${routeId}`);
  }

  async getFeedForUser(userId: string, limit: number = 30, offset: number = 0): Promise<FeedEventWithDetails[]> {
    await this.ensureFeedTables();
    // Get user's friend IDs
    const friendIds = await this.getFriendIds(userId);
    // Feed includes own events + friends' events
    const allUserIds = [userId, ...friendIds];

    if (allUserIds.length === 0) return [];

    // Get feed events
    const events = await this.db
      .select()
      .from(feedEvents)
      .where(inArray(feedEvents.userId, allUserIds))
      .orderBy(desc(feedEvents.createdAt))
      .limit(limit)
      .offset(offset);

    if (events.length === 0) return [];

    // Batch: collect all unique user IDs, route IDs, and event IDs
    const userIdsNeeded = new Set<string>();
    const routeIdsNeeded = new Set<string>();
    const eventIds: string[] = [];

    for (const event of events) {
      userIdsNeeded.add(event.userId);
      if (event.victimId) userIdsNeeded.add(event.victimId);
      if (event.routeId) routeIdsNeeded.add(event.routeId);
      eventIds.push(event.id);
    }

    // Batch fetch all users in one query
    const usersList = userIdsNeeded.size > 0
      ? await this.db.select().from(users).where(inArray(users.id, [...userIdsNeeded]))
      : [];
    const userMap = new Map(usersList.map(u => [u.id, u]));

    // Batch fetch all routes in one query
    const routesList = routeIdsNeeded.size > 0
      ? await this.db.select().from(routes).where(inArray(routes.id, [...routeIdsNeeded]))
      : [];
    const routeMap = new Map(routesList.map(r => [r.id, r]));

    // Batch fetch all comment counts in one query
    const commentCounts = eventIds.length > 0
      ? await this.db
          .select({ feedEventId: feedComments.feedEventId, count: sql<number>`COUNT(*)` })
          .from(feedComments)
          .where(inArray(feedComments.feedEventId, eventIds))
          .groupBy(feedComments.feedEventId)
      : [];
    const commentCountMap = new Map(commentCounts.map(c => [c.feedEventId, c.count]));

    // Build result from cached data (no more individual queries)
    const result: FeedEventWithDetails[] = [];
    for (const event of events) {
      const eventUser = userMap.get(event.userId);
      if (!eventUser) continue;

      let victim = null;
      if (event.victimId) {
        const v = userMap.get(event.victimId);
        if (v) {
          victim = { id: v.id, username: v.username, name: v.name, color: v.color, avatar: v.avatar };
        }
      }

      let routeName: string | null = null;
      let activityDate: string | null = null;
      if (event.routeId) {
        const route = routeMap.get(event.routeId);
        if (route) {
          routeName = route.name;
          activityDate = route.startedAt;
        }
      }

      const commentCount = commentCountMap.get(event.id) || 0;

      result.push({
        ...event,
        user: { id: eventUser.id, username: eventUser.username, name: eventUser.name, color: eventUser.color, avatar: eventUser.avatar },
        victim,
        routeName,
        activityDate,
        commentCount,
      });
    }

    return result;
  }

  async getFeedEventComments(eventId: string): Promise<FeedCommentWithUser[]> {
    await this.ensureFeedTables();

    const rawComments = await this.db
      .select({
        id: feedComments.id,
        feedEventId: feedComments.feedEventId,
        userId: feedComments.userId,
        parentId: feedComments.parentId,
        content: feedComments.content,
        createdAt: feedComments.createdAt,
        userName: users.name,
        userUsername: users.username,
        userAvatar: users.avatar,
      })
      .from(feedComments)
      .innerJoin(users, eq(feedComments.userId, users.id))
      .where(eq(feedComments.feedEventId, eventId))
      .orderBy(feedComments.createdAt);

    if (rawComments.length === 0) return [];

    const allComments: FeedCommentWithUser[] = rawComments.map((row) => ({
      id: row.id,
      feedEventId: row.feedEventId,
      userId: row.userId,
      parentId: row.parentId,
      content: row.content,
      createdAt: row.createdAt,
      user: {
        id: row.userId,
        username: row.userUsername,
        name: row.userName,
        avatar: row.userAvatar,
      },
      replies: [],
    }));

    // Group into top-level + replies
    const topLevel = allComments.filter(c => !c.parentId);
    const replies = allComments.filter(c => c.parentId);
    for (const reply of replies) {
      const parent = topLevel.find(c => c.id === reply.parentId);
      if (parent) {
        parent.replies = parent.replies || [];
        parent.replies.push(reply);
      }
    }
    return topLevel;
  }

  async addFeedComment(data: InsertFeedComment): Promise<FeedComment> {
    await this.ensureFeedTables();
    const [comment] = await this.db
      .insert(feedComments)
      .values(data)
      .returning();
    return comment;
  }

  async deleteFeedComment(commentId: string, userId: string): Promise<boolean> {
    await this.ensureFeedTables();
    const result = await this.db
      .delete(feedComments)
      .where(and(eq(feedComments.id, commentId), eq(feedComments.userId, userId)));
    return (result.rowsAffected || 0) > 0;
  }

  async getFeedEvent(eventId: string): Promise<FeedEvent | undefined> {
    await this.ensureFeedTables();
    const [event] = await this.db
      .select()
      .from(feedEvents)
      .where(eq(feedEvents.id, eventId));
    return event || undefined;
  }

  async getFeedCommentById(commentId: string): Promise<FeedComment | undefined> {
    await this.ensureFeedTables();
    const [comment] = await this.db
      .select()
      .from(feedComments)
      .where(eq(feedComments.id, commentId));
    return comment || undefined;
  }

  // ===== Inactivity Reminders =====

  /**
   * Ensure the inactivity_reminders table exists (auto-create if missing)
   */
  async ensureInactivityRemindersTable(): Promise<void> {
    try {
      await this.db.run(sql`
        CREATE TABLE IF NOT EXISTS inactivity_reminders (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          message_index INTEGER NOT NULL,
          sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
    } catch (e) {
      // Table likely already exists
    }
  }

  /**
   * Get the date of the user's last activity (most recent route completedAt).
   * Returns null if user has never uploaded an activity.
   */
  async getLastActivityDate(userId: string): Promise<string | null> {
    const result = await this.db
      .select({ completedAt: routes.completedAt })
      .from(routes)
      .where(eq(routes.userId, userId))
      .orderBy(desc(routes.completedAt))
      .limit(1);
    return result.length > 0 ? result[0].completedAt : null;
  }

  /**
   * Get the last inactivity reminder sent to a user.
   */
  async getLastInactivityReminder(userId: string): Promise<InactivityReminder | null> {
    await this.ensureInactivityRemindersTable();
    const result = await this.db
      .select()
      .from(inactivityReminders)
      .where(eq(inactivityReminders.userId, userId))
      .orderBy(desc(inactivityReminders.sentAt))
      .limit(1);
    return result.length > 0 ? result[0] : null;
  }

  /**
   * Save a record of sending an inactivity reminder.
   */
  async saveInactivityReminder(userId: string, messageIndex: number): Promise<void> {
    await this.ensureInactivityRemindersTable();
    await this.db
      .insert(inactivityReminders)
      .values({
        userId,
        messageIndex,
      });
  }

  // ===== Territory Loss Notifications =====

  /**
   * Ensure the territory_loss_notifications table exists (auto-create if missing)
   */
  async ensureTerritoryLossNotificationsTable(): Promise<void> {
    try {
      await this.db.run(sql`
        CREATE TABLE IF NOT EXISTS territory_loss_notifications (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          message_index INTEGER NOT NULL,
          sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
    } catch (e) {
      // Table likely already exists
    }
  }

  /**
   * Get the last territory loss notification sent to a user.
   */
  async getLastTerritoryLossNotification(userId: string): Promise<TerritoryLossNotification | null> {
    await this.ensureTerritoryLossNotificationsTable();
    const result = await this.db
      .select()
      .from(territoryLossNotifications)
      .where(eq(territoryLossNotifications.userId, userId))
      .orderBy(desc(territoryLossNotifications.sentAt))
      .limit(1);
    return result.length > 0 ? result[0] : null;
  }

  /**
   * Save a record of sending a territory loss notification.
   */
  async saveTerritoryLossNotification(userId: string, messageIndex: number): Promise<void> {
    await this.ensureTerritoryLossNotificationsTable();
    await this.db
      .insert(territoryLossNotifications)
      .values({
        userId,
        messageIndex,
      });
  }
}
