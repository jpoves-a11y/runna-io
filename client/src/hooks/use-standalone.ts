import { useEffect, useState } from 'react';

// Detectar standalone inmediatamente (antes de React)
function getIsStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as any).standalone === true;
}

export function useStandalone() {
  // Inicializar con el valor real, no con false
  const [isStandalone, setIsStandalone] = useState(getIsStandalone);

  useEffect(() => {
    // Escuchar cambios por si cambia el modo
    const mediaQuery = window.matchMedia('(display-mode: standalone)');
    const handler = (e: MediaQueryListEvent) => setIsStandalone(e.matches);
    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, []);

  return isStandalone;
}
