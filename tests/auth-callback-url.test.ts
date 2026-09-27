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
import {
  safeCallbackUrl,
  loginHref,
  currentPageTarget,
  DEFAULT_CALLBACK_URL,
  LOGIN_PATH,
} from '../lib/auth-callback-url';

/** Any origin will do: every assertion below is about staying ON it. */
const ORIGIN = 'https://pulseblr.example';

/** What the login page reads back from a link: `useSearchParams().get('callbackUrl')`. */
function receivedBy(loginPageLink: string): string | null {
  return new URL(loginPageLink, ORIGIN).searchParams.get('callbackUrl');
}

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

  it('refuses /login however the path is spelled', () => {
    // Judged on the PATH, so a fragment or a trailing slash cannot slip it through, and neither
    // can an escaped letter that a decoding reader would turn back into `/login`.
    expect(safeCallbackUrl('/login#top')).toBe(DEFAULT_CALLBACK_URL);
    expect(safeCallbackUrl('/login/')).toBe(DEFAULT_CALLBACK_URL);
    expect(safeCallbackUrl('/%6Cogin')).toBe(DEFAULT_CALLBACK_URL);
  });
});

/**
 * THE SHARE TARGET. `public/manifest.json` opens `/add-event?title=…&text=…&url=…`, which is a
 * protected page, so a signed-out share goes through sign-in and the shared content lives entirely
 * in the query string. It has to come out the other side byte for byte.
 *
 * The implementation this replaced decoded the value a second time and returned THAT, which was
 * measured to do two different kinds of damage depending on the payload — see the header of
 * `lib/auth-callback-url.ts`. The first case below is the literal payload from the audit.
 */
describe('safeCallbackUrl: a carried query string survives byte for byte', () => {
  const SHARE =
    '/add-event?title=Hello%20%26%20bye&text=a%2Bb%3Dc&url=https%3A%2F%2Fexample.com%2Fe%3Fa%3D1%26b%3D2%23frag';

  it('returns a share-target callback unchanged', () => {
    expect(safeCallbackUrl(SHARE)).toBe(SHARE);
  });

  it('round-trips gate -> /login -> signIn() without changing a byte', () => {
    const link = loginHref(SHARE);
    expect(link.startsWith(`${LOGIN_PATH}?callbackUrl=`)).toBe(true);

    const received = receivedBy(link);
    expect(received).toBe(SHARE);

    const destination = safeCallbackUrl(received);
    expect(destination).toBe(SHARE);

    // `signIn()` posts it inside a URLSearchParams body and Auth.js reads the form back.
    const posted = new URLSearchParams({ callbackUrl: destination }).toString();
    expect(new URLSearchParams(posted).get('callbackUrl')).toBe(SHARE);
  });

  it('delivers the shared title, text and url to /add-event intact', () => {
    const landed = new URL(safeCallbackUrl(receivedBy(loginHref(SHARE))), ORIGIN);

    expect(landed.origin).toBe(ORIGIN);
    expect(landed.pathname).toBe('/add-event');
    expect(landed.searchParams.get('title')).toBe('Hello & bye');
    expect(landed.searchParams.get('text')).toBe('a+b=c');
    expect(landed.searchParams.get('url')).toBe('https://example.com/e?a=1&b=2#frag');
    // Nothing escaped from inside a value into a parameter or a fragment of its own — the old
    // code produced a spurious `b=2` and a real `#frag` from this exact input.
    expect([...landed.searchParams.keys()]).toEqual(['title', 'text', 'url']);
    expect(landed.hash).toBe('');
  });

  it('keeps every shape a real share arrives in', () => {
    for (const target of [
      '/add-event?title=Hello+bye', // spaces as a GET share target form-encodes them
      '/add-event?text=line%20one%0Aline%20two', // a newline, which shared text often has
      '/add-event?title=100%25%20free', // a literal percent sign
      '/add-event?title=%E0%B2%AC%E0%B3%86%E0%B2%82%E0%B2%97%E0%B2%B3%E0%B3%82%E0%B2%B0%E0%B3%81',
      '/add-event?title=%F0%9F%8E%89%20launch', // an emoji
      '/add-event?url=https%3A%2F%2Flu.ma%2Fabc%3Futm_source%3Dshare&url=second', // repeated key
      '/add-event?title=', // an empty value
      '/people?tag=ai%2Fml', // an encoded slash inside a VALUE is payload, not path
    ]) {
      expect(safeCallbackUrl(target)).toBe(target);
      expect(safeCallbackUrl(receivedBy(loginHref(target)))).toBe(target);
    }
  });

  it('leaves a malformed escape in the QUERY to the page that reads it', () => {
    // "100%" is a real title. Only a malformed escape in the PATH is refused (below).
    expect(safeCallbackUrl('/add-event?title=100%')).toBe('/add-event?title=100%');
  });
});

describe('safeCallbackUrl: carrying the query weakens no rejection', () => {
  it('refuses every open-redirect shape with a query attached', () => {
    for (const url of [
      '//evil.example?title=x',
      '/\\evil.example?title=x',
      '%2F%2Fevil.example%3Ftitle%3Dx',
      '/\t/evil.example?title=x',
      'https://evil.example/add-event?title=x',
      '/login?callbackUrl=%2Fadd-event%3Ftitle%3Dx',
    ]) {
      expect(safeCallbackUrl(url)).toBe(DEFAULT_CALLBACK_URL);
    }
  });

  it('judges the PATH one decode deeper, so an escaped slash after the first cannot hide', () => {
    // A browser reads `/%2F%2Fevil.example` as a path on THIS origin, so none of these is an open
    // redirect today — but a reader that decodes before navigating would make every one of them
    // cross-origin, and the old implementation refused them all. That strictness is kept.
    for (const url of [
      '/%2F%2Fevil.example',
      '/%2fevil.example',
      '/%5Cevil.example',
      '/%09/evil.example',
      '/%0A/evil.example',
      '/%2F%2Fevil.example?title=x',
    ]) {
      expect(safeCallbackUrl(url)).toBe(DEFAULT_CALLBACK_URL);
    }
  });

  it('refuses a malformed escape in the PATH', () => {
    expect(safeCallbackUrl('/add%zz-event')).toBe(DEFAULT_CALLBACK_URL);
  });

  it('refuses a LITERAL control character anywhere, the query included', () => {
    // Only the path is decoded for inspection, but the value as received is checked whole: nothing
    // we build contains a raw CR, LF or NUL (`encodeURIComponent` escapes them), and this string
    // ends up in the `Location` header Auth.js writes after sign-in.
    expect(safeCallbackUrl('/tracker?x=a\r\nSet-Cookie:%20a=b')).toBe(DEFAULT_CALLBACK_URL);
    expect(safeCallbackUrl('/tracker?x=\u0000')).toBe(DEFAULT_CALLBACK_URL);
    expect(safeCallbackUrl('/add-event?title=Hello bye')).toBe(DEFAULT_CALLBACK_URL);
  });

  it('never returns anything that resolves off this origin, now or one decode later', () => {
    // The property every case above is an instance of, checked over accepted and refused inputs.
    for (const input of [
      '/tracker',
      '/add-event?title=Hello%20%26%20bye&url=https%3A%2F%2Fevil.example',
      '/people?next=//evil.example', // a protocol-relative VALUE is inert payload
      '//evil.example',
      '/\\evil.example',
      '%2F%2Fevil.example',
      '/%2F%2Fevil.example',
      '/%5C%5Cevil.example',
      '\\/evil.example',
      ' //evil.example',
      'https://evil.example',
      'javascript:alert(1)',
    ]) {
      const out = safeCallbackUrl(input);
      expect(new URL(out, ORIGIN).origin, input).toBe(ORIGIN);
      const path = out.split(/[?#]/)[0];
      expect(new URL(decodeURIComponent(path), ORIGIN).origin, input).toBe(ORIGIN);
    }
  });
});

describe('loginHref: the link every sign-in prompt uses', () => {
  it('carries a safe destination, encoded so /login reads it back exactly', () => {
    expect(loginHref('/tracker')).toBe('/login?callbackUrl=%2Ftracker');
    expect(loginHref('/tracker?view=list')).toBe('/login?callbackUrl=%2Ftracker%3Fview%3Dlist');
  });

  it('carries nothing when there is nothing worth returning to', () => {
    for (const target of [
      '/',
      '',
      null,
      undefined,
      '/login',
      '/login?callbackUrl=%2Ftracker',
      '//evil.example',
      'https://evil.example',
    ]) {
      expect(loginHref(target)).toBe(LOGIN_PATH);
    }
  });

  it('never nests one sign-in link inside another', () => {
    // `/login?callbackUrl=/login?callbackUrl=…` would be the ping-pong in a new costume.
    expect(loginHref(loginHref('/tracker'))).toBe(LOGIN_PATH);
  });
});

describe('currentPageTarget: the page to come back to', () => {
  it('is the path plus the query string when the address bar is current', () => {
    expect(
      currentPageTarget({ pathname: '/add-event', search: '?title=Hello%20%26%20bye' }, '/add-event')
    ).toBe('/add-event?title=Hello%20%26%20bye');
    expect(currentPageTarget({ pathname: '/tracker', search: '' }, '/tracker')).toBe('/tracker');
  });

  it('trusts the location when there is no router pathname to compare (a click handler)', () => {
    expect(currentPageTarget({ pathname: '/events/abc', search: '?from=feed' })).toBe(
      '/events/abc?from=feed'
    );
  });

  it('drops a query that belongs to the page being LEFT', () => {
    // Next renders the new route before its useInsertionEffect calls pushState, so mid-navigation
    // `window.location` still describes the previous page. Carrying `?q=react` onto /tracker would
    // be inventing a URL nobody visited.
    expect(currentPageTarget({ pathname: '/', search: '?q=react' }, '/tracker')).toBe('/tracker');
  });

  it('falls back to the router path, then the home page, with no location at all', () => {
    expect(currentPageTarget(undefined, '/tracker')).toBe('/tracker');
    expect(currentPageTarget(null, null)).toBe(DEFAULT_CALLBACK_URL);
  });
});
