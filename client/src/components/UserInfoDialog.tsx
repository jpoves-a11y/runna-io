import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { apiRequest } from '@/lib/queryClient';

interface Props {
  userId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function UserInfoDialog({ userId, open, onOpenChange }: Props) {
  const { data, refetch } = useQuery({
    queryKey: ['user-stats', userId],
    queryFn: async () => {
      if (!userId) throw new Error('No userId');
      const res = await apiRequest('GET', `/api/users/${userId}/stats`);
      if (!res.ok) throw new Error('Failed to fetch stats');
      return await res.json();
    },
    enabled: !!userId && open,
    staleTime: 1000 * 60,
  });

  useEffect(() => {
    if (open && userId) {
      refetch();
    }
  }, [open, userId, refetch]);

  const stats: any = data || {};
  const totalAreaKm2 = ((stats.totalArea || 0) / 1000000).toFixed(2);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full max-w-sm">
        <DialogHeader>
          <DialogTitle>Información de usuario</DialogTitle>
          <DialogDescription>
            Datos públicos y actividad reciente
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center gap-4 pb-4 border-b">
            <Avatar className="h-16 w-16 flex-shrink-0">
              <AvatarImage src={stats.user?.avatar || undefined} alt={stats.user?.name} />
              <AvatarFallback style={{ backgroundColor: stats.user?.color || '#333' }}>
                {stats.user?.name ? stats.user.name.split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase() : '?'}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <div className="font-semibold text-base truncate">{stats.user?.name || 'Usuario'}</div>
              <div className="text-sm text-muted-foreground truncate">@{stats.user?.username || 'unknown'}</div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground font-medium">Área total</div>
              <div className="text-xl font-bold">{totalAreaKm2}</div>
              <div className="text-xs text-muted-foreground">km²</div>
            </div>
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground font-medium">Actividades</div>
              <div className="text-xl font-bold">{stats.activitiesCount ?? 0}</div>
            </div>
            <div className="space-y-1 col-span-2">
              <div className="text-xs text-muted-foreground font-medium">Última actividad</div>
              <div className="text-sm font-medium">
                {stats.lastActivity 
                  ? new Date(stats.lastActivity).toLocaleString('es-ES', { 
                      year: 'numeric', 
                      month: 'short', 
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit'
                    })
                  : 'Sin actividad'}
              </div>
            </div>
            <div className="space-y-1 col-span-2">
              <div className="text-xs text-muted-foreground font-medium">Área robada / robada</div>
              <div className="text-sm font-medium text-muted-foreground">Por implementar</div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
