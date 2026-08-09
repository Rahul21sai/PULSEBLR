// Meetup adapter.
//
// ARCHITECTURE (verified live, scripts/probe-round2.ts + round3.ts):
//
//   1. CITY FIND PAGES publish JSON-LD Event nodes. `?page=N` is a no-op (pages
//      1/2/3 returned byte-identical payloads), but DIFFERENT KEYWORDS return
//      different event sets — "technology" 30, "ai" 32, "business" 20, "music" 13.
//      So breadth comes from a keyword fan-out, not pagination.
//
//   2. GROUP DISCOVERY. Those same find pages contain event URLs of the form
//      meetup.com/<group-slug>/events/<id>, so we harvest group slugs from them.
//      Recon: 10 keywords → 58 distinct Bengaluru groups. Discovered groups are
//      persisted, so coverage compounds across runs.
//
//   3. PER-GROUP ICS. `meetup.com/<group>/events/ical/` returns every upcoming
//      event with DTSTART/DTEND/SUMMARY/URL in ONE request. The previous
//      implementation fetched the RSS feed and then EVERY event page just to read
//      a date (N+1 requests with a 400 ms delay each) — ICS makes scanning ~100
//      groups practical.
//
//      MEASURED LIMITATION: Meetup's ICS emits NO LOCATION property — verified
//      across bangpypers, reactjs-bangalore, awsugblr, bangalore-ai-tech-talks and
//      ai-professionals-blr, all of which returned zero LOCATION lines. So ICS
//      cannot supply venue, and geo-filtering ICS output is impossible. That is
//      what `enrichMeetupEvents` is for: it fetches event pages under a budget to
//      fill venue/image/description, after which the pipeline can geo-gate for
//      real. Events that don't win the budget are still kept — they were found via
//      a Bengaluru-scoped search, so the city is already evidence.

import { RawEvent, ScrapeResult } from '../core/types';
import { fetchText, mapPool } from '../core/http';
import { rawEventsFromHtml } from '../core/jsonld';
import { rawEventsFromIcs } from '../core/ics';
import { isBengaluru } from '../core/geo';

const MEETUP_SOURCE = 'meetup';

/**
 * Keywords fanned out across Meetup's city search.
 *
 * Chosen to span the whole event landscape, not just tech: the goal is every
 * Bengaluru event. Each keyword costs one request and yields a different slice,
 * and duplicates collapse at ingest, so breadth is cheap.
 */
export const MEETUP_KEYWORDS = [
  // tech core
  'technology', 'ai', 'machine learning', 'data', 'cloud', 'devops', 'security',
  'web development', 'mobile', 'python', 'javascript', 'java', 'golang', 'rust',
  'blockchain', 'web3', 'robotics', 'iot', 'open source', 'kubernetes', 'llm',
  // product / business / career
  'startup', 'product', 'design', 'ux', 'career', 'business', 'marketing',
  'entrepreneur', 'freelance', 'investing', 'finance',
  // community / lifestyle (still real Bengaluru events)
  'networking', 'workshop', 'hackathon', 'meetup', 'music', 'photography',
  'writing', 'book club', 'language', 'fitness', 'running', 'hiking', 'board games',
];

function findUrl(keyword: string): string {
  const params = new URLSearchParams({
    keywords: keyword,
    location: 'in--Bengaluru',
    source: 'EVENTS',
    sortField: 'DATETIME',
  });
  return `https://www.meetup.com/find/?${params.toString()}`;
}

/** Harvest `<group-slug>` from every meetup.com event URL present in a page. */
function harvestGroupSlugs(html: string): string[] {
  const slugs = new Set<string>();
  // Matches both plain and JSON-escaped (\/) forms found in __NEXT_DATA__.
  const re = /meetup\.com\\?\/([a-zA-Z0-9][a-zA-Z0-9-]{2,60})\\?\/events\\?\/(\d{6,})/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const slug = match[1].toLowerCase();
    // Meetup's own reserved paths are not groups.
    if (['find', 'topics', 'cities', 'members', 'help', 'blog', 'home'].includes(slug)) continue;
    slugs.add(slug);
  }
  return [...slugs];
}

/**
 * Scrape Meetup's Bengaluru city search across every keyword.
 * Returns the events found plus the group slugs discovered along the way.
 */
export async function scrapeMeetupCity(concurrency = 4): Promise<ScrapeResult> {
  const startedAt = new Date();
  const result: ScrapeResult = {
    sourceId: 'meetup-city',
    label: 'Meetup — Bengaluru search',
    events: [],
    errors: [],
    discovered: [],
    startedAt,
    durationMs: 0,
  };

  const groups = new Set<string>();
  const byUrl = new Map<string, RawEvent>();

  await mapPool(MEETUP_KEYWORDS, concurrency, async keyword => {
    const url = findUrl(keyword);
    try {
      const html = await fetchText(url, { timeoutMs: 25000, retries: 2 });
      for (const slug of harvestGroupSlugs(html)) groups.add(slug);

      for (const event of rawEventsFromHtml(html, { baseUrl: url, source: MEETUP_SOURCE })) {
        // Keyword fan-out returns heavy overlap; collapse on canonical URL here so
        // downstream stages see each event once.
        if (!byUrl.has(event.sourceUrl)) {
          event.tags = [...(event.tags || []), `kw:${keyword}`];
          byUrl.set(event.sourceUrl, event);
        }
      }
    } catch (err) {
      result.errors.push(`keyword "${keyword}": ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  });

  result.events = [...byUrl.values()];
  result.discovered = [...groups].map(slug => ({
    kind: 'meetup-group',
    handle: slug,
    label: slug.replace(/-/g, ' '),
  }));

  result.durationMs = Date.now() - startedAt.getTime();
  return result;
}

/** Scrape one Meetup group's ICS feed. */
export async function scrapeMeetupGroup(slug: string): Promise<ScrapeResult> {
  const startedAt = new Date();
  const groupUrl = `https://www.meetup.com/${slug}/`;
  const result: ScrapeResult = {
    sourceId: `meetup-group:${slug}`,
    label: `Meetup — ${slug}`,
    events: [],
    errors: [],
    startedAt,
    durationMs: 0,
  };

  try {
    const ics = await fetchText(`https://www.meetup.com/${slug}/events/ical/`, {
      timeoutMs: 20000,
      retries: 2,
    });
    const events = rawEventsFromIcs(ics, {
      source: MEETUP_SOURCE,
      fallbackUrl: groupUrl,
      organizer: slug.replace(/-/g, ' '),
    });

    for (const event of events) {
      // ICS gives no venue (see header note), so the only geo signal available
      // here is the description. Reject an event that positively names another
      // city; keep everything else for the enrichment + geo pass downstream.
      if (isBengaluru({ text: event.description }) === false) continue;
      result.events.push(event);
    }
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
  }

  result.durationMs = Date.now() - startedAt.getTime();
  return result;
}

/** Scrape many Meetup groups concurrently, merging into one result. */
export async function scrapeMeetupGroups(
  slugs: string[],
  concurrency = 6
): Promise<ScrapeResult> {
  const startedAt = new Date();
  const result: ScrapeResult = {
    sourceId: 'meetup-groups',
    label: `Meetup — ${slugs.length} groups`,
    events: [],
    errors: [],
    startedAt,
    durationMs: 0,
  };

  const results = await mapPool(slugs, concurrency, slug => scrapeMeetupGroup(slug));
  for (const one of results) {
    if (!one) continue;
    result.events.push(...one.events);
    // Prefix errors with the group so a dead slug is identifiable in the report.
    result.errors.push(...one.errors.map(e => `${one.sourceId}: ${e}`));
  }

  result.durationMs = Date.now() - startedAt.getTime();
  return result;
}

/**
 * Fill in venue / image / description / attendee count for Meetup events that
 * came from ICS (which supplies none of those) by reading the event page's
 * JSON-LD.
 *
 * `budget` bounds the run. Events are enriched soonest-first so the ones users
 * actually see in the feed always win. Anything not enriched keeps its ICS data
 * and still ingests — enrichment upgrades events, it never gates them.
 */
export async function enrichMeetupEvents(
  events: RawEvent[],
  budget: number,
  concurrency = 8
): Promise<number> {
  const candidates = events
    .filter(e => e.source === MEETUP_SOURCE && !e.venue && !e.imageUrl)
    .sort((a, b) => a.startDateTime.getTime() - b.startDateTime.getTime())
    .slice(0, budget);

  let enriched = 0;
  await mapPool(candidates, concurrency, async event => {
    try {
      const html = await fetchText(event.sourceUrl, { timeoutMs: 15000, retries: 1 });
      const [parsed] = rawEventsFromHtml(html, {
        baseUrl: event.sourceUrl,
        source: MEETUP_SOURCE,
      });

      let changed = false;
      if (parsed) {
        // Only fill gaps — never overwrite a value the ICS/feed already gave us.
        if (!event.venue && parsed.venue) { event.venue = parsed.venue; changed = true; }
        if (!event.address && parsed.address) { event.address = parsed.address; changed = true; }
        if (!event.city && parsed.city) { event.city = parsed.city; changed = true; }
        if (event.lat === undefined && parsed.lat !== undefined) { event.lat = parsed.lat; changed = true; }
        if (event.lng === undefined && parsed.lng !== undefined) { event.lng = parsed.lng; changed = true; }
        if (!event.imageUrl && parsed.imageUrl) { event.imageUrl = parsed.imageUrl; changed = true; }
        if (parsed.description.length > event.description.length) {
          event.description = parsed.description;
          changed = true;
        }
        if (parsed.rawFormat) event.rawFormat = parsed.rawFormat;
      }

      // Meetup's og:image is the event cover and is present even when JSON-LD
      // omits `image`, so it's a worthwhile second try.
      if (!event.imageUrl) {
        const og = html.match(
          /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i
        );
        if (og) { event.imageUrl = og[1]; changed = true; }
      }

      // "N attendees" / "going" counts are the social proof the feed shows.
      const going = html.match(/"goingCount"\s*:\s*(\d+)/) || html.match(/(\d+)\s+attendees/i);
      if (going) {
        const count = Number(going[1]);
        if (Number.isFinite(count) && count > 0) { event.attendeeCount = count; changed = true; }
      }

      if (changed) enriched++;
    } catch {
      // Best-effort by design.
    }
    return null;
  });

  return enriched;
}

/**
 * Seed groups verified live. Discovery adds to this over time, but seeding means
 * a fresh database gets good coverage on its very first run.
 */
export const SEED_MEETUP_GROUPS = [
  // Community user groups
  'awsugblr', 'bangpypers', 'pydata-bangalore', 'women-who-code-bangalore',
  'bangalore-java-user-group', 'owasp-bangalore-chapter', 'data-science-bangalore',
  'the-fifth-elephant', 'datakind-bangalore', 'reactjs-bangalore',
  'cloudops-meetup-bangalore', 'golang-bangalore', 'flutter-bangalore',
  'reactplay-bengaluru', 'techinsider-bangalore', 'genai-bangalore', 'gdg-bangalore',
  'microsoft-reactor-bengaluru', 'producttank-bangalore', 'platform-engineers-bangalore',
  'bengaluruwordpress', 'ksug-in', 'futureofdata-bangalore', 'ai-professionals-blr',

  // Company/vendor-run Bengaluru communities, each verified to return HTTP 200 on
  // its ICS feed (scripts/probe-company-handles.mjs). This is the route to company
  // events that actually works: recon showed most company MARKETING pages publish
  // no structured event data at all, while the communities they run on Meetup do.
  'bangalore-mongodb-user-group', 'docker-bangalore', 'grafana-and-friends-bengaluru',
  'bangalore-kubernetes-meetup', 'microsoft-azure-bangalore', 'servicenow-bangalore',
  'thoughtworks-bangalore',
];
