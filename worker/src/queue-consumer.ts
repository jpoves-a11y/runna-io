/**
 * Cloudflare Queue consumer for heavy territory processing.
 *
 * Receives messages from the TERRITORY_QUEUE and processes them asynchronously,
 * with their own CPU budget (separate from the HTTP request that enqueued them).
 *
 * Message types:
 * - process_route_territory: validate a new run and apply it to both game modes (runPipeline.ts)
 * - rebuild_user_territory: rebuild a user's global map and competition territory from their runs
 *   (after a run is deleted or a reviewed run is reverted)
 * - reprocess_friend_group: obsolete (friends no longer steal from each other); acknowledged and ignored
 */
import { createDb } from './db';
import { WorkerStorage } from './storage';
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

export interface RebuildUserTerritoryMessage {
  type: 'rebuild_user_territory';
  userId: string;
}

export interface ReprocessFriendGroupMessage {
  type: 'reprocess_friend_group';
  userId: string;
}

export type TerritoryQueueMessage = ProcessRouteTerritoryMessage | RebuildUserTerritoryMessage | ReprocessFriendGroupMessage;

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
    case 'rebuild_user_territory': {
      const { rebuildGlobalForUser, rebuildCompetitionForUser } = await import('./runPipeline');
      const global = await rebuildGlobalForUser(storage, msg.userId);
      const competition = await rebuildCompetitionForUser(storage, msg.userId);
      console.log(`[QUEUE] Rebuilt territory of ${msg.userId}: global ${(global.area / 1e6).toFixed(4)} km² (${global.runs} runs), competition ${(competition / 1e6).toFixed(4)} km²`);
      break;
    }
    case 'reprocess_friend_group':
      // Friends no longer steal territory from each other: nothing to do
      console.log(`[QUEUE] Ignoring obsolete reprocess_friend_group for ${msg.userId}`);
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
  const { userId, routeId, earlyFeedEventId } = msg;
  console.log(`[QUEUE] Processing route ${routeId} (user ${userId})`);
  try {
    const { processRun } = await import('./runPipeline');
    await processRun(storage, env, { userId, routeId, earlyFeedEventId });
  } catch (error) {
    console.error(`[QUEUE] ❌ Processing failed for route ${routeId}:`, error);
    if (earlyFeedEventId) {
      try {
        await storage.updateFeedEvent(earlyFeedEventId, { metadata: JSON.stringify({ territoryError: true }) });
      } catch (_) {}
    }
    // Re-throw to trigger message retry
    throw error;
  }
}
