// Eventbrite adapter.
//
// Recon: the public city browse pages carry JSON-LD Event nodes and DO paginate
// properly (`?page=1` → 20 events, `?page=2` → 18, `?page=5` → 6, tapering to
// empty). The private `/api/v3/destination/search/` endpoint is CSRF-gated
// (HTTP 401 "Referer checking failed") so we deliberately do not use it.
//
// Strategy: walk category browse pages until a page yields no new events, then
// stop. Eventbrite is the main source of PAID and professional Bengaluru events,
// which Luma and Meetup under-represent.

import { RawEvent, ScrapeResult } from '../core/types';
import { fetchText } from '../core/http';
import { rawEventsFromHtml } from '../core/jsonld';
import { isBengaluru } from '../core/geo';

const EVENTBRITE_SOURCE = 'eventbrite';
const BASE = 'https://www.eventbrite.com/d/india--bengaluru';

/**
 * Category paths verified to return DISTINCT Bengaluru result sets.
 *
 * "Distinct" is the whole criterion, and it excludes more than it includes.
 * scripts/probe-eventbrite-categories.ts measured 20 further candidates against what these
 * already return:
 *
 *   ALL DUPLICATES — robotics, engineering, hardware, maker. Each returns 1-39 events and
 *   not one is new. Eventbrite's /d/<city>/<path>/ URL is a relevance search rather than a
 *   filter, so a topic word mostly re-ranks the same inventory. Same trap as AllEvents.in,
 *   where /technology and /music return identical sets.
 *
 *   ZERO RESULTS — iot, semiconductor, and every non-tech category: music,
 *   food-and-drink, arts, health, sports-and-fitness, community, film-and-media, hobbies,
 *   education, travel-and-outdoor, charity-and-causes, fashion. Eventbrite Bengaluru is
 *   almost entirely a paid-professional-events platform; the city's cultural events are
 *   not on it, which is worth knowing before anyone tries to widen coverage here again.
 */
const CATEGORIES = [
  'all-events',
  'technology--events',
  'business--events',
  'science-and-tech--events',
  'startup--events',
  // The only two of 20 candidates that added anything: +4 and +1 events respectively.
  // Small, but hardware-adjacent, and hardware is the thinnest part of the corpus.
  'drone--events',
  'electronics--events',
];

export async function scrapeEventbrite(maxPagesPerCategory = 6): Promise<ScrapeResult> {
  const startedAt = new Date();
  const result: ScrapeResult = {
    sourceId: 'eventbrite-bengaluru',
    label: 'Eventbrite — Bengaluru',
    events: [],
    errors: [],
    startedAt,
    durationMs: 0,
  };

  const byUrl = new Map<string, RawEvent>();

  for (const category of CATEGORIES) {
    for (let page = 1; page <= maxPagesPerCategory; page++) {
      const url = `${BASE}/${category}/${page > 1 ? `?page=${page}` : ''}`;
      let html: string;
      try {
        html = await fetchText(url, { timeoutMs: 25000, retries: 2 });
      } catch (err) {
        result.errors.push(`${category} p${page}: ${err instanceof Error ? err.message : String(err)}`);
        break; // A failed page usually means we've walked past the end.
      }

      const events = rawEventsFromHtml(html, { baseUrl: url, source: EVENTBRITE_SOURCE });
      let added = 0;
      for (const event of events) {
        // Eventbrite city pages sometimes bleed in nearby/online listings.
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

        if (!byUrl.has(event.sourceUrl)) {
          byUrl.set(event.sourceUrl, event);
          added++;
        }
      }

      // Pagination is exhausted once a page contributes nothing new.
      if (added === 0) break;
      // Be polite between page fetches on the same host.
      await new Promise(resolve => setTimeout(resolve, 600));
    }
  }

  result.events = [...byUrl.values()];
  result.durationMs = Date.now() - startedAt.getTime();
  return result;
}
