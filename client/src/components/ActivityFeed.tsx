import { useEffect, useMemo, useRef, useState } from 'react';
import { Calendar, MapPin, TrendingUp, Flame, Users, Timer, Route, Trash2, Pencil, Check, X } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useMutation } from '@tanstack/react-query';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { useToast } from '@/hooks/use-toast';
import { useSession } from '@/hooks/use-session';
import type { RouteWithTerritory } from '@shared/schema';
import { formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

interface ActivityFeedProps {
  routes: RouteWithTerritory[];
}

// Helper to safely parse dates that might be timestamps as strings
function parseDate(value: string | number | Date): Date {
  if (value instanceof Date) return value;
  // Handle timestamps stored as strings (e.g., "1769690860000.0")
  const num = typeof value === 'string' ? parseFloat(value) : value;
  return new Date(num);
}

export function ActivityFeed({ routes }: ActivityFeedProps) {
  const [selectedRoute, setSelectedRoute] = useState<RouteWithTerritory | null>(null);
  const [routeToDelete, setRouteToDelete] = useState<RouteWithTerritory | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renamingValue, setRenamingValue] = useState('');
  const { toast } = useToast();
  const { user: currentUser } = useSession();

  const renameRouteMutation = useMutation({
    mutationFn: async ({ routeId, name }: { routeId: string; name: string }) => {
      if (!currentUser) throw new Error('No user');
      return await apiRequest('PATCH', `/api/routes/${routeId}/name`, { userId: currentUser.id, name });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/routes'] });
      setIsRenaming(false);
      toast({ title: '✅ Nombre actualizado' });
    },
    onError: (error: Error) => {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    },
  });

  const deleteRouteMutation = useMutation({
    mutationFn: async (routeId: string) => {
      if (!currentUser) throw new Error('No user');
      return await apiRequest('DELETE', `/api/routes/${routeId}`, { userId: currentUser.id });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/routes'] });
      queryClient.invalidateQueries({ queryKey: ['/api/territories'] });
      queryClient.invalidateQueries({ queryKey: ['/api/current-user'] });
      queryClient.invalidateQueries({ queryKey: ['/api/leaderboard'] });
      // Also invalidate Polar/Strava activity lists so they reflect the deleted link
      if (currentUser?.id) {
        queryClient.invalidateQueries({ queryKey: [`/api/polar/activities/${currentUser.id}`] });
        queryClient.invalidateQueries({ queryKey: [`/api/strava/activities/${currentUser.id}`] });
      }
      setRouteToDelete(null);
      setSelectedRoute(null);
      toast({ title: '✅ Actividad eliminada', description: 'La actividad y su territorio han sido eliminados. Puedes reimportarla desde Polar/Strava.' });
    },
    onError: (error: Error) => {
      toast({ title: 'Error', description: error.message || 'No se pudo eliminar', variant: 'destructive' });
    },
  });

  const formatDistance = (meters: number) => {
    if (meters < 1000) return `${meters.toFixed(0)} m`;
    return `${(meters / 1000).toFixed(2)} km`;
  };

  const formatDuration = (seconds: number) => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    
    if (hrs > 0) return `${hrs}h ${mins}m`;
    return `${mins}m`;
  };

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

  return (
    <div className="flex flex-col h-full animate-fade-in">
      {/* Header */}
      <div 
        className="p-4 border-b border-border/50 bg-gradient-to-r from-primary/5 via-transparent to-orange-500/5 animate-slide-down"
        style={{ paddingTop: 'calc(1rem + env(safe-area-inset-top, 0px))' }}
      >
        <div className="flex items-center gap-3">
          <div className="relative p-2 rounded-xl bg-primary/10">
            <Calendar className="h-6 w-6 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold">Actividad</h1>
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Flame className="h-3 w-3 text-orange-500" />
              Tu historial de rutas
            </p>
          </div>
        </div>
      </div>

      {/* Activity List */}
      <ScrollArea className="flex-1">
        <div className="p-4 pb-24 space-y-3">
          {routes.length === 0 ? (
            <div className="text-center py-12 animate-scale-in">
              <div className="relative inline-block mb-4">
                <MapPin className="h-20 w-20 mx-auto text-muted-foreground" />
                <div className="absolute inset-0 bg-muted-foreground/10 blur-2xl" />
              </div>
              <h3 className="text-lg font-semibold mb-2">No hay actividades</h3>
              <p className="text-muted-foreground">
                Inicia tu primera ruta para empezar a conquistar territorio
              </p>
            </div>
          ) : (
            routes.map((route, index) => (
              <Card
                key={route.id}
                className="p-4 hover-elevate transition-all duration-300 hover:scale-[1.01] hover:shadow-lg animate-slide-up border-card-border group cursor-pointer"
                style={{
                  animationDelay: `${index * 50}ms`,
                }}
                data-testid={`activity-card-${route.id}`}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedRoute(route)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelectedRoute(route);
                  }
                }}
              >
                <div className="flex items-start gap-3">
                  <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0 transition-all duration-300 group-hover:scale-110 group-hover:rotate-6">
                    <MapPin className="h-6 w-6 text-primary" />
                  </div>

                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold mb-2 text-lg">{route.name}</h3>

                    <div className="flex flex-wrap gap-3 text-sm text-muted-foreground mb-3">
                      <span className="flex items-center gap-1">
                        <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
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
                        className="gap-1.5 animate-bounce-in bg-primary/10 hover:bg-primary/20 transition-colors duration-300"
                      >
                        <TrendingUp className="h-3 w-3 text-primary" />
                        <span className="text-primary font-medium">
                          +{(route.territory.area / 1000000).toLocaleString('es-ES', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })} km² conquistados
                        </span>
                      </Badge>
                    )}

                    {route.ranTogetherWithUsers && route.ranTogetherWithUsers.length > 0 && (
                      <div className="mt-2">
                        <Badge
                          variant="outline"
                          className="gap-1.5 bg-green-500/10 border-green-500/30 text-green-700 dark:text-green-400"
                        >
                          <Users className="h-3 w-3" />
                          <span className="font-medium">
                            🏃‍♂️ Corriste junto a {route.ranTogetherWithUsers.map((u) => u.name).join(', ')}, ¡mantenéis vuestros km!
                          </span>
                        </Badge>
                      </div>
                    )}
                  </div>
                </div>
              </Card>
            ))
          )}
        </div>
      </ScrollArea>

      <Dialog open={!!selectedRoute} onOpenChange={(open) => { if (!open) { setSelectedRoute(null); setIsRenaming(false); } }}>
        <DialogContent className="w-[calc(100%-1rem)] max-w-sm mx-auto gap-0 overflow-hidden rounded-2xl border-0 shadow-2xl [&>button]:text-white [&>button]:hover:text-white/80 [&>button]:z-10" style={{ padding: '0', paddingTop: '0', paddingBottom: '0' }}>
          <div className="relative bg-gradient-to-br from-emerald-500 via-green-500 to-teal-600 px-4 py-4 text-white">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.15),transparent_70%)]" />
            <DialogHeader className="space-y-1 relative">
              <DialogTitle className="flex items-center gap-2.5 text-lg font-bold text-white">
                <div className="bg-white/20 backdrop-blur-sm rounded-lg p-1.5">
                  <Route className="h-5 w-5" />
                </div>
                Detalle de actividad
              </DialogTitle>
              <DialogDescription asChild>
                <div className="text-sm text-white/85">
                  {isRenaming ? (
                    <div className="flex items-center gap-1.5 mt-1">
                      <Input
                        value={renamingValue}
                        onChange={(e) => setRenamingValue(e.target.value)}
                        className="h-7 text-sm bg-white/20 border-white/30 text-white placeholder:text-white/50 focus-visible:ring-white/40"
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && renamingValue.trim() && selectedRoute) {
                            renameRouteMutation.mutate({ routeId: selectedRoute.id, name: renamingValue.trim() });
                          }
                          if (e.key === 'Escape') setIsRenaming(false);
                        }}
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-white hover:bg-white/20 shrink-0"
                        onClick={() => {
                          if (renamingValue.trim() && selectedRoute) {
                            renameRouteMutation.mutate({ routeId: selectedRoute.id, name: renamingValue.trim() });
                          }
                        }}
                        disabled={renameRouteMutation.isPending}
                      >
                        <Check className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-white hover:bg-white/20 shrink-0"
                        onClick={() => setIsRenaming(false)}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ) : (
                    <span
                      className="inline-flex items-center gap-1.5 cursor-pointer hover:text-white transition-colors"
                      onClick={() => {
                        setRenamingValue(selectedRoute?.name || '');
                        setIsRenaming(true);
                      }}
                    >
                      {selectedRoute?.name || 'Ruta'}
                      <Pencil className="h-3 w-3 opacity-60" />
                    </span>
                  )}
                </div>
              </DialogDescription>
            </DialogHeader>
          </div>

          <div className="space-y-2 p-3" style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom, 0px))' }}>
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="secondary" className="gap-1">
                <MapPin className="h-3 w-3" />
                {selectedRoute ? formatDistance(selectedRoute.distance) : ''}
              </Badge>
              <Badge variant="secondary" className="gap-1">
                <Timer className="h-3 w-3" />
                {selectedRoute ? formatDuration(selectedRoute.duration) : ''}
              </Badge>
              <Badge variant="secondary" className="gap-1">
                <Calendar className="h-3 w-3" />
                {selectedDate}
              </Badge>
            </div>

            <MiniRouteMap coordinates={selectedCoordinates} activityName={selectedRoute?.name || ''} />

            {selectedRoute?.territory && (
              <div className="text-center py-1 bg-primary/10 rounded-lg">
                <Badge className="bg-primary text-white">
                  +{(selectedRoute.territory.area / 1000000).toLocaleString('es-ES', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })} km² conquistados
                </Badge>
              </div>
            )}

            <Button
              variant="destructive"
              size="sm"
              className="w-full mt-1"
              onClick={() => setRouteToDelete(selectedRoute)}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Eliminar actividad
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!routeToDelete} onOpenChange={() => setRouteToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar actividad?</AlertDialogTitle>
            <AlertDialogDescription>
              Se eliminará la actividad "{routeToDelete?.name}" y el territorio conquistado asociado. Esta acción no se puede deshacer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => routeToDelete && deleteRouteMutation.mutate(routeToDelete.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteRouteMutation.isPending ? 'Eliminando...' : 'Eliminar'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

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

        if (polylineLayerRef.current) {
          polylineLayerRef.current.setLatLngs([]);
        }
        if (endMarkerRef.current) {
          map.removeLayer(endMarkerRef.current);
          endMarkerRef.current = null;
        }
        if (!runnerMarkerRef.current) {
          runnerMarkerRef.current = L.circleMarker(latlngs[0], {
            radius: 4,
            color: '#fff',
            fillColor: '#D4213D',
            fillOpacity: 1,
            weight: 2,
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

          if (polylineLayerRef.current) {
            polylineLayerRef.current.setLatLngs(currentPoints);
          }

          if (runnerMarkerRef.current && currentPoints.length > 0) {
            runnerMarkerRef.current.setLatLng(currentPoints[currentPoints.length - 1]);
          }

          if (progress < 1) {
            animationRef.current = requestAnimationFrame(animate);
          } else {
            endMarkerRef.current = L.circleMarker(latlngs[latlngs.length - 1], {
              radius: 6,
              color: '#fff',
              fillColor: '#dc2626',
              fillOpacity: 1,
              weight: 2,
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
