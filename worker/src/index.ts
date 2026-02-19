import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { registerRoutes } from './routes';

export interface Env {
  DATABASE_URL: string;
  STRAVA_CLIENT_ID: string;
  STRAVA_CLIENT_SECRET: string;
  STRAVA_WEBHOOK_VERIFY_TOKEN: string;
  STRAVA_REDIRECT_URI?: string;
  POLAR_CLIENT_ID?: string;
  POLAR_CLIENT_SECRET?: string;
  WORKER_URL?: string;
  FRONTEND_URL?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  EMAIL_PROVIDER?: 'resend' | 'sendgrid';
  SENDGRID_API_KEY?: string;
  SENDGRID_FROM?: string;
  UPSTASH_CRON_SECRET?: string;
}

const app = new Hono<{ Bindings: Env }>();

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
}));

registerRoutes(app);

app.get('/', (c) => {
  return c.json({ message: 'Runna.io API - Cloudflare Workers' });
});

export default app;
