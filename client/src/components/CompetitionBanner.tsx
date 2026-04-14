import { useState, useEffect, memo } from 'react';
import { useCompetition } from '@/hooks/use-competition';
import { Trophy, Swords, Clock, Crown, ChevronUp, ChevronDown } from 'lucide-react';

function formatCountdown(ms: number): string {
  if (ms <= 0) return '¡Ya!';
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  
  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m ${seconds}s`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
}

function formatCountdownCompact(ms: number): string {
  if (ms <= 0) return '¡Ya!';
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function CompetitionBannerInner() {
  const { status, competition, timeUntilStart, dayOfCompetition, totalDays, isLoading } = useCompetition();
  const [countdown, setCountdown] = useState<number>(timeUntilStart ?? 0);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('competition_banner_collapsed') === 'true'; } catch { return false; }
  });
  
  // Update countdown every second when upcoming
  useEffect(() => {
    if (status !== 'upcoming' || !timeUntilStart) return;
    setCountdown(timeUntilStart);
    const interval = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1000) {
          clearInterval(interval);
          window.location.reload();
          return 0;
        }
        return prev - 1000;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [status, timeUntilStart]);

  const toggleCollapse = () => {
    setCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem('competition_banner_collapsed', String(next)); } catch {}
      return next;
    });
  };
  
  if (isLoading || status === 'no_competition') return <div style={{ height: 'max(2.5rem, calc(env(safe-area-inset-top, 0px) + 1rem))', minHeight: '2.5rem' }} />;
  
  // UPCOMING: Collapsible countdown
  if (status === 'upcoming' && competition) {
    return (
      <div className="competition-banner relative overflow-hidden cursor-pointer select-none" onClick={toggleCollapse}>
        <div className="absolute inset-0 bg-gradient-to-r from-amber-600 via-orange-500 to-red-600 opacity-95" />
        <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGNpcmNsZSBjeD0iMjAiIGN5PSIyMCIgcj0iMSIgZmlsbD0icmdiYSgyNTUsMjU1LDI1NSwwLjEpIi8+PC9zdmc+')] opacity-30" />
        
        {/* Expanded state */}
        <div
          className="relative z-10 flex flex-col items-center px-4 transition-all duration-300 ease-in-out overflow-hidden"
          style={{
            paddingTop: collapsed ? '0px' : 'max(2.5rem, calc(env(safe-area-inset-top, 0px) + 0.75rem))',
            paddingBottom: collapsed ? '0px' : '0.5rem',
            maxHeight: collapsed ? '0px' : '120px',
            opacity: collapsed ? 0 : 1,
          }}
        >
          <div className="flex items-center gap-2 mb-1">
            <Swords className="h-4 w-4 text-amber-200" />
            <span className="text-xs font-bold uppercase tracking-wider text-amber-100">
              {competition.name}
            </span>
            <Swords className="h-4 w-4 text-amber-200" />
          </div>
          <div className="flex items-center gap-2">
            <Clock className="h-3.5 w-3.5 text-white/80" />
            <span className="text-lg font-bold text-white font-mono tracking-wide">
              {formatCountdown(countdown)}
            </span>
          </div>
          <span className="text-[10px] text-amber-200/70 mt-0.5">
            Comienza pronto...
          </span>
        </div>

        {/* Collapsed compact bar */}
        <div
          className="relative z-10 flex items-center justify-center gap-2 px-4 transition-all duration-300 ease-in-out overflow-hidden"
          style={{
            paddingTop: collapsed ? 'max(2.5rem, calc(env(safe-area-inset-top, 0px) + 0.35rem))' : '0px',
            paddingBottom: collapsed ? '0.35rem' : '0px',
            maxHeight: collapsed ? '60px' : '0px',
            opacity: collapsed ? 1 : 0,
          }}
        >
          <Swords className="h-3 w-3 text-amber-200" />
          <span className="text-[11px] font-bold text-amber-100 uppercase tracking-wide">
            {competition.name}
          </span>
          <span className="text-[11px] font-bold text-white font-mono">
            {formatCountdownCompact(countdown)}
          </span>
          <ChevronDown className="h-3 w-3 text-white/60" />
        </div>

        {/* Toggle hint - only in expanded */}
        {!collapsed && (
          <div className="relative z-10 flex justify-center pb-1">
            <ChevronUp className="h-3 w-3 text-white/40" />
          </div>
        )}
      </div>
    );
  }
  
  // ACTIVE: Show day counter
  if (status === 'active' && competition) {
    return (
      <div className="competition-banner relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-r from-emerald-600 via-green-500 to-teal-600 opacity-95" />
        <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGNpcmNsZSBjeD0iMjAiIGN5PSIyMCIgcj0iMSIgZmlsbD0icmdiYSgyNTUsMjU1LDI1NSwwLjEpIi8+PC9zdmc+')] opacity-30" />
        <div className="relative z-10 flex items-center justify-between py-2.5 px-4" style={{ paddingTop: 'max(2.5rem, calc(env(safe-area-inset-top, 0px) + 0.625rem))' }}>
          <div className="flex items-center gap-2">
            <Trophy className="h-4 w-4 text-yellow-300" />
            <span className="text-sm font-bold text-white">
              {competition.name}
            </span>
          </div>
          <div className="flex items-center gap-1.5 bg-white/20 rounded-full px-3 py-1">
            <span className="text-xs font-bold text-white">
              Día {dayOfCompetition}/{totalDays}
            </span>
          </div>
        </div>
      </div>
    );
  }
  
  // FINISHED: Show podium link
  if (status === 'finished' && competition) {
    return (
      <div className="competition-banner relative overflow-hidden cursor-pointer" onClick={() => {
        window.dispatchEvent(new CustomEvent('show-competition-final'));
      }}>
        <div className="absolute inset-0 bg-gradient-to-r from-purple-600 via-indigo-500 to-blue-600 opacity-95" />
        <div className="relative z-10 flex items-center justify-center gap-2 py-2.5 px-4" style={{ paddingTop: 'max(2.5rem, calc(env(safe-area-inset-top, 0px) + 0.625rem))' }}>
          <Crown className="h-4 w-4 text-yellow-300" />
          <span className="text-sm font-bold text-white">
            ¡{competition.name} ha terminado! Toca para ver resultados
          </span>
          <Crown className="h-4 w-4 text-yellow-300" />
        </div>
      </div>
    );
  }
  
  return null;
}

export const CompetitionBanner = memo(CompetitionBannerInner);
