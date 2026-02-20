import { useState, useEffect, useRef } from 'react';
import { useLocation } from 'wouter';
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
import { User, Trophy, MapPin, Users, Settings, LogOut, Link2, Unlink, Loader2, RefreshCw, Palette, Camera, Plus, Trash2, Sun, Moon, Monitor, FileText, UserX } from 'lucide-react';
import { SiStrava } from 'react-icons/si';
import { LoadingState } from '@/components/LoadingState';
import { SettingsDialog } from '@/components/SettingsDialog';
import { LoginDialog } from '@/components/LoginDialog';
import { NotificationToggle } from '@/components/NotificationToggle';
import { useTheme } from '@/hooks/use-theme';
import { AvatarDialog } from '@/components/AvatarDialog';
import CircularCropperOverlay from '@/components/CircularCropperOverlay';
import { ConquestStats } from '@/components/ConquestStats';
import { ActivityPreviewDialog } from '@/components/ActivityPreviewDialog';
import { ColorPickerDialog } from '@/components/ColorPickerDialog';
import { useSession } from '@/hooks/use-session';
import { useToast } from '@/hooks/use-toast';
import { useQuery, useMutation } from '@tanstack/react-query';
import { apiRequest, queryClient, API_BASE } from '@/lib/queryClient';
import { USER_COLOR_NAMES } from '@/lib/colors';

// Parse date string safely (handles ISO, Polar format, and legacy format)
function safeFormatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return 'Sin fecha';
  try {
    // Handle numeric timestamps stored as strings (e.g. "1770750442000.0")
    if (/^\d+(\.\d+)?$/.test(dateStr.trim())) {
      const ts = Number(dateStr);
      let date = new Date(ts);
      if (!isNaN(date.getTime()) && date.getFullYear() > 1970 && date.getFullYear() < 2100) {
        return date.toLocaleDateString('es-ES');
      }
      date = new Date(ts * 1000);
      if (!isNaN(date.getTime()) && date.getFullYear() > 1970 && date.getFullYear() < 2100) {
        return date.toLocaleDateString('es-ES');
      }
    }
    const date = new Date(dateStr);
    if (!isNaN(date.getTime())) {
      return date.toLocaleDateString('es-ES');
    }
    const match = dateStr.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (match) return `${match[3]}/${match[2]}/${match[1]}`;
    return dateStr;
  } catch {
    return dateStr || 'Sin fecha';
  }
}

// Convert hex color to readable Spanish name based on HSL
function getColorName(hex: string): string {
  if (!hex || hex.length < 7) return 'Color personalizado';
  
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);

  const rNorm = r / 255;
  const gNorm = g / 255;
  const bNorm = b / 255;

  const max = Math.max(rNorm, gNorm, bNorm);
  const min = Math.min(rNorm, gNorm, bNorm);
  const l = (max + min) / 2;
  const d = max - min;
  
  let s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  }

  let h = 0;
  if (d !== 0) {
    if (max === rNorm) h = ((gNorm - bNorm) / d + (gNorm < bNorm ? 6 : 0)) / 6;
    else if (max === gNorm) h = ((bNorm - rNorm) / d + 2) / 6;
    else h = ((rNorm - gNorm) / d + 4) / 6;
  }

  const hue = h * 360;
  const sat = s * 100;
  const light = l * 100;

  // Grays, black, white
  if (sat < 10) {
    if (light < 15) return 'Negro';
    if (light < 35) return 'Gris oscuro';
    if (light < 65) return 'Gris';
    if (light < 85) return 'Gris claro';
    return 'Blanco';
  }

  // Determine base color name from hue
  let colorName = '';
  if (hue < 15 || hue >= 345) colorName = 'Rojo';
  else if (hue < 45) colorName = 'Naranja';
  else if (hue < 70) colorName = 'Amarillo';
  else if (hue < 150) colorName = 'Verde';
  else if (hue < 190) colorName = 'Turquesa';
  else if (hue < 260) colorName = 'Azul';
  else if (hue < 290) colorName = 'Violeta';
  else if (hue < 345) colorName = 'Rosa';

  // Add lightness modifier
  if (light < 25) return colorName + ' oscuro';
  if (light > 75) return colorName + ' claro';
  
  return colorName;
}

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

interface PolarStatus {
  connected: boolean;
  polarUserId?: number;
  lastSyncAt?: string | null;
}

interface PolarActivity {
  id: string;
  polarExerciseId: string;
  userId: string;
  name: string;
  activityType: string;
  distance: number;
  duration: number;
  startDate: string;
  summaryPolyline: string | null;
  processed: boolean;
  processedAt: string | null;
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  const options: Array<{ value: 'light' | 'dark' | 'system'; label: string; icon: React.ReactNode }> = [
    { value: 'light', label: 'Claro', icon: <Sun className="h-4 w-4" /> },
    { value: 'dark', label: 'Oscuro', icon: <Moon className="h-4 w-4" /> },
    { value: 'system', label: 'Sistema', icon: <Monitor className="h-4 w-4" /> },
  ];

  return (
    <div className="grid grid-cols-3 gap-2">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => setTheme(opt.value)}
          className={`flex flex-col items-center gap-1.5 rounded-xl p-3 text-xs font-medium transition-all border ${
            theme === opt.value
              ? 'bg-primary/10 border-primary text-primary'
              : 'bg-muted/50 border-transparent text-muted-foreground hover:bg-muted'
          }`}
        >
          {opt.icon}
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export default function ProfilePage() {
  const [, navigate] = useLocation();
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isLogoutDialogOpen, setIsLogoutDialogOpen] = useState(false);
  const [isDeleteAccountOpen, setIsDeleteAccountOpen] = useState(false);
  const [isLoginOpen, setIsLoginOpen] = useState(false);
  const [isStravaDisconnectOpen, setIsStravaDisconnectOpen] = useState(false);
  const [isPolarDisconnectOpen, setIsPolarDisconnectOpen] = useState(false);
  const [isPolarDeleteOpen, setIsPolarDeleteOpen] = useState(false);
  const [polarActivityToDelete, setPolarActivityToDelete] = useState<PolarActivity | null>(null);
  const [deletingPolarActivityId, setDeletingPolarActivityId] = useState<string | null>(null);
  const [isAvatarDialogOpen, setIsAvatarDialogOpen] = useState(false);
  const [isCroppingAvatar, setIsCroppingAvatar] = useState(false);
  const [cropImageUrl, setCropImageUrl] = useState<string | null>(null);
  const [cropPendingFile, setCropPendingFile] = useState<File | null>(null);
  const [isColorPickerOpen, setIsColorPickerOpen] = useState(false);
  const [showActivityPreview, setShowActivityPreview] = useState(false);
  const [pendingActivities, setPendingActivities] = useState<PolarActivity[]>([]);
  const [currentPreviewIndex, setCurrentPreviewIndex] = useState(0);
  const [isProcessingActivity, setIsProcessingActivity] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const touchStartY = useRef<number>(0);
  const pullToRefreshThreshold = 80;
  const { toast } = useToast();
  const { user, isLoading, logout, login } = useSession();

  // Strava status query - use explicit queryFn to build correct URL
  const handleRefresh = async () => {
    if (isRefreshing || !user?.id) return;
    
    setIsRefreshing(true);
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['/api/user', user.id] }),
        queryClient.invalidateQueries({ queryKey: [stravaStatusKey] }),
        queryClient.invalidateQueries({ queryKey: [stravaActivitiesKey] }),
        queryClient.invalidateQueries({ queryKey: [polarStatusKey] }),
        queryClient.invalidateQueries({ queryKey: [polarActivitiesKey] }),
      ]);
      await new Promise(resolve => setTimeout(resolve, 500));
    } finally {
      setIsRefreshing(false);
    }
  };

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

        const result = data.results?.[0];
        if (result?.metrics) {
          sessionStorage.setItem('lastConquestResult', JSON.stringify({
            newAreaConquered: result.metrics?.newAreaConquered || 0,
            totalArea: result.metrics?.totalArea || 0,
            areaStolen: result.metrics?.areaStolen || 0,
            routeId: result.routeId,
            routeName: 'Actividad Strava',
            territoryArea: 0,
            summaryPolyline: null,
            distance: 0,
            victims: result.metrics?.victims || [],
          }));
          navigate('/?showConquestResult=true');
        }
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

  // Polar status query
  const polarStatusKey = `/api/polar/status/${user?.id}`;
  const { data: polarStatus, isLoading: isPolarLoading } = useQuery<PolarStatus>({
    queryKey: [polarStatusKey],
    enabled: !!user?.id,
  });

  // Polar activities query
  const polarActivitiesKey = `/api/polar/activities/${user?.id}`;
  const { data: polarActivities, isLoading: isPolarActivitiesLoading } = useQuery<PolarActivity[]>({
    queryKey: [polarActivitiesKey],
    enabled: !!user?.id && polarStatus?.connected,
  });

  // Polar connect mutation
  const connectPolarMutation = useMutation({
    mutationFn: async () => {
      if (!user?.id) {
        throw new Error('Debes iniciar sesión para conectar con Polar');
      }
      console.log('Polar connect mutation started - userId:', user.id);
      const response = await apiRequest('GET', `/api/polar/connect?userId=${user.id}`);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Error al conectar con Polar');
      }
      const data = await response.json();
      console.log('Polar connect response:', data);
      return data;
    },
    onSuccess: (data) => {
      console.log('Polar connect success - data:', data);
      if (data.authUrl) {
        console.log('Redirecting to:', data.authUrl);
        window.location.href = data.authUrl;
      } else {
        console.error('No authUrl in response');
        toast({
          title: "Error",
          description: "No se recibió URL de autorización",
          variant: "destructive",
        });
      }
    },
    onError: (error) => {
      console.error('Polar connect error:', error);
      toast({
        title: "Error al conectar Polar",
        description: error instanceof Error ? error.message : "Inténtalo de nuevo",
        variant: "destructive",
      });
    },
  });

  // Polar disconnect mutation
  const disconnectPolarMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', '/api/polar/disconnect', { userId: user?.id });
      const data = await response.json();
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [polarStatusKey] });
      toast({
        title: 'Polar desconectado',
        description: 'Tu cuenta de Polar ha sido desvinculada',
      });
      setIsPolarDisconnectOpen(false);
    },
    onError: () => {
      toast({
        title: 'Error',
        description: 'No se pudo desconectar Polar',
        variant: 'destructive',
      });
    },
  });

  // Sync Polar activities from API
  const syncPolarMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', `/api/polar/sync/${user?.id}`);
      const data = await response.json();
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: [polarActivitiesKey] });
      queryClient.invalidateQueries({ queryKey: [polarStatusKey] });
      if (data.imported > 0) {
        toast({
          title: 'Actividades sincronizadas',
          description: `Se importaron ${data.imported} nuevas actividades de Polar`,
        });
      } else {
        toast({
          title: 'Sin actividades nuevas',
          description: data.message || 'Todas tus actividades ya estan sincronizadas',
        });
      }
    },
    onError: () => {
      toast({
        title: 'Error',
        description: 'No se pudieron sincronizar las actividades de Polar',
        variant: 'destructive',
      });
    },
  });

  // Process pending Polar activities
  const processPolarMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', `/api/polar/process/${user?.id}`);
      const data = await response.json();
      return data;
    },
    onSuccess: (data) => {
      if (data.processed > 0) {
        queryClient.invalidateQueries({ queryKey: ['/api/territories'] });
        queryClient.invalidateQueries({ queryKey: ['/api/routes', user?.id] });
        queryClient.invalidateQueries({ queryKey: ['/api/user', user?.id] });
        queryClient.invalidateQueries({ queryKey: [polarActivitiesKey] });
        
        if (data.remaining > 0) {
          toast({
            title: 'Procesamiento en lotes',
            description: `${data.processed} procesadas, ${data.remaining} pendientes. Haz click de nuevo para continuar.`,
          });
        } else {
          toast({
            title: 'Actividades procesadas',
            description: data.message || `Se procesaron ${data.processed} actividades de Polar`,
          });
        }
      } else {
        toast({
          title: 'Sin actividades nuevas',
          description: data.message || 'No hay actividades pendientes de procesar',
        });
      }
    },
    onError: (error: any) => {
      toast({
        title: 'Error',
        description: error.message || 'No se pudieron procesar las actividades de Polar',
        variant: 'destructive',
      });
    },
  });

  // Step 1: Sync from Polar, then show preview dialog for unprocessed activities
  const addNewActivityMutation = useMutation({
    mutationFn: async () => {
      if (!user?.id) throw new Error('No user logged in');
      
      // Sync activities from Polar (no processing yet)
      const syncRes = await apiRequest('POST', `/api/polar/sync/${user.id}`);
      const syncData = await syncRes.json();
      return syncData;
    },
    onSuccess: async (syncData) => {
      // Refresh polar activities list to get newly synced ones
      await queryClient.invalidateQueries({ queryKey: [polarActivitiesKey] });
      
      // Wait for refetch to complete and get updated data
      const updatedActivities = await queryClient.fetchQuery<PolarActivity[]>({
        queryKey: [polarActivitiesKey],
      });
      
      // Filter unprocessed activities (these need preview)
      const unprocessed = (updatedActivities || []).filter(a => !a.processed && a.summaryPolyline);
      
      if (unprocessed.length === 0) {
        // Check activities without GPS
        const noGps = (updatedActivities || []).filter(a => !a.processed && !a.summaryPolyline);
        if (noGps.length > 0) {
          toast({
            title: 'Sin datos GPS',
            description: `Se encontraron ${noGps.length} actividades pero ninguna tiene datos de ruta GPS.`,
          });
        } else if (!syncData.imported || syncData.imported === 0) {
          toast({
            title: 'Sin actividades nuevas',
            description: 'No se encontraron actividades nuevas en Polar Flow.',
          });
        } else {
          toast({
            title: 'Actividades ya procesadas',
            description: 'Todas las actividades ya han sido importadas.',
          });
        }
        return;
      }

      // Show preview dialog for unprocessed activities
      setPendingActivities(unprocessed);
      setCurrentPreviewIndex(0);
      setShowActivityPreview(true);
    },
    onError: (error: any) => {
      toast({
        title: 'Error',
        description: error.message || 'No se pudo sincronizar con Polar',
        variant: 'destructive',
      });
    },
  });

  // Navigate to map after import is done
  const finalizeImportNavigation = () => {
    const currentActivity = pendingActivities[currentPreviewIndex];
    setShowActivityPreview(false);
    setPendingActivities([]);
    setCurrentPreviewIndex(0);
    // Use animation if polyline available, otherwise show conquest result directly
    if (currentActivity?.summaryPolyline) {
      navigate('/?animateLatestActivity=true');
    } else {
      navigate('/?showConquestResult=true');
    }
  };

  // Step 2: Process a single activity and navigate to map with animation
  const handleAcceptActivity = async () => {
    if (!user?.id) return;
    
    setIsProcessingActivity(true);
    try {
      const processRes = await apiRequest('POST', `/api/polar/process/${user.id}`);
      const processData = await processRes.json();
      
      // Get current activity data for the animation
      const currentActivity = pendingActivities[currentPreviewIndex];
      
      let hasTauntVictims = false;
      // Store conquest data + polyline for the map animation
      if (processData.results && processData.results.length > 0) {
        const result = processData.results[0];
        const victimsNotified = result.metrics?.victimsNotified || [];
        const areaStolen = result.metrics?.areaStolen || 0;
        hasTauntVictims = victimsNotified.length > 0 && areaStolen > 0;
        sessionStorage.setItem('lastConquestResult', JSON.stringify({
          newAreaConquered: result.metrics?.newAreaConquered || result.area || 0,
          totalArea: result.metrics?.totalArea || 0,
          areaStolen: result.metrics?.areaStolen || 0,
          routeId: result.routeId,
          routeName: currentActivity?.name || 'Actividad',
          territoryArea: result.area || 0,
          summaryPolyline: currentActivity?.summaryPolyline || null,
          distance: currentActivity?.distance || 0,
          victims: result.metrics?.victims || [],
        }));

        // Victims data stored in sessionStorage for ConquestResultModal
      }
      
      // Invalidate queries so map has fresh data
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['/api/territories'] }),
        queryClient.invalidateQueries({ queryKey: ['/api/territories/friends', user.id] }),
        queryClient.invalidateQueries({ queryKey: ['/api/routes', user.id] }),
        queryClient.invalidateQueries({ queryKey: ['/api/user', user.id] }),
        queryClient.invalidateQueries({ queryKey: [polarActivitiesKey] }),
      ]);
      
      setShowActivityPreview(false);
      toast({
        title: 'Actividad importada',
        description: hasTauntVictims ? '¡Has robado territorio!' : 'Redirigiendo al mapa...',
      });
      finalizeImportNavigation();
    } catch (error: any) {
      toast({
        title: 'Error al procesar',
        description: error.message || 'No se pudo procesar la actividad',
        variant: 'destructive',
      });
    } finally {
      setIsProcessingActivity(false);
    }
  };

  const handleSkipActivity = () => {
    if (currentPreviewIndex < pendingActivities.length - 1) {
      setCurrentPreviewIndex(prev => prev + 1);
    } else {
      // No more activities to preview
      setShowActivityPreview(false);
      setPendingActivities([]);
      setCurrentPreviewIndex(0);
      toast({
        title: 'Vista previa cerrada',
        description: 'Puedes importar las actividades pendientes más tarde.',
      });
    }
  };

  const deletePolarActivityMutation = useMutation({
    mutationFn: async (activityId: string) => {
      const response = await apiRequest('DELETE', `/api/polar/activities/${user?.id}/${activityId}`);
      const data = await response.json();
      return data;
    },
    onMutate: (activityId) => {
      setDeletingPolarActivityId(activityId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/territories'] });
      queryClient.invalidateQueries({ queryKey: ['/api/routes'] });
      queryClient.invalidateQueries({ queryKey: ['/api/current-user'] });
      queryClient.invalidateQueries({ queryKey: ['/api/leaderboard'] });
      queryClient.invalidateQueries({ queryKey: [polarActivitiesKey] });
      if (user?.id) {
        queryClient.invalidateQueries({ queryKey: [`/api/strava/activities/${user.id}`] });
      }
      setIsPolarDeleteOpen(false);
      setPolarActivityToDelete(null);
      toast({
        title: 'Actividad eliminada',
        description: 'Se ha recalculado el territorio de todos los usuarios con las actividades restantes. Puedes reimportarla.',
      });
    },
    onError: (error: any) => {
      toast({
        title: 'Error',
        description: error.message || 'No se pudo eliminar la actividad',
        variant: 'destructive',
      });
    },
    onSettled: () => {
      setDeletingPolarActivityId(null);
    },
  });

  // Check for OAuth callback results (Strava and Polar)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    
    // Strava callbacks
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

    // Polar callbacks
    if (params.get('polar_connected') === 'true') {
      toast({
        title: 'Polar conectado',
        description: 'Tu cuenta de Polar ha sido vinculada exitosamente',
      });
      if (user?.id) {
        queryClient.invalidateQueries({ queryKey: [`/api/polar/status/${user.id}`] });
      }
      window.history.replaceState({}, '', window.location.pathname);
    } else if (params.get('polar_error')) {
      const error = params.get('polar_error');
      let message = 'Hubo un problema conectando con Polar';
      if (error === 'denied') message = 'Acceso denegado por el usuario';
      if (error === 'already_linked') message = 'Esta cuenta de Polar ya esta vinculada a otro usuario';
      if (error === 'registration') message = 'Error al registrar usuario en Polar AccessLink';
      toast({
        title: 'Error de Polar',
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

  const deleteAccountMutation = useMutation({
    mutationFn: async () => {
      await apiRequest('DELETE', `/api/users/${user!.id}`);
    },
    onSuccess: () => {
      logout();
      queryClient.clear();
      toast({
        title: 'Cuenta eliminada',
        description: 'Tu cuenta y todos tus datos han sido eliminados permanentemente',
      });
      setIsDeleteAccountOpen(false);
      setIsLoginOpen(true);
    },
    onError: (error: Error) => {
      toast({
        title: 'Error',
        description: error.message || 'No se pudo eliminar la cuenta',
        variant: 'destructive',
      });
    },
  });

  if (isLoading) {
    return <LoadingState message="Cargando perfil..." />;
  }

  if (!user) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-4 max-w-lg mx-auto w-full">
        <div className="text-center space-y-4">
          <div className="relative inline-block">
            <User className="h-16 w-16 mx-auto text-muted-foreground" />
          </div>
          <h2 className="text-xl font-bold">No has iniciado sesion</h2>
          <p className="text-muted-foreground text-sm">
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

  const handleTouchStart = (e: React.TouchEvent) => {
    if (scrollRef.current && scrollRef.current.scrollTop === 0) {
      touchStartY.current = e.touches[0].clientY;
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!scrollRef.current) return;
    
    const touchY = e.touches[0].clientY;
    const pullDistance = touchY - touchStartY.current;
    
    // Only prevent default when at top and pulling down
    if (scrollRef.current.scrollTop === 0 && pullDistance > 0) {
      e.preventDefault();
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (!scrollRef.current || scrollRef.current.scrollTop > 0) return;
    
    const touchY = e.changedTouches[0].clientY;
    const pullDistance = touchY - touchStartY.current;
    
    if (pullDistance > pullToRefreshThreshold) {
      handleRefresh();
    }
    
    touchStartY.current = 0;
  };

  return (
    <div 
      ref={scrollRef}
      className="h-full w-full overflow-y-auto"
      style={{ overscrollBehaviorY: 'none' }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {isRefreshing && (
        <div className="flex justify-center py-2 bg-primary/5">
          <div className="flex items-center gap-2 text-sm text-primary">
            <RefreshCw className="h-4 w-4 animate-spin" />
            Actualizando...
          </div>
        </div>
      )}
      <div className="flex flex-col min-h-full max-w-lg mx-auto w-full px-0">
        <div 
          className="p-4 border-b border-border/50 bg-gradient-to-r from-primary/5 via-transparent to-primary/5"
          style={{ paddingTop: 'calc(1rem + env(safe-area-inset-top, 0px))' }}
        >
          <div className="flex items-center gap-3">
            <div className="relative p-2 rounded-xl bg-primary/10">
              <User className="h-6 w-6 text-primary" />
            </div>
            <div>
              <h1 className="text-xl font-bold">Perfil</h1>
              <p className="text-xs text-muted-foreground">Tu cuenta y ajustes</p>
            </div>
          </div>
        </div>

        <div className="p-4 pb-24 space-y-4">
          <div className="flex flex-col items-center text-center gap-4">
            <button 
              onClick={() => setIsAvatarDialogOpen(true)}
              className="relative group cursor-pointer focus:outline-none focus:ring-4 focus:ring-primary/50 rounded-full transition-all"
            >
              <Avatar className="h-28 w-28 ring-4 ring-offset-4 transition-transform group-hover:scale-105 group-active:scale-95"
                style={{ '--tw-ring-color': user.color } as React.CSSProperties}
              >
                <AvatarImage src={user.avatar || undefined} className="object-cover" />
                <AvatarFallback style={{ backgroundColor: user.color }}>
                  <span className="text-white text-3xl font-bold">
                    {getInitials(user.name)}
                  </span>
                </AvatarFallback>
              </Avatar>
              <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 rounded-full transition-opacity flex items-center justify-center">
                <Camera className="h-8 w-8 text-white" />
              </div>
            </button>
            
            <div>
              <h2 className="text-2xl font-bold">{user.name}</h2>
              <p className="text-muted-foreground">@{user.username}</p>
            </div>

            {user.rank && (
              <button
                type="button"
                onClick={() => navigate('/rankings')}
                className="focus:outline-none focus:ring-2 focus:ring-primary/50 rounded-md"
                aria-label="Ver rankings"
              >
                <Badge variant="secondary" className="gap-1 hover:bg-secondary/80 transition-colors">
                  <Trophy className="h-4 w-4" />
                  Puesto #{user.rank}
                </Badge>
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <button
              type="button"
              onClick={() => navigate('/')}
              className="text-left focus:outline-none focus:ring-2 focus:ring-primary/50 rounded-xl"
              aria-label="Ir al mapa"
            >
              <Card className="p-4 text-center hover:bg-muted/30 transition-colors">
              <div className="flex items-center justify-center mb-2">
                <MapPin className="h-6 w-6 text-primary" />
              </div>
              <p className="text-2xl font-bold" data-testid="text-total-area">
                {(user.totalArea / 1000000).toLocaleString('es-ES', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </p>
              <p className="text-sm text-muted-foreground">km² conquistados</p>
              </Card>
            </button>

            <button
              type="button"
              onClick={() => navigate('/friends')}
              className="text-left focus:outline-none focus:ring-2 focus:ring-primary/50 rounded-xl"
              aria-label="Ir a amigos"
            >
              <Card className="p-4 text-center hover:bg-muted/30 transition-colors">
              <div className="flex items-center justify-center mb-2">
                <Users className="h-6 w-6 text-primary" />
              </div>
              <p className="text-2xl font-bold" data-testid="text-friend-count">
                {user.friendCount || 0}
              </p>
              <p className="text-sm text-muted-foreground">amigos</p>
              </Card>
            </button>
          </div>

          {/* Conquest Stats */}
          <ConquestStats userId={user.id} />

          <Card className="p-4 cursor-pointer hover:bg-muted/30 transition-all active:scale-[0.99]" onClick={() => setIsColorPickerOpen(true)}>
            <div className="flex items-center gap-2 mb-3">
              <Palette className="h-5 w-5 text-primary" />
              <h3 className="font-semibold">Tu color de territorio</h3>
            </div>
            <div className="flex items-center gap-4">
              <div className="relative group">
                <div
                  className="w-14 h-14 rounded-xl shadow-md flex-shrink-0 ring-2 ring-offset-2 ring-primary/30 group-hover:ring-primary/60 transition-all duration-300 group-hover:scale-105"
                  style={{ backgroundColor: user.color }}
                />
                <div
                  className="absolute inset-0 rounded-xl blur-lg opacity-0 group-hover:opacity-30 transition-opacity duration-300"
                  style={{ backgroundColor: user.color }}
                />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-lg" data-testid="text-color-name">
                  {USER_COLOR_NAMES[user.color.toUpperCase()] || USER_COLOR_NAMES[user.color] || getColorName(user.color)}
                </p>
                <p className="text-sm text-muted-foreground">
                  Toca para cambiar tu color
                </p>
              </div>
            </div>
          </Card>

          <Card className="p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold">Notificaciones</h3>
            </div>
            <p className="text-sm text-muted-foreground mb-4">
              Recibe alertas cuando te conquistan territorio
            </p>
            <NotificationToggle />
          </Card>

          <Card className="p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold">Apariencia</h3>
            </div>
            <p className="text-sm text-muted-foreground mb-4">
              Elige el tema de la aplicación
            </p>
            <ThemeToggle />
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

          <Card className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <img src="/polar_icon.png" alt="Polar" className="h-5 w-5 rounded-full" />
              <h3 className="font-semibold">Integracion con Polar</h3>
            </div>
            
            {isPolarLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Cargando...</span>
              </div>
            ) : polarStatus?.connected ? (
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <div className="h-12 w-12 rounded-full bg-[#D4213D] flex items-center justify-center">
                    <img src="/polar_icon.png" alt="Polar" className="h-6 w-6 rounded-full" />
                  </div>
                  <div className="flex-1">
                    <p className="font-medium">Polar Flow</p>
                    <p className="text-sm text-muted-foreground">
                      Usuario ID: {polarStatus.polarUserId}
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
                    onClick={() => addNewActivityMutation.mutate()}
                    disabled={addNewActivityMutation.isPending}
                    data-testid="button-add-new-activity"
                  >
                    {addNewActivityMutation.isPending ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Plus className="h-4 w-4 mr-2" />
                    )}
                    Añadir Nueva Actividad
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setIsPolarDisconnectOpen(true)}
                    className="text-destructive"
                    data-testid="button-disconnect-polar"
                  >
                    <Unlink className="h-4 w-4 mr-2" />
                    Desconectar
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Conecta tu cuenta de Polar Flow para importar automaticamente tus entrenamientos
                </p>
                <Button
                  onClick={() => connectPolarMutation.mutate()}
                  disabled={connectPolarMutation.isPending}
                  className="bg-[#D4213D] text-white"
                  data-testid="button-connect-polar"
                >
                  {connectPolarMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <img src="/polar_icon.png" alt="Polar" className="h-4 w-4 mr-2 rounded-full" />
                  )}
                  Conectar con Polar
                </Button>
              </div>
            )}
          </Card>

          {polarStatus?.connected && (
            <Card className="p-4">
              <div className="flex items-center justify-between gap-2 mb-3">
                <h3 className="font-semibold">Actividades de Polar</h3>
                {polarActivities && polarActivities.length > 0 && (
                  <Badge variant="secondary" className="text-xs">
                    {polarActivities.filter(a => !a.processed).length} pendientes
                  </Badge>
                )}
              </div>
              
              {isPolarActivitiesLoading ? (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Cargando actividades...</span>
                </div>
              ) : polarActivities && polarActivities.length > 0 ? (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {polarActivities.slice(0, 10).map((activity) => (
                    <div 
                      key={activity.id}
                      className="flex items-center justify-between p-2 rounded-md bg-muted/50"
                      data-testid={`polar-activity-${activity.id}`}
                    >
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm truncate">{activity.name}</p>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span>{activity.activityType}</span>
                          <span>{(activity.distance / 1000).toFixed(2)} km</span>
                          <span>{safeFormatDate(activity.startDate)}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge 
                          variant={activity.processed ? "secondary" : "outline"}
                          className={activity.processed ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300" : ""}
                        >
                          {activity.processed ? "Procesado" : "Pendiente"}
                        </Badge>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive"
                          onClick={() => {
                            setPolarActivityToDelete(activity);
                            setIsPolarDeleteOpen(true);
                          }}
                          disabled={deletingPolarActivityId === activity.id}
                          data-testid={`polar-activity-delete-${activity.id}`}
                        >
                          {deletingPolarActivityId === activity.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4" />
                          )}
                        </Button>
                      </div>
                    </div>
                  ))}
                  {polarActivities.length > 10 && (
                    <p className="text-xs text-muted-foreground text-center py-2">
                      +{polarActivities.length - 10} actividades mas
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No hay actividades importadas. Usa "Importar de Polar" para sincronizar tus entrenamientos.
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

            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={() => navigate('/terms')}
            >
              <FileText className="h-5 w-5 mr-2" />
              Términos y Condiciones
            </Button>

            <Button
              variant="outline"
              className="w-full justify-start text-destructive/70 hover:text-destructive hover:border-destructive/50"
              onClick={() => setIsDeleteAccountOpen(true)}
            >
              <UserX className="h-5 w-5 mr-2" />
              Eliminar cuenta
            </Button>
          </div>
        </div>
      </div>

      <SettingsDialog 
        open={isSettingsOpen} 
        onOpenChange={setIsSettingsOpen}
        user={user}
      />

      <AvatarDialog
        open={isAvatarDialogOpen}
        onOpenChange={setIsAvatarDialogOpen}
        currentAvatar={user.avatar}
        userName={user.name}
        userColor={user.color}
        userId={user.id}
        onStartCrop={(url, file) => {
          setCropImageUrl(url);
          setCropPendingFile(file);
          setIsCroppingAvatar(true);
        }}
      />

      {isCroppingAvatar && cropImageUrl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => {
            try { URL.revokeObjectURL(cropImageUrl); } catch {}
            setIsCroppingAvatar(false);
            setCropImageUrl(null);
            setCropPendingFile(null);
          }} />
          <div className="relative w-full max-w-4xl p-6">
            <CircularCropperOverlay
              imageUrl={cropImageUrl}
              exportSize={512}
              fullscreen={true}
              onCancel={() => {
                try { URL.revokeObjectURL(cropImageUrl); } catch {}
                setIsCroppingAvatar(false);
                setCropImageUrl(null);
                setCropPendingFile(null);
              }}
              onSave={async (file) => {
                const formData = new FormData();
                formData.append('avatar', file);
                formData.append('userId', user.id);
                const fullUrl = `${API_BASE}/api/user/avatar`;
                let attempts = 0;
                let lastErr: any = null;
                while (attempts < 2) {
                  attempts += 1;
                  try {
                    const res = await fetch(fullUrl, { method: 'POST', body: formData, credentials: 'include' });
                    const bodyText = await res.text().catch(() => '');
                    const contentType = res.headers.get('content-type') || '';
                    if (!res.ok) {
                      const detail = `status=${res.status} content-type=${contentType} body=${bodyText}`;
                      if (res.status === 503 && attempts < 2) {
                        await new Promise(r => setTimeout(r, 500));
                        continue;
                      }
                      try {
                        const parsed = JSON.parse(bodyText);
                        const msg = parsed?.message || JSON.stringify(parsed);
                        throw new Error(`${msg} (${detail})`);
                      } catch {
                        throw new Error(`${bodyText || 'Upload failed'} (${detail})`);
                      }
                    }

                    // success
                    try { URL.revokeObjectURL(cropImageUrl); } catch {}
                    setIsCroppingAvatar(false);
                    setCropImageUrl(null);
                    setCropPendingFile(null);
                    queryClient.invalidateQueries({ queryKey: ['/api/user', user.id] });
                    toast({ title: '✅ Avatar actualizado', description: 'Tu foto de perfil ha sido actualizada' });
                    return;
                  } catch (err: any) {
                    lastErr = err;
                    if (attempts < 2) await new Promise(r => setTimeout(r, 500));
                  }
                }
                toast({ title: 'Error', description: lastErr?.message || 'Error subiendo avatar', variant: 'destructive' });
              }}
            />
          </div>
        </div>
      )}

      <ColorPickerDialog
        open={isColorPickerOpen}
        onOpenChange={setIsColorPickerOpen}
        currentColor={user.color}
        userId={user.id}
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

      <AlertDialog open={isDeleteAccountOpen} onOpenChange={setIsDeleteAccountOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <UserX className="h-5 w-5" />
              Eliminar cuenta permanentemente
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <span className="block">Esta acción es <strong className="text-destructive">irreversible</strong>. Se eliminarán permanentemente:</span>
              <span className="block pl-4">• Tu perfil y datos personales</span>
              <span className="block pl-4">• Todas tus rutas y actividades</span>
              <span className="block pl-4">• Tus territorios conquistados</span>
              <span className="block pl-4">• Conexiones con Strava/Polar</span>
              <span className="block pl-4">• Amistades y solicitudes</span>
              <span className="block mt-2 font-medium">¿Estás seguro de que deseas continuar?</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction 
              onClick={() => deleteAccountMutation.mutate()}
              className="bg-destructive hover:bg-destructive/90"
              disabled={deleteAccountMutation.isPending}
            >
              {deleteAccountMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : null}
              Eliminar mi cuenta
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

      <AlertDialog open={isPolarDisconnectOpen} onOpenChange={setIsPolarDisconnectOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Desconectar Polar?</AlertDialogTitle>
            <AlertDialogDescription>
              Ya no se importaran tus actividades de Polar automaticamente. Tus rutas y territorios existentes no seran eliminados.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction 
              onClick={() => disconnectPolarMutation.mutate()}
              className="bg-destructive hover:bg-destructive/90"
              disabled={disconnectPolarMutation.isPending}
            >
              {disconnectPolarMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : null}
              Desconectar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={isPolarDeleteOpen} onOpenChange={setIsPolarDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Eliminar actividad de Polar?</AlertDialogTitle>
            <AlertDialogDescription>
              Esto eliminara la actividad importada y recalculara tu territorio. Podras reimportarla con "Añadir Nueva Actividad".
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPolarActivityToDelete(null)}>
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (polarActivityToDelete?.id) {
                  deletePolarActivityMutation.mutate(polarActivityToDelete.id);
                }
              }}
              className="bg-destructive hover:bg-destructive/90"
              disabled={deletePolarActivityMutation.isPending}
            >
              {deletePolarActivityMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : null}
              Eliminar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ActivityPreviewDialog
        open={showActivityPreview}
        onOpenChange={(open) => {
          if (!open) {
            setShowActivityPreview(false);
            setPendingActivities([]);
            setCurrentPreviewIndex(0);
          }
        }}
        activity={pendingActivities[currentPreviewIndex] || null}
        currentIndex={currentPreviewIndex}
        totalCount={pendingActivities.length}
        onAccept={handleAcceptActivity}
        onSkip={handleSkipActivity}
        isProcessing={isProcessingActivity}
      />

      {/* TauntCameraDialog removed from import flow — now only in ConquestResultModal */}
    </div>
  );
}
