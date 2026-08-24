/**
 * `proxy.ts` — which requests get bounced to /login.
 *
 * This belongs in the pure-function suite because `proxy()` is exactly that: a function of a
 * NextRequest, with no database, no network and no Auth.js call. It had never been tested, and
 * the gap was not academic — the cookie names were hard-coded string comparisons, so a session
 * cookie in any shape Auth.js can legitimately produce OTHER than the two spelled out was read
 * as "signed out". Getting that wrong does not degrade one route; it locks a signed-in user out
 * of `/tracker`, `/folders`, `/add-event` and `/settings` at once, while the client still shows
 * them signed in because `/api/auth/session` reassembles the cookie and this did not.
 *
 * THE CHUNKED CASE IS THE POINT. `@auth/core/lib/utils/cookie.js` splits the session cookie
 * above `ALLOWED_COOKIE_SIZE - ESTIMATED_EMPTY_COOKIE_SIZE` (4096 - 160 = 3936 chars) into
 * `<name>.0`, `<name>.1`, … and the unchunked name then does not exist. Measured against
 * production before the fix: `__Secure-authjs.session-token=x` answered 200 while
 * `__Secure-authjs.session-token.0=x` answered 307 to /login.
 *
 * A real Google session measured 649-883 chars, so chunking does not happen today. These tests
 * exist so it stays harmless when it does — a longer avatar URL or one more claim in the `jwt`
 * callback is all it takes, and the failure is silent.
 *
 * The negative half matters as much: the public pages of the scan feature (`/c/<token>`,
 * `/f/<token>`) must never be captured by the `startsWith` prefix match, or a stranger opening
 * somebody's QR code lands on a sign-in wall for an account they do not have.
 */
import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import proxy from '../proxy';

const SECURE = '__Secure-authjs.session-token';
const PLAIN = 'authjs.session-token';

/** Run the proxy against a path, with the given cookie names present (values are irrelevant). */
function visit(pathname: string, cookies: string[] = []) {
  const req = new NextRequest(new URL(`https://pulseblr.example.com${pathname}`));
  for (const name of cookies) req.cookies.set(name, 'token-value-does-not-matter');
  const res = proxy(req);
  const location = res.headers.get('location');
  return {
    redirected: res.status === 307 || res.status === 308,
    location,
    status: res.status,
  };
}

const PROTECTED_PATHS = [
  '/dashboard',
  '/tracker',
  '/add-event',
  '/settings',
  '/admin',
  '/folders',
  '/scan',
  '/card',
];

describe('proxy: protected pages with no session cookie', () => {
  for (const path of PROTECTED_PATHS) {
    it(`sends ${path} to /login`, () => {
      const { redirected, location } = visit(path);
      expect(redirected).toBe(true);
      expect(location).toContain('/login');
      // The callbackUrl is what returns the user where they were going. Losing it turns a
      // sign-in into "you are now on the home page, find it again yourself".
      expect(location).toContain(`callbackUrl=${encodeURIComponent(path)}`);
    });
  }

  it('also covers nested paths, not just the exact prefix', () => {
    expect(visit('/folders/6a8c75ac1d13c5f121502f3c').redirected).toBe(true);
    expect(visit('/tracker/anything').redirected).toBe(true);
  });
});

describe('proxy: an UNCHUNKED session cookie is let through', () => {
  it('accepts the secure-prefixed name used in production', () => {
    expect(visit('/tracker', [SECURE]).redirected).toBe(false);
  });

  it('accepts the bare name used over http in development', () => {
    expect(visit('/tracker', [PLAIN]).redirected).toBe(false);
  });
});

describe('proxy: a CHUNKED session cookie is let through — the regression this pins', () => {
  it('accepts a single chunk (.0), which used to redirect to /login', () => {
    expect(visit('/tracker', [`${SECURE}.0`]).redirected).toBe(false);
  });

  it('accepts a multi-chunk cookie where the unchunked name is absent', () => {
    // This is exactly what Auth.js writes for a token over 3936 chars: numbered parts and NO
    // cookie under the plain name at all.
    const chunked = [`${SECURE}.0`, `${SECURE}.1`, `${SECURE}.2`];
    expect(visit('/tracker', chunked).redirected).toBe(false);
    for (const path of PROTECTED_PATHS) {
      expect(visit(path, chunked).redirected).toBe(false);
    }
  });

  it('accepts the development chunked form too', () => {
    expect(visit('/settings', [`${PLAIN}.0`]).redirected).toBe(false);
  });
});

describe('proxy: cookies that must NOT count as a session', () => {
  it('ignores the csrf and callback-url cookies', () => {
    // Both are set by Auth.js on any visit to /api/auth/csrf, signed in or not, so treating
    // either as a session would let every anonymous visitor into every protected page.
    expect(visit('/tracker', ['__Host-authjs.csrf-token']).redirected).toBe(true);
    expect(visit('/tracker', ['__Secure-authjs.callback-url']).redirected).toBe(true);
    expect(visit('/tracker', ['__Secure-authjs.pkce.code_verifier']).redirected).toBe(true);
  });

  it('does not accept a name that merely CONTAINS the session cookie name', () => {
    // The match is exact-or-`name.`-prefixed, not substring: a cookie another app set on a
    // shared domain must not authenticate anyone here.
    expect(visit('/tracker', [`evil-${SECURE}`]).redirected).toBe(true);
    expect(visit('/tracker', [`${SECURE}-decoy`]).redirected).toBe(true);
  });
});

describe('proxy: public routes are never gated', () => {
  const publicPaths = [
    '/',
    '/login',
    '/companies',
    '/calendar',
    '/events/6a8c75ac1d13c5f121502f3c',
    // The two anonymous entry points of the scan feature. `'/c/abc'.startsWith('/card')` is
    // false, which is the only reason `/card` above does not capture them — so this asserts the
    // arrangement CLAUDE.md §9 depends on rather than trusting it.
    '/c/some-token',
    '/f/some-token',
  ];

  for (const path of publicPaths) {
    it(`lets ${path} through with no cookie`, () => {
      expect(visit(path).redirected).toBe(false);
    });
  }
});
