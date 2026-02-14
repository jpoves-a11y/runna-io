import { useState, useEffect } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { MapView } from '@/components/MapView';
import UserInfoDialog from '@/components/UserInfoDialog';
import { StatsOverlay } from '@/components/StatsOverlay';
import { RouteTracker } from '@/components/RouteTracker';
import { LoginDialog } from '@/components/LoginDialog';
import { MapSkeleton } from '@/components/LoadingState';
import { ActivityAnimationView } from '@/components/ActivityAnimationView';
import { ConquestResultModal } from '@/components/ConquestResultModal';
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
  const [isAnimating, setIsAnimating] = useState(false);
  const [conquestResult, setConquestResult] = useState<any>(null);
  const [conquestData, setConquestData] = useState<any>(null);
  const [isResultModalOpen, setIsResultModalOpen] = useState(false);
  const [isLoginOpen, setIsLoginOpen] = useState(false);
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
    const checkAnimation = () => {
      const animating = window.location.search.includes('animateLatestActivity=true');
      setIsAnimating(animating);
      if (animating) {
        // Read conquest data from sessionStorage (saved by ProfilePage)
        try {
          const stored = sessionStorage.getItem('lastConquestResult');
          if (stored) {
            setConquestData(JSON.parse(stored));
            sessionStorage.removeItem('lastConquestResult');
          }
        } catch (e) {
          console.error('Error reading conquest data:', e);
        }
      }
    };
    // Run on mount too
    checkAnimation();
    window.addEventListener('popstate', checkAnimation);
    return () => window.removeEventListener('popstate', checkAnimation);
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

  // Solo cargar territorios de amigos
  const { data: territories = [], isLoading: territoriesLoading } = useQuery<TerritoryWithUser[]>({
    queryKey: ['/api/territories/friends', currentUser?.id],
    enabled: !!currentUser?.id,
  });

  // Fetch routes for the current user to display route traces
  const { data: userRoutes = [] } = useQuery<RouteWithTerritory[]>({
    queryKey: ['/api/routes', currentUser?.id],
    enabled: !!currentUser?.id,
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

  if (isAnimating && conquestData?.summaryPolyline) {
    return (
      <div className="w-full h-full flex flex-col">
        <ActivityAnimationView
          summaryPolyline={conquestData.summaryPolyline}
          distance={conquestData.distance || 0}
          userColor={currentUser?.color || '#D4213D'}
          territoryArea={conquestData?.territoryArea || 0}
          onClose={() => {
            window.history.replaceState({}, '', '/');
            setIsAnimating(false);
            setConquestData(null);
          }}
          onComplete={() => {
            // Use real conquest data from the process API
            const newArea = (conquestData?.newAreaConquered || 0) / 1000000;
            const totalArea = (conquestData?.totalArea || currentUser?.totalArea || 0) / 1000000;
            const previousArea = totalArea - newArea;
            
            setConquestResult({
              newArea,
              previousArea: Math.max(0, previousArea),
              victims: []
            });
            setIsResultModalOpen(true);
          }}
          animationDuration={7000}
        />
      </div>
    );
  }

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
        <div className="animate-slide-down">
          <StatsOverlay user={currentUser} />
        </div>
      )}
      <UserInfoDialog userId={selectedUserId} currentUserId={currentUser?.id} open={isDialogOpen} onOpenChange={(open) => { if (!open) setSelectedUserId(null); setIsDialogOpen(open); }} />
      <ConquestResultModal
        open={isResultModalOpen}
        onOpenChange={(open) => {
          if (!open) {
            // Reset animation state and go back to normal map view
            window.history.replaceState({}, '', '/');
            setIsAnimating(false);
            setConquestResult(null);
            setConquestData(null);
          }
          setIsResultModalOpen(open);
        }}
        newAreaKm2={conquestResult?.newArea || 0}
        previousAreaKm2={conquestResult?.previousArea || 0}
        victims={conquestResult?.victims || []}
      />
    </div>
  );
}
