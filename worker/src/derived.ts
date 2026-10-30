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

/**
 * The castle zones of each user (users without castles are absent) and the users whose zones are out
 * of date. Requests pass `compute: false`: they get the cached zones (possibly old) and enqueue the
 * rest (`requestDerivedRefresh`); the queue passes `compute: true` and works them out.
 */
export async function castleZonesOfUsers(
  storage: WorkerStorage,
  userIds: string[],
  compute = false,
): Promise<{ zones: Map<string, StoredCastleZone[]>; stale: string[] }> {
  const signatures = await storage.getFortificationSignatures(userIds);
  const cached = await storage.getDerived(KIND, signatures);
  const zones = new Map<string, StoredCastleZone[]>();
  const stale: string[] = [];
  for (const userId of signatures.keys()) {
    const entry = cached.get(userId);
    if (entry) zones.set(userId, entry.payload);
    if (!entry?.fresh) stale.push(userId);
  }
  if (!compute || stale.length === 0) return { zones, stale };

  const records = await storage.getFortificationsOfUsers(stale);
  const byUser = new Map<string, CastleRecord[]>();
  for (const record of records) {
    try {
      const parsed = { id: record.id, geometry: JSON.parse(record.geometry), createdAt: record.createdAt };
      if (!byUser.has(record.userId)) byUser.set(record.userId, []);
      byUser.get(record.userId)!.push(parsed);
    } catch (_) { /* unreadable record */ }
  }
  const fresh: Array<{ key: string; signature: string; payload: StoredCastleZone[] }> = [];
  for (const userId of stale) {
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
  await storage.saveDerived(KIND, fresh);
  return { zones, stale: [] };
}

/** Message asking the queue to work out castle zones and widget maps that are out of date. */
export interface RefreshDerivedMessage {
  type: 'refresh_derived';
  /** Users whose castle zones to work out. */
  castleUserIds: string[];
  /** Users whose widget map to work out (it includes their castle zones). */
  widgetUserIds: string[];
}

/** Most users whose widget map one message works out (each one is several queries). */
const MAX_WIDGET_MAPS = 4;

/** Enqueues the refresh (best effort: the next request asks again if it's lost). */
export async function requestDerivedRefresh(env: any, castleUserIds: string[], widgetUserIds: string[] = []): Promise<void> {
  if (castleUserIds.length === 0 && widgetUserIds.length === 0) return;
  try {
    const message: RefreshDerivedMessage = {
      type: 'refresh_derived',
      castleUserIds: [...new Set(castleUserIds)],
      widgetUserIds: [...new Set(widgetUserIds)].slice(0, MAX_WIDGET_MAPS),
    };
    await env?.TERRITORY_QUEUE?.send(message);
  } catch (error) {
    console.error('[DERIVED] Could not enqueue the refresh:', error);
  }
}

/** Queue: works out what's out of date (what's already current is only read). */
export async function refreshDerived(storage: WorkerStorage, message: RefreshDerivedMessage): Promise<void> {
  if (message.castleUserIds.length > 0) await castleZonesOfUsers(storage, message.castleUserIds, true);
  if (message.widgetUserIds.length > 0) {
    const { refreshWidgetMap } = await import('./widget');
    for (const userId of message.widgetUserIds.slice(0, MAX_WIDGET_MAPS)) await refreshWidgetMap(storage, userId);
  }
}
