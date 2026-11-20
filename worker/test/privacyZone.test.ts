import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privacyCut, isNoCut, sliceAligned, joinPrivateEnds, PRIVACY_ZONE_METERS } from '../src/privacyZone';
import { line, loop, trackLength } from './helpers';

test('cuts 200 m at each end of a straight run', () => {
  const track = line(41.65, -0.88, 2000, 10); // 201 points, one every 10 m
  const cut = privacyCut(track, PRIVACY_ZONE_METERS);
  const kept = track.slice(cut.start, cut.end);
  const head = track.slice(0, cut.start);
  const tail = track.slice(cut.end);
  // The first kept point is at least 200 m from the start, the last one at least 200 m from the end
  assert.ok(trackLength([...head, kept[0]]) >= 199.9);
  assert.ok(trackLength([kept[kept.length - 1], ...tail]) >= 199.9);
  // ...and not much more (one GPS step)
  assert.ok(trackLength([...head, kept[0]]) < 211);
  assert.ok(Math.abs(trackLength(kept) - (trackLength(track) - 400)) < 25);
  assert.deepEqual(joinPrivateEnds(kept, head, tail), track);
});

test('a loop that starts and ends at home hides both ends', () => {
  const track = loop(41.65, -0.88, 500, 200); // ~3.1 km, starts and ends at the same point
  const cut = privacyCut(track, PRIVACY_ZONE_METERS);
  assert.ok(cut.start > 0 && cut.end < track.length);
  const home = track[0];
  const kept = track.slice(cut.start, cut.end);
  // No kept point is within ~190 m (straight line) of where the run started
  const near = kept.filter(([lat, lng]) => trackLength([home, [lat, lng]]) < 190);
  assert.equal(near.length, 0);
});

test('a run of 400 m or less is hidden whole', () => {
  const track = line(41.65, -0.88, 390, 10);
  const cut = privacyCut(track, PRIVACY_ZONE_METERS);
  assert.equal(cut.start, cut.end);
  assert.equal(track.slice(cut.start, cut.end).length, 0);
});

test('zone off or empty track keeps everything', () => {
  const track = line(41.65, -0.88, 1000, 10);
  assert.ok(isNoCut(privacyCut(track, 0), track.length));
  assert.ok(isNoCut(privacyCut([], 200), 0));
});

test('aligned arrays are cut the same way; misaligned ones pass through', () => {
  const track = line(41.65, -0.88, 1000, 10);
  const times = track.map((_, i) => i * 3);
  const cut = privacyCut(track, PRIVACY_ZONE_METERS);
  const cutTimes = sliceAligned(times, cut, track.length)!;
  assert.equal(cutTimes.length, cut.end - cut.start);
  assert.equal(cutTimes[0], cut.start * 3);
  const other = [1, 2, 3];
  assert.equal(sliceAligned(other, cut, track.length), other);
});
