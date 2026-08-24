// Luma adapter — the single highest-yield source for Bengaluru tech events.
//
// ARCHITECTURE (verified live during recon, see scripts/probe-round3.ts):
//
//   1. DISCOVER FEED. `api.lu.ma/discover/get-paginated-events` is Luma's own
//      public city feed. One call returns fully structured events: name, start/end
//      instants, timezone, cover image, coordinates, obfuscated-but-usable geo
//      info, guest count, ticket price, AND the host `calendar` object. No HTML
//      parsing, no selectors, no browser.
//
//   2. HOST-CALENDAR DISCOVERY — the key to company coverage. The city feed only
//      surfaces a slice of each host's events (recon: "The Product Folks" appeared
//      once in the city feed but its own calendar had 18 upcoming events). Every
//      entry names its calendar, so we harvest those ids and scrape each host's
//      own feed via `api.lu.ma/calendar/get-items`. Hosts include company
//      calendars like "Razorpay Rize: Community" and "Lyzr Community Events", so
//      company event pages get covered WITHOUT hand-maintaining a company list —
//      and the set grows every run because discovered calendars are persisted.
//
//   3. ENRICHMENT. The feeds carry no description. We fetch event pages
//      concurrently for the real description, and only for events we haven't
//      enriched before, under a per-run budget so a run stays bounded.

import { RawEvent, ScrapeResult } from '../core/types';
import { fetchJson, fetchText, mapPool } from '../core/http';
import { stripHtml, truncate } from '../core/text';
import { isBengaluru } from '../core/geo';

const API = 'https://api.lu.ma';
const LUMA_SOURCE = 'luma';

// ── Shapes of the parts of Luma's payload we rely on ────────────────────────
interface LumaGeoAddress {
  city?: string;
  city_state?: string;
  sublocality?: string;
  region?: string;
  region_short?: string;
  country?: string;
  full_address?: string;
  address?: string;
  place_id?: string;
  mode?: string;
  description?: string;
}

interface LumaCoordinate {
  latitude?: number;
  longitude?: number;
}

interface LumaEventCore {
  api_id?: string;
  calendar_api_id?: string;
  name?: string;
  start_at?: string;
  end_at?: string;
  timezone?: string;
  url?: string;
  cover_url?: string;
  social_image_url?: string;
  location_type?: string;
  event_type?: string;
  geo_address_info?: LumaGeoAddress;
  coordinate?: LumaCoordinate;
  virtual_info?: { url?: string };
}

interface LumaCalendar {
  api_id?: string;
  name?: string;
  slug?: string;
  avatar_url?: string;
  geo_city?: string;
  city?: string;
  website?: string;
}

interface LumaTicketInfo {
  price?: { cents?: number; currency?: string } | null;
  max_price?: { cents?: number; currency?: string } | null;
  is_free?: boolean;
  is_sold_out?: boolean;
  spots_remaining?: number | null;
}

interface LumaEntry {
  api_id?: string;
  event?: LumaEventCore;
  calendar?: LumaCalendar;
  hosts?: Array<{ name?: string; avatar_url?: string }>;
  guest_count?: number;
  ticket_count?: number;
  ticket_info?: LumaTicketInfo;
}

interface LumaFeed {
  entries?: LumaEntry[];
  has_more?: boolean;
  next_cursor?: string | null;
}

/** Luma prices are in minor units (cents/paise). */
function moneyToMajor(money: { cents?: number } | null | undefined): number | undefined {
  const cents = money?.cents;
  return typeof cents === 'number' && cents > 0 ? Math.round(cents / 100) : undefined;
}

/** Build the most useful human venue string Luma's obfuscated geo allows. */
function venueFrom(geo: LumaGeoAddress | undefined): string | undefined {
  if (!geo) return undefined;
  // `full_address` is present for public addresses; obfuscated events only give
  // sublocality + city, which is still genuinely useful ("Domlur I Stage").
  const parts = [geo.address || geo.full_address, geo.sublocality, geo.city].filter(Boolean);
  const seen = new Set<string>();
  const deduped = parts
    .map(p => String(p).trim())
    .filter(p => {
      const key = p.toLowerCase();
      if (!p || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return deduped.join(', ') || geo.city_state || undefined;
}

/** Convert one Luma feed entry into a RawEvent, or null if unusable. */
function entryToRawEvent(entry: LumaEntry): RawEvent | null {
  const event = entry.event;
  if (!event?.name || !event.start_at) return null;

  const startDateTime = new Date(event.start_at);
  if (Number.isNaN(startDateTime.getTime())) return null;

  const endDateTime = event.end_at ? new Date(event.end_at) : undefined;
  const isOnline = (event.location_type || '').toLowerCase() === 'online';

  const slug = event.url || '';
  const sourceUrl = slug
    ? slug.startsWith('http')
      ? slug
      : `https://luma.com/${slug}`
    : 'https://luma.com';

  const geo = event.geo_address_info;
  const ticket = entry.ticket_info;
  const price = moneyToMajor(ticket?.price);
  const priceMax = moneyToMajor(ticket?.max_price);

  const host = entry.calendar?.name && entry.calendar.name !== 'Personal'
    ? entry.calendar.name
    : entry.hosts?.[0]?.name;

  return {
    title: event.name.trim(),
    // Real description is filled in by enrichment; the title is a placeholder we
    // deliberately keep short so an un-enriched event still renders sensibly.
    description: event.name.trim(),
    sourceUrl,
    source: LUMA_SOURCE,
    sourceEventId: event.api_id,
    organizer: host,
    hostAvatarUrl: entry.calendar?.avatar_url || entry.hosts?.[0]?.avatar_url,
    venue: isOnline ? undefined : venueFrom(geo),
    address: isOnline ? undefined : geo?.full_address || geo?.address,
    city: geo?.city,
    lat: event.coordinate?.latitude,
    lng: event.coordinate?.longitude,
    onlineLink: isOnline ? event.virtual_info?.url || sourceUrl : undefined,
    startDateTime,
    endDateTime: endDateTime && !Number.isNaN(endDateTime.getTime()) ? endDateTime : undefined,
    timezone: event.timezone,
    imageUrl: event.cover_url || event.social_image_url,
    isFree: ticket?.is_free ?? (price === undefined ? undefined : price === 0),
    price,
    priceMax,
    currency: ticket?.price?.currency?.toUpperCase() || (price ? 'INR' : undefined),
    soldOut: ticket?.is_sold_out,
    attendeeCount: entry.guest_count,
    applyLink: sourceUrl,
    rawFormat: isOnline ? 'online' : 'offline',
  };
}

/** Resolve Luma's internal place id for a city slug (e.g. "bengaluru"). */
async function resolvePlaceId(slug: string): Promise<string | null> {
  try {
    const data = await fetchJson<{ place?: { api_id?: string } }>(
      `${API}/discover/get-place?slug=${encodeURIComponent(slug)}`,
      { timeoutMs: 15000 }
    );
    return data.place?.api_id || null;
  } catch {
    return null;
  }
}

/** Page through a Luma feed URL builder until exhausted or `maxPages` reached. */
async function paginate(
  buildUrl: (cursor: string | null) => string,
  maxPages: number
): Promise<{ entries: LumaEntry[]; errors: string[] }> {
  const entries: LumaEntry[] = [];
  const errors: string[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < maxPages; page++) {
    let feed: LumaFeed;
    try {
      feed = await fetchJson<LumaFeed>(buildUrl(cursor), { timeoutMs: 20000 });
    } catch (err) {
      errors.push(`page ${page}: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
    const batch = feed.entries || [];
    entries.push(...batch);
    if (!feed.has_more || !feed.next_cursor || batch.length === 0) break;
    cursor = feed.next_cursor;
  }

  return { entries, errors };
}

/**
 * Scrape Luma's Bengaluru city discover feed and harvest host calendars.
 */
export async function scrapeLumaCity(citySlug = 'bengaluru'): Promise<ScrapeResult> {
  const startedAt = new Date();
  const result: ScrapeResult = {
    sourceId: `luma-city:${citySlug}`,
    label: `Luma — ${citySlug}`,
    events: [],
    errors: [],
    discovered: [],
    startedAt,
    durationMs: 0,
  };

  const placeId = await resolvePlaceId(citySlug);
  if (!placeId) {
    result.errors.push(`Could not resolve Luma place id for "${citySlug}"`);
    result.durationMs = Date.now() - startedAt.getTime();
    return result;
  }

  const { entries, errors } = await paginate(
    cursor =>
      `${API}/discover/get-paginated-events?discover_place_api_id=${placeId}&pagination_limit=100` +
      (cursor ? `&pagination_cursor=${encodeURIComponent(cursor)}` : ''),
    8
  );
  result.errors.push(...errors);

  const seenCalendars = new Set<string>();
  for (const entry of entries) {
    const event = entryToRawEvent(entry);
    if (event) result.events.push(event);

    // Harvest the host calendar for future (and this) run's deeper coverage.
    const calendar = entry.calendar;
    if (calendar?.api_id && !seenCalendars.has(calendar.api_id)) {
      seenCalendars.add(calendar.api_id);
      // "Personal" calendars are individual users with no stable public identity;
      // they add little beyond what the city feed already gave us, so we skip
      // them and keep the discovered set focused on real orgs/communities.
      const name = calendar.name?.trim();
      if (name && name !== 'Personal') {
        result.discovered!.push({
          kind: 'luma-calendar',
          handle: calendar.api_id,
          label: name,
        });
      }
    }
  }

  result.durationMs = Date.now() - startedAt.getTime();
  return result;
}

/**
 * Scrape ONE Luma host calendar's own upcoming feed.
 *
 * This is where company/community coverage actually comes from: a calendar such
 * as "Razorpay Rize: Community" lists every event that org is running, most of
 * which never appear on the city page.
 */
export async function scrapeLumaCalendar(
  calendarApiId: string,
  label: string
): Promise<ScrapeResult> {
  const startedAt = new Date();
  const result: ScrapeResult = {
    sourceId: `luma-calendar:${calendarApiId}`,
    label: `Luma — ${label}`,
    events: [],
    errors: [],
    startedAt,
    durationMs: 0,
  };

  const { entries, errors } = await paginate(
    cursor =>
      `${API}/calendar/get-items?calendar_api_id=${encodeURIComponent(calendarApiId)}&period=future&pagination_limit=50` +
      (cursor ? `&pagination_cursor=${encodeURIComponent(cursor)}` : ''),
    4
  );
  result.errors.push(...errors);

  for (const entry of entries) {
    const event = entryToRawEvent(entry);
    if (!event) continue;

    // A host calendar is NOT city-scoped: The Product Folks run events in Delhi
    // and online too. Gate on geography so a Bengaluru product stays Bengaluru.
    // Online events from a Bengaluru-based host are kept — they're attendable.
    const verdict = isBengaluru({
      venue: event.venue,
      address: event.address,
      city: event.city,
      lat: event.lat,
      lng: event.lng,
    });
    const isOnline = event.rawFormat === 'online';
    if (verdict === false) continue;
    if (verdict === null && !isOnline) continue;

    result.events.push(event);
  }

  result.durationMs = Date.now() - startedAt.getTime();
  return result;
}

/**
 * Company / community calendars verified to exist, seeded so they're scraped from
 * the first run.
 *
 * WHY SEEDING IS NEEDED ALONGSIDE DISCOVERY: the city discover feed only surfaces
 * hosts that have an event in the *current* window. A company whose next event is
 * two months out is invisible to it. These handles were each confirmed by resolving
 * `luma.com/<handle>` to a real calendar api_id (scripts/probe-luma-handles.ts —
 * 18 of 107 candidates resolved; the rest 404 and are not listed).
 *
 * Every event still passes the Bengaluru gate in scrapeLumaCalendar, so a calendar
 * that turns out to be run from another city contributes nothing rather than noise.
 */
export const LUMA_SEED_CALENDARS: Array<{ handle: string; label: string }> = [
  // ── Deeptech / hardware hosts ──────────────────────────────────────────────
  // Hardware is this product's weakest dimension, and diag-hardware-gap.ts established
  // WHY: exactly 1 of 788 upcoming events mentioned real hardware vocabulary, so it is a
  // SUPPLY problem and no tagger work can touch it. These calendars were found by
  // harvesting the host behind hardware events already in the corpus
  // (probe-hardware-sources.ts) rather than by guessing handles — the method that has
  // worked, against 0/35 on guessed Meetup slugs and 18/107 on guessed Luma handles.
  //
  // Seeding them matters even though the city discover feed already surfaces some of their
  // events: a seed is scraped EVERY run, while the discover feed only shows what it happens
  // to rank that day.
  //
  // Honest limitation: these hosts are deeptech- and AI-adjacent, not silicon. They will
  // not make Bengaluru's VLSI, FPGA and embedded scene appear, because those events are not
  // published on Luma, Meetup or anywhere else machine-readable — see the note in
  // scripts/diag-hardware-gap.ts.
  { handle: 'cal-KD8pFvz8yyo00aW', label: 'The Hardware Club Bangalore / Physical AI' },
  { handle: 'cal-E8r4chACboAw3Oq', label: 'The Ecosystem Community — AI in DeepTech' },
  { handle: 'cal-nFRgTPChtz8gLju', label: 'DeepX — DeepTech' },

  // ── Seeded from the user's own 12-month event-attendance history ──
  // Each was verified live via calendar/get-items?period=future before being added;
  // two other calendars from the same list (Sela x Google Cloud, kipi.ai) returned 0
  // upcoming events and were deliberately left out.
  { handle: 'cal-l0CgIJ0Hhef7fcT', label: 'Bengaluru Tech Week' },
  { handle: 'cal-YsGACKB4XWwUMCs', label: 'Agentic Summit / Unicorn AI Summit' },
  // These two are GLOBAL calendars whose Bengaluru chapters the user attends. Most of
  // their events are elsewhere (Osaka, Houston, Dresden, Lagos) and the pipeline's geo
  // gate drops those, so the cost is one request for the BLR-chapter events we want.
  { handle: 'cal-TOpA5LAFfuDeFpu', label: 'Claude Community (CCCL) — incl. BLR chapter' },
  { handle: 'cal-rKZGvZjZWgFjKWW', label: 'n8n Community — incl. n8n Bangalore' },
  { handle: 'cal-W1a1JagbP7BFFnE', label: 'Postman Meetups' },
  { handle: 'cal-skHyTNF1BS9afOF', label: 'Slice' },
  { handle: 'cal-sa2bowyF5saW6io', label: 'Zluri' },
  { handle: 'cal-SCofCLGEvS5hdXd', label: 'Krutrim' },
  { handle: 'cal-0hx7kc7MBVsNwKv', label: 'Navi — Navigate' },
  { handle: 'cal-0MOQYFxupITToZL', label: 'Zoho' },
  { handle: 'cal-7aoBpXgZExyngdJ', label: 'Hasura' },
  { handle: 'cal-QNexM3g6ZZE38vy', label: 'Fractal' },
  { handle: 'cal-exEBzAxvfF9G4Qa', label: 'AWS User Group Bengaluru' },
  { handle: 'cal-fezWOB9c8umyWuD', label: 'Bengaluru Tech Week' },
  { handle: 'cal-NjGPenzVSf9PFOG', label: 'Surge (Peak XV)' },
  { handle: 'cal-ImHiaA1uaq2YMkM', label: 'GrowthX' },
  { handle: 'cal-DEgVFs3fB8MmpKT', label: 'Startup House' },
  { handle: 'cal-4hkkAGBIvZ29zPW', label: 'Groww' },
  { handle: 'cal-zZ3L4ejebSZmwOq', label: 'Juspay' },
  { handle: 'cal-fEGIAmlfowdozHG', label: 'Zeta' },
  { handle: 'cal-bBzYKgrZdjYZyKQ', label: 'Rippling' },
  { handle: 'cal-qP8i8yj42XnYWCs', label: 'Y Combinator' },

  // ── TOURING SERIES, found by auditing events.heapheaphurray.com ────────────
  // That audit compared its 20 curated pan-India tech events against our corpus: 14 were in
  // other cities, 5 we already had, and 1 was a same-day Bengaluru event we lacked. So it is
  // not a source worth an adapter — its upstreams are Luma and Devfolio, which we already
  // scrape — but it did surface these
  // two hosts, and the reason to seed them is specifically that they TOUR.
  //
  // Both currently show ZERO upcoming Bengaluru events (verify-hhh-calendar.ts, 2026-08-24):
  // JumpStart Bharat is in Kolkata / Guwahati / Lucknow / Prayagraj, AIBoomi in Chennai /
  // Delhi / Hyderabad. Each had a Bengaluru edition days ago and will have another. That makes
  // them the case a seed exists for: we caught AIBoomi's Bengaluru event ONLY because the city
  // discover feed happened to rank it that day, which is luck, whereas a seed is scraped every
  // run. The geo gate drops the other cities, so the cost is one request each per run.
  //
  // Deliberately NOT seeded from the same audit: `cal-3aH7Cvqdyre9u3j` (Founders Running Club).
  // 50 upcoming events for exactly 1 in Bengaluru — Ho Chi Minh, Tokyo, Singapore, Dubai,
  // Istanbul — and it is a running club, so `isTechEvent` is false regardless. We already have
  // its Bengaluru edition via Meetup.
  { handle: 'cal-uoe6JLx8HnATkBp', label: 'JumpStart Bharat — touring, incl. BLR edition' },
  { handle: 'cal-ZEzAGxvFU094YU2', label: 'AIBoomi — touring AI/founder series, incl. BLR' },
];

// ── Enrichment ──────────────────────────────────────────────────────────────

/** Pull the best available description text out of a Luma event page. */
function descriptionFromPage(html: string): string | undefined {
  // Luma stores the rendered description in __NEXT_DATA__ under either
  // `description_mirror` (rich text) or a plain `description` string.
  const plain = html.match(/"description"\s*:\s*"((?:[^"\\]|\\.){40,6000})"/);
  if (plain) {
    try {
      const decoded = JSON.parse(`"${plain[1]}"`) as string;
      const text = stripHtml(decoded);
      if (text.length > 40) return text;
    } catch {
      /* fall through */
    }
  }

  const og = html.match(
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{40,})["']/i
  );
  if (og) return stripHtml(og[1]);

  return undefined;
}

/**
 * Fetch real descriptions for a batch of Luma events.
 *
 * `budget` caps how many pages we fetch in one run so the pipeline stays bounded
 * regardless of how many events discovery turned up. Events are enriched in feed
 * order, which is chronological, so the soonest events — the ones users actually
 * look at — always win the budget.
 */
export async function enrichLumaDescriptions(
  events: RawEvent[],
  budget: number,
  concurrency = 6
): Promise<number> {
  const candidates = events
    .filter(e => e.source === LUMA_SOURCE && e.description === e.title)
    .slice(0, budget);

  let enriched = 0;
  await mapPool(candidates, concurrency, async event => {
    try {
      const html = await fetchText(event.sourceUrl, { timeoutMs: 15000, retries: 2 });
      const description = descriptionFromPage(html);
      if (description) {
        event.description = truncate(description, 4000);
        enriched++;
      }
    } catch {
      // Enrichment is best-effort: the event still ingests with its title as the
      // description rather than being dropped.
    }
    return null;
  });

  return enriched;
}
