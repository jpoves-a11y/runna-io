import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { registerRoutes } from './routes';
import { registerSuuntoRoutes } from './suunto';
import type { AppEnv } from './auth';
import { handleQueueBatch, type TerritoryQueueMessage } from './queue-consumer';
import { configurePush } from './pushHelper';
import { runScheduledTasks } from './cron';
import { registerPublicPages } from './pages';
import { createDb } from './db';
import { WorkerStorage } from './storage';

export interface Env {
  DATABASE_URL: string;
  TURSO_AUTH_TOKEN: string;
  STRAVA_CLIENT_ID: string;
  STRAVA_CLIENT_SECRET: string;
  STRAVA_WEBHOOK_VERIFY_TOKEN: string;
  STRAVA_REDIRECT_URI?: string;
  POLAR_CLIENT_ID?: string;
  POLAR_CLIENT_SECRET?: string;
  // signature_secret_key of the Polar AccessLink webhook (POST /api/admin/polar/webhook/register returns it)
  POLAR_WEBHOOK_SECRET?: string;
  COROS_CLIENT_ID?: string;
  COROS_CLIENT_SECRET?: string;
  // Suunto Cloud API (apizone.suunto.com): OAuth client, API subscription key, optional webhook HMAC secret
  SUUNTO_CLIENT_ID?: string;
  SUUNTO_CLIENT_SECRET?: string;
  SUUNTO_SUBSCRIPTION_KEY?: string;
  SUUNTO_WEBHOOK_SECRET?: string;
  // Public base URL of this Worker (invite links, legal pages, email buttons)
  WORKER_URL?: string;
  FRONTEND_URL?: string;
  // Optional App Store / TestFlight link shown on the invite and /open landing pages
  APP_DOWNLOAD_URL?: string;
  // Set only by the scheduled() handler for in-process cron calls; a request can never set it
  INTERNAL_CRON?: boolean;
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  EMAIL_PROVIDER?: 'resend' | 'sendgrid';
  SENDGRID_API_KEY?: string;
  SENDGRID_FROM?: string;
  UPSTASH_CRON_SECRET?: string;
  // QStash request signing keys (verify the Upstash-Signature header on cron calls)
  QSTASH_CURRENT_SIGNING_KEY?: string;
  QSTASH_NEXT_SIGNING_KEY?: string;
  ENVIRONMENT?: string;
  // Web push (VAPID)
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  // Apple Push Notification service for the iOS app (.p8 key from developer.apple.com)
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_PRIVATE_KEY?: string;
  APNS_BUNDLE_ID?: string;
  // Cloudflare Queue for async territory processing
  TERRITORY_QUEUE: Queue<TerritoryQueueMessage>;
}

const app = new Hono<AppEnv>();

app.use('*', logger());
app.use('*', cors({
  origin: (origin) => {
    // Allow requests from any Cloudflare Pages subdomain, proxy worker, or localhost
    const allowedOrigins = [
      'https://runna-io.pages.dev',
      'https://runna-io-web.runna-io-api.workers.dev',
      'http://localhost:5000',
      'http://localhost:3000',
    ];
    // Also allow any *.runna-io.pages.dev subdomain (preview deployments)
    if (origin && (allowedOrigins.includes(origin) || origin.endsWith('.runna-io.pages.dev') || origin.endsWith('.workers.dev'))) {
      return origin;
    }
    // For other origins, return the first allowed origin
    return allowedOrigins[0];
  },
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
  // Requests now carry an Authorization header, so browsers preflight them; let them cache it
  maxAge: 86400,
}));

registerRoutes(app);
registerSuuntoRoutes(app);
registerPublicPages(app);

app.get('/', (c) => {
  return c.json({ message: 'Runna.io API - Cloudflare Workers' });
});

/** Adds columns/tables newer than the database (once per isolate; errors are logged, not thrown). */
function ensureSchema(env: Env): Promise<void> {
  if (!env.DATABASE_URL) return Promise.resolve();
  try {
    return new WorkerStorage(createDb(env.DATABASE_URL, env.TURSO_AUTH_TOKEN)).ensureSchemaUpgrades();
  } catch (error) {
    console.error('[SCHEMA] Could not open the database:', error);
    return Promise.resolve();
  }
}

/** Read-path indexes (once per isolate), without delaying the request that triggers them. */
function ensureIndexesInBackground(env: Env, ctx: ExecutionContext): void {
  if (!env.DATABASE_URL) return;
  try {
    ctx.waitUntil(new WorkerStorage(createDb(env.DATABASE_URL, env.TURSO_AUTH_TOKEN)).ensureReadPathIndexes());
  } catch (error) {
    console.error('[SCHEMA] Could not schedule index creation:', error);
  }
}

/** Paths that never touch the database (static pages) skip the schema check. */
function needsDatabase(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return pathname.startsWith('/api/');
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    configurePush(env);
    if (needsDatabase(request)) {
      await ensureSchema(env);
      ensureIndexesInBackground(env, ctx);
    }
    return app.fetch(request, env, ctx);
  },
  async queue(batch: Parameters<typeof handleQueueBatch>[0], env: Env) {
    configurePush(env);
    await ensureSchema(env);
    return handleQueueBatch(batch, env);
  },
  scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // Cloudflare Cron Trigger ("*/5 * * * *"): runs the due /api/tasks/* in-process (see cron.ts)
    configurePush(env);
    ctx.waitUntil(
      ensureSchema(env)
        .then(() => runScheduledTasks(app, event.scheduledTime, env, ctx))
        .catch((err) => {
          console.error('[CRON] Scheduled run failed:', err);
        }),
    );
  },
};
