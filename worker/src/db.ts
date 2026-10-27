import { createClient } from '@libsql/client/web';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../../shared/schema';
import { isDbMetricsEnabled, meteringFetch } from './dbMetrics';

export function createDb(databaseUrl: string, authToken?: string) {
  const client = createClient({
    url: databaseUrl,
    authToken: authToken,
    // While DB_METRICS is on, count Turso rows read/written per request (see dbMetrics.ts)
    ...(isDbMetricsEnabled() ? { fetch: meteringFetch } : {}),
  });
  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDb>;
