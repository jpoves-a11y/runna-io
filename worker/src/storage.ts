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
  type UserWithStats,
  type TerritoryWithUser,
  type RouteWithTerritory,
} from '../../shared/schema';
import { eq, desc, sql, and } from 'drizzle-orm';
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

        // Parse coordinates from JSON string (SQLite stores as text)
        const parsedCoordinates = typeof route.coordinates === 'string'
          ? JSON.parse(route.coordinates)
          : route.coordinates;

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

  async deleteTerritoryById(id: string): Promise<void> {
    await this.db.delete(territories).where(eq(territories.id, id));
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
      await this.db.delete(territories).where(eq(territories.id, territoryId));
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
      .where(eq(territories.id, territoryId))
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
    const allUsers = await this.getAllUsersWithStats();
    
    return allUsers.filter((user) => friendIds.includes(user.id));
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

  async deleteRouteById(id: string): Promise<void> {
    await this.db.delete(routes).where(eq(routes.id, id));
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
}
