import { useEffect, useRef, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { MapPin, Timer, Route, Trophy, TrendingUp, Swords, Check } from 'lucide-react'; 
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { decodePolyline } from '@/lib/polyline';

interface VictimInfo {
  userId: string;
  userName: string;
  userColor: string;
  stolenArea: number;
}

interface RouteCompletionData {
  routeName: string;
  distance: number;
  duration: number;
  summaryPolyline: string | null;
  territory: { area: number } | null;
  metrics: {
    totalArea: number;
    newAreaConquered: number;
    areaStolen: number;
    ranTogetherWith: string[];
    victimsNotified: string[];
    victims?: VictimInfo[];
  } | null;
  senderId?: string;
}

interface RouteCompletionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: RouteCompletionData | null;
  onShowConquestResults?: () => void;
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m ${secs}s`;
}

function formatDistance(meters: number): string {
  if (meters < 1000) return `${meters.toFixed(0)} m`;
  return `${(meters / 1000).toFixed(2)} km`;
}

function AnimatedMiniMap({ polyline }: { polyline: string }) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const polylineLayerRef = useRef<L.Polyline | null>(null);
  const animationRef = useRef<number | null>(null);
  const startMarkerRef = useRef<L.CircleMarker | null>(null);
  const endMarkerRef = useRef<L.CircleMarker | null>(null);
  const runnerMarkerRef = useRef<L.CircleMarker | null>(null);

  const coordinates = useMemo(() => {
    try {
      return decodePolyline(polyline);
    } catch {
      return [];
    }
  }, [polyline]);

  useEffect(() => {
    if (!mapContainerRef.current || coordinates.length === 0) return;

    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
    if (mapRef.current) {
      mapRef.current.remove();
      mapRef.current = null;
    }

    const map = L.map(mapContainerRef.current, {
      zoomControl: false,
      attributionControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      touchZoom: false,
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png').addTo(map);

    const latlngs = coordinates.map(([lat, lng]) => L.latLng(lat, lng));
    const fullPolyline = L.polyline(latlngs);
    const bounds = fullPolyline.getBounds();
    map.fitBounds(bounds, { padding: [25, 25] });

    startMarkerRef.current = L.circleMarker(latlngs[0], {
      radius: 6, color: '#fff', fillColor: '#16a34a', fillOpacity: 1, weight: 2,
    }).addTo(map);

    polylineLayerRef.current = L.polyline([], {
      color: '#22c55e', weight: 4, opacity: 0.9, lineCap: 'round', lineJoin: 'round',
    }).addTo(map);

    runnerMarkerRef.current = L.circleMarker(latlngs[0], {
      radius: 5, color: '#fff', fillColor: '#22c55e', fillOpacity: 1, weight: 2,
    }).addTo(map);

    setTimeout(() => {
      map.invalidateSize();
      map.fitBounds(bounds, { padding: [25, 25] });

      const ANIMATION_DURATION = 3000;
      const startTime = performance.now();
      const totalPoints = latlngs.length;

      const animate = (currentTime: number) => {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / ANIMATION_DURATION, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        const pointCount = Math.max(1, Math.floor(eased * totalPoints));
        const currentPoints = latlngs.slice(0, pointCount);

        if (polylineLayerRef.current) polylineLayerRef.current.setLatLngs(currentPoints);
        if (runnerMarkerRef.current && currentPoints.length > 0) {
          runnerMarkerRef.current.setLatLng(currentPoints[currentPoints.length - 1]);
        }

        if (progress < 1) {
          animationRef.current = requestAnimationFrame(animate);
        } else {
          endMarkerRef.current = L.circleMarker(latlngs[latlngs.length - 1], {
            radius: 6, color: '#fff', fillColor: '#dc2626', fillOpacity: 1, weight: 2,
          }).addTo(map);
          if (runnerMarkerRef.current) {
            map.removeLayer(runnerMarkerRef.current);
            runnerMarkerRef.current = null;
          }
        }
      };

      animationRef.current = requestAnimationFrame(animate);
    }, 400);

    mapRef.current = map;

    return () => {
      if (animationRef.current) { cancelAnimationFrame(animationRef.current); animationRef.current = null; }
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
    };
  }, [coordinates]);

  if (coordinates.length === 0) {
    return (
      <div className="w-full h-[180px] rounded-lg bg-muted/50 flex items-center justify-center border border-border/50">
        <div className="text-center text-muted-foreground">
          <MapPin className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm">Sin datos GPS</p>
        </div>
      </div>
    );
  }

  return <div ref={mapContainerRef} className="w-full h-[180px] rounded-lg overflow-hidden border border-border/50" />;
}

function AnimatedCounter({ value, duration = 1500, suffix = '' }: { value: number; duration?: number; suffix?: string }) {
  const [display, setDisplay] = useState(0);
  
  useEffect(() => {
    if (value <= 0) { setDisplay(0); return; }
    const start = performance.now();
    const animate = (now: number) => {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(eased * value);
      if (progress < 1) requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
  }, [value, duration]);

  return <>{display.toFixed(2)}{suffix}</>;
}

export function RouteCompletionDialog({ open, onOpenChange, data, onShowConquestResults }: RouteCompletionDialogProps) {

  if (!data) return null;

  const hasTerritory = !!data.territory;
  const conqueredAreaKm2 = data.metrics?.newAreaConquered ? data.metrics.newAreaConquered / 1000000 : (data.territory?.area ? data.territory.area / 1000000 : 0);
  const totalAreaKm2 = data.metrics?.totalArea ? data.metrics.totalArea / 1000000 : 0;
  const stolenAreaKm2 = data.metrics?.areaStolen ? data.metrics.areaStolen / 1000000 : 0;
  const pace = data.duration > 0 && data.distance > 0 ? (data.duration / 60) / (data.distance / 1000) : 0;
  const victimDetails = data.metrics?.victims || [];

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[calc(100%-1rem)] max-w-sm mx-auto gap-0 overflow-hidden rounded-2xl border-0 shadow-2xl [&>button]:text-white [&>button]:hover:text-white/80 [&>button]:z-10"
        style={{ padding: '0', paddingTop: '0', paddingBottom: '0' }}
      >
        {/* Header */}
        <div className="relative bg-gradient-to-br from-emerald-500 via-green-500 to-teal-600 px-4 py-4 text-white">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.15),transparent_70%)]" />
          <DialogHeader className="space-y-1 relative">
            <DialogTitle className="flex items-center gap-2.5 text-lg font-bold text-white">
              <div className="bg-white/20 backdrop-blur-sm rounded-lg p-1.5">
                {hasTerritory ? <Trophy className="h-5 w-5" /> : <Check className="h-5 w-5" />}
              </div>
              {hasTerritory ? '¡Territorio conquistado!' : 'Ruta completada'}
            </DialogTitle>
            <DialogDescription className="text-sm text-white/85">
              {data.routeName}
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="space-y-2.5 p-3" style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom, 0px))' }}>
          {/* Map preview */}
          {data.summaryPolyline && <AnimatedMiniMap polyline={data.summaryPolyline} />}

          {/* Stats grid */}
          <div className="grid grid-cols-3 gap-2 p-2 bg-muted/30 rounded-lg border border-border/50">
            <div className="text-center">
              <Route className="h-4 w-4 mx-auto text-muted-foreground mb-0.5" />
              <p className="text-[10px] text-muted-foreground">Distancia</p>
              <p className="text-xs font-bold">{formatDistance(data.distance)}</p>
            </div>
            <div className="text-center">
              <Timer className="h-4 w-4 mx-auto text-muted-foreground mb-0.5" />
              <p className="text-[10px] text-muted-foreground">Duración</p>
              <p className="text-xs font-bold">{formatDuration(data.duration)}</p>
            </div>
            <div className="text-center">
              <TrendingUp className="h-4 w-4 mx-auto text-muted-foreground mb-0.5" />
              <p className="text-[10px] text-muted-foreground">Ritmo</p>
              <p className="text-xs font-bold">{pace > 0 ? `${pace.toFixed(1)}'/km` : '-'}</p>
            </div>
          </div>

          {/* Conquest stats */}
          {hasTerritory && (
            <div className="space-y-2 animate-in slide-in-from-bottom-2 duration-500">
              {/* New area conquered */}
              <div className="flex items-center gap-3 p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200/50 dark:border-emerald-800/30">
                <div className="flex items-center justify-center h-10 w-10 rounded-full bg-emerald-100 dark:bg-emerald-900/50">
                  <TrendingUp className="h-5 w-5 text-emerald-600" />
                </div>
                <div className="flex-1">
                  <p className="text-xs text-muted-foreground">Nuevo territorio</p>
                  <p className="text-xl font-bold text-emerald-600">
                    +<AnimatedCounter value={conqueredAreaKm2} suffix=" km²" />
                  </p>
                </div>
              </div>

              {/* Stolen area */}
              {stolenAreaKm2 > 0 && (
                <div className="flex items-center gap-3 p-3 rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200/50 dark:border-red-800/30">
                  <div className="flex items-center justify-center h-10 w-10 rounded-full bg-red-100 dark:bg-red-900/50">
                    <Swords className="h-5 w-5 text-red-500" />
                  </div>
                  <div className="flex-1">
                    <p className="text-xs text-muted-foreground">Robado a otros</p>
                    <p className="text-lg font-bold text-red-500">
                      <AnimatedCounter value={stolenAreaKm2} suffix=" km²" />
                    </p>
                  </div>
                </div>
              )}

              {victimDetails.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 px-1">
                    <Swords className="h-4 w-4 text-red-500" />
                    <p className="text-sm font-semibold">Has robado a</p>
                  </div>
                  <div className="space-y-1.5 max-h-32 overflow-y-auto">
                    {victimDetails.map((victim) => (
                      <div
                        key={victim.userId}
                        className="flex items-center gap-2.5 p-2.5 bg-muted/30 rounded-lg"
                      >
                        <div
                          className="w-3 h-3 rounded-full flex-shrink-0"
                          style={{ backgroundColor: victim.userColor }}
                        />
                        <span className="text-sm flex-1 truncate">{victim.userName}</span>
                        <span className="text-xs font-semibold text-red-500">
                          -{(victim.stolenArea / 1000000).toFixed(2)} km²
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Total area */}
              {totalAreaKm2 > 0 && (
                <div className="flex items-center gap-3 p-2.5 rounded-xl bg-primary/5 border border-primary/10">
                  <div className="flex items-center justify-center h-8 w-8 rounded-full bg-primary/10">
                    <MapPin className="h-4 w-4 text-primary" />
                  </div>
                  <div className="flex-1">
                    <p className="text-xs text-muted-foreground">Área total</p>
                    <p className="text-base font-bold">
                      <AnimatedCounter value={totalAreaKm2} suffix=" km²" />
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          {!hasTerritory && (
            <div className="text-center py-2 text-sm text-muted-foreground">
              La ruta se ha guardado correctamente.
            </div>
          )}

          {hasTerritory && onShowConquestResults && (
            <Button
              variant="outline"
              onClick={() => {
                onOpenChange(false);
                onShowConquestResults();
              }}
              className="w-full h-11 text-sm font-semibold border-primary/30 text-primary hover:bg-primary/5 active:scale-[0.98] transition-transform"
            >
              Ver resultados de conquista
            </Button>
          )}

          {/* Close button */}
          <Button
            onClick={() => onOpenChange(false)}
            className="w-full h-11 text-sm font-semibold gradient-primary border-0 active:scale-[0.98] transition-transform"
          >
            <Check className="h-4 w-4 mr-2" />
            Cerrar
          </Button>
        </div>
      </DialogContent>
    </Dialog>

    </>
  );
}
