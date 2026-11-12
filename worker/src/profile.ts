/**
 * Activity profile: distance, time and altitude of each point of a run, and what the activity
 * screen shows from it (altitude/distance profile, pace chart, km splits, climbs, highlights).
 *
 * The profile is stored compactly per route (route_streams.profile) whatever the source:
 * the iOS app and Apple Health send times and altitudes with the run, Garmin and Suunto send them
 * with the activity, Strava (streams) and Polar (GPX) are asked for them when the activity is opened.
 */

/** Stored profile: cumulative metres, seconds since the start and altitude of each sample. */
export interface StoredProfile {
  v: 1;
  /** metres from the start (non-decreasing) */
  d: number[];
  /** seconds since the start (non-decreasing), when the source has times */
  t?: number[] | null;
  /** metres above sea level, null where unknown, when the source has altitudes */
  e?: Array<number | null> | null;
}

export interface ProfilePoint {
  lat: number;
  lng: number;
  /** ms since the epoch */
  time?: number | null;
  /** metres above sea level */
  ele?: number | null;
  /** metres from the start, from the device */
  dist?: number | null;
}

const MAX_STORED_SAMPLES = 1500;

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const validAltitude = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > -500 && value < 9000;

/** Builds the stored profile from the points of a run. Null with fewer than 2 usable points. */
export function buildProfile(input: ProfilePoint[], startMs?: number | null): StoredProfile | null {
  const points = input.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180);
  if (points.length < 2) return null;

  // Distance: the device's when every point has it and it only goes forward, else along the track
  const deviceDist = points.every((p) => typeof p.dist === 'number' && Number.isFinite(p.dist))
    && points.every((p, i) => i === 0 || (p.dist as number) >= (points[i - 1].dist as number) - 0.5);
  const d: number[] = [];
  for (let i = 0; i < points.length; i++) {
    if (deviceDist) d.push(Math.max(0, (points[i].dist as number) - (points[0].dist as number)));
    else d.push(i === 0 ? 0 : d[i - 1] + haversine(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng));
  }
  for (let i = 1; i < d.length; i++) if (d[i] < d[i - 1]) d[i] = d[i - 1];
  if (d[d.length - 1] <= 0) return null;

  // Times: kept when most points have one (the gaps are interpolated by distance)
  let t: number[] | null = null;
  const timed = points.filter((p) => typeof p.time === 'number' && Number.isFinite(p.time)).length;
  if (timed >= points.length * 0.8) {
    const raw = points.map((p) => (typeof p.time === 'number' && Number.isFinite(p.time) ? p.time : NaN));
    const origin = typeof startMs === 'number' && Number.isFinite(startMs) && startMs <= (raw.find(Number.isFinite) ?? Infinity)
      ? startMs
      : (raw.find(Number.isFinite) as number);
    t = fillByDistance(raw.map((ms) => (Number.isFinite(ms) ? (ms - origin) / 1000 : NaN)), d);
    for (let i = 1; i < t.length; i++) if (t[i] < t[i - 1]) t[i] = t[i - 1];
  }

  // Altitudes: kept when at least half the points have one
  let e: Array<number | null> | null = null;
  const withAltitude = points.filter((p) => validAltitude(p.ele)).length;
  if (withAltitude >= points.length * 0.5) {
    e = points.map((p) => (validAltitude(p.ele) ? p.ele : null));
  }

  // Downsample evenly
  let indexes = points.map((_, i) => i);
  if (indexes.length > MAX_STORED_SAMPLES) {
    const step = (indexes.length - 1) / (MAX_STORED_SAMPLES - 1);
    indexes = Array.from({ length: MAX_STORED_SAMPLES }, (_, i) => Math.round(i * step));
  }
  return {
    v: 1,
    d: indexes.map((i) => Math.round(d[i] * 10) / 10),
    t: t ? indexes.map((i) => Math.round(t![i])) : null,
    e: e ? indexes.map((i) => (e![i] === null ? null : Math.round((e![i] as number) * 10) / 10)) : null,
  };
}

/** Fills NaN entries of `values` by linear interpolation over `d` (and holds the ends). */
function fillByDistance(values: number[], d: number[]): number[] {
  const out = values.slice();
  const known = out.map((v, i) => (Number.isFinite(v) ? i : -1)).filter((i) => i >= 0);
  if (known.length === 0) return out.map(() => 0);
  for (let i = 0; i < out.length; i++) {
    if (Number.isFinite(out[i])) continue;
    let lo = -1;
    let hi = -1;
    for (const k of known) {
      if (k < i) lo = k;
      else { hi = k; break; }
    }
    if (lo < 0) out[i] = out[hi];
    else if (hi < 0) out[i] = out[lo];
    else {
      const span = d[hi] - d[lo];
      out[i] = span > 0 ? out[lo] + ((out[hi] - out[lo]) * (d[i] - d[lo])) / span : out[lo];
    }
  }
  return out;
}

/** Reads a stored profile (JSON text), or null if it isn't one. */
export function parseStoredProfile(text: string | null | undefined): StoredProfile | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.d) || parsed.d.length < 2) return null;
    if (parsed.t && (!Array.isArray(parsed.t) || parsed.t.length !== parsed.d.length)) parsed.t = null;
    if (parsed.e && (!Array.isArray(parsed.e) || parsed.e.length !== parsed.d.length)) parsed.e = null;
    return parsed as StoredProfile;
  } catch {
    return null;
  }
}

// ─── Sources ─────────────────────────────────────────────────────────────────

/** Points of a GPX file (Polar): position, altitude (<ele>) and time (<time>) of each <trkpt>. */
export function parseGpxPoints(gpx: string): ProfilePoint[] {
  const points: ProfilePoint[] = [];
  const trkpt = /<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>|<trkpt\b([^>]*)\/>/g;
  let match: RegExpExecArray | null;
  while ((match = trkpt.exec(gpx)) !== null) {
    const attrs = match[1] ?? match[3] ?? '';
    const body = match[2] ?? '';
    const lat = Number(/lat="([^"]+)"/.exec(attrs)?.[1]);
    const lng = Number(/lon="([^"]+)"/.exec(attrs)?.[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const ele = Number(/<ele>([^<]+)<\/ele>/.exec(body)?.[1]);
    const time = Date.parse(/<time>([^<]+)<\/time>/.exec(body)?.[1] ?? '');
    points.push({ lat, lng, ele: Number.isFinite(ele) ? ele : null, time: Number.isFinite(time) ? time : null });
  }
  return points;
}

/** Points of Strava streams (GET /activities/{id}/streams?keys=latlng,time,altitude,distance&key_by_type=true). */
export function stravaStreamsToPoints(streams: any, startMs: number): ProfilePoint[] {
  const latlng: unknown[] = Array.isArray(streams?.latlng?.data) ? streams.latlng.data : [];
  const time: unknown[] = Array.isArray(streams?.time?.data) ? streams.time.data : [];
  const altitude: unknown[] = Array.isArray(streams?.altitude?.data) ? streams.altitude.data : [];
  const distance: unknown[] = Array.isArray(streams?.distance?.data) ? streams.distance.data : [];
  const points: ProfilePoint[] = [];
  latlng.forEach((pair, i) => {
    if (!Array.isArray(pair) || pair.length < 2) return;
    const seconds = Number(time[i]);
    points.push({
      lat: Number(pair[0]),
      lng: Number(pair[1]),
      time: Number.isFinite(seconds) ? startMs + seconds * 1000 : null,
      ele: Number.isFinite(Number(altitude[i])) ? Number(altitude[i]) : null,
      dist: Number.isFinite(Number(distance[i])) ? Number(distance[i]) : null,
    });
  });
  return points;
}

// ─── Analysis ────────────────────────────────────────────────────────────────

export interface ProfileAnalysis {
  /** What the profile has: pace needs times, the altitude profile and climbs need altitudes. */
  hasPace: boolean;
  hasElevation: boolean;
  /** Chart samples: d km, e altitude (m), p pace (s/km, null when stopped), g grade (%) */
  series: Array<{ d: number; e: number | null; p: number | null; g: number | null }>;
  splits: Array<{
    index: number;
    /** metres of this split (1000 except the last one) */
    distance: number;
    /** moving seconds */
    duration: number;
    /** s/km */
    pace: number;
    elevationGain: number | null;
    elevationLoss: number | null;
  }>;
  climbs: Array<{
    startKm: number;
    endKm: number;
    /** metres */
    length: number;
    gain: number;
    avgGrade: number;
    maxGrade: number;
    /** moving seconds on the climb */
    duration: number | null;
    /** vertical metres per hour */
    vam: number | null;
  }>;
  stats: {
    distance: number;
    movingTime: number | null;
    elapsedTime: number | null;
    avgPace: number | null;
    bestKmPace: number | null;
    bestKmStartKm: number | null;
    fastestSplit: number | null;
    slowestSplit: number | null;
    firstHalfPace: number | null;
    secondHalfPace: number | null;
    elevationGain: number | null;
    elevationLoss: number | null;
    minElevation: number | null;
    maxElevation: number | null;
    maxGrade: number | null;
  };
}

/** Below this speed for at least PAUSE_MIN_S, the runner was stopped (not moving time). */
const PAUSE_SPEED_MS = 0.5;
const PAUSE_MIN_S = 10;
/** Paces outside this range are GPS noise or a stop (s/km). */
const MIN_PACE = 120;
const MAX_PACE = 1500;
/** Altitude changes smaller than this are GPS noise (hysteresis for ascent/descent). */
const ELEVATION_THRESHOLD_M = 3;

const round1 = (x: number) => Math.round(x * 10) / 10;

/** Index i with d[i] <= x < d[i+1] (d non-decreasing). */
function segmentAt(d: number[], x: number): number {
  let lo = 0;
  let hi = d.length - 1;
  if (x <= d[0]) return 0;
  if (x >= d[hi]) return hi - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (d[mid] <= x) lo = mid;
    else hi = mid;
  }
  return lo;
}

function interpolate(d: number[], values: number[], x: number): number {
  const i = segmentAt(d, x);
  const span = d[i + 1] - d[i];
  if (!(span > 0)) return values[i];
  return values[i] + ((values[i + 1] - values[i]) * (x - d[i])) / span;
}

/**
 * Everything the activity screen draws, from a stored profile. `routeDistance` (metres) rescales
 * the profile to the distance shown for the activity, so charts and summary agree.
 */
export function analyzeProfile(profile: StoredProfile, routeDistance?: number | null): ProfileAnalysis {
  const rawTotal = profile.d[profile.d.length - 1];
  const scale = routeDistance && routeDistance > 0 && rawTotal > 0 && Math.abs(routeDistance / rawTotal - 1) < 0.3
    ? routeDistance / rawTotal
    : 1;
  const d = profile.d.map((x) => x * scale);
  const total = d[d.length - 1];
  const n = d.length;

  // Moving time: stops (slower than PAUSE_SPEED for a while) don't count
  let moving: number[] | null = null;
  let elapsed: number | null = null;
  if (profile.t && profile.t.length === n) {
    const t = profile.t;
    moving = [0];
    for (let i = 1; i < n; i++) {
      const dt = Math.max(0, t[i] - t[i - 1]);
      const dd = d[i] - d[i - 1];
      const stopped = dt >= PAUSE_MIN_S && dd / dt < PAUSE_SPEED_MS;
      moving.push(moving[i - 1] + (stopped ? 0 : dt));
    }
    elapsed = t[n - 1] - t[0];
    if (!(moving[n - 1] > 0)) moving = null;
  }

  // Altitudes filled by distance, then smoothed over ~±60 m on a regular grid
  let elevation: number[] | null = null;
  if (profile.e && profile.e.length === n && profile.e.some((v) => v !== null)) {
    elevation = fillByDistance(profile.e.map((v) => (v === null ? NaN : v)), d);
  }

  const step = Math.min(100, Math.max(10, total / 300));
  const grid: number[] = [];
  for (let x = 0; x < total; x += step) grid.push(x);
  grid.push(total);

  let gridElevation: number[] | null = null;
  if (elevation) {
    const raw = grid.map((x) => interpolate(d, elevation!, x));
    const half = Math.max(1, Math.round(60 / step));
    gridElevation = raw.map((_, i) => {
      let sum = 0;
      let count = 0;
      for (let k = Math.max(0, i - half); k <= Math.min(raw.length - 1, i + half); k++) {
        sum += raw[k];
        count++;
      }
      return sum / count;
    });
  }
  const gridMoving = moving ? grid.map((x) => interpolate(d, moving!, x)) : null;
  const movingAt = (x: number) => interpolate(d, moving!, Math.max(0, Math.min(total, x)));

  // Ascent and descent with hysteresis, attributed to the grid point where they are counted
  const gainAt = new Array(grid.length).fill(0);
  const lossAt = new Array(grid.length).fill(0);
  if (gridElevation) {
    let reference = gridElevation[0];
    for (let i = 1; i < grid.length; i++) {
      const delta = gridElevation[i] - reference;
      if (delta >= ELEVATION_THRESHOLD_M) {
        gainAt[i] = delta;
        reference = gridElevation[i];
      } else if (delta <= -ELEVATION_THRESHOLD_M) {
        lossAt[i] = -delta;
        reference = gridElevation[i];
      }
    }
  }

  // Grade over ±50 m
  const gradeAt: Array<number | null> = grid.map((x, i) => {
    if (!gridElevation) return null;
    const w = Math.max(1, Math.round(50 / step));
    const a = Math.max(0, i - w);
    const b = Math.min(grid.length - 1, i + w);
    const run = grid[b] - grid[a];
    if (run < 40) return null;
    const grade = ((gridElevation[b] - gridElevation[a]) / run) * 100;
    return Math.max(-40, Math.min(40, grade));
  });

  // Pace over a 200 m window
  const paceAt: Array<number | null> = grid.map((x) => {
    if (!moving) return null;
    const h = Math.max(step, 100);
    const a = Math.max(0, x - h);
    const b = Math.min(total, x + h);
    if (b - a < 50) return null;
    const pace = ((movingAt(b) - movingAt(a)) / (b - a)) * 1000;
    return pace >= MIN_PACE && pace <= MAX_PACE ? pace : null;
  });

  const series = grid.map((x, i) => ({
    d: Math.round((x / 1000) * 1000) / 1000,
    e: gridElevation ? round1(gridElevation[i]) : null,
    p: paceAt[i] !== null ? Math.round(paceAt[i] as number) : null,
    g: gradeAt[i] !== null ? round1(gradeAt[i] as number) : null,
  }));

  const sumRange = (values: number[], from: number, to: number) => {
    let sum = 0;
    for (let i = 0; i < grid.length; i++) if (grid[i] > from && grid[i] <= to) sum += values[i];
    return sum;
  };

  // Km splits (the last one when at least 100 m)
  const splits: ProfileAnalysis['splits'] = [];
  if (moving) {
    for (let start = 0, index = 1; start < total; start += 1000, index++) {
      const end = Math.min(total, start + 1000);
      const length = end - start;
      if (length < 100 && index > 1) break;
      const duration = movingAt(end) - movingAt(start);
      if (!(duration > 0)) continue;
      splits.push({
        index,
        distance: Math.round(length),
        duration: Math.round(duration),
        pace: Math.round((duration / length) * 1000),
        elevationGain: gridElevation ? Math.round(sumRange(gainAt, start, end)) : null,
        elevationLoss: gridElevation ? Math.round(sumRange(lossAt, start, end)) : null,
      });
    }
  }
  const fullSplits = splits.filter((s) => s.distance >= 950);
  let fastest = fullSplits.length > 1 ? fullSplits.reduce((a, b) => (b.pace < a.pace ? b : a)) : null;
  let slowest = fullSplits.length > 1 ? fullSplits.reduce((a, b) => (b.pace > a.pace ? b : a)) : null;
  // An even run has no fastest or slowest km worth pointing out
  if (fastest && slowest && slowest.pace - fastest.pace < 3) {
    fastest = null;
    slowest = null;
  }

  // Best kilometre anywhere in the run
  let bestKmPace: number | null = null;
  let bestKmStart: number | null = null;
  if (moving && total >= 1000) {
    for (const x of grid) {
      if (x + 1000 > total) break;
      const duration = movingAt(x + 1000) - movingAt(x);
      if (duration >= MIN_PACE && (bestKmPace === null || duration < bestKmPace)) {
        bestKmPace = duration;
        bestKmStart = x;
      }
    }
  }

  // Climbs: from a low point, up at least 15 m, ending where it drops 10 m below its top
  const climbs: ProfileAnalysis['climbs'] = [];
  if (gridElevation) {
    const E = gridElevation;
    let minIdx = 0;
    let startIdx = -1;
    let topIdx = 0;
    const close = () => {
      // The low point can be anywhere on the flat before the climb (GPS noise): start where it really rises
      for (let k = topIdx; k > startIdx; k--) {
        if (E[k] <= E[startIdx] + 2) {
          startIdx = k;
          break;
        }
      }
      const gain = E[topIdx] - E[startIdx];
      const length = grid[topIdx] - grid[startIdx];
      const avgGrade = length > 0 ? (gain / length) * 100 : 0;
      if (gain >= 15 && length >= 200 && avgGrade >= 2.5) {
        let maxGrade = 0;
        for (let k = startIdx; k <= topIdx; k++) if ((gradeAt[k] ?? 0) > maxGrade) maxGrade = gradeAt[k] as number;
        const duration = moving ? movingAt(grid[topIdx]) - movingAt(grid[startIdx]) : null;
        climbs.push({
          startKm: Math.round(grid[startIdx]) / 1000,
          endKm: Math.round(grid[topIdx]) / 1000,
          length: Math.round(length),
          gain: Math.round(gain),
          avgGrade: round1(avgGrade),
          maxGrade: round1(Math.max(maxGrade, avgGrade)),
          duration: duration !== null && duration > 0 ? Math.round(duration) : null,
          vam: duration !== null && duration > 0 ? Math.round(gain / (duration / 3600)) : null,
        });
      }
    };
    for (let i = 1; i < grid.length; i++) {
      if (startIdx < 0) {
        if (E[i] < E[minIdx]) minIdx = i;
        if (E[i] - E[minIdx] >= 5) {
          startIdx = minIdx;
          topIdx = i;
        }
      } else if (E[i] > E[topIdx]) {
        topIdx = i;
      } else if (E[topIdx] - E[i] >= 10) {
        close();
        startIdx = -1;
        minIdx = i;
      }
    }
    if (startIdx >= 0) close();
  }

  const movingTime = moving ? Math.round(moving[n - 1]) : null;
  const halfPace = (from: number, to: number) => (moving && to > from ? Math.round(((movingAt(to) - movingAt(from)) / (to - from)) * 1000) : null);
  const gains = gainAt.reduce((a, b) => a + b, 0);
  const losses = lossAt.reduce((a, b) => a + b, 0);
  const grades = gradeAt.filter((g): g is number => g !== null);

  return {
    hasPace: !!moving,
    hasElevation: !!gridElevation,
    series,
    splits,
    climbs: climbs
      .sort((a, b) => b.gain - a.gain)
      .slice(0, 8)
      .sort((a, b) => a.startKm - b.startKm),
    stats: {
      distance: Math.round(total),
      movingTime,
      elapsedTime: elapsed !== null ? Math.round(elapsed) : null,
      avgPace: movingTime && total > 0 ? Math.round((movingTime / total) * 1000) : null,
      bestKmPace: bestKmPace !== null ? Math.round(bestKmPace) : null,
      bestKmStartKm: bestKmStart !== null ? Math.round(bestKmStart) / 1000 : null,
      fastestSplit: fastest?.index ?? null,
      slowestSplit: slowest?.index ?? null,
      firstHalfPace: total >= 1000 ? halfPace(0, total / 2) : null,
      secondHalfPace: total >= 1000 ? halfPace(total / 2, total) : null,
      elevationGain: gridElevation ? Math.round(gains) : null,
      elevationLoss: gridElevation ? Math.round(losses) : null,
      minElevation: gridElevation ? Math.round(Math.min(...gridElevation)) : null,
      maxElevation: gridElevation ? Math.round(Math.max(...gridElevation)) : null,
      maxGrade: grades.length > 0 ? round1(Math.max(...grades)) : null,
    },
  };
}
