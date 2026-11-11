// Season calendar: 14-day cycles in Europe/Madrid local time (see shared/game.ts).
// Pure functions, no database: the same instant always gives the same cycle and phase.
import {
  SEASON_TIME_ZONE,
  SEASON_ANCHOR_DATE,
  CYCLE_DAYS,
  COMPETITION_DAYS,
  LATE_JOIN_HOURS,
  MODE_ROTATION,
  type CompetitionMode,
} from '../../shared/game';

export type CyclePhase = 'competition' | 'rest' | 'preseason';

export interface CycleInfo {
  /** Cycle number (0 = first competition). -1 before the season starts. */
  number: number;
  phase: CyclePhase;
  /** ISO instants */
  competitionStartsAt: string;
  competitionEndsAt: string;
  restEndsAt: string;
  /** Mode of this cycle's competition (fallbacks per club are decided by the engine) */
  mode: CompetitionMode;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Local date of cycle 0. SEASON_ANCHOR_DATE (Worker variable, a Friday) can override the default. */
let anchorDate = SEASON_ANCHOR_DATE;
export function setSeasonAnchor(ymd: string | null | undefined): void {
  if (ymd && /^\d{4}-\d{2}-\d{2}$/.test(ymd) && !Number.isNaN(Date.parse(ymd))) anchorDate = ymd;
}
export function seasonAnchor(): string {
  return anchorDate;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

interface WallClock { year: number; month: number; day: number; hour: number; minute: number; second: number }

export function wallClock(time: number, timeZone = SEASON_TIME_ZONE): WallClock {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(time))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year, month: parts.month, day: parts.day,
    hour: (parts.hour ?? 0) % 24, minute: parts.minute ?? 0, second: parts.second ?? 0,
  };
}

/** Offset of `timeZone` from UTC at `time`, in ms (Madrid: +1h or +2h). */
export function zoneOffsetMs(time: number, timeZone = SEASON_TIME_ZONE): number {
  const w = wallClock(time, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(time / 1000) * 1000;
}

/** Local date "YYYY-MM-DD" of `time` in `timeZone`. */
export function localDate(time: number, timeZone = SEASON_TIME_ZONE): string {
  const w = wallClock(time, timeZone);
  return `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
}

/** Local hour (0-23) of `time` in `timeZone`. */
export function localHour(time: number, timeZone = SEASON_TIME_ZONE): number {
  return wallClock(time, timeZone).hour;
}

/** UTC instant (ms) of local midnight starting `ymd` in `timeZone`. */
export function localMidnight(ymd: string, timeZone = SEASON_TIME_ZONE): number {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let result = guess - zoneOffsetMs(guess, timeZone);
  // The offset at the result can differ from the one at the guess around a DST change
  const corrected = guess - zoneOffsetMs(result, timeZone);
  if (corrected !== result) result = corrected;
  return result;
}

/** "YYYY-MM-DD" plus `days` calendar days. */
export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** Whole calendar days from `a` to `b` (both "YYYY-MM-DD"). */
export function daysBetween(a: string, b: string): number {
  const [ya, ma, da] = a.split('-').map(Number);
  const [yb, mb, db] = b.split('-').map(Number);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / DAY_MS);
}

export function modeForCycle(number: number): CompetitionMode {
  const n = ((number % MODE_ROTATION.length) + MODE_ROTATION.length) % MODE_ROTATION.length;
  return MODE_ROTATION[n];
}

/** Bounds of cycle `number` (ms since epoch). */
export function cycleBounds(number: number, anchor = anchorDate): { competitionStart: number; competitionEnd: number; restEnd: number } {
  const start = addDays(anchor, number * CYCLE_DAYS);
  return {
    competitionStart: localMidnight(start),
    competitionEnd: localMidnight(addDays(start, COMPETITION_DAYS)),
    restEnd: localMidnight(addDays(start, CYCLE_DAYS)),
  };
}

export function cycleInfo(number: number, phase: CyclePhase, anchor = anchorDate): CycleInfo {
  const bounds = cycleBounds(number, anchor);
  return {
    number,
    phase,
    competitionStartsAt: new Date(bounds.competitionStart).toISOString(),
    competitionEndsAt: new Date(bounds.competitionEnd).toISOString(),
    restEndsAt: new Date(bounds.restEnd).toISOString(),
    mode: modeForCycle(number),
  };
}

/**
 * Cycle and phase at `time`. Before the first competition it is "preseason" of cycle -1, whose
 * rest phase ends when cycle 0 starts (rest features — chests, challenges — already work then).
 */
export function cycleAt(time: number, anchor = anchorDate): CycleInfo {
  const days = daysBetween(anchor, localDate(time));
  if (days < 0) {
    const info = cycleInfo(-1, 'preseason', anchor);
    return info;
  }
  const number = Math.floor(days / CYCLE_DAYS);
  const dayInCycle = days - number * CYCLE_DAYS;
  return cycleInfo(number, dayInCycle < COMPETITION_DAYS ? 'competition' : 'rest', anchor);
}

/** Rest features (chests, challenges) are on during rest and preseason. */
export function isRestLike(phase: CyclePhase): boolean {
  return phase === 'rest' || phase === 'preseason';
}

/** Start/end (ms) of the rest window of a cycle: preseason runs until cycle 0 starts. */
export function restWindow(info: CycleInfo): { start: number; end: number } {
  if (info.phase === 'preseason') return { start: 0, end: Date.parse(info.restEndsAt) };
  return { start: Date.parse(info.competitionEndsAt), end: Date.parse(info.restEndsAt) };
}

/** True during the first LATE_JOIN_HOURS of a competition. */
export function inLateJoinWindow(info: CycleInfo, time: number): boolean {
  if (info.phase !== 'competition') return false;
  return time - Date.parse(info.competitionStartsAt) <= LATE_JOIN_HOURS * 60 * 60 * 1000;
}

/** "YYYY-MM" of `time` in Madrid (period of the monthly ranking). */
export function monthPeriod(time: number): string {
  return localDate(time).slice(0, 7);
}
