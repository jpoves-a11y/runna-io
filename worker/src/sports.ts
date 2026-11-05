/**
 * Runna.io only counts runs: running and trail running outdoors. Walks, hikes and every other
 * sport (cycling, swimming, skiing...) are not imported, and neither are treadmill or virtual runs.
 *
 * Works with the type names of every source: Strava ("Run", "TrailRun", "VirtualRun"),
 * Polar ("RUNNING", "TRAIL_RUNNING", "TREADMILL_RUNNING"...), Garmin ("RUNNING", "TRAIL_RUNNING",
 * "STREET_RUNNING", "INDOOR_RUNNING"...) and our own names ("running", "trail_running").
 */
export function isRunningActivityType(type: unknown): boolean {
  const t = String(type ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (!t) return false;
  if (/treadmill|indoor|virtual|walk|hik|wheelchair|ski|skat/.test(t)) return false;
  return t.includes('run');
}

/** Why an activity of another sport was not imported (stored as skip_reason). */
export const NOT_RUNNING_SKIP_REASON = 'excluded_type';
