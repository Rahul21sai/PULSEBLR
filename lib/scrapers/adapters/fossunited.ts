// FOSS United adapter.
//
// WHY: FOSS United runs India's open-source community — IndiaFOSS, plus a monthly Bengaluru
// city meetup and 101 chapters. Open-source coverage is one of this product's weakest
// dimensions, and this is the largest single source for it.
//
// THIS SOURCE WAS REJECTED TWICE BEFORE, and both rejections asked the wrong question. The
// earlier probes looked for an API or a feed and correctly found none: the Frappe REST API
// is 403, the whitelisted methods do not exist (417 "No module named"), /events.ics is a
// 404, and rss.xml turns out to be a BLOG feed of grants and tech reports. The conclusion
// drawn — "needs selector scraping, which universal.ts refuses" — did not survive actually
// reading the markup.
//
// MECHANISM (verified, scripts/probe-fossunited-round3.ts + round4.ts):
//
//   1. A chapter page (/c/bengaluru) is server-rendered and lists its events as
//      /c/<chapter>/<event> links — 22 of them for Bengaluru, newest first.
//   2. Each event page carries og:title, og:description and EXACTLY TWO <time datetime>
//      elements: the start and the end.
//
//        og:title       "FOSS Bengaluru March Meetup"
//        og:description "… is being organized on Saturday, 28 March 2026 by BENGALURU …"
//        <time datetime="2026-03-28T14:00:00">2:00 PM</time>
//        <time datetime="2026-03-28T17:00:00">5:00 PM</time>
//
// That is extraction from WEB STANDARDS — <time datetime> and Open Graph — not from
// someone's CSS class names. The distinction matters: universal.ts refuses selector
// guessing because selectors break on every redesign, whereas a redesign that drops
// <time datetime> or og: tags breaks the site's own search results and calendar previews.
//
// HONEST YIELD: zero upcoming at build time. Every one of Bengaluru's 22 listed meetups had
// already happened, because the series is monthly and September was not posted yet. This is
// forward coverage: a stable URL pattern for a monthly meetup, so the next one arrives
// without anyone touching the code. Claiming it adds events today would be false.
//
// COST is the one real drawback: event pages are ~360 KB each. Hence the budget below —
// newest-first with an early exit, so a normal run reads a handful of pages, not 22.

import { RawEvent, ScrapeResult } from '../core/types';
import { fetchText } from '../core/http';
import { truncate } from '../core/text';
import { isBengaluru } from '../core/geo';

const FOSSUNITED_SOURCE = 'fossunited';
const BASE = 'https://fossunited.org';

/**
 * Chapters to read. Bengaluru is the city meetup; indiafoss is the flagship conference.
 *
 * Only these two, deliberately: FOSS United has 101 chapters and the rest are other cities
 * and colleges whose events the geo gate would discard, so reading them spends requests to
 * import nothing.
 */
export const FOSSUNITED_CHAPTERS = ['bengaluru', 'indiafoss'];

/** Event pages fetched per chapter. Each is ~360 KB, so this is a real budget. */
const MAX_EVENT_PAGES = 8;

/**
 * Consecutive past events before giving up on a chapter.
 *
 * Chapter pages list newest first, so a run of past events means the rest are older still.
 * Two rather than one, because an undated or oddly-ordered entry should not end the scan.
 */
const PAST_STREAK_LIMIT = 2;

function metaContent(html: string, property: string): string | undefined {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${property}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return m[1].trim();
  }
  return undefined;
}

/**
 * Parse a FOSS United <time datetime> as IST.
 *
 * The values carry no zone ("2026-03-28T14:00:00"), and a bare local string is interpreted
 * by `new Date()` in the SERVER's zone — which would place a 2 PM Bengaluru meetup at 2 PM
 * UTC, i.e. 7:30 PM IST, on a machine running UTC. Every date in this project is pinned to
 * Asia/Kolkata for exactly this reason, so the offset is applied explicitly.
 */
function parseIstLocal(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) {
    // Already zoned (ends in Z or ±hh:mm) — trust it.
    const direct = new Date(value);
    return Number.isNaN(direct.getTime()) ? null : direct;
  }
  const [, y, mo, d, h, mi, s] = m;
  // IST is UTC+5:30 year-round, no DST.
  const utcMs = Date.UTC(+y, +mo - 1, +d, +h, +mi, s ? +s : 0) - 5.5 * 3600 * 1000;
  const date = new Date(utcMs);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Extract one event from its page, or null if it is unusable or already finished. */
function toRawEvent(html: string, url: string, chapter: string): RawEvent | null {
  const title = metaContent(html, 'og:title');
  if (!title) return null;

  const times = [...html.matchAll(/<time[^>]*datetime=["']([^"']+)["']/gi)].map(m => m[1]);
  const start = times.length > 0 ? parseIstLocal(times[0]) : null;
  if (!start) return null;
  const end = times.length > 1 ? parseIstLocal(times[1]) : null;

  // Finished events are almost everything a chapter page lists.
  const finishedAt = end ?? start;
  if (finishedAt.getTime() < Date.now()) return null;

  const description = metaContent(html, 'og:description') || title;

  // The description states the host chapter ("… by BENGALURU Community"), and the venue is
  // labelled but not marked up, so venue is left undefined rather than guessed at from
  // surrounding markup — an invented venue is worse than an absent one.
  if (isBengaluru({ address: `${title} ${description}`, city: chapter }) === false) return null;

  const image = metaContent(html, 'og:image');

  return {
    title,
    description: truncate(description, 600),
    sourceUrl: url,
    source: FOSSUNITED_SOURCE,
    sourceEventId: url.replace(`${BASE}/c/`, '').replace(/\/$/, '') || undefined,
    organizer: chapter === 'indiafoss' ? 'IndiaFOSS (FOSS United)' : 'FOSS United Bengaluru',
    startDateTime: start,
    endDateTime: end ?? undefined,
    timezone: 'Asia/Kolkata',
    // og:image is sometimes the bare origin rather than a file; only keep real files.
    imageUrl: image && /\.(jpe?g|png|webp|avif)$/i.test(image) ? image : undefined,
    applyLink: url,
    rawFormat: 'offline',
    tags: ['open source', 'foss'],
  };
}

/** Harvest a chapter's event page links, newest first as the page lists them. */
function eventLinks(html: string, chapter: string): string[] {
  const re = new RegExp(`href=["'](/c/${chapter}/[a-z0-9][a-z0-9/_-]{2,60})["']`, 'gi');
  const seen = new Set<string>();
  for (const m of html.matchAll(re)) {
    const path = m[1];
    // Sub-pages of an event (cfp, schedule, speakers) are not events themselves.
    if (/\/(cfp|schedule|speakers?|venue|sponsors?|about|tickets?)(\/|$)/i.test(path)) continue;
    seen.add(path);
  }
  return [...seen];
}

export async function scrapeFossUnited(): Promise<ScrapeResult> {
  const startedAt = new Date();
  const result: ScrapeResult = {
    sourceId: 'fossunited',
    label: 'FOSS United — Bengaluru meetups + IndiaFOSS',
    events: [],
    errors: [],
    startedAt,
    durationMs: 0,
  };

  const byUrl = new Map<string, RawEvent>();

  for (const chapter of FOSSUNITED_CHAPTERS) {
    let index: string;
    try {
      index = await fetchText(`${BASE}/c/${chapter}`, { timeoutMs: 25000, retries: 2 });
    } catch (err) {
      result.errors.push(`chapter ${chapter}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const links = eventLinks(index, chapter);
    let pastStreak = 0;

    for (const path of links.slice(0, MAX_EVENT_PAGES)) {
      if (pastStreak >= PAST_STREAK_LIMIT) break;

      const url = `${BASE}${path}`;
      try {
        const page = await fetchText(url, { timeoutMs: 25000, retries: 1 });
        const event = toRawEvent(page, url, chapter);
        if (event) {
          pastStreak = 0;
          if (!byUrl.has(event.sourceUrl)) byUrl.set(event.sourceUrl, event);
        } else {
          pastStreak++;
        }
      } catch (err) {
        result.errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
        pastStreak++;
      }
    }
  }

  result.events = [...byUrl.values()];
  result.durationMs = Date.now() - startedAt.getTime();
  return result;
}
