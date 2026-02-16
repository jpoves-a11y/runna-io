import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Play, Pause, Square, MapPin, Zap, Activity, X, Smartphone } from 'lucide-react';
import { watchPosition, clearWatch, getCurrentPosition, type Coordinates } from '@/lib/geolocation';
import { acquireWakeLock, releaseWakeLock, setupVisibilityReacquire } from '@/lib/wakeLock';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const STORAGE_KEY = 'runna-route-tracking';

interface TrackingState {
  coordinates: Array<[number, number]>;
  startTime: number;
  pausedDuration: number;
  lastPauseTime: number | null;
  isPaused: boolean;
}

interface RouteTrackerProps {
  onComplete: (data: {
    coordinates: Array<[number, number]>;
    distance: number;
    duration: number;
  }) => void;
  onCancel: () => void;
}

function saveTrackingState(state: TrackingState) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
}
function loadTrackingState(): TrackingState | null {
  try { const r = localStorage.getItem(STORAGE_KEY); return r ? JSON.parse(r) : null; } catch { return null; }
}
function clearTrackingState() { localStorage.removeItem(STORAGE_KEY); }

export function RouteTracker({ onComplete, onCancel }: RouteTrackerProps) {
  const [isTracking, setIsTracking] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [displayDuration, setDisplayDuration] = useState(0);
  const [distance, setDistance] = useState(0);
  const [isGettingLocation, setIsGettingLocation] = useState(true);
  const [screenLockActive, setScreenLockActive] = useState(false);

  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const routeLineRef = useRef<L.Polyline | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const displayTimerRef = useRef<number | null>(null);
  const userMarkerObjRef = useRef<L.Marker | null>(null);

  const startTimeRef = useRef<number>(0);
  const pausedDurationRef = useRef<number>(0);
  const lastPauseTimeRef = useRef<number | null>(null);
  const coordsRef = useRef<Array<[number, number]>>([]);

  // --- Distance calculation ---
  const calculateDistance = useCallback((coords: Array<[number, number]>): number => {
    if (coords.length < 2) return 0;
    let total = 0;
    for (let i = 1; i < coords.length; i++) {
      const [lat1, lng1] = coords[i - 1];
      const [lat2, lng2] = coords[i];
      const R = 6371000;
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLng = (lng2 - lng1) * Math.PI / 180;
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
      total += R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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

  // --- GPS watch ---
  const startGpsWatch = useCallback(() => {
    if (watchIdRef.current) clearWatch(watchIdRef.current);
    watchIdRef.current = watchPosition((coords: Coordinates) => {
      const pt: [number, number] = [coords.lat, coords.lng];
      if (userMarkerObjRef.current) userMarkerObjRef.current.setLatLng([coords.lat, coords.lng]);
      coordsRef.current = [...coordsRef.current, pt];
      setDistance(calculateDistance(coordsRef.current));
      if (mapRef.current) {
        mapRef.current.setView(pt, 17, { animate: true });
        if (routeLineRef.current) {
          routeLineRef.current.setLatLngs(coordsRef.current.map(c => [c[0], c[1]]));
        } else {
          routeLineRef.current = L.polyline(coordsRef.current.map(c => [c[0], c[1]]), {
            color: '#22c55e', weight: 6, opacity: 0.9, lineCap: 'round', lineJoin: 'round',
          }).addTo(mapRef.current);
        }
      }
    });
  }, [calculateDistance]);

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
    const map = L.map(mapContainer.current, { center: [40.4168, -3.7038], zoom: 16, zoomControl: false, attributionControl: false });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(map);
    mapRef.current = map;
    getCurrentPosition()
      .then((pos) => {
        map.setView([pos.lat, pos.lng], 17);
        const icon = L.divIcon({ className: 'current-location-marker', html: '<div class="relative flex items-center justify-center"><div class="absolute w-8 h-8 bg-primary/30 rounded-full animate-ping"></div><div class="relative w-4 h-4 bg-primary rounded-full border-2 border-white shadow-lg"></div></div>', iconSize: [32, 32], iconAnchor: [16, 16] });
        userMarkerObjRef.current = L.marker([pos.lat, pos.lng], { icon }).addTo(map);
      })
      .catch(() => {})
      .finally(() => setIsGettingLocation(false));
    return () => {
      if (watchIdRef.current) clearWatch(watchIdRef.current);
      if (displayTimerRef.current) window.clearInterval(displayTimerRef.current);
      map.remove(); mapRef.current = null;
    };
  }, []);

  // --- Restore state on mount ---
  useEffect(() => {
    const saved = loadTrackingState();
    if (saved && saved.startTime > 0) {
      startTimeRef.current = saved.startTime;
      pausedDurationRef.current = saved.pausedDuration;
      lastPauseTimeRef.current = saved.lastPauseTime;
      coordsRef.current = saved.coordinates;
      setDistance(calculateDistance(saved.coordinates));
      setIsTracking(true);
      if (saved.isPaused) {
        setIsPaused(true);
        updateDisplayDuration();
      } else {
        startGpsWatch(); startDisplayTimer();
        acquireWakeLock().then(ok => setScreenLockActive(ok));
      }
      // Draw existing polyline on map after map init
      setTimeout(() => {
        if (mapRef.current && saved.coordinates.length >= 2) {
          routeLineRef.current = L.polyline(saved.coordinates.map(c => [c[0], c[1]]), {
            color: '#22c55e', weight: 6, opacity: 0.9, lineCap: 'round', lineJoin: 'round',
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
      saveTrackingState({ coordinates: coordsRef.current, startTime: startTimeRef.current, pausedDuration: pausedDurationRef.current, lastPauseTime: lastPauseTimeRef.current, isPaused });
    }, 5000);
    return () => window.clearInterval(iv);
  }, [isTracking, isPaused]);

  // --- Cleanup on unmount ---
  useEffect(() => { return () => { releaseWakeLock(); closeTrackingNotification(); }; }, []);

  // --- Controls ---
  const handleStart = async () => {
    const now = Date.now();
    startTimeRef.current = now; pausedDurationRef.current = 0; lastPauseTimeRef.current = null; coordsRef.current = [];
    setIsTracking(true); setIsPaused(false); setDistance(0); setDisplayDuration(0);
    const ok = await acquireWakeLock(); setScreenLockActive(ok);
    showTrackingNotification(); startDisplayTimer(); startGpsWatch();
    saveTrackingState({ coordinates: [], startTime: now, pausedDuration: 0, lastPauseTime: null, isPaused: false });
  };

  const handlePause = () => {
    setIsPaused(true); lastPauseTimeRef.current = Date.now(); updateDisplayDuration();
    if (displayTimerRef.current) { window.clearInterval(displayTimerRef.current); displayTimerRef.current = null; }
    if (watchIdRef.current) { clearWatch(watchIdRef.current); watchIdRef.current = null; }
    saveTrackingState({ coordinates: coordsRef.current, startTime: startTimeRef.current, pausedDuration: pausedDurationRef.current, lastPauseTime: lastPauseTimeRef.current, isPaused: true });
  };

  const handleResume = async () => {
    if (lastPauseTimeRef.current) pausedDurationRef.current += Date.now() - lastPauseTimeRef.current;
    lastPauseTimeRef.current = null; setIsPaused(false);
    const ok = await acquireWakeLock(); setScreenLockActive(ok);
    startDisplayTimer(); startGpsWatch();
    saveTrackingState({ coordinates: coordsRef.current, startTime: startTimeRef.current, pausedDuration: pausedDurationRef.current, lastPauseTime: null, isPaused: false });
  };

  const handleStop = () => {
    if (watchIdRef.current) clearWatch(watchIdRef.current);
    if (displayTimerRef.current) window.clearInterval(displayTimerRef.current);
    releaseWakeLock(); closeTrackingNotification(); clearTrackingState();
    const finalDuration = getRealDurationSec();
    const finalCoords = coordsRef.current;
    onComplete({ coordinates: finalCoords, distance: calculateDistance(finalCoords), duration: finalDuration });
  };

  const handleCancelTracking = () => {
    if (watchIdRef.current) clearWatch(watchIdRef.current);
    if (displayTimerRef.current) window.clearInterval(displayTimerRef.current);
    releaseWakeLock(); closeTrackingNotification(); clearTrackingState(); onCancel();
  };

  const formatTime = (s: number) => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  };
  const formatDist = (m: number) => m < 1000 ? `${m.toFixed(0)} m` : `${(m / 1000).toFixed(2)} km`;
  const pace = displayDuration > 0 && distance > 0 ? (displayDuration / 60) / (distance / 1000) : 0;

  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      <div className="flex-1 relative">
        <div ref={mapContainer} className="absolute inset-0" data-testid="tracker-map" />
        <button className="absolute left-3 z-[1000] w-10 h-10 flex items-center justify-center bg-card/95 backdrop-blur-md rounded-full shadow-lg border border-border"
          style={{ top: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)' }} onClick={handleCancelTracking} data-testid="button-cancel">
          <X className="h-5 w-5" />
        </button>
        {isTracking && !isPaused && (
          <div className="absolute right-3 z-[1000]" style={{ top: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)' }}>
            <div className="flex items-center gap-2 px-3 py-1.5 bg-red-500 text-white rounded-full shadow-lg">
              <div className="w-2 h-2 bg-white rounded-full animate-pulse" /><span className="text-xs font-semibold">REC</span>
            </div>
          </div>
        )}
        {isTracking && (
          <div className="absolute left-1/2 -translate-x-1/2 z-[1000]" style={{ top: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)' }}>
            <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full shadow-lg text-xs font-medium ${screenLockActive ? 'bg-green-500/90 text-white' : 'bg-yellow-500/90 text-black'}`}>
              <Smartphone className="w-3 h-3" />{screenLockActive ? 'Pantalla activa' : 'No bloquees'}
            </div>
          </div>
        )}
        {isGettingLocation && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/50 backdrop-blur-sm z-[999]">
            <div className="flex flex-col items-center gap-2">
              <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <span className="text-sm text-muted-foreground">Obteniendo ubicación...</span>
            </div>
          </div>
        )}
      </div>
      <div className="bg-card border-t border-border p-4 space-y-4" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 1rem)' }}>
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
            <p className="text-xl font-bold tabular-nums" data-testid="text-pace">{pace > 0 ? `${pace.toFixed(1)}'` : "0.0'"}</p>
          </div>
        </div>
        {!isTracking ? (
          <Button size="lg" className="w-full h-14 text-base font-semibold gradient-primary border-0 active:scale-[0.98] transition-transform" onClick={handleStart} disabled={isGettingLocation} data-testid="button-start-tracking">
            <Play className="h-6 w-6 mr-2" fill="currentColor" />Iniciar Ruta
          </Button>
        ) : (
          <div className="flex gap-3">
            {!isPaused ? (
              <Button size="lg" variant="secondary" className="flex-1 h-14 font-semibold active:scale-[0.98] transition-transform" onClick={handlePause} data-testid="button-pause">
                <Pause className="h-5 w-5 mr-2" />Pausar
              </Button>
            ) : (
              <Button size="lg" className="flex-1 h-14 font-semibold gradient-primary border-0 active:scale-[0.98] transition-transform" onClick={handleResume} data-testid="button-resume">
                <Play className="h-5 w-5 mr-2" fill="currentColor" />Reanudar
              </Button>
            )}
            <Button size="lg" variant="destructive" className="flex-1 h-14 font-semibold active:scale-[0.98] transition-transform" onClick={handleStop} data-testid="button-stop">
              <Square className="h-5 w-5 mr-2" fill="currentColor" />Finalizar
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
