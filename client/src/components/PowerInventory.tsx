import { useState, useEffect, memo } from 'react';
import { useUserPowers, useActivatePower, type UserPower } from '@/hooks/use-competition';
import { useSession } from '@/hooks/use-session';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { Shield, Zap, Skull, Ghost, Magnet, Eye, Swords, Theater, X, Loader2, Search } from 'lucide-react';
import { API_BASE } from '@/lib/queryClient';

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
  const [nicknameModal, setNicknameModal] = useState<{ powerId: string } | null>(null);
  const [nicknameText, setNicknameText] = useState('');
  const [nicknameTargetId, setNicknameTargetId] = useState('');
  const [nicknameTargetName, setNicknameTargetName] = useState('');
  const [leaderboardUsers, setLeaderboardUsers] = useState<{ id: string; username: string; name: string }[]>([]);
  const [userSearch, setUserSearch] = useState('');
  const [loadingUsers, setLoadingUsers] = useState(false);
  
  if (!open) return null;
  
  const powers = data?.powers ?? [];
  const availablePowers = powers.filter(p => p.status === 'available');
  const activePowers = powers.filter(p => p.status === 'active');
  const usedPowers = powers.filter(p => p.status === 'used' || p.status === 'expired');
  
  const handleActivate = async (power: UserPower) => {
    if (activatingId) return;
    
    // Nickname requires selecting a target user + typing a nickname
    if (power.powerType === 'nickname') {
      setNicknameModal({ powerId: power.id });
      setNicknameText('');
      setNicknameTargetId('');
      setNicknameTargetName('');
      setUserSearch('');
      // Load all participants for the selector
      setLoadingUsers(true);
      try {
        const res = await fetch(`${API_BASE}/api/competition/participants`);
        const data = await res.json();
        const users = (data.participants || []).map((p: any) => ({
          id: p.id,
          username: p.username || '',
          name: p.name || '',
        })).filter((u: any) => u.id !== user?.id); // exclude self
        setLeaderboardUsers(users);
      } catch (e) {
        setLeaderboardUsers([]);
      }
      setLoadingUsers(false);
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
  
  const handleNicknameConfirm = async () => {
    if (!nicknameModal || !nicknameTargetId || !nicknameText.trim()) return;
    setActivatingId(nicknameModal.powerId);
    try {
      await activateMutation.mutateAsync({
        powerId: nicknameModal.powerId,
        targetUserId: nicknameTargetId,
        nickname: nicknameText.trim(),
      });
      queryClient.invalidateQueries({ queryKey: ['/api/users'] });
      toast({
        title: '🎭 ¡Apodo asignado!',
        description: `"${nicknameText.trim()}" asignado a ${nicknameTargetName} durante 48h`,
      });
      setNicknameModal(null);
    } catch (err: any) {
      toast({ title: 'Error', description: err?.message || 'No se pudo asignar el apodo', variant: 'destructive' });
    } finally {
      setActivatingId(null);
    }
  };

  const filteredUsers = leaderboardUsers.filter(u =>
    !userSearch || u.username.toLowerCase().includes(userSearch.toLowerCase()) || u.name.toLowerCase().includes(userSearch.toLowerCase())
  );

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
    <div className="fixed inset-0 z-[10000] flex items-end justify-center sm:items-center" style={{ paddingBottom: 'calc(3.5rem + env(safe-area-inset-bottom, 0px))' }}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      
      <div className="relative w-full max-w-md mx-auto max-h-[80vh] bg-gray-950 rounded-t-2xl sm:rounded-2xl border border-white/10 overflow-hidden">
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
        <div className="overflow-y-auto max-h-[calc(80vh-60px)] px-5 py-4 space-y-4">
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

      {/* Nickname Modal */}
      {nicknameModal && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/70 backdrop-blur-sm rounded-2xl">
          <div className="w-full max-w-sm mx-4 bg-gray-900 rounded-xl border border-white/10 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-white font-bold flex items-center gap-2">
                <span>✏️</span> Pluma del Troll
              </h3>
              <button onClick={() => setNicknameModal(null)} className="text-white/50 hover:text-white">
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="text-white/50 text-xs">Elige a quién ponerle un apodo público durante 48h</p>

            {/* User selector */}
            <div className="space-y-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-white/30" />
                <input
                  type="text"
                  placeholder="Buscar usuario..."
                  value={userSearch}
                  onChange={e => setUserSearch(e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder-white/30 focus:outline-none focus:border-white/30"
                />
              </div>
              <div className="max-h-32 overflow-y-auto space-y-1">
                {loadingUsers ? (
                  <div className="flex justify-center py-3"><Loader2 className="h-4 w-4 text-white/30 animate-spin" /></div>
                ) : filteredUsers.length === 0 ? (
                  <p className="text-white/30 text-xs text-center py-2">No se encontraron usuarios</p>
                ) : (
                  filteredUsers.map(u => (
                    <button
                      key={u.id}
                      onClick={() => { setNicknameTargetId(u.id); setNicknameTargetName(u.username || u.name); }}
                      className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                        nicknameTargetId === u.id
                          ? 'bg-pink-500/20 text-pink-300 border border-pink-500/30'
                          : 'bg-white/5 text-white/70 hover:bg-white/10 border border-transparent'
                      }`}
                    >
                      <span className="font-medium">{u.username || u.name}</span>
                      {u.name && u.username && <span className="text-white/30 ml-1 text-xs">({u.name})</span>}
                    </button>
                  ))
                )}
              </div>
            </div>

            {/* Nickname input */}
            <div>
              <label className="text-white/50 text-xs mb-1 block">Apodo (máx. 20 caracteres)</label>
              <input
                type="text"
                maxLength={20}
                placeholder="Ej: El Tortuga, Piernas Locas..."
                value={nicknameText}
                onChange={e => setNicknameText(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-white/30 focus:outline-none focus:border-white/30"
              />
              <p className="text-white/20 text-[10px] mt-1">{nicknameText.length}/20</p>
            </div>

            {/* Confirm */}
            <div className="flex gap-2">
              <button
                onClick={() => setNicknameModal(null)}
                className="flex-1 px-3 py-2 rounded-lg text-sm text-white/50 bg-white/5 hover:bg-white/10 transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={handleNicknameConfirm}
                disabled={!nicknameTargetId || !nicknameText.trim() || !!activatingId}
                className="flex-1 px-3 py-2 rounded-lg text-sm font-bold text-white bg-pink-600 hover:bg-pink-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-1"
              >
                {activatingId ? <Loader2 className="h-3 w-3 animate-spin" /> : '✏️ Asignar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export const PowerInventory = memo(PowerInventoryInner);
