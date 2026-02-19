import { useMutation, useQuery } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Check, X, Loader2 } from 'lucide-react';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { useToast } from '@/hooks/use-toast';

interface FriendRequestWithSender {
  id: string;
  senderId: string;
  recipientId: string;
  status: string;
  createdAt: string;
  sender: {
    id: string;
    name: string;
    username: string;
    avatar: string | null;
    color: string;
  } | null;
}

interface PendingRequestsProps {
  userId: string;
}

export function PendingRequests({ userId }: PendingRequestsProps) {
  const { toast } = useToast();

  const { data: requests = [], isLoading } = useQuery<FriendRequestWithSender[]>({
    queryKey: ['/api/friends/requests', userId],
    queryFn: async () => {
      const response = await apiRequest('GET', `/api/friends/requests/${userId}`);
      return await response.json();
    },
  });

  const acceptMutation = useMutation({
    mutationFn: async (requestId: string) => {
      const response = await apiRequest('POST', `/api/friends/requests/${requestId}/accept`, {
        userId,
      });
      return await response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['/api/friends/requests', userId] });
      queryClient.invalidateQueries({ queryKey: ['/api/friends', userId] });
      queryClient.invalidateQueries({ queryKey: ['/api/current-user'] });
      if (data.colorChanged) {
        toast({
          title: '✅ Solicitud aceptada',
          description: `Se cambió tu color de territorio automáticamente para evitar conflictos.`,
        });
      } else {
        toast({
          title: '✅ Solicitud aceptada',
          description: 'Ahora son amigos',
        });
      }
    },
    onError: (error: Error) => {
      toast({
        title: 'Error',
        description: error.message || 'No se pudo aceptar la solicitud',
        variant: 'destructive',
      });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: async (requestId: string) => {
      const response = await apiRequest('POST', `/api/friends/requests/${requestId}/reject`, {
        userId,
      });
      return await response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/friends/requests', userId] });
      toast({
        title: 'Solicitud rechazada',
        description: 'Se rechazó la solicitud',
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Error',
        description: error.message || 'No se pudo rechazar la solicitud',
        variant: 'destructive',
      });
    },
  });

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-4">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (requests.length === 0) {
    return null;
  }

  return (
    <Card className="bg-card/80 backdrop-blur-sm">
      <div className="p-3 border-b">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">
            Solicitudes Recibidas
          </h3>
          <Badge variant="secondary">{requests.length}</Badge>
        </div>
      </div>
      <div className="p-2 space-y-2 max-h-[300px] overflow-y-auto">
        {requests.map((request) => (
          <Card key={request.id} className="p-3 bg-muted/50">
            <div className="flex items-center gap-3">
              <Avatar className="h-10 w-10 flex-shrink-0">
                <AvatarImage src={request.sender?.avatar || undefined} />
                <AvatarFallback style={{ backgroundColor: request.sender?.color }}>
                  <span className="text-white font-semibold text-sm">
                    {request.sender ? getInitials(request.sender.name) : '?'}
                  </span>
                </AvatarFallback>
              </Avatar>

              <div className="flex-1 min-w-0">
                <p className="font-semibold truncate text-sm">{request.sender?.name}</p>
                <p className="text-xs text-muted-foreground truncate">
                  @{request.sender?.username}
                </p>
              </div>

              <div className="flex gap-1 flex-shrink-0">
                <Button
                  size="sm"
                  variant="default"
                  onClick={() => acceptMutation.mutate(request.id)}
                  disabled={acceptMutation.isPending || rejectMutation.isPending}
                  className="gradient-primary h-8 w-8 p-0"
                >
                  {acceptMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Check className="h-4 w-4" />
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => rejectMutation.mutate(request.id)}
                  disabled={acceptMutation.isPending || rejectMutation.isPending}
                  className="h-8 w-8 p-0"
                >
                  {rejectMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <X className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </Card>
  );
}
