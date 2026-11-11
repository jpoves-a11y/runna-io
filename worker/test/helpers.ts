// Synthetic GPS tracks for the tests.

/** Metres per degree of latitude */
const M_PER_DEG = 111_320;

/** A closed loop of `points` points around a centre (radius in metres), as [lat, lng]. */
export function loop(lat: number, lng: number, radius: number, points = 120): Array<[number, number]> {
  const coords: Array<[number, number]> = [];
  for (let i = 0; i <= points; i++) {
    const angle = (2 * Math.PI * i) / points;
    coords.push([
      lat + (radius / M_PER_DEG) * Math.sin(angle),
      lng + (radius / (M_PER_DEG * Math.cos((lat * Math.PI) / 180))) * Math.cos(angle),
    ]);
  }
  return coords;
}

/** A straight line north from a point, `meters` long, with a point every `step` metres. */
export function line(lat: number, lng: number, meters: number, step = 10): Array<[number, number]> {
  const coords: Array<[number, number]> = [];
  for (let d = 0; d <= meters; d += step) coords.push([lat + d / M_PER_DEG, lng]);
  return coords;
}

function legMeters(a: [number, number], b: [number, number]): number {
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLng = ((b[1] - a[1]) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((a[0] * Math.PI) / 180) * Math.cos((b[0] * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
}

export function trackLength(coords: Array<[number, number]>): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += legMeters(coords[i - 1], coords[i]);
  return total;
}

/**
 * Seconds since the start for each point, moving at `speedKmh` (a function of the point index lets a
 * stretch go at another speed).
 */
export function timesAt(coords: Array<[number, number]>, speedKmh: number | ((index: number) => number)): number[] {
  const times = [0];
  for (let i = 1; i < coords.length; i++) {
    const speed = typeof speedKmh === 'function' ? speedKmh(i) : speedKmh;
    times.push(times[i - 1] + legMeters(coords[i - 1], coords[i]) / (speed / 3.6));
  }
  return times;
}

/** Repeats a closed loop `laps` times (one continuous track). */
export function laps(track: Array<[number, number]>, count: number): Array<[number, number]> {
  const result: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) result.push(...(i === 0 ? track : track.slice(1)));
  return result;
}
