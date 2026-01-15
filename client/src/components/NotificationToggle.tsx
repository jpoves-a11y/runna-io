import { useState, useEffect } from 'react';
import { Bell, BellOff } from 'lucide-react';
import { useSession } from '@/hooks/use-session';
import { Button } from './ui/button';
import {
  registerServiceWorker,
  requestNotificationPermission,
  subscribeToPushNotifications,
  unsubscribeFromPushNotifications,
} from '@/lib/pushNotifications';

export function NotificationToggle() {
  const { user } = useSession();
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>('default');

  useEffect(() => {
    if ('Notification' in window) {
      setNotificationPermission(Notification.permission);
    }

    // Check if already subscribed
    checkSubscriptionStatus();
  }, []);

  async function checkSubscriptionStatus() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      return;
    }

    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      setIsSubscribed(!!subscription);
    } catch (error) {
      console.error('Error checking subscription:', error);
    }
  }

  async function handleToggleNotifications() {
    if (!user) return;

    setIsLoading(true);

    try {
      if (isSubscribed) {
        // Unsubscribe
        const success = await unsubscribeFromPushNotifications(user.id);
        if (success) {
          setIsSubscribed(false);
        }
      } else {
        // Subscribe
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

        const success = await subscribeToPushNotifications(registration, user.id);
        if (success) {
          setIsSubscribed(true);
        }
      }
    } catch (error) {
      console.error('Error toggling notifications:', error);
      alert('Error al configurar las notificaciones');
    } finally {
      setIsLoading(false);
    }
  }

  if (!user || !('Notification' in window)) {
    return null;
  }

  return (
    <Button
      variant={isSubscribed ? 'default' : 'outline'}
      size="sm"
      onClick={handleToggleNotifications}
      disabled={isLoading}
      className="gap-2"
    >
      {isSubscribed ? (
        <>
          <Bell className="h-4 w-4" />
          <span className="hidden sm:inline">Notificaciones ON</span>
        </>
      ) : (
        <>
          <BellOff className="h-4 w-4" />
          <span className="hidden sm:inline">Activar notificaciones</span>
        </>
      )}
    </Button>
  );
}
