import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cycleAt, cycleBounds, wallClock, modeForCycle, localDate, inLateJoinWindow, restWindow, monthPeriod } from '../src/cycles';
import { SEASON_ANCHOR_DATE, MODE_ROTATION } from '../../shared/game';

const at = (iso: string) => Date.parse(iso);

test('the anchor is a Friday', () => {
  const day = new Date(`${SEASON_ANCHOR_DATE}T12:00:00Z`).getUTCDay();
  assert.equal(day, 5);
});

test('before the first competition it is preseason (rest-like) until cycle 0 starts', () => {
  const info = cycleAt(at('2026-11-12T12:00:00Z'));
  assert.equal(info.phase, 'preseason');
  assert.equal(info.number, -1);
  // Madrid is UTC+1 in November: local midnight of Friday 13 is 23:00 UTC on Thursday 12
  assert.equal(info.restEndsAt, '2026-11-12T23:00:00.000Z');
  assert.equal(restWindow(info).end, at('2026-11-12T23:00:00Z'));
});

test('competition: Friday 00:00 to the next Sunday 23:59 (10 days), rest Monday to Thursday', () => {
  assert.deepEqual([cycleAt(at('2026-11-12T22:59:59Z')).phase], ['preseason']);
  const start = cycleAt(at('2026-11-12T23:00:00Z'));
  assert.equal(start.number, 0);
  assert.equal(start.phase, 'competition');
  assert.equal(cycleAt(at('2026-11-22T22:59:00Z')).phase, 'competition'); // Sunday 23:59 Madrid
  const rest = cycleAt(at('2026-11-22T23:00:00Z')); // Monday 00:00 Madrid
  assert.equal(rest.number, 0);
  assert.equal(rest.phase, 'rest');
  assert.equal(cycleAt(at('2026-11-26T22:59:00Z')).phase, 'rest'); // Thursday 23:59
  const next = cycleAt(at('2026-11-26T23:00:00Z')); // Friday 00:00
  assert.equal(next.number, 1);
  assert.equal(next.phase, 'competition');
  assert.equal(start.competitionEndsAt, '2026-11-22T23:00:00.000Z');
  assert.equal(start.restEndsAt, '2026-11-26T23:00:00.000Z');
});

test('boundaries stay at local midnight across daylight saving changes', () => {
  for (let n = 0; n < 60; n++) {
    const b = cycleBounds(n);
    const start = wallClock(b.competitionStart);
    const end = wallClock(b.competitionEnd);
    const restEnd = wallClock(b.restEnd);
    for (const w of [start, end, restEnd]) {
      assert.equal(w.hour, 0, `cycle ${n} boundary not at midnight`);
      assert.equal(w.minute, 0);
    }
    assert.equal(new Date(Date.UTC(start.year, start.month - 1, start.day)).getUTCDay(), 5, `cycle ${n} doesn't start on Friday`);
    assert.equal(new Date(Date.UTC(end.year, end.month - 1, end.day)).getUTCDay(), 1, `cycle ${n} competition doesn't end on Monday 00:00`);
    assert.equal(cycleBounds(n + 1).competitionStart, b.restEnd, 'cycles must be contiguous');
  }
});

test('a cycle across the March DST change is 1 hour shorter but still aligned', () => {
  // Cycle containing Sunday 2027-03-28 (Madrid goes from UTC+1 to UTC+2)
  const info = cycleAt(at('2027-03-28T12:00:00Z'));
  const b = cycleBounds(info.number);
  assert.equal(localDate(b.competitionStart).length, 10);
  assert.equal(wallClock(b.restEnd).hour, 0);
});

test('modes rotate every cycle', () => {
  for (let n = 0; n < 8; n++) assert.equal(modeForCycle(n), MODE_ROTATION[n % MODE_ROTATION.length]);
  assert.equal(modeForCycle(-1), MODE_ROTATION[MODE_ROTATION.length - 1]);
});

test('late joins are allowed during the first 48 hours of a competition only', () => {
  const info = cycleAt(at('2026-11-13T10:00:00Z'));
  assert.equal(inLateJoinWindow(info, at('2026-11-13T10:00:00Z')), true);
  assert.equal(inLateJoinWindow(info, at('2026-11-14T22:59:00Z')), true);
  assert.equal(inLateJoinWindow(info, at('2026-11-15T23:01:00Z')), false);
});

test('month periods use Madrid time', () => {
  assert.equal(monthPeriod(at('2026-11-30T23:30:00Z')), '2026-12'); // already December 1st in Madrid
  assert.equal(monthPeriod(at('2026-11-30T22:30:00Z')), '2026-11');
});
