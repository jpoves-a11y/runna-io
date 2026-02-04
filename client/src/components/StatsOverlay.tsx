import { Trophy, TrendingUp, Award } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { UserWithStats } from '@shared/schema';

interface StatsOverlayProps {
  user: UserWithStats;
}

export function StatsOverlay({ user }: StatsOverlayProps) {
  const formattedArea = (user.totalArea / 1000000).toLocaleString('es-ES', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const getRankBadge = () => {
    if (!user.rank) return null;
    
    if (user.rank === 1) {
      return (
        <Badge className="gap-1 bg-yellow-500/90 hover:bg-yellow-600 text-white border-0 text-[10px] px-1.5 py-0.5">
          <Trophy className="h-2.5 w-2.5" />
          1º
        </Badge>
      );
    }
    
    if (user.rank === 2) {
      return (
        <Badge className="gap-1 bg-gray-400/90 hover:bg-gray-500 text-white border-0 text-[10px] px-1.5 py-0.5">
          <Award className="h-2.5 w-2.5" />
          2º
        </Badge>
      );
    }
    
    if (user.rank === 3) {
      return (
        <Badge className="gap-1 bg-amber-600/90 hover:bg-amber-700 text-white border-0 text-[10px] px-1.5 py-0.5">
          <Award className="h-2.5 w-2.5" />
          3º
        </Badge>
      );
    }
    
    return (
      <Badge variant="secondary" className="gap-1 text-[10px] px-1.5 py-0.5">
        <Trophy className="h-2.5 w-2.5" />
        #{user.rank}
      </Badge>
    );
  };

  return (
    <div
      className="absolute left-3 right-3 p-3 bg-card/95 backdrop-blur-xl rounded-xl border border-border shadow-lg z-[1000]"
      style={{ top: 'calc(0.75rem + env(safe-area-inset-top, 0px))' }}
      data-testid="stats-overlay"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className="w-10 h-10 rounded-lg flex-shrink-0 shadow-md"
            style={{ backgroundColor: user.color }}
          />
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-xs text-muted-foreground font-medium">Tu territorio</span>
              {getRankBadge()}
            </div>
            <div className="flex items-baseline gap-1">
              <span className="text-2xl font-bold tracking-tight" data-testid="total-area">
                {formattedArea}
              </span>
              <span className="text-sm text-muted-foreground font-medium">km²</span>
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-md bg-primary/10" style={{ color: user.color }}>
          <TrendingUp className="h-3 w-3" />
          <span>+12%</span>
        </div>
      </div>
    </div>
  );
}
