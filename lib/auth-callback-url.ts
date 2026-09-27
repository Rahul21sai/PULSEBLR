/**
 * Where to send someone after they sign in.
 *
 * Whatever sends a signed-out visitor to `/login` attaches `?callbackUrl=<the page they wanted>`
 * so that signing in returns them there: `ProtectedRouteGate` for private pages, `SaveButton` for
 * a refused save, `/admin`'s server-side redirect. (It was `proxy.ts` once; the proxy no longer
 * gates pages — see `lib/protected-routes.ts`.) The login page ignored it and passed a hard-coded
 * `'/'` to `signIn()`, which meant tapping "Tracker", signing in, and landing on the home page —
 * indistinguishable from the sign-in having failed, and the reason this was reported as "clicking
 * the tracker just sends me to sign in".
 *
 * THIS IS A TRUST BOUNDARY, NOT A CONVENIENCE. The value arrives in the URL, so anyone can
 * choose it. Passing it through unchecked is a textbook open redirect: a link to
 * `…/login?callbackUrl=https://evil.example/login` produces a real sign-in on the real domain
 * that lands the user on an attacker's page, which is a better phishing setup than a lookalike
 * domain because every visible signal up to the final hop is genuine.
 *
 * So this allows exactly one shape: a same-origin ABSOLUTE PATH, optionally with a query. Everything
 * else falls back to `/`. The rejections that are easy to miss:
 *
 *   · `//evil.example`   — protocol-relative. Browsers read this as a HOST, not a path.
 *   · `/\evil.example`   — backslash; several browsers normalise `\` to `/`, making it the above.
 *   · `https://…`        — absolute, even when the host looks like ours (`pulseblr.evil.example`).
 *   · `javascript:…`     — a scheme with no slash at all.
 *   · `%2F%2Fevil`       — encoded protocol-relative, which is why a wholly-encoded value is
 *                          decoded BEFORE it is inspected.
 *
 * A bare `/` prefix check alone stops none of the first two, which is why they are pinned in
 * `tests/auth-callback-url.test.ts`.
 *
 * ── THE QUERY STRING IS RETURNED EXACTLY AS IT ARRIVED. That is the second job, and it broke. ──
 *
 * The PWA's share target (`public/manifest.json`) opens `/add-event?title=…&text=…&url=…`, a
 * protected page, so a signed-out share goes through sign-in — and the shared content lives
 * entirely in that query. This function used to decode the value AGAIN before inspecting it and
 * returned the decoded form, on top of the decode `URLSearchParams.get()` had already done.
 * Measured against the old code with the gate carrying the query:
 *
 *   title=Hello%20%26%20bye&…   → `/`. The second decode exposed the SPACE, the control-character
 *                                 check refused it, and every share with a space in its title —
 *                                 nearly all of them — landed on the home page.
 *   title=R%26D&text=a%2Bb%3Dc&url=https%3A%2F%2Fexample.com%2Fe%3Fa%3D1%26b%3D2%23frag
 *                               → title "R", text "a b=c", url "https://example.com/e?a=1", a
 *                                 spurious `b=2` param, and `#frag` promoted to a real fragment.
 *
 * So a value that already reads as a path is inspected but NEVER rewritten. The inspection that
 * needs decoding still gets it, on the PATH only (see `isSafeCallbackPath`): the query is opaque
 * payload that the destination page parses for itself, and judging it would mean judging somebody's
 * shared text for containing spaces and newlines.
 */

/** The page to land on when no usable destination was supplied. */
export const DEFAULT_CALLBACK_URL = '/';

/** The sign-in page. A destination that points back here would loop, so it is refused. */
export const LOGIN_PATH = '/login';

/**
 * Is this a character that must never appear in a callback path?
 *
 * Written as a code-point test rather than a regex character class on purpose: this file has
 * been edited through a shell heredoc once, which turned the escapes into literal control
 * BYTES and left a class that matched almost nothing. A numeric comparison cannot be corrupted
 * that way, and it reads the same as what it means — anything at or below U+0020 (space, tab,
 * newline, NUL) plus U+007F. Browsers strip tab/CR/LF while parsing a URL, so leaving them in
 * would let `/<TAB>/evil.example` survive the protocol-relative check and then become one.
 */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Does this read as a path on OUR origin: one leading `/`, and not the protocol-relative form in
 * either slash flavour? Tested on the SECOND character, so `/tracker` passes while `//evil`,
 * `///evil` and `/\evil` do not.
 */
function isRootRelative(value: string): boolean {
  return value.startsWith('/') && value[1] !== '/' && value[1] !== '\\';
}

/**
 * Everything before the first `?` or `#` — the only part that decides WHERE a URL goes.
 *
 * A loop rather than a regex for the same reason as `hasControlCharacter`.
 */
function pathOf(value: string): string {
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '?' || value[i] === '#') return value.slice(0, i);
  }
  return value;
}

/** `/login` itself or anything beneath it. `/loginhelp` is a different page. */
function isLoginPath(path: string): boolean {
  return path === LOGIN_PATH || path.startsWith(`${LOGIN_PATH}/`);
}

/**
 * The checks, applied to the exact string that will be returned.
 *
 * TWO READINGS OF THE PATH, because two readers exist:
 *
 *   1. The WHOLE value as the browser (and Auth.js's default `redirect` callback) will read it.
 *      Nothing we build ever contains a literal control character — `encodeURIComponent` escapes
 *      them all — so any at all is refused, anywhere in the string.
 *   2. The PATH decoded once more, as defence in depth against a reader that decodes before it
 *      navigates. None does today (`signIn()` posts the value inside `URLSearchParams`, which
 *      round-trips exactly, and Auth.js prefixes the origin to a leading-`/` path), but the old
 *      implementation inspected a decoded form and this keeps every rejection that gave it:
 *      `/%2F%2Fevil.example`, `/%5Cevil.example` and `/%09/evil.example` all still fall back.
 *
 * The QUERY is deliberately not decoded for inspection. Decoded, a shared title legitimately holds
 * spaces, `&`, `=`, `#` and newlines — exactly the characters the whole-value check refuses — and
 * none of them can move the destination off this origin, because they sit after the path.
 */
function isSafeCallbackPath(value: string): boolean {
  if (hasControlCharacter(value)) return false;
  if (!isRootRelative(value)) return false;

  const path = pathOf(value);
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(path);
  } catch {
    // A malformed escape in the PATH is not something to guess at. (One in the query is the
    // destination page's business — "100% free" is a real title.)
    return false;
  }
  if (hasControlCharacter(decodedPath) || !isRootRelative(decodedPath)) return false;

  // Never bounce someone back to the sign-in page: it would send them here again and the two
  // would ping-pong. Landing on the home page signed in is a working outcome. Judged on the path,
  // so `/login?…` and `/login#…` are both caught.
  if (isLoginPath(path) || isLoginPath(decodedPath)) return false;

  return true;
}

/**
 * Coerce an untrusted `callbackUrl` into a safe same-origin path.
 *
 * Returns a path beginning with a single `/` — with its query string byte-for-byte as received —
 * or `DEFAULT_CALLBACK_URL`.
 */
export function safeCallbackUrl(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_CALLBACK_URL;

  /*
   * UNWRAP A WHOLLY-ENCODED VALUE, AT MOST ONCE.
   *
   * `searchParams.get('callbackUrl')` has already decoded one layer, so a value built with
   * `encodeURIComponent` arrives as a plain path. One that does NOT start with `/` may still be
   * wearing a second layer (`%2Ftracker`, from a double-encoded link) — decoding that once is what
   * lets `%2F%2Fevil.example` be judged as the `//evil.example` that any decoding reader would make
   * of it. A value that already starts with `/` is a path, and decoding it again is exactly the bug
   * described in the header.
   */
  let value = raw;
  if (!value.startsWith('/')) {
    try {
      value = decodeURIComponent(value);
    } catch {
      // A malformed escape sequence is not something to guess at.
      return DEFAULT_CALLBACK_URL;
    }
  }

  return isSafeCallbackPath(value) ? value : DEFAULT_CALLBACK_URL;
}

/**
 * The sign-in link that returns to `target` afterwards.
 *
 * `target` goes through `safeCallbackUrl` on the way IN as well as on the way out, so a link built
 * here is always one the login page will honour verbatim — the two halves cannot disagree about
 * what is acceptable. Encoded with `encodeURIComponent`, whose output `URLSearchParams.get()`
 * reverses exactly (it never emits `+`, the one character `get()` would turn into a space).
 *
 * Nothing worth carrying — the home page, `/login`, anything unsafe — is a bare `/login`, which
 * lands on `/` anyway.
 */
export function loginHref(target: string | null | undefined): string {
  const destination = safeCallbackUrl(target);
  return destination === DEFAULT_CALLBACK_URL
    ? LOGIN_PATH
    : `${LOGIN_PATH}?callbackUrl=${encodeURIComponent(destination)}`;
}

/**
 * The page the user is on, as a callback target: path AND query string.
 *
 * `location` is `window.location` (or undefined on the server); `routerPathname` is
 * `usePathname()` when the caller has it.
 *
 * WHY THE PATHNAME COMPARISON. During a client-side navigation Next renders the NEW route before
 * the address bar changes: `HistoryUpdater` in `next/dist/client/components/app-router.js` calls
 * `history.pushState` from a `useInsertionEffect`, i.e. after render. So a component rendering the
 * new page reads the OLD `window.location` — tapping Tracker from `/?q=react` would carry
 * `/tracker?q=react`. When the two pathnames disagree, the query belongs to the page being left and
 * is dropped: the result is the path alone, which is never wrong, only less specific. A fresh
 * document load — which is how the share target arrives — always agrees.
 */
export function currentPageTarget(
  location: { pathname: string; search: string } | null | undefined,
  routerPathname?: string | null
): string {
  if (!location) return routerPathname || DEFAULT_CALLBACK_URL;
  if (routerPathname && routerPathname !== location.pathname) return routerPathname;
  return `${location.pathname}${location.search}`;
}
