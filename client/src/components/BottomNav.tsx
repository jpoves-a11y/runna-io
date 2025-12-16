import { Map, Trophy, Activity, User } from 'lucide-react';
import { Link, useLocation } from 'wouter';

const navItems = [
  { path: '/', label: 'Mapa', icon: Map },
  { path: '/rankings', label: 'Rankings', icon: Trophy },
  { path: '/activity', label: 'Actividad', icon: Activity },
  { path: '/profile', label: 'Perfil', icon: User },
];

export function BottomNav() {
  const [location] = useLocation();

  const isPathActive = (path: string) => {
    if (path === '/') {
      return location === '/' || location.startsWith('/?');
    }
    return location === path;
  };

  return (
    <nav 
      className="fixed bottom-0 left-0 right-0 bg-card/98 backdrop-blur-xl border-t border-border z-50"
      style={{ 
        height: 'calc(4.5rem + env(safe-area-inset-bottom, 0px))',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)'
      }}
    >
      <div className="flex items-stretch justify-around h-[4.5rem] max-w-md mx-auto px-2">
        {navItems.map((item) => {
          const isActive = isPathActive(item.path);
          const Icon = item.icon;
          
          return (
            <Link
              key={item.path}
              href={item.path}
              data-testid={`nav-${item.label.toLowerCase()}`}
              className="flex-1 flex items-center justify-center"
            >
              <div
                className={`flex flex-col items-center justify-center gap-0.5 py-1 px-3 rounded-xl transition-all duration-200 ${
                  isActive ? 'text-primary' : 'text-muted-foreground active:bg-muted/50'
                }`}
              >
                <div className={`p-1.5 rounded-lg transition-all duration-200 ${isActive ? 'bg-primary/15' : ''}`}>
                  <Icon className={`h-5 w-5 ${isActive ? 'stroke-[2.5]' : 'stroke-[1.75]'}`} />
                </div>
                <span className={`text-[10px] leading-tight ${isActive ? 'font-bold' : 'font-medium'}`}>
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
