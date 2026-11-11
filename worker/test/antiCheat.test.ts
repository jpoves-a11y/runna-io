import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRun, timeOverlapShare, withReasons } from '../src/antiCheat';
import { loop, line, laps, timesAt, trackLength } from './helpers';

const START = '2026-11-20T08:00:00.000Z';
function run(coords: Array<[number, number]>, speedKmh: number | ((i: number) => number), extra: Record<string, unknown> = {}) {
  const t = timesAt(coords, speedKmh);
  const duration = t[t.length - 1];
  return analyzeRun({
    coordinates: coords,
    pointTimes: t,
    distance: trackLength(coords),
    duration,
    startedAt: START,
    completedAt: new Date(Date.parse(START) + duration * 1000).toISOString(),
    ...extra,
  });
}

const ZARAGOZA: [number, number] = [41.65, -0.88];
// A 5 km loop (radius ~800 m)
const LOOP = loop(ZARAGOZA[0], ZARAGOZA[1], 800, 400);

test('a normal run is accepted and keeps the whole track', () => {
  const result = run(LOOP, 10.5);
  assert.equal(result.status, 'accepted');
  assert.deepEqual(result.reasons, []);
  assert.equal(result.segments.length, 1);
  assert.ok(Math.abs(result.stats.avgSpeedKmh - 10.5) < 0.3);
});

test('faster than 2:50 min/km (car or bike) is rejected', () => {
  const result = run(laps(LOOP, 3), 45);
  assert.equal(result.status, 'rejected');
  assert.ok(result.reasons.includes('too_fast'));
  assert.equal(result.segments.length, 0);
  assert.match(result.message ?? '', /bici o en coche/);
});

test('slower than 12:00 min/km (walking) is rejected', () => {
  const result = run(LOOP, 4.2);
  assert.equal(result.status, 'rejected');
  assert.ok(result.reasons.includes('too_slow'));
});

test('stops do not slow the pace down (moving time)', () => {
  // A 3-minute stop in the middle of a 10.5 km/h run
  const t = timesAt(LOOP, 10.5);
  const half = Math.floor(LOOP.length / 2);
  const stopped = t.map((v, i) => (i >= half ? v + 180 : v));
  const result = analyzeRun({
    coordinates: LOOP, pointTimes: stopped, distance: trackLength(LOOP), duration: stopped[stopped.length - 1],
    startedAt: START, completedAt: new Date(Date.parse(START) + stopped[stopped.length - 1] * 1000).toISOString(),
  });
  assert.equal(result.status, 'accepted');
  assert.ok(result.stats.avgSpeedKmh > 10);
});

test('a short vehicle stretch is cut out of the territory, the rest counts', () => {
  // 3 laps at 11 km/h with ~800 m at 50 km/h in the middle (≈5% of the distance)
  const track = laps(LOOP, 3);
  const n = track.length;
  const fastFrom = Math.floor(n / 2);
  const fastTo = fastFrom + 64; // 64 legs of ~12.6 m ≈ 800 m
  const result = run(track, (i) => (i > fastFrom && i <= fastTo ? 50 : 11));
  assert.equal(result.status, 'accepted', result.reasons.join(','));
  assert.ok(result.reasons.includes('vehicle_stretch_removed'));
  assert.equal(result.segments.length, 2);
  assert.ok(result.stats.removedDistanceM > 500);
});

test('more than 15% of the distance at vehicle speed rejects the run', () => {
  const track = laps(LOOP, 3);
  const n = track.length;
  // a third of the run at 40 km/h, the rest at 9 km/h (average below the "too fast" limit)
  const result = run(track, (i) => (i < n / 3 ? 40 : 9));
  assert.equal(result.status, 'rejected');
  assert.ok(result.reasons.includes('vehicle'), result.reasons.join(','));
});

test('a pace too steady for a human (cruise control) goes to review', () => {
  const track = laps(LOOP, 4);
  const result = run(track, 16);
  assert.equal(result.status, 'flagged');
  assert.ok(result.reasons.includes('too_steady'));
});

test('a heart rate too low for the speed goes to review', () => {
  const result = run(laps(LOOP, 3), 17, { avgHeartRate: 85 });
  assert.ok(result.reasons.includes('heart_rate'));
  assert.equal(result.status, 'flagged');
});

test('untimed tracks: big jumps between points are teleports, cut and sent to review', () => {
  const track: Array<[number, number]> = [];
  for (let k = 0; k < 5; k++) track.push(...line(41.65 + k * 0.05, -0.88, 1000, 20)); // 5 pieces 5.5 km apart
  const result = analyzeRun({ coordinates: track, distance: 5000, duration: 1800, startedAt: START, completedAt: new Date(Date.parse(START) + 1800_000).toISOString() });
  assert.equal(result.stats.teleports, 4);
  assert.equal(result.segments.length, 5);
  assert.ok(result.reasons.includes('gps_jumps'));
  assert.equal(result.status, 'flagged');
});

test('a moving time longer than start-to-end is rejected', () => {
  const result = analyzeRun({
    coordinates: LOOP, distance: 5000, duration: 7200,
    startedAt: START, completedAt: new Date(Date.parse(START) + 1800_000).toISOString(),
  });
  assert.equal(result.status, 'rejected');
  assert.ok(result.reasons.includes('invalid_duration'));
});

test('short runs skip the pace checks', () => {
  const short = loop(41.65, -0.88, 60, 40); // ~380 m
  const result = analyzeRun({ coordinates: short, distance: 380, duration: 600, startedAt: START, completedAt: START });
  assert.equal(result.status, 'accepted');
});

test('withReasons recomputes the status', () => {
  const ok = run(LOOP, 10);
  assert.equal(withReasons(ok, ['large_area']).status, 'flagged');
  assert.equal(withReasons(ok, ['duplicate']).status, 'rejected');
  assert.equal(withReasons(ok, ['before_season']).status, 'rejected');
});

test('time overlap share', () => {
  assert.equal(timeOverlapShare(0, 100, 50, 150), 0.5);
  assert.equal(timeOverlapShare(0, 100, 100, 200), 0);
  assert.equal(timeOverlapShare(0, 100, -10, 200), 1);
});
