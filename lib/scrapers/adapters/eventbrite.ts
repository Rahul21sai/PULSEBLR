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

/** Category paths verified to return distinct Bengaluru result sets. */
const CATEGORIES = [
  'all-events',
  'technology--events',
  'business--events',
  'science-and-tech--events',
  'startup--events',
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
