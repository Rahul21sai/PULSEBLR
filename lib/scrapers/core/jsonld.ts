// Generic schema.org JSON-LD Event extraction.
//
// This is the single highest-leverage parser in the codebase: recon proved that
// AllEvents.in, Eventbrite, Meetup (both event pages and city find pages), Luma
// event pages and company pages like postman.com/events all publish their events
// as JSON-LD `Event` nodes. One correct parser therefore unlocks many sources,
// and the universal adapter uses it to crack arbitrary company event pages.
//
// Everything here is defensive: schema.org allows almost every field to be a
// string, an object, or an array of either, and real sites use all three forms.

import { RawEvent } from './types';
import { stripHtml, truncate, firstText, absoluteUrl } from './text';

/** Extract and parse every JSON-LD block on a page (tolerant of odd attributes). */
export function extractJsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const re = /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const body = match[1].trim();
    if (!body) continue;
    try {
      blocks.push(JSON.parse(body));
    } catch {
      // Some sites emit JS-escaped or trailing-comma JSON. Try one cheap repair
      // (strip trailing commas) before giving up on the block.
      try {
        blocks.push(JSON.parse(body.replace(/,\s*([}\]])/g, '$1')));
      } catch {
        /* genuinely malformed — skip */
      }
    }
  }
  return blocks;
}

function typeIncludesEvent(value: unknown): boolean {
  if (typeof value === 'string') return /Event$/i.test(value) || value === 'Event';
  if (Array.isArray(value)) return value.some(typeIncludesEvent);
  return false;
}

/** Recursively collect every JSON-LD node whose @type is an Event variant. */
export function collectEventNodes(blocks: unknown[]): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  const stack: unknown[] = [...blocks];

  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (seen.has(node)) continue;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }

    const obj = node as Record<string, unknown>;
    if (typeIncludesEvent(obj['@type']) && (obj.name || obj.startDate)) {
      found.push(obj);
    }
    // Keep walking: @graph, itemListElement, subEvent all nest events.
    for (const value of Object.values(obj)) {
      if (value && typeof value === 'object') stack.push(value);
    }
  }

  return found;
}

/** Pull the first usable string out of a schema.org value that may be nested. */
function scalar(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const resolved = scalar(item);
      if (resolved) return resolved;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return scalar(obj.name ?? obj['@id'] ?? obj.url ?? obj.text);
  }
  return undefined;
}

function numeric(value: unknown): number | undefined {
  const text = scalar(value);
  if (text === undefined) return undefined;
  const parsed = Number(String(text).replace(/[^0-9.]/g, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Build a readable venue + address pair from schema.org `location`. */
function parseLocation(location: unknown): {
  venue?: string;
  address?: string;
  city?: string;
  lat?: number;
  lng?: number;
  isVirtual: boolean;
  onlineLink?: string;
} {
  const first = Array.isArray(location) ? location[0] : location;
  if (!first || typeof first !== 'object') {
    return { isVirtual: false, venue: scalar(location) };
  }

  const obj = first as Record<string, unknown>;
  const type = obj['@type'];
  const isVirtual =
    (typeof type === 'string' && /VirtualLocation/i.test(type)) ||
    (Array.isArray(type) && type.some(t => typeof t === 'string' && /VirtualLocation/i.test(t)));

  if (isVirtual) {
    return { isVirtual: true, onlineLink: scalar(obj.url) };
  }

  const venue = scalar(obj.name);
  let address: string | undefined;
  let city: string | undefined;

  const addr = obj.address;
  if (typeof addr === 'string') {
    address = addr.trim();
  } else if (addr && typeof addr === 'object') {
    const a = addr as Record<string, unknown>;
    city = scalar(a.addressLocality);
    address = [
      scalar(a.streetAddress),
      city,
      scalar(a.addressRegion),
      scalar(a.postalCode),
    ]
      .filter(Boolean)
      .join(', ') || undefined;
  }

  const geo = obj.geo as Record<string, unknown> | undefined;
  return {
    isVirtual: false,
    venue,
    address,
    city,
    lat: numeric(geo?.latitude),
    lng: numeric(geo?.longitude),
  };
}

/** Extract price info from schema.org `offers`. */
function parseOffers(offers: unknown): {
  isFree?: boolean;
  price?: number;
  priceMax?: number;
  currency?: string;
  soldOut?: boolean;
} {
  const list = Array.isArray(offers) ? offers : offers ? [offers] : [];
  if (list.length === 0) return {};

  const prices: number[] = [];
  let currency: string | undefined;
  let soldOut: boolean | undefined;

  for (const offer of list) {
    if (!offer || typeof offer !== 'object') continue;
    const o = offer as Record<string, unknown>;
    const low = numeric(o.lowPrice ?? o.price);
    const high = numeric(o.highPrice ?? o.price);
    if (low !== undefined) prices.push(low);
    if (high !== undefined) prices.push(high);
    currency = currency ?? scalar(o.priceCurrency);
    const availability = scalar(o.availability) || '';
    if (/SoldOut/i.test(availability)) soldOut = true;
  }

  if (prices.length === 0) return { currency, soldOut };

  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return {
    isFree: max === 0,
    price: min > 0 ? min : undefined,
    priceMax: max > min ? max : undefined,
    currency,
    soldOut,
  };
}

/** Direct ticket URL from `offers`, which may be a single object or an array. */
function offerUrl(offers: unknown): string | undefined {
  const list = Array.isArray(offers) ? offers : offers ? [offers] : [];
  for (const offer of list) {
    if (offer && typeof offer === 'object') {
      const url = scalar((offer as Record<string, unknown>).url);
      if (url) return url;
    }
  }
  return undefined;
}

/** Parse a schema.org date. Returns undefined for missing/unparseable values. */
function parseDate(value: unknown): Date | undefined {
  const text = scalar(value);
  if (!text) return undefined;
  // Date-only values ("2026-12-05") are common on AllEvents.in. Anchor them to
  // 19:00 IST rather than UTC midnight, which would otherwise render as
  // "5 Dec, 5:30 AM" in the feed and read as a data bug to the user.
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return new Date(`${text}T19:00:00+05:30`);
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export interface JsonLdParseOptions {
  /** Page URL, used to absolutise relative links. */
  baseUrl: string;
  /** Source value stamped on each event. */
  source: string;
}

/**
 * Convert one JSON-LD Event node into a RawEvent.
 * Returns null when the node lacks the two fields we refuse to invent: a title
 * and a parseable start date.
 */
export function eventNodeToRawEvent(
  node: Record<string, unknown>,
  opts: JsonLdParseOptions
): RawEvent | null {
  const title = scalar(node.name);
  const startDateTime = parseDate(node.startDate);
  if (!title || !startDateTime) return null;

  const location = parseLocation(node.location);
  const offers = parseOffers(node.offers);
  const attendanceMode = scalar(node.eventAttendanceMode) || '';
  const isOnline = location.isVirtual || /Online/i.test(attendanceMode);
  const isHybrid = /Mixed/i.test(attendanceMode);

  const url = absoluteUrl(scalar(node.url), opts.baseUrl) || opts.baseUrl;
  const image = absoluteUrl(scalar(node.image), opts.baseUrl);
  const descriptionRaw = scalar(node.description) || title;

  const status = scalar(node.eventStatus) || '';
  // Cancelled events are dropped by the caller via this flag on tags.
  const tags: string[] = [];
  if (/Cancelled/i.test(status)) tags.push('__cancelled');
  if (/Postponed/i.test(status)) tags.push('__postponed');

  return {
    title,
    description: truncate(stripHtml(descriptionRaw), 4000),
    sourceUrl: url,
    source: opts.source,
    sourceEventId: scalar(node['@id']) || url,
    organizer: scalar(node.organizer) ?? scalar(node.performer),
    venue: isOnline ? undefined : location.venue,
    address: isOnline ? undefined : location.address,
    city: location.city,
    lat: location.lat,
    lng: location.lng,
    onlineLink: isOnline || isHybrid ? location.onlineLink || url : undefined,
    startDateTime,
    endDateTime: parseDate(node.endDate),
    imageUrl: image,
    isFree: offers.isFree,
    price: offers.price,
    priceMax: offers.priceMax,
    currency: offers.currency,
    soldOut: offers.soldOut,
    // JSON-LD has no "how many people are coming" field, only capacity. We leave
    // attendeeCount unset rather than conflating the two — the feed shows it as
    // social proof, and capacity would misrepresent an empty event as popular.
    capacity: numeric(node.maximumAttendeeCapacity),
    applyLink: firstText(offerUrl(node.offers), url),
    tags,
    rawFormat: isHybrid ? 'hybrid' : isOnline ? 'online' : 'offline',
  };
}

/** Extract every usable RawEvent from a page's JSON-LD. */
export function rawEventsFromHtml(html: string, opts: JsonLdParseOptions): RawEvent[] {
  const nodes = collectEventNodes(extractJsonLdBlocks(html));
  const events: RawEvent[] = [];
  for (const node of nodes) {
    const event = eventNodeToRawEvent(node, opts);
    if (event && !event.tags?.includes('__cancelled')) events.push(event);
  }
  return events;
}

/** Parse the Next.js `__NEXT_DATA__` payload, if the page has one. */
export function extractNextData(html: string): unknown | null {
  const match = html.match(
    /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/
  );
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}
