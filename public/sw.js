// PulseBLR Service Worker
// v2 — network-first for pages/API so the app shell is NEVER served stale.
// (v1 precached "/" and served navigations cache-first, which poisoned the
//  browser with stale HTML pointing at dead JS chunks → infinite spinner.)
const STATIC_CACHE = 'pulseblr-static-v2';
const DYNAMIC_CACHE = 'pulseblr-dynamic-v2';

// Only truly-immutable, hand-authored assets are precached.
// The app shell ("/", "/tracker", ...) is intentionally NOT precached.
const STATIC_ASSETS = [
  '/manifest.json',
  '/icon-192.svg',
  '/icon-512.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(STATIC_ASSETS.map(url => new Request(url, { cache: 'reload' }))))
      .catch((err) => console.log('[SW] precache failed:', err))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    // Wipe every cache that isn't a current one — clears v1's poisoned shell.
    caches.keys().then((names) => Promise.all(
      names
        .filter((name) => name !== STATIC_CACHE && name !== DYNAMIC_CACHE)
        .map((name) => caches.delete(name))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;
  if (!url.protocol.startsWith('http')) return;
  // Never touch Next.js dev/build assets or HMR — let the browser go direct.
  if (url.pathname.startsWith('/_next/')) return;

  // Navigations (HTML pages) and API → NETWORK FIRST. Cache is only an
  // offline fallback, so a fresh page shell always wins.
  if (request.mode === 'navigate' || url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(DYNAMIC_CACHE).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request).then((cached) => {
          if (cached) return cached;
          if (url.pathname.startsWith('/api/')) {
            return new Response(JSON.stringify({ error: 'Offline', offline: true }), {
              headers: { 'Content-Type': 'application/json' },
              status: 503,
            });
          }
          return new Response('Offline', { status: 503 });
        }))
    );
    return;
  }

  // Everything else (icons, manifest, images) → cache first.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(DYNAMIC_CACHE).then((cache) => cache.put(request, clone));
        }
        return response;
      }).catch(() => new Response('Offline', { status: 503 }));
    })
  );
});

// Push notification handler
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  const options = {
    body: data.body || 'New tech events in Bangalore!',
    icon: '/icon-192.svg',
    badge: '/icon-192.svg',
    vibrate: [200, 100, 200],
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(data.title || 'PulseBLR', options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url || '/'));
});
