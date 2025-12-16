import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BottomNav } from "@/components/BottomNav";
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
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
