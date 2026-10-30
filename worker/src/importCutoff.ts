/**
 * Activities from a connected service (Strava, Polar, Suunto, Garmin) only count from the moment the
 * account was linked: older workouts in the user's history are never imported.
 */

/** Skip reason stored for an activity that started before the account was linked. */
export const BEFORE_CONNECTION = 'before_connection';

/**
 * ms since the epoch of a stored timestamp: ISO strings, or SQLite's CURRENT_TIMESTAMP
 * ("YYYY-MM-DD HH:MM:SS", UTC without a zone). null when missing or unreadable.
 */
export function connectionTimeMs(connectedAt: string | Date | null | undefined): number | null {
  if (!connectedAt) return null;
  if (connectedAt instanceof Date) return Number.isFinite(connectedAt.getTime()) ? connectedAt.getTime() : null;
  const sqlite = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(connectedAt);
  const ms = Date.parse(sqlite ? `${connectedAt.replace(' ', 'T')}Z` : connectedAt);
  return Number.isFinite(ms) ? ms : null;
}

/** True when an activity starting at `startMs` was done before the account was linked. */
export function startedBeforeConnection(startMs: number | null | undefined, connectedAt: string | Date | null | undefined): boolean {
  const cutoff = connectionTimeMs(connectedAt);
  if (cutoff === null || startMs === null || startMs === undefined || !Number.isFinite(startMs)) return false;
  return startMs < cutoff;
}
