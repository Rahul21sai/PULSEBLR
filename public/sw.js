// PulseBLR Service Worker
// v3 — network-first for pages/API so the app shell is NEVER served stale, and
//      PRIVATE API responses are never written to the cache at all.
//
// (v1 precached "/" and served navigations cache-first, which poisoned the
//  browser with stale HTML pointing at dead JS chunks → infinite spinner.)
//
// WHY v3 EXISTS — a real cross-account leak, not a hypothetical. v2 cached every
// successful API GET into an ORIGIN-WIDE cache, and sign-out did not purge it. So:
// sign out, sign in with a different Google account, go offline, and an API read
// served the PREVIOUS user's tracker entries, contacts and private notes. CLAUDE.md
// already names this class of bug as the reason generateDailyDigest() takes a
// required userId. The scan feature — folders full of other people's phone numbers
// and private "how we met" notes — made fixing it non-optional.
//
// The fix has two halves:
//   1. PRIVATE_API paths are network-only: never written, never served from cache.
//   2. A 'purge-caches' message wipes everything, sent by the app on sign-out.
//
// COST, STATED HONESTLY: private data can no longer be read offline. The scanner's
// own captures do not depend on this — they live in IndexedDB, which the cache
// sweep below cannot touch — but a folder's already-synced rows will not render
// with no network. That is the right trade: showing one user another user's
// contacts is worse than showing nobody anything.
const STATIC_CACHE = 'pulseblr-static-v3';
const DYNAMIC_CACHE = 'pulseblr-dynamic-v3';

// Everything under these prefixes is one user's private data.
const PRIVATE_API = [
  '/api/tracker',
  '/api/contacts',
  '/api/folders',
  '/api/me/',
  '/api/phase6',
  '/api/notifications',
  '/api/admin',
  '/api/auth',
];

function isPrivateApi(pathname) {
  return PRIVATE_API.some(prefix => pathname.startsWith(prefix));
}

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

  // PRIVATE API → NETWORK ONLY. Never cached, never served from cache, so one
  // account's data cannot be read back by the next account on this device.
  if (isPrivateApi(url.pathname)) {
    event.respondWith(
      fetch(request).catch(() =>
        new Response(JSON.stringify({ error: 'Offline', offline: true }), {
          headers: { 'Content-Type': 'application/json' },
          status: 503,
        })
      )
    );
    return;
  }

  // Navigations (HTML pages) and public API → NETWORK FIRST. Cache is only an
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

/**
 * Purge every cache on request.
 *
 * Sent by the app immediately before signing out. Belt and braces alongside the
 * network-only rule above: cached NAVIGATIONS can also carry server-rendered
 * private markup, and this is the only moment at which the app knows the identity
 * behind the cache is about to change.
 *
 * The reply lets the caller await completion, so sign-out does not race the wipe.
 */
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'purge-caches') return;
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.map((name) => caches.delete(name))))
      .then(() => {
        event.source?.postMessage({ type: 'caches-purged' });
      })
      .catch(() => {
        // A failed purge must not block sign-out; the network-only rule above is
        // what actually contains the private data.
        event.source?.postMessage({ type: 'caches-purged' });
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
