import { useQuery } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Swords, Shield, TrendingUp, TrendingDown } from 'lucide-react';

interface ConquestStats {
  totalStolen: number;
  totalLost: number;
  stolenByUser: Array<{ userId: string; userName: string; userColor: string; amount: number }>;
  lostToUser: Array<{ userId: string; userName: string; userColor: string; amount: number }>;
}

interface ConquestStatsProps {
  userId: string;
}

export function ConquestStats({ userId }: ConquestStatsProps) {
  const { data: stats, isLoading } = useQuery<ConquestStats>({
    queryKey: [`/api/conquest-stats/${userId}`],
    enabled: !!userId,
  });

  if (isLoading) {
    return (
      <Card className="p-4 animate-pulse">
        <div className="h-20 bg-muted rounded" />
      </Card>
    );
  }

  if (!stats || (stats.totalStolen === 0 && stats.totalLost === 0)) {
    return null; // Don't show if no conquest activity
  }

  const formatArea = (area: number) => {
    const km2 = area / 1000000;
    if (km2 < 0.01) return `${(area).toFixed(0)} m²`;
    return `${km2.toFixed(2)} km²`;
  };

  const netGain = stats.totalStolen - stats.totalLost;

  return (
    <Card className="p-4 space-y-4">
      <div className="flex items-center gap-2 mb-2">
        <Swords className="h-5 w-5 text-primary" />
        <h3 className="font-semibold text-lg">Batallas de territorio</h3>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-green-500/10 rounded-lg p-3 border border-green-500/20">
          <div className="flex items-center gap-2 text-green-600 dark:text-green-400 mb-1">
            <TrendingUp className="h-4 w-4" />
            <span className="text-xs font-medium">Robados</span>
          </div>
          <p className="text-lg font-bold text-green-700 dark:text-green-300">
            {formatArea(stats.totalStolen)}
          </p>
        </div>
        
        <div className="bg-red-500/10 rounded-lg p-3 border border-red-500/20">
          <div className="flex items-center gap-2 text-red-600 dark:text-red-400 mb-1">
            <TrendingDown className="h-4 w-4" />
            <span className="text-xs font-medium">Perdidos</span>
          </div>
          <p className="text-lg font-bold text-red-700 dark:text-red-300">
            {formatArea(stats.totalLost)}
          </p>
        </div>
      </div>

      {/* Net balance */}
      <div className={`rounded-lg p-3 text-center ${
        netGain >= 0 
          ? 'bg-green-500/5 border border-green-500/10' 
          : 'bg-red-500/5 border border-red-500/10'
      }`}>
        <span className="text-sm text-muted-foreground">Balance neto: </span>
        <span className={`font-bold ${netGain >= 0 ? 'text-green-600' : 'text-red-600'}`}>
          {netGain >= 0 ? '+' : ''}{formatArea(netGain)}
        </span>
      </div>

      {/* Stolen from breakdown */}
      {stats.stolenByUser.length > 0 && (
        <div>
          <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1">
            <Swords className="h-3 w-3" /> Has robado a:
          </p>
          <div className="space-y-2">
            {stats.stolenByUser.slice(0, 3).map((victim) => (
              <div key={victim.userId} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <div 
                    className="w-3 h-3 rounded-full" 
                    style={{ backgroundColor: victim.userColor }}
                  />
                  <span className="truncate max-w-[120px]">{victim.userName}</span>
                </div>
                <span className="font-medium text-green-600">+{formatArea(victim.amount)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Lost to breakdown */}
      {stats.lostToUser.length > 0 && (
        <div>
          <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1">
            <Shield className="h-3 w-3" /> Te han robado:
          </p>
          <div className="space-y-2">
            {stats.lostToUser.slice(0, 3).map((attacker) => (
              <div key={attacker.userId} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <div 
                    className="w-3 h-3 rounded-full" 
                    style={{ backgroundColor: attacker.userColor }}
                  />
                  <span className="truncate max-w-[120px]">{attacker.userName}</span>
                </div>
                <span className="font-medium text-red-600">-{formatArea(attacker.amount)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}
