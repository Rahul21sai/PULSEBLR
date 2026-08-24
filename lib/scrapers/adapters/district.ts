// District (district.in) adapter — Zomato's events platform, which absorbed Paytm Insider.
//
// This is the broadest CONSUMER events surface in India, and it is the source that moves
// "every Bengaluru event" rather than the tech feed: comedy, live music, theatre, cultural
// festivals, business networking, run events, the occasional startup summit. The tech feed
// is gated by `isTechEvent`, so adding breadth here cannot dilute it — a Sonu Nigam concert
// is ingested, classified non-tech, and never appears under the default `techOnly` filter.
//
// WHY THE EARLIER REJECTION WAS WRONG:
// A previous probe tried `district.in/bengaluru` (404) and `api.district.in/rest/v1/events`
// (fetch failed) and wrote the platform off. Both were GUESSES; a 404 on a guessed path is
// evidence about the guess, not the platform. Starting from robots.txt instead found the
// real mechanism in one request.
//
// MECHANISM (measured 2026-08-23, scripts/probe-district-round2.ts / -round3.ts):
//   robots.txt declares  /events/search-sitemap/sitemap-events.xml
//     └── event-detail-pages.xml   6316 URLs, 365 with Bengaluru in the slug   ← the source
//     └── event-artist-pages.xml   1646 URLs,   0 Bengaluru                    (artist bios)
//     └── event-venue-guide-pages.xml 25 URLs,  6 Bengaluru                    (venue guides)
//   Each event page carries a schema.org JSON-LD `Event`, so `rawEventsFromHtml` handles
//   extraction with no new parser and no browser. Coverage on the 23 sampled pages that had
//   an Event node: venue 100%, address 100%, image 100%, description 100%, price 100%,
//   organizer 100% — the most complete of any source in this project, Luma included.
//
// THE SLUG IS THE FILTER, AND THAT IS THE WHOLE COST STORY:
// Pages average 233 KB. Fetching all 365 Bengaluru URLs would move ~85 MB per run and make
// this the most expensive source by an order of magnitude — for a set that is mostly PAST
// events, because the sitemap keeps history (287 of 371 had a past date in the slug).
//
// District's slug generator appends the date for dated events (`...-sep6-2026-buy-tickets`)
// and omits it for its always-on "experiences" catalogue (`timezone-orion-mall-bengaluru-
// buy-tickets`). In the round-3 sample that separation was total:
//
//   slug HAS a date  → 11 of 11 were real dated events (comedy, concerts, summits, runs)
//   slug has NO date → 13 of 13 were permanent attractions — Timezone arcades, amusement
//                      parks, vineyard tours, kids' play areas, a rage room — every one of
//                      which reported `startDate` = TODAY with a 0-day span, i.e. exactly
//                      the evergreen advert CLAUDE.md records as having pinned itself to the
//                      top of the feed until `pipeline.ts` learned to reject it.
//
// So undated slugs are skipped WITHOUT a request. That is a deliberate trade: if District
// ever changes its slug format, this adapter goes to zero rather than silently importing
// arcades. It is designed to fail loudly — `datedSlugs` is reported in the errors array when
// it hits zero, which is what the source-health system reads to flag a dead feed.
//
// The evergreen guard is kept anyway, because a dated slug can still point at a season pass.

import { ScrapeResult, RawEvent } from '../core/types';
import { fetchText, mapPool } from '../core/http';
import { rawEventsFromHtml } from '../core/jsonld';
import { isBengaluru } from '../core/geo';

const SITEMAP_INDEX = 'https://www.district.in/events/search-sitemap/sitemap-events.xml';
const DISTRICT_SOURCE = 'district';

export const DISTRICT_SOURCE_URL = 'https://www.district.in/events';

/**
 * Hard ceiling on page fetches per run. The measured list is ~27; this is the backstop that
 * keeps a sitemap explosion from turning one source into the entire run's request budget.
 */
const MAX_PAGES = 80;
const CONCURRENCY = 4;

/** An event whose start and end are further apart than this is a season pass, not an event. */
const MAX_SPAN_DAYS = 30;

/** Ignore anything claiming to start more than this far out; District lists 2027 placeholders. */
const MAX_FUTURE_DAYS = 400;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * The date District embeds in the slug, or null when there is none.
 *
 * Forms seen live: `-apr19-2026-`, `-may31-2026-`, `-sep6-2026-`, `-nov-2025-` (month only).
 * A month-only slug resolves to the END of that month, because this is only a pre-filter —
 * the JSON-LD `startDate` is authoritative — and erring late keeps a still-running event in
 * the list rather than dropping it a few days early.
 *
 * The trailing `-` is required, and every real slug ends `-buy-tickets`, so the pattern
 * cannot match a bare word: it needs month, optional day, and a four-digit 20xx year.
 */
export function districtSlugDate(url: string): Date | null {
  const match = url.match(new RegExp(`-(${MONTHS.join('|')})(\\d{1,2})?-(20\\d{2})[-/]`, 'i'));
  if (!match) return null;

  const month = MONTHS.indexOf(match[1].toLowerCase());
  const year = Number.parseInt(match[3], 10);
  if (month < 0 || !Number.isFinite(year)) return null;

  if (match[2]) {
    const day = Number.parseInt(match[2], 10);
    if (day < 1 || day > 31) return null;
    // 18:30 UTC = midnight IST the next day, so a same-day event survives the cutoff for
    // the whole of its IST day.
    return new Date(Date.UTC(year, month, day, 18, 30));
  }
  // Month only → last instant of that month in IST.
  return new Date(Date.UTC(year, month + 1, 0, 18, 30));
}

/** Bengaluru under either spelling, as it appears in a District slug. */
const BLR_SLUG = /(?:^|-)(bengaluru|bangalore)(?:-|$)/i;

async function collectEventUrls(errors: string[]): Promise<{ all: string[]; blr: string[]; dated: string[] }> {
  const index = await fetchText(SITEMAP_INDEX, { timeoutMs: 25000, retries: 2 });
  const children = [...index.matchAll(/<loc>([^<]+\.xml)<\/loc>/g)].map(m => m[1]);

  // Only the detail-pages sitemap holds events; artist pages are bios and venue-guide pages
  // are editorial. Named rather than "all children" so a new sitemap cannot quietly enter.
  const detail = children.find(c => /event-detail-pages\.xml$/.test(c));
  if (!detail) {
    errors.push(
      `sitemap index has no event-detail-pages.xml (found: ${children.map(c => c.split('/').pop()).join(', ') || 'nothing'})`
    );
    return { all: [], blr: [], dated: [] };
  }

  const body = await fetchText(detail, { timeoutMs: 30000, retries: 2 });
  const all = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map(m => m[1].trim())
    .filter(u => u && !u.endsWith('.xml'));

  const blr = all.filter(u => BLR_SLUG.test(u.split('/').pop() || ''));

  const now = Date.now();
  const horizon = now + MAX_FUTURE_DAYS * 86400_000;
  const dated = blr.filter(u => {
    const d = districtSlugDate(u);
    return d !== null && d.getTime() >= now && d.getTime() <= horizon;
  });

  return { all, blr, dated };
}

export async function scrapeDistrict(): Promise<ScrapeResult> {
  const startedAt = new Date();
  const result: ScrapeResult = {
    sourceId: 'district',
    label: 'District — Bengaluru city events',
    events: [],
    errors: [],
    startedAt,
    durationMs: 0,
  };

  try {
    const { all, blr, dated } = await collectEventUrls(result.errors);

    if (all.length === 0) {
      result.errors.push('sitemap returned no event URLs');
      result.durationMs = Date.now() - startedAt.getTime();
      return result;
    }

    // The loud failure described in the header. Measured baseline: 6316 URLs / 365 Bengaluru
    // / 27 dated. Zero dated with a healthy sitemap means the slug format changed.
    if (dated.length === 0) {
      result.errors.push(
        `no dated Bengaluru slugs among ${blr.length} Bengaluru URLs (${all.length} total) — ` +
          'District may have changed its slug format; see districtSlugDate()'
      );
      result.durationMs = Date.now() - startedAt.getTime();
      return result;
    }

    const targets = dated.slice(0, MAX_PAGES);
    if (dated.length > MAX_PAGES) {
      result.errors.push(`capped at ${MAX_PAGES} of ${dated.length} dated pages`);
    }

    const now = Date.now();
    const horizon = now + MAX_FUTURE_DAYS * 86400_000;
    /** Guards against the same event appearing under several JSON-LD nodes on one page. */
    const seen = new Set<string>();

    const perPage = await mapPool(targets, CONCURRENCY, async url => {
      try {
        const html = await fetchText(url, { timeoutMs: 25000, retries: 2 });
        return rawEventsFromHtml(html, { baseUrl: url, source: DISTRICT_SOURCE });
      } catch (err) {
        // One dead page must not cost the source. Not pushed to errors: with ~27 pages a
        // couple of 404s from a stale sitemap is normal and would drown the real signals.
        void err;
        return [] as RawEvent[];
      }
    });

    let rejectedSpan = 0;
    let rejectedEvergreen = 0;
    let rejectedGeo = 0;

    for (const events of perPage) {
      if (!events) continue;
      for (const event of events) {
        const start = event.startDateTime.getTime();
        if (!Number.isFinite(start)) continue;
        if (start > horizon) continue;

        // Season passes and year-long "attractions". pipeline.ts rejects these too; doing it
        // here keeps them out of the tagger's token budget.
        if (event.endDateTime) {
          const spanDays = (event.endDateTime.getTime() - start) / 86400_000;
          if (spanDays > MAX_SPAN_DAYS) { rejectedSpan++; continue; }
        }

        // Belt and braces on the evergreen signature: starts within the day AND has no end,
        // which is how every sampled arcade and vineyard presented itself. A genuine event
        // today is kept, because District always publishes an endDateTime for those.
        if (!event.endDateTime && Math.abs(start - now) < 36 * 3600_000) {
          rejectedEvergreen++;
          continue;
        }

        // District is national. The slug said Bengaluru; confirm against the JSON-LD address
        // so a Mumbai show with "bangalore" in its tour name cannot slip through.
        const geo = isBengaluru({
          address: [event.venue, event.address, event.city].filter(Boolean).join(', '),
          city: event.city,
        });
        if (geo === false) { rejectedGeo++; continue; }

        const key = `${event.title.toLowerCase().trim()}|${Math.floor(start / 60000)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        result.events.push({
          ...event,
          city: 'Bengaluru',
          // District's `organizer` is the promoter and its `performer` is the act; the
          // JSON-LD parser already prefers organizer and falls back to performer.
          //
          // `tags` deliberately carries NO source marker. An earlier version appended 'district'
          // here, which put a source name into a field meant for organiser-supplied TOPIC hints —
          // and those hints are fed to the tagger, so it was feeding the classifier a word that
          // says nothing about the subject. It was also the single most common tag value in the
          // whole corpus (24 of 32 tagged events, per diag-tag-supply.ts), which made the field
          // look populated when it is not. The source already lives in `Event.source`.
          tags: event.tags || [],
          rawFormat: event.rawFormat || 'offline',
          applyLink: event.applyLink || event.sourceUrl,
        });
      }
    }

    if (result.events.length === 0) {
      result.errors.push(
        `${targets.length} dated pages yielded no usable events ` +
          `(span ${rejectedSpan}, evergreen ${rejectedEvergreen}, non-Bengaluru ${rejectedGeo})`
      );
    }
  } catch (err) {
    result.errors.push(`fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  result.durationMs = Date.now() - startedAt.getTime();
  return result;
}
