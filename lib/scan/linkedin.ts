/**
 * LinkedIn profile URL parsing and canonicalisation.
 *
 * WHAT A LINKEDIN QR ACTUALLY CONTAINS (measured, not assumed):
 *
 *     https://www.linkedin.com/in/<public-vanity-slug>?fromQR=1
 *
 * 19 independently published "My code" screenshots were decoded during research,
 * spanning Jun 2018 → Mar 2026, iOS and Android, six locales. Every one matched that
 * shape with ZERO structural variation. There is no opaque token, no `/qr/` route, no
 * `mwlite` form, no embedded vCard and no name.
 *
 * That single fact drives the whole feature: the vanity slug is a globally unique,
 * stable identity for a person, available OFFLINE with no network call. It is what
 * `contactKey` prefers above everything else, and it is what makes
 * "you have now met this person at three events" an exact index lookup rather than the
 * lowercased-name guess `detectRepeatConnections()` does today.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * WE NEVER FETCH linkedin.com. This is a hard rule, not a preference.
 *
 *   - LinkedIn's User Agreement forbids software "to scrape or copy the Services,
 *     including profiles and other data from the Services", and robots.txt terminates
 *     in `User-agent: * / Disallow: /`.
 *   - It does not work anyway: measured during research, `curl` of a profile returns
 *     HTTP 999, and headless Chromium from the same address is redirected to
 *     /authwall. A Vercel or GitHub-Actions fetch gets nothing.
 *   - There is no API substitute. LinkedIn's self-serve endpoint returns only the
 *     *authenticated member's own* profile.
 *   - hiQ v. LinkedIn found scraping public pages is not a CFAA violation — but hiQ
 *     still lost on breach of the User Agreement. "Public" is not a permission slip.
 *
 * So the name comes from the vCard, or from the person, or from the eight seconds you
 * spend on the capture card. Never from an HTTP request. This also keeps us from
 * pointing an outbound fetch at a caller-supplied URL, which is exactly the SSRF shape
 * lib/security/safe-fetch.ts exists to contain.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

/** Path prefixes LinkedIn uses in front of `in/<slug>` on its various surfaces. */
const PATH_PREFIXES = new Set(['m', 'comm', 'mwlite']);

export interface LinkedInRef {
  /** Canonical, query-free profile URL. Safe to open and safe to store. */
  url: string;
  /**
   * The lowercased vanity slug, when the URL is a profile URL.
   *
   * Absent for a LinkedIn URL that is not `/in/<slug>` (a company page, a post, a
   * shortlink). The caller should then keep `url` but treat identity as unknown.
   */
  slug?: string;
}

/**
 * Recognise a LinkedIn URL and canonicalise it.
 *
 * Parsed with `URL` rather than a regex specifically so the hostname check is a real
 * hostname check: `https://linkedin.com.evil.com/in/x` must NOT be treated as LinkedIn,
 * and a substring or loosely-anchored pattern gets that wrong.
 *
 * Returns null when the input is not a LinkedIn URL at all.
 */
export function parseLinkedInUrl(raw: string): LinkedInRef | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  const host = u.hostname.toLowerCase();
  // Exact domain, or a subdomain of it (in.linkedin.com, m.linkedin.com, uk.…).
  if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return null;

  const segments = u.pathname.split('/').filter(Boolean);
  // Skip the surface prefix, if any: /m/in/x, /comm/in/x, /mwlite/in/x.
  let i = 0;
  while (i < segments.length && PATH_PREFIXES.has(segments[i].toLowerCase())) i++;

  if (segments[i]?.toLowerCase() === 'in' && segments[i + 1]) {
    const slug = normalizeLinkedInSlug(segments[i + 1]);
    if (slug) {
      // Every query param is discarded on purpose. `?fromQR=1` is LinkedIn's own
      // provenance flag and carries no information we want; research also saw stray
      // `time`/`uuid` params on related links. Canonicalising to one form is what makes
      // the slug a dependable identity key.
      return { url: `https://www.linkedin.com/in/${slug}`, slug };
    }
  }

  // A LinkedIn URL, but not a profile. Keep it — LinkedIn will resolve it in-app when
  // tapped — but do not pretend we know who it is.
  return { url: u.toString() };
}

/**
 * Normalise a raw path segment into a comparable slug.
 *
 * Percent-decoded (slugs may contain non-ASCII), lowercased, trailing slash and
 * whitespace removed. Returns '' for anything unusable.
 */
export function normalizeLinkedInSlug(segment: string): string {
  let s = segment.trim();
  if (!s) return '';
  try {
    s = decodeURIComponent(s);
  } catch {
    // A malformed escape sequence — keep the raw form rather than losing the value.
  }
  return s.replace(/\/+$/, '').trim().toLowerCase();
}

/** Build a profile URL from a stored slug. */
export function linkedInUrlFromSlug(slug: string): string {
  return `https://www.linkedin.com/in/${normalizeLinkedInSlug(slug)}`;
}

/**
 * Accept whatever a human types into a "LinkedIn" field: a full URL, a bare slug, or
 * an @handle. Returns a canonical ref, or null.
 *
 * This exists because manual entry is a first-class path — most people at an event will
 * not present a QR code at all.
 */
export function coerceLinkedInInput(input: string): LinkedInRef | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const direct = parseLinkedInUrl(trimmed);
  if (direct) return direct;

  // A pasted URL with the scheme missing — "linkedin.com/in/rahul", "www.linkedin.com/…".
  // Copying from a browser address bar drops it routinely.
  if (/^(?:[a-z0-9-]+\.)*linkedin\.com\//i.test(trimmed)) {
    const withScheme = parseLinkedInUrl(`https://${trimmed}`);
    if (withScheme) return withScheme;
  }

  // Otherwise treat it as a bare slug: "rahul-vudumula", "@rahul", "in/rahul".
  const bare = trimmed
    .replace(/^@/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/^in\//i, '');
  if (/^[\p{L}\p{N}_\-.%]+$/u.test(bare)) {
    const slug = normalizeLinkedInSlug(bare);
    if (slug) return { url: linkedInUrlFromSlug(slug), slug };
  }
  return null;
}

/**
 * Best-effort name from a vanity slug — a SUGGESTION, never a fact.
 *
 * Measured against the 19 real payloads: this fires for roughly the 5 that are
 * hyphenated (`alina-kalinina-27o6` → "Alina Kalinina") and correctly declines for the
 * concatenated custom vanities (`paulalosullivan`) and the non-names
 * (`ebusinesstutor`). Whatever it returns MUST be surfaced as editable and marked as a
 * guess — see `ParsedPerson.nameIsGuess`.
 *
 * Returns undefined when it cannot make a defensible guess, which is the common case.
 */
export function guessNameFromSlug(slug: string): string | undefined {
  const s = normalizeLinkedInSlug(slug);
  if (!s.includes('-')) return undefined;

  const tokens = s.split('-').filter(Boolean);

  // Drop trailing tokens containing a digit: LinkedIn appends a random discriminator
  // when a vanity collides (`-27o6`, `-0852331a6`, `-6396786b`). Names don't have digits.
  while (tokens.length && /\d/.test(tokens[tokens.length - 1])) tokens.pop();

  // One token is as likely a handle as a first name, so decline. More than four is not
  // a name. A very long token is a concatenated phrase, not a name part.
  if (tokens.length < 2 || tokens.length > 4) return undefined;
  if (tokens.some(t => t.length > 20 || /\d/.test(t))) return undefined;

  return tokens.map(t => t.charAt(0).toUpperCase() + t.slice(1)).join(' ');
}
