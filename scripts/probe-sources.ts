#!/usr/bin/env tsx
/**
 * READ-ONLY source reconnaissance.
 *
 * Purpose: decide which Bengaluru event sources are worth building adapters for
 * based on EVIDENCE, not guesses. For each candidate endpoint it records the HTTP
 * status, content type, payload size, and — crucially — whether the response
 * actually contains machine-readable event data (JSON-LD Event, __NEXT_DATA__,
 * embedded JSON arrays, ICS VEVENTs, RSS items).
 *
 * Writes nothing to the database. Run:  npx tsx scripts/probe-sources.ts
 */
import './load-env';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

interface Probe {
  group: string;
  name: string;
  url: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  headers?: Record<string, string>;
}

const PROBES: Probe[] = [
  // ── Luma ──────────────────────────────────────────────────────────────────
  { group: 'luma', name: 'city page bengaluru', url: 'https://luma.com/bengaluru' },
  {
    group: 'luma',
    name: 'discover API (city)',
    url: 'https://api.lu.ma/discover/get-paginated-events?discover_place_api_id=discplace-BLpVGkGRSbdVXfV&pagination_limit=50',
  },
  {
    group: 'luma',
    name: 'discover city getPlace',
    url: 'https://api.lu.ma/discover/get-place?slug=bengaluru',
  },
  {
    group: 'luma',
    name: 'search API',
    url: 'https://api.lu.ma/search/get-results?query=bengaluru',
  },

  // ── Meetup ────────────────────────────────────────────────────────────────
  { group: 'meetup', name: 'group RSS', url: 'https://www.meetup.com/bangpypers/events/rss/' },
  {
    group: 'meetup',
    name: 'find events city page',
    url: 'https://www.meetup.com/find/?location=in--Bengaluru&source=EVENTS',
  },
  {
    group: 'meetup',
    name: 'find tech events city page',
    url: 'https://www.meetup.com/find/?keywords=technology&location=in--Bengaluru&source=EVENTS',
  },
  {
    group: 'meetup',
    name: 'gql2 keyword search',
    url: 'https://www.meetup.com/gql2',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: {
      operationName: 'eventKeywordSearch',
      variables: {
        first: 20,
        lat: 12.97,
        lon: 77.59,
        radius: 50,
        topicCategoryId: null,
        startDateRange: new Date().toISOString().slice(0, 19),
        source: 'EVENTS',
      },
      query:
        'query eventKeywordSearch($first: Int, $lat: Float!, $lon: Float!, $radius: Int, $startDateRange: ZonedDateTime, $source: [SearchSources!]) { results: keywordSearch(input: {first: $first}, filter: {lat: $lat, lon: $lon, radius: $radius, startDateRange: $startDateRange, source: $source}) { count edges { node { id result { ... on Event { id title dateTime eventUrl venue { name city } group { name } } } } } } }',
    },
  },

  // ── Eventbrite ────────────────────────────────────────────────────────────
  {
    group: 'eventbrite',
    name: 'city browse page',
    url: 'https://www.eventbrite.com/d/india--bengaluru/all-events/',
  },
  {
    group: 'eventbrite',
    name: 'destination search API',
    url: 'https://www.eventbrite.com/api/v3/destination/search/',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: {
      event_search: {
        page: 1,
        page_size: 50,
        places: ['101735441'],
        dates: 'current_future',
      },
      expand: { destination_event: ['primary_venue', 'image', 'ticket_availability'] },
    },
  },

  // ── Commudle (Indian dev-community platform) ──────────────────────────────
  { group: 'commudle', name: 'v2 events', url: 'https://api.commudle.com/api/v2/events' },
  { group: 'commudle', name: 'all-events page', url: 'https://www.commudle.com/all-events' },
  {
    group: 'commudle',
    name: 'v2 all_events feed',
    url: 'https://api.commudle.com/api/v2/all_events?page=1&count=30',
  },

  // ── Hasgeek ───────────────────────────────────────────────────────────────
  { group: 'hasgeek', name: 'home', url: 'https://hasgeek.com/' },
  { group: 'hasgeek', name: 'api all', url: 'https://hasgeek.com/api/1/events' },
  { group: 'hasgeek', name: 'json home', url: 'https://hasgeek.com/?json=1' },

  // ── Unstop ────────────────────────────────────────────────────────────────
  {
    group: 'unstop',
    name: 'public search API',
    url: 'https://unstop.com/api/public/opportunity/search-result?opportunity=hackathons&per_page=30&page=1',
  },
  {
    group: 'unstop',
    name: 'public search API (all)',
    url: 'https://unstop.com/api/public/opportunity/search-result?per_page=30&page=1&searchTerm=bangalore',
  },

  // ── Devfolio ──────────────────────────────────────────────────────────────
  { group: 'devfolio', name: 'hackathons API', url: 'https://api.devfolio.co/api/hackathons?page=1' },

  // ── Townscript ────────────────────────────────────────────────────────────
  { group: 'townscript', name: 'bangalore browse', url: 'https://www.townscript.com/browse/bangalore' },
  {
    group: 'townscript',
    name: 'search API',
    url: 'https://www.townscript.com/api/v1/event/search?city=Bangalore',
  },

  // ── AllEvents.in ──────────────────────────────────────────────────────────
  { group: 'allevents', name: 'bengaluru tech', url: 'https://allevents.in/bengaluru/technology' },
  { group: 'allevents', name: 'bengaluru all', url: 'https://allevents.in/bengaluru/all' },

  // ── Bevy (GDG / community.dev chapters) ───────────────────────────────────
  { group: 'bevy', name: 'gdg blr chapter page', url: 'https://gdg.community.dev/gdg-bangalore/' },
  {
    group: 'bevy',
    name: 'bevy event_slim API',
    url: 'https://gdg.community.dev/api/event_slim/?fields=title,start_date,url,city&status=Published',
  },
  {
    group: 'bevy',
    name: 'bevy search API india',
    url: 'https://gdg.community.dev/api/search/event/?q=bangalore',
  },

  // ── Microsoft Reactor ─────────────────────────────────────────────────────
  {
    group: 'msreactor',
    name: 'reactor events API',
    url: 'https://developer.microsoft.com/en-us/reactor/api/search/events?searchText=&pageSize=50&pageIndex=0',
  },
  { group: 'msreactor', name: 'reactor bengaluru page', url: 'https://developer.microsoft.com/en-us/reactor/location/bengaluru/' },

  // ── Company / org event pages (universal-adapter candidates) ──────────────
  { group: 'company', name: 'AWS events', url: 'https://aws.amazon.com/events/' },
  { group: 'company', name: 'Google Developers events', url: 'https://developers.google.com/events' },
  { group: 'company', name: 'MongoDB events', url: 'https://www.mongodb.com/company/events' },
  { group: 'company', name: 'Postman events', url: 'https://www.postman.com/events/' },
  { group: 'company', name: 'Razorpay events (luma)', url: 'https://luma.com/razorpay' },
  { group: 'company', name: 'GitHub events', url: 'https://github.com/events' },
  { group: 'company', name: 'Nvidia events', url: 'https://www.nvidia.com/en-in/events/' },
  { group: 'company', name: 'Atlassian events', url: 'https://www.atlassian.com/company/events' },

  // ── ICS feed discovery candidates ─────────────────────────────────────────
  { group: 'ics', name: 'hasgeek ics', url: 'https://hasgeek.com/api/1/events.ics' },
  { group: 'ics', name: 'meetup group ics', url: 'https://www.meetup.com/bangpypers/events/ical/' },
];

interface Finding {
  group: string;
  name: string;
  url: string;
  status: number | string;
  contentType: string;
  bytes: number;
  signals: string[];
  sample?: string;
}

/** Look for machine-readable event signals in a payload. */
function detectSignals(text: string, contentType: string): { signals: string[]; sample?: string } {
  const signals: string[] = [];
  let sample: string | undefined;

  // JSON-LD Event blocks
  const ldMatches = [...text.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
  if (ldMatches.length > 0) {
    let eventNodes = 0;
    for (const m of ldMatches) {
      try {
        const parsed = JSON.parse(m[1].trim());
        const json = JSON.stringify(parsed);
        eventNodes += (json.match(/"@type"\s*:\s*"[A-Za-z]*Event"/g) || []).length;
      } catch {
        /* malformed */
      }
    }
    signals.push(`jsonld:${ldMatches.length}blocks/${eventNodes}events`);
  }

  if (text.includes('__NEXT_DATA__')) signals.push('__NEXT_DATA__');
  if (text.includes('window.__SERVER_DATA__')) signals.push('__SERVER_DATA__');
  if (text.includes('self.__next_f')) signals.push('rsc-flight');
  if (/<link[^>]+text\/calendar/i.test(text)) signals.push('ics-link');
  if (/BEGIN:VEVENT/.test(text)) {
    signals.push(`ics:${(text.match(/BEGIN:VEVENT/g) || []).length}vevents`);
  }
  if (/<item>/i.test(text)) signals.push(`rss:${(text.match(/<item>/gi) || []).length}items`);

  // JSON payloads: look for date-ish keys that indicate event records
  if (contentType.includes('json')) {
    try {
      const parsed = JSON.parse(text);
      const json = JSON.stringify(parsed);
      const keyHits = [
        'start_at',
        'starts_at',
        'startDate',
        'start_date',
        'dateTime',
        'start_time',
        'startTime',
      ].filter(k => json.includes(`"${k}"`));
      if (keyHits.length > 0) signals.push(`json-date-keys:${keyHits.join('|')}`);
      const topKeys = Array.isArray(parsed)
        ? `array[${parsed.length}]`
        : Object.keys(parsed as object).slice(0, 12).join(',');
      sample = `keys=${topKeys}`;
    } catch {
      signals.push('json-parse-failed');
    }
  }

  if (signals.length === 0) sample = text.slice(0, 160).replace(/\s+/g, ' ');
  return { signals, sample };
}

async function probe(p: Probe): Promise<Finding> {
  const started = Date.now();
  try {
    const res = await fetch(p.url, {
      method: p.method || 'GET',
      headers: {
        'User-Agent': UA,
        Accept: p.method === 'POST' ? 'application/json' : 'text/html,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(p.headers || {}),
      },
      body: p.body ? JSON.stringify(p.body) : undefined,
      redirect: 'follow',
      signal: AbortSignal.timeout(25000),
    });

    const contentType = res.headers.get('content-type') || '';
    const text = await res.text();
    const { signals, sample } = detectSignals(text, contentType);

    return {
      group: p.group,
      name: p.name,
      url: p.url,
      status: res.status,
      contentType: contentType.split(';')[0],
      bytes: text.length,
      signals,
      sample: signals.length === 0 ? sample : sample,
    };
  } catch (err) {
    return {
      group: p.group,
      name: p.name,
      url: p.url,
      status: `ERR(${Date.now() - started}ms)`,
      contentType: '-',
      bytes: 0,
      signals: [],
      sample: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main() {
  console.log(`\n🔎 Probing ${PROBES.length} candidate endpoints…\n`);

  const findings: Finding[] = [];
  // Modest concurrency so we stay polite but finish quickly.
  const CONCURRENCY = 6;
  let idx = 0;
  async function worker() {
    while (idx < PROBES.length) {
      const mine = PROBES[idx++];
      findings.push(await probe(mine));
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  findings.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));

  let lastGroup = '';
  for (const f of findings) {
    if (f.group !== lastGroup) {
      console.log(`\n── ${f.group.toUpperCase()} ${'─'.repeat(Math.max(0, 60 - f.group.length))}`);
      lastGroup = f.group;
    }
    const ok = typeof f.status === 'number' && f.status < 400;
    const mark = ok ? (f.signals.length > 0 ? '✅' : '⚠️ ') : '❌';
    console.log(
      `${mark} [${String(f.status).padEnd(6)}] ${f.name.padEnd(28)} ${String(f.bytes).padStart(8)}B ${f.contentType.padEnd(18)} ${f.signals.join(' ') || '(no event signals)'}`
    );
    if (f.sample) console.log(`        ↳ ${f.sample.slice(0, 200)}`);
  }

  const usable = findings.filter(f => typeof f.status === 'number' && f.status < 400 && f.signals.length > 0);
  console.log(`\n📊 ${usable.length}/${findings.length} endpoints returned machine-readable event signals.\n`);
}

main().catch(e => {
  console.error('❌ probe failed', e);
  process.exit(1);
});
