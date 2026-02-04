import { Loader2 } from 'lucide-react';

interface LoadingStateProps {
  message?: string;
}

export function LoadingState({ message = 'Cargando...' }: LoadingStateProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full min-h-[400px] gap-4">
      <Loader2 className="h-12 w-12 animate-spin text-primary" />
      <p className="text-muted-foreground">{message}</p>
    </div>
  );
}

export function MapSkeleton() {
  return (
    <div className="w-full h-full bg-gradient-to-br from-muted to-muted/50 flex items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="h-12 w-12 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">Cargando mapa...</p>
      </div>
    </div>
  );
}

export function LeaderboardSkeleton() {
  return (
    <div className="p-4 space-y-2">
      {[...Array(8)].map((_, i) => (
        <div
          key={i}
          className="h-20 bg-muted rounded-md animate-pulse"
        />
      ))}
    </div>
  );
}
