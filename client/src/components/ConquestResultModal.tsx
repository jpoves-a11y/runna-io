import { useEffect, useState } from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Trophy, MapPin, TrendingUp, Swords } from 'lucide-react';
import { TauntCameraDialog } from '@/components/TauntCameraDialog';

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
  senderId?: string;
}

export function ConquestResultModal({
  open,
  onOpenChange,
  newAreaKm2,
  previousAreaKm2,
  victims,
  senderId,
}: ConquestResultModalProps) {
  const [displayNewArea, setDisplayNewArea] = useState(0);
  const [displayTotalArea, setDisplayTotalArea] = useState(previousAreaKm2);
  const [showContent, setShowContent] = useState(false);
  const [selectedVictim, setSelectedVictim] = useState<VictimInfo | null>(null);
  const [showTauntCamera, setShowTauntCamera] = useState(false);

  // Filter out victims with no stolen area
  const activeVictims = victims.filter(v => v.stolenArea > 0);

  useEffect(() => {
    if (!open) {
      setDisplayNewArea(0);
      setDisplayTotalArea(previousAreaKm2);
      setShowContent(false);
      setSelectedVictim(null);
      setShowTauntCamera(false);
      return;
    }

    // Small delay for entrance
    setTimeout(() => setShowContent(true), 100);

    // Animate new area counter
    const newAreaInterval = setInterval(() => {
      setDisplayNewArea((prev) => {
        const target = newAreaKm2;
        const diff = target - prev;
        const step = Math.max(diff / 20, 0.01);
        const next = Math.min(prev + step, target);
        
        if (Math.abs(next - target) < 0.01) {
          clearInterval(newAreaInterval);
          setTimeout(() => {
            const totalInterval = setInterval(() => {
              setDisplayTotalArea((prev2) => {
                const target2 = previousAreaKm2 + newAreaKm2;
                const diff2 = target2 - prev2;
                const step2 = Math.max(diff2 / 20, 0.01);
                const next2 = Math.min(prev2 + step2, target2);
                if (Math.abs(next2 - target2) < 0.01) {
                  clearInterval(totalInterval);
                }
                return next2;
              });
            }, 50);
          }, 200);
        }
        return next;
      });
    }, 50);

    return () => clearInterval(newAreaInterval);
  }, [open, newAreaKm2, previousAreaKm2]);

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100%-1rem)] max-w-sm mx-auto gap-0 overflow-hidden rounded-2xl border-0 shadow-2xl p-0" style={{ padding: '0', paddingTop: '0', paddingBottom: '0' }}>
        {/* Green gradient header */}
        <div className="relative bg-gradient-to-br from-emerald-500 via-green-500 to-teal-600 px-5 pt-6 pb-8 text-white text-center">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.15),transparent_70%)]" />
          <div className="relative">
            <div className="inline-flex items-center justify-center bg-white/20 backdrop-blur-sm rounded-full p-3 mb-3">
              <Trophy className="h-8 w-8 text-yellow-200" />
            </div>
            <h2 className="text-xl font-bold mb-1">¡Conquista Completada!</h2>
            <p className="text-sm text-white/80">Tu actividad ha sido procesada</p>
          </div>
        </div>

        {/* New area card - overlapping header */}
        <div className={`px-4 -mt-5 transition-all duration-500 ${showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}`}>
          <div className="bg-background rounded-xl shadow-lg border border-border/50 p-5 text-center">
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Has conquistado</p>
            <div className="text-4xl font-black text-primary mb-0.5">
              {displayNewArea.toFixed(2)}
            </div>
            <p className="text-sm font-medium text-muted-foreground">km² nuevos</p>
          </div>
        </div>

        {/* Stats and action */}
        <div className={`px-4 pt-3 pb-4 space-y-3 transition-all duration-500 delay-200 ${showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}`} style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))' }}>
          {/* Total area + change */}
          <div className="flex items-center gap-3 p-3 bg-muted/40 rounded-xl">
            <div className="bg-primary/10 rounded-lg p-2">
              <MapPin className="h-5 w-5 text-primary" />
            </div>
            <div className="flex-1">
              <p className="text-xs text-muted-foreground">Área total conquistada</p>
              <p className="text-xl font-bold">{displayTotalArea.toFixed(2)} km²</p>
            </div>
            {newAreaKm2 > 0 && (
              <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300 border-0">
                <TrendingUp className="h-3 w-3 mr-1" />
                +{newAreaKm2.toFixed(2)}
              </Badge>
            )}
          </div>

          {/* Stolen Territories */}
          {activeVictims.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 px-1">
                <Swords className="h-4 w-4 text-red-500" />
                <p className="text-sm font-semibold">Territorios robados</p>
              </div>
              <div className="space-y-1.5 max-h-32 overflow-y-auto">
                {activeVictims.map((victim) => (
                  <div
                    key={victim.userId}
                    className="flex items-center gap-2.5 p-2.5 bg-muted/30 rounded-lg"
                  >
                    <div
                      className="w-3 h-3 rounded-full flex-shrink-0"
                      style={{ backgroundColor: victim.userColor }}
                    />
                    <span className="text-sm flex-1 truncate">{victim.userName}</span>
                    <span className="text-xs font-semibold text-red-500">
                      -{(victim.stolenArea / 1000000).toFixed(2)} km²
                    </span>
                    {senderId && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="ml-1 h-7 px-2 text-xs border-red-200 text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/30"
                        onClick={() => {
                          setSelectedVictim(victim);
                          setShowTauntCamera(true);
                        }}
                      >
                        Enviar foto
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Action Button */}
          <Button
            onClick={() => onOpenChange(false)}
            className="w-full h-12 bg-primary hover:bg-primary/90 rounded-xl text-base font-semibold shadow-lg"
          >
            Ver en el mapa
          </Button>
        </div>
      </DialogContent>
    </Dialog>

    {selectedVictim && senderId && (
      <TauntCameraDialog
        open={showTauntCamera}
        onOpenChange={setShowTauntCamera}
        senderId={senderId}
        victims={[selectedVictim.userId]}
        areaStolen={selectedVictim.stolenArea}
      />
    )}
    </>
  );
}
