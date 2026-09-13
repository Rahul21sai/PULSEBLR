/**
 * Is this app actually installable, in a real browser, as a real user would meet it?
 *
 * WHY THIS CANNOT BE A VITEST SUITE. `tests/manifest.test.ts` already asserts everything that
 * can be decided by reading files: that the manifest's colours agree with `layout.tsx` and
 * `globals.css`, that every declared icon exists at its declared pixel size, that the ICO's
 * embedded PNGs are RGBA. What it cannot do is ask a browser. Installability is Chrome's
 * verdict, not ours, and the failures here are all silent:
 *
 *   - An icon URL that 404s is a missing picture, not an error. Nothing logs.
 *   - `<meta name="theme-color">` disagreeing with the manifest's `theme_color` shows up as a
 *     flash of the wrong colour on a device nobody is watching. That drift has already shipped
 *     twice in this repo.
 *   - `/.well-known/assetlinks.json` returning a redirect instead of a 200 makes the Play TWA
 *     show a browser URL bar. Indistinguishable from a wrong fingerprint, and the single most
 *     common TWA failure.
 *   - A manifest Chrome rejects still parses as JSON perfectly well.
 *
 * TWO CONTROLS THAT MUST FIRE, because this repo's own history is that every probe failure in
 * the last design pass was a check which silently could not fail:
 *
 *   1. A URL known to be absent must be reported as missing. If the fetch helper is broken and
 *      resolves everything, this catches it.
 *   2. The install prompt must be ABSENT on a desktop browser that fired no
 *      `beforeinstallprompt`. A component that renders unconditionally would pass a
 *      "does the banner appear" check and be wrong.
 *
 * Read-only: no DB, no writes, no sign-in. Needs a server.
 *
 *   PULSEBLR_DIST_DIR=.next-verify npm run build
 *   node scripts/start-verify.js
 *   PB_BASE=http://localhost:3200 npx tsx scripts/diag-pwa.ts
 *
 * Point `PB_BASE` at production to check `assetlinks.json`, which only means anything on the
 * host the TWA is pinned to.
 *
 * Exits non-zero on any contradiction.
 */
import { chromium, devices, type Browser } from 'playwright';

const BASE = (process.env.PB_BASE || 'http://localhost:3200').replace(/\/$/, '');

/** An iPhone Safari UA. The install path on iOS is driven entirely by UA sniffing. */
const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const INSTALL_BANNER = '[aria-label="Install PulseBLR"]';

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
function section(name: string): void {
  console.log(`\n${name}`);
}

type ManifestIcon = { src: string; sizes: string; type?: string };
type Manifest = {
  theme_color: string;
  background_color: string;
  icons: ManifestIcon[];
  screenshots?: ManifestIcon[];
  shortcuts?: { icons?: ManifestIcon[] }[];
};

async function main(): Promise<void> {
  console.log(`PWA diagnostics against ${BASE}`);
  let browser: Browser | undefined;

  try {
    browser = await chromium.launch();
    const page = await browser.newPage();

    const landing = await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    if (!landing || landing.status() >= 400) {
      fail('server reachable', `GET / returned ${landing?.status() ?? 'no response'}`);
      console.log('\nNothing else can be checked without a server. Is start-verify.js running?');
      process.exitCode = 1;
      return;
    }
    ok('server reachable', `GET / ${landing.status()}`);

    // ---------------------------------------------------------------- manifest, fetched
    section('Manifest');
    const manifestRes = await page.request.get(`${BASE}/manifest.json`);
    if (!manifestRes.ok()) {
      fail('manifest.json fetched', String(manifestRes.status()));
      process.exitCode = 1;
      return;
    }
    const manifest = (await manifestRes.json()) as Manifest;
    ok('manifest.json fetched', `${manifestRes.status()} ${manifestRes.headers()['content-type']}`);

    // ------------------------------------------------- Chrome's own installability verdict
    // This is the decisive check. Nothing else substitutes for asking the browser that will
    // actually be asked to install the thing.
    const cdp = await page.context().newCDPSession(page);
    // `critical` is a NUMBER in the CDP protocol, not a boolean — typing it as boolean compiles
    // under tsx (which only strips types) and fails `tsc --noEmit`. Worth stating because this
    // whole branch is skipped when the manifest is clean, so a green run of this script does not
    // typecheck it.
    const appManifest = await cdp.send('Page.getAppManifest');
    const manifestErrors = appManifest.errors ?? [];
    const critical = manifestErrors.filter((e) => e.critical !== 0);
    if (critical.length === 0) {
      ok('Chrome reports no critical manifest errors');
    } else {
      for (const e of critical) fail('Chrome manifest error', `line ${e.line}: ${e.message}`);
    }
    for (const e of manifestErrors.filter((x) => x.critical === 0)) {
      console.log(`  note  non-critical: ${e.message}`);
    }

    // ------------------------------------------------------------------ every icon resolves
    section('Declared assets resolve over HTTP');
    // Screenshots belong in here too. They were omitted at first and the count gave it away:
    // adding six manifest entries left the check total unchanged at 18. A missing screenshot is
    // exactly the kind of thing this script exists for — Chrome silently drops the richer install
    // dialog rather than reporting a broken URL.
    const declared = [
      ...manifest.icons.map((i) => i.src),
      ...(manifest.screenshots ?? []).map((s) => s.src),
      ...(manifest.shortcuts ?? []).flatMap((s) => (s.icons ?? []).map((i) => i.src)),
    ];
    for (const src of [...new Set(declared)]) {
      const res = await page.request.get(`${BASE}${src}`);
      const type = res.headers()['content-type'] ?? '';
      const expected = src.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
      if (!res.ok()) {
        fail(src, `status ${res.status()}`);
      } else if (!type.startsWith(expected)) {
        fail(src, `content-type ${type}, expected ${expected}`);
      } else {
        ok(src, `${res.status()} ${type}`);
      }
    }

    // CONTROL 1. A path that cannot exist must be reported as missing. If this "passes", the
    // fetch above proves nothing about the icons.
    const controlRes = await page.request.get(`${BASE}/icon-does-not-exist-0000.png`);
    if (controlRes.status() === 404) {
      ok('control: absent asset reports 404');
    } else {
      fail('control: absent asset reports 404', `got ${controlRes.status()} — the asset check is not discriminating`);
    }

    // ---------------------------------------------------- theme-color agrees at runtime
    section('Runtime theme colour');
    const metaTheme = await page
      .locator('meta[name="theme-color"]')
      .first()
      .getAttribute('content');
    if (metaTheme && metaTheme.toUpperCase() === manifest.theme_color.toUpperCase()) {
      ok('meta theme-color matches manifest theme_color', metaTheme);
    } else {
      fail(
        'meta theme-color matches manifest theme_color',
        `meta=${metaTheme ?? 'absent'} manifest=${manifest.theme_color}`
      );
    }

    // ------------------------------------------------------------- icon tags, exactly one
    section('Icon tags in the document');
    const iconLinks = await page.locator('link[rel="icon"]').count();
    if (iconLinks === 1) {
      ok('exactly one <link rel="icon">');
    } else {
      // Two used to be emitted: a hand-written SVG tag in layout.tsx competing with the one
      // Next generates for app/favicon.ico, leaving the choice to the browser.
      fail('exactly one <link rel="icon">', `found ${iconLinks}`);
    }
    const appleHref = await page
      .locator('link[rel="apple-touch-icon"]')
      .first()
      .getAttribute('href');
    if (appleHref && !appleHref.includes('.svg')) {
      ok('apple-touch-icon is a raster image', appleHref.split('?')[0]);
    } else {
      // iOS ignores an SVG here entirely and screenshots the page for the home screen.
      fail('apple-touch-icon is a raster image', appleHref ?? 'absent');
    }

    // ---------------------------------------------------------- install prompt behaviour
    section('Install prompt');

    // CONTROL 2. Desktop Chromium fires no beforeinstallprompt here, so the banner must NOT
    // render. A component that shows unconditionally would sail through the iOS check below.
    const desktopCount = await page.locator(INSTALL_BANNER).count();
    if (desktopCount === 0) {
      ok('control: absent on a browser that offered no install event');
    } else {
      fail('control: absent on a browser that offered no install event', 'banner rendered anyway');
    }
    await page.close();

    // iOS gets instructions instead, because it fires no event and exposes no API.
    const iosCtx = await browser.newContext({ ...devices['iPhone 13'], userAgent: IOS_UA });
    const iosPage = await iosCtx.newPage();
    await iosPage.goto(`${BASE}/`, { waitUntil: 'networkidle' });

    const banner = iosPage.locator(INSTALL_BANNER);
    if ((await banner.count()) === 0) {
      fail('iOS Safari is offered the add-to-home-screen path');
    } else {
      ok('iOS Safari is offered the add-to-home-screen path');

      // It must clear the bottom nav. `--bottomnav-h` exists so this is not a measured
      // constant: the nav's height contains env(safe-area-inset-bottom), which is 0 headless
      // and ~34px on a notched phone.
      const geometry = await iosPage.evaluate((selector) => {
        const el = document.querySelector(selector);
        const nav = [...document.querySelectorAll('nav')].find(
          (n) => getComputedStyle(n).position === 'fixed' && getComputedStyle(n).bottom === '0px'
        );
        if (!el || !nav) return null;
        return {
          bannerBottom: el.getBoundingClientRect().bottom,
          navTop: nav.getBoundingClientRect().top,
        };
      }, INSTALL_BANNER);

      if (!geometry) {
        fail('install banner clears the bottom nav', 'could not locate both elements');
      } else if (geometry.bannerBottom <= geometry.navTop + 0.5) {
        ok(
          'install banner clears the bottom nav',
          `banner ends ${Math.round(geometry.bannerBottom)}, nav starts ${Math.round(geometry.navTop)}`
        );
      } else {
        fail(
          'install banner clears the bottom nav',
          `banner ends ${Math.round(geometry.bannerBottom)} but nav starts ${Math.round(geometry.navTop)}`
        );
      }

      // The instructions have to actually open, or the only affordance on iOS is a dead end.
      await banner.getByRole('button', { name: 'How' }).click();
      await iosPage.waitForTimeout(300);
      if ((await iosPage.locator('[role="dialog"]').count()) > 0) {
        ok('the how-to sheet opens');
      } else {
        fail('the how-to sheet opens');
      }
    }
    await iosCtx.close();

    // ------------------------------------------------------------------- Digital Asset Links
    section('Digital Asset Links (Play TWA)');
    const alRes = await (await browser.newPage()).request.get(`${BASE}/.well-known/assetlinks.json`);
    if (alRes.status() === 404) {
      // Not yet a failure: this file is written once the Play upload key exists. Say so plainly
      // rather than reporting a pass or a fail for something that is simply not done yet.
      console.log('  pend  /.well-known/assetlinks.json is absent (expected until the first Play upload)');
    } else if (!alRes.ok()) {
      fail('assetlinks.json returns 200', `status ${alRes.status()}`);
    } else {
      const type = alRes.headers()['content-type'] ?? '';
      if (!type.includes('json')) {
        fail('assetlinks.json content-type is JSON', type);
      } else {
        try {
          type AssetLinkStatement = {
            relation?: string[];
            target?: {
              namespace?: string;
              package_name?: string;
              sha256_cert_fingerprints?: string[];
            };
          };
          const statements = (await alRes.json()) as AssetLinkStatement[];
          const fingerprints = statements.flatMap(
            (s) => s.target?.sha256_cert_fingerprints ?? []
          );
          ok('assetlinks.json parses', `${statements.length} statement(s)`);
          // Play App Signing re-signs the upload, so BOTH the upload and the Play signing
          // fingerprint have to be listed or the store build fails verification while a
          // locally-installed APK succeeds.
          if (fingerprints.length >= 2) {
            ok('assetlinks lists at least two fingerprints (upload + Play signing)');
          } else {
            fail(
              'assetlinks lists at least two fingerprints (upload + Play signing)',
              `found ${fingerprints.length} — a Play-installed TWA will show a URL bar`
            );
          }
        } catch {
          fail('assetlinks.json parses as JSON');
        }
      }
    }
  } finally {
    await browser?.close();
  }

  console.log(
    `\n${checks} checks, ${failures} failure${failures === 1 ? '' : 's'}` +
      (failures === 0 ? ' — installable.' : '')
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
