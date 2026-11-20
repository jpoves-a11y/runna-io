// Privacy zone: hides the first and last metres of a run (where it usually starts: home).
// The hidden ends are cut before the run is stored, so nothing derived from it (global and
// competition territory, fortifications, feed, spy and radar items) reaches them. The runner still
// sees the whole run: the cut ends are kept apart in route_private_ends.

import { haversineMeters } from './antiCheat';

export const PRIVACY_ZONE_METERS = 200;

export type LatLng = [number, number];

/** Indices of the points kept: points[start..end) (end exclusive). Empty when start >= end. */
export interface PrivacyCut {
  start: number;
  end: number;
}

/**
 * Where to cut a track so that `meters` of it are hidden at each end. The first kept point is the
 * first one at least `meters` (along the track) from the start, and likewise from the end. A track
 * of `2 * meters` or less is hidden whole (start === end).
 */
export function privacyCut(points: readonly LatLng[], meters: number): PrivacyCut {
  const n = points.length;
  if (!(meters > 0) || n === 0) return { start: 0, end: n };
  const cumulative: number[] = [0];
  for (let i = 1; i < n; i++) cumulative.push(cumulative[i - 1] + haversineMeters(points[i - 1] as [number, number], points[i] as [number, number]));
  const total = cumulative[n - 1];
  if (total <= 2 * meters) return { start: 0, end: 0 };
  let start = 0;
  while (start < n && cumulative[start] < meters) start++;
  let end = n;
  while (end > 0 && total - cumulative[end - 1] < meters) end--;
  if (start >= end) return { start: 0, end: 0 };
  return { start, end };
}

/** True when the cut keeps every point (nothing to hide). */
export function isNoCut(cut: PrivacyCut, length: number): boolean {
  return cut.start === 0 && cut.end === length;
}

/** The same cut applied to an array aligned with the points (times, altitudes); others pass through. */
export function sliceAligned<T>(values: T[] | null | undefined, cut: PrivacyCut, length: number): T[] | null | undefined {
  if (!Array.isArray(values) || values.length !== length) return values;
  return values.slice(cut.start, cut.end);
}

/** Puts the hidden ends back around the stored (cut) track: what the runner sees. */
export function joinPrivateEnds(points: LatLng[], head: LatLng[], tail: LatLng[]): LatLng[] {
  return [...head, ...points, ...tail];
}
