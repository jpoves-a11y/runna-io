import { Trophy, TrendingUp, Award } from 'lucide-react';
import { Card } from '@/components/ui/card';
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
        <Badge className="gap-1 bg-yellow-500 hover:bg-yellow-600 text-white border-0">
          <Trophy className="h-3 w-3" />
          1º Lugar
        </Badge>
      );
    }
    
    if (user.rank === 2) {
      return (
        <Badge className="gap-1 bg-gray-400 hover:bg-gray-500 text-white border-0">
          <Award className="h-3 w-3" />
          2º Lugar
        </Badge>
      );
    }
    
    if (user.rank === 3) {
      return (
        <Badge className="gap-1 bg-amber-600 hover:bg-amber-700 text-white border-0">
          <Award className="h-3 w-3" />
          3º Lugar
        </Badge>
      );
    }
    
    return (
      <Badge variant="secondary" className="gap-1">
        <Trophy className="h-3 w-3" />
        #{user.rank}
      </Badge>
    );
  };

  return (
    <Card
      className="absolute top-4 left-4 right-4 p-4 bg-card/95 backdrop-blur-md border-border shadow-xl z-[1000]"
      data-testid="stats-overlay"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-3">
            <h3 className="text-sm font-medium text-muted-foreground">
              Tu territorio
            </h3>
            {getRankBadge()}
          </div>
          
          <div className="flex items-baseline gap-2 mb-2">
            <span className="text-5xl font-bold tracking-tight" data-testid="total-area">
              {formattedArea}
            </span>
            <span className="text-xl text-muted-foreground font-medium">km²</span>
          </div>
          
          <div className="flex items-center gap-1.5 text-sm font-medium" style={{ color: user.color }}>
            <TrendingUp className="h-4 w-4" />
            <span>+12% esta semana</span>
          </div>
        </div>
        
        <div
          className="w-16 h-16 rounded-xl flex-shrink-0 shadow-lg border-2 border-white/20"
          style={{ backgroundColor: user.color }}
          aria-label="Tu color de territorio"
        />
      </div>
    </Card>
  );
}
