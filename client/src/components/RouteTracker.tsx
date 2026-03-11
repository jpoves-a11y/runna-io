import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Play, Pause, Square, MapPin, Zap, Activity, X, Smartphone, Loader2, Navigation } from 'lucide-react';
import { watchPosition, clearWatch, getCurrentPosition, type Coordinates } from '@/lib/geolocation';
import { acquireWakeLock, releaseWakeLock, setupVisibilityReacquire } from '@/lib/wakeLock';
import { useToast } from '@/hooks/use-toast';
import { apiRequest } from '@/lib/queryClient';
import type { TerritoryWithUser } from '@shared/schema';
import type { Treasure } from '@/hooks/use-competition';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet-rotate';

const STORAGE_KEY = 'runna-route-tracking';
const MIN_ACCURACY_METERS = 30;
const MIN_MOVEMENT_METERS = 5; // Increased from 3 for phone GPS noise
const MAX_JUMP_METERS = 200; // Reject jumps > 200m (cell tower switches)
const MAX_JUMP_TIME_MS = 5000; // ... if time delta < 5s
const MIN_SPEED_MS = 0.3; // Skip when speed < 0.3 m/s (stationary drift)
const TREASURE_COLLECT_RADIUS = 100; // meters
const TREASURE_POLL_INTERVAL = 60000; // 60s poll for new treasures

interface TrackingState {
  coordinates: Array<[number, number]>;
  startTime: number;
  pausedDuration: number;
  lastPauseTime: number | null;
  isPaused: boolean;
  collectedTreasureIds?: string[];
}

interface CollectedTreasure {
  treasureId: string;
  treasureName: string;
  powerType: string;
  rarity: string;
}

interface RouteTrackerProps {
  onComplete: (data: {
    coordinates: Array<[number, number]>;
    distance: number;
    duration: number;
    treasuresCollected?: CollectedTreasure[];
  }) => void;
  onCancel: () => void;
  territories?: TerritoryWithUser[];
  treasures?: Treasure[];
  currentUser?: { id: string; color?: string } | null;
}

function saveTrackingState(state: TrackingState) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
}
function loadTrackingState(): TrackingState | null {
  try { const r = localStorage.getItem(STORAGE_KEY); return r ? JSON.parse(r) : null; } catch { return null; }
}
function clearTrackingState() { localStorage.removeItem(STORAGE_KEY); }

function haversineDistance(a: [number, number], b: [number, number]): number {
  const [lat1, lng1] = a;
  const [lat2, lng2] = b;
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

// Rarity-based colors for treasure markers
const RARITY_COLORS: Record<string, { bg: string; glow: string; pulse: string }> = {
  common: { bg: '#6b7280', glow: 'rgba(107,114,128,0.4)', pulse: 'rgba(107,114,128,0.2)' },
  rare: { bg: '#3b82f6', glow: 'rgba(59,130,246,0.5)', pulse: 'rgba(59,130,246,0.2)' },
  epic: { bg: '#a855f7', glow: 'rgba(168,85,247,0.5)', pulse: 'rgba(168,85,247,0.2)' },
  legendary: { bg: '#f59e0b', glow: 'rgba(245,158,11,0.6)', pulse: 'rgba(245,158,11,0.3)' },
};
const CHEST_IMAGES: Record<string, string> = {
  common: '/cofre_common.png', rare: '/cofre_rare.png', epic: '/cofre_epic.png', legendary: '/cofre_legendary.png',
};

export function RouteTracker({ onComplete, onCancel, territories = [], treasures = [], currentUser }: RouteTrackerProps) {
  const { toast } = useToast();
  const [isTracking, setIsTracking] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [displayDuration, setDisplayDuration] = useState(0);
  const [distance, setDistance] = useState(0);
  const [isGettingLocation, setIsGettingLocation] = useState(true);
  const [screenLockActive, setScreenLockActive] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [pauseTaps, setPauseTaps] = useState(0);
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const [autoFollow, setAutoFollow] = useState(true);
  const [liveTreasures, setLiveTreasures] = useState<Treasure[]>([]);
  const pauseTapsTimeoutRef = useRef<number | null>(null);
  const confirmStopTimeoutRef = useRef<number | null>(null);

  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const routeLineRef = useRef<L.Polyline | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const preTrackWatchRef = useRef<number | null>(null);
  const displayTimerRef = useRef<number | null>(null);
  const userMarkerObjRef = useRef<L.Marker | null>(null);
  const headingRef = useRef<number | null>(null);
  const orientationHandlerRef = useRef<((e: Event) => void) | null>(null);
  const territoryGroupRef = useRef<L.LayerGroup | null>(null);
  const treasureGroupRef = useRef<L.LayerGroup | null>(null);
  const treasureMarkersRef = useRef<Map<string, L.Marker>>(new Map());
  const collectedIdsRef = useRef<Set<string>>(new Set());
  const collectedTreasuresRef = useRef<CollectedTreasure[]>([]);
  const lastPointTimeRef = useRef<number>(0);
  const userInteractingRef = useRef(false);
  const autoFollowRef = useRef(true);
  const treasuresForCheckRef = useRef<Treasure[]>([]);

  const startTimeRef = useRef<number>(0);
  const pausedDurationRef = useRef<number>(0);
  const lastPauseTimeRef = useRef<number | null>(null);
  const coordsRef = useRef<Array<[number, number]>>([]);

  // Keep refs in sync with state for use inside GPS watch callback
  useEffect(() => { autoFollowRef.current = autoFollow; }, [autoFollow]);
  useEffect(() => { treasuresForCheckRef.current = liveTreasures.length > 0 ? liveTreasures : treasures; }, [treasures, liveTreasures]);

  // --- Distance calculation ---
  const calculateDistance = useCallback((coords: Array<[number, number]>): number => {
    if (coords.length < 2) return 0;
    let total = 0;
    for (let i = 1; i < coords.length; i++) {
      total += haversineDistance(coords[i - 1], coords[i]);
    }
    return total;
  }, []);

  // --- Real elapsed time ---
  const getRealDurationSec = useCallback((): number => {
    if (startTimeRef.current === 0) return 0;
    const now = lastPauseTimeRef.current || Date.now();
    return Math.max(0, Math.floor((now - startTimeRef.current - pausedDurationRef.current) / 1000));
  }, []);

  const updateDisplayDuration = useCallback(() => { setDisplayDuration(getRealDurationSec()); }, [getRealDurationSec]);

  const startDisplayTimer = useCallback(() => {
    if (displayTimerRef.current) window.clearInterval(displayTimerRef.current);
    displayTimerRef.current = window.setInterval(updateDisplayDuration, 1000);
  }, [updateDisplayDuration]);

  // --- GPS watch with enhanced filtering + auto-follow + treasure check ---
  const startGpsWatch = useCallback(() => {
    if (watchIdRef.current) clearWatch(watchIdRef.current);
    watchIdRef.current = watchPosition((coords: Coordinates) => {
      const pt: [number, number] = [coords.lat, coords.lng];
      const now = Date.now();

      // Always update GPS accuracy for the signal indicator
      if (coords.accuracy !== undefined) setGpsAccuracy(coords.accuracy);

      // Filter: reject readings with poor accuracy
      if (!coords.accuracy || coords.accuracy > MIN_ACCURACY_METERS) return;

      // Filter: speed-based stationary detection (if available from device)
      if (coords.speed !== undefined && coords.speed !== null && coords.speed >= 0 && coords.speed < MIN_SPEED_MS) {
        if (userMarkerObjRef.current) userMarkerObjRef.current.setLatLng([coords.lat, coords.lng]);
        if (autoFollowRef.current && mapRef.current && !userInteractingRef.current) {
          mapRef.current.setView(pt, mapRef.current.getZoom(), { animate: true });
        }
        return;
      }

      if (coordsRef.current.length > 0) {
        const lastPt = coordsRef.current[coordsRef.current.length - 1];
        const dist = haversineDistance(lastPt, pt);

        // Filter: ignore jitter (tiny movements)
        if (dist < MIN_MOVEMENT_METERS) {
          if (userMarkerObjRef.current) userMarkerObjRef.current.setLatLng([coords.lat, coords.lng]);
          return;
        }

        // Filter: reject impossible jumps (cell tower switch)
        const timeDelta = now - lastPointTimeRef.current;
        if (dist > MAX_JUMP_METERS && timeDelta < MAX_JUMP_TIME_MS) return;
      }

      lastPointTimeRef.current = now;
      if (userMarkerObjRef.current) userMarkerObjRef.current.setLatLng([coords.lat, coords.lng]);
      coordsRef.current = [...coordsRef.current, pt];
      setDistance(calculateDistance(coordsRef.current));

      // Update polyline on map
      if (mapRef.current) {
        if (autoFollowRef.current && !userInteractingRef.current) {
          mapRef.current.setView(pt, mapRef.current.getZoom(), { animate: true });
        }
        if (routeLineRef.current) {
          routeLineRef.current.setLatLngs(coordsRef.current.map(c => [c[0], c[1]]));
        } else {
          routeLineRef.current = L.polyline(coordsRef.current.map(c => [c[0], c[1]]), {
            color: '#22c55e', weight: 5, opacity: 0.9, lineCap: 'round', lineJoin: 'round',
          }).addTo(mapRef.current);
        }
      }

      // Check treasure proximity for auto-collection
      if (currentUser) {
        for (const treasure of treasuresForCheckRef.current) {
          if (collectedIdsRef.current.has(treasure.id)) continue;
          const tdist = haversineDistance(pt, [treasure.lat, treasure.lng]);
          if (tdist <= TREASURE_COLLECT_RADIUS) {
            collectedIdsRef.current.add(treasure.id);
            // Remove marker from map immediately
            const marker = treasureMarkersRef.current.get(treasure.id);
            if (marker && treasureGroupRef.current) {
              treasureGroupRef.current.removeLayer(marker);
              treasureMarkersRef.current.delete(treasure.id);
            }
            const emoji = treasure.power?.emoji || '📦';
            toast({ title: `${emoji} ¡Cofre recogido!`, description: `${treasure.name} (${treasure.rarity})` });
            collectedTreasuresRef.current.push({
              treasureId: treasure.id, treasureName: treasure.name,
              powerType: treasure.powerType, rarity: treasure.rarity,
            });
            // Call API (fire-and-forget; server also re-checks at route save)
            apiRequest('POST', '/api/treasures/collect', {
              userId: currentUser.id, treasureId: treasure.id, lat: pt[0], lng: pt[1],
            }).catch(() => {});
          }
        }
      }
    });
  }, [calculateDistance, currentUser, toast]);

  // --- Notification helpers ---
  const showTrackingNotification = async () => {
    try {
      if (!('Notification' in window)) return;
      if (Notification.permission !== 'granted') { const p = await Notification.requestPermission(); if (p !== 'granted') return; }
      const reg = await navigator.serviceWorker?.ready;
      if (!reg) return;
      await reg.showNotification('🏃 Grabando ruta', {
        body: 'Mantén Runna.io abierto para grabar tu ruta GPS', icon: '/icon-192.png', badge: '/icon-192.png',
        tag: 'runna-tracking', silent: true, requireInteraction: true, data: { url: '/?tracking=true', type: 'tracking' },
      });
    } catch (e) { console.error('Tracking notification error:', e); }
  };
  const closeTrackingNotification = async () => {
    try { const reg = await navigator.serviceWorker?.ready; if (!reg) return; const n = await reg.getNotifications({ tag: 'runna-tracking' }); n.forEach((x: Notification) => x.close()); } catch (_) {}
  };

  // --- Map init ---
  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;
    const isDark = document.documentElement.classList.contains('dark');
    const tileUrl = isDark
      ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
      : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';

    const map = L.map(mapContainer.current, {
      center: [40.4168, -3.7038], zoom: 16, zoomControl: false, attributionControl: false,
      zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false,
      rotate: true, touchRotate: true, shiftKeyRotate: true, rotateControl: false,
    } as any);
    L.tileLayer(tileUrl, { maxZoom: 19, subdomains: ['a', 'b', 'c', 'd'], keepBuffer: 12, updateWhenIdle: false, updateWhenZooming: true }).addTo(map);

    // Create layer groups for territories and treasures
    const territoryGroup = L.layerGroup().addTo(map);
    const treasureGroup = L.layerGroup().addTo(map);
    territoryGroupRef.current = territoryGroup;
    treasureGroupRef.current = treasureGroup;
    mapRef.current = map;

    // Detect user pan to disable auto-follow
    map.on('dragstart', () => { userInteractingRef.current = true; setAutoFollow(false); });
    map.on('dragend', () => { userInteractingRef.current = false; });

    // Heading-aware icon creator for RouteTracker
    const createTrackerIcon = (heading: number | null) => {
      const hasHeading = heading !== null;
      const rotation = hasHeading ? heading : 0;
      return L.divIcon({
        className: 'current-location-marker',
        html: `
          <div style="width:48px;height:48px;position:relative;display:flex;align-items:center;justify-content:center;">
            <div style="position:absolute;width:40px;height:40px;left:4px;top:4px;border-radius:50%;background:rgba(66,133,244,0.15);animation:location-pulse 2s ease-out infinite;"></div>
            ${hasHeading ? `
              <svg class="location-arrow" width="28" height="28" viewBox="0 0 32 32" style="transform:rotate(${rotation}deg);position:relative;z-index:2;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.4));">
                <path d="M16 2L6 28L16 20L26 28L16 2Z" fill="#4285F4" stroke="white" stroke-width="2" stroke-linejoin="round"/>
              </svg>
            ` : `
              <div style="width:16px;height:16px;border-radius:50%;background:#4285F4;border:3px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.4);position:relative;z-index:2;"></div>
            `}
          </div>
        `,
        iconSize: [48, 48], iconAnchor: [24, 24],
      });
    };

    // Setup heading watch for compass arrow
    const setupTrackerHeading = () => {
      if (orientationHandlerRef.current) {
        window.removeEventListener('deviceorientation', orientationHandlerRef.current, true);
        window.removeEventListener('deviceorientationabsolute', orientationHandlerRef.current, true);
      }
      const handler = (event: Event) => {
        const e = event as DeviceOrientationEvent;
        let heading: number | null = null;
        if ((e as any).webkitCompassHeading !== undefined) {
          heading = (e as any).webkitCompassHeading as number;
        } else if (e.alpha !== null && e.alpha !== undefined) {
          heading = (360 - e.alpha) % 360;
        }
        if (heading !== null && userMarkerObjRef.current) {
          headingRef.current = heading;
          const arrowEl = userMarkerObjRef.current.getElement()?.querySelector('.location-arrow') as HTMLElement;
          if (arrowEl) {
            arrowEl.style.transform = `rotate(${heading}deg)`;
          } else {
            userMarkerObjRef.current.setIcon(createTrackerIcon(heading));
          }
        }
      };
      orientationHandlerRef.current = handler;
      if ('ondeviceorientationabsolute' in window) {
        window.addEventListener('deviceorientationabsolute', handler, true);
      } else {
        window.addEventListener('deviceorientation', handler, true);
      }
    };

    // Request orientation permission (iOS needs user gesture, but we're in useEffect after a click to start tracking)
    const requestOrientation = async () => {
      try {
        if (typeof (DeviceOrientationEvent as any).requestPermission === 'function') {
          const perm = await (DeviceOrientationEvent as any).requestPermission();
          if (perm === 'granted') setupTrackerHeading();
        } else {
          setupTrackerHeading();
        }
      } catch { /* permission denied */ }
    };
    requestOrientation();

    getCurrentPosition()
      .then((pos) => {
        if (pos.accuracy !== undefined) setGpsAccuracy(pos.accuracy);
        map.setView([pos.lat, pos.lng], 17);
        const icon = createTrackerIcon(headingRef.current);
        userMarkerObjRef.current = L.marker([pos.lat, pos.lng], { icon, zIndexOffset: 1000, interactive: false }).addTo(map);
      })
      .catch(() => {})
      .finally(() => setIsGettingLocation(false));
    return () => {
      if (watchIdRef.current) clearWatch(watchIdRef.current);
      if (displayTimerRef.current) window.clearInterval(displayTimerRef.current);
      if (orientationHandlerRef.current) {
        window.removeEventListener('deviceorientation', orientationHandlerRef.current, true);
        window.removeEventListener('deviceorientationabsolute', orientationHandlerRef.current, true);
      }
      map.remove(); mapRef.current = null;
      territoryGroupRef.current = null; treasureGroupRef.current = null;
      treasureMarkersRef.current.clear();
    };
  }, []);

  // --- Render territories on map ---
  useEffect(() => {
    if (!mapRef.current || !territoryGroupRef.current) return;
    const group = territoryGroupRef.current;
    group.clearLayers();
    territories.forEach((territory) => {
      if (!territory.geometry) return;
      try {
        const geometry = typeof territory.geometry === 'string' ? JSON.parse(territory.geometry) : territory.geometry;
        const color = territory.user?.color || '#888';
        const addPolygon = (coords: number[][]) => {
          const latlngs = coords.map(([lng, lat]: number[]) => [lat, lng] as [number, number]);
          L.polygon(latlngs, {
            color, fillColor: color, fillOpacity: 0.2, weight: 1.5, opacity: 0.5, interactive: false,
          }).addTo(group);
        };
        if (geometry.type === 'Polygon') {
          addPolygon(geometry.coordinates[0]);
        } else if (geometry.type === 'MultiPolygon') {
          geometry.coordinates.forEach((poly: number[][][]) => addPolygon(poly[0]));
        }
      } catch (_) {}
    });
  }, [territories]);

  // --- Render treasure markers on map ---
  useEffect(() => {
    if (!mapRef.current || !treasureGroupRef.current) return;
    const group = treasureGroupRef.current;
    const existing = treasureMarkersRef.current;
    const treasuresToShow = liveTreasures.length > 0 ? liveTreasures : treasures;
    const newIds = new Set(treasuresToShow.map(t => t.id));

    // Remove stale markers
    for (const [id, marker] of existing) {
      if (!newIds.has(id) || collectedIdsRef.current.has(id)) {
        group.removeLayer(marker);
        existing.delete(id);
      }
    }
    // Add new markers
    treasuresToShow.forEach((treasure) => {
      if (existing.has(treasure.id) || collectedIdsRef.current.has(treasure.id)) return;
      const colors = RARITY_COLORS[treasure.rarity] || RARITY_COLORS.common;
      const chestSrc = CHEST_IMAGES[treasure.rarity] || CHEST_IMAGES.common;
      const icon = L.divIcon({
        className: 'treasure-marker',
        html: `<div style="position:relative;width:40px;height:40px;"><div style="position:absolute;inset:-4px;border-radius:50%;background:${colors.pulse};animation:treasure-pulse 2s ease-in-out infinite;"></div><div style="position:absolute;inset:-2px;border-radius:50%;box-shadow:0 0 12px ${colors.glow};"></div><img src="${chestSrc}" alt="" style="position:relative;width:40px;height:40px;object-fit:contain;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.4));"/></div>`,
        iconSize: [40, 40], iconAnchor: [20, 20],
      });
      const marker = L.marker([treasure.lat, treasure.lng], { icon, interactive: false });
      group.addLayer(marker);
      existing.set(treasure.id, marker);
    });
  }, [treasures, liveTreasures]);

  // --- Treasure polling during recording (catch new spawns) ---
  useEffect(() => {
    if (!isTracking || isPaused) return;
    const poll = async () => {
      try {
        const res = await fetch('/api/treasures/active');
        if (res.ok) {
          const data = await res.json();
          if (data?.treasures) setLiveTreasures(data.treasures);
        }
      } catch (_) {}
    };
    poll(); // Initial fetch
    const iv = window.setInterval(poll, TREASURE_POLL_INTERVAL);
    return () => window.clearInterval(iv);
  }, [isTracking, isPaused]);

  // --- Pre-tracking GPS watch for accuracy indicator + marker updates ---
  useEffect(() => {
    if (isTracking) {
      if (preTrackWatchRef.current !== null) { clearWatch(preTrackWatchRef.current); preTrackWatchRef.current = null; }
      return;
    }
    preTrackWatchRef.current = watchPosition((coords) => {
      if (coords.accuracy !== undefined) setGpsAccuracy(coords.accuracy);
      if (userMarkerObjRef.current) userMarkerObjRef.current.setLatLng([coords.lat, coords.lng]);
      if (mapRef.current) mapRef.current.setView([coords.lat, coords.lng], mapRef.current.getZoom(), { animate: true });
    });
    return () => {
      if (preTrackWatchRef.current !== null) { clearWatch(preTrackWatchRef.current); preTrackWatchRef.current = null; }
    };
  }, [isTracking]);

  // --- Restore state on mount ---
  useEffect(() => {
    const saved = loadTrackingState();
    if (saved && saved.startTime > 0) {
      startTimeRef.current = saved.startTime;
      pausedDurationRef.current = saved.pausedDuration;
      lastPauseTimeRef.current = saved.lastPauseTime;
      coordsRef.current = saved.coordinates;
      if (saved.collectedTreasureIds) collectedIdsRef.current = new Set(saved.collectedTreasureIds);
      setDistance(calculateDistance(saved.coordinates));
      setIsTracking(true);
      window.dispatchEvent(new Event('runna-tracking-changed'));
      if (saved.isPaused) {
        setIsPaused(true);
        updateDisplayDuration();
      } else {
        startGpsWatch(); startDisplayTimer();
        acquireWakeLock().then(ok => setScreenLockActive(ok));
      }
      setTimeout(() => {
        if (mapRef.current && saved.coordinates.length >= 2) {
          routeLineRef.current = L.polyline(saved.coordinates.map(c => [c[0], c[1]]), {
            color: '#22c55e', weight: 5, opacity: 0.9, lineCap: 'round', lineJoin: 'round',
          }).addTo(mapRef.current);
          const last = saved.coordinates[saved.coordinates.length - 1];
          mapRef.current.setView(last, 17);
        }
      }, 500);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Visibility change: re-acquire wake lock ---
  useEffect(() => {
    if (!isTracking || isPaused) return;
    const cleanup = setupVisibilityReacquire();
    const handler = () => {
      if (document.visibilityState === 'visible') {
        updateDisplayDuration();
        if (!watchIdRef.current) startGpsWatch();
      }
    };
    document.addEventListener('visibilitychange', handler);
    return () => { cleanup(); document.removeEventListener('visibilitychange', handler); };
  }, [isTracking, isPaused, updateDisplayDuration, startGpsWatch]);

  // --- Save state every 5s ---
  useEffect(() => {
    if (!isTracking) return;
    const iv = window.setInterval(() => {
      saveTrackingState({
        coordinates: coordsRef.current, startTime: startTimeRef.current,
        pausedDuration: pausedDurationRef.current, lastPauseTime: lastPauseTimeRef.current,
        isPaused, collectedTreasureIds: [...collectedIdsRef.current],
      });
    }, 5000);
    return () => window.clearInterval(iv);
  }, [isTracking, isPaused]);

  // --- Navigation lock: prevent browser back during tracking ---
  useEffect(() => {
    if (!isTracking) return;
    const handlePopState = () => { window.history.pushState({}, '', '/?tracking=true'); };
    window.history.pushState({}, '', '/?tracking=true');
    window.addEventListener('popstate', handlePopState);
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = 'Estás grabando una ruta. ¿Seguro que quieres salir?';
      return e.returnValue;
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('popstate', handlePopState);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [isTracking]);

  // --- Cleanup on unmount ---
  useEffect(() => { return () => {
    releaseWakeLock(); closeTrackingNotification();
    if (watchIdRef.current) { clearWatch(watchIdRef.current); watchIdRef.current = null; }
    if (displayTimerRef.current) { window.clearInterval(displayTimerRef.current); displayTimerRef.current = null; }
  }; }, []);

  // --- Controls ---
  const handleStart = async () => {
    clearTrackingState();
    collectedIdsRef.current.clear();
    collectedTreasuresRef.current = [];
    if (routeLineRef.current && mapRef.current) {
      mapRef.current.removeLayer(routeLineRef.current);
      routeLineRef.current = null;
    }
    const now = Date.now();
    startTimeRef.current = now; pausedDurationRef.current = 0; lastPauseTimeRef.current = null;
    coordsRef.current = []; lastPointTimeRef.current = now;
    setIsTracking(true); setIsPaused(false); setDistance(0); setDisplayDuration(0);
    setIsSaving(false); setConfirmStop(false); setPauseTaps(0); setAutoFollow(true);
    const ok = await acquireWakeLock(); setScreenLockActive(ok);
    showTrackingNotification(); startDisplayTimer(); startGpsWatch();
    saveTrackingState({ coordinates: [], startTime: now, pausedDuration: 0, lastPauseTime: null, isPaused: false, collectedTreasureIds: [] });
    window.dispatchEvent(new Event('runna-tracking-changed'));
  };

  const handlePauseTap = () => {
    if (pauseTapsTimeoutRef.current) window.clearTimeout(pauseTapsTimeoutRef.current);
    const newCount = pauseTaps + 1;
    setPauseTaps(newCount);
    if (newCount >= 2) {
      setIsPaused(true); lastPauseTimeRef.current = Date.now(); updateDisplayDuration();
      if (displayTimerRef.current) { window.clearInterval(displayTimerRef.current); displayTimerRef.current = null; }
      if (watchIdRef.current) { clearWatch(watchIdRef.current); watchIdRef.current = null; }
      saveTrackingState({ coordinates: coordsRef.current, startTime: startTimeRef.current, pausedDuration: pausedDurationRef.current, lastPauseTime: lastPauseTimeRef.current, isPaused: true, collectedTreasureIds: [...collectedIdsRef.current] });
      setPauseTaps(0);
    } else {
      pauseTapsTimeoutRef.current = window.setTimeout(() => setPauseTaps(0), 800);
    }
  };

  const handleResume = async () => {
    if (lastPauseTimeRef.current) pausedDurationRef.current += Date.now() - lastPauseTimeRef.current;
    lastPauseTimeRef.current = null; setIsPaused(false); setPauseTaps(0); setConfirmStop(false);
    setAutoFollow(true);
    const ok = await acquireWakeLock(); setScreenLockActive(ok);
    startDisplayTimer(); startGpsWatch();
    saveTrackingState({ coordinates: coordsRef.current, startTime: startTimeRef.current, pausedDuration: pausedDurationRef.current, lastPauseTime: null, isPaused: false, collectedTreasureIds: [...collectedIdsRef.current] });
  };

  const handleStop = () => {
    if (!confirmStop) {
      setConfirmStop(true);
      if (confirmStopTimeoutRef.current) window.clearTimeout(confirmStopTimeoutRef.current);
      confirmStopTimeoutRef.current = window.setTimeout(() => setConfirmStop(false), 3000);
      return;
    }
    if (isSaving) return;
    if (confirmStopTimeoutRef.current) window.clearTimeout(confirmStopTimeoutRef.current);
    setIsSaving(true);
    const finalDuration = getRealDurationSec();
    const finalCoords = [...coordsRef.current];
    const finalDistance = calculateDistance(finalCoords);
    const finalTreasures = [...collectedTreasuresRef.current];
    if (watchIdRef.current) { clearWatch(watchIdRef.current); watchIdRef.current = null; }
    if (displayTimerRef.current) { window.clearInterval(displayTimerRef.current); displayTimerRef.current = null; }
    releaseWakeLock(); closeTrackingNotification();
    clearTrackingState();
    setIsTracking(false);
    window.dispatchEvent(new Event('runna-tracking-changed'));
    coordsRef.current = [];
    startTimeRef.current = 0;
    pausedDurationRef.current = 0;
    lastPauseTimeRef.current = null;
    collectedIdsRef.current.clear();
    collectedTreasuresRef.current = [];
    setDistance(0);
    setDisplayDuration(0);
    setConfirmStop(false);
    setPauseTaps(0);
    if (routeLineRef.current && mapRef.current) {
      mapRef.current.removeLayer(routeLineRef.current);
      routeLineRef.current = null;
    }
    onComplete({ coordinates: finalCoords, distance: finalDistance, duration: finalDuration, treasuresCollected: finalTreasures });
  };

  const handleCancelTracking = () => {
    if (isTracking) return;
    if (watchIdRef.current) clearWatch(watchIdRef.current);
    if (displayTimerRef.current) window.clearInterval(displayTimerRef.current);
    releaseWakeLock(); closeTrackingNotification(); clearTrackingState();
    window.dispatchEvent(new Event('runna-tracking-changed'));
    onCancel();
  };

  const handleReCenter = () => {
    setAutoFollow(true);
    userInteractingRef.current = false;
    if (coordsRef.current.length > 0 && mapRef.current) {
      const last = coordsRef.current[coordsRef.current.length - 1];
      mapRef.current.setView(last, mapRef.current.getZoom(), { animate: true });
    }
  };

  const formatTime = (s: number) => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  };
  const formatDist = (m: number) => m < 1000 ? `${m.toFixed(0)} m` : `${(m / 1000).toFixed(2)} km`;
  const pace = displayDuration > 0 && distance > 0 ? (displayDuration / 60) / (distance / 1000) : 0;
  const formatPace = (p: number) => {
    if (p <= 0) return "0'00\"";
    const mins = Math.floor(p);
    const secs = Math.round((p - mins) * 60);
    return `${mins}'${secs.toString().padStart(2, '0')}"`;
  };

  return (
    <div className="absolute inset-0 flex flex-col">
      {/* SAVING OVERLAY */}
      {isSaving && (
        <div className="absolute inset-0 z-[2000] flex items-center justify-center bg-black/90">
          <div className="flex flex-col items-center gap-4 p-8 rounded-2xl bg-slate-900 shadow-2xl border border-slate-700">
            <Loader2 className="h-10 w-10 text-primary animate-spin" />
            <p className="text-lg font-semibold text-white">Guardando ruta...</p>
            <p className="text-sm text-slate-400 text-center">Procesando territorio y conquista</p>
          </div>
        </div>
      )}

      {/* MAP — always visible (both pre-tracking and tracking) */}
      <div className="flex-1 relative">
        <div ref={mapContainer} className="absolute inset-0" data-testid="tracker-map" />

        {/* Getting location overlay */}
        {isGettingLocation && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/50 backdrop-blur-sm z-[999]">
            <div className="flex flex-col items-center gap-2">
              <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <span className="text-sm text-muted-foreground">Obteniendo ubicación...</span>
            </div>
          </div>
        )}

        {/* Top-left: Close button (pre-tracking only) */}
        {!isTracking && (
          <button
            className="absolute left-3 z-[1000] w-10 h-10 flex items-center justify-center bg-card/95 backdrop-blur-md rounded-full shadow-lg border border-border"
            style={{ top: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)' }}
            onClick={handleCancelTracking}
            data-testid="button-cancel"
          >
            <X className="h-5 w-5" />
          </button>
        )}

        {/* Top-left: Status badges (tracking mode) */}
        {isTracking && (
          <div
            className="absolute left-3 z-[1000] flex items-center gap-2"
            style={{ top: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)' }}
          >
            {isPaused ? (
              <div className="flex items-center gap-1 px-2.5 py-1 bg-yellow-600 text-white rounded-full text-[11px] font-bold shadow-lg">
                <Pause className="w-3 h-3" />PAUSA
              </div>
            ) : (
              <div className="flex items-center gap-1 px-2.5 py-1 bg-red-600 text-white rounded-full text-[11px] font-bold shadow-lg">
                <div className="w-2 h-2 bg-white rounded-full animate-pulse" />REC
              </div>
            )}
            <div className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold shadow-lg ${screenLockActive ? 'bg-green-600/90 text-white' : 'bg-yellow-600/90 text-white'}`}>
              <Smartphone className="w-3 h-3" />{screenLockActive ? 'ON' : '⚠'}
            </div>
          </div>
        )}

        {/* Top-right: GPS Signal indicator (tracking mode) */}
        {isTracking && (
          <div
            className="absolute right-3 z-[1000] bg-black/70 backdrop-blur-sm rounded-full px-2.5 py-1 shadow-lg"
            style={{ top: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)' }}
          >
            <GpsSignalIndicator accuracy={gpsAccuracy} />
          </div>
        )}

        {/* Re-center button (tracking mode, visible when auto-follow is off) */}
        {isTracking && !autoFollow && (
          <button
            className="absolute right-3 z-[1000] w-11 h-11 flex items-center justify-center bg-primary text-primary-foreground rounded-full shadow-xl border-2 border-white/20 active:scale-95 transition-transform"
            style={{ top: 'calc(env(safe-area-inset-top, 0px) + 3rem)' }}
            onClick={handleReCenter}
          >
            <Navigation className="h-5 w-5" />
          </button>
        )}
      </div>

      {/* BOTTOM PANEL */}
      {!isTracking ? (
        /* Pre-tracking panel */
        <div className="bg-card border-t border-border p-4 space-y-3 flex-shrink-0" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 1rem)' }}>
          <div className="flex items-center justify-center py-1">
            <GpsSignalIndicator accuracy={gpsAccuracy} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="text-center">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1 flex items-center justify-center gap-1"><Activity className="h-3 w-3" />Tiempo</p>
              <p className="text-xl font-bold tabular-nums" data-testid="text-duration">{formatTime(displayDuration)}</p>
            </div>
            <div className="text-center border-x border-border">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1 flex items-center justify-center gap-1"><MapPin className="h-3 w-3" />Distancia</p>
              <p className="text-xl font-bold tabular-nums" data-testid="text-distance">{formatDist(distance)}</p>
            </div>
            <div className="text-center">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1 flex items-center justify-center gap-1"><Zap className="h-3 w-3" />Ritmo</p>
              <p className="text-xl font-bold tabular-nums" data-testid="text-pace">{pace > 0 ? formatPace(pace) : "0'00\""}</p>
            </div>
          </div>
          <Button size="lg" className="w-full h-14 text-base font-semibold gradient-primary border-0 active:scale-[0.98] transition-transform" onClick={handleStart} disabled={isGettingLocation} data-testid="button-start-tracking">
            <Play className="h-6 w-6 mr-2" fill="currentColor" />Iniciar Ruta
          </Button>
        </div>
      ) : (
        /* Tracking panel — compact overlay at bottom, map stays visible above */
        <div
          className="flex-shrink-0 bg-black/85 backdrop-blur-md rounded-t-2xl border-t border-white/10 select-none"
          style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.75rem)' }}
        >
          {/* Stats row */}
          <div className="grid grid-cols-3 gap-2 px-4 pt-3 pb-2">
            <div className="text-center">
              <p className="text-[9px] text-slate-500 uppercase tracking-widest mb-0.5">Tiempo</p>
              <p className="text-2xl font-black tabular-nums text-white leading-none" data-testid="text-duration">
                {formatTime(displayDuration)}
              </p>
            </div>
            <div className="text-center border-x border-white/10">
              <p className="text-[9px] text-slate-500 uppercase tracking-widest mb-0.5">Distancia</p>
              <p className="text-2xl font-bold tabular-nums text-slate-200 leading-none" data-testid="text-distance">
                {formatDist(distance)}
              </p>
            </div>
            <div className="text-center">
              <p className="text-[9px] text-slate-500 uppercase tracking-widest mb-0.5">Ritmo</p>
              <p className="text-2xl font-semibold tabular-nums text-slate-400 leading-none" data-testid="text-pace">
                {pace > 0 ? `${formatPace(pace)}` : "--'--\""}
              </p>
            </div>
          </div>

          {/* Control buttons */}
          <div className="flex items-center justify-center gap-10 px-6 pt-1 pb-1">
            {/* Pause / Resume */}
            <div className="flex flex-col items-center gap-1">
              <button
                className={`w-16 h-16 rounded-full flex items-center justify-center transition-all duration-200 shadow-xl ${
                  !isPaused
                    ? pauseTaps > 0
                      ? 'bg-orange-600 ring-4 ring-orange-400/60 scale-110'
                      : 'bg-slate-700 active:bg-slate-600'
                    : 'bg-green-600 active:bg-green-500'
                }`}
                onClick={!isPaused ? handlePauseTap : () => { setPauseTaps(0); handleResume(); }}
                data-testid="button-pause"
              >
                {!isPaused
                  ? <Pause className="w-7 h-7 text-white" />
                  : <Play className="w-7 h-7 text-white ml-0.5" fill="white" />
                }
              </button>
              <span className={`text-[10px] font-bold transition-all ${
                !isPaused
                  ? pauseTaps > 0
                    ? 'text-orange-400 animate-pulse'
                    : 'text-slate-500'
                  : 'text-green-400'
              }`}>
                {!isPaused
                  ? pauseTaps > 0 ? '¡OTRA VEZ!' : 'PAUSA'
                  : 'REANUDAR'
                }
              </span>
            </div>

            {/* Stop */}
            <div className="flex flex-col items-center gap-1">
              <button
                className={`w-16 h-16 rounded-full flex items-center justify-center transition-all duration-200 shadow-xl ${
                  confirmStop
                    ? 'bg-red-600 ring-4 ring-red-400/60 scale-110'
                    : 'bg-slate-700 active:bg-slate-600'
                }`}
                onClick={handleStop}
                disabled={isSaving}
                data-testid="button-stop"
              >
                <Square className="w-7 h-7 text-white" fill="white" />
              </button>
              <span className={`text-[10px] font-bold transition-all ${
                confirmStop ? 'text-red-400 animate-pulse' : 'text-slate-500'
              }`}>
                {confirmStop ? '¡OTRA VEZ!' : 'PARAR'}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Treasure pulse + Location pulse animation CSS */}
      <style>{`
        @keyframes treasure-pulse {
          0%, 100% { transform: scale(1); opacity: 0.6; }
          50% { transform: scale(1.4); opacity: 0; }
        }
        @keyframes location-pulse {
          0% { transform: scale(1); opacity: 0.6; }
          100% { transform: scale(2.2); opacity: 0; }
        }
        .current-location-marker {
          background: none !important;
          border: none !important;
        }
        .leaflet-tile {
          transition: none !important;
        }
      `}</style>
    </div>
  );
}

/** GPS signal quality indicator — shows accuracy as colored bars */
function GpsSignalIndicator({ accuracy }: { accuracy: number | null }) {
  let level: number;
  let color: string;
  let label: string;

  if (accuracy === null) {
    level = 0; color = '#6b7280'; label = 'Sin GPS';
  } else if (accuracy <= 5) {
    level = 4; color = '#22c55e'; label = `${Math.round(accuracy)}m · Excelente`;
  } else if (accuracy <= 10) {
    level = 3; color = '#84cc16'; label = `${Math.round(accuracy)}m · Buena`;
  } else if (accuracy <= 20) {
    level = 2; color = '#eab308'; label = `${Math.round(accuracy)}m · Aceptable`;
  } else if (accuracy <= 30) {
    level = 1; color = '#f97316'; label = `${Math.round(accuracy)}m · Débil`;
  } else {
    level = 0; color = '#ef4444'; label = `${Math.round(accuracy)}m · Mala`;
  }

  return (
    <div className="flex items-center gap-1.5">
      <div className="flex items-end gap-[2px] h-3">
        {[1, 2, 3, 4].map(bar => (
          <div
            key={bar}
            className="rounded-sm transition-colors duration-500"
            style={{
              width: '3px',
              height: `${bar * 3}px`,
              backgroundColor: bar <= level ? color : '#374151',
            }}
          />
        ))}
      </div>
      <span className="text-[10px] font-semibold transition-colors duration-500" style={{ color }}>
        {label}
      </span>
    </div>
  );
}
