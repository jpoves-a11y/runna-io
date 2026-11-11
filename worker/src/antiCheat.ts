// Run validation: decides whether a run counts (accepted), counts but goes to review (flagged) or
// doesn't count (rejected), and cuts impossible stretches (vehicle speed, GPS teleports) out of the
// track before it becomes territory. Pure functions: no database.
//
// Inputs come from every source: the iOS recorder sends per-point timestamps (`pointTimes`), the
// imports (Strava, Polar, Garmin, Suunto, Apple Health) usually only have the track, distance and
// duration. Checks that need timestamps only run when they are present.
import { ANTI_CHEAT } from '../../shared/game';

export type ValidationStatus = 'accepted' | 'flagged' | 'rejected';

export type ValidationReason =
  | 'invalid_duration'
  | 'too_fast'
  | 'too_slow'
  | 'vehicle'
  | 'vehicle_stretch_removed'
  | 'gps_jumps'
  | 'too_steady'
  | 'heart_rate'
  | 'duplicate'
  | 'large_area'
  | 'daily_area'
  | 'reviewed_reverted'
  | 'before_season';

/** Reasons that reject the run (the others only flag it or are informative). */
const REJECTING: ReadonlySet<ValidationReason> = new Set(['invalid_duration', 'too_fast', 'too_slow', 'vehicle', 'duplicate', 'reviewed_reverted', 'before_season']);
/** Reasons that only tell the runner something was cleaned up */
const INFORMATIVE: ReadonlySet<ValidationReason> = new Set(['vehicle_stretch_removed']);

export const REASON_MESSAGES: Record<ValidationReason, string> = {
  invalid_duration: 'La duración de la carrera no es válida, así que no cuenta.',
  too_fast: 'El ritmo medio es demasiado rápido para correr (más rápido que 2:50 min/km). ¿Ibas en bici o en coche? Esta carrera no cuenta.',
  too_slow: 'El ritmo medio es más lento que 12:00 min/km: parece que ibas andando. Esta carrera no cuenta.',
  vehicle: 'Más del 15% del recorrido va a velocidad de bici o coche. Esta carrera no cuenta.',
  vehicle_stretch_removed: 'Hemos quitado del territorio algunos tramos hechos a velocidad de vehículo.',
  gps_jumps: 'El GPS dio varios saltos imposibles. La carrera cuenta, pero queda en revisión.',
  too_steady: 'El ritmo es sospechosamente constante. La carrera cuenta, pero queda en revisión.',
  heart_rate: 'La frecuencia cardíaca no encaja con la velocidad. La carrera cuenta, pero queda en revisión.',
  duplicate: 'Ya tienes otra carrera a la misma hora (por ejemplo, importada de otra app). Solo cuenta una.',
  large_area: 'Esta carrera conquista muchísima área de una vez. Cuenta, pero queda en revisión.',
  daily_area: 'Hoy llevas muchísima área conquistada. Cuenta, pero queda en revisión.',
  reviewed_reverted: 'Tras revisarla, esta carrera ya no cuenta.',
  before_season: 'Esta carrera es anterior a la nueva temporada de Runna, así que no cuenta.',
};

export interface RunInput {
  /** [lat, lng] points */
  coordinates: Array<[number, number]>;
  /** Seconds since the start for each point (same length as coordinates), when known */
  pointTimes?: number[] | null;
  /** Reported distance in metres */
  distance: number;
  /** Reported (moving) duration in seconds */
  duration: number;
  startedAt?: string | null;
  completedAt?: string | null;
  /** Average heart rate, when the source has it */
  avgHeartRate?: number | null;
}

export interface RunStats {
  distanceM: number;
  /** Seconds used for the pace (moving time when timestamps exist) */
  movingTimeS: number;
  avgSpeedKmh: number;
  /** Share of distance above the vehicle speed (only with timestamps) */
  vehicleShare: number;
  maxSpeedKmh: number;
  teleports: number;
  removedDistanceM: number;
  timed: boolean;
}

export interface RunAnalysis {
  status: ValidationStatus;
  reasons: ValidationReason[];
  /** Message for the runner (most important reason), if any */
  message: string | null;
  /** Continuous valid stretches of the track ([lat, lng]); territory is built from these */
  segments: Array<Array<[number, number]>>;
  stats: RunStats;
}

const EARTH_RADIUS_M = 6371008.8;

export function haversineMeters(a: [number, number], b: [number, number]): number {
  const [lat1, lng1] = a;
  const [lat2, lng2] = b;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function validPoint(p: unknown): p is [number, number] {
  return Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])
    && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180 && !(p[0] === 0 && p[1] === 0);
}

export function statusFromReasons(reasons: ValidationReason[]): ValidationStatus {
  if (reasons.some((r) => REJECTING.has(r))) return 'rejected';
  if (reasons.some((r) => !INFORMATIVE.has(r))) return 'flagged';
  return 'accepted';
}

export function messageFor(reasons: ValidationReason[]): string | null {
  const rejecting = reasons.find((r) => REJECTING.has(r));
  if (rejecting) return REASON_MESSAGES[rejecting];
  const flagging = reasons.find((r) => !INFORMATIVE.has(r));
  if (flagging) return REASON_MESSAGES[flagging];
  return reasons.length > 0 ? REASON_MESSAGES[reasons[0]] : null;
}

/** Adds reasons to an existing analysis and recomputes its status and message. */
export function withReasons(analysis: RunAnalysis, extra: ValidationReason[]): RunAnalysis {
  const reasons = [...analysis.reasons];
  for (const r of extra) if (!reasons.includes(r)) reasons.push(r);
  return { ...analysis, reasons, status: statusFromReasons(reasons), message: messageFor(reasons) };
}

interface Leg {
  from: number; // index of the first point
  to: number; // index of the second point
  meters: number;
  seconds: number | null;
  kmh: number | null;
}

/**
 * Speed of each leg, smoothed over a window of at least ~30 m / 10 s so single GPS wobbles don't
 * count as vehicle speed.
 */
function smoothedSpeeds(points: Array<[number, number]>, times: number[]): number[] {
  const n = points.length;
  const cumulative: number[] = [0];
  for (let i = 1; i < n; i++) cumulative.push(cumulative[i - 1] + haversineMeters(points[i - 1], points[i]));
  const speeds: number[] = [];
  for (let i = 1; i < n; i++) {
    let a = i - 1;
    let b = i;
    // widen the window until it covers 30 m and 10 s (or the track ends)
    while ((cumulative[b] - cumulative[a] < 30 || times[b] - times[a] < 10) && (a > 0 || b < n - 1)) {
      if (a > 0) a--;
      if (b < n - 1 && (cumulative[b] - cumulative[a] < 30 || times[b] - times[a] < 10)) b++;
    }
    const dt = times[b] - times[a];
    const dm = cumulative[b] - cumulative[a];
    speeds.push(dt > 0 ? (dm / dt) * 3.6 : Number.POSITIVE_INFINITY);
  }
  return speeds;
}

export function analyzeRun(input: RunInput): RunAnalysis {
  const reasons: ValidationReason[] = [];
  const rawPoints = Array.isArray(input.coordinates) ? input.coordinates : [];
  const timesRaw = Array.isArray(input.pointTimes) && input.pointTimes.length === rawPoints.length ? input.pointTimes : null;

  // Drop invalid points (keeping times aligned)
  const points: Array<[number, number]> = [];
  const times: number[] = [];
  rawPoints.forEach((p, i) => {
    if (!validPoint(p)) return;
    if (timesRaw) {
      const t = Number(timesRaw[i]);
      if (!Number.isFinite(t)) return;
      if (times.length > 0 && t < times[times.length - 1]) return; // out of order
      times.push(t);
    }
    points.push([p[0], p[1]]);
  });
  const timed = !!timesRaw && times.length === points.length && points.length >= 2 && times[times.length - 1] - times[0] > 0;

  // Legs between consecutive points
  const legs: Leg[] = [];
  for (let i = 1; i < points.length; i++) {
    const meters = haversineMeters(points[i - 1], points[i]);
    const seconds = timed ? times[i] - times[i - 1] : null;
    legs.push({ from: i - 1, to: i, meters, seconds, kmh: seconds !== null && seconds > 0 ? (meters / seconds) * 3.6 : null });
  }
  const trackLength = legs.reduce((sum, leg) => sum + leg.meters, 0);

  // ── Teleports and vehicle stretches: legs to cut out of the track ──
  const cut = new Array<boolean>(legs.length).fill(false);
  let teleports = 0;
  let teleportMeters = 0;
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const isTeleport = timed
      ? leg.meters > ANTI_CHEAT.teleportMinM && (leg.seconds === 0 || (leg.kmh !== null && leg.kmh > ANTI_CHEAT.teleportSpeedKmh))
      : leg.meters > ANTI_CHEAT.untimedTeleportM;
    if (isTeleport) {
      teleports++;
      teleportMeters += leg.meters;
      cut[i] = true;
    }
  }

  let vehicleShare = 0;
  let maxSpeedKmh = 0;
  let movingTimeS = Number(input.duration) || 0;
  let removedDistanceM = legs.reduce((sum, leg, i) => sum + (cut[i] ? leg.meters : 0), 0);

  if (timed) {
    const speeds = smoothedSpeeds(points, times);
    let fastMeters = 0;
    let moving = 0;
    let runStart = -1;
    let runMeters = 0;
    const closeRun = (end: number) => {
      if (runStart >= 0 && runMeters >= ANTI_CHEAT.cutSegmentMinM) {
        for (let k = runStart; k < end; k++) {
          if (!cut[k]) { cut[k] = true; removedDistanceM += legs[k].meters; }
        }
        if (!reasons.includes('vehicle_stretch_removed')) reasons.push('vehicle_stretch_removed');
      }
      runStart = -1;
      runMeters = 0;
    };
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const speed = speeds[i];
      if (Number.isFinite(speed)) maxSpeedKmh = Math.max(maxSpeedKmh, speed);
      if (!cut[i]) {
        if (speed > ANTI_CHEAT.vehicleSpeedKmh) fastMeters += leg.meters;
        if (leg.seconds !== null && leg.kmh !== null && leg.kmh >= ANTI_CHEAT.stoppedSpeedKmh) moving += leg.seconds;
      }
      if (speed > ANTI_CHEAT.cutSpeedKmh && !cut[i]) {
        if (runStart < 0) runStart = i;
        runMeters += leg.meters;
      } else {
        closeRun(i);
      }
    }
    closeRun(legs.length);
    const countedMeters = trackLength - teleportMeters;
    vehicleShare = countedMeters > 0 ? fastMeters / countedMeters : 0;
    if (moving > 0) movingTimeS = moving;
  }

  // ── Average pace ──
  // Teleport jumps are not distance you ran
  const distanceM = Math.max(Number(input.distance) || 0, trackLength - teleportMeters);
  const reportedDuration = Number(input.duration) || 0;
  let avgSpeedKmh = 0;

  if (distanceM >= ANTI_CHEAT.minCheckedDistanceM) {
    if (reportedDuration <= 0 && !timed) {
      reasons.push('invalid_duration');
    } else {
      const start = input.startedAt ? Date.parse(input.startedAt) : NaN;
      const end = input.completedAt ? Date.parse(input.completedAt) : NaN;
      // A moving time longer than start->end (plus slack) is faked to slow the pace down
      if (Number.isFinite(start) && Number.isFinite(end) && reportedDuration > (end - start) / 1000 + 300) {
        reasons.push('invalid_duration');
      } else {
        const seconds = timed ? movingTimeS : reportedDuration;
        avgSpeedKmh = seconds > 0 ? (distanceM / 1000) / (seconds / 3600) : 0;
        if (avgSpeedKmh > ANTI_CHEAT.maxAvgSpeedKmh) reasons.push('too_fast');
        else if (avgSpeedKmh > 0 && avgSpeedKmh < ANTI_CHEAT.minAvgSpeedKmh) reasons.push('too_slow');
      }
    }
    if (timed && vehicleShare > ANTI_CHEAT.maxVehicleShare && !reasons.includes('too_fast')) reasons.push('vehicle');
  }

  if (teleports > ANTI_CHEAT.maxTeleports) reasons.push('gps_jumps');

  // ── Too steady (cruise control): per-minute speeds barely change ──
  if (timed && distanceM >= ANTI_CHEAT.minCheckedDistanceM) {
    const minuteSpeeds: number[] = [];
    let bucketStart = times[0];
    let bucketMeters = 0;
    for (let i = 0; i < legs.length; i++) {
      if (cut[i]) continue;
      bucketMeters += legs[i].meters;
      const elapsed = times[legs[i].to] - bucketStart;
      if (elapsed >= 60) {
        minuteSpeeds.push((bucketMeters / elapsed) * 3.6);
        bucketStart = times[legs[i].to];
        bucketMeters = 0;
      }
    }
    if (minuteSpeeds.length >= ANTI_CHEAT.steadyCheckMinMinutes) {
      const mean = minuteSpeeds.reduce((a, b) => a + b, 0) / minuteSpeeds.length;
      const variance = minuteSpeeds.reduce((a, b) => a + (b - mean) ** 2, 0) / minuteSpeeds.length;
      const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
      if (mean >= ANTI_CHEAT.steadyCheckMinSpeedKmh && cv < ANTI_CHEAT.minSpeedVariation) reasons.push('too_steady');
    }
  }

  // ── Heart rate that doesn't match the speed ──
  const hr = Number(input.avgHeartRate);
  if (Number.isFinite(hr) && hr > 0 && avgSpeedKmh >= ANTI_CHEAT.suspiciousHrSpeedKmh && hr < ANTI_CHEAT.suspiciousHrMax) {
    reasons.push('heart_rate');
  }

  // ── Valid stretches ──
  const segments: Array<Array<[number, number]>> = [];
  let current: Array<[number, number]> = [];
  if (points.length > 0) current.push(points[0]);
  for (let i = 0; i < legs.length; i++) {
    if (cut[i]) {
      if (current.length > 0) segments.push(current);
      current = [points[legs[i].to]];
    } else {
      current.push(points[legs[i].to]);
    }
  }
  if (current.length > 0) segments.push(current);

  const status = statusFromReasons(reasons);
  return {
    status,
    reasons,
    message: messageFor(reasons),
    segments: status === 'rejected' ? [] : segments.filter((s) => s.length >= 2),
    stats: {
      distanceM,
      movingTimeS: timed ? movingTimeS : reportedDuration,
      avgSpeedKmh,
      vehicleShare,
      maxSpeedKmh,
      teleports,
      removedDistanceM,
      timed,
    },
  };
}

/** Fraction of interval A covered by interval B (0..1). */
export function timeOverlapShare(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const length = aEnd - aStart;
  if (!(length > 0)) return 0;
  const overlap = Math.min(aEnd, bEnd) - Math.max(aStart, bStart);
  return overlap > 0 ? overlap / length : 0;
}

/** Parses the routes.track_meta column. */
export function parseTrackMeta(value: unknown): { t?: number[]; hr?: number } {
  if (!value) return {};
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object') return {};
    const meta: { t?: number[]; hr?: number } = {};
    if (Array.isArray((parsed as any).t)) meta.t = (parsed as any).t.map(Number);
    if (Number.isFinite(Number((parsed as any).hr))) meta.hr = Number((parsed as any).hr);
    return meta;
  } catch {
    return {};
  }
}
