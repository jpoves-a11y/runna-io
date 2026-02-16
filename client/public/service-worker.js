// Runna.io Service Worker - Minimal version to avoid caching issues
const CACHE_NAME = 'runna-io-v16';

// Install event
self.addEventListener('install', () => {
  self.skipWaiting();
});

// Activate event
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch event - Simple pass-through, no caching
self.addEventListener('fetch', (event) => {
  // Let the browser handle all requests normally
  // This prevents caching issues
  return;
});

// Push notification event
self.addEventListener('push', (event) => {
  let data = { title: 'Runna.io', body: 'Nueva notificación' };
  
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [200, 100, 200],
    tag: data.tag || 'runna-notification',
    requireInteraction: false,
    data: data.data || {}
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// Notification click event
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const urlToOpen = event.notification.data?.url || '/';
  const isTracking = event.notification.data?.type === 'tracking';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        // For tracking notifications, try to focus existing window
        for (const client of clientList) {
          if (client.url.includes(self.registration.scope) && 'focus' in client) {
            return client.focus().then(() => {
              // For tracking, stay on the current tracking view
              if (!isTracking) client.navigate(urlToOpen);
              return client;
            });
          }
        }
        // Open new window
        if (clients.openWindow) {
          return clients.openWindow(urlToOpen);
        }
      })
  );
});
