// Runs the Worker API locally on Node against a SQLite file, for end-to-end tests
// (used by the iOS CI job). Territory queue messages are processed in-process.
//
//   npx esbuild worker/src/index.ts --bundle --format=esm --platform=node --target=node20 \
//     --outfile=scripts/e2e/.build/worker.mjs --alias:@libsql/client/web=@libsql/client --external:@libsql/client
//   DATABASE_URL=file:scripts/e2e/.build/e2e.db npx drizzle-kit push --force
//   node scripts/e2e/server.mjs
import { serve } from '@hono/node-server';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const databaseUrl = process.env.E2E_DATABASE_URL || `file:${path.join(here, '.build', 'e2e.db')}`;
const port = Number(process.env.E2E_PORT || 8787);

// No emails, Strava, push services etc. during tests
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) return realFetch(input, init);
  throw new Error(`external network disabled in e2e: ${url}`);
};

const worker = (await import('./.build/worker.mjs')).default;

const env = {
  DATABASE_URL: databaseUrl,
  ENVIRONMENT: 'test',
  UPSTASH_CRON_SECRET: 'e2e-cron-secret',
  FRONTEND_URL: 'http://localhost:5000',
  WORKER_URL: `http://127.0.0.1:${port}`,
  TERRITORY_QUEUE: {
    send: async (body) => {
      // Like a real queue: processed after the request returns
      setTimeout(() => {
        worker
          .queue({ messages: [{ body, ack() {}, retry() { console.error('[e2e queue] retry requested for', body.type); } }] }, env)
          .catch((error) => console.error('[e2e queue] failed:', error));
      }, 50);
    },
  },
};

const ctx = { waitUntil: (promise) => { Promise.resolve(promise).catch(() => {}); }, passThroughOnException() {} };

serve({ fetch: (request) => worker.fetch(request, env, ctx), port, hostname: '127.0.0.1' }, () => {
  console.log(`[e2e] API listening on http://127.0.0.1:${port} (${databaseUrl})`);
});
