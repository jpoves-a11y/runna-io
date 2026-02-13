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
import { Card } from '@/components/ui/card';
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
    const date = new Date(dateStr);
    return date.toLocaleDateString('es-ES', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

function MiniMap({ polyline, activityName }: { polyline: string; activityName: string }) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);

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

    L.tileLayer('https://{s}.basemaps.cartocdn.com/positron/{z}/{x}/{y}{r}.png').addTo(map);

    const latlngs = coordinates.map(([lat, lng]) => L.latLng(lat, lng));
    const polylineLayer = L.polyline(latlngs, {
      color: '#D4213D',
      weight: 3,
      opacity: 0.9,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(map);

    // Add start/end markers
    if (latlngs.length > 0) {
      L.circleMarker(latlngs[0], {
        radius: 5,
        color: '#16a34a',
        fillColor: '#16a34a',
        fillOpacity: 1,
        weight: 2,
      }).addTo(map);

      L.circleMarker(latlngs[latlngs.length - 1], {
        radius: 5,
        color: '#dc2626',
        fillColor: '#dc2626',
        fillOpacity: 1,
        weight: 2,
      }).addTo(map);
    }

    const bounds = polylineLayer.getBounds();
    map.fitBounds(bounds, { padding: [20, 20] });

    // Invalidate size after dialog animation completes
    setTimeout(() => {
      map.invalidateSize();
      map.fitBounds(bounds, { padding: [20, 20] });
    }, 350);

    mapRef.current = map;

    return () => {
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
      <DialogContent className="w-[calc(100%-2rem)] max-w-sm mx-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="h-5 w-5 text-primary" />
            Nueva Actividad
          </DialogTitle>
          <DialogDescription>
            {totalCount > 1
              ? `Actividad ${currentIndex + 1} de ${totalCount}`
              : 'Revisa los detalles antes de importar'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Activity name + type */}
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-base truncate flex-1 mr-2">
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

          {/* Info grid */}
          <Card className="p-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <div>
                  <p className="text-xs text-muted-foreground">Fecha</p>
                  <p className="text-sm font-medium">{formatDate(activity.startDate)}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Route className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <div>
                  <p className="text-xs text-muted-foreground">Distancia</p>
                  <p className="text-sm font-medium">
                    {(activity.distance / 1000).toFixed(2)} km
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Timer className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <div>
                  <p className="text-xs text-muted-foreground">Duracion</p>
                  <p className="text-sm font-medium">{formatDuration(activity.duration)}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <MapPin className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <div>
                  <p className="text-xs text-muted-foreground">Tipo</p>
                  <p className="text-sm font-medium">{activity.activityType}</p>
                </div>
              </div>
            </div>
          </Card>

          {/* Action buttons */}
          <div className="flex gap-2 pt-1">
            <Button
              onClick={onAccept}
              disabled={isProcessing || !activity.summaryPolyline}
              className="flex-1 bg-primary hover:bg-primary/90 text-sm"
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
                className="flex-shrink-0"
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
