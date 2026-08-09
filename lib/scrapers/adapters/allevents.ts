// AllEvents.in adapter — general-audience Bengaluru events (concerts, comedy,
// festivals, expos) that Luma/Meetup/Eventbrite do not carry.
//
// IMPORTANT RECON FINDING — read before "improving" this file:
// AllEvents.in's category pages are NOT category-scoped in their structured data.
// /bengaluru/all, /bengaluru/technology and /bengaluru/music returned an IDENTICAL
// set of 48 JSON-LD events (100% overlap, union = 48), all of them concerts and
// large shows. `?page=2` also returned the same set. So:
//   · Do NOT add more category URLs expecting more events — they return the same.
//   · Do NOT treat this as a tech source; its yield is culture/entertainment.
// It is kept because those ARE real Bengaluru events and the goal is city-wide
// coverage, but it is a single cheap request, not a breadth lever.

import { ScrapeResult, RawEvent } from '../core/types';
import { fetchText } from '../core/http';
import { rawEventsFromHtml } from '../core/jsonld';

const ALLEVENTS_SOURCE = 'allevents';

/** Two URLs only: the general feed, plus one alternate in case `all` changes shape. */
const PAGES = ['https://allevents.in/bengaluru/all', 'https://allevents.in/bengaluru/'];

export async function scrapeAllEvents(): Promise<ScrapeResult> {
  const startedAt = new Date();
  const result: ScrapeResult = {
    sourceId: 'allevents-bengaluru',
    label: 'AllEvents.in — Bengaluru',
    events: [],
    errors: [],
    startedAt,
    durationMs: 0,
  };

  const byUrl = new Map<string, RawEvent>();
  const now = Date.now();

  for (const url of PAGES) {
    try {
      const html = await fetchText(url, { timeoutMs: 30000, retries: 2 });
      for (const event of rawEventsFromHtml(html, { baseUrl: url, source: ALLEVENTS_SOURCE })) {
        const effectiveEnd = (event.endDateTime ?? event.startDateTime).getTime();
        if (effectiveEnd < now) continue;
        // These pages are city-scoped by URL, so we trust the city rather than
        // re-gating on venue text (many listings give only a hall name).
        event.city = event.city || 'Bengaluru';
        if (!byUrl.has(event.sourceUrl)) byUrl.set(event.sourceUrl, event);
      }
      // The second URL exists only as a fallback; if the first worked, stop.
      if (byUrl.size > 0) break;
    } catch (err) {
      result.errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  result.events = [...byUrl.values()];
  result.durationMs = Date.now() - startedAt.getTime();
  return result;
}
