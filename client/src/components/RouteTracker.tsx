import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Play, Pause, Square, MapPin, Zap, Activity, X, Smartphone, Loader2 } from 'lucide-react';
import { watchPosition, clearWatch, getCurrentPosition, type Coordinates } from '@/lib/geolocation';
import { acquireWakeLock, releaseWakeLock, setupVisibilityReacquire } from '@/lib/wakeLock';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const STORAGE_KEY = 'runna-route-tracking';
const MIN_ACCURACY_METERS = 30; // Ignore GPS points with accuracy worse than 30m
const MIN_MOVEMENT_METERS = 3; // Ignore points closer than 3m to last accepted point (jitter filter)

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

// Haversine distance between two [lat, lng] points in meters
function haversineDistance(a: [number, number], b: [number, number]): number {
  const [lat1, lng1] = a;
  const [lat2, lng2] = b;
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

export function RouteTracker({ onComplete, onCancel }: RouteTrackerProps) {
  const [isTracking, setIsTracking] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [displayDuration, setDisplayDuration] = useState(0);
  const [distance, setDistance] = useState(0);
  const [isGettingLocation, setIsGettingLocation] = useState(true);
  const [screenLockActive, setScreenLockActive] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [pauseTaps, setPauseTaps] = useState(0);
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null); // latest GPS accuracy in meters
  const pauseTapsTimeoutRef = useRef<number | null>(null);
  const confirmStopTimeoutRef = useRef<number | null>(null);
  const [polylineKey, setPolylineKey] = useState(0); // force re-render of polyline strip

  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const routeLineRef = useRef<L.Polyline | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const preTrackWatchRef = useRef<number | null>(null);
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

  // --- GPS watch with accuracy + jitter filtering ---
  const startGpsWatch = useCallback(() => {
    if (watchIdRef.current) clearWatch(watchIdRef.current);
    watchIdRef.current = watchPosition((coords: Coordinates) => {
      const pt: [number, number] = [coords.lat, coords.lng];

      // Always update GPS accuracy for the signal indicator
      if (coords.accuracy) setGpsAccuracy(coords.accuracy);

      // Filter: ignore low-accuracy readings
      if (coords.accuracy && coords.accuracy > MIN_ACCURACY_METERS) {
        return;
      }

      // Filter: ignore tiny movements (GPS jitter)
      if (coordsRef.current.length > 0) {
        const lastPt = coordsRef.current[coordsRef.current.length - 1];
        if (haversineDistance(lastPt, pt) < MIN_MOVEMENT_METERS) {
          // Still update the user marker position for visual feedback
          if (userMarkerObjRef.current) userMarkerObjRef.current.setLatLng([coords.lat, coords.lng]);
          return;
        }
      }

      if (userMarkerObjRef.current) userMarkerObjRef.current.setLatLng([coords.lat, coords.lng]);
      coordsRef.current = [...coordsRef.current, pt];
      setDistance(calculateDistance(coordsRef.current));
      // Trigger polyline strip re-render every 5 new points
      if (coordsRef.current.length % 5 === 0) {
        setPolylineKey(prev => prev + 1);
      }
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
        if (pos.accuracy !== undefined) setGpsAccuracy(pos.accuracy);
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

  // --- Pre-tracking GPS watch for accuracy indicator + marker updates ---
  useEffect(() => {
    if (isTracking) {
      if (preTrackWatchRef.current !== null) { clearWatch(preTrackWatchRef.current); preTrackWatchRef.current = null; }
      return;
    }
    preTrackWatchRef.current = watchPosition((coords) => {
      if (coords.accuracy !== undefined) setGpsAccuracy(coords.accuracy);
      if (userMarkerObjRef.current) userMarkerObjRef.current.setLatLng([coords.lat, coords.lng]);
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

  // --- Navigation lock: prevent browser back during tracking ---
  useEffect(() => {
    if (!isTracking) return;
    const handlePopState = () => {
      // Push back to tracking URL to prevent leaving
      window.history.pushState({}, '', '/?tracking=true');
    };
    // Push an extra entry so back button stays on tracking
    window.history.pushState({}, '', '/?tracking=true');
    window.addEventListener('popstate', handlePopState);

    // Warn before closing tab/browser
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
    if (routeLineRef.current && mapRef.current) {
      mapRef.current.removeLayer(routeLineRef.current);
      routeLineRef.current = null;
    }
    const now = Date.now();
    startTimeRef.current = now; pausedDurationRef.current = 0; lastPauseTimeRef.current = null; coordsRef.current = [];
    setIsTracking(true); setIsPaused(false); setDistance(0); setDisplayDuration(0);
    setIsSaving(false); setConfirmStop(false); setPauseTaps(0);
    const ok = await acquireWakeLock(); setScreenLockActive(ok);
    showTrackingNotification(); startDisplayTimer(); startGpsWatch();
    saveTrackingState({ coordinates: [], startTime: now, pausedDuration: 0, lastPauseTime: null, isPaused: false });
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
      saveTrackingState({ coordinates: coordsRef.current, startTime: startTimeRef.current, pausedDuration: pausedDurationRef.current, lastPauseTime: lastPauseTimeRef.current, isPaused: true });
      setPauseTaps(0);
    } else {
      pauseTapsTimeoutRef.current = window.setTimeout(() => setPauseTaps(0), 800);
    }
  };

  const handleResume = async () => {
    if (lastPauseTimeRef.current) pausedDurationRef.current += Date.now() - lastPauseTimeRef.current;
    lastPauseTimeRef.current = null; setIsPaused(false); setPauseTaps(0); setConfirmStop(false);
    const ok = await acquireWakeLock(); setScreenLockActive(ok);
    startDisplayTimer(); startGpsWatch();
    saveTrackingState({ coordinates: coordsRef.current, startTime: startTimeRef.current, pausedDuration: pausedDurationRef.current, lastPauseTime: null, isPaused: false });
  };

  const handleStop = () => {
    if (!confirmStop) {
      setConfirmStop(true);
      // Auto-reset confirm after 3 seconds
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
    setDistance(0);
    setDisplayDuration(0);
    setConfirmStop(false);
    setPauseTaps(0);
    if (routeLineRef.current && mapRef.current) {
      mapRef.current.removeLayer(routeLineRef.current);
      routeLineRef.current = null;
    }
    onComplete({ coordinates: finalCoords, distance: finalDistance, duration: finalDuration });
  };

  const handleCancelTracking = () => {
    if (isTracking) return; // Cannot cancel while actively tracking — must stop first
    if (watchIdRef.current) clearWatch(watchIdRef.current);
    if (displayTimerRef.current) window.clearInterval(displayTimerRef.current);
    releaseWakeLock(); closeTrackingNotification(); clearTrackingState();
    window.dispatchEvent(new Event('runna-tracking-changed'));
    onCancel();
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
    <div className="absolute inset-0 flex flex-col bg-black">
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

      {/* PRE-TRACKING MODE: Show map + normal UI */}
      {!isTracking ? (
        <>
          <div className="flex-1 relative">
            <div ref={mapContainer} className="absolute inset-0" data-testid="tracker-map" />
            <button className="absolute left-3 z-[1000] w-10 h-10 flex items-center justify-center bg-card/95 backdrop-blur-md rounded-full shadow-lg border border-border"
              style={{ top: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)' }} onClick={handleCancelTracking} data-testid="button-cancel">
              <X className="h-5 w-5" />
            </button>
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
        </>
      ) : (
        /* ═══════════════════════════════════════════════════════════════
           TRACKING MODE — Designed for:
           - Battery efficiency (black bg, no map tiles, minimal renders)
           - No button overlap on any screen size (flex layout, no fixed positioning)
           - Clear stat hierarchy (Time > Distance > Pace)
           - Lightweight SVG polyline strip instead of full map
           - Navigation locked (can't leave without stopping)
        ═══════════════════════════════════════════════════════════════ */
        <div className="flex-1 flex flex-col bg-black select-none">
          {/* ── Top status bar ── */}
          <div
            className="flex items-center justify-between px-3 py-1 flex-shrink-0"
            style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 0.25rem)' }}
          >
            <div className="flex items-center gap-2">
              {isPaused ? (
                <div className="flex items-center gap-1 px-2.5 py-1 bg-yellow-600 text-white rounded-full text-[11px] font-bold">
                  <Pause className="w-3 h-3" />PAUSA
                </div>
              ) : (
                <div className="flex items-center gap-1 px-2.5 py-1 bg-red-600 text-white rounded-full text-[11px] font-bold">
                  <div className="w-2 h-2 bg-white rounded-full animate-pulse" />REC
                </div>
              )}
            </div>
            <div className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold ${screenLockActive ? 'bg-green-600/80 text-white' : 'bg-yellow-600/80 text-white'}`}>
              <Smartphone className="w-3 h-3" />{screenLockActive ? 'Pantalla ON' : '⚠ Lock'}
            </div>
          </div>
          {/* ── GPS Signal indicator ── */}
          <div className="flex items-center justify-center gap-2 py-1 flex-shrink-0">
            <GpsSignalIndicator accuracy={gpsAccuracy} />
          </div>

          {/* ── Main stats area (takes most of the screen) ── */}
          <div className="flex-1 flex flex-col items-center justify-center px-4 min-h-0">
            {/* Time — largest */}
            <div className="text-center mb-3">
              <p className="text-[10px] text-slate-500 uppercase tracking-widest mb-1">Tiempo</p>
              <p className="text-6xl font-black tabular-nums text-white leading-none" data-testid="text-duration">
                {formatTime(displayDuration)}
              </p>
            </div>

            {/* Distance */}
            <div className="text-center mb-3">
              <p className="text-[10px] text-slate-500 uppercase tracking-widest mb-1">Distancia</p>
              <p className="text-4xl font-bold tabular-nums text-slate-200 leading-none" data-testid="text-distance">
                {formatDist(distance)}
              </p>
            </div>

            {/* Pace */}
            <div className="text-center">
              <p className="text-[10px] text-slate-500 uppercase tracking-widest mb-1">Ritmo</p>
              <p className="text-2xl font-semibold tabular-nums text-slate-400 leading-none" data-testid="text-pace">
                {pace > 0 ? `${formatPace(pace)} /km` : "-- /km"}
              </p>
            </div>
          </div>

          {/* ── Lightweight polyline strip (SVG, no Leaflet tiles) ── */}
          {coordsRef.current.length >= 2 && (
            <div className="flex-shrink-0 h-16 mx-4 mb-2 rounded-xl bg-slate-900/60 border border-slate-800 overflow-hidden" key={polylineKey}>
              <MiniPolylineStrip coordinates={[...coordsRef.current]} />
            </div>
          )}

          {/* ── Control buttons — fixed at bottom, never overlap stats ── */}
          <div
            className="flex-shrink-0 flex flex-col items-center px-6 pb-4"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 1.5rem)' }}
          >
            <div className="flex items-center justify-center gap-12 mb-2">
              {/* Pause / Resume button */}
              <div className="flex flex-col items-center gap-1.5">
                <button
                  className={`w-20 h-20 rounded-full flex items-center justify-center transition-all duration-200 shadow-xl ${
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
                    ? <Pause className="w-9 h-9 text-white" />
                    : <Play className="w-9 h-9 text-white ml-1" fill="white" />
                  }
                </button>
                <span className={`text-xs font-bold transition-all ${
                  !isPaused
                    ? pauseTaps > 0
                      ? 'text-orange-400 animate-pulse'
                      : 'text-slate-500'
                    : 'text-green-400'
                }`}>
                  {!isPaused
                    ? pauseTaps > 0 ? '¡PULSA OTRA VEZ!' : 'PAUSA'
                    : 'REANUDAR'
                  }
                </span>
              </div>

              {/* Stop button */}
              <div className="flex flex-col items-center gap-1.5">
                <button
                  className={`w-20 h-20 rounded-full flex items-center justify-center transition-all duration-200 shadow-xl ${
                    confirmStop
                      ? 'bg-red-600 ring-4 ring-red-400/60 scale-110'
                      : 'bg-slate-700 active:bg-slate-600'
                  }`}
                  onClick={handleStop}
                  disabled={isSaving}
                  data-testid="button-stop"
                >
                  <Square className="w-9 h-9 text-white" fill="white" />
                </button>
                <span className={`text-xs font-bold transition-all ${
                  confirmStop ? 'text-red-400 animate-pulse' : 'text-slate-500'
                }`}>
                  {confirmStop ? '¡PULSA OTRA VEZ!' : 'PARAR'}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Lightweight SVG polyline strip — no Leaflet, no tiles, minimal battery usage */
function MiniPolylineStrip({ coordinates }: { coordinates: Array<[number, number]> }) {
  if (coordinates.length < 2) return null;

  // Project to simple XY (lat/lng → equirectangular)
  const lats = coordinates.map(c => c[0]);
  const lngs = coordinates.map(c => c[1]);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const padLat = (maxLat - minLat) * 0.15 || 0.0005;
  const padLng = (maxLng - minLng) * 0.15 || 0.0005;

  const W = 300, H = 50;
  const rangeX = (maxLng - minLng + 2 * padLng) || 1;
  const rangeY = (maxLat - minLat + 2 * padLat) || 1;

  const points = coordinates.map(([lat, lng]) => {
    const x = ((lng - minLng + padLng) / rangeX) * W;
    const y = H - ((lat - minLat + padLat) / rangeY) * H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  // Current position dot
  const lastCoord = coordinates[coordinates.length - 1];
  const dotX = ((lastCoord[1] - minLng + padLng) / rangeX) * W;
  const dotY = H - ((lastCoord[0] - minLat + padLat) / rangeY) * H;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-full" preserveAspectRatio="xMidYMid meet">
      <polyline
        points={points}
        fill="none"
        stroke="#22c55e"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.8"
      />
      <circle cx={dotX} cy={dotY} r="4" fill="#22c55e" stroke="white" strokeWidth="1.5" />
    </svg>
  );
}

/** GPS signal quality indicator — shows accuracy as colored bars */
function GpsSignalIndicator({ accuracy }: { accuracy: number | null }) {
  // Determine signal quality: green (≤5m), yellow-green (≤10m), yellow (≤20m), orange (≤30m), red (>30m), grey (no signal)
  let level: number; // 0-4 bars
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
      {/* Signal bars */}
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
