/**
 * `isProtectedPath()` — which pages the client gate draws a sign-in wall for.
 *
 * This replaces `tests/proxy-session-cookie.test.ts`. That suite pinned `proxy.ts`'s cookie-name
 * matching, including the chunked-cookie case it was blind to. All of it is gone with the check
 * itself: the proxy could not verify a token (a made-up cookie returned 200 on every protected
 * page in production) and it locked out users with valid sessions, so the question moved to
 * `useSession()`. What survives from that work is the prefix-matching contract below, which is
 * the part that can still be got wrong.
 *
 * THE NEGATIVE HALF IS THE IMPORTANT HALF. Matching is by prefix, so `/card` would capture
 * `/c/<token>` under a sloppier comparison — and `/c/<token>` is the page a STRANGER opens from
 * somebody's QR code, with no account. Gating it means showing a sign-in wall for an account they
 * do not have and cannot get, which silently breaks the whole point of the scan feature.
 */
import { describe, it, expect } from 'vitest';
import { isProtectedPath, PROTECTED_PATHS } from '../lib/protected-routes';

describe('isProtectedPath: the private pages', () => {
  for (const path of PROTECTED_PATHS) {
    it(`gates ${path}`, () => {
      expect(isProtectedPath(path)).toBe(true);
    });
  }

  it('gates nested paths under a private prefix', () => {
    expect(isProtectedPath('/folders/6a8c75ac1d13c5f121502f3c')).toBe(true);
    expect(isProtectedPath('/admin/events')).toBe(true);
  });

  it('gates a private path carrying a query string', () => {
    expect(isProtectedPath('/tracker?view=list')).toBe(true);
  });
});

describe('isProtectedPath: PUBLIC pages that must never be gated', () => {
  it('leaves the anonymous scan pages alone', () => {
    // The whole reason /card and /c/<token> are different top-level segments. A stranger with a
    // QR code has no account, so a sign-in wall here is a dead end, not a prompt.
    expect(isProtectedPath('/c/some-token')).toBe(false);
    expect(isProtectedPath('/f/some-token')).toBe(false);
  });

  it('leaves the public browsing surface alone', () => {
    for (const path of ['/', '/login', '/companies', '/calendar', '/events/6a8c75ac']) {
      expect(isProtectedPath(path)).toBe(false);
    }
  });

  it('does not gate a path that merely starts with the same letters', () => {
    // `/card` must not swallow `/cards-guide`, and `/scan` must not swallow `/scanner-help`.
    expect(isProtectedPath('/cards-guide')).toBe(false);
    expect(isProtectedPath('/scanner-help')).toBe(false);
    expect(isProtectedPath('/settings-help')).toBe(false);
  });

  it('handles absent input', () => {
    expect(isProtectedPath(null)).toBe(false);
    expect(isProtectedPath(undefined)).toBe(false);
    expect(isProtectedPath('')).toBe(false);
  });
});
