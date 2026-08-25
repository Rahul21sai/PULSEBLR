/**
 * Where to send someone after they sign in.
 *
 * `proxy.ts` appends `?callbackUrl=<path>` when it bounces a signed-out visitor off a
 * protected page, so that signing in returns them to what they were actually trying to open.
 * The login page ignored it and passed a hard-coded `'/'` to `signIn()`, which meant tapping
 * "Tracker", signing in, and landing on the home page — indistinguishable from the sign-in
 * having failed, and the reason this was reported as "clicking the tracker just sends me to
 * sign in".
 *
 * THIS IS A TRUST BOUNDARY, NOT A CONVENIENCE. The value arrives in the URL, so anyone can
 * choose it. Passing it through unchecked is a textbook open redirect: a link to
 * `…/login?callbackUrl=https://evil.example/login` produces a real sign-in on the real domain
 * that lands the user on an attacker's page, which is a better phishing setup than a lookalike
 * domain because every visible signal up to the final hop is genuine.
 *
 * So this allows exactly one shape: a same-origin ABSOLUTE PATH. Everything else falls back
 * to `/`. The rejections that are easy to miss:
 *
 *   · `//evil.example`   — protocol-relative. Browsers read this as a HOST, not a path.
 *   · `/\evil.example`   — backslash; several browsers normalise `\` to `/`, making it the above.
 *   · `https://…`        — absolute, even when the host looks like ours (`pulseblr.evil.example`).
 *   · `javascript:…`     — a scheme with no slash at all.
 *   · `%2F%2Fevil`       — encoded protocol-relative, which is why decoding happens FIRST.
 *
 * A bare `/` prefix check alone stops none of the first two, which is why they are pinned in
 * `tests/auth-callback-url.test.ts`.
 */

/** The page to land on when no usable destination was supplied. */
export const DEFAULT_CALLBACK_URL = '/';

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
 * Coerce an untrusted `callbackUrl` into a safe same-origin path.
 *
 * Returns a path beginning with a single `/`, or `DEFAULT_CALLBACK_URL`.
 */
export function safeCallbackUrl(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_CALLBACK_URL;

  // The value has usually been through one round of URL encoding already (`%2Ftracker`).
  // Decode BEFORE inspecting, or `%2F%2Fevil.example` slips past the `//` check below and is
  // then decoded by the browser into a protocol-relative URL.
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    // A malformed escape sequence is not something to guess at.
    return DEFAULT_CALLBACK_URL;
  }

  if (!value) return DEFAULT_CALLBACK_URL;
  if (hasControlCharacter(value)) return DEFAULT_CALLBACK_URL;

  // Must be an absolute path...
  if (!value.startsWith('/')) return DEFAULT_CALLBACK_URL;

  // ...and must not be the protocol-relative form, in either slash flavour. Tested on the
  // SECOND character, so `/tracker` passes while `//evil` and `/\evil` do not.
  if (value.length > 1 && (value[1] === '/' || value[1] === '\\')) return DEFAULT_CALLBACK_URL;

  // Never bounce someone back to the sign-in page: the proxy would send them here again and
  // the two would ping-pong. Landing on the home page signed in is a working outcome.
  if (value === '/login' || value.startsWith('/login?') || value.startsWith('/login/')) {
    return DEFAULT_CALLBACK_URL;
  }

  return value;
}
