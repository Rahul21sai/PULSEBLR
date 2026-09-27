/**
 * The stand-in `sourceUrl` a hand-added event gets when its author gave no link, and the predicate
 * every consumer uses to recognise it. DEPENDENCY-FREE on purpose: the event page, the MCP
 * serialiser and both ICS writers import this, and one of them is a client component.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY A PLACEHOLDER EXISTS AT ALL. `Event.sourceUrl` is `required` in the schema, and it has to be:
 * every scraped row carries the page it came from, and dedup, provenance and the admin editor all
 * assume it. A hand-added event often has no such page — an internal hackathon, a reading group — so
 * `POST /api/events` writes this constant rather than refusing the event.
 *
 * WHY IT HAS TO BE RECOGNISED EVERYWHERE. It is a syntactically perfect https URL, so every
 * "is this linkable" check in the app (`/^https?:\/\//`) passed it. The event page rendered it as the
 * Register button (`applyLink || sourceUrl`) and as an "Organiser's page" link, both pointing at a
 * host that does not exist — a dead button on exactly the events whose author is most likely to be
 * looking at them.
 *
 * WHY THE MATCH IS BY HOST, NOT BY EXACT STRING. `.local` is reserved for multicast DNS (RFC 6762),
 * so no public page can ever live on `pulseblr.local` — matching the host is therefore exact in
 * effect while surviving the things an exact-string compare would not: a trailing slash, an
 * uppercase host, `http:` instead of `https:`, and the pipeline's other stand-in,
 * `https://pulseblr.local/microsites`. `tests/event-placeholder.test.ts` pins the look-alikes that
 * must NOT match (`notpulseblr.local`, `pulseblr.local.evil.com`, `pulseblr.localhost`).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

/** What `POST /api/events` writes when a hand-added event has no link. Import this; do not retype it. */
export const PLACEHOLDER_SOURCE_URL = 'https://pulseblr.local/manual';

const PLACEHOLDER_HOST = 'pulseblr.local';

function parseHttpUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** Is this the stand-in written because no real link was given? */
export function isPlaceholderSourceUrl(value: unknown): boolean {
  const url = parseHttpUrl(value);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  return host === PLACEHOLDER_HOST || host.endsWith(`.${PLACEHOLDER_HOST}`);
}

/**
 * A link worth putting in an `href`: http(s), and not the placeholder. Returns the trimmed URL or
 * `undefined`.
 *
 * The http(s) check is not decoration. These strings reach an `href`, and a `javascript:` value there
 * is stored XSS; the write paths validate it, but a reader should not depend on every writer having
 * done so.
 */
export function usableLink(value: unknown): string | undefined {
  const url = parseHttpUrl(value);
  if (!url || isPlaceholderSourceUrl(value)) return undefined;
  return (value as string).trim();
}

/**
 * Where the Register button goes: the registration link, else the event's real source page, else
 * nowhere. `null` means "render the no-registration-link state", never a dead button.
 */
export function registrationUrl(event: {
  applyLink?: string | null;
  sourceUrl?: string | null;
}): string | null {
  return usableLink(event.applyLink) ?? usableLink(event.sourceUrl) ?? null;
}
