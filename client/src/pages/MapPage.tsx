import { useState, useEffect } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Plus, Zap, User } from 'lucide-react';
import { MapView } from '@/components/MapView';
import { StatsOverlay } from '@/components/StatsOverlay';
import { RouteTracker } from '@/components/RouteTracker';
import { LoginDialog } from '@/components/LoginDialog';
import { MapSkeleton } from '@/components/LoadingState';
import { useToast } from '@/hooks/use-toast';
import { useSession } from '@/hooks/use-session';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { getCurrentPosition, DEFAULT_CENTER } from '@/lib/geolocation';
import type { TerritoryWithUser } from '@shared/schema';

export default function MapPage() {
  const [isTracking, setIsTracking] = useState(false);
  const [isLoginOpen, setIsLoginOpen] = useState(false);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [isLoadingLocation, setIsLoadingLocation] = useState(true);
  const { toast } = useToast();
  const { user: currentUser, isLoading: userLoading, login } = useSession();

  useEffect(() => {
    getCurrentPosition()
      .then((coords) => {
        setUserLocation(coords);
      })
      .catch((error) => {
        console.log('Could not get user location, using default:', error);
        setUserLocation(DEFAULT_CENTER);
      })
      .finally(() => {
        setIsLoadingLocation(false);
      });
  }, []);

  const { data: territories = [], isLoading: territoriesLoading } = useQuery<TerritoryWithUser[]>({
    queryKey: ['/api/territories'],
  });

  const createRouteMutation = useMutation({
    mutationFn: async (routeData: {
      coordinates: Array<[number, number]>;
      distance: number;
      duration: number;
    }) => {
      if (!currentUser) throw new Error('No current user');

      const response = await apiRequest('POST', '/api/routes', {
        userId: currentUser.id,
        name: `Ruta ${new Date().toLocaleDateString('es-ES')}`,
        coordinates: routeData.coordinates,
        distance: routeData.distance,
        duration: routeData.duration,
        startedAt: new Date(Date.now() - routeData.duration * 1000).toISOString(),
        completedAt: new Date().toISOString(),
      });

      return response;
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['/api/territories'] });
      queryClient.invalidateQueries({ queryKey: ['/api/current-user'] });
      queryClient.invalidateQueries({ queryKey: ['/api/routes', currentUser?.id] });
      queryClient.invalidateQueries({ queryKey: ['/api/leaderboard'] });

      if (data.territory) {
        toast({
          title: '🎉 ¡Territorio conquistado!',
          description: `Has conquistado ${(data.territory.area / 1000000).toLocaleString('es-ES', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })} km² de territorio`,
          duration: 5000,
          className: 'animate-bounce-in',
        });
      } else {
        toast({
          title: '✅ Ruta guardada',
          description: 'Tu ruta ha sido guardada exitosamente',
        });
      }

      setIsTracking(false);
    },
    onError: (error: Error) => {
      toast({
        title: 'Error',
        description: error.message || 'No se pudo guardar la ruta',
        variant: 'destructive',
      });
    },
  });

  const handleRouteComplete = async (routeData: {
    coordinates: Array<[number, number]>;
    distance: number;
    duration: number;
  }) => {
    createRouteMutation.mutate(routeData);
  };

  if (isTracking) {
    return (
      <div className="animate-fade-in">
        <RouteTracker
          onComplete={handleRouteComplete}
          onCancel={() => setIsTracking(false)}
        />
      </div>
    );
  }

  if (territoriesLoading || userLoading || isLoadingLocation) {
    return <MapSkeleton />;
  }

  return (
    <div className="relative w-full h-full animate-fade-in">
      <MapView territories={territories} center={userLocation || DEFAULT_CENTER} />
      
      {currentUser && (
        <div className="animate-slide-down">
          <StatsOverlay user={currentUser} />
        </div>
      )}
      
      <Button
        size="lg"
        className="absolute bottom-24 right-4 h-16 w-16 rounded-full shadow-2xl z-[1000] gradient-primary border-0 hover:scale-110 active:scale-95 transition-all duration-300 group animate-scale-in"
        onClick={() => setIsTracking(true)}
        data-testid="button-start-run"
      >
        <div className="relative">
          <Plus className="h-8 w-8 text-white transition-transform duration-300 group-hover:rotate-90" />
          <Zap className="h-4 w-4 text-white absolute -top-1 -right-1 animate-pulse" />
          <div className="absolute inset-0 bg-white/20 rounded-full blur-xl animate-pulse" />
        </div>
      </Button>
    </div>
  );
}
