import { useState, useEffect, memo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useCompetition, useLeaderboard } from '@/hooks/use-competition';
import { Trophy, Medal, Target, Footprints, MapPin, Swords, Users, Crown, Star, X } from 'lucide-react';
import { formatArea } from '@/lib/formatArea';

const WEEKLY_SEEN_KEY = 'weekly_summary_seen';

interface WeeklySummaryData {
  weekNumber: number;
  awards: Record<string, any>;
  leaderboardSnapshot: any[];
  stats?: any;
}

// Listen for global event to open weekly summary manually
let globalOpenFn: (() => void) | null = null;

export function openWeeklySummary() {
  globalOpenFn?.();
}

function WeeklySummaryDialogInner() {
  const { isActive, competition, dayOfCompetition } = useCompetition();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  
  // Calculate current week number (client-side, based on competition day)
  const currentWeekNumber = competition
    ? Math.ceil((dayOfCompetition || 1) / 7)
    : 0;
  
  // The summary is generated on Sunday evening, so the summary for "week N" is stored with
  // the weekNumber that was current at generation time. When the user opens the app on 
  // Monday-Wednesday, dayOfCompetition has already incremented to the next week.
  // We need to fetch the PREVIOUS week's summary if we're in the first days of a new week.
  // Strategy: try currentWeekNumber first, then currentWeekNumber - 1
  const [summaryWeek, setSummaryWeek] = useState(currentWeekNumber);
  
  // Auto-open: extended window from Sunday 8PM through Wednesday midnight (3+ days of grace)
  useEffect(() => {
    if (!isActive || !competition || currentWeekNumber <= 0) return;
    
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0=Sunday, 1=Mon, 2=Tue, 3=Wed
    const hour = now.getHours();
    
    // Show from Sunday 20:00 through Wednesday 23:59
    const isInWindow = 
      (dayOfWeek === 0 && hour >= 20) || // Sunday evening
      dayOfWeek === 1 || // Monday all day
      dayOfWeek === 2 || // Tuesday all day
      dayOfWeek === 3;   // Wednesday all day
    
    // Use the previous week's summary number if we're already in the next week (Mon-Wed)
    const targetWeek = dayOfWeek >= 1 && dayOfWeek <= 3 
      ? Math.max(1, currentWeekNumber - 1) 
      : currentWeekNumber;
    setSummaryWeek(targetWeek);
    
    const seenKey = `${WEEKLY_SEEN_KEY}_${competition.id}_${targetWeek}`;
    const seen = localStorage.getItem(seenKey);
    
    if (isInWindow && !seen) {
      setOpen(true);
    }
  }, [isActive, competition, currentWeekNumber]);
  
  // Register global open function for manual trigger
  useEffect(() => {
    globalOpenFn = () => {
      if (!isActive || !competition) return;
      // For manual open, try current week first, then previous
      const targetWeek = currentWeekNumber > 1 ? currentWeekNumber - 1 : currentWeekNumber;
      setSummaryWeek(targetWeek);
      setPage(0);
      setOpen(true);
    };
    return () => { globalOpenFn = null; };
  }, [isActive, competition, currentWeekNumber]);
  
  // Fetch weekly summary data — try summaryWeek, fallback to summaryWeek-1
  const { data: summaryData } = useQuery<{ summary: WeeklySummaryData | null; weekNumber: number }>({
    queryKey: ['/api/competition/weekly-summary', String(summaryWeek)],
    enabled: open && summaryWeek > 0,
  });
  
  // If primary week returns null, try the previous week
  const { data: fallbackData } = useQuery<{ summary: WeeklySummaryData | null; weekNumber: number }>({
    queryKey: ['/api/competition/weekly-summary', String(summaryWeek - 1)],
    enabled: open && summaryWeek > 1 && summaryData?.summary === null,
  });
  
  const { data: leaderboardData } = useLeaderboard();
  
  const handleClose = () => {
    if (competition && summaryWeek > 0) {
      localStorage.setItem(`${WEEKLY_SEEN_KEY}_${competition.id}_${summaryWeek}`, 'true');
      // Also mark fallback week as seen
      if (summaryWeek > 1) {
        localStorage.setItem(`${WEEKLY_SEEN_KEY}_${competition.id}_${summaryWeek - 1}`, 'true');
      }
    }
    setOpen(false);
  };
  
  if (!open) return null;
  
  const activeSummary = summaryData?.summary || fallbackData?.summary;
  const displayWeek = summaryData?.summary ? summaryWeek : (fallbackData?.summary ? summaryWeek - 1 : summaryWeek);
  const awards = activeSummary?.awards || {};
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

  // Format area values in awards properly (m² for small, km² for large)
  function formatAwardValue(award: any): string {
    if (award.value == null) return '';
    if (award.unit === 'm²' || award.unit === 'm² robados') return formatArea(award.value);
    if (award.unit === 'm') {
      const km = award.value / 1000;
      return `${km.toFixed(1)} km`;
    }
    return `${award.value} ${award.unit || ''}`;
  }
  
  const pages = [
    // Page 1: Week recap title
    <div key="title" className="flex flex-col items-center text-center px-4">
      <div className="text-5xl mb-4">📊</div>
      <h2 className="text-2xl font-black text-white mb-2">
        Semana {displayWeek}
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
              <span className={`text-sm font-bold ${(entry.user as any).nickname ? 'text-pink-400' : 'text-white'}`}>
                {(entry.user as any).nickname ? `🎭 ${(entry.user as any).nickname}` : entry.user.name}
              </span>
            </div>
            <span className="text-xs text-white/50 font-mono">
              {formatArea(entry.totalArea)}
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
          const displayValue = formatAwardValue(award);
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
