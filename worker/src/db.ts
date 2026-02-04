import { createClient } from '@libsql/client/web';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../../shared/schema';

export function createDb(databaseUrl: string, authToken?: string) {
  const client = createClient({
    url: databaseUrl,
    authToken: authToken,
  });
  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDb>;
