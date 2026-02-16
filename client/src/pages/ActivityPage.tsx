import { useState, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ActivityFeed } from '@/components/ActivityFeed';
import { SocialFeed } from '@/components/SocialFeed';
import { LoadingState } from '@/components/LoadingState';
import { LoginDialog } from '@/components/LoginDialog';
import { Button } from '@/components/ui/button';
import { User, RefreshCw } from 'lucide-react';
import { useSession } from '@/hooks/use-session';
import { queryClient } from '@/lib/queryClient';
import type { RouteWithTerritory } from '@shared/schema';

export default function ActivityPage() {
  const [isLoginOpen, setIsLoginOpen] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<'my' | 'feed'>('feed');
  const scrollRef = useRef<HTMLDivElement>(null);
  const touchStartY = useRef<number>(0);
  const pullToRefreshThreshold = 80;
  const { user: currentUser, isLoading: userLoading, login } = useSession();

  const { data: routes = [], isLoading } = useQuery<RouteWithTerritory[]>({
    queryKey: ['/api/routes', currentUser?.id],
    enabled: !!currentUser?.id,
  });

  if (userLoading) {
    return <LoadingState message="Cargando..." />;
  }

  if (!currentUser) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6">
        <div className="text-center space-y-4">
          <User className="h-20 w-20 mx-auto text-muted-foreground" />
          <h2 className="text-2xl font-bold">Inicia sesion</h2>
          <p className="text-muted-foreground">
            Inicia sesion para ver tu actividad
          </p>
          <Button onClick={() => setIsLoginOpen(true)} data-testid="button-login-activity">
            Iniciar sesion
          </Button>
        </div>
        <LoginDialog open={isLoginOpen} onOpenChange={setIsLoginOpen} onLogin={login} />
      </div>
    );
  }

  const handleRefresh = async () => {
    if (isRefreshing || !currentUser?.id) return;
    
    setIsRefreshing(true);
    try {
      if (activeTab === 'my') {
        await queryClient.invalidateQueries({ queryKey: ['/api/routes', currentUser.id] });
      } else {
        await queryClient.invalidateQueries({ queryKey: ['/api/feed'] });
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (scrollRef.current && scrollRef.current.scrollTop === 0) {
      touchStartY.current = e.touches[0].clientY;
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!scrollRef.current) return;
    
    const touchY = e.touches[0].clientY;
    const pullDistance = touchY - touchStartY.current;
    
    // Only prevent default when at top and pulling down
    if (scrollRef.current.scrollTop === 0 && pullDistance > 0) {
      e.preventDefault();
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (!scrollRef.current || scrollRef.current.scrollTop > 0) return;
    
    const touchY = e.changedTouches[0].clientY;
    const pullDistance = touchY - touchStartY.current;
    
    if (pullDistance > pullToRefreshThreshold) {
      handleRefresh();
    }
    
    touchStartY.current = 0;
  };

  return (
    <div 
      ref={scrollRef}
      className="h-full w-full overflow-y-auto"
      style={{ overscrollBehaviorY: 'none' }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {isRefreshing && (
        <div className="flex justify-center py-2 bg-primary/5">
          <div className="flex items-center gap-2 text-sm text-primary">
            <RefreshCw className="h-4 w-4 animate-spin" />
            Actualizando...
          </div>
        </div>
      )}

      {/* Subtabs */}
      <div
        className="flex border-b border-border/50 sticky top-0 bg-background z-10"
        style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
      >
        <button
          className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
            activeTab === 'feed'
              ? 'text-primary border-b-2 border-primary'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => setActiveTab('feed')}
        >
          Feed
        </button>
        <button
          className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
            activeTab === 'my'
              ? 'text-primary border-b-2 border-primary'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => setActiveTab('my')}
        >
          Mis Actividades
        </button>
      </div>

      {/* Content */}
      <div className="px-0">
        {activeTab === 'feed' ? (
          <div className="p-3">
            <SocialFeed />
          </div>
        ) : (
          isLoading ? (
            <LoadingState message="Cargando actividades..." />
          ) : (
            <ActivityFeed routes={routes} />
          )
        )}
      </div>
    </div>
  );
}
