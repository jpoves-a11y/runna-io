// Castle zones of users, computed once and reused while their castles don't change (derived_cache).
// Grouping castles into zones intersects and unites their geometries: done on every map or widget
// request for you and all your friends, it went over the Worker's CPU limit (503) and the map showed
// no castles.
import * as turf from '@turf/turf';
import type { WorkerStorage } from './storage';
import { FORTIFICATION_TTL_DAYS, MAX_FORTIFICATION_LAYERS } from './storage';
import { castleMarkerPoint, groupCastleZones, type CastleRecord } from './castles';

export interface StoredCastleZone {
  /** Id of the zone's oldest castle. */
  id: string;
  layers: number;
  lat: number | null;
  lng: number | null;
  geometry: any;
  area: number;
  /** The oldest castle falls first; the zone is unfortified when the newest expires. */
  nextExpiryAt: string;
  expiresAt: string;
}

const KIND = 'castle-zones-v1';

function expiry(createdAt: string): string {
  const created = Date.parse(createdAt.includes('T') ? createdAt : `${createdAt.replace(' ', 'T')}Z`);
  return new Date((Number.isFinite(created) ? created : Date.now()) + FORTIFICATION_TTL_DAYS * 24 * 3600 * 1000).toISOString();
}

/** The castle zones of each user (users without castles are absent). */
export async function castleZonesOfUsers(storage: WorkerStorage, userIds: string[]): Promise<Map<string, StoredCastleZone[]>> {
  const signatures = await storage.getFortificationSignatures(userIds);
  const zones = await storage.getDerived(KIND, signatures);
  const missing = [...signatures.keys()].filter((userId) => !zones.has(userId));
  if (missing.length === 0) return zones;

  const records = await storage.getFortificationsOfUsers(missing);
  const byUser = new Map<string, CastleRecord[]>();
  for (const record of records) {
    try {
      const parsed = { id: record.id, geometry: JSON.parse(record.geometry), createdAt: record.createdAt };
      if (!byUser.has(record.userId)) byUser.set(record.userId, []);
      byUser.get(record.userId)!.push(parsed);
    } catch (_) { /* unreadable record */ }
  }
  const fresh: Array<{ key: string; signature: string; payload: StoredCastleZone[] }> = [];
  for (const userId of missing) {
    const computed: StoredCastleZone[] = [];
    for (const zone of groupCastleZones(byUser.get(userId) ?? [])) {
      if (!zone.geometry) continue;
      const center = castleMarkerPoint(zone.geometry);
      let area = 0;
      try { area = turf.area(zone.geometry); } catch (_) { /* keep 0 */ }
      computed.push({
        id: zone.records[0].id,
        layers: Math.min(zone.records.length, MAX_FORTIFICATION_LAYERS),
        lat: center?.[0] ?? null,
        lng: center?.[1] ?? null,
        geometry: zone.geometry,
        area,
        nextExpiryAt: expiry(zone.records[0].createdAt),
        expiresAt: expiry(zone.records[zone.records.length - 1].createdAt),
      });
    }
    zones.set(userId, computed);
    fresh.push({ key: userId, signature: signatures.get(userId)!, payload: computed });
  }
  try {
    await storage.saveDerived(KIND, fresh);
  } catch (error) {
    console.error('[CASTLES] Could not cache castle zones:', error);
  }
  return zones;
}
