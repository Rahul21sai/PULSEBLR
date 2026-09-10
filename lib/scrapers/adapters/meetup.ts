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
//   3. PER-GROUP ICS. `meetup.com/<group>/events/ical/` returns up to TEN upcoming
//      events with DTSTART/DTEND/SUMMARY/URL in ONE request. The previous
//      implementation fetched the RSS feed and then EVERY event page just to read
//      a date (N+1 requests with a 400 ms delay each) — ICS makes scanning ~100
//      groups practical.
//
//      ** THIS PARAGRAPH USED TO SAY "returns EVERY upcoming event". IT DOES NOT, AND
//      THAT ONE WORD COST ~550 EVENTS. ** Measured 2026-09-07 across all 261 stored
//      groups: `lastEventCount` was 0 for 99 of them, exactly 10 for 74, and ABOVE 10
//      for none. Seventy-four groups on the same number and nothing past it is a wall,
//      not a distribution. Three feeds were then fetched directly and each returned
//      exactly 10 VEVENTs. The cap is Meetup's, not ours — the adapter was correct and
//      its comment was wrong, which is why nobody went looking for a ceiling for months.
//      See `scrapeMeetupGroupPage` for the second pass that recovers the rest, and
//      `scripts/diag-meetup-cap.ts` to re-measure.
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
import { rawEventsFromHtml, extractNextData } from '../core/jsonld';
import { rawEventsFromIcs } from '../core/ics';
import { isBengaluru } from '../core/geo';
import { stripHtml, truncate } from '../core/text';
import { COMPANIES } from '../../companies/registry';

const MEETUP_SOURCE = 'meetup';

/**
 * How many upcoming events `/<group>/events/ical/` will ever return.
 *
 * Upstream, undocumented, and the reason `scrapeMeetupGroupPage` exists. A group whose ICS
 * returns this number (or more, should Meetup ever raise it) is *suspected truncated* — it might
 * genuinely have exactly ten, so this is a signal to go and look, never a conclusion.
 */
export const MEETUP_ICS_CAP = 10;

/**
 * Keywords fanned out across Meetup's city search.
 *
 * Chosen to span the whole event landscape, not just tech: the goal is every
 * Bengaluru event. Each keyword costs one request and yields a different slice,
 * and duplicates collapse at ingest, so breadth is cheap.
 */
export const MEETUP_KEYWORDS = [
  // ── Software core ──
  'technology', 'ai', 'machine learning', 'data', 'cloud', 'devops', 'security',
  'web development', 'mobile', 'python', 'javascript', 'java', 'golang', 'rust',
  'blockchain', 'web3', 'kubernetes', 'llm', 'backend', 'frontend', 'sre',
  'platform engineering', 'observability', 'api', 'database', 'postgres',

  // ── Open source ──
  // The product explicitly wants open-source events. Guessing group SLUGS does not
  // work — 0 of 35 candidate open-source slugs existed — but keyword search DOES
  // surface these groups, and each new keyword also harvests more group slugs which
  // are then persisted. So breadth here is the mechanism, not a hand-kept list.
  'open source', 'linux', 'foss', 'apache', 'kafka', 'cncf', 'docker',
  'git', 'contributor', 'hacktoberfest',

  // ── Hardware ──
  // "software and hardware" is the stated focus, and hardware is the thinnest slice of
  // the corpus by a wide margin.
  //
  // Note what was MISSING from this list until 2026-08-23: the word `hardware` itself,
  // plus `maker`/`makerspace`, `deeptech` and `space tech`. Two hardware communities —
  // "The Hardware Club Bangalore - Robotics & Physical AI" and "Space Tech Meetup -
  // Bengaluru" — were reaching the corpus only incidentally, via some other keyword's
  // relevance spill. Searching for the obvious word is not optional.
  //
  // Keyword search is the discovery mechanism that WORKS here: probing 35 guessed
  // open-source group slugs returned 0 hits, while keywords both surface events and
  // harvest real group slugs, which are then persisted and scraped directly forever.
  // Each keyword costs one request.
  'hardware', 'robotics', 'iot', 'embedded', 'firmware', 'fpga', 'vlsi', 'semiconductor',
  'chip design', 'electronics', 'drone', 'arduino', 'raspberry pi',
  'maker', 'makerspace', 'mechatronics', 'pcb', 'microcontroller', 'risc-v',
  '3d printing', 'deeptech', 'space tech', 'satellite', 'automotive', 'electric vehicle',
  'signal processing', 'sensors',

  // ── Product / business / career ──
  'startup', 'product', 'design', 'ux', 'career', 'business', 'marketing',
  'entrepreneur', 'freelance', 'investing', 'finance',

  // ── Community / lifestyle (still real Bengaluru events, shown when
  //    "show all events" is on) ──
  'networking', 'workshop', 'hackathon', 'meetup', 'music', 'photography',
  'writing', 'book club', 'language', 'fitness', 'running', 'hiking', 'board games',
];

/**
 * Company names used as additional search keywords.
 *
 * Measured behaviour: Meetup's search is fuzzy RELEVANCE, not a filter — a nonsense
 * keyword returns the same 12 results as "Google", and only 5 of those 12 mention
 * Google. So these keywords are a DISCOVERY tool, not an attribution one: they
 * surface genuine company events ("Google Agents in Production for Enterprises",
 * "Building AI Agents with Microsoft Foundry") and harvest more group slugs, while
 * the irrelevant remainder collapses at ingest as duplicates of events other
 * keywords already found. Attribution is done separately and properly by
 * lib/companies/resolve.ts against the host field.
 *
 * Only distinctive names are used: querying "Intel" or "Target" would return
 * results about intelligence and targets.
 */
const COMPANY_KEYWORDS = COMPANIES.filter(c => c.strength === 'distinctive').map(c => c.name);

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
export async function scrapeMeetupCity(
  concurrency = 4,
  includeCompanyKeywords = true
): Promise<ScrapeResult> {
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

  const keywords = includeCompanyKeywords
    ? [...MEETUP_KEYWORDS, ...COMPANY_KEYWORDS]
    : MEETUP_KEYWORDS;

  await mapPool(keywords, concurrency, async keyword => {
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
      /*
       * THIS GUARD IS INERT, AND IS LEFT HERE DELIBERATELY. The real city gate is pipeline
       * stage 5c (`offCityReason`, lib/scrapers/core/geo.ts) — it runs AFTER enrichment, which
       * is what finally gives this source a real venue, and it serves every adapter. Do not
       * "fix" the line below and do not delete it without reading the rest of this note: a
       * per-adapter gate here is the wrong shape, and re-introducing one is the specific
       * mistake this comment exists to prevent.
       *
       * This guard CANNOT REJECT ANYTHING. `isBengaluru`'s only text-driven `return false` sits
       * inside `if (location)`, where location is built from venue + address — and this adapter's
       * own file header documents that Meetup's ICS emits no LOCATION, so both are always absent
       * here. With only `text` the function returns `true` or `null`, so `=== false` is never
       * satisfied. It reads as a working city filter and is dead code.
       *
       * Measured consequence (scripts/diag-meetup-geo-leak.ts, 2026-08-24): 23 of 886 upcoming
       * Meetup events name another city in their title/venue/address without naming Bengaluru —
       * 19 in-person, 9 in the DEFAULT tech feed, including "Anthropic - Code - Coffee : Chennai
       * Edition", "… Coimbatore Edition", "KONG API + AI Summit 2026" (Los Angeles), "FounderX
       * Silicon Valley" and "Umbraco India Festival 2026" (Kochi).
       *
       * Those events are gone from new runs — stage 5c rejects them, and it reads the TITLE,
       * which is where six of them named their city and which `isBengaluru` never looks at. It
       * cannot reach the ones already stored, though, because it filters the incoming batch and
       * never queries the collection; `scripts/cleanup-non-bengaluru.ts` is what removes those.
       *
       * See scripts/diag-meetup-geo-leak.ts for the reproduction. It was found while auditing a
       * competitor index against this corpus, which is also how the touring Luma seeds in luma.ts
       * were found.
       */
      if (isBengaluru({ text: event.description }) === false) continue;
      result.events.push(event);
    }
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
  }

  result.durationMs = Date.now() - startedAt.getTime();
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SECOND PASS — recovering the events the ICS cap hides
//
// THE MEASUREMENT. `/<group>/events/ical/` returns at most 10 upcoming events (MEETUP_ICS_CAP).
// `/<group>/events/` returns up to 30, and tells you the true total. Sampled 2026-09-10:
//
//     group                            ICS   page   upstream says
//     ai-blr                            10     17     17
//     agile-kitchen                     10     16     16
//     agile-chapter-bengaluru           10     12     12
//     agile-hr-practices                10     12     12
//     active-adventure-travel-junkies   10     30    148  (hasNextPage: true)
//
// THE MECHANISM IS A PLAIN FETCH, NOT A BROWSER, AND THE AUDIT GOT THIS WRONG. The finding that
// motivated this work concluded a headless browser was required, because the page yields zero
// JSON-LD `Event` nodes to a plain fetch. That is true and the conclusion does not follow: there
// are no JSON-LD Event nodes on that page in a RENDERED DOM either (only Organization, Place and
// BreadcrumbList). The events are server-rendered into
// `__NEXT_DATA__.props.pageProps.__APOLLO_STATE__`, which `extractNextData` has always been able
// to read. Measured on the same URL: plain fetch 27 events in ~1200 ms; Playwright 27 events in
// ~7300 ms plus a browser. So the cheap path IS the path, and `core/render.ts` is a fallback for
// the day Meetup stops server-rendering that island. See its header.
//
// WHAT THE PAGE GIVES THAT THE ICS DOES NOT, which matters for more than volume: a real VENUE
// with `city` and an ISO `country`, a cover photo, and a going count. Meetup's ICS carries no
// LOCATION at all — the documented reason `enrichMeetupEvents` exists and the reason the stage-5c
// city gate has nothing but a title to judge Meetup rows on. Second-pass rows arrive already
// judgeable, and already excluded from the enrichment budget (`!e.venue && !e.imageUrl`).
//
// THREE TRAPS, all of which would have quietly broken the city gate. Do not "simplify" past them.
//
//  1. NEVER COPY THE GROUP'S `lat`/`lon` ONTO AN EVENT. The Apollo `Group` node carries the
//     group's home coordinates (ai-blr: 12.97/77.56 — central Bengaluru).
//     `offCityReason` → `hasBengaluruEvidence` checks coordinates FIRST and an in-city
//     coordinate is an unconditional VETO of rejection. Stamping the group's location on its
//     events would therefore make every event of every Bengaluru group unrejectable, including
//     the Chiang Mai trekking trip below. Coordinates are taken from the VENUE or not at all,
//     and Meetup's Venue node does not publish them, so in practice: not at all.
//  2. NEVER COPY THE GROUP'S `city` EITHER, for exactly the same reason one step weaker — a
//     `city` of "Bangalore" is Bengaluru evidence and vetoes rejection. `city` comes from the
//     venue, which is the event's city; the group's is where the ORGANISER is based, and a
//     Bengaluru group running a Chennai edition is the documented shape of this leak.
//  3. `sourceEventId` MUST KEEP THE ICS's `event_<id>@meetup.com` FORM. It is an ingest-time
//     re-match key (`ingestion.ts`), so a page row and an ICS row for the same event must carry
//     the same one or the second pass would insert duplicates of the ten events already stored.
//
// The rows this pass adds go through the pipeline UNCHANGED — normalize → stage 5b date window →
// stage 5c `offCityReason` → stage 6 dedup — because they are ordinary `RawEvent`s in
// `collector.events`. They get no exemption and no shortcut.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Meetup's own page connection ceiling, for reporting a group we still cannot see all of. */
export const MEETUP_PAGE_CAP = 30;

/**
 * How far into the past a row may start and still be kept.
 *
 * Matches `MAX_PAST_START_DAYS` in pipeline.ts stage 5b. The page's upcoming connection is
 * already filtered by `afterDateTime`, so this only bites on the fallback path that walks every
 * `Event:` node — where the page's PAST tab (ten more events) is also in the cache. Aligning the
 * two numbers means a row this pass keeps is never immediately rejected by the gate and charged
 * against the group's health.
 */
const PAGE_PAST_TOLERANCE_DAYS = 2;

type ApolloState = Record<string, Record<string, unknown>>;

export interface MeetupPageParse {
  events: RawEvent[];
  /** Upcoming rows dropped because the venue names a country other than India. */
  offCountry: number;
  /** The upstream's own count of upcoming events, when it publishes one. */
  upstreamTotal?: number;
  /** True when the upstream says there are more events past the page's own 30-row ceiling. */
  hasMore: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function refTarget(state: ApolloState, value: unknown): Record<string, unknown> | undefined {
  const ref = asRecord(value)?.__ref;
  return typeof ref === 'string' ? asRecord(state[ref]) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function date(value: unknown): Date | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** Locate `props.pageProps.__APOLLO_STATE__` in a parsed `__NEXT_DATA__` payload. */
function apolloState(nextData: unknown): ApolloState | undefined {
  const pageProps = asRecord(asRecord(asRecord(nextData)?.props)?.pageProps);
  const state = asRecord(pageProps?.__APOLLO_STATE__);
  return state as ApolloState | undefined;
}

/**
 * Pull the upcoming-events connection out of the Apollo cache.
 *
 * Apollo encodes a field's arguments into the cache KEY, so the group node carries several
 * `events({...})` entries — one per query the page ran. The upcoming one is identified by
 * `afterDateTime` in its arguments; the `beforeDateTime` sibling is the PAST tab, and reading it
 * would import ten expired events per group.
 *
 * Returns `undefined` (not an empty list) when no such key exists, so the caller can tell "the
 * shape changed, fall back to walking every Event node" apart from "this group has nothing on".
 */
function upcomingConnection(
  state: ApolloState
): { refs: unknown[]; upstreamTotal?: number; hasMore: boolean } | undefined {
  for (const [key, node] of Object.entries(state)) {
    if (!key.startsWith('Group:')) continue;
    const group = asRecord(node);
    if (!group) continue;
    for (const [field, value] of Object.entries(group)) {
      if (!field.startsWith('events(') || !field.includes('afterDateTime')) continue;
      const connection = asRecord(value);
      if (!connection) continue;
      const edges = Array.isArray(connection.edges) ? connection.edges : [];
      const total = connection.totalCount;
      const pageInfo = asRecord(connection.pageInfo);
      return {
        refs: edges.map(edge => asRecord(edge)?.node),
        upstreamTotal: typeof total === 'number' ? total : undefined,
        hasMore: pageInfo?.hasNextPage === true,
      };
    }
  }
  return undefined;
}

/**
 * Turn one Apollo `Event` node into a RawEvent, or null if it is not a usable upcoming event.
 *
 * `null` covers three cases deliberately lumped together, because none of them is a parser bug:
 * cancelled/draft, unparseable or expired start, and an off-India venue (counted separately by
 * the caller).
 */
function apolloEventToRaw(
  state: ApolloState,
  node: Record<string, unknown>,
  opts: { slug: string; organizer: string; floorMs: number }
): { event: RawEvent } | { offCountry: true } | null {
  const title = text(node.title);
  const startDateTime = date(node.dateTime);
  if (!title || !startDateTime) return null;
  if (startDateTime.getTime() < opts.floorMs) return null;

  // Reject only what is EXPLICITLY bad. An unrecognised future status must be kept: the
  // alternative fails in the direction that silently zeroes the source when Meetup renames a
  // value, which is the failure mode this whole second pass exists because of.
  const status = (text(node.status) || '').toUpperCase();
  if (status === 'CANCELLED' || status === 'DRAFT') return null;

  const venue = refTarget(state, node.venue);
  const venueName = text(venue?.name);
  const venueCity = text(venue?.city);
  const venueCountry = (text(venue?.country) || '').toLowerCase();

  /*
   * THE ONE GEO DECISION THIS ADAPTER MAKES, AND WHY IT IS NOT THE PER-ADAPTER GATE THIS FILE
   * WARNS AGAINST FURTHER UP.
   *
   * `offCityReason` (the shared stage-5c gate) takes title/venue/address/city and NO COUNTRY —
   * it is a gazetteer of Indian cities, and its own header records that a city absent from the
   * list simply passes. So it cannot judge `Chiang Mai`, `Kuta/Bali` or `Pisa`, which is exactly
   * what `active-adventure-travel-junkies` publishes: 148 upcoming trips, 30 of them reachable
   * here where the ICS showed 10. Widening a city gazetteer to cover the world is not the fix.
   *
   * A two-letter ISO country from the upstream's own structured Venue field is not a text
   * heuristic — it is the upstream stating where the event is. That makes it categorically
   * different from the dead `isBengaluru({ text })` guard below, which tried to infer a city from
   * prose the ICS does not even carry.
   *
   * FAILS OPEN, always: an absent or empty country keeps the row. Online events have no venue
   * country, and "attendable from anywhere" is the documented policy for a venue-less row.
   */
  if (venueCountry && venueCountry !== 'in') return { offCountry: true };

  const eventType = (text(node.eventType) || '').toUpperCase();
  const isOnline = node.isOnline === true || eventType === 'ONLINE';
  const isHybrid = eventType === 'HYBRID';
  // Meetup files online events against a placeholder venue literally called "Online event".
  const placeholderVenue = !venueName || /^online event$/i.test(venueName);

  const id = text(node.id);
  const sourceUrl =
    text(node.eventUrl) ||
    (id ? `https://www.meetup.com/${opts.slug}/events/${id}/` : undefined) ||
    `https://www.meetup.com/${opts.slug}/`;

  const photo = refTarget(state, node.featuredEventPhoto) ?? refTarget(state, node.displayPhoto);
  const going = asRecord(node.going)?.totalCount;
  const description = text(node.description);

  const address = [text(venue?.address), venueCity, text(venue?.state)]
    .filter(Boolean)
    .join(', ');

  return {
    event: {
      title,
      description: truncate(stripHtml(description || title), 4000),
      sourceUrl,
      source: MEETUP_SOURCE,
      // Same shape as the ICS UID — see trap 3 in the block comment above.
      sourceEventId: id ? `event_${id}@meetup.com` : sourceUrl,
      organizer: opts.organizer,
      venue: isOnline || placeholderVenue ? undefined : venueName,
      address: isOnline || !address ? undefined : address,
      // VENUE city only. Never the group's — trap 2.
      city: isOnline ? undefined : venueCity,
      onlineLink: isOnline || isHybrid ? sourceUrl : undefined,
      startDateTime,
      endDateTime: date(node.endTime),
      imageUrl: text(photo?.highResUrl),
      attendeeCount: typeof going === 'number' && going > 0 ? going : undefined,
      rawFormat: isHybrid ? 'hybrid' : isOnline ? 'online' : 'offline',
    },
  };
}

/**
 * Extract a Meetup group's upcoming events from its `/events/` HTML. PURE — no network, no clock
 * of its own (`now` is a parameter), so `tests/meetup-cap.test.ts` can pin it against a fixture.
 */
export function meetupEventsFromGroupPage(
  html: string,
  opts: { slug: string; organizer?: string; now?: Date }
): MeetupPageParse {
  const empty: MeetupPageParse = { events: [], offCountry: 0, hasMore: false };
  const state = apolloState(extractNextData(html));
  if (!state) return empty;

  const organizer = opts.organizer ?? opts.slug.replace(/-/g, ' ');
  const now = opts.now ?? new Date();
  const floorMs = now.getTime() - PAGE_PAST_TOLERANCE_DAYS * 24 * 3600 * 1000;

  const connection = upcomingConnection(state);
  const nodes: Array<Record<string, unknown>> = [];
  if (connection) {
    for (const ref of connection.refs) {
      const node = refTarget(state, ref);
      if (node) nodes.push(node);
    }
  } else {
    // Shape-change fallback: every Event node in the cache, leaning on `floorMs` to shed the
    // PAST tab. Strictly worse than the connection (it cannot report a total or a next page),
    // which is why it is only reached when the connection key is absent entirely.
    for (const [key, node] of Object.entries(state)) {
      if (!key.startsWith('Event:')) continue;
      const record = asRecord(node);
      if (record) nodes.push(record);
    }
  }

  const events: RawEvent[] = [];
  let offCountry = 0;
  for (const node of nodes) {
    const outcome = apolloEventToRaw(state, node, { slug: opts.slug, organizer, floorMs });
    if (!outcome) continue;
    if ('offCountry' in outcome) {
      offCountry++;
      continue;
    }
    events.push(outcome.event);
  }

  return {
    events,
    offCountry,
    upstreamTotal: connection?.upstreamTotal,
    hasMore: connection?.hasMore ?? false,
  };
}

/** Signature of `core/render.ts#renderHtml`, so this adapter never imports Playwright. */
export type PageRenderer = (url: string) => Promise<string | null>;

/**
 * Second pass over ONE group: read `/<slug>/events/` and return its upcoming events.
 *
 * Cheap path first (`fetchText`, ~1 s). `render` is consulted only when the cheap path produced
 * no events at all, and is expected to be unused — see the block comment above.
 */
export async function scrapeMeetupGroupPage(
  slug: string,
  opts: { render?: PageRenderer; now?: Date } = {}
): Promise<MeetupPageParse & { via: 'fetch' | 'render' | 'empty'; error?: string }> {
  const url = `https://www.meetup.com/${slug}/events/`;
  let error: string | undefined;

  try {
    const html = await fetchText(url, { timeoutMs: 25000, retries: 2 });
    const parsed = meetupEventsFromGroupPage(html, { slug, now: opts.now });
    if (parsed.events.length > 0 || parsed.upstreamTotal === 0) {
      // `upstreamTotal === 0` is a real answer ("this group has nothing on"), not a failure, so
      // it must not trigger a browser render.
      return { ...parsed, via: 'fetch' };
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  if (!opts.render) return { events: [], offCountry: 0, hasMore: false, via: 'empty', error };

  const rendered = await opts.render(url);
  if (!rendered) return { events: [], offCountry: 0, hasMore: false, via: 'empty', error };

  // The rendered DOM is tried BOTH ways: the data island again (it may have hydrated late) and
  // JSON-LD, which is the shape a future Meetup redesign would most plausibly move to and which
  // `rawEventsFromHtml` already handles for the keyword fan-out.
  const parsed = meetupEventsFromGroupPage(rendered, { slug, now: opts.now });
  if (parsed.events.length > 0) return { ...parsed, via: 'render' };

  const fromJsonLd = rawEventsFromHtml(rendered, { baseUrl: url, source: MEETUP_SOURCE });
  if (fromJsonLd.length > 0) {
    return { events: fromJsonLd, offCountry: 0, hasMore: false, via: 'render' };
  }
  return { events: [], offCountry: 0, hasMore: false, via: 'empty', error };
}

/** Canonical identity for merging an ICS row against a page row: same event, two feeds. */
function eventUrlKey(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
}

/**
 * Merge a group's ICS rows with its page rows.
 *
 * The page copy WINS on overlap (it has venue, city, cover photo and a going count where the ICS
 * has none) but gap-fills from the ICS copy, so nothing the ICS uniquely supplied — `timezone`
 * from `DTSTART;TZID`, an end time, a longer description — is lost.
 *
 * This happens HERE rather than being left to the pipeline's stage-6 dedup on purpose. Stage 6
 * runs after enrichment, so leaving both copies in flight would spend an event-page fetch out of
 * `meetupEnrichBudget` on the ICS copy and then throw that copy away.
 */
function mergeGroupEvents(ics: RawEvent[], page: RawEvent[]): { events: RawEvent[]; gained: number } {
  const byUrl = new Map<string, RawEvent>();
  const order: string[] = [];
  for (const event of ics) {
    const key = eventUrlKey(event.sourceUrl);
    if (!byUrl.has(key)) order.push(key);
    byUrl.set(key, event);
  }

  let gained = 0;
  for (const fresh of page) {
    const key = eventUrlKey(fresh.sourceUrl);
    const existing = byUrl.get(key);
    if (!existing) {
      order.push(key);
      byUrl.set(key, fresh);
      gained++;
      continue;
    }
    const merged: RawEvent = { ...fresh };
    merged.timezone ??= existing.timezone;
    merged.endDateTime ??= existing.endDateTime;
    merged.venue ??= existing.venue;
    merged.address ??= existing.address;
    merged.city ??= existing.city;
    merged.imageUrl ??= existing.imageUrl;
    merged.onlineLink ??= existing.onlineLink;
    merged.attendeeCount ??= existing.attendeeCount;
    if (existing.description.length > merged.description.length) {
      merged.description = existing.description;
    }
    byUrl.set(key, merged);
  }

  return { events: order.map(key => byUrl.get(key)!).filter(Boolean), gained };
}

export type SecondPassOutcome =
  /** The whole second pass is switched off for this run. */
  | 'disabled'
  /** ICS came back under the cap, so there is nothing to suspect. */
  | 'not-needed'
  /** Suspected truncated, but the per-run cap on second passes was already spent. */
  | 'capped'
  /** Read from the page's data island by a plain fetch. */
  | 'fetch'
  /** Read from a rendered DOM after the plain fetch found nothing. */
  | 'render'
  /** Tried and got nothing — a real change in the upstream, or an empty group. */
  | 'empty';

export interface MeetupGroupOutcome {
  slug: string;
  events: RawEvent[];
  errors: string[];
  /** Rows the ICS feed returned, before merging. The truncation signal. */
  icsCount: number;
  /** Events the second pass added that the ICS did not have. */
  gained: number;
  /**
   * ICS returned AT OR ABOVE `MEETUP_ICS_CAP` — suspected upstream truncation.
   *
   * `>=` rather than `===` deliberately: if Meetup ever raises its cap, an `===` test would
   * stop suspecting anything on the day the ceiling moved, and this whole finding is what a
   * ceiling nobody was testing for costs.
   */
  truncated: boolean;
  secondPass: SecondPassOutcome;
  /** Upcoming total the upstream itself reports, when it does. */
  upstreamTotal?: number;
  /** Still more events than even the page shows (`hasNextPage`). */
  hasMore: boolean;
  /** Rows dropped because the venue named a country other than India. */
  offCountry: number;
}

export interface MeetupSweepSummary {
  groups: number;
  /** Groups whose ICS returned exactly the cap. */
  truncated: number;
  /** Second passes actually performed. */
  secondPassRan: number;
  /** Truncated groups skipped because the per-run cap bit. */
  capped: number;
  /** Net-new events across every second pass. */
  gained: number;
  /** Rows the country guard dropped. */
  offCountry: number;
  /** Groups that still have more than the page's 30-row ceiling shows. */
  stillTruncated: number;
  /** Second passes that came back with nothing. */
  empty: number;
  durationMs: number;
}

export interface MeetupSweepOptions {
  /** Run the second pass at all. Off ⇒ pure ICS behaviour, unchanged. */
  secondPass?: boolean;
  /**
   * Optional renderer for the fallback path (`core/render.ts#renderHtml`). Passed IN rather than
   * imported so this adapter has no reference, static or dynamic, to Playwright — see
   * `core/render.ts` property 1 on why that matters for the serverless bundle.
   */
  render?: PageRenderer;
  /** Concurrency for the ICS pass. */
  icsConcurrency?: number;
  /** Concurrency for the page pass. Separate because the two have different costs. */
  pageConcurrency?: number;
  /** Cap on second passes per run. */
  maxSecondPass?: number;
  now?: Date;
}

/**
 * Scrape every group: ICS for all of them, then a page pass for the ones sitting on the cap.
 *
 * TWO PHASES, NOT ONE PER-GROUP UNIT, and the reason is cost shape rather than tidiness: the ICS
 * pass is one cheap request per group and runs 8-wide, the page pass is a heavier request for
 * ~28% of groups and runs 5-wide under its own cap. Interleaving them would force one concurrency
 * number onto two different costs.
 *
 * Results are returned PER GROUP so the caller can record per-group health with exactly ONE
 * `updateSource` write. Two writes for one Source row would increment
 * `consecutiveEmptyScrapes` twice and back the group off in half the documented time — see
 * `claim()` in pipeline.ts.
 */
export async function scrapeMeetupGroupsSweep(
  slugs: string[],
  opts: MeetupSweepOptions = {}
): Promise<{ outcomes: MeetupGroupOutcome[]; summary: MeetupSweepSummary }> {
  const startedAt = Date.now();
  const icsConcurrency = opts.icsConcurrency ?? 8;
  const pageConcurrency = opts.pageConcurrency ?? 5;
  const maxSecondPass = opts.maxSecondPass ?? Number.POSITIVE_INFINITY;

  // ── Phase A: ICS for every group ────────────────────────────────────────────────────────────
  const icsResults = await mapPool(slugs, icsConcurrency, slug => scrapeMeetupGroup(slug));

  const outcomes: MeetupGroupOutcome[] = slugs.map((slug, index) => {
    const one = icsResults[index];
    const events = one?.events ?? [];
    return {
      slug,
      events,
      errors: one?.errors ?? [],
      icsCount: events.length,
      gained: 0,
      truncated: events.length >= MEETUP_ICS_CAP,
      secondPass: opts.secondPass ? 'not-needed' : 'disabled',
      hasMore: false,
      offCountry: 0,
    };
  });

  // ── Phase B: page pass for the groups on the cap ────────────────────────────────────────────
  const suspects = outcomes.filter(o => o.truncated);
  let capped = 0;
  if (opts.secondPass && suspects.length > 0) {
    const due = suspects.slice(0, maxSecondPass);
    capped = suspects.length - due.length;
    if (capped > 0) {
      // Same rule as `applyCap` in pipeline.ts: a cap is a legitimate cost control, a cap you
      // cannot see in the logs is a coverage bug that presents as a supply problem.
      console.log(
        `  ! Meetup second pass: capped at ${due.length} of ${suspects.length} truncated group(s) — ` +
          `${capped} left at ${MEETUP_ICS_CAP} this run`
      );
    }

    await mapPool(due, pageConcurrency, async outcome => {
      const page = await scrapeMeetupGroupPage(outcome.slug, {
        render: opts.render,
        now: opts.now,
      });
      outcome.secondPass = page.via;
      outcome.upstreamTotal = page.upstreamTotal;
      outcome.hasMore = page.hasMore;
      outcome.offCountry = page.offCountry;
      if (page.error) outcome.errors.push(`second pass: ${page.error}`);

      const merged = mergeGroupEvents(outcome.events, page.events);
      outcome.events = merged.events;
      outcome.gained = merged.gained;
      return null;
    });

    for (const outcome of suspects.slice(maxSecondPass)) outcome.secondPass = 'capped';
  }

  const summary: MeetupSweepSummary = {
    groups: slugs.length,
    truncated: suspects.length,
    secondPassRan: outcomes.filter(o => o.secondPass === 'fetch' || o.secondPass === 'render').length,
    capped,
    gained: outcomes.reduce((sum, o) => sum + o.gained, 0),
    offCountry: outcomes.reduce((sum, o) => sum + o.offCountry, 0),
    stillTruncated: outcomes.filter(o => o.hasMore).length,
    empty: outcomes.filter(o => o.secondPass === 'empty').length,
    durationMs: Date.now() - startedAt,
  };

  return { outcomes, summary };
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

  // Resolved from the communities named in the user's own attendance history. The
  // names were searched rather than guessed (guessing scored 0/35), then every
  // candidate slug's ICS feed was fetched and kept only if it returned UPCOMING
  // events -- scripts/verify-attended-seeds.ts prints the counts.
  //
  // Open-source / data-infrastructure groups, which is where the corpus was thinnest:
  'apache-iceberg-meetups-india',          // Bangalore Iceberg Community Meetup
  'apache-pinot-bengaluru-by-startree',    // Apache Pinot, hosted by StarTree
  'presto-bangalore',                      // Presto/Trino
  // Platform, cloud and AI practitioner groups:
  'lead-with-tech-meetup-group',           // 10 upcoming at verification time
  'ai-xchange',
  'global-platform-engineers-network-gpen',
  'cloud-computing-circle',
  'technexus-community',
  // Startup/founder groups the user follows via newsletter invites:
  'startups-entrepreneurs-network-senex-by-cedat',
  'bangalore-seapreneurs-community',
  // Non-tech but real city events, kept because the scraper ingests the whole city
  // and the feed filters with techOnly:
  'hsrmeetups',
  //
  // DELIBERATELY NOT SEEDED: 'whfl-bangalore'. Its ICS does return 6 upcoming events,
  // but they are the "India's Premier Weekly Business Exchange Network" series that
  // the tagger currently mis-classifies as a tech event. It is already in the Source
  // collection from keyword discovery, so seeding it would only make a known
  // false-positive family more prominent.
];
