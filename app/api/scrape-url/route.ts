import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/api-auth';
import { safeFetch, UnsafeUrlError } from '@/lib/security/safe-fetch';
import { callerFacingMessage, errorLogLine } from '@/lib/http/errors';
/**
 * The SAME date rule the validator applies, not a copy of it. See the note at the JSON-LD dates
 * below for why this route and `validateManualEvent` must read dates identically.
 */
import { toFormDateTime } from '@/lib/events/manual-input';

/**
 * POST /api/scrape-url
 * Body: { url: string }
 * Returns: { event: Partial<EventFields> | null }
 *
 * Fetches the raw HTML of a Luma / Meetup / Hasgeek / Devfolio URL
 * and extracts basic event metadata using simple regex/text heuristics.
 * Does NOT require Playwright — uses fetch() so it works on serverless.
 */
export async function POST(request: NextRequest) {
  // Signed-in only. This endpoint makes the SERVER issue a request to a destination the
  // caller chooses, so leaving it open made it a general-purpose proxy sitting inside
  // the deployment's network.
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  try {
    const { url } = await request.json();
    if (!url || typeof url !== 'string') {
      return NextResponse.json({ error: 'url is required' }, { status: 400 });
    }

    // safeFetch enforces http(s) only, refuses any host that resolves to a private,
    // loopback or link-local address (169.254.169.254 is the cloud metadata service,
    // which hands out temporary credentials), re-validates every redirect hop, and caps
    // the body size. Previously this was a bare fetch(url) with no validation at all.
    let result;
    try {
      result = await safeFetch(url, { timeoutMs: 8000, accept: 'text/html' });
    } catch (err) {
      /*
       * The one error whose wording a caller may read, and WHICH errors qualify is decided in
       * lib/http/errors.ts (`callerFacingMessage`) rather than by a `.message` read here. That keeps
       * `tests/api-error-leaks.test.ts` able to hold every route to "no error text in a body" with no
       * exceptions, and it sends the message as one clean, bounded line.
       */
      if (err instanceof UnsafeUrlError) {
        return NextResponse.json(
          { event: null, error: callerFacingMessage(err) ?? 'That URL cannot be fetched.' },
          { status: 400 }
        );
      }
      throw err;
    }

    if (result.status < 200 || result.status >= 300) {
      return NextResponse.json({ event: null, error: 'Could not fetch URL' }, { status: 200 });
    }

    const html = result.body;

    // ── Helpers ──────────────────────────────────────────────────────────────
    const metaContent = (name: string): string | undefined => {
      const m = html.match(
        new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i')
      ) ?? html.match(
        new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${name}["']`, 'i')
      );
      return m?.[1];
    };

    const stripHtml = (s: string) =>
      s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    // Base for resolving relative asset URLs. The request URL, not the canonical tag — the
    // canonical is parsed later and may itself be relative.
    const canonicalBase = url;

    // ── Extract fields ────────────────────────────────────────────────────────

    // Title
    const title =
      metaContent('og:title') ??
      metaContent('twitter:title') ??
      html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] ??
      '';

    // Description
    const description =
      metaContent('og:description') ??
      metaContent('twitter:description') ??
      metaContent('description') ??
      '';

    /*
     * Image. This was `// const image = metaContent('og:image');` — extraction commented out —
     * so "Import from Link" never returned a cover and every manually added event fell back to
     * the category-tinted monogram. The form had no image field either, so there was nowhere to
     * put one even by hand.
     *
     * JSON-LD FIRST, then og:image. For an event page the schema.org `image` is the event's own
     * artwork, while `og:image` is whatever the site wants in a social card — often a site-wide
     * banner or logo. Preferring the specific one over the generic one is the whole point of
     * looking in two places.
     *
     * schema.org allows `image` to be a string, an array, or an ImageObject, and real pages use
     * all three, so it is normalised rather than assumed.
     */
    const firstImage = (value: unknown): string | undefined => {
      if (!value) return undefined;
      if (typeof value === 'string') return value;
      if (Array.isArray(value)) {
        for (const item of value) {
          const found = firstImage(item);
          if (found) return found;
        }
        return undefined;
      }
      if (typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        return firstImage(obj.url ?? obj.contentUrl);
      }
      return undefined;
    };

    let image: string | undefined;
    const imageLd = html.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
    if (imageLd) {
      try {
        const ld = JSON.parse(imageLd[1]);
        for (const node of (Array.isArray(ld) ? ld : [ld]) as Array<Record<string, unknown>>) {
          if (node['@type'] === 'Event' || node['@type'] === 'SocialEvent') {
            image = firstImage(node.image);
            break;
          }
        }
      } catch {
        // ignore JSON parse errors — og:image below is the fallback
      }
    }
    image = image ?? metaContent('og:image') ?? metaContent('twitter:image');

    /*
     * Resolve against the page and reject anything that is not http(s).
     *
     * Relative values like `/images/cover.png` are common and would render as a broken image.
     * The scheme check matters more: the cover is rendered in a plain <img src>, so a
     * `javascript:` or `data:` value from a page we do not control has no business reaching it.
     * `safeFetch` guards what this route FETCHES; this guards what it hands back.
     */
    if (image) {
      try {
        const resolved = new URL(image, canonicalBase);
        image = /^https?:$/.test(resolved.protocol) ? resolved.toString() : undefined;
      } catch {
        image = undefined;
      }
    }

    // Organizer — try JSON-LD first
    let organizer: string | undefined;
    const jsonLdMatch = html.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
    if (jsonLdMatch) {
      try {
        const ld = JSON.parse(jsonLdMatch[1]);
        const ldArr = Array.isArray(ld) ? ld : [ld];
        for (const node of ldArr) {
          if (node['@type'] === 'Event' || node['@type'] === 'SocialEvent') {
            organizer = node?.organizer?.name ?? node?.organizer?.[0]?.name;
            break;
          }
        }
      } catch {
        // ignore JSON parse errors
      }
    }

    /**
     * Dates — JSON-LD `startDate` / `endDate` first, then `<time datetime>`.
     *
     * RETURNED AS IST WALL-CLOCK TEXT (`YYYY-MM-DDTHH:mm`), which is what the form's datetime-local
     * inputs hold and what the person reads as Bengaluru time.
     *
     * THIS USED TO BE `new Date(node.startDate).toISOString().slice(0, 16)` — the UTC wall clock
     * with its zone cut off — so a 19:00 IST event arrived in the form as 13:30. On the UTC
     * production host it then "worked", because `validateManualEvent` read the zone-less text in
     * the server's zone (UTC) and the two errors cancelled. Fixing the validator alone would have
     * moved every imported event 5.5 hours, so both now go through `parseEventDateTime` in
     * `lib/events/manual-input.ts`: an explicit zone is that instant, a zone-less value is IST, and
     * the round trip back to the same instant is pinned by `tests/manual-event-time.test.ts`.
     *
     * A DATE WITH NO TIME (`"startDate": "2026-11-12"`, common on conference pages) yields nothing:
     * prefilling midnight would present a time the page never published. It still counts as the
     * markup having answered, so the `<time>` heuristic below does not then override proper Event
     * markup with whatever `<time>` happens to come first — that ordering is the heuristic's own
     * safety argument. (An unreadable value such as "TBA" does NOT count, exactly as before.)
     */
    let startDateTime: string | undefined;
    let endDateTime: string | undefined;
    let jsonLdDateOnly = false;

    if (jsonLdMatch) {
      try {
        const ld = JSON.parse(jsonLdMatch[1]);
        const ldArr = Array.isArray(ld) ? ld : [ld];
        for (const node of ldArr) {
          if (node['@type'] === 'Event' || node['@type'] === 'SocialEvent') {
            startDateTime = toFormDateTime(node.startDate);
            endDateTime = toFormDateTime(node.endDate);
            jsonLdDateOnly =
              !startDateTime &&
              typeof node.startDate === 'string' &&
              /^\d{4}-\d{2}-\d{2}$/.test(node.startDate.trim());
            break;
          }
        }
      } catch {
        // ignore
      }
    }

    /**
     * Fall back to <time datetime="…"> when JSON-LD gave no date.
     *
     * This is what makes "Import from Link" useful for the pages a crawler CANNOT reach,
     * which is the whole reason the feature exists. Measured with
     * scripts/diag-import-from-link.ts: Luma and HasGeek fill 7 of 7 fields from JSON-LD,
     * but FOSS United filled only 3 of 7 — no date — despite publishing start and end as
     *
     *     <time datetime="2026-08-01T14:00:00">2:00 PM</time>
     *     <time datetime="2026-08-01T17:00:00">5:00 PM</time>
     *
     * <time datetime> is a web standard, so reading it is not selector guessing; it helps
     * every site with semantic markup, not just this one.
     *
     * The first two parseable values are taken as start and end, which is the ordinary
     * document order for an event's own times. A page whose first <time> is a post date
     * would mislead this, so it only ever runs when JSON-LD produced nothing — a page with
     * proper Event markup is always trusted over a heuristic.
     *
     * Unzoned values were already read as IST here (`${value}+05:30`) — and then emitted as UTC
     * wall-clock text by the same `toISOString().slice(0, 16)` as above, so the one path that
     * got the zone right on the way in lost it on the way out. `toFormDateTime` is that same IST
     * rule end to end. It also SKIPS a date-only `<time datetime="2026-08-01">`, which on a real
     * page is far more often a publication date than an event's start.
     */
    if (!startDateTime && !jsonLdDateOnly) {
      const times: string[] = [];
      for (const m of html.matchAll(/<time[^>]*datetime=["']([^"']+)["']/gi)) {
        const value = toFormDateTime(m[1]);
        if (value) times.push(value);
        if (times.length >= 2) break;
      }
      if (times[0]) startDateTime = times[0];
      if (!endDateTime && times[1]) endDateTime = times[1];
    }

    // Venue
    let venue: string | undefined;
    let format: 'online' | 'offline' | 'hybrid' = 'offline';

    if (jsonLdMatch) {
      try {
        const ld = JSON.parse(jsonLdMatch[1]);
        const ldArr = Array.isArray(ld) ? ld : [ld];
        for (const node of ldArr) {
          if (node['@type'] === 'Event' || node['@type'] === 'SocialEvent') {
            const loc = node.location;
            if (loc) {
              if (loc['@type'] === 'VirtualLocation') {
                format = 'online';
              } else {
                venue = loc.name ?? loc.address?.streetAddress;
                format = 'offline';
              }
            }
            break;
          }
        }
      } catch {
        // ignore
      }
    }

    // Detect online from keywords if not already set
    if (!venue && /online|virtual|zoom|meet\.google|teams\.microsoft|webinar/i.test(html.slice(0, 5000))) {
      format = 'online';
    }

    /*
     * sourceUrl — the page's canonical link, RESOLVED against the page and kept only if http(s).
     *
     * It used to be the raw attribute text. A relative canonical (`/events/123`) is legal HTML and
     * common, and `validateManualEvent` drops anything that is not an absolute http(s) URL — so the
     * import filled "Event URL" with a value the save then silently threw away, and the event was
     * stored pointing at the `https://pulseblr.local/manual` placeholder. `&amp;` is decoded because
     * this is attribute text, not a URL: the browser would decode it before following the link.
     */
    let canonical = url;
    const canonicalHref = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1];
    if (canonicalHref) {
      try {
        const resolved = new URL(canonicalHref.replace(/&amp;/g, '&'), url);
        if (resolved.protocol === 'http:' || resolved.protocol === 'https:') canonical = resolved.href;
      } catch {
        // an unparseable canonical is ignored; the URL the person gave is still a fine source link
      }
    }

    const event = {
      title: stripHtml(title).slice(0, 200),
      description: stripHtml(description).slice(0, 1000),
      organizer: organizer?.slice(0, 100),
      sourceUrl: canonical,
      startDateTime,
      endDateTime,
      venue,
      format,
      imageUrl: image,
    };

    // If we got at least a title, return it
    if (event.title) {
      return NextResponse.json({ event });
    }

    return NextResponse.json({ event: null });
  } catch (error) {
    /*
     * NO ECHOED MESSAGE. This is the catch-all, so what lands here is an internal fault — a
     * regex/parse throw, or a `safeFetch` failure carrying network detail about the deployment's
     * own egress. The `UnsafeUrlError` branch ABOVE is the deliberate exception and must stay:
     * that message is written by `lib/security/safe-fetch.ts` for the caller, and it is the only
     * way they learn WHY their URL was refused rather than merely that it was.
     */
    // The URL is the caller's, and a fetch error can quote it: one inert line.
    console.error('scrape-url error:', errorLogLine(error));
    return NextResponse.json({ event: null, error: 'Could not read that URL' }, { status: 200 });
  }
}
