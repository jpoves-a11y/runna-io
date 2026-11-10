// Scheduled tasks run by the Cloudflare Cron Trigger ("* * * * *", every minute, in wrangler.worker.toml).
//
// Every trigger calls the Hono app in-process (no HTTP round trip to our own workers.dev URL,
// which needs the cron secret and can fail with Cloudflare error 1042). The internal request
// carries env.INTERNAL_CRON = true, which isCronRequest() accepts; a real HTTP request can never
// set a binding, so the /api/tasks/* endpoints stay closed to the outside.
//
// Times are evaluated in Europe/Madrid so the schedule follows Spanish local time across DST.

export const CRON_TIME_ZONE = 'Europe/Madrid';

export type CronTask = 'polar-auto-sync' | 'suunto-auto-sync' | 'spawn-treasure' | 'inactivity-check' | 'weekly-summary' | 'steal-notifications';

/** The device poll (Polar's fallback) runs on the minutes divisible by this. */
const DEVICE_POLL_MINUTES = 3;

export interface LocalTime {
  /** 0 = Sunday ... 6 = Saturday */
  weekday: number;
  hour: number;
  minute: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

let formatter: Intl.DateTimeFormat | null = null;

/** Wall-clock weekday/hour/minute of `time` (ms since epoch) in Europe/Madrid. */
export function madridTime(time: number): LocalTime {
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: CRON_TIME_ZONE,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  }
  let weekday = 0;
  let hour = 0;
  let minute = 0;
  for (const part of formatter.formatToParts(new Date(time))) {
    if (part.type === 'weekday') weekday = WEEKDAYS[part.value] ?? 0;
    else if (part.type === 'hour') hour = Number(part.value) % 24;
    else if (part.type === 'minute') minute = Number(part.value);
  }
  return { weekday, hour, minute };
}

/**
 * Tasks to run for a cron trigger scheduled at `scheduledTime` (ms since epoch); the trigger fires
 * every minute:
 * - steal-notifications: every minute (sends the queued "te han robado" and "tu carrera está lista"
 *   pushes that are due, 3 minutes after the run arrived)
 * - polar-auto-sync: every 3 minutes (fallback poll; Polar's webhook imports at once)
 * - spawn-treasure: at minute 0 of every hour (the handler decides whether today's spawn hour has come)
 * - inactivity-check: 10:00 and 19:00
 * - weekly-summary: Sundays at 20:00
 * - suunto-auto-sync: at minute 30 of every hour (fallback poll; Suunto's webhook is the primary path)
 */
export function tasksDue(scheduledTime: number): CronTask[] {
  const { weekday, hour, minute } = madridTime(scheduledTime);
  const topOfHour = minute === 0;
  const tasks: CronTask[] = [];
  // First: it is quick, and the pushes it sends are the ones people are waiting for
  tasks.push('steal-notifications');
  if (topOfHour) tasks.push('spawn-treasure');
  if (topOfHour && (hour === 10 || hour === 19)) tasks.push('inactivity-check');
  if (topOfHour && weekday === 0 && hour === 20) tasks.push('weekly-summary');
  if (minute === 30) tasks.push('suunto-auto-sync');
  // Last: it is the slowest (up to ~25 s)
  if (minute % DEVICE_POLL_MINUTES === 0) tasks.push('polar-auto-sync');
  return tasks;
}

interface CronApp {
  fetch(request: Request, env: any, ctx: any): Response | Promise<Response>;
}

/** Runs every task due at `scheduledTime` by calling the app in-process, one after another. */
export async function runScheduledTasks<E extends object>(
  app: CronApp,
  scheduledTime: number,
  env: E,
  ctx: { waitUntil(promise: Promise<unknown>): void },
): Promise<Record<string, unknown>> {
  const internalEnv = { ...env, INTERNAL_CRON: true };
  const results: Record<string, unknown> = {};
  for (const task of tasksDue(scheduledTime)) {
    try {
      const response = await app.fetch(
        new Request(`https://internal/api/tasks/${task}`, { method: 'POST' }),
        internalEnv,
        ctx,
      );
      const text = await response.text();
      let body: unknown = text;
      try { body = JSON.parse(text); } catch { /* keep text */ }
      results[task] = { status: response.status, body };
      console.log(`[CRON] ${task} -> ${response.status}: ${text.slice(0, 500)}`);
    } catch (error) {
      results[task] = { error: String(error) };
      console.error(`[CRON] ${task} failed:`, error);
    }
  }
  return results;
}
