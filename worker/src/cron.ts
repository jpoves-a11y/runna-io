// Scheduled tasks run by the Cloudflare Cron Trigger ("*/5 * * * *" in wrangler.worker.toml).
//
// Every trigger calls the Hono app in-process (no HTTP round trip to our own workers.dev URL,
// which needs the cron secret and can fail with Cloudflare error 1042). The internal request
// carries env.INTERNAL_CRON = true, which isCronRequest() accepts; a real HTTP request can never
// set a binding, so the /api/tasks/* endpoints stay closed to the outside.
//
// Times are evaluated in Europe/Madrid so the schedule follows Spanish local time across DST.

export const CRON_TIME_ZONE = 'Europe/Madrid';

export type CronTask = 'polar-auto-sync' | 'suunto-auto-sync' | 'spawn-treasure' | 'inactivity-check' | 'weekly-summary';

/** The trigger fires every 5 minutes, so "at minute 0" means the run in [:00, :05). */
const SLOT_MINUTES = 5;

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

let dateFormatter: Intl.DateTimeFormat | null = null;

/**
 * Monday 00:00 of the current week in Europe/Madrid, as a UTC Date. (In the week of a DST change the
 * offset of "now" is used, so the boundary can be an hour off; harmless for a ranking.)
 */
export function madridWeekStart(time: number): Date {
  if (!dateFormatter) {
    dateFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: CRON_TIME_ZONE,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  }
  const values: Record<string, string> = {};
  for (const part of dateFormatter.formatToParts(new Date(time))) values[part.type] = part.value;
  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);
  const localAsUtc = Date.UTC(year, month - 1, day, Number(values.hour) % 24, Number(values.minute), Number(values.second));
  const offset = localAsUtc - Math.floor(time / 1000) * 1000;
  const weekday = WEEKDAYS[values.weekday] ?? 0;
  const daysSinceMonday = (weekday + 6) % 7;
  return new Date(Date.UTC(year, month - 1, day - daysSinceMonday) - offset);
}

/**
 * Tasks to run for a cron trigger scheduled at `scheduledTime` (ms since epoch):
 * - polar-auto-sync: every run (every 5 minutes)
 * - spawn-treasure: at minute 0 of every hour (the handler decides whether today's spawn hour has come)
 * - inactivity-check: 10:00 and 19:00
 * - weekly-summary: Sundays at 20:00
 * - suunto-auto-sync: at minute 30 of every hour (fallback poll; Suunto's webhook is the primary path)
 */
export function tasksDue(scheduledTime: number): CronTask[] {
  const { weekday, hour, minute } = madridTime(scheduledTime);
  const topOfHour = minute < SLOT_MINUTES;
  const tasks: CronTask[] = [];
  if (topOfHour) tasks.push('spawn-treasure');
  if (topOfHour && (hour === 10 || hour === 19)) tasks.push('inactivity-check');
  if (topOfHour && weekday === 0 && hour === 20) tasks.push('weekly-summary');
  if (minute >= 30 && minute < 30 + SLOT_MINUTES) tasks.push('suunto-auto-sync');
  // Last: it is the slowest (up to ~25 s) and runs every time anyway
  tasks.push('polar-auto-sync');
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
