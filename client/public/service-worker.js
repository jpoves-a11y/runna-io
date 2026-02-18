// Runna.io Service Worker - Optimized caching for performance
const CACHE_NAME = 'runna-io-v17';
const STATIC_CACHE = 'runna-static-v17';
const TILE_CACHE = 'runna-tiles-v17';
const API_CACHE = 'runna-api-v17';
const IMAGE_CACHE = 'runna-images-v17';

// Critical assets to pre-cache for offline support
const STATIC_ASSETS = [
  '/',
  '/index.html',
];

// Install event - pre-cache critical assets
self.addEventListener('install', (event) => {
  self.skipWaiting();
  
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.log('Pre-cache failed for some assets:', err);
      });
    })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  const currentCaches = [CACHE_NAME, STATIC_CACHE, TILE_CACHE, API_CACHE, IMAGE_CACHE];
  
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (!currentCaches.includes(cacheName)) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch event - Strategic caching based on resource type
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Map tiles - CacheFirst (tiles don't change, serve from cache for speed)
  if (url.hostname.includes('cartocdn.com') || url.hostname.includes('openstreetmap.org') || url.pathname.match(/\/(tiles|maps)\//)) {
    event.respondWith(
      caches.open(TILE_CACHE).then((cache) => {
        return cache.match(request).then((cached) => {
          if (cached) {
            return cached;
          }
          return fetch(request).then((response) => {
            // Only cache successful responses
            if (response.ok) {
              cache.put(request, response.clone());
            }
            return response;
          }).catch(() => {
            // Return a placeholder for failed tile loads
            return new Response('', { status: 404 });
          });
        });
      })
    );
    return;
  }

  // Images - CacheFirst with 7-day expiration
  if (request.destination === 'image' || url.pathname.match(/\.(png|jpg|jpeg|svg|gif|webp|ico)$/i)) {
    event.respondWith(
      caches.open(IMAGE_CACHE).then((cache) => {
        return cache.match(request).then((cached) => {
          if (cached) {
            // Check if cache entry is older than 7 days
            const cacheDate = cached.headers.get('sw-cache-date');
            if (cacheDate) {
              const age = Date.now() - parseInt(cacheDate, 10);
              if (age < 7 * 24 * 60 * 60 * 1000) {
                return cached;
              }
            }
          }
          
          return fetch(request).then((response) => {
            if (response.ok) {
              const responseToCache = response.clone();
              const headers = new Headers(responseToCache.headers);
              headers.set('sw-cache-date', Date.now().toString());
              
              responseToCache.blob().then((blob) => {
                cache.put(request, new Response(blob, {
                  status: responseToCache.status,
                  statusText: responseToCache.statusText,
                  headers: headers,
                }));
              });
            }
            return response;
          }).catch(() => {
            return cached || new Response('', { status: 404 });
          });
        });
      })
    );
    return;
  }

  // API calls - NetworkFirst with 10s timeout then cache fallback
  if (url.pathname.startsWith('/api/') || url.hostname.includes('runna-io-api')) {
    event.respondWith(
      caches.open(API_CACHE).then((cache) => {
        return Promise.race([
          fetch(request).then((response) => {
            // Only cache GET requests with successful responses
            if (request.method === 'GET' && response.ok) {
              cache.put(request, response.clone());
            }
            return response;
          }),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('timeout')), 10000)
          )
        ]).catch(() => {
          // Network failed or timed out - try cache
          return cache.match(request).then((cached) => {
            if (cached) {
              return cached;
            }
            // No cache available
            return new Response(JSON.stringify({ error: 'Offline' }), {
              status: 503,
              headers: { 'Content-Type': 'application/json' }
            });
          });
        });
      })
    );
    return;
  }

  // JS/CSS assets - StaleWhileRevalidate (use cache, update in background)
  if (request.destination === 'script' || request.destination === 'style' || 
      url.pathname.match(/\.(js|css)$/i)) {
    event.respondWith(
      caches.open(STATIC_CACHE).then((cache) => {
        return cache.match(request).then((cached) => {
          const fetchPromise = fetch(request).then((response) => {
            if (response.ok) {
              cache.put(request, response.clone());
            }
            return response;
          });
          
          // Return cached version immediately, but update cache in background
          return cached || fetchPromise;
        });
      })
    );
    return;
  }

  // Default - network only for everything else
  event.respondWith(fetch(request));
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
