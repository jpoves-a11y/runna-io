import { useState, useEffect } from 'react';
import { Card } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { User, Trophy, MapPin, Users, Settings, LogOut, Link2, Unlink, Loader2, RefreshCw } from 'lucide-react';
import { SiStrava } from 'react-icons/si';
import { LoadingState } from '@/components/LoadingState';
import { SettingsDialog } from '@/components/SettingsDialog';
import { LoginDialog } from '@/components/LoginDialog';
import { useSession } from '@/hooks/use-session';
import { useToast } from '@/hooks/use-toast';
import { useQuery, useMutation } from '@tanstack/react-query';
import { apiRequest, queryClient } from '@/lib/queryClient';

interface StravaStatus {
  connected: boolean;
  athleteData?: {
    firstname?: string;
    lastname?: string;
    profile_medium?: string;
    city?: string;
    country?: string;
  };
  lastSyncAt?: string | null;
}

interface StravaActivity {
  id: string;
  stravaActivityId: number;
  userId: string;
  name: string;
  activityType: string;
  distance: number;
  duration: number;
  startDate: string;
  processed: boolean;
  processedAt: string | null;
}

export default function ProfilePage() {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isLogoutDialogOpen, setIsLogoutDialogOpen] = useState(false);
  const [isLoginOpen, setIsLoginOpen] = useState(false);
  const [isStravaDisconnectOpen, setIsStravaDisconnectOpen] = useState(false);
  const { toast } = useToast();
  const { user, isLoading, logout, login } = useSession();

  // Strava status query - use explicit queryFn to build correct URL
  const stravaStatusKey = `/api/strava/status/${user?.id}`;
  const { data: stravaStatus, isLoading: isStravaLoading } = useQuery<StravaStatus>({
    queryKey: [stravaStatusKey],
    enabled: !!user?.id,
  });

  // Strava activities query
  const stravaActivitiesKey = `/api/strava/activities/${user?.id}`;
  const { data: stravaActivities, isLoading: isActivitiesLoading } = useQuery<StravaActivity[]>({
    queryKey: [stravaActivitiesKey],
    enabled: !!user?.id && stravaStatus?.connected,
  });

  // Strava connect mutation
  const connectStravaMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('GET', `/api/strava/connect?userId=${user?.id}`);
      const data = await response.json();
      return data;
    },
    onSuccess: (data) => {
      if (data.authUrl) {
        window.location.href = data.authUrl;
      }
    },
    onError: () => {
      toast({
        title: 'Error',
        description: 'No se pudo conectar con Strava',
        variant: 'destructive',
      });
    },
  });

  // Strava disconnect mutation
  const disconnectStravaMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', '/api/strava/disconnect', { userId: user?.id });
      const data = await response.json();
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [stravaStatusKey] });
      toast({
        title: 'Strava desconectado',
        description: 'Tu cuenta de Strava ha sido desvinculada',
      });
      setIsStravaDisconnectOpen(false);
    },
    onError: () => {
      toast({
        title: 'Error',
        description: 'No se pudo desconectar Strava',
        variant: 'destructive',
      });
    },
  });

  // Process pending Strava activities
  const processMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', `/api/strava/process/${user?.id}`);
      const data = await response.json();
      return data;
    },
    onSuccess: (data) => {
      if (data.processed > 0) {
        queryClient.invalidateQueries({ queryKey: ['/api/territories'] });
        queryClient.invalidateQueries({ queryKey: ['/api/routes', user?.id] });
        queryClient.invalidateQueries({ queryKey: ['/api/user', user?.id] });
        queryClient.invalidateQueries({ queryKey: [stravaActivitiesKey] });
        toast({
          title: 'Actividades procesadas',
          description: `Se procesaron ${data.processed} actividades de Strava`,
        });
      } else {
        toast({
          title: 'Sin actividades nuevas',
          description: 'No hay actividades pendientes de procesar',
        });
      }
    },
    onError: () => {
      toast({
        title: 'Error',
        description: 'No se pudieron procesar las actividades',
        variant: 'destructive',
      });
    },
  });

  // Sync Strava activities from API
  const syncMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', `/api/strava/sync/${user?.id}`);
      const data = await response.json();
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: [stravaActivitiesKey] });
      queryClient.invalidateQueries({ queryKey: [stravaStatusKey] });
      if (data.imported > 0) {
        toast({
          title: 'Actividades sincronizadas',
          description: `Se importaron ${data.imported} nuevas actividades de Strava`,
        });
      } else {
        toast({
          title: 'Sin actividades nuevas',
          description: 'Todas tus actividades ya estan sincronizadas',
        });
      }
    },
    onError: () => {
      toast({
        title: 'Error',
        description: 'No se pudieron sincronizar las actividades',
        variant: 'destructive',
      });
    },
  });

  // Check for Strava OAuth callback results
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('strava_connected') === 'true') {
      toast({
        title: 'Strava conectado',
        description: 'Tu cuenta de Strava ha sido vinculada exitosamente',
      });
      if (user?.id) {
        queryClient.invalidateQueries({ queryKey: [`/api/strava/status/${user.id}`] });
      }
      window.history.replaceState({}, '', window.location.pathname);
    } else if (params.get('strava_error')) {
      const error = params.get('strava_error');
      let message = 'Hubo un problema conectando con Strava';
      if (error === 'denied') message = 'Acceso denegado por el usuario';
      if (error === 'already_linked') message = 'Esta cuenta de Strava ya esta vinculada a otro usuario';
      toast({
        title: 'Error de Strava',
        description: message,
        variant: 'destructive',
      });
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [toast, user?.id]);

  const handleLogout = () => {
    logout();
    toast({
      title: 'Sesion cerrada',
      description: 'Has cerrado sesion exitosamente',
    });
    setIsLogoutDialogOpen(false);
    setIsLoginOpen(true);
  };

  if (isLoading) {
    return <LoadingState message="Cargando perfil..." />;
  }

  if (!user) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6">
        <div className="text-center space-y-4">
          <div className="relative inline-block">
            <User className="h-20 w-20 mx-auto text-muted-foreground" />
          </div>
          <h2 className="text-2xl font-bold">No has iniciado sesion</h2>
          <p className="text-muted-foreground">
            Inicia sesion para acceder a tu perfil
          </p>
          <Button
            onClick={() => setIsLoginOpen(true)}
            data-testid="button-login-prompt"
          >
            Iniciar sesion
          </Button>
        </div>
        <LoginDialog open={isLoginOpen} onOpenChange={setIsLoginOpen} onLogin={login} />
      </div>
    );
  }

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col min-h-full">
        <div className="p-6 border-b border-border bg-gradient-to-br from-primary/5 to-transparent">
          <h1 className="text-3xl font-bold flex items-center gap-3">
            <User className="h-8 w-8 text-primary" />
            Perfil
          </h1>
        </div>

        <div className="p-6 space-y-6">
          <div className="flex flex-col items-center text-center gap-4">
            <div className="relative group">
              <Avatar className="h-28 w-28 ring-4 ring-offset-4"
                style={{ '--tw-ring-color': user.color } as React.CSSProperties}
              >
                <AvatarImage src={user.avatar || undefined} />
                <AvatarFallback style={{ backgroundColor: user.color }}>
                  <span className="text-white text-3xl font-bold">
                    {getInitials(user.name)}
                  </span>
                </AvatarFallback>
              </Avatar>
            </div>
            
            <div>
              <h2 className="text-2xl font-bold">{user.name}</h2>
              <p className="text-muted-foreground">@{user.username}</p>
            </div>

            {user.rank && (
              <Badge variant="secondary" className="gap-1">
                <Trophy className="h-4 w-4" />
                Puesto #{user.rank}
              </Badge>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Card className="p-4 text-center">
              <div className="flex items-center justify-center mb-2">
                <MapPin className="h-6 w-6 text-primary" />
              </div>
              <p className="text-2xl font-bold" data-testid="text-total-area">
                {user.totalArea.toLocaleString('es-ES', {
                  maximumFractionDigits: 0,
                })}
              </p>
              <p className="text-sm text-muted-foreground">m2 conquistados</p>
            </Card>

            <Card className="p-4 text-center">
              <div className="flex items-center justify-center mb-2">
                <Users className="h-6 w-6 text-primary" />
              </div>
              <p className="text-2xl font-bold" data-testid="text-friend-count">
                {user.friendCount || 0}
              </p>
              <p className="text-sm text-muted-foreground">amigos</p>
            </Card>
          </div>

          <Card className="p-4">
            <h3 className="font-semibold mb-3">Tu color de territorio</h3>
            <div className="flex items-center gap-3">
              <div
                className="w-16 h-16 rounded-xl border-2 border-border shadow-lg"
                style={{ backgroundColor: user.color }}
              />
              <div className="flex-1">
                <p className="font-medium text-lg">{user.color}</p>
                <p className="text-sm text-muted-foreground">
                  Este color representa tus conquistas en el mapa
                </p>
              </div>
            </div>
          </Card>

          <Card className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <SiStrava className="h-5 w-5 text-[#FC4C02]" />
              <h3 className="font-semibold">Integracion con Strava</h3>
            </div>
            
            {isStravaLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Cargando...</span>
              </div>
            ) : stravaStatus?.connected ? (
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <Avatar className="h-12 w-12">
                    <AvatarImage src={stravaStatus.athleteData?.profile_medium} />
                    <AvatarFallback className="bg-[#FC4C02] text-white">
                      {stravaStatus.athleteData?.firstname?.[0] || 'S'}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1">
                    <p className="font-medium">
                      {stravaStatus.athleteData?.firstname} {stravaStatus.athleteData?.lastname}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {stravaStatus.athleteData?.city && stravaStatus.athleteData?.country
                        ? `${stravaStatus.athleteData.city}, ${stravaStatus.athleteData.country}`
                        : 'Cuenta conectada'}
                    </p>
                  </div>
                  <Badge variant="secondary" className="bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300">
                    <Link2 className="h-3 w-3 mr-1" />
                    Conectado
                  </Badge>
                </div>
                
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => syncMutation.mutate()}
                    disabled={syncMutation.isPending}
                    data-testid="button-sync-strava"
                  >
                    {syncMutation.isPending ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4 mr-2" />
                    )}
                    Importar de Strava
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => processMutation.mutate()}
                    disabled={processMutation.isPending}
                    data-testid="button-process-strava"
                  >
                    {processMutation.isPending ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <MapPin className="h-4 w-4 mr-2" />
                    )}
                    Procesar territorios
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setIsStravaDisconnectOpen(true)}
                    className="text-destructive"
                    data-testid="button-disconnect-strava"
                  >
                    <Unlink className="h-4 w-4 mr-2" />
                    Desconectar
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Conecta tu cuenta de Strava para importar automaticamente tus carreras y caminatas
                </p>
                <Button
                  onClick={() => connectStravaMutation.mutate()}
                  disabled={connectStravaMutation.isPending}
                  className="bg-[#FC4C02] text-white"
                  data-testid="button-connect-strava"
                >
                  {connectStravaMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <SiStrava className="h-4 w-4 mr-2" />
                  )}
                  Conectar con Strava
                </Button>
              </div>
            )}
          </Card>

          {stravaStatus?.connected && (
            <Card className="p-4">
              <div className="flex items-center justify-between gap-2 mb-3">
                <h3 className="font-semibold">Actividades de Strava</h3>
                {stravaActivities && stravaActivities.length > 0 && (
                  <Badge variant="secondary" className="text-xs">
                    {stravaActivities.filter(a => !a.processed).length} pendientes
                  </Badge>
                )}
              </div>
              
              {isActivitiesLoading ? (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Cargando actividades...</span>
                </div>
              ) : stravaActivities && stravaActivities.length > 0 ? (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {stravaActivities.slice(0, 10).map((activity) => (
                    <div 
                      key={activity.id}
                      className="flex items-center justify-between p-2 rounded-md bg-muted/50"
                      data-testid={`strava-activity-${activity.id}`}
                    >
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm truncate">{activity.name}</p>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span>{activity.activityType}</span>
                          <span>{(activity.distance / 1000).toFixed(2)} km</span>
                          <span>{new Date(activity.startDate).toLocaleDateString('es-ES')}</span>
                        </div>
                      </div>
                      <Badge 
                        variant={activity.processed ? "secondary" : "outline"}
                        className={activity.processed ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300" : ""}
                      >
                        {activity.processed ? "Procesado" : "Pendiente"}
                      </Badge>
                    </div>
                  ))}
                  {stravaActivities.length > 10 && (
                    <p className="text-xs text-muted-foreground text-center py-2">
                      +{stravaActivities.length - 10} actividades mas
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No hay actividades importadas. Usa "Importar de Strava" para sincronizar tus entrenamientos.
                </p>
              )}
            </Card>
          )}

          <div className="space-y-3">
            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={() => setIsSettingsOpen(true)}
              data-testid="button-settings"
            >
              <Settings className="h-5 w-5 mr-2" />
              Configuracion
            </Button>
            
            <Button
              variant="outline"
              className="w-full justify-start text-destructive hover:text-destructive"
              onClick={() => setIsLogoutDialogOpen(true)}
              data-testid="button-logout"
            >
              <LogOut className="h-5 w-5 mr-2" />
              Cerrar sesion
            </Button>
          </div>
        </div>
      </div>

      <SettingsDialog 
        open={isSettingsOpen} 
        onOpenChange={setIsSettingsOpen}
        user={user}
      />

      <AlertDialog open={isLogoutDialogOpen} onOpenChange={setIsLogoutDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cerrar sesion?</AlertDialogTitle>
            <AlertDialogDescription>
              Tendras que iniciar sesion nuevamente para acceder a tu cuenta
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction 
              onClick={handleLogout}
              className="bg-destructive hover:bg-destructive/90"
            >
              Cerrar sesion
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <LoginDialog open={isLoginOpen} onOpenChange={setIsLoginOpen} onLogin={login} />

      <AlertDialog open={isStravaDisconnectOpen} onOpenChange={setIsStravaDisconnectOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Desconectar Strava?</AlertDialogTitle>
            <AlertDialogDescription>
              Ya no se importaran tus actividades de Strava automaticamente. Tus rutas y territorios existentes no seran eliminados.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction 
              onClick={() => disconnectStravaMutation.mutate()}
              className="bg-destructive hover:bg-destructive/90"
              disabled={disconnectStravaMutation.isPending}
            >
              {disconnectStravaMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : null}
              Desconectar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ScrollArea>
  );
}
