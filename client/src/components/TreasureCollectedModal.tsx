import { useState, useEffect, memo } from 'react';

interface CollectedTreasure {
  id: string;
  name: string;
  powerType: string;
  rarity: string;
}

interface TreasureCollectedModalProps {
  treasures: CollectedTreasure[];
  open: boolean;
  onClose: () => void;
}

const RARITY_STYLES: Record<string, { bg: string; border: string; text: string; glow: string }> = {
  common: { bg: 'from-gray-700 to-gray-800', border: 'border-gray-500', text: 'text-gray-300', glow: '' },
  rare: { bg: 'from-blue-700 to-blue-900', border: 'border-blue-400', text: 'text-blue-300', glow: 'shadow-blue-500/30' },
  epic: { bg: 'from-purple-700 to-purple-900', border: 'border-purple-400', text: 'text-purple-300', glow: 'shadow-purple-500/40' },
  legendary: { bg: 'from-amber-600 to-orange-800', border: 'border-amber-400', text: 'text-amber-300', glow: 'shadow-amber-500/50' },
};

const POWER_EMOJIS: Record<string, string> = {
  shield: '🛡️',
  double_area: '⚡',
  nickname: '🎭',
  steal_boost: '🏴‍☠️',
  invisibility: '👻',
  time_bomb: '💀',
  magnet: '🧲',
  reveal: '🔮',
};

function TreasureCollectedModalInner({ treasures, open, onClose }: TreasureCollectedModalProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [animating, setAnimating] = useState(false);
  
  useEffect(() => {
    if (open) {
      setCurrentIndex(0);
      setAnimating(true);
      const timer = setTimeout(() => setAnimating(false), 600);
      return () => clearTimeout(timer);
    }
  }, [open]);
  
  if (!open || treasures.length === 0) return null;
  
  const treasure = treasures[currentIndex];
  const style = RARITY_STYLES[treasure.rarity] || RARITY_STYLES.common;
  const emoji = POWER_EMOJIS[treasure.powerType] || '💎';
  
  const handleNext = () => {
    if (currentIndex < treasures.length - 1) {
      setAnimating(true);
      setTimeout(() => {
        setCurrentIndex(i => i + 1);
        setAnimating(false);
      }, 300);
    } else {
      onClose();
    }
  };
  
  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={handleNext} />
      
      <div className={`relative transform transition-all duration-500 ${
        animating ? 'scale-50 opacity-0' : 'scale-100 opacity-100'
      }`}>
        {/* Glow effect */}
        {treasure.rarity === 'legendary' && (
          <div className="absolute inset-0 -m-8 bg-gradient-to-r from-amber-500/20 via-orange-500/20 to-yellow-500/20 rounded-3xl blur-2xl animate-pulse" />
        )}
        {treasure.rarity === 'epic' && (
          <div className="absolute inset-0 -m-6 bg-purple-500/15 rounded-3xl blur-xl animate-pulse" />
        )}
        
        <div className={`relative bg-gradient-to-b ${style.bg} rounded-2xl border ${style.border} overflow-hidden shadow-2xl ${style.glow} min-w-[280px]`}>
          {/* Header */}
          <div className="text-center pt-6 pb-2">
            <div className="text-xs uppercase tracking-widest font-bold text-white/40 mb-2">
              ¡Tesoro encontrado!
            </div>
            <div className={`text-6xl mb-3 ${animating ? '' : 'animate-bounce'}`}>
              {emoji}
            </div>
            <h3 className="text-xl font-black text-white px-4">
              {treasure.name}
            </h3>
          </div>
          
          {/* Rarity badge */}
          <div className="flex justify-center py-2">
            <span className={`px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${style.text} bg-white/10`}>
              {treasure.rarity}
            </span>
          </div>
          
          {/* Action */}
          <div className="px-6 pb-6 pt-2">
            <p className="text-center text-white/60 text-xs mb-4">
              El poder se ha añadido a tu inventario. ¡Actívalo cuando quieras!
            </p>
            <button
              onClick={handleNext}
              className="w-full py-3 rounded-xl bg-white/15 hover:bg-white/25 text-white font-bold text-sm transition-colors"
            >
              {currentIndex < treasures.length - 1 ? 'Siguiente tesoro' : '¡Genial!'}
            </button>
            {treasures.length > 1 && (
              <div className="flex justify-center gap-1.5 mt-3">
                {treasures.map((_, i) => (
                  <div
                    key={i}
                    className={`h-1 rounded-full transition-all ${
                      i === currentIndex ? 'w-4 bg-white' : 'w-1 bg-white/30'
                    }`}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export const TreasureCollectedModal = memo(TreasureCollectedModalInner);
