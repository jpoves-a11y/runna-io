import { useState, useEffect, memo, useCallback } from 'react';
import { useCompetition } from '@/hooks/use-competition';
import { Swords, Clock } from 'lucide-react';

const ANNOUNCEMENT_SEEN_KEY = 'competition_announcement_seen';

// Gate: set to null to show to everyone, or array of user IDs to restrict
const ALLOWED_USER_IDS: string[] | null = null; // Show to all users

function getUserIdFromStorage(): string | null {
  try {
    return localStorage.getItem('runna_user_id');
  } catch {
    return null;
  }
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return '¡Ya!';
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h ${minutes}m ${seconds}s`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function CompetitionAnnouncementDialogInner() {
  const { isUpcoming, competition, timeUntilStart, status } = useCompetition();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [closing, setClosing] = useState(false);
  const [countdown, setCountdown] = useState<number>(timeUntilStart ?? 0);

  useEffect(() => {
    if (status !== 'upcoming' || !competition) return;

    // Read userId synchronously from localStorage (no need to wait for session query)
    const userId = getUserIdFromStorage();
    if (!userId) return;

    // User gate check
    if (ALLOWED_USER_IDS !== null && !ALLOWED_USER_IDS.includes(userId)) return;

    const key = `${ANNOUNCEMENT_SEEN_KEY}_${competition.id}`;
    const seen = localStorage.getItem(key);
    if (!seen) {
      setOpen(true);
    }
  }, [status, competition]);

  // Countdown timer
  useEffect(() => {
    if (!timeUntilStart) return;
    setCountdown(timeUntilStart);
    const interval = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1000) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1000;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [timeUntilStart]);

  const handleClose = useCallback(() => {
    if (competition) {
      localStorage.setItem(`${ANNOUNCEMENT_SEEN_KEY}_${competition.id}`, 'true');
    }
    setClosing(true);
    // Let the exit animation play, then unmount
    setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, 600);
  }, [competition]);

  if (!open || !competition) return null;

  const pages = [
    // Page 1: Epic teaser
    <div key="teaser" className="flex flex-col items-center text-center px-4">
      <div className="text-6xl mb-5 animate-pulse">⚔️</div>
      <h2 className="text-sm font-bold uppercase tracking-[0.2em] text-amber-300/80 mb-3">
        Algo se acerca...
      </h2>
      <h1 className="text-[1.7rem] leading-tight font-black text-white mb-4">
        La Primera Conquista<br />del Ebro
      </h1>
      <p className="text-white/75 text-[0.82rem] leading-relaxed max-w-[280px]">
        Este <strong className="text-white">lunes 2 de marzo</strong>, a las <strong className="text-white">9:00</strong>, se desata una batalla de{' '}
        <strong className="text-white">28 días</strong> donde{' '}
        <strong className="text-amber-300">todos luchan contra todos</strong>.
      </p>
      <p className="text-white/60 text-[0.78rem] leading-relaxed max-w-[280px] mt-3">
        Cada kilómetro que corras conquista territorio real en el mapa de Zaragoza.
        ¿Tienes lo que hace falta para dominar la ciudad?
      </p>
      <div className="flex items-center gap-2 mt-5 bg-white/10 rounded-xl px-4 py-2.5 border border-white/5">
        <Swords className="h-4 w-4 text-amber-300" />
        <span className="text-[0.7rem] text-amber-200 font-bold uppercase tracking-wider">Todos contra todos</span>
        <Swords className="h-4 w-4 text-amber-300" />
      </div>
    </div>,

    // Page 2: Treasure map tease + countdown
    <div key="treasures" className="flex flex-col items-center text-center px-4">
      <div className="text-5xl mb-4">🗺️</div>
      <h2 className="text-xl font-black text-white mb-3">
        El Mapa del Tesoro
      </h2>
      <p className="text-white/75 text-[0.82rem] leading-relaxed max-w-[280px] mb-2">
        Pero no solo de correr vive el conquistador...
      </p>
      <p className="text-white/60 text-[0.78rem] leading-relaxed max-w-[280px] mb-5">
        Cada día aparecerán <strong className="text-white">tesoros ocultos</strong> por toda Zaragoza.
        Escudos, bombas, poderes secretos... Pasa corriendo cerca de ellos para recogerlos
        y úsalos para proteger tu territorio o destruir el de tus rivales.
      </p>
      <div className="flex flex-wrap justify-center gap-2 mb-6">
        {[
          { emoji: '🛡️', label: 'Escudos' },
          { emoji: '💀', label: 'Bombas' },
          { emoji: '👻', label: 'Invisibilidad' },
          { emoji: '🧲', label: 'Imanes' },
          { emoji: '⚡', label: 'Poderes' },
        ].map(item => (
          <span key={item.label} className="inline-flex items-center gap-1 bg-white/10 rounded-lg px-2.5 py-1.5 text-[0.7rem] text-white/70">
            <span className="text-sm">{item.emoji}</span> {item.label}
          </span>
        ))}
      </div>

      {/* Embedded countdown */}
      <div className="w-full bg-gradient-to-r from-amber-600/30 via-orange-500/30 to-red-600/30 border border-amber-500/20 rounded-xl px-4 py-3">
        <div className="flex items-center justify-center gap-2 mb-1">
          <Clock className="h-3.5 w-3.5 text-amber-300/80" />
          <span className="text-[0.65rem] uppercase tracking-wider font-bold text-amber-300/80">
            Cuenta atrás
          </span>
        </div>
        <div className="text-xl font-black text-white font-mono tracking-wider">
          {formatCountdown(countdown)}
        </div>
      </div>

      <p className="text-amber-300/70 text-[0.72rem] font-bold mt-4">
        El lunes empieza todo.
      </p>
    </div>,
  ];

  return (
    <div
      className={`fixed inset-0 z-[10001] flex items-center justify-center transition-all duration-500 ${
        closing ? 'opacity-0 translate-y-4 scale-95' : 'opacity-100 translate-y-0 scale-100'
      }`}
    >
      {/* Backdrop */}
      <div
        className={`absolute inset-0 bg-black/85 backdrop-blur-md transition-opacity duration-500 ${
          closing ? 'opacity-0' : 'opacity-100'
        }`}
        onClick={handleClose}
      />

      {/* Content card */}
      <div
        className={`relative w-[92%] max-w-sm mx-auto transition-all duration-500 ease-out ${
          closing ? 'translate-y-8 opacity-0 scale-90' : 'translate-y-0 opacity-100 scale-100'
        }`}
      >
        <div className="bg-gradient-to-b from-gray-900 via-gray-900 to-gray-950 rounded-2xl border border-amber-500/15 overflow-hidden shadow-[0_0_60px_rgba(245,158,11,0.1)]">
          {/* Decorative top stripe */}
          <div className="h-1 bg-gradient-to-r from-amber-500 via-orange-500 to-red-500" />

          {/* Page content */}
          <div className="px-5 py-8 min-h-[380px] flex items-center justify-center">
            {pages[page]}
          </div>

          {/* Pagination + navigation */}
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
                className="px-5 py-2.5 rounded-full bg-white/10 text-white text-sm font-bold hover:bg-white/20 transition-colors active:scale-95"
              >
                Siguiente
              </button>
            ) : (
              <button
                onClick={handleClose}
                className="px-5 py-2.5 rounded-full bg-gradient-to-r from-amber-500 to-orange-500 text-white text-sm font-bold hover:from-amber-400 hover:to-orange-400 transition-all shadow-lg shadow-amber-500/20 active:scale-95"
              >
                ¡Entendido!
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export const CompetitionAnnouncementDialog = memo(CompetitionAnnouncementDialogInner);
