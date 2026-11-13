import { createClient } from '@libsql/client/web';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../../shared/schema';

/**
 * Every statement sent to Turso is one HTTP request, and Cloudflare allows a limited number of
 * those per invocation (50 on the free plan). Tests and the admin stats read this counter.
 */
export const dbStats = { statements: 0 };
(globalThis as any).__runnaDbStats = dbStats;

/**
 * Subrequests left in this invocation. Cloudflare allows 50 per invocation on the free plan
 * (SUBREQUEST_LIMIT can raise it on a paid plan). Long jobs (the season engine, pushes) stop before
 * running out and carry on in the next run; a request that runs out fails on every query after.
 */
let invocationStart = 0;
let invocationLimit = 50;
export function startInvocation(limit?: unknown): void {
  invocationStart = dbStats.statements;
  readCache.clear();
  const value = Number(limit);
  invocationLimit = Number.isFinite(value) && value > 0 ? value : 50;
}
export function subrequestsUsed(): number {
  return dbStats.statements - invocationStart;
}
export function subrequestsLeft(): number {
  return invocationLimit - subrequestsUsed();
}
/** Counts a subrequest that isn't a database query (a push sent, an external API call). */
export function countSubrequest(n = 1): void {
  dbStats.statements += n;
}

/** Thrown by long jobs when the invocation is about to run out of subrequests: they resume next time. */
export class SubrequestBudgetError extends Error {
  constructor(where: string) {
    super(`Out of subrequests (${subrequestsUsed()} used) at ${where}: will continue on the next run`);
    this.name = 'SubrequestBudgetError';
  }
}
/** Stops a long job when fewer than `reserve` subrequests are left. */
export function checkBudget(where: string, reserve = 12): void {
  if (subrequestsLeft() < reserve) throw new SubrequestBudgetError(where);
}

/**
 * Reads of this invocation, keyed by SQL and arguments. A write drops every read that mentions the
 * table it writes; a batch or anything unrecognised drops them all. Cleared at the start of each
 * invocation, and entries live a few seconds at most.
 */
const READ_CACHE_TTL_MS = 5_000;
const readCache = {
  entries: new Map<string, { at: number; text: string; result: Promise<unknown> }>(),
  key(statement: any): { key: string; text: string } | null {
    const text = typeof statement === 'string' ? statement : statement?.sql;
    if (typeof text !== 'string') return null;
    const args = typeof statement === 'string' ? [] : statement.args ?? [];
    return { key: `${text}\u0000${JSON.stringify(args)}`, text };
  },
  get(statement: any): Promise<unknown> | null {
    const k = this.key(statement);
    if (!k || !/^\s*select\b/i.test(k.text)) {
      if (k) this.invalidate(k.text);
      else this.clear();
      return null;
    }
    const entry = this.entries.get(k.key);
    if (!entry || Date.now() - entry.at > READ_CACHE_TTL_MS) return null;
    return entry.result;
  },
  remember(statement: any, result: Promise<unknown>): void {
    const k = this.key(statement);
    if (!k || !/^\s*select\b/i.test(k.text)) return;
    const entry = { at: Date.now(), text: k.text.toLowerCase(), result };
    this.entries.set(k.key, entry);
    // A failed read is not kept
    result.catch(() => { if (this.entries.get(k.key) === entry) this.entries.delete(k.key); });
  },
  /** A write: forget the reads that mention the table it changes. */
  invalidate(text: string): void {
    const table = /^\s*(?:insert\s+(?:or\s+\w+\s+)?into|update|delete\s+from|replace\s+into)\s+["`]?(\w+)/i.exec(text)?.[1]?.toLowerCase();
    if (!table) {
      this.clear();
      return;
    }
    const word = new RegExp(`\\b${table}\\b`);
    for (const [key, entry] of this.entries) if (word.test(entry.text)) this.entries.delete(key);
  },
  clear(): void {
    this.entries.clear();
  },
};

export function createDb(databaseUrl: string, authToken?: string) {
  const client = createClient({
    url: databaseUrl,
    authToken: authToken,
  });
  for (const method of ['execute', 'batch', 'executeMultiple'] as const) {
    const original = (client as any)[method]?.bind(client);
    if (!original) continue;
    (client as any)[method] = (...args: any[]) => {
      // The same read twice in one invocation, with no write to its tables in between: no round trip
      if (method === 'execute') {
        const cached = readCache.get(args[0]);
        if (cached) return cached;
      } else {
        readCache.clear();
      }
      dbStats.statements++;
      // Tests can record what is sent (globalThis.__runnaDbTrace = [])
      const trace = (globalThis as any).__runnaDbTrace;
      if (Array.isArray(trace)) {
        const first = args[0];
        const text = typeof first === 'string' ? first : Array.isArray(first) ? `BATCH(${first.length}) ${String(first[0]?.sql ?? first[0]).slice(0, 60)}` : String(first?.sql ?? '');
        trace.push(text.replace(/\s+/g, ' ').slice(0, 110));
      }
      const result = original(...args);
      if (method === 'execute') readCache.remember(args[0], result);
      return result;
    };
  }
  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDb>;
