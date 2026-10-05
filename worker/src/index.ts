import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { registerRoutes } from './routes';
import type { AppEnv } from './auth';
import { handleQueueBatch, type TerritoryQueueMessage } from './queue-consumer';
import { configurePush } from './pushHelper';

export interface Env {
  DATABASE_URL: string;
  TURSO_AUTH_TOKEN: string;
  STRAVA_CLIENT_ID: string;
  STRAVA_CLIENT_SECRET: string;
  STRAVA_WEBHOOK_VERIFY_TOKEN: string;
  STRAVA_REDIRECT_URI?: string;
  POLAR_CLIENT_ID?: string;
  POLAR_CLIENT_SECRET?: string;
  COROS_CLIENT_ID?: string;
  COROS_CLIENT_SECRET?: string;
  WORKER_URL?: string;
  FRONTEND_URL?: string;
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

app.get('/', (c) => {
  return c.json({ message: 'Runna.io API - Cloudflare Workers' });
});

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    configurePush(env);
    return app.fetch(request, env, ctx);
  },
  queue(batch: Parameters<typeof handleQueueBatch>[0], env: Env) {
    configurePush(env);
    return handleQueueBatch(batch, env);
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // Cloudflare Cron Trigger: auto-sync Polar activities every 5 minutes
    const workerUrl = (env as any).WORKER_URL || 'https://runna-io-api.runna-io-api.workers.dev';
    ctx.waitUntil(
      fetch(`${workerUrl}/api/tasks/polar-auto-sync`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${(env as any).UPSTASH_CRON_SECRET || ''}`,
          'Content-Type': 'application/json',
        },
      }).then(r => r.json()).then(result => {
        console.log('[CRON] Polar auto-sync result:', JSON.stringify(result));
      }).catch(err => {
        console.error('[CRON] Polar auto-sync failed:', err);
      })
    );
  },
};
