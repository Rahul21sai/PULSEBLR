/**
 * Does this PWA actually COLD-BOOT with no network, and does anything private survive in
 * Cache Storage?
 *
 * WHY THIS CANNOT BE A VITEST SUITE, AND CANNOT RUN UNDER `npm run dev`. `public/sw.js` is a
 * browser script with no exports that reaches for `caches`, `clients` and `registration` —
 * `tests/sw-policy.test.ts` reads it as TEXT and says so in its own header, because a regex
 * cannot execute a fetch handler. And `app/layout.tsx` deliberately UNREGISTERS every service
 * worker and deletes every cache in development, so a dev server is structurally incapable of
 * answering the question. This needs a production build and a real Chromium.
 *
 *   PULSEBLR_DIST_DIR=.next-verify npm run build
 *   node scripts/start-verify.js
 *   PB_BASE=http://localhost:3200 npx tsx scripts/diag-offline.ts
 *
 * WHAT IT PROVES, and why each check is shaped the way it is:
 *
 *   1. COLD BOOT. The decisive one, and the reason v5 exists. Loading `/` while offline in a
 *      brand-new page is not enough on its own — cached HTML that cannot find its JS chunks
 *      is exactly the v1 disaster (a stale shell and an infinite spinner), and it LOOKS like
 *      a pass to anything that only checks the document rendered. So this asserts the chunks
 *      were served BY THE SERVICE WORKER (`response.fromServiceWorker()`), that no
 *      `/_next/static/` request failed, and that no page error fired. Serving a document is
 *      not booting an app.
 *
 *   2. NOTHING PRIVATE AT REST. Fetch the private APIs and an `?_rsc=` url through the
 *      controlling worker, then enumerate EVERY cache and EVERY key and assert none of them
 *      is there. This is the v2/v3/v4/v5 bug in its general form: the leak was never in the
 *      reading, it was in the writing.
 *
 *   3. ONLY -v5 CACHE NAMES SURVIVE. A stale cache left behind by `activate` is the v5 leak
 *      preserved intact, since v4's dynamic store is where the RSC payloads are.
 *
 * FOUR CONTROLS THAT MUST FIRE. Every probe failure in this repo's last design pass was a
 * check that silently could not fail (CLAUDE.md §17 lists six), so each of the three checks
 * above is paired with something that proves the instrument discriminates:
 *
 *   A. A route never visited online must render `/offline.html`. If `setOffline(true)` is not
 *      actually working, check 1 proves nothing whatsoever — it would just be a normal online
 *      page load. This is the control that makes check 1 mean something.
 *   B. The cache enumeration must FIND entries, and specifically `/_next/static/` ones. An
 *      empty Cache Storage passes check 2 vacuously and is also a cold-boot failure.
 *   C. A planted `/api/tracker/CANARY` entry must be REPORTED by the same scanner that
 *      declares the caches clean. Written and deleted here; it proves the matcher works
 *      rather than that the regex happened to match nothing.
 *   D. A planted `pulseblr-dynamic-v4` cache must be REPORTED by the version check. Same
 *      argument: "every name ends -v5" is trivially true of an empty list.
 *
 * READ-ONLY with respect to the app: no database, no sign-in, no writes to the repo. Controls
 * C and D write two throwaway entries into the EPHEMERAL browser profile's Cache Storage and
 * remove them again; nothing outlives the browser.
 *
 * KNOWN LIMIT, STATED RATHER THAN GLOSSED. `next start` runs with NODE_ENV=production and
 * `lib/dev-login.ts` correctly refuses to activate there, while Google OAuth is pinned to
 * port 3000 — so there is NO WAY to sign in here. Everything below is measured as an
 * anonymous visitor. That is sufficient for the leak checks (a private response that is never
 * written cannot be written for a signed-in user either — the branch does not consult the
 * session) but it means the specific case of a signed-in owner's private `/events/[id]` RSC
 * payload is verified structurally, by the branch it takes, not by observing its bytes.
 *
 * Exits non-zero on any contradiction.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const BASE = (process.env.PB_BASE || 'http://localhost:3200').replace(/\/$/, '');

/** Anything matching one of these must never appear as a Cache Storage key. */
const MUST_NOT_BE_CACHED = [
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

/** A route with a nav link from `/` but never OPENED, so its document cannot be cached. */
const UNVISITED_ROUTE = '/calendar';

let failures = 0;
let checks = 0;

function ok(label: string, detail = ''): void {
  checks++;
  console.log(`  OK    ${label}${detail ? `  ${detail}` : ''}`);
}
function fail(label: string, detail = ''): void {
  checks++;
  failures++;
  console.log(`  FAIL  ${label}${detail ? `  ${detail}` : ''}`);
}
function note(text: string): void {
  console.log(`  note  ${text}`);
}
function section(name: string): void {
  console.log(`\n${name}`);
}

type CacheSnapshot = { name: string; keys: string[] }[];

/** Every cache, every key. The one function both the checks and the controls use. */
function snapshotCaches(page: Page): Promise<CacheSnapshot> {
  return page.evaluate(async () => {
    const names = await caches.keys();
    const out: { name: string; keys: string[] }[] = [];
    for (const name of names) {
      const cache = await caches.open(name);
      const keys = await cache.keys();
      out.push({ name, keys: keys.map((r) => r.url) });
    }
    return out;
  });
}

/** The private/RSC scanner. Shared by check 2 and control C, deliberately. */
function findForbidden(snapshot: CacheSnapshot): string[] {
  const hits: string[] = [];
  for (const { name, keys } of snapshot) {
    for (const url of keys) {
      const path = new URL(url).pathname;
      const search = new URL(url).search;
      if (MUST_NOT_BE_CACHED.some((p) => path.startsWith(p))) hits.push(`${name} → ${url}`);
      else if (/[?&]_rsc(=|$|&)/.test(search)) hits.push(`${name} → ${url}`);
    }
  }
  return hits;
}

/** The version scanner. Shared by check 3 and control D. */
function findStaleCaches(snapshot: CacheSnapshot): string[] {
  return snapshot.map((c) => c.name).filter((name) => !name.endsWith('-v5'));
}

/** Wait until a service worker is actually in control of this page. */
async function waitForController(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false;
      await navigator.serviceWorker.ready;
      for (let i = 0; i < 100; i++) {
        if (navigator.serviceWorker.controller) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    });
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  console.log(`Offline diagnostics against ${BASE}`);
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;

  try {
    browser = await chromium.launch();
    context = await browser.newContext();
    const page = await context.newPage();

    // ------------------------------------------------------------------ server reachable
    section('Server');
    const landing = await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    if (!landing || landing.status() >= 400) {
      fail('server reachable', `GET / returned ${landing?.status() ?? 'no response'}`);
      console.log(
        '\nNothing below can be checked without a PRODUCTION server. Note that a DEV server' +
          '\ncannot be used at all: app/layout.tsx unregisters the worker in development.' +
          '\n  PULSEBLR_DIST_DIR=.next-verify npm run build && node scripts/start-verify.js'
      );
      process.exitCode = 1;
      return;
    }
    ok('server reachable', `GET / ${landing.status()}`);

    // A dev server would silently invalidate everything below, so refuse it by name rather
    // than reporting a confusing string of failures.
    const isDev = await page.evaluate(
      () => document.documentElement.innerHTML.includes('__next_devtools') || false
    );
    if (isDev) note('this looks like a dev build; the worker is unregistered in development');

    // ------------------------------------------------------------- /sw.js must not be cached
    section('Headers');
    const swRes = await page.request.get(`${BASE}/sw.js`);
    const swCC = (swRes.headers()['cache-control'] || '').toLowerCase();
    if (swRes.ok() && swCC.includes('no-store')) {
      ok('/sw.js sends no-store', swCC);
    } else {
      // Without this the OLD worker keeps running and a leaking version cannot be withdrawn.
      fail('/sw.js sends no-store', `status ${swRes.status()} cache-control="${swCC || 'absent'}"`);
    }

    const offlineRes = await page.request.get(`${BASE}${'/offline.html'}`);
    if (offlineRes.ok() && (offlineRes.headers()['content-type'] || '').includes('text/html')) {
      ok('/offline.html is served', `${offlineRes.status()}`);
    } else {
      fail('/offline.html is served', `status ${offlineRes.status()}`);
    }

    // Informative, not judged: it is what `mayStore()` keys off for the navigation branch.
    const navCC = landing.headers()['cache-control'] || 'absent';
    note(`GET / cache-control: ${navCC}`);

    // --------------------------------------------------------------- worker takes control
    section('Service worker');
    if (!(await waitForController(page))) {
      fail('a service worker takes control of the page');
      console.log('\nNothing below is meaningful without a controlling worker.');
      process.exitCode = 1;
      return;
    }
    ok('a service worker takes control of the page');

    // The FIRST document was fetched before the worker was controlling, so it is not in any
    // cache yet. Reload through the worker so the navigation and its chunks are stored — this
    // is what a returning visitor's second visit looks like, which is the realistic case.
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(1200); // let the amortised cache writes land

    // ------------------------------------------------- drive the network-only paths ONLINE
    section('Private and RSC requests leave nothing behind');
    const fetchProbe = await page.evaluate(async () => {
      const results: Record<string, number | string> = {};
      const urls = [
        '/api/events?limit=1',
        '/api/tracker',
        // The RSC shape: the page's OWN url plus the cache-busting param, and the header.
        // Both signals at once, which is what a real soft navigation sends.
        '/?_rsc=probe1',
      ];
      for (const u of urls) {
        try {
          const res = await fetch(u, { headers: u.includes('_rsc') ? { RSC: '1' } : {} });
          results[u] = res.status;
        } catch (err) {
          results[u] = `threw: ${(err as Error).message}`;
        }
      }
      // A BARE `_rsc` with no `=`, which is what Next emits when the computed hash is empty.
      // The reason sw.js uses searchParams.has() instead of a substring test.
      try {
        const res = await fetch('/?_rsc', { headers: { RSC: '1' } });
        results['/?_rsc'] = res.status;
      } catch (err) {
        results['/?_rsc'] = `threw: ${(err as Error).message}`;
      }
      return results;
    });
    for (const [url, status] of Object.entries(fetchProbe)) note(`${url} → ${status}`);
    await page.waitForTimeout(800);

    let snapshot = await snapshotCaches(page);
    const forbidden = findForbidden(snapshot);
    if (forbidden.length === 0) {
      ok('no private or RSC response is in Cache Storage');
    } else {
      for (const hit of forbidden) fail('cached private/RSC response', hit);
    }

    // CONTROL B. An empty Cache Storage would pass the check above for the wrong reason —
    // and would also mean cold boot cannot possibly work.
    const totalKeys = snapshot.reduce((n, c) => n + c.keys.length, 0);
    const assetKeys = snapshot
      .flatMap((c) => c.keys)
      .filter((u) => new URL(u).pathname.startsWith('/_next/static/'));
    if (totalKeys > 0 && assetKeys.length > 0) {
      ok(
        'control B: the cache scan has something to scan',
        `${totalKeys} entries across ${snapshot.length} caches, ${assetKeys.length} build assets`
      );
    } else {
      fail(
        'control B: the cache scan has something to scan',
        `${totalKeys} entries, ${assetKeys.length} build assets — check 2 above proved nothing`
      );
    }

    // No entry may be keyed without its query string, or a previous deployment's chunk gets
    // served against new HTML.
    const dplStripped = assetKeys.filter((u) => u.includes('?dpl=')).length;
    note(`build assets carrying ?dpl=: ${dplStripped} (0 is expected without skew protection)`);

    // CONTROL C. Plant something the scanner MUST catch, then remove it.
    const canary = '/api/tracker/CANARY-diag-offline';
    await page.evaluate(async (url) => {
      const cache = await caches.open('pulseblr-dynamic-v5');
      await cache.put(new Request(url), new Response('canary'));
    }, canary);
    const planted = findForbidden(await snapshotCaches(page));
    if (planted.some((h) => h.includes('CANARY-diag-offline'))) {
      ok('control C: the scanner detects a planted private entry');
    } else {
      fail(
        'control C: the scanner detects a planted private entry',
        'the clean result above is not evidence of anything'
      );
    }
    await page.evaluate(async (url) => {
      const cache = await caches.open('pulseblr-dynamic-v5');
      await cache.delete(new Request(url));
    }, canary);

    // --------------------------------------------------------------- cache versions
    section('Cache versions');
    snapshot = await snapshotCaches(page);
    const stale = findStaleCaches(snapshot);
    if (stale.length === 0) {
      ok('every surviving cache is -v5', snapshot.map((c) => c.name).join(', ') || 'none');
    } else {
      // v4's dynamic cache is where the accidentally-cache-first RSC payloads live.
      for (const name of stale) fail('stale cache survived activate', name);
    }

    // CONTROL D. "Every name ends -v5" is trivially true of an empty list.
    await page.evaluate(() => caches.open('pulseblr-dynamic-v4'));
    if (findStaleCaches(await snapshotCaches(page)).includes('pulseblr-dynamic-v4')) {
      ok('control D: the version check detects a planted stale cache');
    } else {
      fail('control D: the version check detects a planted stale cache');
    }
    await page.evaluate(() => caches.delete('pulseblr-dynamic-v4'));

    // ============================================================ THE CHECK THIS ALL EXISTS FOR
    section('Cold boot with no network');
    await context.setOffline(true);

    // CONTROL A FIRST, because it is what makes the cold-boot result mean anything. If
    // setOffline is not working, this route loads normally and says so.
    const controlPage = await context.newPage();
    const controlRes = await controlPage.goto(`${BASE}${UNVISITED_ROUTE}`, {
      waitUntil: 'domcontentloaded',
    });
    const controlTitle = await controlPage.title();
    const controlIsOfflineDoc = await controlPage.evaluate(() =>
      document.body.textContent?.includes("You're offline") ?? false
    );
    if (controlIsOfflineDoc) {
      ok(
        `control A: ${UNVISITED_ROUTE} (never opened online) falls back to /offline.html`,
        `status ${controlRes?.status() ?? '?'}`
      );
    } else {
      fail(
        `control A: ${UNVISITED_ROUTE} (never opened online) falls back to /offline.html`,
        `got "${controlTitle}" — either the network is still up (so the cold-boot check below ` +
          `is meaningless) or the fallback is unreachable`
      );
    }
    await controlPage.close();

    // A BRAND NEW PAGE in the same context: no in-memory state, no warm HTTP cache beyond
    // what the profile holds. This is a cold boot.
    const cold = await context.newPage();
    const chunkResponses: { url: string; status: number; fromSw: boolean }[] = [];
    const failedRequests: string[] = [];
    const pageErrors: string[] = [];

    cold.on('response', (res) => {
      if (new URL(res.url()).pathname.startsWith('/_next/static/')) {
        chunkResponses.push({
          url: res.url(),
          status: res.status(),
          fromSw: res.fromServiceWorker(),
        });
      }
    });
    cold.on('requestfailed', (req) => {
      if (new URL(req.url()).pathname.startsWith('/_next/static/')) failedRequests.push(req.url());
    });
    cold.on('pageerror', (err) => pageErrors.push(err.message));

    const coldRes = await cold.goto(`${BASE}/`, { waitUntil: 'load' });
    await cold.waitForTimeout(1500);

    const coldIsOfflineDoc = await cold.evaluate(() =>
      document.body.textContent?.includes("You're offline") ?? false
    );
    if (!coldIsOfflineDoc) {
      ok('/ renders real app content offline, not the fallback', `status ${coldRes?.status() ?? '?'}`);
    } else {
      fail('/ renders real app content offline, not the fallback', 'got /offline.html');
    }

    // Serving a DOCUMENT is not booting an APP. v1 served a document whose chunks 404ed.
    const servedByWorker = chunkResponses.filter((r) => r.fromSw && r.status === 200);
    if (servedByWorker.length > 0) {
      ok(
        'build chunks were served by the service worker',
        `${servedByWorker.length} of ${chunkResponses.length} /_next/static/ responses`
      );
    } else {
      fail(
        'build chunks were served by the service worker',
        `${chunkResponses.length} /_next/static/ responses, none from the worker cache`
      );
    }

    if (failedRequests.length === 0) {
      ok('no /_next/static/ request failed offline');
    } else {
      // This is the v1 signature exactly: a shell that cannot find its code.
      fail('no /_next/static/ request failed offline', `${failedRequests.length} failed`);
      for (const u of failedRequests.slice(0, 5)) note(`failed: ${u}`);
    }

    // React actually mounting is the difference between a screenshot and an app. The nav is
    // client-rendered and `/offline.html` contains no <nav> at all.
    const navCount = await cold.locator('nav').count();
    if (navCount > 0) {
      ok('the app shell hydrated', `${navCount} nav element(s)`);
    } else {
      fail('the app shell hydrated', 'no nav rendered');
    }

    if (pageErrors.length === 0) {
      ok('no uncaught page error during the offline boot');
    } else {
      fail('no uncaught page error during the offline boot', pageErrors[0]);
      for (const e of pageErrors.slice(0, 3)) note(`error: ${e}`);
    }

    // The private feed must FAIL offline rather than serve a stale copy. That is the v3/v4
    // cost, and confirming it is confirming the fix is still in place.
    const offlineApi = await cold.evaluate(async () => {
      try {
        const res = await fetch('/api/events?limit=1');
        const body = await res.text();
        return { status: res.status, offline: body.includes('"offline":true') };
      } catch (err) {
        return { status: -1, offline: false, threw: (err as Error).message };
      }
    });
    if (offlineApi.status === 503 && offlineApi.offline) {
      ok('the private feed refuses offline instead of serving a cached copy', '503 offline:true');
    } else {
      fail(
        'the private feed refuses offline instead of serving a cached copy',
        JSON.stringify(offlineApi)
      );
    }

    // And still nothing forbidden landed while offline.
    const afterForbidden = findForbidden(await snapshotCaches(cold));
    if (afterForbidden.length === 0) {
      ok('still no private or RSC entry after the offline boot');
    } else {
      for (const hit of afterForbidden) fail('cached private/RSC response (offline pass)', hit);
    }

    await context.setOffline(false);
    await cold.close();
  } finally {
    await context?.close();
    await browser?.close();
  }

  console.log(
    `\n${checks} checks, ${failures} failure${failures === 1 ? '' : 's'}` +
      (failures === 0 ? ' — cold boot works and nothing private is at rest.' : '')
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
