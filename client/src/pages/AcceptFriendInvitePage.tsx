import { useEffect, useState } from 'react';
import { useRoute, useLocation } from 'wouter';
import { useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { LoadingState } from '@/components/LoadingState';
import { Users, CheckCircle, XCircle, Loader2, AlertTriangle, Palette } from 'lucide-react';
import { useSession } from '@/hooks/use-session';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { useToast } from '@/hooks/use-toast';

export default function AcceptFriendInvitePage() {
  const [, params] = useRoute('/friends/accept/:token');
  const [, setLocation] = useLocation();
  const { user: currentUser, isLoading: userLoading } = useSession();
  const [status, setStatus] = useState<'loading' | 'success' | 'error' | 'same_color' | 'pending'>('pending');
  const { toast } = useToast();

  const acceptInviteMutation = useMutation({
    mutationFn: async () => {
      if (!params?.token) throw new Error('Token no válido');
      const res = await apiRequest('POST', `/api/friends/accept/${params.token}`, { userId: currentUser?.id });
      if (!res.ok) {
        const err = await res.json();
        if (err.error === 'SAME_COLOR') {
          throw new Error('SAME_COLOR');
        }
        throw new Error(err.error || err.message || 'Error al aceptar invitación');
      }
      return res;
    },
    onSuccess: () => {
      setStatus('success');
      queryClient.invalidateQueries({ queryKey: ['/api/friends', currentUser?.id] });
      toast({
        title: '🎉 ¡Amigo agregado!',
        description: 'Ahora puedes competir juntos',
        className: 'animate-bounce-in',
      });
      setTimeout(() => {
        setLocation('/friends');
      }, 2000);
    },
    onError: (error: Error) => {
      if (error.message === 'SAME_COLOR') {
        setStatus('same_color');
        toast({
          title: '⚠️ Mismo color de territorio',
          description: 'Cambia tu color antes de aceptar esta invitación.',
          variant: 'destructive',
        });
      } else {
        setStatus('error');
        toast({
          title: 'Error',
          description: error.message || 'No se pudo aceptar la invitación',
          variant: 'destructive',
        });
      }
    },
  });

  useEffect(() => {
    if (!userLoading && currentUser && status === 'pending') {
      setStatus('loading');
      acceptInviteMutation.mutate();
    }
  }, [userLoading, currentUser, status]);

  if (userLoading) {
    return <LoadingState message="Cargando..." />;
  }

  if (!currentUser) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6 animate-fade-in">
        <Card className="max-w-md w-full p-8 text-center space-y-6">
          <div className="relative inline-block">
            <Users className="h-20 w-20 mx-auto text-primary" />
            <div className="absolute inset-0 bg-primary/20 blur-2xl" />
          </div>
          
          <div className="space-y-2">
            <h2 className="text-2xl font-bold">Invitación de amigo</h2>
            <p className="text-muted-foreground">
              Inicia sesión o regístrate para aceptar esta invitación
            </p>
          </div>

          <div className="space-y-2">
            <Button
              onClick={() => setLocation('/login')}
              className="w-full gradient-primary"
            >
              Iniciar sesión
            </Button>
            <Button
              onClick={() => setLocation('/register')}
              variant="outline"
              className="w-full"
            >
              Registrarse
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  if (status === 'loading') {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6 animate-fade-in">
        <Card className="max-w-md w-full p-8 text-center space-y-6">
          <Loader2 className="h-16 w-16 mx-auto text-primary animate-spin" />
          <div className="space-y-2">
            <h2 className="text-2xl font-bold">Aceptando invitación...</h2>
            <p className="text-muted-foreground">
              Un momento por favor
            </p>
          </div>
        </Card>
      </div>
    );
  }

  if (status === 'success') {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6 animate-fade-in">
        <Card className="max-w-md w-full p-8 text-center space-y-6">
          <div className="relative inline-block">
            <CheckCircle className="h-20 w-20 mx-auto text-green-500" />
            <div className="absolute inset-0 bg-green-500/20 blur-2xl animate-pulse" />
          </div>
          
          <div className="space-y-2">
            <h2 className="text-2xl font-bold">¡Invitación aceptada!</h2>
            <p className="text-muted-foreground">
              Ahora son amigos. Redirigiendo...
            </p>
          </div>
        </Card>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6 animate-fade-in">
        <Card className="max-w-md w-full p-8 text-center space-y-6">
          <div className="relative inline-block">
            <XCircle className="h-20 w-20 mx-auto text-destructive" />
            <div className="absolute inset-0 bg-destructive/20 blur-2xl" />
          </div>
          
          <div className="space-y-2">
            <h2 className="text-2xl font-bold">Error al aceptar</h2>
            <p className="text-muted-foreground">
              El link puede haber expirado o ya fue usado
            </p>
          </div>

          <Button
            onClick={() => setLocation('/friends')}
            className="w-full gradient-primary"
          >
            Ir a Amigos
          </Button>
        </Card>
      </div>
    );
  }

  if (status === 'same_color') {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6 animate-fade-in">
        <Card className="max-w-md w-full p-8 text-center space-y-6">
          <div className="relative inline-block">
            <AlertTriangle className="h-20 w-20 mx-auto text-amber-500" />
            <div className="absolute inset-0 bg-amber-500/20 blur-2xl" />
          </div>
          
          <div className="space-y-2">
            <h2 className="text-2xl font-bold">Mismo color de territorio</h2>
            <p className="text-muted-foreground">
              Tú y esta persona tenéis el mismo color de territorio. Cambia tu color en tu perfil y vuelve a intentarlo.
            </p>
          </div>

          <div className="space-y-2">
            <Button
              onClick={() => setLocation('/profile')}
              className="w-full gradient-primary"
            >
              <Palette className="h-4 w-4 mr-2" />
              Ir a cambiar mi color
            </Button>
            <Button
              onClick={() => {
                setStatus('pending');
              }}
              variant="outline"
              className="w-full"
            >
              Reintentar
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return null;
}
