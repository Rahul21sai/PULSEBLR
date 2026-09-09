// Bevy adapter — GDG / Google Developer Group chapters and other Bevy communities.
//
// Recon: `gdg.community.dev/api/search/event/?q=<city>` is an open, unauthenticated
// search API returning fully structured records — title, description_short,
// start_date_iso/end_date_iso, venue_name/address/city, chapter_title, picture_url
// and cropped_banner_url, plus _geoloc coordinates.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE RESULT COUNTS ARE INDEX TOTALS INCLUDING PAST EVENTS. THIS SENTENCE EXISTS BECAUSE THE
// EARLIER VERSION OF THIS COMMENT CAUSED A WRONG AUDIT FINDING.
//
// It used to say "q=bangalore returned 202 results and q=bengaluru 327, all in a single response".
// True, and it reads as available supply — so a September 2026 audit concluded this adapter was
// losing ~200 Bengaluru events and filed it as the highest-value supply bug in the product. It was
// not a bug. Re-measured 2026-09-10:
//
//   q=bangalore   202 results →   0 upcoming
//   q=bengaluru   327 results →   1 upcoming
//   q=india      8931 claimed →   9 upcoming across the ~1000 rows the API will actually serve
//
//   16 distinct UPCOMING events across all 5 tenants × 3 queries. Of those, 13 are genuinely
//   elsewhere — Ahmedabad, Kerala, Noida, Delhi, Chennai, Coimbatore, Jaipur, West Lafayette —
//   and the geo gate below correctly rejects every one. Three remain. Three is the right answer.
//
// So when quoting a number from here, say whether it is an index total or an upcoming count. The
// search index is mostly history, and history is not supply.
//
// PAGINATION: `count` also overstates what is retrievable. GDG reports 8931 for q=india and stops
// serving rows after page 2 (~1000). Pages are 500 rows; only the broad q=india query overflows one.
// Measured yield of page 2+ for Bengaluru specifically: ZERO. It is followed anyway, capped, and the
// cap is logged — a limit you cannot see in the logs is a coverage bug that presents as a supply
// problem, which is the lesson `applyCap` in pipeline.ts already exists to encode.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// This is how GDG Cloud Bengaluru, GDG Bangalore, Women Techmakers and the many
// company-sponsored chapter events get covered. `/api/event_slim/` was rejected:
// it returns all 70k+ global Bevy events and has no city filter.
//
// No date filter is honoured: `result_types=upcoming`, `upcoming=true`, `order=start_date` and
// `start_date__gte` were each probed and all returned the identical unfiltered page.

import { RawEvent, ScrapeResult } from '../core/types';
import { fetchJson } from '../core/http';
import { stripHtml, truncate } from '../core/text';
import { isBengaluru } from '../core/geo';

const BEVY_SOURCE = 'bevy';

interface BevyResult {
  id?: number | string;
  title?: string;
  description_short?: string;
  start_date_iso?: string;
  end_date_iso?: string;
  url?: string;
  relative_url?: string;
  picture_url?: string;
  cropped_banner_url?: string;
  banner?: string;
  venue_name?: string;
  venue_address?: string;
  venue_city?: string;
  chapter_title?: string;
  chapter_city?: string;
  event_timezone?: string;
  event_type_title?: string;
  virtual_event_type?: string | null;
  _geoloc?: { lat?: number; lng?: number };
}

interface BevySearchResponse {
  count?: number;
  results?: BevyResult[];
}

/**
 * Bevy communities to search. gdg.community.dev is by far the largest in
 * Bengaluru; the others are separate Bevy tenants that host India chapters.
 */
/**
 * Bevy tenants, each VERIFIED to return the Bevy search shape.
 *
 * Guessing hostnames does not work and wastes a request each: of 18 candidates
 * probed, mongodb/sap/aws/jamf/grafana/neo4j/temporal returned 403 or 404 and
 * datastax/airbyte/redis/commonroom did not resolve at all. mlh.community.dev was
 * removed for the same reason. Only add a host here after
 * scripts/probe-microsites-round2.ts confirms it.
 *
 * Measured counts for q=bengaluru: GDG 327, UiPath 127, Snowflake 22, CNCF 4.
 */
// Every host here was verified live by scripts/probe-bevy-tenants.ts, which checked
// 36 candidates and found exactly these 5. That ratio is the point: Bevy is the one
// route to company-run event pages that returns structured JSON, but only a handful
// of companies use it. The other 31 candidates were 404s, Cloudflare blocks, or HTML
// forums — guessing `community.<company>.com` does not work, so this list only grows
// on evidence. Re-run the probe before adding to it.
const BEVY_HOSTS = [
  'https://gdg.community.dev',
  'https://community.cncf.io',
  'https://usergroups.snowflake.com',
  'https://community.uipath.com',
  // Linux Foundation — the open-source events hub (217 India events at probe time),
  // covering Open Networking & Edge Summit India, KubeCon-adjacent days and the
  // foundation's Indian chapters.
  'https://community.linuxfoundation.org',
];

/**
 * Search terms. "india" is included deliberately: CNCF returned 13 records for
 * q=india versus 4 for q=bengaluru, because nationally-branded events (KubeDay
 * India) do not carry the city in their indexed text. The geo gate below still
 * rejects anything not actually in Bengaluru, so the wider query costs nothing
 * but catches more.
 */
const QUERIES = ['bangalore', 'bengaluru', 'india'];

/** Rows Bevy returns per page. A short page therefore means the set is exhausted. */
const BEVY_PAGE_SIZE = 500;

/**
 * Pages to walk per host × query.
 *
 * Three is deliberate and evidence-based, not a round number: only `q=india` exceeds one page at
 * all, GDG stops serving rows after page 2 regardless of its `count: 8931`, and UiPath's 836 rows
 * fit in two. Three leaves one page of headroom while keeping the worst case at 45 requests for the
 * whole source. Raising it is cheap if the cap ever starts appearing in the run report.
 */
const MAX_PAGES = 3;

function toRawEvent(item: BevyResult, host: string): RawEvent | null {
  if (!item.title || !item.start_date_iso) return null;

  const startDateTime = new Date(item.start_date_iso);
  if (Number.isNaN(startDateTime.getTime())) return null;

  const endDateTime = item.end_date_iso ? new Date(item.end_date_iso) : undefined;
  const isOnline = Boolean(item.virtual_event_type);

  const url = item.url || (item.relative_url ? `${host}${item.relative_url}` : host);
  const description = stripHtml(item.description_short || item.title);

  return {
    title: item.title.trim(),
    description: truncate(description, 4000),
    sourceUrl: url,
    source: BEVY_SOURCE,
    sourceEventId: item.id !== undefined ? `bevy-${item.id}` : url,
    organizer: item.chapter_title,
    venue: isOnline ? undefined : item.venue_name || item.venue_address,
    address: isOnline ? undefined : item.venue_address,
    city: item.venue_city || item.chapter_city,
    lat: item._geoloc?.lat,
    lng: item._geoloc?.lng,
    onlineLink: isOnline ? url : undefined,
    startDateTime,
    endDateTime: endDateTime && !Number.isNaN(endDateTime.getTime()) ? endDateTime : undefined,
    timezone: item.event_timezone,
    imageUrl: item.cropped_banner_url || item.picture_url || item.banner,
    // GDG/CNCF chapter events are free essentially without exception.
    isFree: true,
    applyLink: url,
    rawFormat: isOnline ? 'online' : 'offline',
    tags: item.event_type_title ? [item.event_type_title] : undefined,
  };
}

export async function scrapeBevy(): Promise<ScrapeResult> {
  const startedAt = new Date();
  const result: ScrapeResult = {
    sourceId: 'bevy-communities',
    label: 'Bevy — GDG / CNCF chapters',
    events: [],
    errors: [],
    startedAt,
    durationMs: 0,
  };

  const byId = new Map<string, RawEvent>();
  const now = Date.now();

  for (const host of BEVY_HOSTS) {
    for (const query of QUERIES) {
      try {
        for (let page = 1; page <= MAX_PAGES; page++) {
          const url = `${host}/api/search/event/?q=${encodeURIComponent(query)}&page=${page}`;
          const data = await fetchJson<BevySearchResponse>(url, { timeoutMs: 25000, retries: 2 });
          const rows = data.results || [];

          // An empty page is the real end of the set, whatever `count` claimed.
          if (rows.length === 0) break;

          for (const item of rows) {
            const event = toRawEvent(item, host);
            if (!event) continue;

            // The search index includes past events; the feed is upcoming-only.
            const effectiveEnd = (event.endDateTime ?? event.startDateTime).getTime();
            if (effectiveEnd < now) continue;

            // A text search for "bangalore" also matches chapters merely named after
            // it while meeting elsewhere, so re-verify geography.
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

            const key = event.sourceEventId || event.sourceUrl;
            if (!byId.has(key)) byId.set(key, event);
          }

          /*
           * SAY SO WHEN THE PAGE CAP BITES, rather than stopping quietly.
           *
           * A full page on the last allowed request means there was more to fetch. Today that costs
           * nothing measurable — page 2+ yielded zero Bengaluru events — but "costs nothing today"
           * is exactly how the Meetup group cap became a permanent blind spot that dropped the same
           * 80 groups every run with no log line.
           */
          if (page === MAX_PAGES && rows.length === BEVY_PAGE_SIZE) {
            result.errors.push(
              `${host} q=${query}: stopped at the ${MAX_PAGES}-page cap with a full page — more results exist`
            );
          }
        }
      } catch (err) {
        // A Bevy tenant that doesn't exist or blocks us shouldn't fail the source.
        result.errors.push(`${host} q=${query}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  result.events = [...byId.values()];
  result.durationMs = Date.now() - startedAt.getTime();
  return result;
}
