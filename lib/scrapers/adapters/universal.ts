// Universal adapter — extract events from ANY url.
//
// This exists so that adding a company/community event page is a one-line
// registry entry rather than a new scraper. Given a URL it tries, in order of
// reliability:
//
//   1. JSON-LD `Event` nodes            — schema.org, the web's actual standard.
//                                         Recon: postman.com/events yielded 15.
//   2. An advertised ICS calendar feed  — <link rel=alternate type=text/calendar>
//                                         or the handful of conventional paths.
//   3. An RSS/Atom feed                 — enumerate item links, then recurse into
//                                         each item page looking for JSON-LD.
//   4. Embedded Next.js/RSC JSON        — sites that hydrate events client-side.
//
// DELIBERATE NON-GOAL: there is no LLM-on-raw-HTML fallback and no CSS-selector
// guessing. Recon measured what those would have to cover — Red Hat, GitLab,
// Docker, Google Cloud, Databricks and Confluent event pages all returned ZERO
// structured events — and blind extraction on such pages produces confident
// garbage (wrong dates, marketing copy as titles) that is worse than absence.
// For those companies the right move is to register the Luma calendar or Meetup
// group they actually host on, which the Luma/Meetup adapters discover anyway.

import { RawEvent, ScrapeResult } from '../core/types';
import { fetchText, mapPool } from '../core/http';
import { rawEventsFromHtml, extractNextData } from '../core/jsonld';
import { rawEventsFromIcs, findIcsLink } from '../core/ics';
import { isBengaluru } from '../core/geo';
import { absoluteUrl } from '../core/text';

/** Conventional calendar paths worth trying when none is advertised. */
const ICS_GUESSES = ['/events.ics', '/calendar.ics', '/events/ical/', '/feed.ics'];

export interface UniversalOptions {
  /** Value written to Event.source. Registered company pages use 'company'. */
  source?: string;
  /** Organizer name when the page's own data doesn't supply one. */
  organizer?: string;
  /**
   * How to treat events with no location evidence.
   * 'require' (default) drops them — right for global company pages where most
   * events are elsewhere. 'accept' keeps them — right for a page that is already
   * Bengaluru-specific.
   */
  geoPolicy?: 'require' | 'accept';
  /** Follow up to N RSS item links looking for JSON-LD. 0 disables step 3. */
  followRssItems?: number;
}

/** Pull event-shaped objects out of an embedded Next.js payload. */
function eventsFromNextData(html: string, url: string, source: string): RawEvent[] {
  const data = extractNextData(html);
  if (!data) return [];

  const events: RawEvent[] = [];
  const stack: unknown[] = [data];
  const seen = new Set<unknown>();

  while (stack.length > 0 && events.length < 200) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }

    const obj = node as Record<string, unknown>;
    // An event-shaped object needs a title-ish and a date-ish field. We require
    // BOTH to avoid mistaking blog posts or nav items for events.
    const title = [obj.title, obj.name, obj.eventName].find(
      v => typeof v === 'string' && v.trim().length > 3
    ) as string | undefined;
    const rawDate = [
      obj.startDate, obj.start_date, obj.start_at, obj.startsAt, obj.startTime, obj.dateTime,
    ].find(v => typeof v === 'string') as string | undefined;

    if (title && rawDate) {
      const startDateTime = new Date(rawDate);
      if (!Number.isNaN(startDateTime.getTime())) {
        const href = [obj.url, obj.link, obj.permalink].find(v => typeof v === 'string') as
          | string
          | undefined;
        events.push({
          title: title.trim(),
          description: typeof obj.description === 'string' ? obj.description : title.trim(),
          sourceUrl: absoluteUrl(href, url) || url,
          source,
          startDateTime,
          rawFormat: 'offline',
        });
      }
    }

    for (const value of Object.values(obj)) {
      if (value && typeof value === 'object') stack.push(value);
    }
  }

  return events;
}

/** Extract `<link>` hrefs from an RSS/Atom document. */
function rssItemLinks(xml: string, baseUrl: string): string[] {
  const links: string[] = [];
  for (const m of xml.matchAll(/<link[^>]*>([^<]+)<\/link>/gi)) {
    const href = absoluteUrl(m[1].trim(), baseUrl);
    if (href) links.push(href);
  }
  for (const m of xml.matchAll(/<link[^>]+href=["']([^"']+)["']/gi)) {
    const href = absoluteUrl(m[1].trim(), baseUrl);
    if (href) links.push(href);
  }
  // Drop the feed's own self-link and duplicates.
  return [...new Set(links)].filter(href => href !== baseUrl).slice(0, 40);
}

/** Discover an RSS/Atom feed advertised by a page. */
function findRssLink(html: string, baseUrl: string): string | undefined {
  const match =
    html.match(/<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*href=["']([^"']+)["']/i) ||
    html.match(/<link[^>]+href=["']([^"']+)["'][^>]*type=["']application\/(?:rss|atom)\+xml["']/i);
  return match ? absoluteUrl(match[1], baseUrl) : undefined;
}

/**
 * Extract every event we can find at `url`.
 *
 * Never throws for content reasons — a page with no events yields an empty list
 * with the reason recorded in `errors`, which is what the source-health tracking
 * needs to distinguish "broken" from "nothing on right now".
 */
export async function scrapeUrlUniversal(
  url: string,
  opts: UniversalOptions = {}
): Promise<ScrapeResult> {
  const startedAt = new Date();
  const source = opts.source || 'company';
  const geoPolicy = opts.geoPolicy || 'require';
  const result: ScrapeResult = {
    sourceId: `universal:${url}`,
    label: opts.organizer || url.replace(/^https?:\/\//, '').replace(/\/$/, ''),
    events: [],
    errors: [],
    startedAt,
    durationMs: 0,
  };

  const collected: RawEvent[] = [];
  let html = '';

  try {
    html = await fetchText(url, { timeoutMs: 25000, retries: 2 });
  } catch (err) {
    result.errors.push(`fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    result.durationMs = Date.now() - startedAt.getTime();
    return result;
  }

  // ── 1. JSON-LD ────────────────────────────────────────────────────────────
  collected.push(...rawEventsFromHtml(html, { baseUrl: url, source }));

  // ── 2. ICS feed ───────────────────────────────────────────────────────────
  if (collected.length === 0) {
    const advertised = findIcsLink(html, url);
    const candidates = advertised
      ? [advertised]
      : ICS_GUESSES.map(path => absoluteUrl(path, url)).filter((u): u is string => Boolean(u));

    for (const icsUrl of candidates) {
      try {
        const ics = await fetchText(icsUrl, { timeoutMs: 20000, retries: 1 });
        if (!ics.includes('BEGIN:VEVENT')) continue;
        collected.push(
          ...rawEventsFromIcs(ics, { source, fallbackUrl: url, organizer: opts.organizer })
        );
        if (collected.length > 0) break;
      } catch {
        // A guessed path that 404s is expected; keep trying.
      }
    }
  }

  // ── 3. RSS → per-item JSON-LD ─────────────────────────────────────────────
  const followBudget = opts.followRssItems ?? 0;
  if (collected.length === 0 && followBudget > 0) {
    const feedUrl = findRssLink(html, url);
    if (feedUrl) {
      try {
        const xml = await fetchText(feedUrl, { timeoutMs: 20000, retries: 1 });
        const links = rssItemLinks(xml, feedUrl).slice(0, followBudget);
        const pages = await mapPool(links, 4, link =>
          fetchText(link, { timeoutMs: 15000, retries: 1 }).then(itemHtml => ({ link, itemHtml }))
        );
        for (const page of pages) {
          if (!page) continue;
          collected.push(...rawEventsFromHtml(page.itemHtml, { baseUrl: page.link, source }));
        }
      } catch (err) {
        result.errors.push(`rss: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ── 4. Embedded Next.js payload ───────────────────────────────────────────
  if (collected.length === 0) {
    collected.push(...eventsFromNextData(html, url, source));
  }

  if (collected.length === 0) {
    result.errors.push('no structured event data found (no JSON-LD, ICS, RSS or embedded JSON)');
  }

  // ── Filter: upcoming, in Bengaluru, deduped ───────────────────────────────
  const now = Date.now();
  const byUrl = new Map<string, RawEvent>();

  for (const event of collected) {
    const effectiveEnd = (event.endDateTime ?? event.startDateTime).getTime();
    if (effectiveEnd < now) continue;

    if (opts.organizer && !event.organizer) event.organizer = opts.organizer;

    const verdict = isBengaluru({
      venue: event.venue,
      address: event.address,
      city: event.city,
      lat: event.lat,
      lng: event.lng,
      text: event.description,
    });
    const isOnline = event.rawFormat === 'online';
    if (verdict === false) continue;
    if (verdict === null && geoPolicy === 'require' && !isOnline) continue;

    if (!byUrl.has(event.sourceUrl)) byUrl.set(event.sourceUrl, event);
  }

  result.events = [...byUrl.values()];
  result.durationMs = Date.now() - startedAt.getTime();
  return result;
}

/**
 * Company / community event pages checked into the registry.
 *
 * Only pages recon showed actually publish structured data are listed with
 * confidence; the rest are included because they cost one request and will start
 * working the moment the site adds schema.org markup (many do, seasonally).
 * A page that yields nothing is reported as an unhealthy source rather than
 * silently ignored, so this list stays honest over time.
 */
export const COMPANY_EVENT_PAGES: Array<{ url: string; organizer: string }> = [
  { url: 'https://www.postman.com/events/', organizer: 'Postman' },
  { url: 'https://hasgeek.com/', organizer: 'Hasgeek' },
  { url: 'https://aws.amazon.com/events/', organizer: 'AWS' },
  { url: 'https://developers.google.com/events', organizer: 'Google Developers' },
  { url: 'https://cloud.google.com/events', organizer: 'Google Cloud' },
  { url: 'https://www.redhat.com/en/events', organizer: 'Red Hat' },
  { url: 'https://events.gitlab.com/', organizer: 'GitLab' },
  { url: 'https://www.docker.com/events/', organizer: 'Docker' },
  { url: 'https://www.databricks.com/events', organizer: 'Databricks' },
  { url: 'https://www.confluent.io/events/', organizer: 'Confluent' },
  { url: 'https://www.mongodb.com/events', organizer: 'MongoDB' },
  { url: 'https://www.nvidia.com/en-in/events/', organizer: 'NVIDIA' },
  { url: 'https://www.atlassian.com/company/events', organizer: 'Atlassian' },
  { url: 'https://github.com/events', organizer: 'GitHub' },
  { url: 'https://www.elastic.co/events/', organizer: 'Elastic' },
  { url: 'https://developer.microsoft.com/en-us/reactor/', organizer: 'Microsoft Reactor' },
  { url: 'https://razorpay.com/events/', organizer: 'Razorpay' },
  { url: 'https://www.zoho.com/events/', organizer: 'Zoho' },
  { url: 'https://www.freshworks.com/events/', organizer: 'Freshworks' },
  { url: 'https://www.swiggy.com/careers/events', organizer: 'Swiggy' },
];
