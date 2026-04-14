import { Trophy, TrendingUp, Crown, Flame, MapPin, BarChart3 } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { formatAreaParts } from '@/lib/formatArea';
import { openWeeklySummary } from '@/components/WeeklySummaryDialog';
import type { UserWithStats } from '@shared/schema';

interface LeaderboardTableProps {
  users: (UserWithStats & { nickname?: string | null; nicknameExpiresAt?: string | null })[];
  currentUserId?: string;
  onUserClick?: (userId: string) => void;
}

export function LeaderboardTable({ users, currentUserId, onUserClick }: LeaderboardTableProps) {
  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  const podiumMedal = (rank: number) => {
    if (rank === 1) return { emoji: '🥇', bg: 'bg-amber-50 dark:bg-amber-950/40', border: 'border-amber-300 dark:border-amber-700', text: 'text-amber-700 dark:text-amber-300', glow: 'shadow-amber-200/50 dark:shadow-amber-800/30' };
    if (rank === 2) return { emoji: '🥈', bg: 'bg-slate-50 dark:bg-slate-900/40', border: 'border-slate-300 dark:border-slate-600', text: 'text-slate-600 dark:text-slate-300', glow: 'shadow-slate-200/50 dark:shadow-slate-700/30' };
    if (rank === 3) return { emoji: '🥉', bg: 'bg-orange-50 dark:bg-orange-950/40', border: 'border-orange-300 dark:border-orange-700', text: 'text-orange-700 dark:text-orange-300', glow: 'shadow-orange-200/50 dark:shadow-orange-700/30' };
    return null;
  };

  return (
    <div className="flex flex-col h-full animate-fade-in">
      {/* Header */}
      <div className="px-5 py-4 border-b border-border/40 animate-slide-down" style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 1rem)' }}>
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-primary/10">
            <Trophy className="h-5 w-5 text-primary" />
          </div>
          <div className="flex-1">
            <h1 className="text-lg font-bold tracking-tight">Rankings</h1>
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <MapPin className="h-3 w-3" />
              Territorio conquistado
            </p>
          </div>
          <button
            onClick={() => openWeeklySummary()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-500 text-xs font-bold transition-colors"
            title="Ver resumen semanal"
          >
            <BarChart3 className="h-3.5 w-3.5" />
            Resumen
          </button>
        </div>
      </div>

      {/* Leaderboard */}
      <ScrollArea className="flex-1">
        <div className="px-4 py-3 pb-24 space-y-1.5">
          {users.map((user, index) => {
            const rank = index + 1;
            const isCurrentUser = user.id === currentUserId;
            const isTopThree = rank <= 3;
            const medal = podiumMedal(rank);

            return (
              <div
                key={user.id}
                onClick={() => onUserClick?.(user.id)}
                className={`
                  flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-200 cursor-pointer
                  animate-slide-up
                  ${isCurrentUser
                    ? 'bg-primary/8 ring-1 ring-primary/30'
                    : medal
                      ? `${medal.bg} border ${medal.border} shadow-sm ${medal.glow}`
                      : 'hover:bg-muted/60'
                  }
                `}
                style={{ animationDelay: `${index * 40}ms` }}
                data-testid={`leaderboard-row-${user.id}`}
              >
                {/* Rank number */}
                <div className="w-8 flex-shrink-0 flex items-center justify-center">
                  {medal ? (
                    <span className="text-xl leading-none">{medal.emoji}</span>
                  ) : (
                    <span className="text-sm font-semibold text-muted-foreground/70 tabular-nums">
                      {rank}
                    </span>
                  )}
                </div>

                {/* Avatar */}
                <Avatar className={`${isTopThree ? 'h-11 w-11' : 'h-9 w-9'} flex-shrink-0 transition-all`}>
                  <AvatarImage src={user.avatar || undefined} />
                  <AvatarFallback
                    style={{ backgroundColor: user.color }}
                    className="text-white font-semibold text-xs"
                  >
                    {getInitials(user.name)}
                  </AvatarFallback>
                </Avatar>

                {/* User Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    {user.nickname ? (
                      <div className="flex items-center gap-1 min-w-0">
                        <span className="text-pink-400 font-medium truncate text-sm" title={`Apodo puesto por otro jugador (expira pronto)`}>
                          🎭 {user.nickname}
                        </span>
                      </div>
                    ) : (
                      <p className={`font-medium truncate text-sm ${isTopThree ? 'font-semibold' : ''}`} data-testid={`text-name-${user.id}`}>
                        {user.name}
                      </p>
                    )}
                    {isCurrentUser && (
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 flex-shrink-0">
                        Tú
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground truncate">
                    @{user.username}
                    {user.nickname && <span className="text-[10px] text-pink-400/60 ml-1">(antes: {user.name})</span>}
                  </p>
                </div>

                {/* Area */}
                <div className="text-right flex-shrink-0">
                  {(() => {
                    const parts = formatAreaParts(user.totalArea);
                    return (
                      <>
                        <p className={`font-bold tabular-nums ${isTopThree ? 'text-base' : 'text-sm'}`} data-testid={`text-area-${user.id}`}>
                          {parts.value}
                        </p>
                        <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">{parts.unit}</p>
                      </>
                    );
                  })()}
                </div>
              </div>
            );
          })}

          {users.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <Trophy className="h-10 w-10 mb-3 opacity-30" />
              <p className="text-sm font-medium">Sin participantes aún</p>
              <p className="text-xs mt-1">Añade amigos para ver el ranking</p>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
