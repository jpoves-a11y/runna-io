// Unit tests for the FIT decoder used by the Suunto import (worker/src/fit.ts).
//
//   npx tsx scripts/e2e/fit-test.ts                 # synthetic FIT files built in memory
//   npx tsx scripts/e2e/fit-test.ts <examples-dir>  # also every *.fit in the folder, checked against
//                                                    # the FIT SDK *.csv dump next to it (Suunto's
//                                                    # FITexamples.zip from apizone.suunto.com)
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseFit, isFootSport, fitTrack, FitParseError, FIT_SPORT } from '../../worker/src/fit';

let failures = 0;
function check(name: string, condition: boolean, extra = ''): void {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${condition ? '' : ` ${extra}`}`);
  if (!condition) failures++;
}

// ---------- Synthetic file ----------

const FIT_EPOCH_S = 631065600;
const toSemicircles = (deg: number) => Math.round((deg * 2 ** 31) / 180);

class Writer {
  bytes: number[] = [];
  u8(v: number) { this.bytes.push(v & 0xff); }
  u16(v: number, le = true) { const b = [v & 0xff, (v >> 8) & 0xff]; this.bytes.push(...(le ? b : b.reverse())); }
  u32(v: number, le = true) { const b = [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]; this.bytes.push(...(le ? b : b.reverse())); }
  i32(v: number, le = true) { this.u32(v >>> 0, le); }
}

/** A FIT file with a dev-field record definition, big-endian session, compressed timestamps. */
function buildSyntheticFit(): { data: Uint8Array; start: number } {
  const body = new Writer();
  const start = Math.floor(Date.UTC(2026, 3, 10, 7, 0, 0) / 1000) - FIT_EPOCH_S;

  // Definition local 0: record (20), little endian, fields timestamp/lat/long/distance + 1 dev field (2 bytes)
  body.u8(0x40 | 0x20 | 0); body.u8(0); body.u8(0); body.u16(20); body.u8(4);
  body.u8(253); body.u8(4); body.u8(0x86);
  body.u8(0); body.u8(4); body.u8(0x85);
  body.u8(1); body.u8(4); body.u8(0x85);
  body.u8(5); body.u8(4); body.u8(0x86);
  body.u8(1); body.u8(0); body.u8(2); body.u8(0); // 1 dev field: num 0, size 2, dev index 0

  // Definition local 1: record without timestamp (used with compressed timestamp headers)
  body.u8(0x40 | 1); body.u8(0); body.u8(0); body.u16(20); body.u8(2);
  body.u8(0); body.u8(4); body.u8(0x85);
  body.u8(1); body.u8(4); body.u8(0x85);

  const lat0 = 41.65;
  const lng0 = -0.88;
  for (let i = 0; i < 20; i++) {
    const lat = lat0 + i * 0.0001;
    const lng = lng0 + i * 0.0001;
    if (i % 2 === 0) {
      body.u8(0); // data, local 0
      body.u32(start + i * 5); body.i32(toSemicircles(lat)); body.i32(toSemicircles(lng)); body.u32(i * 1400);
      body.u16(0xabcd); // dev field bytes
    } else {
      // compressed timestamp header: local 1, offset = (start + i*5) & 0x1f
      body.u8(0x80 | (1 << 5) | ((start + i * 5) & 0x1f));
      body.i32(toSemicircles(lat)); body.i32(toSemicircles(lng));
    }
  }
  // A record with invalid position (0x7FFFFFFF) must be ignored
  body.u8(0); body.u32(start + 101); body.i32(0x7fffffff); body.i32(0x7fffffff); body.u32(0xffffffff); body.u16(0);

  // Definition local 2: session (18), BIG endian
  body.u8(0x40 | 2); body.u8(0); body.u8(1); body.u16(18, false); body.u8(7);
  body.u8(253); body.u8(4); body.u8(0x86);
  body.u8(2); body.u8(4); body.u8(0x86);
  body.u8(5); body.u8(1); body.u8(0x00);
  body.u8(6); body.u8(1); body.u8(0x00);
  body.u8(7); body.u8(4); body.u8(0x86);
  body.u8(8); body.u8(4); body.u8(0x86);
  body.u8(9); body.u8(4); body.u8(0x86);
  body.u8(2); body.u32(start + 100, false); body.u32(start, false); body.u8(1); body.u8(2);
  body.u32(100_500, false); body.u32(95_250, false); body.u32(266_000, false);

  const header = new Writer();
  header.u8(14); header.u8(0x20); header.u16(2132); header.u32(body.bytes.length);
  for (const ch of '.FIT') header.u8(ch.charCodeAt(0));
  header.u16(0);
  const all = [...header.bytes, ...body.bytes, 0, 0];
  return { data: new Uint8Array(all), start };
}

{
  const { data, start } = buildSyntheticFit();
  const fit = parseFit(data);
  check('synthetic: 21 records seen', fit.recordCount === 21, String(fit.recordCount));
  check('synthetic: 20 GPS points', fit.points.length === 20, String(fit.points.length));
  check('synthetic: first point lat/lng', Math.abs(fit.points[0].lat - 41.65) < 1e-6 && Math.abs(fit.points[0].lng + 0.88) < 1e-6, JSON.stringify(fit.points[0]));
  check('synthetic: compressed timestamp resolved', fit.points[1].time === (start + 5 + FIT_EPOCH_S) * 1000, String(fit.points[1].time));
  check('synthetic: distance scaled', fit.points[2].distance === 28, String(fit.points[2].distance));
  check('synthetic: one session', fit.sessions.length === 1, String(fit.sessions.length));
  check('synthetic: big-endian session sport', fit.sport === FIT_SPORT.running && fit.subSport === 2, `${fit.sport}/${fit.subSport}`);
  check('synthetic: session start', fit.startTime === (start + FIT_EPOCH_S) * 1000, String(fit.startTime));
  check('synthetic: timer time', fit.totalTimerTime === 95.25, String(fit.totalTimerTime));
  check('synthetic: distance', fit.totalDistance === 2660, String(fit.totalDistance));
  check('synthetic: foot sport', isFootSport(fit.sport, fit.subSport));
  check('synthetic: track keeps distinct points', fitTrack(fit.points).length === 20, String(fitTrack(fit.points).length));

  // Truncated file: still decodes what's there
  const truncated = parseFit(data.slice(0, 200));
  check('truncated: some points', truncated.points.length > 0 && truncated.points.length < 20, String(truncated.points.length));

  let threw = false;
  try { parseFit(new TextEncoder().encode('<html>not a fit file</html>')); } catch (e) { threw = e instanceof FitParseError; }
  check('non-FIT input throws FitParseError', threw);
}

check('treadmill is not a foot sport', !isFootSport(FIT_SPORT.running, 1));
check('trail running is a foot sport', isFootSport(FIT_SPORT.running, 3));
check('walking / hiking are foot sports', isFootSport(FIT_SPORT.walking, null) && isFootSport(FIT_SPORT.hiking, 0));
check('cycling / swimming are not', !isFootSport(FIT_SPORT.cycling, null) && !isFootSport(FIT_SPORT.swimming, null));

// ---------- Example files ----------

function csvSessions(csv: string): Array<{ sport: number; distance: number | null; timer: number | null; start: number }> {
  const sessions: Array<{ sport: number; distance: number | null; timer: number | null; start: number }> = [];
  for (const line of csv.split('\n')) {
    if (!/^Data,\d+,session,/.test(line)) continue;
    const cells = line.split(',').map((cell) => cell.replace(/^"|"$/g, ''));
    const value = (name: string): number | null => {
      const i = cells.indexOf(name);
      return i >= 0 && cells[i + 1] !== '' ? Number(cells[i + 1]) : null;
    };
    sessions.push({ sport: value('sport') ?? -1, distance: value('total_distance'), timer: value('total_timer_time'), start: value('start_time') ?? 0 });
  }
  return sessions;
}

function csvGpsRecords(csv: string): { count: number; first: [number, number] | null } {
  let count = 0;
  let first: [number, number] | null = null;
  for (const line of csv.split('\n')) {
    if (!/^Data,\d+,record,/.test(line) || !line.includes('position_lat')) continue;
    const cells = line.split(',').map((cell) => cell.replace(/^"|"$/g, ''));
    const lat = Number(cells[cells.indexOf('position_lat') + 1]);
    const lng = Number(cells[cells.indexOf('position_long') + 1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    count++;
    if (!first) first = [(lat * 180) / 2 ** 31, (lng * 180) / 2 ** 31];
  }
  return { count, first };
}

const dir = process.argv[2];
if (dir) {
  const files = readdirSync(dir).filter((name) => name.endsWith('.fit')).sort();
  check(`example dir has FIT files (${files.length})`, files.length > 0);
  for (const name of files) {
    const started = Date.now();
    const fit = parseFit(readFileSync(path.join(dir, name)));
    const elapsed = Date.now() - started;
    const csvPath = path.join(dir, name.replace(/\.fit$/, '.csv'));
    const label = `${name} (sport ${fit.sport}/${fit.subSport}, ${fit.points.length} pts, ${fit.totalDistance} m, ${elapsed} ms)`;
    if (!existsSync(csvPath)) {
      check(`${label}: parsed`, fit.recordCount > 0);
      continue;
    }
    const csv = readFileSync(csvPath, 'utf8');
    const expectedSessions = csvSessions(csv);
    const gps = csvGpsRecords(csv);
    check(`${label}: session count`, fit.sessions.length === expectedSessions.length, `${fit.sessions.length} vs ${expectedSessions.length}`);
    expectedSessions.forEach((expected, i) => {
      const got = fit.sessions[i];
      if (!got) return;
      const sportOk = got.sport === expected.sport;
      const distOk = expected.distance === null || Math.abs((got.totalDistance ?? 0) - expected.distance) < 0.5;
      const timerOk = expected.timer === null || Math.abs((got.totalTimerTime ?? 0) - expected.timer) < 0.01;
      const startOk = got.startTime === (expected.start + FIT_EPOCH_S) * 1000;
      check(`${name}: session ${i} sport/distance/timer/start`, sportOk && distOk && timerOk && startOk, JSON.stringify({ got, expected }));
    });
    check(`${name}: GPS points match CSV (${gps.count})`, fit.points.length === gps.count, `${fit.points.length} vs ${gps.count}`);
    if (gps.first && fit.points[0]) {
      check(`${name}: first point`, Math.abs(fit.points[0].lat - gps.first[0]) < 1e-7 && Math.abs(fit.points[0].lng - gps.first[1]) < 1e-7, JSON.stringify([fit.points[0], gps.first]));
    }
    if (fit.points.length > 0) {
      const track = fitTrack(fit.points);
      check(`${name}: track ${track.length} points (from ${fit.points.length})`, track.length >= 2 && track.length <= fit.points.length);
    }
  }
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
