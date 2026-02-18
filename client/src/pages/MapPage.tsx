import { useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { MapView } from '@/components/MapView';
import UserInfoDialog from '@/components/UserInfoDialog';
import { StatsOverlay } from '@/components/StatsOverlay';
import { FriendFilterBar } from '@/components/FriendFilterBar';
import { RouteTracker } from '@/components/RouteTracker';
import { LoginDialog } from '@/components/LoginDialog';
import { MapSkeleton } from '@/components/LoadingState';
import { ActivityAnimationView } from '@/components/ActivityAnimationView';
import { ConquestResultModal } from '@/components/ConquestResultModal';

import { useToast } from '@/hooks/use-toast';
import { useSession } from '@/hooks/use-session';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { getCurrentPosition, DEFAULT_CENTER } from '@/lib/geolocation';
import type { TerritoryWithUser, RouteWithTerritory, UserWithStats } from '@shared/schema';

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
      const showResult = window.location.search.includes('showConquestResult=true');
      setIsAnimating(animating);
      if (animating || showResult) {
        // Read conquest data from sessionStorage (saved by ProfilePage)
        try {
          const stored = sessionStorage.getItem('lastConquestResult');
          if (stored) {
            const parsed = JSON.parse(stored);
            setConquestData(parsed);
            if (!animating) {
              const newArea = (parsed?.newAreaConquered || 0) / 1000000;
              const totalArea = (parsed?.totalArea || 0) / 1000000;
              const previousArea = totalArea - newArea;
              setConquestResult({
                newArea,
                previousArea: Math.max(0, previousArea),
                victims: parsed?.victims || [],
              });
              setIsResultModalOpen(true);
            }
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

  // Get user location in parallel, don't block rendering
  useEffect(() => {
    // Use Promise.allSettled to not fail if geolocation is denied
    Promise.allSettled([getCurrentPosition()])
      .then((results) => {
        if (results[0].status === 'fulfilled') {
          setUserLocation(results[0].value);
        } else {
          console.log('Could not get user location, using default');
          setUserLocation(DEFAULT_CENTER);
        }
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

  // Fetch friends list for the filter bar
  const { data: friends = [] } = useQuery<UserWithStats[]>({
    queryKey: ['/api/friends', currentUser?.id],
    enabled: !!currentUser?.id,
  });

  // Friend filter state - null means all visible (initialized once friends load)
  const [visibleUserIds, setVisibleUserIds] = useState<Set<string> | null>(null);

  // Initialize visible users when friends or currentUser load
  useEffect(() => {
    if (currentUser && friends.length > 0 && !visibleUserIds) {
      const allIds = new Set([currentUser.id, ...friends.map(f => f.id)]);
      setVisibleUserIds(allIds);
    }
  }, [currentUser, friends]);

  const handleToggleUser = useCallback((userId: string) => {
    setVisibleUserIds(prev => {
      if (!prev) return prev;
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
      return next;
    });
  }, []);

  const handleShowAll = useCallback(() => {
    if (!currentUser) return;
    setVisibleUserIds(new Set([currentUser.id, ...friends.map(f => f.id)]));
  }, [currentUser, friends]);

  const handleHideAll = useCallback(() => {
    setVisibleUserIds(new Set());
  }, []);

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
        coordinates: JSON.stringify(routeData.coordinates),
        distance: routeData.distance,
        duration: routeData.duration,
        startedAt: new Date(Date.now() - routeData.duration * 1000).toISOString(),
        completedAt: new Date().toISOString(),
      });

      const data = await response.json();
      return { ...data, inputDistance: routeData.distance, inputDuration: routeData.duration };
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['/api/territories'] });
      queryClient.invalidateQueries({ queryKey: ['/api/territories/friends', currentUser?.id] });
      queryClient.invalidateQueries({ queryKey: ['/api/current-user'] });
      queryClient.invalidateQueries({ queryKey: ['/api/routes', currentUser?.id] });
      queryClient.invalidateQueries({ queryKey: ['/api/leaderboard'] });

      // Stop tracking mode
      setIsTracking(false);

      // Store conquest data in sessionStorage and trigger animation (same as Polar flow)
      const conquestPayload = {
        newAreaConquered: data.metrics?.newAreaConquered || 0,
        totalArea: data.metrics?.totalArea || 0,
        areaStolen: data.metrics?.areaStolen || 0,
        routeId: data.route?.id,
        routeName: data.route?.name || `Ruta ${new Date().toLocaleDateString('es-ES')}`,
        territoryArea: data.territory?.area || 0,
        summaryPolyline: data.summaryPolyline || null,
        distance: data.inputDistance || 0,
        victims: data.metrics?.victims || [],
      };
      sessionStorage.setItem('lastConquestResult', JSON.stringify(conquestPayload));

      if (conquestPayload.summaryPolyline) {
        window.history.replaceState({}, '', '/?animateLatestActivity=true');
        setConquestData(conquestPayload);
        setIsAnimating(true);
      } else {
        // No polyline — skip animation, go directly to conquest result modal
        const newArea = conquestPayload.newAreaConquered / 1000000;
        const totalArea = conquestPayload.totalArea / 1000000;
        setConquestData(conquestPayload);
        setConquestResult({ newArea, previousArea: Math.max(0, totalArea - newArea), victims: conquestPayload.victims });
        window.history.replaceState({}, '', '/?showConquestResult=true');
        setIsResultModalOpen(true);
      }
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
              victims: conquestData?.victims || []
            });
            // Stop animation view so the normal map renders with ConquestResultModal
            window.history.replaceState({}, '', '/');
            setIsAnimating(false);
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

  // Show map immediately with loading states for data
  // Only show skeleton if user session is still loading
  if (userLoading) {
    return <MapSkeleton />;
  }

  return (
    <div className="relative w-full h-full animate-fade-in">
      <MapView 
        territories={territories} 
        routes={userRoutes}
        center={userLocation || DEFAULT_CENTER}
        onTerritoryClick={(id) => { setSelectedUserId(id); setIsDialogOpen(true); }}
        isLoadingTerritories={territoriesLoading}
        visibleUserIds={visibleUserIds}
      />
      
      {currentUser && (
        <div className="animate-slide-down">
          <StatsOverlay user={currentUser} />
        </div>
      )}

      {currentUser && friends.length > 0 && visibleUserIds && (
        <FriendFilterBar
          currentUser={currentUser}
          friends={friends}
          visibleUserIds={visibleUserIds}
          onToggleUser={handleToggleUser}
          onShowAll={handleShowAll}
          onHideAll={handleHideAll}
        />
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
        senderId={currentUser?.id}
        routeId={conquestData?.routeId}
        routeName={conquestData?.routeName}
      />

    </div>
  );
}
