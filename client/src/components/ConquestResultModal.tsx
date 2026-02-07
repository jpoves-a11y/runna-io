import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Trophy, Heart, Zap } from 'lucide-react';

interface VictimInfo {
  userId: string;
  userName: string;
  userColor: string;
  stolenArea: number;
}

interface ConquestResultModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  newAreaKm2: number;
  previousAreaKm2: number;
  victims: VictimInfo[];
}

export function ConquestResultModal({
  open,
  onOpenChange,
  newAreaKm2,
  previousAreaKm2,
  victims,
}: ConquestResultModalProps) {
  const [displayNewArea, setDisplayNewArea] = useState(0);
  const [displayTotalArea, setDisplayTotalArea] = useState(previousAreaKm2);
  const [showVictims, setShowVictims] = useState(false);

  useEffect(() => {
    if (!open) {
      setDisplayNewArea(0);
      setDisplayTotalArea(previousAreaKm2);
      setShowVictims(false);
      return;
    }

    // Animate new area counter
    const newAreaInterval = setInterval(() => {
      setDisplayNewArea((prev) => {
        const target = newAreaKm2;
        const diff = target - prev;
        const step = Math.max(diff / 20, 0.01);
        const next = Math.min(prev + step, target);
        
        if (Math.abs(next - target) < 0.01) {
          clearInterval(newAreaInterval);
          // After new area is done, animate total area
          setTimeout(() => {
            const totalInterval = setInterval(() => {
              setDisplayTotalArea((prev2) => {
                const target2 = previousAreaKm2 + newAreaKm2;
                const diff2 = target2 - prev2;
                const step2 = Math.max(diff2 / 20, 0.01);
                const next2 = Math.min(prev2 + step2, target2);
                
                if (Math.abs(next2 - target2) < 0.01) {
                  clearInterval(totalInterval);
                  // Finally show victims
                  setTimeout(() => setShowVictims(true), 300);
                }
                
                return next2;
              });
            }, 50);
          }, 300);
        }
        
        return next;
      });
    }, 50);

    return () => clearInterval(newAreaInterval);
  }, [open, newAreaKm2, previousAreaKm2]);

  const totalStolenArea = victims.reduce((sum, v) => sum + v.stolenArea, 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full max-w-sm border-2 border-primary/50">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-center justify-center">
            <Trophy className="h-6 w-6 text-yellow-500 animate-bounce" />
            ¡Conquista Completada!
            <Zap className="h-6 w-6 text-primary animate-pulse" />
          </DialogTitle>
          <DialogDescription>Tu actividad ha sido procesada y mapeada</DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* New Area Gained */}
          <div className="bg-gradient-to-br from-primary/10 to-primary/5 rounded-lg p-6 text-center border border-primary/20">
            <p className="text-sm text-muted-foreground mb-2">Has conquistado</p>
            <div className="text-5xl font-bold text-primary mb-2">
              {displayNewArea.toFixed(2)}
            </div>
            <p className="text-sm font-semibold text-muted-foreground">km² nuevos</p>
          </div>

          {/* Total Area */}
          <div className="flex items-center justify-between p-4 bg-muted/50 rounded-lg border border-border/50">
            <div>
              <p className="text-sm text-muted-foreground">Área total conquistada</p>
              <p className="text-2xl font-bold">
                {displayTotalArea.toFixed(2)}
              </p>
              <p className="text-xs text-muted-foreground">km²</p>
            </div>
            <Heart className="h-8 w-8 text-red-500 opacity-50" />
          </div>

          {/* Stolen Territories */}
          {victims.length > 0 && showVictims && (
            <div className="space-y-3 pt-2 border-t border-border/50">
              <div className="flex items-center justify-between">
                <p className="font-semibold">Territorios robados</p>
                <Badge variant="secondary" className="bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300">
                  {totalStolenArea.toFixed(2)} km²
                </Badge>
              </div>

              <div className="space-y-2 max-h-48 overflow-y-auto">
                {victims.map((victim) => (
                  <div
                    key={victim.userId}
                    className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg border border-border/50 hover:bg-muted transition-colors"
                  >
                    <div
                      className="w-4 h-4 rounded-full flex-shrink-0"
                      style={{ backgroundColor: victim.userColor }}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{victim.userName}</p>
                    </div>
                    <Badge variant="outline" className="text-xs flex-shrink-0 bg-red-50 dark:bg-red-950 text-red-600 dark:text-red-400 border-red-200 dark:border-red-800">
                      {victim.stolenArea.toFixed(2)} km²
                    </Badge>
                  </div>
                ))}
              </div>

              <p className="text-xs text-muted-foreground text-center pt-2">
                {victims.length} {victims.length === 1 ? 'usuario perdió' : 'usuarios perdieron'} territorio
              </p>
            </div>
          )}

          {/* Loading state for victims */}
          {!showVictims && victims.length > 0 && (
            <div className="text-center py-2">
              <div className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                <div className="w-2 h-2 bg-primary rounded-full animate-bounce" />
                Calculando territorios robados...
              </div>
            </div>
          )}

          {/* No victims */}
          {victims.length === 0 && showVictims && (
            <div className="text-center p-4 bg-muted/50 rounded-lg border border-border/50">
              <p className="text-sm text-muted-foreground">
                No robaste territorio a otros usuarios en esta actividad
              </p>
            </div>
          )}

          {/* Action Button */}
          <Button
            onClick={() => onOpenChange(false)}
            className="w-full bg-primary hover:bg-primary/90"
            disabled={!showVictims && victims.length > 0}
          >
            {!showVictims && victims.length > 0 ? 'Calculando...' : 'Ver en el mapa'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
