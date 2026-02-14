// Push Notifications Helper
import { API_BASE } from './queryClient';

// VAPID keys
const VAPID_PUBLIC_KEY = 'BOGRkr2uEzhJfiGZ90GHqrfXfgJX1WjfSCB7pOxaDbA81aSkBNuRLnsjsq-9Jf7ryPq1TMvYDLisOurpJNptkHw';

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) {
    console.warn('Service Workers not supported');
    return null;
  }

  try {
    const registration = await navigator.serviceWorker.register('/service-worker.js');
    console.log('✅ Service Worker registrado');
    return registration;
  } catch (error) {
    console.error('❌ Error registrando SW:', error);
    return null;
  }
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!('Notification' in window)) {
    console.warn('Notifications not supported');
    return 'denied';
  }

  if (Notification.permission === 'granted') {
    return 'granted';
  }

  if (Notification.permission !== 'denied') {
    const permission = await Notification.requestPermission();
    return permission;
  }

  return Notification.permission;
}

export async function subscribeToPushNotifications(
  registration: ServiceWorkerRegistration,
  userId: string
): Promise<boolean> {
  try {
    // Check if already subscribed
    const existingSubscription = await registration.pushManager.getSubscription();
    if (existingSubscription) {
      console.log('Ya existe suscripción push');
      // Send to backend anyway to ensure it's stored
      await sendSubscriptionToBackend(existingSubscription, userId);
      return true;
    }

    // Subscribe to push notifications
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });

    console.log('✅ Suscrito a push notifications');

    // Send subscription to backend
    await sendSubscriptionToBackend(subscription, userId);
    return true;
  } catch (error) {
    console.error('❌ Error subscribing to push:', error);
    return false;
  }
}

async function sendSubscriptionToBackend(
  subscription: PushSubscription,
  userId: string
): Promise<void> {
  const subscriptionJSON = subscription.toJSON();
  
  const response = await fetch(`${API_BASE}/api/push/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId,
      endpoint: subscriptionJSON.endpoint,
      keys: subscriptionJSON.keys,
    }),
  });

  if (!response.ok) {
    throw new Error('Failed to send subscription to backend');
  }
}

export async function unsubscribeFromPushNotifications(userId: string): Promise<boolean> {
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    
    if (!subscription) {
      return true;
    }

    await subscription.unsubscribe();

    // Remove from backend
    await fetch(`${API_BASE}/api/push/unsubscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    });

    console.log('✅ Desuscrito de push notifications');
    return true;
  } catch (error) {
    console.error('❌ Error unsubscribing:', error);
    return false;
  }
}

// Helper function to convert VAPID key
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
