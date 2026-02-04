import { Calendar, MapPin, TrendingUp, Flame, Users } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { RouteWithTerritory } from '@shared/schema';
import { formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';

interface ActivityFeedProps {
  routes: RouteWithTerritory[];
}

// Helper to safely parse dates that might be timestamps as strings
function parseDate(value: string | number | Date): Date {
  if (value instanceof Date) return value;
  // Handle timestamps stored as strings (e.g., "1769690860000.0")
  const num = typeof value === 'string' ? parseFloat(value) : value;
  return new Date(num);
}

export function ActivityFeed({ routes }: ActivityFeedProps) {
  const formatDistance = (meters: number) => {
    if (meters < 1000) return `${meters.toFixed(0)} m`;
    return `${(meters / 1000).toFixed(2)} km`;
  };

  const formatDuration = (seconds: number) => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    
    if (hrs > 0) return `${hrs}h ${mins}m`;
    return `${mins}m`;
  };

  return (
    <div className="flex flex-col h-full animate-fade-in">
      {/* Header */}
      <div className="p-4 border-b border-border/50 bg-gradient-to-r from-primary/5 via-transparent to-orange-500/5 animate-slide-down">
        <div className="flex items-center gap-3">
          <div className="relative p-2 rounded-xl bg-primary/10">
            <Calendar className="h-6 w-6 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold">Actividad</h1>
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Flame className="h-3 w-3 text-orange-500" />
              Tu historial de rutas
            </p>
          </div>
        </div>
      </div>

      {/* Activity List */}
      <ScrollArea className="flex-1">
        <div className="p-4 pb-24 space-y-3">
          {routes.length === 0 ? (
            <div className="text-center py-12 animate-scale-in">
              <div className="relative inline-block mb-4">
                <MapPin className="h-20 w-20 mx-auto text-muted-foreground" />
                <div className="absolute inset-0 bg-muted-foreground/10 blur-2xl" />
              </div>
              <h3 className="text-lg font-semibold mb-2">No hay actividades</h3>
              <p className="text-muted-foreground">
                Inicia tu primera ruta para empezar a conquistar territorio
              </p>
            </div>
          ) : (
            routes.map((route, index) => (
              <Card
                key={route.id}
                className="p-4 hover-elevate transition-all duration-300 hover:scale-[1.01] hover:shadow-lg animate-slide-up border-card-border group"
                style={{
                  animationDelay: `${index * 50}ms`,
                }}
                data-testid={`activity-card-${route.id}`}
              >
                <div className="flex items-start gap-3">
                  <div
                    className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0 transition-all duration-300 group-hover:scale-110 group-hover:rotate-6"
                  >
                    <MapPin className="h-6 w-6 text-primary" />
                  </div>

                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold mb-2 text-lg">{route.name}</h3>
                    
                    <div className="flex flex-wrap gap-3 text-sm text-muted-foreground mb-3">
                      <span className="flex items-center gap-1">
                        <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                        {formatDistance(route.distance)}
                      </span>
                      <span>•</span>
                      <span>{formatDuration(route.duration)}</span>
                      <span>•</span>
                      <span>
                        {formatDistanceToNow(parseDate(route.completedAt), {
                          addSuffix: true,
                          locale: es,
                        })}
                      </span>
                    </div>

                    {route.territory && (
                      <Badge 
                        variant="secondary" 
                        className="gap-1.5 animate-bounce-in bg-primary/10 hover:bg-primary/20 transition-colors duration-300"
                      >
                        <TrendingUp className="h-3 w-3 text-primary" />
                        <span className="text-primary font-medium">
                          +{(route.territory.area / 1000000).toLocaleString('es-ES', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })} km² conquistados
                        </span>
                      </Badge>
                    )}

                    {route.ranTogetherWithUsers && route.ranTogetherWithUsers.length > 0 && (
                      <div className="mt-2">
                        <Badge 
                          variant="outline" 
                          className="gap-1.5 bg-green-500/10 border-green-500/30 text-green-700 dark:text-green-400"
                        >
                          <Users className="h-3 w-3" />
                          <span className="font-medium">
                            🏃‍♂️ Corriste junto a {route.ranTogetherWithUsers.map(u => u.name).join(', ')}, ¡mantenéis vuestros km!
                          </span>
                        </Badge>
                      </div>
                    )}
                  </div>
                </div>
              </Card>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
