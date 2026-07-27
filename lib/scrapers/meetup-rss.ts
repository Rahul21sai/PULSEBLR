import Parser from 'rss-parser';
import { RawEvent, ScraperResult } from './types';
import { fetchHtml, extractJsonLdBlocks } from './util';

const parser = new Parser();

/**
 * Scrape events from a Meetup group's RSS feed.
 *
 * Meetup RSS feed URL format: https://www.meetup.com/{group-name}/events/rss/
 *
 * WHY THIS IS A TWO-STEP SCRAPE (RSS → event page):
 * Meetup's RSS `<item>` does NOT carry the event's start date. `<pubDate>` is the
 * publish date of the listing, and the description has no reliable date. Using
 * `pubDate` as the event date (the previous behaviour) stamped every event with a
 * past date, so the upcoming-only UI hid them all — that was the root cause of
 * "I only see the seeded events, not the scraped ones."
 *
 * The real, structured event date lives on the event PAGE (`<item><link>`), inside
 * a JSON-LD `Event` block (verified live: `"startDate":"2026-09-06T10:30:00+05:30"`
 * with `endDate` and `location`). So we use RSS only to ENUMERATE event URLs, then
 * fetch each page for its authoritative date/venue. Events with no parseable date,
 * or whose date is in the past, are dropped — never back-filled with a fake date.
 *
 * A group with no upcoming events returns HTTP 200 with an empty <channel> — that's
 * normal, not an error. A 404 means the slug is wrong/renamed and must be fixed.
 */

interface JsonLdAddress {
  streetAddress?: string;
  addressLocality?: string;
  addressRegion?: string;
}

interface JsonLdLocation {
  name?: string;
  address?: string | JsonLdAddress;
}

interface JsonLdEvent {
  '@type'?: string | string[];
  name?: string;
  description?: string;
  startDate?: string;
  endDate?: string;
  eventAttendanceMode?: string;
  location?: JsonLdLocation | JsonLdLocation[];
}

/** True for a JSON-LD node whose @type is (or includes) an Event type. */
function isEventNode(node: unknown): node is JsonLdEvent {
  if (!node || typeof node !== 'object') return false;
  const type = (node as { '@type'?: unknown })['@type'];
  if (Array.isArray(type)) {
    return type.some(t => typeof t === 'string' && t.includes('Event'));
  }
  return typeof type === 'string' && type.includes('Event');
}

/** Locate the first JSON-LD Event node across all blocks (handles arrays + @graph). */
function findEventNode(blocks: unknown[]): JsonLdEvent | null {
  for (const block of blocks) {
    const candidates: unknown[] = Array.isArray(block) ? block : [block];
    for (const candidate of candidates) {
      if (isEventNode(candidate)) return candidate;
      const graph = (candidate as { '@graph'?: unknown })?.['@graph'];
      if (Array.isArray(graph)) {
        const event = graph.find(isEventNode);
        if (event) return event as JsonLdEvent;
      }
    }
  }
  return null;
}

/** Build a human-readable venue string from a JSON-LD location. */
function locationToVenue(
  location: JsonLdLocation | JsonLdLocation[] | undefined
): string | undefined {
  if (!location) return undefined;
  const first = Array.isArray(location) ? location[0] : location;
  if (!first) return undefined;

  const parts: string[] = [];
  if (first.name) parts.push(first.name);
  const address = first.address;
  if (typeof address === 'string') {
    parts.push(address);
  } else if (address) {
    if (address.streetAddress) parts.push(address.streetAddress);
    if (address.addressLocality) parts.push(address.addressLocality);
  }
  // Meetup often repeats the same token across name/street/locality for
  // placeholder venues (e.g. "To Be Announced, Bangalore, Bangalore, Bangalore").
  // De-duplicate case-insensitively while preserving order.
  const seen = new Set<string>();
  const deduped = parts
    .map(p => p.trim())
    .filter(p => {
      if (!p) return false;
      const key = p.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const venue = deduped.join(', ').trim();
  return venue || undefined;
}

/** Fallback: pull a startDate straight out of Meetup's __NEXT_DATA__ if JSON-LD is absent. */
function nextDataStartDate(html: string): string | undefined {
  const m = html.match(/"(?:startDate|dateTime)"\s*:\s*"([^"]+)"/);
  return m?.[1];
}

export async function scrapeMeetupRSS(feedUrl: string): Promise<ScraperResult> {
  const result: ScraperResult = {
    source: 'meetup',
    events: [],
    errors: [],
    scrapedAt: new Date(),
  };

  try {
    console.log(`Fetching Meetup RSS feed: ${feedUrl}`);
    // Fetch with a browser UA (rss-parser's default UA can be bot-blocked), then
    // parse the XML string.
    const xml = await fetchHtml(feedUrl);
    const feed = await parser.parseString(xml);

    if (!feed.items || feed.items.length === 0) {
      // Empty channel = group has no upcoming events. Not an error.
      return result;
    }

    const now = Date.now();

    for (const item of feed.items) {
      const title = item.title || 'Untitled Event';
      const eventUrl = item.link;
      if (!eventUrl) {
        result.errors.push(`Event "${title}" has no link — skipped`);
        continue;
      }

      try {
        // Fetch the event page for its authoritative structured date/venue.
        const html = await fetchHtml(eventUrl);
        const event = findEventNode(extractJsonLdBlocks(html));

        const startRaw = event?.startDate || nextDataStartDate(html);
        if (!startRaw) {
          // No reliable date anywhere — skip rather than invent one.
          result.errors.push(`No structured date for "${title}" — skipped`);
          continue;
        }

        const startDateTime = new Date(startRaw);
        const endDateTime = event?.endDate ? new Date(event.endDate) : undefined;
        if (isNaN(startDateTime.getTime())) {
          result.errors.push(`Unparseable date for "${title}" — skipped`);
          continue;
        }

        // Upcoming-only: drop events already finished. Use end time when known so
        // an all-day / multi-hour event still in progress isn't dropped mid-event.
        const effectiveEnd = endDateTime && !isNaN(endDateTime.getTime())
          ? endDateTime.getTime()
          : startDateTime.getTime();
        if (effectiveEnd < now) continue;

        const isOnline =
          (event?.eventAttendanceMode || '').includes('Online');
        const venue = locationToVenue(event?.location);
        const description =
          event?.description || item.contentSnippet || item.content || title;

        result.events.push({
          title: event?.name || title,
          description,
          sourceUrl: eventUrl,
          organizer: feed.title || 'Meetup Group',
          venue: isOnline ? undefined : venue || 'Bangalore',
          onlineLink: isOnline ? eventUrl : undefined,
          startDateTime,
          endDateTime: endDateTime && !isNaN(endDateTime.getTime()) ? endDateTime : undefined,
        } satisfies RawEvent);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        result.errors.push(`Failed to parse event "${title}": ${msg}`);
      }

      // Be polite between event-page fetches.
      await new Promise(resolve => setTimeout(resolve, 400));
    }

    console.log(`Scraped ${result.events.length} upcoming events from ${feedUrl}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    result.errors.push(`Failed to fetch RSS feed: ${msg}`);
    console.error(`Meetup RSS scraper error:`, error);
  }

  return result;
}

/**
 * Scrape multiple Meetup groups.
 */
export async function scrapeMeetupGroups(groupUrls: string[]): Promise<ScraperResult> {
  const combinedResult: ScraperResult = {
    source: 'meetup',
    events: [],
    errors: [],
    scrapedAt: new Date(),
  };

  for (const url of groupUrls) {
    const result = await scrapeMeetupRSS(url);
    combinedResult.events.push(...result.events);
    combinedResult.errors.push(...result.errors);
  }

  return combinedResult;
}

// Default Bangalore tech Meetup groups.
// Every slug below was verified HTTP 200 with a valid RSS feed. A group that
// currently has no upcoming events still returns 200 with an empty channel —
// that is expected and harmless; it will surface events once the group posts them.
export const BANGALORE_MEETUP_GROUPS = [
  // — Original set —
  'https://www.meetup.com/awsugblr/events/rss/',                  // AWS User Group
  'https://www.meetup.com/bangpypers/events/rss/',               // Python User Group
  'https://www.meetup.com/PyData-Bangalore/events/rss/',         // PyData (AI/ML)
  'https://www.meetup.com/Women-Who-Code-Bangalore/events/rss/', // Women Who Code
  'https://www.meetup.com/Bangalore-Java-User-Group/events/rss/', // Java User Group

  // — Tier-1 additions —
  'https://www.meetup.com/owasp-bangalore-chapter/events/rss/',  // OWASP (Cybersecurity)
  'https://www.meetup.com/data-science-bangalore/events/rss/',   // Data Science (AI/ML)
  'https://www.meetup.com/the-fifth-elephant/events/rss/',       // Big Data / AI/ML
  'https://www.meetup.com/DataKind-Bangalore/events/rss/',       // Data-for-good (AI/ML)
  'https://www.meetup.com/reactjs-bangalore/events/rss/',        // Web
  'https://www.meetup.com/cloudops-meetup-bangalore/events/rss/', // Cloud & DevOps
  'https://www.meetup.com/golang-bangalore/events/rss/',         // Dev (Go)
  'https://www.meetup.com/flutter-bangalore/events/rss/',        // Mobile
  'https://www.meetup.com/reactplay-bengaluru/events/rss/',      // Web
  'https://www.meetup.com/techinsider-bangalore/events/rss/',    // Web/Cloud/DevOps

  // — Verified live 2026-07-27 (currently no upcoming events, kept for coverage) —
  'https://www.meetup.com/GenAI-Bangalore/events/rss/',          // GenAI (AI/ML — on-priority)
  'https://www.meetup.com/GDG-Bangalore/events/rss/',            // Google Dev Group (AI/dev)
];

// Made with Bob
