// Minimal, dependency-free decoder for Garmin FIT activity files (as exported by the Suunto Cloud API:
// GET /v2/workout/exportFit/{workoutKey}). It reads only what Runna.io needs:
//   - record messages: position_lat / position_long (semicircles), timestamp, distance
//   - session messages: sport, sub_sport, start_time, timestamp, total_timer_time, total_elapsed_time, total_distance
//   - sport messages: sport, sub_sport (fallback when there is no session)
// Handles normal and compressed-timestamp record headers, developer fields, both byte orders and
// chained FIT files. Unknown messages and fields are skipped by their declared size.

/** Seconds between the Unix epoch and the FIT epoch (1989-12-31T00:00:00Z). */
const FIT_EPOCH_OFFSET_S = 631065600;
const SEMICIRCLES_TO_DEGREES = 180 / 2 ** 31;

const MESG_SESSION = 18;
const MESG_RECORD = 20;
const MESG_SPORT = 12;

/** FIT `sport` enum values relevant to Runna.io. */
export const FIT_SPORT = {
  generic: 0,
  running: 1,
  cycling: 2,
  transition: 3,
  fitnessEquipment: 4,
  swimming: 5,
  walking: 11,
  hiking: 17,
} as const;

/** FIT running `sub_sport` values. */
export const FIT_SUB_SPORT = {
  treadmill: 1,
  street: 2,
  trail: 3,
  track: 4,
  indoorWalking: 27,
  virtualActivity: 58,
} as const;

export interface FitPoint {
  lat: number;
  lng: number;
  /** ms since the Unix epoch, when known */
  time: number | null;
  /** metres from the start, when known */
  distance: number | null;
}

export interface FitSession {
  sport: number | null;
  subSport: number | null;
  /** ms since the Unix epoch */
  startTime: number | null;
  /** ms since the Unix epoch (end of the session) */
  endTime: number | null;
  /** seconds */
  totalTimerTime: number | null;
  /** seconds */
  totalElapsedTime: number | null;
  /** metres */
  totalDistance: number | null;
}

export interface FitActivity {
  sessions: FitSession[];
  points: FitPoint[];
  /** Sport of the main session (the longest one), or of the first sport message. */
  sport: number | null;
  subSport: number | null;
  /** ms since the Unix epoch */
  startTime: number | null;
  /** seconds */
  totalTimerTime: number | null;
  /** metres */
  totalDistance: number | null;
  /** Number of record messages seen (with or without GPS). */
  recordCount: number;
}

interface FieldDef {
  num: number;
  size: number;
  baseType: number;
}

interface MessageDef {
  globalNum: number;
  littleEndian: boolean;
  fields: FieldDef[];
  devFieldsSize: number;
}

export class FitParseError extends Error {}

function fitTimeToMs(value: number | null): number | null {
  if (value === null) return null;
  return (value + FIT_EPOCH_OFFSET_S) * 1000;
}

/**
 * Reads one scalar field value; returns null for FIT "invalid" values, arrays and types
 * we don't need (strings, floats are read as numbers where useful).
 */
function readValue(view: DataView, offset: number, field: FieldDef, littleEndian: boolean): number | null {
  const base = field.baseType & 0x1f;
  switch (base) {
    case 0x00: // enum
    case 0x02: // uint8
    case 0x0a: // uint8z
    case 0x0d: { // byte
      if (field.size !== 1) return null;
      const v = view.getUint8(offset);
      if ((base === 0x0a && v === 0) || (base !== 0x0a && v === 0xff)) return null;
      return v;
    }
    case 0x01: { // sint8
      if (field.size !== 1) return null;
      const v = view.getInt8(offset);
      return v === 0x7f ? null : v;
    }
    case 0x03: { // sint16
      if (field.size !== 2) return null;
      const v = view.getInt16(offset, littleEndian);
      return v === 0x7fff ? null : v;
    }
    case 0x04: // uint16
    case 0x0b: { // uint16z
      if (field.size !== 2) return null;
      const v = view.getUint16(offset, littleEndian);
      if ((base === 0x0b && v === 0) || (base === 0x04 && v === 0xffff)) return null;
      return v;
    }
    case 0x05: { // sint32
      if (field.size !== 4) return null;
      const v = view.getInt32(offset, littleEndian);
      return v === 0x7fffffff ? null : v;
    }
    case 0x06: // uint32
    case 0x0c: { // uint32z
      if (field.size !== 4) return null;
      const v = view.getUint32(offset, littleEndian);
      if ((base === 0x0c && v === 0) || (base === 0x06 && v === 0xffffffff)) return null;
      return v;
    }
    case 0x08: { // float32
      if (field.size !== 4) return null;
      const v = view.getFloat32(offset, littleEndian);
      return Number.isFinite(v) ? v : null;
    }
    case 0x09: { // float64
      if (field.size !== 8) return null;
      const v = view.getFloat64(offset, littleEndian);
      return Number.isFinite(v) ? v : null;
    }
    default:
      return null;
  }
}

/** Decodes a FIT file. Throws FitParseError when the data is not a FIT file at all. */
export function parseFit(input: ArrayBuffer | Uint8Array): FitActivity {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const sessions: FitSession[] = [];
  const points: FitPoint[] = [];
  let firstSport: number | null = null;
  let firstSubSport: number | null = null;
  let recordCount = 0;

  let fileStart = 0;
  let filesRead = 0;
  // Chained FIT files: one header + data + CRC after another
  while (fileStart + 12 <= bytes.length) {
    const headerSize = bytes[fileStart];
    if (headerSize < 12 || fileStart + headerSize > bytes.length) {
      if (filesRead === 0) throw new FitParseError('Invalid FIT header size');
      break;
    }
    const signature = String.fromCharCode(bytes[fileStart + 8], bytes[fileStart + 9], bytes[fileStart + 10], bytes[fileStart + 11]);
    if (signature !== '.FIT') {
      if (filesRead === 0) throw new FitParseError('Missing .FIT signature');
      break;
    }
    const dataSize = view.getUint32(fileStart + 4, true);
    const dataStart = fileStart + headerSize;
    // Tolerate truncated files: decode what's there
    const dataEnd = Math.min(dataStart + dataSize, bytes.length);

    const definitions = new Map<number, MessageDef>();
    let lastTimestamp: number | null = null;
    let pos = dataStart;

    while (pos < dataEnd) {
      const header = bytes[pos];
      pos += 1;

      let localType: number;
      let compressedTimestamp: number | null = null;

      if (header & 0x80) {
        // Compressed timestamp header (always a data message)
        localType = (header >> 5) & 0x03;
        const offset = header & 0x1f;
        if (lastTimestamp !== null) {
          let ts: number = (lastTimestamp & ~0x1f) + offset;
          if (offset < (lastTimestamp & 0x1f)) ts += 0x20;
          compressedTimestamp = ts >>> 0;
          lastTimestamp = compressedTimestamp;
        }
      } else if (header & 0x40) {
        // Definition message
        localType = header & 0x0f;
        const hasDevFields = (header & 0x20) !== 0;
        if (pos + 5 > dataEnd) break;
        const littleEndian = bytes[pos + 1] === 0;
        const globalNum = view.getUint16(pos + 2, littleEndian);
        const numFields = bytes[pos + 4];
        pos += 5;
        const fields: FieldDef[] = [];
        for (let i = 0; i < numFields; i++) {
          if (pos + 3 > dataEnd) break;
          fields.push({ num: bytes[pos], size: bytes[pos + 1], baseType: bytes[pos + 2] });
          pos += 3;
        }
        let devFieldsSize = 0;
        if (hasDevFields && pos < dataEnd) {
          const numDev = bytes[pos];
          pos += 1;
          for (let i = 0; i < numDev; i++) {
            if (pos + 3 > dataEnd) break;
            devFieldsSize += bytes[pos + 1];
            pos += 3;
          }
        }
        definitions.set(localType, { globalNum, littleEndian, fields, devFieldsSize });
        continue;
      } else {
        localType = header & 0x0f;
      }

      // Data message
      const def = definitions.get(localType);
      if (!def) {
        // Can't know its size: the rest of this file is unreadable
        break;
      }
      const values = new Map<number, number | null>();
      for (const field of def.fields) {
        if (pos + field.size > dataEnd) {
          pos = dataEnd;
          break;
        }
        if (def.globalNum === MESG_RECORD || def.globalNum === MESG_SESSION || def.globalNum === MESG_SPORT || field.num === 253) {
          values.set(field.num, readValue(view, pos, field, def.littleEndian));
        }
        pos += field.size;
      }
      pos += def.devFieldsSize;

      const ts: number | null | undefined = values.get(253);
      if (ts !== undefined && ts !== null) {
        lastTimestamp = ts;
      }
      const timestamp = ts !== undefined && ts !== null ? ts : compressedTimestamp;

      if (def.globalNum === MESG_RECORD) {
        recordCount += 1;
        const latRaw = values.get(0);
        const lngRaw = values.get(1);
        if (latRaw !== undefined && latRaw !== null && lngRaw !== undefined && lngRaw !== null) {
          const lat = latRaw * SEMICIRCLES_TO_DEGREES;
          const lng = lngRaw * SEMICIRCLES_TO_DEGREES;
          const valid = Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
          if (valid) {
            const distRaw = values.get(5);
            points.push({
              lat,
              lng,
              time: fitTimeToMs(timestamp),
              distance: distRaw !== undefined && distRaw !== null ? distRaw / 100 : null,
            });
          }
        }
      } else if (def.globalNum === MESG_SESSION) {
        const start = values.get(2) ?? null;
        const timer = values.get(8) ?? null;
        const elapsed = values.get(7) ?? null;
        const dist = values.get(9) ?? null;
        sessions.push({
          sport: values.get(5) ?? null,
          subSport: values.get(6) ?? null,
          startTime: fitTimeToMs(start),
          endTime: fitTimeToMs(timestamp),
          totalTimerTime: timer !== null ? timer / 1000 : null,
          totalElapsedTime: elapsed !== null ? elapsed / 1000 : null,
          totalDistance: dist !== null ? dist / 100 : null,
        });
      } else if (def.globalNum === MESG_SPORT) {
        if (firstSport === null) {
          firstSport = values.get(0) ?? null;
          firstSubSport = values.get(1) ?? null;
        }
      }
    }

    filesRead += 1;
    // Next chained file starts after the 2-byte CRC
    fileStart = dataStart + dataSize + 2;
  }

  // Main session: the one covering the longest distance (then the longest time)
  let main: FitSession | null = null;
  for (const session of sessions) {
    if (!main) {
      main = session;
      continue;
    }
    const d = session.totalDistance ?? 0;
    const md = main.totalDistance ?? 0;
    if (d > md || (d === md && (session.totalTimerTime ?? 0) > (main.totalTimerTime ?? 0))) main = session;
  }

  const firstPointTime = points.length > 0 ? points[0].time : null;
  const totalTimerTime = sessions.length > 0
    ? sessions.reduce((sum, s) => sum + (s.totalTimerTime ?? 0), 0)
    : null;
  const totalDistance = sessions.length > 0
    ? sessions.reduce((sum, s) => sum + (s.totalDistance ?? 0), 0)
    : null;
  const startTimes = sessions.map((s) => s.startTime).filter((t): t is number => t !== null);

  return {
    sessions,
    points,
    sport: main?.sport ?? firstSport,
    subSport: main?.subSport ?? firstSubSport,
    startTime: startTimes.length > 0 ? Math.min(...startTimes) : firstPointTime,
    totalTimerTime,
    totalDistance,
    recordCount,
  };
}

/** True for FIT sports that count as running/walking on foot outdoors (Runna.io's import filter). */
export function isFootSport(sport: number | null, subSport: number | null): boolean {
  if (sport === FIT_SPORT.running) {
    return subSport !== FIT_SUB_SPORT.treadmill && subSport !== FIT_SUB_SPORT.virtualActivity;
  }
  if (sport === FIT_SPORT.walking) {
    return subSport !== FIT_SUB_SPORT.indoorWalking;
  }
  return sport === FIT_SPORT.hiking;
}

/** Spanish label for a FIT sport, used to name imported activities. */
export function fitSportLabel(sport: number | null, subSport: number | null): string {
  if (sport === FIT_SPORT.running) {
    if (subSport === FIT_SUB_SPORT.trail) return 'Trail';
    if (subSport === FIT_SUB_SPORT.track) return 'Carrera en pista';
    return 'Carrera';
  }
  if (sport === FIT_SPORT.walking) return 'Caminata';
  if (sport === FIT_SPORT.hiking) return 'Senderismo';
  if (sport === FIT_SPORT.cycling) return 'Ciclismo';
  if (sport === FIT_SPORT.swimming) return 'Natación';
  return 'Actividad';
}

/**
 * GPS track as [lat, lng] pairs, dropping points closer than `minSpacingM` metres to the
 * previously kept one (watches record every second; the map doesn't need that detail).
 */
export function fitTrack(points: FitPoint[], minSpacingM = 3): Array<[number, number]> {
  const track: Array<[number, number]> = [];
  let last: FitPoint | null = null;
  for (const point of points) {
    if (last) {
      const dLat = ((point.lat - last.lat) * Math.PI) / 180;
      const dLng = ((point.lng - last.lng) * Math.PI) / 180;
      const a = Math.sin(dLat / 2) ** 2 + Math.cos((last.lat * Math.PI) / 180) * Math.cos((point.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
      const meters = 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      if (meters < minSpacingM) continue;
    }
    track.push([point.lat, point.lng]);
    last = point;
  }
  // Always keep the final point so the route ends where the activity ended
  const final = points.length > 0 ? points[points.length - 1] : null;
  if (final && last && final !== last) track.push([final.lat, final.lng]);
  return track;
}
