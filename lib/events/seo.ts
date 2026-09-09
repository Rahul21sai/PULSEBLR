// Structured data and share metadata for a single event page.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS IS A PURE MODULE. Everything here is a total function of one event plus its canonical
// URL, so it sits in the vitest tier (`tests/event-seo.test.ts`) rather than needing a server, a
// browser or a database. That matters because two of its behaviours are security properties, and a
// security property asserted only by a diagnostic somebody has to remember to run is not asserted.
//
// TWO RULES, BOTH LOAD-BEARING.
//
//   1. A NON-PUBLIC EVENT PRODUCES NO STRUCTURED DATA. `visibility: 'private'` and `'pending'`
//      events are reachable at their own URL by their owner, and pending ones by an admin. Emitting
//      JSON-LD for them would publish another user's private event into a search index — strictly
//      worse than an in-app disclosure, because an index is not something you can retract. The
//      caller must ALSO set `robots: { index: false }`; `isIndexableEvent` is exported so both
//      decisions read from one predicate rather than two copies of the same condition.
//
//      Absence is the common case, not a fallback: roughly 1500 stored documents predate the
//      `visibility` field entirely and every one of them is a scraped, public event.
//
//   2. `JSON.stringify` DOES NOT ESCAPE `<`. Next's own JSON-LD guide states this outright — it
//      "does not sanitize malicious strings used in XSS injection". Every string here (title,
//      description, organizer, venue) is SCRAPED from a third-party page, so it is
//      attacker-influenced by construction. A title carrying `</script><script>…` would be stored
//      XSS on our own domain. `serializeJsonLd` is the only sanctioned way to render this object;
//      never hand a raw `JSON.stringify` to `dangerouslySetInnerHTML`.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { fullDateIST, stripMarkdown } from '../format';
import { truncate } from '../scrapers/core/text';

/**
 * The only fields SEO reads. Narrow on purpose, so a lean projection or a full document both
 * satisfy it and the caller is not obliged to hydrate an entire event to build a share card.
 */
export interface SeoEvent {
  _id: string;
  title: string;
  description?: string | null;
  format: 'online' | 'offline' | 'hybrid';
  isFree: boolean;
  price?: number | null;
  currency?: string | null;
  soldOut?: boolean | null;
  venue?: string | null;
  address?: string | null;
  area?: string | null;
  city?: string | null;
  onlineLink?: string | null;
  imageUrl?: string | null;
  organizer?: string | null;
  startDateTime: string;
  endDateTime?: string | null;
  applyLink?: string | null;
  /** Absent or 'public' ⇒ indexable. 'private' and 'pending' ⇒ never. */
  visibility?: string | null;
}

/** Shape of what we emit. Loose by design — schema.org accepts more than we model. */
export type EventJsonLd = Record<string, unknown> & {
  '@context': string;
  '@type': 'Event';
  name: string;
  startDate: string;
  url: string;
};

const SCHEMA = 'https://schema.org';
const DEFAULT_CITY = 'Bengaluru';
const DEFAULT_CURRENCY = 'INR';

/** Share-card descriptions are cut here. Both OG and Twitter truncate around this length. */
const OG_DESCRIPTION_CHARS = 200;

/** May this event appear in a search index? The single predicate for JSON-LD and `robots`. */
export function isIndexableEvent(event: Pick<SeoEvent, 'visibility'>): boolean {
  return !event.visibility || event.visibility === 'public';
}

/** ISO string, or null when the input is missing or unparseable — never `Invalid Date`. */
function isoOrNull(value?: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const ATTENDANCE_MODE: Record<SeoEvent['format'], string> = {
  offline: `${SCHEMA}/OfflineEventAttendanceMode`,
  online: `${SCHEMA}/OnlineEventAttendanceMode`,
  hybrid: `${SCHEMA}/MixedEventAttendanceMode`,
};

/**
 * Where the event is.
 *
 * A `VirtualLocation` is only emitted when there is a real URL to put in it: an online event whose
 * link we never captured would otherwise produce `{"url": ""}`, which is worse than saying nothing
 * because it asserts a location and then fails to name one. Those fall back to a `Place`, as does
 * every in-person event — `Event` wants a location, and the city is always known here.
 */
function buildLocation(event: SeoEvent): Record<string, unknown> {
  if (event.format === 'online' && event.onlineLink) {
    return { '@type': 'VirtualLocation', url: event.onlineLink };
  }

  const city = event.city || DEFAULT_CITY;
  const address: Record<string, unknown> = {
    '@type': 'PostalAddress',
    addressLocality: city,
    addressRegion: 'Karnataka',
    addressCountry: 'IN',
  };
  if (event.address) address.streetAddress = event.address;

  return {
    '@type': 'Place',
    name: event.venue || event.area || city,
    address,
  };
}

function buildOffer(event: SeoEvent, canonicalUrl: string): Record<string, unknown> {
  const availability = event.soldOut ? `${SCHEMA}/SoldOut` : `${SCHEMA}/InStock`;
  const price = event.isFree ? 0 : (event.price ?? 0);
  return {
    '@type': 'Offer',
    price: String(price),
    priceCurrency: event.currency || DEFAULT_CURRENCY,
    availability,
    url: event.applyLink || canonicalUrl,
  };
}

/**
 * Build schema.org `Event` structured data, or null when this event must not be indexed.
 *
 * Also returns null when the start date cannot be parsed: an `Event` with no `startDate` is invalid
 * structured data, and emitting an invalid block is worse than emitting none — Google reports it as
 * an error against the whole page rather than ignoring it.
 */
export function buildEventJsonLd(event: SeoEvent, canonicalUrl: string): EventJsonLd | null {
  if (!isIndexableEvent(event)) return null;

  const startDate = isoOrNull(event.startDateTime);
  if (!startDate) return null;

  const jsonLd: EventJsonLd = {
    '@context': SCHEMA,
    '@type': 'Event',
    name: event.title,
    startDate,
    url: canonicalUrl,
    eventAttendanceMode: ATTENDANCE_MODE[event.format],
    eventStatus: `${SCHEMA}/EventScheduled`,
    location: buildLocation(event),
    offers: buildOffer(event, canonicalUrl),
    description: eventSeoDescription(event),
  };

  const endDate = isoOrNull(event.endDateTime);
  if (endDate) jsonLd.endDate = endDate;
  if (event.imageUrl) jsonLd.image = event.imageUrl;
  if (event.organizer) {
    jsonLd.organizer = { '@type': 'Organization', name: event.organizer };
  }

  return jsonLd;
}

/**
 * Render structured data for `dangerouslySetInnerHTML`. THE ONLY sanctioned serialiser.
 *
 * The `<` → `<` replacement is what stops a scraped title from closing our script tag. It is
 * safe for the payload because JSON decodes the escape back to the original character, so the
 * consumer sees the real string — the escaping exists purely to survive HTML parsing.
 *
 * Returns '' for null so a caller that renders unconditionally emits an empty script rather than the
 * four characters `null`.
 */
export function serializeJsonLd(value: unknown): string {
  if (value === null || value === undefined) return '';
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * A description fit for a share card.
 *
 * Falls back to a generated sentence rather than an empty string: an empty `og:description` makes a
 * link preview look broken, and 10% of the corpus has no usable description at all.
 */
export function eventSeoDescription(event: SeoEvent): string {
  const raw = (event.description || '').trim();

  if (raw) {
    const clean = stripMarkdown(raw).replace(/\s+/g, ' ').trim();
    if (clean) {
      // `truncate` appends an ellipsis, so ask for one fewer to land on the cap exactly.
      return truncate(clean, OG_DESCRIPTION_CHARS - 1);
    }
  }

  const city = event.city || DEFAULT_CITY;
  const where = event.format === 'online' ? null : event.venue || event.area || null;
  const at = where && where !== city ? ` at ${where}` : '';
  return `A tech event in ${city}${at} on ${fullDateIST(event.startDateTime)}.`;
}
