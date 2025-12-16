import { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Play, Pause, Square, MapPin, Zap, Activity, X } from 'lucide-react';
import { watchPosition, clearWatch, getCurrentPosition, type Coordinates } from '@/lib/geolocation';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

interface RouteTrackerProps {
  onComplete: (data: {
    coordinates: Array<[number, number]>;
    distance: number;
    duration: number;
  }) => void;
  onCancel: () => void;
}

export function RouteTracker({ onComplete, onCancel }: RouteTrackerProps) {
  const [isTracking, setIsTracking] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [duration, setDuration] = useState(0);
  const [distance, setDistance] = useState(0);
  const [coordinates, setCoordinates] = useState<Array<[number, number]>>([]);
  const [isGettingLocation, setIsGettingLocation] = useState(true);
  
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const routeLineRef = useRef<L.Polyline | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const intervalRef = useRef<number | null>(null);
  const userMarkerRef = useRef<L.Marker | null>(null);

  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;

    const map = L.map(mapContainer.current, {
      center: [40.4168, -3.7038],
      zoom: 16,
      zoomControl: false,
      attributionControl: false,
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
    }).addTo(map);

    mapRef.current = map;

    getCurrentPosition()
      .then((pos) => {
        map.setView([pos.lat, pos.lng], 17);
        const pulsingIcon = L.divIcon({
          className: 'current-location-marker',
          html: `
            <div class="relative flex items-center justify-center">
              <div class="absolute w-8 h-8 bg-primary/30 rounded-full animate-ping"></div>
              <div class="relative w-4 h-4 bg-primary rounded-full border-2 border-white shadow-lg"></div>
            </div>
          `,
          iconSize: [32, 32],
          iconAnchor: [16, 16],
        });
        userMarkerRef.current = L.marker([pos.lat, pos.lng], { icon: pulsingIcon }).addTo(map);
      })
      .catch(() => {})
      .finally(() => setIsGettingLocation(false));

    return () => {
      if (watchIdRef.current) clearWatch(watchIdRef.current);
      if (intervalRef.current) window.clearInterval(intervalRef.current);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  const calculateDistance = (coords: Array<[number, number]>): number => {
    if (coords.length < 2) return 0;
    
    let total = 0;
    for (let i = 1; i < coords.length; i++) {
      const [lat1, lng1] = coords[i - 1];
      const [lat2, lng2] = coords[i];
      
      const R = 6371000;
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLng = (lng2 - lng1) * Math.PI / 180;
      const a = 
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      total += R * c;
    }
    
    return total;
  };

  const handleStart = () => {
    setIsTracking(true);
    setIsPaused(false);

    intervalRef.current = window.setInterval(() => {
      setDuration((d) => d + 1);
    }, 1000);

    watchIdRef.current = watchPosition(
      (coords: Coordinates) => {
        const newCoords: [number, number] = [coords.lat, coords.lng];
        
        if (userMarkerRef.current && mapRef.current) {
          userMarkerRef.current.setLatLng([coords.lat, coords.lng]);
        }
        
        setCoordinates((prev) => {
          const updated = [...prev, newCoords];
          setDistance(calculateDistance(updated));
          
          if (mapRef.current) {
            mapRef.current.setView(newCoords, 17, { animate: true });
            
            if (routeLineRef.current) {
              routeLineRef.current.setLatLngs(updated.map(c => [c[0], c[1]]));
            } else {
              routeLineRef.current = L.polyline(updated.map(c => [c[0], c[1]]), {
                color: '#22c55e',
                weight: 6,
                opacity: 0.9,
                lineCap: 'round',
                lineJoin: 'round',
              }).addTo(mapRef.current);
            }
          }
          
          return updated;
        });
      }
    );
  };

  const handlePause = () => {
    setIsPaused(true);
    if (intervalRef.current) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (watchIdRef.current) {
      clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
  };

  const handleResume = () => {
    handleStart();
  };

  const handleStop = () => {
    if (watchIdRef.current) clearWatch(watchIdRef.current);
    if (intervalRef.current) window.clearInterval(intervalRef.current);
    
    onComplete({
      coordinates,
      distance,
      duration,
    });
  };

  const formatTime = (seconds: number) => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const formatDistance = (meters: number) => {
    if (meters < 1000) return `${meters.toFixed(0)} m`;
    return `${(meters / 1000).toFixed(2)} km`;
  };

  const pace = duration > 0 && distance > 0 
    ? (duration / 60) / (distance / 1000) 
    : 0;

  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      {/* Map - Full screen */}
      <div className="flex-1 relative">
        <div ref={mapContainer} className="absolute inset-0" data-testid="tracker-map" />
        
        {/* Close button */}
        <button
          className="absolute top-3 left-3 z-[1000] w-10 h-10 flex items-center justify-center bg-card/95 backdrop-blur-md rounded-full shadow-lg border border-border"
          onClick={onCancel}
          data-testid="button-cancel"
        >
          <X className="h-5 w-5" />
        </button>

        {/* Recording indicator */}
        {isTracking && !isPaused && (
          <div className="absolute top-3 right-3 z-[1000]">
            <div className="flex items-center gap-2 px-3 py-1.5 bg-red-500 text-white rounded-full shadow-lg">
              <div className="w-2 h-2 bg-white rounded-full animate-pulse" />
              <span className="text-xs font-semibold">REC</span>
            </div>
          </div>
        )}
        
        {/* Loading indicator */}
        {isGettingLocation && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/50 backdrop-blur-sm z-[999]">
            <div className="flex flex-col items-center gap-2">
              <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <span className="text-sm text-muted-foreground">Obteniendo ubicación...</span>
            </div>
          </div>
        )}
      </div>

      {/* Bottom Panel - Stats and Controls */}
      <div className="bg-card border-t border-border p-4 space-y-4 safe-area-bottom">
        {/* Stats Row */}
        <div className="grid grid-cols-3 gap-3">
          <div className="text-center">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1 flex items-center justify-center gap-1">
              <Activity className="h-3 w-3" />
              Tiempo
            </p>
            <p className="text-xl font-bold tabular-nums" data-testid="text-duration">
              {formatTime(duration)}
            </p>
          </div>
          <div className="text-center border-x border-border">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1 flex items-center justify-center gap-1">
              <MapPin className="h-3 w-3" />
              Distancia
            </p>
            <p className="text-xl font-bold tabular-nums" data-testid="text-distance">
              {formatDistance(distance)}
            </p>
          </div>
          <div className="text-center">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1 flex items-center justify-center gap-1">
              <Zap className="h-3 w-3" />
              Ritmo
            </p>
            <p className="text-xl font-bold tabular-nums" data-testid="text-pace">
              {pace > 0 ? `${pace.toFixed(1)}'` : "0.0'"}
            </p>
          </div>
        </div>

        {/* Control Buttons */}
        {!isTracking ? (
          <Button
            size="lg"
            className="w-full h-14 text-base font-semibold gradient-primary border-0 active:scale-[0.98] transition-transform"
            onClick={handleStart}
            disabled={isGettingLocation}
            data-testid="button-start-tracking"
          >
            <Play className="h-6 w-6 mr-2" fill="currentColor" />
            Iniciar Ruta
          </Button>
        ) : (
          <div className="flex gap-3">
            {!isPaused ? (
              <Button
                size="lg"
                variant="secondary"
                className="flex-1 h-14 font-semibold active:scale-[0.98] transition-transform"
                onClick={handlePause}
                data-testid="button-pause"
              >
                <Pause className="h-5 w-5 mr-2" />
                Pausar
              </Button>
            ) : (
              <Button
                size="lg"
                className="flex-1 h-14 font-semibold gradient-primary border-0 active:scale-[0.98] transition-transform"
                onClick={handleResume}
                data-testid="button-resume"
              >
                <Play className="h-5 w-5 mr-2" fill="currentColor" />
                Reanudar
              </Button>
            )}
            <Button
              size="lg"
              variant="destructive"
              className="flex-1 h-14 font-semibold active:scale-[0.98] transition-transform"
              onClick={handleStop}
              data-testid="button-stop"
            >
              <Square className="h-5 w-5 mr-2" fill="currentColor" />
              Finalizar
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
