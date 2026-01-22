import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertUserSchema, insertRouteSchema, insertFriendshipSchema } from "@shared/schema";
import * as turf from "@turf/turf";
import { seedDatabase } from "./seed";
import bcrypt from "bcryptjs";

// Helper function to process territory conquest for a new route
async function processTerritoryConquest(
  userId: string,
  routeId: string,
  bufferedGeometry: any
): Promise<{
  territory: any;
  totalArea: number;
  newAreaConquered: number;
  areaStolen: number;
}> {
  const allTerritories = await storage.getAllTerritories();
  const userTerritories = allTerritories.filter(t => t.userId === userId);
  
  // Get friend IDs to determine who can be conquered
  const friendIds = await storage.getFriendIds(userId);
  const enemyTerritories = allTerritories.filter(t => 
    t.userId !== userId && friendIds.includes(t.userId)
  );

  let totalStolenArea = 0;

  // Step 1: Handle enemy territory conquest
  console.log(`[TERRITORY] Processing ${enemyTerritories.length} enemy territories...`);
  
  for (const enemyTerritory of enemyTerritories) {
    try {
      const result = await storage.subtractFromTerritory(
        enemyTerritory.id,
        bufferedGeometry
      );

      if (result.stolenArea > 0) {
        totalStolenArea += result.stolenArea;
        
        console.log(
          `[TERRITORY] Stole ${(result.stolenArea/1000000).toFixed(4)} km² from user ${enemyTerritory.userId}`
        );

        // Record conquest metric
        try {
          await storage.recordConquestMetric(
            userId,
            enemyTerritory.userId,
            result.stolenArea,
            routeId
          );
        } catch (metricErr) {
          console.error('[TERRITORY] Failed to record conquest metric:', metricErr);
        }

        // Update victim's total area
        const victimTerritories = await storage.getTerritoriesByUserId(
          enemyTerritory.userId
        );
        const victimTotalArea = victimTerritories.reduce(
          (sum, t) => sum + t.area,
          0
        );
        await storage.updateUserTotalArea(
          enemyTerritory.userId,
          victimTotalArea
        );
      }
    } catch (err) {
      console.error('[TERRITORY] Error processing enemy territory:', err);
    }
  }

  // Step 2: Merge with user's existing territories and calculate new area
  console.log('[TERRITORY] Merging with existing user territories...');
  
  const result = await storage.addOrMergeTerritory(
    userId,
    routeId,
    bufferedGeometry,
    userTerritories
  );

  // Step 3: Update user's total area
  await storage.updateUserTotalArea(userId, result.totalArea);

  console.log(`[TERRITORY] Conquest complete:
    - Total area: ${(result.totalArea/1000000).toFixed(4)} km²
    - New area: ${(result.newArea/1000000).toFixed(4)} km²
    - Area stolen: ${(totalStolenArea/1000000).toFixed(4)} km²
    - Existing area in route: ${(result.existingArea/1000000).toFixed(4)} km²
  `);

  return {
    territory: result.territory,
    totalArea: result.totalArea,
    newAreaConquered: result.newArea,
    areaStolen: totalStolenArea,
  };
}

export async function registerRoutes(app: Express): Promise<Server> {
  
  // ==================== SEED ====================
  
  // Seed database with demo data
  app.post("/api/seed", async (req, res) => {
    try {
      const defaultUser = await seedDatabase();
      res.json({ message: "Database seeded successfully", defaultUser });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get user by ID (for session management - client sends userId)
  app.get("/api/current-user/:userId", async (req, res) => {
    try {
      const { userId } = req.params;
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      const allUsers = await storage.getAllUsersWithStats();
      const userWithStats = allUsers.find(u => u.id === userId);
      res.json(userWithStats || user);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Login endpoint
  app.post("/api/auth/login", async (req, res) => {
    try {
      const { username, password } = req.body;
      if (!username || !password) {
        return res.status(400).json({ error: "Username y password son requeridos" });
      }
      
      const user = await storage.getUserByUsername(username);
      if (!user) {
        return res.status(401).json({ error: "Usuario no encontrado" });
      }

      const isValidPassword = await bcrypt.compare(password, user.password);
      if (!isValidPassword) {
        return res.status(401).json({ error: "Contraseña incorrecta" });
      }

      // Return user without password
      const { password: _, ...userWithoutPassword } = user;
      res.json(userWithoutPassword);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });
  
  // ==================== USERS ====================
  
  // Create user (register)
  app.post("/api/users", async (req, res) => {
    try {
      const { password, ...userData } = req.body;
      
      if (!password || password.length < 4) {
        return res.status(400).json({ error: "La contraseña debe tener al menos 4 caracteres" });
      }

      // Hash password
      const hashedPassword = await bcrypt.hash(password, 10);
      
      const validatedData = insertUserSchema.parse({
        ...userData,
        password: hashedPassword,
      });
      
      const user = await storage.createUser(validatedData);
      
      // Return user without password
      const { password: _, ...userWithoutPassword } = user;
      res.json(userWithoutPassword);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  // Get user with stats
  app.get("/api/user/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const user = await storage.getUser(id);
      
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Get user rank
      const allUsers = await storage.getAllUsersWithStats();
      const userWithStats = allUsers.find(u => u.id === id);

      res.json(userWithStats || user);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Update user
  app.patch("/api/users/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const { name, color, avatar } = req.body;
      
      const updateData: Partial<{ name: string; color: string; avatar: string }> = {};
      if (name !== undefined) updateData.name = name;
      if (color !== undefined) updateData.color = color;
      if (avatar !== undefined) updateData.avatar = avatar;

      const updatedUser = await storage.updateUser(id, updateData);
      res.json(updatedUser);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  // Get leaderboard
  app.get("/api/leaderboard", async (req, res) => {
    try {
      const users = await storage.getAllUsersWithStats();
      res.json(users);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ==================== ROUTES ====================
  
  // Create route and calculate territory
  app.post("/api/routes", async (req, res) => {
    try {
      const routeData = insertRouteSchema.parse(req.body);
      
      // Create route
      const route = await storage.createRoute(routeData);

      // Calculate territory from route coordinates
      if (routeData.coordinates.length >= 3) {
        try {
          // Create a buffer around the route to represent conquered territory
          const lineString = turf.lineString(
            routeData.coordinates.map((coord: any) => [coord[1], coord[0]]) // [lng, lat] for GeoJSON
          );
          
          // Buffer of 50 meters around the route
          const buffered = turf.buffer(lineString, 0.05, { units: 'kilometers' });
          
          if (buffered) {
            const conquestResult = await processTerritoryConquest(
              routeData.userId,
              route.id,
              buffered.geometry
            );

            res.json({ 
              route, 
              territory: conquestResult.territory,
              metrics: {
                totalArea: conquestResult.totalArea,
                newAreaConquered: conquestResult.newAreaConquered,
                areaStolen: conquestResult.areaStolen,
              }
            });
          } else {
            res.json({ route });
          }
        } catch (error) {
          console.error('Error calculating territory:', error);
          res.json({ route });
        }
      } else {
        res.json({ route });
      }
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  // Get routes by user
  app.get("/api/routes/:userId", async (req, res) => {
    try {
      const { userId } = req.params;
      const routes = await storage.getRoutesByUserId(userId);
      res.json(routes);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ==================== TERRITORIES ====================
  
  // Get all territories
  app.get("/api/territories", async (req, res) => {
    try {
      const territories = await storage.getAllTerritories();
      res.json(territories);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ==================== FRIENDSHIPS ====================
  
  // ==================== FRIENDS SYSTEM ====================
  
  // Create bidirectional friendship
  app.post("/api/friends", async (req, res) => {
    try {
      const { userId, friendId } = req.body;
      
      if (!userId || !friendId) {
        return res.status(400).json({ error: "userId and friendId required" });
      }

      if (userId === friendId) {
        return res.status(400).json({ error: "Cannot add yourself as friend" });
      }

      await storage.createBidirectionalFriendship(userId, friendId);
      res.json({ success: true });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  // Get friends by user
  app.get("/api/friends/:userId", async (req, res) => {
    try {
      const { userId } = req.params;
      const friends = await storage.getFriendsByUserId(userId);
      res.json(friends);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Delete friend (bidirectional)
  app.delete("/api/friends/:friendId", async (req, res) => {
    try {
      const { friendId } = req.params;
      const { userId } = req.body;

      if (!userId) {
        return res.status(400).json({ error: "userId required in body" });
      }

      await storage.deleteBidirectionalFriendship(userId, friendId);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Search users
  app.get("/api/users/search", async (req, res) => {
    try {
      const { query, userId } = req.query;

      if (!query || !userId) {
        return res.status(400).json({ error: "query and userId required" });
      }

      const users = await storage.searchUsers(query as string, userId as string);
      res.json(users);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get leaderboard for friends only
  app.get("/api/leaderboard/friends/:userId", async (req, res) => {
    try {
      const { userId } = req.params;
      const friends = await storage.getLeaderboardFriends(userId);
      res.json(friends);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get territories for friends only
  app.get("/api/territories/friends/:userId", async (req, res) => {
    try {
      const { userId } = req.params;
      const territories = await storage.getTerritoriesWithUsersByFriends(userId);
      res.json(territories);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Create friend invite link
  app.post("/api/friends/invite", async (req, res) => {
    try {
      const { userId } = req.body;

      if (!userId) {
        return res.status(400).json({ error: "userId required" });
      }

      const invite = await storage.createFriendInvite(userId);
      const inviteUrl = `${process.env.FRONTEND_URL || 'https://runna-io.pages.dev'}/friends/accept/${invite.token}`;
      
      res.json({ token: invite.token, url: inviteUrl });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Accept friend invite
  app.post("/api/friends/accept/:token", async (req, res) => {
    try {
      const { token } = req.params;
      const { userId } = req.body;

      if (!userId) {
        return res.status(400).json({ error: "userId required" });
      }

      const invite = await storage.getFriendInviteByToken(token);

      if (!invite) {
        return res.status(404).json({ error: "Invite not found or expired" });
      }

      if (new Date() > invite.expiresAt) {
        await storage.deleteFriendInvite(invite.id);
        return res.status(400).json({ error: "Invite expired" });
      }

      if (invite.userId === userId) {
        return res.status(400).json({ error: "Cannot accept your own invite" });
      }

      await storage.createBidirectionalFriendship(invite.userId, userId);
      await storage.deleteFriendInvite(invite.id);

      res.json({ success: true, friendId: invite.userId });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ==================== STRAVA INTEGRATION ====================
  
  const STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID;
  const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
  const STRAVA_WEBHOOK_VERIFY_TOKEN = process.env.STRAVA_WEBHOOK_VERIFY_TOKEN;
  const STRAVA_REDIRECT_URI = process.env.STRAVA_REDIRECT_URI || 'https://runna-io.pages.dev/api/strava/callback';

  // Helper to refresh Strava access token if expired
  async function getValidStravaToken(stravaAccount: {
    userId: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
  }): Promise<string | null> {
    const now = new Date();
    const expiresAt = new Date(stravaAccount.expiresAt);
    
    // Add 5 minute buffer before expiration
    const bufferMs = 5 * 60 * 1000;
    if (expiresAt.getTime() - bufferMs > now.getTime()) {
      return stravaAccount.accessToken;
    }

    // Token expired or expiring soon, refresh it
    try {
      const params = new URLSearchParams({
        client_id: STRAVA_CLIENT_ID!,
        client_secret: STRAVA_CLIENT_SECRET!,
        grant_type: 'refresh_token',
        refresh_token: stravaAccount.refreshToken,
      });
      const response = await fetch('https://www.strava.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      if (!response.ok) {
        console.error('Failed to refresh Strava token:', await response.text());
        return null;
      }

      const data: any = await response.json();
      const { access_token, refresh_token, expires_at } = data;

      // Update stored tokens
      await storage.updateStravaAccount(stravaAccount.userId, {
        accessToken: access_token,
        refreshToken: refresh_token,
        expiresAt: new Date(expires_at * 1000),
      });

      return access_token;
    } catch (error) {
      console.error('Error refreshing Strava token:', error);
      return null;
    }
  }

  // Get Strava connection status for user
  app.get("/api/strava/status/:userId", async (req, res) => {
    try {
      const { userId } = req.params;
      const stravaAccount = await storage.getStravaAccountByUserId(userId);
      
      if (stravaAccount) {
        res.json({
          connected: true,
          athleteData: stravaAccount.athleteData,
          lastSyncAt: stravaAccount.lastSyncAt,
        });
      } else {
        res.json({ connected: false });
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Initiate Strava OAuth
  app.get("/api/strava/connect", async (req, res) => {
    try {
      const { userId } = req.query;
      if (!userId || !STRAVA_CLIENT_ID) {
        return res.status(400).json({ error: "userId required and Strava not configured" });
      }

      const state = Buffer.from(JSON.stringify({ userId, ts: Date.now() })).toString('base64');
      const scopes = 'read,activity:read_all';
      
      const authUrl = `https://www.strava.com/oauth/authorize?client_id=${STRAVA_CLIENT_ID}&redirect_uri=${encodeURIComponent(STRAVA_REDIRECT_URI)}&response_type=code&scope=${scopes}&state=${state}`;
      
      res.json({ authUrl });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Strava OAuth callback
  app.get("/api/strava/callback", async (req, res) => {
    try {
      const { code, state, error: authError } = req.query;
      
      if (authError) {
        return res.redirect('/?strava_error=denied');
      }
      
      if (!code || !state || !STRAVA_CLIENT_ID || !STRAVA_CLIENT_SECRET) {
        return res.redirect('/?strava_error=invalid');
      }

      // Decode state to get userId
      let userId: string;
      try {
        const decoded = JSON.parse(Buffer.from(state as string, 'base64').toString());
        userId = decoded.userId;
      } catch {
        return res.redirect('/?strava_error=invalid_state');
      }

      // Exchange code for tokens
      const params = new URLSearchParams({
        client_id: STRAVA_CLIENT_ID!,
        client_secret: STRAVA_CLIENT_SECRET!,
        code: code as string,
        grant_type: 'authorization_code',
      });
      const tokenResponse = await fetch('https://www.strava.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      if (!tokenResponse.ok) {
        console.error('Strava token exchange failed:', await tokenResponse.text());
        return res.redirect('/?strava_error=token_exchange');
      }

      const tokenData = await tokenResponse.json();
      const { access_token, refresh_token, expires_at, athlete } = tokenData;

      // Check if this Strava account is already linked to another user
      const existingAccount = await storage.getStravaAccountByAthleteId(athlete.id);
      if (existingAccount && existingAccount.userId !== userId) {
        return res.redirect('/?strava_error=already_linked');
      }

      // Create or update Strava account
      const expiresAtDate = new Date(expires_at * 1000);
      const stravaAccountData = {
        userId,
        stravaAthleteId: athlete.id,
        accessToken: access_token,
        refreshToken: refresh_token,
        expiresAt: expiresAtDate,
        scope: 'read,activity:read_all',
        athleteData: athlete,
        lastSyncAt: null,
      };

      if (existingAccount) {
        await storage.updateStravaAccount(userId, stravaAccountData);
      } else {
        await storage.createStravaAccount(stravaAccountData);
      }

      res.redirect('/?strava_connected=true');
    } catch (error: any) {
      console.error('Strava callback error:', error);
      res.redirect('/?strava_error=server');
    }
  });

  // Disconnect Strava
  app.post("/api/strava/disconnect", async (req, res) => {
    try {
      const { userId } = req.body;
      if (!userId) {
        return res.status(400).json({ error: "userId required" });
      }

      const stravaAccount = await storage.getStravaAccountByUserId(userId);
      if (!stravaAccount) {
        return res.status(404).json({ error: "Strava account not connected" });
      }

      // Revoke token at Strava (best effort)
      try {
        await fetch('https://www.strava.com/oauth/deauthorize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `access_token=${stravaAccount.accessToken}`,
        });
      } catch (e) {
        console.error('Failed to revoke Strava token:', e);
      }

      await storage.deleteStravaAccount(userId);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Strava webhook validation (GET)
  app.get("/api/strava/webhook", (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === STRAVA_WEBHOOK_VERIFY_TOKEN) {
      res.json({ 'hub.challenge': challenge });
    } else {
      res.status(403).json({ error: 'Forbidden' });
    }
  });

  // Strava webhook events (POST)
  app.post("/api/strava/webhook", async (req, res) => {
    try {
      const { object_type, aspect_type, object_id, owner_id } = req.body;
      
      // Only process new activities
      if (object_type === 'activity' && aspect_type === 'create') {
        // Find user by Strava athlete ID
        const stravaAccount = await storage.getStravaAccountByAthleteId(owner_id);
        
        if (stravaAccount) {
          // Check if activity already exists
          const existingActivity = await storage.getStravaActivityByStravaId(object_id);
          
          if (!existingActivity) {
            // Get valid (possibly refreshed) access token
            const validToken = await getValidStravaToken(stravaAccount);
            if (!validToken) {
              console.error('Failed to get valid Strava token for athlete:', owner_id);
              return res.status(200).json({ received: true });
            }

            // Fetch activity details from Strava
            const activityResponse = await fetch(
              `https://www.strava.com/api/v3/activities/${object_id}?include_all_efforts=false`,
              {
                headers: { 'Authorization': `Bearer ${validToken}` },
              }
            );
            
            if (activityResponse.ok) {
              const activity = await activityResponse.json();
              
              // Only process runs and walks
              if (['Run', 'Walk', 'Hike', 'Trail Run'].includes(activity.type)) {
                // Store the activity for processing
                await storage.createStravaActivity({
                  stravaActivityId: activity.id,
                  userId: stravaAccount.userId,
                  routeId: null,
                  territoryId: null,
                  name: activity.name,
                  activityType: activity.type,
                  distance: activity.distance,
                  duration: activity.moving_time,
                  startDate: new Date(activity.start_date),
                  summaryPolyline: activity.map?.summary_polyline || null,
                  processed: false,
                  processedAt: null,
                });
              }
            } else {
              console.error('Failed to fetch Strava activity:', object_id, await activityResponse.text());
            }
          }
        }
      }
      
      // Always respond 200 to acknowledge receipt
      res.status(200).json({ received: true });
    } catch (error: any) {
      console.error('Strava webhook error:', error);
      res.status(200).json({ received: true }); // Still acknowledge to prevent retries
    }
  });

  // Process pending Strava activities (manual trigger or cron)
  app.post("/api/strava/process/:userId", async (req, res) => {
    try {
      const { userId } = req.params;
      const unprocessed = await storage.getUnprocessedStravaActivities(userId);
      const results: any[] = [];

      for (const activity of unprocessed) {
        if (!activity.summaryPolyline) {
          // Skip activities without GPS data
          await storage.updateStravaActivity(activity.id, { processed: true, processedAt: new Date() });
          continue;
        }

        try {
          // Decode polyline to coordinates
          const polyline = await import('@mapbox/polyline');
          const decoded = polyline.decode(activity.summaryPolyline);
          const coordinates: Array<[number, number]> = decoded.map((coord: [number, number]) => [coord[0], coord[1]]);

          if (coordinates.length >= 3) {
            // Create route
            const route = await storage.createRoute({
              userId: activity.userId,
              name: activity.name,
              coordinates,
              distance: activity.distance,
              duration: activity.duration,
              startedAt: activity.startDate,
              completedAt: new Date(activity.startDate.getTime() + activity.duration * 1000),
            });

            // Calculate territory (same logic as POST /api/routes)
            const lineString = turf.lineString(
              coordinates.map(coord => [coord[1], coord[0]]) // [lng, lat] for GeoJSON
            );
            const buffered = turf.buffer(lineString, 0.05, { units: 'kilometers' });

            if (buffered) {
              const conquestResult = await processTerritoryConquest(
                userId,
                route.id,
                buffered.geometry
              );

              await storage.updateStravaActivity(activity.id, {
                processed: true,
                processedAt: new Date(),
                routeId: route.id,
                territoryId: conquestResult.territory.id,
              });

              results.push({ 
                activityId: activity.stravaActivityId, 
                routeId: route.id, 
                territoryId: conquestResult.territory.id,
                metrics: {
                  totalArea: conquestResult.totalArea,
                  newAreaConquered: conquestResult.newAreaConquered,
                  areaStolen: conquestResult.areaStolen,
                }
              });
            }
          }
        } catch (err) {
          console.error('Error processing Strava activity:', err);
          await storage.updateStravaActivity(activity.id, { processed: true, processedAt: new Date() });
        }
      }

      res.json({ processed: results.length, results });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get all Strava activities for a user
  app.get("/api/strava/activities/:userId", async (req, res) => {
    try {
      const { userId } = req.params;
      const activities = await storage.getStravaActivitiesByUserId(userId);
      res.json(activities);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Sync recent Strava activities (pull from Strava API)
  app.post("/api/strava/sync/:userId", async (req, res) => {
    try {
      const { userId } = req.params;
      const stravaAccount = await storage.getStravaAccountByUserId(userId);
      
      if (!stravaAccount) {
        return res.status(404).json({ error: 'Strava account not connected' });
      }

      // Get valid access token
      const validToken = await getValidStravaToken(stravaAccount);
      if (!validToken) {
        return res.status(401).json({ error: 'Failed to get valid Strava token' });
      }

      // Fetch recent activities from Strava (last 30 days)
      const after = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
      const activitiesResponse = await fetch(
        `https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=50`,
        {
          headers: { 'Authorization': `Bearer ${validToken}` },
        }
      );

      if (!activitiesResponse.ok) {
        console.error('Failed to fetch Strava activities:', await activitiesResponse.text());
        return res.status(500).json({ error: 'Failed to fetch activities from Strava' });
      }

      const stravaActivities = await activitiesResponse.json();
      let imported = 0;

      for (const activity of stravaActivities) {
        // Only process runs and walks
        if (!['Run', 'Walk', 'Hike', 'Trail Run'].includes(activity.type)) {
          continue;
        }

        // Check if already exists
        const existing = await storage.getStravaActivityByStravaId(activity.id);
        if (existing) {
          continue;
        }

        // IMPORTANT: /athlete/activities returns a summary without GPS data
        // We need to fetch the detailed activity to get the polyline (GPS route)
        let summaryPolyline = null;
        try {
          const detailedResponse = await fetch(
            `https://www.strava.com/api/v3/activities/${activity.id}?include_all_efforts=false`,
            {
              headers: { 'Authorization': `Bearer ${validToken}` },
            }
          );
          
          if (detailedResponse.ok) {
            const detailedActivity = await detailedResponse.json();
            summaryPolyline = detailedActivity.map?.summary_polyline || null;
          } else {
            console.warn(`Failed to fetch detailed activity ${activity.id}:`, await detailedResponse.text());
          }
        } catch (err) {
          console.warn(`Error fetching detailed Strava activity ${activity.id}:`, err);
        }

        // Only import activities that have GPS data (polyline)
        // Activities without GPS won't be useful for territory calculation
        if (!summaryPolyline) {
          console.log(`Skipping activity ${activity.id} - no GPS data (polyline)`);
          continue;
        }

        // Store the activity
        await storage.createStravaActivity({
          stravaActivityId: activity.id,
          userId,
          routeId: null,
          territoryId: null,
          name: activity.name,
          activityType: activity.type,
          distance: activity.distance,
          duration: activity.moving_time,
          startDate: new Date(activity.start_date),
          summaryPolyline,
          processed: false,
          processedAt: null,
        });
        imported++;
      }

      // Update last sync time
      await storage.updateStravaAccount(userId, { lastSyncAt: new Date() });

      res.json({ imported, total: stravaActivities.length });
    } catch (error: any) {
      console.error('Strava sync error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // ==================== POLAR INTEGRATION ====================
  
  const POLAR_CLIENT_ID = process.env.POLAR_CLIENT_ID;
  const POLAR_CLIENT_SECRET = process.env.POLAR_CLIENT_SECRET;
  
  // Get base URL for redirect
  function getPolarRedirectUri(): string {
    // Use REPLIT_DEV_DOMAIN for dev, otherwise fallback to a configured URL
    const domain = process.env.REPLIT_DEV_DOMAIN || process.env.POLAR_REDIRECT_DOMAIN || 'localhost:5000';
    const protocol = domain.includes('localhost') ? 'http' : 'https';
    return `${protocol}://${domain}/api/polar/callback`;
  }

  // Get Polar connection status for user
  app.get("/api/polar/status/:userId", async (req, res) => {
    try {
      const { userId } = req.params;
      const polarAccount = await storage.getPolarAccountByUserId(userId);
      
      if (polarAccount) {
        res.json({
          connected: true,
          polarUserId: polarAccount.polarUserId,
          lastSyncAt: polarAccount.lastSyncAt,
        });
      } else {
        res.json({ connected: false });
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Initiate Polar OAuth
  app.get("/api/polar/connect", async (req, res) => {
    try {
      const { userId } = req.query;
      if (!userId || !POLAR_CLIENT_ID) {
        return res.status(400).json({ error: "userId required and Polar not configured" });
      }

      const state = Buffer.from(JSON.stringify({ userId, ts: Date.now() })).toString('base64');
      const redirectUri = getPolarRedirectUri();
      
      const authUrl = `https://flow.polar.com/oauth2/authorization?response_type=code&client_id=${POLAR_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
      
      res.json({ authUrl });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Polar OAuth callback
  app.get("/api/polar/callback", async (req, res) => {
    try {
      const { code, state, error: authError } = req.query;
      
      if (authError) {
        return res.redirect('/profile?polar_error=denied');
      }
      
      if (!code || !state || !POLAR_CLIENT_ID || !POLAR_CLIENT_SECRET) {
        return res.redirect('/profile?polar_error=invalid');
      }

      // Decode state to get userId
      let userId: string;
      try {
        const decoded = JSON.parse(Buffer.from(state as string, 'base64').toString());
        userId = decoded.userId;
      } catch {
        return res.redirect('/profile?polar_error=invalid_state');
      }

      // Exchange code for token
      const redirectUri = getPolarRedirectUri();
      const authHeader = Buffer.from(`${POLAR_CLIENT_ID}:${POLAR_CLIENT_SECRET}`).toString('base64');
      
      const tokenResponse = await fetch('https://polarremote.com/v2/oauth2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${authHeader}`,
          'Accept': 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code as string,
          redirect_uri: redirectUri,
        }).toString(),
      });

      if (!tokenResponse.ok) {
        console.error('Polar token exchange failed:', await tokenResponse.text());
        return res.redirect('/profile?polar_error=token_exchange');
      }

      const tokenData = await tokenResponse.json();
      const { access_token, x_user_id } = tokenData as { access_token: string; x_user_id: number | string };
      const normalizedPolarUserId = Number(x_user_id);

      if (!Number.isFinite(normalizedPolarUserId)) {
        console.error('Invalid x_user_id returned by Polar:', x_user_id);
        return res.redirect('/profile?polar_error=invalid_user');
      }

      // Check if this Polar account is already linked to another user
      const existingAccount = await storage.getPolarAccountByPolarUserId(normalizedPolarUserId);
      if (existingAccount && existingAccount.userId !== userId) {
        return res.redirect('/profile?polar_error=already_linked');
      }

      // Register user with Polar AccessLink (required before accessing data)
      try {
        const registerResponse = await fetch('https://www.polaraccesslink.com/v3/users', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${access_token}`,
          },
          body: JSON.stringify({
            'member-id': normalizedPolarUserId,
          }),
        });

        // 409 means already registered, which is fine
        if (!registerResponse.ok && registerResponse.status !== 409) {
          console.error('Polar user registration failed:', await registerResponse.text());
          return res.redirect('/profile?polar_error=registration');
        }
      } catch (e) {
        console.error('Polar registration error:', e);
      }

      // Create or update Polar account
      const polarAccountData = {
        userId,
        polarUserId: normalizedPolarUserId,
        accessToken: access_token,
        memberId: normalizedPolarUserId.toString(),
        registeredAt: new Date(),
        lastSyncAt: null,
      };

      if (existingAccount) {
        await storage.updatePolarAccount(userId, polarAccountData);
      } else {
        await storage.createPolarAccount(polarAccountData);
      }

      res.redirect('/profile?polar_connected=true');
    } catch (error: any) {
      console.error('Polar callback error:', error);
      res.redirect('/profile?polar_error=server');
    }
  });

  // Disconnect Polar
  app.post("/api/polar/disconnect", async (req, res) => {
    try {
      const { userId } = req.body;
      if (!userId) {
        return res.status(400).json({ error: "userId required" });
      }

      const polarAccount = await storage.getPolarAccountByUserId(userId);
      if (!polarAccount) {
        return res.status(404).json({ error: "Polar account not connected" });
      }

      // Delete user from Polar AccessLink (best effort)
      try {
        await fetch(`https://www.polaraccesslink.com/v3/users/${polarAccount.polarUserId}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${polarAccount.accessToken}`,
          },
        });
      } catch (e) {
        console.error('Failed to delete Polar user:', e);
      }

      await storage.deletePolarAccount(userId);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Sync exercises from Polar
  app.post("/api/polar/sync/:userId", async (req, res) => {
    try {
      const { userId } = req.params;
      const polarAccount = await storage.getPolarAccountByUserId(userId);
      
      if (!polarAccount) {
        return res.status(404).json({ error: 'Polar account not connected' });
      }

      // Create transaction to get available data
      const transactionResponse = await fetch('https://www.polaraccesslink.com/v3/users/' + polarAccount.polarUserId + '/exercise-transactions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${polarAccount.accessToken}`,
          'Accept': 'application/json',
        },
      });

      if (transactionResponse.status === 204) {
        // No new data available
        await storage.updatePolarAccount(userId, { lastSyncAt: new Date() });
        return res.json({ imported: 0, message: 'No new exercises available' });
      }

      if (!transactionResponse.ok) {
        console.error('Polar transaction failed:', await transactionResponse.text());
        return res.status(500).json({ error: 'Failed to create Polar transaction' });
      }

      const transaction = await transactionResponse.json();
      const transactionId = transaction['transaction-id'];

      // List exercises in transaction
      const exercisesResponse = await fetch(transaction['resource-uri'], {
        headers: {
          'Authorization': `Bearer ${polarAccount.accessToken}`,
          'Accept': 'application/json',
        },
      });

      if (!exercisesResponse.ok) {
        console.error('Failed to list Polar exercises:', await exercisesResponse.text());
        return res.status(500).json({ error: 'Failed to list Polar exercises' });
      }

      const exercisesData = await exercisesResponse.json();
      const exerciseUrls = exercisesData.exercises || [];
      let imported = 0;

      for (const exerciseUrl of exerciseUrls) {
        try {
          // Get exercise details
          const exerciseResponse = await fetch(exerciseUrl, {
            headers: {
              'Authorization': `Bearer ${polarAccount.accessToken}`,
              'Accept': 'application/json',
            },
          });

          if (!exerciseResponse.ok) continue;

          const exercise = await exerciseResponse.json();
          const exerciseId = exercise.id || exerciseUrl.split('/').pop();

          // Check if already exists
          const existing = await storage.getPolarActivityByPolarId(exerciseId.toString());
          if (existing) continue;

          // Only process running and walking activities
          const sport = exercise['detailed-sport-info']?.sport || exercise.sport || '';
          const activityType = sport.toLowerCase();
          if (!['running', 'walking', 'trail_running', 'hiking', 'jogging'].some(t => activityType.includes(t))) {
            continue;
          }

          // Try to get GPX data for the route
          let summaryPolyline = null;
          try {
            const gpxResponse = await fetch(`${exerciseUrl}/gpx`, {
              headers: {
                'Authorization': `Bearer ${polarAccount.accessToken}`,
                'Accept': 'application/gpx+xml',
              },
            });

            if (gpxResponse.ok) {
              const gpxText = await gpxResponse.text();
              // Parse GPX and extract coordinates, then encode as polyline
              const coordinates = parseGpxToCoordinates(gpxText);
              if (coordinates.length >= 2) {
                const polyline = await import('@mapbox/polyline');
                summaryPolyline = polyline.encode(coordinates);
              }
            }
          } catch (e) {
            console.error('Failed to get GPX for exercise:', exerciseId, e);
          }

          // Create the activity
          await storage.createPolarActivity({
            polarExerciseId: exerciseId.toString(),
            userId,
            routeId: null,
            territoryId: null,
            name: exercise.sport || 'Polar Exercise',
            activityType: sport,
            distance: exercise.distance || 0,
            duration: parseDuration(exercise.duration),
            startDate: new Date(exercise['start-time']),
            summaryPolyline,
            processed: false,
            processedAt: null,
          });
          imported++;
        } catch (e) {
          console.error('Error processing Polar exercise:', e);
        }
      }

      // Commit the transaction
      try {
        await fetch(`https://www.polaraccesslink.com/v3/users/${polarAccount.polarUserId}/exercise-transactions/${transactionId}`, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${polarAccount.accessToken}`,
          },
        });
      } catch (e) {
        console.error('Failed to commit Polar transaction:', e);
      }

      // Update last sync time
      await storage.updatePolarAccount(userId, { lastSyncAt: new Date() });

      res.json({ imported, total: exerciseUrls.length });
    } catch (error: any) {
      console.error('Polar sync error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Helper to parse GPX to coordinates
  function parseGpxToCoordinates(gpxText: string): Array<[number, number]> {
    const coordinates: Array<[number, number]> = [];
    const trkptRegex = /<trkpt[^>]*lat="([^"]+)"[^>]*lon="([^"]+)"/g;
    let match;
    while ((match = trkptRegex.exec(gpxText)) !== null) {
      const lat = parseFloat(match[1]);
      const lon = parseFloat(match[2]);
      if (!isNaN(lat) && !isNaN(lon)) {
        coordinates.push([lat, lon]);
      }
    }
    return coordinates;
  }

  // Helper to parse ISO 8601 duration to seconds
  function parseDuration(duration: string): number {
    if (!duration) return 0;
    const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/);
    if (!match) return 0;
    const hours = parseInt(match[1] || '0', 10);
    const minutes = parseInt(match[2] || '0', 10);
    const seconds = parseFloat(match[3] || '0');
    return hours * 3600 + minutes * 60 + Math.round(seconds);
  }

  // Get all Polar activities for a user
  app.get("/api/polar/activities/:userId", async (req, res) => {
    try {
      const { userId } = req.params;
      const activities = await storage.getPolarActivitiesByUserId(userId);
      res.json(activities);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Process pending Polar activities
  app.post("/api/polar/process/:userId", async (req, res) => {
    const startTime = Date.now();
    const MAX_PROCESSING_TIME = 25000; // 25 seconds limit
    
    try {
      const { userId } = req.params;
      const unprocessed = await storage.getUnprocessedPolarActivities(userId);
      
      console.log(`[PROCESS] Starting - ${unprocessed.length} unprocessed Polar activities for user ${userId}`);
      
      if (unprocessed.length === 0) {
        return res.json({ processed: 0, results: [], message: 'No activities to process' });
      }

      const results: any[] = [];
      const BATCH_SIZE = 5; // Process max 5 at a time
      const toBatch = unprocessed.slice(0, BATCH_SIZE);
      
      console.log(`[PROCESS] Processing batch of ${toBatch.length} activities (${unprocessed.length - toBatch.length} remaining)`);

      for (const activity of toBatch) {
        // Check timeout
        if (Date.now() - startTime > MAX_PROCESSING_TIME) {
          console.warn(`[PROCESS] Timeout approaching - stopping at ${results.length} processed`);
          break;
        }

        if (!activity.summaryPolyline) {
          console.log(`[PROCESS] Skipping activity ${activity.id} - no GPS data`);
          await storage.updatePolarActivity(activity.id, { processed: true, processedAt: new Date() });
          continue;
        }

        try {
          console.log(`[PROCESS] Processing activity ${activity.id}: ${activity.name}`);
          // Decode polyline to coordinates
          const polyline = await import('@mapbox/polyline');
          const decoded = polyline.decode(activity.summaryPolyline);
          const coordinates: Array<[number, number]> = decoded.map((coord: [number, number]) => [coord[0], coord[1]]);

          if (coordinates.length < 3) {
            console.log(`[PROCESS] Skipping activity ${activity.id} - insufficient coordinates (${coordinates.length})`);
            await storage.updatePolarActivity(activity.id, { processed: true, processedAt: new Date() });
            continue;
          }

          if (coordinates.length >= 3) {
            // Create route
            const route = await storage.createRoute({
              userId: activity.userId,
              name: activity.name,
              coordinates,
              distance: activity.distance,
              duration: activity.duration,
              startedAt: activity.startDate,
              completedAt: new Date(activity.startDate.getTime() + activity.duration * 1000),
            });

            // Calculate territory (same logic as POST /api/routes)
            const lineString = turf.lineString(
              coordinates.map(coord => [coord[1], coord[0]]) // [lng, lat] for GeoJSON
            );
            const buffered = turf.buffer(lineString, 0.05, { units: 'kilometers' });

            if (buffered) {
              console.log(`[PROCESS] Processing territory conquest...`);
              
              const conquestResult = await processTerritoryConquest(
                userId,
                route.id,
                buffered.geometry
              );

              console.log(`[PROCESS] Territory updated: ${conquestResult.territory.id}, area: ${conquestResult.territory.area}`);

              // Mark as processed
              await storage.updatePolarActivity(activity.id, {
                processed: true,
                processedAt: new Date(),
                routeId: route.id,
                territoryId: conquestResult.territory.id,
              });

              results.push({ 
                activityId: activity.polarExerciseId, 
                routeId: route.id, 
                territoryId: conquestResult.territory.id,
                metrics: {
                  totalArea: conquestResult.totalArea,
                  newAreaConquered: conquestResult.newAreaConquered,
                  areaStolen: conquestResult.areaStolen,
                }
              });
              console.log(`[PROCESS] ✅ Activity ${activity.id} processed successfully`);
            }
          }
        } catch (err) {
          console.error(`[PROCESS] ❌ Error processing activity ${activity.id}:`, err);
          await storage.updatePolarActivity(activity.id, { processed: true, processedAt: new Date() });
        }
      }

      const remaining = unprocessed.length - toBatch.length;
      const processingTime = Date.now() - startTime;
      console.log(`[PROCESS] Completed in ${processingTime}ms - ${results.length} processed, ${remaining} remaining`);

      res.json({ 
        processed: results.length, 
        results,
        remaining,
        processingTime,
        message: remaining > 0 ? `${results.length} procesadas, ${remaining} pendientes. Ejecuta de nuevo para continuar.` : `${results.length} procesadas correctamente`
      });
    } catch (error: any) {
      const processingTime = Date.now() - startTime;
      console.error('[PROCESS] ❌ Critical error:', error);
      res.status(500).json({ 
        error: error.message,
        processed: 0,
        processingTime,
        message: 'Error al procesar actividades. Por favor intenta de nuevo.'
      });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
