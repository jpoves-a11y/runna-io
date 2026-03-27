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
  corosAccounts,
  corosActivities,
  conquestMetrics,
  emailNotifications,
  emailPreferences,
  ephemeralPhotos,
  feedEvents,
  feedComments,
  feedReactions,
  inactivityReminders,
  territoryLossNotifications,
  competitions,
  treasures,
  userPowers,
  competitionStats,
  weeklySummaries,
  userNicknames,
  territoryFortifications,
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
  type CorosAccount,
  type InsertCorosAccount,
  type CorosActivity,
  type InsertCorosActivity,
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
  type FeedReaction,
  type InsertFeedReaction,
  type FeedEventWithDetails,
  type FeedCommentWithUser,
  type Competition,
  type Treasure,
  type UserPower,
  type CompetitionStat,
  type WeeklySummary,
  type UserNickname,
  type TreasurePowerType,
  type TreasureRarity,
  TREASURE_DEFINITIONS,
  RARITY_CONFIG,
  ZARAGOZA_BOUNDS,
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

// Helper to safely parse a geometry (handles string or object, Polygon or MultiPolygon)
function safeParseGeometry(geometry: any): any {
  if (typeof geometry === 'string') {
    try { return JSON.parse(geometry); } catch { return null; }
  }
  return geometry;
}

// Helper to safely compute union of two geometries, returning null on failure
function safeUnion(geomA: any, geomB: any): any | null {
  try {
    const featureA = geometryToFeature(geomA);
    const featureB = geometryToFeature(geomB);
    const result = turf.union(turf.featureCollection([featureA, featureB]));
    return result ? result.geometry : null;
  } catch (err) {
    console.error('[TERRITORY] safeUnion failed:', err);
    return null;
  }
}

export class WorkerStorage {
  private _competitionTablesEnsured = false;
  private _feedTablesEnsured = false;
  constructor(private db: Database) {}

  async getUser(id: string): Promise<User | undefined> {
    const [user] = await this.db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  /** Batch-load multiple users by IDs in a single query (saves N subrequests → 1) */
  async getUsersByIds(ids: string[]): Promise<User[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(id => `'${id.replace(/'/g, "''")}'`).join(',');
    return await this.db.all<User>(
      sql.raw(`SELECT * FROM users WHERE id IN (${placeholders})`)
    );
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

  // Ensure a "system" user exists for system-generated feed events (treasure spawns, etc.)
  static readonly SYSTEM_USER_ID = '__system_runna__';
  async ensureSystemUser(): Promise<string> {
    const existing = await this.db.select().from(users).where(eq(users.id, WorkerStorage.SYSTEM_USER_ID)).limit(1);
    if (existing.length > 0) return WorkerStorage.SYSTEM_USER_ID;
    try {
      await this.db.run(sql`INSERT OR IGNORE INTO users (id, username, email, name, password, color) VALUES (${WorkerStorage.SYSTEM_USER_ID}, '_runna_system', 'system@runna.io', 'Runna', '', '#16a34a')`);
    } catch (_) { /* already exists from race */ }
    return WorkerStorage.SYSTEM_USER_ID;
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
    // Safely stringify coordinates — avoid double-encoding if already a string
    const coordsValue = typeof insertRoute.coordinates === 'string'
      ? insertRoute.coordinates
      : JSON.stringify(insertRoute.coordinates);
    const routeValues = {
      ...insertRoute,
      coordinates: coordsValue,
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

  async getRoutesByUserIdChronologicalPaginated(userId: string, limit: number, offset: number): Promise<Route[]> {
    return await this.db
      .select()
      .from(routes)
      .where(eq(routes.userId, userId))
      .orderBy(routes.completedAt)
      .limit(limit)
      .offset(offset);
  }

  async getRouteCountByUserId(userId: string): Promise<number> {
    const result = await this.db
      .select({ count: sql<number>`COUNT(*)` })
      .from(routes)
      .where(eq(routes.userId, userId));
    return Number(result[0]?.count || 0);
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

  // Get routes from specific users that started within a time window of a given timestamp
  async getRoutesInTimeWindow(userIds: string[], centerTime: string, windowMs: number = 15 * 60 * 1000): Promise<Route[]> {
    if (userIds.length === 0) return [];
    const center = new Date(centerTime).getTime();
    const minTime = new Date(center - windowMs).toISOString();
    const maxTime = new Date(center + windowMs).toISOString();
    const placeholders = userIds.map(id => `'${id.replace(/'/g, "''")}'`).join(',');
    return await this.db
      .select()
      .from(routes)
      .where(sql`${routes.userId} IN (${sql.raw(placeholders)}) AND ${routes.startedAt} >= ${minTime} AND ${routes.startedAt} <= ${maxTime}`);
  }

  // Get routes from specific users that started after a given timestamp
  // Used to detect "future routes" — enemy routes that were run after the current route
  async getRoutesStartedAfter(userIds: string[], afterTime: string): Promise<Route[]> {
    if (userIds.length === 0) return [];
    const minTime = new Date(afterTime).toISOString();
    const placeholders = userIds.map(id => `'${id.replace(/'/g, "''")}'`).join(',');
    return await this.db
      .select()
      .from(routes)
      .where(sql`${routes.userId} IN (${sql.raw(placeholders)}) AND ${routes.startedAt} > ${minTime}`);
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
            let parsed = JSON.parse(route.coordinates);
            // Handle double-encoded JSON strings (legacy bug: coordinates were JSON.stringify'd twice)
            if (typeof parsed === 'string') {
              try { parsed = JSON.parse(parsed); } catch (_) {}
            }
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
        ranTogetherWith: routes.ranTogetherWith,
      })
      .from(territories)
      .leftJoin(users, eq(territories.userId, users.id))
      .leftJoin(routes, eq(territories.routeId, routes.id))
      .orderBy(desc(territories.conqueredAt));

    return this._enrichTerritoriesWithCoRunnerColors(allTerritories);
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
        ranTogetherWith: routes.ranTogetherWith,
      })
      .from(territories)
      .leftJoin(users, eq(territories.userId, users.id))
      .leftJoin(routes, eq(territories.routeId, routes.id))
      .where(inArray(territories.userId, userIds))
      .orderBy(desc(territories.conqueredAt));

    return this._enrichTerritoriesWithCoRunnerColors(results);
  }

  // Helper: resolve co-runner user colors for territories that have ranTogetherWith
  private async _enrichTerritoriesWithCoRunnerColors(
    rows: Array<{
      id: string; userId: string; routeId: string | null;
      geometry: string; area: number; conqueredAt: string;
      userName: string | null; userUsername: string | null; userColor: string | null;
      ranTogetherWith?: string | null;
    }>
  ): Promise<TerritoryWithUser[]> {
    // Collect all co-runner user IDs across all territories
    const coRunnerIds = new Set<string>();
    const parsedRanTogether = new Map<string, string[]>();
    for (const t of rows) {
      if (t.ranTogetherWith) {
        try {
          const ids: string[] = JSON.parse(t.ranTogetherWith);
          if (Array.isArray(ids) && ids.length > 0) {
            parsedRanTogether.set(t.id, ids);
            ids.forEach(id => coRunnerIds.add(id));
          }
        } catch { /* ignore parse errors */ }
      }
    }

    // Batch-fetch co-runner user colors in a single query
    let coRunnerColorMap = new Map<string, string>();
    if (coRunnerIds.size > 0) {
      const coRunnerUsers = await this.db
        .select({ id: users.id, color: users.color })
        .from(users)
        .where(inArray(users.id, [...coRunnerIds]));
      coRunnerColorMap = new Map(coRunnerUsers.map(u => [u.id, u.color]));
    }

    return rows.map((t) => {
      const coRunnerUserIds = parsedRanTogether.get(t.id);
      const ranTogetherWithColors = coRunnerUserIds
        ? coRunnerUserIds
            .map(uid => ({ id: uid, color: coRunnerColorMap.get(uid) || '#888888' }))
            .filter(u => u.id !== t.userId) // don't include the owner in co-runners
        : undefined;

      return {
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
        ranTogetherWithColors: ranTogetherWithColors && ranTogetherWithColors.length > 0 ? ranTogetherWithColors : undefined,
      };
    });
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
    const parsedGeometry = safeParseGeometry(territory.geometry);
    if (!parsedGeometry) {
      console.error(`[TERRITORY] Could not parse geometry for territory ${territory.id}`);
      return { updatedTerritory: territory, stolenArea: 0 };
    }

    // Use helper to handle both Polygon and MultiPolygon
    let originalFeature: turf.Feature<turf.Polygon | turf.MultiPolygon>;
    let subtractionFeature: turf.Feature<turf.Polygon | turf.MultiPolygon>;
    try {
      originalFeature = geometryToFeature(parsedGeometry);
      subtractionFeature = geometryToFeature(subtractionGeometry);
    } catch (err) {
      console.error(`[TERRITORY] Could not create features for territory ${territory.id}:`, err);
      return { updatedTerritory: territory, stolenArea: 0 };
    }
    
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
    userTerritories: Territory[],
    fortificationMultiplier: number = 1
  ): Promise<{
    territory: Territory;
    totalArea: number;
    newArea: number;
    existingArea: number;
    fortificationLayers: number;
    fortificationArea: number;
  }> {
    // Use helper to handle both Polygon and MultiPolygon
    const newFeature = geometryToFeature(newGeometry);
    let newArea = turf.area(newGeometry);
    let existingAreaInBuffer = 0;
    const overlapGeometries: any[] = [];

    // Calculate how much of the buffer overlaps with existing user territories
    for (const userTerritory of userTerritories) {
      try {
        const parsedGeometry = safeParseGeometry(userTerritory.geometry);
        if (!parsedGeometry) continue;
        
        const userFeature = geometryToFeature(parsedGeometry);
        const overlap = turf.intersect(
          turf.featureCollection([newFeature, userFeature])
        );
        
        if (overlap) {
          existingAreaInBuffer += turf.area(overlap);
          overlapGeometries.push(overlap.geometry);
        }
      } catch (err) {
        console.error('[TERRITORY] Error calculating overlap with existing territory:', err);
      }
    }

    // Save fortification records for overlap zones (batch insert)
    let fortificationLayers = 0;
    const fortRecords: Array<{userId: string; routeId: string; geometry: string; area: number; bboxMinLng: number; bboxMinLat: number; bboxMaxLng: number; bboxMaxLat: number}> = [];
    for (const overlapGeom of overlapGeometries) {
      const overlapArea = turf.area(overlapGeom);
      if (overlapArea < 10) continue; // Skip tiny overlaps
      const bbox = turf.bbox(overlapGeom);
      const recordsToCreate = fortificationMultiplier; // 1 normally, 2 with wall power
      for (let i = 0; i < recordsToCreate; i++) {
        fortRecords.push({
          userId, routeId,
          geometry: JSON.stringify(overlapGeom),
          area: overlapArea,
          bboxMinLng: bbox[0], bboxMinLat: bbox[1],
          bboxMaxLng: bbox[2], bboxMaxLat: bbox[3],
        });
        fortificationLayers++;
      }
    }
    if (fortRecords.length > 0) {
      try {
        await this.createFortificationRecordsBatch(fortRecords);
      } catch (err) {
        console.error('[TERRITORY] Batch fortification insert failed, falling back:', err);
        for (const rec of fortRecords) {
          try { await this.createFortificationRecord(rec); } catch (_) {}
        }
      }
    }

    // True new area = buffer area - overlap with own territories
    const actualNewArea = newArea - existingAreaInBuffer;

    // === SAFE MERGE: compute merged geometry FIRST, before any deletions ===
    let finalGeometry = newGeometry;
    let mergeSucceeded = true;
    
    for (const userTerritory of userTerritories) {
      try {
        const parsedGeometry = safeParseGeometry(userTerritory.geometry);
        if (!parsedGeometry) continue;
        
        const merged = safeUnion(finalGeometry, parsedGeometry);
        if (merged) {
          finalGeometry = merged;
        } else {
          // Union failed for this territory - log but DON'T skip it
          // We'll still have the old territory's area in the final count
          console.error(`[TERRITORY] Union failed for territory ${userTerritory.id}, geometry may be corrupt`);
          mergeSucceeded = false;
        }
      } catch (err) {
        console.error('[TERRITORY] Error merging territories:', err);
        mergeSucceeded = false;
      }
    }

    // Validate the final geometry before committing
    let finalArea: number;
    try {
      finalArea = turf.area(finalGeometry);
      if (finalArea <= 0 || !isFinite(finalArea)) {
        throw new Error(`Invalid final area: ${finalArea}`);
      }
    } catch (err) {
      console.error('[TERRITORY] Final geometry validation failed, keeping existing territories:', err);
      // SAFETY: If we can't validate the merged geometry, DON'T delete anything.
      // Just add the new buffer as a separate territory.
      const [territory] = await this.db
        .insert(territories)
        .values({
          userId,
          routeId,
          geometry: JSON.stringify(newGeometry),
          area: newArea,
          conqueredAt: new Date(),
        })
        .returning();

      // Recalculate total from all territories
      const totalArea = await this.getUserTotalAreaFromTerritories(userId);

      return {
        territory,
        totalArea,
        newArea: actualNewArea,
        existingArea: existingAreaInBuffer,
        fortificationLayers,
        fortificationArea: existingAreaInBuffer,
      };
    }

    // Additional safety check: merged area should be >= each individual territory's area
    // If the merged area is suspiciously small (less than 50% of existing), something went wrong
    const existingTotalArea = userTerritories.reduce((sum, t) => sum + (t.area || 0), 0);
    if (existingTotalArea > 0 && finalArea < existingTotalArea * 0.5) {
      console.error(`[TERRITORY] SAFETY: Merged area (${finalArea}) is much less than existing (${existingTotalArea}). Aborting merge to prevent data loss.`);
      // Add new territory alongside existing ones instead of replacing
      const [territory] = await this.db
        .insert(territories)
        .values({
          userId,
          routeId,
          geometry: JSON.stringify(newGeometry),
          area: newArea,
          conqueredAt: new Date(),
        })
        .returning();

      const totalArea = await this.getUserTotalAreaFromTerritories(userId);

      return {
        territory,
        totalArea,
        newArea: actualNewArea,
        existingArea: existingAreaInBuffer,
        fortificationLayers,
        fortificationArea: existingAreaInBuffer,
      };
    }

    // === Everything validated - now safe to delete old and insert new ===
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
        area: finalArea,
        conqueredAt: new Date(),
      })
      .returning();

    return {
      territory,
      totalArea: finalArea,
      newArea: actualNewArea,
      existingArea: existingAreaInBuffer,
      fortificationLayers,
      fortificationArea: existingAreaInBuffer,
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
      .where(sql`${polarActivities.userId} = ${userId} AND ${polarActivities.processed} = 0 AND ${polarActivities.skipReason} IS NULL`)
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

  // Mark activity for retry by resetting processed flag and clearing skip reason
  async resetPolarActivityForRetry(id: string): Promise<PolarActivity> {
    const [activity] = await this.db
      .update(polarActivities)
      .set({
        processed: false,
        processedAt: null,
        skipReason: null,
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

  // Delete all polar activities that were saved as "skipped" (have a skipReason).
  // These block reimport because getPolarActivityByPolarId finds them and treats them as "already imported".
  // Optionally filter by userId.
  async deleteSkippedPolarActivities(userId?: string | null): Promise<number> {
    const condition = userId
      ? sql`${polarActivities.skipReason} IS NOT NULL AND ${polarActivities.userId} = ${userId}`
      : sql`${polarActivities.skipReason} IS NOT NULL`;
    const result = await this.db.delete(polarActivities).where(condition).returning();
    return result.length;
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

  // ==================== COROS ====================

  async getCorosAccountByUserId(userId: string): Promise<CorosAccount | undefined> {
    const [account] = await this.db.select().from(corosAccounts).where(eq(corosAccounts.userId,userId));
    return account || undefined;
  }

  async getCorosAccountByOpenId(openId: string): Promise<CorosAccount | undefined> {
    const [account] = await this.db.select().from(corosAccounts).where(eq(corosAccounts.corosOpenId, openId));
    return account || undefined;
  }

  async createCorosAccount(data: InsertCorosAccount): Promise<CorosAccount> {
    const [account] = await this.db.insert(corosAccounts).values(data).returning();
    return account;
  }

  async updateCorosAccount(userId: string, data: Partial<InsertCorosAccount>): Promise<CorosAccount> {
    const [account] = await this.db
      .update(corosAccounts)
      .set(data)
      .where(eq(corosAccounts.userId, userId))
      .returning();
    return account;
  }

  async deleteCorosAccount(userId: string): Promise<void> {
    await this.db.delete(corosAccounts).where(eq(corosAccounts.userId, userId));
  }

  async getCorosActivityByWorkoutId(workoutId: string): Promise<CorosActivity | undefined> {
    const [activity] = await this.db.select().from(corosActivities).where(eq(corosActivities.corosWorkoutId, workoutId));
    return activity || undefined;
  }

  async createCorosActivity(data: InsertCorosActivity): Promise<CorosActivity> {
    const [activity] = await this.db.insert(corosActivities).values(data).returning();
    return activity;
  }

  async updateCorosActivity(id: string, data: Partial<InsertCorosActivity>): Promise<CorosActivity> {
    const [activity] = await this.db
      .update(corosActivities)
      .set(data)
      .where(eq(corosActivities.id, id))
      .returning();
    return activity;
  }

  async getUnprocessedCorosActivities(userId: string): Promise<CorosActivity[]> {
    return await this.db
      .select()
      .from(corosActivities)
      .where(sql`${corosActivities.userId} = ${userId} AND ${corosActivities.processed} = 0 AND ${corosActivities.skipReason} IS NULL`)
      .orderBy(desc(corosActivities.startDate));
  }

  async getCorosActivitiesByUserId(userId: string): Promise<CorosActivity[]> {
    return await this.db
      .select()
      .from(corosActivities)
      .where(eq(corosActivities.userId, userId))
      .orderBy(desc(corosActivities.startDate));
  }

  async getCorosActivityById(id: string): Promise<CorosActivity | undefined> {
    const [activity] = await this.db.select().from(corosActivities).where(eq(corosActivities.id, id));
    return activity || undefined;
  }

  async deleteCorosActivity(id: string): Promise<void> {
    await this.db.delete(corosActivities).where(eq(corosActivities.id, id));
  }

  async markCorosActivityProcessed(id: string, routeId: string | null, territoryId: string | null, skipReason: string | null): Promise<CorosActivity> {
    const [activity] = await this.db
      .update(corosActivities)
      .set({
        processed: true,
        processedAt: new Date().toISOString(),
        routeId,
        territoryId,
        skipReason,
      })
      .where(eq(corosActivities.id, id))
      .returning();
    return activity;
  }

  async getCorosActivityStats(userId: string): Promise<{ total: number; unprocessed: number; lastStartDate: Date | null; }> {
    const [aggregate] = await this.db
      .select({
        total: sql<number>`count(*)`,
        unprocessed: sql<number>`sum(case when ${corosActivities.processed} = false then 1 else 0 end)` as any,
        lastStartDate: sql<Date | null>`max(${corosActivities.startDate})`,
      })
      .from(corosActivities)
      .where(eq(corosActivities.userId, userId));

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
        ranTogetherWith: routes.ranTogetherWith,
      })
      .from(territories)
      .leftJoin(users, eq(territories.userId, users.id))
      .leftJoin(routes, eq(territories.routeId, routes.id))
      .where(sql`${territories.userId} IN (${sql.join(allIds.map(id => sql`${id}`), sql`, `)})`);

    return this._enrichTerritoriesWithCoRunnerColors(territoryData);
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
    if (this._feedTablesEnsured) return;
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
        metadata TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      // Add metadata column to existing tables that don't have it yet
      try { await this.db.run(sql`ALTER TABLE feed_events ADD COLUMN metadata TEXT`); } catch (_) { /* column already exists */ }
      // Add skip_reason column to polar_activities
      try { await this.db.run(sql`ALTER TABLE polar_activities ADD COLUMN skip_reason TEXT`); } catch (_) { /* column already exists */ }
      await this.db.run(sql`CREATE TABLE IF NOT EXISTS feed_comments (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        feed_event_id TEXT NOT NULL REFERENCES feed_events(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        parent_id TEXT,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      await this.db.run(sql`CREATE TABLE IF NOT EXISTS feed_reactions (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        reaction_type TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      // Create unique index for one reaction per user per target
      await this.db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_feed_reactions_unique ON feed_reactions(user_id, target_type, target_id)`);
      this._feedTablesEnsured = true;
    } catch (e) {
      console.error('[FEED] ensureFeedTables error:', e);
    }
  }

  async createFeedEvent(data: InsertFeedEvent): Promise<FeedEvent> {
    await this.ensureFeedTables();
    const [event] = await this.db
      .insert(feedEvents)
      .values(data)
      .returning();
    return event;
  }

  async updateFeedEvent(eventId: string, data: { distance?: number; duration?: number; newArea?: number; metadata?: string | null }): Promise<void> {
    await this.ensureFeedTables();
    const updateData: any = {};
    if (data.distance !== undefined) updateData.distance = data.distance;
    if (data.duration !== undefined) updateData.duration = data.duration;
    if (data.newArea !== undefined) updateData.newArea = data.newArea;
    if (data.metadata !== undefined) updateData.metadata = data.metadata;
    if (Object.keys(updateData).length === 0) return;
    await this.db.update(feedEvents).set(updateData).where(eq(feedEvents.id, eventId));
  }

  async getMaxConquestArea(userId: string): Promise<number> {
    await this.ensureFeedTables();
    const result = await this.db
      .select({ max: sql<number>`COALESCE(MAX(${feedEvents.newArea}), 0)` })
      .from(feedEvents)
      .where(and(eq(feedEvents.userId, userId), eq(feedEvents.eventType, 'activity')));
    return result[0]?.max || 0;
  }

  async deleteFeedEventsByRouteId(routeId: string): Promise<void> {
    await this.ensureFeedTables();
    // Delete comments first, then events (raw SQL to avoid ON DELETE SET NULL race)
    await this.db.run(sql`DELETE FROM feed_comments WHERE feed_event_id IN (SELECT id FROM feed_events WHERE route_id = ${routeId})`);
    await this.db.run(sql`DELETE FROM feed_events WHERE route_id = ${routeId}`);
  }

  async getFeedEventByRouteId(routeId: string): Promise<FeedEvent | undefined> {
    await this.ensureFeedTables();
    const [event] = await this.db
      .select()
      .from(feedEvents)
      .where(eq(feedEvents.routeId, routeId));
    return event || undefined;
  }

  async getFeedForUser(userId: string, limit: number = 30, offset: number = 0): Promise<FeedEventWithDetails[]> {
    await this.ensureFeedTables();
    
    // Check if competition is active — if so, show ALL users' events (global feed)
    let isCompetitionMode = false;
    try {
      const comp = await this.getActiveCompetition();
      if (comp) {
        const now = Date.now();
        const start = new Date(comp.startsAt).getTime();
        const end = new Date(comp.endsAt).getTime();
        if (comp.status === 'active' || (now >= start && now <= end)) {
          isCompetitionMode = true;
        }
      }
    } catch (_) {}

    // Get feed events — global during competition, friends-only otherwise
    let events;
    if (isCompetitionMode) {
      events = await this.db
        .select()
        .from(feedEvents)
        .orderBy(desc(feedEvents.createdAt))
        .limit(limit)
        .offset(offset);
    } else {
      const friendIds = await this.getFriendIds(userId);
      const allUserIds = [userId, ...friendIds];
      events = await this.db
        .select()
        .from(feedEvents)
        .where(inArray(feedEvents.userId, allUserIds))
        .orderBy(desc(feedEvents.createdAt))
        .limit(limit)
        .offset(offset);
    }

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

    // Batch fetch all routes in one query (only needed columns)
    const routesList = routeIdsNeeded.size > 0
      ? await this.db.select({
          id: routes.id,
          name: routes.name,
          startedAt: routes.startedAt,
          coordinates: routes.coordinates,
        }).from(routes).where(inArray(routes.id, [...routeIdsNeeded]))
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

    // Batch fetch reaction counts for all events
    const reactionCounts = eventIds.length > 0
      ? await this.db
          .select({
            targetId: feedReactions.targetId,
            reactionType: feedReactions.reactionType,
            count: sql<number>`COUNT(*)`,
          })
          .from(feedReactions)
          .where(and(
            eq(feedReactions.targetType, 'event'),
            inArray(feedReactions.targetId, eventIds)
          ))
          .groupBy(feedReactions.targetId, feedReactions.reactionType)
      : [];
    const likeCountMap = new Map<string, number>();
    const dislikeCountMap = new Map<string, number>();
    for (const r of reactionCounts) {
      if (r.reactionType === 'like') likeCountMap.set(r.targetId, r.count);
      else if (r.reactionType === 'dislike') dislikeCountMap.set(r.targetId, r.count);
    }

    // Batch fetch user's own reactions for all events
    const userReactions = eventIds.length > 0
      ? await this.db
          .select({ targetId: feedReactions.targetId, reactionType: feedReactions.reactionType })
          .from(feedReactions)
          .where(and(
            eq(feedReactions.userId, userId),
            eq(feedReactions.targetType, 'event'),
            inArray(feedReactions.targetId, eventIds)
          ))
      : [];
    const userReactionMap = new Map(userReactions.map(r => [r.targetId, r.reactionType as 'like' | 'dislike']));

    // Batch fetch active nicknames for all involved users
    let nicknameMap = new Map<string, { nickname: string; expiresAt: string }>();
    try {
      nicknameMap = await this.getActiveNicknamesForUsers([...userIdsNeeded]);
    } catch (_) {}

    // Build result from cached data (no more individual queries)
    const result: FeedEventWithDetails[] = [];
    for (const event of events) {
      const eventUser = userMap.get(event.userId);
      if (!eventUser) continue;

      let victim = null;
      if (event.victimId) {
        const v = userMap.get(event.victimId);
        if (v) {
          const vnn = nicknameMap.get(v.id);
          victim = { id: v.id, username: v.username, name: v.name, color: v.color, avatar: v.avatar, nickname: vnn?.nickname || null, nicknameExpiresAt: vnn?.expiresAt || null };
        }
      }

      let routeName: string | null = null;
      let activityDate: string | null = null;
      let routeCoordinates: [number, number][] | null = null;
      if (event.routeId) {
        const route = routeMap.get(event.routeId);
        if (route) {
          routeName = route.name;
          activityDate = route.startedAt;
          // Parse and downsample coordinates for feed animation (max 80 points)
          try {
            const raw: [number, number][] = typeof route.coordinates === 'string'
              ? JSON.parse(route.coordinates)
              : (route.coordinates as any) || [];
            if (raw.length > 0) {
              if (raw.length <= 80) {
                routeCoordinates = raw;
              } else {
                const step = raw.length / 80;
                const sampled: [number, number][] = [];
                for (let i = 0; i < 80; i++) {
                  sampled.push(raw[Math.min(Math.floor(i * step), raw.length - 1)]);
                }
                // Always include the last point
                sampled.push(raw[raw.length - 1]);
                routeCoordinates = sampled;
              }
            }
          } catch { /* ignore parse errors */ }
        }
      }

      const commentCount = commentCountMap.get(event.id) || 0;
      const likeCount = likeCountMap.get(event.id) || 0;
      const dislikeCount = dislikeCountMap.get(event.id) || 0;
      const userReaction = userReactionMap.get(event.id) || null;

      const userNn = nicknameMap.get(eventUser.id);
      result.push({
        ...event,
        user: { id: eventUser.id, username: eventUser.username, name: eventUser.name, color: eventUser.color, avatar: eventUser.avatar, nickname: userNn?.nickname || null, nicknameExpiresAt: userNn?.expiresAt || null },
        victim,
        routeName,
        activityDate,
        routeCoordinates,
        commentCount,
        likeCount,
        dislikeCount,
        userReaction,
      });
    }

    return result;
  }

  async getFeedEventComments(eventId: string, viewerUserId?: string): Promise<FeedCommentWithUser[]> {
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
        userColor: users.color,
      })
      .from(feedComments)
      .innerJoin(users, eq(feedComments.userId, users.id))
      .where(eq(feedComments.feedEventId, eventId))
      .orderBy(feedComments.createdAt);

    if (rawComments.length === 0) return [];

    // Batch fetch reaction counts for all comments
    const commentIds = rawComments.map(c => c.id);
    const reactionCounts = commentIds.length > 0
      ? await this.db
          .select({
            targetId: feedReactions.targetId,
            reactionType: feedReactions.reactionType,
            count: sql<number>`COUNT(*)`,
          })
          .from(feedReactions)
          .where(and(
            eq(feedReactions.targetType, 'comment'),
            inArray(feedReactions.targetId, commentIds)
          ))
          .groupBy(feedReactions.targetId, feedReactions.reactionType)
      : [];
    const likeCounts = new Map<string, number>();
    const dislikeCounts = new Map<string, number>();
    for (const r of reactionCounts) {
      if (r.reactionType === 'like') likeCounts.set(r.targetId, r.count);
      else dislikeCounts.set(r.targetId, r.count);
    }

    // Batch fetch viewer's reactions
    const viewerReactions = viewerUserId && commentIds.length > 0
      ? await this.db
          .select({ targetId: feedReactions.targetId, reactionType: feedReactions.reactionType })
          .from(feedReactions)
          .where(and(
            eq(feedReactions.userId, viewerUserId),
            eq(feedReactions.targetType, 'comment'),
            inArray(feedReactions.targetId, commentIds)
          ))
      : [];
    const viewerReactionMap = new Map(viewerReactions.map(r => [r.targetId, r.reactionType as 'like' | 'dislike']));

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
        color: row.userColor,
      },
      replies: [],
      likeCount: likeCounts.get(row.id) || 0,
      dislikeCount: dislikeCounts.get(row.id) || 0,
      userReaction: viewerReactionMap.get(row.id) || null,
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

  /** Get top preview comments for a feed event — prioritizes comments with replies and most likes */
  async getPreviewComments(eventId: string, viewerUserId: string, limit: number = 3): Promise<FeedCommentWithUser[]> {
    const allComments = await this.getFeedEventComments(eventId, viewerUserId);
    if (allComments.length === 0) return [];

    // Sort: comments with replies first, then by like count desc, then by createdAt asc
    const sorted = [...allComments].sort((a, b) => {
      const aReplies = (a.replies?.length || 0) > 0 ? 1 : 0;
      const bReplies = (b.replies?.length || 0) > 0 ? 1 : 0;
      if (bReplies !== aReplies) return bReplies - aReplies;
      if (b.likeCount !== a.likeCount) return b.likeCount - a.likeCount;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

    // Take up to limit, and for each include at most 1 reply
    const preview = sorted.slice(0, limit).map(c => ({
      ...c,
      replies: c.replies && c.replies.length > 0 ? [c.replies[0]] : [],
    }));

    return preview;
  }

  /** Toggle a reaction (like/dislike). Returns updated counts. */
  async toggleReaction(userId: string, targetType: 'event' | 'comment', targetId: string, reactionType: 'like' | 'dislike'): Promise<{ likeCount: number; dislikeCount: number; userReaction: 'like' | 'dislike' | null }> {
    await this.ensureFeedTables();

    // Check if user already has a reaction on this target
    const [existing] = await this.db
      .select()
      .from(feedReactions)
      .where(and(
        eq(feedReactions.userId, userId),
        eq(feedReactions.targetType, targetType),
        eq(feedReactions.targetId, targetId)
      ));

    if (existing) {
      if (existing.reactionType === reactionType) {
        // Same reaction — remove it (toggle off)
        await this.db.delete(feedReactions).where(eq(feedReactions.id, existing.id));
      } else {
        // Different reaction — switch
        await this.db.update(feedReactions)
          .set({ reactionType })
          .where(eq(feedReactions.id, existing.id));
      }
    } else {
      // No existing reaction — create new
      await this.db.insert(feedReactions).values({
        userId,
        targetType,
        targetId,
        reactionType,
      });
    }

    // Fetch updated counts
    const counts = await this.db
      .select({
        reactionType: feedReactions.reactionType,
        count: sql<number>`COUNT(*)`,
      })
      .from(feedReactions)
      .where(and(
        eq(feedReactions.targetType, targetType),
        eq(feedReactions.targetId, targetId)
      ))
      .groupBy(feedReactions.reactionType);

    let likeCount = 0;
    let dislikeCount = 0;
    for (const c of counts) {
      if (c.reactionType === 'like') likeCount = c.count;
      else if (c.reactionType === 'dislike') dislikeCount = c.count;
    }

    // Get user's current reaction
    const [current] = await this.db
      .select({ reactionType: feedReactions.reactionType })
      .from(feedReactions)
      .where(and(
        eq(feedReactions.userId, userId),
        eq(feedReactions.targetType, targetType),
        eq(feedReactions.targetId, targetId)
      ));

    return { likeCount, dislikeCount, userReaction: (current?.reactionType as 'like' | 'dislike') || null };
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

  // ============ COMPETITION SYSTEM ============

  async ensureCompetitionTables(): Promise<void> {
    if (this._competitionTablesEnsured) return;
    try {
      await this.db.run(sql`CREATE TABLE IF NOT EXISTS competitions (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'upcoming',
        config TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      await this.db.run(sql`CREATE TABLE IF NOT EXISTS treasures (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        competition_id TEXT NOT NULL,
        name TEXT NOT NULL,
        power_type TEXT NOT NULL,
        rarity TEXT NOT NULL,
        lat REAL NOT NULL,
        lng REAL NOT NULL,
        collected_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        collected_at TEXT,
        spawned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
      )`);
      await this.db.run(sql`CREATE TABLE IF NOT EXISTS user_powers (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        competition_id TEXT NOT NULL,
        power_type TEXT NOT NULL,
        treasure_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'available',
        activated_at TEXT,
        used_at TEXT,
        expires_at TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      await this.db.run(sql`CREATE TABLE IF NOT EXISTS competition_stats (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        competition_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        total_area REAL NOT NULL DEFAULT 0,
        total_distance REAL NOT NULL DEFAULT 0,
        total_duration INTEGER NOT NULL DEFAULT 0,
        activities_count INTEGER NOT NULL DEFAULT 0,
        treasures_collected INTEGER NOT NULL DEFAULT 0,
        area_stolen REAL NOT NULL DEFAULT 0,
        unique_victims INTEGER NOT NULL DEFAULT 0,
        ran_together_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      await this.db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_competition_stats_unique ON competition_stats(competition_id, user_id)`);
      await this.db.run(sql`CREATE TABLE IF NOT EXISTS weekly_summaries (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        competition_id TEXT NOT NULL,
        week_number INTEGER NOT NULL,
        data TEXT NOT NULL,
        generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      await this.db.run(sql`CREATE TABLE IF NOT EXISTS user_nicknames (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        target_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        set_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        nickname TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      await this.db.run(sql`CREATE TABLE IF NOT EXISTS territory_fortifications (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        route_id TEXT REFERENCES routes(id) ON DELETE CASCADE,
        geometry TEXT NOT NULL,
        area REAL NOT NULL DEFAULT 0,
        bbox_min_lng REAL,
        bbox_min_lat REAL,
        bbox_max_lng REAL,
        bbox_max_lat REAL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      await this.db.run(sql`CREATE INDEX IF NOT EXISTS idx_fortifications_user ON territory_fortifications(user_id)`);
      await this.db.run(sql`CREATE INDEX IF NOT EXISTS idx_fortifications_bbox ON territory_fortifications(bbox_min_lng, bbox_min_lat, bbox_max_lng, bbox_max_lat)`);
      // Add zone column to treasures
      try { await this.db.run(sql`ALTER TABLE treasures ADD COLUMN zone TEXT`); } catch (_) { /* column already exists */ }
      this._competitionTablesEnsured = true;
    } catch (_) {}
  }

  // --- Competition CRUD ---

  async getActiveCompetition(): Promise<Competition | null> {
    await this.ensureCompetitionTables();
    // Return active or upcoming (for countdown)
    const result = await this.db
      .select()
      .from(competitions)
      .where(sql`${competitions.status} IN ('upcoming', 'active')`)
      .orderBy(desc(competitions.createdAt))
      .limit(1);
    return result.length > 0 ? result[0] : null;
  }

  async getCompetitionById(id: string): Promise<Competition | null> {
    await this.ensureCompetitionTables();
    const result = await this.db.select().from(competitions).where(eq(competitions.id, id)).limit(1);
    return result.length > 0 ? result[0] : null;
  }

  async createCompetition(data: InsertCompetition): Promise<Competition> {
    await this.ensureCompetitionTables();
    const [comp] = await this.db.insert(competitions).values(data).returning();
    return comp;
  }

  async updateCompetitionStatus(id: string, status: string): Promise<void> {
    await this.ensureCompetitionTables();
    await this.db.update(competitions).set({ status }).where(eq(competitions.id, id));
  }

  // --- Treasure methods ---

  async getActiveTreasures(competitionId: string): Promise<Treasure[]> {
    await this.ensureCompetitionTables();
    const now = new Date().toISOString();
    return await this.db
      .select()
      .from(treasures)
      .where(and(
        eq(treasures.competitionId, competitionId),
        eq(treasures.active, true),
        sql`${treasures.collectedBy} IS NULL`,
        sql`${treasures.expiresAt} > ${now}`
      ));
  }

  async getTreasureById(id: string): Promise<Treasure | null> {
    await this.ensureCompetitionTables();
    const result = await this.db.select().from(treasures).where(eq(treasures.id, id)).limit(1);
    return result.length > 0 ? result[0] : null;
  }

  async createTreasure(data: InsertTreasure): Promise<Treasure> {
    await this.ensureCompetitionTables();
    const [t] = await this.db.insert(treasures).values(data).returning();
    return t;
  }

  async collectTreasure(treasureId: string, userId: string): Promise<Treasure | null> {
    await this.ensureCompetitionTables();
    const now = new Date().toISOString();
    // Atomic: only collect if not yet collected
    await this.db
      .update(treasures)
      .set({ collectedBy: userId, collectedAt: now, active: false })
      .where(and(
        eq(treasures.id, treasureId),
        sql`${treasures.collectedBy} IS NULL`,
        eq(treasures.active, true)
      ));
    return this.getTreasureById(treasureId);
  }

  async getAllTreasuresForCompetition(competitionId: string): Promise<Treasure[]> {
    await this.ensureCompetitionTables();
    return await this.db.select().from(treasures).where(eq(treasures.competitionId, competitionId));
  }

  // --- User Powers ---

  async getUserPowers(userId: string, competitionId: string): Promise<UserPower[]> {
    await this.ensureCompetitionTables();
    return await this.db
      .select()
      .from(userPowers)
      .where(and(
        eq(userPowers.userId, userId),
        eq(userPowers.competitionId, competitionId)
      ))
      .orderBy(desc(userPowers.createdAt));
  }

  async getAvailablePowers(userId: string, competitionId: string): Promise<UserPower[]> {
    await this.ensureCompetitionTables();
    return await this.db
      .select()
      .from(userPowers)
      .where(and(
        eq(userPowers.userId, userId),
        eq(userPowers.competitionId, competitionId),
        eq(userPowers.status, 'available')
      ));
  }

  async getActivePowersForUser(userId: string, competitionId: string): Promise<UserPower[]> {
    await this.ensureCompetitionTables();
    const now = new Date().toISOString();
    return await this.db
      .select()
      .from(userPowers)
      .where(and(
        eq(userPowers.userId, userId),
        eq(userPowers.competitionId, competitionId),
        eq(userPowers.status, 'active'),
        sql`(${userPowers.expiresAt} IS NULL OR ${userPowers.expiresAt} > ${now})`
      ));
  }

  async createUserPower(data: InsertUserPower): Promise<UserPower> {
    await this.ensureCompetitionTables();
    const [p] = await this.db.insert(userPowers).values(data).returning();
    return p;
  }

  /** Batch create multiple user powers in a single query (saves N subrequests → 1) */
  async createUserPowersBatch(powers: Array<{ id: string; userId: string; competitionId: string; powerType: string; treasureId: string; status: string }>): Promise<void> {
    if (powers.length === 0) return;
    await this.ensureCompetitionTables();
    const values = powers.map(p =>
      `('${p.id.replace(/'/g, "''")}', '${p.userId.replace(/'/g, "''")}', '${p.competitionId.replace(/'/g, "''")}', '${p.powerType.replace(/'/g, "''")}', '${p.treasureId.replace(/'/g, "''")}', '${p.status.replace(/'/g, "''")}', datetime('now'))`
    ).join(',');
    await this.db.run(sql.raw(`INSERT INTO user_powers (id, user_id, competition_id, power_type, treasure_id, status, created_at) VALUES ${values}`));
  }

  /** Batch consume multiple powers in a single query (saves N subrequests → 1) */
  async usePowersBatch(powerIds: string[]): Promise<void> {
    if (powerIds.length === 0) return;
    await this.ensureCompetitionTables();
    const now = new Date().toISOString();
    const placeholders = powerIds.map(id => `'${id.replace(/'/g, "''")}'`).join(',');
    await this.db.run(sql.raw(`UPDATE user_powers SET status = 'used', used_at = '${now}' WHERE id IN (${placeholders}) AND status IN ('available', 'active')`));
  }

  async activatePower(powerId: string): Promise<void> {
    await this.ensureCompetitionTables();
    const now = new Date().toISOString();
    await this.db
      .update(userPowers)
      .set({ status: 'active', activatedAt: now })
      .where(and(eq(userPowers.id, powerId), eq(userPowers.status, 'available')));
  }

  async setPowerExpiration(powerId: string, expiresAt: string): Promise<void> {
    await this.ensureCompetitionTables();
    await this.db.update(userPowers).set({ expiresAt }).where(eq(userPowers.id, powerId));
  }

  async getAllPushSubscriptions() {
    return await this.db.select().from(pushSubscriptions);
  }

  async usePower(powerId: string): Promise<void> {
    await this.ensureCompetitionTables();
    const now = new Date().toISOString();
    await this.db
      .update(userPowers)
      .set({ status: 'used', usedAt: now })
      .where(and(
        eq(userPowers.id, powerId),
        sql`${userPowers.status} IN ('available', 'active')`
      ));
  }

  async getPowerById(powerId: string): Promise<UserPower | null> {
    await this.ensureCompetitionTables();
    const result = await this.db.select().from(userPowers).where(eq(userPowers.id, powerId)).limit(1);
    return result.length > 0 ? result[0] : null;
  }

  /** Check if user has an active (not expired) shield power */
  async hasActiveShield(userId: string, competitionId: string): Promise<boolean> {
    const now = new Date().toISOString();
    const result = await this.db
      .select()
      .from(userPowers)
      .where(and(
        eq(userPowers.userId, userId),
        eq(userPowers.competitionId, competitionId),
        eq(userPowers.powerType, 'shield'),
        eq(userPowers.status, 'active'),
        sql`(${userPowers.expiresAt} IS NULL OR ${userPowers.expiresAt} > ${now})`
      ))
      .limit(1);
    return result.length > 0;
  }

  /** Check if user has an active time_bomb */
  async hasActiveTimeBomb(userId: string, competitionId: string): Promise<boolean> {
    const now = new Date().toISOString();
    const result = await this.db
      .select()
      .from(userPowers)
      .where(and(
        eq(userPowers.userId, userId),
        eq(userPowers.competitionId, competitionId),
        eq(userPowers.powerType, 'time_bomb'),
        eq(userPowers.status, 'active'),
        sql`(${userPowers.expiresAt} IS NULL OR ${userPowers.expiresAt} > ${now})`
      ))
      .limit(1);
    return result.length > 0;
  }

  /** Check if user has invisible territory (capa de sombras) */
  async hasInvisibility(userId: string, competitionId: string): Promise<boolean> {
    const now = new Date().toISOString();
    const result = await this.db
      .select()
      .from(userPowers)
      .where(and(
        eq(userPowers.userId, userId),
        eq(userPowers.competitionId, competitionId),
        eq(userPowers.powerType, 'invisibility'),
        eq(userPowers.status, 'active'),
        sql`(${userPowers.expiresAt} IS NULL OR ${userPowers.expiresAt} > ${now})`
      ))
      .limit(1);
    return result.length > 0;
  }

  /** Generic check for any active power type */
  async hasActivePowerOfType(userId: string, competitionId: string, powerType: string): Promise<boolean> {
    const now = new Date().toISOString();
    const result = await this.db
      .select()
      .from(userPowers)
      .where(and(
        eq(userPowers.userId, userId),
        eq(userPowers.competitionId, competitionId),
        eq(userPowers.powerType, powerType),
        eq(userPowers.status, 'active'),
        sql`(${userPowers.expiresAt} IS NULL OR ${userPowers.expiresAt} > ${now})`
      ))
      .limit(1);
    return result.length > 0;
  }

  /** Batch-load all active defensive powers for multiple users in ONE query (saves N*4 subrequests) */
  async getActiveDefensivePowersForUsers(userIds: string[], competitionId: string): Promise<Array<{ userId: string; powerType: string }>> {
    if (userIds.length === 0) return [];
    await this.ensureCompetitionTables();
    const now = new Date().toISOString();
    const defensiveTypes = ['shield', 'invisibility', 'time_bomb', 'sentinel'];
    const result = await this.db
      .select({
        userId: userPowers.userId,
        powerType: userPowers.powerType,
      })
      .from(userPowers)
      .where(and(
        inArray(userPowers.userId, userIds),
        eq(userPowers.competitionId, competitionId),
        inArray(userPowers.powerType, defensiveTypes),
        eq(userPowers.status, 'active'),
        sql`(${userPowers.expiresAt} IS NULL OR ${userPowers.expiresAt} > ${now})`
      ));
    return result;
  }

  // --- Competition Stats ---

  async getOrCreateCompetitionStats(competitionId: string, userId: string): Promise<CompetitionStat> {
    await this.ensureCompetitionTables();
    const existing = await this.db
      .select()
      .from(competitionStats)
      .where(and(
        eq(competitionStats.competitionId, competitionId),
        eq(competitionStats.userId, userId)
      ))
      .limit(1);
    if (existing.length > 0) return existing[0];
    const [created] = await this.db.insert(competitionStats).values({
      competitionId,
      userId,
      totalArea: 0,
      totalDistance: 0,
      totalDuration: 0,
      activitiesCount: 0,
      treasuresCollected: 0,
      areaStolen: 0,
      uniqueVictims: 0,
      ranTogetherCount: 0,
    }).returning();
    return created;
  }

  async updateCompetitionStats(
    competitionId: string,
    userId: string,
    updates: Partial<{
      totalArea: number;
      totalDistance: number;
      totalDuration: number;
      activitiesCount: number;
      treasuresCollected: number;
      areaStolen: number;
      uniqueVictims: number;
      ranTogetherCount: number;
    }>
  ): Promise<void> {
    await this.ensureCompetitionTables();
    const now = new Date().toISOString();
    await this.db
      .update(competitionStats)
      .set({ ...updates, updatedAt: now })
      .where(and(
        eq(competitionStats.competitionId, competitionId),
        eq(competitionStats.userId, userId)
      ));
  }

  async incrementCompetitionStats(
    competitionId: string,
    userId: string,
    increments: {
      distance?: number;
      duration?: number;
      activities?: number;
      treasures?: number;
      areaStolen?: number;
      ranTogether?: number;
    }
  ): Promise<void> {
    await this.ensureCompetitionTables();
    await this.getOrCreateCompetitionStats(competitionId, userId);
    const now = new Date().toISOString();
    // Build a single SQL UPDATE with all increments combined (saves 5+ subrequests vs individual calls)
    const setParts: string[] = [`updated_at = '${now}'`];
    if (increments.distance != null && increments.distance > 0) {
      setParts.push(`total_distance = total_distance + ${increments.distance}`);
    }
    if (increments.duration != null && increments.duration > 0) {
      setParts.push(`total_duration = total_duration + ${increments.duration}`);
    }
    if (increments.activities != null && increments.activities > 0) {
      setParts.push(`activities_count = activities_count + ${increments.activities}`);
    }
    if (increments.treasures != null && increments.treasures > 0) {
      setParts.push(`treasures_collected = treasures_collected + ${increments.treasures}`);
    }
    if (increments.areaStolen != null && increments.areaStolen > 0) {
      setParts.push(`area_stolen = area_stolen + ${increments.areaStolen}`);
    }
    if (increments.ranTogether != null && increments.ranTogether > 0) {
      setParts.push(`ran_together_count = ran_together_count + ${increments.ranTogether}`);
    }
    if (setParts.length > 1) {
      await this.db.run(sql.raw(`UPDATE competition_stats SET ${setParts.join(', ')} WHERE competition_id = '${competitionId}' AND user_id = '${userId}'`));
    }
  }

  /** Count distinct victims (defenders) this user has conquered, from conquest_metrics */
  async getDistinctVictimsCount(attackerId: string): Promise<number> {
    const result = await this.db
      .select({ count: sql<number>`COUNT(DISTINCT ${conquestMetrics.defenderId})` })
      .from(conquestMetrics)
      .where(eq(conquestMetrics.attackerId, attackerId));
    return result[0]?.count || 0;
  }

  async getCompetitionLeaderboard(competitionId: string): Promise<(CompetitionStat & { user: Pick<User, 'id' | 'username' | 'name' | 'color' | 'avatar'> })[]> {
    await this.ensureCompetitionTables();
    const stats = await this.db
      .select()
      .from(competitionStats)
      .where(eq(competitionStats.competitionId, competitionId))
      .orderBy(desc(competitionStats.totalArea));
    // Enrich with user info
    const userIds = stats.map(s => s.userId);
    if (userIds.length === 0) return [];
    const usersData = await this.db.select().from(users).where(inArray(users.id, userIds));
    const userMap = new Map(usersData.map(u => [u.id, u]));
    return stats.map(s => ({
      ...s,
      user: (() => {
        const u = userMap.get(s.userId);
        return { id: u?.id || s.userId, username: u?.username || '', name: u?.name || '', color: u?.color || '#888', avatar: u?.avatar || null };
      })(),
    }));
  }

  // --- Weekly Summaries ---

  async getWeeklySummary(competitionId: string, weekNumber: number): Promise<WeeklySummary | null> {
    await this.ensureCompetitionTables();
    const result = await this.db
      .select()
      .from(weeklySummaries)
      .where(and(
        eq(weeklySummaries.competitionId, competitionId),
        eq(weeklySummaries.weekNumber, weekNumber)
      ))
      .limit(1);
    return result.length > 0 ? result[0] : null;
  }

  async createWeeklySummary(data: { competitionId: string; weekNumber: number; data: string }): Promise<WeeklySummary> {
    await this.ensureCompetitionTables();
    const [ws] = await this.db.insert(weeklySummaries).values(data).returning();
    return ws;
  }

  // --- User Nicknames ---

  async getActiveNickname(targetUserId: string): Promise<UserNickname | null> {
    await this.ensureCompetitionTables();
    const now = new Date().toISOString();
    const result = await this.db
      .select()
      .from(userNicknames)
      .where(and(
        eq(userNicknames.targetUserId, targetUserId),
        sql`${userNicknames.expiresAt} > ${now}`
      ))
      .orderBy(desc(userNicknames.createdAt))
      .limit(1);
    return result.length > 0 ? result[0] : null;
  }

  async getActiveNicknamesForUsers(userIds: string[]): Promise<Map<string, { nickname: string; expiresAt: string }>> {
    await this.ensureCompetitionTables();
    const now = new Date().toISOString();
    const result = await this.db
      .select()
      .from(userNicknames)
      .where(and(
        inArray(userNicknames.targetUserId, userIds),
        sql`${userNicknames.expiresAt} > ${now}`
      ));
    // Build map: pick the most recent nickname per target user
    const map = new Map<string, { nickname: string; expiresAt: string }>();
    for (const nn of result) {
      const existing = map.get(nn.targetUserId);
      if (!existing || nn.createdAt > (existing as any).createdAt) {
        map.set(nn.targetUserId, { nickname: nn.nickname, expiresAt: nn.expiresAt });
      }
    }
    return map;
  }

  async createNickname(data: { targetUserId: string; setByUserId: string; nickname: string; expiresAt: string }): Promise<UserNickname> {
    await this.ensureCompetitionTables();
    const [nn] = await this.db.insert(userNicknames).values(data).returning();
    return nn;
  }

  // --- Territory Fortifications ---

  async createFortificationRecord(data: {
    userId: string;
    routeId: string;
    geometry: string;
    area: number;
    bboxMinLng: number;
    bboxMinLat: number;
    bboxMaxLng: number;
    bboxMaxLat: number;
  }): Promise<void> {
    await this.ensureCompetitionTables();
    await this.db.run(sql`INSERT INTO territory_fortifications (id, user_id, route_id, geometry, area, bbox_min_lng, bbox_min_lat, bbox_max_lng, bbox_max_lat)
      VALUES (lower(hex(randomblob(16))), ${data.userId}, ${data.routeId}, ${data.geometry}, ${data.area}, ${data.bboxMinLng}, ${data.bboxMinLat}, ${data.bboxMaxLng}, ${data.bboxMaxLat})`);
  }

  /** Batch insert multiple fortification records in a single query (saves N subrequests → 1) */
  async createFortificationRecordsBatch(records: Array<{
    userId: string;
    routeId: string;
    geometry: string;
    area: number;
    bboxMinLng: number;
    bboxMinLat: number;
    bboxMaxLng: number;
    bboxMaxLat: number;
  }>): Promise<void> {
    if (records.length === 0) return;
    await this.ensureCompetitionTables();
    const values = records.map(r =>
      `(lower(hex(randomblob(16))), '${r.userId.replace(/'/g, "''")}', '${r.routeId.replace(/'/g, "''")}', '${r.geometry.replace(/'/g, "''")}', ${r.area}, ${r.bboxMinLng}, ${r.bboxMinLat}, ${r.bboxMaxLng}, ${r.bboxMaxLat})`
    ).join(',');
    await this.db.run(sql.raw(`INSERT INTO territory_fortifications (id, user_id, route_id, geometry, area, bbox_min_lng, bbox_min_lat, bbox_max_lng, bbox_max_lat) VALUES ${values}`));
  }

  async getFortificationsInBbox(userId: string, minLng: number, minLat: number, maxLng: number, maxLat: number): Promise<Array<{ id: string; geometry: string; area: number }>> {
    await this.ensureCompetitionTables();
    const results = await this.db
      .select({
        id: territoryFortifications.id,
        geometry: territoryFortifications.geometry,
        area: territoryFortifications.area,
      })
      .from(territoryFortifications)
      .where(and(
        eq(territoryFortifications.userId, userId),
        sql`${territoryFortifications.bboxMaxLng} >= ${minLng}`,
        sql`${territoryFortifications.bboxMinLng} <= ${maxLng}`,
        sql`${territoryFortifications.bboxMaxLat} >= ${minLat}`,
        sql`${territoryFortifications.bboxMinLat} <= ${maxLat}`
      ));
    return results;
  }

  /** Batch-load fortifications for ALL enemy users in a bbox — single DB call instead of N.
   *  Returns a Map from userId to their fortification records. */
  async getAllFortificationsInBbox(userIds: string[], minLng: number, minLat: number, maxLng: number, maxLat: number): Promise<Map<string, Array<{ id: string; geometry: string; area: number }>>> {
    const result = new Map<string, Array<{ id: string; geometry: string; area: number }>>();
    if (userIds.length === 0) return result;
    await this.ensureCompetitionTables();
    const placeholders = userIds.map(id => `'${id.replace(/'/g, "''")}'`).join(',');
    const rows = await this.db.all<{ id: string; user_id: string; geometry: string; area: number }>(
      sql.raw(`SELECT id, user_id, geometry, area FROM territory_fortifications
        WHERE user_id IN (${placeholders})
        AND bbox_max_lng >= ${minLng} AND bbox_min_lng <= ${maxLng}
        AND bbox_max_lat >= ${minLat} AND bbox_min_lat <= ${maxLat}`)
    );
    for (const row of rows) {
      const uid = row.user_id;
      if (!result.has(uid)) result.set(uid, []);
      result.get(uid)!.push({ id: row.id, geometry: row.geometry, area: row.area });
    }
    return result;
  }

  async getFortificationsByUserId(userId: string): Promise<Array<{ id: string; geometry: string; area: number; routeId: string | null }>> {
    await this.ensureCompetitionTables();
    return await this.db
      .select({
        id: territoryFortifications.id,
        geometry: territoryFortifications.geometry,
        area: territoryFortifications.area,
        routeId: territoryFortifications.routeId,
      })
      .from(territoryFortifications)
      .where(eq(territoryFortifications.userId, userId));
  }

  async getAllFortifications(): Promise<Array<{ id: string; userId: string; geometry: string; area: number }>> {
    await this.ensureCompetitionTables();
    return await this.db
      .select({
        id: territoryFortifications.id,
        userId: territoryFortifications.userId,
        geometry: territoryFortifications.geometry,
        area: territoryFortifications.area,
      })
      .from(territoryFortifications);
  }

  async deleteFortificationsByRouteId(routeId: string): Promise<void> {
    await this.ensureCompetitionTables();
    await this.db.run(sql`DELETE FROM territory_fortifications WHERE route_id = ${routeId}`);
  }

  async deleteFortificationRecord(id: string): Promise<void> {
    await this.ensureCompetitionTables();
    await this.db.run(sql`DELETE FROM territory_fortifications WHERE id = ${id}`);
  }

  /** Delete multiple fortification records in a single query */
  async deleteFortificationRecordsBatch(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.ensureCompetitionTables();
    const placeholders = ids.map(id => `'${id.replace(/'/g, "''")}'`).join(',');
    await this.db.run(sql.raw(`DELETE FROM territory_fortifications WHERE id IN (${placeholders})`));
  }

  /** Batch insert conquest metrics in a single query (saves N subrequests → 1) */
  async recordConquestMetricsBatch(metrics: Array<{ attackerId: string; defenderId: string; areaStolen: number; routeId?: string }>): Promise<void> {
    if (metrics.length === 0) return;
    const values = metrics.map(m => {
      const id = crypto.randomUUID();
      const rid = m.routeId ? `'${m.routeId.replace(/'/g, "''")}'` : 'NULL';
      return `('${id}', '${m.attackerId.replace(/'/g, "''")}', '${m.defenderId.replace(/'/g, "''")}', ${m.areaStolen}, ${rid}, datetime('now'))`;
    }).join(',');
    await this.db.run(sql.raw(`INSERT INTO conquest_metrics (id, attacker_id, defender_id, area_stolen, route_id, conquered_at) VALUES ${values}`));
  }

  /** Batch insert feed events in a single query (saves N subrequests → 1) */
  async createFeedEventsBatch(events: Array<{ userId: string; eventType: string; metadata: string }>): Promise<void> {
    if (events.length === 0) return;
    const values = events.map(e => {
      const id = crypto.randomUUID();
      return `('${id}', '${e.userId.replace(/'/g, "''")}', '${e.eventType.replace(/'/g, "''")}', '${e.metadata.replace(/'/g, "''")}', datetime('now'))`;
    }).join(',');
    await this.db.run(sql.raw(`INSERT INTO feed_events (id, user_id, event_type, metadata, created_at) VALUES ${values}`));
  }

  /** Batch update victim areas using subquery — single DB call for all victims */
  async updateVictimAreasBatch(victimIds: string[]): Promise<void> {
    if (victimIds.length === 0) return;
    const placeholders = victimIds.map(id => `'${id.replace(/'/g, "''")}'`).join(',');
    await this.db.run(sql.raw(`
      UPDATE users SET total_area = COALESCE(
        (SELECT SUM(area) FROM territories WHERE territories.user_id = users.id), 0
      ) WHERE id IN (${placeholders})
    `));
  }

  // --- DB Reset for competition ---

  async resetForCompetition(): Promise<{ deletedRoutes: number; deletedTerritories: number }> {
    // Delete in dependency order
    await this.db.run(sql`DELETE FROM feed_reactions`);
    await this.db.run(sql`DELETE FROM feed_comments`);
    await this.db.run(sql`DELETE FROM feed_events`);
    await this.db.run(sql`DELETE FROM conquest_metrics`);
    await this.db.run(sql`DELETE FROM ephemeral_photos`);
    await this.db.run(sql`DELETE FROM email_notifications`);
    await this.db.run(sql`DELETE FROM inactivity_reminders`);
    try { await this.db.run(sql`DELETE FROM territory_loss_notifications`); } catch (_) {}
    // Clean competition-specific tables
    try { await this.db.run(sql`DELETE FROM user_nicknames`); } catch (_) {}
    try { await this.db.run(sql`DELETE FROM user_powers`); } catch (_) {}
    try { await this.db.run(sql`DELETE FROM treasures`); } catch (_) {}
    try { await this.db.run(sql`DELETE FROM competition_stats`); } catch (_) {}
    try { await this.db.run(sql`DELETE FROM weekly_summaries`); } catch (_) {}
    try { await this.db.run(sql`DELETE FROM territory_fortifications`); } catch (_) {}
    // Count before delete
    const routeCount = await this.db.select({ count: sql<number>`count(*)` }).from(routes);
    const terrCount = await this.db.select({ count: sql<number>`count(*)` }).from(territories);
    await this.db.run(sql`DELETE FROM territories`);
    await this.db.run(sql`DELETE FROM routes`);
    // Reset users' totalArea
    await this.db.run(sql`UPDATE users SET total_area = 0`);
    // Mark polar/strava activities as unprocessed so they can be reimported
    await this.db.run(sql`UPDATE polar_activities SET processed = 0, route_id = NULL, territory_id = NULL`);
    await this.db.run(sql`UPDATE strava_activities SET processed = 0, route_id = NULL, territory_id = NULL`);
    return {
      deletedRoutes: routeCount[0]?.count || 0,
      deletedTerritories: terrCount[0]?.count || 0,
    };
  }
}
