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
 *   2. NO API RESPONSE AT REST, AT ALL. Since v6 the rule is not "these private routes" but
 *      "every /api/ route", so the scanner flags ANY Cache Storage key whose path — decoded,
 *      slashes collapsed, lowercased, the way the worker judges it — is under /api/, plus any
 *      `?_rsc=` url. This is the v2-v6 bug in its general form: the leak was never in the
 *      reading, it was in the writing. `/api/people` is fetched by name because it is the v6
 *      leak, but ANONYMOUSLY it answers 401, which `mayStore()` refused anyway — so it cannot
 *      fail. The probe that CAN is `/api/companies`: a public 200 with no Cache-Control, which
 *      v5's network-first branch stored. Control E below insists at least one probe was a 200.
 *
 *   3. ONLY CURRENT CACHE NAMES SURVIVE, and the server is serving the worker this script
 *      expects. A stale `-v5` cache left behind by `activate` is the v6 leak preserved intact —
 *      it is where the People JSON sits.
 *
 * FIVE CONTROLS THAT MUST FIRE. Every probe failure in this repo's last design pass was a
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
 *   D. A planted `pulseblr-dynamic-v5` cache must be REPORTED by the version check. Same
 *      argument: "every name is current" is trivially true of an empty list.
 *   E. At least one /api/ probe must come back 200 through the worker. A 401 or 500 is never
 *      stored by any version of the worker, so if every probe was refused, check 2 measured
 *      `mayStore()`, not the v6 rule. (`/api/companies` needs the database — a 500 here usually
 *      means the verify server has no MONGODB_URI.)
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

/** The worker version this script expects the server to be serving. Bump with public/sw.js. */
const EXPECTED_VERSION = 'v6';

/**
 * Would the worker treat this cache key as an API url? Deliberately written here rather than
 * lifted out of sw.js: a scanner that shares the worker's matcher shares its blind spots. Same
 * breadth — decoded, `\` folded, repeated slashes collapsed, lowercased — and an undecodable
 * key is flagged, since the worker refuses those too.
 */
function isApiKey(url: string): boolean {
  let p = new URL(url).pathname;
  try {
    p = decodeURIComponent(p);
  } catch {
    return true;
  }
  p = p.split('\\').join('/').toLowerCase();
  while (p.includes('//')) p = p.split('//').join('/');
  return p === '/api' || p.startsWith('/api/');
}

/**
 * Fetched through the controlling worker, online. Only the ones answering 200 can discriminate —
 * see control E.
 */
const API_PROBES = [
  // THE DISCRIMINATING ONE: public, 200, no Cache-Control. v5 stored exactly this.
  '/api/companies?includeEmpty=true',
  // The same handler by a spelling Next decodes to it in production — why isApiRequest() decodes.
  '/%61pi/companies',
  // The v6 leak, by name. Anonymous here, so 401: named for the record, not because they can fail.
  '/api/people',
  '/api/people/facets',
  '/api/people/merge',
  '/api/sources',
  // Network-only since v4/v3; kept so the older rules are still exercised.
  '/api/events?limit=1',
  '/api/tracker',
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

/** The /api/ + RSC scanner. Shared by check 2 and control C, deliberately. */
function findForbidden(snapshot: CacheSnapshot): string[] {
  const hits: string[] = [];
  for (const { name, keys } of snapshot) {
    for (const url of keys) {
      const search = new URL(url).search;
      if (isApiKey(url)) hits.push(`${name} → ${url}`);
      else if (/[?&]_rsc(=|$|&)/.test(search)) hits.push(`${name} → ${url}`);
    }
  }
  return hits;
}

/** The version scanner. Shared by check 3 and control D. */
function findStaleCaches(snapshot: CacheSnapshot): string[] {
  return snapshot.map((c) => c.name).filter((name) => !name.endsWith(`-${EXPECTED_VERSION}`));
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

    // A stale build looks exactly like the fix not working (CLAUDE.md §7), so establish WHICH
    // worker is being measured before measuring it.
    const swBody = swRes.ok() ? await swRes.text() : '';
    const served = swBody.match(/const VERSION\s*=\s*'([^']+)'/)?.[1];
    if (served === EXPECTED_VERSION) {
      ok('the server is serving the expected worker', `VERSION ${served}`);
    } else {
      fail(
        'the server is serving the expected worker',
        `expected ${EXPECTED_VERSION}, got ${served ?? 'no VERSION found'} — rebuild before trusting anything below`
      );
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
    section('API and RSC requests leave nothing behind');
    const fetchProbe = await page.evaluate(async (apiProbes) => {
      const results: Record<string, number | string> = {};
      const urls = [
        ...apiProbes,
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
    }, API_PROBES);
    for (const [url, status] of Object.entries(fetchProbe)) note(`${url} → ${status}`);

    // A TOP-LEVEL NAVIGATION to an API url. Under v5 it reached the network-first navigation
    // branch and was stored; v6 checks the API rule before that branch.
    const navProbe = await context.newPage();
    const navRes = await navProbe
      .goto(`${BASE}/api/companies?probe=navigate`, { waitUntil: 'domcontentloaded' })
      .catch(() => null);
    note(`navigate /api/companies?probe=navigate → ${navRes?.status() ?? 'no response'}`);
    await navProbe.close();
    await page.waitForTimeout(800);

    // CONTROL E. Only a 200 could ever have been stored; without one, the check below is vacuous.
    const api200 = API_PROBES.filter((u) => fetchProbe[u] === 200);
    if (api200.length > 0 || navRes?.status() === 200) {
      ok('control E: an /api/ probe returned 200, so the scan below can fail', api200.join(', '));
    } else {
      fail(
        'control E: an /api/ probe returned 200, so the scan below can fail',
        'every probe was refused before a cache could matter — check 2 proves nothing (DB down?)'
      );
    }

    let snapshot = await snapshotCaches(page);
    const forbidden = findForbidden(snapshot);
    if (forbidden.length === 0) {
      ok('no /api/ or RSC response is in Cache Storage');
    } else {
      for (const hit of forbidden) fail('cached /api/ or RSC response', hit);
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

    // CONTROL C. Plant entries the scanner MUST catch — one plain, one in an encoded spelling so
    // the scanner's decoding is proved too — then remove them.
    const canaries = ['/api/tracker/CANARY-diag-offline', '/%61pi/people/CANARY-diag-offline-encoded'];
    const plantIn = `pulseblr-dynamic-${EXPECTED_VERSION}`;
    await page.evaluate(
      async ({ urls, name }) => {
        const cache = await caches.open(name);
        for (const url of urls) await cache.put(new Request(url), new Response('canary'));
      },
      { urls: canaries, name: plantIn }
    );
    const planted = findForbidden(await snapshotCaches(page));
    const caught = canaries.filter((c) => planted.some((h) => h.endsWith(c)));
    if (caught.length === canaries.length) {
      ok('control C: the scanner detects planted API entries, encoded spelling included');
    } else {
      fail(
        'control C: the scanner detects planted API entries, encoded spelling included',
        `caught ${caught.length} of ${canaries.length} — the clean result above is not evidence of anything`
      );
    }
    await page.evaluate(
      async ({ urls, name }) => {
        const cache = await caches.open(name);
        for (const url of urls) await cache.delete(new Request(url));
      },
      { urls: canaries, name: plantIn }
    );

    // --------------------------------------------------------------- cache versions
    section('Cache versions');
    snapshot = await snapshotCaches(page);
    const stale = findStaleCaches(snapshot);
    if (stale.length === 0) {
      ok(
        `every surviving cache is -${EXPECTED_VERSION}`,
        snapshot.map((c) => c.name).join(', ') || 'none'
      );
    } else {
      // v5's dynamic cache is where the People JSON lives on devices that opened /people.
      for (const name of stale) fail('stale cache survived activate', name);
    }

    // CONTROL D. "Every name is current" is trivially true of an empty list.
    await page.evaluate(() => caches.open('pulseblr-dynamic-v5'));
    if (findStaleCaches(await snapshotCaches(page)).includes('pulseblr-dynamic-v5')) {
      ok('control D: the version check detects a planted stale cache');
    } else {
      fail('control D: the version check detects a planted stale cache');
    }
    await page.evaluate(() => caches.delete('pulseblr-dynamic-v5'));

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

    // The v6 rule, observed from the READ side: a PUBLIC api that v5 would have answered from
    // its cached copy must now refuse offline too.
    const offlineCompanies = await cold.evaluate(async () => {
      try {
        const res = await fetch('/api/companies?includeEmpty=true');
        const body = await res.text();
        return { status: res.status, offline: body.includes('"offline":true') };
      } catch (err) {
        return { status: -1, offline: false, threw: (err as Error).message };
      }
    });
    if (offlineCompanies.status === 503 && offlineCompanies.offline) {
      ok('a public API refuses offline too — no /api/ copy is served', '503 offline:true');
    } else {
      fail('a public API refuses offline too — no /api/ copy is served', JSON.stringify(offlineCompanies));
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
