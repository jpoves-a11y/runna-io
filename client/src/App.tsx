import { useState, useEffect } from 'react';
import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BottomNav } from "@/components/BottomNav";
import { Play } from "lucide-react";
import MapPage from "@/pages/MapPage";
import RankingsPage from "@/pages/RankingsPage";
import ActivityPage from "@/pages/ActivityPage";
import ProfilePage from "@/pages/ProfilePage";
import FriendsPage from "@/pages/FriendsPage";
import NotFound from "@/pages/not-found";

function Router() {
  return (
    <Switch>
      <Route path="/" component={MapPage} />
      <Route path="/rankings" component={RankingsPage} />
      <Route path="/activity" component={ActivityPage} />
      <Route path="/profile" component={ProfilePage} />
      <Route path="/friends" component={FriendsPage} />
      <Route component={NotFound} />
    </Switch>
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
      setShowButton(isMapPage && !isTracking);
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
      className="fixed z-[9999] flex items-center justify-center shadow-2xl transition-all duration-300 active:scale-95"
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

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <div className="fixed inset-0 flex flex-col bg-background">
          <main className="flex-1 relative overflow-hidden" style={{ marginBottom: 'calc(4.5rem + env(safe-area-inset-bottom, 0px))' }}>
            <Router />
          </main>
          <BottomNav />
        </div>
        <StartActivityButton />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
