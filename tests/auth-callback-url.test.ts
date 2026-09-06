/**
 * `safeCallbackUrl()` — the post-sign-in destination, which arrives from the URL.
 *
 * Two jobs, and both were broken before this existed. The login page hard-coded `'/'`, so the
 * `?callbackUrl=` that `proxy.ts` attaches was thrown away and signing in from `/tracker`
 * landed you on the home page. Fixing that by passing the parameter through would have created
 * an open redirect, because the value is attacker-chosen.
 *
 * The negative cases are the important half. `value.startsWith('/')` — the obvious check —
 * accepts `//evil.example` and `/\evil.example`, both of which browsers resolve as a HOST
 * rather than a path, so the "fix" would hand out real sign-ins on the real domain that land
 * on somebody else's page.
 */
import { describe, it, expect } from 'vitest';
import { safeCallbackUrl, DEFAULT_CALLBACK_URL } from '../lib/auth-callback-url';

describe('safeCallbackUrl: paths that must be honoured', () => {
  it('keeps the protected paths the proxy actually redirects from', () => {
    for (const path of ['/tracker', '/folders', '/add-event', '/settings', '/admin', '/scan', '/card']) {
      expect(safeCallbackUrl(path)).toBe(path);
    }
  });

  it('accepts the URL-encoded form the proxy writes', () => {
    // proxy.ts sets `callbackUrl` via searchParams, so it arrives percent-encoded.
    expect(safeCallbackUrl('%2Ftracker')).toBe('/tracker');
    expect(safeCallbackUrl('%2Ffolders%2F6a8c75ac1d13c5f121502f3c')).toBe(
      '/folders/6a8c75ac1d13c5f121502f3c'
    );
  });

  it('keeps nested paths and query strings', () => {
    expect(safeCallbackUrl('/folders/6a8c75ac1d13c5f121502f3c')).toBe(
      '/folders/6a8c75ac1d13c5f121502f3c'
    );
    expect(safeCallbackUrl('/tracker?view=list')).toBe('/tracker?view=list');
  });
});

describe('safeCallbackUrl: OPEN REDIRECTS that a startsWith("/") check would let through', () => {
  it('rejects the protocol-relative form', () => {
    // The one that matters: browsers read `//host` as a host, not a path.
    expect(safeCallbackUrl('//evil.example')).toBe(DEFAULT_CALLBACK_URL);
    expect(safeCallbackUrl('//evil.example/login')).toBe(DEFAULT_CALLBACK_URL);
  });

  it('rejects the backslash variant, which browsers normalise to the above', () => {
    expect(safeCallbackUrl('/\\evil.example')).toBe(DEFAULT_CALLBACK_URL);
    expect(safeCallbackUrl('/\\/evil.example')).toBe(DEFAULT_CALLBACK_URL);
  });

  it('rejects the ENCODED protocol-relative form — why decoding happens first', () => {
    expect(safeCallbackUrl('%2F%2Fevil.example')).toBe(DEFAULT_CALLBACK_URL);
    expect(safeCallbackUrl('%2f%2fevil.example')).toBe(DEFAULT_CALLBACK_URL);
  });

  it('rejects control characters used to hide a leading slash', () => {
    // Browsers strip tab/CR/LF while parsing a URL, so these would BECOME protocol-relative.
    expect(safeCallbackUrl('/\t/evil.example')).toBe(DEFAULT_CALLBACK_URL);
    expect(safeCallbackUrl('/\n/evil.example')).toBe(DEFAULT_CALLBACK_URL);
    expect(safeCallbackUrl('%2F%09%2Fevil.example')).toBe(DEFAULT_CALLBACK_URL);
  });
});

describe('safeCallbackUrl: anything that is not a same-origin path', () => {
  it('rejects absolute URLs, including look-alike hosts', () => {
    for (const url of [
      'https://evil.example/login',
      'http://evil.example',
      'https://pulseblr.evil.example/tracker',
      'https://pulseblr-u9f1.vercel.app.evil.example/',
    ]) {
      expect(safeCallbackUrl(url)).toBe(DEFAULT_CALLBACK_URL);
    }
  });

  it('rejects non-http schemes', () => {
    expect(safeCallbackUrl('javascript:alert(1)')).toBe(DEFAULT_CALLBACK_URL);
    expect(safeCallbackUrl('data:text/html,<script>alert(1)</script>')).toBe(DEFAULT_CALLBACK_URL);
  });

  it('rejects bare relative paths, which could resolve anywhere', () => {
    expect(safeCallbackUrl('tracker')).toBe(DEFAULT_CALLBACK_URL);
    expect(safeCallbackUrl('../admin')).toBe(DEFAULT_CALLBACK_URL);
  });

  it('falls back on absent, empty and malformed input', () => {
    expect(safeCallbackUrl(null)).toBe(DEFAULT_CALLBACK_URL);
    expect(safeCallbackUrl(undefined)).toBe(DEFAULT_CALLBACK_URL);
    expect(safeCallbackUrl('')).toBe(DEFAULT_CALLBACK_URL);
    expect(safeCallbackUrl('   ')).toBe(DEFAULT_CALLBACK_URL);
    // A lone `%` is not a valid escape; decodeURIComponent throws rather than returning it.
    expect(safeCallbackUrl('%')).toBe(DEFAULT_CALLBACK_URL);
    expect(safeCallbackUrl('%zz')).toBe(DEFAULT_CALLBACK_URL);
  });
});

describe('safeCallbackUrl: never returns to /login', () => {
  it('breaks the ping-pong with the proxy', () => {
    // Otherwise: proxy sends you to /login, /login sends you to /login, forever.
    expect(safeCallbackUrl('/login')).toBe(DEFAULT_CALLBACK_URL);
    expect(safeCallbackUrl('/login?callbackUrl=%2Ftracker')).toBe(DEFAULT_CALLBACK_URL);
    expect(safeCallbackUrl('%2Flogin')).toBe(DEFAULT_CALLBACK_URL);
  });

  it('still allows paths that merely begin with the same letters', () => {
    // `/login` must not swallow a future `/logins` or `/loginhelp`.
    expect(safeCallbackUrl('/loginhelp')).toBe('/loginhelp');
  });
});
