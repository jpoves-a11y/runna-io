import { useState, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LeaderboardTable } from '@/components/LeaderboardTable';
import UserInfoDialog from '@/components/UserInfoDialog';
import { LeaderboardSkeleton } from '@/components/LoadingState';
import { useSession } from '@/hooks/use-session';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Users, RefreshCw } from 'lucide-react';
import { queryClient } from '@/lib/queryClient';
import type { UserWithStats } from '@shared/schema';

export default function RankingsPage() {
  const { user: currentUser } = useSession();
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [friendsOnly, setFriendsOnly] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const touchStartY = useRef<number>(0);
  const pullToRefreshThreshold = 80;

  const { data: allUsers = [], isLoading: isLoadingAll } = useQuery<UserWithStats[]>({
    queryKey: ['/api/leaderboard'],
    enabled: !friendsOnly,
  });

  const { data: friendUsers = [], isLoading: isLoadingFriends } = useQuery<UserWithStats[]>({
    queryKey: ['/api/leaderboard/friends', currentUser?.id],
    enabled: friendsOnly && !!currentUser?.id,
  });

  const users = friendsOnly ? friendUsers : allUsers;
  const isLoading = friendsOnly ? isLoadingFriends : isLoadingAll;

  const handleRefresh = async () => {
    if (isRefreshing) return;
    
    setIsRefreshing(true);
    try {
      await queryClient.invalidateQueries({ queryKey: ['/api/leaderboard'] });
      await queryClient.invalidateQueries({ queryKey: ['/api/leaderboard/friends', currentUser?.id] });
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

  if (isLoading) {
    return (
      <div className="h-full overflow-hidden">
        <div className="p-6 border-b border-border">
          <div className="h-10 w-48 bg-muted animate-pulse rounded-md mb-2" />
          <div className="h-4 w-64 bg-muted animate-pulse rounded-md" />
        </div>
        <LeaderboardSkeleton />
      </div>
    );
  }

  return (
    <div 
      ref={scrollRef}
      className="h-full flex flex-col overflow-y-auto"
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
      <div className="p-4 border-b border-border bg-card/50 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <Switch
            id="friends-toggle"
            checked={friendsOnly}
            onCheckedChange={setFriendsOnly}
            disabled={!currentUser}
            data-testid="switch-friends-only"
          />
          <Label
            htmlFor="friends-toggle"
            className="flex items-center gap-2 cursor-pointer text-sm font-medium"
          >
            <Users className="h-4 w-4" />
            {friendsOnly ? 'Solo amigos' : 'Todos los usuarios'}
          </Label>
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        <LeaderboardTable
          users={users}
          currentUserId={currentUser?.id}
          onUserClick={(id) => { setSelectedUserId(id); setIsDialogOpen(true); }}
        />
      </div>

      <UserInfoDialog
        userId={selectedUserId}
        open={isDialogOpen}
        onOpenChange={(open) => { if (!open) setSelectedUserId(null); setIsDialogOpen(open); }}
      />
    </div>
  );
}
