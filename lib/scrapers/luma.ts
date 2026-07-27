import { RawEvent, ScraperResult } from './types';
import { fetchHtml, extractNextData } from './util';

/**
 * Scrape events from a Luma city calendar page.
 *
 * WHY NO BROWSER / NO DOM SELECTORS:
 * The previous implementation drove headless Chromium and read guessed CSS
 * selectors off the rendered page. That was brittle (selectors broke silently)
 * AND aimed at dead URLs: the old `lu.ma/<slug>` calendars 404 after the
 * lu.ma → luma.com migration, so the scraper returned nothing.
 *
 * Luma is a Next.js app that embeds its FULL calendar state as JSON in the
 * `__NEXT_DATA__` script tag. Each event object carries machine-readable fields
 * (verified live against luma.com/bengaluru):
 *   - name           event title
 *   - start_at       ISO-8601 UTC, e.g. "2026-07-27T11:30:00.000Z"
 *   - end_at         ISO-8601 UTC (optional)
 *   - url            event slug → full URL https://luma.com/<slug>
 *   - api_id         stable id "evt-..." (used for dedup within the page)
 *   - location_type  "offline" | "online"
 *   - geo_address_info { city_state, city, sublocality, region, ... }
 *
 * So we fetch the calendar HTML with a browser UA, parse `__NEXT_DATA__`, and
 * walk it for event objects. No Playwright, no selectors, real dates.
 */

interface LumaGeo {
  city_state?: string;
  city?: string;
  sublocality?: string;
  region?: string;
}

interface LumaEvent {
  api_id?: string;
  name?: string;
  start_at?: string;
  end_at?: string;
  url?: string;
  location_type?: string;
  geo_address_info?: LumaGeo;
}

/** A Luma event node: an object with a start time and at least a name or slug. */
function isLumaEvent(node: unknown): node is LumaEvent {
  if (!node || typeof node !== 'object') return false;
  const obj = node as Record<string, unknown>;
  if (typeof obj.start_at !== 'string') return false;
  return typeof obj.name === 'string' || typeof obj.url === 'string';
}

/**
 * Recursively collect every Luma event object nested anywhere in the parsed
 * __NEXT_DATA__ tree, de-duplicated by api_id (falling back to url/name).
 * Luma nests events under several keys depending on the view, so a structural
 * walk is more robust than reaching for a specific path that may move.
 */
function collectLumaEvents(root: unknown): LumaEvent[] {
  const found = new Map<string, LumaEvent>();
  const stack: unknown[] = [root];

  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;

    if (isLumaEvent(node)) {
      const key = node.api_id || node.url || node.name || '';
      if (key && !found.has(key)) found.set(key, node);
      // An event object can still contain nested objects; keep walking its values.
    }

    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
    } else {
      for (const value of Object.values(node as Record<string, unknown>)) {
        if (value && typeof value === 'object') stack.push(value);
      }
    }
  }

  return [...found.values()];
}

/** Build a venue string from Luma's geo info; undefined when nothing usable. */
function geoToVenue(geo: LumaGeo | undefined): string | undefined {
  if (!geo) return undefined;
  const parts = [geo.sublocality, geo.city].filter(Boolean) as string[];
  if (parts.length > 0) return parts.join(', ');
  return geo.city_state || geo.region || undefined;
}

export async function scrapeLumaCalendar(calendarUrl: string): Promise<ScraperResult> {
  const result: ScraperResult = {
    source: 'luma',
    events: [],
    errors: [],
    scrapedAt: new Date(),
  };

  try {
    console.log(`Scraping Luma calendar: ${calendarUrl}`);
    const html = await fetchHtml(calendarUrl);
    const nextData = extractNextData(html);
    if (!nextData) {
      result.errors.push('No __NEXT_DATA__ found on Luma page');
      return result;
    }

    const events = collectLumaEvents(nextData);
    if (events.length === 0) {
      // Calendar rendered but had no events — informational, not fatal.
      result.errors.push('No event objects found in Luma __NEXT_DATA__');
      return result;
    }

    const now = Date.now();

    for (const event of events) {
      const startRaw = event.start_at;
      const title = event.name;
      if (!startRaw || !title) continue;

      const startDateTime = new Date(startRaw);
      if (isNaN(startDateTime.getTime())) continue;

      const endDateTime = event.end_at ? new Date(event.end_at) : undefined;
      const effectiveEnd = endDateTime && !isNaN(endDateTime.getTime())
        ? endDateTime.getTime()
        : startDateTime.getTime();
      if (effectiveEnd < now) continue; // upcoming-only

      const isOnline = (event.location_type || '').toLowerCase() === 'online';
      const slug = event.url || '';
      const sourceUrl = slug
        ? (slug.startsWith('http') ? slug : `https://luma.com/${slug}`)
        : calendarUrl;
      const venue = geoToVenue(event.geo_address_info);

      result.events.push({
        title,
        description: title,
        sourceUrl,
        organizer: 'Luma',
        venue: isOnline ? undefined : venue || 'Bangalore',
        onlineLink: isOnline ? sourceUrl : undefined,
        startDateTime,
        endDateTime: endDateTime && !isNaN(endDateTime.getTime()) ? endDateTime : undefined,
      } satisfies RawEvent);
    }

    console.log(`Scraped ${result.events.length} upcoming events from ${calendarUrl}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    result.errors.push(`Failed to scrape Luma calendar: ${msg}`);
    console.error(`Luma scraper error:`, error);
  }

  return result;
}

/**
 * Scrape multiple Luma calendars.
 */
export async function scrapeLumaCalendars(calendarUrls: string[]): Promise<ScraperResult> {
  const combinedResult: ScraperResult = {
    source: 'luma',
    events: [],
    errors: [],
    scrapedAt: new Date(),
  };

  for (const url of calendarUrls) {
    const result = await scrapeLumaCalendar(url);
    combinedResult.events.push(...result.events);
    combinedResult.errors.push(...result.errors);
    // Rate limiting - wait 2 seconds between requests
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  return combinedResult;
}

// Bengaluru Luma city calendars.
// luma.com/bengaluru is Luma's official Bengaluru city page — verified live to
// return ~20-40 upcoming offline events with real dates. `blr` is an alias that
// redirects there (fetchHtml follows redirects), kept as a resilience fallback.
export const BANGALORE_LUMA_CALENDARS = [
  'https://luma.com/bengaluru',
  'https://luma.com/blr',
];

// Made with Bob
