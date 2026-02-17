import { Trophy, Medal, Award, TrendingUp, Crown } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { UserWithStats } from '@shared/schema';

interface LeaderboardTableProps {
  users: UserWithStats[];
  currentUserId?: string;
  onUserClick?: (userId: string) => void;
}

export function LeaderboardTable({ users, currentUserId, onUserClick }: LeaderboardTableProps) {
  const getRankIcon = (rank: number) => {
    switch (rank) {
      case 1:
        return <Crown className="h-6 w-6 text-yellow-500 animate-bounce-in" />;
      case 2:
        return <Medal className="h-5 w-5 text-gray-400 animate-bounce-in" />;
      case 3:
        return <Award className="h-5 w-5 text-amber-600 animate-bounce-in" />;
      default:
        return null;
    }
  };

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  const getRankBadge = (rank: number) => {
    if (rank === 1) {
      return 'gradient-primary text-white shadow-lg';
    }
    if (rank === 2) {
      return 'bg-gray-400 text-white shadow-md';
    }
    if (rank === 3) {
      return 'bg-amber-600 text-white shadow-md';
    }
    return '';
  };

  return (
    <div className="flex flex-col h-full animate-fade-in">
      {/* Header */}
      <div className="p-4 border-b border-border/50 bg-gradient-to-r from-primary/5 via-transparent to-primary/5 animate-slide-down">
        <div className="flex items-center gap-3">
          <div className="relative p-2 rounded-xl bg-primary/10">
            <Trophy className="h-6 w-6 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold">Rankings</h1>
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <TrendingUp className="h-3 w-3" />
              Territorio conquistado
            </p>
          </div>
        </div>
      </div>

      {/* Leaderboard */}
      <ScrollArea className="flex-1">
        <div className="p-3 pb-24 space-y-2 sm:p-4">
          {users.map((user, index) => {
            const rank = index + 1;
            const isCurrentUser = user.id === currentUserId;
            const isTopThree = rank <= 3;

            return (
              <Card
                key={user.id}
                onClick={() => onUserClick?.(user.id)}
                className={`p-3 sm:p-4 transition-all duration-300 hover:scale-[1.02] hover:shadow-lg animate-slide-up cursor-pointer ${
                  isCurrentUser
                    ? 'border-primary border-2 shadow-primary/20'
                    : 'border-card-border hover-elevate'
                } ${getRankBadge(rank)}`}
                style={{
                  animationDelay: `${index * 50}ms`,
                }}
                data-testid={`leaderboard-row-${user.id}`}
              >
                <div className="flex items-center gap-2 sm:gap-4 min-w-0">
                  {/* Rank */}
                  <div className="w-10 sm:w-14 flex items-center justify-center flex-shrink-0 relative">
                    {getRankIcon(rank) || (
                      <span className={`text-xl sm:text-2xl font-bold ${isTopThree ? 'text-white/80' : 'text-muted-foreground'}`}>
                        {rank}
                      </span>
                    )}
                    {isTopThree && rank === 1 && (
                      <div className="absolute inset-0 bg-yellow-500/20 rounded-full blur-xl animate-pulse" />
                    )}
                  </div>

                  {/* Avatar */}
                  <div className="relative flex-shrink-0">
                    <Avatar className={`${isTopThree ? 'h-12 sm:h-14 w-12 sm:w-14 ring-2 ring-offset-2' : 'h-10 sm:h-12 w-10 sm:w-12'} transition-all duration-300`}
                      style={{
                        '--tw-ring-color': isTopThree ? user.color : 'transparent'
                      } as React.CSSProperties}
                    >
                      <AvatarImage src={user.avatar || undefined} />
                      <AvatarFallback style={{ backgroundColor: user.color }}>
                        <span className="text-white font-semibold text-xs sm:text-base">
                          {getInitials(user.name)}
                        </span>
                      </AvatarFallback>
                    </Avatar>
                    {isTopThree && (
                      <div className="absolute -top-1 -right-1">
                        {getRankIcon(rank)}
                      </div>
                    )}
                  </div>

                  {/* User Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1 sm:gap-2">
                      <p className={`font-semibold truncate text-sm sm:text-base ${isTopThree ? 'sm:text-lg text-white' : ''}`} data-testid={`text-name-${user.id}`}>
                        {user.name}
                      </p>
                      {isCurrentUser && (
                        <Badge variant="secondary" className="text-xs flex-shrink-0 animate-pulse">
                          Tú
                        </Badge>
                      )}
                    </div>
                    <p className={`text-xs sm:text-sm truncate ${isTopThree ? 'text-white/70' : 'text-muted-foreground'}`}>
                      @{user.username}
                    </p>
                  </div>

                  {/* Area */}
                  <div className="text-right flex-shrink-0">
                    <p className={`font-bold text-sm sm:text-lg ${isTopThree ? 'sm:text-2xl text-white' : ''}`} data-testid={`text-area-${user.id}`}>
                      {(user.totalArea / 1000000).toLocaleString('es-ES', {
                        minimumFractionDigits: 1,
                        maximumFractionDigits: 1,
                      })}
                    </p>
                    <p className={`text-xs ${isTopThree ? 'text-white/70' : 'text-muted-foreground'}`}>km²</p>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
