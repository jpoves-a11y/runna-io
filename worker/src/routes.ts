import { Hono } from 'hono';
import { createDb } from './db';
import { WorkerStorage } from './storage';
import { insertUserSchema, insertRouteSchema, insertFriendshipSchema, type InsertRoute } from '../../shared/schema';
import * as turf from '@turf/turf';
import type { Env } from './index';

async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + 'runna_salt_2024');
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const computedHash = await hashPassword(password);
  return computedHash === hash;
}

// Helper to refresh Strava access token if expired
async function getValidStravaToken(
  stravaAccount: {
    userId: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
  },
  storage: WorkerStorage,
  env: Env
): Promise<string | null> {
  const now = new Date();
  const expiresAt = new Date(stravaAccount.expiresAt);
  
  // Add 5 minute buffer before expiration
  const bufferMs = 5 * 60 * 1000;
  if (expiresAt.getTime() - bufferMs > now.getTime()) {
    // Token is still valid
    return stravaAccount.accessToken;
  }

  // Token expired or expiring soon, refresh it
  try {
    const params = new URLSearchParams({
      client_id: env.STRAVA_CLIENT_ID!,
      client_secret: env.STRAVA_CLIENT_SECRET!,
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

export function registerRoutes(app: Hono<{ Bindings: Env }>) {
  
  app.post('/api/seed', async (c) => {
    try {
      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);
      
      const existingUsers = await storage.getAllUsersWithStats();
      if (existingUsers.length > 0) {
        return c.json({ message: "Database already has users", defaultUser: existingUsers[0] });
      }

      const hashedPassword = await hashPassword('demo123');
      const user = await storage.createUser({
        username: "demo_runner",
        name: "Demo Runner",
        password: hashedPassword,
        color: "#3B82F6",
        avatar: null,
      });

      return c.json({ message: "Database seeded successfully", defaultUser: user });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.get('/api/current-user/:userId', async (c) => {
    try {
      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);
      const userId = c.req.param('userId');
      const user = await storage.getUser(userId);
      if (!user) {
        return c.json({ error: "User not found" }, 404);
      }
      const allUsers = await storage.getAllUsersWithStats();
      const userWithStats = allUsers.find(u => u.id === userId);
      const { password: _, ...userWithoutPassword } = userWithStats || user;
      return c.json(userWithoutPassword);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.post('/api/auth/login', async (c) => {
    try {
      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);
      const body = await c.req.json();
      const { username, password } = body;
      
      if (!username || !password) {
        return c.json({ error: "Username y password son requeridos" }, 400);
      }
      
      const user = await storage.getUserByUsername(username);
      if (!user) {
        return c.json({ error: "Usuario no encontrado" }, 401);
      }

      const isValid = await verifyPassword(password, user.password);
      if (!isValid) {
        return c.json({ error: "ContraseÃ±a incorrecta" }, 401);
      }

      const { password: _, ...userWithoutPassword } = user;
      return c.json(userWithoutPassword);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.post('/api/users', async (c) => {
    try {
      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);
      const body = await c.req.json();
      const { password, ...userData } = body;
      
      if (!password || password.length < 4) {
        return c.json({ error: "La contraseÃ±a debe tener al menos 4 caracteres" }, 400);
      }

      const hashedPassword = await hashPassword(password);
      const validatedData = insertUserSchema.parse({
        ...userData,
        password: hashedPassword,
      });
      const user = await storage.createUser(validatedData);
      
      const { password: _, ...userWithoutPassword } = user;
      return c.json(userWithoutPassword);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  });

  app.get('/api/user/:id', async (c) => {
    try {
      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);
      const id = c.req.param('id');
      const user = await storage.getUser(id);
      
      if (!user) {
        return c.json({ error: "User not found" }, 404);
      }

      const allUsers = await storage.getAllUsersWithStats();
      const userWithStats = allUsers.find(u => u.id === id);

      return c.json(userWithStats || user);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.patch('/api/users/:id', async (c) => {
    try {
      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);
      const id = c.req.param('id');
      const body = await c.req.json();
      const { name, color, avatar } = body;
      
      const updateData: Partial<{ name: string; color: string; avatar: string }> = {};
      if (name !== undefined) updateData.name = name;
      if (color !== undefined) updateData.color = color;
      if (avatar !== undefined) updateData.avatar = avatar;

      const updatedUser = await storage.updateUser(id, updateData);
      return c.json(updatedUser);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  });

  app.get('/api/leaderboard', async (c) => {
    try {
      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);
      const users = await storage.getAllUsersWithStats();
      return c.json(users);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.post('/api/routes', async (c) => {
    try {
      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);
      const body = await c.req.json();
      const routeData = insertRouteSchema.parse(body);
      
      const route = await storage.createRoute(routeData);

      if (routeData.coordinates.length >= 3) {
        try {
          const coords = routeData.coordinates as [number, number][];
          const lineString = turf.lineString(
            coords.map((coord: [number, number]) => [coord[1], coord[0]])
          );
          
          const buffered = turf.buffer(lineString, 0.05, { units: 'kilometers' });
          
          if (buffered) {
            const area = turf.area(buffered);
            
            const allTerritories = await storage.getAllTerritories();
            const userTerritories = allTerritories.filter(t => t.userId === routeData.userId);
            const otherTerritories = allTerritories.filter(t => t.userId !== routeData.userId);

            for (const otherTerritory of otherTerritories) {
              try {
                const otherPoly = turf.polygon(otherTerritory.geometry.coordinates);
                const intersection = turf.intersect(
                  turf.featureCollection([buffered, otherPoly])
                );

                if (intersection) {
                  await storage.deleteTerritoryById(otherTerritory.id);
                  
                  const otherUserTerritories = await storage.getTerritoriesByUserId(otherTerritory.userId);
                  const newTotalArea = otherUserTerritories
                    .filter(t => t.id !== otherTerritory.id)
                    .reduce((sum, t) => sum + t.area, 0);
                  await storage.updateUserTotalArea(otherTerritory.userId, newTotalArea);
                }
              } catch (err) {
                console.error('Error checking overlap:', err);
              }
            }

            let finalGeometry = buffered.geometry;
            for (const userTerritory of userTerritories) {
              try {
                const userPoly = turf.polygon(userTerritory.geometry.coordinates);
                const union = turf.union(
                  turf.featureCollection([turf.polygon(finalGeometry.coordinates as any), userPoly])
                );
                if (union) {
                  finalGeometry = union.geometry as any;
                  await storage.deleteTerritoryById(userTerritory.id);
                }
              } catch (err) {
                console.error('Error merging territories:', err);
              }
            }

            const territory = await storage.createTerritory({
              userId: routeData.userId,
              routeId: route.id,
              geometry: finalGeometry as any,
              area: turf.area(finalGeometry),
            });

            const updatedTerritories = await storage.getTerritoriesByUserId(routeData.userId);
            const totalArea = updatedTerritories.reduce((sum, t) => sum + t.area, 0);
            await storage.updateUserTotalArea(routeData.userId, totalArea);

            return c.json({ route, territory });
          } else {
            return c.json({ route });
          }
        } catch (error) {
          console.error('Error calculating territory:', error);
          return c.json({ route });
        }
      } else {
        return c.json({ route });
      }
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  });

  app.get('/api/routes/:userId', async (c) => {
    try {
      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);
      const userId = c.req.param('userId');
      const routes = await storage.getRoutesByUserId(userId);
      return c.json(routes);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.get('/api/territories', async (c) => {
    try {
      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);
      const territories = await storage.getAllTerritories();
      return c.json(territories);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.post('/api/friends', async (c) => {
    try {
      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);
      const body = await c.req.json();
      const friendshipData = insertFriendshipSchema.parse(body);
      
      const exists = await storage.checkFriendship(
        friendshipData.userId,
        friendshipData.friendId
      );

      if (exists) {
        return c.json({ error: "Friendship already exists" }, 400);
      }

      const friendship = await storage.createFriendship(friendshipData);
      return c.json(friendship);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  });

  app.get('/api/friends/:userId', async (c) => {
    try {
      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);
      const userId = c.req.param('userId');
      const friends = await storage.getFriendsByUserId(userId);
      return c.json(friends);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // ==================== STRAVA INTEGRATION ====================

  app.get('/api/strava/status/:userId', async (c) => {
    try {
      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);
      const userId = c.req.param('userId');
      const stravaAccount = await storage.getStravaAccountByUserId(userId);
      
      if (stravaAccount) {
        return c.json({
          connected: true,
          athleteData: stravaAccount.athleteData,
          lastSyncAt: stravaAccount.lastSyncAt,
        });
      } else {
        return c.json({ connected: false });
      }
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.get('/api/strava/connect', async (c) => {
    try {
      const userId = c.req.query('userId');
      const STRAVA_CLIENT_ID = c.env.STRAVA_CLIENT_ID;
      const STRAVA_REDIRECT_URI = 'https://runna-io-api.workers.dev/api/strava/callback';

      
      if (!userId || !STRAVA_CLIENT_ID) {
        return c.json({ error: "userId required and Strava not configured" }, 400);
      }

      const state = btoa(JSON.stringify({ userId, ts: Date.now() }));
      const scopes = 'read,activity:read_all';
      
      const authUrl = `https://www.strava.com/oauth/authorize?client_id=${STRAVA_CLIENT_ID}&redirect_uri=${encodeURIComponent(STRAVA_REDIRECT_URI)}&response_type=code&scope=${scopes}&state=${state}`;
      
      return c.json({ authUrl });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.get('/api/strava/callback', async (c) => {
    const FRONTEND_URL = c.env.FRONTEND_URL || 'https://runna-io.pages.dev';
    
    try {
      const code = c.req.query('code');
      const state = c.req.query('state');
      const authError = c.req.query('error');
      const STRAVA_CLIENT_ID = c.env.STRAVA_CLIENT_ID;
      const STRAVA_CLIENT_SECRET = c.env.STRAVA_CLIENT_SECRET;
      
      if (authError) {
        return c.redirect(`${FRONTEND_URL}/?strava_error=denied`);
      }
      
      if (!code || !state || !STRAVA_CLIENT_ID || !STRAVA_CLIENT_SECRET) {
        return c.redirect(`${FRONTEND_URL}/?strava_error=invalid`);
      }

      let userId: string;
      try {
        const decoded = JSON.parse(atob(state));
        userId = decoded.userId;
      } catch {
        return c.redirect(`${FRONTEND_URL}/?strava_error=invalid_state`);
      }

            const STRAVA_REDIRECT_URI = 'https://runna-io-api.workers.dev/api/strava/callback';
      
      const params = new URLSearchParams({
        client_id: STRAVA_CLIENT_ID!,
        client_secret: STRAVA_CLIENT_SECRET!,
        code: code as string,
        grant_type: 'authorization_code',
        redirect_uri: STRAVA_REDIRECT_URI,
      });

      const tokenResponse = await fetch('https://www.strava.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      if (!tokenResponse.ok) {
        console.error('Strava token exchange failed:', await tokenResponse.text());
        return c.redirect(`${FRONTEND_URL}/?strava_error=token_exchange`);
      }

      const tokenData: any = await tokenResponse.json();
      const { access_token, refresh_token, expires_at, athlete } = tokenData;

      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);

      const existingAccount = await storage.getStravaAccountByAthleteId(athlete.id);
      if (existingAccount && existingAccount.userId !== userId) {
        return c.redirect(`${FRONTEND_URL}/?strava_error=already_linked`);
      }

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

      return c.redirect(`${FRONTEND_URL}/?strava_connected=true`);
    } catch (error: any) {
      console.error('Strava callback error:', error);
      return c.redirect(`${FRONTEND_URL}/?strava_error=server`);
    }
  });

  app.post('/api/strava/disconnect', async (c) => {
    try {
      const body = await c.req.json();
      const { userId } = body;
      if (!userId) {
        return c.json({ error: "userId required" }, 400);
      }

      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);

      const stravaAccount = await storage.getStravaAccountByUserId(userId);
      if (!stravaAccount) {
        return c.json({ error: "Strava account not connected" }, 404);
      }

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
      return c.json({ success: true });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.get('/api/strava/webhook', (c) => {
    const mode = c.req.query('hub.mode');
    const token = c.req.query('hub.verify_token');
    const challenge = c.req.query('hub.challenge');

    if (mode === 'subscribe' && token === c.env.STRAVA_WEBHOOK_VERIFY_TOKEN) {
      return c.json({ 'hub.challenge': challenge });
    } else {
      return c.json({ error: 'Forbidden' }, 403);
    }
  });

  app.post('/api/strava/webhook', async (c) => {
    try {
      const body = await c.req.json();
      const { object_type, aspect_type, object_id, owner_id } = body;
      
      if (object_type === 'activity' && aspect_type === 'create') {
        const db = createDb(c.env.DATABASE_URL);
        const storage = new WorkerStorage(db);
        const stravaAccount = await storage.getStravaAccountByAthleteId(owner_id);
        
        if (stravaAccount) {
          const existingActivity = await storage.getStravaActivityByStravaId(object_id);
          
          if (!existingActivity) {
            // Get valid (possibly refreshed) access token
            const validToken = await getValidStravaToken(stravaAccount, storage, c.env);
            if (!validToken) {
              console.error('Failed to get valid Strava token for athlete:', owner_id);
              return c.json({ received: true }, 200);
            }

            const activityResponse = await fetch(
              `https://www.strava.com/api/v3/activities/${object_id}?include_all_efforts=false`,
              {
                headers: { 'Authorization': `Bearer ${validToken}` },
              }
            );
            
            if (activityResponse.ok) {
              const activity: any = await activityResponse.json();
              
              if (['Run', 'Walk', 'Hike', 'Trail Run'].includes(activity.type)) {
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
      
      return c.json({ received: true }, 200);
    } catch (error: any) {
      console.error('Strava webhook error:', error);
      return c.json({ received: true }, 200);
    }
  });

  app.post('/api/strava/process/:userId', async (c) => {
    try {
      const userId = c.req.param('userId');
      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);
      const unprocessed = await storage.getUnprocessedStravaActivities(userId);
      const results: any[] = [];

      for (const activity of unprocessed) {
        if (!activity.summaryPolyline) {
          await storage.updateStravaActivity(activity.id, { processed: true, processedAt: new Date() });
          continue;
        }

        try {
          const decoded = decodePolyline(activity.summaryPolyline);
          const coordinates: Array<[number, number]> = decoded.map((coord: [number, number]) => [coord[0], coord[1]]);

          if (coordinates.length >= 3) {
            const route = await storage.createRoute({
              userId: activity.userId,
              name: activity.name,
              coordinates,
              distance: activity.distance,
              duration: activity.duration,
              startedAt: activity.startDate,
              completedAt: new Date(activity.startDate.getTime() + activity.duration * 1000),
            });

            const lineString = turf.lineString(
              coordinates.map(coord => [coord[1], coord[0]])
            );
            const buffered = turf.buffer(lineString, 0.05, { units: 'kilometers' });

            if (buffered) {
              const allTerritories = await storage.getAllTerritories();
              const userTerritories = allTerritories.filter(t => t.userId === userId);
              const otherTerritories = allTerritories.filter(t => t.userId !== userId);

              for (const otherTerritory of otherTerritories) {
                try {
                  const otherPoly = turf.polygon(otherTerritory.geometry.coordinates);
                  const intersection = turf.intersect(turf.featureCollection([buffered, otherPoly]));
                  if (intersection) {
                    await storage.deleteTerritoryById(otherTerritory.id);
                    const otherUserTerritories = await storage.getTerritoriesByUserId(otherTerritory.userId);
                    const newTotalArea = otherUserTerritories
                      .filter(t => t.id !== otherTerritory.id)
                      .reduce((sum, t) => sum + t.area, 0);
                    await storage.updateUserTotalArea(otherTerritory.userId, newTotalArea);
                  }
                } catch (err) {
                  console.error('Error checking overlap:', err);
                }
              }

              let finalGeometry = buffered.geometry;
              for (const userTerritory of userTerritories) {
                try {
                  const userPoly = turf.polygon(userTerritory.geometry.coordinates);
                  const union = turf.union(turf.featureCollection([turf.polygon(finalGeometry.coordinates as any), userPoly]));
                  if (union) {
                    finalGeometry = union.geometry as any;
                    await storage.deleteTerritoryById(userTerritory.id);
                  }
                } catch (err) {
                  console.error('Error merging territories:', err);
                }
              }

              const territory = await storage.createTerritory({
                userId,
                routeId: route.id,
                geometry: finalGeometry as any,
                area: turf.area(finalGeometry),
              });

              const updatedTerritories = await storage.getTerritoriesByUserId(userId);
              const totalArea = updatedTerritories.reduce((sum, t) => sum + t.area, 0);
              await storage.updateUserTotalArea(userId, totalArea);

              await storage.updateStravaActivity(activity.id, {
                processed: true,
                processedAt: new Date(),
                routeId: route.id,
                territoryId: territory.id,
              });

              results.push({ activityId: activity.stravaActivityId, routeId: route.id, territoryId: territory.id });
            }
          }
        } catch (err) {
          console.error('Error processing Strava activity:', err);
          await storage.updateStravaActivity(activity.id, { processed: true, processedAt: new Date() });
        }
      }

      return c.json({ processed: results.length, results });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // Get all Strava activities for a user
  app.get('/api/strava/activities/:userId', async (c) => {
    try {
      const userId = c.req.param('userId');
      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);
      const activities = await storage.getStravaActivitiesByUserId(userId);
      return c.json(activities);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // Sync recent Strava activities (pull from Strava API)
  app.post('/api/strava/sync/:userId', async (c) => {
    try {
      const userId = c.req.param('userId');
      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);
      const stravaAccount = await storage.getStravaAccountByUserId(userId);
      
      if (!stravaAccount) {
        return c.json({ error: 'Strava account not connected' }, 404);
      }

      // Get valid access token
      const validToken = await getValidStravaToken(stravaAccount, storage, c.env);
      if (!validToken) {
        return c.json({ error: 'Failed to get valid Strava token' }, 401);
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
        return c.json({ error: 'Failed to fetch activities from Strava' }, 500);
      }

      const stravaActivitiesList: any[] = await activitiesResponse.json();
      let imported = 0;

      for (const activity of stravaActivitiesList) {
        // Only process runs and walks
        if (!['Run', 'Walk', 'Hike', 'Trail Run'].includes(activity.type)) {
          continue;
        }

        // Check if already exists
        const existing = await storage.getStravaActivityByStravaId(activity.id);
        if (existing) {
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
          summaryPolyline: activity.map?.summary_polyline || null,
          processed: false,
          processedAt: null,
        });
        imported++;
      }

      // Update last sync time
      await storage.updateStravaAccount(userId, { lastSyncAt: new Date() });

      return c.json({ imported, total: stravaActivitiesList.length });
    } catch (error: any) {
      console.error('Strava sync error:', error);
      return c.json({ error: error.message }, 500);
    }
  });

  // ==================== POLAR ====================

  app.get('/api/polar/status/:userId', async (c) => {
    try {
      const userId = c.req.param('userId');
      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);
      const polarAccount = await storage.getPolarAccountByUserId(userId);
      
      if (polarAccount) {
        return c.json({
          connected: true,
          polarUserId: polarAccount.polarUserId,
          lastSyncAt: polarAccount.lastSyncAt,
        });
      } else {
        return c.json({ connected: false });
      }
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.get('/api/polar/connect', async (c) => {
    try {
      const userId = c.req.query('userId');
      const POLAR_CLIENT_ID = c.env.POLAR_CLIENT_ID;
      if (!userId || !POLAR_CLIENT_ID) {
        return c.json({ error: "userId required and Polar not configured" }, 400);
      }

      const state = btoa(JSON.stringify({ userId, ts: Date.now() }));
      const redirectUri = `${c.env.WORKER_URL || 'https://runna-io-api.runna-io-api.workers.dev'}/api/polar/callback`;
      const authUrl = `https://flow.polar.com/oauth2/authorization?response_type=code&client_id=${POLAR_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
      
      return c.json({ authUrl });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.get('/api/polar/callback', async (c) => {
    try {
      const code = c.req.query('code');
      const state = c.req.query('state');
      const authError = c.req.query('error');
      const POLAR_CLIENT_ID = c.env.POLAR_CLIENT_ID;
      const POLAR_CLIENT_SECRET = c.env.POLAR_CLIENT_SECRET;
      const FRONTEND_URL = c.env.FRONTEND_URL || 'https://runna.io';
      
      if (authError) {
        return c.redirect(`${FRONTEND_URL}/profile?polar_error=denied`);
      }
      
      if (!code || !state || !POLAR_CLIENT_ID || !POLAR_CLIENT_SECRET) {
        return c.redirect(`${FRONTEND_URL}/profile?polar_error=invalid`);
      }

      let userId: string;
      try {
        const decoded = JSON.parse(atob(state as string));
        userId = decoded.userId;
      } catch {
        return c.redirect(`${FRONTEND_URL}/profile?polar_error=invalid_state`);
      }

      const redirectUri = `${c.env.WORKER_URL || 'https://runna-io-api.runna-io-api.workers.dev'}/api/polar/callback`;
      const authHeader = btoa(`${POLAR_CLIENT_ID}:${POLAR_CLIENT_SECRET}`);
      
      const tokenResponse = await fetch('https://polaraccesslink.com/v3/oauth2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${authHeader}`,
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code as string,
          redirect_uri: redirectUri,
        }).toString(),
      });

      if (!tokenResponse.ok) {
        console.error('Polar token exchange failed:', await tokenResponse.text());
        return c.redirect(`${FRONTEND_URL}/profile?polar_error=token_exchange`);
      }

      const tokenData: any = await tokenResponse.json();
      const { access_token, x_user_id } = tokenData;

      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);

      const existingAccount = await storage.getPolarAccountByPolarUserId(x_user_id);
      if (existingAccount && existingAccount.userId !== userId) {
        return c.redirect(`${FRONTEND_URL}/profile?polar_error=already_linked`);
      }

      try {
        const registerResponse = await fetch('https://www.polaraccesslink.com/v3/users', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${access_token}`,
          },
          body: JSON.stringify({ 'member-id': userId }),
        });

        if (!registerResponse.ok && registerResponse.status !== 409) {
          console.error('Polar user registration failed:', await registerResponse.text());
          return c.redirect(`${FRONTEND_URL}/profile?polar_error=registration`);
        }
      } catch (e) {
        console.error('Polar registration error:', e);
      }

      const polarAccountData = {
        userId,
        polarUserId: x_user_id,
        accessToken: access_token,
        memberId: userId,
        registeredAt: new Date(),
        lastSyncAt: null,
      };

      if (existingAccount) {
        await storage.updatePolarAccount(userId, polarAccountData);
      } else {
        await storage.createPolarAccount(polarAccountData);
      }

      return c.redirect(`${FRONTEND_URL}/profile?polar_connected=true`);
    } catch (error: any) {
      console.error('Polar callback error:', error);
      return c.redirect(`${c.env.FRONTEND_URL || 'https://runna.io'}/profile?polar_error=server`);
    }
  });

  app.post('/api/polar/disconnect', async (c) => {
    try {
      const body = await c.req.json();
      const { userId } = body;
      if (!userId) {
        return c.json({ error: "userId required" }, 400);
      }

      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);

      const polarAccount = await storage.getPolarAccountByUserId(userId);
      if (!polarAccount) {
        return c.json({ error: "Polar account not connected" }, 404);
      }

      try {
        await fetch(`https://www.polaraccesslink.com/v3/users/${polarAccount.polarUserId}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${polarAccount.accessToken}` },
        });
      } catch (e) {
        console.error('Failed to delete Polar user:', e);
      }

      await storage.deletePolarAccount(userId);
      return c.json({ success: true });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.post('/api/polar/sync/:userId', async (c) => {
    try {
      const userId = c.req.param('userId');
      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);
      const polarAccount = await storage.getPolarAccountByUserId(userId);
      
      if (!polarAccount) {
        return c.json({ error: 'Polar account not connected' }, 404);
      }

      const transactionResponse = await fetch(`https://www.polaraccesslink.com/v3/users/${polarAccount.polarUserId}/exercise-transactions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${polarAccount.accessToken}`,
          'Accept': 'application/json',
        },
      });

      if (transactionResponse.status === 204) {
        await storage.updatePolarAccount(userId, { lastSyncAt: new Date() });
        return c.json({ imported: 0, message: 'No new exercises available' });
      }

      if (!transactionResponse.ok) {
        console.error('Polar transaction failed:', await transactionResponse.text());
        return c.json({ error: 'Failed to create Polar transaction' }, 500);
      }

      const transaction: any = await transactionResponse.json();
      const transactionId = transaction['transaction-id'];

      const exercisesResponse = await fetch(transaction['resource-uri'], {
        headers: {
          'Authorization': `Bearer ${polarAccount.accessToken}`,
          'Accept': 'application/json',
        },
      });

      if (!exercisesResponse.ok) {
        console.error('Failed to list Polar exercises:', await exercisesResponse.text());
        return c.json({ error: 'Failed to list Polar exercises' }, 500);
      }

      const exercisesData: any = await exercisesResponse.json();
      const exerciseUrls = exercisesData.exercises || [];
      let imported = 0;

      for (const exerciseUrl of exerciseUrls) {
        try {
          const exerciseResponse = await fetch(exerciseUrl, {
            headers: {
              'Authorization': `Bearer ${polarAccount.accessToken}`,
              'Accept': 'application/json',
            },
          });

          if (!exerciseResponse.ok) continue;

          const exercise: any = await exerciseResponse.json();
          const exerciseId = exercise.id || exerciseUrl.split('/').pop();

          const existing = await storage.getPolarActivityByPolarId(exerciseId.toString());
          if (existing) continue;

          const sport = exercise['detailed-sport-info']?.sport || exercise.sport || '';
          const activityType = sport.toLowerCase();
          if (!['running', 'walking', 'trail_running', 'hiking', 'jogging'].some(t => activityType.includes(t))) {
            continue;
          }

          let summaryPolyline: string | null = null;
          try {
            const gpxResponse = await fetch(`${exerciseUrl}/gpx`, {
              headers: {
                'Authorization': `Bearer ${polarAccount.accessToken}`,
                'Accept': 'application/gpx+xml',
              },
            });

            if (gpxResponse.ok) {
              const gpxText = await gpxResponse.text();
              const coordinates = parseGpxToCoordinates(gpxText);
              if (coordinates.length >= 2) {
                summaryPolyline = encodePolyline(coordinates);
              }
            }
          } catch (e) {
            console.error('Failed to get GPX for exercise:', exerciseId, e);
          }

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

      try {
        await fetch(`https://www.polaraccesslink.com/v3/users/${polarAccount.polarUserId}/exercise-transactions/${transactionId}`, {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${polarAccount.accessToken}` },
        });
      } catch (e) {
        console.error('Failed to commit Polar transaction:', e);
      }

      await storage.updatePolarAccount(userId, { lastSyncAt: new Date() });

      return c.json({ imported, total: exerciseUrls.length });
    } catch (error: any) {
      console.error('Polar sync error:', error);
      return c.json({ error: error.message }, 500);
    }
  });

  app.get('/api/polar/activities/:userId', async (c) => {
    try {
      const userId = c.req.param('userId');
      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);
      const activities = await storage.getPolarActivitiesByUserId(userId);
      return c.json(activities);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.post('/api/polar/process/:userId', async (c) => {
    try {
      const userId = c.req.param('userId');
      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);
      const unprocessed = await storage.getUnprocessedPolarActivities(userId);
      const results: any[] = [];

      for (const activity of unprocessed) {
        if (!activity.summaryPolyline) {
          await storage.updatePolarActivity(activity.id, { processed: true, processedAt: new Date() });
          continue;
        }

        try {
          const decoded = decodePolyline(activity.summaryPolyline);
          const coordinates: Array<[number, number]> = decoded.map((coord: [number, number]) => [coord[0], coord[1]]);

          if (coordinates.length >= 3) {
            const route = await storage.createRoute({
              userId: activity.userId,
              name: activity.name,
              coordinates,
              distance: activity.distance,
              duration: activity.duration,
              startedAt: activity.startDate,
              completedAt: new Date(activity.startDate.getTime() + activity.duration * 1000),
            });

            const lineString = turf.lineString(
              coordinates.map(coord => [coord[1], coord[0]])
            );
            const buffered = turf.buffer(lineString, 0.05, { units: 'kilometers' });

            if (buffered) {
              const allTerritories = await storage.getAllTerritories();
              const userTerritories = allTerritories.filter(t => t.userId === userId);
              const otherTerritories = allTerritories.filter(t => t.userId !== userId);

              for (const otherTerritory of otherTerritories) {
                try {
                  const otherPoly = turf.polygon(otherTerritory.geometry.coordinates);
                  const intersection = turf.intersect(turf.featureCollection([buffered, otherPoly]));
                  if (intersection) {
                    await storage.deleteTerritoryById(otherTerritory.id);
                    const otherUserTerritories = await storage.getTerritoriesByUserId(otherTerritory.userId);
                    const newTotalArea = otherUserTerritories
                      .filter(t => t.id !== otherTerritory.id)
                      .reduce((sum, t) => sum + t.area, 0);
                    await storage.updateUserTotalArea(otherTerritory.userId, newTotalArea);
                  }
                } catch (e) {
                  console.error('Error checking intersection:', e);
                }
              }

              const area = turf.area(buffered) / 1000000;
              const newTerritory = await storage.createTerritory({
                userId,
                routeId: route.id,
                geometry: buffered.geometry as any,
                area,
              });

              const totalArea = userTerritories.reduce((sum, t) => sum + t.area, 0) + area;
              await storage.updateUserTotalArea(userId, totalArea);

              results.push({
                activityId: activity.id,
                routeId: route.id,
                territoryId: newTerritory.id,
                area,
              });
            }

            await storage.updatePolarActivity(activity.id, { 
              routeId: route.id, 
              processed: true, 
              processedAt: new Date() 
            });
          }
        } catch (e) {
          console.error('Error processing Polar activity:', e);
          await storage.updatePolarActivity(activity.id, { processed: true, processedAt: new Date() });
        }
      }

      return c.json({ processed: results.length, results });
    } catch (error: any) {
      console.error('Polar process error:', error);
      return c.json({ error: error.message }, 500);
    }
  });
  app.get('/api/polar/debug/:userId', async (c) => {
  try {
    const userId = c.req.param('userId');
    console.log('🔍 [DEBUG] Starting Polar data check for user:', userId);

    const db = createDb(c.env.DATABASE_URL);
    const storage = new WorkerStorage(db);

    // 1. Get account
    const polarAccount = await storage.getPolarAccountByUserId(userId);
    if (!polarAccount) {
      return c.json({ error: 'No Polar account' }, 404);
    }

    console.log('✅ Account found');
    console.log('  Token:', polarAccount.accessToken?.substring(0, 20) + '...');

    // 2. Fetch exercises DIRECTAMENTE
    console.log('\n🔍 [DEBUG EXERCISES]');
    const exercisesResponse = await fetch(
      'https://www.polaraccesslink.com/v3/exercises',
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${polarAccount.accessToken}`,
          'Accept': 'application/json',
        },
      }
    );

    console.log('Status:', exercisesResponse.status);
    const exercisesText = await exercisesResponse.text();
    console.log('Response length:', exercisesText.length);
    console.log('Response preview:', exercisesText.substring(0, 500));

    let exercises = [];
    if (exercisesText.length > 0) {
      try {
        exercises = JSON.parse(exercisesText);
        console.log('Parsed exercises:', exercises.length);
        if (exercises.length > 0) {
          console.log('\nFirst exercise sample:');
          console.log(JSON.stringify(exercises[0], null, 2));
        }
      } catch (e) {
        console.error('❌ Failed to parse exercises:', e);
      }
    }

    // 3. Fetch daily activities DIRECTAMENTE
    console.log('\n🔍 [DEBUG DAILY ACTIVITIES]');
    const to = new Date();
    const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    const fromStr = from.toISOString().split('T')[0];
    const toStr = to.toISOString().split('T')[0];

    console.log('Date range:', fromStr, 'to', toStr);

    const activitiesResponse = await fetch(
      `https://www.polaraccesslink.com/v3/users/activities?from=${fromStr}&to=${toStr}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${polarAccount.accessToken}`,
          'Accept': 'application/json',
        },
      }
    );

    console.log('Status:', activitiesResponse.status);
    const activitiesText = await activitiesResponse.text();
    console.log('Response length:', activitiesText.length);
    console.log('Response preview:', activitiesText.substring(0, 500));

    let activities = [];
    if (activitiesText.length > 0) {
      try {
        const activitiesData = JSON.parse(activitiesText);
        activities = Array.isArray(activitiesData) ? activitiesData : activitiesData.activities || [];
        console.log('Parsed activities:', activities.length);
        if (activities.length > 0) {
          console.log('\nFirst activity sample:');
          console.log(JSON.stringify(activities[0], null, 2));
        }
      } catch (e) {
        console.error('❌ Failed to parse activities:', e);
      }
    }

    // 4. Check what's already in DB
    console.log('\n🔍 [DEBUG DATABASE]');
    const dbActivities = await storage.getPolarActivitiesByUserId(userId);
    console.log('Activities in DB:', dbActivities.length);
    if (dbActivities.length > 0) {
      console.log('First DB activity:');
      console.log(JSON.stringify(dbActivities[0], null, 2).substring(0, 300));
    }

    // Return summary
    return c.json({
      summary: {
        polarAccountFound: !!polarAccount,
        tokenValid: !!polarAccount.accessToken,
        exercisesFromAPI: {
          count: exercises.length,
          status: exercisesResponse.status,
          sample: exercises.length > 0 ? exercises[0] : null,
        },
        activitiesFromAPI: {
          count: activities.length,
          status: activitiesResponse.status,
          dateRange: `${fromStr} to ${toStr}`,
          sample: activities.length > 0 ? activities[0] : null,
        },
        databaseActivities: {
          count: dbActivities.length,
          all: dbActivities,
        },
      },
      logs: 'Check Cloudflare Real-time tail for full logs',
    });

  } catch (error: any) {
    console.error('❌ [DEBUG ERROR]:', error.message);
    console.error(error.stack);
    return c.json({ error: error.message, stack: error.stack }, 500);
  }
});
}

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

// Helper to encode polyline
function encodePolyline(coordinates: Array<[number, number]>): string {
  let encoded = '';
  let prevLat = 0;
  let prevLng = 0;

  for (const [lat, lng] of coordinates) {
    const dlat = Math.round((lat - prevLat) * 1e5);
    const dlng = Math.round((lng - prevLng) * 1e5);

    encoded += encodeValue(dlat);
    encoded += encodeValue(dlng);

    prevLat = lat;
    prevLng = lng;
  }

  return encoded;
}

// Helper to encode a single value
function encodeValue(val: number): string {
  val = val << 1;
  if (val < 0) val = ~val;

  let encoded = '';
  while (val >= 0x20) {
    encoded += String.fromCharCode((0x20 | (val & 0x1f)) + 63);
    val >>= 5;
  }
  encoded += String.fromCharCode(val + 63);
  return encoded;
}

// Polyline decoder for Cloudflare Workers (no npm dependency)
function decodePolyline(encoded: string): [number, number][] {
  const points: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte: number;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const deltaLat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += deltaLat;

    shift = 0;
    result = 0;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const deltaLng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += deltaLng;

    points.push([lat / 1e5, lng / 1e5]);
  }

  return points;
}