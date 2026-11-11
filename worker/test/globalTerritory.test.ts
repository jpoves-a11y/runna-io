import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAreaGeometry, mergeIntoGlobal, geometryArea } from '../src/globalTerritory';
import { loop, line } from './helpers';

const A = loop(41.65, -0.88, 500, 200); // ~0.785 km²
const B = loop(41.65, -0.874, 500, 200); // same size, shifted ~500 m east (overlaps A)

test('the first run adds its whole area', () => {
  const run = runAreaGeometry([A]);
  assert.ok(run);
  const merge = mergeIntoGlobal(null, run as any);
  assert.ok(merge);
  const expected = Math.PI * 500 * 500;
  assert.ok(Math.abs(merge!.newArea - expected) / expected < 0.02, `${merge!.newArea}`);
  assert.equal(Math.round(merge!.totalArea), Math.round(merge!.newArea));
});

test('repeating the same loop adds nothing', () => {
  const first = mergeIntoGlobal(null, runAreaGeometry([A]) as any)!;
  const second = mergeIntoGlobal(first.merged, runAreaGeometry([A]) as any)!;
  assert.equal(second.newArea, 0);
  assert.equal(Math.round(second.totalArea), Math.round(first.totalArea));
});

test('an overlapping loop only adds the part that is new', () => {
  const first = mergeIntoGlobal(null, runAreaGeometry([A]) as any)!;
  const second = mergeIntoGlobal(first.merged, runAreaGeometry([B]) as any)!;
  const loopArea = geometryArea(runAreaGeometry([B]) as any);
  assert.ok(second.newArea > 0.1 * loopArea && second.newArea < 0.9 * loopArea, `${second.newArea}`);
  assert.ok(Math.abs(second.totalArea - (first.totalArea + second.newArea)) < 1);
});

test('a run without area changes nothing', () => {
  const first = mergeIntoGlobal(null, runAreaGeometry([A]) as any)!;
  const none = mergeIntoGlobal(first.merged, null)!;
  assert.equal(none.newArea, 0);
});

test('"Estela ancha" makes an out-and-back run count a strip along the track', () => {
  const out = line(41.66, -0.9, 2000, 10);
  const back = [...out].reverse();
  const track = [...out, ...back.slice(1)];
  const plain = runAreaGeometry([track]);
  const wide = runAreaGeometry([track], { wideTrail: true });
  assert.ok(geometryArea(plain as any) < 1000, 'an out-and-back run encloses ~nothing');
  const expected = 2000 * 50 + Math.PI * 25 * 25; // 25 m each side + round ends
  assert.ok(Math.abs(geometryArea(wide as any) - expected) / expected < 0.05, `${geometryArea(wide as any)}`);
});

test('each valid stretch of a split track makes its own area', () => {
  const geometry = runAreaGeometry([A, loop(41.70, -0.88, 300, 100)]);
  const area = geometryArea(geometry as any);
  const expected = Math.PI * (500 * 500 + 300 * 300);
  assert.ok(Math.abs(area - expected) / expected < 0.03, `${area}`);
});
