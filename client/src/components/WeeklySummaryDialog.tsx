import { useState, useEffect, memo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useCompetition, useLeaderboard } from '@/hooks/use-competition';
import { Trophy, Medal, Target, Footprints, MapPin, Swords, Users, Crown, Star, X } from 'lucide-react';

const WEEKLY_SEEN_KEY = 'weekly_summary_seen';

interface WeeklySummaryData {
  weekNumber: number;
  awards: Record<string, any>;
  leaderboardSnapshot: any[];
  stats?: any;
}

function WeeklySummaryDialogInner() {
  const { isActive, competition, dayOfCompetition } = useCompetition();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  
  // Calculate current week number
  const weekNumber = competition
    ? Math.ceil((dayOfCompetition || 1) / 7)
    : 0;
  
  // Currently just shows after Sunday 8PM — checked by the competition status  
  // For now, check localStorage for last seen week
  useEffect(() => {
    if (!isActive || !competition || weekNumber <= 0) return;
    
    // Check if it's Sunday evening (day 0 = Sunday, after 20:00)
    const now = new Date();
    const isSundayEvening = now.getDay() === 0 && now.getHours() >= 20;
    
    const seenKey = `${WEEKLY_SEEN_KEY}_${competition.id}_${weekNumber}`;
    const seen = localStorage.getItem(seenKey);
    
    if (isSundayEvening && !seen) {
      setOpen(true);
    }
  }, [isActive, competition, weekNumber]);
  
  // Fetch weekly summary data
  const { data: summaryData } = useQuery<{ summary: WeeklySummaryData }>({
    queryKey: ['/api/competition/weekly-summary', String(weekNumber)],
    enabled: open && weekNumber > 0,
  });
  
  const { data: leaderboardData } = useLeaderboard();
  
  const handleClose = () => {
    if (competition && weekNumber > 0) {
      localStorage.setItem(`${WEEKLY_SEEN_KEY}_${competition.id}_${weekNumber}`, 'true');
    }
    setOpen(false);
  };
  
  if (!open) return null;
  
  const summary = summaryData?.summary;
  const awards = summary?.awards || {};
  const leaderboard = leaderboardData?.leaderboard || [];
  
  const AWARD_INFO: Record<string, { emoji: string; title: string; stat: string }> = {
    territory_king: { emoji: '🏆', title: 'Rey del Territorio', stat: 'Más territorio total' },
    conqueror: { emoji: '🗡️', title: 'El Conquistador', stat: 'Más territorio robado' },
    marathon: { emoji: '🏃', title: 'Maratonista', stat: 'Más km recorridos' },
    consistent: { emoji: '📊', title: 'El Constante', stat: 'Más actividades' },
    treasure_hunter: { emoji: '💎', title: 'Cazatesoros', stat: 'Más tesoros recogidos' },
    precise: { emoji: '🎯', title: 'El Preciso', stat: 'Más víctimas únicas' },
    social: { emoji: '🤝', title: 'Alma Social', stat: 'Más carreras juntos' },
    mvp: { emoji: '⚡', title: 'MVP de la Semana', stat: 'Mejor jugador combinado' },
  };
  
  const pages = [
    // Page 1: Week recap title
    <div key="title" className="flex flex-col items-center text-center px-4">
      <div className="text-5xl mb-4">📊</div>
      <h2 className="text-2xl font-black text-white mb-2">
        Semana {weekNumber}
      </h2>
      <p className="text-white/60 text-sm">
        Resumen semanal de {competition?.name}
      </p>
      <div className="mt-6 bg-white/5 rounded-xl p-4 w-full max-w-xs">
        <div className="text-xs text-white/40 uppercase tracking-wider mb-2">Top 3</div>
        {leaderboard.slice(0, 3).map((entry, i) => (
          <div key={entry.userId} className="flex items-center gap-3 py-2">
            <span className="text-lg">{['🥇', '🥈', '🥉'][i]}</span>
            <div className="flex-1 text-left">
              <span className="text-sm font-bold text-white">{entry.user.name}</span>
            </div>
            <span className="text-xs text-white/50 font-mono">
              {(entry.totalArea / 1e6).toFixed(2)} km²
            </span>
          </div>
        ))}
        {leaderboard.length === 0 && (
          <p className="text-white/30 text-xs py-4">Sin datos aún</p>
        )}
      </div>
    </div>,
    
    // Page 2: Awards
    <div key="awards" className="flex flex-col items-center text-center px-2">
      <div className="text-4xl mb-3">🏅</div>
      <h3 className="text-xl font-bold text-white mb-4">Premios de la semana</h3>
      <div className="space-y-2 w-full max-w-xs overflow-y-auto max-h-[50vh]">
        {Object.entries(awards).map(([category, award]: [string, any]) => {
          const info = AWARD_INFO[category] || { emoji: '🏅', title: category, stat: '' };
          const userName = award?.user?.name || award?.userName;
          if (!award || !userName) return null;
          // Format value with unit
          let displayValue = '';
          if (award.value != null) {
            if (award.unit === 'm²') displayValue = `${(award.value / 1e6).toFixed(2)} km²`;
            else if (award.unit === 'm² robados') displayValue = `${(award.value / 1e6).toFixed(2)} km²`;
            else if (award.unit === 'm') displayValue = `${(award.value / 1000).toFixed(1)} km`;
            else displayValue = `${award.value} ${award.unit || ''}`;
          }
          return (
            <div key={category} className="flex items-center gap-3 bg-white/5 rounded-xl px-3 py-2.5">
              <span className="text-2xl">{info.emoji}</span>
              <div className="flex-1 text-left">
                <div className="text-xs font-bold text-white">{info.title}</div>
                <div className="text-[10px] text-white/40">{info.stat}</div>
              </div>
              <div className="text-right">
                <div className="text-xs font-bold text-amber-400">{userName}</div>
                <div className="text-[10px] text-white/30">{displayValue}</div>
              </div>
            </div>
          );
        })}
        {Object.keys(awards).length === 0 && (
          <p className="text-white/30 text-xs py-8">Premios pendientes de calcular</p>
        )}
      </div>
    </div>,
  ];
  
  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={handleClose} />
      
      <div className="relative w-[90%] max-w-sm mx-auto">
        <div className="bg-gradient-to-b from-gray-900 to-gray-950 rounded-2xl border border-white/10 overflow-hidden shadow-2xl">
          {/* Close button */}
          <button
            onClick={handleClose}
            className="absolute top-3 right-3 z-10 text-white/40 hover:text-white transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
          
          {/* Content */}
          <div className="px-6 py-8 min-h-[350px] flex items-center justify-center">
            {pages[page]}
          </div>
          
          {/* Navigation */}
          <div className="flex items-center justify-between px-6 pb-5">
            <div className="flex gap-1.5">
              {pages.map((_, i) => (
                <div
                  key={i}
                  className={`h-1.5 rounded-full transition-all duration-300 ${
                    i === page ? 'w-6 bg-amber-400' : 'w-1.5 bg-white/20'
                  }`}
                />
              ))}
            </div>
            
            {page < pages.length - 1 ? (
              <button
                onClick={() => setPage(p => p + 1)}
                className="px-5 py-2 rounded-full bg-white/10 text-white text-sm font-bold hover:bg-white/20 transition-colors"
              >
                Siguiente
              </button>
            ) : (
              <button
                onClick={handleClose}
                className="px-5 py-2 rounded-full bg-gradient-to-r from-amber-500 to-orange-500 text-white text-sm font-bold transition-colors"
              >
                Cerrar
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export const WeeklySummaryDialog = memo(WeeklySummaryDialogInner);
