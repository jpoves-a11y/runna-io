import { useState, memo } from 'react';
import { useUserPowers, useActivatePower, type UserPower } from '@/hooks/use-competition';
import { useSession } from '@/hooks/use-session';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { Shield, Zap, Skull, Ghost, Magnet, Eye, Swords, Theater, X, Loader2 } from 'lucide-react';

const POWER_CONFIG: Record<string, { emoji: string; color: string; activeLabel: string }> = {
  shield: { emoji: '🛡️', color: '#3b82f6', activeLabel: 'Protegido 24h' },
  double_area: { emoji: '⚡', color: '#eab308', activeLabel: 'Próxima carrera x2' },
  nickname: { emoji: '🎭', color: '#ec4899', activeLabel: 'Apodo activo' },
  steal_boost: { emoji: '🏴‍☠️', color: '#22c55e', activeLabel: 'Próximo robo +50%' },
  invisibility: { emoji: '👻', color: '#a855f7', activeLabel: 'Invisible 24h' },
  time_bomb: { emoji: '💀', color: '#ef4444', activeLabel: 'Trampa activa 24h' },
  magnet: { emoji: '🧲', color: '#f97316', activeLabel: 'Próxima carrera +25%' },
  reveal: { emoji: '🔮', color: '#06b6d4', activeLabel: 'Revelado' },
};

const RARITY_STYLES: Record<string, string> = {
  common: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  rare: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  epic: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  legendary: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
};

interface PowerInventoryProps {
  open: boolean;
  onClose: () => void;
}

function PowerInventoryInner({ open, onClose }: PowerInventoryProps) {
  const { user } = useSession();
  const { data, isLoading } = useUserPowers(user?.id);
  const activateMutation = useActivatePower();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [nicknameTarget, setNicknameTarget] = useState<string | null>(null);
  
  if (!open) return null;
  
  const powers = data?.powers ?? [];
  const availablePowers = powers.filter(p => p.status === 'available');
  const activePowers = powers.filter(p => p.status === 'active');
  const usedPowers = powers.filter(p => p.status === 'used' || p.status === 'expired');
  
  const handleActivate = async (power: UserPower) => {
    if (activatingId) return;
    
    // Nickname requires a target — not available yet
    if (power.powerType === 'nickname') {
      toast({ title: '🎭 Próximamente', description: 'El poder de apodo se activará en futuras actualizaciones.' });
      return;
    }
    
    setActivatingId(power.id);
    try {
      await activateMutation.mutateAsync({ powerId: power.id });
      queryClient.invalidateQueries({ queryKey: ['/api/users'] });
    } catch (err) {
      console.error('Error activating power:', err);
    } finally {
      setActivatingId(null);
    }
  };
  
  const renderPowerCard = (power: UserPower, canActivate: boolean) => {
    const config = POWER_CONFIG[power.powerType] || { emoji: '❓', color: '#666', activeLabel: '' };
    const rarityStyle = RARITY_STYLES[power.definition?.rarity || 'common'] || RARITY_STYLES.common;
    
    return (
      <div
        key={power.id}
        className={`rounded-xl border p-3 transition-all ${
          power.status === 'active'
            ? 'border-white/20 bg-white/5'
            : power.status === 'available'
            ? 'border-white/10 bg-white/[0.02] hover:bg-white/5'
            : 'border-white/5 bg-white/[0.01] opacity-50'
        }`}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-lg flex items-center justify-center text-xl flex-shrink-0"
            style={{ background: `${config.color}20` }}
          >
            {config.emoji}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-white truncate">
                {power.definition?.name || power.powerType}
              </span>
              <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-full border ${rarityStyle}`}>
                {power.definition?.rarity || 'common'}
              </span>
            </div>
            <p className="text-[11px] text-white/50 truncate">
              {power.status === 'active' ? config.activeLabel : (power.definition?.description || '')}
            </p>
          </div>
          {canActivate && power.status === 'available' && (
            <button
              onClick={() => handleActivate(power)}
              disabled={!!activatingId}
              className="px-3 py-1.5 rounded-lg text-xs font-bold bg-white/10 hover:bg-white/20 text-white transition-colors disabled:opacity-50 flex-shrink-0"
            >
              {activatingId === power.id ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                'Activar'
              )}
            </button>
          )}
          {power.status === 'active' && (
            <div className="flex-shrink-0">
              <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            </div>
          )}
        </div>
      </div>
    );
  };
  
  return (
    <div className="fixed inset-0 z-[10000] flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      
      <div className="relative w-full max-w-md mx-auto max-h-[85vh] bg-gray-950 rounded-t-2xl sm:rounded-2xl border border-white/10 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <span className="text-lg">⚡</span>
            <h2 className="text-lg font-bold text-white">Poderes</h2>
            {availablePowers.length > 0 && (
              <span className="bg-amber-500/20 text-amber-400 text-xs font-bold px-2 py-0.5 rounded-full">
                {availablePowers.length}
              </span>
            )}
          </div>
          <button onClick={onClose} className="text-white/50 hover:text-white transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>
        
        {/* Content */}
        <div className="overflow-y-auto max-h-[calc(85vh-60px)] px-5 py-4 space-y-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 text-white/30 animate-spin" />
            </div>
          ) : powers.length === 0 ? (
            <div className="text-center py-12">
              <div className="text-4xl mb-3">🗺️</div>
              <p className="text-white/50 text-sm">
                Aún no tienes poderes. ¡Recoge tesoros corriendo para obtenerlos!
              </p>
            </div>
          ) : (
            <>
              {/* Active powers */}
              {activePowers.length > 0 && (
                <div>
                  <h3 className="text-xs font-bold text-green-400 uppercase tracking-wider mb-2">
                    Activos ({activePowers.length})
                  </h3>
                  <div className="space-y-2">
                    {activePowers.map(p => renderPowerCard(p, false))}
                  </div>
                </div>
              )}
              
              {/* Available powers */}
              {availablePowers.length > 0 && (
                <div>
                  <h3 className="text-xs font-bold text-amber-400 uppercase tracking-wider mb-2">
                    Disponibles ({availablePowers.length})
                  </h3>
                  <div className="space-y-2">
                    {availablePowers.map(p => renderPowerCard(p, true))}
                  </div>
                </div>
              )}
              
              {/* Used powers */}
              {usedPowers.length > 0 && (
                <div>
                  <h3 className="text-xs font-bold text-white/30 uppercase tracking-wider mb-2">
                    Usados ({usedPowers.length})
                  </h3>
                  <div className="space-y-2">
                    {usedPowers.map(p => renderPowerCard(p, false))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export const PowerInventory = memo(PowerInventoryInner);
