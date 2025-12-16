import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BottomNav } from "@/components/BottomNav";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
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
  const [location, setLocation] = useLocation();
  
  // Always show on map page
  if (location !== '/' && !location.startsWith('/?')) return null;
  
  return (
    <div 
      style={{
        position: 'fixed',
        bottom: '96px',
        right: '16px',
        width: '64px',
        height: '64px',
        borderRadius: '50%',
        backgroundColor: '#22c55e',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
        zIndex: 9999,
        cursor: 'pointer',
      }}
      onClick={() => setLocation('/?tracking=true')}
      data-testid="button-start-run"
    >
      <Plus className="h-8 w-8 text-white" />
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <div className="flex flex-col h-screen w-full max-w-full overflow-hidden bg-background">
          {/* Main content area - accounts for bottom nav */}
          <main className="flex-1 w-full max-w-full overflow-hidden pb-16">
            <Router />
          </main>
          
          {/* Bottom Navigation */}
          <BottomNav />
        </div>
        
        {/* Start Activity Button - fixed position outside container */}
        <StartActivityButton />
        
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
