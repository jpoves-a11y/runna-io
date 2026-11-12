import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cycleAt, cycleBounds, wallClock, modeForCycle, localDate, inLateJoinWindow, restWindow, monthPeriod, competitionCycleForRun, arrivedAfterClose, isClosing } from '../src/cycles';
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

test('the competition closes on Monday at 06:00 Madrid: late runs that started before the end still count', () => {
  const bounds = cycleBounds(0);
  // Ends on Monday 00:00 Madrid (23:00 UTC on Sunday), closes 6 hours later
  assert.equal(new Date(bounds.competitionEnd).toISOString(), '2026-11-22T23:00:00.000Z');
  assert.equal(new Date(bounds.closeAt).toISOString(), '2026-11-23T05:00:00.000Z');
  assert.equal(cycleAt(at('2026-11-12T23:00:00Z')).competitionClosesAt, '2026-11-23T05:00:00.000Z');
  const sundayNight = '2026-11-22T22:30:00Z'; // Sunday 23:30 Madrid
  // Synced at 03:00 Madrid: counts for cycle 0
  assert.equal(competitionCycleForRun(sundayNight, at('2026-11-23T02:00:00Z'))?.number, 0);
  assert.equal(arrivedAfterClose(sundayNight, at('2026-11-23T02:00:00Z')), false);
  // Synced at 07:00 Madrid: too late, global only
  assert.equal(competitionCycleForRun(sundayNight, at('2026-11-23T06:00:00Z')), null);
  assert.equal(arrivedAfterClose(sundayNight, at('2026-11-23T06:00:00Z')), true);
  // A run on Monday at 01:00 Madrid started after the end: never counts for the competition
  assert.equal(competitionCycleForRun('2026-11-23T00:00:00Z', at('2026-11-23T00:30:00Z')), null);
  assert.equal(arrivedAfterClose('2026-11-23T00:00:00Z', at('2026-11-23T07:00:00Z')), false);
  // Preseason runs never count
  assert.equal(competitionCycleForRun('2026-11-10T10:00:00Z', at('2026-11-10T11:00:00Z')), null);
  // "Closing" only between the end and the close
  assert.equal(isClosing(cycleAt(at('2026-11-23T01:00:00Z')), at('2026-11-23T01:00:00Z')), true);
  assert.equal(isClosing(cycleAt(at('2026-11-23T05:00:00Z')), at('2026-11-23T05:00:00Z')), false);
  assert.equal(isClosing(cycleAt(at('2026-11-21T12:00:00Z')), at('2026-11-21T12:00:00Z')), false);
});

test('the close stays at 06:00 local on the Monday after a daylight saving change', () => {
  // Cycle 10 ends on Sunday 4 April 2027 local, after the change of 28 March (UTC+2)
  for (let n = 0; n < 60; n++) {
    const bounds = cycleBounds(n);
    const clock = wallClock(bounds.closeAt);
    assert.equal(clock.hour, 6, `cycle ${n}`);
    assert.equal(clock.minute, 0);
  }
});
