import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match';
import { modifyRouteRegex } from 'next/dist/lib/redirect-status';
import loadedNextConfig from '../next.config';
import { stripComments } from './support/strip-comments';

/**
 * The service worker's CACHING POLICY, asserted mostly by reading `public/sw.js` as text.
 *
 * THESE ASSERTIONS ARE CRUDE AND THIS FILE SAYS SO UP FRONT. `public/sw.js` is a plain
 * browser script with no exports — it registers listeners on `self` and reaches for
 * `caches`, `clients` and `registration`, none of which exist in Node. It cannot be
 * imported. A regex over source text cannot tell you the worker WORKS; `scripts/diag-offline.ts`
 * drives a real Chromium for that, and it is the only thing that can.
 *
 * ONE EXCEPTION, and it is the v6 fix. `isApiRequest()` is a pure function of a URL, so its text
 * is lifted out of the (comment-stripped) worker and EXECUTED — against every route directory
 * that exists under app/api today, plus the spellings Next routes to the same handlers. Whether
 * `/%61pi/people` is caught is not a question a regex over the function's source can answer.
 *
 * WHAT THE REST IS FOR, and why it is worth having anyway: the failure it catches is somebody
 * reordering two branches, or hanging an exception off a guard, during an unrelated refactor.
 * That is not a hypothetical risk in this file — it is the ENTIRE VERSION HISTORY of it. v2
 * leaked one account's data to the next because a caching rule was broader than anyone had
 * checked; v3 fixed it with a list of private prefixes; v4 was needed because `/api/events`
 * gained private rows and nobody re-asked the question; v5 because RSC payloads had been landing
 * in the cache-first branch all along; v6 because seven People routes were written and none of
 * them reached the list. Four leaks, all silent, none of which any test would have had to be
 * clever to catch — only present.
 *
 * COMMENTS ARE STRIPPED BEFORE ANY ASSERTION RUNS. Without that, this suite is worse than
 * useless: `sw.js`'s changelog names `ignoreSearch`, `_rsc`, `PRIVATE_API` and
 * `/_next/static/webpack/` while EXPLAINING them, so a prose mention would satisfy a check about
 * code. Every assertion below reads `swCode`, never `swSource`. The stripper lives in
 * `tests/support/strip-comments.ts`, with the story of why it is a scanner and not a regex.
 *
 * The ORDERING assertions are the load-bearing ones. A branch that is present but sits after
 * the early return that would have caught the request first is dead code that reads as a fix —
 * the single most likely way this file regresses.
 */

const ROOT = path.join(import.meta.dirname, '..');

const swSource = readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
const offlineHtml = readFileSync(path.join(ROOT, 'public', 'offline.html'), 'utf8');
const globalsCss = readFileSync(path.join(ROOT, 'app', 'globals.css'), 'utf8');
const nextConfig = readFileSync(path.join(ROOT, 'next.config.ts'), 'utf8');

const swCode = stripComments(swSource);

/** The body of `self.addEventListener('fetch', …)`, to the next listener. */
function fetchHandler(): string {
  const start = swCode.indexOf("addEventListener('fetch'");
  expect(start, "the fetch listener must exist").toBeGreaterThan(-1);
  // Everything up to the next top-level listener registration is the handler.
  const next = swCode.indexOf("addEventListener('message'", start);
  return swCode.slice(start, next === -1 ? undefined : next);
}

/** A top-level `function name(…) { … }` from the stripped worker, up to its closing brace. */
function swFunctionText(name: string): string {
  // Every top-level function in sw.js closes with a `}` in column 0, and nothing inside one
  // does — the same convention the isImmutableBuildAsset/mayStore assertions below rely on.
  const found = swCode.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\)[\\s\\S]*?\\n\\}`));
  expect(found, `sw.js must declare function ${name}`).not.toBeNull();
  return found![0];
}

/**
 * `isApiRequest`, lifted out of the worker and made callable. It uses nothing but `URL`,
 * `decodeURIComponent` and string methods, all of which Node has, so executing its real text is
 * honest — this is the function the browser runs, not a copy of it.
 */
const isApiRequest = new Function(`${swFunctionText('isApiRequest')}\nreturn isApiRequest;`)() as (
  url: URL
) => boolean;

/** Absolute on purpose: `new URL('//api/x', base)` is protocol-RELATIVE and makes `api` a host. */
const ORIGIN = 'https://pulseblr.test';
const at = (p: string) => new URL(ORIGIN + p);

/** Every directory under `app/<sub>` holding `file`, turned into the URL path that serves it. */
function routePaths(sub: string, file: string, skip: (rel: string) => boolean = () => false): string[] {
  const base = path.join(ROOT, 'app', sub);
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
      else if (entry.name === file) {
        const rel = path.relative(path.join(ROOT, 'app'), dir).split(path.sep).join('/');
        if (skip(rel)) continue;
        // `_private` folders are not routes at all; `(group)` and `@slot` segments add nothing to
        // the URL. Dynamic segments get a plausible value — the worker never sees brackets.
        const segments = rel.split('/').filter(Boolean);
        if (segments.some(s => s.startsWith('_'))) continue;
        const url = segments
          .filter(s => !(s.startsWith('(') && s.endsWith(')')) && !s.startsWith('@'))
          .map(s => (s.startsWith('[') ? 'x1y2z3' : s));
        out.push(`/${url.join('/')}`);
      }
    }
  };
  walk(base);
  return out;
}

describe('sw.js — the stripper itself (control)', () => {
  it('removes comments but leaves the code', () => {
    // If this fails, every other assertion here is meaningless: either nothing was
    // stripped (so prose can satisfy a code check) or too much was.
    expect(swCode.length).toBeLessThan(swSource.length);
    expect(swSource).toContain('ignoreSearch'); // present in prose
    expect(swSource).toContain('PRIVATE_API'); // present in prose — the v3-v5 history
    expect(swCode).toContain('isRscRequest');
    expect(swCode).toContain('isApiRequest');
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
      'const STATIC_ASSETS',
      'function isApiRequest',
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
    // Several assertions in this file match on literals like '/api/'. A stripper that removed
    // string bodies would make the suite pass vacuously forever.
    expect(swCode).toContain("'/api/'");
    expect(swCode).toContain("'/offline.html'");
  });

  it('sw.js contains no regex literal, which is what the stripper assumes', () => {
    // Stated as an assertion rather than a comment: the scanner does not track regex
    // literals, so a future `/…/.test(x)` here could hide a `//` from it.
    expect(swCode).not.toMatch(/=\s*\/[^/*\s][^\n]*\/[gimsuy]*[;.)]/);
    expect(swCode).not.toMatch(/\.(?:replace|replaceAll|match|split|test|search)\(\s*\/[^/*]/);
  });

  it('the route enumeration used below finds the real tree (control)', () => {
    // An enumeration that silently found nothing would make "every route is claimed" and
    // "no page is claimed" both pass vacuously.
    expect(routePaths('api', 'route.ts').length).toBeGreaterThanOrEqual(40);
    expect(routePaths('', 'page.tsx', rel => rel.startsWith('api/')).length).toBeGreaterThanOrEqual(15);
    expect(routePaths('api', 'route.ts')).toContain('/api/people');
    expect(routePaths('', 'page.tsx')).toContain('/people');
  });
});

describe('sw.js — cache naming', () => {
  it('every cache name ends -v6', () => {
    const names = [...swCode.matchAll(/`pulseblr-[a-z]+-\$\{VERSION\}`/g)];
    expect(names.length).toBeGreaterThanOrEqual(3);
    expect(swCode).toMatch(/const VERSION\s*=\s*'v6'/);
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
    // A hardcoded 'pulseblr-dynamic-v5' left behind would keep the People-data cache alive
    // past activate, which is exactly what the v6 bump exists to prevent.
    expect(swCode).not.toMatch(/pulseblr-[a-z]+-v[0-5]\b/);
  });
});

describe('sw.js — EVERY /api/ request is network-only (the v6 fix)', () => {
  it('the denylist is gone, not merely unused', () => {
    // v3-v5 kept a list of private prefixes and every unlisted /api/ route was cached. A list
    // left behind as dead code is a list somebody will "fix" by adding to it.
    expect(swCode).not.toContain('PRIVATE_API');
    expect(swCode).not.toContain('isPrivateApi');
  });

  it('the API guard is UNCONDITIONAL — no exception can hang off it', () => {
    // `if (isApiRequest(url) && !isPublic(url))` is a denylist with the sign flipped, and the
    // way this regresses: one route is "obviously public", then a second.
    expect(fetchHandler()).toMatch(/\n\s*if \(isApiRequest\(url\)\) \{/);
  });

  it('the handler makes no API decision of its own', () => {
    // Every "is this the API" question goes through isApiRequest(), which decodes. A bare
    // `startsWith('/api/')` reappearing in a branch is a spelling-based rule that
    // `/%61pi/people` walks past.
    const handler = fetchHandler();
    expect(handler).not.toContain("'/api");
    expect(handler).not.toContain('"/api');
  });

  it('the API branch goes to the network and never reads or writes a cache', () => {
    const handler = fetchHandler();
    const guard = handler.indexOf('if (isApiRequest(url))');
    expect(guard).toBeGreaterThan(-1);
    // From the guard to the `return` that closes its block, there must be no cache access
    // at all — that is what "network only" means, and a cache read here is how one account
    // reads the previous account's data.
    const branch = handler.slice(guard, handler.indexOf('return;', guard));
    expect(branch).toContain('fetch(request)');
    expect(branch).toContain('offlineJson()');
    expect(branch).not.toContain('caches.');
    expect(branch).not.toContain('stash(');
  });

  it('runs BEFORE the navigation branch and before every branch that stashes a page response', () => {
    // A top-level navigation to /api/... is still an API response. Under v5 it reached the
    // network-first navigation branch and was stored.
    const handler = fetchHandler();
    const guard = handler.indexOf('if (isApiRequest(url))');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(handler.indexOf("request.mode === 'navigate'"));
    expect(guard).toBeLessThan(handler.indexOf('stash(DYNAMIC_CACHE'));
    expect(guard).toBeLessThan(handler.indexOf('stash(STATIC_CACHE'));
  });

  it('stash() — the only cache.put — refuses API traffic before it writes', () => {
    // The structural guarantee: whatever branch calls it, in whatever order, an API request
    // or an API response url never reaches `cache.put`. Counted as `.put(` under ANY receiver
    // name, so a second writer spelled `c.put(` is not invisible to this.
    expect(swCode.match(/\.put\(/g)?.length ?? 0).toBe(1);
    const stash = swFunctionText('stash');
    const put = stash.indexOf('cache.put(');
    expect(put, 'cache.put must live inside stash()').toBeGreaterThan(-1);
    const byRequest = stash.indexOf('isApiRequest(new URL(request.url))');
    const byResponse = stash.indexOf('isApiRequest(new URL(response.url))');
    expect(byRequest).toBeGreaterThan(-1);
    expect(byResponse).toBeGreaterThan(-1);
    expect(byRequest).toBeLessThan(put);
    expect(byResponse).toBeLessThan(put);
  });

  it('the only other writer is the install precache, and it names no API path', () => {
    // `cache` and `.add(` sit on separate lines in the install handler, so this counts the
    // method call, not the spelling.
    expect(swCode).not.toMatch(/\.addAll\(/);
    expect(swCode.match(/\.add\(/g)?.length ?? 0).toBe(1);
    const start = swCode.indexOf("addEventListener('install'");
    const install = swCode.slice(start, swCode.indexOf("addEventListener('activate'", start));
    expect(install).toMatch(/\.add\(/);
    const block = swCode.match(/const STATIC_ASSETS\s*=\s*\[([\s\S]*?)\]/);
    expect(block).not.toBeNull();
    expect(block![1]).not.toMatch(/api/i);
  });

  it('claims every route that exists under app/api', () => {
    // SELF-UPDATING: a route added tomorrow is in this list the moment its file exists, which is
    // precisely what the v3-v5 list could never be.
    const routes = routePaths('api', 'route.ts');
    const missed = routes.filter(p => !isApiRequest(at(p)));
    expect(missed, `routes the worker would cache: ${missed.join(', ')}`).toEqual([]);
  });

  it('claims the spellings Next routes to the same handler', () => {
    for (const p of [
      '/api',
      '/api/',
      '/api/people/facets?q=razorpay',
      // Decoded: Next retries its route lookup with the decoded path in production.
      '/%61pi/people',
      '/%61%70%69/people/merge',
      '/api%2Fpeople',
      // Repeated slashes and backslashes: Next 308s these to the clean path, and fetch follows.
      '//api/people',
      '///api//people',
      '/%5Capi/people',
      // Case: not something this worker can know a proxy will not fold.
      '/API/people',
      '/Api/People/Facets',
      // Dot segments, resolved by the URL parser before the worker ever sees them.
      '/%2e%2e/api/people',
      '/events/%2e%2e/api/people',
    ]) {
      expect(isApiRequest(at(p)), p).toBe(true);
    }
  });

  it('fails CLOSED on an escape it cannot decode', () => {
    // It cannot establish what the server will make of the URL, so it refuses to cache it.
    expect(isApiRequest(at('/api/%E0%A4%A'))).toBe(true);
    expect(isApiRequest(at('/people/%E0%A4%A'))).toBe(true);
  });

  it('does NOT claim pages, assets or look-alikes — the negative half is the important half', () => {
    // Over-matching fails silently the other way: a page claimed here is network-only, so its
    // document stops rendering offline and nothing reports it.
    const pages = routePaths('', 'page.tsx', rel => rel.startsWith('api/'));
    const claimed = pages.filter(p => isApiRequest(at(p)));
    expect(claimed, `pages the worker would never cache: ${claimed.join(', ')}`).toEqual([]);
    for (const p of [
      '/',
      '/people/api',
      '/apiary',
      '/api-docs',
      '/apis',
      '/_next/static/chunks/app/api/page-0123abcd.js',
      '/offline.html',
      '/manifest.json',
      '/icon-192.png',
      '/wasm/zxing_reader.wasm',
      '/c/abcdef0123456789',
      '/f/abcdef0123456789',
    ]) {
      expect(isApiRequest(at(p)), p).toBe(false);
    }
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
    expect(push).toMatch(/badge:\s*'\/badge-96\.png'/);
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

/**
 * The response headers `next.config.ts` would put on `pathname`, matched by NEXT'S OWN matcher
 * with the options `next start` uses for a header rule (server/lib/router-utils/filesystem.js,
 * `buildCustomRoute('header', …)`: strict, unnamed params removed, case-insensitive because
 * `experimental.caseSensitiveRoutes` defaults to false, and `modifyRouteRegex` allowing one
 * trailing slash). Later rules override earlier ones for the same key, as the headers() docs
 * specify.
 */
async function configuredHeadersFor(pathname: string): Promise<Record<string, string>> {
  const rules = (await loadedNextConfig.headers?.()) ?? [];
  const out: Record<string, string> = {};
  for (const rule of rules) {
    const match = getPathMatch(rule.source, {
      strict: true,
      removeUnnamedParams: true,
      sensitive: false,
      regexModifier: regex => modifyRouteRegex(regex),
    });
    if (match(pathname) === false) continue;
    for (const header of rule.headers) out[header.key.toLowerCase()] = header.value;
  }
  return out;
}

describe('next.config.ts — response headers', () => {
  it('sets no-store on the worker script', () => {
    const headers = nextConfig.match(/async headers\(\)[\s\S]*?\n  \},/);
    expect(headers, 'next.config.ts must declare headers()').not.toBeNull();
    expect(headers![0]).toContain("source: '/sw.js'");
    expect(headers![0]).toMatch(/no-store/);
  });

  it('the worker script really receives it, by the matcher Next uses', async () => {
    expect((await configuredHeadersFor('/sw.js'))['cache-control']).toMatch(/no-store/);
  });

  it('sends private, no-store on the two public token pages', async () => {
    // A contact card and a folder intake link: another person's details, reachable by a bearer
    // token, and revocable. Neither may outlive a revocation in any cache.
    for (const p of ['/c/abcdef0123456789', '/f/abcdef0123456789', '/C/abcdef0123456789']) {
      const cc = (await configuredHeadersFor(p))['cache-control'] ?? '';
      expect(cc, p).toContain('private');
      expect(cc, p).toContain('no-store');
    }
  });

  it('does NOT reach the signed-in pages that share their first letter', async () => {
    // The prefix trap this repo documents for `/c/` and `/card`: `/f/` must not swallow
    // `/folders` either. A no-store there would stop the worker keeping those documents for
    // offline use, and nothing would report it. (A bare `/c` or `/f` DOES match `:path*` —
    // zero segments — and is a 404, so it is deliberately not in this list.)
    for (const p of ['/card', '/folders', '/folders/x1y2z3', '/', '/people', '/calendar', '/companies']) {
      const cc = (await configuredHeadersFor(p))['cache-control'];
      expect(cc, p).toBeUndefined();
    }
  });

  it('leaves the three pre-existing config keys alone', () => {
    // Each carries a long justification comment; this suite must not be the reason one
    // of them quietly disappears.
    expect(nextConfig).toContain('distDir:');
    expect(nextConfig).toContain('ignoreBuildErrors');
    expect(nextConfig).toContain('remotePatterns');
  });
});
