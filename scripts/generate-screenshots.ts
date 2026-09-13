/**
 * Capture the Play listing and web-manifest screenshots from the real app.
 *
 * ONE SET SERVES BOTH CONSUMERS, and that was worth measuring rather than assuming. The files
 * land in `public/screenshots/`, referenced by `public/manifest.json` so Chrome can show the
 * richer install dialog (title, description, carousel) instead of a bare icon and URL. The Play
 * listing uploads the same files.
 *
 * An earlier version wrote a second, flattened copy under `store-assets/screenshots/` on the
 * theory that Play needs 24-bit PNG with no alpha. Play does — but Chromium already emits exactly
 * that here: `omitBackground` defaults to false and these pages paint an opaque ground, so every
 * capture measured colour type 2 before any flattening. The copies satisfied no requirement the
 * originals did not, cost 1.4 MB in the repo, and on the event page the re-encode made the file
 * 56% LARGER (418 KB -> 655 KB). Deleted.
 *
 * `tests/manifest.test.ts` asserts the no-alpha property on the files themselves, so if a future
 * Chromium ever starts emitting an alpha channel the test fails and flattening can come back
 * then — rather than a flatten step running forever against a requirement already met.
 *
 * THE GEOMETRY RULES ARE NOT ADVISORY, and each one silently degrades rather than erroring:
 *
 *   - Each side must be 320..3840 px.
 *   - The long side must be at most 2.3x the short side. 1080x1920 is 1.78, which also satisfies
 *     Play's stricter 2x listing rule.
 *   - EVERY entry sharing a `form_factor` must share ONE aspect ratio. A single 1080x1921 among
 *     1080x1920s makes Chrome drop the whole richer dialog with no console warning anywhere.
 *   - Android shows at most 5 narrow screenshots; desktop at most 8 wide ones.
 *
 * 1080x1920 is produced as a 360x640 viewport at deviceScaleFactor 3, so the page lays out as a
 * phone and is then rendered at 3x — rather than a 1080-wide viewport, which would lay out as a
 * small desktop and show the md: breakpoint's desktop nav.
 *
 * THE INSTALL BANNER IS SUPPRESSED BEFORE NAVIGATION, deliberately. `app/components/
 * InstallPrompt.tsx` renders on `/` for a phone user agent, which is exactly what this script
 * is — so without this every screenshot of the feed would carry a banner asking the viewer to
 * install the app they are looking at in a store listing. It is suppressed by writing the same
 * `pblr-install-dismissed` key the component reads, via an init script that runs before any
 * page code, so nothing races.
 *
 * Read-only with respect to the app: it only GETs pages. Needs a server, and a database for the
 * event page (the id is looked up from the public feed API rather than hardcoded).
 *
 *   PULSEBLR_DIST_DIR=.next-verify npm run build
 *   node scripts/start-verify.js
 *   PB_BASE=http://localhost:3200 npx tsx scripts/generate-screenshots.ts
 */
import { chromium, type Browser, type Page } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE = (process.env.PB_BASE || 'http://localhost:3200').replace(/\/$/, '');
const ROOT = path.join(import.meta.dirname, '..');
const WEB_DIR = path.join(ROOT, 'public', 'screenshots');

/** Phone: 360x640 at 3x = 1080x1920. Ratio 1.78, inside both Chrome's 2.3 and Play's 2. */
const PHONE = { width: 360, height: 640, scale: 3 };
/** Desktop: 1280x720 at 1.5x = 1920x1080. */
const DESKTOP = { width: 1280, height: 720, scale: 1.5 };

const PHONE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Mobile Safari/537.36';

type Shot = {
  name: string;
  route: string;
  label: string;
  /**
   * Scroll the first event row into view before capturing. The feed's hero fills a phone screen
   * on its own — CLAUDE.md records the first ranked row sitting at y=2259 on a 390px viewport —
   * so a top-of-page capture of `/` shows the proposition and not one actual event. For a
   * listings app that is a weak listing. Both shots earn their place: one sells the idea, one
   * proves there is something behind it.
   */
  scrollToEvent?: boolean;
};

/** Public surfaces only — nothing here requires a session. */
const NARROW: Shot[] = [
  { name: 'feed', route: '/', label: "Bengaluru tech events, ranked by who you'll meet" },
  {
    name: 'feed-rows',
    route: '/',
    label: 'Every developer meetup, conference and hackathon in the city',
    scrollToEvent: true,
  },
  { name: 'calendar', route: '/calendar', label: 'A month of events at a glance' },
  { name: 'topics', route: '/topics', label: 'Browse by what you actually work on' },
];

async function suppressInstallBanner(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      // Same key app/components/InstallPrompt.tsx reads. A fresh timestamp puts it inside the
      // 30-day dismissal window, so the banner never renders.
      window.localStorage.setItem('pblr-install-dismissed', String(Date.now()));
    } catch {
      /* private-mode storage; the banner may then appear, and the caller checks for it */
    }
  });
}

async function findEventRoute(page: Page): Promise<Shot | null> {
  try {
    const res = await page.request.get(`${BASE}/api/events?limit=1`);
    if (!res.ok()) return null;
    const body = (await res.json()) as { events?: { _id: string; title: string }[] };
    const first = body.events?.[0];
    if (!first) return null;
    return {
      name: 'event',
      route: `/events/${first._id}`,
      label: 'One event: when, where, and why it is worth going',
    };
  } catch {
    return null;
  }
}

async function capture(
  browser: Browser,
  shot: Shot,
  form: 'narrow' | 'wide'
): Promise<{ bytes: number; size: string } | null> {
  const spec = form === 'narrow' ? PHONE : DESKTOP;
  const ctx = await browser.newContext({
    viewport: { width: spec.width, height: spec.height },
    deviceScaleFactor: spec.scale,
    ...(form === 'narrow' ? { userAgent: PHONE_UA, isMobile: true, hasTouch: true } : {}),
  });
  const page = await ctx.newPage();
  await suppressInstallBanner(page);

  try {
    const res = await page.goto(BASE + shot.route, { waitUntil: 'networkidle', timeout: 45_000 });
    if (!res || res.status() >= 400) {
      console.log(`  FAIL  ${shot.route} returned ${res?.status() ?? 'nothing'}`);
      return null;
    }
    // Let webfonts settle; a screenshot taken mid-swap ships the fallback face.
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(600);

    if (shot.scrollToEvent) {
      // Scroll to a real event row rather than a pixel offset: the hero's height depends on how
      // the headline wraps and which shelves have data, so any constant would drift.
      //
      // "First event link" is NOT good enough, and the first attempt here shipped that bug. Of 46
      // matching anchors on the feed, the first has a bounding rect of 0x0 at (0,0) — so it was
      // already in view, scrollIntoView correctly did nothing, and the capture was byte-identical
      // to the unscrolled one while reporting success. Require a link that is actually laid out
      // AND below the fold, then assert the window moved.
      const before = await page.evaluate(() => window.scrollY);
      // NO NAMED FUNCTION DECLARATIONS INSIDE page.evaluate. tsx compiles through esbuild, which
      // wraps named function expressions in a `__name()` helper for better stack traces — and the
      // body of an evaluate is serialised and run in the BROWSER, where that helper does not
      // exist. The failure is `ReferenceError: __name is not defined` at evaluate time, nowhere
      // near the declaration. Everything below is therefore written as inline loops.
      const target = await page.evaluate(() => {
        // Any shelf left mid-scroll shows two half-cards. Snap them all back to their first card
        // so nothing in frame is clipped, whichever row we end up centring on.
        const all = document.querySelectorAll<HTMLElement>('*');
        for (const el of all) {
          const overflowX = getComputedStyle(el).overflowX;
          if ((overflowX === 'auto' || overflowX === 'scroll') && el.scrollLeft !== 0) {
            el.scrollLeft = 0;
          }
        }

        const laidOut: Element[] = [];
        for (const el of document.querySelectorAll('a[href^="/events/"]')) {
          const r = el.getBoundingClientRect();
          if (r.height > 40 && r.width > 100 && r.top > window.innerHeight * 0.5) {
            laidOut.push(el);
          }
        }
        if (laidOut.length === 0) return false;

        // Prefer a full-width row from the day-grouped list over a carousel card, which is clipped
        // at the viewport edge and reads as a broken screenshot rather than a scrolled one.
        let row: Element = laidOut[0];
        for (const candidate of laidOut) {
          let node: Element | null = candidate.parentElement;
          let inShelf = false;
          while (node && node !== document.body) {
            const overflowX = getComputedStyle(node).overflowX;
            if (overflowX === 'auto' || overflowX === 'scroll') {
              inShelf = true;
              break;
            }
            node = node.parentElement;
          }
          if (!inShelf) {
            row = candidate;
            break;
          }
        }

        row.scrollIntoView({ block: 'center', behavior: 'instant' });
        return true;
      });
      if (!target) {
        console.log(`  FAIL  ${shot.route}: found no laid-out event row below the fold`);
        return null;
      }
      await page.waitForTimeout(900);
      const after = await page.evaluate(() => window.scrollY);
      if (after === before) {
        console.log(`  FAIL  ${shot.route}: scroll had no effect (still at y=${after})`);
        return null;
      }
    }

    if (await page.locator('[aria-label="Install PulseBLR"]').count()) {
      console.log(`  FAIL  ${shot.route}: install banner is visible, suppression did not work`);
      return null;
    }

    const png = await page.screenshot({ type: 'png' });
    const suffix = form === 'wide' ? 'wide-' : '';
    const filename = `${suffix}${shot.name}.png`;

    mkdirSync(WEB_DIR, { recursive: true });
    writeFileSync(path.join(WEB_DIR, filename), png);

    const w = spec.width * spec.scale;
    const h = spec.height * spec.scale;
    return { bytes: png.length, size: `${w}x${h}` };
  } finally {
    await ctx.close();
  }
}

async function main(): Promise<void> {
  console.log(`Capturing screenshots from ${BASE}\n`);
  const browser = await chromium.launch();
  const captured: { entry: Record<string, string>; form: string }[] = [];
  let failures = 0;

  try {
    const probe = await browser.newPage();
    const landing = await probe.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    if (!landing || landing.status() >= 400) {
      console.log('No server. Start it with `node scripts/start-verify.js`.');
      process.exitCode = 1;
      return;
    }
    const eventShot = await findEventRoute(probe);
    if (!eventShot) {
      console.log('  note  no event id from /api/events — skipping the event-page screenshot');
    }
    await probe.close();

    const narrow = eventShot ? [...NARROW, eventShot] : NARROW;

    console.log('Narrow (phone, 1080x1920):');
    for (const shot of narrow) {
      const out = await capture(browser, shot, 'narrow');
      if (!out) {
        failures++;
        continue;
      }
      console.log(`  OK    ${shot.name.padEnd(10)} ${out.size}  ${(out.bytes / 1024).toFixed(0)} KB`);
      captured.push({
        form: 'narrow',
        entry: {
          src: `/screenshots/${shot.name}.png`,
          sizes: out.size,
          type: 'image/png',
          form_factor: 'narrow',
          label: shot.label,
        },
      });
    }

    console.log('\nWide (desktop, 1920x1080):');
    const wide = await capture(browser, NARROW[0], 'wide');
    if (!wide) {
      failures++;
    } else {
      console.log(`  OK    feed       ${wide.size}  ${(wide.bytes / 1024).toFixed(0)} KB`);
      captured.push({
        form: 'wide',
        entry: {
          src: `/screenshots/wide-feed.png`,
          sizes: wide.size,
          type: 'image/png',
          form_factor: 'wide',
          label: 'The feed on a desktop',
        },
      });
    }
  } finally {
    await browser.close();
  }

  // Print the block rather than editing manifest.json in place: this script needs a server and a
  // database, so it must never be the thing that can leave the manifest half-written.
  console.log('\nPaste into public/manifest.json as "screenshots":\n');
  console.log(JSON.stringify(captured.map((c) => c.entry), null, 2));

  const narrowCount = captured.filter((c) => c.form === 'narrow').length;
  console.log(
    `\n${captured.length} captured (${narrowCount} narrow, ${captured.length - narrowCount} wide), ` +
      `${failures} failure${failures === 1 ? '' : 's'}`
  );
  if (narrowCount < 2) {
    console.log('Play requires at least 2 screenshots; the manifest wants at least 1 narrow.');
    failures++;
  }
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
