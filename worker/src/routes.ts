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

  // Upload avatar image
  app.post('/api/user/avatar', async (c) => {
    try {
      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);
      const formData = await c.req.formData();
      const userId = formData.get('userId') as string;
      const file = formData.get('avatar') as File;

      if (!file || !userId) {
        return c.json({ error: 'Missing file or userId' }, 400);
      }

      // Validate file size (max 5MB)
      if (file.size > 5 * 1024 * 1024) {
        return c.json({ error: 'File size must be less than 5MB' }, 400);
      }

      // Convert to base64 for storage (avoid spread on large arrays)
      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);

      // Log file info for debugging
      try {
        console.log('Uploading avatar:', { name: (file as any).name, type: file.type, size: file.size });
      } catch (e) {}

      // Efficient base64 encoder avoiding large apply/call and huge intermediate strings
      const base64Encode = (input: Uint8Array) => {
        const lookup = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        const output: string[] = [];
        const len = input.length;
        let i = 0;
        for (; i + 2 < len; i += 3) {
          const n = (input[i] << 16) | (input[i + 1] << 8) | (input[i + 2]);
          output.push(
            lookup[(n >> 18) & 63],
            lookup[(n >> 12) & 63],
            lookup[(n >> 6) & 63],
            lookup[n & 63]
          );
          // avoid extremely large arrays growing too big in memory by flushing occasionally
          if (output.length > 16384) {
            output.push('');
          }
        }
        if (i < len) {
          const a = input[i];
          const b = i + 1 < len ? input[i + 1] : 0;
          const n = (a << 16) | (b << 8);
          output.push(lookup[(n >> 18) & 63]);
          output.push(lookup[(n >> 12) & 63]);
          output.push(i + 1 < len ? lookup[(n >> 6) & 63] : '=');
          output.push('=');
        }
        return output.join('');
      };

      const base64 = base64Encode(bytes);
      const dataUrl = `data:${file.type};base64,${base64}`;

      const updatedUser = await storage.updateUser(userId, { avatar: dataUrl });
      return c.json({ success: true, avatar: dataUrl });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // Delete avatar
  app.delete('/api/user/avatar', async (c) => {
    try {
      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);
      const body = await c.req.json();
      const { userId } = body;

      if (!userId) {
        return c.json({ error: 'Missing userId' }, 400);
      }

      const updatedUser = await storage.updateUser(userId, { avatar: null });
      return c.json({ success: true });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
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
                  // Send notification before deleting
                  const { notifyTerritoryLoss } = await import('./notifications');
                  await notifyTerritoryLoss(storage, otherTerritory.userId, routeData.userId, c.env);
                  
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
                }
              } catch (err) {
                console.error('Error merging territories:', err);
              }
            }

            const territory = await storage.updateTerritoryGeometry(
              routeData.userId,
              route.id,
              finalGeometry as any,
              turf.area(finalGeometry)
            );

            await storage.updateUserTotalArea(routeData.userId, territory.area);

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

  // ==================== FRIENDS SYSTEM ====================

  app.post('/api/friends', async (c) => {
    try {
      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);
      const body = await c.req.json();
      const { userId, friendId } = body;
      
      if (!userId || !friendId) {
        return c.json({ error: "userId and friendId required" }, 400);
      }

      if (userId === friendId) {
        return c.json({ error: "Cannot add yourself as friend" }, 400);
      }

      // Check if already friends
      const alreadyFriends = await storage.checkFriendship(userId, friendId);
      if (alreadyFriends) {
        return c.json({ error: "Already friends" }, 400);
      }

      // Create friend request instead of direct friendship
      const request = await storage.createFriendRequest({
        senderId: userId,
        recipientId: friendId,
      });

      // Send push notification to recipient
      const { notifyFriendRequest } = await import('./notifications');
      await notifyFriendRequest(storage, friendId, userId, c.env);

      return c.json({ success: true, requestId: request.id });
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

  app.delete('/api/friends/:friendId', async (c) => {
    try {
      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);
      const friendId = c.req.param('friendId');
      const body = await c.req.json();
      const { userId } = body;

      if (!userId) {
        return c.json({ error: "userId required in body" }, 400);
      }

      await storage.deleteBidirectionalFriendship(userId, friendId);
      return c.json({ success: true });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // Friend requests endpoints
  app.get('/api/friends/requests/:userId', async (c) => {
    try {
      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);
      const userId = c.req.param('userId');
      const requests = await storage.getFriendRequestsByRecipient(userId);
      
      // Enrich with sender info
      const enrichedRequests = await Promise.all(
        requests.map(async (req) => {
          const sender = await storage.getUser(req.senderId);
          return {
            ...req,
            sender: sender ? {
              id: sender.id,
              name: sender.name,
              username: sender.username,
              avatar: sender.avatar,
              color: sender.color,
            } : null,
          };
        })
      );

      return c.json(enrichedRequests);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // Get friend requests sent by a user
  app.get('/api/friends/requests/sent/:userId', async (c) => {
    try {
      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);
      const userId = c.req.param('userId');
      
      const requests = await storage.getFriendRequestsBySender(userId);
      
      // Enrich with recipient info
      const enrichedRequests = await Promise.all(
        requests.map(async (req) => {
          const recipient = await storage.getUser(req.recipientId);
          return {
            ...req,
            recipient: recipient ? {
              id: recipient.id,
              name: recipient.name,
              username: recipient.username,
              avatar: recipient.avatar,
              color: recipient.color,
            } : null,
          };
        })
      );

      return c.json(enrichedRequests);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.post('/api/friends/requests/:requestId/accept', async (c) => {
    try {
      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);
      const requestId = c.req.param('requestId');
      const body = await c.req.json();
      const { userId } = body;

      const request = await storage.getFriendRequestById(requestId);
      if (!request) {
        return c.json({ error: "Request not found" }, 404);
      }

      if (request.recipientId !== userId) {
        return c.json({ error: "Unauthorized" }, 403);
      }

      if (request.status !== 'pending') {
        return c.json({ error: "Request already processed" }, 400);
      }

      // Create bidirectional friendship
      await storage.createBidirectionalFriendship(request.senderId, request.recipientId);
      
      // Update request status
      await storage.updateFriendRequestStatus(requestId, 'accepted');

      // Send notification to sender
      const { notifyFriendRequestAccepted } = await import('./notifications');
      await notifyFriendRequestAccepted(storage, request.senderId, userId, c.env);

      return c.json({ success: true });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.post('/api/friends/requests/:requestId/reject', async (c) => {
    try {
      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);
      const requestId = c.req.param('requestId');
      const body = await c.req.json();
      const { userId } = body;

      const request = await storage.getFriendRequestById(requestId);
      if (!request) {
        return c.json({ error: "Request not found" }, 404);
      }

      if (request.recipientId !== userId) {
        return c.json({ error: "Unauthorized" }, 403);
      }

      // Update request status
      await storage.updateFriendRequestStatus(requestId, 'rejected');

      return c.json({ success: true });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.get('/api/users/search', async (c) => {
    try {
      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);
      const query = c.req.query('query');
      const userId = c.req.query('userId');

      if (!query || !userId) {
        return c.json({ error: "query and userId required" }, 400);
      }

      const users = await storage.searchUsers(query, userId);
      return c.json(users);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // Get aggregated stats for a user
  app.get('/api/users/:id/stats', async (c) => {
    try {
      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);
      const userId = c.req.param('id');

      const user = await storage.getUser(userId);
      if (!user) {
        return c.json({ error: 'User not found' }, 404);
      }

      // Total area (stored on users.totalArea)
      const totalArea = user.totalArea || 0;

      // Activities: count saved routes
      const routes = await storage.getRoutesByUserId(userId);
      const activitiesCount = routes.length;

      // Last activity: most recent route completion or strava activity
      const stravaActs = await storage.getStravaActivitiesByUserId(userId);
      const lastRouteDate = routes.length > 0 ? new Date(routes[0].completedAt) : null;
      const lastStravaDate = stravaActs.length > 0 ? new Date(stravaActs[0].startDate) : null;
      let lastActivity: string | null = null;
      if (lastRouteDate && lastStravaDate) {
        lastActivity = (lastRouteDate > lastStravaDate ? lastRouteDate : lastStravaDate).toISOString();
      } else if (lastRouteDate) {
        lastActivity = lastRouteDate.toISOString();
      } else if (lastStravaDate) {
        lastActivity = lastStravaDate.toISOString();
      }

      // Note: historical "stolen/robbed" area is not currently recorded in the DB.
      // Return null for those fields so the client can display N/A.
      const stats = {
        user: {
          id: user.id,
          name: user.name,
          username: user.username,
          avatar: user.avatar,
          color: user.color,
        },
        totalArea, // in m²
        activitiesCount,
        lastActivity, // ISO string or null
        areaStolen: null,
        areaRobbed: null,
      };

      return c.json(stats);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.get('/api/leaderboard/friends/:userId', async (c) => {
    try {
      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);
      const userId = c.req.param('userId');
      const friends = await storage.getLeaderboardFriends(userId);
      return c.json(friends);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.get('/api/territories/friends/:userId', async (c) => {
    try {
      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);
      const userId = c.req.param('userId');
      const territories = await storage.getTerritoriesWithUsersByFriends(userId);
      return c.json(territories);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.post('/api/friends/invite', async (c) => {
    try {
      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);
      const body = await c.req.json();
      const { userId } = body;

      if (!userId) {
        return c.json({ error: "userId required" }, 400);
      }

      const invite = await storage.createFriendInvite(userId);
      const inviteUrl = `${c.env.FRONTEND_URL || 'https://runna-io.pages.dev'}/friends/accept/${invite.token}`;
      
      return c.json({ token: invite.token, url: inviteUrl });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.post('/api/friends/accept/:token', async (c) => {
    try {
      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);
      const token = c.req.param('token');
      const body = await c.req.json();
      const { userId } = body;

      if (!userId) {
        return c.json({ error: "userId required" }, 400);
      }

      const invite = await storage.getFriendInviteByToken(token);

      if (!invite) {
        return c.json({ error: "Invite not found or expired" }, 404);
      }

      if (new Date() > invite.expiresAt) {
        await storage.deleteFriendInvite(invite.id);
        return c.json({ error: "Invite expired" }, 400);
      }

      if (invite.userId === userId) {
        return c.json({ error: "Cannot accept your own invite" }, 400);
      }

      await storage.createBidirectionalFriendship(invite.userId, userId);
      await storage.deleteFriendInvite(invite.id);

      // Send notification to the person who created the invite
      const { notifyFriendRequestAccepted } = await import('./notifications');
      await notifyFriendRequestAccepted(storage, invite.userId, userId, c.env);

      return c.json({ success: true, friendId: invite.userId });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // ==================== PUSH NOTIFICATIONS ====================

  app.post('/api/push/subscribe', async (c) => {
    try {
      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);
      const body = await c.req.json();
      const { userId, endpoint, keys } = body;

      if (!userId || !endpoint || !keys?.p256dh || !keys?.auth) {
        return c.json({ error: 'Missing required fields' }, 400);
      }

      await storage.createPushSubscription({
        userId,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
      });

      return c.json({ success: true });
    } catch (error: any) {
      console.error('Error subscribing to push:', error);
      return c.json({ error: error.message }, 500);
    }
  });

  app.post('/api/push/unsubscribe', async (c) => {
    try {
      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);
      const body = await c.req.json();
      const { userId } = body;

      if (!userId) {
        return c.json({ error: 'userId required' }, 400);
      }

      await storage.deletePushSubscriptionsByUserId(userId);
      return c.json({ success: true });
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
      const STRAVA_REDIRECT_URI = `${c.env.WORKER_URL || 'https://runna-io-api.runna-io-api.workers.dev'}/api/strava/callback`;

      
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

      const params = new URLSearchParams({
        client_id: STRAVA_CLIENT_ID!,
        client_secret: STRAVA_CLIENT_SECRET!,
        code: code as string,
        grant_type: 'authorization_code',
      });

      const tokenResponse = await fetch('https://www.strava.com/api/v3/oauth/token', {
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
                    // Send notification for Strava activity
                    const { notifyTerritoryLoss } = await import('./notifications');
                    await notifyTerritoryLoss(storage, otherTerritory.userId, userId, c.env);
                    
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
                  }
                } catch (err) {
                  console.error('Error merging territories:', err);
                }
              }

              const territory = await storage.updateTerritoryGeometry(
                userId,
                route.id,
                finalGeometry as any,
                turf.area(finalGeometry)
              );

              await storage.updateUserTotalArea(userId, territory.area);

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

      return c.json({ imported, total: stravaActivitiesList.length });
    } catch (error: any) {
      console.error('Strava sync error:', error);
      return c.json({ error: error.message }, 500);
    }
  });

  // ==================== POLAR ====================

  const triggerPolarBackfill = async (env: any, userId: string) => {
    const baseUrl = env.WORKER_URL || 'https://runna-io-api.runna-io-api.workers.dev';
    try {
      const res = await fetch(`${baseUrl}/api/polar/sync-full/${userId}`, { method: 'POST' });
      console.log(`[BACKFILL] kickoff user=${userId} status=${res.status}`);
    } catch (err) {
      console.error('[BACKFILL] kickoff failed', err);
    }
  };

  app.get('/api/polar/status/:userId', async (c) => {
    try {
      const userId = c.req.param('userId');
      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);
      const polarAccount = await storage.getPolarAccountByUserId(userId);
      
      if (polarAccount) {
        const stats = await storage.getPolarActivityStats(userId);
        return c.json({
          connected: true,
          polarUserId: polarAccount.polarUserId,
          lastSyncAt: polarAccount.lastSyncAt,
          totalActivities: stats.total,
          pendingActivities: stats.unprocessed,
          lastActivityStart: stats.lastStartDate,
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
      
      console.log('Polar connect request - userId:', userId, 'POLAR_CLIENT_ID:', POLAR_CLIENT_ID ? 'configured' : 'NOT configured');
      
      if (!userId || !POLAR_CLIENT_ID) {
        console.error('Missing userId or POLAR_CLIENT_ID');
        return c.json({ error: "userId required and Polar not configured" }, 400);
      }

      const state = btoa(JSON.stringify({ userId, ts: Date.now() }));
      const redirectUri = `${c.env.WORKER_URL || 'https://runna-io-api.runna-io-api.workers.dev'}/api/polar/callback`;
      const authUrl = `https://flow.polar.com/oauth2/authorization?response_type=code&client_id=${POLAR_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
      
      console.log('Generated authUrl:', authUrl);
      return c.json({ authUrl });
    } catch (error: any) {
      console.error('Polar connect error:', error);
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
      const FRONTEND_URL = c.env.FRONTEND_URL || 'https://runna-io.pages.dev';
      
      console.log('Polar callback started - code:', code ? 'present' : 'missing', 'state:', state ? 'present' : 'missing', 'error:', authError);
      
      if (authError) {
        console.log('Auth error detected:', authError);
        return c.redirect(`${FRONTEND_URL}/profile?polar_error=denied`);
      }
      
      if (!code || !state || !POLAR_CLIENT_ID || !POLAR_CLIENT_SECRET) {
        console.error('Missing required params - code:', !!code, 'state:', !!state, 'CLIENT_ID:', !!POLAR_CLIENT_ID, 'CLIENT_SECRET:', !!POLAR_CLIENT_SECRET);
        return c.redirect(`${FRONTEND_URL}/profile?polar_error=invalid`);
      }

      let userId: string;
      try {
        const decoded = JSON.parse(atob(state as string));
        userId = decoded.userId;
        console.log('State decoded - userId:', userId);
      } catch (e) {
        console.error('State decode error:', e);
        return c.redirect(`${FRONTEND_URL}/profile?polar_error=invalid_state`);
      }

      const redirectUri = `${c.env.WORKER_URL || 'https://runna-io-api.runna-io-api.workers.dev'}/api/polar/callback`;
      const authHeader = btoa(`${POLAR_CLIENT_ID}:${POLAR_CLIENT_SECRET}`);
      
      console.log('Exchanging code for token...');
      const tokenResponse = await fetch('https://polarremote.com/v2/oauth2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${authHeader}`,
          'Accept': 'application/json',
        },
        body: `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(redirectUri)}`,
      });

      if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        console.error('Polar token exchange failed:', errorText);
        return c.redirect(`${FRONTEND_URL}/profile?polar_error=token_exchange`);
      }

      const tokenData: any = await tokenResponse.json();
      const { access_token, x_user_id } = tokenData;
      const normalizedPolarUserId = Number(x_user_id);
      console.log('Token received - x_user_id:', x_user_id);

      if (!Number.isFinite(normalizedPolarUserId)) {
        console.error('Invalid x_user_id received:', x_user_id);
        return c.redirect(`${FRONTEND_URL}/profile?polar_error=invalid_user`);
      }

      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);

      console.log('Checking for existing account...');
      const existingAccount = await storage.getPolarAccountByPolarUserId(normalizedPolarUserId);
      if (existingAccount && existingAccount.userId !== userId) {
        console.log('Account already linked to different user');
        return c.redirect(`${FRONTEND_URL}/profile?polar_error=already_linked`);
      }

      try {
        console.log('Registering user with Polar using x_user_id:', x_user_id);
        const registerResponse = await fetch('https://www.polaraccesslink.com/v3/users', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/xml',
            'Authorization': `Bearer ${access_token}`,
            'Accept': 'application/json',
          },
          body: `<?xml version="1.0" encoding="UTF-8"?><register><member-id>${x_user_id}</member-id></register>`,
        });

        if (!registerResponse.ok && registerResponse.status !== 409) {
          const errorText = await registerResponse.text();
          console.error('Polar user registration failed:', errorText);
          return c.redirect(`${FRONTEND_URL}/profile?polar_error=registration`);
        }
        console.log('User registered or already exists');
      } catch (e) {
        console.error('Polar registration error:', e);
      }

      const polarAccountData = {
        userId,
        polarUserId: normalizedPolarUserId,
        accessToken: access_token,
        memberId: normalizedPolarUserId.toString(),
        lastSyncAt: null,
      };

      console.log('Saving account to database...');
      if (existingAccount) {
        await storage.updatePolarAccount(userId, polarAccountData);
        console.log('Account updated');
      } else {
        await storage.createPolarAccount(polarAccountData);
        console.log('Account created');
      }

      if (c.executionCtx) {
        c.executionCtx.waitUntil(triggerPolarBackfill(c.env, userId));
      }

      console.log('Polar callback success - redirecting to:', `${FRONTEND_URL}/profile?polar_connected=true`);
      return c.redirect(`${FRONTEND_URL}/profile?polar_connected=true`);
    } catch (error: any) {
      console.error('Polar callback error:', error);
      return c.redirect(`${c.env.FRONTEND_URL || 'https://runna-io.pages.dev'}/profile?polar_error=server`);
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

      console.log(`\n🔄 [SYNC] Starting Polar sync for user: ${userId}`);

      // MÉTODO DIRECTO: Obtener ejercicios del último mes
      const toDate = new Date();
      const fromDate = new Date(toDate.getTime() - 30 * 24 * 60 * 60 * 1000);
      
      const fromStr = fromDate.toISOString().split('T')[0];
      const toStr = toDate.toISOString().split('T')[0];
      
      console.log(`📅 Fetching exercises from ${fromStr} to ${toStr}`);

      const exercisesResponse = await fetch(
        `https://www.polaraccesslink.com/v3/users/${polarAccount.polarUserId}/exercise-transactions`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${polarAccount.accessToken}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
        }
      );

      // 401 means access token expired
      if (exercisesResponse.status === 401) {
        console.error('Polar token expired for user:', userId);
        await storage.deletePolarAccount(userId);
        return c.json({ error: 'Polar token expired - please reconnect' }, 401);
      }

      if (exercisesResponse.status === 204) {
        console.log('No new exercises (204 No Content)');
        await storage.updatePolarAccount(userId, { lastSyncAt: new Date() });
        return c.json({ imported: 0, total: 0, message: 'No new exercises available' });
      }

      if (!exercisesResponse.ok) {
        const errorText = await exercisesResponse.text();
        console.error('Polar transaction failed:', exercisesResponse.status, errorText);
        return c.json({ error: `Failed to get exercises: ${exercisesResponse.status}` }, 500);
      }

      const transactionData: any = await exercisesResponse.json();
      const transactionId = transactionData['transaction-id'];
      const resourceUri = transactionData['resource-uri'];
      
      console.log(`Transaction ID: ${transactionId}`);
      console.log(`Resource URI: ${resourceUri}`);

      // Obtener lista de ejercicios
      const listResponse = await fetch(resourceUri, {
        headers: {
          'Authorization': `Bearer ${polarAccount.accessToken}`,
          'Accept': 'application/json',
        },
      });

      if (!listResponse.ok) {
        const errorText = await listResponse.text();
        console.error('Failed to list exercises:', listResponse.status, errorText);
        return c.json({ error: 'Failed to list exercises' }, 500);
      }

      const listData: any = await listResponse.json();
      const exerciseUrls = listData.exercises || [];
      console.log(`📊 Found ${exerciseUrls.length} exercises`);
      
      let imported = 0;
      let skipped = 0;
      let errors = 0;

      for (const exerciseUrl of exerciseUrls) {
        try {
          const exerciseResponse = await fetch(exerciseUrl, {
            headers: {
              'Authorization': `Bearer ${polarAccount.accessToken}`,
              'Accept': 'application/json',
            },
          });

          if (!exerciseResponse.ok) {
            console.warn(`Failed to fetch exercise ${exerciseUrl}: ${exerciseResponse.status}`);
            continue;
          }

          const exercise: any = await exerciseResponse.json();
          const exerciseId = exercise.id || exerciseUrl.split('/').pop();

          console.log(`\n📍 Exercise: ${exerciseId}`);
          console.log(`   URL: ${exerciseUrl}`);

          // Verificar si ya existe
          const existing = await storage.getPolarActivityByPolarId(exerciseId.toString());
          if (existing) {
            console.log(`   ⏭️  Ya importada`);
            skipped++;
            continue;
          }

          // Extraer deporte de múltiples campos
          const sport = 
            exercise['detailed-sport-info']?.sport || 
            exercise['sport-info']?.sport ||
            exercise.sport || 
            exercise.type ||
            exercise['sport-id'] ||
            '';
          
          const activityType = String(sport).toLowerCase().trim();
          const distance = Number(exercise.distance) || 0;
          const duration = exercise.duration ? parseDuration(exercise.duration) : 0;
          const startTime = exercise['start-time'];
          
          console.log(`   Sport: "${sport}" (type: "${activityType}")`);
          console.log(`   Distance: ${distance}m | Duration: ${duration}s`);
          console.log(`   Start: ${startTime}`);

          // FILTRO MEJORADO: Sin restricciones si tiene datos básicos
          // Solo rechaza si claramente NO es una actividad de movimiento
          const excludeTypes = ['sleep', 'rest', 'pause', 'meditation', 'breathing'];
          const isExcluded = excludeTypes.some(t => activityType.includes(t));
          
          if (isExcluded) {
            console.log(`   ❌ Skipped: tipo excluido (${sport})`);
            skipped++;
            continue;
          }

          // Validar distancia mínima - pero menos restrictivo
          if (distance < 100) {
            console.log(`   ❌ Skipped: distancia muy corta (${distance}m < 100m)`);
            skipped++;
            continue;
          }

          // Validar duración mínima - pero menos restrictivo
          if (duration < 60) {
            console.log(`   ❌ Skipped: duración muy corta (${duration}s < 60s)`);
            skipped++;
            continue;
          }

          // Intentar obtener GPX
          let summaryPolyline: string | null = null;
          try {
            const gpxUrl = `${exerciseUrl}/gpx`;
            const gpxResponse = await fetch(gpxUrl, {
              headers: {
                'Authorization': `Bearer ${polarAccount.accessToken}`,
                'Accept': 'application/gpx+xml',
              },
            });

            if (gpxResponse.ok) {
              const gpxText = await gpxResponse.text();
              if (gpxText && gpxText.length > 0) {
                const coordinates = parseGpxToCoordinates(gpxText);
                console.log(`   📍 GPX: ${coordinates.length} coordinates`);
                
                if (coordinates.length >= 2) {
                  summaryPolyline = encodePolyline(coordinates);
                  console.log(`   ✅ Polyline encoded`);
                } else {
                  console.log(`   ⚠️  GPX has ${coordinates.length} coordinates (need ≥2)`);
                }
              }
            } else {
              console.log(`   ℹ️  No GPX (${gpxResponse.status})`);
            }
          } catch (e) {
            console.error(`   ❌ GPX error: ${e}`);
          }

          // Guardar actividad en BD
          await storage.createPolarActivity({
            polarExerciseId: exerciseId.toString(),
            userId,
            routeId: null,
            territoryId: null,
            name: `${sport} (${(distance/1000).toFixed(2)}km)`,
            activityType: sport,
            distance: distance,
            duration: duration,
            startDate: new Date(startTime),
            summaryPolyline,
            processed: false,
            processedAt: null,
          });
          
          console.log(`   ✅ IMPORTED!`);
          imported++;
        } catch (e) {
          console.error(`   ❌ Error: ${e}`);
          errors++;
        }
      }

      // Comprometer la transacción
      try {
        await fetch(
          `https://www.polaraccesslink.com/v3/users/${polarAccount.polarUserId}/exercise-transactions/${transactionId}`,
          {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${polarAccount.accessToken}` },
          }
        );
        console.log('✅ Transaction committed');
      } catch (e) {
        console.error('⚠️  Transaction commit failed:', e);
      }

      await storage.updatePolarAccount(userId, { lastSyncAt: new Date() });

      console.log(`\n📊 SYNC RESULT: ${imported} imported, ${skipped} skipped, ${errors} errors out of ${exerciseUrls.length} total`);

      return c.json({ 
        imported, 
        total: exerciseUrls.length, 
        skipped,
        errors,
        message: `${imported} importadas de ${exerciseUrls.length}` 
      });
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

  // Full sync - get all exercises from Polar history (last 365 days)
  app.post('/api/polar/sync-full/:userId', async (c) => {
    try {
      const userId = c.req.param('userId');
      const db = createDb(c.env.DATABASE_URL);
      const storage = new WorkerStorage(db);
      const polarAccount = await storage.getPolarAccountByUserId(userId);
      
      if (!polarAccount) {
        return c.json({ error: 'Polar account not connected' }, 404);
      }

      console.log(`\n🔄 [FULL SYNC] Starting full historical sync for user: ${userId}`);

      // Get exercises from last 365 days for full history
      const toDate = new Date();
      const fromDate = new Date(toDate.getTime() - 365 * 24 * 60 * 60 * 1000);
      
      const fromStr = fromDate.toISOString().split('T')[0];
      const toStr = toDate.toISOString().split('T')[0];
      
      console.log(`📅 Full sync: Fetching exercises from ${fromStr} to ${toStr} (365 days)`);

      const exercisesResponse = await fetch(
        `https://www.polaraccesslink.com/v3/users/${polarAccount.polarUserId}/exercise-transactions`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${polarAccount.accessToken}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
        }
      );

      if (exercisesResponse.status === 401) {
        console.error('Polar token expired for user:', userId);
        await storage.deletePolarAccount(userId);
        return c.json({ error: 'Polar token expired - please reconnect' }, 401);
      }

      if (exercisesResponse.status === 204) {
        console.log('No exercises found in history');
        return c.json({ imported: 0, total: 0, message: 'No exercises in history' });
      }

      if (!exercisesResponse.ok) {
        const errorText = await exercisesResponse.text();
        console.error('Polar transaction failed:', exercisesResponse.status, errorText);
        return c.json({ error: `Failed to get exercises: ${exercisesResponse.status}` }, 500);
      }

      const transactionData: any = await exercisesResponse.json();
      const transactionId = transactionData['transaction-id'];
      const resourceUri = transactionData['resource-uri'];
      
      console.log(`Transaction ID: ${transactionId}`);

      const listResponse = await fetch(resourceUri, {
        headers: {
          'Authorization': `Bearer ${polarAccount.accessToken}`,
          'Accept': 'application/json',
        },
      });

      if (!listResponse.ok) {
        const errorText = await listResponse.text();
        console.error('Failed to list exercises:', listResponse.status, errorText);
        return c.json({ error: 'Failed to list exercises' }, 500);
      }

      const listData: any = await listResponse.json();
      const exerciseUrls = listData.exercises || [];
      console.log(`📊 Full sync: Found ${exerciseUrls.length} exercises in last 90 days`);
      
      let imported = 0;
      let skipped = 0;
      let errors = 0;
      let duplicates = 0;

      for (const exerciseUrl of exerciseUrls) {
        try {
          const exerciseResponse = await fetch(exerciseUrl, {
            headers: {
              'Authorization': `Bearer ${polarAccount.accessToken}`,
              'Accept': 'application/json',
            },
          });

          if (!exerciseResponse.ok) {
            console.warn(`⚠️  Failed to fetch exercise: ${exerciseResponse.status}`);
            errors++;
            continue;
          }

          const exercise: any = await exerciseResponse.json();
          const exerciseId = exercise.id || exerciseUrl.split('/').pop();

          console.log(`\n📍 Exercise: ${exerciseId}`);

          // Check if already exists
          const existing = await storage.getPolarActivityByPolarId(exerciseId.toString());
          if (existing) {
            console.log(`   ⏭️  Already imported`);
            duplicates++;
            continue;
          }

          // Extract sport from multiple fields
          const sport = 
            exercise['detailed-sport-info']?.sport || 
            exercise['sport-info']?.sport ||
            exercise.sport || 
            exercise.type ||
            exercise['sport-id'] ||
            '';
          
          const activityType = String(sport).toLowerCase().trim();
          const distance = Number(exercise.distance) || 0;
          const duration = exercise.duration ? parseDuration(exercise.duration) : 0;
          const startTime = exercise['start-time'];
          
          console.log(`   Sport: "${sport}"`);
          console.log(`   Distance: ${distance}m | Duration: ${duration}s`);

          const excludeTypes = ['sleep', 'rest', 'pause', 'meditation', 'breathing'];
          const isExcluded = excludeTypes.some(t => activityType.includes(t));
          
          if (isExcluded) {
            console.log(`   ❌ Excluded type`);
            skipped++;
            continue;
          }

          if (distance < 100) {
            console.log(`   ❌ Distance too short (${distance}m)`);
            skipped++;
            continue;
          }

          if (duration < 60) {
            console.log(`   ❌ Duration too short (${duration}s)`);
            skipped++;
            continue;
          }

          // Try to get GPX
          let summaryPolyline: string | null = null;
          try {
            const gpxUrl = `${exerciseUrl}/gpx`;
            const gpxResponse = await fetch(gpxUrl, {
              headers: {
                'Authorization': `Bearer ${polarAccount.accessToken}`,
                'Accept': 'application/gpx+xml',
              },
            });

            if (gpxResponse.ok) {
              const gpxText = await gpxResponse.text();
              if (gpxText && gpxText.length > 0) {
                const coordinates = parseGpxToCoordinates(gpxText);
                console.log(`   📍 GPX: ${coordinates.length} coordinates`);
                
                if (coordinates.length >= 2) {
                  summaryPolyline = encodePolyline(coordinates);
                  console.log(`   ✅ Polyline encoded`);
                }
              }
            } else {
              console.log(`   ℹ️  No GPX`);
            }
          } catch (e) {
            console.error(`   ❌ GPX error: ${e}`);
          }

          await storage.createPolarActivity({
            polarExerciseId: exerciseId.toString(),
            userId,
            routeId: null,
            territoryId: null,
            name: `${sport} (${(distance/1000).toFixed(2)}km)`,
            activityType: sport,
            distance: distance,
            duration: duration,
            startDate: new Date(startTime),
            summaryPolyline,
            processed: false,
            processedAt: null,
          });
          
          console.log(`   ✅ IMPORTED!`);
          imported++;
        } catch (e) {
          console.error(`   ❌ Error: ${e}`);
          errors++;
        }
      }

      // Commit transaction
      try {
        await fetch(
          `https://www.polaraccesslink.com/v3/users/${polarAccount.polarUserId}/exercise-transactions/${transactionId}`,
          {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${polarAccount.accessToken}` },
          }
        );
        console.log('✅ Transaction committed');
      } catch (e) {
        console.error('⚠️  Transaction commit failed:', e);
      }

      console.log(`\n📊 FULL SYNC RESULT: ${imported} imported, ${duplicates} duplicates, ${skipped} skipped, ${errors} errors out of ${exerciseUrls.length} total`);

      return c.json({ 
        imported, 
        total: exerciseUrls.length, 
        duplicates,
        skipped,
        errors,
        message: `Full sync: ${imported} nuevas de ${exerciseUrls.length}` 
      });
    } catch (error: any) {
      console.error('Polar full sync error:', error);
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
          console.log(`Skipping Polar activity ${activity.id} - no GPS data available`);
          await storage.updatePolarActivity(activity.id, { processed: true, processedAt: new Date() });
          continue;
        }

        try {
          const decoded = decodePolyline(activity.summaryPolyline);
          const coordinates: Array<[number, number]> = decoded.map((coord: [number, number]) => [coord[0], coord[1]]);

          if (coordinates.length < 3) {
            console.log(`Skipping Polar activity ${activity.id} - insufficient coordinates (${coordinates.length})`);
            await storage.updatePolarActivity(activity.id, { processed: true, processedAt: new Date() });
            continue;
          }

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
                  // Send notification for Polar activity
                  const { notifyTerritoryLoss } = await import('./notifications');
                  await notifyTerritoryLoss(storage, otherTerritory.userId, userId, c.env);
                  
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

            let finalGeometry = buffered.geometry;
            for (const userTerritory of userTerritories) {
              try {
                const userPoly = turf.polygon(userTerritory.geometry.coordinates);
                const union = turf.union(turf.featureCollection([turf.polygon(finalGeometry.coordinates as any), userPoly]));
                if (union) {
                  finalGeometry = union.geometry as any;
                }
              } catch (err) {
                console.error('Error merging territories:', err);
              }
            }

            const territory = await storage.updateTerritoryGeometry(
              userId,
              route.id,
              finalGeometry as any,
              turf.area(finalGeometry)
            );

            await storage.updateUserTotalArea(userId, territory.area);

            results.push({
              activityId: activity.id,
              routeId: route.id,
              territoryId: territory.id,
              area: territory.area,
            });
          }

          await storage.updatePolarActivity(activity.id, { 
            routeId: route.id, 
            processed: true, 
            processedAt: new Date() 
          });
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