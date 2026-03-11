import { useEffect, useState, useRef } from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Trophy, MapPin, TrendingUp, Swords, Pencil, Check, X, CheckCircle2, Camera } from 'lucide-react';
import { TauntCameraDialog } from '@/components/TauntCameraDialog';
import { useMutation } from '@tanstack/react-query';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { useSession } from '@/hooks/use-session';
import { useToast } from '@/hooks/use-toast';

interface VictimInfo {
  userId: string;
  userName: string;
  userColor: string;
  stolenArea: number;
}

interface TreasureInfo {
  treasureId: string;
  treasureName: string;
  powerType: string;
  rarity: string;
}

const POWER_EMOJI: Record<string, string> = {
  shield: '🛡️',
  double_area: '⚡',
  nickname: '🎭',
  steal_boost: '🏴‍☠️',
  invisibility: '👻',
  time_bomb: '💀',
  magnet: '🧲',
  reveal: '🔮',
  bulldozer: '🚜',
  battering_ram: '🐏',
  sentinel: '🔔',
  wall: '🧱',
};

const RARITY_COLORS: Record<string, string> = {
  common: 'from-gray-400 to-gray-500',
  rare: 'from-blue-400 to-blue-600',
  epic: 'from-purple-400 to-purple-600',
  legendary: 'from-amber-400 to-amber-600',
};

interface ConquestResultModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  newAreaKm2: number;
  previousAreaKm2: number;
  victims: VictimInfo[];
  treasuresCollected?: TreasureInfo[];
  senderId?: string;
  routeId?: string;
  routeName?: string;
}

export function ConquestResultModal({
  open,
  onOpenChange,
  newAreaKm2,
  previousAreaKm2,
  victims,
  treasuresCollected = [],
  senderId,
  routeId,
  routeName,
}: ConquestResultModalProps) {
  const [displayNewArea, setDisplayNewArea] = useState(0);
  const [displayTotalArea, setDisplayTotalArea] = useState(previousAreaKm2);
  const [showContent, setShowContent] = useState(false);
  const [selectedVictim, setSelectedVictim] = useState<VictimInfo | null>(null);
  const [showTauntCamera, setShowTauntCamera] = useState(false);
  const [sentVictims, setSentVictims] = useState<Set<string>>(new Set());
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(routeName || '');
  const [currentRouteName, setCurrentRouteName] = useState(routeName || '');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const { user: currentUser } = useSession();
  const { toast } = useToast();

  // Sync routeName prop
  useEffect(() => {
    if (routeName) {
      setRenameValue(routeName);
      setCurrentRouteName(routeName);
    }
  }, [routeName]);

  const renameMutation = useMutation({
    mutationFn: async (name: string) => {
      if (!routeId || !currentUser) throw new Error('No route');
      return await apiRequest('PATCH', `/api/routes/${routeId}/name`, { userId: currentUser.id, name });
    },
    onSuccess: () => {
      setCurrentRouteName(renameValue.trim());
      setIsRenaming(false);
      queryClient.invalidateQueries({ queryKey: ['/api/routes'] });
      queryClient.invalidateQueries({ queryKey: ['/api/feed'] });
      toast({ title: '✅ Nombre actualizado' });
    },
    onError: (err: Error) => {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    },
  });

  // Filter out victims with no stolen area
  const activeVictims = victims.filter(v => v.stolenArea > 0);

  useEffect(() => {
    if (!open) {
      setDisplayNewArea(0);
      setDisplayTotalArea(previousAreaKm2);
      setShowContent(false);
      setSelectedVictim(null);
      setShowTauntCamera(false);
      setSentVictims(new Set());
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
    <Dialog open={open} onOpenChange={(v) => { /* Only allow programmatic close via the button */ if (!v) return; onOpenChange(v); }}>
      <DialogContent
        className="w-[calc(100%-1rem)] max-w-sm mx-auto gap-0 overflow-hidden rounded-2xl border-0 shadow-2xl p-0 [&>button]:hidden"
        style={{ padding: '0', paddingTop: '0', paddingBottom: '0' }}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        {/* Green gradient header */}
        <div className="relative bg-gradient-to-br from-emerald-500 via-green-500 to-teal-600 px-5 pt-6 pb-8 text-white text-center">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.15),transparent_70%)]" />
          <div className="relative">
            <div className="inline-flex items-center justify-center bg-white/20 backdrop-blur-sm rounded-full p-3 mb-3">
              <Trophy className="h-8 w-8 text-yellow-200" />
            </div>
            <h2 className="text-xl font-bold mb-1">¡Conquista Completada!</h2>
            {routeId ? (
              <div className="mt-2">
                {isRenaming ? (
                  <div className="flex items-center gap-1.5 bg-white/15 backdrop-blur-sm rounded-xl px-3 py-2">
                    <Input
                      ref={renameInputRef}
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && renameValue.trim()) renameMutation.mutate(renameValue.trim());
                        if (e.key === 'Escape') { setIsRenaming(false); setRenameValue(currentRouteName); }
                      }}
                      placeholder="Ej: Carrera por el parque ✨"
                      className="h-8 text-sm bg-transparent border-0 text-white placeholder:text-white/40 p-0 focus-visible:ring-0"
                      autoFocus
                    />
                    <button onClick={() => { if (renameValue.trim()) renameMutation.mutate(renameValue.trim()); }} className="text-white/80 hover:text-white bg-white/10 rounded-lg p-1.5"><Check className="w-4 h-4" /></button>
                    <button onClick={() => { setIsRenaming(false); setRenameValue(currentRouteName); }} className="text-white/60 hover:text-white p-1"><X className="w-4 h-4" /></button>
                  </div>
                ) : (
                  <button
                    onClick={() => { setIsRenaming(true); setTimeout(() => renameInputRef.current?.focus(), 50); }}
                    className="w-full flex items-center gap-2.5 bg-white/10 hover:bg-white/15 backdrop-blur-sm rounded-xl px-3 py-2.5 transition-all duration-200 group"
                  >
                    <Pencil className="w-4 h-4 text-yellow-200 group-hover:scale-110 transition-transform flex-shrink-0" />
                    <span className="text-sm text-white/90 truncate flex-1 text-left">{currentRouteName || 'Sin nombre'}</span>
                    <span className="text-[10px] text-yellow-200/80 font-semibold uppercase tracking-wider flex-shrink-0">Renombrar</span>
                  </button>
                )}
              </div>
            ) : (
              <p className="text-sm text-white/80 mt-1">Tu actividad ha sido procesada</p>
            )}
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
              <p className="text-xl font-bold">{(() => { if (displayTotalArea >= 0.05) return `${displayTotalArea.toFixed(2)} km²`; return `${Math.round(displayTotalArea * 1000000)} m²`; })()}</p>
            </div>
            {newAreaKm2 > 0 && (
              <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300 border-0">
                <TrendingUp className="h-3 w-3 mr-1" />
                +{newAreaKm2 >= 0.05 ? `${newAreaKm2.toFixed(2)} km²` : `${Math.round(newAreaKm2 * 1000000)} m²`}
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
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {activeVictims.map((victim) => (
                  <div
                    key={victim.userId}
                    className="relative overflow-hidden rounded-xl border border-border/50 bg-muted/20"
                  >
                    {/* Victim info row */}
                    <div className="flex items-center gap-2.5 px-3 py-2.5">
                      <div
                        className="w-3.5 h-3.5 rounded-full flex-shrink-0 ring-2 ring-background shadow-sm"
                        style={{ backgroundColor: victim.userColor }}
                      />
                      <span className="text-sm font-medium flex-1 truncate">{victim.userName}</span>
                      <span className="text-xs font-bold text-red-500 bg-red-50 dark:bg-red-950/40 px-2 py-0.5 rounded-full">
                        -{(() => { const km2 = victim.stolenArea / 1000000; if (km2 >= 0.05) return `${km2.toFixed(2)} km²`; return `${Math.round(victim.stolenArea)} m²`; })()}
                      </span>
                    </div>
                    
                    {/* Photo action area */}
                    {senderId && (
                      sentVictims.has(victim.userId) ? (
                        <div className="flex items-center justify-center gap-2 px-3 py-2.5 bg-emerald-50 dark:bg-emerald-950/30 border-t border-emerald-200/50 dark:border-emerald-800/30">
                          <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                          <span className="text-sm font-bold text-emerald-600 dark:text-emerald-400">
                            ✅ Foto enviada
                          </span>
                        </div>
                      ) : (
                        <button
                          onClick={() => {
                            setSelectedVictim(victim);
                            setShowTauntCamera(true);
                          }}
                          className="w-full flex items-center justify-center gap-2.5 px-3 py-3.5 bg-gradient-to-r from-red-500 via-orange-500 to-amber-500 text-white text-base font-black active:scale-[0.97] transition-all duration-200 hover:brightness-110 animate-pulse"
                        >
                          <Camera className="h-5 w-5" />
                          <span>📸 ¡ENVIAR FOTO!</span>
                        </button>
                      )
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Treasures Collected */}
          {treasuresCollected.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 px-1">
                <span className="text-lg">🎁</span>
                <p className="text-sm font-semibold">¡Tesoros encontrados!</p>
              </div>
              <div className="space-y-2">
                {treasuresCollected.map((treasure) => {
                  const emoji = POWER_EMOJI[treasure.powerType] || '❓';
                  const rarityGradient = RARITY_COLORS[treasure.rarity] || RARITY_COLORS.common;
                  return (
                    <div
                      key={treasure.treasureId}
                      className="relative overflow-hidden rounded-xl border border-amber-500/30 bg-gradient-to-r from-amber-50/50 to-yellow-50/50 dark:from-amber-950/20 dark:to-yellow-950/20"
                    >
                      <div className="flex items-center gap-3 px-3 py-3">
                        <div className={`w-10 h-10 rounded-lg flex items-center justify-center text-xl bg-gradient-to-br ${rarityGradient} shadow-sm`}>
                          {emoji}
                        </div>
                        <div className="flex-1 min-w-0">
                          <span className="text-sm font-bold block truncate">{treasure.treasureName}</span>
                          <span className="text-xs text-muted-foreground capitalize">{treasure.rarity}</span>
                        </div>
                        <span className="text-xs font-bold text-amber-600 dark:text-amber-400 bg-amber-100 dark:bg-amber-900/40 px-2 py-1 rounded-full uppercase">
                          Nuevo
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Action Button — only way to close */}
          <Button
            onClick={() => onOpenChange(false)}
            className="w-full h-14 bg-primary hover:bg-primary/90 rounded-xl text-lg font-bold shadow-lg"
          >
            Ver en el mapa
          </Button>
        </div>
      </DialogContent>
    </Dialog>

    {selectedVictim && senderId && (
      <TauntCameraDialog
        open={showTauntCamera}
        onOpenChange={(isOpen) => {
          setShowTauntCamera(isOpen);
          // Mark victim as sent when dialog closes (photo was sent or dismissed)
          if (!isOpen && selectedVictim) {
            // Only mark if photo was actually sent — check via the dialog's internal state
            // We mark on close since TauntCameraDialog handles the send internally
          }
        }}
        senderId={senderId}
        victims={[selectedVictim.userId]}
        areaStolen={selectedVictim.stolenArea}
        onPhotoSent={() => {
          if (selectedVictim) {
            setSentVictims(prev => new Set(prev).add(selectedVictim.userId));
          }
        }}
      />
    )}
    </>
  );
}
