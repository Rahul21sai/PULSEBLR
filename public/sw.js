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
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY v4 — the same leak, through a route nobody thought of as private.
//
// `/api/events` was not in PRIVATE_API, because the event feed was global: every
// row in it was scraped and public, so caching it origin-wide was harmless and
// let the feed render offline. Then events gained an owner and a `visibility`,
// and /api/events began returning the CALLER's private events alongside the
// public ones. At that moment the v2 bug came back on this one path — account A's
// private event titles written to a shared cache and served to account B offline.
//
// The alternative was serving private events from a separate path so /api/events
// could stay cacheable. Rejected: it means two definitions of the feed, and the
// query builder being shared between the list and the facet counts is the
// property that keeps them honest. One filtered endpoint that cannot be cached
// beats two endpoints that can disagree.
//
// COST OF v4, ON TOP OF v3: the event feed no longer renders offline at all.
// Worth naming, because it is a real regression for a PWA — and it is bounded by
// the same reasoning as v3. `purge-caches` only helps when the app sends it
// before signOut(); a session expiry, a cleared cookie, a sign-out in another
// tab or a crash leaves the cache intact, which is why this has to be a
// never-write rule rather than a cleanup.
//
// The cache NAMES are bumped so existing clients drop an already-poisoned cache
// on activate rather than keeping it.
// ─────────────────────────────────────────────────────────────────────────────
// WHY v5 — the SAME LEAK A THIRD TIME, on a path v3 and v4 could not see, plus
//          the offline cold boot this app has never had.
//
// ── 1. RSC PAYLOADS WERE BEING CACHED CACHE-FIRST, ORIGIN-WIDE, FOREVER.
//
// This was the third instance of the v2 bug and the worst of the three, because
// unlike a navigation (network-first, so re-validated on every online visit) an
// RSC payload landed in the FINAL cache-first branch and was therefore never
// re-fetched again. Written once, served forever, to whoever held the device.
//
// The mechanism, traced through the installed Next 16.3.4 rather than assumed:
//
//   · An App Router SOFT navigation does not issue a navigation request. It calls
//     `fetch()` for the destination page's OWN url with a cache-busting query
//     param appended — `NEXT_RSC_UNION_QUERY = '_rsc'`
//     (node_modules/next/dist/esm/client/components/app-router-headers.js:27) —
//     and an `RSC: 1` request header (same file, line 1).
//   · `createFetch` (router-reducer/fetch-server-response.js:460) sets
//     `credentials: 'same-origin'` and no `mode`, so the Request defaults to
//     `mode: 'cors'`. It is NOT `'navigate'`.
//   · So for a soft navigation to /events/<id> the fetch handler saw: method GET,
//     pathname `/events/<id>` (NOT `/_next/`, so no early return), not in
//     PRIVATE_API (that list holds `/api/events`, not `/events`), mode not
//     `'navigate'`, pathname not `/api/`. Every guard missed, and it fell through
//     to "everything else → cache first".
//   · `app/events/[id]/page.tsx` is a real SERVER component: it calls
//     `getCurrentUserId()` and `canViewEvent()` and renders `visibility:'private'`
//     events for their owner. So that payload is private server-rendered markup.
//
// It also HIT, not merely got written. Next sets
// `Vary: RSC, Next-Router-State-Tree, Next-Router-Prefetch, Next-Router-Segment-Prefetch`
// (server/base-server.js:1149), and `caches.match` honours Vary — but the `_rsc`
// hash is COMPUTED FROM those same headers (set-cache-busting-search-param.js), so
// an identical url implies identical Vary-relevant headers by construction. Same
// url ⇒ Vary passes ⇒ cache hit. Link prefetches take the same path, so payloads
// arrived for pages that were never even opened.
//
// CONSEQUENCE BEYOND PRIVACY, and it may explain a documented mystery: CLAUDE.md
// §7 records a stale shell during `next start` verification whose "exact mechanism
// was NOT established", having correctly ruled out `/_next/` (skipped) and the
// document (network-first). Neither of those is the branch this used. A soft
// navigation reading a frozen RSC payload renders stale CONTENT under a fresh
// document — which is exactly what was observed and what neither ruled-out path
// can produce.
//
// FIX: `_rsc` and the `RSC` header are network-only, exactly like PRIVATE_API.
//
//   DETECTION DETAIL THAT MATTERS: match the PARAM, not the string `'_rsc='`.
//   `setCacheBustingSearchParamWithHash` pushes a BARE `_rsc` with no `=` when the
//   computed hash is empty (`if (hash.length > 0) … else pairs.push('_rsc')`), so a
//   substring test for `'_rsc='` misses that case entirely. `searchParams.has()`
//   catches both forms.
//
//   COST: a soft navigation to /events/<id> no longer resolves offline. That is
//   ~nothing in practice, and the degradation is graceful rather than a dead end:
//   the 503 below carries `text/plain`, so `fetchServerResponse` sees
//   `!isFlightResponse`, calls `doMpaNavigation()`, and the router performs a HARD
//   navigation to the same page with `_rsc` stripped
//   (`urlToUrlWithoutFlightMarker`, client/route-params.js:153). That lands in the
//   navigate branch, which serves a cached document or /offline.html. An offline
//   soft navigation degrades into an offline hard navigation.
//
//   The other protected surfaces lose nothing at all, because they hold no server
//   data to lose: /tracker, /dashboard and /folders are `'use client'`, and
//   /people/[id] is a thin server shell that awaits `params` and reads no user
//   data. /events/[id] is the sole server-rendered exception, and it is the one
//   whose payload was the leak.
//
// ── 2. COLD BOOT OFFLINE, which this app has never been able to do.
//
// v1's damage came from precaching the DOCUMENT, so every later version returned
// early for `/_next/` and never cached a chunk — documented as a known limit at
// lib/scan/outbox.ts. The result: nothing boots with no network.
//
// `/_next/static/*` is content-hashed and immutable, so a hit is correct for that
// url BY CONSTRUCTION. This is not a repeat of v1, it is v1's actual repair: v1
// served a stale document whose chunks 404ed, and a cached document can now find
// its chunks instead of dying.
//
//   KEYED ON THE FULL URL, QUERY INCLUDED. NEVER `ignoreSearch`. Under skew
//   protection Next appends a deployment-scoped `?dpl=<id>` to static assets
//   (docs/01-app/03-api-reference/05-config/01-next-config-js/supportsImmutableAssets.md),
//   and `supportsImmutableAssets` — added in 16.3.0, this repo is on 16.3.4 —
//   instead serves them from `/_next/static/immutable/*` with no param. Both live
//   under `/_next/static/`, so the allow-list covers either. But `ignoreSearch`
//   would serve a PREVIOUS deployment's chunk against new HTML: chunk-load
//   failure, the v1 class of bug through a new door.
//
//   POSITIVE ALLOW-LIST, not a deny-list. `/_next/static/webpack/*` (hot-update
//   chunks) is excluded because it is the one thing under that prefix which is not
//   immutable. `/_next/image` is excluded BY CONSTRUCTION rather than by a rule —
//   it is not under `/_next/static/` — and there are 0 `next/image` imports in this
//   app anyway. `/_next/data/` needs no exclusion at all: it is a PAGES ROUTER
//   path and does not exist here (0 references in the tree).
//
// ── 3. THE COST OF THE BUMP, STATED PLAINLY.
//
// `activate` deletes every cache not named for the current version, so returning
// users lose their cached documents ONCE on upgrade and the next online visit
// re-fills them. That is necessary rather than merely tolerable: v4's dynamic
// cache is exactly where the accidentally-cache-first RSC payloads from §1 are
// sitting, and leaving it in place would preserve the leak this version exists to
// close.
//
// THE SWEEP TOUCHES CACHE STORAGE ONLY — it calls `caches.delete()` and nothing
// else. `lib/scan/outbox.ts` depends on that: the offline scan queue lives in
// IndexedDB precisely because a routine version bump erases Cache Storage, and an
// unsynced capture is somebody you met and would otherwise lose. Do not add an
// `indexedDB.deleteDatabase()` here for any reason.
// ─────────────────────────────────────────────────────────────────────────────
const VERSION = 'v5';
const STATIC_CACHE = `pulseblr-static-${VERSION}`;
const ASSET_CACHE = `pulseblr-assets-${VERSION}`;
const DYNAMIC_CACHE = `pulseblr-dynamic-${VERSION}`;

const CURRENT_CACHES = [STATIC_CACHE, ASSET_CACHE, DYNAMIC_CACHE];

/**
 * THREE caches rather than v4's two, so pruning can be targeted.
 *
 * The asset cache grows without bound across deployments while the other two do
 * not, so it is the only one that needs a size policy — and it must be possible to
 * trim it WITHOUT throwing away the hand-authored offline page and icons, which is
 * impossible when everything shares one store.
 */
const OFFLINE_URL = '/offline.html';

/**
 * `/_next/static/*` accumulates one set of entries per deployment the user visits,
 * so it needs a bound.
 *
 * FIFO, NOT WHOLESALE DELETION, and the difference is load-bearing. Cache Storage
 * has no LRU metadata — but `Cache.keys()` is specified to return entries in
 * INSERTION order, which is all that is needed here: an older deployment's chunks
 * were necessarily inserted before the current one's, so dropping from the front
 * evicts precisely the dead deployments. Dropping the whole cache instead would
 * evict the CURRENT deployment's chunks too and break offline boot until the next
 * online visit — self-healing in the sense that it heals from a wound it inflicted.
 *
 * High/low watermark so a cache sitting at the limit does not re-trim on every put.
 * 53 files in a production build of this app, of which a session loads a subset, so
 * 320 is roughly a dozen deployments' worth of real browsing.
 */
const ASSET_CACHE_MAX = 320;
const ASSET_CACHE_TRIM_TO = 260;
/** Enumerating the cache on every put is wasted work; amortise it. */
const SWEEP_EVERY = 25;
let putsSinceSweep = 0;

// Everything under these prefixes is one user's private data.
const PRIVATE_API = [
  // Returns the caller's own private and pending events mixed in with the public feed, so it
  // cannot be cached in an origin-wide store. See the v4 note above.
  '/api/events',
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

/**
 * Is this an App Router RSC request — a soft navigation or a link prefetch?
 *
 * Two independent signals, because either alone has a gap. The header is the
 * authoritative one but is only readable for same-origin requests; the query param
 * is what survives a CDN that strips unknown headers. Checked with `has()` rather
 * than a substring test on purpose — see the DETECTION DETAIL note in the v5
 * changelog for why `'_rsc='` is not good enough.
 */
function isRscRequest(request, url) {
  if (url.searchParams.has('_rsc')) return true;
  const rsc = request.headers.get('rsc');
  if (rsc !== null && rsc !== '') return true;
  return (request.headers.get('accept') || '').includes('text/x-component');
}

/** An immutable, content-hashed build asset that is safe to serve cache-first. */
function isImmutableBuildAsset(pathname) {
  if (!pathname.startsWith('/_next/static/')) return false;
  // Hot-update chunks are the one mutable thing under that prefix.
  if (pathname.startsWith('/_next/static/webpack/')) return false;
  return true;
}

/**
 * May this response be written to an ORIGIN-WIDE store shared by every account
 * that uses this device?
 *
 * Cache Storage does not honour HTTP cache directives — a `put()` stores whatever
 * it is handed — so this has to be checked by hand. It closes the navigation-
 * DOCUMENT half of the leak §1 describes without duplicating
 * `lib/protected-routes.ts` into this file: a dynamically-rendered page that read
 * the session says so in its own headers, and a second copy of the route list here
 * is a copy that would drift.
 *
 * `private` counts as a refusal alongside `no-store`. In HTTP terms a browser cache
 * IS a private cache, so `private` alone would normally be storable — but the whole
 * v2/v3/v4 history in this file is cross-account leakage on ONE device, where
 * Cache Storage is emphatically shared. For this app `private` means "not here".
 *
 * A 206 is refused separately: `put()` throws a TypeError on a partial response
 * rather than failing quietly, which would reject the whole handler.
 */
function mayStore(response) {
  if (!response || response.status !== 200) return false;
  if (response.type === 'opaque' || response.type === 'opaqueredirect') return false;
  const cc = (response.headers.get('cache-control') || '').toLowerCase();
  if (cc.includes('no-store') || cc.includes('private')) return false;
  return true;
}

/**
 * Only truly-immutable, hand-authored assets are precached.
 *
 * The app shell ("/", "/tracker", ...) is STILL intentionally not precached — that
 * was v1's bug and it stays fixed. `/offline.html` is the one document here, and it
 * is safe for a structural reason rather than a hopeful one: it references NO
 * chunks, no scripts and no external stylesheet, so there is no version of it that
 * can go stale in a way that breaks. Precaching the Next route `/offline` instead
 * WOULD be the v1 bug, because its HTML names content-hashed chunks that a static
 * file cannot know.
 *
 * The wasm is here so the FIRST offline scan works rather than the second — it is
 * ~1 MB, which is the largest single item and worth naming.
 */
const STATIC_ASSETS = [
  OFFLINE_URL,
  '/manifest.json',
  '/icon-96.png',
  '/icon-192.png',
  '/icon-512.png',
  '/wasm/zxing_reader.wasm',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) =>
      // Individually rather than `addAll`, which is ATOMIC: one 404 would discard
      // the whole precache. `/wasm/zxing_reader.wasm` is written by a postinstall
      // script, so its absence is a real possibility and must not cost us the
      // offline page.
      Promise.all(
        STATIC_ASSETS.map((url) =>
          cache
            .add(new Request(url, { cache: 'reload' }))
            .catch((err) => console.log('[SW] precache miss:', url, err && err.message))
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    // Wipe every cache that isn't a current one. CACHE STORAGE ONLY — see the v5
    // note: lib/scan/outbox.ts's IndexedDB queue must survive this.
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names.filter((name) => !CURRENT_CACHES.includes(name)).map((name) => caches.delete(name))
        )
      )
      // Re-apply the bound on activate too, so lowering ASSET_CACHE_MAX takes
      // effect on upgrade rather than only after 25 more puts.
      .then(() => trimAssetCache())
      .then(() => self.clients.claim())
  );
});

/** FIFO-trim the asset cache back to the low watermark. See ASSET_CACHE_MAX. */
async function trimAssetCache() {
  try {
    const cache = await caches.open(ASSET_CACHE);
    const keys = await cache.keys();
    if (keys.length <= ASSET_CACHE_MAX) return;
    // `keys()` is insertion-ordered, so the front of this list is the oldest
    // deployment still held.
    const doomed = keys.slice(0, keys.length - ASSET_CACHE_TRIM_TO);
    await Promise.all(doomed.map((request) => cache.delete(request)));
  } catch {
    // A cache that cannot be trimmed is a disk-space problem, not a correctness
    // one. Never let it reject a fetch handler.
  }
}

/** Write to a cache off the critical path, then amortised-sweep the asset store. */
function stash(cacheName, request, response) {
  if (!mayStore(response)) return;
  const clone = response.clone();
  caches
    .open(cacheName)
    .then((cache) => cache.put(request, clone))
    .then(() => {
      if (cacheName !== ASSET_CACHE) return;
      putsSinceSweep += 1;
      if (putsSinceSweep < SWEEP_EVERY) return;
      putsSinceSweep = 0;
      return trimAssetCache();
    })
    .catch(() => {
      /* A failed put must never break the response the user is waiting for. */
    });
}

function offlineJson() {
  return new Response(JSON.stringify({ error: 'Offline', offline: true }), {
    headers: { 'Content-Type': 'application/json' },
    status: 503,
  });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;
  if (!url.protocol.startsWith('http')) return;

  // ── RSC (soft navigations and link prefetches) → NETWORK ONLY.
  // Checked FIRST because these carry a PAGE pathname, not an /api/ or /_next/
  // one, so every other guard in this handler misses them. See the v5 changelog.
  //
  // `text/plain` on the failure is deliberate, not lazy: it makes the router treat
  // this as a non-Flight response and fall back to a hard navigation with `_rsc`
  // stripped, which the navigate branch below can actually serve.
  if (isRscRequest(request, url)) {
    event.respondWith(
      fetch(request).catch(
        () =>
          new Response('Offline', {
            headers: { 'Content-Type': 'text/plain' },
            status: 503,
          })
      )
    );
    return;
  }

  // ── Immutable build assets → CACHE FIRST. This is what makes cold boot work.
  if (isImmutableBuildAsset(url.pathname)) {
    event.respondWith(
      // No `ignoreSearch`: `?dpl=<deployment>` must be part of the key.
      caches.match(request, { cacheName: ASSET_CACHE }).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          stash(ASSET_CACHE, request, response);
          return response;
        });
      })
    );
    return;
  }

  // Any OTHER /_next/ path (HMR, /_next/image, the dev overlay) → straight to the
  // browser, exactly as before.
  if (url.pathname.startsWith('/_next/')) return;

  // ── PRIVATE API → NETWORK ONLY. Never cached, never served from cache, so one
  // account's data cannot be read back by the next account on this device.
  if (isPrivateApi(url.pathname)) {
    event.respondWith(fetch(request).catch(() => offlineJson()));
    return;
  }

  // ── Navigations (HTML pages) and public API → NETWORK FIRST. Cache is only an
  // offline fallback, so a fresh page shell always wins. DO NOT make this
  // cache-first: that was v1, and it poisoned browsers with a stale shell.
  if (request.mode === 'navigate' || url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          stash(DYNAMIC_CACHE, request, response);
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) return cached;
          if (url.pathname.startsWith('/api/')) return offlineJson();
          // Last resort for a route this device has never opened online. Only ever
          // reached when the network failed AND no real document is cached, so it
          // can never win over genuine content.
          const shell = await caches.match(OFFLINE_URL, { cacheName: STATIC_CACHE });
          if (shell) return shell;
          return new Response('Offline', {
            headers: { 'Content-Type': 'text/plain' },
            status: 503,
          });
        })
    );
    return;
  }

  // Everything else (icons, manifest, images, the wasm) → cache first.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          stash(STATIC_CACHE, request, response);
          return response;
        })
        .catch(() => new Response('Offline', { status: 503 }));
    })
  );
});

/**
 * Purge every cache on request.
 *
 * Sent by the app immediately before signing out. Belt and braces alongside the
 * network-only rules above: cached NAVIGATIONS can also carry server-rendered
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
        // A failed purge must not block sign-out; the network-only rules above are
        // what actually contain the private data.
        event.source?.postMessage({ type: 'caches-purged' });
      })
  );
});

/**
 * Push notifications.
 *
 * FOUR DEAD BUGS FIXED HERE, all of them silent, and none of them yet reachable —
 * nothing subscribes a push endpoint at the time of writing, so every one of these
 * would have surfaced for the first time in front of a real user.
 *
 *   1. `icon: '/icon-192.svg'` showed NOTHING on Android. Notification icons must
 *      be raster; the platform does not render SVG here and does not complain. The
 *      PNGs exist (`public/icon-{48..512}.png`).
 *   2. `badge` was the same full-colour 192 tile. A badge is masked to a monochrome
 *      silhouette, so a full-colour square arrives as a grey blob. LIMITATION
 *      STATED RATHER THAN PAPERED OVER: this repo has no dedicated monochrome
 *      badge asset, so `/icon-96.png` is used as the closest fit. It will still be
 *      masked. A purpose-made single-colour glyph is the real fix and is a design
 *      task, not a code one — inventing a filename that does not exist would just
 *      restore bug 1.
 *   3. `notificationclick` always called `openWindow`, which in an installed PWA or
 *      a TWA opens a SECOND instance rather than surfacing the one already running.
 *      Now: look for an existing window client, focus it, and only open a new one
 *      when there is genuinely nothing to focus.
 *   4. `event.data.json()` throws on a non-JSON payload and `data.url` throws when
 *      `data` is absent. Both are guarded, so a malformed push degrades to a
 *      generic notification instead of throwing inside the handler and showing the
 *      browser's own "This site has been updated in the background" instead.
 *
 * `tag` is supported so repeat notifications about ONE event replace rather than
 * stack — a reminder re-sent for the same event should update, not pile up.
 */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Not JSON. Fall back to the raw text as the body rather than losing the push.
    try {
      data = { body: event.data ? event.data.text() : '' };
    } catch {
      data = {};
    }
  }
  if (!data || typeof data !== 'object') data = {};

  const options = {
    body: data.body || 'New tech events in Bangalore!',
    // Raster, not SVG — see bug 1 above.
    icon: '/icon-192.png',
    // Masked to a silhouette by the platform — see bug 2 above.
    badge: '/icon-96.png',
    vibrate: [200, 100, 200],
    data: { url: typeof data.url === 'string' && data.url ? data.url : '/' },
  };
  // Only set `tag` when one was sent: an empty tag is not the same as no tag, and a
  // shared constant would collapse unrelated notifications into one.
  //
  // `renotify` is deliberately NOT set, which is a decision rather than an omission.
  // It only has any effect when a notification with this tag is ALREADY ON SCREEN,
  // i.e. when the user has already been alerted about this exact event —
  // `lib/notifications/reminder-policy.ts` defines one push kind
  // (`event-reminder-push`) and claims its `ReminderLog` row before sending, so a
  // shared tag can only ever be a retry or a re-delivery of the same reminder, never
  // a second more-urgent one. Re-buzzing for content already shown is exactly the
  // noise the tag exists to suppress. It would also throw: the Notifications spec
  // makes `renotify` with an empty tag a TypeError, so the two can never be split.
  if (typeof data.tag === 'string' && data.tag) {
    options.tag = data.tag;
  }

  event.waitUntil(self.registration.showNotification(data.title || 'PulseBLR', options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const target = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    (async () => {
      const targetUrl = new URL(target, self.location.origin);
      // `includeUncontrolled` matters: a window opened before this worker took
      // control is still the user's open app, and focusing it is the whole point.
      const clientList = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      // Prefer an exact url match, then any window on this origin.
      let match = clientList.find((c) => c.url === targetUrl.href);
      if (!match) match = clientList.find((c) => new URL(c.url).origin === targetUrl.origin);

      if (match) {
        if ('navigate' in match && match.url !== targetUrl.href) {
          try {
            await match.navigate(targetUrl.href);
          } catch {
            // Navigation of an existing client can be refused; focusing it is
            // still better than a duplicate window.
          }
        }
        await match.focus();
        return;
      }

      await self.clients.openWindow(targetUrl.href);
    })()
  );
});
