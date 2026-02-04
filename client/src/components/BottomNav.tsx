import { Map, Trophy, Activity, User, Users } from 'lucide-react';
import { Link, useLocation } from 'wouter';
import { useStandalone } from '@/hooks/use-standalone';

const navItems = [
  { path: '/', label: 'Mapa', icon: Map },
  { path: '/rankings', label: 'Rankings', icon: Trophy },
  { path: '/activity', label: 'Actividad', icon: Activity },
  { path: '/friends', label: 'Amigos', icon: Users },
  { path: '/profile', label: 'Perfil', icon: User },
];

export function BottomNav() {
  const [location] = useLocation();
  const isStandalone = useStandalone();

  const isPathActive = (path: string) => {
    if (path === '/') {
      return location === '/' || location.startsWith('/?');
    }
    return location === path;
  };

  // En PWA standalone, usar un padding mínimo (4px) en vez del safe-area completo
  const bottomPadding = isStandalone ? '4px' : 'env(safe-area-inset-bottom, 0px)';
  const navHeight = isStandalone ? 'calc(3.5rem + 4px)' : 'calc(3.5rem + env(safe-area-inset-bottom, 0px))';

  return (
    <nav 
      className="fixed bottom-0 left-0 right-0 bg-background/95 backdrop-blur-xl border-t border-border/50 z-50 shadow-lg shadow-black/5 dark:shadow-black/20"
      style={{ 
        height: navHeight,
        paddingBottom: bottomPadding
      }}
    >
      <div className="flex items-stretch justify-around h-[3.5rem]">
        {navItems.map((item) => {
          const isActive = isPathActive(item.path);
          const Icon = item.icon;
          
          return (
            <Link
              key={item.path}
              href={item.path}
              data-testid={`nav-${item.label.toLowerCase()}`}
              className="flex-1 flex items-center justify-center min-h-[48px]"
            >
              <div
                className={`flex flex-col items-center justify-center gap-0.5 py-1.5 px-2 rounded-2xl transition-all duration-300 touch-manipulation ${
                  isActive 
                    ? 'text-primary bg-primary/10' 
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/30 active:scale-95'
                }`}
              >
                <Icon className={`h-5 w-5 transition-transform duration-200 ${isActive ? 'stroke-[2.5] scale-110' : 'stroke-[1.75]'}`} />
                <span className={`text-[9px] leading-tight transition-all duration-200 ${isActive ? 'font-bold' : 'font-medium opacity-80'}`}>
                  {item.label}
                </span>
              </div>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
