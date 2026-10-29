// Nightly decay pass of one user (run from the territory queue, one message per user, so it never
// overlaps a run being processed).
import * as turf from '@turf/turf';
import type { WorkerStorage, DecayState } from './storage';
import {
  ALL, DAY_MS, DECAY_GRACE_DAYS, DECAY_WARNING_DAYS, REST_DAYS_PER_YEAR,
  decayTerritory, defendedFootprint, insidePoint, unionAll, type Defended,
} from './decay';
import { isCompetitionActive } from './territory';

const time = (value: string) => {
  const parsed = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Is the user resting at `now`, and for how long the rest has stopped the clock in the last weeks. */
export function restWindow(rest: { startedAt: string; until: string } | null, now: number): { resting: boolean; pausedMs: number } {
  if (!rest) return { resting: false, pausedMs: 0 };
  const start = time(rest.startedAt);
  const end = Math.min(time(rest.until), now);
  const resting = now >= start && now < time(rest.until);
  // The time spent resting doesn't count towards the grace period (only a recent rest matters)
  const pausedMs = end > start && end > now - (DECAY_GRACE_DAYS + REST_DAYS_PER_YEAR) * DAY_MS ? end - start : 0;
  return { resting, pausedMs };
}

export interface DecayOutcome {
  skipped?: string;
  lost: number;
  weakArea: number;
  atRiskArea: number;
}

export async function runTerritoryDecay(storage: WorkerStorage, env: any, userId: string, now = Date.now()): Promise<DecayOutcome> {
  const day = new Date(now).toISOString().slice(0, 10);
  const previous = await storage.getDecayState(userId);
  if (previous?.lastDay === day) return { skipped: 'already done today', lost: 0, weakArea: 0, atRiskArea: 0 };
  const state: DecayState = previous ?? {
    userId, trackingSince: new Date(now).toISOString(), lastDay: null, weak: null, atRisk: null, lostToday: 0, lostTotal: 0,
  };
  state.lastDay = day;
  state.lostToday = 0;

  const territories = await storage.getTerritoriesByUserId(userId);
  const rest = restWindow(await storage.getRestMode(userId), now);
  if (territories.length === 0 || rest.resting) {
    state.weak = null;
    state.atRisk = null;
    await storage.saveDecayState(state);
    return { skipped: rest.resting ? 'resting' : 'no territory', lost: 0, weakArea: 0, atRiskArea: 0 };
  }

  const graceStart = now - DECAY_GRACE_DAYS * DAY_MS - rest.pausedMs;
  const warningStart = now - DECAY_WARNING_DAYS * DAY_MS - rest.pausedMs;
  const trackingSince = time(state.trackingSince);
  // Before the clock has run for the whole period, everything counts as defended
  let defended: Defended = ALL;
  let defendedRecently: Defended = ALL;
  if (trackingSince <= warningStart) {
    const tracks = await storage.getRecentTracks(userId, new Date(graceStart).toISOString());
    defendedRecently = defendedFootprint(tracks.filter((t) => time(t.startedAt) >= warningStart).map((t) => t.coordinates));
    if (trackingSince <= graceStart) defended = defendedFootprint(tracks.map((t) => t.coordinates));
  }

  let lost = 0;
  const weak: any[] = [];
  const atRisk: any[] = [];
  for (const territory of territories) {
    let geometry: any;
    try { geometry = typeof territory.geometry === 'string' ? JSON.parse(territory.geometry) : territory.geometry; } catch { continue; }
    if (!geometry) continue;
    const result = decayTerritory(geometry, defended, defendedRecently);
    if (result.lost > 0) {
      await storage.setTerritoryRowGeometry(territory.id, result.geometry);
      lost += result.lost;
    }
    if (result.weak) weak.push(result.weak);
    if (result.atRisk) atRisk.push(result.atRisk);
  }

  state.weak = unionAll(weak);
  state.atRisk = unionAll(atRisk);
  state.lostToday = lost;
  state.lostTotal += lost;
  await storage.saveDecayState(state);

  if (lost > 0) {
    const total = await storage.getUserTotalAreaFromTerritories(userId);
    await storage.updateUserTotalArea(userId, total);
    try {
      const competition = await storage.getActiveCompetition();
      if (competition && isCompetitionActive(competition)) await storage.syncCompetitionAreas(competition.id, [userId]);
    } catch (error) {
      console.error('[DECAY] Competition sync failed:', error);
    }
  }

  const outcome = { lost, weakArea: areaOf(state.weak), atRiskArea: areaOf(state.atRisk) };
  try {
    const { notifyDecayWarning, notifyDecayLoss } = await import('./notifications');
    if (outcome.atRiskArea > 0) await notifyDecayWarning(storage, env, userId, outcome.atRiskArea, insidePoint(state.atRisk));
    if (lost > 0) await notifyDecayLoss(storage, env, userId, lost, insidePoint(state.weak));
  } catch (error) {
    console.error('[DECAY] Notification failed (non-critical):', error);
  }
  return outcome;
}

function areaOf(geometry: any): number {
  try {
    return geometry ? turf.area(geometry) : 0;
  } catch {
    return 0;
  }
}
