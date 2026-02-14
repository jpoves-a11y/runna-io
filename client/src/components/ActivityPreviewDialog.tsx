import { useEffect, useRef, useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { MapPin, Calendar, Timer, Route, Loader2, SkipForward, Download } from 'lucide-react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { decodePolyline } from '@/lib/polyline';

interface PolarActivityPreview {
  id: string;
  polarExerciseId: string;
  userId: string;
  name: string;
  activityType: string;
  distance: number;
  duration: number;
  startDate: string;
  summaryPolyline: string | null;
  processed: boolean;
}

interface ActivityPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activity: PolarActivityPreview | null;
  currentIndex: number;
  totalCount: number;
  onAccept: () => void;
  onSkip: () => void;
  isProcessing: boolean;
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

function formatDate(dateStr: string): string {
  try {
    if (!dateStr) return 'Sin fecha';
    
    // Handle numeric timestamps stored as strings (e.g. "1770750442000.0")
    if (/^\d+(\.\d+)?$/.test(dateStr.trim())) {
      const ts = Number(dateStr);
      const date = new Date(ts);
      if (!isNaN(date.getTime()) && date.getFullYear() > 1970 && date.getFullYear() < 2100) {
        return date.toLocaleDateString('es-ES', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
      }
      // Maybe seconds instead of ms
      const dateSec = new Date(ts * 1000);
      if (!isNaN(dateSec.getTime()) && dateSec.getFullYear() > 1970 && dateSec.getFullYear() < 2100) {
        return dateSec.toLocaleDateString('es-ES', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
      }
    }
    
    // Handle ISO strings and other standard formats
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      const match = dateStr.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (match) {
        return `${match[3]}/${match[2]}/${match[1]}`;
      }
      return dateStr;
    }
    return date.toLocaleDateString('es-ES', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return dateStr || 'Sin fecha';
  }
}

function MiniMap({ polyline, activityName }: { polyline: string; activityName: string }) {
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

    // Clean up previous map
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

    // Fit bounds first (using full route bounds)
    const fullPolyline = L.polyline(latlngs);
    const bounds = fullPolyline.getBounds();
    map.fitBounds(bounds, { padding: [25, 25] });

    // Start marker (green)
    startMarkerRef.current = L.circleMarker(latlngs[0], {
      radius: 6,
      color: '#fff',
      fillColor: '#16a34a',
      fillOpacity: 1,
      weight: 2,
    }).addTo(map);

    // Animated polyline - starts empty
    polylineLayerRef.current = L.polyline([], {
      color: '#D4213D',
      weight: 3,
      opacity: 0.9,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(map);

    // Runner dot (moves along the route)
    runnerMarkerRef.current = L.circleMarker(latlngs[0], {
      radius: 4,
      color: '#fff',
      fillColor: '#D4213D',
      fillOpacity: 1,
      weight: 2,
    }).addTo(map);

    // Invalidate size after dialog animation completes, then start route animation
    setTimeout(() => {
      map.invalidateSize();
      map.fitBounds(bounds, { padding: [25, 25] });

      // Animate the polyline drawing
      const ANIMATION_DURATION = 3000; // 3 seconds
      const startTime = performance.now();
      const totalPoints = latlngs.length;

      const animate = (currentTime: number) => {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / ANIMATION_DURATION, 1);
        
        // Ease-out cubic for smooth deceleration
        const eased = 1 - Math.pow(1 - progress, 3);
        const pointCount = Math.max(1, Math.floor(eased * totalPoints));
        const currentPoints = latlngs.slice(0, pointCount);

        if (polylineLayerRef.current) {
          polylineLayerRef.current.setLatLngs(currentPoints);
        }

        // Move runner dot
        if (runnerMarkerRef.current && currentPoints.length > 0) {
          runnerMarkerRef.current.setLatLng(currentPoints[currentPoints.length - 1]);
        }

        if (progress < 1) {
          animationRef.current = requestAnimationFrame(animate);
        } else {
          // Animation complete - add end marker
          endMarkerRef.current = L.circleMarker(latlngs[latlngs.length - 1], {
            radius: 6,
            color: '#fff',
            fillColor: '#dc2626',
            fillOpacity: 1,
            weight: 2,
          }).addTo(map);

          // Remove runner dot after completion
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
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [coordinates, activityName]);

  if (coordinates.length === 0) {
    return (
      <div className="w-full h-[180px] sm:h-[200px] rounded-lg bg-muted/50 flex items-center justify-center border border-border/50">
        <div className="text-center text-muted-foreground">
          <MapPin className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm">Sin datos GPS</p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={mapContainerRef}
      className="w-full h-[180px] sm:h-[200px] rounded-lg overflow-hidden border border-border/50"
    />
  );
}

export function ActivityPreviewDialog({
  open,
  onOpenChange,
  activity,
  currentIndex,
  totalCount,
  onAccept,
  onSkip,
  isProcessing,
}: ActivityPreviewDialogProps) {
  if (!activity) return null;

  return (
    <Dialog open={open} onOpenChange={isProcessing ? undefined : onOpenChange}>
      <DialogContent className="w-[calc(100%-1rem)] max-w-sm mx-auto gap-0 overflow-hidden rounded-2xl border-0 shadow-2xl [&>button]:text-white [&>button]:hover:text-white/80 [&>button]:z-10" style={{ padding: '0', paddingTop: '0', paddingBottom: '0' }}>
        {/* Green header with icon */}
        <div className="relative bg-gradient-to-br from-emerald-500 via-green-500 to-teal-600 px-4 py-4 text-white">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.15),transparent_70%)]" />
          <DialogHeader className="space-y-1 relative">
            <DialogTitle className="flex items-center gap-2.5 text-lg font-bold text-white">
              <div className="bg-white/20 backdrop-blur-sm rounded-lg p-1.5">
                <Download className="h-5 w-5" />
              </div>
              Nueva Actividad
            </DialogTitle>
            <DialogDescription className="text-sm text-white/85">
              {totalCount > 1
                ? `Actividad ${currentIndex + 1} de ${totalCount} pendientes`
                : 'Revisa los detalles antes de importar'}
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="space-y-2 p-3" style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom, 0px))' }}>
          {/* Activity name + type */}
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-sm sm:text-base truncate flex-1 mr-2">
              {activity.name}
            </h3>
            <Badge variant="secondary" className="text-xs flex-shrink-0">
              {activity.activityType}
            </Badge>
          </div>

          {/* Mini-map preview */}
          {activity.summaryPolyline ? (
            <MiniMap polyline={activity.summaryPolyline} activityName={activity.name} />
          ) : (
            <div className="w-full h-[180px] sm:h-[200px] rounded-lg bg-muted/50 flex items-center justify-center border border-border/50">
              <div className="text-center text-muted-foreground">
                <MapPin className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">Sin datos GPS</p>
              </div>
            </div>
          )}

          {/* Info grid - 3 items in a row */}
          <div className="grid grid-cols-3 gap-2 p-2 bg-muted/30 rounded-lg border border-border/50">
            <div className="text-center">
              <Calendar className="h-4 w-4 mx-auto text-muted-foreground mb-0.5" />
              <p className="text-[10px] text-muted-foreground">Fecha</p>
              <p className="text-xs font-semibold">{formatDate(activity.startDate)}</p>
            </div>
            <div className="text-center">
              <Route className="h-4 w-4 mx-auto text-muted-foreground mb-0.5" />
              <p className="text-[10px] text-muted-foreground">Distancia</p>
              <p className="text-xs font-semibold">{(activity.distance / 1000).toFixed(2)} km</p>
            </div>
            <div className="text-center">
              <Timer className="h-4 w-4 mx-auto text-muted-foreground mb-0.5" />
              <p className="text-[10px] text-muted-foreground">Duracion</p>
              <p className="text-xs font-semibold">{formatDuration(activity.duration)}</p>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex gap-2 pt-1">
            <Button
              onClick={onAccept}
              disabled={isProcessing || !activity.summaryPolyline}
              className="flex-1 bg-primary hover:bg-primary/90 text-sm h-11"
            >
              {isProcessing ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin flex-shrink-0" />
                  <span className="truncate">Procesando...</span>
                </>
              ) : (
                <>
                  <Download className="h-4 w-4 mr-2 flex-shrink-0" />
                  <span className="truncate">Importar y ver en mapa</span>
                </>
              )}
            </Button>
            {totalCount > 1 && (
              <Button
                variant="outline"
                onClick={onSkip}
                disabled={isProcessing}
                className="flex-shrink-0 h-11"
              >
                <SkipForward className="h-4 w-4 mr-1" />
                Omitir
              </Button>
            )}
          </div>

          {!activity.summaryPolyline && (
            <p className="text-xs text-muted-foreground text-center">
              Esta actividad no tiene datos GPS y no puede ser importada al mapa.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
