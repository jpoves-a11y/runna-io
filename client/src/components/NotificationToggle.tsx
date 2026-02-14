import { useState, useEffect } from 'react';
import { Bell, BellOff, BellRing, Loader2, Send } from 'lucide-react';
import { useSession } from '@/hooks/use-session';
import { API_BASE } from '@/lib/queryClient';
import {
  registerServiceWorker,
  requestNotificationPermission,
  subscribeToPushNotifications,
  unsubscribeFromPushNotifications,
} from '@/lib/pushNotifications';

export function NotificationToggle() {
  const { user } = useSession();
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>('default');

  useEffect(() => {
    if ('Notification' in window) {
      setNotificationPermission(Notification.permission);
    }
    checkSubscriptionStatus();
  }, []);

  async function checkSubscriptionStatus() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      setIsLoading(false);
      return;
    }

    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      setIsSubscribed(!!subscription);
    } catch (error) {
      console.error('Error checking subscription:', error);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleToggleNotifications() {
    if (!user) return;

    setIsLoading(true);

    try {
      if (isSubscribed) {
        const success = await unsubscribeFromPushNotifications(user.id);
        if (success) {
          setIsSubscribed(false);
        }
      } else {
        const permission = await requestNotificationPermission();
        setNotificationPermission(permission);

        if (permission !== 'granted') {
          alert('Debes permitir las notificaciones para recibir alertas de territorio');
          return;
        }

        const registration = await registerServiceWorker();
        if (!registration) {
          alert('No se pudo registrar el service worker');
          return;
        }

        // Wait for service worker to be ready
        await navigator.serviceWorker.ready;

        const success = await subscribeToPushNotifications(registration, user.id);
        if (success) {
          setIsSubscribed(true);
        } else {
          alert('Error al suscribirse a las notificaciones');
        }
      }
    } catch (error) {
      console.error('Error toggling notifications:', error);
      alert('Error al configurar las notificaciones');
    } finally {
      setIsLoading(false);
    }
  }

  if (!user || !('Notification' in window) || !('PushManager' in window)) {
    return null;
  }

  // Permission permanently denied
  if (notificationPermission === 'denied') {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/20 p-3">
        <div className="flex items-center justify-center h-9 w-9 rounded-full bg-red-100 dark:bg-red-900/30">
          <BellOff className="h-4 w-4 text-red-500" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium">Notificaciones bloqueadas</div>
          <div className="text-xs text-muted-foreground">Actívalas en los ajustes de tu dispositivo</div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
    <button
      onClick={handleToggleNotifications}
      disabled={isLoading}
      className={`w-full flex items-center gap-3 rounded-xl border p-3 transition-all active:scale-[0.98] ${
        isSubscribed
          ? 'border-emerald-200 dark:border-emerald-900/40 bg-emerald-50 dark:bg-emerald-950/20'
          : 'border-border/60 bg-muted/30 hover:bg-muted/50'
      }`}
    >
      <div className={`flex items-center justify-center h-9 w-9 rounded-full transition-colors ${
        isSubscribed
          ? 'bg-emerald-100 dark:bg-emerald-900/30'
          : 'bg-muted'
      }`}>
        {isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : isSubscribed ? (
          <BellRing className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <Bell className="h-4 w-4 text-muted-foreground" />
        )}
      </div>
      <div className="flex-1 min-w-0 text-left">
        <div className="text-sm font-medium">
          {isSubscribed ? 'Notificaciones activadas' : 'Activar notificaciones'}
        </div>
        <div className="text-xs text-muted-foreground">
          {isSubscribed
            ? 'Recibirás alertas de conquistas y amigos'
            : 'Recibe alertas cuando te roben territorio'}
        </div>
      </div>
      <div className={`flex-shrink-0 w-11 h-6 rounded-full relative transition-colors ${
        isSubscribed ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-gray-600'
      }`}>
        <div className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
          isSubscribed ? 'translate-x-[22px]' : 'translate-x-0.5'
        }`} />
      </div>
    </button>
    {isSubscribed && (
      <button
        onClick={async () => {
          try {
            const res = await fetch(`${API_BASE}/api/push/test`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ userId: user.id }),
            });
            const data = await res.json();
            if (!res.ok) alert(data.error || 'Error enviando notificación de prueba');
          } catch (e) {
            alert('Error de conexión');
          }
        }}
        className="w-full flex items-center justify-center gap-2 rounded-xl border border-border/60 bg-muted/30 hover:bg-muted/50 p-2.5 text-xs text-muted-foreground transition-all active:scale-[0.98]"
      >
        <Send className="h-3.5 w-3.5" />
        Enviar notificación de prueba
      </button>
    )}
    </div>
  );
}
