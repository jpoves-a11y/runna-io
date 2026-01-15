import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { X } from "lucide-react";

interface SentRequest {
  id: string;
  senderId: string;
  recipientId: string;
  status: string;
  createdAt: string;
  recipient: {
    id: string;
    name: string;
    username: string;
    avatar?: string;
    color: string;
  } | null;
}

interface SentRequestsProps {
  userId: string;
}

export default function SentRequests({ userId }: SentRequestsProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: sentRequests = [], isLoading } = useQuery<SentRequest[]>({
    queryKey: ['/api/friends/requests/sent', userId],
    queryFn: async () => {
      const response = await apiRequest('GET', `/api/friends/requests/sent/${userId}`);
      return await response.json();
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async (requestId: string) => {
      const response = await apiRequest('DELETE', `/api/friends/requests/${requestId}`);
      return await response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/friends/requests/sent', userId] });
      toast({
        title: "Solicitud cancelada",
        description: "La solicitud de amistad ha sido cancelada",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "No se pudo cancelar la solicitud",
        variant: "destructive",
      });
    },
  });

  const pendingRequests = sentRequests.filter(req => req.status === 'pending');

  if (isLoading) {
    return null;
  }

  if (pendingRequests.length === 0) {
    return null;
  }

  return (
    <Card className="bg-card/80 backdrop-blur-sm">
      <div className="p-3 border-b">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">
            Solicitudes Enviadas
          </h3>
          <Badge variant="secondary">{pendingRequests.length}</Badge>
        </div>
      </div>
      <div className="p-2 space-y-2 max-h-[300px] overflow-y-auto">
        {pendingRequests.map((request) => (
          <Card key={request.id} className="p-3 bg-muted/50">
            <div className="flex items-center gap-3">
              {request.recipient?.avatar ? (
                <img
                  src={request.recipient.avatar}
                  alt={request.recipient.name}
                  className="w-10 h-10 rounded-full flex-shrink-0"
                />
              ) : (
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold flex-shrink-0 text-sm"
                  style={{ backgroundColor: request.recipient?.color || '#666' }}
                >
                  {request.recipient?.name.charAt(0).toUpperCase()}
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm truncate">{request.recipient?.name}</p>
                <p className="text-xs text-muted-foreground truncate">@{request.recipient?.username}</p>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <span className="text-xs text-muted-foreground">Pendiente</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => cancelMutation.mutate(request.id)}
                  disabled={cancelMutation.isPending}
                  className="h-8 w-8 p-0"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </Card>
  );
}
