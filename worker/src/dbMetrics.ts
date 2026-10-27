// Database usage metering (optional, while DB_METRICS = "1").
//
// Turso bills "rows read" and "rows written": every row a statement touches, not only the rows it
// returns. The server reports both numbers in each statement result (rows_read / rows_written), but
// @libsql/client does not expose them and its default protobuf encoding is hard to inspect. While
// metering is on, the client gets a fetch that:
//   1. answers the "v3-protobuf" version probe with 404, so the client falls back to the JSON
//      pipeline (v2), and
//   2. reads rows_read / rows_written from each JSON pipeline response and adds them to the usage
//      of the request (or queue message) that sent it, tracked with AsyncLocalStorage.
// The middleware in index.ts labels each request with its route ("GET /api/feed/:userId") and
// adds the totals to the db_usage_daily table (one upsert per request, made outside the metered
// context so it doesn't count itself). GET /api/admin/db-usage reads that table.
//
// Not counted: work in ctx.waitUntil() that finishes after the response, and the once-per-isolate
// schema check that runs before routing.

import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import type { Database } from './db';

export interface DbUsage {
  statements: number;
  rowsRead: number;
  rowsWritten: number;
  /** Statements whose result carried no rows_read / rows_written (server didn't report them) */
  unreported: number;
}

export function newDbUsage(): DbUsage {
  return { statements: 0, rowsRead: 0, rowsWritten: 0, unreported: 0 };
}

const usageStorage = new AsyncLocalStorage<DbUsage>();

let metricsEnabled = false;

/** Called by each entry point (fetch, queue, scheduled) with the Worker env. */
export function configureDbMetrics(env: { DB_METRICS?: string }): void {
  metricsEnabled = env.DB_METRICS === '1' || env.DB_METRICS === 'true';
}

export function isDbMetricsEnabled(): boolean {
  return metricsEnabled;
}

/** Runs `fn` with every database statement it sends counted into `usage`. */
export function withDbUsage<T>(usage: DbUsage, fn: () => T): T {
  return usageStorage.run(usage, fn);
}

/** Adds the statement results of one JSON pipeline response body to `usage`. */
export function addPipelineUsage(usage: DbUsage, body: any): void {
  const results = Array.isArray(body?.results) ? body.results : [];
  for (const entry of results) {
    if (entry?.type !== 'ok') continue;
    const response = entry.response;
    if (response?.type === 'execute') {
      addStmtResult(usage, response.result);
    } else if (response?.type === 'batch') {
      const steps = Array.isArray(response.result?.step_results) ? response.result.step_results : [];
      for (const step of steps) {
        if (step) addStmtResult(usage, step);
      }
    }
  }
}

function addStmtResult(usage: DbUsage, result: any): void {
  usage.statements += 1;
  const read = Number(result?.rows_read);
  const written = Number(result?.rows_written);
  if (!Number.isFinite(read) && !Number.isFinite(written)) {
    usage.unreported += 1;
    return;
  }
  if (Number.isFinite(read)) usage.rowsRead += read;
  if (Number.isFinite(written)) usage.rowsWritten += written;
}

/** fetch for createClient() while metering is on (see the header comment). */
export const meteringFetch = async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
  const request = input instanceof Request ? input : new Request(input, init);
  const { pathname } = new URL(request.url);
  if (request.method === 'GET' && pathname.endsWith('/v3-protobuf')) {
    return new Response('JSON pipeline forced by DB_METRICS', { status: 404 });
  }
  // Capture the usage now: the response may resolve outside the caller's async context
  const usage = usageStorage.getStore();
  const response = await fetch(request);
  if (usage && response.ok && pathname.endsWith('/pipeline')) {
    try {
      addPipelineUsage(usage, await response.clone().json());
    } catch (error) {
      console.error('[DB METRICS] Could not read pipeline response:', error);
    }
  }
  return response;
};

let usageTableReady = false;

/** Adds one request's usage to its (UTC day, label) row of db_usage_daily. */
export async function recordDbUsage(db: Database, label: string, usage: DbUsage): Promise<void> {
  if (usage.statements === 0) return;
  try {
    if (!usageTableReady) {
      await db.run(sql`
        CREATE TABLE IF NOT EXISTS db_usage_daily (
          day TEXT NOT NULL,
          label TEXT NOT NULL,
          requests INTEGER NOT NULL DEFAULT 0,
          statements INTEGER NOT NULL DEFAULT 0,
          rows_read INTEGER NOT NULL DEFAULT 0,
          rows_written INTEGER NOT NULL DEFAULT 0,
          unreported INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (day, label)
        ) WITHOUT ROWID
      `);
      usageTableReady = true;
    }
    const day = new Date().toISOString().slice(0, 10);
    await db.run(sql`
      INSERT INTO db_usage_daily (day, label, requests, statements, rows_read, rows_written, unreported)
      VALUES (${day}, ${label}, 1, ${usage.statements}, ${usage.rowsRead}, ${usage.rowsWritten}, ${usage.unreported})
      ON CONFLICT (day, label) DO UPDATE SET
        requests = requests + 1,
        statements = statements + excluded.statements,
        rows_read = rows_read + excluded.rows_read,
        rows_written = rows_written + excluded.rows_written,
        unreported = unreported + excluded.unreported
    `);
  } catch (error) {
    console.error('[DB METRICS] Could not record usage:', error);
  }
}
