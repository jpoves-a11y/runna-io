import { useState, useEffect, memo } from 'react';
import { useCompetition } from '@/hooks/use-competition';
import { Swords, Trophy, MapPin, Shield, Zap, Eye, Clock, Target, Magnet, Skull, Crown } from 'lucide-react';

const INTRO_SEEN_KEY = 'competition_intro_seen';

function CompetitionIntroDialogInner() {
  const { isActive, competition, dayOfCompetition, totalDays, treasurePowers } = useCompetition();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  
  useEffect(() => {
    if (!isActive || !competition) return;
    const seen = localStorage.getItem(`${INTRO_SEEN_KEY}_${competition.id}`);
    if (!seen) {
      setOpen(true);
    }
  }, [isActive, competition]);
  
  const handleClose = () => {
    if (competition) {
      localStorage.setItem(`${INTRO_SEEN_KEY}_${competition.id}`, 'true');
    }
    setOpen(false);
  };
  
  if (!open || !competition) return null;
  
  const pages = [
    // Page 1: Epic intro
    <div key="intro" className="flex flex-col items-center text-center px-2">
      <div className="text-5xl mb-4">⚔️</div>
      <h2 className="text-2xl font-black text-white mb-2">
        {competition.name}
      </h2>
      <p className="text-white/80 text-sm leading-relaxed max-w-xs">
        Una competición épica de <strong>{totalDays} días</strong> donde todos luchan contra todos. 
        Cada kilómetro que corres conquista territorio. ¡El mapa entero de Zaragoza está en juego!
      </p>
      <div className="flex items-center gap-2 mt-4 bg-white/10 rounded-xl px-4 py-2">
        <Swords className="h-4 w-4 text-amber-300" />
        <span className="text-xs text-amber-200 font-bold">TODOS CONTRA TODOS</span>
        <Swords className="h-4 w-4 text-amber-300" />
      </div>
    </div>,
    
    // Page 2: Rules
    <div key="rules" className="flex flex-col items-center text-center px-2">
      <div className="text-4xl mb-3">🗺️</div>
      <h3 className="text-xl font-bold text-white mb-3">Reglas</h3>
      <div className="space-y-3 text-left w-full max-w-xs">
        <div className="flex items-start gap-3">
          <div className="w-6 h-6 rounded-full bg-emerald-500/30 flex items-center justify-center flex-shrink-0 mt-0.5">
            <MapPin className="h-3.5 w-3.5 text-emerald-300" />
          </div>
          <p className="text-white/80 text-xs leading-relaxed">
            <strong className="text-white">Corre para conquistar.</strong> El área que encierras al correr se convierte en tu territorio.
          </p>
        </div>
        <div className="flex items-start gap-3">
          <div className="w-6 h-6 rounded-full bg-red-500/30 flex items-center justify-center flex-shrink-0 mt-0.5">
            <Target className="h-3.5 w-3.5 text-red-300" />
          </div>
          <p className="text-white/80 text-xs leading-relaxed">
            <strong className="text-white">Roba a CUALQUIERA.</strong> Tu ruta puede cruzar territorio de otro jugador y robárselo.
          </p>
        </div>
        <div className="flex items-start gap-3">
          <div className="w-6 h-6 rounded-full bg-amber-500/30 flex items-center justify-center flex-shrink-0 mt-0.5">
            <Trophy className="h-3.5 w-3.5 text-amber-300" />
          </div>
          <p className="text-white/80 text-xs leading-relaxed">
            <strong className="text-white">Resumen semanal.</strong> Cada domingo a las 20:00 se publica un resumen con premios.
          </p>
        </div>
      </div>
    </div>,
    
    // Page 3: Treasures
    <div key="treasures" className="flex flex-col items-center text-center px-2">
      <div className="text-4xl mb-3">💎</div>
      <h3 className="text-xl font-bold text-white mb-3">Tesoros</h3>
      <p className="text-white/70 text-xs mb-4 max-w-xs">
        Cada día aparecen nuevos tesoros en el mapa de Zaragoza. ¡Pasa corriendo a menos de 100m para recogerlos!
      </p>
      <div className="grid grid-cols-2 gap-2 w-full max-w-xs">
        {[
          { emoji: '🛡️', name: 'Escudo', desc: 'Protege tu territorio 24h', color: 'blue' },
          { emoji: '⚡', name: 'Doble Área', desc: 'x2 en tu próxima carrera', color: 'yellow' },
          { emoji: '💀', name: 'Bomba', desc: 'Trampa que refleja daño', color: 'red' },
          { emoji: '👻', name: 'Invisibilidad', desc: 'Oculta tu territorio 24h', color: 'purple' },
          { emoji: '🧲', name: 'Imán', desc: '+25% territorio', color: 'orange' },
          { emoji: '🔮', name: 'Revelar', desc: 'Ve tesoros ocultos', color: 'cyan' },
          { emoji: '🏴‍☠️', name: 'Saqueo +50%', desc: 'Roba más territorio', color: 'green' },
          { emoji: '🎭', name: 'Renombrar', desc: 'Pon apodo a alguien', color: 'pink' },
        ].map(power => (
          <div key={power.name} className="flex items-center gap-2 bg-white/10 rounded-lg px-2.5 py-2">
            <span className="text-lg">{power.emoji}</span>
            <div className="text-left">
              <div className="text-[10px] font-bold text-white">{power.name}</div>
              <div className="text-[9px] text-white/50">{power.desc}</div>
            </div>
          </div>
        ))}
      </div>
    </div>,
    
    // Page 4: Go!
    <div key="go" className="flex flex-col items-center text-center px-2">
      <div className="text-6xl mb-4">🏆</div>
      <h3 className="text-2xl font-black text-white mb-2">¡A conquistar!</h3>
      <p className="text-white/80 text-sm leading-relaxed max-w-xs mb-4">
        Al final de los {totalDays} días, el jugador con más territorio gana la corona. 
        ¿Tienes lo que hace falta para dominar Zaragoza?
      </p>
      <div className="flex items-center gap-1 text-amber-300">
        <Crown className="h-5 w-5" />
        <Crown className="h-7 w-7" />
        <Crown className="h-5 w-5" />
      </div>
    </div>,
  ];
  
  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={handleClose} />
      
      {/* Content */}
      <div className="relative w-[90%] max-w-sm mx-auto">
        <div className="bg-gradient-to-b from-gray-900 to-gray-950 rounded-2xl border border-white/10 overflow-hidden shadow-2xl">
          {/* Page content */}
          <div className="px-6 py-8 min-h-[320px] flex items-center justify-center">
            {pages[page]}
          </div>
          
          {/* Pagination dots + navigation */}
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
                className="px-5 py-2 rounded-full bg-gradient-to-r from-amber-500 to-orange-500 text-white text-sm font-bold hover:from-amber-400 hover:to-orange-400 transition-colors shadow-lg"
              >
                ¡Vamos!
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export const CompetitionIntroDialog = memo(CompetitionIntroDialogInner);
