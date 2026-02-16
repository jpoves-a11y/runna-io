import { Hono } from 'hono';
import { createDb } from './db';
import { WorkerStorage } from './storage';
import { insertUserSchema, insertRouteSchema, insertFriendshipSchema, type InsertRoute, type Route } from '../../shared/schema';
import * as turf from '@turf/turf';
import { EmailService } from './email';
import type { Env } from './index';

// Helper function to get database instance
function getDb(env: Env) {
  return createDb(env.DATABASE_URL, env.TURSO_AUTH_TOKEN);
}

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

// Helper function to process territory conquest for a new route
// Helper function to check if two activities started at roughly the same time
// Only checks START dates (not end dates) with a 15-minute tolerance
function activitiesOverlapInTime(
  activity1Start: Date | string,
  activity1End: Date | string,
  activity2Start: Date | string,
  activity2End: Date | string,
  toleranceMs: number = 15 * 60 * 1000 // 15 minutes tolerance
): boolean {
  const a1Start = new Date(activity1Start).getTime();
  const a2Start = new Date(activity2Start).getTime();
  
  // Check if activities started within 15 min of each other (start dates only)
  const startDiff = Math.abs(a1Start - a2Start);
  
  return startDiff <= toleranceMs;
}

// Helper function to check if two geometries overlap by at least a percentage
function geometriesOverlapByPercentage(
  geometry1: any,
  geometry2: any,
  minOverlapPercent: number = 0.90 // 90% overlap required
): boolean {
  try {
    // Convert to features if needed
    const feature1 = geometry1.type === 'Feature' ? geometry1 : turf.feature(geometry1);
    const feature2 = geometry2.type === 'Feature' ? geometry2 : turf.feature(geometry2);
    
    // Calculate intersection
    const intersection = turf.intersect(turf.featureCollection([feature1, feature2]));
    
    if (!intersection) {
      return false; // No overlap
    }
    
    // Calculate areas
    const area1 = turf.area(feature1);
    const area2 = turf.area(feature2);
    const intersectionArea = turf.area(intersection);
    
    // Calculate overlap percentage relative to the smaller area
    const smallerArea = Math.min(area1, area2);
    const overlapPercent = smallerArea > 0 ? intersectionArea / smallerArea : 0;
    
    console.log(`[TERRITORY] Area overlap check: ${(overlapPercent * 100).toFixed(1)}% (threshold: ${minOverlapPercent * 100}%)`);
    
    return overlapPercent >= minOverlapPercent;
  } catch (err) {
    console.error('[TERRITORY] Error calculating geometry overlap:', err);
    return false;
  }
}

interface ConquestVictimInfo {
  userId: string;
  userName: string;
  userColor: string;
  stolenArea: number;
}

async function processTerritoryConquest(
  storage: WorkerStorage,
  userId: string,
  routeId: string,
  bufferedGeometry: any,
  env?: any,
  activityStartedAt?: string,
  activityCompletedAt?: string
): Promise<{
  territory: any;
  totalArea: number;
  newAreaConquered: number;
  areaStolen: number;
  victimsNotified: string[];
  victims: ConquestVictimInfo[];
  ranTogetherWith: string[]; // Users who ran together (no territory stolen)
}> {
  const allTerritories = await storage.getAllTerritories();
  const userTerritories = allTerritories.filter(t => t.userId === userId);
  
  // Get friend IDs to determine who can be conquered
  const friendIds = await storage.getFriendIds(userId);
  const enemyTerritories = allTerritories.filter(t => 
    t.userId !== userId && friendIds.includes(t.userId)
  );

  let totalStolenArea = 0;
  const victimsNotified: string[] = [];
  const ranTogetherWith: string[] = []; // Track users who ran together

  const victimMap = new Map<string, ConquestVictimInfo>();
  const defenderCache = new Map<string, any>();
  const attacker = await storage.getUser(userId);

  // Step 1: Handle enemy territory conquest
  console.log(`[TERRITORY] Processing ${enemyTerritories.length} enemy territories...`);
  
  for (const enemyTerritory of enemyTerritories) {
    try {
      // Check if activities were done together (time + area overlap)
      if (activityStartedAt && activityCompletedAt && enemyTerritory.routeId) {
        try {
          const enemyRoute = await storage.getRoute(enemyTerritory.routeId);
          if (enemyRoute && enemyRoute.startedAt && enemyRoute.completedAt) {
            // Check time overlap (within 30 minutes)
            const timeOverlap = activitiesOverlapInTime(
              activityStartedAt,
              activityCompletedAt,
              enemyRoute.startedAt,
              enemyRoute.completedAt
            );
            
            if (timeOverlap) {
              // Parse enemy territory geometry
              const enemyGeometry = typeof enemyTerritory.geometry === 'string'
                ? JSON.parse(enemyTerritory.geometry)
                : enemyTerritory.geometry;
              
              // Check area overlap (90% or more)
              const areaOverlap = geometriesOverlapByPercentage(
                bufferedGeometry,
                enemyGeometry,
                0.90
              );
              
              if (areaOverlap) {
                console.log(`[TERRITORY] Skipping territory ${enemyTerritory.id} from user ${enemyTerritory.userId} - ran together! (start times within 15min AND area 90%+ overlap)`);
                if (!ranTogetherWith.includes(enemyTerritory.userId)) {
                  ranTogetherWith.push(enemyTerritory.userId);
                }
                continue; // Skip this territory - they ran together
              }
            }
          }
        } catch (routeErr) {
          console.error('[TERRITORY] Error checking enemy route:', routeErr);
          // Continue with normal conquest if we can't check
        }
      }
      
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

        let defender = defenderCache.get(enemyTerritory.userId);
        if (!defender) {
          defender = await storage.getUser(enemyTerritory.userId);
          defenderCache.set(enemyTerritory.userId, defender);
        }

        if (!victimMap.has(enemyTerritory.userId)) {
          victimMap.set(enemyTerritory.userId, {
            userId: enemyTerritory.userId,
            userName: defender?.name || defender?.username || 'Usuario',
            userColor: defender?.color || '#9ca3af',
            stolenArea: 0,
          });
        }
        const currentVictim = victimMap.get(enemyTerritory.userId);
        if (currentVictim) {
          currentVictim.stolenArea += result.stolenArea;
        }

        // Send email notification
        try {
          const provider = env.EMAIL_PROVIDER || (env.SENDGRID_API_KEY ? 'sendgrid' : 'resend');
          const apiKey = provider === 'sendgrid' ? env.SENDGRID_API_KEY : env.RESEND_API_KEY;
          const fromEmail = provider === 'sendgrid' ? (env.SENDGRID_FROM || env.RESEND_FROM) : env.RESEND_FROM;
          const emailService = new EmailService(apiKey!, fromEmail, provider as any);
          
          if (attacker && defender && defender.email) {
            await emailService.sendTerritoryConqueredEmail(
              defender.email,
              attacker.name,
              attacker.username,
              result.stolenArea
            );
            
            await emailService.recordNotification(
              storage,
              enemyTerritory.userId,
              'territory_conquered',
              userId,
              `¡${attacker.name} te conquistó ${(result.stolenArea/1000000).toFixed(2)} km²!`,
              `${attacker.name} (@${attacker.username}) ha conquistado ${(result.stolenArea/1000000).toFixed(2)} km² de tu territorio.`,
              result.stolenArea
            );
          }
        } catch (emailErr) {
          console.error('[TERRITORY] Failed to send conquest email:', emailErr);
        }

        // Send notification with stolen area
        if (env && !victimsNotified.includes(enemyTerritory.userId)) {
          try {
            const { notifyTerritoryLoss } = await import('./notifications');
            await notifyTerritoryLoss(
              storage,
              enemyTerritory.userId,
              userId,
              env,
              result.stolenArea
            );
            victimsNotified.push(enemyTerritory.userId);
          } catch (notifErr) {
            console.error('[TERRITORY] Failed to send notification:', notifErr);
          }
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
    - Ran together with: ${ranTogetherWith.length > 0 ? ranTogetherWith.join(', ') : 'none'}
  `);

  return {
    territory: result.territory,
    totalArea: result.totalArea,
    newAreaConquered: result.newArea,
    areaStolen: totalStolenArea,
    victimsNotified,
    victims: Array.from(victimMap.values()).sort((a, b) => b.stolenArea - a.stolenArea),
    ranTogetherWith,
  };
}

// Rebuild territories for a user from all their remaining routes
// Used after route deletion to recalculate territory accurately
async function reprocessUserTerritories(
  storage: WorkerStorage,
  userId: string
): Promise<void> {
  // Delete all existing territories for this user
  await storage.deleteTerritoriesByUserId(userId);

  // Get all of the user's routes, ordered chronologically (oldest first)
  const userRoutes = await storage.getRoutesByUserIdChronological(userId);

  let currentGeometry: any = null;

  for (const route of userRoutes) {
    try {
      const coords: [number, number][] = Array.isArray(route.coordinates)
        ? route.coordinates
        : typeof route.coordinates === 'string'
          ? JSON.parse(route.coordinates)
          : [];

      if (coords.length < 3) continue;

      const simplifiedCoords = simplifyCoordinates(coords, 150);
      const lineString = turf.lineString(
        simplifiedCoords.map((coord: [number, number]) => [coord[1], coord[0]])
      );
      const buffered = turf.buffer(lineString, 0.05, { units: 'kilometers' });
      if (!buffered) continue;

      if (currentGeometry) {
        // Merge with existing territory
        try {
          const toFeature = (geom: any) => geom.type === 'MultiPolygon'
            ? turf.multiPolygon(geom.coordinates)
            : turf.polygon(geom.coordinates);
          const currentFeature = toFeature(currentGeometry);
          const newFeature = toFeature(buffered.geometry);
          const union = turf.union(
            turf.featureCollection([currentFeature, newFeature])
          );
          if (union) {
            currentGeometry = union.geometry;
          }
        } catch (err) {
          console.error('[REPROCESS] Error merging geometry:', err);
        }
      } else {
        currentGeometry = buffered.geometry;
      }
    } catch (err) {
      console.error(`[REPROCESS] Error processing route ${route.id}:`, err);
    }
  }

  if (currentGeometry) {
    const totalArea = turf.area(currentGeometry);
    await storage.updateTerritoryGeometry(userId, null, currentGeometry, totalArea);
    await storage.updateUserTotalArea(userId, totalArea);
  } else {
    await storage.updateUserTotalArea(userId, 0);
  }
}

// Reprocess ALL users' territories in strict chronological order so that
// older routes "own" the territory first and newer overlapping routes steal
// from them.  This is the only way to get correct steal attribution after
// a route is deleted and then reimported.
// Reprocess territories chronologically for a user and their friends only.
// Since territory stealing only happens between friends, a delete/reimport
// only needs to recalculate the territory of the affected friend group.
async function reprocessFriendGroupTerritoriesChronologically(
  storage: WorkerStorage,
  triggerUserId: string,
): Promise<void> {
  console.log(`[FRIEND REPROCESS] Starting for user ${triggerUserId} + friends...`);

  // 1. Determine the friend group (user + their friends)
  const friendIds = await storage.getFriendIds(triggerUserId);
  const groupUserIds = [triggerUserId, ...friendIds];
  console.log(`[FRIEND REPROCESS] Friend group: ${groupUserIds.length} users`);

  // 2. Wipe territories and conquest metrics for this group only
  for (const uid of groupUserIds) {
    await storage.deleteTerritoriesByUserId(uid);
    await storage.updateUserTotalArea(uid, 0);
  }

  // Delete conquest metrics where attacker OR defender is in the group
  for (const uid of groupUserIds) {
    await storage.deleteConquestMetricsByUserId(uid);
  }

  // 3. Get routes from group users only, oldest first
  const allRoutes = await storage.getRoutesForUsersChronological(groupUserIds);
  console.log(`[FRIEND REPROCESS] ${allRoutes.length} routes to process`);

  // Per-user accumulated geometry
  const userGeometries = new Map<string, any>();

  // Build a friendship lookup: for each user, which other group members are friends
  const friendshipMap = new Map<string, Set<string>>();
  for (const uid of groupUserIds) {
    const uFriends = await storage.getFriendIds(uid);
    friendshipMap.set(uid, new Set(uFriends));
  }

  for (const route of allRoutes) {
    try {
      const coords: [number, number][] = Array.isArray(route.coordinates)
        ? route.coordinates
        : typeof route.coordinates === 'string'
          ? JSON.parse(route.coordinates)
          : [];

      if (coords.length < 3) continue;

      const simplifiedCoords = simplifyCoordinates(coords, 150);
      const lineString = turf.lineString(
        simplifiedCoords.map((c: [number, number]) => [c[1], c[0]])
      );
      const buffered = turf.buffer(lineString, 0.05, { units: 'kilometers' });
      if (!buffered) continue;

      const routeGeometry = buffered.geometry;
      const routeOwnerFriends = friendshipMap.get(route.userId) || new Set();

      // --- Steal from FRIENDS only whose territory overlaps this route ---
      for (const [otherUserId, otherGeometry] of userGeometries) {
        if (otherUserId === route.userId) continue;
        // Only steal between friends
        if (!routeOwnerFriends.has(otherUserId)) continue;

        try {
          const toFeature = (geom: any) => geom.type === 'MultiPolygon'
            ? turf.multiPolygon(geom.coordinates)
            : turf.polygon(geom.coordinates);

          const otherFeature = toFeature(otherGeometry);
          const routeFeature = toFeature(routeGeometry);

          const intersection = turf.intersect(turf.featureCollection([otherFeature, routeFeature]));
          if (intersection) {
            // --- Ran-together exception: BOTH conditions must be met ---
            // 1. Start times within 15 minutes
            // 2. Area overlap >= 90%
            // If both conditions are met, they "ran together" → no stealing
            if (route.startedAt && route.completedAt) {
              // Find the enemy route that generated this territory
              // We check this route's time against all routes from otherUserId
              const otherRoutes = allRoutes.filter(r => r.userId === otherUserId);
              let ranTogether = false;
              for (const otherRoute of otherRoutes) {
                if (!otherRoute.startedAt || !otherRoute.completedAt) continue;
                const timeOverlap = activitiesOverlapInTime(
                  route.startedAt,
                  route.completedAt,
                  otherRoute.startedAt,
                  otherRoute.completedAt
                );
                if (timeOverlap) {
                  const areaOverlap = geometriesOverlapByPercentage(
                    routeGeometry,
                    otherGeometry,
                    0.90
                  );
                  if (areaOverlap) {
                    console.log(`[FRIEND REPROCESS] Ran together: route ${route.id} (${route.userId}) and user ${otherUserId} - start times within 15min AND 90%+ area overlap, skipping steal`);
                    ranTogether = true;
                    break;
                  }
                }
              }
              if (ranTogether) continue;
            }

            const stolenArea = turf.area(intersection);
            if (stolenArea > 0) {
              const remaining = turf.difference(turf.featureCollection([otherFeature, routeFeature]));
              if (remaining) {
                userGeometries.set(otherUserId, remaining.geometry);
              } else {
                userGeometries.delete(otherUserId);
              }

              try {
                await storage.recordConquestMetric(
                  route.userId,
                  otherUserId,
                  stolenArea,
                  route.id
                );
              } catch (_e) { /* best-effort */ }
            }
          }
        } catch (_e) {
          // geometry operation failed, skip
        }
      }

      // --- Merge route into its owner's accumulated geometry ---
      const existing = userGeometries.get(route.userId);
      if (existing) {
        try {
          const toFeature = (geom: any) => geom.type === 'MultiPolygon'
            ? turf.multiPolygon(geom.coordinates)
            : turf.polygon(geom.coordinates);
          const existingFeature = toFeature(existing);
          const newFeature = toFeature(routeGeometry);
          const union = turf.union(turf.featureCollection([existingFeature, newFeature]));
          if (union) {
            userGeometries.set(route.userId, union.geometry);
          }
        } catch (_e) {
          // If merge fails, keep existing
        }
      } else {
        userGeometries.set(route.userId, routeGeometry);
      }
    } catch (err) {
      console.error(`[FRIEND REPROCESS] Error on route ${route.id}:`, err);
    }
  }

  // 4. Persist final geometries
  for (const [uid, geometry] of userGeometries) {
    const totalArea = turf.area(geometry);
    await storage.updateTerritoryGeometry(uid, null, geometry, totalArea);
    await storage.updateUserTotalArea(uid, totalArea);
  }

  // Users in the group with no routes left
  for (const uid of groupUserIds) {
    if (!userGeometries.has(uid)) {
      await storage.updateUserTotalArea(uid, 0);
    }
  }

  console.log('[FRIEND REPROCESS] Chronological reprocessing complete');
}

// Check if a newly inserted route is chronologically older than existing routes
// from the user's FRIENDS.  If so, the territory ownership order is wrong and we
// need a friend-group chronological rebuild.
async function hasNewerOverlappingRoutes(
  storage: WorkerStorage,
  newRoute: { id: string; userId: string; completedAt: string | Date }
): Promise<boolean> {
  try {
    const newCompletedAt = typeof newRoute.completedAt === 'string'
      ? newRoute.completedAt
      : (newRoute.completedAt as Date).toISOString();

    // Only check friends' routes (only friends can steal territory)
    const friendIds = await storage.getFriendIds(newRoute.userId);
    if (friendIds.length === 0) return false;

    const friendRoutes = await storage.getRoutesForUsersChronological(friendIds);
    for (const route of friendRoutes) {
      const routeCompletedAt = typeof route.completedAt === 'string'
        ? route.completedAt
        : String(route.completedAt);
      if (routeCompletedAt > newCompletedAt) {
        return true;
      }
    }
    return false;
  } catch (err) {
    console.error('[hasNewerOverlappingRoutes] Error:', err);
    return false;
  }
}

function coerceDate(value: string | number | Date): Date | null {
  const date = value instanceof Date
    ? value
    : typeof value === 'number'
      ? new Date(value)
      : new Date(Number(value) || value);

  return Number.isNaN(date.getTime()) ? null : date;
}

// Simplify coordinates to reduce CPU usage in turf.js operations
// Uses Douglas-Peucker-like algorithm with distance threshold
function simplifyCoordinates(coords: Array<[number, number]>, maxPoints: number = 200): Array<[number, number]> {
  if (coords.length <= maxPoints) return coords;
  
  // Sample evenly distributed points
  const step = Math.ceil(coords.length / maxPoints);
  const simplified: Array<[number, number]> = [];
  
  for (let i = 0; i < coords.length; i += step) {
    simplified.push(coords[i]);
  }
  
  // Always include the last point
  if (simplified[simplified.length - 1] !== coords[coords.length - 1]) {
    simplified.push(coords[coords.length - 1]);
  }
  
  return simplified;
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
      const db = getDb(c.env);
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
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const userId = c.req.param('userId');
      const user = await storage.getUser(userId);
      if (!user) {
        return c.json({ error: "User not found" }, 404);
      }
      // Use friends leaderboard so rank is among friends, not global
      const friendsLeaderboard = await storage.getLeaderboardFriends(userId);
      const userWithStats = friendsLeaderboard.find(u => u.id === userId);
      if (!userWithStats) {
        // Fallback to global stats if somehow not in friends list
        const allUsers = await storage.getAllUsersWithStats();
        const globalUser = allUsers.find(u => u.id === userId);
        const { password: _, ...userWithoutPassword } = globalUser || user;
        return c.json(userWithoutPassword);
      }
      const { password: _, ...userWithoutPassword } = userWithStats;
      return c.json(userWithoutPassword);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.post('/api/auth/login', async (c) => {
    try {
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const body = await c.req.json();
      const { username, email, password } = body;
      const identifier = username || email;
      
      if (!identifier || !password) {
        return c.json({ error: "Usuario o correo y password son requeridos" }, 400);
      }
      
      const user = identifier.includes('@')
        ? await storage.getUserByEmail(identifier)
        : await storage.getUserByUsername(identifier);

      if (!user) {
        return c.json({ error: "Usuario no encontrado" }, 401);
      }

      const isValid = await verifyPassword(password, user.password);
      if (!isValid) {
        return c.json({ error: "Contraseña incorrecta" }, 401);
      }

      const { password: _, ...userWithoutPassword } = user;
      return c.json(userWithoutPassword);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.post('/api/users', async (c) => {
    try {
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const body = await c.req.json();
      const { password, email, ...userData } = body;
      
      if (!email || !email.includes('@')) {
        return c.json({ error: "Email válido requerido" }, 400);
      }
      
      if (!password || password.length < 4) {
        return c.json({ error: "La contraseña debe tener al menos 4 caracteres" }, 400);
      }

      // Generar código de verificación de 6 dígitos
      const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutos

      const hashedPassword = await hashPassword(password);
      const validatedData = insertUserSchema.parse({
        ...userData,
        email,
        password: hashedPassword,
      });
      const user = await storage.createUser({
        ...validatedData,
        emailVerified: false,
        verificationCode,
        verificationCodeExpiresAt: expiresAt,
      });
      
      // Create email preferences for new user
      await storage.createEmailPreferences(user.id);

      // Enviar código de verificación por email
      try {
        const provider1 = c.env.EMAIL_PROVIDER || (c.env.SENDGRID_API_KEY ? 'sendgrid' : 'resend');
        const apiKey1 = provider1 === 'sendgrid' ? c.env.SENDGRID_API_KEY : c.env.RESEND_API_KEY;
        const fromEmail1 = provider1 === 'sendgrid' ? (c.env.SENDGRID_FROM || c.env.RESEND_FROM) : c.env.RESEND_FROM;
        const emailService = new EmailService(apiKey1!, fromEmail1, provider1 as any);
        await emailService.sendVerificationCode(user.email, user.name, verificationCode);
      } catch (err) {
        console.error('[EMAIL] Failed to send verification code:', err);
      }
      
      const { password: _, verificationCode: __, ...userWithoutSensitive } = user as any;
      return c.json({ ...userWithoutSensitive, requiresVerification: true });
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  });

  // Endpoint para verificar código de email
  app.post('/api/auth/verify-email', async (c) => {
    try {
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const { userId, code } = await c.req.json();

      if (!userId || !code) {
        return c.json({ error: "userId y code son requeridos" }, 400);
      }

      const user = await storage.getUser(userId);
      if (!user) {
        return c.json({ error: "Usuario no encontrado" }, 404);
      }

      const userAny = user as any;
      if (userAny.emailVerified) {
        return c.json({ success: true, message: "Email ya verificado" });
      }

      if (!userAny.verificationCode || !userAny.verificationCodeExpiresAt) {
        return c.json({ error: "No hay código de verificación pendiente" }, 400);
      }

      const now = new Date();
      const expiresAt = new Date(userAny.verificationCodeExpiresAt);
      if (now > expiresAt) {
        return c.json({ error: "El código ha expirado. Solicita uno nuevo." }, 400);
      }

      if (userAny.verificationCode !== code) {
        return c.json({ error: "Código incorrecto" }, 400);
      }

      // Verificar usuario
      await storage.updateUser(userId, {
        emailVerified: true,
        verificationCode: null,
        verificationCodeExpiresAt: null,
      } as any);

      // Enviar email de bienvenida ahora que está verificado
      try {
        const provider1 = c.env.EMAIL_PROVIDER || (c.env.SENDGRID_API_KEY ? 'sendgrid' : 'resend');
        const apiKey1 = provider1 === 'sendgrid' ? c.env.SENDGRID_API_KEY : c.env.RESEND_API_KEY;
        const fromEmail1 = provider1 === 'sendgrid' ? (c.env.SENDGRID_FROM || c.env.RESEND_FROM) : c.env.RESEND_FROM;
        const emailService = new EmailService(apiKey1!, fromEmail1, provider1 as any);
        await emailService.sendWelcomeEmail(user.email, user.name);
      } catch (err) {
        console.error('[EMAIL] Failed to send welcome email:', err);
      }

      return c.json({ success: true, message: "Email verificado correctamente" });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // Endpoint para reenviar código de verificación
  app.post('/api/auth/resend-verification', async (c) => {
    try {
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const { userId } = await c.req.json();

      if (!userId) {
        return c.json({ error: "userId es requerido" }, 400);
      }

      const user = await storage.getUser(userId);
      if (!user) {
        return c.json({ error: "Usuario no encontrado" }, 404);
      }

      const userAny = user as any;
      if (userAny.emailVerified) {
        return c.json({ success: true, message: "Email ya verificado" });
      }

      // Generar nuevo código
      const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      await storage.updateUser(userId, {
        verificationCode,
        verificationCodeExpiresAt: expiresAt,
      } as any);

      // Enviar código
      try {
        const provider1 = c.env.EMAIL_PROVIDER || (c.env.SENDGRID_API_KEY ? 'sendgrid' : 'resend');
        const apiKey1 = provider1 === 'sendgrid' ? c.env.SENDGRID_API_KEY : c.env.RESEND_API_KEY;
        const fromEmail1 = provider1 === 'sendgrid' ? (c.env.SENDGRID_FROM || c.env.RESEND_FROM) : c.env.RESEND_FROM;
        const emailService = new EmailService(apiKey1!, fromEmail1, provider1 as any);
        await emailService.sendVerificationCode(user.email, user.name, verificationCode);
      } catch (err) {
        console.error('[EMAIL] Failed to resend verification code:', err);
        return c.json({ error: "No se pudo enviar el código" }, 500);
      }

      return c.json({ success: true, message: "Código reenviado" });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.get('/api/user/:id', async (c) => {
    try {
      const db = getDb(c.env);
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
      const db = getDb(c.env);
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
      const db = getDb(c.env);
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
      const db = getDb(c.env);
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
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const users = await storage.getAllUsersWithStats();
      return c.json(users);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.post('/api/routes', async (c) => {
    try {
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const body = await c.req.json();
      const routeData = insertRouteSchema.parse(body);
      
      const route = await storage.createRoute(routeData);

      // Parse coordinates from JSON string
      const coords: [number, number][] = typeof routeData.coordinates === 'string'
        ? JSON.parse(routeData.coordinates)
        : routeData.coordinates;

      if (coords.length >= 3) {
        try {
          const simplifiedCoords = simplifyCoordinates(coords, 150);
          const lineString = turf.lineString(
            simplifiedCoords.map((coord: [number, number]) => [coord[1], coord[0]])
          );
          
          const buffered = turf.buffer(lineString, 0.05, { units: 'kilometers' });
          
          if (buffered) {
            const conquestResult = await processTerritoryConquest(
              storage,
              routeData.userId,
              route.id,
              buffered.geometry,
              c.env,
              routeData.startedAt,
              routeData.completedAt
            );

            // Save ran together info to the route
            if (conquestResult.ranTogetherWith.length > 0) {
              await storage.updateRouteRanTogether(route.id, conquestResult.ranTogetherWith);
            }

            // Send notifications to friends about new activity + check area overtakes
            // (non-blocking — don't await, let it run in background)
            c.executionCtx.waitUntil((async () => {
              try {
                const { notifyFriendNewActivity, notifyAreaOvertake } = await import('./notifications');
                
                // 1. Notify friends about new activity
                const distanceKm = routeData.distance ? routeData.distance / 1000 : 0;
                const newAreaKm2 = conquestResult.newAreaConquered / 1000000;
                await notifyFriendNewActivity(
                  storage,
                  routeData.userId,
                  distanceKm,
                  newAreaKm2,
                  c.env
                );

                // 2. Check if user overtook any friends in total area
                const friendIds = await storage.getFriendIds(routeData.userId);
                const userAreaKm2 = conquestResult.totalArea / 1000000;
                
                for (const friendId of friendIds) {
                  try {
                    const friend = await storage.getUser(friendId);
                    if (friend && friend.totalArea !== null && friend.totalArea !== undefined) {
                      const friendAreaKm2 = friend.totalArea / 1000000;
                      // User now has more area than friend
                      // Check if before this activity they had less (new area pushed them over)
                      const previousAreaKm2 = (conquestResult.totalArea - conquestResult.newAreaConquered) / 1000000;
                      if (previousAreaKm2 < friendAreaKm2 && userAreaKm2 >= friendAreaKm2) {
                        await notifyAreaOvertake(
                          storage,
                          routeData.userId,
                          friendId,
                          userAreaKm2,
                          c.env
                        );
                      }
                    }
                  } catch (friendErr) {
                    console.error(`[NOTIFY] Error checking overtake for friend ${friendId}:`, friendErr);
                  }
                }
              } catch (notifErr) {
                console.error('[NOTIFY] Error sending activity/overtake notifications:', notifErr);
              }
            })());

            // Encode polyline from coords for the response
            const summaryPolyline = encodePolyline(coords);

            return c.json({ 
              route, 
              territory: conquestResult.territory,
              summaryPolyline,
              metrics: {
                totalArea: conquestResult.totalArea,
                newAreaConquered: conquestResult.newAreaConquered,
                areaStolen: conquestResult.areaStolen,
                ranTogetherWith: conquestResult.ranTogetherWith,
                victimsNotified: conquestResult.victimsNotified,
                victims: conquestResult.victims,
              }
            });
          } else {
            // Encode polyline even without territory
            const summaryPolyline = encodePolyline(coords);
            return c.json({ route, summaryPolyline });
          }
        } catch (error) {
          console.error('Error calculating territory:', error);
          const summaryPolyline = encodePolyline(coords);
          return c.json({ route, summaryPolyline });
        }
      } else {
        return c.json({ route });
      }
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  });

  // Rename a route
  app.patch('/api/routes/:routeId/name', async (c) => {
    try {
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const routeId = c.req.param('routeId');
      const { userId, name } = await c.req.json();
      if (!userId || !name || !name.trim()) {
        return c.json({ error: 'userId and name are required' }, 400);
      }
      const route = await storage.getRouteById(routeId);
      if (!route) {
        return c.json({ error: 'Route not found' }, 404);
      }
      if (route.userId !== userId) {
        return c.json({ error: 'Unauthorized' }, 403);
      }
      await storage.updateRouteName(routeId, name.trim());
      return c.json({ success: true });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // Delete a route and its associated territory/metrics
  app.delete('/api/routes/:routeId', async (c) => {
    try {
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const routeId = c.req.param('routeId');
      const body = await c.req.json();
      const userId = body.userId;

      if (!userId) {
        return c.json({ error: 'userId is required' }, 400);
      }

      // Verify the route belongs to this user
      const route = await storage.getRouteById(routeId);
      if (!route) {
        return c.json({ error: 'Route not found' }, 404);
      }
      if (route.userId !== userId) {
        return c.json({ error: 'Unauthorized' }, 403);
      }

      // Detach territories from this route (set routeId to null) so cascade doesn't delete them
      await storage.detachTerritoriesFromRoute(routeId);

      // Delete conquest metrics for this route
      await storage.deleteConquestMetricsByRouteId(routeId);

      // Remove any linked Polar/Strava activity records so they can be reimported
      await storage.deletePolarActivityByRouteId(routeId);
      await storage.deleteStravaActivityByRouteId(routeId);

      // Delete the route itself (no cascade on territories now)
      await storage.deleteRouteById(routeId);

      // Reprocess this user's friend group territories chronologically
      // so that removing this route recalculates correct ownership order
      await reprocessFriendGroupTerritoriesChronologically(storage, userId);

      return c.json({ success: true });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // Reprocess all territories for all users (admin endpoint to fix data)
  app.post('/api/admin/reprocess-territories', async (c) => {
    try {
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);

      // Fix the FK constraint in the actual database
      // Clean stale route_ids from territories
      try {
        await storage.cleanStaleRouteIds();
      } catch (e) {
        console.error('[REPROCESS] Could not clean stale route_ids:', e);
      }

      // Reprocess each user's friend group chronologically
      const allUsers = await storage.getAllUsersWithStats();
      const processedGroups = new Set<string>();
      for (const user of allUsers) {
        if (processedGroups.has(user.id)) continue;
        const friendIds = await storage.getFriendIds(user.id);
        // Mark this group as processed
        processedGroups.add(user.id);
        for (const fid of friendIds) processedGroups.add(fid);
        await reprocessFriendGroupTerritoriesChronologically(storage, user.id);
      }

      // Gather results summary
      const results: { userId: string; name: string; totalArea: number; routeCount: number }[] = [];
      for (const user of allUsers) {
        const updatedUser = await storage.getUser(user.id);
        const userRoutes = await storage.getRoutesByUserIdChronological(user.id);
        results.push({
          userId: user.id,
          name: user.name,
          totalArea: updatedUser?.totalArea || 0,
          routeCount: userRoutes.length,
        });
      }

      return c.json({ success: true, results });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // Admin: Full cleanup of a user's data (routes, territories, activities) so they can reimport fresh
  app.post('/api/admin/cleanup-user/:username', async (c) => {
    try {
      const username = c.req.param('username');
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);

      const user = await storage.getUserByUsername(username);
      if (!user) {
        return c.json({ error: `User '${username}' not found` }, 404);
      }

      const userId = user.id;
      console.log(`[ADMIN CLEANUP] Starting full cleanup for user: ${username} (${userId})`);

      // 1. Delete all conquest metrics involving this user
      await storage.deleteConquestMetricsByUserId(userId);
      console.log(`[ADMIN CLEANUP] Deleted conquest metrics`);

      // 2. Delete all territories for this user
      await storage.deleteTerritoriesByUserId(userId);
      console.log(`[ADMIN CLEANUP] Deleted territories`);

      // 3. Delete all routes for this user
      await storage.deleteAllRoutesByUserId(userId);
      console.log(`[ADMIN CLEANUP] Deleted routes`);

      // 4. Delete all polar activity records (so they can be reimported)
      await storage.deleteAllPolarActivitiesByUserId(userId);
      console.log(`[ADMIN CLEANUP] Deleted polar activities`);

      // 5. Delete all strava activity records (so they can be reimported)
      await storage.deleteAllStravaActivitiesByUserId(userId);
      console.log(`[ADMIN CLEANUP] Deleted strava activities`);

      // 6. Reset user stats
      await storage.updateUser(userId, { totalArea: 0, totalDistance: 0 });
      console.log(`[ADMIN CLEANUP] Reset user stats`);

      // 7. Reprocess friend group territories (friends keep their territories, just recalculated without this user's old data)
      try {
        await reprocessFriendGroupTerritoriesChronologically(storage, userId);
        console.log(`[ADMIN CLEANUP] Reprocessed friend group territories`);
      } catch (e) {
        console.error('[ADMIN CLEANUP] Error reprocessing friend group:', e);
      }

      return c.json({
        success: true,
        message: `User '${username}' data cleaned. Polar/Strava activities removed. User can now sync to reimport.`,
        userId,
      });
    } catch (error: any) {
      console.error('[ADMIN CLEANUP] Error:', error);
      return c.json({ error: error.message }, 500);
    }
  });

  app.get('/api/routes/:userId', async (c) => {
    try {
      const db = getDb(c.env);
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
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const territories = await storage.getAllTerritories();
      return c.json(territories);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // Get user conquest stats (km stolen/lost)
  app.get('/api/conquest-stats/:userId', async (c) => {
    try {
      const userId = c.req.param('userId');
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const stats = await storage.getUserConquestStats(userId);
      return c.json(stats);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // ==================== FRIENDS SYSTEM ====================

  app.post('/api/friends', async (c) => {
    try {
      const db = getDb(c.env);
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

      // Send email notification
      try {
        const sender = await storage.getUser(userId);
        const recipient = await storage.getUser(friendId);
        const provider2 = c.env.EMAIL_PROVIDER || (c.env.SENDGRID_API_KEY ? 'sendgrid' : 'resend');
        const apiKey2 = provider2 === 'sendgrid' ? c.env.SENDGRID_API_KEY : c.env.RESEND_API_KEY;
        const fromEmail2 = provider2 === 'sendgrid' ? (c.env.SENDGRID_FROM || c.env.RESEND_FROM) : c.env.RESEND_FROM;
        const emailService = new EmailService(apiKey2!, fromEmail2, provider2 as any);
        
        if (sender && recipient && recipient.email) {
          const prefs = await storage.getEmailPreferences(friendId);
          if (!prefs || prefs.friendRequestNotifications) {
            await emailService.sendFriendRequestEmail(
              recipient.email,
              sender.name,
              sender.username
            );
            
            await emailService.recordNotification(
              storage,
              friendId,
              'friend_request',
              userId,
              `¡${sender.name} te envió una solicitud de amistad!`,
              `${sender.name} (@${sender.username}) te ha enviado una solicitud de amistad en Runna.io.`
            );
          }
        }
      } catch (emailErr) {
        console.error('[EMAIL] Failed to send friend request email:', emailErr);
      }

      return c.json({ success: true, requestId: request.id });
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  });

  app.get('/api/friends/:userId', async (c) => {
    try {
      const db = getDb(c.env);
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
      const db = getDb(c.env);
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
      const db = getDb(c.env);
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
      const db = getDb(c.env);
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
      const db = getDb(c.env);
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

      // Send email notification
      try {
        const sender = await storage.getUser(request.senderId);
        const recipient = await storage.getUser(userId);
        const provider3 = c.env.EMAIL_PROVIDER || (c.env.SENDGRID_API_KEY ? 'sendgrid' : 'resend');
        const apiKey3 = provider3 === 'sendgrid' ? c.env.SENDGRID_API_KEY : c.env.RESEND_API_KEY;
        const fromEmail3 = provider3 === 'sendgrid' ? (c.env.SENDGRID_FROM || c.env.RESEND_FROM) : c.env.RESEND_FROM;
        const emailService = new EmailService(apiKey3!, fromEmail3, provider3 as any);
        
        if (sender && sender.email && recipient) {
          const prefs = await storage.getEmailPreferences(request.senderId);
          if (!prefs || prefs.friendAcceptedNotifications) {
            await emailService.sendFriendAcceptedEmail(
              sender.email,
              recipient.name,
              recipient.username
            );
            
            await emailService.recordNotification(
              storage,
              request.senderId,
              'friend_accepted',
              userId,
              `¡${recipient.name} aceptó tu solicitud de amistad!`,
              `${recipient.name} (@${recipient.username}) aceptó tu solicitud de amistad. Ahora son amigos en Runna.io!`
            );
          }
        }
      } catch (emailErr) {
        console.error('[EMAIL] Failed to send friend accepted email:', emailErr);
      }

      // Reprocess territories for the new friend group
      // When two users become friends, their overlapping territories need 
      // to be recalculated chronologically (newer steals from older)
      try {
        console.log(`[FRIEND ACCEPT] Reprocessing territories for new friends: ${request.senderId} <-> ${userId}`);
        await reprocessFriendGroupTerritoriesChronologically(storage, request.senderId);
        console.log(`[FRIEND ACCEPT] Territory reprocessing complete`);
      } catch (reprocessErr) {
        console.error('[FRIEND ACCEPT] Failed to reprocess territories:', reprocessErr);
        // Don't fail the friendship creation if territory reprocessing fails
      }

      return c.json({ success: true });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.post('/api/friends/requests/:requestId/reject', async (c) => {
    try {
      const db = getDb(c.env);
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

  // Cancel (delete) a friend request sent by the user
  app.delete('/api/friends/requests/:requestId', async (c) => {
    try {
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const requestId = c.req.param('requestId');

      const request = await storage.getFriendRequestById(requestId);
      if (!request) {
        return c.json({ error: "Request not found" }, 404);
      }

      // Only the sender can cancel their own request
      // We don't check userId from body here since the request itself identifies the sender
      // If you want additional auth, uncomment the lines below
      // const body = await c.req.json();
      // const { userId } = body;
      // if (request.senderId !== userId) {
      //   return c.json({ error: "Unauthorized" }, 403);
      // }

      // Delete the request
      await storage.deleteFriendRequest(requestId);

      return c.json({ success: true });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.get('/api/users/search', async (c) => {
    try {
      const db = getDb(c.env);
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
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const userId = c.req.param('id');

      const user = await storage.getUser(userId);
      if (!user) {
        return c.json({ error: 'User not found' }, 404);
      }

      // Total area (stored on users.totalArea)
      const totalArea = user.totalArea || 0;

      // Activities & last activity - wrapped in try/catch so user info still returns if routes fail
      let activitiesCount = 0;
      let lastActivity: string | null = null;
      try {
        const routes = await storage.getRoutesByUserId(userId);
        activitiesCount = routes.length;
        const lastRouteDate = routes.length > 0 ? new Date(routes[0].completedAt) : null;

        try {
          const stravaActs = await storage.getStravaActivitiesByUserId(userId);
          const lastStravaDate = stravaActs.length > 0 ? new Date(stravaActs[0].startDate) : null;
          if (lastRouteDate && lastStravaDate) {
            lastActivity = (lastRouteDate > lastStravaDate ? lastRouteDate : lastStravaDate).toISOString();
          } else if (lastRouteDate) {
            lastActivity = lastRouteDate.toISOString();
          } else if (lastStravaDate) {
            lastActivity = lastStravaDate.toISOString();
          }
        } catch (e) {
          console.error('Error fetching strava activities for stats:', e);
          if (lastRouteDate) lastActivity = lastRouteDate.toISOString();
        }
      } catch (e) {
        console.error('Error fetching routes for user stats:', e);
      }

      // Conquest stats: total stolen by this user and total lost by this user (global)
      let totalStolen = 0;
      let totalLost = 0;
      // Conquest stats between viewer and this user
      let stolenFromViewer = 0;
      let stolenByViewer = 0;
      try {
        const conquestStats = await storage.getUserConquestStats(userId);
        totalStolen = conquestStats.totalStolen;
        totalLost = conquestStats.totalLost;
      } catch (e) {
        console.error('Error fetching conquest stats:', e);
      }

      // If a viewerId is provided, compute stolen area between the two users
      const viewerId = c.req.query('viewerId');
      if (viewerId && viewerId !== userId) {
        try {
          const between = await storage.getConquestMetricsBetweenUsers(userId, viewerId);
          // totalFromFirstToSecond = area userId stole from viewerId
          // totalFromSecondToFirst = area viewerId stole from userId
          stolenFromViewer = between.totalFromFirstToSecond; // this user stole from viewer
          stolenByViewer = between.totalFromSecondToFirst; // viewer stole from this user
        } catch (e) {
          console.error('Error fetching conquest metrics between users:', e);
        }
      }

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
        totalStolen, // total area this user has stolen globally (m²)
        totalLost, // total area stolen from this user globally (m²)
        stolenFromViewer, // area this user stole from the viewer (m²)
        stolenByViewer, // area the viewer stole from this user (m²)
      };

      return c.json(stats);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.get('/api/leaderboard/friends/:userId', async (c) => {
    try {
      const db = getDb(c.env);
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
      const db = getDb(c.env);
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
      const db = getDb(c.env);
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
      const db = getDb(c.env);
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
      const db = getDb(c.env);
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
      const db = getDb(c.env);
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

  // Test push notification endpoint
  app.post('/api/push/test', async (c) => {
    try {
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const body = await c.req.json();
      const { userId } = body;

      if (!userId) return c.json({ error: 'userId required' }, 400);

      const subscriptions = await storage.getPushSubscriptionsByUserId(userId);
      if (subscriptions.length === 0) {
        return c.json({ error: 'No push subscriptions found for this user', subscriptionCount: 0 }, 404);
      }

      const { sendPushToUser } = await import('./pushHelper');

      const pushSubs = subscriptions.map((sub) => ({
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      }));

      const payload = {
        title: '🏃 Runna.io',
        body: '¡Las notificaciones funcionan correctamente!',
        tag: 'test-notification',
        data: { url: '/', type: 'test' },
      };

      await sendPushToUser(
        pushSubs,
        payload,
        c.env.VAPID_PUBLIC_KEY || '',
        c.env.VAPID_PRIVATE_KEY || '',
        c.env.VAPID_SUBJECT || 'mailto:notifications@runna.io'
      );

      return c.json({ success: true, subscriptionCount: subscriptions.length });
    } catch (error: any) {
      console.error('Error sending test push:', error);
      return c.json({ error: error.message }, 500);
    }
  });

  // ==================== STRAVA INTEGRATION ====================

  app.get('/api/strava/status/:userId', async (c) => {
    try {
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const userId = c.req.param('userId');
      const stravaAccount = await storage.getStravaAccountByUserId(userId);
      
      if (stravaAccount) {
        const failedActivities = await storage.getFailedStravaActivities(userId);
        return c.json({
          connected: true,
          athleteData: stravaAccount.athleteData,
          lastSyncAt: stravaAccount.lastSyncAt,
          failedActivities: failedActivities.length,
        });
      } else {
        return c.json({ connected: false });
      }
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // Get failed activities for a user
  app.get('/api/strava/failed/:userId', async (c) => {
    try {
      const userId = c.req.param('userId');
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const failedActivities = await storage.getFailedStravaActivities(userId);
      return c.json(failedActivities);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // Retry processing a failed activity
  app.post('/api/strava/retry/:activityId', async (c) => {
    try {
      const activityId = c.req.param('activityId');
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      
      // Reset the activity for retry
      const activity = await storage.resetStravaActivityForRetry(activityId);
      
      console.log(`[STRAVA] Activity ${activityId} reset for retry`);
      return c.json({ message: 'Activity reset for retry', activity });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // Retry processing all failed activities for a user
  app.post('/api/strava/retry-all/:userId', async (c) => {
    try {
      const userId = c.req.param('userId');
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      
      // Get all failed activities
      const failedActivities = await storage.getFailedStravaActivities(userId);
      console.log(`[STRAVA] Retrying ${failedActivities.length} failed activities for user ${userId}`);
      
      // Reset all for retry
      let retryCount = 0;
      for (const activity of failedActivities) {
        try {
          await storage.resetStravaActivityForRetry(activity.id);
          retryCount++;
        } catch (err) {
          console.error(`[STRAVA] Failed to reset activity ${activity.id}:`, err);
        }
      }
      
      return c.json({ 
        message: `${retryCount}/${failedActivities.length} activities reset for retry`,
        retryCount,
        totalFailed: failedActivities.length,
      });
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

      const db = getDb(c.env);
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

      const db = getDb(c.env);
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
        const db = getDb(c.env);
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
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const unprocessed = await storage.getUnprocessedStravaActivities(userId);
      const results: any[] = [];

      for (const activity of unprocessed) {
        if (!activity.summaryPolyline) {
          await storage.updateStravaActivity(activity.id, { processed: true, processedAt: new Date() });
          continue;
        }

        try {
          const startDate = coerceDate(activity.startDate);
          if (!startDate) {
            console.log(`[PROCESS] Skipping activity ${activity.id} - invalid start date`);
            await storage.updateStravaActivity(activity.id, { processed: true, processedAt: new Date() });
            continue;
          }

          const decoded = decodePolyline(activity.summaryPolyline);
          const coordinates: Array<[number, number]> = decoded.map((coord: [number, number]) => [coord[0], coord[1]]);

          if (coordinates.length >= 3) {
            const startedAtStr = startDate.toISOString();
            const completedAtStr = new Date(startDate.getTime() + activity.duration * 1000).toISOString();
            const route = await storage.createRoute({
              userId: activity.userId,
              name: activity.name,
              coordinates,
              distance: activity.distance,
              duration: activity.duration,
              startedAt: startedAtStr,
              completedAt: completedAtStr,
            });

            // Check if this activity is older than existing routes from other users
            let needsChronologicalReprocess = false;
            try {
              needsChronologicalReprocess = await hasNewerOverlappingRoutes(storage, route);
            } catch (e) {
              console.warn(`[STRAVA PROCESS] hasNewerOverlappingRoutes check failed:`, e);
            }

            if (needsChronologicalReprocess) {
              console.log(`[STRAVA PROCESS] Activity ${activity.id} is older than some existing routes — needs chronological reprocess (use admin endpoint)`);
            }

            const simplifiedCoords = simplifyCoordinates(coordinates, 150);
            const lineString = turf.lineString(
              simplifiedCoords.map(coord => [coord[1], coord[0]])
            );
            const buffered = turf.buffer(lineString, 0.05, { units: 'kilometers' });

            if (buffered) {
              const conquestResult = await processTerritoryConquest(
                storage,
                userId,
                route.id,
                buffered.geometry,
                c.env,
                startedAtStr,
                completedAtStr
              );

              // Save ran together info to the route
              if (conquestResult.ranTogetherWith.length > 0) {
                await storage.updateRouteRanTogether(route.id, conquestResult.ranTogetherWith);
              }

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
                ranTogetherWith: conquestResult.ranTogetherWith,
                victimsNotified: conquestResult.victimsNotified,
                }
              });
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
      const db = getDb(c.env);
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
      const db = getDb(c.env);
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

  app.get('/api/polar/status/:userId', async (c) => {
    try {
      const userId = c.req.param('userId');
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const polarAccount = await storage.getPolarAccountByUserId(userId);
      
      if (polarAccount) {
        const stats = await storage.getPolarActivityStats(userId);
        const failedActivities = await storage.getFailedPolarActivities(userId);
        return c.json({
          connected: true,
          polarUserId: polarAccount.polarUserId,
          lastSyncAt: polarAccount.lastSyncAt,
          totalActivities: stats.total,
          pendingActivities: stats.unprocessed,
          failedActivities: failedActivities.length,
          lastActivityStart: stats.lastStartDate,
        });
      } else {
        return c.json({ connected: false });
      }
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // Get failed activities for a user
  app.get('/api/polar/failed/:userId', async (c) => {
    try {
      const userId = c.req.param('userId');
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const failedActivities = await storage.getFailedPolarActivities(userId);
      return c.json(failedActivities);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // Retry processing all failed activities for a user
  app.post('/api/polar/retry-all/:userId', async (c) => {
    try {
      const userId = c.req.param('userId');
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      
      // Get all failed activities
      const failedActivities = await storage.getFailedPolarActivities(userId);
      console.log(`[POLAR] Retrying ${failedActivities.length} failed activities for user ${userId}`);
      
      // Reset all for retry
      let retryCount = 0;
      for (const activity of failedActivities) {
        try {
          await storage.resetPolarActivityForRetry(activity.id);
          retryCount++;
        } catch (err) {
          console.error(`[POLAR] Failed to reset activity ${activity.id}:`, err);
        }
      }
      
      return c.json({ 
        message: `${retryCount}/${failedActivities.length} activities reset for retry`,
        retryCount,
        totalFailed: failedActivities.length,
      });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // DIAGNOSTIC: Get ALL failed activities across ALL users (route_id IS NULL)
  app.get('/api/polar/failed-all', async (c) => {
    try {
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const failedActivities = await storage.getAllFailedPolarActivities();
      
      // Group by userId for reporting
      const byUser: Record<string, number> = {};
      for (const act of failedActivities) {
        byUser[act.userId] = (byUser[act.userId] || 0) + 1;
      }
      
      return c.json({
        totalFailed: failedActivities.length,
        byUser,
        activities: failedActivities.map(a => ({
          id: a.id,
          userId: a.userId,
          name: a.name,
          processed: a.processed,
          routeId: a.routeId,
          territoryId: a.territoryId,
        })),
      });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // GLOBAL: Retry ALL failed activities for ALL users
  app.post('/api/polar/retry-all-global', async (c) => {
    try {
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      
      const failedActivities = await storage.getAllFailedPolarActivities();
      console.log(`[POLAR] Globally retrying ${failedActivities.length} failed activities`);
      
      let retryCount = 0;
      for (const activity of failedActivities) {
        try {
          await storage.resetPolarActivityForRetry(activity.id);
          retryCount++;
        } catch (err) {
          console.error(`[POLAR] Failed to reset activity ${activity.id}:`, err);
        }
      }
      
      return c.json({ 
        message: `${retryCount}/${failedActivities.length} activities reset for retry globally`,
        retryCount,
        totalFailed: failedActivities.length,
      });
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

      const db = getDb(c.env);
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

      // Trigger initial full + incremental sync in background (best effort)
      console.log('[BACKFILL] Triggering initial Polar sync...');
      const baseUrl = c.env.WORKER_URL || 'https://runna-io-api.runna-io-api.workers.dev';
      fetch(`${baseUrl}/api/polar/sync-full/${userId}`, { method: 'POST' })
        .then(res => console.log(`[BACKFILL] Initial full sync triggered: ${res.status}`))
        .catch(err => console.error('[BACKFILL] Initial full sync failed:', err));
      fetch(`${baseUrl}/api/polar/sync/${userId}`, { method: 'POST' })
        .then(res => console.log(`[BACKFILL] Initial incremental sync triggered: ${res.status}`))
        .catch(err => console.error('[BACKFILL] Initial incremental sync failed:', err));

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

      const db = getDb(c.env);
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

  // Manual reset of Polar exercise transactions (support/debug)
  app.post('/api/polar/transactions/reset/:userId', async (c) => {
    try {
      const userId = c.req.param('userId');
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const polarAccount = await storage.getPolarAccountByUserId(userId);

      if (!polarAccount) {
        return c.json({ error: 'Polar account not connected' }, 404);
      }

      const status = await resetPolarTransactions(polarAccount);
      return c.json({ resetStatus: status });
    } catch (error: any) {
      console.error('[RESET] error:', error);
      return c.json({ error: error.message }, 500);
    }
  });

  const resetPolarTransactions = async (polarAccount: { polarUserId: number; accessToken: string; }) => {
    try {
      const res = await fetch(`https://www.polaraccesslink.com/v3/users/${polarAccount.polarUserId}/exercise-transactions`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${polarAccount.accessToken}` },
      });
      console.log('[SYNC] Reset transactions status:', res.status);
      return res.status;
    } catch (err) {
      console.error('[SYNC] Reset transactions failed:', err);
      return null;
    }
  };

  // Non-transactional fallback: GET /v3/exercises returns all exercises from last 30 days
  // regardless of transaction commit state. Used to reimport deleted activities.
  const syncPolarExercisesDirect = async (
    polarAccount: { polarUserId: number; accessToken: string },
    userId: string,
    storage: WorkerStorage
  ) => {
    console.log('[DIRECT SYNC] Using non-transactional GET /v3/exercises endpoint...');
    
    try {
      const listResponse = await fetch(
        'https://www.polaraccesslink.com/v3/exercises?samples=false&zones=false&route=true',
        {
          headers: {
            'Authorization': `Bearer ${polarAccount.accessToken}`,
            'Accept': 'application/json',
          },
        }
      );

      if (listResponse.status === 401) {
        console.error('[DIRECT SYNC] Token expired');
        return { imported: 0, total: 0, message: 'Polar token expired' };
      }

      if (!listResponse.ok) {
        const errorText = await listResponse.text();
        console.error('[DIRECT SYNC] Failed to list exercises:', listResponse.status, errorText);
        return { imported: 0, total: 0, message: `Failed to fetch exercises: ${listResponse.status}` };
      }

      const exercises: any[] = await listResponse.json();
      console.log(`[DIRECT SYNC] Found ${exercises.length} exercises from Polar`);

      let imported = 0;
      let skipped = 0;
      let errors = 0;

      for (const exercise of exercises) {
        try {
          const exerciseId = exercise.id;
          if (!exerciseId) {
            console.warn('[DIRECT SYNC] Exercise without id, skipping');
            skipped++;
            continue;
          }

          console.log(`\n[DIRECT SYNC] 📍 Exercise: ${exerciseId}`);

          // Check if already exists in DB (by polar exercise ID)
          const existing = await storage.getPolarActivityByPolarId(exerciseId.toString());
          if (existing) {
            console.log(`[DIRECT SYNC]    ⏭️  Already imported (by ID)`);
            skipped++;
            continue;
          }

          // Also check by attributes to avoid duplicates from different ID formats
          // (transactional API uses numeric IDs, non-transactional uses hashed IDs)
          const startTimeRaw = exercise.start_time;
          if (startTimeRaw) {
            const dupCheck = await storage.findPolarActivityByAttributes(
              userId,
              Number(exercise.distance) || 0,
              new Date(startTimeRaw).toISOString()
            );
            if (dupCheck) {
              console.log(`[DIRECT SYNC]    ⏭️  Already imported (by attributes match: ${dupCheck.id})`);
              skipped++;
              continue;
            }
          }

          // Extract sport
          const sport =
            exercise.detailed_sport_info ||
            exercise.sport ||
            '';
          const activityType = String(sport).toLowerCase().trim();
          const distance = Number(exercise.distance) || 0;
          const duration = exercise.duration ? parseDuration(exercise.duration) : 0;
          const startTime = exercise.start_time;

          console.log(`[DIRECT SYNC]    Sport: "${sport}" | Distance: ${distance}m | Duration: ${duration}s`);

          const excludeTypes = ['sleep', 'rest', 'pause', 'meditation', 'breathing'];
          const isExcluded = excludeTypes.some(t => activityType.includes(t));

          if (isExcluded) {
            console.log(`[DIRECT SYNC]    ❌ Excluded type (${sport})`);
            skipped++;
            continue;
          }

          if (distance < 100) {
            console.log(`[DIRECT SYNC]    ❌ Distance too short (${distance}m)`);
            skipped++;
            continue;
          }

          if (duration < 60) {
            console.log(`[DIRECT SYNC]    ❌ Duration too short (${duration}s)`);
            skipped++;
            continue;
          }

          // Try to get route data from the exercise itself (included via ?route=true)
          let summaryPolyline: string | null = null;
          if (exercise.route && Array.isArray(exercise.route) && exercise.route.length >= 2) {
            const coordinates: Array<[number, number]> = exercise.route
              .filter((pt: any) => pt.latitude && pt.longitude)
              .map((pt: any) => [pt.latitude, pt.longitude]);
            if (coordinates.length >= 2) {
              summaryPolyline = encodePolyline(coordinates);
              console.log(`[DIRECT SYNC]    ✅ Route encoded from inline data (${coordinates.length} points)`);
            }
          }

          // Fallback: try GPX endpoint if no inline route
          if (!summaryPolyline) {
            try {
              const gpxResponse = await fetch(
                `https://www.polaraccesslink.com/v3/exercises/${exerciseId}/gpx`,
                {
                  headers: {
                    'Authorization': `Bearer ${polarAccount.accessToken}`,
                    'Accept': 'application/gpx+xml',
                  },
                }
              );
              if (gpxResponse.ok) {
                const gpxText = await gpxResponse.text();
                if (gpxText && gpxText.length > 0) {
                  const coordinates = parseGpxToCoordinates(gpxText);
                  if (coordinates.length >= 2) {
                    summaryPolyline = encodePolyline(coordinates);
                    console.log(`[DIRECT SYNC]    ✅ Polyline from GPX (${coordinates.length} points)`);
                  }
                }
              } else {
                console.log(`[DIRECT SYNC]    ℹ️  No GPX (${gpxResponse.status})`);
              }
            } catch (e) {
              console.error(`[DIRECT SYNC]    ❌ GPX error: ${e}`);
            }
          }

          // Save to database
          const startDateISO = startTime ? new Date(startTime).toISOString() : new Date().toISOString();
          await storage.createPolarActivity({
            polarExerciseId: exerciseId.toString(),
            userId,
            routeId: null,
            territoryId: null,
            name: `${sport} (${(distance / 1000).toFixed(2)}km)`,
            activityType: sport,
            distance: distance,
            duration: duration,
            startDate: startDateISO,
            summaryPolyline,
            processed: false,
            processedAt: null,
          });

          console.log(`[DIRECT SYNC]    ✅ IMPORTED!`);
          imported++;
        } catch (e) {
          console.error(`[DIRECT SYNC]    ❌ Error: ${e}`);
          errors++;
        }
      }

      console.log(`\n[DIRECT SYNC] 📊 RESULT: ${imported} imported, ${skipped} skipped, ${errors} errors out of ${exercises.length} total`);
      return {
        imported,
        total: exercises.length,
        skipped,
        errors,
        message: `${imported} importadas de ${exercises.length} (direct sync)`,
      };
    } catch (error: any) {
      console.error('[DIRECT SYNC] Error:', error);
      return { imported: 0, total: 0, message: `Direct sync error: ${error.message}` };
    }
  };

  app.post('/api/polar/sync/:userId', async (c) => {
    const userId = c.req.param('userId');
    const db = getDb(c.env);
    const storage = new WorkerStorage(db);
    const polarAccount = await storage.getPolarAccountByUserId(userId);

    try {
      if (!polarAccount) {
        console.error('[SYNC] No Polar account found for user:', userId);
        return c.json({ error: 'Polar account not connected' }, 404);
      }

      console.log(`\n🔄 [SYNC] Starting Polar sync for user: ${userId}`);
      console.log('[SYNC] Using non-transactional GET /v3/exercises (recommended by Polar)');

      // Use GET /v3/exercises directly - returns exercises from last 30 days
      // No transaction needed, allows reimporting deleted exercises
      const result = await syncPolarExercisesDirect(polarAccount, userId, storage);
      
      await storage.updatePolarAccount(userId, { lastSyncAt: new Date() });
      return c.json(result);
    } catch (error: any) {
      console.error('Polar sync error:', error);
      return c.json({ error: error.message }, 500);
    }
  });

  app.get('/api/polar/activities/:userId', async (c) => {
    try {
      const userId = c.req.param('userId');
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const activities = await storage.getPolarActivitiesByUserId(userId);
      return c.json(activities);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // Delete a Polar activity and revert its territory contribution
  app.delete('/api/polar/activities/:userId/:activityId', async (c) => {
    try {
      const userId = c.req.param('userId');
      const activityId = c.req.param('activityId');
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);

      const activity = await storage.getPolarActivityById(activityId);
      if (!activity) {
        return c.json({ error: 'Actividad no encontrada' }, 404);
      }
      if (activity.userId !== userId) {
        return c.json({ error: 'No autorizado' }, 403);
      }

      // Find the route to delete - use routeId if available, otherwise match by attributes
      let routeId = activity.routeId;
      if (!routeId) {
        console.log(`[DELETE] routeId is null for activity ${activityId}, searching by attributes...`);
        // Buscar por nombre y distancia (por si no ha sido renombrada)
        let matchedRoute = await storage.findRouteByAttributes(userId, activity.name, activity.distance);
        // Si no se encuentra, buscar por fecha y distancia (por si ha sido renombrada)
        if (!matchedRoute && activity.startDate) {
          matchedRoute = await storage.findRouteByDateAndDistance(userId, activity.startDate, activity.distance);
        }
        if (matchedRoute) {
          routeId = matchedRoute.id;
          console.log(`[DELETE] Found matching route by attributes or date: ${routeId}`);
        } else {
          console.log(`[DELETE] No matching route found for activity ${activityId}`);
        }
      }

      // If we have a route, perform consistent cleanup similar to the /api/routes/:routeId handler
      if (routeId) {
        try {
          // Detach territories from the route so they are not orphan-deleted
          await storage.detachTerritoriesFromRoute(routeId);

          // Remove conquest metrics associated with the route
          await storage.deleteConquestMetricsByRouteId(routeId);

          // Remove any linked Polar/Strava activity records so they can be reimported
          await storage.deletePolarActivityByRouteId(routeId);
          await storage.deleteStravaActivityByRouteId(routeId);

          // Finally delete the route itself
          await storage.deleteRouteById(routeId);
          console.log(`[DELETE] Route ${routeId} and associated records cleaned up`);
        } catch (e) {
          console.error('Error cleaning up route-related data:', e);
        }

        // The polar activity row(s) linked to the route were removed by deletePolarActivityByRouteId.
        // No need to call deletePolarActivityById(activityId) in this branch.
      } else {
        // No route associated: just delete the polar activity record
        await storage.deletePolarActivityById(activityId);
        console.log(`[DELETE] Polar activity ${activityId} deleted (no route attached)`);
      }

      // Rebuild friend group territories chronologically so ownership order is correct
      try {
        await reprocessFriendGroupTerritoriesChronologically(storage, userId);
      } catch (e) {
        console.error('Error reprocessing territories after delete:', e);
        // Fallback: at least rebuild this user's territories
        try {
          await reprocessUserTerritories(storage, userId);
        } catch (e2) {
          console.error('Fallback reprocess also failed:', e2);
        }
      }

      return c.json({ success: true });
    } catch (error: any) {
      console.error('Error deleting Polar activity:', error);
      return c.json({ error: error.message }, 500);
    }
  });

  // Full sync - get all exercises from Polar history (last 365 days)
  app.post('/api/polar/sync-full/:userId', async (c) => {
    const userId = c.req.param('userId');
    const db = getDb(c.env);
    const storage = new WorkerStorage(db);
    const polarAccount = await storage.getPolarAccountByUserId(userId);

    try {
      if (!polarAccount) {
        return c.json({ error: 'Polar account not connected' }, 404);
      }

      console.log(`\n🔄 [FULL SYNC] Starting full sync for user: ${userId}`);
      console.log('[FULL SYNC] Using non-transactional GET /v3/exercises (recommended by Polar)');

      // Use GET /v3/exercises directly - returns exercises from last 30 days
      const result = await syncPolarExercisesDirect(polarAccount, userId, storage);
      
      await storage.updatePolarAccount(userId, { lastSyncAt: new Date() });
      return c.json(result);
    } catch (error: any) {
      console.error('Polar full sync error:', error);
      return c.json({ error: error.message }, 500);
    }
  });

  app.post('/api/polar/process/:userId', async (c) => {
    const startTime = Date.now();
    const MAX_PROCESSING_TIME = 25000; // 25 seconds limit to avoid timeout
    
    try {
      const userId = c.req.param('userId');
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const unprocessed = await storage.getUnprocessedPolarActivities(userId);
      
      console.log(`[PROCESS] Starting - ${unprocessed.length} unprocessed Polar activities for user ${userId}`);
      
      if (unprocessed.length === 0) {
        return c.json({ processed: 0, results: [], message: 'No activities to process' });
      }

      const results: any[] = [];
      const BATCH_SIZE = 1; // Process 1 at a time to avoid Worker CPU limits
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
          const startDate = coerceDate(activity.startDate);
          if (!startDate) {
            console.log(`[PROCESS] Skipping activity ${activity.id} - invalid start date`);
            await storage.updatePolarActivity(activity.id, { processed: true, processedAt: new Date() });
            continue;
          }

          const decoded = decodePolyline(activity.summaryPolyline);
          const coordinates: Array<[number, number]> = decoded.map((coord: [number, number]) => [coord[0], coord[1]]);

          if (coordinates.length < 3) {
            console.log(`[PROCESS] Skipping activity ${activity.id} - insufficient coordinates (${coordinates.length})`);
            await storage.updatePolarActivity(activity.id, { processed: true, processedAt: new Date() });
            continue;
          }

          console.log(`[PROCESS] Creating route for activity ${activity.id}`);
          const startedAtStr = startDate.toISOString();
          const completedAtStr = new Date(startDate.getTime() + activity.duration * 1000).toISOString();

          // Check if the activity already has a route (from a previous partial processing)
          let route: Route | null = null;
          if (activity.routeId) {
            route = await storage.getRouteById(activity.routeId);
            if (route) {
              console.log(`[PROCESS] Reusing existing route ${route.id} for activity ${activity.id}`);
            }
          }
          if (!route) {
            route = await storage.createRoute({
              userId: activity.userId,
              name: activity.name,
              coordinates,
              distance: activity.distance,
              duration: activity.duration,
              startedAt: startedAtStr,
              completedAt: completedAtStr,
            });
            console.log(`[PROCESS] Route created: ${route.id}`);
          }

          // Save routeId immediately so it's linked even if territory processing fails
          await storage.updatePolarActivity(activity.id, { routeId: route.id });

          // Check if this activity is older than existing routes from other users.
          // If so, a full chronological reprocess is needed (handled separately via admin endpoint
          // to avoid hitting Worker CPU limits during inline processing).
          let needsChronologicalReprocess = false;
          try {
            needsChronologicalReprocess = await hasNewerOverlappingRoutes(storage, route);
          } catch (e) {
            console.warn(`[PROCESS] hasNewerOverlappingRoutes check failed, proceeding with normal processing:`, e);
          }

          if (needsChronologicalReprocess) {
            console.log(`[PROCESS] Activity ${activity.id} is older than some existing routes — needs chronological reprocess (use admin endpoint)`);
          }

          console.log(`[PROCESS] Calculating territory buffer (${coordinates.length} coords)...`);
          // Simplify coordinates to avoid Worker CPU limits
          const simplifiedCoords = simplifyCoordinates(coordinates, 150);
          console.log(`[PROCESS] Simplified to ${simplifiedCoords.length} coords`);
          
          const lineString = turf.lineString(
            simplifiedCoords.map(coord => [coord[1], coord[0]])
          );
          const buffered = turf.buffer(lineString, 0.05, { units: 'kilometers' });
          console.log(`[PROCESS] Buffer calculated`);

          if (buffered) {
            console.log(`[PROCESS] Processing territory conquest...`);
            
            const conquestResult = await processTerritoryConquest(
              storage,
              userId,
              route.id,
              buffered.geometry,
              c.env,
              startedAtStr,
              completedAtStr
            );

            // Save ran together info to the route
            if (conquestResult.ranTogetherWith.length > 0) {
              await storage.updateRouteRanTogether(route.id, conquestResult.ranTogetherWith);
            }

            console.log(`[PROCESS] Territory updated: ${conquestResult.territory.id}, area: ${conquestResult.territory.area}`);

            results.push({
              activityId: activity.id,
              routeId: route.id,
              territoryId: conquestResult.territory.id,
              area: conquestResult.territory.area,
              needsChronologicalReprocess,
              metrics: {
                totalArea: conquestResult.totalArea,
                newAreaConquered: conquestResult.newAreaConquered,
                areaStolen: conquestResult.areaStolen,
                ranTogetherWith: conquestResult.ranTogetherWith,
                victimsNotified: conquestResult.victimsNotified,
                victims: conquestResult.victims,
              }
            });
          }

          await storage.updatePolarActivity(activity.id, { 
            routeId: route.id, 
            processed: true, 
            processedAt: new Date() 
          });
          console.log(`[PROCESS] ✅ Activity ${activity.id} processed successfully`);
        } catch (e) {
          console.error(`[PROCESS] ❌ Error processing activity ${activity.id}:`, e);
          await storage.updatePolarActivity(activity.id, { processed: true, processedAt: new Date() });
        }
      }

      const remaining = unprocessed.length - toBatch.length;
      const processingTime = Date.now() - startTime;
      console.log(`[PROCESS] Completed in ${processingTime}ms - ${results.length} processed, ${remaining} remaining`);

      return c.json({ 
        processed: results.length, 
        results,
        remaining,
        processingTime,
        message: remaining > 0 ? `${results.length} procesadas, ${remaining} pendientes. Ejecuta de nuevo para continuar.` : `${results.length} procesadas correctamente`
      });
    } catch (error: any) {
      const processingTime = Date.now() - startTime;
      console.error('[PROCESS] ❌ Critical error:', error);
      // Return partial success if we processed anything
      return c.json({ 
        error: error.message,
        processed: 0,
        processingTime,
        message: 'Error al procesar actividades. Por favor intenta de nuevo.'
      }, 500);
    }
  });

  app.get('/api/polar/debug/:userId', async (c) => {
  try {
    const userId = c.req.param('userId');
    console.log('🔍 [DEBUG] Starting Polar data check for user:', userId);

    const db = getDb(c.env);
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

  // ==========================================
  // EPHEMERAL PHOTOS (one-time taunt photos)
  // ==========================================

  // Send a taunt photo to a victim
  app.post('/api/ephemeral-photos', async (c) => {
    try {
      const { senderId, recipientId, photoData, message, areaStolen } = await c.req.json();

      if (!senderId || !recipientId || !photoData) {
        return c.json({ error: 'senderId, recipientId, and photoData are required' }, 400);
      }

      // Validate photo size (max ~500KB base64)
      if (photoData.length > 700000) {
        return c.json({ error: 'Photo too large. Max 500KB.' }, 400);
      }

      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24h

      const photo = await storage.createEphemeralPhoto({
        senderId,
        recipientId,
        photoData,
        message: message || null,
        areaStolen: areaStolen || null,
        expiresAt,
      });

      // Send push notification to the recipient
      try {
        const sender = await storage.getUser(senderId);
        if (sender) {
          const subs = await storage.getPushSubscriptionsByUserId(recipientId);
          if (subs.length > 0) {
            const { sendPushToUser } = await import('./pushHelper');
            const pushSubs = subs.map(s => ({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }));
            const areaKm2 = areaStolen ? (areaStolen / 1000000).toFixed(2) : null;
            const bodyText = areaKm2 
              ? `${sender.name} te ha robado ${areaKm2} km² y te ha enviado una foto` 
              : `${sender.name} te ha enviado una foto de conquista`;
            await sendPushToUser(
              pushSubs,
              {
                title: '📸 ¡Foto de conquista!',
                body: bodyText,
                tag: 'ephemeral-photo',
                data: { url: '/', type: 'ephemeral-photo', photoId: photo.id },
              },
              c.env.VAPID_PUBLIC_KEY || '',
              c.env.VAPID_PRIVATE_KEY || '',
              c.env.VAPID_SUBJECT || 'mailto:notifications@runna.io'
            );
          }
        }
      } catch (_) {}

      return c.json({ success: true, photoId: photo.id });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // Get pending photos for a user
  app.get('/api/ephemeral-photos/pending/:userId', async (c) => {
    try {
      const userId = c.req.param('userId');
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);

      // Cleanup expired photos first
      await storage.cleanupExpiredPhotos();

      const photos = await storage.getPendingPhotosForUser(userId);

      // Return without photoData to save bandwidth on listing
      const listing = photos.map(p => ({
        id: p.id,
        senderId: p.senderId,
        senderName: p.senderName,
        senderUsername: p.senderUsername,
        senderAvatar: p.senderAvatar,
        message: p.message,
        areaStolen: p.areaStolen,
        createdAt: p.createdAt,
      }));

      return c.json(listing);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // View a photo (returns data and deletes it)
  app.get('/api/ephemeral-photos/:photoId/view', async (c) => {
    try {
      const photoId = c.req.param('photoId');
      const userId = c.req.query('userId');

      if (!userId) {
        return c.json({ error: 'userId query param required' }, 400);
      }

      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const photo = await storage.viewAndDeleteEphemeralPhoto(photoId, userId);

      if (!photo) {
        return c.json({ error: 'Photo not found or already viewed' }, 404);
      }

      return c.json(photo);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
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
