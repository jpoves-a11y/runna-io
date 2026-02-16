import { useState, useEffect, useRef } from 'react';
import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BottomNav } from "@/components/BottomNav";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { EphemeralPhotoViewer } from "@/components/EphemeralPhotoViewer";
import { OnboardingTutorial, shouldShowOnboarding } from "@/components/OnboardingTutorial";
import { useSession } from "@/hooks/use-session";
import { Play } from "lucide-react";

function EphemeralPhotoWrapper() {
  const { user } = useSession();
  if (!user) return null;
  return <EphemeralPhotoViewer userId={user.id} />;
}

// Log app initialization
console.log('App.tsx loading...');
console.log('API_BASE:', import.meta.env.VITE_API_BASE_URL || (import.meta.env.PROD ? 'https://runna-io-api.runna-io-api.workers.dev' : ''));
import MapPage from "@/pages/MapPage";
import RankingsPage from "@/pages/RankingsPage";
import ActivityPage from "@/pages/ActivityPage";
import ProfilePage from "@/pages/ProfilePage";
import FriendsPage from "@/pages/FriendsPage";
import AcceptFriendInvitePage from "@/pages/AcceptFriendInvitePage";
import PrivacyPage from "@/pages/PrivacyPage";
import TermsPage from "@/pages/TermsPage";
import NotFound from "@/pages/not-found";

function Router() {
  return (
    <div className="w-full h-full">
      <Switch>
        <Route path="/" component={MapPage} />
        <Route path="/rankings" component={RankingsPage} />
        <Route path="/activity" component={ActivityPage} />
        <Route path="/profile" component={ProfilePage} />
        <Route path="/friends" component={FriendsPage} />
        <Route path="/friends/accept/:token" component={AcceptFriendInvitePage} />
        <Route path="/privacy" component={PrivacyPage} />
        <Route path="/terms" component={TermsPage} />
        <Route component={NotFound} />
      </Switch>
    </div>
  );
}

function StartActivityButton() {
  const [location] = useLocation();
  const [showButton, setShowButton] = useState(() => {
    return (location === '/' || location.startsWith('/?')) && !window.location.search.includes('tracking=true');
  });
  
  useEffect(() => {
    const checkVisibility = () => {
      const isMapPage = window.location.pathname === '/';
      const isTracking = window.location.search.includes('tracking=true');
      const isAnimating = window.location.search.includes('animateLatestActivity=true');
      setShowButton(isMapPage && !isTracking && !isAnimating);
    };
    window.addEventListener('popstate', checkVisibility);
    checkVisibility();
    return () => window.removeEventListener('popstate', checkVisibility);
  }, [location]);

  const handleStartTracking = () => {
    window.history.pushState({}, '', '/?tracking=true');
    window.dispatchEvent(new PopStateEvent('popstate'));
  };
  
  if (!showButton) return null;
  
  return (
    <button
      className="play-button-pwa fixed z-[9999] flex items-center justify-center shadow-2xl transition-all duration-300 active:scale-95"
      style={{
        bottom: 'calc(5rem + env(safe-area-inset-bottom, 0px) + 12px)',
        left: '50%',
        transform: 'translateX(-50%)',
        width: '60px',
        height: '60px',
        borderRadius: '50%',
        background: 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)',
        border: '3px solid rgba(255,255,255,0.3)',
      }}
      onClick={handleStartTracking}
      data-testid="button-start-run"
    >
      <Play className="h-7 w-7 text-white ml-0.5" fill="white" />
    </button>
  );
}

function OnboardingWrapper() {
  const [showOnboarding, setShowOnboarding] = useState(false);
  const { user: appUser } = useSession();

  useEffect(() => {
    if (appUser && shouldShowOnboarding()) {
      setShowOnboarding(true);
    }
  }, [appUser]);

  if (!showOnboarding) return null;
  return (
    <OnboardingTutorial
      userId={appUser?.id}
      onComplete={() => setShowOnboarding(false)}
    />
  );
}

function App() {
  const [location, setLocation] = useLocation();
  const touchStartX = useRef(0);
  const touchStartY = useRef(0);
  const isSwiping = useRef(false);
  const isPulling = useRef(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const mainRef = useRef<HTMLElement | null>(null);

  // Match the order used in BottomNav
  const tabs = ['/', '/rankings', '/activity', '/friends', '/profile'];

  const handleTouchStart = (e: React.TouchEvent) => {
    // Don't handle touch events on map page - let map handle them directly
    const currentPath = (location || '/').split('?')[0];
    const isMapPage = currentPath === '' || currentPath === '/';
    if (isMapPage) return;

    const t = e.touches[0];
    touchStartX.current = t.clientX;
    touchStartY.current = t.clientY;
    isSwiping.current = false;
    isPulling.current = false;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    // Don't handle touch events on map page - let map handle them directly
    const currentPath = (location || '/').split('?')[0];
    const isMapPage = currentPath === '' || currentPath === '/';
    if (isMapPage) return;

    const t = e.touches[0];
    const dx = t.clientX - touchStartX.current;
    const dy = t.clientY - touchStartY.current;

    if (!isSwiping.current && Math.abs(dx) > 20 && Math.abs(dx) > Math.abs(dy)) {
      isSwiping.current = true;
    }

    const atTop = window.scrollY === 0;
    if (!isPulling.current && dy > 30 && Math.abs(dy) > Math.abs(dx) && atTop) {
      isPulling.current = true;
    }

    if (isSwiping.current) {
      e.preventDefault();
    }
  };

  const doRefresh = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      await queryClient.invalidateQueries();
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      setIsRefreshing(false);
    }
  };
  // Animation state for lateral transitions
  const [isAnimating, setIsAnimating] = useState(false);
  const [animDirection, setAnimDirection] = useState<'left' | 'right'>('left');

  const animateAndNavigate = (to: string, direction: 'left' | 'right') => {
    if (isAnimating) return;
    setAnimDirection(direction);
    setIsAnimating(true);
    // exit animation
    setTimeout(() => {
      setLocation(to);
      // small delay to allow route render, then clear animating to show enter state
      setTimeout(() => setIsAnimating(false), 220);
    }, 160);
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    // Don't handle touch events on map page - let map handle them directly
    const currentPath = (location || '/').split('?')[0];
    const isMapPage = currentPath === '' || currentPath === '/';
    if (isMapPage) return;

    const touch = e.changedTouches[0];
    const dx = touch.clientX - touchStartX.current;
    const dy = touch.clientY - touchStartY.current;

    if (isPulling.current && dy > 80) {
      doRefresh();
      return;
    }

    if (isSwiping.current && Math.abs(dx) > 80 && Math.abs(dx) > Math.abs(dy)) {
      const currentIndex = tabs.indexOf(isMapPage ? '/' : currentPath);
      if (dx > 0) {
        const prev = tabs[Math.max(0, currentIndex - 1)];
        if (prev && prev !== location) animateAndNavigate(prev, 'right');
      } else {
        const next = tabs[Math.min(tabs.length - 1, currentIndex + 1)];
        if (next && next !== location) animateAndNavigate(next, 'left');
      }
    }
  };

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <div className="fixed inset-0 flex flex-col bg-background">
            <main
              ref={(el) => (mainRef.current = el)}
              className={`main-content-pwa flex-1 relative overflow-hidden ${isAnimating ? (animDirection === 'left' ? 'page-exit-left' : 'page-exit-right') : 'page-enter'}`}
              style={{ paddingBottom: 'calc(3.5rem + env(safe-area-inset-bottom, 0px))' }}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
            >
              {isRefreshing && (
                <div
                  className="absolute inset-x-0 top-0 flex items-center justify-center z-50 bg-background/80 backdrop-blur-sm"
                  style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 0.5rem)', paddingBottom: '0.5rem' }}
                >
                  <div className="h-8 w-8 rounded-full border-[3px] border-muted-foreground/20 border-t-primary animate-spin" />
                </div>
              )}
              <Router />
            </main>
            <BottomNav />
          </div>
          <StartActivityButton />
          <EphemeralPhotoWrapper />
          <OnboardingWrapper />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
