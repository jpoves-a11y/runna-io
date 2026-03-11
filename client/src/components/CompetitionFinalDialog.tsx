import { useState, useEffect, memo } from 'react';
import { useCompetition, useLeaderboard } from '@/hooks/use-competition';
import { Crown, Trophy, Medal, X } from 'lucide-react';

const FINAL_SEEN_KEY = 'competition_final_seen';

function CompetitionFinalDialogInner() {
  const { isFinished, competition } = useCompetition();
  const { data: leaderboardData } = useLeaderboard();
  const [open, setOpen] = useState(false);
  
  useEffect(() => {
    if (!isFinished || !competition) return;
    const seen = localStorage.getItem(`${FINAL_SEEN_KEY}_${competition.id}`);
    if (!seen) {
      setOpen(true);
    }
  }, [isFinished, competition]);
  
  // Also listen for custom event from CompetitionBanner click
  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener('show-competition-final', handler);
    return () => window.removeEventListener('show-competition-final', handler);
  }, []);
  
  const handleClose = () => {
    if (competition) {
      localStorage.setItem(`${FINAL_SEEN_KEY}_${competition.id}`, 'true');
    }
    setOpen(false);
  };
  
  if (!open || !competition) return null;
  
  const leaderboard = leaderboardData?.leaderboard || [];
  const top3 = leaderboard.slice(0, 3);
  const rest = leaderboard.slice(3, 10);
  
  const podiumOrder = [1, 0, 2]; // Silver, Gold, Bronze position order
  const podiumHeights = ['h-28', 'h-40', 'h-20'];
  const podiumColors = ['bg-gradient-to-t from-gray-400 to-gray-300', 'bg-gradient-to-t from-yellow-500 to-amber-400', 'bg-gradient-to-t from-orange-700 to-orange-500'];
  const podiumEmojis = ['🥈', '🥇', '🥉'];
  
  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/85 backdrop-blur-md" onClick={handleClose} />
      
      <div className="relative w-[92%] max-w-sm mx-auto max-h-[90vh] overflow-y-auto">
        <div className="bg-gradient-to-b from-gray-900 via-gray-950 to-black rounded-2xl border border-amber-500/20 overflow-hidden shadow-2xl">
          {/* Close */}
          <button onClick={handleClose} className="absolute top-3 right-3 z-10 text-white/40 hover:text-white">
            <X className="h-5 w-5" />
          </button>
          
          {/* Title */}
          <div className="text-center pt-8 pb-4 px-6">
            <div className="flex items-center justify-center gap-1 mb-3">
              <Crown className="h-6 w-6 text-amber-400" />
              <Crown className="h-8 w-8 text-amber-300" />
              <Crown className="h-6 w-6 text-amber-400" />
            </div>
            <h2 className="text-xl font-black text-white mb-1">
              ¡{competition.name} ha terminado!
            </h2>
            <p className="text-white/40 text-xs">Resultados finales</p>
          </div>
          
          {/* Podium */}
          {top3.length >= 1 && (
            <div className="px-6 pb-6">
              <div className="flex items-end justify-center gap-2">
                {podiumOrder.map((index, visualPos) => {
                  const entry = top3[index];
                  if (!entry) return <div key={visualPos} className="w-[30%]" />;
                  
                  return (
                    <div key={entry.userId} className="w-[30%] flex flex-col items-center">
                      {/* Avatar circle */}
                      <div
                        className="w-12 h-12 rounded-full flex items-center justify-center font-bold text-white text-sm mb-2 shadow-lg"
                        style={{ background: entry.user.color || '#666' }}
                      >
                        {entry.user.name?.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
                      </div>
                      <span className="text-[10px] font-bold text-white/80 truncate max-w-full mb-1">
                        {(entry.user as any).nickname ? `🎭 ${(entry.user as any).nickname}` : entry.user.name}
                      </span>
                      <span className="text-[9px] text-white/40 font-mono mb-2">
                        {(() => { const km2 = entry.totalArea / 1e6; if (km2 >= 0.05) return `${km2.toFixed(2)} km²`; return `${Math.round(entry.totalArea)} m²`; })()}
                      </span>
                      {/* Podium bar */}
                      <div className={`w-full ${podiumHeights[visualPos]} ${podiumColors[visualPos]} rounded-t-lg flex items-start justify-center pt-2`}>
                        <span className="text-2xl">{podiumEmojis[visualPos]}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          
          {/* Rest of leaderboard */}
          {rest.length > 0 && (
            <div className="px-6 pb-6">
              <div className="space-y-1.5">
                {rest.map((entry, i) => (
                  <div key={entry.userId} className="flex items-center gap-3 bg-white/5 rounded-lg px-3 py-2">
                    <span className="text-xs font-bold text-white/30 w-5 text-right">
                      {i + 4}
                    </span>
                    <div
                      className="w-7 h-7 rounded-full flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0"
                      style={{ background: entry.user.color || '#666' }}
                    >
                      {entry.user.name?.[0]?.toUpperCase() || '?'}
                    </div>
                    <span className={`text-xs font-medium flex-1 truncate ${(entry.user as any).nickname ? 'text-pink-400' : 'text-white'}`}>
                      {(entry.user as any).nickname ? `🎭 ${(entry.user as any).nickname}` : entry.user.name}
                    </span>
                    <span className="text-xs text-white/40 font-mono">
                      {(() => { const km2 = entry.totalArea / 1e6; if (km2 >= 0.05) return `${km2.toFixed(2)} km²`; return `${Math.round(entry.totalArea)} m²`; })()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          
          {leaderboard.length === 0 && (
            <div className="text-center py-12 text-white/30 text-sm">
              Sin resultados
            </div>
          )}
          
          {/* Close button */}
          <div className="px-6 pb-6">
            <button
              onClick={handleClose}
              className="w-full py-3 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 text-white font-bold text-sm hover:from-amber-400 hover:to-orange-400 transition-colors shadow-lg"
            >
              ¡Ha sido épico!
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export const CompetitionFinalDialog = memo(CompetitionFinalDialogInner);
