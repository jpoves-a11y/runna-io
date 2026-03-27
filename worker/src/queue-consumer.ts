/**
 * Cloudflare Queue consumer for heavy territory processing.
 * 
 * Receives messages from the TERRITORY_QUEUE and processes them asynchronously,
 * with their own CPU budget (separate from the HTTP request that enqueued them).
 * 
 * Message types:
 * - process_route_territory: Process territory conquest + feed update for a new route
 * - reprocess_friend_group: Full chronological reprocess of a friend group's territories
 */
import { createDb } from './db';
import { WorkerStorage } from './storage';
import {
  routeToEnclosedPolygon,
  isCompetitionActive,
  type ConquestVictimInfo,
} from './territory';
import type { Env } from './index';

// Cloudflare Workers Queue types (provided by runtime, declared here for TS)
interface QueueMessage<T> {
  readonly body: T;
  ack(): void;
  retry(): void;
}
interface QueueMessageBatch<T> {
  readonly queue: string;
  readonly messages: readonly QueueMessage<T>[];
}

// ─── Message Types ───────────────────────────────────────────────────────────

export interface ProcessRouteTerritoryMessage {
  type: 'process_route_territory';
  userId: string;
  routeId: string;
  // coordinates are read from the DB (routes table) to avoid exceeding
  // Cloudflare Queue's 128 KB message size limit.
  startedAt: string;
  completedAt: string;
  distance: number;
  duration: number;
  earlyFeedEventId?: string;
}

export interface ReprocessFriendGroupMessage {
  type: 'reprocess_friend_group';
  userId: string; // trigger user — friend group is derived from their friendships
}

export type TerritoryQueueMessage = ProcessRouteTerritoryMessage | ReprocessFriendGroupMessage;

// ─── Queue Consumer ──────────────────────────────────────────────────────────

export async function handleQueueBatch(
  batch: QueueMessageBatch<TerritoryQueueMessage>,
  env: Env
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processMessage(message.body, env);
      message.ack();
    } catch (err) {
      console.error(`[QUEUE] Error processing message:`, err);
      message.retry();
    }
  }
}

async function processMessage(msg: TerritoryQueueMessage, env: Env): Promise<void> {
  const db = createDb(env.DATABASE_URL, env.TURSO_AUTH_TOKEN);
  const storage = new WorkerStorage(db);

  switch (msg.type) {
    case 'process_route_territory':
      await handleProcessRouteTerritory(storage, msg, env);
      break;
    case 'reprocess_friend_group':
      await handleReprocessFriendGroup(storage, msg);
      break;
    default:
      console.error(`[QUEUE] Unknown message type:`, (msg as any).type);
  }
}

// ─── Process Route Territory ─────────────────────────────────────────────────

async function handleProcessRouteTerritory(
  storage: WorkerStorage,
  msg: ProcessRouteTerritoryMessage,
  env: Env
): Promise<void> {
  const { userId, routeId, startedAt, completedAt, distance, duration, earlyFeedEventId } = msg;
  console.log(`[QUEUE] Processing territory for route ${routeId} (user ${userId})`);

  // Read coordinates from the routes table (not from the message) to stay
  // under the 128 KB Cloudflare Queue message-size limit.
  const route = await storage.getRouteById(routeId);
  if (!route) {
    console.error(`[QUEUE] Route ${routeId} not found in DB, skipping`);
    return;
  }
  const coords: [number, number][] = typeof route.coordinates === 'string'
    ? JSON.parse(route.coordinates)
    : route.coordinates;
  
  if (coords.length < 10) {
    console.log(`[QUEUE] Route ${routeId} has < 10 coords, skipping territory processing`);
    // Still update feed event with basic info
    await updateFeedEventSafe(storage, userId, routeId, distance, duration, {
      newAreaConquered: 0, victims: [], ranTogetherWith: [], treasuresCollected: [],
    }, earlyFeedEventId);
    return;
  }

  const enclosedPoly = routeToEnclosedPolygon(coords, 150);
  if (!enclosedPoly) {
    console.warn(`[QUEUE] routeToEnclosedPolygon returned null for route ${routeId}`);
    
    // Auto-collect treasures
    let treasuresCollected: any[] = [];
    try {
      const competition = await storage.getActiveCompetition();
      if (competition && isCompetitionActive(competition)) {
        // Inline treasure collection (lightweight)
        treasuresCollected = await autoCollectTreasures(storage, userId, competition.id, coords);
      }
    } catch (e) {
      console.error('[QUEUE] Treasure collect failed:', e);
    }
    
    await updateFeedEventSafe(storage, userId, routeId, distance, duration, {
      newAreaConquered: 0, victims: [], ranTogetherWith: [], treasuresCollected,
    }, earlyFeedEventId);
    return;
  }

  try {
    // Import processTerritoryConquest dynamically to avoid circular deps
    const { processTerritoryConquest, generateFeedEvents } = await import('./routes');

    // Pass env=undefined to SKIP inline notifications during territory processing.
    // Notifications consume subrequests; we must save budget for the feed-event
    // update which is the critical write.  Notifications are sent below.
    const conquestResult = await processTerritoryConquest(
      storage, userId, routeId, enclosedPoly.geometry,
      undefined, startedAt, completedAt, coords
    );

    // Save ran-together info
    if (conquestResult.ranTogetherWith.length > 0) {
      await storage.updateRouteRanTogether(routeId, conquestResult.ranTogetherWith);
    }

    // ── CRITICAL: Update feed event FIRST (before notifications) ──
    // This is the most important write — it populates the emblems in the feed.
    console.log(`[QUEUE] About to call generateFeedEvents: routeId=${routeId}, newArea=${conquestResult.newAreaConquered}, victims=${conquestResult.victims.length}, earlyFeedEventId=${earlyFeedEventId}`);
    await generateFeedEvents(
      storage, userId, routeId, distance, duration,
      conquestResult, false, earlyFeedEventId
    );
    console.log(`[QUEUE] generateFeedEvents completed for route ${routeId}`);

    // Sync user area
    try {
      const actualArea = await storage.getUserTotalAreaFromTerritories(userId);
      if (Math.abs(actualArea - conquestResult.totalArea) > 100) {
        console.warn(`[QUEUE] Area mismatch: conquest=${conquestResult.totalArea}, actual=${actualArea}`);
        await storage.updateUserTotalArea(userId, actualArea);
      }
    } catch (_) {}

    // ── BEST-EFFORT: Send notifications (territory loss + friend activity) ──
    // These can fail without affecting data integrity.
    try {
      // Territory loss notifications (previously done inside processTerritoryConquest)
      if (conquestResult.victims.length > 0) {
        const { notifyTerritoryLoss } = await import('./notifications');
        const MAX_NOTIFICATIONS = 3;
        const topVictims = [...conquestResult.victims]
          .sort((a, b) => b.stolenArea - a.stolenArea)
          .slice(0, MAX_NOTIFICATIONS);
        for (const victim of topVictims) {
          try {
            await notifyTerritoryLoss(storage, victim.userId, userId, env, victim.stolenArea);
          } catch (_) {}
        }
      }
    } catch (notifErr) {
      console.error('[QUEUE] Territory loss notification error (non-critical):', notifErr);
    }

    try {
      const { notifyFriendNewActivity, notifyAreaOvertake } = await import('./notifications');
      const distanceKm = distance ? distance / 1000 : 0;
      const newAreaKm2 = conquestResult.newAreaConquered / 1000000;
      await notifyFriendNewActivity(storage, userId, distanceKm, newAreaKm2, env);

      // Check overtakes (top 10 friends) — batch load users in 1 query
      const friendIds = await storage.getFriendIds(userId);
      const userAreaKm2 = conquestResult.totalArea / 1000000;
      const previousAreaKm2 = (conquestResult.totalArea - conquestResult.newAreaConquered) / 1000000;
      const MAX_FRIEND_CHECKS = 10;
      const friendIdsToCheck = friendIds.slice(0, MAX_FRIEND_CHECKS);

      if (friendIdsToCheck.length > 0) {
        try {
          const friends = await storage.getUsersByIds(friendIdsToCheck);
          for (const friend of friends) {
            if (friend?.totalArea != null) {
              const friendAreaKm2 = friend.totalArea / 1000000;
              if (previousAreaKm2 < friendAreaKm2 && userAreaKm2 >= friendAreaKm2) {
                await notifyAreaOvertake(storage, userId, friend.id, userAreaKm2, env);
              }
            }
          }
        } catch (_) {}
      }
    } catch (notifErr) {
      console.error('[QUEUE] Notification error (non-critical):', notifErr);
    }

    console.log(`[QUEUE] ✅ Route ${routeId} territory processed: ${(conquestResult.newAreaConquered / 1e6).toFixed(4)} km² new, ${conquestResult.victims.length} victims`);

  } catch (error: any) {
    console.error(`[QUEUE] ❌ Territory processing failed for route ${routeId}:`, error);

    // Recovery: sync user area from territory table
    try {
      const actualArea = await storage.getUserTotalAreaFromTerritories(userId);
      await storage.updateUserTotalArea(userId, actualArea);
    } catch (_) {}

    // Mark feed event with error
    if (earlyFeedEventId) {
      try {
        await storage.updateFeedEvent(earlyFeedEventId, {
          metadata: JSON.stringify({ territoryError: true }),
        });
      } catch (_) {}
    }

    // Re-throw to trigger message retry
    throw error;
  }
}

// ─── Reprocess Friend Group ──────────────────────────────────────────────────

async function handleReprocessFriendGroup(
  storage: WorkerStorage,
  msg: ReprocessFriendGroupMessage
): Promise<void> {
  console.log(`[QUEUE] Reprocessing friend group for user ${msg.userId}`);

  const { reprocessFriendGroupTerritoriesChronologically } = await import('./routes');
  await reprocessFriendGroupTerritoriesChronologically(storage, msg.userId);

  console.log(`[QUEUE] ✅ Friend group reprocess complete for user ${msg.userId}`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function updateFeedEventSafe(
  storage: WorkerStorage,
  userId: string,
  routeId: string,
  distance: number,
  duration: number,
  conquestResult: { newAreaConquered: number; victims: ConquestVictimInfo[]; ranTogetherWith: string[]; treasuresCollected?: any[]; fortressesDestroyed?: number; fortificationLayers?: number; fortificationArea?: number },
  earlyFeedEventId?: string
): Promise<void> {
  try {
    const { generateFeedEvents } = await import('./routes');
    await generateFeedEvents(
      storage, userId, routeId, distance, duration,
      conquestResult, false, earlyFeedEventId
    );
  } catch (err) {
    console.error('[QUEUE] Feed event update failed:', err);
  }
}

async function autoCollectTreasures(
  storage: WorkerStorage,
  userId: string,
  competitionId: string,
  coords: [number, number][]
): Promise<any[]> {
  const { autoCollectTreasuresAlongRoute } = await import('./routes');
  return autoCollectTreasuresAlongRoute(storage, userId, competitionId, coords);
}
