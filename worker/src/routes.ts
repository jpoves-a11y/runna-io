import { Hono } from 'hono';
import { createDb } from './db';
import { WorkerStorage } from './storage';
import { insertUserSchema, insertRouteSchema, insertFriendshipSchema, type InsertRoute, type Route } from '../../shared/schema';
import * as turf from '@turf/turf';
import { EmailService } from './email';
import { USER_COLORS } from '../../shared/colors';
import type { Env } from './index';
import {
  simplifyCoordinates,
  routeToEnclosedPolygon,
  activitiesOverlapInTime,
  geometriesOverlapByPercentage,
  isCompetitionActive,
  isCompetitionUpcoming,
  encodePolyline,
  decodePolyline,
  formatAreaNotification,
  type ConquestVictimInfo,
} from './territory';

// Helper function to get database instance
function getDb(env: Env) {
  return createDb(env.DATABASE_URL, env.TURSO_AUTH_TOKEN);
}

/**
 * Get all colors used by a user's friends (and the user themselves).
 * Returns the set of colors that would conflict for a given user joining a friend group.
 */
async function getFriendGroupColors(storage: WorkerStorage, userId: string): Promise<Set<string>> {
  const friendIds = await storage.getFriendIds(userId);
  const colors = new Set<string>();
  for (const fid of friendIds) {
    const friend = await storage.getUser(fid);
    if (friend) colors.add(friend.color.toUpperCase());
  }
  return colors;
}

/**
 * Find a color from USER_COLORS that doesn't conflict with any colors in the provided sets.
 * Returns null if no color is available (very unlikely with 12 colors).
 */
function findAvailableColor(usedColors: Set<string>): string | null {
  for (const color of USER_COLORS) {
    if (!usedColors.has(color.toUpperCase())) {
      return color;
    }
  }
  return null;
}

/**
 * When two users are about to become friends, check if they have the same color.
 * If so, auto-reassign the second user (accepter) to an available color.
 * Also checks against all friends of both users to avoid any group conflicts.
 * Returns the new color assigned, or null if no change was needed.
 */
async function resolveColorConflictOnFriendship(
  storage: WorkerStorage,
  user1Id: string,
  user2Id: string
): Promise<{ changed: boolean; newColor?: string; userId?: string }> {
  const user1 = await storage.getUser(user1Id);
  const user2 = await storage.getUser(user2Id);
  if (!user1 || !user2) return { changed: false };

  // Collect all colors in the combined friend group
  const user1FriendColors = await getFriendGroupColors(storage, user1Id);
  const user2FriendColors = await getFriendGroupColors(storage, user2Id);

  // Add the users' own colors
  user1FriendColors.add(user1.color.toUpperCase());
  user2FriendColors.add(user2.color.toUpperCase());

  // Check if user2's color conflicts with user1 or any of user1's friends
  if (user1FriendColors.has(user2.color.toUpperCase())) {
    // user2 needs a new color - find one not used by either friend group
    const allUsed = new Set([...user1FriendColors, ...user2FriendColors]);
    const newColor = findAvailableColor(allUsed);
    if (newColor) {
      await storage.updateUser(user2Id, { color: newColor });
      console.log(`[COLOR CONFLICT] Auto-changed ${user2.name}'s color from ${user2.color} to ${newColor}`);
      return { changed: true, newColor, userId: user2Id };
    }
  }

  // Also check if user1's color conflicts with user2's friends
  if (user2FriendColors.has(user1.color.toUpperCase())) {
    const allUsed = new Set([...user1FriendColors, ...user2FriendColors]);
    const newColor = findAvailableColor(allUsed);
    if (newColor) {
      await storage.updateUser(user1Id, { color: newColor });
      console.log(`[COLOR CONFLICT] Auto-changed ${user1.name}'s color from ${user1.color} to ${newColor}`);
      return { changed: true, newColor, userId: user1Id };
    }
  }

  return { changed: false };
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

// Helper: generate a SINGLE merged feed event per activity
// All conquest details (victims, ran-together, records, treasures) are stored in metadata JSON
// If existingFeedEventId is provided, UPDATE the existing event instead of creating a new one
export async function generateFeedEvents(
  storage: WorkerStorage,
  userId: string,
  routeId: string,
  distance: number,
  duration: number,
  conquestResult: { newAreaConquered: number; victims: ConquestVictimInfo[]; ranTogetherWith: string[]; treasuresCollected?: any[]; fortressesDestroyed?: number; fortificationLayers?: number; fortificationArea?: number },
  skipRecordsCheck: boolean = false,
  existingFeedEventId?: string
): Promise<void> {
  try {
    // Build metadata with all supplementary info
    const metadata: any = {};

    // Victims
    if (conquestResult.victims && conquestResult.victims.length > 0) {
      metadata.victims = conquestResult.victims.map(v => ({
        userId: v.userId,
        userName: v.userName,
        userColor: v.userColor,
        stolenArea: v.stolenArea,
      }));
    }

    // Ran together
    if (conquestResult.ranTogetherWith && conquestResult.ranTogetherWith.length > 0) {
      const ranNames = await Promise.all(
        conquestResult.ranTogetherWith.map(async (uid: string) => {
          const u = await storage.getUser(uid);
          return { id: uid, name: u?.name || uid };
        })
      );
      metadata.ranTogetherWith = ranNames;
    }

    // Treasures collected
    if (conquestResult.treasuresCollected && conquestResult.treasuresCollected.length > 0) {
      metadata.treasures = conquestResult.treasuresCollected.map((t: any) => ({
        treasureId: t.treasureId || t.id,
        treasureName: t.treasureName || t.name,
        powerType: t.powerType,
        rarity: t.rarity,
      }));
    }

    // Fortresses destroyed
    if (conquestResult.fortressesDestroyed && conquestResult.fortressesDestroyed > 0) {
      metadata.fortressesDestroyed = conquestResult.fortressesDestroyed;
    }

    // Fortification layers added (reinforced own territory)
    if (conquestResult.fortificationLayers && conquestResult.fortificationLayers > 0) {
      metadata.fortificationLayers = conquestResult.fortificationLayers;
      metadata.fortificationArea = conquestResult.fortificationArea || 0;
    }

    // Personal records check (skipped during Polar process to save subrequests)
    const records: any[] = [];
    if (!skipRecordsCheck) {
    try {
      if (distance && distance >= 500) {
        const userRoutes = await storage.getRoutesByUserIdChronological(userId);
        const previousRoutes = userRoutes.filter(r => r.id !== routeId);

        // Longest run (only if >1 km and the user has at least 1 previous route)
        if (previousRoutes.length > 0 && distance > 1000) {
          const maxPrevDistance = Math.max(...previousRoutes.map(r => r.distance || 0));
          if (distance > maxPrevDistance) {
            records.push({ type: 'longest_run', value: distance });
          }
        }

        // Fastest pace (min/km) — only for runs >= 1 km
        if (distance >= 1000 && duration && duration > 0) {
          const pace = (duration / 60) / (distance / 1000); // min/km
          const prevPaces = previousRoutes
            .filter(r => r.distance && r.distance >= 1000 && r.duration && r.duration > 0)
            .map(r => (r.duration / 60) / (r.distance / 1000));
          if (prevPaces.length > 0) {
            const bestPrevPace = Math.min(...prevPaces);
            if (pace < bestPrevPace) {
              records.push({ type: 'fastest_pace', value: pace });
            }
          }
        }

        // Biggest conquest
        if (conquestResult.newAreaConquered > 0 && previousRoutes.length > 0) {
          try {
            const prevConquests = await storage.getMaxConquestArea(userId);
            if (conquestResult.newAreaConquered > prevConquests) {
              records.push({ type: 'biggest_conquest', value: conquestResult.newAreaConquered });
            }
          } catch (_) {}
        }
      }
    } catch (prErr) {
      console.warn('[FEED] Personal record check failed (non-critical):', prErr);
    }
    } // end skipRecordsCheck

    if (records.length > 0) {
      metadata.records = records;
    }

    // If we have an existing feed event (created early), UPDATE it with conquest data
    if (existingFeedEventId) {
      console.log(`[FEED] Updating feed event ${existingFeedEventId}: newArea=${conquestResult.newAreaConquered}, metadataKeys=${Object.keys(metadata).join(',')}`);
      await storage.updateFeedEvent(existingFeedEventId, {
        distance,
        duration,
        newArea: conquestResult.newAreaConquered,
        metadata: JSON.stringify(metadata),
      });
      console.log(`[FEED] ✅ Updated existing feed event ${existingFeedEventId} with conquest data`);
    } else {
      // Fallback: check if there's already a feed event for this route (avoid duplicates)
      const existing = await storage.getFeedEventByRouteId(routeId);
      if (existing) {
        await storage.updateFeedEvent(existing.id, {
          distance,
          duration,
          newArea: conquestResult.newAreaConquered,
          metadata: JSON.stringify(metadata),
        });
        console.log(`[FEED] ✅ Updated feed event ${existing.id} (found by routeId) with conquest data`);
      } else {
        // Create a new one (no early event existed)
        await storage.createFeedEvent({
          userId,
          eventType: 'activity',
          routeId,
          distance,
          duration,
          newArea: conquestResult.newAreaConquered,
          metadata: JSON.stringify(metadata),
        });
        console.log(`[FEED] ✅ Created new feed event for route ${routeId}`);
      }
    }

  } catch (e) {
    console.error('[FEED] Error creating/updating feed event:', e);
  }
}

// Standalone function to auto-collect treasures along route coordinates.
// Can be called independently of processTerritoryConquest (e.g., when polygon is null).
export async function autoCollectTreasuresAlongRoute(
  storage: WorkerStorage,
  userId: string,
  competitionId: string,
  routeCoordinates: [number, number][]
): Promise<any[]> {
  const treasuresCollected: any[] = [];
  if (!routeCoordinates || routeCoordinates.length === 0) return treasuresCollected;

  try {
    const activeTreasures = await storage.getActiveTreasures(competitionId);
    if (activeTreasures.length === 0) return treasuresCollected;

    // Sample every 5th coordinate to reduce computation, but also always include first and last
    const sampledCoords = routeCoordinates.filter((_, i) => i % 5 === 0 || i === routeCoordinates.length - 1);

    for (const treasure of activeTreasures) {
      for (const coord of sampledCoords) {
        const dist = turf.distance(
          turf.point([coord[1], coord[0]]), // [lng, lat]
          turf.point([treasure.lng, treasure.lat]),
          { units: 'meters' }
        );
        if (dist <= 250) {
          const result = await storage.collectTreasure(treasure.id, userId);
          if (result && result.collectedBy === userId) {
            // Create power for user
            await storage.createUserPower({
              id: crypto.randomUUID(),
              userId,
              competitionId,
              powerType: treasure.powerType,
              treasureId: treasure.id,
              status: 'available',
            });
            treasuresCollected.push({
              treasureId: treasure.id,
              treasureName: treasure.name,
              powerType: treasure.powerType,
              rarity: treasure.rarity,
              zone: (treasure as any).zone || null,
            });
            console.log(`[TREASURE] Auto-collected: ${treasure.name} (${treasure.powerType}) by ${userId}`);
            
            // Create feed event for treasure collection
            try {
              await storage.createFeedEvent({
                userId,
                eventType: 'treasure_found',
                routeId: null,
                distance: 0,
                duration: 0,
                newArea: 0,
                metadata: JSON.stringify({
                  treasureId: treasure.id,
                  treasureName: treasure.name,
                  powerType: treasure.powerType,
                  rarity: treasure.rarity,
                }),
              });
            } catch (_) {}
            
            // Update competition stats
            try {
              await storage.incrementCompetitionStats(competitionId, userId, { treasures: 1 });
            } catch (_) {}
          }
          break; // Move to next treasure
        }
      }
    }
  } catch (err) {
    console.error('[TREASURE] Error in standalone auto-collect:', err);
  }

  return treasuresCollected;
}

export async function processTerritoryConquest(
  storage: WorkerStorage,
  userId: string,
  routeId: string,
  bufferedGeometry: any,
  env?: any,
  activityStartedAt?: string,
  activityCompletedAt?: string,
  routeCoordinates?: [number, number][]
): Promise<{
  territory: any;
  totalArea: number;
  newAreaConquered: number;
  areaStolen: number;
  victimsNotified: string[];
  victims: ConquestVictimInfo[];
  ranTogetherWith: string[]; // Users who ran together (no territory stolen)
  treasuresCollected: any[];
  powersUsed: string[];
  fortressesDestroyed: number;
  fortificationLayers: number;
  fortificationArea: number;
}> {
  // Check if competition is active for ALL-VS-ALL mode
  const competition = await storage.getActiveCompetition();
  const isCompMode = !!(competition && isCompetitionActive(competition));
  
  const friendIds = await storage.getFriendIds(userId);
  
  let allTerritories: any[];
  if (isCompMode) {
    // Competition: ALL-VS-ALL - load ALL users' territories
    console.log('[COMPETITION] All-vs-all mode active — loading ALL territories');
    allTerritories = await storage.getAllTerritories();
  } else {
    // Normal mode: only friends
    const relevantUserIds = [userId, ...friendIds];
    allTerritories = await storage.getTerritoriesForUsers(relevantUserIds);
  }
  
  const userTerritories = allTerritories.filter(t => t.userId === userId);
  const enemyTerritories = isCompMode
    ? allTerritories.filter(t => t.userId !== userId)
    : allTerritories.filter(t => t.userId !== userId && friendIds.includes(t.userId));
  
  // --- Competition power checks for attacker ---
  let hasDoubleAreaPower = false;
  let hasStealBoostPower = false;
  let hasMagnetPower = false;
  let hasBulldozerPower = false;
  let hasBatteringRamPower = false;
  let hasWallPower = false;
  let doubleAreaPowerId: string | null = null;
  let stealBoostPowerId: string | null = null;
  let magnetPowerId: string | null = null;
  let bulldozerPowerId: string | null = null;
  let batteringRamPowerId: string | null = null;
  let fortressesDestroyed = 0;
  
  if (isCompMode && competition) {
    try {
      const activePowers = await storage.getActivePowersForUser(userId, competition.id);
      for (const power of activePowers) {
        if (power.powerType === 'double_area') { hasDoubleAreaPower = true; doubleAreaPowerId = power.id; }
        if (power.powerType === 'steal_boost') { hasStealBoostPower = true; stealBoostPowerId = power.id; }
        if (power.powerType === 'magnet') { hasMagnetPower = true; magnetPowerId = power.id; }
        if (power.powerType === 'bulldozer') { hasBulldozerPower = true; bulldozerPowerId = power.id; }
        if (power.powerType === 'battering_ram') { hasBatteringRamPower = true; batteringRamPowerId = power.id; }
        if (power.powerType === 'wall') { hasWallPower = true; }
      }
      if (hasDoubleAreaPower || hasStealBoostPower || hasMagnetPower || hasBulldozerPower || hasBatteringRamPower || hasWallPower) {
        console.log(`[COMPETITION] Active powers for ${userId}: double_area=${hasDoubleAreaPower} steal_boost=${hasStealBoostPower} magnet=${hasMagnetPower} bulldozer=${hasBulldozerPower} battering_ram=${hasBatteringRamPower} wall=${hasWallPower}`);
      }
    } catch (err) {
      console.error('[COMPETITION] Error checking active powers:', err);
    }
  }
  
  // Apply offensive geometry expansion powers
  let attackGeometry = bufferedGeometry;
  if (isCompMode && (hasDoubleAreaPower || hasMagnetPower)) {
    try {
      let currentGeom = attackGeometry;
      if (hasDoubleAreaPower) {
        // Double area: expand radius by sqrt(2) ≈ 1.414x → ~2x area
        const area = turf.area(turf.feature(currentGeom));
        const approxRadius = Math.sqrt(area / Math.PI);
        const bufferDist = approxRadius * (Math.SQRT2 - 1);
        const expanded = turf.buffer(turf.feature(currentGeom), bufferDist / 1000, { units: 'kilometers' });
        if (expanded) {
          currentGeom = expanded.geometry;
          console.log(`[COMPETITION] DOUBLE AREA applied: ${(area/1e6).toFixed(4)} → ${(turf.area(expanded)/1e6).toFixed(4)} km²`);
        }
      }
      if (hasMagnetPower) {
        // Magnet: expand radius by sqrt(1.25) ≈ 1.118x → +25% area
        const area = turf.area(turf.feature(currentGeom));
        const approxRadius = Math.sqrt(area / Math.PI);
        const bufferDist = approxRadius * (Math.sqrt(1.25) - 1);
        const expanded = turf.buffer(turf.feature(currentGeom), bufferDist / 1000, { units: 'kilometers' });
        if (expanded) {
          currentGeom = expanded.geometry;
          console.log(`[COMPETITION] MAGNET applied: +25% area`);
        }
      }
      attackGeometry = currentGeom;
    } catch (err) {
      console.error('[COMPETITION] Error applying power geometry expansion:', err);
    }
  }

  let totalStolenArea = 0;
  const victimsNotified: string[] = [];
  const ranTogetherWith: string[] = []; // Track users who ran together

  const victimMap = new Map<string, ConquestVictimInfo>();
  const defenderCache = new Map<string, any>();

  // Batch-load routes from enemy users that started within 15 min of this activity
  // to check ran-together against the SPECIFIC route geometry, not accumulated territory
  const enemyUserIds = [...new Set(enemyTerritories.map(t => t.userId))];
  let ranTogetherUserIds = new Set<string>();

  if (activityStartedAt && activityCompletedAt && enemyUserIds.length > 0) {
    try {
      const nearbyRoutes = await storage.getRoutesInTimeWindow(enemyUserIds, activityStartedAt);
      for (const enemyRoute of nearbyRoutes) {
        if (!enemyRoute.startedAt || !enemyRoute.completedAt) continue;
        const timeOverlap = activitiesOverlapInTime(
          activityStartedAt, activityCompletedAt,
          enemyRoute.startedAt, enemyRoute.completedAt
        );
        if (!timeOverlap) continue;

        // Compute the specific enemy route's enclosed polygon
        const enemyCoords: [number, number][] = Array.isArray(enemyRoute.coordinates)
          ? enemyRoute.coordinates as [number, number][]
          : typeof enemyRoute.coordinates === 'string'
            ? JSON.parse(enemyRoute.coordinates)
            : [];
        if (enemyCoords.length < 10) continue;
        const enemyPoly = routeToEnclosedPolygon(enemyCoords, 150);
        if (!enemyPoly) continue;

        // Check area overlap against the SPECIFIC route's polygon
        const areaOverlap = geometriesOverlapByPercentage(
          bufferedGeometry,
          enemyPoly.geometry,
          0.90
        );
        if (areaOverlap) {
          console.log(`[TERRITORY] Ran together with user ${enemyRoute.userId} (route ${enemyRoute.id}) - will skip stealing from this user`);
          ranTogetherUserIds.add(enemyRoute.userId);
          if (!ranTogetherWith.includes(enemyRoute.userId)) {
            ranTogetherWith.push(enemyRoute.userId);
          }
        }
      }
    } catch (err) {
      console.error('[TERRITORY] Error checking ran-together routes:', err);
    }
  }

  // Late-import guard: only applies when the route being processed is genuinely old
  // (completed >2 hours ago). In that case, skip stealing from territories that were
  // created/merged AFTER this route's completion time (they didn't exist when the route ran).
  const LATE_IMPORT_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours
  const isLateImport = activityCompletedAt
    ? (Date.now() - new Date(activityCompletedAt).getTime()) > LATE_IMPORT_THRESHOLD_MS
    : false;
  if (isLateImport) {
    console.log(`[TERRITORY] Late import detected (completed ${activityCompletedAt}) — will skip territories created after route time`);
  }

  // Step 1: Handle enemy territory conquest
  console.log(`[TERRITORY] Processing ${enemyTerritories.length} enemy territories...`);
  
  // PRE-LOAD: Batch-fetch all active defensive powers for all enemy users in ONE query
  // This saves 2-5 subrequests PER enemy territory (shield, invisibility, time_bomb, sentinel checks)
  const enemyDefensivePowers = new Map<string, Set<string>>(); // userId -> Set<powerType>
  if (isCompMode && competition && enemyUserIds.length > 0) {
    try {
      const allDefensivePowers = await storage.getActiveDefensivePowersForUsers(enemyUserIds, competition.id);
      for (const power of allDefensivePowers) {
        if (!enemyDefensivePowers.has(power.userId)) {
          enemyDefensivePowers.set(power.userId, new Set());
        }
        enemyDefensivePowers.get(power.userId)!.add(power.powerType);
      }
      if (enemyDefensivePowers.size > 0) {
        console.log(`[COMPETITION] Pre-loaded defensive powers for ${enemyDefensivePowers.size} enemy users`);
      }
    } catch (err) {
      console.error('[COMPETITION] Error pre-loading defensive powers:', err);
    }
  }

  // Collect deferred notifications/emails to send after the main loop
  const deferredNotifications: Array<{
    victimId: string;
    attackerName: string;
    attackerUsername: string;
    victimEmail: string;
    stolenArea: number;
  }> = [];

  // Track which victims need area recalculation
  const victimsToUpdate = new Set<string>();
  let timeBombPenalty = 0; // Area penalty from triggered time bombs

  // === SUBREQUEST OPTIMIZATION: Accumulate operations for batch execution ===
  const pendingConquestMetrics: Array<{ attackerId: string; defenderId: string; areaStolen: number; routeId?: string }> = [];
  const pendingSentinelAlerts: Array<{ userId: string; eventType: string; metadata: string }> = [];
  const pendingFortificationDeletes: string[] = [];
  // Cap enemy territories per invocation to avoid "Too many subrequests" (each territory = 1-3 DB calls)
  const MAX_ENEMY_TERRITORIES = 25;
  const territoriesToProcess = enemyTerritories.slice(0, MAX_ENEMY_TERRITORIES);
  if (enemyTerritories.length > MAX_ENEMY_TERRITORIES) {
    console.warn(`[TERRITORY] Capping enemy territories: processing ${MAX_ENEMY_TERRITORIES} of ${enemyTerritories.length} (rest will be handled on next import)`);
  }
  // Pre-compute attack bbox ONCE (for all fortification checks)
  let attackBbox: number[] | null = null;
  try { attackBbox = turf.bbox(attackGeometry); } catch (_) {}

  // PRE-LOAD: Batch-fetch ALL fortifications for ALL enemy users in the attack bbox (1 query instead of 25)
  let preloadedFortifications = new Map<string, Array<{ id: string; geometry: string; area: number }>>();
  if (isCompMode && competition && !hasBulldozerPower && attackBbox) {
    try {
      const enemyUserIdsForForts = [...new Set(territoriesToProcess.map(t => t.userId))];
      preloadedFortifications = await storage.getAllFortificationsInBbox(
        enemyUserIdsForForts,
        attackBbox[0], attackBbox[1], attackBbox[2], attackBbox[3]
      );
      if (preloadedFortifications.size > 0) {
        console.log(`[COMPETITION] Pre-loaded fortifications for ${preloadedFortifications.size} enemy users in 1 query`);
      }
    } catch (err) {
      console.error('[COMPETITION] Error pre-loading fortifications:', err);
    }
  }

  for (const enemyTerritory of territoriesToProcess) {
    try {
      // Skip if this user was identified as "ran together" (checked above against specific routes)
      if (ranTogetherUserIds.has(enemyTerritory.userId)) {
        console.log(`[TERRITORY] Skipping territory ${enemyTerritory.id} from user ${enemyTerritory.userId} - ran together`);
        continue;
      }

      // Late-import guard: skip territories created AFTER this route's completion time
      // (they didn't exist when the route was actually run)
      if (isLateImport && activityCompletedAt && enemyTerritory.conqueredAt) {
        const territoryTime = new Date(enemyTerritory.conqueredAt).getTime();
        const routeTime = new Date(activityCompletedAt).getTime();
        if (territoryTime > routeTime) {
          console.log(`[TERRITORY] Skipping territory ${enemyTerritory.id} from user ${enemyTerritory.userId} - territory created after route time (late import protection)`);
          continue;
        }
      }
      
      // --- Competition defensive power checks (using pre-loaded data, NO extra DB calls) ---
      if (isCompMode && competition) {
        const defenderPowers = enemyDefensivePowers.get(enemyTerritory.userId);
        
        // Shield: defender's territory is protected
        if (defenderPowers?.has('shield')) {
          continue;
        }
        
        // Invisibility: defender is invisible, skip their territory
        if (defenderPowers?.has('invisibility')) {
          continue;
        }

        // Fortification defense: check how many layers protect this territory
        if (!hasBulldozerPower && attackBbox) {
          try {
            const defenderGeomRaw = typeof enemyTerritory.geometry === 'string'
              ? JSON.parse(enemyTerritory.geometry)
              : enemyTerritory.geometry;
            if (defenderGeomRaw) {
              // Use pre-loaded fortifications (0 DB calls — already fetched in bulk)
              const fortRecords = preloadedFortifications.get(enemyTerritory.userId) || [];
              if (fortRecords.length > 0) {
                const attackFeature = turf.feature(attackGeometry);
                let overlappingLayers = 0;
                const layersToRemove: string[] = [];
                for (const fort of fortRecords) {
                  try {
                    const fortGeom = JSON.parse(fort.geometry);
                    const fortFeature = turf.feature(fortGeom);
                    const overlap = turf.intersect(turf.featureCollection([attackFeature as any, fortFeature as any]));
                    if (overlap && turf.area(overlap) > 10) {
                      overlappingLayers++;
                      layersToRemove.push(fort.id);
                    }
                  } catch (_) {}
                }
                // Base territory counts as layer 1; each fort record adds +0.5
                // 1 run = level 1 (stealable), 2 runs = 1.5 (stealable), 3 runs = 2.0 (fortified)
                const fortLevel = 1 + overlappingLayers * 0.5;
                if (fortLevel >= 2) {
                  // Break 2 records per attack (reduces level by 1.0); battering ram breaks up to 6
                  const layersToBreak = hasBatteringRamPower ? Math.min(overlappingLayers, 6) : Math.min(overlappingLayers, 2);
                  console.log(`[COMPETITION] FORTIFICATION level ${fortLevel} — breaking ${layersToBreak} layer(s) from ${enemyTerritory.userId}`);
                  // BATCH: accumulate fortification deletes instead of individual calls
                  for (let i = 0; i < layersToBreak && i < layersToRemove.length; i++) {
                    pendingFortificationDeletes.push(layersToRemove[i]);
                  }
                  fortressesDestroyed += layersToBreak;
                  continue;
                }
              }
            }
          } catch (err) {
            console.error('[TERRITORY] Error checking fortification:', err);
          }
        } else if (hasBulldozerPower) {
          // Bulldozer ignores fortifications — no DB call needed
        }
      }
      
      // Use subtractFromTerritoryDirect with pre-loaded territory (avoids redundant DB read)
      const result = await storage.subtractFromTerritoryDirect(
        enemyTerritory as any,
        attackGeometry
      );

      if (result.stolenArea > 0) {
        // Check if defender has TIME BOMB — damage is reflected back to attacker (using pre-loaded data)
        if (isCompMode && competition) {
          const defenderPowers = enemyDefensivePowers.get(enemyTerritory.userId);
          if (defenderPowers?.has('time_bomb')) {
            console.log(`[COMPETITION] TIME BOMB triggered by ${enemyTerritory.userId}!`);
            timeBombPenalty += result.stolenArea;
            victimsToUpdate.add(enemyTerritory.userId);
            continue;
          }
        }
        
        // Apply steal_boost multiplier for stats tracking
        const effectiveStolenArea = hasStealBoostPower
          ? result.stolenArea * 1.5
          : result.stolenArea;
        
        totalStolenArea += effectiveStolenArea;
        victimsToUpdate.add(enemyTerritory.userId);
        
        console.log(
          `[TERRITORY] Stole ${(result.stolenArea/1000000).toFixed(4)} km² from user ${enemyTerritory.userId}`
        );

        // BATCH: accumulate conquest metric instead of inserting individually
        pendingConquestMetrics.push({
          attackerId: userId,
          defenderId: enemyTerritory.userId,
          areaStolen: result.stolenArea,
          routeId,
        });

        // BATCH: accumulate sentinel alerts instead of inserting individually
        if (isCompMode && competition) {
          const defenderPowers = enemyDefensivePowers.get(enemyTerritory.userId);
          if (defenderPowers?.has('sentinel')) {
            // Pre-load attacker once (from cache)
            if (!defenderCache.has(userId)) {
              const attacker = await storage.getUser(userId);
              if (attacker) defenderCache.set(userId, attacker);
            }
            const attacker = defenderCache.get(userId);
            pendingSentinelAlerts.push({
              userId: enemyTerritory.userId,
              eventType: 'sentinel_alert',
              metadata: JSON.stringify({
                alertMessage: `🔔 ¡ALERTA CENTINELA! ${attacker?.name || 'Alguien'} está robando tu territorio (${formatAreaNotification(result.stolenArea)})`,
                attackerId: userId,
                attackerName: attacker?.name || 'Unknown',
                stolenArea: result.stolenArea,
                timestamp: new Date().toISOString(),
              }),
            });
          }
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

        // Defer email/notification instead of sending inline
        if (defender?.email) {
          deferredNotifications.push({
            victimId: enemyTerritory.userId,
            attackerName: '',
            attackerUsername: '',
            victimEmail: defender.email,
            stolenArea: result.stolenArea,
          });
        }
      }
    } catch (err) {
      console.error('[TERRITORY] Error processing enemy territory:', err);
    }
  }

  // === BATCH EXECUTE: All accumulated operations in minimal DB calls ===
  // 1. Batch delete fortification records (1 query instead of N)
  try {
    if (pendingFortificationDeletes.length > 0) {
      await storage.deleteFortificationRecordsBatch(pendingFortificationDeletes);
      console.log(`[TERRITORY] Batch deleted ${pendingFortificationDeletes.length} fortification records`);
    }
  } catch (err) {
    console.error('[TERRITORY] Batch fortification delete failed:', err);
  }

  // 2. Batch insert conquest metrics (1 query instead of N)
  try {
    if (pendingConquestMetrics.length > 0) {
      await storage.recordConquestMetricsBatch(pendingConquestMetrics);
      console.log(`[TERRITORY] Batch inserted ${pendingConquestMetrics.length} conquest metrics`);
    }
  } catch (err) {
    console.error('[TERRITORY] Batch conquest metrics failed, falling back:', err);
  }

  // 3. Batch insert sentinel alerts (1 query instead of N)
  try {
    if (pendingSentinelAlerts.length > 0) {
      await storage.createFeedEventsBatch(pendingSentinelAlerts);
      console.log(`[TERRITORY] Batch inserted ${pendingSentinelAlerts.length} sentinel alerts`);
    }
  } catch (err) {
    console.error('[TERRITORY] Batch sentinel alerts failed:', err);
  }

  // 4. Batch update victims' total areas (1 query instead of 2*N)
  try {
    if (victimsToUpdate.size > 0) {
      await storage.updateVictimAreasBatch(Array.from(victimsToUpdate));
      console.log(`[TERRITORY] Batch updated areas for ${victimsToUpdate.size} victims`);
    }
  } catch (err) {
    console.error('[TERRITORY] Batch victim area update failed:', err);
  }

  // Step 2: Merge with user's existing territories and calculate new area
  // In competition mode, wall power doubles fortification rate (2 records per overlap instead of 1)
  const fortificationMultiplier = (isCompMode && hasWallPower) ? 2 : 1;
  console.log('[TERRITORY] Merging with existing user territories...');
  
  const result = await storage.addOrMergeTerritory(
    userId,
    routeId,
    attackGeometry, // Use power-expanded geometry if applicable
    userTerritories,
    fortificationMultiplier
  );

  // In competition mode, new territory is worth 1.5x
  const effectiveNewArea = isCompMode ? result.newArea * 1.5 : result.newArea;

  // Step 3: Update user's total area (accounting for time bomb penalty and new territory bonus)
  let finalTotalArea = result.totalArea;
  if (isCompMode && result.newArea > 0) {
    // Add the 50% bonus for truly new territory
    const newTerritoryBonus = result.newArea * 0.5;
    finalTotalArea += newTerritoryBonus;
    console.log(`[COMPETITION] New territory bonus: +${(newTerritoryBonus/1e6).toFixed(4)} km² (1.5x on ${(result.newArea/1e6).toFixed(4)} km² new area)`);
  }
  if (result.fortificationLayers > 0) {
    console.log(`[COMPETITION] Fortification: ${result.fortificationLayers} layer(s) added (multiplier: ${fortificationMultiplier}x)`);
  }
  if (timeBombPenalty > 0) {
    finalTotalArea = Math.max(0, finalTotalArea - timeBombPenalty);
    console.log(`[COMPETITION] Time bomb penalty applied: -${(timeBombPenalty/1e6).toFixed(4)} km²`);
  }
  await storage.updateUserTotalArea(userId, finalTotalArea);

  // Step 4: Send deferred emails/notifications (non-critical, best-effort)
  // CAP: Only send notifications for the top MAX_NOTIFICATIONS victims (by stolen area) to prevent subrequest explosion
  const MAX_NOTIFICATIONS = 5;
  if (deferredNotifications.length > 0 && env) {
    const attacker = await storage.getUser(userId);
    if (attacker) {
      // Import notifications module ONCE
      let notifyFn: any = null;
      try {
        const mod = await import('./notifications');
        notifyFn = mod.notifyTerritoryLoss;
      } catch (_e) { /* notifications not available */ }

      // Sort by stolen area descending and cap at MAX_NOTIFICATIONS
      const sortedNotifs = [...deferredNotifications].sort((a, b) => b.stolenArea - a.stolenArea);
      const cappedNotifs = sortedNotifs.slice(0, MAX_NOTIFICATIONS);
      if (deferredNotifications.length > MAX_NOTIFICATIONS) {
        console.log(`[TERRITORY] Capping notifications: ${deferredNotifications.length} victims, sending to top ${MAX_NOTIFICATIONS}`);
      }

      for (const notif of cappedNotifs) {
        try {
          const provider = env.EMAIL_PROVIDER || (env.SENDGRID_API_KEY ? 'sendgrid' : 'resend');
          const apiKey = provider === 'sendgrid' ? env.SENDGRID_API_KEY : env.RESEND_API_KEY;
          const fromEmail = provider === 'sendgrid' ? (env.SENDGRID_FROM || env.RESEND_FROM) : env.RESEND_FROM;
          const emailService = new EmailService(apiKey!, fromEmail, provider as any);
          
          await emailService.sendTerritoryConqueredEmail(
            notif.victimEmail,
            attacker.name,
            attacker.username,
            notif.stolenArea
          );
          
          await emailService.recordNotification(
            storage,
            notif.victimId,
            'territory_conquered',
            userId,
            `¡${attacker.name} te conquistó ${formatAreaNotification(notif.stolenArea)}!`,
            `${attacker.name} (@${attacker.username}) ha conquistado ${formatAreaNotification(notif.stolenArea)} de tu territorio.`,
            notif.stolenArea
          );
        } catch (emailErr) {
          console.error('[TERRITORY] Failed to send conquest email:', emailErr);
        }

        // Push notification
        if (notifyFn && !victimsNotified.includes(notif.victimId)) {
          try {
            await notifyFn(storage, notif.victimId, userId, env, notif.stolenArea);
            victimsNotified.push(notif.victimId);
          } catch (notifErr) {
            console.error('[TERRITORY] Failed to send notification:', notifErr);
          }
        }
      }
    }
  }

  console.log(`[TERRITORY] Conquest complete:
    - Total area: ${(finalTotalArea/1000000).toFixed(4)} km²
    - New area: ${(result.newArea/1000000).toFixed(4)} km²
    - Area stolen: ${(totalStolenArea/1000000).toFixed(4)} km²
    - Existing area in route: ${(result.existingArea/1000000).toFixed(4)} km²
    - Ran together with: ${ranTogetherWith.length > 0 ? ranTogetherWith.join(', ') : 'none'}
    - Competition mode: ${isCompMode}
  `);

  // --- Competition post-processing ---
  const treasuresCollected: any[] = [];
  const powersUsed: string[] = [];
  
  if (isCompMode && competition) {
    // 1. Auto-collect treasures along the route (within 250m)
    if (routeCoordinates && routeCoordinates.length > 0) {
      try {
        const activeTreasures = await storage.getActiveTreasures(competition.id);
        // Sample every 5th coordinate to reduce computation
        const sampledCoords = routeCoordinates.filter((_, i) => i % 5 === 0);
        
        // First pass: identify treasures within range (pure computation, 0 DB calls)
        const treasuresToCollect: typeof activeTreasures = [];
        for (const treasure of activeTreasures) {
          for (const coord of sampledCoords) {
            const dist = turf.distance(
              turf.point([coord[1], coord[0]]),
              turf.point([treasure.lng, treasure.lat]),
              { units: 'meters' }
            );
            if (dist <= 250) {
              treasuresToCollect.push(treasure);
              break;
            }
          }
        }
        
        // Second pass: collect each treasure atomically (must be sequential for atomicity)
        // but batch the power creation and feed events after
        const collectedTreasureData: Array<{ treasure: typeof activeTreasures[0]; powerId: string }> = [];
        for (const treasure of treasuresToCollect) {
          const result = await storage.collectTreasure(treasure.id, userId);
          if (result && result.collectedBy === userId) {
            const powerId = crypto.randomUUID();
            collectedTreasureData.push({ treasure, powerId });
            treasuresCollected.push({
              treasureId: treasure.id,
              treasureName: treasure.name,
              powerType: treasure.powerType,
              rarity: treasure.rarity,
              zone: (treasure as any).zone || null,
            });
            console.log(`[COMPETITION] Treasure auto-collected: ${treasure.name} (${treasure.powerType}) by ${userId}`);
          }
        }
        
        // Batch create user powers (1 query instead of N)
        if (collectedTreasureData.length > 0) {
          try {
            await storage.createUserPowersBatch(collectedTreasureData.map(({ treasure, powerId }) => ({
              id: powerId,
              userId,
              competitionId: competition.id,
              powerType: treasure.powerType,
              treasureId: treasure.id,
              status: 'available',
            })));
          } catch (batchPowerErr) {
            console.error('[COMPETITION] Batch power creation failed, falling back:', batchPowerErr);
            // Fallback: create individually
            for (const { treasure, powerId } of collectedTreasureData) {
              try {
                await storage.createUserPower({
                  id: powerId,
                  userId,
                  competitionId: competition.id,
                  powerType: treasure.powerType,
                  treasureId: treasure.id,
                  status: 'available',
                });
              } catch (_) {}
            }
          }
        }
      } catch (err) {
        console.error('[COMPETITION] Error auto-collecting treasures:', err);
      }
    }
    
    // 2. Consume "next-run" powers in batch (1 query instead of up to 5)
    try {
      const powerIdsToConsume: Array<{id: string; name: string}> = [];
      if (doubleAreaPowerId) powerIdsToConsume.push({id: doubleAreaPowerId, name: 'double_area'});
      if (stealBoostPowerId) powerIdsToConsume.push({id: stealBoostPowerId, name: 'steal_boost'});
      if (magnetPowerId) powerIdsToConsume.push({id: magnetPowerId, name: 'magnet'});
      if (bulldozerPowerId) powerIdsToConsume.push({id: bulldozerPowerId, name: 'bulldozer'});
      if (batteringRamPowerId) powerIdsToConsume.push({id: batteringRamPowerId, name: 'battering_ram'});
      
      if (powerIdsToConsume.length > 0) {
        await storage.usePowersBatch(powerIdsToConsume.map(p => p.id));
        for (const p of powerIdsToConsume) {
          powersUsed.push(p.name);
          console.log(`[COMPETITION] Power consumed: ${p.name} (${p.id})`);
        }
      }
    } catch (err) {
      console.error('[COMPETITION] Error consuming powers:', err);
    }
    
    // 3. Update competition stats
    try {
      // Compute distance & duration from the route coordinates timeline
      let routeDistance = 0;
      let routeDuration = 0;
      if (routeCoordinates && routeCoordinates.length >= 2) {
        try {
          const line = turf.lineString(routeCoordinates.map(c => [c[1], c[0]]));
          routeDistance = turf.length(line, { units: 'meters' });
        } catch (_) {}
      }
      if (activityStartedAt && activityCompletedAt) {
        routeDuration = Math.round((new Date(activityCompletedAt).getTime() - new Date(activityStartedAt).getTime()) / 1000);
      }
      // Sync totalArea to competition stats (includes 1.5x new-territory bonus)
      try {
        await storage.updateCompetitionStats(competition.id, userId, { totalArea: finalTotalArea });
      } catch (_) {}
      await storage.incrementCompetitionStats(competition.id, userId, {
        activities: 1,
        distance: routeDistance,
        duration: routeDuration,
        areaStolen: totalStolenArea,
        treasures: treasuresCollected.length,
        ranTogether: ranTogetherWith.length,
      });
      // Fix: compute truly unique victims from conquest_metrics (not per-run)
      try {
        const distinctVictims = await storage.getDistinctVictimsCount(userId);
        await storage.updateCompetitionStats(competition.id, userId, { uniqueVictims: distinctVictims });
      } catch (_) {}
    } catch (err) {
      console.error('[COMPETITION] Error updating competition stats:', err);
    }
  }

  return {
    territory: result.territory,
    totalArea: finalTotalArea,
    newAreaConquered: effectiveNewArea,
    areaStolen: totalStolenArea,
    victimsNotified,
    victims: Array.from(victimMap.values()).sort((a, b) => b.stolenArea - a.stolenArea),
    ranTogetherWith,
    treasuresCollected,
    powersUsed,
    fortressesDestroyed,
    fortificationLayers: result.fortificationLayers,
    fortificationArea: result.fortificationArea,
  };
}

// Helper to safely compute union of two geometries, returning null on failure
function safeUnion(geomA: any, geomB: any): any | null {
  try {
    const toFeature = (geom: any) => geom.type === 'MultiPolygon'
      ? turf.multiPolygon(geom.coordinates)
      : turf.polygon(geom.coordinates);
    const result = turf.union(turf.featureCollection([toFeature(geomA), toFeature(geomB)]));
    return result ? result.geometry : null;
  } catch (err) {
    console.error('[TERRITORY] safeUnion failed:', err);
    return null;
  }
}

// Rebuild territories for a user from all their remaining routes
// Used after route deletion to recalculate territory accurately
// SAFE: computes full geometry before deleting anything
async function reprocessUserTerritories(
  storage: WorkerStorage,
  userId: string
): Promise<void> {
  // Get all of the user's routes, ordered chronologically (oldest first)
  const userRoutes = await storage.getRoutesByUserIdChronological(userId);

  let currentGeometry: any = null;
  let processedCount = 0;

  for (const route of userRoutes) {
    try {
      const coords: [number, number][] = Array.isArray(route.coordinates)
        ? route.coordinates
        : typeof route.coordinates === 'string'
          ? JSON.parse(route.coordinates)
          : [];

      if (coords.length < 10) continue;

      const enclosedPoly = routeToEnclosedPolygon(coords, 150);
      if (!enclosedPoly) continue;

      if (currentGeometry) {
        // Merge with existing territory using safe union
        const merged = safeUnion(currentGeometry, enclosedPoly.geometry);
        if (merged) {
          currentGeometry = merged;
        } else {
          console.error(`[REPROCESS] Error merging route ${route.id}, skipping`);
        }
      } else {
        currentGeometry = enclosedPoly.geometry;
      }
      processedCount++;
    } catch (err) {
      console.error(`[REPROCESS] Error processing route ${route.id}:`, err);
    }
  }

  if (currentGeometry) {
    const totalArea = turf.area(currentGeometry);
    
    // Safety check: only proceed if the rebuilt area seems reasonable
    if (totalArea > 0 && isFinite(totalArea)) {
      // Now safe to delete and replace
      await storage.deleteTerritoriesByUserId(userId);
      await storage.updateTerritoryGeometry(userId, null, currentGeometry, totalArea);
      await storage.updateUserTotalArea(userId, totalArea);
      console.log(`[REPROCESS] Rebuilt territory for user ${userId}: ${processedCount} routes, ${(totalArea/1000000).toFixed(4)} km²`);
    } else {
      console.error(`[REPROCESS] Invalid rebuilt area (${totalArea}), not replacing territories`);
    }
  } else {
    // No valid routes — safe to clear
    await storage.deleteTerritoriesByUserId(userId);
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
export async function reprocessFriendGroupTerritoriesChronologically(
  storage: WorkerStorage,
  triggerUserId: string,
): Promise<void> {
  console.log(`[FRIEND REPROCESS] Starting for user ${triggerUserId} + friends...`);

  // 1. Determine the friend group (user + their friends)
  const friendIds = await storage.getFriendIds(triggerUserId);
  const groupUserIds = [triggerUserId, ...friendIds];
  console.log(`[FRIEND REPROCESS] Friend group: ${groupUserIds.length} users`);

  // 2. Wipe territories and conquest metrics for this group (batch operations)
  await storage.deleteTerritoriesForUsers(groupUserIds);
  await storage.resetTotalAreaForUsers(groupUserIds);
  await storage.deleteConquestMetricsForUsers(groupUserIds);

  // 3. Get routes from group users only, oldest first
  const allRoutes = await storage.getRoutesForUsersChronological(groupUserIds);
  console.log(`[FRIEND REPROCESS] ${allRoutes.length} routes to process`);

  // Per-user accumulated geometry
  const userGeometries = new Map<string, any>();

  // Build a friendship lookup for the whole group (single DB call)
  const friendshipMap = await storage.getFriendshipMap(groupUserIds);

  // Pre-build routes-by-user index for fast ran-together lookups
  const routesByUser = new Map<string, typeof allRoutes>();
  for (const r of allRoutes) {
    if (!routesByUser.has(r.userId)) routesByUser.set(r.userId, []);
    routesByUser.get(r.userId)!.push(r);
  }

  // Pre-compute enclosed polygons for all routes (for ran-together area checks)
  const routePolygonCache = new Map<string, any>();

  // Helper to convert geometry to turf feature
  const toFeature = (geom: any) => geom.type === 'MultiPolygon'
    ? turf.multiPolygon(geom.coordinates)
    : turf.polygon(geom.coordinates);

  for (const route of allRoutes) {
    try {
      const coords: [number, number][] = Array.isArray(route.coordinates)
        ? route.coordinates
        : typeof route.coordinates === 'string'
          ? JSON.parse(route.coordinates)
          : [];

      if (coords.length < 10) continue;

      const enclosedPoly = routeToEnclosedPolygon(coords, 150);
      if (!enclosedPoly) continue;

      const routeGeometry = enclosedPoly.geometry;
      routePolygonCache.set(route.id, routeGeometry);
      const routeOwnerFriends = friendshipMap.get(route.userId) || new Set();

      // --- Steal from FRIENDS only whose territory overlaps this route ---
      for (const [otherUserId, otherGeometry] of userGeometries) {
        if (otherUserId === route.userId) continue;
        // Only steal between friends
        if (!routeOwnerFriends.has(otherUserId)) continue;

        try {
          const otherFeature = toFeature(otherGeometry);
          const routeFeature = toFeature(routeGeometry);

          const intersection = turf.intersect(turf.featureCollection([otherFeature, routeFeature]));
          if (intersection) {
            // --- Ran-together exception: BOTH conditions must be met ---
            // 1. Start times within 15 minutes
            // 2. Area overlap >= 90%
            // If both conditions are met, they "ran together" → no stealing
            if (route.startedAt && route.completedAt) {
              const otherRoutes = routesByUser.get(otherUserId) || [];
              let ranTogether = false;
              // Time check is very cheap, area check is expensive → check time first
              for (const otherRoute of otherRoutes) {
                if (!otherRoute.startedAt || !otherRoute.completedAt) continue;
                const timeOverlap = activitiesOverlapInTime(
                  route.startedAt,
                  route.completedAt,
                  otherRoute.startedAt,
                  otherRoute.completedAt
                );
                if (timeOverlap) {
                  // Check area overlap against the SPECIFIC route's enclosed polygon, not accumulated territory
                  const otherRoutePolygon = routePolygonCache.get(otherRoute.id);
                  if (otherRoutePolygon) {
                    const areaOverlap = geometriesOverlapByPercentage(
                      routeGeometry,
                      otherRoutePolygon,
                      0.90
                    );
                    if (areaOverlap) {
                      console.log(`[FRIEND REPROCESS] Ran together: route ${route.id} (${route.userId}) and route ${otherRoute.id} (${otherUserId}) - skipping steal`);
                      ranTogether = true;
                      break;
                    }
                  }
                  // Continue checking other routes from this user that might also match in time
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

  // Health check endpoint for COROS webhook verification
  app.get('/api/health', (c) => {
    return c.json({ 
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'runna-io-api'
    });
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
      if (color !== undefined) {
        // Check if the new color conflicts with any friend's color
        const friendColors = await getFriendGroupColors(storage, id);
        if (friendColors.has(color.toUpperCase())) {
          return c.json({ error: 'Este color ya lo usa uno de tus amigos. Elige otro.' }, 400);
        }
        updateData.color = color;
      }
      if (avatar !== undefined) updateData.avatar = avatar;

      const updatedUser = await storage.updateUser(id, updateData);
      return c.json(updatedUser);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  });

  // Delete user account and all associated data
  app.delete('/api/users/:id', async (c) => {
    try {
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const id = c.req.param('id');
      const user = await storage.getUser(id);
      if (!user) {
        return c.json({ error: 'User not found' }, 404);
      }
      await storage.deleteUser(id);
      return c.json({ success: true });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
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

      // Ensure coordinates is a JSON string (clients may send array or string)
      if (body.coordinates && typeof body.coordinates !== 'string') {
        body.coordinates = JSON.stringify(body.coordinates);
      }

      const routeData = insertRouteSchema.parse(body);
      
      const route = await storage.createRoute(routeData);

      // CRITICAL FIX: Create a basic feed event IMMEDIATELY after route creation.
      // This guarantees the feed event exists even if territory processing exhausts
      // Cloudflare Worker subrequests and fails. We'll UPDATE it with conquest data later.
      let earlyFeedEventId: string | undefined;
      try {
        // Check for existing feed event first (prevents duplicates on retries)
        const existingFeed = await storage.getFeedEventByRouteId(route.id);
        if (existingFeed) {
          earlyFeedEventId = existingFeed.id;
          console.log(`[FEED] ♻️ Reusing existing feed event ${earlyFeedEventId} for route ${route.id}`);
        } else {
          const earlyFeedEvent = await storage.createFeedEvent({
            userId: routeData.userId,
            eventType: 'activity',
            routeId: route.id,
            distance: routeData.distance,
            duration: routeData.duration,
            newArea: 0,
            metadata: null,
          });
          earlyFeedEventId = earlyFeedEvent.id;
          console.log(`[FEED] ✅ Early feed event created: ${earlyFeedEventId} for route ${route.id}`);
        }
      } catch (earlyFeedErr) {
        console.error('[FEED] ❌ Early feed event creation failed:', earlyFeedErr);
      }

      // Parse coordinates from JSON string
      const coords: [number, number][] = typeof routeData.coordinates === 'string'
        ? JSON.parse(routeData.coordinates)
        : routeData.coordinates;

      // ── Enqueue heavy territory processing via Cloudflare Queue ──
      // The queue consumer (queue-consumer.ts) will handle:
      //   - routeToEnclosedPolygon + processTerritoryConquest
      //   - generateFeedEvents (update early feed event with conquest data)
      //   - Notifications (friend activity, area overtakes)
      // This runs with its own 30s CPU budget, eliminating error 1102.
      try {
        await c.env.TERRITORY_QUEUE.send({
          type: 'process_route_territory',
          userId: routeData.userId,
          routeId: route.id,
          startedAt: routeData.startedAt,
          completedAt: routeData.completedAt,
          distance: routeData.distance,
          duration: routeData.duration,
          earlyFeedEventId,
        });
        console.log(`[QUEUE] ✅ Enqueued territory processing for route ${route.id}`);
      } catch (queueErr) {
        console.error(`[QUEUE] ❌ Failed to enqueue territory processing:`, queueErr);
        // Fallback: try inline processing (old behavior) via waitUntil
        // This shares the request's CPU budget so it may still fail,
        // but at least the route + feed event are already saved.
        c.executionCtx.waitUntil((async () => {
          try {
            const enclosedPoly = routeToEnclosedPolygon(coords, 150);
            if (enclosedPoly) {
              const conquestResult = await processTerritoryConquest(
                storage, routeData.userId, route.id, enclosedPoly.geometry,
                c.env, routeData.startedAt, routeData.completedAt, coords
              );
              if (conquestResult.ranTogetherWith.length > 0) {
                await storage.updateRouteRanTogether(route.id, conquestResult.ranTogetherWith);
              }
              await generateFeedEvents(storage, routeData.userId, route.id, routeData.distance, routeData.duration, conquestResult, false, earlyFeedEventId);
            }
          } catch (fallbackErr) {
            console.error('[QUEUE FALLBACK] Inline territory processing failed:', fallbackErr);
          }
        })());
      }

      const summaryPolyline = encodePolyline(coords);

      return c.json({
        route,
        summaryPolyline,
        // Territory data will be processed asynchronously via queue.
        // Client fetches fresh territory data from GET /api/territories/friends/:userId
        territoryProcessing: 'queued',
      });
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
  app.delete('/api/routes/:userId/:routeId', async (c) => {
    try {
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const routeId = c.req.param('routeId');
      const userId = c.req.param('userId');

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

      // Delete feed events for this route
      await storage.deleteFeedEventsByRouteId(routeId);

      // Delete conquest metrics for this route
      await storage.deleteConquestMetricsByRouteId(routeId);

      // Remove any linked Polar/Strava activity records so they can be reimported
      await storage.deletePolarActivityByRouteId(routeId);
      await storage.deleteStravaActivityByRouteId(routeId);

      // Delete the route itself (no cascade on territories now)
      await storage.deleteRouteById(routeId);

      // Rebuild territories after delete — smart reprocess like Polar delete
      // SAFETY: Only reprocess the affected user to avoid CPU timeout (error 1102).
      // Friend-group reprocessing is too expensive and can wipe all territory data.
      try {
        console.log('[DELETE ROUTE] Reprocessing user territories only (safe mode)');
        await reprocessUserTerritories(storage, userId);
      } catch (e) {
        console.error('[DELETE ROUTE] Error reprocessing territories:', e);
      }

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

  // Admin: Reprocess territories for a SINGLE user (lightweight, avoids CPU timeout)
  app.post('/api/admin/reprocess-user/:userId', async (c) => {
    try {
      const userId = c.req.param('userId');
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);

      const user = await storage.getUser(userId);
      if (!user) {
        return c.json({ error: `User '${userId}' not found` }, 404);
      }

      // Simple single-user reprocess (no friend-group stealing, just rebuild own territory)
      await reprocessUserTerritories(storage, userId);

      const updatedUser = await storage.getUser(userId);
      return c.json({
        success: true,
        userId,
        name: updatedUser?.name,
        totalArea: updatedUser?.totalArea || 0,
      });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // Admin: Batch reprocess territories for a user (processes N routes at a time)
  // Call repeatedly with increasing offset until done=true
  app.post('/api/admin/reprocess-user-batch/:userId', async (c) => {
    try {
      const userId = c.req.param('userId');
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const body = await c.req.json().catch(() => ({}));
      const batchSize = body.batchSize || 20;
      const offset = body.offset || 0;

      const user = await storage.getUser(userId);
      if (!user) {
        return c.json({ error: `User '${userId}' not found` }, 404);
      }

      const totalRoutes = await storage.getRouteCountByUserId(userId);

      // On first batch (offset=0), delete existing territories
      if (offset === 0) {
        await storage.deleteTerritoriesByUserId(userId);
      }

      // Get current territory geometry if continuing
      let currentGeometry: any = null;
      if (offset > 0) {
        const existingTerritories = await storage.getTerritoriesByUserId(userId);
        if (existingTerritories.length > 0) {
          currentGeometry = existingTerritories[0].geometry;
        }
      }

      // Get batch of routes
      const batchRoutes = await storage.getRoutesByUserIdChronologicalPaginated(userId, batchSize, offset);
      let processed = 0;

      for (const route of batchRoutes) {
        try {
          const coords: [number, number][] = Array.isArray(route.coordinates)
            ? route.coordinates
            : typeof route.coordinates === 'string'
              ? JSON.parse(route.coordinates)
              : [];
          if (coords.length < 10) continue;

          const enclosedPoly = routeToEnclosedPolygon(coords, 150);
          if (!enclosedPoly) continue;

          if (currentGeometry) {
            try {
              const toFeature = (geom: any) => geom.type === 'MultiPolygon'
                ? turf.multiPolygon(geom.coordinates)
                : turf.polygon(geom.coordinates);
              const currentFeature = toFeature(currentGeometry);
              const newFeature = toFeature(enclosedPoly.geometry);
              const union = turf.union(turf.featureCollection([currentFeature, newFeature]));
              if (union) currentGeometry = union.geometry;
            } catch (err) {
              console.error('[BATCH REPROCESS] Error merging geometry:', err);
            }
          } else {
            currentGeometry = enclosedPoly.geometry;
          }
          processed++;
        } catch (err) {
          console.error(`[BATCH REPROCESS] Error processing route ${route.id}:`, err);
        }
      }

      // Save progress
      if (currentGeometry) {
        const totalArea = turf.area(currentGeometry);
        await storage.updateTerritoryGeometry(userId, null, currentGeometry, totalArea);
        await storage.updateUserTotalArea(userId, totalArea);
      }

      const nextOffset = offset + batchSize;
      const done = nextOffset >= totalRoutes;

      return c.json({
        success: true,
        userId,
        name: user.name,
        totalRoutes,
        processed,
        offset,
        nextOffset: done ? null : nextOffset,
        done,
        currentArea: currentGeometry ? turf.area(currentGeometry) : 0,
      });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // Admin: Reprocess territories for a user's FRIEND GROUP with full chronological stealing.
  // This is lighter than the global reprocess because it only processes one friend group.
  // Supports batching via batchSize/offset to avoid CPU timeout (error 1102).
  app.post('/api/admin/reprocess-friend-group/:userId', async (c) => {
    try {
      const userId = c.req.param('userId');
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);

      const user = await storage.getUser(userId);
      if (!user) {
        return c.json({ error: `User '${userId}' not found` }, 404);
      }

      const body = await c.req.json().catch(() => ({}));
      const batchSize = body.batchSize || 30;
      const offset = body.offset || 0;

      // 1. Determine friend group
      const friendIds = await storage.getFriendIds(userId);
      const groupUserIds = [userId, ...friendIds];

      // 2. On first batch, wipe territories and conquest metrics for this group
      if (offset === 0) {
        await storage.deleteTerritoriesForUsers(groupUserIds);
        await storage.resetTotalAreaForUsers(groupUserIds);
        await storage.deleteConquestMetricsForUsers(groupUserIds);
      }

      // 3. Get ALL routes from group, oldest first
      const allRoutes = await storage.getRoutesForUsersChronological(groupUserIds);
      const totalRoutes = allRoutes.length;

      // 4. If continuing from offset > 0, rebuild geometry state up to offset
      //    by loading persisted territory geometries (from previous batch's save)
      const userGeometries = new Map<string, any>();
      if (offset > 0) {
        for (const uid of groupUserIds) {
          const territories = await storage.getTerritoriesByUserId(uid);
          if (territories.length > 0) {
            try {
              const geom = typeof territories[0].geometry === 'string'
                ? JSON.parse(territories[0].geometry)
                : territories[0].geometry;
              userGeometries.set(uid, geom);
            } catch (_) { /* skip invalid */ }
          }
        }
      }

      // Build friendship lookup
      const friendshipMap = await storage.getFriendshipMap(groupUserIds);

      // Pre-build route polygon cache for ran-together checks
      const routePolygonCache = new Map<string, any>();
      const routesByUser = new Map<string, typeof allRoutes>();
      for (const r of allRoutes) {
        if (!routesByUser.has(r.userId)) routesByUser.set(r.userId, []);
        routesByUser.get(r.userId)!.push(r);
      }

      const toFeature = (geom: any) => geom.type === 'MultiPolygon'
        ? turf.multiPolygon(geom.coordinates)
        : turf.polygon(geom.coordinates);

      // 5. Process batch of routes
      const batchEnd = Math.min(offset + batchSize, totalRoutes);
      let processed = 0;

      // NOTE: We do NOT pre-compute polygons for routes before offset.
      // That would use too much CPU with turf.buffer(). Instead, ran-together
      // polygon checks compute lazily only when a time overlap is detected.

      for (let i = offset; i < batchEnd; i++) {
        const route = allRoutes[i];
        try {
          const coords: [number, number][] = Array.isArray(route.coordinates)
            ? route.coordinates
            : typeof route.coordinates === 'string'
              ? JSON.parse(route.coordinates)
              : [];

          if (coords.length < 10) continue;

          const enclosedPoly = routeToEnclosedPolygon(coords, 150);
          if (!enclosedPoly) continue;

          const routeGeometry = enclosedPoly.geometry;
          routePolygonCache.set(route.id, routeGeometry);
          const routeOwnerFriends = friendshipMap.get(route.userId) || new Set();

          // Steal from friends whose territory overlaps this route
          for (const [otherUserId, otherGeometry] of userGeometries) {
            if (otherUserId === route.userId) continue;
            if (!routeOwnerFriends.has(otherUserId)) continue;

            try {
              const otherFeature = toFeature(otherGeometry);
              const routeFeature = toFeature(routeGeometry);

              const intersection = turf.intersect(turf.featureCollection([otherFeature, routeFeature]));
              if (intersection) {
                // Ran-together exception
                if (route.startedAt && route.completedAt) {
                  const otherRoutes = routesByUser.get(otherUserId) || [];
                  let ranTogether = false;
                  for (const otherRoute of otherRoutes) {
                    if (!otherRoute.startedAt || !otherRoute.completedAt) continue;
                    const timeOverlap = activitiesOverlapInTime(
                      route.startedAt, route.completedAt,
                      otherRoute.startedAt, otherRoute.completedAt
                    );
                    if (timeOverlap) {
                      // Lazy-compute polygon for older route if not cached
                      let otherRoutePolygon = routePolygonCache.get(otherRoute.id);
                      if (!otherRoutePolygon) {
                        try {
                          const otherCoords: [number, number][] = Array.isArray(otherRoute.coordinates)
                            ? otherRoute.coordinates
                            : typeof otherRoute.coordinates === 'string'
                              ? JSON.parse(otherRoute.coordinates)
                              : [];
                          if (otherCoords.length >= 10) {
                            const otherPoly = routeToEnclosedPolygon(otherCoords, 150);
                            if (otherPoly) {
                              otherRoutePolygon = otherPoly.geometry;
                              routePolygonCache.set(otherRoute.id, otherRoutePolygon);
                            }
                          }
                        } catch (_) { /* skip */ }
                      }
                      if (otherRoutePolygon) {
                        const areaOverlap = geometriesOverlapByPercentage(routeGeometry, otherRoutePolygon, 0.90);
                        if (areaOverlap) {
                          ranTogether = true;
                          break;
                        }
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
                    await storage.recordConquestMetric(route.userId, otherUserId, stolenArea, route.id);
                  } catch (_e) { /* best-effort */ }
                }
              }
            } catch (_e) { /* geometry op failed */ }
          }

          // Merge route into owner's territory
          const existing = userGeometries.get(route.userId);
          if (existing) {
            try {
              const merged = turf.union(turf.featureCollection([toFeature(existing), toFeature(routeGeometry)]));
              if (merged) userGeometries.set(route.userId, merged.geometry);
            } catch (_e) { /* keep existing */ }
          } else {
            userGeometries.set(route.userId, routeGeometry);
          }

          processed++;
        } catch (err) {
          console.error(`[FRIEND GROUP REPROCESS] Error on route ${route.id}:`, err);
        }
      }

      // 6. Persist current geometries
      for (const [uid, geometry] of userGeometries) {
        const totalArea = turf.area(geometry);
        // Delete existing territories first, then create new
        await storage.deleteTerritoriesByUserId(uid);
        await storage.updateTerritoryGeometry(uid, null, geometry, totalArea);
        await storage.updateUserTotalArea(uid, totalArea);
      }
      // Users with no territory
      for (const uid of groupUserIds) {
        if (!userGeometries.has(uid)) {
          await storage.deleteTerritoriesByUserId(uid);
          await storage.updateUserTotalArea(uid, 0);
        }
      }

      const done = batchEnd >= totalRoutes;
      const nextOffset = done ? null : batchEnd;

      // Build summary
      const summary: any[] = [];
      for (const uid of groupUserIds) {
        const u = await storage.getUser(uid);
        summary.push({
          userId: uid,
          name: u?.name,
          totalArea: u?.totalArea || 0,
        });
      }

      return c.json({
        success: true,
        userId,
        friendGroupSize: groupUserIds.length,
        totalRoutes,
        processed,
        offset,
        batchEnd,
        nextOffset,
        done,
        summary,
      });
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

      // 7. Reprocess friend group territories — SAFE: only reprocess each user individually
      try {
        const friendIds = await storage.getFriendIds(userId);
        for (const fid of friendIds) {
          try {
            await reprocessUserTerritories(storage, fid);
          } catch (e) {
            console.error(`[ADMIN CLEANUP] Error reprocessing friend ${fid}:`, e);
          }
        }
        console.log(`[ADMIN CLEANUP] Reprocessed friend territories individually`);
      } catch (e) {
        console.error('[ADMIN CLEANUP] Error reprocessing friends:', e);
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

  // ===== CRON: Inactivity Reminders (called by Upstash every 12h) =====
  app.post('/api/tasks/inactivity-check', async (c) => {
    try {
      // Verify Upstash cron secret (or allow manual trigger with admin key)
      const authHeader = c.req.header('Authorization');
      const cronSecret = (c.env as any).UPSTASH_CRON_SECRET;
      
      // Allow if: Upstash signature matches, or Authorization Bearer matches cron secret
      if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const db = getDb(c.env);
      const storage = new WorkerStorage(db);

      const { checkAndSendInactivityReminders } = await import('./inactivityReminders');
      const result = await checkAndSendInactivityReminders(storage, c.env);

      return c.json({
        success: true,
        message: 'Inactivity check completed',
        ...result,
      });
    } catch (error: any) {
      console.error('[CRON INACTIVITY] Error:', error);
      return c.json({ error: error.message }, 500);
    }
  });

  // ===== CRON: Inactivity Reminders (called by Upstash every 12h) =====
  app.post('/api/tasks/inactivity-check', async (c) => {
    try {
      // Verify Upstash cron secret (or allow manual trigger with admin key)
      const authHeader = c.req.header('Authorization');
      const cronSecret = (c.env as any).UPSTASH_CRON_SECRET;
      
      // Allow if: Upstash signature matches, or Authorization Bearer matches cron secret
      if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const db = getDb(c.env);
      const storage = new WorkerStorage(db);

      const { checkAndSendInactivityReminders } = await import('./inactivityReminders');
      const result = await checkAndSendInactivityReminders(storage, c.env);

      return c.json({
        success: true,
        message: 'Inactivity check completed',
        ...result,
      });
    } catch (error: any) {
      console.error('[CRON INACTIVITY] Error:', error);
      return c.json({ error: error.message }, 500);
    }
  });

  // Admin: Force reimport of all Polar activities from database
  // Phase 1: ?phase=diagnose → shows current state (no changes)
  // Phase 2: ?phase=cleanup → removes duplicate routes, orphaned data
  // Phase 3: ?phase=process → processes 1 unprocessed activity (call repeatedly)
  // Phase 4: ?phase=reprocess → full chronological territory reprocess for all friend groups
  app.post('/api/admin/reimport-polar-activities', async (c) => {
    const phase = c.req.query('phase') || 'process';
    const db = getDb(c.env);
    const storage = new WorkerStorage(db);

    // ===== PHASE 1: DIAGNOSE =====
    if (phase === 'diagnose') {
      try {
        const userIds = await storage.getUsersWithPolarActivities();
        const diagnostics: any[] = [];

        for (const userId of userIds) {
          const user = await storage.getUser(userId);
          const allActivities = await storage.getPolarActivitiesByUserId(userId);
          const unprocessed = allActivities.filter(a => !a.processed);
          const withRoute = allActivities.filter(a => a.routeId);
          const withoutRoute = allActivities.filter(a => !a.routeId);
          const routeCount = await storage.getRouteCountByUserId(userId);
          const territoryCount = await storage.getTerritoryCountByUserId(userId);

          diagnostics.push({
            userId,
            userName: user?.name || userId,
            polarActivities: {
              total: allActivities.length, 
              processed: allActivities.length - unprocessed.length,
              unprocessed: unprocessed.length,
              withRoute: withRoute.length,
              withoutRoute: withoutRoute.length,
            },
            routes: routeCount,
            territories: territoryCount,
          });
        }

        return c.json({ phase: 'diagnose', diagnostics });
      } catch (error: any) {
        return c.json({ error: error.message }, 500);
      }
    }

    // ===== PHASE 2: CLEANUP =====
    // Removes: duplicate routes (same user+date+distance), orphaned territories,
    // and resets polar activities that point to non-existent routes
    if (phase === 'cleanup') {
      try {
        const userIds = await storage.getUsersWithPolarActivities();
        const cleanupResults: any[] = [];

        for (const userId of userIds) {
          const user = await storage.getUser(userId);
          let deletedRoutes = 0;
          let resetActivities = 0;

          // 1. Find and remove orphaned routes (routes not linked to any polar/strava activity)
          const orphanedRoutes = await storage.getOrphanedRoutes(userId);
          for (const route of orphanedRoutes) {
            // Clean up territories linked to this route
            await storage.detachTerritoriesFromRoute(route.id);
            await storage.deleteConquestMetricsByRouteId(route.id);
            await storage.deleteRouteByIdDirect(route.id);
            deletedRoutes++;
          }

          // 2. Reset polar activities whose routeId points to a route that was deleted
          const allActivities = await storage.getPolarActivitiesByUserId(userId);
          for (const activity of allActivities) {
            if (activity.routeId) {
              const route = await storage.getRouteById(activity.routeId);
              if (!route) {
                // Route was deleted but activity still points to it
                await storage.updatePolarActivity(activity.id, {
                  routeId: null,
                  territoryId: null,
                  processed: false,
                  processedAt: null,
                });
                resetActivities++;
              }
            }
          }

          cleanupResults.push({
            userId,
            userName: user?.name || userId,
            orphanedRoutesDeleted: deletedRoutes,
            activitiesReset: resetActivities,
          });
        }

        return c.json({ phase: 'cleanup', results: cleanupResults });
      } catch (error: any) {
        return c.json({ error: error.message }, 500);
      }
    }

    // ===== PHASE 3: PROCESS (one activity at a time - LIGHTWEIGHT) =====
    // Only creates the route and links it to the polar activity. 
    // Territory processing is deferred to phase=reprocess for correct chronological order.
    if (phase === 'process') {
      try {
        const userIds = await storage.getUsersWithPolarActivities();

        // Find first user with unprocessed activities
        for (const userId of userIds) {
          const unprocessed = await storage.getUnprocessedPolarActivities(userId);
          if (unprocessed.length === 0) continue;

          const user = await storage.getUser(userId);
          const activity = unprocessed[0];

          console.log(`[REIMPORT] Processing activity ${activity.id} for user ${user?.name || userId}: "${activity.name}"`);

          if (!activity.summaryPolyline) {
            await storage.updatePolarActivity(activity.id, { processed: true, processedAt: new Date() });
            return c.json({
              phase: 'process', action: 'skipped_no_gps',
              activity: { id: activity.id, name: activity.name },
              user: user?.name || userId, remaining: unprocessed.length - 1,
            });
          }

          const startDate = coerceDate(activity.startDate);
          if (!startDate) {
            await storage.updatePolarActivity(activity.id, { processed: true, processedAt: new Date(), skipReason: 'bad_date' });
            return c.json({
              phase: 'process', action: 'skipped_bad_date',
              activity: { id: activity.id, name: activity.name },
              user: user?.name || userId, remaining: unprocessed.length - 1,
            });
          }

          // COMPETITION FILTER: Skip activities before competition start date
          const COMP_MIN_DATE = new Date('2026-03-02T00:00:00Z');
          if (startDate < COMP_MIN_DATE) {
            await storage.updatePolarActivity(activity.id, { processed: true, processedAt: new Date(), skipReason: 'before_competition' });
            console.log(`[REIMPORT] ❌ Activity ${activity.id} before competition start (${startDate.toISOString()})`);
            return c.json({
              phase: 'process', action: 'skipped_before_competition',
              activity: { id: activity.id, name: activity.name, date: startDate.toISOString() },
              user: user?.name || userId, remaining: unprocessed.length - 1,
            });
          }

          const decoded = decodePolyline(activity.summaryPolyline);
          const coordinates: Array<[number, number]> = decoded.map((coord: [number, number]) => [coord[0], coord[1]]);

          if (coordinates.length < 3) {
            await storage.updatePolarActivity(activity.id, { processed: true, processedAt: new Date() });
            return c.json({
              phase: 'process', action: 'skipped_few_coords',
              activity: { id: activity.id, name: activity.name },
              user: user?.name || userId, remaining: unprocessed.length - 1,
            });
          }

          const startedAtStr = startDate.toISOString();
          const completedAtStr = new Date(startDate.getTime() + activity.duration * 1000).toISOString();

          // DEDUPLICATE: Check if a route already exists for this user at this time/distance
          let route = await storage.findRouteByDateAndDistance(userId, startedAtStr, activity.distance);
          let routeAction = 'reused_existing';

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
            routeAction = 'created_new';
          }

          // Link activity to route and mark as processed
          await storage.updatePolarActivity(activity.id, {
            routeId: route.id,
            processed: true,
            processedAt: new Date(),
          });

          return c.json({
            phase: 'process', action: 'processed', routeAction,
            activity: { id: activity.id, name: activity.name, distance: Math.round(activity.distance) },
            user: user?.name || userId,
            remaining: unprocessed.length - 1,
            note: 'Ruta creada. Territorios se calculan con phase=reprocess al final.',
          });
        }

        // All users done
        return c.json({
          phase: 'process', action: 'all_done',
          message: 'Todas las actividades procesadas. Ahora ejecuta phase=reprocess para calcular territorios.',
        });

      } catch (error: any) {
        console.error('[REIMPORT] Error:', error);
        return c.json({ error: error.message }, 500);
      }
    }

    // ===== PHASE 4: REPROCESS TERRITORIES =====
    // Process ONE friend group per invocation (call repeatedly until done).
    // Uses chronological reprocess with steal logic + ran-together detection.
    if (phase === 'reprocess') {
      try {
        const allUsers = await storage.getAllUsersWithStats();
        
        // Find which friend groups have routes but no territories yet
        // (or need recalculation)
        const processedGroupKey = new Set<string>();
        
        for (const user of allUsers) {
          // Create a deterministic group key (sorted user IDs)
          const friendIds = await storage.getFriendIds(user.id);
          const groupIds = [user.id, ...friendIds].sort();
          const groupKey = groupIds.join(',');
          
          if (processedGroupKey.has(groupKey)) continue;
          processedGroupKey.add(groupKey);
          
          // Check if this group needs reprocessing:
          // Any user in the group has routes but no territory, or totalArea = 0 with routes
          let needsReprocess = false;
          for (const uid of groupIds) {
            const routeCount = await storage.getRouteCountByUserId(uid);
            const territoryCount = await storage.getTerritoryCountByUserId(uid);
            if (routeCount > 0 && territoryCount === 0) {
              needsReprocess = true;
              break;
            }
          }
          
          if (!needsReprocess) continue;
          
          // Process this friend group
          console.log(`[REPROCESS] Processing friend group: ${groupIds.length} users, trigger: ${user.name}`);
          await reprocessFriendGroupTerritoriesChronologically(storage, user.id);
          
          // Return result for this group only
          const groupResults: any[] = [];
          for (const uid of groupIds) {
            const u = await storage.getUser(uid);
            groupResults.push({
              userId: uid,
              name: u?.name || uid,
              totalArea: u?.totalArea || 0,
            });
          }
          
          return c.json({ 
            phase: 'reprocess', 
            action: 'processed_group',
            group: groupResults,
            message: 'Un grupo de amigos procesado. Ejecuta de nuevo si hay más.',
          });
        }
        
        // All groups done
        const results: any[] = [];
        for (const user of allUsers) {
          results.push({
            userId: user.id,
            name: user.name,
            totalArea: user.totalArea || 0,
          });
        }
        
        return c.json({ phase: 'reprocess', action: 'all_done', results });
      } catch (error: any) {
        return c.json({ error: error.message }, 500);
      }
    }

    // ===== PHASE: RESET =====
    // Resets all polar activities to unprocessed state (USE WITH CAUTION)
    if (phase === 'reset') {
      try {
        const userIds = await storage.getUsersWithPolarActivities();
        const resetResults: any[] = [];

        for (const userId of userIds) {
          const user = await storage.getUser(userId);
          const activities = await storage.getPolarActivitiesByUserId(userId);
          
          let resetCount = 0;
          for (const activity of activities) {
            await storage.updatePolarActivity(activity.id, {
              processed: false,
              processedAt: null,
              routeId: null,
              territoryId: null,
            });
            resetCount++;
          }

          // Delete all routes for this user (they'll be recreated from polar activities)
          await storage.deleteTerritoriesByUserId(userId);
          await storage.deleteAllRoutesByUserId(userId);
          await storage.deleteConquestMetricsByUserId(userId);
          await storage.updateUser(userId, { totalArea: 0 });

          resetResults.push({
            userId,
            userName: user?.name || userId,
            activitiesReset: resetCount,
          });
        }

        return c.json({ phase: 'reset', results: resetResults });
      } catch (error: any) {
        return c.json({ error: error.message }, 500);
      }
    }

    return c.json({ error: `Fase desconocida: ${phase}. Usa: diagnose, cleanup, process, reprocess, reset` }, 400);
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

  // Pending animation: returns the latest auto-imported activity ready for animation
  app.get('/api/polar/pending-animation/:userId', async (c) => {
    try {
      const userId = c.req.param('userId');
      const afterRouteId = c.req.query('after'); // client sends the last animated routeId
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);

      // Get processed activities from ALL sources (Polar + Strava) with routeId & polyline
      const polarActivities = await storage.getPolarActivitiesByUserId(userId);
      const stravaActivities = await storage.getStravaActivitiesByUserId(userId);

      const allProcessed = [
        ...polarActivities.filter(a => a.processed && a.routeId && a.summaryPolyline),
        ...stravaActivities.filter(a => a.processed && a.routeId && a.summaryPolyline),
      ].sort((a, b) => {
        // Sort chronologically (oldest first) so animations play in order
        const dateA = new Date(a.startDate).getTime();
        const dateB = new Date(b.startDate).getTime();
        return dateA - dateB;
      });

      if (allProcessed.length === 0) {
        return c.json({ pending: false });
      }

      // Skip past the last animated route, then return the next ready activity
      let foundAfter = !afterRouteId; // If no afterRouteId, start from the beginning
      for (const activity of allProcessed) {
        if (!foundAfter) {
          if (activity.routeId === afterRouteId) {
            foundAfter = true;
          }
          continue;
        }

        // Check if territory processing is done (feed event has metadata)
        const feedEvent = await storage.getFeedEventByRouteId(activity.routeId!);
        if (feedEvent && feedEvent.metadata) {
          return c.json({
            pending: true,
            routeId: activity.routeId,
            routeName: activity.name,
            summaryPolyline: activity.summaryPolyline,
            distance: activity.distance,
            duration: activity.duration,
          });
        }
      }

      return c.json({ pending: false });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // Conquest result polling endpoint (used by client after async queue processing)
  app.get('/api/conquest-result/:routeId', async (c) => {
    try {
      const routeId = c.req.param('routeId');
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const feedEvent = await storage.getFeedEventByRouteId(routeId);
      if (!feedEvent || !feedEvent.metadata) {
        // Feed event either doesn't exist yet, or exists as an early placeholder
        // (created with metadata=null before territory processing completes)
        return c.json({ ready: false });
      }
      // Parse metadata for victims and treasures
      let victims: any[] = [];
      let treasuresCollected: any[] = [];
      if (feedEvent.metadata) {
        try {
          const meta = JSON.parse(feedEvent.metadata);
          victims = meta.victims || [];
          treasuresCollected = meta.treasures || [];
        } catch (_) {}
      }
      return c.json({
        ready: true,
        newAreaConquered: feedEvent.newArea || 0,
        areaStolen: feedEvent.areaStolen || 0,
        distance: feedEvent.distance || 0,
        duration: feedEvent.duration || 0,
        victims,
        treasuresCollected,
      });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // --- Social Feed Endpoints ---

  // Get feed for a user (own + friends' events)
  app.get('/api/feed/:userId', async (c) => {
    try {
      const userId = c.req.param('userId');
      const limit = parseInt(c.req.query('limit') || '30');
      const offset = parseInt(c.req.query('offset') || '0');
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const events = await storage.getFeedForUser(userId, limit, offset);
      return c.json(events);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // Get comments for a feed event
  app.get('/api/feed/events/:eventId/comments', async (c) => {
    try {
      const eventId = c.req.param('eventId');
      const viewerUserId = c.req.query('userId') || undefined;
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const comments = await storage.getFeedEventComments(eventId, viewerUserId);
      return c.json(comments);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // Add a comment to a feed event
  app.post('/api/feed/events/:eventId/comments', async (c) => {
    try {
      const eventId = c.req.param('eventId');
      const { userId, content, parentId } = await c.req.json();

      if (!userId || !content || !content.trim()) {
        return c.json({ error: 'userId and content are required' }, 400);
      }
      if (content.length > 500) {
        return c.json({ error: 'Comment too long (max 500 chars)' }, 400);
      }

      const db = getDb(c.env);
      const storage = new WorkerStorage(db);

      const comment = await storage.addFeedComment({
        feedEventId: eventId,
        userId,
        content: content.trim(),
        parentId: parentId || null,
      });

      // Send push notifications (non-blocking)
      c.executionCtx.waitUntil((async () => {
        try {
          const { sendPushToUser } = await import('./pushHelper');
          const commenter = await storage.getUser(userId);
          const commenterName = commenter?.name || 'Alguien';
          const notifiedUserIds = new Set<string>([userId]); // track who we already notified

          // Notify event owner
          const event = await storage.getFeedEvent(eventId);
          if (event && event.userId !== userId) {
            notifiedUserIds.add(event.userId);
            const subs = await storage.getPushSubscriptionsByUserId(event.userId);
            if (subs.length > 0) {
              await sendPushToUser(
                subs.map(s => ({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } })),
                {
                  title: `💬 ${commenterName} comentó tu actividad`,
                  body: content.trim().substring(0, 100),
                  tag: 'feed-comment',
                  data: { url: '/activity', type: 'feed_comment' },
                },
                c.env.VAPID_PUBLIC_KEY || '',
                c.env.VAPID_PRIVATE_KEY || '',
                c.env.VAPID_SUBJECT || 'mailto:notifications@runna.io'
              );
            }
          }

          // Notify parent comment author for replies
          if (parentId) {
            const parentComment = await storage.getFeedCommentById(parentId);
            if (parentComment && !notifiedUserIds.has(parentComment.userId)) {
              notifiedUserIds.add(parentComment.userId);
              const subs = await storage.getPushSubscriptionsByUserId(parentComment.userId);
              if (subs.length > 0) {
                await sendPushToUser(
                  subs.map(s => ({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } })),
                  {
                    title: `💬 ${commenterName} respondió tu comentario`,
                    body: content.trim().substring(0, 100),
                    tag: 'feed-reply',
                    data: { url: '/activity', type: 'feed_reply' },
                  },
                  c.env.VAPID_PUBLIC_KEY || '',
                  c.env.VAPID_PRIVATE_KEY || '',
                  c.env.VAPID_SUBJECT || 'mailto:notifications@runna.io'
                );
              }
            }
          }

          // Notify @mentioned users
          const mentionRegex = /@([\w\u00C0-\u024F]+(?:\s[\w\u00C0-\u024F]+)?)/g;
          const mentions = [...content.matchAll(mentionRegex)].map((m: RegExpMatchArray) => m[1]);
          if (mentions.length > 0) {
            const friendIds = await storage.getFriendIds(userId);
            for (const friendId of friendIds) {
              const friend = await storage.getUser(friendId);
              if (!friend || notifiedUserIds.has(friend.id)) continue;
              const friendNameLower = friend.name?.toLowerCase() || '';
              const friendUsernameLower = friend.username?.toLowerCase() || '';
              const isMentioned = mentions.some((m: string) => {
                const ml = m.toLowerCase();
                return ml === friendNameLower || ml === friendUsernameLower;
              });
              if (isMentioned) {
                notifiedUserIds.add(friend.id);
                const subs = await storage.getPushSubscriptionsByUserId(friend.id);
                if (subs.length > 0) {
                  await sendPushToUser(
                    subs.map(s => ({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } })),
                    {
                      title: `📣 ${commenterName} te mencionó en un comentario`,
                      body: content.trim().substring(0, 100),
                      tag: 'feed-mention',
                      data: { url: '/activity', type: 'feed_mention' },
                    },
                    c.env.VAPID_PUBLIC_KEY || '',
                    c.env.VAPID_PRIVATE_KEY || '',
                    c.env.VAPID_SUBJECT || 'mailto:notifications@runna.io'
                  );
                }
              }
            }
          }
        } catch (e) {
          console.error('[FEED] Error sending comment notification:', e);
        }
      })());

      return c.json(comment);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // Delete a comment (only own comments)
  app.delete('/api/feed/comments/:commentId', async (c) => {
    try {
      const commentId = c.req.param('commentId');
      const { userId } = await c.req.json();
      if (!userId) {
        return c.json({ error: 'userId is required' }, 400);
      }
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const deleted = await storage.deleteFeedComment(commentId, userId);
      if (!deleted) {
        return c.json({ error: 'Comment not found or not yours' }, 404);
      }
      return c.json({ success: true });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // Toggle reaction (like/dislike) on a feed event or comment
  app.post('/api/feed/reactions', async (c) => {
    try {
      const { userId, targetType, targetId, reactionType } = await c.req.json();
      if (!userId || !targetType || !targetId || !reactionType) {
        return c.json({ error: 'userId, targetType, targetId, and reactionType are required' }, 400);
      }
      if (!['event', 'comment'].includes(targetType)) {
        return c.json({ error: 'targetType must be "event" or "comment"' }, 400);
      }
      if (!['like', 'dislike'].includes(reactionType)) {
        return c.json({ error: 'reactionType must be "like" or "dislike"' }, 400);
      }
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const result = await storage.toggleReaction(userId, targetType, targetId, reactionType);

      // Send push notification to the content owner (only for likes, not dislikes, and only if reaction was added)
      if (result.userReaction === reactionType) {
        try {
          let ownerId: string | null = null;
          if (targetType === 'event') {
            const event = await storage.getFeedEvent(targetId);
            if (event) ownerId = event.userId;
          } else if (targetType === 'comment') {
            const comment = await storage.getFeedCommentById(targetId);
            if (comment) ownerId = comment.userId;
          }
          if (ownerId && ownerId !== userId) {
            const { notifyReaction } = await import('./notifications');
            await notifyReaction(storage, userId, ownerId, reactionType, targetType, c.env);
          }
        } catch (notifErr) {
          console.error('[REACTION] Push notification error:', notifErr);
        }
      }

      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // Get preview comments for a feed event (top 3 prioritized)
  // Admin: Initialize feed tables (lightweight)
  app.post('/api/admin/init-feed-tables', async (c) => {
    try {
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      await storage.ensureFeedTables();
      return c.json({ success: true });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.get('/api/feed/events/:eventId/preview-comments', async (c) => {
    try {
      const eventId = c.req.param('eventId');
      const viewerUserId = c.req.query('userId') || '';
      const limit = parseInt(c.req.query('limit') || '3');
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const comments = await storage.getPreviewComments(eventId, viewerUserId, limit);
      return c.json(comments);
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

      // Check for color conflict - warn but don't block (they can change before accepting)
      const sender = await storage.getUser(userId);
      const recipient = await storage.getUser(friendId);
      let colorWarning = false;
      if (sender && recipient && sender.color.toUpperCase() === recipient.color.toUpperCase()) {
        colorWarning = true;
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

      return c.json({ success: true, requestId: request.id, colorWarning });
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

      // Auto-resolve color conflicts before creating friendship
      const colorResult = await resolveColorConflictOnFriendship(storage, request.senderId, userId);

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

      // Reprocess territories for the new friend group via queue
      // (Previously disabled due to CPU timeout - now offloaded to Cloudflare Queue)
      try {
        console.log(`[FRIEND ACCEPT] Enqueuing territory reprocess for new friends: ${request.senderId} <-> ${userId}`);
        await (c.env as any).TERRITORY_QUEUE.send({
          type: 'reprocess_friend_group',
          userId: request.senderId,
          friendUserId: userId,
        });
        console.log(`[FRIEND ACCEPT] Territory reprocess enqueued successfully`);
      } catch (queueErr) {
        console.error('[FRIEND ACCEPT] Failed to enqueue territory reprocess:', queueErr);
      }

      return c.json({ success: true, colorChanged: colorResult.changed, newColor: colorResult.newColor || null });
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

      // Check for active nickname
      let nicknameData: { nickname: string | null; nicknameExpiresAt: string | null } = { nickname: null, nicknameExpiresAt: null };
      try {
        const nn = await storage.getActiveNickname(userId);
        if (nn) nicknameData = { nickname: nn.nickname, nicknameExpiresAt: nn.expiresAt };
      } catch (_) {}

      const stats = {
        user: {
          id: user.id,
          name: user.name,
          username: user.username,
          avatar: user.avatar,
          color: user.color,
          nickname: nicknameData.nickname,
          nicknameExpiresAt: nicknameData.nicknameExpiresAt,
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
      // Batch-fetch active nicknames in a single query
      const nicknameMap = await storage.getActiveNicknamesForUsers(friends.map(f => f.id));
      const enriched = friends.map(f => {
        const nn = nicknameMap.get(f.id);
        return { ...f, nickname: nn?.nickname || null, nicknameExpiresAt: nn?.expiresAt || null };
      });
      return c.json(enriched);
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

      // Auto-resolve color conflicts before creating friendship
      const colorResult = await resolveColorConflictOnFriendship(storage, invite.userId, userId);

      await storage.createBidirectionalFriendship(invite.userId, userId);
      await storage.deleteFriendInvite(invite.id);

      // Send notification to the person who created the invite
      const { notifyFriendRequestAccepted } = await import('./notifications');
      await notifyFriendRequestAccepted(storage, invite.userId, userId, c.env);

      // Reprocess territories for the new friend group via queue
      try {
        console.log(`[FRIEND INVITE ACCEPT] Enqueuing territory reprocess for: ${invite.userId} <-> ${userId}`);
        await (c.env as any).TERRITORY_QUEUE.send({
          type: 'reprocess_friend_group',
          userId: invite.userId,
          friendUserId: userId,
        });
      } catch (queueErr) {
        console.error('[FRIEND INVITE ACCEPT] Failed to enqueue territory reprocess:', queueErr);
      }

      return c.json({ success: true, friendId: invite.userId, colorChanged: colorResult.changed, newColor: colorResult.newColor || null });
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

      const { sendPushNotification } = await import('./pushHelper');

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

      const results = [];
      for (const sub of pushSubs) {
        try {
          const ok = await sendPushNotification(
            sub,
            payload,
            c.env.VAPID_PUBLIC_KEY || '',
            c.env.VAPID_PRIVATE_KEY || '',
            c.env.VAPID_SUBJECT || 'mailto:notifications@runna.io'
          );
          results.push({ endpoint: sub.endpoint.slice(0, 60), success: ok });
        } catch (err: any) {
          results.push({ endpoint: sub.endpoint.slice(0, 60), success: false, error: err.message });
        }
      }

      return c.json({ success: true, subscriptionCount: subscriptions.length, results });
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

                // Auto-process: create route + enqueue territory processing + send notification
                const polyline = activity.map?.summary_polyline;
                if (polyline && activity.distance >= 100 && activity.moving_time >= 60) {
                  try {
                    const startDate = new Date(activity.start_date);
                    const COMP_PROCESS_MIN_DATE = new Date('2026-03-02T00:00:00Z');

                    if (startDate >= COMP_PROCESS_MIN_DATE) {
                      const decoded = decodePolyline(polyline);
                      const coordinates: Array<[number, number]> = decoded.map((coord: [number, number]) => [coord[0], coord[1]]);
                      const userId = stravaAccount.userId;

                      if (coordinates.length >= 10) {
                        const startedAt = startDate.toISOString();
                        const completedAt = new Date(startDate.getTime() + activity.moving_time * 1000).toISOString();

                        let route = await storage.findRouteByDateAndDistance(userId, startedAt, activity.distance);
                        if (!route) {
                          route = await storage.createRoute({
                            userId,
                            name: activity.name,
                            coordinates,
                            distance: activity.distance,
                            duration: activity.moving_time,
                            startedAt,
                            completedAt,
                          });
                        }

                        // Link strava activity to route
                        const savedActivity = await storage.getStravaActivityByStravaId(activity.id);
                        if (savedActivity) {
                          await storage.updateStravaActivity(savedActivity.id, { routeId: route.id });
                        }

                        // Create early feed event
                        let earlyFeedEventId: string | undefined;
                        try {
                          const existingFeed = await storage.getFeedEventByRouteId(route.id);
                          if (existingFeed) {
                            earlyFeedEventId = existingFeed.id;
                          } else {
                            const earlyFeedEvent = await storage.createFeedEvent({
                              userId,
                              eventType: 'activity',
                              routeId: route.id,
                              distance: activity.distance,
                              duration: activity.moving_time,
                              newArea: 0,
                              metadata: null,
                            });
                            earlyFeedEventId = earlyFeedEvent.id;
                          }
                        } catch (_) {}

                        // Enqueue territory processing via Cloudflare Queue
                        await c.env.TERRITORY_QUEUE.send({
                          type: 'process_route_territory',
                          userId,
                          routeId: route.id,
                          startedAt,
                          completedAt,
                          distance: activity.distance,
                          duration: activity.moving_time,
                          earlyFeedEventId,
                        });

                        // Mark as processed
                        if (savedActivity) {
                          await storage.updateStravaActivity(savedActivity.id, {
                            routeId: route.id,
                            processed: true,
                            processedAt: new Date(),
                          });
                        }

                        console.log(`[STRAVA WEBHOOK] ✅ Auto-processed activity ${activity.id} → route ${route.id}`);

                        // Send push notification
                        try {
                          const { sendPushToUser } = await import('./pushHelper');
                          const subscriptions = await storage.getPushSubscriptionsByUserId(userId);
                          if (subscriptions.length > 0) {
                            const distKm = (activity.distance / 1000).toFixed(1);
                            const pushSubs = subscriptions.map((sub: any) => ({
                              endpoint: sub.endpoint,
                              keys: { p256dh: sub.p256dh, auth: sub.auth },
                            }));
                            await sendPushToUser(
                              pushSubs,
                              {
                                title: '🏃 ¡Carrera registrada!',
                                body: `${activity.name} · ${distKm} km — Entra para ver tu conquista`,
                                tag: `strava-auto-${activity.id}`,
                                data: { type: 'strava_auto_import', routeId: route.id, url: '/?showPendingAnimation=true' },
                              },
                              (c.env as any).VAPID_PUBLIC_KEY || '',
                              (c.env as any).VAPID_PRIVATE_KEY || '',
                              (c.env as any).VAPID_SUBJECT || 'mailto:notifications@runna.io'
                            );
                          }
                        } catch (pushErr) {
                          console.warn(`[STRAVA WEBHOOK] Push notification failed:`, pushErr);
                        }
                      } else {
                        // Short route (<10 coords) — create route + feed event without territory
                        try {
                          const startedAt = startDate.toISOString();
                          const completedAt = new Date(startDate.getTime() + activity.moving_time * 1000).toISOString();
                          let shortRoute = await storage.findRouteByDateAndDistance(stravaAccount.userId, startedAt, activity.distance);
                          if (!shortRoute) {
                            shortRoute = await storage.createRoute({
                              userId: stravaAccount.userId,
                              name: activity.name,
                              coordinates,
                              distance: activity.distance,
                              duration: activity.moving_time,
                              startedAt,
                              completedAt,
                            });
                          }
                          await generateFeedEvents(storage, stravaAccount.userId, shortRoute.id, activity.distance, activity.moving_time, { newAreaConquered: 0, victims: [], ranTogetherWith: [] });
                          const savedActivity = await storage.getStravaActivityByStravaId(activity.id);
                          if (savedActivity) {
                            await storage.updateStravaActivity(savedActivity.id, { routeId: shortRoute.id, processed: true, processedAt: new Date() });
                          }
                        } catch (_) {}
                      }
                    }
                  } catch (autoErr) {
                    console.warn(`[STRAVA WEBHOOK] Auto-process failed for activity ${activity.id}:`, autoErr);
                    // Non-fatal: activity saved as unprocessed, can be processed manually later
                  }
                }
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
    const stravaProcessStart = Date.now();
    const STRAVA_MAX_PROCESSING_TIME = 25000; // 25s safety limit
    const STRAVA_BATCH_SIZE = 1; // Process 1 at a time like Polar
    
    try {
      const userId = c.req.param('userId');
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const unprocessed = await storage.getUnprocessedStravaActivities(userId);
      const results: any[] = [];

      console.log(`[STRAVA PROCESS] Starting - ${unprocessed.length} unprocessed for user ${userId}`);
      
      if (unprocessed.length === 0) {
        return c.json({ processed: 0, results: [], remaining: 0, message: 'No activities to process' });
      }

      const toBatch = unprocessed.slice(0, STRAVA_BATCH_SIZE);
      
      for (const activity of toBatch) {
        // Check timeout
        if (Date.now() - stravaProcessStart > STRAVA_MAX_PROCESSING_TIME) {
          console.warn(`[STRAVA PROCESS] Timeout approaching - stopping at ${results.length} processed`);
          break;
        }

        if (!activity.summaryPolyline) {
          await storage.updateStravaActivity(activity.id, { processed: true, processedAt: new Date() });
          continue;
        }

        try {
          const startDate = coerceDate(activity.startDate);
          if (!startDate) {
            console.log(`[STRAVA PROCESS] Skipping activity ${activity.id} - invalid start date`);
            await storage.updateStravaActivity(activity.id, { processed: true, processedAt: new Date() });
            continue;
          }

          const decoded = decodePolyline(activity.summaryPolyline);
          const coordinates: Array<[number, number]> = decoded.map((coord: [number, number]) => [coord[0], coord[1]]);

          if (coordinates.length >= 10) {
            const startedAtStr = startDate.toISOString();
            const completedAtStr = new Date(startDate.getTime() + activity.duration * 1000).toISOString();
            
            // ANTI-DUPLICATE: Check if a route with same date+distance already exists
            let route = await storage.findRouteByDateAndDistance(userId, startedAtStr, activity.distance);
            if (route) {
              console.log(`[STRAVA PROCESS] Found existing route by date+distance: ${route.id} - reusing`);
            } else {
              route = await storage.createRoute({
                userId: activity.userId,
                name: activity.name,
                coordinates,
                distance: activity.distance,
                duration: activity.duration,
                startedAt: startedAtStr,
                completedAt: completedAtStr,
              });
            }

            // Save routeId immediately
            await storage.updateStravaActivity(activity.id, { routeId: route.id });

            // CRITICAL: Create early feed event IMMEDIATELY so it exists even if territory processing
            // exhausts subrequests. We'll UPDATE it with conquest data later.
            let earlyFeedEventId: string | undefined;
            try {
              const existingFeed = await storage.getFeedEventByRouteId(route.id);
              if (existingFeed) {
                earlyFeedEventId = existingFeed.id;
                console.log(`[STRAVA] ♻️ Reusing existing feed event ${earlyFeedEventId} for route ${route.id}`);
              } else {
                const earlyFeedEvent = await storage.createFeedEvent({
                  userId,
                  eventType: 'activity',
                  routeId: route.id,
                  distance: activity.distance,
                  duration: activity.duration,
                  newArea: 0,
                  metadata: null,
                });
                earlyFeedEventId = earlyFeedEvent.id;
                console.log(`[STRAVA] ✅ Early feed event created: ${earlyFeedEventId} for route ${route.id}`);
              }
            } catch (earlyFeedErr) {
              console.error('[STRAVA] ❌ Early feed event creation failed:', earlyFeedErr);
            }

            const enclosedPoly = routeToEnclosedPolygon(coordinates, 150);

            if (enclosedPoly) {
              // Pass env=undefined to skip inline notifications (saves subrequests)
              const conquestResult = await processTerritoryConquest(
                storage,
                userId,
                route.id,
                enclosedPoly.geometry,
                undefined, // skip notifications to reduce subrequests
                startedAtStr,
                completedAtStr,
                coordinates
              );

              // Save ran together info to the route
              if (conquestResult.ranTogetherWith.length > 0) {
                await storage.updateRouteRanTogether(route.id, conquestResult.ranTogetherWith);
              }

              // Mark as processed BEFORE feed events
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
                  victims: conquestResult.victims,
                }
              });

              // Update early feed event with full conquest data
              try {
                await generateFeedEvents(storage, userId, route.id, activity.distance, activity.duration, conquestResult, false, earlyFeedEventId);
              } catch (feedErr) {
                console.warn(`[STRAVA PROCESS] Feed events update failed (early event already exists):`, feedErr);
              }
            } else {
              // No valid polygon — update early feed event with basic data
              try {
                await generateFeedEvents(storage, userId, route.id, activity.distance, activity.duration, { newAreaConquered: 0, victims: [], ranTogetherWith: [] }, false, earlyFeedEventId);
              } catch (feedErr) {
                console.warn('[STRAVA] Feed event update failed (early event already exists):', feedErr);
              }
              await storage.updateStravaActivity(activity.id, { 
                routeId: route.id, 
                processed: true, 
                processedAt: new Date() 
              });
            }
          } else {
            // Short route (<10 coords) — still create route + activity feed event
            try {
              const startedAtShort = startDate.toISOString();
              const completedAtShort = new Date(startDate.getTime() + activity.duration * 1000).toISOString();
              let shortRoute = await storage.findRouteByDateAndDistance(userId, startedAtShort, activity.distance);
              if (!shortRoute) {
                shortRoute = await storage.createRoute({
                  userId: activity.userId,
                  name: activity.name,
                  coordinates,
                  distance: activity.distance,
                  duration: activity.duration,
                  startedAt: startedAtShort,
                  completedAt: completedAtShort,
                });
              }
              await generateFeedEvents(storage, userId, shortRoute.id, activity.distance, activity.duration, { newAreaConquered: 0, victims: [], ranTogetherWith: [] });
              await storage.updateStravaActivity(activity.id, { routeId: shortRoute.id, processed: true, processedAt: new Date() });
            } catch (feedErr) {
              console.warn('[STRAVA] Short route feed event failed:', feedErr);
              await storage.updateStravaActivity(activity.id, { processed: true, processedAt: new Date() });
            }
          }
        } catch (err) {
          console.error('Error processing Strava activity:', err);
          await storage.updateStravaActivity(activity.id, { processed: true, processedAt: new Date() });
        }
      }

      const remaining = unprocessed.length - toBatch.length;
      const processingTime = Date.now() - stravaProcessStart;
      console.log(`[STRAVA PROCESS] Completed in ${processingTime}ms - ${results.length} processed, ${remaining} remaining`);

      return c.json({ 
        processed: results.length, 
        results, 
        remaining,
        processingTime,
        message: remaining > 0 ? `${results.length} procesadas, ${remaining} pendientes.` : `${results.length} procesadas correctamente`
      });
    } catch (error: any) {
      console.error('[STRAVA PROCESS] Critical error:', error);
      return c.json({ error: error.message, processed: 0, remaining: -1 }, 500);
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

      // Fetch recent activities from Strava (last 30 days) with pagination
      const after = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
      const STRAVA_MAX_PAGES = 3; // Max pages to fetch per invocation
      const DETAIL_FETCH_BUDGET = 10; // Max detail fetches to stay under subrequest limits
      const STRAVA_SYNC_TIMEOUT = 20000; // 20s safety limit
      const stravaSyncStart = Date.now();
      let detailFetchesUsed = 0;
      let imported = 0;
      let totalFetched = 0;
      let hasMore = false;

      for (let page = 1; page <= STRAVA_MAX_PAGES; page++) {
        // Check time limit
        if (Date.now() - stravaSyncStart > STRAVA_SYNC_TIMEOUT) {
          console.warn(`[STRAVA SYNC] Time limit reached — stopping at page ${page}`);
          hasMore = true;
          break;
        }

        const activitiesResponse = await fetch(
          `https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=50&page=${page}`,
          {
            headers: { 'Authorization': `Bearer ${validToken}` },
          }
        );

        if (!activitiesResponse.ok) {
          console.error('Failed to fetch Strava activities:', await activitiesResponse.text());
          if (page === 1) {
            return c.json({ error: 'Failed to fetch activities from Strava' }, 500);
          }
          break; // Partial success on subsequent pages
        }

        const stravaActivitiesList: any[] = await activitiesResponse.json();
        totalFetched += stravaActivitiesList.length;

        if (stravaActivitiesList.length === 0) break; // No more activities

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

          // Budget-limited detail fetch for GPS polyline
          if (detailFetchesUsed >= DETAIL_FETCH_BUDGET) {
            console.log(`[STRAVA SYNC] Detail fetch budget exhausted (${DETAIL_FETCH_BUDGET}), skipping remaining`);
            hasMore = true;
            break;
          }

          let summaryPolyline = null;
          try {
            detailFetchesUsed++;
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

          if (!summaryPolyline) {
            console.log(`Skipping activity ${activity.id} - no GPS data (polyline)`);
            continue;
          }

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

        // If less than 50 results, there are no more pages
        if (stravaActivitiesList.length < 50) break;
        hasMore = true; // There might be more pages
      }

      // Update last sync time
      await storage.updateStravaAccount(userId, { lastSyncAt: new Date() });

      return c.json({ imported, total: totalFetched, hasMore });
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

  // Reset a single skipped/failed activity for retry
  app.post('/api/polar/retry/:activityId', async (c) => {
    try {
      const activityId = c.req.param('activityId');
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const activity = await storage.resetPolarActivityForRetry(activityId);
      console.log(`[POLAR] Activity ${activityId} reset for retry (was skipReason: ${activity.skipReason})`);
      return c.json({ success: true, activity });
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

      // Trigger initial sync in background via waitUntil (properly registered with runtime)
      // Only trigger one sync (sync-full and sync are identical), wrapped in waitUntil to prevent
      // the promise being dropped when the response is sent.
      console.log('[BACKFILL] Triggering initial Polar sync via waitUntil...');
      const baseUrl = c.env.WORKER_URL || 'https://runna-io-api.runna-io-api.workers.dev';
      c.executionCtx.waitUntil(
        new Promise<void>(resolve => setTimeout(resolve, 2000)).then(() =>
          fetch(`${baseUrl}/api/polar/sync/${userId}`, { method: 'POST' })
            .then(res => console.log(`[BACKFILL] Initial sync triggered: ${res.status}`))
            .catch(err => console.error('[BACKFILL] Initial sync failed:', err))
        )
      );

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
  // SAFETY: Bounded by MAX_EXERCISES and MAX_SYNC_TIME to prevent Cloudflare Worker timeout/subrequest saturation.
  const syncPolarExercisesDirect = async (
    polarAccount: { polarUserId: number; accessToken: string },
    userId: string,
    storage: WorkerStorage
  ) => {
    console.log('[DIRECT SYNC] Using non-transactional GET /v3/exercises endpoint...');
    const syncStartTime = Date.now();
    const MAX_SYNC_TIME = 20000; // 20s safety limit
    const MAX_EXERCISES = 10; // Max exercises to process per invocation (reduced from 15 to stay under subrequest limit)
    const GPX_FETCH_BUDGET = 5; // Max external GPX fetches to stay under subrequest limits
    let gpxFetchesUsed = 0;
    
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
      let processed = 0;
      let stoppedEarly = false;

      for (const exercise of exercises) {
        // SAFETY: Check time limit (always applies)
        if (Date.now() - syncStartTime > MAX_SYNC_TIME) {
          console.warn(`[DIRECT SYNC] ⏱️ Time limit reached (${MAX_SYNC_TIME}ms) — stopping at ${processed} exercises`);
          stoppedEarly = true;
          break;
        }

        const exerciseId = exercise.id;
        if (!exerciseId) {
          console.warn('[DIRECT SYNC] Exercise without id, skipping');
          skipped++;
          continue;
        }

        // FAST PATH: Check if already imported or permanently skipped (costs 1 DB read, doesn't count against limit)
        const existing = await storage.getPolarActivityByPolarId(exerciseId.toString());
        if (existing) {
          if (!existing.skipReason) {
            console.log(`[DIRECT SYNC]    ⏭️  Already imported: ${exerciseId}`);
            skipped++;
            continue;
          }
          const permanentSkipReasons = ['before_competition', 'excluded_type'];
          if (permanentSkipReasons.includes(existing.skipReason)) {
            // Permanently skipped — don't count against exercise limit
            skipped++;
            continue;
          }
        }

        // This exercise needs real processing — NOW check the exercise limit
        if (processed >= MAX_EXERCISES) {
          console.warn(`[DIRECT SYNC] 📊 Exercise limit reached (${MAX_EXERCISES}) — stopping`);
          stoppedEarly = true;
          break;
        }
        processed++;

        try {
          console.log(`\n[DIRECT SYNC] 📍 Exercise: ${exerciseId}`);

          // If existing had a fixable skip reason, re-evaluate
          if (existing && existing.skipReason) {
            console.log(`[DIRECT SYNC]    🔄 Previously skipped (${existing.skipReason}), re-evaluating`);
            await storage.deletePolarActivityById(existing.id);
          }

          // Also check by attributes to avoid duplicates from different ID formats
          // (transactional API uses numeric IDs, non-transactional uses hashed IDs)
          const startTimeRaw = exercise.start_time;
          if (!existing && startTimeRaw) {
            const dupCheck = await storage.findPolarActivityByAttributes(
              userId,
              Number(exercise.distance) || 0,
              new Date(startTimeRaw).toISOString()
            );
            if (dupCheck && !dupCheck.skipReason) {
              console.log(`[DIRECT SYNC]    ⏭️  Already imported (by attributes match: ${dupCheck.id})`);
              skipped++;
              continue;
            }
            // Only re-evaluate fixable skip reasons
            if (dupCheck && dupCheck.skipReason) {
              const permanentSkipReasons = ['before_competition', 'excluded_type'];
              if (permanentSkipReasons.includes(dupCheck.skipReason)) {
                console.log(`[DIRECT SYNC]    ⏭️  Permanently skipped by attributes (${dupCheck.skipReason})`);
                skipped++;
                continue;
              }
              console.log(`[DIRECT SYNC]    🔄 Attribute match was skipped (${dupCheck.skipReason}), re-evaluating`);
              await storage.deletePolarActivityById(dupCheck.id);
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

          console.log(`[DIRECT SYNC]    Sport: "${sport}" | Distance: ${distance}m | Duration: ${duration}s | Start: ${startTime}`);

          // Helper: save a skipped activity to DB so it won't be re-fetched
          const saveSkipped = async (reason: string) => {
            const startDateISO = startTime ? new Date(startTime).toISOString() : new Date().toISOString();
            await storage.createPolarActivity({
              polarExerciseId: exerciseId.toString(),
              userId,
              routeId: null,
              territoryId: null,
              name: `${sport || 'Actividad'} (${(distance / 1000).toFixed(2)}km)`,
              activityType: sport || 'unknown',
              distance,
              duration,
              startDate: startDateISO,
              summaryPolyline: null,
              processed: true,
              processedAt: new Date().toISOString(),
              skipReason: reason,
            });
            console.log(`[DIRECT SYNC]    💾 Saved as skipped: ${reason}`);
          };

          // COMPETITION FILTER: Skip activities before competition start date
          const COMPETITION_MIN_DATE = '2026-03-02T00:00:00Z';
          if (startTime) {
            const activityDate = new Date(startTime);
            if (activityDate < new Date(COMPETITION_MIN_DATE)) {
              console.log(`[DIRECT SYNC]    ❌ Activity before competition start (${startTime})`);
              await saveSkipped('before_competition');
              skipped++;
              continue;
            }
          }

          const excludeTypes = ['sleep', 'rest', 'pause', 'meditation', 'breathing'];
          const isExcluded = excludeTypes.some(t => activityType.includes(t));

          if (isExcluded) {
            console.log(`[DIRECT SYNC]    ❌ Excluded type (${sport})`);
            await saveSkipped('excluded_type');
            skipped++;
            continue;
          }

          if (distance < 100) {
            console.log(`[DIRECT SYNC]    ❌ Distance too short (${distance}m)`);
            await saveSkipped('distance_too_short');
            skipped++;
            continue;
          }

          if (duration < 60) {
            console.log(`[DIRECT SYNC]    ❌ Duration too short (${duration}s)`);
            await saveSkipped('duration_too_short');
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

          // Fallback: try GPX endpoint if no inline route (budget-limited)
          if (!summaryPolyline && gpxFetchesUsed < GPX_FETCH_BUDGET) {
            try {
              gpxFetchesUsed++;
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
          } else if (!summaryPolyline && gpxFetchesUsed >= GPX_FETCH_BUDGET) {
            console.log(`[DIRECT SYNC]    ⏭️ GPX budget exhausted (${GPX_FETCH_BUDGET}), skipping GPX fetch`);
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

          console.log(`[DIRECT SYNC]    ✅ IMPORTED!${!summaryPolyline ? ' (no GPS, auto-processed)' : ''}`);
          imported++;
        } catch (e) {
          console.error(`[DIRECT SYNC]    ❌ Error: ${e}`);
          errors++;
        }
      }

      const remaining = stoppedEarly ? exercises.length - processed : 0;
      console.log(`\n[DIRECT SYNC] 📊 RESULT: ${imported} imported, ${skipped} skipped, ${errors} errors out of ${exercises.length} total (processed ${processed}, remaining ~${remaining})`);
      return {
        imported,
        total: exercises.length,
        skipped,
        errors,
        remaining,
        message: `${imported} importadas de ${exercises.length} (direct sync)${stoppedEarly ? ` — parado temprano, ~${remaining} pendientes` : ''}`,
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

      // Rebuild territories after delete.
      // SAFETY: Only reprocess the affected user to avoid CPU timeout (error 1102).
      try {
        console.log('[DELETE] Reprocessing user territories only (safe mode)');
        await reprocessUserTerritories(storage, userId);
      } catch (e) {
        console.error('Error reprocessing territories after delete:', e);
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
      const body = await c.req.json().catch(() => ({}));
      const requestedActivityId = body?.activityId || null; // Client can request a specific activity
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const unprocessed = await storage.getUnprocessedPolarActivities(userId);
      
      console.log(`[PROCESS] Starting - ${unprocessed.length} unprocessed Polar activities for user ${userId}${requestedActivityId ? ` (requested: ${requestedActivityId})` : ''}`);
      
      if (unprocessed.length === 0) {
        return c.json({ processed: 0, results: [], message: 'No activities to process' });
      }

      const results: any[] = [];
      
      // If a specific activityId was requested, process only that one
      // Otherwise fall back to the newest unprocessed (batch=1)
      let toBatch: typeof unprocessed;
      if (requestedActivityId) {
        const requested = unprocessed.find(a => a.id === requestedActivityId);
        if (!requested) {
          // Activity not found or already processed — check if it exists at all
          console.log(`[PROCESS] Requested activity ${requestedActivityId} not in unprocessed list, may already be processed`);
          return c.json({ processed: 0, results: [], message: 'Activity already processed or not found' });
        }
        toBatch = [requested];
      } else {
        const BATCH_SIZE = 1;
        toBatch = unprocessed.slice(0, BATCH_SIZE);
      }
      
      console.log(`[PROCESS] Processing batch of ${toBatch.length} activities (${unprocessed.length - toBatch.length} remaining)`);

      for (const activity of toBatch) {
        // Check timeout
        if (Date.now() - startTime > MAX_PROCESSING_TIME) {
          console.warn(`[PROCESS] Timeout approaching - stopping at ${results.length} processed`);
          break;
        }

        if (!activity.summaryPolyline) {
          console.log(`[PROCESS] Skipping activity ${activity.id} - no GPS data`);
          await storage.updatePolarActivity(activity.id, { processed: true, processedAt: new Date(), skipReason: 'no_gps' });
          continue;
        }

        let route: Route | null = null;
        try {
          console.log(`[PROCESS] Processing activity ${activity.id}: ${activity.name}`);
          const startDate = coerceDate(activity.startDate);
          if (!startDate) {
            console.log(`[PROCESS] Skipping activity ${activity.id} - invalid start date`);
            await storage.updatePolarActivity(activity.id, { processed: true, processedAt: new Date(), skipReason: 'bad_date' });
            continue;
          }

          // COMPETITION FILTER: Skip activities before competition start date
          const COMP_PROCESS_MIN_DATE = new Date('2026-03-02T00:00:00Z');
          if (startDate < COMP_PROCESS_MIN_DATE) {
            console.log(`[PROCESS] Skipping activity ${activity.id} - before competition start (${startDate.toISOString()})`);
            await storage.updatePolarActivity(activity.id, { processed: true, processedAt: new Date(), skipReason: 'before_competition' });
            continue;
          }

          const decoded = decodePolyline(activity.summaryPolyline);
          const coordinates: Array<[number, number]> = decoded.map((coord: [number, number]) => [coord[0], coord[1]]);

          if (coordinates.length < 10) {
            console.log(`[PROCESS] Short Polar activity ${activity.id} (${coordinates.length} coords) — creating route + feed event without territory`);
            try {
              const startedAtShort = startDate.toISOString();
              const completedAtShort = new Date(startDate.getTime() + activity.duration * 1000).toISOString();
              let shortRoute = await storage.findRouteByDateAndDistance(userId, startedAtShort, activity.distance);
              if (!shortRoute) {
                shortRoute = await storage.createRoute({
                  userId: activity.userId,
                  name: activity.name,
                  coordinates,
                  distance: activity.distance,
                  duration: activity.duration,
                  startedAt: startedAtShort,
                  completedAt: completedAtShort,
                });
              }
              await generateFeedEvents(storage, userId, shortRoute.id, activity.distance, activity.duration, { newAreaConquered: 0, victims: [], ranTogetherWith: [] });
              await storage.updatePolarActivity(activity.id, { routeId: shortRoute.id, processed: true, processedAt: new Date() });
            } catch (feedErr) {
              console.warn('[POLAR] Short route feed event failed:', feedErr);
              await storage.updatePolarActivity(activity.id, { processed: true, processedAt: new Date() });
            }
            continue;
          }

          console.log(`[PROCESS] Creating route for activity ${activity.id}`);
          const startedAtStr = startDate.toISOString();
          const completedAtStr = new Date(startDate.getTime() + activity.duration * 1000).toISOString();

          // Check if the activity already has a route (from a previous partial processing)
          if (activity.routeId) {
            route = await storage.getRouteById(activity.routeId);
            if (route) {
              console.log(`[PROCESS] Reusing existing route ${route.id} for activity ${activity.id}`);
            }
          }
          // ANTI-DUPLICATE: Check if a route with same date+distance already exists
          if (!route) {
            route = await storage.findRouteByDateAndDistance(userId, startedAtStr, activity.distance);
            if (route) {
              console.log(`[PROCESS] Found existing route by date+distance: ${route.id} - reusing to avoid duplicate`);
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

          // CRITICAL: Create early feed event IMMEDIATELY so it exists even if territory processing
          // exhausts subrequests. We'll UPDATE it with conquest data later.
          let earlyFeedEventId: string | undefined;
          try {
            const existingFeed = await storage.getFeedEventByRouteId(route.id);
            if (existingFeed) {
              earlyFeedEventId = existingFeed.id;
              console.log(`[PROCESS] ♻️ Reusing existing feed event ${earlyFeedEventId} for route ${route.id}`);
            } else {
              const earlyFeedEvent = await storage.createFeedEvent({
                userId,
                eventType: 'activity',
                routeId: route.id,
                distance: activity.distance,
                duration: activity.duration,
                newArea: 0,
                metadata: null,
              });
              earlyFeedEventId = earlyFeedEvent.id;
              console.log(`[PROCESS] ✅ Early feed event created: ${earlyFeedEventId} for route ${route.id}`);
            }
          } catch (earlyFeedErr) {
            console.error('[PROCESS] ❌ Early feed event creation failed:', earlyFeedErr);
          }

          // Enqueue territory processing via Cloudflare Queue (same as native POST /api/routes)
          // The queue consumer has its own 30s CPU budget, avoiding subrequest limits
          let queued = false;
          try {
            await c.env.TERRITORY_QUEUE.send({
              type: 'process_route_territory',
              userId,
              routeId: route.id,
              startedAt: startedAtStr,
              completedAt: completedAtStr,
              distance: activity.distance,
              duration: activity.duration,
              earlyFeedEventId,
            });
            queued = true;
            console.log(`[PROCESS] ✅ Enqueued territory processing for route ${route.id}`);
          } catch (queueErr) {
            console.error(`[PROCESS] ❌ Queue enqueue failed:`, queueErr);
          }

          // Mark as processed — territory will be handled by queue consumer
          await storage.updatePolarActivity(activity.id, { 
            routeId: route.id, 
            processed: true, 
            processedAt: new Date() 
          });

          results.push({
            activityId: activity.id,
            routeId: route.id,
            queued,
          });

          console.log(`[PROCESS] ✅ Activity ${activity.id} processed and queued for territory`);
        } catch (e) {
          console.error(`[PROCESS] ❌ Error processing activity ${activity.id}:`, e);
          // Only mark as processed if route was created — otherwise allow retry
          if (route?.id) {
            await storage.updatePolarActivity(activity.id, { routeId: route.id, processed: true, processedAt: new Date() });
          }
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

  // ==================== COROS ====================
  // NOTE: Implementation requires COROS API credentials and documentation
  // Apply for API access at: https://coros.com/api
  // Once approved, update env vars: COROS_CLIENT_ID, COROS_CLIENT_SECRET

  app.get('/api/coros/status/:userId', async (c) => {
    try {
      const userId = c.req.param('userId');
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const corosAccount = await storage.getCorosAccountByUserId(userId);
      
      if (corosAccount) {
        const stats = await storage.getCorosActivityStats(userId);
        return c.json({
          connected: true,
          corosOpenId: corosAccount.corosOpenId,
          lastSyncAt: corosAccount.lastSyncAt,
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

  app.get('/api/coros/connect', async (c) => {
    try {
      const userId = c.req.query('userId');
      const COROS_CLIENT_ID = c.env.COROS_CLIENT_ID;
      const COROS_REDIRECT_URI = `${c.env.WORKER_URL || 'https://runna-io-api.runna-io-api.workers.dev'}/api/coros/callback`;

      if (!userId || !COROS_CLIENT_ID) {
        return c.json({ error: "userId required and COROS not configured" }, 400);
      }

      const state = btoa(JSON.stringify({ userId, ts: Date.now() }));
      
      // TODO: Update with actual COROS OAuth URL from API documentation
      const authUrl = `https://open.coros.com/oauth2/authorize?client_id=${COROS_CLIENT_ID}&redirect_uri=${encodeURIComponent(COROS_REDIRECT_URI)}&response_type=code&state=${state}`;
      
      return c.json({ authUrl });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.get('/api/coros/callback', async (c) => {
    const FRONTEND_URL = c.env.FRONTEND_URL || 'https://runna-io.pages.dev';
    
    try {
      const code = c.req.query('code');
      const state = c.req.query('state');
      const authError = c.req.query('error');
      const COROS_CLIENT_ID = c.env.COROS_CLIENT_ID;
      const COROS_CLIENT_SECRET = c.env.COROS_CLIENT_SECRET;
      
      if (authError) {
        return c.redirect(`${FRONTEND_URL}/?coros_error=denied`);
      }
      
      if (!code || !state || !COROS_CLIENT_ID || !COROS_CLIENT_SECRET) {
        return c.redirect(`${FRONTEND_URL}/?coros_error=invalid`);
      }

      let userId: string;
      try {
        const decoded = JSON.parse(atob(state));
        userId = decoded.userId;
      } catch {
        return c.redirect(`${FRONTEND_URL}/?coros_error=invalid_state`);
      }

      // TODO: Update with actual COROS token exchange endpoint from API documentation
      const tokenResponse = await fetch('https://open.coros.com/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: COROS_CLIENT_ID,
          client_secret: COROS_CLIENT_SECRET,
          code: code,
          grant_type: 'authorization_code',
        }),
      });

      if (!tokenResponse.ok) {
        console.error('COROS token exchange failed:', await tokenResponse.text());
        return c.redirect(`${FRONTEND_URL}/?coros_error=token_exchange`);
      }

      const tokenData: any = await tokenResponse.json();
      // TODO: Update field names based on actual COROS API response
      const { access_token, refresh_token, expires_in, openId } = tokenData;

      const db = getDb(c.env);
      const storage = new WorkerStorage(db);

      const existingAccount = await storage.getCorosAccountByOpenId(openId);
      if (existingAccount && existingAccount.userId !== userId) {
        return c.redirect(`${FRONTEND_URL}/?coros_error=already_linked`);
      }

      const expiresAt = expires_in ? new Date(Date.now() + expires_in * 1000) : null;
      const corosAccountData = {
        userId,
        corosOpenId: openId,
        accessToken: access_token,
        refreshToken: refresh_token,
        expiresAt,
        lastSyncAt: null,
      };

      if (existingAccount) {
        await storage.updateCorosAccount(userId, corosAccountData);
      } else {
        await storage.createCorosAccount(corosAccountData);
      }

      return c.redirect(`${FRONTEND_URL}/?coros_connected=true`);
    } catch (error: any) {
      console.error('COROS callback error:', error);
      return c.redirect(`${FRONTEND_URL}/?coros_error=server`);
    }
  });

  app.post('/api/coros/disconnect', async (c) => {
    try {
      const body = await c.req.json();
      const { userId } = body;
      if (!userId) {
        return c.json({ error: "userId required" }, 400);
      }

      const db = getDb(c.env);
      const storage = new WorkerStorage(db);

      const corosAccount = await storage.getCorosAccountByUserId(userId);
      if (!corosAccount) {
        return c.json({ error: "COROS account not connected" }, 404);
      }

      await storage.deleteCorosAccount(userId);
      return c.json({ success: true });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.post('/api/coros/webhook', async (c) => {
    try {
      const body = await c.req.json();
      console.log('[COROS WEBHOOK] Received data:', JSON.stringify(body));
      
      // TODO: Implement based on COROS webhook format from API documentation
      // Expected flow:
      // 1. Validate webhook signature if required
      // 2. Extract workout data (openId, workoutId, activity type, GPS data, etc.)
      // 3. Look up user by corosOpenId
      // 4. Create CorosActivity record with processed=0
      // 5. Optionally trigger processing immediately or let manual process handle it
      
      return c.json({ received: true }, 200);
    } catch (error: any) {
      console.error('COROS webhook error:', error);
      return c.json({ error: error.message }, 500);
    }
  });

  app.get('/api/coros/activities/:userId', async (c) => {
    try {
      const userId = c.req.param('userId');
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      
      const activities = await storage.getCorosActivitiesByUserId(userId);
      return c.json({ activities });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.delete('/api/coros/activities/:userId/:activityId', async (c) => {
    try {
      const userId = c.req.param('userId');
      const activityId = c.req.param('activityId');
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);

      const activity = await storage.getCorosActivityById(activityId);
      if (!activity || activity.userId !== userId) {
        return c.json({ error: "Activity not found or unauthorized" }, 404);
      }

      // Delete associated route and territory if exists
      if (activity.routeId) {
        await storage.deleteRoute(activity.routeId);
      }
      if (activity.territoryId) {
        await storage.deleteTerritory(activity.territoryId);
      }

      await storage.deleteCorosActivity(activityId);
      return c.json({ success: true });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.post('/api/coros/process/:userId', async (c) => {
    try {
      const userId = c.req.param('userId');
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);

      // Get unprocessed activities
      const activities = await storage.getUnprocessedCorosActivities(userId);
      
      let processed = 0;
      let skipped = 0;
      const errors: string[] = [];

      for (const activity of activities) {
        try {
          if (!activity.summaryPolyline) {
            await storage.markCorosActivityProcessed(activity.id, null, null, 'no_gps');
            skipped++;
            continue;
          }

          // Decode polyline and create route
          const route = await storage.createRoute({
            userId,
            name: activity.name,
            distance: activity.distance,
            duration: activity.duration,
            gpxData: activity.summaryPolyline,
            sourceType: 'coros',
            sourceId: activity.id,
            createdAt: new Date(activity.startDate),
          });

          // Create territory from route (50m buffer)
          const routeCoords = JSON.parse(route.gpxData);
          const lineString = turf.lineString(routeCoords);
          const buffered = turf.buffer(lineString, 0.05, { units: 'kilometers' });
          
          const territory = await storage.createTerritory({
            userId,
            routeId: route.id,
            geometry: JSON.stringify(buffered.geometry),
            area: turf.area(buffered),
            createdAt: new Date(activity.startDate),
          });

          // Handle territory overlaps and stealing
          await storage.handleTerritoryOverlaps(territory.id, userId);

          // Mark activity as processed
          await storage.markCorosActivityProcessed(activity.id, route.id, territory.id, null);
          processed++;
        } catch (err: any) {
          console.error(`[COROS] Failed to process activity ${activity.id}:`, err);
          await storage.markCorosActivityProcessed(activity.id, null, null, err.message);
          errors.push(`${activity.name}: ${err.message}`);
        }
      }

      return c.json({ processed, skipped, errors, total: activities.length });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
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
            const areaText = areaStolen ? formatAreaNotification(areaStolen) : null;
            const bodyText = areaText 
              ? `${sender.name} te ha robado ${areaText} y te ha enviado una foto` 
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

  // ============ COMPETITION SYSTEM ============

  // Competition name constant
  const COMPETITION_NAME = 'La Primera Conquista del Ebro';
  const COMPETITION_SLUG = 'la-primera-conquista-del-ebro';
  const COMPETITION_START = '2026-03-02T09:00:00+01:00'; // Monday March 2, 9AM CET
  const COMPETITION_END = '2026-03-30T23:59:59+02:00'; // March 30

  // Zaragoza bounding box for treasure spawning (walkable/runnable areas)
  const ZARAGOZA_BOUNDS = {
    minLat: 41.6200, maxLat: 41.6900,
    minLng: -0.9300, maxLng: -0.8400,
  };

  // Zaragoza street-level spawn points (pre-defined on roads/paths within the city)
  const ZARAGOZA_SPAWN_POINTS: Array<{ lat: number; lng: number; zone: string }> = [
    // Centro histórico
    { lat: 41.6560, lng: -0.8773, zone: 'Plaza del Pilar' },
    { lat: 41.6542, lng: -0.8817, zone: 'Calle Alfonso I' },
    { lat: 41.6530, lng: -0.8770, zone: 'El Tubo' },
    { lat: 41.6518, lng: -0.8839, zone: 'Plaza España' },
    { lat: 41.6575, lng: -0.8782, zone: 'Paseo Echegaray' },
    // Parque Grande / Ribera
    { lat: 41.6370, lng: -0.8870, zone: 'Parque Grande' },
    { lat: 41.6400, lng: -0.8830, zone: 'Cabezo Buenavista' },
    { lat: 41.6350, lng: -0.8780, zone: 'Jardín Botánico' },
    { lat: 41.6420, lng: -0.8920, zone: 'Paseo Sagasta' },
    // Expo / Ribera norte
    { lat: 41.6620, lng: -0.9080, zone: 'Expo Zaragoza' },
    { lat: 41.6630, lng: -0.8970, zone: 'Puente del Tercer Milenio' },
    { lat: 41.6600, lng: -0.8850, zone: 'Puente de Piedra' },
    // Delicias / Romareda
    { lat: 41.6480, lng: -0.9070, zone: 'Estación Delicias' },
    { lat: 41.6430, lng: -0.9000, zone: 'Parque Delicias' },
    { lat: 41.6400, lng: -0.8950, zone: 'Romareda' },
    // Actur / Universidad
    { lat: 41.6700, lng: -0.8760, zone: 'Campus Río Ebro' },
    { lat: 41.6680, lng: -0.8880, zone: 'Actur' },
    { lat: 41.6650, lng: -0.8650, zone: 'Parque del Agua' },
    // La Almozara / Casablanca
    { lat: 41.6550, lng: -0.9100, zone: 'La Almozara' },
    { lat: 41.6320, lng: -0.8910, zone: 'Casablanca' },
    // San José / Las Fuentes
    { lat: 41.6520, lng: -0.8650, zone: 'Las Fuentes' },
    { lat: 41.6490, lng: -0.8700, zone: 'Parque Bruil' },
    // Valdespartera / Arcosur
    { lat: 41.6250, lng: -0.9050, zone: 'Valdespartera' },
    { lat: 41.6280, lng: -0.8850, zone: 'Pinares de Venecia' },
    // Arrabal / Jesús
    { lat: 41.6610, lng: -0.8730, zone: 'Arrabal' },
    { lat: 41.6460, lng: -0.8660, zone: 'Barrio Jesús' },
    // Torrero / Canal Imperial
    { lat: 41.6340, lng: -0.8730, zone: 'Canal Imperial' },
    { lat: 41.6310, lng: -0.8800, zone: 'Torrero' },
    // Montecanal / Rosales
    { lat: 41.6260, lng: -0.8970, zone: 'Montecanal' },
    { lat: 41.6290, lng: -0.9100, zone: 'Rosales del Canal' },
  ];

  // Treasure power definitions
  const TREASURE_POWERS = {
    shield: { name: 'Escudo de Acero', rarity: 'rare', description: 'Tu siguiente territorio es inmune a robos durante 24h', color: '#7C8CA1', emoji: '🛡️' },
    double_area: { name: 'Doble Conquista', rarity: 'epic', description: 'Los km² de tu siguiente ruta cuentan x2', color: '#F59E0B', emoji: '⚡' },
    nickname: { name: 'Pluma del Troll', rarity: 'common', description: 'Pon un apodo público a otro usuario durante 48h', color: '#CD7F32', emoji: '✏️' },
    steal_boost: { name: 'Espada Voraz', rarity: 'epic', description: 'Robas un 50% más de lo normal en tu siguiente ruta', color: '#F59E0B', emoji: '⚔️' },
    invisibility: { name: 'Capa de Sombras', rarity: 'legendary', description: 'Tu territorio es invisible en el mapa para otros durante 24h', color: '#8B5CF6', emoji: '👻' },
    time_bomb: { name: 'Bomba Temporal', rarity: 'rare', description: 'El que te robe en las próximas 24h pierde el doble', color: '#7C8CA1', emoji: '💣' },
    magnet: { name: 'Imán de Tierras', rarity: 'legendary', description: 'Tu siguiente ruta absorbe un 25% extra de territorios en su radio', color: '#8B5CF6', emoji: '🧲' },
    reveal: { name: 'Ojo del Halcón', rarity: 'common', description: 'Revela la ubicación del siguiente tesoro 1h antes', color: '#CD7F32', emoji: '🦅' },
    bulldozer: { name: 'El Arrasador', rarity: 'epic', description: 'Tu siguiente ruta ignora TODAS las fortalezas enemigas', color: '#F59E0B', emoji: '🚜' },
    battering_ram: { name: 'Ariete de Guerra', rarity: 'legendary', description: 'Tu siguiente ruta tiene fuerza ×3: cada pasada rompe 3 capas de fortaleza', color: '#8B5CF6', emoji: '🪓' },
    wall: { name: 'Muralla Imparable', rarity: 'rare', description: 'Durante 24h, cada carrera fortalece el doble (+1.0 en vez de +0.5)', color: '#7C8CA1', emoji: '🧱' },
    sentinel: { name: 'Centinela', rarity: 'epic', description: 'Durante 24h, recibes notificación instantánea cuando alguien intenta robar tu territorio', color: '#F59E0B', emoji: '🔔' },
  };

  // Rarity weights for random treasure spawning (ratio legendary:epic:rare:common = 1:1.1:1.2:1.3)
  const RARITY_WEIGHTS = [
    { rarity: 'common', powers: ['nickname', 'reveal'], weight: 13 },
    { rarity: 'rare', powers: ['shield', 'time_bomb', 'wall'], weight: 12 },
    { rarity: 'epic', powers: ['double_area', 'steal_boost', 'bulldozer', 'sentinel'], weight: 11 },
    { rarity: 'legendary', powers: ['invisibility', 'magnet', 'battering_ram'], weight: 10 },
  ];

  function pickRandomTreasure(): { powerType: string; rarity: string; name: string } {
    const totalWeight = RARITY_WEIGHTS.reduce((sum, r) => sum + r.weight, 0);
    let roll = Math.random() * totalWeight;
    for (const tier of RARITY_WEIGHTS) {
      roll -= tier.weight;
      if (roll <= 0) {
        const pow = tier.powers[Math.floor(Math.random() * tier.powers.length)];
        const info = TREASURE_POWERS[pow as keyof typeof TREASURE_POWERS];
        return { powerType: pow, rarity: tier.rarity, name: info.name };
      }
    }
    return { powerType: 'nickname', rarity: 'common', name: 'Pluma del Troll' };
  }

  function pickRandomSpawnPoint(): { lat: number; lng: number; zone: string } {
    // Add slight randomness (±100m) to avoid exact same spots every time
    const base = ZARAGOZA_SPAWN_POINTS[Math.floor(Math.random() * ZARAGOZA_SPAWN_POINTS.length)];
    const jitterLat = (Math.random() - 0.5) * 0.002; // ~100m
    const jitterLng = (Math.random() - 0.5) * 0.002;
    return {
      lat: base.lat + jitterLat,
      lng: base.lng + jitterLng,
      zone: base.zone,
    };
  }

  // isCompetitionActive and isCompetitionUpcoming are now module-level functions (above registerRoutes)
  // so they are accessible from processTerritoryConquest and other module-level functions

  // GET /api/competition/active — Public: returns competition state for UI
  app.get('/api/competition/active', async (c) => {
    try {
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const comp = await storage.getActiveCompetition();
      if (!comp) {
        return c.json({ competition: null, status: 'no_competition', state: 'none' });
      }
      const now = Date.now();
      const start = new Date(comp.startsAt).getTime();
      const end = new Date(comp.endsAt).getTime();
      let status: 'upcoming' | 'active' | 'finished' = 'upcoming';
      if (now >= start && now <= end) status = 'active';
      else if (now > end) status = 'finished';
      // Auto-update status if needed
      if (status !== comp.status) {
        await storage.updateCompetitionStatus(comp.id, status);
      }
      const totalDays = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
      const dayOfCompetition = status === 'active' ? Math.min(totalDays, Math.ceil((now - start) / (1000 * 60 * 60 * 24))) : undefined;
      const timeUntilStart = status === 'upcoming' ? Math.max(0, start - now) : undefined;
      return c.json({
        competition: {
          id: comp.id,
          name: comp.name,
          slug: comp.slug,
          startsAt: comp.startsAt,
          endsAt: comp.endsAt,
          status,
        },
        status,
        state: status, // backward compat
        timeUntilStart,
        dayOfCompetition,
        totalDays,
        treasurePowers: TREASURE_POWERS,
      });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // Admin auth helper
  function requireAdminAuth(c: any): boolean {
    const secret = c.env.UPSTASH_CRON_SECRET;
    if (!secret) return true; // No secret configured = allow (dev mode)
    const authHeader = c.req.header('Authorization');
    return authHeader === `Bearer ${secret}`;
  }

  // POST /api/admin/competition — Create competition (admin)
  app.post('/api/admin/competition', async (c) => {
    try {
      if (!requireAdminAuth(c)) return c.json({ error: 'Unauthorized' }, 401);
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const body = await c.req.json().catch(() => ({}));
      const comp = await storage.createCompetition({
        name: body.name || COMPETITION_NAME,
        slug: body.slug || COMPETITION_SLUG,
        startsAt: body.startsAt || COMPETITION_START,
        endsAt: body.endsAt || COMPETITION_END,
        config: body.config || null,
      });
      return c.json(comp);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // POST /api/admin/reset-for-competition — Reset DB for competition
  app.post('/api/admin/reset-for-competition', async (c) => {
    try {
      if (!requireAdminAuth(c)) return c.json({ error: 'Unauthorized' }, 401);
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const result = await storage.resetForCompetition();
      return c.json({ success: true, ...result });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // Helper: compute today's deterministic spawn hour for a competition
  function getTodaySpawnHour(competitionId: string): number {
    const today = new Date().toISOString().slice(0, 10);
    const seed = today + competitionId;
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
    }
    return ((hash % 24) + 24) % 24; // 0-23 UTC
  }

  // Helper: check if a treasure was already spawned today (checks ALL treasures, not just active)
  async function wasTreasureSpawnedToday(storage: WorkerStorage, competitionId: string): Promise<boolean> {
    const allTreasures = await storage.getAllTreasuresForCompetition(competitionId);
    const todayStart = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime();
    return allTreasures.some((t: any) => new Date(t.spawnedAt).getTime() >= todayStart);
  }

  // Helper: spawn a treasure and send push notifications
  async function spawnTreasureNow(storage: WorkerStorage, comp: any, env: any, source: string): Promise<any> {
    const pick = pickRandomTreasure();
    const spot = pickRandomSpawnPoint();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(); // 24h
    const rarityLabel = pick.rarity === 'legendary' ? '💎 LEGENDARIO' : pick.rarity === 'epic' ? '✨ ÉPICO' : pick.rarity === 'rare' ? '🔵 RARO' : '🟤 COMÚN';
    const treasure = await storage.createTreasure({
      competitionId: comp.id,
      name: pick.name,
      powerType: pick.powerType,
      rarity: pick.rarity,
      lat: spot.lat,
      lng: spot.lng,
      spawnedAt: now.toISOString(),
      expiresAt,
      zone: spot.zone,
    });
    console.log(`[TREASURE ${source}] Spawned ${pick.name} (${pick.rarity}) at ${spot.zone}`);

    // Create feed event for treasure spawn
    try {
      const systemUserId = await storage.ensureSystemUser();
      await storage.createFeedEvent({
        userId: systemUserId,
        eventType: 'treasure_spawned',
        routeId: null,
        metadata: JSON.stringify({
          treasureId: treasure.id,
          treasureName: pick.name,
          powerType: pick.powerType,
          rarity: pick.rarity,
          zone: spot.zone,
          emoji: TREASURE_POWERS[pick.powerType as keyof typeof TREASURE_POWERS]?.emoji || '📦',
        }),
      });
    } catch (e) {
      console.error(`[TREASURE ${source}] Feed event error:`, e);
    }

    // Send push notifications (non-blocking)
    try {
      const allSubs = await storage.getAllPushSubscriptions();
      const { sendPushToUser } = await import('./pushHelper');
      const payload = {
        title: `🗺️ ¡Nuevo tesoro en ${spot.zone}!`,
        body: `Un ${pick.name} (${rarityLabel}) ha aparecido en ${spot.zone}. ¡Corre a por él!`,
        tag: `treasure-${treasure.id}`,
        data: { type: 'treasure_spawned', treasureId: treasure.id },
      };
      const subsByUser = new Map<string, any[]>();
      for (const sub of allSubs) {
        if (!subsByUser.has(sub.userId)) subsByUser.set(sub.userId, []);
        subsByUser.get(sub.userId)!.push({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } });
      }
      let sent = 0;
      for (const [_, userSubs] of subsByUser) {
        try {
          await sendPushToUser(userSubs, payload, env.VAPID_PUBLIC_KEY!, env.VAPID_PRIVATE_KEY!, 'mailto:runna.io.service@gmail.com');
          sent++;
        } catch (_) {}
      }
      console.log(`[TREASURE ${source}] Notified ${sent} users`);
    } catch (e) {
      console.error(`[TREASURE ${source}] Push error:`, e);
    }

    return treasure;
  }

  // Helper: flexible auth check for Upstash cron endpoints
  function isUpstashAuthorized(c: any): boolean {
    const authHeader = c.req.header('Authorization');
    const upstashSignature = c.req.header('Upstash-Signature');
    const cronSecret = (c.env as any).UPSTASH_CRON_SECRET;
    // Allow if: no secret configured, or Authorization matches, or Upstash-Signature present
    return !cronSecret || authHeader === `Bearer ${cronSecret}` || !!upstashSignature;
  }

  // GET /api/treasures/active — Active treasures for map (only during competition)
  // Auto-spawn fallback: if it's past today's spawn hour and no treasure was spawned today, spawn one
  app.get('/api/treasures/active', async (c) => {
    try {
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const comp = await storage.getActiveCompetition();
      if (!comp || !isCompetitionActive(comp)) {
        return c.json({ treasures: [] });
      }
      let active = await storage.getActiveTreasures(comp.id);

      // Auto-spawn fallback: only if past today's random spawn hour AND no treasure spawned today
      // Use ?force=true to bypass hour check (admin use)
      const forceSpawn = c.req.query('force') === 'true';
      const spawnHour = getTodaySpawnHour(comp.id);
      const currentHour = new Date().getUTCHours();
      if (forceSpawn || currentHour >= spawnHour) {
        const alreadySpawned = await wasTreasureSpawnedToday(storage, comp.id);
        if (!alreadySpawned) {
          try {
            await spawnTreasureNow(storage, comp, c.env, 'AUTO-SPAWN');
            active = await storage.getActiveTreasures(comp.id);
          } catch (spawnErr) {
            console.error('[TREASURE AUTO-SPAWN] Error:', spawnErr);
          }
        }
      }

      return c.json({
        treasures: active.map(t => ({
          id: t.id,
          name: t.name,
          powerType: t.powerType,
          rarity: t.rarity,
          lat: t.lat,
          lng: t.lng,
          spawnedAt: t.spawnedAt,
          expiresAt: t.expiresAt,
          power: TREASURE_POWERS[t.powerType as keyof typeof TREASURE_POWERS] || null,
        })),
      });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // POST /api/treasures/renotify — Re-send push notifications about active treasures
  app.post('/api/treasures/renotify', async (c) => {
    try {
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const comp = await storage.getActiveCompetition();
      if (!comp) return c.json({ error: 'No active competition' }, 404);
      const active = await storage.getActiveTreasures(comp.id);
      if (active.length === 0) return c.json({ error: 'No active treasures' }, 404);

      const allSubs = await storage.getAllPushSubscriptions();
      if (allSubs.length === 0) return c.json({ error: 'No subscriptions' }, 404);

      const { sendPushToUser } = await import('./pushHelper');
      const subsByUser = new Map<string, any[]>();
      for (const sub of allSubs) {
        if (!subsByUser.has(sub.userId)) subsByUser.set(sub.userId, []);
        subsByUser.get(sub.userId)!.push({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } });
      }

      let totalSent = 0;
      for (const t of active) {
        const power = TREASURE_POWERS[t.powerType as keyof typeof TREASURE_POWERS];
        const payload = {
          title: `🗺️ ¡Tesoro disponible!`,
          body: `${power?.name || t.name} (${t.rarity === 'legendary' ? '💎 LEGENDARIO' : t.rarity === 'epic' ? '✨ ÉPICO' : t.rarity === 'rare' ? '🔵 RARO' : '🟤 COMÚN'}) está en el mapa. ¡Corre a por él!`,
          tag: `treasure-renotify-${t.id}`,
          data: { type: 'treasure_spawned', treasureId: t.id },
        };
        for (const [_, userSubs] of subsByUser) {
          try {
            await sendPushToUser(userSubs, payload, c.env.VAPID_PUBLIC_KEY || '', c.env.VAPID_PRIVATE_KEY || '', 'mailto:runna.io.service@gmail.com');
            totalSent++;
          } catch (_) {}
        }
      }
      return c.json({ success: true, sent: totalSent, treasures: active.length });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // GET /api/push/debug/:username — Check push subscriptions for a user  
  app.get('/api/push/debug/:username', async (c) => {
    try {
      const username = c.req.param('username');
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const user = await storage.getUserByUsername(username);
      if (!user) return c.json({ error: `User '${username}' not found` }, 404);
      const subs = await storage.getPushSubscriptionsByUserId(user.id);
      const allSubs = await storage.getAllPushSubscriptions();
      const subsByUser = new Map<string, number>();
      for (const sub of allSubs) {
        subsByUser.set(sub.userId, (subsByUser.get(sub.userId) || 0) + 1);
      }
      return c.json({
        userId: user.id,
        username: user.username,
        name: user.name,
        subscriptionCount: subs.length,
        subscriptions: subs.map(s => ({ endpoint: s.endpoint?.slice(0, 80) + '...', createdAt: s.createdAt })),
        totalUsersWithSubs: subsByUser.size,
        allSubCounts: Object.fromEntries(subsByUser),
      });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // POST /api/treasures/collect — Collect a treasure  
  app.post('/api/treasures/collect', async (c) => {
    try {
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const body = await c.req.json();
      const { userId, treasureId, lat, lng } = body;
      if (!userId || !treasureId) return c.json({ error: 'Missing userId or treasureId' }, 400);

      const comp = await storage.getActiveCompetition();
      if (!comp || !isCompetitionActive(comp)) {
        return c.json({ error: 'No active competition' }, 400);
      }

      const treasure = await storage.getTreasureById(treasureId);
      if (!treasure || treasure.collectedBy || !treasure.active) {
        return c.json({ error: 'Treasure not available' }, 404);
      }

      // Check proximity (100m)
      if (lat && lng) {
        const dist = haversineDistance(lat, lng, treasure.lat, treasure.lng);
        if (dist > 100) {
          return c.json({ error: 'Too far from treasure', distance: dist }, 400);
        }
      }

      // Collect it
      const collected = await storage.collectTreasure(treasureId, userId);
      if (!collected || collected.collectedBy !== userId) {
        return c.json({ error: 'Already collected by someone else' }, 409);
      }

      // Create user power
      const powerDef = TREASURE_POWERS[treasure.powerType as keyof typeof TREASURE_POWERS];
      await storage.createUserPower({
        userId,
        competitionId: comp.id,
        powerType: treasure.powerType,
        treasureId: treasure.id,
        expiresAt: null,
        metadata: null,
      });

      // Increment stats
      await storage.incrementCompetitionStats(comp.id, userId, { treasures: 1 });

      // Create feed event
      await storage.createFeedEvent({
        userId,
        eventType: 'treasure_found',
        routeId: null,
        metadata: JSON.stringify({
          treasureName: treasure.name,
          powerType: treasure.powerType,
          rarity: treasure.rarity,
          zone: (treasure as any).zone || null,
          emoji: powerDef?.emoji || '📦',
        }),
      });

      return c.json({
        success: true,
        treasure: {
          ...treasure,
          collectedBy: userId,
          collectedAt: new Date().toISOString(),
        },
        power: {
          type: treasure.powerType,
          name: powerDef?.name || treasure.name,
          rarity: treasure.rarity,
          description: powerDef?.description || '',
          emoji: powerDef?.emoji || '📦',
        },
      });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // GET /api/users/:userId/powers — User's powers (only during competition)
  app.get('/api/users/:userId/powers', async (c) => {
    try {
      const userId = c.req.param('userId');
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const comp = await storage.getActiveCompetition();
      if (!comp || !isCompetitionActive(comp)) {
        return c.json({ powers: [] });
      }
      const powers = await storage.getUserPowers(userId, comp.id);
      return c.json({
        powers: powers.map(p => ({
          ...p,
          definition: TREASURE_POWERS[p.powerType as keyof typeof TREASURE_POWERS] || null,
        })),
      });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // POST /api/powers/:powerId/activate — Activate a power (auto-use for instant ones)
  app.post('/api/powers/:powerId/activate', async (c) => {
    try {
      const powerId = c.req.param('powerId');
      const body = await c.req.json().catch(() => ({}));
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);

      const power = await storage.getPowerById(powerId);
      if (!power) return c.json({ error: 'Power not found' }, 404);
      if (power.status !== 'available') return c.json({ error: 'Power already used or expired' }, 400);

      const now = new Date().toISOString();
      const in24h = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const in48h = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

      // Handle per-type activation
      switch (power.powerType) {
        case 'shield':
        case 'time_bomb':
        case 'invisibility': {
          // Time-limited passive: activate for 24h
          await storage.activatePower(powerId);
          // Set expiration via storage method
          await storage.setPowerExpiration(powerId, in24h);
          return c.json({ success: true, message: `Activado durante 24h`, expiresAt: in24h });
        }
        case 'double_area':
        case 'steal_boost':
        case 'magnet':
        case 'bulldozer':
        case 'battering_ram': {
          // Next-run powers: activate (will be consumed on next route submission)
          await storage.activatePower(powerId);
          return c.json({ success: true, message: 'Se aplicará en tu siguiente ruta' });
        }
        case 'wall':
        case 'sentinel': {
          // Duration-based: activate for 24h
          await storage.activatePower(powerId);
          await storage.setPowerExpiration(powerId, in24h);
          return c.json({ success: true, message: `Activado durante 24h`, expiresAt: in24h });
        }
        case 'nickname': {
          // Requires target user + nickname
          const { targetUserId, nickname } = body;
          if (!targetUserId || !nickname) return c.json({ error: 'Missing targetUserId or nickname' }, 400);
          if (nickname.length > 20) return c.json({ error: 'Nickname too long (max 20 chars)' }, 400);
          await storage.createNickname({
            targetUserId,
            setByUserId: power.userId,
            nickname,
            expiresAt: in48h,
          });
          await storage.usePower(powerId);

          // Get attacker and victim names for feed/notifications
          const attacker = await storage.getUser(power.userId);
          const target = await storage.getUser(targetUserId);
          const attackerName = attacker?.name || 'Alguien';
          const targetName = target?.name || 'un jugador';

          // Create feed event for nickname_changed
          try {
            await storage.createFeedEvent({
              userId: power.userId,
              eventType: 'nickname_changed',
              victimId: targetUserId,
              metadata: JSON.stringify({
                nickname,
                targetName,
                attackerName,
                expiresAt: in48h,
              }),
            });
          } catch (e) {
            console.error('[NICKNAME] Feed event error:', e);
          }

          // Send push notification to ALL users (non-blocking via waitUntil)
          const env = c.env;
          (c.executionCtx as any).waitUntil?.((async () => {
            try {
              const allSubs = await storage.getAllPushSubscriptions();
              const { sendPushToUser } = await import('./pushHelper');
              const payload = {
                title: `🎭 ¡Nuevo apodo en la competición!`,
                body: `${attackerName} ha puesto el apodo "${nickname}" a ${targetName} durante 48h`,
                tag: `nickname-${targetUserId}`,
                data: { type: 'nickname_changed', targetUserId },
              };
              const subsByUser = new Map<string, any[]>();
              for (const sub of allSubs) {
                if (!subsByUser.has(sub.userId)) subsByUser.set(sub.userId, []);
                subsByUser.get(sub.userId)!.push({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } });
              }
              let sent = 0;
              for (const [_, userSubs] of subsByUser) {
                try {
                  await sendPushToUser(userSubs, payload, env.VAPID_PUBLIC_KEY!, env.VAPID_PRIVATE_KEY!, 'mailto:runna.io.service@gmail.com');
                  sent++;
                } catch (_) {}
              }
              console.log(`[NICKNAME] Notified ${sent} users about nickname "${nickname}" for ${targetName}`);
            } catch (e) {
              console.error('[NICKNAME] Push error:', e);
            }
          })());

          return c.json({ success: true, message: `Apodo "${nickname}" asignado durante 48h` });
        }
        case 'reveal': {
          // Instant: no real action needed, client shows next treasure location early
          await storage.usePower(powerId);
          return c.json({ success: true, message: 'Recibirás la ubicación del próximo tesoro 1h antes' });
        }
        default:
          return c.json({ error: 'Unknown power type' }, 400);
      }
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // GET /api/territories/fortifications — Get all fortification records (for map overlay)
  app.get('/api/territories/fortifications', async (c) => {
    try {
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const comp = await storage.getActiveCompetition();
      if (!comp || !isCompetitionActive(comp)) {
        return c.json({ fortifications: [] });
      }
      const allForts = await storage.getAllFortifications();
      // Group by userId and compute levels per zone
      const byUser = new Map<string, Array<{ geometry: string; area: number }>>();
      for (const fort of allForts) {
        if (!byUser.has(fort.userId)) byUser.set(fort.userId, []);
        byUser.get(fort.userId)!.push({ geometry: fort.geometry, area: fort.area });
      }
      // Return grouped data for the client
      const fortifications: Array<{ userId: string; layers: number; records: Array<{ geometry: any; area: number }> }> = [];
      for (const [uid, records] of byUser) {
        fortifications.push({
          userId: uid,
          layers: records.length,
          records: records.map(r => ({
            geometry: JSON.parse(r.geometry),
            area: r.area,
          })),
        });
      }
      return c.json({ fortifications });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // GET /api/competition/participants — All users in the system (for nickname target selector etc.)
  app.get('/api/competition/participants', async (c) => {
    try {
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const allUsers = await storage.getAllUsersWithStats();
      return c.json({
        participants: allUsers.map(u => ({
          id: u.id,
          username: u.username,
          name: u.name,
          color: u.color,
          avatar: u.avatar,
        })),
      });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // GET /api/competition/leaderboard — Competition leaderboard (with active nicknames)
  app.get('/api/competition/leaderboard', async (c) => {
    try {
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const comp = await storage.getActiveCompetition();
      if (!comp) return c.json({ leaderboard: [] });
      const leaderboard = await storage.getCompetitionLeaderboard(comp.id);
      // Enrich with active nicknames
      const enriched = await Promise.all(leaderboard.map(async (entry) => {
        const nn = await storage.getActiveNickname(entry.user.id);
        return { ...entry, user: { ...entry.user, nickname: nn?.nickname || null, nicknameExpiresAt: nn?.expiresAt || null } };
      }));
      return c.json({ leaderboard: enriched });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // GET /api/competition/weekly-summary/:weekNumber
  app.get('/api/competition/weekly-summary/:weekNumber', async (c) => {
    try {
      const weekNumber = parseInt(c.req.param('weekNumber'));
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const comp = await storage.getActiveCompetition();
      if (!comp) return c.json({ summary: null });
      const summary = await storage.getWeeklySummary(comp.id, weekNumber);
      return c.json({ summary: summary ? JSON.parse(summary.data) : null, weekNumber });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // POST /api/tasks/polar-auto-sync — Cron: runs every 5 minutes, auto-syncs Polar activities
  // Checks all connected Polar accounts for new exercises, processes them, and notifies users
  app.post('/api/tasks/polar-auto-sync', async (c) => {
    try {
      if (!isUpstashAuthorized(c)) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const cronStart = Date.now();
      const MAX_CRON_TIME = 25000; // 25s safety limit
      const MAX_USERS_PER_INVOCATION = 5; // Process at most 5 users per cron run
      const SYNC_STALE_MINUTES = 4; // Only sync users not synced in last 4 minutes

      const db = getDb(c.env);
      const storage = new WorkerStorage(db);

      const allAccounts = await storage.getAllPolarAccounts();
      if (allAccounts.length === 0) {
        return c.json({ success: true, message: 'No Polar accounts connected', synced: 0 });
      }

      // Sort by lastSyncAt ASC (oldest first = most stale), null = never synced = highest priority
      const sortedAccounts = allAccounts.sort((a, b) => {
        if (!a.lastSyncAt) return -1;
        if (!b.lastSyncAt) return 1;
        return new Date(a.lastSyncAt).getTime() - new Date(b.lastSyncAt).getTime();
      });

      // Filter to only stale accounts (not synced recently)
      const staleThreshold = new Date(Date.now() - SYNC_STALE_MINUTES * 60 * 1000).toISOString();
      const staleAccounts = sortedAccounts.filter(a => !a.lastSyncAt || a.lastSyncAt < staleThreshold);

      const toSync = staleAccounts.slice(0, MAX_USERS_PER_INVOCATION);
      console.log(`[POLAR AUTO-SYNC] ${allAccounts.length} total accounts, ${staleAccounts.length} stale, syncing ${toSync.length}`);

      let syncedUsers = 0;
      let newActivitiesFound = 0;
      let activitiesProcessed = 0;

      for (const account of toSync) {
        if (Date.now() - cronStart > MAX_CRON_TIME) {
          console.warn('[POLAR AUTO-SYNC] Time limit reached, stopping');
          break;
        }

        const userId = account.userId;
        try {
          // 1. Sync new exercises from Polar API
          const beforeCount = (await storage.getUnprocessedPolarActivities(userId)).length;
          const syncResult = await syncPolarExercisesDirect(account, userId, storage);
          await storage.updatePolarAccount(userId, { lastSyncAt: new Date() });
          const afterUnprocessed = await storage.getUnprocessedPolarActivities(userId);
          const newCount = afterUnprocessed.length;

          console.log(`[POLAR AUTO-SYNC] User ${userId}: sync=${syncResult.imported} imported, ${newCount} unprocessed`);
          syncedUsers++;

          if (newCount === 0) continue;

          // 2. Auto-process unprocessed activities (same logic as POST /api/polar/process)
          const newActivities = afterUnprocessed.slice(0, 3); // Max 3 per user per cron
          newActivitiesFound += newActivities.length;

          for (const activity of newActivities) {
            if (Date.now() - cronStart > MAX_CRON_TIME) break;

            if (!activity.summaryPolyline) {
              await storage.updatePolarActivity(activity.id, { processed: 1 as any, processedAt: new Date().toISOString(), skipReason: 'no_gps' });
              continue;
            }

            const startDate = coerceDate(activity.startDate);
            if (!startDate) {
              await storage.updatePolarActivity(activity.id, { processed: 1 as any, processedAt: new Date().toISOString(), skipReason: 'bad_date' });
              continue;
            }

            const COMP_PROCESS_MIN_DATE = new Date('2026-03-02T00:00:00Z');
            if (startDate < COMP_PROCESS_MIN_DATE) {
              await storage.updatePolarActivity(activity.id, { processed: 1 as any, processedAt: new Date().toISOString(), skipReason: 'before_competition' });
              continue;
            }

            const decoded = decodePolyline(activity.summaryPolyline);
            const coordinates: Array<[number, number]> = decoded.map((coord: [number, number]) => [coord[0], coord[1]]);

            if (coordinates.length < 10) {
              // Short activity - create route + basic feed event
              try {
                const startedAt = startDate.toISOString();
                const completedAt = new Date(startDate.getTime() + activity.duration * 1000).toISOString();
                let shortRoute = await storage.findRouteByDateAndDistance(userId, startedAt, activity.distance);
                if (!shortRoute) {
                  shortRoute = await storage.createRoute({
                    userId,
                    name: activity.name,
                    coordinates,
                    distance: activity.distance,
                    duration: activity.duration,
                    startedAt,
                    completedAt,
                  });
                }
                await generateFeedEvents(storage, userId, shortRoute.id, activity.distance, activity.duration, { newAreaConquered: 0, victims: [], ranTogetherWith: [] });
                await storage.updatePolarActivity(activity.id, { routeId: shortRoute.id, processed: 1 as any, processedAt: new Date().toISOString() });
              } catch (_) {
                await storage.updatePolarActivity(activity.id, { processed: 1 as any, processedAt: new Date().toISOString() });
              }
              continue;
            }

            // Full route with territory processing
            try {
              const startedAt = startDate.toISOString();
              const completedAt = new Date(startDate.getTime() + activity.duration * 1000).toISOString();

              let route = activity.routeId ? await storage.getRouteById(activity.routeId) : null;
              if (!route) {
                route = await storage.findRouteByDateAndDistance(userId, startedAt, activity.distance);
              }
              if (!route) {
                route = await storage.createRoute({
                  userId,
                  name: activity.name,
                  coordinates,
                  distance: activity.distance,
                  duration: activity.duration,
                  startedAt,
                  completedAt,
                });
              }

              await storage.updatePolarActivity(activity.id, { routeId: route.id });

              // Create early feed event
              let earlyFeedEventId: string | undefined;
              try {
                const existingFeed = await storage.getFeedEventByRouteId(route.id);
                if (existingFeed) {
                  earlyFeedEventId = existingFeed.id;
                } else {
                  const earlyFeedEvent = await storage.createFeedEvent({
                    userId,
                    eventType: 'activity',
                    routeId: route.id,
                    distance: activity.distance,
                    duration: activity.duration,
                    newArea: 0,
                    metadata: null,
                  });
                  earlyFeedEventId = earlyFeedEvent.id;
                }
              } catch (_) {}

              // Enqueue territory processing
              await c.env.TERRITORY_QUEUE.send({
                type: 'process_route_territory',
                userId,
                routeId: route.id,
                startedAt,
                completedAt,
                distance: activity.distance,
                duration: activity.duration,
                earlyFeedEventId,
              });

              await storage.updatePolarActivity(activity.id, {
                routeId: route.id,
                processed: 1 as any,
                processedAt: new Date().toISOString(),
              });

              activitiesProcessed++;
              console.log(`[POLAR AUTO-SYNC] ✅ Auto-processed activity ${activity.id} → route ${route.id}`);

              // 3. Send push notification to user about the new activity
              try {
                const { sendPushToUser } = await import('./pushHelper');
                const subscriptions = await storage.getPushSubscriptionsByUserId(userId);
                if (subscriptions.length > 0) {
                  const distKm = (activity.distance / 1000).toFixed(1);
                  const pushSubs = subscriptions.map((sub: any) => ({
                    endpoint: sub.endpoint,
                    keys: { p256dh: sub.p256dh, auth: sub.auth },
                  }));
                  await sendPushToUser(
                    pushSubs,
                    {
                      title: '🏃 ¡Carrera registrada!',
                      body: `${activity.name} · ${distKm} km — Entra para ver tu conquista`,
                      tag: `polar-auto-${activity.id}`,
                      data: { type: 'polar_auto_import', routeId: route.id, url: '/?showPendingAnimation=true' },
                    },
                    (c.env as any).VAPID_PUBLIC_KEY || '',
                    (c.env as any).VAPID_PRIVATE_KEY || '',
                    (c.env as any).VAPID_SUBJECT || 'mailto:notifications@runna.io'
                  );
                }
              } catch (pushErr) {
                console.warn(`[POLAR AUTO-SYNC] Push notification failed for ${userId}:`, pushErr);
              }
            } catch (procErr) {
              console.error(`[POLAR AUTO-SYNC] ❌ Error processing activity ${activity.id}:`, procErr);
            }
          }
        } catch (userErr) {
          console.error(`[POLAR AUTO-SYNC] ❌ Error syncing user ${userId}:`, userErr);
        }
      }

      const elapsed = Date.now() - cronStart;
      console.log(`[POLAR AUTO-SYNC] Done in ${elapsed}ms: ${syncedUsers} users synced, ${newActivitiesFound} new activities, ${activitiesProcessed} processed`);
      return c.json({
        success: true,
        syncedUsers,
        newActivitiesFound,
        activitiesProcessed,
        elapsed,
      });
    } catch (error: any) {
      console.error('[POLAR AUTO-SYNC] Critical error:', error);
      return c.json({ error: error.message }, 500);
    }
  });

  // POST /api/tasks/spawn-treasure — Cron: runs every hour, spawns at a random hour each day
  app.post('/api/tasks/spawn-treasure', async (c) => {
    try {
      if (!isUpstashAuthorized(c)) {
        console.log('[TREASURE CRON] Auth failed. Headers:', JSON.stringify(Object.fromEntries([...new Map(c.req.raw.headers)])).slice(0, 200));
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const comp = await storage.getActiveCompetition();
      if (!comp || !isCompetitionActive(comp)) {
        return c.json({ skipped: true, reason: 'No active competition' });
      }

      // Determine today's random spawn hour
      const spawnHour = getTodaySpawnHour(comp.id);
      const currentHour = new Date().getUTCHours();

      if (currentHour !== spawnHour) {
        return c.json({ skipped: true, reason: `Not spawn hour (today=${spawnHour}h UTC, now=${currentHour}h UTC)` });
      }

      // Check if a treasure was already spawned today (checks ALL treasures, not just active)
      const alreadySpawned = await wasTreasureSpawnedToday(storage, comp.id);
      if (alreadySpawned) {
        return c.json({ skipped: true, reason: 'Treasure already spawned today' });
      }

      const treasure = await spawnTreasureNow(storage, comp, c.env, 'CRON');
      return c.json({ success: true, treasure });
    } catch (error: any) {
      console.error('[TREASURE CRON] Error:', error);
      return c.json({ error: error.message }, 500);
    }
  });

  // POST /api/tasks/weekly-summary — Cron: generate weekly summary (Sundays 8PM)
  app.post('/api/tasks/weekly-summary', async (c) => {
    try {
      if (!isUpstashAuthorized(c)) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const comp = await storage.getActiveCompetition();
      if (!comp || !isCompetitionActive(comp)) {
        return c.json({ skipped: true, reason: 'No active competition' });
      }

      // Determine week number (1-based from competition start)
      const startDate = new Date(comp.startsAt);
      const now = new Date();
      const weekNumber = Math.ceil((now.getTime() - startDate.getTime()) / (7 * 24 * 60 * 60 * 1000));

      // Get all stats for this competition
      const leaderboard = await storage.getCompetitionLeaderboard(comp.id);
      if (leaderboard.length === 0) {
        return c.json({ skipped: true, reason: 'No participants yet' });
      }

      // Compute awards
      const byArea = [...leaderboard].sort((a, b) => b.totalArea - a.totalArea);
      const byStolen = [...leaderboard].sort((a, b) => b.areaStolen - a.areaStolen);
      const byDistance = [...leaderboard].sort((a, b) => b.totalDistance - a.totalDistance);
      const byActivities = [...leaderboard].sort((a, b) => b.activitiesCount - a.activitiesCount);
      const byTreasures = [...leaderboard].sort((a, b) => b.treasuresCollected - a.treasuresCollected);
      const byVictims = [...leaderboard].sort((a, b) => b.uniqueVictims - a.uniqueVictims);
      const byRanTogether = [...leaderboard].sort((a, b) => b.ranTogetherCount - a.ranTogetherCount);

      // MVP score: normalized combo of all metrics
      const maxArea = byArea[0]?.totalArea || 1;
      const maxStolen = byStolen[0]?.areaStolen || 1;
      const maxDist = byDistance[0]?.totalDistance || 1;
      const maxAct = byActivities[0]?.activitiesCount || 1;
      const mvpScores = leaderboard.map(s => ({
        ...s,
        mvpScore: (s.totalArea / maxArea) * 0.3 + (s.areaStolen / maxStolen) * 0.25 +
                  (s.totalDistance / maxDist) * 0.2 + (s.activitiesCount / maxAct) * 0.25,
      })).sort((a, b) => b.mvpScore - a.mvpScore);

      const summaryData = {
        weekNumber,
        generatedAt: now.toISOString(),
        competitionName: comp.name,
        participantCount: leaderboard.length,
        awards: {
          territory_king: { title: '🏆 Rey del Territorio', user: byArea[0]?.user, value: byArea[0]?.totalArea || 0, unit: 'm²' },
          conqueror: { title: '🗡️ El Conquistador', user: byStolen[0]?.user, value: byStolen[0]?.areaStolen || 0, unit: 'm² robados' },
          marathon: { title: '🏃 Maratonista', user: byDistance[0]?.user, value: byDistance[0]?.totalDistance || 0, unit: 'm' },
          consistent: { title: '📊 El Constante', user: byActivities[0]?.user, value: byActivities[0]?.activitiesCount || 0, unit: 'actividades' },
          treasure_hunter: { title: '💎 Cazatesoros', user: byTreasures[0]?.user, value: byTreasures[0]?.treasuresCollected || 0, unit: 'tesoros' },
          precise: { title: '🎯 El Preciso', user: byVictims[0]?.user, value: byVictims[0]?.uniqueVictims || 0, unit: 'víctimas' },
          social: { title: '🤝 Alma Social', user: byRanTogether[0]?.user, value: byRanTogether[0]?.ranTogetherCount || 0, unit: 'carreras juntos' },
          mvp: { title: '⚡ MVP de la Semana', user: mvpScores[0]?.user, value: Math.round(mvpScores[0]?.mvpScore * 100) || 0, unit: 'puntos' },
        },
        ranking: byArea.slice(0, 10).map((s, i) => ({
          rank: i + 1,
          user: s.user,
          totalArea: s.totalArea,
          activitiesCount: s.activitiesCount,
          areaStolen: s.areaStolen,
        })),
      };

      await storage.createWeeklySummary({
        competitionId: comp.id,
        weekNumber,
        data: JSON.stringify(summaryData),
      });

      // Push notification to all users
      try {
        const allSubs = await storage.getAllPushSubscriptions();
        const { sendPushToUser } = await import('./pushHelper');
        const payload = {
          title: `📊 Resumen Semanal — Semana ${weekNumber}`,
          body: `¡El resumen de La Primera Conquista del Ebro está listo! Abre la app para ver los premios.`,
          tag: `weekly-summary-${weekNumber}`,
          data: { type: 'weekly_summary', weekNumber },
        };
        const subsByUser = new Map<string, any[]>();
        for (const sub of allSubs) {
          if (!subsByUser.has(sub.userId)) subsByUser.set(sub.userId, []);
          subsByUser.get(sub.userId)!.push({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } });
        }
        for (const [_, userSubs] of subsByUser) {
          try { await sendPushToUser(userSubs, payload, c.env.VAPID_PUBLIC_KEY!, c.env.VAPID_PRIVATE_KEY!, 'mailto:runna.io.service@gmail.com'); } catch (_) {}
        }
      } catch (_) {}

      return c.json({ success: true, weekNumber, summary: summaryData });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // POST /api/admin/spawn-treasure — Manual treasure spawn (admin/testing)
  app.post('/api/admin/spawn-treasure', async (c) => {
    try {
      if (!requireAdminAuth(c)) return c.json({ error: 'Unauthorized' }, 401);
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const body = await c.req.json().catch(() => ({}));
      const comp = await storage.getActiveCompetition();
      if (!comp) return c.json({ error: 'No competition' }, 400);

      const pick = body.powerType
        ? { powerType: body.powerType, rarity: TREASURE_POWERS[body.powerType as keyof typeof TREASURE_POWERS]?.rarity || 'common', name: TREASURE_POWERS[body.powerType as keyof typeof TREASURE_POWERS]?.name || body.powerType }
        : pickRandomTreasure();
      const spot = body.lat && body.lng ? { lat: body.lat, lng: body.lng, zone: body.zone || 'Manual' } : pickRandomSpawnPoint();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + (body.durationHours || 24) * 60 * 60 * 1000).toISOString();

      const treasure = await storage.createTreasure({
        competitionId: comp.id,
        name: pick.name,
        powerType: pick.powerType,
        rarity: pick.rarity,
        lat: spot.lat,
        lng: spot.lng,
        spawnedAt: now.toISOString(),
        expiresAt,
        zone: spot.zone,
      });

      // Create feed event for treasure spawn
      try {
        const systemUserId = await storage.ensureSystemUser();
        await storage.createFeedEvent({
          userId: systemUserId,
          eventType: 'treasure_spawned',
          routeId: null,
          metadata: JSON.stringify({
            treasureId: treasure.id,
            treasureName: pick.name,
            powerType: pick.powerType,
            rarity: pick.rarity,
            zone: spot.zone,
            emoji: TREASURE_POWERS[pick.powerType as keyof typeof TREASURE_POWERS]?.emoji || '📦',
          }),
        });
      } catch (_) {}

      // Send push notification to all users
      try {
        const allSubs = await storage.getAllPushSubscriptions();
        const { sendPushToUser } = await import('./pushHelper');
        const payload = {
          title: `🗺️ ¡Nuevo tesoro en ${spot.zone}!`,
          body: `Un ${pick.name} (${pick.rarity === 'legendary' ? '💎 LEGENDARIO' : pick.rarity === 'epic' ? '✨ ÉPICO' : pick.rarity === 'rare' ? '🔵 RARO' : '🟤 COMÚN'}) ha aparecido. ¡Corre a por él!`,
          tag: `treasure-${treasure.id}`,
          data: { type: 'treasure_spawned', treasureId: treasure.id },
        };
        const subsByUser = new Map<string, any[]>();
        for (const sub of allSubs) {
          if (!subsByUser.has(sub.userId)) subsByUser.set(sub.userId, []);
          subsByUser.get(sub.userId)!.push({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } });
        }
        let sent = 0;
        for (const [_, userSubs] of subsByUser) {
          try {
            await sendPushToUser(userSubs, payload, c.env.VAPID_PUBLIC_KEY!, c.env.VAPID_PRIVATE_KEY!, 'mailto:runna.io.service@gmail.com');
            sent++;
          } catch (_) {}
        }
        console.log(`[TREASURE-ADMIN] Spawned ${pick.name} at ${spot.zone}, notified ${sent} users`);
      } catch (e) {
        console.error('[TREASURE-ADMIN] Push error:', e);
      }

      return c.json({ success: true, treasure, zone: spot.zone });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // POST /api/admin/reset-skipped-polar — Delete all skipped Polar activities so they can be re-evaluated
  app.post('/api/admin/reset-skipped-polar', async (c) => {
    try {
      if (!requireAdminAuth(c)) return c.json({ error: 'Unauthorized' }, 401);
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const body = await c.req.json().catch(() => ({}));
      const targetUserId = body?.userId || null;

      // Delete all polar activities with a skipReason (they block reimport)
      const deleted = await storage.deleteSkippedPolarActivities(targetUserId);
      console.log(`[ADMIN] Reset ${deleted} skipped Polar activities${targetUserId ? ` for user ${targetUserId}` : ' (all users)'}`);
      return c.json({ success: true, deleted, message: `${deleted} actividades skipped eliminadas. Ejecuta sync de nuevo para reimportarlas.` });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // POST /api/admin/retrofix-route — Retroactively create feed event + collect treasures for a route that was missed
  app.post('/api/admin/retrofix-route', async (c) => {
    try {
      if (!requireAdminAuth(c)) return c.json({ error: 'Unauthorized' }, 401);
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const body = await c.req.json();
      const { routeId } = body;
      if (!routeId) return c.json({ error: 'routeId required' }, 400);

      const route = await storage.getRouteById(routeId);
      if (!route) return c.json({ error: 'Route not found' }, 404);

      const coords: [number, number][] = typeof route.coordinates === 'string'
        ? JSON.parse(route.coordinates)
        : route.coordinates;

      // Check if feed event already exists for this route
      const existingFeed = await storage.getFeedEventByRouteId(route.id);
      let feedCreated = false;
      if (!existingFeed) {
        try {
          await generateFeedEvents(storage, route.userId, route.id, route.distance || 0, route.duration || 0, { newAreaConquered: 0, victims: [], ranTogetherWith: [] });
          feedCreated = true;
          console.log(`[ADMIN RETROFIX] Feed event created for route ${routeId}`);
        } catch (feedErr) {
          console.error(`[ADMIN RETROFIX] Feed event creation failed:`, feedErr);
        }
      } else {
        console.log(`[ADMIN RETROFIX] Feed event already exists for route ${routeId}`);
      }

      // Try to auto-collect treasures along the route
      let treasuresCollected: any[] = [];
      if (coords && coords.length > 0) {
        try {
          const competition = await storage.getActiveCompetition();
          if (competition && isCompetitionActive(competition)) {
            treasuresCollected = await autoCollectTreasuresAlongRoute(storage, route.userId, competition.id, coords);
            console.log(`[ADMIN RETROFIX] Treasures collected: ${treasuresCollected.length}`);
          }
        } catch (tErr) {
          console.error(`[ADMIN RETROFIX] Treasure collection failed:`, tErr);
        }
      }

      return c.json({ 
        success: true, 
        routeId, 
        userId: route.userId,
        feedCreated,
        feedAlreadyExisted: !!existingFeed,
        treasuresCollected: treasuresCollected.length,
        treasures: treasuresCollected,
      });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // POST /api/admin/broadcast — Send push notification to all users (admin)
  app.post('/api/admin/broadcast', async (c) => {
    try {
      if (!requireAdminAuth(c)) return c.json({ error: 'Unauthorized' }, 401);
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const body = await c.req.json();
      const { title, body: msgBody, tag, data } = body;
      if (!title || !msgBody) return c.json({ error: 'title and body required' }, 400);

      const allSubs = await storage.getAllPushSubscriptions();
      if (allSubs.length === 0) return c.json({ error: 'No subscriptions', sent: 0 }, 404);

      const { sendPushToUser } = await import('./pushHelper');
      const payload = { title, body: msgBody, tag: tag || 'broadcast', data: data || {} };

      // Group subs by userId
      const subsByUser = new Map<string, { endpoint: string; keys: { p256dh: string; auth: string } }[]>();
      for (const sub of allSubs) {
        if (!subsByUser.has(sub.userId)) subsByUser.set(sub.userId, []);
        subsByUser.get(sub.userId)!.push({
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        });
      }

      let sent = 0;
      let failed = 0;
      for (const [_, userSubs] of subsByUser) {
        try {
          await sendPushToUser(userSubs, payload, c.env.VAPID_PUBLIC_KEY || '', c.env.VAPID_PRIVATE_KEY || '', 'mailto:runna.io.service@gmail.com');
          sent++;
        } catch (_) { failed++; }
      }
      return c.json({ success: true, sent, failed, totalUsers: subsByUser.size, totalSubs: allSubs.length });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // GET /api/users/:userId/nickname — Get active nickname for user
  app.get('/api/users/:userId/nickname', async (c) => {
    try {
      const userId = c.req.param('userId');
      const db = getDb(c.env);
      const storage = new WorkerStorage(db);
      const nickname = await storage.getActiveNickname(userId);
      return c.json({ nickname: nickname?.nickname || null, expiresAt: nickname?.expiresAt || null });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // Haversine distance in meters
  function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

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
// Handles both PT1H30M0S and P0DT1H30M0S formats (Polar sends both)
function parseDuration(duration: string): number {
  if (!duration) return 0;
  // Try extended format first: P[nD]T[nH][nM][nS] (handles P0DT1H30M5S etc.)
  const extMatch = duration.match(/P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/);
  if (extMatch) {
    const days = parseInt(extMatch[1] || '0', 10);
    const hours = parseInt(extMatch[2] || '0', 10);
    const minutes = parseInt(extMatch[3] || '0', 10);
    const seconds = parseFloat(extMatch[4] || '0');
    return days * 86400 + hours * 3600 + minutes * 60 + Math.round(seconds);
  }
  // Fallback: simple PTxHxMxS format
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/);
  if (!match) {
    console.warn(`[PARSE] Unrecognized duration format: "${duration}"`);
    return 0;
  }
  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  const seconds = parseFloat(match[3] || '0');
  return hours * 3600 + minutes * 60 + Math.round(seconds);
}
