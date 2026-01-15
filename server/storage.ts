import {
  users,
  routes,
  territories,
  friendships,
  friendInvites,
  polarAccounts,
  polarActivities,
  stravaAccounts,
  stravaActivities,
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
  type PolarAccount,
  type InsertPolarAccount,
  type PolarActivity,
  type InsertPolarActivity,
  type StravaAccount,
  type InsertStravaAccount,
  type StravaActivity,
  type InsertStravaActivity,
  type UserWithStats,
  type TerritoryWithUser,
  type RouteWithTerritory,
} from "@shared/schema";
import { db } from "./db";
import { eq, desc, sql } from "drizzle-orm";

export interface IStorage {
  // Users
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(userId: string, data: Partial<Pick<User, 'name' | 'color' | 'avatar'>>): Promise<User>;
  getAllUsersWithStats(): Promise<UserWithStats[]>;
  updateUserTotalArea(userId: string, area: number): Promise<void>;

  // Routes
  createRoute(route: InsertRoute): Promise<Route>;
  getRoutesByUserId(userId: string): Promise<RouteWithTerritory[]>;
  getRoute(id: string): Promise<Route | undefined>;

  // Territories
  createTerritory(territory: InsertTerritory): Promise<Territory>;
  getAllTerritories(): Promise<TerritoryWithUser[]>;
  getTerritoriesByUserId(userId: string): Promise<Territory[]>;
  deleteTerritoryById(id: string): Promise<void>;

  // Friendships
  createFriendship(friendship: InsertFriendship): Promise<Friendship>;
  getFriendsByUserId(userId: string): Promise<UserWithStats[]>;
  checkFriendship(userId: string, friendId: string): Promise<boolean>;

  // Polar
  getPolarAccountByUserId(userId: string): Promise<PolarAccount | undefined>;
  getPolarAccountByPolarUserId(polarUserId: number): Promise<PolarAccount | undefined>;
  createPolarAccount(account: InsertPolarAccount): Promise<PolarAccount>;
  updatePolarAccount(userId: string, data: Partial<PolarAccount>): Promise<PolarAccount>;
  deletePolarAccount(userId: string): Promise<void>;
  getPolarActivityByPolarId(polarExerciseId: string): Promise<PolarActivity | undefined>;
  createPolarActivity(activity: InsertPolarActivity): Promise<PolarActivity>;
  updatePolarActivity(id: string, data: Partial<PolarActivity>): Promise<PolarActivity>;
  getUnprocessedPolarActivities(userId: string): Promise<PolarActivity[]>;
  getPolarActivitiesByUserId(userId: string): Promise<PolarActivity[]>;

  // Strava
  getStravaAccountByUserId(userId: string): Promise<StravaAccount | undefined>;
  getStravaAccountByAthleteId(athleteId: number): Promise<StravaAccount | undefined>;
  createStravaAccount(account: InsertStravaAccount): Promise<StravaAccount>;
  updateStravaAccount(userId: string, data: Partial<StravaAccount>): Promise<StravaAccount>;
  deleteStravaAccount(userId: string): Promise<void>;
  getStravaActivityByStravaId(stravaActivityId: number): Promise<StravaActivity | undefined>;
  createStravaActivity(activity: InsertStravaActivity): Promise<StravaActivity>;
  updateStravaActivity(id: string, data: Partial<StravaActivity>): Promise<StravaActivity>;
  getUnprocessedStravaActivities(userId: string): Promise<StravaActivity[]>;
  getStravaActivitiesByUserId(userId: string): Promise<StravaActivity[]>;
}

export class DatabaseStorage implements IStorage {
  // Users
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user || undefined;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db
      .insert(users)
      .values(insertUser)
      .returning();
    return user;
  }

  async getAllUsersWithStats(): Promise<UserWithStats[]> {
    const allUsers = await db
      .select()
      .from(users)
      .orderBy(desc(users.totalArea));

    // Add rank and friend count
    const usersWithStats: UserWithStats[] = await Promise.all(
      allUsers.map(async (user, index) => {
        const friendCount = await db
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
    const [updatedUser] = await db
      .update(users)
      .set(data)
      .where(eq(users.id, userId))
      .returning();
    return updatedUser;
  }

  async updateUserTotalArea(userId: string, area: number): Promise<void> {
    await db
      .update(users)
      .set({ totalArea: area })
      .where(eq(users.id, userId));
  }

  // Routes
  async createRoute(insertRoute: InsertRoute): Promise<Route> {
    const [route] = await db
      .insert(routes)
      .values(insertRoute as any)
      .returning();
    return route;
  }

  async getRoutesByUserId(userId: string): Promise<RouteWithTerritory[]> {
    const userRoutes = await db
      .select()
      .from(routes)
      .where(eq(routes.userId, userId))
      .orderBy(desc(routes.completedAt));

    // Get territory for each route if exists
    const routesWithTerritories: RouteWithTerritory[] = await Promise.all(
      userRoutes.map(async (route) => {
        const [territory] = await db
          .select()
          .from(territories)
          .where(eq(territories.routeId, route.id));

        return {
          ...route,
          territory: territory || undefined,
        };
      })
    );

    return routesWithTerritories;
  }

  async getRoute(id: string): Promise<Route | undefined> {
    const [route] = await db.select().from(routes).where(eq(routes.id, id));
    return route || undefined;
  }

  // Territories
  async createTerritory(insertTerritory: InsertTerritory): Promise<Territory> {
    const [territory] = await db
      .insert(territories)
      .values(insertTerritory)
      .returning();
    return territory;
  }

  async getAllTerritories(): Promise<TerritoryWithUser[]> {
    const allTerritories = await db
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
    return await db
      .select()
      .from(territories)
      .where(eq(territories.userId, userId))
      .orderBy(desc(territories.conqueredAt));
  }

  async deleteTerritoryById(id: string): Promise<void> {
    await db.delete(territories).where(eq(territories.id, id));
  }

  async updateTerritoryGeometry(
    userId: string, 
    routeId: string | null,
    geometry: any, 
    area: number
  ): Promise<Territory> {
    // Delete all existing territories for the user
    await db.delete(territories).where(eq(territories.userId, userId));
    
    // Create new unified territory
    const [territory] = await db
      .insert(territories)
      .values({
        userId,
        routeId,
        geometry,
        area,
      })
      .returning();
    return territory;
  }

  // Friendships
  async createFriendship(insertFriendship: InsertFriendship): Promise<Friendship> {
    const [friendship] = await db
      .insert(friendships)
      .values(insertFriendship)
      .returning();
    return friendship;
  }

  async getFriendsByUserId(userId: string): Promise<UserWithStats[]> {
    const userFriendships = await db
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
    const [friendship] = await db
      .select()
      .from(friendships)
      .where(
        sql`${friendships.userId} = ${userId} AND ${friendships.friendId} = ${friendId}`
      );
    return !!friendship;
  }

  // Polar
  async getPolarAccountByUserId(userId: string): Promise<PolarAccount | undefined> {
    const [account] = await db.select().from(polarAccounts).where(eq(polarAccounts.userId, userId));
    return account || undefined;
  }

  async getPolarAccountByPolarUserId(polarUserId: number): Promise<PolarAccount | undefined> {
    const [account] = await db.select().from(polarAccounts).where(eq(polarAccounts.polarUserId, polarUserId));
    return account || undefined;
  }

  async createPolarAccount(account: InsertPolarAccount): Promise<PolarAccount> {
    const [created] = await db.insert(polarAccounts).values(account).returning();
    return created;
  }

  async updatePolarAccount(userId: string, data: Partial<PolarAccount>): Promise<PolarAccount> {
    const [updated] = await db.update(polarAccounts).set(data).where(eq(polarAccounts.userId, userId)).returning();
    return updated;
  }

  async deletePolarAccount(userId: string): Promise<void> {
    await db.delete(polarAccounts).where(eq(polarAccounts.userId, userId));
  }

  async getPolarActivityByPolarId(polarExerciseId: string): Promise<PolarActivity | undefined> {
    const [activity] = await db.select().from(polarActivities).where(eq(polarActivities.polarExerciseId, polarExerciseId));
    return activity || undefined;
  }

  async createPolarActivity(activity: InsertPolarActivity): Promise<PolarActivity> {
    const [created] = await db.insert(polarActivities).values(activity).returning();
    return created;
  }

  async updatePolarActivity(id: string, data: Partial<PolarActivity>): Promise<PolarActivity> {
    const [updated] = await db.update(polarActivities).set(data).where(eq(polarActivities.id, id)).returning();
    return updated;
  }

  async getUnprocessedPolarActivities(userId: string): Promise<PolarActivity[]> {
    return await db.select().from(polarActivities)
      .where(sql`${polarActivities.userId} = ${userId} AND ${polarActivities.processed} = false`)
      .orderBy(desc(polarActivities.startDate));
  }

  async getPolarActivitiesByUserId(userId: string): Promise<PolarActivity[]> {
    return await db.select().from(polarActivities)
      .where(eq(polarActivities.userId, userId))
      .orderBy(desc(polarActivities.startDate));
  }

  // Strava
  async getStravaAccountByUserId(userId: string): Promise<StravaAccount | undefined> {
    const [account] = await db.select().from(stravaAccounts).where(eq(stravaAccounts.userId, userId));
    return account || undefined;
  }

  async getStravaAccountByAthleteId(athleteId: number): Promise<StravaAccount | undefined> {
    const [account] = await db.select().from(stravaAccounts).where(eq(stravaAccounts.stravaAthleteId, athleteId));
    return account || undefined;
  }

  async createStravaAccount(account: InsertStravaAccount): Promise<StravaAccount> {
    const [created] = await db.insert(stravaAccounts).values(account).returning();
    return created;
  }

  async updateStravaAccount(userId: string, data: Partial<StravaAccount>): Promise<StravaAccount> {
    const [updated] = await db.update(stravaAccounts).set(data).where(eq(stravaAccounts.userId, userId)).returning();
    return updated;
  }

  async deleteStravaAccount(userId: string): Promise<void> {
    await db.delete(stravaAccounts).where(eq(stravaAccounts.userId, userId));
  }

  async getStravaActivityByStravaId(stravaActivityId: number): Promise<StravaActivity | undefined> {
    const [activity] = await db.select().from(stravaActivities).where(eq(stravaActivities.stravaActivityId, stravaActivityId));
    return activity || undefined;
  }

  async createStravaActivity(activity: InsertStravaActivity): Promise<StravaActivity> {
    const [created] = await db.insert(stravaActivities).values(activity).returning();
    return created;
  }

  async updateStravaActivity(id: string, data: Partial<StravaActivity>): Promise<StravaActivity> {
    const [updated] = await db.update(stravaActivities).set(data).where(eq(stravaActivities.id, id)).returning();
    return updated;
  }

  async getUnprocessedStravaActivities(userId: string): Promise<StravaActivity[]> {
    return await db.select().from(stravaActivities)
      .where(sql`${stravaActivities.userId} = ${userId} AND ${stravaActivities.processed} = false`)
      .orderBy(desc(stravaActivities.startDate));
  }

  async getStravaActivitiesByUserId(userId: string): Promise<StravaActivity[]> {
    return await db.select().from(stravaActivities)
      .where(eq(stravaActivities.userId, userId))
      .orderBy(desc(stravaActivities.startDate));
  }

  // New friendship methods for friend-only competition
  async getLeaderboardFriends(userId: string): Promise<UserWithStats[]> {
    // Get friend IDs
    const userFriendships = await db
      .select({ friendId: friendships.friendId })
      .from(friendships)
      .where(eq(friendships.userId, userId));

    const friendIds = userFriendships.map((f) => f.friendId);
    
    // Include the user themselves in the list
    const allIds = [userId, ...friendIds];
    
    // Get all friends + user with stats, ordered by totalArea
    const friends = await db
      .select()
      .from(users)
      .where(sql`${users.id} IN (${sql.join(allIds.map(id => sql`${id}`), sql`, `)})`)
      .orderBy(desc(users.totalArea));

    // Calculate rank and friendCount
    const friendsWithStats: UserWithStats[] = [];
    for (let i = 0; i < friends.length; i++) {
      const friend = friends[i];
      const [{ count }] = await db
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
    const userFriendships = await db
      .select({ friendId: friendships.friendId })
      .from(friendships)
      .where(eq(friendships.userId, userId));

    const friendIds = userFriendships.map((f) => f.friendId);
    
    // Include the user themselves in the list
    const allIds = [userId, ...friendIds];

    // Get territories belonging to friends + user
    const territoryData = await db
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
    return await db
      .select()
      .from(users)
      .where(
        sql`(LOWER(${users.username}) LIKE ${`%${lowerQuery}%`} OR LOWER(${users.name}) LIKE ${`%${lowerQuery}%`}) AND ${users.id} != ${currentUserId}`
      )
      .limit(limit);
  }

  async createBidirectionalFriendship(userId: string, friendId: string): Promise<void> {
    // Check if friendship already exists
    const existing = await db
      .select()
      .from(friendships)
      .where(
        sql`(${friendships.userId} = ${userId} AND ${friendships.friendId} = ${friendId}) OR (${friendships.userId} = ${friendId} AND ${friendships.friendId} = ${userId})`
      );

    if (existing.length > 0) {
      return; // Already friends
    }

    // Create both directions
    await db.insert(friendships).values([
      { userId, friendId },
      { userId: friendId, friendId: userId },
    ]);
  }

  async deleteBidirectionalFriendship(userId: string, friendId: string): Promise<void> {
    await db
      .delete(friendships)
      .where(
        sql`(${friendships.userId} = ${userId} AND ${friendships.friendId} = ${friendId}) OR (${friendships.userId} = ${friendId} AND ${friendships.friendId} = ${userId})`
      );
  }

  async createFriendInvite(userId: string): Promise<FriendInvite> {
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
    
    const [invite] = await db
      .insert(friendInvites)
      .values({ userId, token, expiresAt })
      .returning();
    
    return invite;
  }

  async getFriendInviteByToken(token: string): Promise<FriendInvite | undefined> {
    const [invite] = await db
      .select()
      .from(friendInvites)
      .where(eq(friendInvites.token, token));
    
    return invite || undefined;
  }

  async deleteFriendInvite(id: string): Promise<void> {
    await db.delete(friendInvites).where(eq(friendInvites.id, id));
  }

  async getFriendIds(userId: string): Promise<string[]> {
    const userFriendships = await db
      .select({ friendId: friendships.friendId })
      .from(friendships)
      .where(eq(friendships.userId, userId));
    
    return userFriendships.map(f => f.friendId);
  }
}

export const storage = new DatabaseStorage();
