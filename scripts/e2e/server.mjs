// Runs the Worker API locally on Node against a SQLite file, for end-to-end tests
// (used by the iOS CI job). Territory queue messages are processed in-process.
//
//   npx esbuild worker/src/index.ts --bundle --format=esm --platform=node --target=node20 \
//     --outfile=scripts/e2e/.build/worker.mjs --alias:@libsql/client/web=@libsql/client --alias:cloudflare:sockets=./scripts/e2e/cloudflare-sockets-stub.mjs --external:@libsql/client
//   DATABASE_URL=file:scripts/e2e/.build/e2e.db npx drizzle-kit push --force
//   node scripts/e2e/server.mjs
//
// E2E_RUN_CRON=1 also runs the Worker's scheduled() handler once at start-up (all tasks due at
// E2E_CRON_TIME, an ISO date; default now), the same way the Cloudflare Cron Trigger does.
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

// Season calendar for the tests: the first competition started on the last Friday at least 2 days
// ago, so "now" is inside a running competition (day 3 to 9). E2E_SEASON_ANCHOR overrides it.
function defaultSeasonAnchor() {
  const day = new Date();
  day.setUTCHours(12, 0, 0, 0);
  day.setUTCDate(day.getUTCDate() - 2);
  while (day.getUTCDay() !== 5) day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}
const seasonAnchor = process.env.E2E_SEASON_ANCHOR || defaultSeasonAnchor();

let chain = Promise.resolve();
const env = {
  DATABASE_URL: databaseUrl,
  SEASON_ANCHOR_DATE: seasonAnchor,
  // Cloudflare's free plan: 50 subrequests per invocation (long jobs resume on the next run)
  SUBREQUEST_LIMIT: process.env.E2E_SUBREQUEST_LIMIT || 50,
  ENVIRONMENT: 'test',
  UPSTASH_CRON_SECRET: 'e2e-cron-secret',
  FRONTEND_URL: 'http://localhost:5000',
  WORKER_URL: `http://127.0.0.1:${port}`,
  TERRITORY_QUEUE: {
    send: async (body) => {
      // Like a real queue: processed after the request returns
      setTimeout(() => {
        const stats = globalThis.__runnaDbStats;
        const run = () => {
          const before = stats?.statements ?? 0;
          if (process.env.E2E_SQL_TRACE) globalThis.__runnaDbTrace = [];
          return worker
            .queue({ messages: [{ body, ack() {}, retry() { console.error('[e2e queue] retry requested for', body.type); } }] }, env)
            .then(() => {
              if (process.env.E2E_SUBREQUEST_LOG && stats) console.log(`[subrequests] ${stats.statements - before} QUEUE ${body.type}`);
              if (process.env.E2E_SQL_TRACE) { for (const line of globalThis.__runnaDbTrace) console.log(`[sql] ${line}`); globalThis.__runnaDbTrace = null; }
            })
            .catch((error) => console.error('[e2e queue] failed:', error));
        };
        if (process.env.E2E_SUBREQUEST_LOG) chain = chain.then(run); else run();
      }, 50);
    },
  },
};

const ctx = { waitUntil: (promise) => { Promise.resolve(promise).catch(() => {}); }, passThroughOnException() {} };

// Database round trips per request (Cloudflare counts each one as a subrequest: 50 on the free plan).
// E2E_SUBREQUEST_LOG=1 prints them; requests run one at a time so the counts don't mix.
const measured = async (request) => {
  const stats = globalThis.__runnaDbStats;
  if (!process.env.E2E_SUBREQUEST_LOG || !stats) return worker.fetch(request, env, ctx);
  const run = chain.then(async () => {
    const before = stats.statements;
    const response = await worker.fetch(request, env, ctx);
    const used = stats.statements - before;
    const url = new URL(request.url);
    console.log(`[subrequests] ${used} ${request.method} ${url.pathname}`);
    return response;
  });
  chain = run.catch(() => {});
  return run;
};
serve({ fetch: measured, port, hostname: '127.0.0.1' }, () => {
  console.log(`[e2e] API listening on http://127.0.0.1:${port} (${databaseUrl}), season anchor ${seasonAnchor}`);
  if (process.env.E2E_RUN_CRON === '1') runCronOnce();
});

function runCronOnce() {
  const scheduledTime = process.env.E2E_CRON_TIME ? Date.parse(process.env.E2E_CRON_TIME) : Date.now();
  const pending = [];
  const cronCtx = { waitUntil: (promise) => { pending.push(Promise.resolve(promise)); }, passThroughOnException() {} };
  try {
    worker.scheduled({ cron: '* * * * *', scheduledTime, type: 'scheduled' }, env, cronCtx);
  } catch (error) {
    console.error('[e2e cron] scheduled() threw:', error);
    return;
  }
  Promise.allSettled(pending).then(() => console.log(`[e2e cron] scheduled run finished (${new Date(scheduledTime).toISOString()})`));
}
