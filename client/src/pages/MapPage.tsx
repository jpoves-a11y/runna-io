import { useState, useEffect } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { MapView } from '@/components/MapView';
import UserInfoDialog from '@/components/UserInfoDialog';
import { StatsOverlay } from '@/components/StatsOverlay';
import { RouteTracker } from '@/components/RouteTracker';
import { LoginDialog } from '@/components/LoginDialog';
import { MapSkeleton } from '@/components/LoadingState';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Users } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useSession } from '@/hooks/use-session';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { getCurrentPosition, DEFAULT_CENTER } from '@/lib/geolocation';
import type { TerritoryWithUser, RouteWithTerritory } from '@shared/schema';

export default function MapPage() {
  const [, setLocation] = useLocation();
  const [isTracking, setIsTracking] = useState(() => {
    return window.location.search.includes('tracking=true');
  });
  const [isLoginOpen, setIsLoginOpen] = useState(false);
  const [friendsOnly, setFriendsOnly] = useState(false);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [isLoadingLocation, setIsLoadingLocation] = useState(true);
  const { toast } = useToast();
  const { user: currentUser, isLoading: userLoading, login } = useSession();
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  useEffect(() => {
    const checkTracking = () => {
      setIsTracking(window.location.search.includes('tracking=true'));
    };
    window.addEventListener('popstate', checkTracking);
    return () => window.removeEventListener('popstate', checkTracking);
  }, []);

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

  const { data: allTerritories = [], isLoading: isLoadingAllTerritories } = useQuery<TerritoryWithUser[]>({
    queryKey: ['/api/territories'],
    enabled: !friendsOnly,
  });

  const { data: friendTerritories = [], isLoading: isLoadingFriendTerritories } = useQuery<TerritoryWithUser[]>({
    queryKey: ['/api/territories/friends', currentUser?.id],
    enabled: friendsOnly && !!currentUser?.id,
  });

  // Fetch routes for the current user to display route traces
  const { data: userRoutes = [] } = useQuery<RouteWithTerritory[]>({
    queryKey: ['/api/routes', currentUser?.id],
    enabled: !!currentUser?.id,
  });

  const territories = friendsOnly ? friendTerritories : allTerritories;
  const territoriesLoading = friendsOnly ? isLoadingFriendTerritories : isLoadingAllTerritories;

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

      setLocation('/');
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

  const handleCancelTracking = () => {
    window.history.pushState({}, '', '/');
    setIsTracking(false);
    window.dispatchEvent(new PopStateEvent('popstate'));
  };

  if (isTracking) {
    return (
      <RouteTracker
        onComplete={handleRouteComplete}
        onCancel={handleCancelTracking}
      />
    );
  }

  if (territoriesLoading || userLoading || isLoadingLocation) {
    return <MapSkeleton />;
  }

  return (
    <div className="relative w-full h-full animate-fade-in">
      <MapView 
        territories={territories} 
        routes={userRoutes}
        center={userLocation || DEFAULT_CENTER}
        onTerritoryClick={(id) => { setSelectedUserId(id); setIsDialogOpen(true); }}
      />
      
      {currentUser && (
        <>
          <div className="animate-slide-down">
            <StatsOverlay user={currentUser} />
          </div>
          
          <Card className="absolute bottom-4 left-4 p-3 shadow-lg backdrop-blur-sm bg-card/95 border-border animate-slide-right z-[999]">
            <div className="flex items-center gap-2">
              <Switch
                id="map-friends-toggle"
                checked={friendsOnly}
                onCheckedChange={setFriendsOnly}
                data-testid="switch-map-friends-only"
              />
              <Label
                htmlFor="map-friends-toggle"
                className="flex items-center gap-2 cursor-pointer text-sm font-medium whitespace-nowrap"
              >
                <Users className="h-4 w-4" />
                {friendsOnly ? 'Amigos' : 'Todos'}
              </Label>
            </div>
          </Card>
        </>
      )}
      <UserInfoDialog userId={selectedUserId} open={isDialogOpen} onOpenChange={(open) => { if (!open) setSelectedUserId(null); setIsDialogOpen(open); }} />
    </div>
  );
}
