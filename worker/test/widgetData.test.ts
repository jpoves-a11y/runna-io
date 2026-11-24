import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simplifyRing, simplifyForWidget, boundsOf, padBounds, intersects, podiumOf, polygonsOf } from '../src/widgetData';

/** A circle of `n` points (closed) around a centre, radius in degrees. */
function circle(cx: number, cy: number, r: number, n: number): number[][] {
  const ring: number[][] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  ring.push(ring[0]);
  return ring;
}

test('a ring stays closed and keeps its shape when simplified', () => {
  const ring = circle(-0.88, 41.65, 0.01, 2000);
  const simple = simplifyRing(ring, 0.0002);
  assert.ok(simple.length < 200, `${simple.length}`);
  assert.ok(simple.length >= 4);
  assert.deepEqual(simple[0], simple[simple.length - 1]);
});

test('polygons are simplified until they fit the budget', () => {
  const polygons = [[circle(-0.88, 41.65, 0.02, 3000)], [circle(-0.84, 41.66, 0.01, 3000)]];
  const result = simplifyForWidget(polygons, 300);
  const points = result.reduce((s, p) => s + p.reduce((t, r) => t + r.length, 0), 0);
  assert.ok(points <= 300, `${points}`);
  assert.equal(result.length, 2);
});

test('specks too small to see are dropped', () => {
  const polygons = [[circle(-0.88, 41.65, 0.05, 400)], [circle(-0.80, 41.70, 0.00005, 40)]];
  assert.equal(simplifyForWidget(polygons, 1000).length, 1);
});

test('bounds, padding and overlap', () => {
  const b = boundsOf([[circle(0, 0, 1, 64)]])!;
  assert.ok(Math.abs(b.maxLng - 1) < 1e-9 && Math.abs(b.minLat + 1) < 1e-9);
  const padded = padBounds(b, 0.5);
  assert.ok(Math.abs(padded.maxLng - 2) < 1e-9);
  assert.ok(intersects(padded, { minLng: 1.5, minLat: 0, maxLng: 3, maxLat: 1 }));
  assert.ok(!intersects(b, { minLng: 1.5, minLat: 0, maxLng: 3, maxLat: 1 }));
});

test('polygonsOf reads Polygon and MultiPolygon', () => {
  const ring = circle(0, 0, 1, 8);
  assert.equal(polygonsOf({ type: 'Polygon', coordinates: [ring] }).length, 1);
  assert.equal(polygonsOf({ type: 'MultiPolygon', coordinates: [[ring], [ring]] }).length, 2);
  assert.equal(polygonsOf(null).length, 0);
});

test('podium: top three, my place and the gap to whoever is ahead', () => {
  const standings = [
    { userId: 'a', name: 'Ana', score: 900, rank: 1 },
    { userId: 'b', name: 'Bea', score: 700, rank: 2 },
    { userId: 'c', name: 'Carlos', score: 650, rank: 3 },
    { userId: 'me', name: 'Yo', score: 500, rank: 4 },
  ];
  const colors = new Map<string, string | null>([['a', '#111111'], ['me', '#00FF1E']]);
  const podium = podiumOf(standings, 'me', colors);
  assert.equal(podium.top.length, 3);
  assert.equal(podium.top[0].color, '#111111');
  assert.equal(podium.me?.rank, 4);
  assert.deepEqual(podium.me?.ahead, { name: 'Carlos', gap: 150 });
  const leader = podiumOf(standings, 'a', colors);
  assert.equal(leader.me?.ahead, null);
  assert.equal(leader.top[0].me, true);
  assert.equal(podiumOf(standings, 'nobody', colors).me, null);
});
