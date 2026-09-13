import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The service worker's CACHING POLICY, asserted by reading `public/sw.js` as text.
 *
 * THESE ASSERTIONS ARE CRUDE AND THIS FILE SAYS SO UP FRONT. `public/sw.js` is a plain
 * browser script with no exports — it registers listeners on `self` and reaches for
 * `caches`, `clients` and `registration`, none of which exist in Node. It cannot be
 * imported, so nothing here executes a single line of it. A regex over source text cannot
 * tell you the worker WORKS; `scripts/diag-offline.ts` drives a real Chromium for that, and
 * it is the only thing that can.
 *
 * WHAT THIS FILE IS FOR, then, and why it is worth having anyway: the failure it catches is
 * somebody deleting a `PRIVATE_API` prefix, or reordering two branches, during an unrelated
 * refactor. That is not a hypothetical risk in this file — it is the ENTIRE VERSION HISTORY
 * of it. v2 leaked one account's data to the next because a caching rule was broader than
 * anyone had checked; v3 fixed it; v4 was needed because `/api/events` gained private rows
 * and nobody re-asked the question; v5 was needed because RSC payloads had been landing in
 * the cache-first branch all along. Three leaks, all silent, none of which any test would
 * have had to be clever to catch — only present.
 *
 * COMMENTS ARE STRIPPED BEFORE ANY ASSERTION RUNS. Without that, this suite is worse than
 * useless: `sw.js`'s changelog names `ignoreSearch`, `_rsc` and `/_next/static/webpack/`
 * while EXPLAINING them, so a prose mention would satisfy a check about code. Every
 * assertion below reads `swCode`, never `swSource`.
 *
 * The ORDERING assertions are the load-bearing ones. A branch that is present but sits
 * after the early return that would have caught the request first is dead code that reads as
 * a fix — the single most likely way this file regresses.
 */

const ROOT = path.join(import.meta.dirname, '..');

const swSource = readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
const offlineHtml = readFileSync(path.join(ROOT, 'public', 'offline.html'), 'utf8');
const globalsCss = readFileSync(path.join(ROOT, 'app', 'globals.css'), 'utf8');
const nextConfig = readFileSync(path.join(ROOT, 'next.config.ts'), 'utf8');

/**
 * Remove comments, keeping strings intact.
 *
 * A CHARACTER SCANNER RATHER THAN TWO REGEXES, and the first draft of this file proves why
 * it has to be. `/\/\*[\s\S]*?\*\//g` looks obviously correct and is not: `sw.js`'s
 * changelog contains the text `/_next/static/webpack/*` inside a `//` line comment, and the
 * `/*` in that path opened a block comment that ran on until the next `*​/` far below —
 * swallowing the three `const …_CACHE` declarations with it. The symptom was two
 * cache-naming assertions failing against a `sw.js` that was perfectly correct, i.e. the
 * instrument reporting a fault in the thing it was measuring. This repo's own rule, recorded
 * in CLAUDE.md §17: when a measurement disagrees with the code, the instrument is the first
 * suspect.
 *
 * Order cannot fix it either — stripping line comments first breaks on any block comment
 * containing `//`. Tracking the state is the only version that is right for both.
 *
 * Strings are preserved deliberately: every assertion below matches on literals like
 * `'/api/events'`, so a stripper that removed string bodies would make the whole suite
 * vacuous. REGEX LITERALS ARE NOT TRACKED — `sw.js` contains none, and the control block
 * below is what keeps that true.
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') {
          out += src.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const swCode = stripComments(swSource);

/** The nine prefixes that must never quietly lose a member. */
const REQUIRED_PRIVATE_PREFIXES = [
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

/** The body of `self.addEventListener('fetch', …)`, to the end of the file. */
function fetchHandler(): string {
  const start = swCode.indexOf("addEventListener('fetch'");
  expect(start, "the fetch listener must exist").toBeGreaterThan(-1);
  // Everything up to the next top-level listener registration is the handler.
  const next = swCode.indexOf("addEventListener('message'", start);
  return swCode.slice(start, next === -1 ? undefined : next);
}

describe('sw.js — the stripper itself (control)', () => {
  it('removes comments but leaves the code', () => {
    // If this fails, every other assertion here is meaningless: either nothing was
    // stripped (so prose can satisfy a code check) or too much was.
    expect(swCode.length).toBeLessThan(swSource.length);
    expect(swSource).toContain('ignoreSearch'); // present in prose
    expect(swCode).toContain('isRscRequest');
    expect(swCode).toContain('PRIVATE_API');
    expect(swCode).toContain("addEventListener('fetch'");
  });

  it('does not over-strip: every top-level declaration survives', () => {
    // THE ASSERTION THE FIRST DRAFT NEEDED. A `/*` inside a line comment made the old
    // regex stripper eat 60 lines of real code, and the only visible symptom was two
    // unrelated assertions failing. Name the landmarks so an over-eager stripper is
    // reported as itself.
    for (const decl of [
      'const VERSION',
      'const STATIC_CACHE',
      'const ASSET_CACHE',
      'const DYNAMIC_CACHE',
      'const CURRENT_CACHES',
      'const OFFLINE_URL',
      'const PRIVATE_API',
      'const STATIC_ASSETS',
      'function isPrivateApi',
      'function isRscRequest',
      'function isImmutableBuildAsset',
      'function mayStore',
      'function trimAssetCache',
      'function stash',
    ]) {
      expect(swCode, `stripComments() removed ${decl}`).toContain(decl);
    }
  });

  it('leaves string literals intact', () => {
    // Every assertion in this file matches on literals like '/api/events'. A stripper
    // that removed string bodies would make the suite pass vacuously forever.
    expect(swCode).toContain("'/api/tracker'");
    expect(swCode).toContain("'/offline.html'");
  });

  it('sw.js contains no regex literal, which is what the stripper assumes', () => {
    // Stated as an assertion rather than a comment: the scanner does not track regex
    // literals, so a future `/…/.test(x)` here could hide a `//` from it.
    expect(swCode).not.toMatch(/=\s*\/[^/*\s][^\n]*\/[gimsuy]*[;.)]/);
  });
});

describe('sw.js — cache naming', () => {
  it('every cache name ends -v5', () => {
    const names = [...swCode.matchAll(/`pulseblr-[a-z]+-\$\{VERSION\}`/g)];
    expect(names.length).toBeGreaterThanOrEqual(3);
    expect(swCode).toMatch(/const VERSION\s*=\s*'v5'/);
  });

  it('declares three caches and lists all of them as current', () => {
    // Three so the unbounded asset store can be trimmed without discarding the
    // hand-authored offline page.
    for (const name of ['STATIC_CACHE', 'ASSET_CACHE', 'DYNAMIC_CACHE']) {
      expect(swCode).toContain(`const ${name} =`);
      expect(swCode).toMatch(new RegExp(`CURRENT_CACHES\\s*=\\s*\\[[^\\]]*${name}`));
    }
  });

  it('no stale version literal survives anywhere in the code', () => {
    // A hardcoded 'pulseblr-static-v4' left behind would keep a poisoned cache alive
    // past activate, which is exactly what the bump exists to prevent.
    expect(swCode).not.toMatch(/pulseblr-[a-z]+-v[0-4]\b/);
  });
});

describe('sw.js — private API stays network-only', () => {
  it('retains all nine PRIVATE_API prefixes', () => {
    const block = swCode.match(/const PRIVATE_API\s*=\s*\[([\s\S]*?)\]/);
    expect(block, 'PRIVATE_API must still be a literal array').not.toBeNull();
    const body = block![1];
    for (const prefix of REQUIRED_PRIVATE_PREFIXES) {
      expect(body, `PRIVATE_API lost ${prefix}`).toContain(`'${prefix}'`);
    }
  });

  it('the private branch never reads or writes a cache', () => {
    const handler = fetchHandler();
    const guard = handler.indexOf('isPrivateApi(url.pathname)');
    expect(guard).toBeGreaterThan(-1);
    // From the guard to the `return` that closes its block, there must be no cache
    // access at all — that is what "network only" means, and a cache read here is how
    // one account reads the previous account's data.
    const branch = handler.slice(guard, handler.indexOf('return;', guard));
    expect(branch).not.toContain('caches.');
    expect(branch).not.toContain('stash(');
  });
});

describe('sw.js — RSC payloads are network-only (the v5 fix)', () => {
  it('detects the _rsc query param by presence, not by substring', () => {
    // Next pushes a BARE `_rsc` with no `=` when the computed hash is empty, so a test
    // for the string '_rsc=' misses that form entirely.
    expect(swCode).toMatch(/searchParams\.has\(\s*'_rsc'\s*\)/);
  });

  it('also detects the RSC request header', () => {
    expect(swCode).toMatch(/headers\.get\(\s*'rsc'\s*\)/);
  });

  it('checks for RSC BEFORE any cache is consulted', () => {
    // THE ORDERING IS THE WHOLE FIX. An RSC request carries a PAGE pathname, so if any
    // cache-first branch runs first it wins and the payload is cached forever — which is
    // precisely the bug v5 exists to close.
    const handler = fetchHandler();
    const rscCheck = handler.indexOf('isRscRequest(');
    const firstCacheRead = handler.indexOf('caches.match(');
    expect(rscCheck).toBeGreaterThan(-1);
    expect(firstCacheRead).toBeGreaterThan(-1);
    expect(rscCheck).toBeLessThan(firstCacheRead);
  });

  it('the RSC branch never touches a cache', () => {
    const handler = fetchHandler();
    const guard = handler.indexOf('isRscRequest(request, url)');
    expect(guard).toBeGreaterThan(-1);
    const branch = handler.slice(guard, handler.indexOf('return;', guard));
    expect(branch).not.toContain('caches.');
    expect(branch).not.toContain('stash(');
  });
});

describe('sw.js — immutable build assets are cache-first (the cold-boot fix)', () => {
  it('allows /_next/static/ by a positive prefix test', () => {
    expect(swCode).toMatch(/startsWith\(\s*'\/_next\/static\/'\s*\)/);
  });

  it('excludes the one mutable thing under that prefix', () => {
    // Hot-update chunks are not content-hashed and must never be served from cache.
    expect(swCode).toMatch(/startsWith\(\s*'\/_next\/static\/webpack\/'\s*\)/);
    const fn = swCode.match(/function isImmutableBuildAsset[\s\S]*?\n}/);
    expect(fn).not.toBeNull();
    expect(fn![0]).toContain('webpack');
    expect(fn![0]).toContain('return false');
  });

  it('runs the allow-list BEFORE the blanket /_next/ passthrough', () => {
    // Flip these two and the allow-list becomes unreachable dead code that still reads
    // as a working fix — nothing boots offline and no test would notice.
    const handler = fetchHandler();
    const allow = handler.indexOf('isImmutableBuildAsset(url.pathname)');
    const passthrough = handler.search(/startsWith\(\s*'\/_next\/'\s*\)/);
    expect(allow).toBeGreaterThan(-1);
    expect(passthrough).toBeGreaterThan(-1);
    expect(allow).toBeLessThan(passthrough);
  });

  it('NEVER ignores the query string', () => {
    // `?dpl=<deployment>` is part of the identity of a skew-protected asset. Ignoring it
    // serves a previous deployment's chunk against new HTML — chunk-load failure, which
    // is the v1 class of bug through a new door.
    expect(swCode).not.toContain('ignoreSearch');
  });

  it('bounds the asset cache and trims oldest-first', () => {
    expect(swCode).toMatch(/ASSET_CACHE_MAX\s*=\s*\d+/);
    const trim = swCode.match(/async function trimAssetCache[\s\S]*?\n}/);
    expect(trim).not.toBeNull();
    // `Cache.keys()` is insertion-ordered, so slicing from the FRONT evicts the oldest
    // deployment. Slicing from the end would evict the deployment currently in use.
    expect(trim![0]).toMatch(/slice\(\s*0\s*,/);
    expect(trim![0]).toContain('cache.delete');
  });
});

describe('sw.js — navigations stay network-first', () => {
  it('fetches before falling back to cache', () => {
    const handler = fetchHandler();
    const guard = handler.indexOf("request.mode === 'navigate'");
    expect(guard).toBeGreaterThan(-1);
    const branch = handler.slice(guard);
    const networkCall = branch.indexOf('fetch(request)');
    const cacheRead = branch.indexOf('caches.match(request)');
    expect(networkCall).toBeGreaterThan(-1);
    expect(cacheRead).toBeGreaterThan(-1);
    // v1 served navigations cache-first and poisoned browsers with a stale shell whose
    // chunks had been deleted. The network call must come first, forever.
    expect(networkCall).toBeLessThan(cacheRead);
  });

  it('falls back to the offline document only after a cache miss', () => {
    const handler = fetchHandler();
    const branch = handler.slice(handler.indexOf("request.mode === 'navigate'"));
    const cacheRead = branch.indexOf('caches.match(request)');
    const shell = branch.indexOf('OFFLINE_URL');
    expect(shell).toBeGreaterThan(cacheRead);
  });

  it('refuses to store a response the server marked private or no-store', () => {
    // Cache Storage does not honour cache directives; this has to be done by hand. It is
    // what keeps a server-rendered PRIVATE event page's document out of the shared store
    // without duplicating lib/protected-routes.ts into this file.
    const fn = swCode.match(/function mayStore[\s\S]*?\n}/);
    expect(fn).not.toBeNull();
    expect(fn![0]).toContain('no-store');
    expect(fn![0]).toContain('private');
    // A 206 makes `put()` throw, so only a clean 200 is storable.
    expect(fn![0]).toMatch(/status !== 200/);
  });
});

describe('sw.js — the cache sweep must not reach IndexedDB', () => {
  it('activate deletes caches and nothing else', () => {
    const start = swCode.indexOf("addEventListener('activate'");
    expect(start).toBeGreaterThan(-1);
    const activate = swCode.slice(start, swCode.indexOf("addEventListener('fetch'", start));
    expect(activate).toContain('caches.delete');
    // lib/scan/outbox.ts keeps the offline scan queue in IndexedDB PRECISELY because a
    // version bump erases Cache Storage. An unsynced capture is a person you met.
    expect(activate).not.toContain('indexedDB');
  });

  it('nothing anywhere in the worker touches IndexedDB', () => {
    expect(swCode).not.toContain('indexedDB');
    expect(swCode).not.toContain('deleteDatabase');
  });
});

describe('sw.js — push handlers', () => {
  it('uses a raster notification icon, never an SVG', () => {
    const start = swCode.indexOf("addEventListener('push'");
    expect(start).toBeGreaterThan(-1);
    const push = swCode.slice(start, swCode.indexOf("addEventListener('notificationclick'", start));
    // Android renders nothing for an SVG notification icon and logs nothing either.
    expect(push).toMatch(/icon:\s*'\/icon-\d+\.png'/);
    expect(push).toMatch(/badge:\s*'\/icon-\d+\.png'/);
    expect(push).not.toContain('.svg');
    // A malformed payload must not throw inside the handler.
    expect(push).toContain('try');
  });

  it('supports a tag but does not re-alert on a replacement', () => {
    const start = swCode.indexOf("addEventListener('push'");
    const push = swCode.slice(start, swCode.indexOf("addEventListener('notificationclick'", start));
    // The tag coalesces repeat notifications about one event. `renotify` would re-buzz for
    // content already on screen, which is the noise the tag exists to suppress — and with an
    // empty tag it is a spec-level TypeError, so the two cannot be split safely.
    expect(push).toMatch(/options\.tag\s*=/);
    expect(push).not.toContain('renotify');
  });

  it('focuses an existing window rather than opening a duplicate', () => {
    const start = swCode.indexOf("addEventListener('notificationclick'");
    expect(start).toBeGreaterThan(-1);
    const click = swCode.slice(start);
    expect(click).toContain('matchAll');
    expect(click).toContain('includeUncontrolled');
    expect(click).toContain('.focus()');
    // openWindow must be reachable only after the match attempt, or an installed PWA
    // opens a second instance on every notification tap.
    expect(click.indexOf('matchAll')).toBeLessThan(click.indexOf('openWindow'));
  });
});

describe('offline.html — the fallback document', () => {
  it('contains no JavaScript at all', () => {
    // Not a style preference. This is the one document served when the worker's own
    // assumptions have already failed, so it must not depend on anything running.
    expect(offlineHtml).not.toMatch(/<script/i);
    expect(offlineHtml).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it('references no external resource, so it cannot fail offline', () => {
    // Any <link href>, external stylesheet or remote font would 404 in exactly the
    // situation this file exists for. Structural immunity, not good intentions.
    expect(offlineHtml).not.toMatch(/<link\b/i);
    expect(offlineHtml).not.toMatch(/@import/i);
    expect(offlineHtml).not.toMatch(/https?:\/\//i);
    expect(offlineHtml).not.toMatch(/<img\b/i);
  });

  it('is precached by the worker', () => {
    expect(swCode).toMatch(/OFFLINE_URL\s*=\s*'\/offline\.html'/);
    const block = swCode.match(/const STATIC_ASSETS\s*=\s*\[([\s\S]*?)\]/);
    expect(block).not.toBeNull();
    expect(block![1]).toContain('OFFLINE_URL');
  });

  it('precaches the wasm, so the FIRST offline scan works', () => {
    const block = swCode.match(/const STATIC_ASSETS\s*=\s*\[([\s\S]*?)\]/);
    expect(block![1]).toContain('/wasm/zxing_reader.wasm');
  });

  it('its inlined palette agrees with globals.css', () => {
    // globals.css is not loaded here, so these have to be literals — the same standing
    // hand-maintenance obligation `themeColor` in app/layout.tsx carries, and the same
    // silent drift. CLAUDE.md records that exact drift shipping twice.
    const tokens = ['paper', 'ink', 'ink-2', 'ink-3', 'rule', 'accent'] as const;
    for (const token of tokens) {
      const inCss = globalsCss.match(new RegExp(`--${token}:\\s*(#[0-9a-fA-F]{6})`));
      expect(inCss, `globals.css must define --${token}`).not.toBeNull();
      const inHtml = offlineHtml.match(new RegExp(`--${token}:\\s*(#[0-9a-fA-F]{6})`));
      expect(inHtml, `offline.html must define --${token}`).not.toBeNull();
      expect(
        inHtml![1].toLowerCase(),
        `--${token} drifted: globals.css ${inCss![1]}, offline.html ${inHtml![1]}`
      ).toBe(inCss![1].toLowerCase());
    }
  });

  it('keeps a side gutter that a shorthand cannot zero', () => {
    expect(offlineHtml).toContain('padding-inline');
    expect(offlineHtml).toContain('padding-block');
  });
});

describe('next.config.ts — /sw.js must not be HTTP-cached', () => {
  it('sets no-store on the worker script', () => {
    const headers = nextConfig.match(/async headers\(\)[\s\S]*?\n  \},/);
    expect(headers, 'next.config.ts must declare headers()').not.toBeNull();
    expect(headers![0]).toContain("source: '/sw.js'");
    expect(headers![0]).toMatch(/no-store/);
  });

  it('leaves the three pre-existing config keys alone', () => {
    // Each carries a long justification comment; this suite must not be the reason one
    // of them quietly disappears.
    expect(nextConfig).toContain('distDir:');
    expect(nextConfig).toContain('ignoreBuildErrors');
    expect(nextConfig).toContain('remotePatterns');
  });
});
