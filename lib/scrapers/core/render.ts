// Optional headless-browser rendering, for pages a plain fetch genuinely cannot read.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// READ THIS BEFORE POINTING ANYTHING NEW AT IT: A BROWSER IS THE LAST RESORT, NOT THE FIRST.
//
// This module was written for the Meetup 10-event ICS cap (see `scrapeMeetupGroupPage` in
// adapters/meetup.ts). The audit that found that cap concluded a browser was REQUIRED, because
// the group's `/events/` page yields zero JSON-LD `Event` nodes to a plain fetch. That premise
// was measured and is true — but the conclusion was wrong, and the difference is a factor of ten
// in run cost:
//
//   · rendered `/events/` page  → 0 JSON-LD Event nodes, ~7300 ms, ~470 MB of Chromium
//   · plain fetch of the SAME URL → 27 events in `__NEXT_DATA__.props.pageProps.__APOLLO_STATE__`,
//                                   ~1200 ms, no browser
//
// There are no JSON-LD Event nodes on that page in EITHER mode (only Organization, Place and
// BreadcrumbList) — so "JSON-LD is missing, therefore it must be client-rendered" was a false
// inference. The event data is server-rendered into the Next.js data island, which
// `jsonld.ts#extractNextData` has always been able to read.
//
// So the Meetup second pass uses `fetchText`, and this module is its FALLBACK: it runs only when
// the cheap path returns nothing, which today is never. Keeping it is still worth the ~200 lines,
// because the cheap path depends on Meetup continuing to server-render its data island, and the
// day that stops the fallback is the difference between a degraded source and a dead one.
//
// WHEN TO REACH FOR THIS: only after fetching the URL and confirming the data is in neither the
// HTML, a JSON-LD block, `__NEXT_DATA__`, an ICS link, nor an XHR you can call directly.
// `10times.com` (Cloudflare interstitial) is the one audited candidate that genuinely needs it.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// THREE PROPERTIES THIS MODULE MUST KEEP.
//
//  1. PLAYWRIGHT IS NEVER IN A STATIC IMPORT, AND THE SPECIFIER IS NEVER A LITERAL.
//     `app/api/scrape/route.ts` imports `runPipeline`, so the whole scraper graph is traced into
//     a serverless bundle. A static `import { chromium } from 'playwright'` anywhere in that
//     graph would try to bundle Chromium's node bindings into a Vercel function — which cannot
//     run a browser and should not be paying to carry one. Even a bare `await import('playwright')`
//     is traced, because tracing dynamic imports is how a bundler makes them work. The specifier
//     is therefore assembled at runtime AND carries `webpackIgnore`/`turbopackIgnore` (both
//     supported per node_modules/next/dist/docs/01-app/03-api-reference/08-turbopack.md), so no
//     bundler can follow it. Callers must reach this module by `await import()` too.
//
//  2. IT FAILS SOFT, ALWAYS. Every adapter in this codebase is isolated so that a dead feed
//     contributes zero events rather than failing a run (pipeline.ts, design note 2). A browser
//     is the most fragile dependency the scraper has — a missing `playwright install chromium`,
//     a sandbox refusal, an OOM on a small runner — so `renderHtml` returns `null` on every
//     failure and never throws.
//
//  3. A LAUNCH FAILURE IS FATAL ONCE, NOT 74 TIMES. If Chromium cannot launch, it will not
//     launch for the next group either. Retrying per URL turns one clear failure into ~74
//     timeouts and can push a 6-minute run past the workflow's 45-minute cap. The first launch
//     failure is remembered, reported, and every later call short-circuits to `null`.
//
// One browser per process, reused across URLs (a launch is ~470 ms and a fresh context per page
// is enough isolation), closed by `closeRenderer()`. Callers MUST call that in a `finally` — an
// un-closed Chromium keeps the Node process alive and a GitHub runner would sit until timeout.

/**
 * The slice of Playwright's surface this module uses, declared structurally.
 *
 * NOT `import type { Browser } from 'playwright'`. A type-only import is erased and would be
 * safe for the bundler, but it makes this file fail to type-check the moment Playwright is
 * removed from `dependencies` — which is a reasonable thing for somebody to do, given it is a
 * ~470 MB dependency used by one optional fallback. Structural types keep the compile
 * independent of whether the package is installed at all.
 */
interface RenderPage {
  goto(url: string, opts: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown>;
  content(): Promise<string>;
  evaluate(fn: () => unknown): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  close(): Promise<void>;
}

interface RenderContext {
  newPage(): Promise<RenderPage>;
  close(): Promise<void>;
}

interface RenderBrowser {
  newContext(opts: {
    userAgent: string;
    viewport: { width: number; height: number };
  }): Promise<RenderContext>;
  close(): Promise<void>;
}

interface PlaywrightLike {
  chromium: { launch(opts: { headless: boolean }): Promise<RenderBrowser> };
}

/** Same UA as `core/http.ts` — Meetup and friends serve stripped markup to the default one. */
const RENDER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * How many pages to render at once.
 *
 * Two. A Chromium page is ~100 MB of RSS and a GitHub runner has 7 GB shared with Node, Mongo
 * driver buffers and the whole event corpus in memory; the `fetchText` pool runs at 8 because an
 * HTTP request costs a socket. This is exported so a caller cannot pick a number that looks
 * comparable to the HTTP pool's.
 */
export const RENDER_CONCURRENCY = 2;

export interface RenderOptions {
  /** Hard navigation timeout. */
  timeoutMs?: number;
  /** Pause after DOMContentLoaded, for client-side hydration to populate the DOM. */
  settleMs?: number;
  /** Scroll-to-bottom passes, for pages that lazy-load further items. */
  scrollPasses?: number;
  /** Pause after each scroll pass. */
  scrollPauseMs?: number;
}

const DEFAULT_RENDER: Required<RenderOptions> = {
  timeoutMs: 45000,
  settleMs: 3500,
  scrollPasses: 3,
  scrollPauseMs: 1200,
};

export interface RenderStats {
  /** Calls made, including ones short-circuited after a launch failure. */
  requested: number;
  /** Calls that returned HTML. */
  rendered: number;
  /** Calls that returned null. */
  failed: number;
  /** Whether the browser is up. */
  launched: boolean;
  /** Why the browser could not start, if it could not. This is the message worth reporting. */
  launchError?: string;
  /** Wall-clock spent inside `renderHtml`, so a run can report what the browser cost. */
  totalMs: number;
}

const stats: RenderStats = {
  requested: 0,
  rendered: 0,
  failed: 0,
  launched: false,
  totalMs: 0,
};

/** Snapshot of what rendering has cost this process. */
export function renderStats(): RenderStats {
  return { ...stats };
}

let browserPromise: Promise<RenderBrowser | null> | null = null;
/** Set once a launch has failed. See property 3 in the header: one failure, not 74. */
let launchRefused = false;

async function getBrowser(): Promise<RenderBrowser | null> {
  if (launchRefused) return null;
  if (browserPromise) return browserPromise;

  browserPromise = (async () => {
    try {
      // Assembled at runtime: see property 1. Do not inline this string.
      const specifier = ['play', 'wright'].join('');
      const mod = (await import(
        /* webpackIgnore: true */ /* turbopackIgnore: true */ specifier
      )) as PlaywrightLike;
      const browser = await mod.chromium.launch({ headless: true });
      stats.launched = true;
      return browser;
    } catch (error) {
      launchRefused = true;
      stats.launchError = error instanceof Error ? error.message.split('\n')[0] : String(error);
      // Named once, loudly. A silent browser failure is indistinguishable from a source with
      // nothing scheduled, which is the exact confusion the cap this exists for caused.
      console.warn(
        `  ! headless browser unavailable — rendering disabled for this run: ${stats.launchError}`
      );
      console.warn('    (on a CI runner this usually means `npx playwright install chromium` did not run)');
      return null;
    }
  })();

  return browserPromise;
}

/**
 * Render a URL and return its HTML after hydration, or `null` if anything at all went wrong.
 *
 * Never throws. A fresh context per call, so cookies from one page cannot alter another.
 */
export async function renderHtml(url: string, opts: RenderOptions = {}): Promise<string | null> {
  const settings = { ...DEFAULT_RENDER, ...opts };
  stats.requested++;
  const startedAt = Date.now();

  const browser = await getBrowser();
  if (!browser) {
    stats.failed++;
    return null;
  }

  let context: RenderContext | null = null;
  try {
    context = await browser.newContext({
      userAgent: RENDER_UA,
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: settings.timeoutMs });
    await page.waitForTimeout(settings.settleMs);
    for (let pass = 0; pass < settings.scrollPasses; pass++) {
      await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
      await page.waitForTimeout(settings.scrollPauseMs);
    }
    const html = await page.content();
    stats.rendered++;
    return html;
  } catch (error) {
    stats.failed++;
    console.warn(
      `  ! render failed for ${url}: ${
        error instanceof Error ? error.message.split('\n')[0].slice(0, 120) : String(error)
      }`
    );
    return null;
  } finally {
    stats.totalMs += Date.now() - startedAt;
    // Closing the context closes its pages. Swallowed: a failure to close is not a scrape result.
    try {
      await context?.close();
    } catch {
      /* nothing useful to do */
    }
  }
}

/**
 * Shut the browser down. Safe to call when none was ever launched, and safe to call twice.
 *
 * MUST be called in a `finally` by whoever turned rendering on: an open Chromium holds the Node
 * event loop, so a script that forgets this exits only when the runner's timeout kills it.
 */
export async function closeRenderer(): Promise<void> {
  const pending = browserPromise;
  browserPromise = null;
  stats.launched = false;
  if (!pending) return;
  try {
    const browser = await pending;
    await browser?.close();
  } catch {
    /* already gone */
  }
}
