import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Activity, Calendar, MapPin, TrendingUp, Timer, Route, ChevronLeft } from 'lucide-react';
import { apiRequest } from '@/lib/queryClient';
import type { RouteWithTerritory } from '@shared/schema';
import { formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

interface Props {
  userId?: string | null;
  userName?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function parseDate(value: string | number | Date): Date {
  if (value instanceof Date) return value;
  const num = typeof value === 'string' ? parseFloat(value) : value;
  return new Date(num);
}

function formatDistance(meters: number) {
  if (meters < 1000) return `${meters.toFixed(0)} m`;
  return `${(meters / 1000).toFixed(2)} km`;
}

function formatDuration(seconds: number) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (hrs > 0) return `${hrs}h ${mins}m`;
  return `${mins}m`;
}

export default function UserActivitiesDialog({ userId, userName, open, onOpenChange }: Props) {
  const [selectedRoute, setSelectedRoute] = useState<RouteWithTerritory | null>(null);

  const { data: routes = [], isLoading } = useQuery<RouteWithTerritory[]>({
    queryKey: ['user-routes', userId],
    queryFn: async () => {
      if (!userId) throw new Error('No userId');
      const res = await apiRequest('GET', `/api/routes/${userId}`);
      if (!res.ok) throw new Error('Failed to fetch routes');
      return await res.json();
    },
    enabled: !!userId && open,
    staleTime: 1000 * 60,
  });

  // Reset selected route when dialog closes
  useEffect(() => {
    if (!open) setSelectedRoute(null);
  }, [open]);

  const selectedCoordinates = useMemo(() => {
    if (!selectedRoute?.coordinates) return [];
    if (Array.isArray(selectedRoute.coordinates)) {
      return selectedRoute.coordinates as Array<[number, number]>;
    }
    if (typeof selectedRoute.coordinates === 'string') {
      try {
        const parsed = JSON.parse(selectedRoute.coordinates) as Array<[number, number]>;
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  }, [selectedRoute?.coordinates]);

  const selectedDate = selectedRoute
    ? parseDate(selectedRoute.completedAt).toLocaleDateString('es-ES', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';

  // Activity detail view (with animated map)
  if (selectedRoute) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="w-[calc(100%-1rem)] max-w-sm mx-auto gap-0 overflow-hidden rounded-2xl border-0 shadow-2xl [&>button]:text-white [&>button]:hover:text-white/80 [&>button]:z-10" style={{ padding: '0', paddingTop: '0', paddingBottom: '0' }}>
          <div className="relative bg-gradient-to-br from-emerald-500 via-green-500 to-teal-600 px-4 py-4 text-white">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.15),transparent_70%)]" />
            <DialogHeader className="space-y-1 relative">
              <DialogTitle className="flex items-center gap-2.5 text-lg font-bold text-white">
                <button
                  onClick={() => setSelectedRoute(null)}
                  className="bg-white/20 backdrop-blur-sm rounded-lg p-1.5 hover:bg-white/30 transition-colors"
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
                Detalle de actividad
              </DialogTitle>
              <DialogDescription className="text-sm text-white/85">
                {selectedRoute.name || 'Ruta'} — {userName || 'Usuario'}
              </DialogDescription>
            </DialogHeader>
          </div>

          <div className="space-y-2 p-3" style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom, 0px))' }}>
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="secondary" className="gap-1">
                <MapPin className="h-3 w-3" />
                {formatDistance(selectedRoute.distance)}
              </Badge>
              <Badge variant="secondary" className="gap-1">
                <Timer className="h-3 w-3" />
                {formatDuration(selectedRoute.duration)}
              </Badge>
              <Badge variant="secondary" className="gap-1">
                <Calendar className="h-3 w-3" />
                {selectedDate}
              </Badge>
            </div>

            <MiniRouteMap coordinates={selectedCoordinates} activityName={selectedRoute.name || ''} />

            {selectedRoute.territory && (
              <div className="text-center py-1 bg-primary/10 rounded-lg">
                <Badge className="bg-primary text-white">
                  +{(selectedRoute.territory.area / 1000000).toLocaleString('es-ES', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })} km² conquistados
                </Badge>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // Activity list view
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100%-1rem)] max-w-sm mx-auto gap-0 overflow-hidden rounded-2xl border-0 shadow-2xl p-0" style={{ padding: '0', paddingTop: '0', paddingBottom: '0' }}>
        <div className="relative bg-gradient-to-br from-emerald-500 via-green-500 to-teal-600 px-4 py-4 text-white">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.15),transparent_70%)]" />
          <DialogHeader className="space-y-1 relative">
            <DialogTitle className="flex items-center gap-2.5 text-lg font-bold text-white">
              <div className="bg-white/20 backdrop-blur-sm rounded-lg p-1.5">
                <Activity className="h-5 w-5" />
              </div>
              Actividades de {userName || 'Usuario'}
            </DialogTitle>
            <DialogDescription className="text-sm text-white/85">
              {routes.length} {routes.length === 1 ? 'actividad registrada' : 'actividades registradas'}
            </DialogDescription>
          </DialogHeader>
        </div>

        <ScrollArea className="max-h-[60vh]">
          <div className="p-3 space-y-2" style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom, 0px))' }}>
            {isLoading ? (
              <div className="text-center py-8 text-muted-foreground">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-3" />
                <p className="text-sm">Cargando actividades...</p>
              </div>
            ) : routes.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <MapPin className="h-12 w-12 mx-auto mb-3 opacity-40" />
                <p className="text-sm font-medium">Sin actividades</p>
                <p className="text-xs mt-1">Este usuario aun no tiene rutas registradas</p>
              </div>
            ) : (
              routes.map((route, index) => (
                <Card
                  key={route.id}
                  className="p-3 transition-all duration-200 hover:shadow-md hover:scale-[1.01] border-border/50 cursor-pointer group"
                  onClick={() => setSelectedRoute(route)}
                >
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0 transition-transform duration-200 group-hover:scale-110">
                      <MapPin className="h-5 w-5 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold text-sm truncate">{route.name}</h3>
                      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground mt-1">
                        <span className="flex items-center gap-1">
                          <div className="w-1 h-1 rounded-full bg-primary" />
                          {formatDistance(route.distance)}
                        </span>
                        <span>•</span>
                        <span>{formatDuration(route.duration)}</span>
                        <span>•</span>
                        <span>
                          {formatDistanceToNow(parseDate(route.completedAt), {
                            addSuffix: true,
                            locale: es,
                          })}
                        </span>
                      </div>
                      {route.territory && (
                        <Badge
                          variant="secondary"
                          className="gap-1 mt-1.5 text-xs bg-primary/10"
                        >
                          <TrendingUp className="h-3 w-3 text-primary" />
                          <span className="text-primary font-medium">
                            +{(route.territory.area / 1000000).toLocaleString('es-ES', {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })} km²
                          </span>
                        </Badge>
                      )}
                    </div>
                  </div>
                </Card>
              ))
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

// Mini route map with looping animation — same as in ActivityFeed
function MiniRouteMap({
  coordinates,
  activityName,
}: {
  coordinates: Array<[number, number]>;
  activityName: string;
}) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const polylineLayerRef = useRef<L.Polyline | null>(null);
  const animationRef = useRef<number | null>(null);
  const startMarkerRef = useRef<L.CircleMarker | null>(null);
  const endMarkerRef = useRef<L.CircleMarker | null>(null);
  const runnerMarkerRef = useRef<L.CircleMarker | null>(null);

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
      radius: 6,
      color: '#fff',
      fillColor: '#16a34a',
      fillOpacity: 1,
      weight: 2,
    }).addTo(map);

    polylineLayerRef.current = L.polyline([], {
      color: '#D4213D',
      weight: 3,
      opacity: 0.9,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(map);

    runnerMarkerRef.current = L.circleMarker(latlngs[0], {
      radius: 4,
      color: '#fff',
      fillColor: '#D4213D',
      fillOpacity: 1,
      weight: 2,
    }).addTo(map);

    setTimeout(() => {
      map.invalidateSize();
      map.fitBounds(bounds, { padding: [25, 25] });

      const ANIMATION_DURATION = 3000;
      const totalPoints = latlngs.length;

      const startCycle = () => {
        const startTime = performance.now();

        if (polylineLayerRef.current) polylineLayerRef.current.setLatLngs([]);
        if (endMarkerRef.current) {
          map.removeLayer(endMarkerRef.current);
          endMarkerRef.current = null;
        }
        if (!runnerMarkerRef.current) {
          runnerMarkerRef.current = L.circleMarker(latlngs[0], {
            radius: 4, color: '#fff', fillColor: '#D4213D', fillOpacity: 1, weight: 2,
          }).addTo(map);
        } else {
          runnerMarkerRef.current.setLatLng(latlngs[0]);
        }

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
            setTimeout(startCycle, 600);
          }
        };

        animationRef.current = requestAnimationFrame(animate);
      };

      startCycle();
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
